"""
😺NKD Video Viewer — encode once, watch it properly.

Why this exists at all: the core only writes mp4/h264 (`SaveVideo`) and vp9/av1
(`SaveWEBM`), and both hand the browser a bare `<video>`. Video Helper Suite has the
formats but transcodes every preview into a streaming WebM WITHOUT Range support, which is
precisely why its preview cannot be scrubbed. Here the encoded file is served RAW through
`/view`, which aiohttp delivers with `FileResponse` — Range included — so the `<video>`
seeks natively. Same reasoning as `src/timeline/media.ts`.

Encoding goes through **PyAV**, already a hard dependency of the core
(`comfy_extras/nodes_video.py` imports it at module level), so this adds nothing new. It
cannot go through `VideoFromComponents.save_to`, which is wired to h264/mp4/aac
(`comfy_api/latest/_input_impl/video_types.py:833`).
"""

import json
import os
import re
import shutil
import time
import weakref
from fractions import Fraction

import av
import folder_paths
import numpy as np
import torch
from PIL import Image as PILImage
from typing_extensions import override

import comfy.utils
from comfy.cli_args import args
from comfy_api.latest import InputImpl, Types, io
from comfy_api.latest._io import _UIOutput


# ── Output naming, the way a Write node does it ───────────────────────────────
# Nuke puts the version between the name and the frame padding
# (`final_comp_v01.####.exr`), and studio convention repeats it in the FOLDER too
# (`sh001_comp_v001/sh001_comp_v001.####.exr`) so a stray file still says which version it
# is. ComfyUI has tokens (Save Image Extended, SaveImageWithMetaData) but nothing has
# versioning, which is the gap this fills.
#
# `%date:...%` and `%NodeTitle.widget%` are already resolved by the FRONTEND before the
# prompt is sent (`applyTextReplacements`, exported on `comfyAPI.utils`), which also
# sanitises the substituted value so a widget cannot inject a path separator. What is left
# here are the tokens only the backend can know, because they describe the render that just
# happened.
#
# Kept in this file rather than a module of its own: `nkd_timeline.py` is self-contained for
# the same reason, so the tests can import it flat.

VERSION_RE = re.compile(r"%v(#+)%")


def resolve_tokens(prefix: str, ctx: dict) -> str:
    """Replace the render-time tokens. `%v###%` is handled separately, by `apply_version`."""
    out = prefix
    out = re.sub(r"%time:([^%]*)%",
                 lambda m: time.strftime(m.group(1) or "%H-%M-%S"), out)
    for key, value in ctx.items():
        out = out.replace(f"%{key}%", str(value))
    return out


def _version_pattern(part: str, pad: int) -> re.Pattern | None:
    """Turn one path segment containing `%v###%` into a regex with the number captured."""
    if not VERSION_RE.search(part):
        return None
    escaped = VERSION_RE.sub("\x00", part)
    escaped = re.escape(escaped).replace("\x00", rf"(\d{{{pad},}})")
    return re.compile(rf"^{escaped}(?:\..*)?$", re.IGNORECASE)


def next_version(root: str, prefix: str, pad: int) -> int:
    """The lowest unused version, found by scanning where the token actually sits.

    The token can be in a FOLDER (`shot/v%v###%/name`) or in the FILE NAME
    (`shot/name_v%v###%`), and studios use both at once. So: walk down the fixed part of the
    path, stop at the first segment carrying the token, and scan THAT directory for
    neighbours matching the same pattern.

    Returns 1 when nothing matches - including when the directory does not exist yet, which
    is the common first-run case.
    """
    parts = prefix.replace("\\", "/").split("/")
    fixed: list[str] = []
    for part in parts:
        pattern = _version_pattern(part, pad)
        if pattern is None:
            fixed.append(part)
            continue
        folder = os.path.join(root, *fixed) if fixed else root
        try:
            entries = os.listdir(folder)
        except OSError:
            return 1
        best = 0
        for entry in entries:
            m = pattern.match(entry)
            if m:
                best = max(best, int(m.group(1)))
        return best + 1
    return 1


def apply_version(prefix: str, version: int) -> str:
    """Stamp the version into every `%v###%`, each padded by its own hash count."""
    return VERSION_RE.sub(lambda m: str(version).zfill(len(m.group(1))), prefix)


# `v001`: three digits is the convention everywhere, and it is what gets appended when
# versioning is on but the prefix carries no token of its own.
DEFAULT_VERSION_PAD = 3


def version_pad(prefix: str) -> int:
    """Hash count of the first version token, or the default if there is none."""
    m = VERSION_RE.search(prefix)
    return len(m.group(1)) if m else DEFAULT_VERSION_PAD


def has_version(prefix: str) -> bool:
    return bool(VERSION_RE.search(prefix))


# ── Formats ───────────────────────────────────────────────────────────────────
# The key IS the combo label, so it reads as "container / codec" the way an export dialog
# does. Everything downstream keys off this table rather than off scattered ifs.
FORMATS = {
    "mp4 / h264": {"ext": "mp4", "vcodec": "libx264", "acodec": "aac"},
    "webm / vp9": {"ext": "webm", "vcodec": "libvpx-vp9", "acodec": "libopus"},
    "gif": {"ext": "gif", "vcodec": None, "acodec": None},
}

# Formats the browser can play back with a seekable `<video>`. A GIF is shown as an <img>
# instead: no scrub, which is a limitation of the format and not something to paper over.
PLAYABLE = {"mp4", "webm"}


# ── Re-encode avoidance ───────────────────────────────────────────────────────
# Bumping the version bumps an INPUT, so ComfyUI's signature changes and the node re-runs -
# correct, but the only thing that actually changed is where the file goes. Re-encoding a
# long clip to rename it is absurd, so an identical render is COPIED instead.
#
# "Identical" is decided by tensor IDENTITY, not by hashing:
#
# - Hashing the frames costs about a second per gigabyte, on every run, forever.
# - Reconstructing ComfyUI's own signature from `hidden.prompt` looks tempting and is WRONG:
#   it would miss `IS_CHANGED`. A Load Video pointing at a file whose CONTENTS were replaced
#   keeps the exact same prompt entry, so that signature would match and we would happily
#   copy the previous, stale render.
# - Object identity has neither problem. When an upstream node is served from ComfyUI's
#   cache it hands back the SAME tensor object; when it re-executes - for any reason,
#   including IS_CHANGED - it builds a new one. So `is` answers exactly the question.
#
# Held as WEAK references: a strong one would pin whole frame batches (gigabytes) alive for
# the rest of the session. If the tensor is collected the ref dies and we simply re-encode,
# which is the safe direction to fail in.
_ENCODED: dict[str, dict] = {}


def _weak(tensor):
    """A weakref to a tensor, or None. Never raises - not everything is weak-referenceable."""
    try:
        return weakref.ref(tensor) if tensor is not None else None
    except TypeError:
        return None


def _same_object(ref, obj) -> bool:
    """True when `ref` still points at exactly `obj`. A dead ref is never a match."""
    if ref is None and obj is None:
        return True
    if ref is None or obj is None:
        return False
    return ref() is obj


def reusable_render(node_key: str, images, audio_wave, settings: tuple,
                    ext: str) -> str | None:
    """Path of a previous render that is byte-for-byte what we are about to make."""
    prev = _ENCODED.get(node_key)
    if not prev or prev["settings"] != settings or prev["ext"] != ext:
        return None
    if not (_same_object(prev["images"], images) and _same_object(prev["audio"], audio_wave)):
        return None
    # The user may have moved or deleted it since; a missing source is not reusable.
    return prev["path"] if os.path.isfile(prev["path"]) else None


def remember_render(node_key: str, images, audio_wave, settings: tuple, ext: str,
                    path: str) -> None:
    _ENCODED[node_key] = {
        "images": _weak(images), "audio": _weak(audio_wave),
        "settings": settings, "ext": ext, "path": path,
    }


class NKDVideoUI(_UIOutput):
    """A UI payload the CORE frontend does not recognise.

    Deliberate: returning `ui.PreviewVideo` would make ComfyUI render its own player on top
    of ours, so the node would carry two. Our own key means only our widget reacts.
    """

    def __init__(self, result: dict, meta: dict):
        self.result = result
        self.meta = meta

    def as_dict(self):
        return {"nkd_video": [self.result], "nkd_meta": [self.meta]}


# ── Encoding ──────────────────────────────────────────────────────────────────

def _to_u8(frame: torch.Tensor, channels: int) -> np.ndarray:
    """One frame of an IMAGE tensor as HxWxC uint8."""
    return (frame[..., :channels] * 255).clamp(0, 255).byte().cpu().numpy()


def _add_audio_stream(container, audio: dict | None, codec: str | None,
                      max_seconds: float):
    """Declare the audio stream and prepare its source frame.

    **Must run before the first video packet is muxed.** The container writes its header on
    that first packet; a stream added afterwards is missing from the header, gets no
    time base, and every packet on it dies with "Cannot rebase to zero time".
    """
    if not audio or not codec:
        return None
    rate = int(audio["sample_rate"])
    wave = audio["waveform"][0]                       # (channels, samples)
    wave = wave[:, : max(1, int(rate * max_seconds))]  # never outrun the picture
    layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(wave.shape[0], "stereo")

    # Opus only accepts 48 kHz, so a 44.1 kHz track has to be resampled. Going through
    # AudioResampler covers every codec rather than special-casing that one.
    stream = container.add_stream(codec, rate=48000 if codec == "libopus" else rate)
    stream.layout = layout
    src = av.AudioFrame.from_ndarray(
        wave.float().cpu().contiguous().numpy(), format="fltp", layout=layout)
    src.sample_rate = rate
    # Without a pts AND a time base the resampler emits frames with no timestamp, and the
    # muxer rejects them rather than assuming a start.
    src.pts = 0
    src.time_base = Fraction(1, rate)
    return stream, src


def _write_audio(container, prepared) -> None:
    if prepared is None:
        return
    stream, src = prepared
    resampler = av.audio.resampler.AudioResampler(
        format=stream.format, layout=stream.layout, rate=stream.rate)
    for frame in resampler.resample(src):
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)


def encode_video(images: torch.Tensor, path: str, spec: dict, fps: float,
                 crf: float, preset: str | None, audio: dict | None,
                 metadata: dict | None, pbar: comfy.utils.ProgressBar | None) -> None:
    """h264 / vp9 through PyAV.

    **RGBA input is flattened, including on vp9.** The core's `SaveWEBM` sets `yuva420p`
    and implies transparency works; measured here it does not survive. WebM carries a vp9
    alpha plane in `BlockAdditional`, which the ffmpeg CLI assembles as a second stream -
    libavformat does not do it, so nothing PyAV can express produces it. Verified by
    encoding a half-transparent clip and reading it back: every pixel came out opaque, with
    and without `auto-alt-ref 0`. Promising alpha here would be a lie that only shows up
    once someone composites the result.
    """
    # mp4 drops any tag it does not recognise unless `use_metadata_tags` is on, so without
    # this the embedded prompt silently vanishes. `faststart` earns its place separately:
    # it moves the moov atom to the front, which is what lets a <video> start playing and
    # seeking without pulling the whole file first - the point of this node's viewer.
    open_kwargs = {"mode": "w"}
    if spec["ext"] == "mp4":
        open_kwargs["options"] = {"movflags": "use_metadata_tags+faststart"}
    container = av.open(path, **open_kwargs)
    try:
        if metadata:
            for key, value in metadata.items():
                container.metadata[key] = json.dumps(value)
        stream = container.add_stream(
            spec["vcodec"], rate=Fraction(round(fps * 1000), 1000))
        stream.width = images.shape[2]
        stream.height = images.shape[1]
        stream.pix_fmt = "yuv420p"
        stream.bit_rate = 0
        stream.options = {"crf": str(int(crf))}
        if preset and spec["vcodec"] == "libx264":
            stream.options["preset"] = preset
        # Before the first mux, or the stream misses the header. See _add_audio_stream.
        prepared = _add_audio_stream(
            container, audio, spec["acodec"], len(images) / max(fps, 1e-6))

        for frame in images:
            packet = stream.encode(
                av.VideoFrame.from_ndarray(_to_u8(frame, 3), format="rgb24"))
            container.mux(packet)
            if pbar:
                pbar.update(1)
        container.mux(stream.encode(None))
        _write_audio(container, prepared)
    finally:
        container.close()


PALETTE_SAMPLES = 16


def _gif_palette(images: torch.Tensor, colors: int) -> PILImage.Image:
    """One palette for the whole clip, sampled ACROSS it.

    Quantising each frame on its own is what makes a GIF shimmer: the table drifts frame to
    frame and flat areas crawl. But building it from the FIRST frame alone is just as wrong
    — a clip that opens on a fade gets a palette of near-blacks and everything after it
    collapses onto those few entries. Sampling evenly over the clip costs nothing here and
    is what ffmpeg's palettegen does for the same reason.
    """
    n = len(images)
    picks = {round(i * (n - 1) / max(1, PALETTE_SAMPLES - 1)) for i in range(PALETTE_SAMPLES)}
    sample = torch.cat([images[i] for i in sorted(picks)], dim=0)   # stack vertically
    return PILImage.fromarray(_to_u8(sample, 3), "RGB").quantize(
        colors=max(2, min(256, colors)), method=PILImage.Quantize.MEDIANCUT)


def encode_gif(images: torch.Tensor, path: str, fps: float, colors: int, dither: bool,
               pbar: comfy.utils.ProgressBar | None) -> None:
    d = PILImage.Dither.FLOYDSTEINBERG if dither else PILImage.Dither.NONE
    master = _gif_palette(images, colors)
    frames = []
    for frame in images:
        im = PILImage.fromarray(_to_u8(frame, 3), "RGB")
        frames.append(im.quantize(palette=master, dither=d))
        if pbar:
            pbar.update(1)
    frames[0].save(path, save_all=True, append_images=frames[1:], loop=0,
                   duration=max(1, round(1000 / max(fps, 1e-6))), disposal=2)


# ── Node ──────────────────────────────────────────────────────────────────────

class NKDVideoViewer(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="NKDVideoViewer",
            display_name="😺NKD Video Viewer",
            category="😺NKD Nodes/Preview",
            search_aliases=["video combine", "save video", "export video", "video viewer"],
            description=(
                "Encodes frames (or a video) and previews the result in a scrubbable, "
                "looping viewer with frame-accurate stepping. The file is served raw, so "
                "seeking is native rather than a re-streamed approximation."
            ),
            # Ordered the way it is CONFIGURED, not the way it was written: what the clip is
            # (fps, pingpong), how it is encoded (format + its quality knobs), then where it
            # lands (save_output, prefix, versioning, numbering).
            #
            # Sockets are wired BY INDEX and `widgets_values` is a POSITIONAL array, so this
            # order is load-bearing: from here on, anything new goes at the END or every
            # saved workflow gets silently re-wired. It could be arranged freely today only
            # because the node has not left this machine yet.
            inputs=[
                io.Image.Input("images", optional=True,
                               tooltip="Frames to encode. Takes priority over `video`."),
                io.Video.Input("video", optional=True,
                               tooltip="Re-encode an existing video instead of frames."),
                io.Audio.Input("audio", optional=True,
                               tooltip="Overrides the audio carried by `video`."),
                io.Float.Input("fps", default=24.0, min=0.01, max=1000.0, step=0.01),
                io.Boolean.Input("pingpong", default=False,
                                 tooltip="Play forward then backward, for a seamless loop."),
                # One DynamicCombo instead of the dozen loose widgets VHS carries: the
                # quality knobs of a format you did not pick are noise. Same pattern the
                # core's SaveVideo uses for its codec.
                io.DynamicCombo.Input(
                    "format",
                    options=[
                        io.DynamicCombo.Option("mp4 / h264", [
                            io.Float.Input("crf", default=19.0, min=0.0, max=51.0, step=1.0,
                                           tooltip="Lower is better quality and bigger."),
                            io.Combo.Input("preset", options=[
                                "medium", "veryfast", "fast", "slow", "veryslow"]),
                        ]),
                        io.DynamicCombo.Option("webm / vp9", [
                            io.Float.Input("crf", default=32.0, min=0.0, max=63.0, step=1.0),
                        ]),
                        io.DynamicCombo.Option("gif", [
                            io.Int.Input("colors", default=256, min=2, max=256),
                            io.Boolean.Input("dither", default=True),
                        ]),
                    ],
                ),
                io.Boolean.Input("save_output", default=True,
                                 tooltip="Off writes to temp/ — a preview you can discard."),
                io.String.Input(
                    "filename_prefix", default="video/NKD",
                    tooltip=(
                        "Relative to output/. Tokens: %node% (this node's TITLE — rename "
                        "the node to SH010_comp and it lands there), %v###% (version, one "
                        "digit per hash), %res%, %fps%, %frames%, %duration%, %format%, "
                        "%codec%, %time:HH-mm-ss%, plus ComfyUI's own %date:yyyy-MM-dd% and "
                        "%Node title.widget%. Tokens work in the folder part too."
                    ),
                ),
                io.Combo.Input(
                    "versioning", options=["off", "auto (next free)", "manual"],
                    default="off",
                    tooltip=(
                        "Adds _v001 to the name — no need to type %v###% yourself; spell "
                        "the token out only to place it elsewhere (a folder) or pad it "
                        "differently. `auto` takes the next unused version in the target "
                        "folder. Turning this on also drops ComfyUI's _00001_ counter, "
                        "which would number the same thing twice. Note that a cached graph "
                        "does not re-run, so it makes no new version — the render would be "
                        "identical; use `manual` to force one (and it overwrites, like "
                        "re-rendering a version in Nuke)."
                    ),
                ),
                io.Int.Input("version", default=1, min=1, max=99999,
                             tooltip="Used when versioning is `manual`."),
                io.Combo.Input(
                    "numbering", options=["counter", "none"], default="counter",
                    tooltip=(
                        "`counter` is ComfyUI's _00001_ suffix. `none` gives a clean name - "
                        "what you want once the version is carrying the uniqueness."
                    ),
                ),
            ],
            outputs=[io.Video.Output("video"), io.String.Output("filepath")],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo, io.Hidden.unique_id],
            is_output_node=True,
        )

    @classmethod
    def _node_title(cls) -> str:
        """The node's TITLE, which is the naming field.

        Rename the node to `SH010_comp` and `%node%` picks it up - a rename instead of a
        taxonomy of shot/task/project widgets that nobody would fill in.

        The title only exists in the frontend, so it arrives inside `extra_pnginfo.workflow`
        rather than as a hidden of its own. Two things to know about that:

        - LiteGraph OMITS `title` when it still equals the node's default, so an un-renamed
          node has no title in the workflow at all. Verified live: a renamed node serialises
          `"title": "SH010_comp"`, an untouched one serialises nothing.
        - The fallback is therefore a constant, NOT the node id: `video/73/v073_...` is not
          a name anyone wants, and the default title itself is no better - it carries an
          emoji and spaces. Two un-renamed viewers do share a folder, which is the correct
          nudge: renaming is the whole mechanism.

        `cls.hidden` is None when `execute` is called directly, as the tests do.
        """
        fallback = "NKD"
        hidden = cls.hidden
        if hidden is None or hidden.unique_id is None:
            return fallback
        node_id = str(hidden.unique_id)
        try:
            for node in (hidden.extra_pnginfo or {})["workflow"]["nodes"]:
                if str(node.get("id")) == node_id:
                    title = str(node.get("title") or "").strip()
                    # Sanitised the same way the core sanitises a substituted widget value,
                    # so a renamed node can never inject a path separator.
                    return re.sub(r'[/?<>\\:*|"\x00-\x1f\x7f]', "_", title) or fallback
        except (KeyError, TypeError, AttributeError):
            pass
        return fallback

    @classmethod
    def _resolve_prefix(cls, filename_prefix, folder, versioning, version,
                        key, spec, fps, images) -> tuple[str, int | None]:
        """Render-time tokens, then the version. Returns (prefix, version used).

        `naming` is deliberately absent: the preset was already written into
        `filename_prefix` by the frontend's context-menu templates, which is also where
        `%date:...%` gets expanded.
        """
        prefix = resolve_tokens(filename_prefix, {
            "fps": f"{fps:g}",
            "frames": len(images),
            "duration": f"{len(images) / max(fps, 1e-6):.2f}",
            "res": f"{int(images.shape[2])}x{int(images.shape[1])}",
            "width": int(images.shape[2]),
            "height": int(images.shape[1]),
            "format": spec["ext"],
            "codec": key.split("/")[-1].strip(),
            "node": cls._node_title(),
        })
        if versioning != "off" and not has_version(prefix):
            # Turning versioning ON is the whole statement; having to also type `_v%v###%`
            # is asking for the same thing twice. Appended to the FILE NAME, which is where
            # Nuke puts it (`final_comp_v01.####.exr`) - putting it on a folder would be a
            # layout decision the user did not make. Spell out the token yourself when you
            # want it somewhere else, or padded differently.
            prefix = f"{prefix}_v%v{'#' * DEFAULT_VERSION_PAD}%"
        if versioning == "off":
            # A template carrying %v###% with versioning off would otherwise write the token
            # into the filename verbatim, which is never what anyone meant.
            return apply_version(prefix, version), None
        used = (version if versioning == "manual"
                else next_version(folder, prefix, version_pad(prefix)))
        return apply_version(prefix, used), used

    @classmethod
    def execute(cls, images=None, video=None, audio=None, fps=24.0, format=None,
                filename_prefix="video/NKD", save_output=True, pingpong=False,
                versioning="off", version=1, numbering="counter"):
        key = (format or {}).get("format", "mp4 / h264")
        spec = FORMATS[key]

        # A VIDEO input has to be decomposed anyway to be re-encoded, and that is exactly
        # what the core's GetVideoComponents does. Its audio only stands in when nothing
        # was wired into `audio`.
        if images is None:
            if video is None:
                raise ValueError("😺NKD Video Viewer needs either `images` or `video`.")
            components = video.get_components()
            images = components.images
            if audio is None:
                audio = components.audio
            fps = float(components.frame_rate)

        # Captured BEFORE pingpong rebuilds the batch: the identity that matters is the one
        # handed to us by the upstream node, not a tensor we just derived from it.
        src_images = images
        src_audio = audio.get("waveform") if isinstance(audio, dict) else None
        # Everything that changes the BYTES. Destination settings (filename_prefix,
        # versioning, version, numbering, save_output) are deliberately absent - that is the
        # whole point: they move the file, they do not re-render it.
        settings = (round(float(fps), 6), bool(pingpong), json.dumps(format, sort_keys=True,
                                                                    default=str))

        if pingpong and len(images) > 2:
            # Drop the shared end frames, or the loop stutters on a doubled first and last.
            images = torch.cat([images, torch.flip(images[1:-1], dims=[0])])

        folder = (folder_paths.get_output_directory() if save_output
                  else folder_paths.get_temp_directory())
        prefix, used_version = cls._resolve_prefix(
            filename_prefix, folder, versioning, version, key, spec, fps, images)

        # Still through the core helper: it is the authority on containment (it refuses any
        # path escaping the output folder, folder_paths.py:552) and it creates the subfolder.
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, folder, images.shape[2], images.shape[1])
        os.makedirs(full_folder, exist_ok=True)
        # `none` drops ComfyUI's _00001_: once a version carries the uniqueness the counter
        # is just noise on a name you are about to drag into an edit.
        #
        # Versioning forces it, because the two together number the same thing twice
        # (`NKD_v001_00001_.mp4`). With `auto` the counter would never even leave 00001,
        # since every run lands in a fresh version. The consequence to know: re-running a
        # `manual` version OVERWRITES it - which is exactly what re-rendering v003 does in
        # Nuke, and is the point of pinning a version by hand.
        versioned = used_version is not None
        stem = filename if (numbering == "none" or versioned) else f"{filename}_{counter:05}_"
        file = f"{stem}.{spec['ext']}"
        path = os.path.join(full_folder, file)

        metadata = None
        if not args.disable_metadata:
            meta = dict(cls.hidden.extra_pnginfo or {}) if cls.hidden else {}
            if cls.hidden and cls.hidden.prompt is not None:
                meta["prompt"] = cls.hidden.prompt
            metadata = meta or None

        # Same bytes as last time? Copy them. Bumping a version must not cost a re-encode.
        node_key = str(cls.hidden.unique_id) if cls.hidden is not None else "-"
        reuse = reusable_render(node_key, src_images, src_audio, settings, spec["ext"])
        if reuse and os.path.abspath(reuse) != os.path.abspath(path):
            shutil.copy2(reuse, path)
        elif not reuse:
            pbar = comfy.utils.ProgressBar(len(images))
            if spec["vcodec"]:
                encode_video(images, path, spec, fps, (format or {}).get("crf", 19.0),
                             (format or {}).get("preset"), audio, metadata, pbar)
            else:
                encode_gif(images, path, fps, (format or {}).get("colors", 256),
                           bool((format or {}).get("dither", True)), pbar)
        remember_render(node_key, src_images, src_audio, settings, spec["ext"], path)

        result = {
            "filename": file,
            "subfolder": subfolder,
            "type": "output" if save_output else "temp",
        }
        info = {
            "fps": fps,
            "frame_count": len(images),
            "width": int(images.shape[2]),
            "height": int(images.shape[1]),
            "playable": spec["ext"] in PLAYABLE,
            "format": key,
            "size": os.path.getsize(path),
            "path": path,
            "version": used_version,
        }
        out = InputImpl.VideoFromComponents(
            Types.VideoComponents(images=images, audio=audio, frame_rate=Fraction(fps)))
        return io.NodeOutput(out, path, ui=NKDVideoUI(result, info))
