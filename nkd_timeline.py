"""NKD Timeline - a video/audio coordinator.

This is not a "load video" node: it is the piece missing between the loaders and the
graph. Material comes in through the INPUTS (the stock Load Video / Load Audio, or
anything emitting VIDEO/AUDIO), gets laid out on a multi-track timeline, and the numbers
that matter -- fps, frame count, resolution, ranges -- come back out as REAL SOCKETS the
rest of the graph can be coordinated with.

The important reframing: **a gap in the timeline is a region to generate**. The `coverage`
output is 1 where there is material and 0 in the gaps, so it is directly the conditioning
mask for temporal inpainting.

All the heavy lifting is already in ComfyUI core: the native VIDEO type
(`comfy_api.latest.InputImpl.VideoFromFile`) provides `as_trimmed()` with lazy,
keyframe-seeking decoding, so no decoder is written here.
"""

from __future__ import annotations

import json
import math
import os
from fractions import Fraction
from typing import Any, Optional

import folder_paths
import torch
from typing_extensions import override

import comfy.utils
from comfy_api.latest import ComfyExtension, InputImpl, Types, io

# ── Frame-count quantisation ──────────────────────────────────────────────────
# Video models only accept certain frame counts. Getting this wrong looks fine while
# editing and blows up in the sampler twenty minutes later, so the timeline snaps to the
# grid and draws the valid stops on its ruler.
#
# Each preset is (step, offset): a valid count is `offset + step*k`. Values taken from the
# EmptyLatent nodes in ComfyUI core, which are the authority:
#   4n+1   comfy_extras/nodes_wan.py:44, nodes_hunyuan.py:61, nodes_kandinsky5.py:37,
#          nodes_cosmos.py:106, nodes_scail.py:181, nodes_bernini.py:71
#   8n+1   comfy_extras/nodes_lt.py:79 (LTXV), nodes_cosmos.py:28 (Cosmos 1)
#   6n+1   comfy_extras/nodes_mochi.py:27
#   17n+5  comfy_extras/nodes_minimax_h3.py:33 -- note this one is NOT of the Nn+1 family;
#          `align_frame_count` walks up until `n % 17 == 5`.
QUANTIZE_FREE = "free"
QUANTIZE_CUSTOM = "custom (multiple of N)"
# Split per MODEL rather than per grid, even where the grid is shared: Wan and Hunyuan
# both want 4n+1 but were trained at different frame rates, so one grouped entry could not
# carry an honest expected fps.
QUANTIZE_PRESETS: dict[str, tuple[int, int]] = {
    "Wan (4n+1)": (4, 1),
    "Hunyuan (4n+1)": (4, 1),
    "LTX (8n+1)": (8, 1),
    "Cosmos (8n+1)": (8, 1),
    "Mochi (6n+1)": (6, 1),
    "MiniMax H3 (17n+5)": (17, 5),
}

# Frame rate each family was trained at, ONLY where ComfyUI core states it outright:
#   Wan        16  comfy_extras/nodes_wan.py:526 ("model trained with 16 fps")
#   LTX        25  comfy_extras/nodes_lt.py:549 (LTXVConditioning frame_rate default)
#   MiniMax H3 24  comfy_extras/nodes_minimax_h3.py:29 (FPS = 24)
# Hunyuan, Cosmos and Mochi are absent on purpose: no rate is documented in the repo, and
# guessing one would produce a confident warning that might simply be wrong.
QUANTIZE_NATIVE_FPS: dict[str, float] = {
    "Wan (4n+1)": 16.0,
    "LTX (8n+1)": 25.0,
    "MiniMax H3 (17n+5)": 24.0,
}
QUANTIZE_MODES = [QUANTIZE_FREE, *QUANTIZE_PRESETS, QUANTIZE_CUSTOM]


def quantize_grid(mode: str, k: int = 8) -> Optional[tuple[int, int]]:
    """(step, offset) for a mode, or None when no snapping applies."""
    if mode == QUANTIZE_CUSTOM:
        return (max(1, int(k)), 0)
    return QUANTIZE_PRESETS.get(mode)


def first_stop(step: int, offset: int) -> int:
    """Smallest useful valid count.

    `offset` itself is arithmetically valid but for the Nn+1 families that means a
    single frame, which is never what someone dragging a timeline meant. So the floor is
    one full group up unless the offset already lands somewhere sensible: 4n+1 -> 5,
    8n+1 -> 9, 6n+1 -> 7, 17n+5 -> 5, multiple of N -> N.
    """
    return offset if offset > 1 else offset + step


def quantize_count(n: int, mode: str, k: int = 8) -> int:
    """Round a frame count DOWN to the nearest valid stop, never below the first one."""
    n = max(0, int(n))
    grid = quantize_grid(mode, k)
    if grid is None or n == 0:
        return n
    step, offset = grid
    low = first_stop(step, offset)
    if n <= low:
        return low
    return offset + ((n - offset) // step) * step


def quantize_stops(max_n: int, mode: str, k: int = 8) -> list[int]:
    """Every valid stop within [0, max_n] - what the editor paints on the ruler."""
    grid = quantize_grid(mode, k)
    if grid is None or max_n <= 0:
        return []
    step, offset = grid
    return list(range(first_stop(step, offset), max_n + 1, step))


# ── Defensive reading of the editor's JSON ────────────────────────────────────

def _int(v: Any, default: int = 0) -> int:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _float(v: Any, default: float = 0.0) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def _parse_clips(raw_list: Any) -> list[dict]:
    out = []
    for c in raw_list or []:
        if not isinstance(c, dict) or not c.get("src"):
            continue
        length = _int(c.get("length"))
        if length <= 0:
            continue
        out.append({
            "src": str(c["src"]),
            "track": _int(c.get("track")),
            "start": max(0, _int(c.get("start"))),
            "trimIn": max(0, _int(c.get("trimIn"))),
            "length": length,
            "muted": bool(c.get("muted")),
        })
    out.sort(key=lambda c: (c["track"], c["start"]))
    return out


def parse_timeline(raw: Any) -> dict:
    """Never raises. Corrupt JSON degrades to an empty timeline rather than taking the
    whole workflow run down with it."""
    out = {"clips": [], "masks": [], "audio": [], "tracks": [], "playhead": 0}
    if isinstance(raw, dict):
        data = raw
    else:
        if not raw or not isinstance(raw, str):
            return out
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return out
    if not isinstance(data, dict):
        return out

    # Higher tracks sit on top; write order decides who covers whom.
    tracks = data.get("tracks")
    if isinstance(tracks, list):
        out["tracks"] = [{"blend": t.get("blend", "normal")}
                         if isinstance(t, dict) else {"blend": "normal"}
                         for t in tracks]
    out["clips"] = _parse_clips(data.get("clips"))
    # The mask lane. A mask clip may point at ANY slot - a real MASK, an IMAGE batch or
    # even a video - and whatever it points at is read as a mask (luminance).
    out["masks"] = _parse_clips(data.get("masks"))
    for a in data.get("audio") or []:
        if not isinstance(a, dict) or not a.get("src"):
            continue
        length = _int(a.get("length"))
        if length <= 0:
            continue
        out["audio"].append({
            "src": str(a["src"]),
            "start": max(0, _int(a.get("start"))),
            "trimIn": max(0, _int(a.get("trimIn"))),
            "length": length,
            "gain": _float(a.get("gain"), 1.0),
            "muted": bool(a.get("muted")),
        })

    ui_state = data.get("ui")
    if isinstance(ui_state, dict):
        out["playhead"] = max(0, _int(ui_state.get("playhead")))
    return out


def timeline_span(*lanes: list[dict]) -> int:
    """Last frame occupied by any lane."""
    ends = [c["start"] + c["length"] for lane in lanes for c in lane]
    return max(ends) if ends else 0


def source_frame(clip: dict, f: int, src_fps: float, fps: float) -> int:
    """Source frame corresponding to timeline frame `f`.

    When the frame rates differ this IS the resampling: 30 -> 24 drops frames, 24 -> 30
    repeats them. It is the easiest thing in this node to get subtly wrong, which is why
    it is isolated and tested.
    """
    if fps <= 0:
        return clip["trimIn"]
    return clip["trimIn"] + int(round((f - clip["start"]) * (src_fps / fps)))


# ── Track blending ────────────────────────────────────────────────────────────
# Stacking two versions of a shot and reading the difference is a big part of why this node
# has tracks at all. These four are the ones a browser canvas can do natively, so the
# editor's preview shows the real composite and not an approximation of it.

BLEND_MODES = ["normal", "screen", "multiply", "difference"]


def blend_pixels(base: torch.Tensor, top: torch.Tensor, mode: str) -> torch.Tensor:
    """Composite `top` over `base`, both [.., C] in 0..1."""
    if mode == "screen":
        return 1.0 - (1.0 - base) * (1.0 - top)
    if mode == "multiply":
        return base * top
    if mode == "difference":
        return (base - top).abs()
    return top


def track_blend(tracks: list[dict], track: int) -> str:
    if 0 <= track < len(tracks):
        mode = tracks[track].get("blend")
        if mode in BLEND_MODES:
            return mode
    return "normal"


# ── One view over VIDEO / IMAGE / MASK sources ────────────────────────────────
# An IMAGE input is literally a frame sequence and a MASK is a batch of them, so both sit
# on the timeline exactly like a video. The only real difference is that a tensor batch has
# no intrinsic frame rate: it runs at the timeline rate, one element per timeline frame.

def classify(obj: Any) -> Optional[str]:
    """What kind of media is this? "video" | "image" | "mask" | "audio", or None.

    Every input arrives through ONE multi-type socket, so the kind is recovered from the
    object itself rather than from which group it was wired into. The four are trivially
    distinguishable and never ambiguous:
      AUDIO  a dict carrying a waveform
      VIDEO  a VideoInput (duck-typed on get_frame_rate, so any implementation counts)
      IMAGE  a [N,H,W,C] tensor
      MASK   a [N,H,W] tensor
    """
    if obj is None:
        return None
    if isinstance(obj, dict):
        return "audio" if "waveform" in obj else None
    if torch.is_tensor(obj):
        if obj.ndim == 4:
            return "image"
        if obj.ndim == 3:
            return "mask"
        return None
    if hasattr(obj, "get_frame_rate") and hasattr(obj, "get_components"):
        return "video"
    return None


def build_sources(media: dict) -> tuple[dict[str, tuple[str, Any]], dict[str, dict]]:
    """(picture sources, audio sources) keyed by slot name.

    Audio is split out because it feeds the mixer rather than the picture pipeline.
    """
    visual: dict[str, tuple[str, Any]] = {}
    audio: dict[str, dict] = {}
    for name, obj in (media or {}).items():
        kind = classify(obj)
        if kind == "audio":
            audio[name] = obj
        elif kind is not None:
            visual[name] = (kind, obj)
    return visual, audio


def source_meta(kind: str, obj: Any, fps: float) -> tuple[float, int]:
    """(native fps, frame count) for any source kind."""
    if kind == "video":
        return float(obj.get_frame_rate()) or fps, int(obj.get_frame_count())
    return fps, int(obj.shape[0])


def _to_rgb(t: torch.Tensor) -> torch.Tensor:
    """Anything -> [N,H,W,3]. A mask becomes the grey image it looks like."""
    if t.ndim == 3:                      # [N,H,W] mask
        return t.unsqueeze(-1).repeat(1, 1, 1, 3)
    if t.shape[-1] == 1:
        return t.repeat(1, 1, 1, 3)
    return t[..., :3]


def _to_mask(t: torch.Tensor) -> torch.Tensor:
    """Anything -> [N,H,W]. Colour is read as luminance, which is what makes "use this
    video as a mask" work without a separate conversion node."""
    if t.ndim == 3:
        return t
    if t.shape[-1] == 1:
        return t[..., 0]
    # Rec.709 luma - the same weighting every mask-from-image node in the ecosystem uses.
    return (t[..., 0] * 0.2126 + t[..., 1] * 0.7152 + t[..., 2] * 0.0722)


def gather_window(kind: str, obj: Any, clip: dict, a: int, b: int,
                  fps: float) -> tuple[Optional[torch.Tensor], Optional[dict]]:
    """Frames covering timeline range [a, b), plus this clip's audio when it has any.

    For video this is ONE lazy, keyframe-seeking decode of just the window needed, then a
    gather by index. For tensor sources it is only the gather.
    """
    src_fps, total = source_meta(kind, obj, fps)
    if total <= 0 or b <= a:
        return None, None

    s0 = source_frame(clip, a, src_fps, fps)
    s1 = source_frame(clip, b - 1, src_fps, fps)
    lo, hi = min(s0, s1), max(s0, s1)
    audio = None

    if kind == "video":
        window = obj.as_trimmed(max(0, lo) / src_fps, (hi - lo + 1) / src_fps,
                                strict_duration=False)
        comps = (window or obj).get_components()
        frames = comps.images
        audio = comps.audio
    else:
        lo = max(0, min(lo, total - 1))
        hi = max(lo, min(hi, total - 1))
        frames = obj[lo:hi + 1]

    if frames is None or frames.shape[0] == 0:
        return None, None
    idx = torch.tensor(
        [min(max(source_frame(clip, f, src_fps, fps) - lo, 0), frames.shape[0] - 1)
         for f in range(a, b)], dtype=torch.long)
    return frames.index_select(0, idx), audio


# ── Resolution fitting ────────────────────────────────────────────────────────

def fit_frames(t: torch.Tensor, width: int, height: int, mode: str) -> torch.Tensor:
    """`t` is [N,H,W,C] (or [N,H,W] for a mask) in 0..1. Returns the same rank, resized.

    The editor's preview mirrors these three modes exactly, so what you scrub is what
    gets rendered.
    """
    if t.ndim == 3:
        # Mask: fit it as a THREE-channel image and take one channel back. Not as a
        # single-channel one - `comfy.utils.lanczos` deliberately squeezes grayscale
        # (utils.py:1062, "the below API is strict"), so a [N,H,W,1] tensor returns rank 3
        # and every shape downstream breaks. The RGB path is the well-trodden one and the
        # extra channels cost nothing measurable at mask sizes.
        return fit_frames(t.unsqueeze(-1).repeat(1, 1, 1, 3), width, height, mode)[..., 0]
    if t.shape[1] == height and t.shape[2] == width:
        return t
    chw = t.movedim(-1, 1)  # common_upscale wants [N,C,H,W]
    if mode == "cover":
        out = comfy.utils.common_upscale(chw, width, height, "lanczos", "center")
    elif mode == "stretch":
        out = comfy.utils.common_upscale(chw, width, height, "lanczos", "disabled")
    else:  # contain - scale to fit whole, pad the remainder with black
        src_h, src_w = chw.shape[-2], chw.shape[-1]
        scale = min(width / src_w, height / src_h)
        inner_w = max(1, int(round(src_w * scale)))
        inner_h = max(1, int(round(src_h * scale)))
        inner = comfy.utils.common_upscale(chw, inner_w, inner_h, "lanczos", "disabled")
        out = torch.zeros((chw.shape[0], chw.shape[1], height, width), dtype=chw.dtype)
        y = (height - inner_h) // 2
        x = (width - inner_w) // 2
        out[:, :, y:y + inner_h, x:x + inner_w] = inner
    return out.movedim(1, -1).clamp(0.0, 1.0)


# ── Audio ─────────────────────────────────────────────────────────────────────

def _resample(wave: torch.Tensor, src_sr: int, dst_sr: int) -> torch.Tensor:
    """ponytail: linear resampling via `interpolate` instead of pulling in torchaudio.
    No new dependency and good enough for mixing reference tracks. If master-grade quality
    is ever needed, a polyphase resampler goes here."""
    if src_sr == dst_sr or wave.shape[-1] == 0:
        return wave
    n = max(1, int(round(wave.shape[-1] * dst_sr / src_sr)))
    return torch.nn.functional.interpolate(wave, size=n, mode="linear", align_corners=False)


def _as_2ch(wave: torch.Tensor) -> torch.Tensor:
    """[C,T] -> [2,T]. Mono is duplicated, multichannel is cut to the first two."""
    if wave.shape[0] == 1:
        return wave.repeat(2, 1)
    return wave[:2] if wave.shape[0] > 2 else wave


def mix_audio(segments: list[tuple[torch.Tensor, int, int, int, float]],
              total_samples: int, sample_rate: int) -> torch.Tensor:
    """Additive mix into a [1,2,total_samples] buffer.

    Each segment is (waveform[C,T], source_sample_rate, offset_samples, trim_samples,
    gain).
    """
    buf = torch.zeros((2, max(0, total_samples)), dtype=torch.float32)
    if total_samples <= 0:
        return buf.unsqueeze(0)
    for wave, sr, offset, trim, gain in segments:
        if wave is None or wave.numel() == 0:
            continue
        w = _resample(_as_2ch(wave.to(torch.float32)).unsqueeze(0), sr, sample_rate)[0]
        if trim > 0:
            w = w[:, trim:]
        if w.shape[-1] == 0:
            continue
        dst_a = max(0, offset)
        src_a = max(0, -offset)
        n = min(w.shape[-1] - src_a, total_samples - dst_a)
        if n <= 0:
            continue
        buf[:, dst_a:dst_a + n] += w[:, src_a:src_a + n] * gain
    return buf.clamp(-1.0, 1.0).unsqueeze(0)


# ── Probe route ───────────────────────────────────────────────────────────────
# The frontend needs the EXACT frame count and fps before anything runs, and the browser's
# <video> element does not report them reliably. Path resolution is as strict as core's
# /view: absolute client-supplied paths are never honoured.

_probe_cache: dict[str, tuple[float, dict]] = {}


def _resolve_input_path(filename: str, type_: str, subfolder: str) -> Optional[str]:
    base = folder_paths.get_directory_by_type(type_ or "input")
    if not base:
        return None
    if subfolder:
        base = os.path.join(base, subfolder)
    path = os.path.abspath(os.path.join(base, os.path.basename(filename)))
    root = os.path.abspath(folder_paths.get_directory_by_type(type_ or "input"))
    try:
        # commonpath raises when the paths sit on different drives - that is a reject.
        if os.path.commonpath([path, root]) != root:
            return None
    except ValueError:
        return None
    return path if os.path.isfile(path) else None


def probe_media(path: str) -> dict:
    """Exact fps / frame count / duration / size, cached by mtime."""
    mtime = os.path.getmtime(path)
    hit = _probe_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    video = InputImpl.VideoFromFile(path)
    width, height = video.get_dimensions()
    info = {
        "fps": float(video.get_frame_rate()),
        "frame_count": int(video.get_frame_count()),
        "duration": float(video.get_duration()),
        "width": int(width),
        "height": int(height),
    }
    _probe_cache[path] = (mtime, info)
    return info


def _register_routes() -> None:
    # try/except as in Basic-Tools/nkd_spline_preview.py: aiohttp refuses duplicate
    # registrations, and the tests run with no server at all.
    try:
        from aiohttp import web
        from server import PromptServer

        @PromptServer.instance.routes.get("/nkd/timeline/probe")
        async def _probe(request):  # noqa: ANN001
            q = request.rel_url.query
            path = _resolve_input_path(q.get("filename", ""), q.get("type", "input"),
                                       q.get("subfolder", ""))
            if not path:
                return web.json_response({"error": "not found"}, status=404)
            try:
                return web.json_response(probe_media(path))
            except Exception as exc:  # noqa: BLE001 - an unreadable file must not 500
                return web.json_response({"error": str(exc)}, status=422)
    except Exception as exc:  # noqa: BLE001
        # The tests run without a server, so failing here is legitimate. But NOT
        # silently: registering too late (after the route table is frozen) raises exactly
        # this and leaves the probe answering 404 for files that plainly exist.
        print(f"[NKD Timeline] probe route not registered: {exc!r}")


_register_routes()


# ── The node ──────────────────────────────────────────────────────────────────

class NKDTimeline(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDTimeline",
            display_name="😺NKD Timeline",
            category="😺NKD Nodes/Preview",
            description=(
                "Lay several videos and audio tracks on a multi-track timeline and get "
                "fps, frame count and resolution back as connectable sockets, so the "
                "material can be coordinated before it enters the graph. Gaps in the "
                "timeline are regions to generate: the `coverage` output is 0 there, "
                "ready to use as a temporal inpainting mask."
            ),
            inputs=[
                # ONE growing list that takes whatever you plug in. The socket carries a
                # multi-type ("VIDEO,IMAGE,MASK,AUDIO"); the kind is recovered from the
                # object at execute time, and the editor puts each source on the lane its
                # type belongs to. Same shape KJNodes ships in SimpleCalculatorKJ.
                io.Autogrow.Input(
                    "media",
                    template=io.Autogrow.TemplatePrefix(
                        input=io.MultiType.Input(
                            "slot", [io.Video, io.Image, io.Mask, io.Audio],
                            optional=True),
                        prefix="media_", min=1, max=24),
                    tooltip="Connect a video, an image sequence, a mask or audio - the "
                            "same socket takes any of them and the timeline puts it on "
                            "the right lane. More slots appear as you connect."),
                # The editor's data channel. socketless + multiline=False is mandatory:
                # multiline creates a DOM textarea whose element survives being hidden.
                io.String.Input("timeline", default="", socketless=True, multiline=False),
                # Frontend-only: decides where a newly connected source lands. Kept as a
                # real widget so it serialises with the workflow like everything else.
                io.Combo.Input("import_mode", options=["stack", "append"],
                               default="stack",
                               tooltip="Where a newly connected source is placed. "
                                       "'stack' gives each one its own track from frame "
                                       "0, so they layer like any other timeline - the "
                                       "higher track is the one you see. 'append' puts "
                                       "it after the previous one on the same track, to "
                                       "assemble a sequence."),
                io.Float.Input("fps", default=24.0, min=1.0, max=240.0, step=0.01,
                               tooltip="Timeline frame rate. Sources at a different rate "
                                       "are resampled."),
                io.Int.Input("start_frame", default=0, min=0, max=1_000_000),
                io.Int.Input("frame_count", default=0, min=0, max=1_000_000,
                             tooltip="0 = up to the end of the last clip."),
                io.Int.Input("width", default=0, min=0, max=16384, step=8,
                             tooltip="0 = take the width of the first clip."),
                io.Int.Input("height", default=0, min=0, max=16384, step=8,
                             tooltip="0 = take the height of the first clip."),
                io.Combo.Input("fit", options=["contain", "cover", "stretch"],
                               default="contain",
                               tooltip="How a clip is fitted when its aspect ratio does "
                                       "not match the output. The preview shows this "
                                       "live."),
                io.Combo.Input("quantize", options=QUANTIZE_MODES, default=QUANTIZE_FREE,
                               tooltip="Snap the frame count to the grid the model "
                                       "requires. Wan, Hunyuan Video, Kandinsky, Cosmos "
                                       "Predict and SCAIL use 4n+1; LTX and Cosmos 1 use "
                                       "8n+1; Mochi uses 6n+1; MiniMax H3 uses 17n+5."),
                io.Int.Input("quantize_n", default=8, min=1, max=256,
                             tooltip="Only used by 'custom (multiple of N)'."),
                io.Boolean.Input("clip_audio", default=True,
                                 tooltip="Include the videos' own audio in the mix."),
            ],
            outputs=[
                io.Image.Output(display_name="images"),
                io.Mask.Output(display_name="mask"),
                io.Mask.Output(display_name="coverage"),
                io.Audio.Output(display_name="audio"),
                io.Video.Output(display_name="video"),
                io.Float.Output(display_name="fps"),
                io.Int.Output(display_name="frame_count"),
                io.Int.Output(display_name="width"),
                io.Int.Output(display_name="height"),
                io.Int.Output(display_name="current_frame"),
                # Appended at the END on purpose: inserting these next to the outputs
                # they belong with would shift every later index and silently rewire
                # saved workflows.
                io.Image.Output(display_name="current_image"),
                io.Float.Output(display_name="duration",
                                tooltip="Length of the output range in seconds."),
            ],
        )

    @classmethod
    def execute(cls, media: io.Autogrow.Type, timeline: str,
                import_mode: str, fps: float, start_frame: int, frame_count: int,
                width: int, height: int, fit: str, quantize: str, quantize_n: int,
                clip_audio: bool) -> io.NodeOutput:
        del import_mode   # placement happens in the editor; the backend reads the result
        sources, auds = build_sources(media)

        tl = parse_timeline(timeline)
        clips = [c for c in tl["clips"] if c["src"] in sources]
        maskclips = [c for c in tl["masks"] if c["src"] in sources]
        auclips = [a for a in tl["audio"] if a["src"] in auds]

        fps = max(1e-6, float(fps))

        # With no editor JSON yet (freshly dropped node) every connected picture source
        # gets its own track from frame 0, so the node does something sensible untouched.
        if not clips and sources:
            visual = [k for k in sorted(sources) if sources[k][0] != "mask"]
            clips = [{"src": k, "track": i, "start": 0, "trimIn": 0,
                      "length": source_meta(*sources[k], fps)[1]}
                     for i, k in enumerate(visual)]
        if not maskclips and not clips:
            maskclips = [{"src": k, "track": 0, "start": 0, "trimIn": 0,
                          "length": source_meta(*sources[k], fps)[1]}
                         for k in sorted(sources) if sources[k][0] == "mask"]
        # Audio too, so a graph driven purely from the API (no editor JSON) still mixes
        # whatever was wired in rather than coming out silent.
        if not auclips and auds:
            auclips = [{"src": k, "start": 0, "trimIn": 0, "gain": 1.0, "muted": False,
                        "length": max(1, int(round(
                            auds[k]["waveform"].shape[-1] / int(auds[k]["sample_rate"])
                            * fps)))}
                       for k in sorted(auds)]

        span = timeline_span(clips, maskclips, auclips)
        start_frame = max(0, int(start_frame))
        count = int(frame_count) if frame_count else max(0, span - start_frame)
        count = quantize_count(count, quantize, quantize_n)
        if count <= 0:
            raise ValueError(
                "NKD Timeline: the timeline is empty. Connect a video, image sequence or "
                "mask, or set frame_count by hand.")

        # Output resolution: that of the first clip unless stated.
        if width <= 0 or height <= 0:
            first = (clips or maskclips)
            if first:
                kind, obj = sources[first[0]["src"]]
                if kind == "video":
                    w0, h0 = obj.get_dimensions()
                else:
                    h0, w0 = int(obj.shape[1]), int(obj.shape[2])
            else:
                w0, h0 = 512, 512
            width = int(width) if width > 0 else int(w0)
            height = int(height) if height > 0 else int(h0)

        out = torch.zeros((count, height, width, 3), dtype=torch.float32)
        mask_out = torch.zeros((count, height, width), dtype=torch.float32)
        coverage = torch.zeros((count, height, width), dtype=torch.float32)
        # Which output frames already carry picture. A blend needs something underneath to
        # blend WITH: the bottom-most clip on a frame always writes straight, whatever its
        # track mode says, or `multiply` over the initial black would just erase it.
        written = torch.zeros(count, dtype=torch.bool)
        audio_segments: list[tuple[torch.Tensor, int, int, int, float]] = []
        sample_rate = 0

        end_frame = start_frame + count
        for clip in clips:  # already sorted by track, so higher ones overwrite
            a = max(clip["start"], start_frame)
            b = min(clip["start"] + clip["length"], end_frame)
            if b <= a:
                continue
            kind, obj = sources[clip["src"]]
            frames, audio = gather_window(kind, obj, clip, a, b, fps)
            if frames is None:
                continue
            lo_i, hi_i = a - start_frame, b - start_frame
            fitted = fit_frames(_to_rgb(frames), width, height, fit)
            mode = track_blend(tl["tracks"], clip["track"])
            if mode == "normal":
                out[lo_i:hi_i] = fitted
            else:
                base = out[lo_i:hi_i]
                blended = blend_pixels(base, fitted, mode).clamp(0.0, 1.0)
                # Frame-wise: only blend where something is already there.
                have = written[lo_i:hi_i].view(-1, 1, 1, 1)
                out[lo_i:hi_i] = torch.where(have, blended, fitted)
            written[lo_i:hi_i] = True
            coverage[lo_i:hi_i] = 1.0

            if clip_audio and audio is not None and not clip.get("muted"):
                wave = audio["waveform"]
                sr = int(audio["sample_rate"])
                sample_rate = sample_rate or sr
                src_fps = source_meta(kind, obj, fps)[0]
                s0 = source_frame(clip, a, src_fps, fps)
                s1 = source_frame(clip, b - 1, src_fps, fps)
                # The decoded window starts at min(s0,s1); the offset to `a` is the trim.
                trim = int(round((s0 - min(s0, s1)) / src_fps * sr))
                audio_segments.append((wave[0], sr,
                                       int(round((a - start_frame) / fps * sr)), trim, 1.0))

        # The mask lane. A mask clip may point at ANY slot: a real MASK passes through, an
        # image or video is read as luminance. That is "use this video as a mask".
        for clip in maskclips:
            a = max(clip["start"], start_frame)
            b = min(clip["start"] + clip["length"], end_frame)
            if b <= a:
                continue
            kind, obj = sources[clip["src"]]
            frames, _ = gather_window(kind, obj, clip, a, b, fps)
            if frames is None:
                continue
            mask_out[a - start_frame:b - start_frame] = fit_frames(
                _to_mask(frames), width, height, fit).clamp(0.0, 1.0)

        for ac in auclips:
            if ac.get("muted"):
                continue
            src = auds[ac["src"]]
            sr = int(src["sample_rate"])
            sample_rate = sample_rate or sr
            a = max(ac["start"], start_frame)
            b = min(ac["start"] + ac["length"], end_frame)
            if b <= a:
                continue
            trim = int(round((ac["trimIn"] + (a - ac["start"])) / fps * sr))
            audio_segments.append((src["waveform"][0], sr,
                                   int(round((a - start_frame) / fps * sr)), trim,
                                   ac["gain"]))

        sample_rate = sample_rate or 44100
        total_samples = int(round(count / fps * sample_rate))
        audio_out = {"waveform": mix_audio(audio_segments, total_samples, sample_rate),
                     "sample_rate": sample_rate}

        video_out = InputImpl.VideoFromComponents(Types.VideoComponents(
            images=out, audio=audio_out, frame_rate=Fraction(round(fps * 1000), 1000)))
        current = max(0, min(tl["playhead"], count - 1))
        # The frame under the playhead, as a one-image batch. Taken from `out`, so it is
        # the FULLY COMPOSITED frame - track blends and all - not a re-read of a source.
        # Scrubbing changes the timeline widget, which invalidates the cache, so this
        # tracks the playhead on the next run: the playhead drives the graph.
        current_image = out[current:current + 1]

        # Seconds, from the QUANTISED count - what actually gets rendered, not what was
        # asked for. Reading it off the raw request would drift from the real output the
        # moment a model grid is in play.
        duration = count / fps

        return io.NodeOutput(out, mask_out, coverage, audio_out, video_out,
                             float(fps), int(count), int(width), int(height), int(current),
                             current_image, float(duration))


class NKDTimelineExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [NKDTimeline]


NODE_CLASS_MAPPINGS = {"NKDTimeline": NKDTimeline}
NODE_DISPLAY_NAME_MAPPINGS = {"NKDTimeline": "😺NKD Timeline"}
