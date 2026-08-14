"""Checks for 😺NKD Audio Timeline.

    python tests/test_audio_timeline.py

The mixing arithmetic itself lives in `nkd_timeline.py` and is covered by
`tests/test_timeline.py`; what is asserted here is what this node adds on top - the
window, the fallback when no editor JSON exists, and the outputs.
"""

import os
import sys

_PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PACK)
# The node imports folder_paths / comfy.utils from core: custom_nodes/<pack>/ -> ComfyUI/
sys.path.insert(0, os.path.dirname(os.path.dirname(_PACK)))

from fractions import Fraction  # noqa: E402
from json import dumps  # noqa: E402

import torch  # noqa: E402

from nkd_timeline import parse_timeline  # noqa: E402

from nkd_audio_timeline import (  # noqa: E402
    NKDAudioTimeline, build_audio_sources, demo, render_audio,
)

SR = 100
FPS = 10.0


def clip(**kw):
    return {"src": "media_0", "start": 0, "length": 10, "gain": 1.0, **kw}


def tone(value=1.0, samples=200):
    return {"waveform": torch.full((1, 1, samples), value), "sample_rate": SR}


def outs(r):
    """The result tuple keyed by the schema's OUTPUT NAMES - indexing by number is how a
    socket reorder slips past a whole test file with every assertion still green."""
    names = [o.display_name for o in NKDAudioTimeline.define_schema().outputs]
    assert len(names) == len(r.result), (len(names), len(r.result))
    return dict(zip(names, r.result))


def test_demo():
    demo()


def test_only_audio_and_video_are_accepted():
    """The socket takes AUDIO and VIDEO. A stray IMAGE (a MultiType further up a chain can
    still deliver one) must be skipped rather than crash the mix."""
    srcs = build_audio_sources({
        "media_0": tone(), "media_1": torch.rand((4, 8, 8, 3)), "media_2": None,
    })
    assert list(srcs) == ["media_0"]
    assert build_audio_sources({}) == {}
    assert build_audio_sources(None) == {}


def _components_video(audio):
    """A VIDEO that lives as TENSORS. It cannot be demuxed - `VideoFromComponents` does
    not override `get_stream_source`, and the ABC's default ENCODES the whole video into a
    buffer, which is slower than the thing we are avoiding - so this exercises the
    get_components() branch."""
    from comfy_api.latest import Types
    from comfy_api.latest._input_impl.video_types import VideoFromComponents
    return VideoFromComponents(Types.VideoComponents(
        images=torch.rand((4, 8, 8, 3)), audio=audio, frame_rate=Fraction(10)))


def test_a_video_arrives_as_its_sound():
    """The point of accepting VIDEO: "the voice is inside this take" without paying for a
    full video decode through a separate extractor node."""
    src = build_audio_sources({"media_0": _components_video(tone(0.5))})
    assert list(src) == ["media_0"]
    assert float(src["media_0"]["waveform"].abs().max()) == 0.5

    # A silent video is skipped, not an error: nothing to put on the timeline.
    assert build_audio_sources({"media_0": _components_video(None)}) == {}


def test_a_file_backed_video_is_demuxed_without_decoding_a_frame():
    """MEASURED, not assumed: `get_components()` decodes every video frame to float32
    planar RGB just to hand back a waveform sitting beside it in the same file. On a 0.5 MB
    clip that is 4.12 s against 0.05 s for demuxing the audio stream alone - and the two
    waveforms are BIT-IDENTICAL, which is the assertion that matters here.

    Skipped when the sample file is absent; it is a fixture of Neko's install, not of the
    repo.
    """
    import time

    from comfy_api.latest._input_impl.video_types import VideoFromFile

    path = os.path.join(os.path.dirname(os.path.dirname(_PACK)),
                        "input", "videoplayback_2.mp4")
    if not os.path.exists(path):
        print("      (skipped: no sample video)")
        return

    t0 = time.perf_counter()
    fast = build_audio_sources({"media_0": VideoFromFile(path)})["media_0"]
    fast_s = time.perf_counter() - t0

    t0 = time.perf_counter()
    slow = VideoFromFile(path).get_components().audio
    slow_s = time.perf_counter() - t0

    assert fast["sample_rate"] == slow["sample_rate"]
    assert torch.equal(fast["waveform"], slow["waveform"]), "the fast path changed the audio"
    assert fast_s < slow_s, f"the fast path was not faster ({fast_s:.3f} vs {slow_s:.3f})"
    print(f"      ({fast_s:.3f}s vs {slow_s:.3f}s, {slow_s / max(fast_s, 1e-9):.0f}x)")

    # A trimmed Load Video hands over a trimmed VideoInput, and the sound has to follow it
    # - within one audio frame, which is the granularity a container can seek to.
    trimmed = build_audio_sources(
        {"media_0": VideoFromFile(path, start_time=2.0, duration=3.0)})["media_0"]
    secs = trimmed["waveform"].shape[-1] / trimmed["sample_rate"]
    assert abs(secs - 3.0) < 0.05, f"trim window ignored: got {secs:.3f}s"


def test_clips_land_where_the_editor_put_them():
    tl = parse_timeline(dumps({"audio": [
        clip(src="media_0", start=0, length=10),
        clip(src="media_1", start=10, length=10),
    ]}))
    out, count = render_audio(tl, {"media_0": tone(1.0), "media_1": tone(0.5)}, FPS, 0, 0)
    w = out["waveform"]
    assert count == 20
    assert w.shape == (1, 2, 200)
    assert abs(float(w[0, 0, 50]) - 1.0) < 1e-6
    assert abs(float(w[0, 0, 150]) - 0.5) < 1e-6
    # Mono is duplicated to stereo, the way every AUDIO consumer downstream expects.
    assert torch.equal(w[0, 0], w[0, 1])


def test_trimming_the_tail_actually_shortens_the_sound():
    """Nothing enforced the clip's length before this: the source played on to the end of
    the timeline, so a tail trim was silently ignored for audio."""
    tl = parse_timeline(dumps({"audio": [clip(length=5)]}))
    out, _ = render_audio(tl, {"media_0": tone()}, FPS, 0, 20)
    w = out["waveform"]
    assert float(w[0, 0, 49]) == 1.0
    assert float(w[0, 0, 50]) == 0.0


def test_the_window_is_start_frame_plus_count():
    tl = parse_timeline(dumps({"audio": [clip(length=30)]}))
    # Render frames 10..20 of a 30-frame clip: 10 frames, all inside the material.
    out, count = render_audio(tl, {"media_0": tone(1.0, 600)}, FPS, 10, 10)
    assert count == 10
    assert out["waveform"].shape == (1, 2, 100)
    assert float(out["waveform"].abs().min()) == 1.0, "the window landed off the material"
    # frame_count 0 means "to the end of the material", measured from start_frame.
    _, full = render_audio(tl, {"media_0": tone(1.0, 600)}, FPS, 10, 0)
    assert full == 20


def test_a_fade_reaches_the_samples():
    tl = parse_timeline(dumps({"audio": [
        clip(length=10, fadeIn=5, fadeOut=5),
    ]}))
    out, _ = render_audio(tl, {"media_0": tone()}, FPS, 0, 0)
    w = out["waveform"][0, 0]
    assert float(w[0]) == 0.0
    assert abs(float(w[25]) - 0.5) < 1e-6      # halfway through a 50-sample fade-in
    assert float(w[50]) == 1.0
    assert float(w[99]) < 0.05
    # Muted wins over the ramp.
    muted = parse_timeline(dumps({"audio": [clip(length=10, muted=True)]}))
    out2, _ = render_audio(muted, {"media_0": tone()}, FPS, 0, 0)
    assert float(out2["waveform"].abs().max()) == 0.0


def test_a_missing_slot_is_skipped_not_fatal():
    """A clip can outlive the connection that made it - unplug the source and the JSON
    still names the slot. That must not take the run down."""
    tl = parse_timeline(dumps({"audio": [clip(src="media_7")]}))
    out, count = render_audio(tl, {}, FPS, 0, 10)
    assert count == 10
    assert float(out["waveform"].abs().max()) == 0.0


def test_the_output_rate_follows_the_source():
    """A single-source cut should be a copy, not a resample, so the first source's rate
    wins rather than a fixed 44100."""
    tl = parse_timeline(dumps({"audio": [clip()]}))
    src = {"waveform": torch.ones((1, 1, 480)), "sample_rate": 48000}
    out, _ = render_audio(tl, {"media_0": src}, FPS, 0, 0)
    assert out["sample_rate"] == 48000
    assert out["waveform"].shape == (1, 2, int(round(10 / FPS * 48000)))


def test_no_editor_json_still_mixes_what_is_wired():
    """A graph driven from the API has no timeline string. Coming out silent would be a
    confusing way to say "you did not open the editor"."""
    r = NKDAudioTimeline.execute({"media_0": tone(1.0, 200)}, "", FPS, 0, 0)
    o = outs(r)
    assert o["fps"] == FPS
    assert o["frame_count"] == 20               # 200 samples at 100 Hz = 2 s = 20 frames
    assert abs(o["duration"] - 2.0) < 1e-9
    assert float(o["audio"]["waveform"].abs().max()) == 1.0


def test_execute_reports_a_duration_that_matches_the_frames():
    tl = dumps({"audio": [clip(length=13)]})
    o = outs(NKDAudioTimeline.execute({"media_0": tone(1.0, 400)}, tl, FPS, 0, 0))
    assert o["frame_count"] == 13
    assert abs(o["duration"] - 13 / FPS) < 1e-9
    assert o["audio"]["waveform"].shape[-1] == int(round(13 / FPS * SR))

    # An absurd fps is clamped rather than dividing by zero.
    o0 = outs(NKDAudioTimeline.execute({"media_0": tone()}, tl, 0.0, 0, 0))
    assert o0["fps"] >= 0.1 and o0["duration"] > 0

    # `import_mode` is frontend-only - it decides where the EDITOR drops a newly connected
    # clip - but it is a real widget, so the signature has to accept it and the render has
    # to be identical either way.
    a = outs(NKDAudioTimeline.execute({"media_0": tone(1.0, 400)}, tl, FPS, 0, 0, "stack"))
    b = outs(NKDAudioTimeline.execute({"media_0": tone(1.0, 400)}, tl, FPS, 0, 0, "append"))
    assert torch.equal(a["audio"]["waveform"], b["audio"]["waveform"])


def test_nothing_connected_at_all():
    o = outs(NKDAudioTimeline.execute({}, "", FPS, 0, 24))
    assert o["frame_count"] == 24
    assert float(o["audio"]["waveform"].abs().max()) == 0.0


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    # No emoji: the Windows console is cp1252 and would blow up printing one.
    print("\nNKD Audio Timeline - all good.")
