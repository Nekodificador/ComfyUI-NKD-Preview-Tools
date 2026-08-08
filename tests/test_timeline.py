"""Checks for the non-trivial logic in NKD Timeline.

Covers what breaks silently: frame resampling when the rates differ, model
quantisation, and the arithmetic of the audio mix. No frameworks - plain `assert`
and a `__main__`.

    python tests/test_timeline.py
"""

import os
import sys

_PACK = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PACK)
# The node imports folder_paths / comfy.utils from core: custom_nodes/<pack>/ -> ComfyUI/
sys.path.insert(0, os.path.dirname(os.path.dirname(_PACK)))

import torch  # noqa: E402

from nkd_timeline import (  # noqa: E402
    BLEND_MODES, QUANTIZE_MODES, NKDTimeline, _to_mask, _to_rgb, blend_pixels,
    build_sources, classify,
    fit_frames, gather_window, mix_audio, parse_timeline, quantize_count, quantize_stops,
    source_frame, source_meta, timeline_span, track_blend,
)

WAN = "Wan (4n+1)"
LTX = "LTX (8n+1)"
MOCHI = "Mochi (6n+1)"
MINIMAX = "MiniMax H3 (17n+5)"
CUSTOM = "custom (multiple of N)"


def test_quantize():
    # Presets are named after model families; the combo value is what reaches the backend.
    assert QUANTIZE_MODES == ["free", WAN, "Hunyuan (4n+1)", LTX, "Cosmos (8n+1)",
                              MOCHI, MINIMAX, CUSTOM]

    # 8n+1 stops are 9, 17, 25, 33... Rounds down.
    assert quantize_count(33, LTX) == 33
    assert quantize_count(40, LTX) == 33
    assert quantize_count(41, LTX) == 41
    # 4n+1: 5, 9, 13...
    assert quantize_count(16, WAN) == 13
    assert quantize_count(13, WAN) == 13
    # 6n+1: 7, 13, 19...
    assert quantize_count(20, MOCHI) == 19
    assert quantize_count(7, MOCHI) == 7
    # MiniMax H3 is NOT an Nn+1 family: 5, 22, 39, 56... (124 is the node's own default)
    assert quantize_count(124, MINIMAX) == 124
    assert quantize_count(130, MINIMAX) == 124
    assert quantize_count(22, MINIMAX) == 22
    assert quantize_count(21, MINIMAX) == 5
    assert quantize_count(4, MINIMAX) == 5
    # Never below the first valid stop, not even for absurd input.
    assert quantize_count(1, LTX) == 9
    assert quantize_count(3, WAN) == 5
    # And never 0 when something was asked for - that would blow up the sampler.
    for mode in (WAN, LTX, MOCHI, MINIMAX):
        for n in range(1, 300):
            assert quantize_count(n, mode) >= 5, (mode, n)
    assert quantize_count(0, LTX) == 0             # empty stays empty
    assert quantize_count(100, "free") == 100
    assert quantize_count(100, CUSTOM, 16) == 96
    assert quantize_count(5, CUSTOM, 16) == 16     # never below the step
    # An unknown mode degrades to no snapping rather than to 0.
    assert quantize_count(37, "something else") == 37


def test_quantize_stops_are_fixed_points():
    """Every stop painted on the ruler must survive quantize_count unchanged, or the
    editor would show an end point the backend then silently moves."""
    for mode in (WAN, LTX, MOCHI, MINIMAX):
        stops = quantize_stops(200, mode)
        assert stops, mode
        for s in stops:
            assert quantize_count(s, mode) == s, (mode, s)
    assert quantize_stops(45, MINIMAX) == [5, 22, 39]
    assert quantize_stops(30, LTX) == [9, 17, 25]
    assert quantize_stops(100, "free") == []


def test_minimax_matches_core():
    """comfy_extras/nodes_minimax_h3.py:33 walks UP until n % 17 == 5. We round DOWN, so
    every stop we produce must be a fixed point of that same function."""
    def align_up(n):
        while n % 17 != 5:
            n += 1
        return n

    for s in quantize_stops(400, MINIMAX):
        assert align_up(s) == s, s


def test_source_frame_resample():
    clip = {"start": 10, "trimIn": 5, "length": 100}
    # Same cadence: one-to-one offset from trimIn.
    assert source_frame(clip, 10, 24.0, 24.0) == 5
    assert source_frame(clip, 34, 24.0, 24.0) == 29
    # 30 fps source, 24 fps timeline: the source runs faster (frames get dropped).
    assert source_frame(clip, 10, 30.0, 24.0) == 5
    assert source_frame(clip, 34, 30.0, 24.0) == 5 + 30   # 24 frames x 30/24
    # 24 fps source, 30 fps timeline: the source runs slower (frames repeat).
    assert source_frame(clip, 40, 24.0, 30.0) == 5 + 24   # 30 frames x 24/30
    # An invalid fps must neither throw nor return nonsense.
    assert source_frame(clip, 50, 24.0, 0.0) == 5


def test_parse_defensive():
    # Garbage -> empty timeline, never an exception.
    empty = {"clips": [], "masks": [], "audio": [], "tracks": [], "playhead": 0}
    for junk in ("", None, "{{{", "[]", '{"clips": "nope"}', 42):
        assert parse_timeline(junk) == empty
    tl = parse_timeline('{"clips":['
                        '{"src":"video_1","track":2,"start":10,"trimIn":3,"length":20},'
                        '{"src":"video_0","track":0,"start":0,"length":30},'
                        '{"src":"video_9","length":0},'          # zero length -> dropped
                        '{"track":1,"length":5}],'               # no src -> dropped
                        '"audio":[{"src":"audio_0","start":0,"length":50,"gain":0.5}],'
                        '"ui":{"playhead":12}}')
    assert len(tl["clips"]) == 2
    # Sorted by track: the higher one comes last, so it overwrites when drawn.
    assert [c["src"] for c in tl["clips"]] == ["video_0", "video_1"]
    assert tl["clips"][1]["trimIn"] == 3
    assert tl["audio"][0]["gain"] == 0.5
    assert tl["playhead"] == 12
    assert timeline_span(tl["clips"], tl["masks"], tl["audio"]) == 50


def test_image_and_mask_sources():
    """An IMAGE batch is a frame sequence and a MASK is a batch of them, so both ride the
    timeline like a video. Tensor sources have no intrinsic rate: they run 1:1 with the
    timeline."""
    imgs = torch.rand((10, 8, 16, 3))
    msks = torch.rand((10, 8, 16))
    sources, audio_sources = build_sources({"image_0": imgs, "mask_0": msks})
    assert sources["image_0"][0] == "image"
    assert sources["mask_0"][0] == "mask"
    assert audio_sources == {}
    assert source_meta("image", imgs, 24.0) == (24.0, 10)   # 1:1 with the timeline
    assert source_meta("mask", msks, 30.0) == (30.0, 10)

    clip = {"src": "image_0", "track": 0, "start": 5, "trimIn": 2, "length": 6}
    frames, audio = gather_window("image", imgs, clip, 5, 11, 24.0)
    assert audio is None                       # a tensor batch carries no audio
    assert frames.shape == (6, 8, 16, 3)
    assert torch.equal(frames[0], imgs[2])     # honours trimIn
    assert torch.equal(frames[3], imgs[5])

    # Reading past the end clamps to the last frame rather than throwing.
    long_clip = {"src": "image_0", "track": 0, "start": 0, "trimIn": 0, "length": 40}
    tail, _ = gather_window("image", imgs, long_clip, 0, 40, 24.0)
    assert tail.shape[0] == 40
    assert torch.equal(tail[-1], imgs[-1])

    # An empty or inverted range yields nothing instead of a malformed tensor.
    assert gather_window("image", imgs, clip, 5, 5, 24.0) == (None, None)


def test_mask_and_rgb_conversion():
    # A mask [N,H,W] shown as a picture becomes grey; the rank comes back correctly.
    m = torch.rand((3, 4, 5))
    rgb = _to_rgb(m)
    assert rgb.shape == (3, 4, 5, 3)
    assert torch.equal(rgb[..., 0], m) and torch.equal(rgb[..., 2], m)
    # A picture read as a mask becomes Rec.709 luma - that is "use this video as a mask".
    white = torch.ones((2, 4, 5, 3))
    assert torch.allclose(_to_mask(white), torch.ones((2, 4, 5)))
    red = torch.zeros((1, 2, 2, 3))
    red[..., 0] = 1.0
    assert torch.allclose(_to_mask(red), torch.full((1, 2, 2), 0.2126))
    # A real mask passes through untouched, and RGBA drops its alpha.
    assert torch.equal(_to_mask(m), m)
    assert _to_rgb(torch.rand((2, 4, 5, 4))).shape == (2, 4, 5, 3)
    # fit_frames keeps a mask a mask.
    assert fit_frames(torch.rand((2, 10, 20)), 8, 8, "contain").shape == (2, 8, 8)


def test_fit_frames():
    src = torch.rand((3, 100, 200, 3))          # 2:1
    for mode in ("contain", "cover", "stretch"):
        out = fit_frames(src, 64, 64, mode)
        assert out.shape == (3, 64, 64, 3), mode
        assert float(out.min()) >= 0.0 and float(out.max()) <= 1.0, mode
    # contain preserves the aspect ratio -> black bars top and bottom.
    contained = fit_frames(torch.ones((1, 100, 200, 3)), 64, 64, "contain")
    assert float(contained[0, 0, 32, 0]) == 0.0    # top edge, padding
    assert float(contained[0, 32, 32, 0]) == 1.0   # centre, image
    # Already matching: passes through untouched (no needless resample).
    same = torch.rand((2, 32, 32, 3))
    assert fit_frames(same, 32, 32, "contain") is same


def test_mix_audio():
    sr = 100
    ones = torch.ones((1, 50))                  # mono, 0.5 s
    # Placed at offset 20, no trim.
    out = mix_audio([(ones, sr, 20, 0, 1.0)], 100, sr)
    assert out.shape == (1, 2, 100)
    assert float(out[0, 0, 19]) == 0.0          # before the segment: silence
    assert float(out[0, 0, 20]) == 1.0          # mono duplicated to stereo
    assert float(out[0, 1, 20]) == 1.0
    assert float(out[0, 0, 69]) == 1.0
    assert float(out[0, 0, 70]) == 0.0          # after: silence again
    # Additive and clamped to [-1,1]: two full-scale segments must not overflow.
    both = mix_audio([(ones, sr, 0, 0, 1.0), (ones, sr, 0, 0, 1.0)], 50, sr)
    assert float(both[0, 0, 0]) == 1.0
    # Gain is applied.
    quiet = mix_audio([(ones, sr, 0, 0, 0.25)], 50, sr)
    assert abs(float(quiet[0, 0, 0]) - 0.25) < 1e-6
    # Trim discards the head of the segment.
    ramp = torch.arange(50, dtype=torch.float32).unsqueeze(0) / 100.0
    trimmed = mix_audio([(ramp, sr, 0, 10, 1.0)], 50, sr)
    assert abs(float(trimmed[0, 0, 0]) - 0.10) < 1e-6
    # A segment running off the end is clipped rather than crashing.
    assert mix_audio([(ones, sr, 80, 0, 1.0)], 100, sr).shape == (1, 2, 100)
    # And a negative offset is clipped from the front.
    assert float(mix_audio([(ones, sr, -10, 0, 1.0)], 100, sr)[0, 0, 0]) == 1.0
    # Resampling: half the sample rate -> twice the samples occupied.
    up = mix_audio([(ones, 50, 0, 0, 1.0)], 200, 100)
    assert float(up[0, 0, 99]) == 1.0
    assert float(up[0, 0, 150]) == 0.0


def test_audio_length_matches_frames():
    """Audio length must be exactly frames/fps * sample_rate: drift here makes
    picture and sound separate progressively."""
    for fps, count, sr in ((24.0, 97, 44100), (30.0, 120, 48000), (12.5, 25, 22050)):
        total = int(round(count / fps * sr))
        assert mix_audio([], total, sr).shape == (1, 2, total)


def test_blend_modes():
    """Stacking a before and an after and reading the difference is a main reason this
    node has tracks, so the maths has to be the real thing, not an approximation."""
    assert BLEND_MODES == ["normal", "screen", "multiply", "difference"]
    base = torch.tensor([[0.0, 0.5, 1.0]])
    top = torch.tensor([[0.25, 0.5, 0.25]])
    assert torch.allclose(blend_pixels(base, top, "normal"), top)
    assert torch.allclose(blend_pixels(base, top, "multiply"),
                          torch.tensor([[0.0, 0.25, 0.25]]))
    # screen: 1-(1-a)(1-b)
    assert torch.allclose(blend_pixels(base, top, "screen"),
                          torch.tensor([[0.25, 0.75, 1.0]]))
    assert torch.allclose(blend_pixels(base, top, "difference"),
                          torch.tensor([[0.25, 0.0, 0.75]]))
    # Identical layers under difference must be exactly black - that is the whole point.
    same = torch.rand((4, 4, 3))
    assert float(blend_pixels(same, same, "difference").abs().max()) == 0.0
    # An unknown mode must fall back to plain overwrite, never to something destructive.
    assert torch.allclose(blend_pixels(base, top, "nonsense"), top)


def test_track_blend_lookup():
    tracks = [{"blend": "normal"}, {"blend": "difference"}]
    assert track_blend(tracks, 0) == "normal"
    assert track_blend(tracks, 1) == "difference"
    assert track_blend(tracks, 7) == "normal"      # beyond the list
    assert track_blend([], 0) == "normal"
    assert track_blend([{"blend": "bogus"}], 0) == "normal"
    tl = parse_timeline('{"tracks":[{"blend":"screen"},"junk",{"blend":"evil"}]}')
    assert track_blend(tl["tracks"], 0) == "screen"
    assert track_blend(tl["tracks"], 1) == "normal"   # a non-dict entry degrades
    assert track_blend(tl["tracks"], 2) == "normal"   # an unknown name degrades


def test_current_image_is_the_composited_frame():
    """`current_image` must come from the OUTPUT tensor, not from a re-read of a source:
    it has to carry the track blends, and it has to track the playhead exactly."""
    import json

    seq = torch.zeros((20, 8, 8, 3))
    for i in range(20):
        seq[i] = i / 100.0

    def run(playhead):
        tl = json.dumps({
            "clips": [{"src": "media_0", "track": 0, "start": 0, "trimIn": 0,
                       "length": 20}],
            "masks": [], "audio": [], "ui": {"playhead": playhead}})
        r = NKDTimeline.execute(
            media={"media_0": seq}, timeline=tl,
            import_mode="stack", fps=24.0, start_frame=0, frame_count=0, width=8,
            height=8, fit="stretch", quantize="free", quantize_n=8, clip_audio=False)
        images, _mask, _cov, _aud, _vid, _fps, n, _w, _h, cur, cur_img, dur = r.result
        # Duration must be the QUANTISED count in seconds, matching what was rendered.
        assert abs(dur - n / 24.0) < 1e-9, (dur, n)
        assert images.shape[0] == n
        return cur, cur_img, images

    for ph in (0, 7, 19):
        cur, cur_img, images = run(ph)
        assert cur == ph
        assert cur_img.shape == (1, 8, 8, 3)          # a one-frame IMAGE batch
        assert torch.equal(cur_img[0], images[cur])   # exactly the rendered frame
    # A playhead past the end clamps instead of raising or returning an empty batch.
    cur, cur_img, images = run(999)
    assert cur == 19
    assert cur_img.shape[0] == 1


def test_classify():
    """One socket takes everything, so the kind has to be recovered from the object. The
    four are never ambiguous - but a wrong answer here would put a mask on the picture
    lane, so it is worth pinning down."""
    assert classify(torch.zeros((4, 8, 8, 3))) == "image"      # [N,H,W,C]
    assert classify(torch.zeros((4, 8, 8))) == "mask"          # [N,H,W]
    assert classify({"waveform": torch.zeros((1, 2, 100)), "sample_rate": 44100}) == "audio"

    class FakeVideo:            # duck-typed, so any VideoInput implementation counts
        def get_frame_rate(self): return 24
        def get_components(self): return None
    assert classify(FakeVideo()) == "video"

    # Anything unrecognised is None rather than a wrong guess - an unfilled Autogrow slot
    # arrives as None and must simply be skipped.
    assert classify(None) is None
    assert classify({}) is None                       # a dict with no waveform
    assert classify(torch.zeros((8, 8))) is None      # rank 2: neither image nor mask
    assert classify("nope") is None

    visual, audio = build_sources({
        "media_0": torch.zeros((2, 4, 4, 3)),
        "media_1": torch.zeros((2, 4, 4)),
        "media_2": {"waveform": torch.zeros((1, 2, 10)), "sample_rate": 8000},
        "media_3": None,                              # unconnected slot
    })
    assert sorted(visual) == ["media_0", "media_1"]
    assert sorted(audio) == ["media_2"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  ok  {name}")
    # No emoji: the Windows console is cp1252 and would blow up printing one.
    print("\nNKD Timeline - all good.")
