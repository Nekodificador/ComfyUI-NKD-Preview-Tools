"""😺NKD Audio Timeline — the Timeline with only its sound.

A separate NODE, but deliberately NOT a separate implementation. It speaks the exact same
`timeline` JSON, and everything below is imported from `nkd_timeline.py`: the parser, the
level envelope and the mixer. Cutting sound and cutting picture are the same arithmetic on
a different lane, and two copies of it would disagree within a month.

What it is FOR: pulling a stretch of sound out of a long take, laying several pieces
against each other, and easing in and out of the joins - without dragging a whole video
timeline (a monitor, filmstrips, mask lanes, resolution fitting) along for the ride.

    python tests/test_audio_timeline.py
"""

from __future__ import annotations

from typing import Any

import torch

from comfy_api.latest import io

# Relative when ComfyUI imports the pack as a package, absolute when a test (or this
# file's own __main__) runs it with the pack directory on sys.path. Both entry points are
# real, and the tests are the only place the mixing arithmetic gets exercised at all.
try:
    from .nkd_timeline import (
        audio_env, classify, mix_audio, muted_rows, parse_timeline, rows_to_ranges,
        timeline_span,
    )
except ImportError:                                             # pragma: no cover
    from nkd_timeline import (                                  # type: ignore[no-redef]
        audio_env, classify, mix_audio, muted_rows, parse_timeline, rows_to_ranges,
        timeline_span,
    )


def _rate(sources: dict[str, dict]) -> int:
    """The output sample rate: the first source's own, so a single-source cut is a copy
    rather than a resample. 44100 only when there is nothing to ask."""
    for src in sources.values():
        sr = int(src.get("sample_rate") or 0)
        if sr > 0:
            return sr
    return 44100


def _demux_audio(source: Any, start_time: float, duration: float) -> dict | None:
    """Decode ONLY the audio stream of a container, never a video frame.

    This is the whole point of accepting VIDEO here. `get_components()` demuxes *and
    decodes every video frame* into float32 planar RGB (`gbrpf32le`,
    comfy_api/latest/_input_impl/video_types.py:322) just to hand back a waveform that was
    sitting next to it in the same file - which is why pulling a voice out of a long take
    through Get Video Components takes minutes. Asking PyAV to demux one stream skips all
    of it.

    Returns None when the file has no audio track at all, which is not an error: a silent
    clip is a legitimate thing to drop on a timeline.
    """
    import av
    import numpy as np

    with av.open(source, mode="r") as container:
        # LAST decodable stream, matching core's `last_decodable_audio_stream`: a stream
        # FFmpeg has no decoder for carries no codec context, and decoding its packets
        # takes the process down (core hit this with the APAC spatial track iPhones write).
        stream = next((s for s in reversed(container.streams.audio)
                       if s.codec_context is not None), None)
        if stream is None:
            return None
        if start_time > 0:
            container.seek(int(start_time / stream.time_base), stream=stream)
        end_time = start_time + duration if duration > 0 else None
        # fltp = planar float, the layout an AUDIO dict wants; letting PyAV convert is
        # cheaper and more correct than unpacking whatever the codec happened to use.
        resampler = av.audio.resampler.AudioResampler(format="fltp")
        chunks: list[Any] = []
        for packet in container.demux(stream):
            for frame in packet.decode():
                t = float(frame.pts * frame.time_base) if frame.pts is not None else None
                if t is not None:
                    # A seek lands on the packet BEFORE the target, so the head still has
                    # to be dropped by hand.
                    if t + float(frame.samples) / stream.rate <= start_time:
                        continue
                    if end_time is not None and t >= end_time:
                        break
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray())
            else:
                continue
            break
        for out in resampler.resample(None):        # flush
            chunks.append(out.to_ndarray())
        if not chunks:
            return None
        wave = torch.from_numpy(np.concatenate(chunks, axis=1)).unsqueeze(0)
        return {"waveform": wave, "sample_rate": int(stream.rate)}


def audio_of_video(video: Any) -> dict | None:
    """The sound of a VIDEO input, by the cheapest route that object allows.

    Only a FILE-BACKED video can be demuxed. `VideoFromComponents` (a video already living
    as tensors) does not override `get_stream_source`, and the ABC's default implementation
    ENCODES the whole video into a BytesIO buffer - slower than the thing we are avoiding.
    For that one the components are already in memory, so asking for them is free.
    """
    from comfy_api.latest._input.video_types import VideoInput

    streamable = getattr(type(video), "get_stream_source", None) is not \
        VideoInput.get_stream_source
    if streamable:
        try:
            start, duration = video.get_active_trim_window()
        except Exception:
            start, duration = 0.0, 0.0
        try:
            return _demux_audio(video.get_stream_source(), float(start), float(duration))
        except Exception as exc:                                # pragma: no cover
            # A container PyAV chokes on must not lose the clip: fall back to the slow but
            # thoroughly exercised path rather than dropping the audio silently.
            print(f"[NKD Audio Timeline] fast audio demux failed ({exc}); "
                  f"falling back to get_components()")
    try:
        return video.get_components().audio
    except Exception:                                           # pragma: no cover
        return None


def build_audio_sources(media: dict) -> dict[str, dict]:
    """Slot name -> AUDIO dict.

    A VIDEO is accepted and reduced to its sound on the way in, because "the voice is
    inside this take" is the common case and routing it through a separate extractor node
    costs a full video decode. Anything that is neither is skipped; `classify` is the same
    check the video Timeline uses.
    """
    out: dict[str, dict] = {}
    for name, obj in (media or {}).items():
        kind = classify(obj)
        if kind == "audio":
            out[name] = obj
        elif kind == "video":
            audio = audio_of_video(obj)
            if audio is not None:
                out[name] = audio
    return out


def render_audio(timeline: dict, sources: dict[str, dict], fps: float,
                 start_frame: int, frame_count: int) -> tuple[dict, int]:
    """(AUDIO dict, frame count actually rendered).

    Pure, so the tests can drive it without a node. The window and the per-clip envelope
    are computed exactly as `NKDTimeline.execute` does - see `audio_env` for why the head
    offset is the part that must not be forgotten.
    """
    clips = timeline["audio"]
    sample_rate = _rate(sources)
    span = timeline_span([], [], clips)
    count = max(0, int(frame_count) if frame_count > 0 else span - start_frame)
    end_frame = start_frame + count

    segments: list[tuple[torch.Tensor, int, int, int, Any]] = []
    for ac in clips:
        if ac.get("muted") or ac["src"] not in sources:
            continue
        src = sources[ac["src"]]
        sr = int(src["sample_rate"])
        a = max(ac["start"], start_frame)
        b = min(ac["start"] + ac["length"], end_frame)
        if b <= a:
            continue
        trim = int(round((ac["trimIn"] + (a - ac["start"])) / fps * sr))
        segments.append((src["waveform"][0], sr,
                         int(round((a - start_frame) / fps * sr)), trim,
                         audio_env(ac, a, fps, sample_rate)))

    total = int(round(count / fps * sample_rate))
    return ({"waveform": mix_audio(segments, total, sample_rate),
             "sample_rate": sample_rate}, count)


class NKDAudioTimeline(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="NKDAudioTimeline",
            display_name="😺NKD Audio Timeline",
            category="😺NKD Nodes/Preview",
            description=(
                "Cut and arrange sound on a multi-track timeline: scrub it, blade it, "
                "set a level and drag fades in and out of the joins. Same editor as "
                "😺NKD Timeline with the picture taken away, so a reference cut does not "
                "cost a whole video timeline."
            ),
            inputs=[
                io.Autogrow.Input(
                    "media",
                    template=io.Autogrow.TemplatePrefix(
                        input=io.MultiType.Input("slot", [io.Audio, io.Video],
                                                 optional=True),
                        prefix="media_", min=1, max=12),
                    tooltip="Connect audio, or a video to work on its sound - the "
                            "picture is ignored and only the audio track is read, "
                            "without decoding a single frame. More slots appear as you "
                            "connect."),
                # APPEND-ONLY from here: `widgets_values` is a positional array in the
                # saved workflow, so a widget inserted in the middle repoints every value
                # stored after it.
                #
                # The editor's data channel. socketless + multiline=False is mandatory:
                # multiline creates a DOM textarea whose element survives being hidden.
                io.String.Input("timeline", default="", socketless=True, multiline=False),
                io.Float.Input("fps", default=24.0, min=0.1, max=240.0, step=0.001,
                               tooltip="Frames the timeline is measured in. Sound has no "
                                       "frames of its own, so this is what makes a cut "
                                       "land on the same frame as the picture it will be "
                                       "married to."),
                io.Int.Input("start_frame", default=0, min=0, max=1_000_000,
                             tooltip="First frame to render. The in point."),
                io.Int.Input("frame_count", default=0, min=0, max=1_000_000,
                             tooltip="0 = to the end of the material."),
                # APPENDED, not slotted in next to `fps` where it reads better, because
                # `widgets_values` is a positional array: inserting it in the middle would
                # make every workflow already holding this node read `fps` as the old
                # `import_mode`. Frontend-only, like the video node's copy.
                io.Combo.Input("import_mode", options=["stack", "append"],
                               default="append",
                               tooltip="Where a newly connected source lands. 'append' "
                                       "puts it after the previous one on the same lane, "
                                       "to assemble a sequence - the usual thing for "
                                       "sound. 'stack' gives each source its own lane so "
                                       "they can overlap, which is what a crossfade or a "
                                       "music bed under dialogue needs."),
            ],
            outputs=[
                io.Audio.Output(display_name="audio"),
                # Slotted next to `audio` on 2026-08-19 (Neko's call, BREAKING: sockets
                # wire by index, duration/frame_count/fps shifted by 1).
                io.String.Output(display_name="audio_ranges",
                                 tooltip="The MUTED stretches as in,out second pairs "
                                         "(e.g. 0.292,0.833), relative to the rendered "
                                         "range — the exact syntax MVEx Audio Mask To "
                                         "Latent's time_ranges input parses. Mute a clip "
                                         "to mark its sound for regeneration."),
                io.Float.Output(display_name="duration"),
                io.Int.Output(display_name="frame_count"),
                io.Float.Output(display_name="fps"),
            ],
            hidden=[io.Hidden.unique_id],
            # So it can be run on its own to hear the cut, without a save node downstream.
            is_output_node=True,
        )

    @classmethod
    def execute(cls, media: io.Autogrow.Type, timeline: str = "", fps: float = 24.0,
                start_frame: int = 0, frame_count: int = 0,
                import_mode: str = "append") -> io.NodeOutput:
        del import_mode          # frontend-only: it decides where the editor drops a clip
        fps = max(0.1, float(fps))
        sources = build_audio_sources(media)
        tl = parse_timeline(timeline)
        # No editor JSON (a graph driven from the API) still mixes what was wired in,
        # rather than coming out silent. Same fallback the video Timeline has.
        if not tl["audio"] and sources:
            tl["audio"] = [
                {"src": k, "track": 0, "start": 0, "trimIn": 0, "gain": 1.0,
                 "muted": False, "fadeIn": 0, "fadeOut": 0,
                 "length": max(1, int(round(
                     sources[k]["waveform"].shape[-1] / int(sources[k]["sample_rate"])
                     * fps)))}
                for k in sorted(sources)]

        audio, count = render_audio(tl, sources, fps, max(0, int(start_frame)),
                                    max(0, int(frame_count)))
        ranges = rows_to_ranges(muted_rows([tl["audio"]], max(0, int(start_frame)),
                                           count), fps)
        return io.NodeOutput(audio, ranges, count / fps, count, fps)


def demo() -> None:
    """Self-check. `python tests/test_audio_timeline.py` runs the full set."""
    import json

    sr = 100
    a = {"waveform": torch.ones((1, 1, 200)), "sample_rate": sr}
    b = {"waveform": torch.full((1, 1, 200), 0.5), "sample_rate": sr}
    fps = 10.0

    tl = parse_timeline(json.dumps({"audio": [
        {"src": "media_0", "start": 0, "length": 10, "gain": 1.0},
        {"src": "media_1", "start": 10, "length": 10, "gain": 1.0},
    ]}))
    out, count = render_audio(tl, {"media_0": a, "media_1": b}, fps, 0, 0)
    assert count == 20, count
    w = out["waveform"]
    assert w.shape == (1, 2, 200), w.shape
    assert abs(float(w[0, 0, 50]) - 1.0) < 1e-6      # first clip
    assert abs(float(w[0, 0, 150]) - 0.5) < 1e-6     # second clip
    assert out["sample_rate"] == sr

    # A fade-out on the first clip actually reaches the samples.
    tl2 = parse_timeline(json.dumps({"audio": [
        {"src": "media_0", "start": 0, "length": 10, "gain": 1.0, "fadeOut": 5},
    ]}))
    faded, _ = render_audio(tl2, {"media_0": a}, fps, 0, 0)
    assert float(faded["waveform"][0, 0, 0]) == 1.0
    assert float(faded["waveform"][0, 0, 99]) < 0.05

    # Nothing wired: silence of the requested length, not a crash. With no source to ask,
    # the rate falls back to 44100 - so the assertion is derived, not hardcoded.
    empty, n = render_audio(parse_timeline(""), {}, fps, 0, 30)
    assert n == 30
    assert empty["sample_rate"] == 44100
    assert empty["waveform"].shape == (1, 2, int(round(30 / fps * 44100)))
    assert float(empty["waveform"].abs().max()) == 0.0

    # A clip trimmed SHORTER than its source stops where it was cut. Nothing enforced this
    # before: the source played on to the end of the timeline.
    short = parse_timeline(json.dumps({"audio": [
        {"src": "media_0", "start": 0, "length": 5, "gain": 1.0},
    ]}))
    cut, _ = render_audio(short, {"media_0": a}, fps, 0, 20)
    assert float(cut["waveform"][0, 0, 49]) == 1.0
    assert float(cut["waveform"][0, 0, 50]) == 0.0, "the tail trim was ignored"

    print("NKD Audio Timeline - all good.")


if __name__ == "__main__":
    demo()
