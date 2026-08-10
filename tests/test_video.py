"""😺NKD Video Viewer — encoder checks.

Every format has to produce a file PyAV (or PIL) can read back with the frame count, rate
and size that were asked for. An encoder that silently writes a truncated or half-rate file
is the failure mode that only shows up in someone else's edit.

Run: python tests/test_video.py   (with ComfyUI's interpreter)
"""
import os
import sys
import tempfile
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))

import av  # noqa: E402
import torch  # noqa: E402
from PIL import Image as PILImage  # noqa: E402

from nkd_video import (  # noqa: E402
    FORMATS, PRORES_PROFILES, _gif_palette, apply_version, encode_gif,
    encode_png_sequence, encode_video, encode_webp, has_version, next_version,
    resolve_tokens, version_pad,
)


def ramp(n=12, h=32, w=48, channels=3):
    """Frames that differ from each other AND have spatial detail.

    Flat colour frames are a useless fixture: a GIF writer collapses identical frames, so a
    dropped-frame bug would hide behind that. The horizontal gradient also means the clip
    has real colours to build a palette from.
    """
    out = torch.zeros((n, h, w, channels))
    grad = torch.linspace(0, 1, w).view(1, w)
    for i in range(n):
        shift = i / max(1, n - 1)
        out[i, :, :, 0] = (grad + shift) % 1.0
        out[i, :, :, 1] = grad.flip(-1)
        out[i, :, :, 2] = shift
        if channels == 4:
            out[i, :, :, 3] = 1.0
    return out


def tone(seconds=1.0, rate=44100):
    t = torch.linspace(0, seconds, int(rate * seconds))
    wave = torch.sin(2 * torch.pi * 440 * t).unsqueeze(0).unsqueeze(0)
    return {"waveform": wave, "sample_rate": rate}


def probe(path):
    with av.open(path) as c:
        v = c.streams.video[0]
        frames = sum(1 for _ in c.decode(video=0))
        return {
            "frames": frames,
            "fps": float(v.average_rate),
            "width": v.codec_context.width,
            "height": v.codec_context.height,
            "audio": len(c.streams.audio),
        }


def test_each_format_round_trips():
    """Every format in the table must come back with the frame count, rate and size asked
    for. Driven off FORMATS itself, so adding a format without a way to read it back fails
    here rather than shipping."""
    images = ramp(12)
    for key, spec in FORMATS.items():
        with tempfile.TemporaryDirectory() as d:
            if spec["ext"] == "png":
                folder = os.path.join(d, "seq")
                encode_png_sequence(images, folder, "shot", 4, None)
                names = sorted(os.listdir(folder))
                assert len(names) == 12, (key, names)
                # Dot before the number: the convention every compositor reads as a sequence.
                assert names[0] == "shot.0000.png", names[0]
                with PILImage.open(os.path.join(folder, names[0])) as im:
                    assert im.size == (48, 32), im.size
                continue
            path = os.path.join(d, f"t.{spec['ext']}")
            if spec["vcodec"]:
                encode_video(images, path, spec, 24.0, 23.0, None, None, None, None,
                             profile="hq")
                got = probe(path)
                assert got["frames"] == 12, (key, got)
                assert abs(got["fps"] - 24.0) < 0.01, (key, got)
                assert (got["width"], got["height"]) == (48, 32), (key, got)
            elif spec["ext"] == "webp":
                encode_webp(images, path, 24.0, 85, False, None)
                with PILImage.open(path) as im:
                    assert im.n_frames == 12, (key, im.n_frames)
                    assert im.size == (48, 32), im.size
            else:
                encode_gif(images, path, 24.0, 256, True, None)
                with PILImage.open(path) as im:
                    assert im.n_frames == 12, (key, im.n_frames)
                    assert im.size == (48, 32), im.size
            assert os.path.getsize(path) > 0, key
    print("  ok  test_each_format_round_trips")


def test_prores_profiles_pick_the_right_pixel_format():
    """The profile IS the quality setting for ProRes, and only 4444 carries alpha.

    Also settles, by measurement, whether alpha survives here - it does NOT through vp9, and
    guessing either way would be exactly the mistake that test pins down.
    """
    rgba = ramp(4, channels=4)
    rgba[:, :, :24, 3] = 0.0                          # left half transparent
    with tempfile.TemporaryDirectory() as d:
        for profile, (_number, _requested) in PRORES_PROFILES.items():
            path = os.path.join(d, f"{profile}.mov")
            encode_video(rgba, path, FORMATS["mov / prores"], 24.0, 0, None, None, None,
                         None, profile=profile)
            with av.open(path) as c:
                stored = c.streams.video[0].codec_context.pix_fmt
                # Asserted on whether the format HAS an alpha plane, not on its exact name:
                # prores_ks promotes the requested 10-bit to 12-bit on the way out, so the
                # stored name is an encoder detail and pinning it tests the wrong thing.
                assert stored.startswith("yuva") == (profile == "4444"), (profile, stored)
                frame = next(c.decode(video=0)).to_ndarray(format="rgba")
            left, right = int(frame[0, 0, 3]), int(frame[0, 40, 3])
            if profile == "4444":
                # The pack's ONE working alpha path. vp9 loses it; this keeps it.
                assert left < 16 and right > 240, (profile, left, right)
            else:
                assert left > 240, (profile, "alpha where the profile has no plane")
    print("  ok  test_prores_profiles_pick_the_right_pixel_format")


def test_pingpong_doubles_the_clip_minus_the_shared_ends():
    """N frames out and back is 2N-2, not 2N: repeating the first and last would stutter at
    the turn."""
    import folder_paths
    import nkd_video

    with tempfile.TemporaryDirectory() as out:
        orig = folder_paths.get_output_directory
        folder_paths.get_output_directory = lambda: out
        try:
            def go(pingpong):
                r = nkd_video.NKDVideoViewer.execute(
                    images=ramp(10), fps=24.0,
                    format={"format": "mp4 / h264", "crf": 30.0, "preset": "veryfast"},
                    filename_prefix=f"pp/{pingpong}", save_output=True, pingpong=pingpong,
                    versioning="off", version=1, numbering="none")
                return r.ui.as_dict()["nkd_meta"][0]["frame_count"], probe(r.result[1])
            assert go(False) [0] == 10
            frames, got = go(True)
            assert frames == 18, frames                 # 10 out + 8 back
            assert got["frames"] == 18, got             # and it reached the FILE
        finally:
            folder_paths.get_output_directory = orig
            nkd_video._ENCODED.clear()
    print("  ok  test_pingpong_doubles_the_clip_minus_the_shared_ends")


def test_poster_is_written_for_formats_no_browser_opens():
    """h265, ProRes and a sequence have no browser preview, so the node would show an empty
    box. One PNG of the first frame answers "did it render what I meant?"."""
    import nkd_video
    images = ramp(5)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "p.png")
        nkd_video.write_poster(images, path)
        with PILImage.open(path) as im:
            assert im.size == (48, 32), im.size
    # And the table has to agree about which formats need one.
    assert {k for k, v in FORMATS.items() if v["preview"] == "none"} == {
        "mov / prores", "png sequence"}
    # h265 is not in the table at all: libx265 crashes the process in this build. See
    # FORMATS - if it ever comes back, this line is the reminder to re-measure first.
    assert "mp4 / h265" not in FORMATS
    # Everything with no preview must have a poster, or the node shows an empty box.
    assert all(v["poster"] for v in FORMATS.values() if v["preview"] == "none")
    assert {k for k, v in FORMATS.items() if v["preview"] == "video"} == {
        "mp4 / h264", "webm / vp9"}
    print("  ok  test_poster_is_written_for_formats_no_browser_opens")


def test_audio_is_muxed_only_where_the_container_takes_it():
    """Every container that declares an audio codec must actually carry the track.

    Driven off the table, so a format added without an audio path shows up here. GIF, WebP
    and a PNG sequence have nowhere to put sound at all - they just must not blow up.
    """
    images = ramp(24)
    for key, spec in FORMATS.items():
        if not spec["vcodec"]:
            continue                       # still formats: covered by the round-trip test
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, f"t.{spec['ext']}")
            encode_video(images, path, spec, 24.0, 23.0, None, tone(1.0), None, None,
                         profile="hq")
            assert probe(path)["audio"] == 1, key
    print("  ok  test_audio_is_muxed_only_where_the_container_takes_it")


def test_opus_resamples_rather_than_refusing():
    """Opus only accepts 48 kHz. A 44.1 kHz track has to be resampled, not rejected."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.webm")
        encode_video(ramp(24), path, FORMATS["webm / vp9"], 24.0, 32.0, None,
                     tone(1.0, 44100), None, None)
        with av.open(path) as c:
            assert len(c.streams.audio) == 1
            assert c.streams.audio[0].codec_context.sample_rate == 48000
    print("  ok  test_opus_resamples_rather_than_refusing")


def test_rgba_input_encodes_cleanly_with_alpha_flattened():
    """RGBA must not crash either codec, and the alpha is knowingly dropped.

    Pins the measured reality rather than the hoped-for one: WebM's vp9 alpha plane lives
    in BlockAdditional, which only the ffmpeg CLI assembles, so nothing PyAV can express
    round-trips it. If a future PyAV changes that, this test fails and the claim gets
    revisited on purpose.
    """
    rgba = ramp(6, channels=4)
    rgba[:, :, :24, 3] = 0.0                          # left half fully transparent
    with tempfile.TemporaryDirectory() as d:
        for key in ("webm / vp9", "mp4 / h264"):
            path = os.path.join(d, "a." + FORMATS[key]["ext"])
            encode_video(rgba, path, FORMATS[key], 24.0, 30.0, "veryfast", None, None, None)
            assert probe(path)["frames"] == 6, key
            with av.open(path) as c:
                frame = next(c.decode(video=0)).to_ndarray(format="rgba")
            assert frame[0, 0, 3] == 255, (key, "alpha unexpectedly survived - revisit")
    print("  ok  test_rgba_input_encodes_cleanly_with_alpha_flattened")


def test_gif_shares_one_palette_across_the_whole_clip():
    """Per-frame palettes are what make a GIF shimmer.

    Checked by behaviour rather than by comparing palette bytes (PIL trims unused entries
    per frame): decode every frame back to RGB and count the distinct colours in the whole
    animation. Per-frame adaptive palettes would blow past the limit; one shared table
    cannot.
    """
    limit = 32
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.gif")
        encode_gif(ramp(8), path, 12.0, limit, False, None)
        seen = set()
        with PILImage.open(path) as im:
            assert im.n_frames == 8, im.n_frames
            for i in range(im.n_frames):
                im.seek(i)
                seen.update(im.convert("RGB").getdata())
        assert len(seen) <= limit, len(seen)
        assert len(seen) > 1, "a single colour means the palette collapsed"
    print("  ok  test_gif_shares_one_palette_across_the_whole_clip")


def test_gif_palette_survives_an_unrepresentative_first_frame():
    """A clip that opens on black must not end up with a palette of near-blacks.

    Building the table from frame 0 alone did exactly that, and every later frame then
    collapsed onto a couple of entries. Asserted on `_gif_palette` directly, which is where
    the logic lives: the written frames only carry their changed region, so counting
    colours there measures PIL's diffing rather than our palette.
    """
    images = ramp(12)
    images[0] = 0.0                                   # fade-in: frame 0 carries no colour
    shared = len(set(_gif_palette(images, 64).convert("RGB").getdata()))
    first_only = len(set(
        PILImage.fromarray((images[0] * 255).byte().numpy(), "RGB")
        .quantize(colors=64).convert("RGB").getdata()))
    assert first_only == 1, first_only          # what the naive approach would have had
    assert shared > 16, shared                  # what sampling across the clip gives
    print("  ok  test_gif_palette_survives_an_unrepresentative_first_frame")


def test_metadata_survives_the_container():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.mp4")
        encode_video(ramp(4), path, FORMATS["mp4 / h264"], 24.0, 23.0, None, None,
                     {"prompt": {"1": {"class_type": "X"}}}, None)
        with av.open(path) as c:
            assert "prompt" in c.metadata
            assert "class_type" in c.metadata["prompt"]
    print("  ok  test_metadata_survives_the_container")


def test_fractional_rate_is_not_rounded_to_an_integer():
    """29.97 has to come back as 29.97, not 30: a whole-number rate would drift a long
    clip against its own audio."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.mp4")
        encode_video(ramp(10), path, FORMATS["mp4 / h264"], 29.97, 23.0, None, None,
                     None, None)
        assert abs(probe(path)["fps"] - 29.97) < 0.01
        assert Fraction(round(29.97 * 1000), 1000) != 30
    print("  ok  test_fractional_rate_is_not_rounded_to_an_integer")


def test_version_padding_follows_the_hash_count():
    """Nuke's convention: the number of hashes IS the padding, per token."""
    assert apply_version("shot_v%v###%", 7) == "shot_v007"
    assert apply_version("shot_v%v##%", 7) == "shot_v07"
    # Studio layout repeats the version in the folder AND the file; both get stamped.
    assert apply_version("sh/v%v###%/sh_v%v###%", 12) == "sh/v012/sh_v012"
    assert version_pad("a_v%v####%") == 4
    assert version_pad("no token here") == 3          # the v001 convention
    assert has_version("a_v%v#%") and not has_version("plain")
    print("  ok  test_version_padding_follows_the_hash_count")


def test_next_version_takes_the_highest_not_the_first_gap():
    """v001 and v003 present must give v004.

    Filling the v002 hole would overwrite nothing today but breaks the ordering everyone
    reads a version folder by - and the point of `auto` is that you never land on an
    existing render.
    """
    with tempfile.TemporaryDirectory() as root:
        # Version in the FOLDER segment.
        for v in ("v001", "v003"):
            os.makedirs(os.path.join(root, "sh010", v))
        assert next_version(root, "sh010/v%v###%/sh010_v%v###%", 3) == 4
        # Version in the FILE NAME, extension ignored.
        os.makedirs(os.path.join(root, "flat"))
        for name in ("take_v002.mp4", "take_v005.mp4", "unrelated.mp4"):
            open(os.path.join(root, "flat", name), "w").close()
        assert next_version(root, "flat/take_v%v###%", 3) == 6
        # Nothing there yet - including a folder that does not exist - starts at 1.
        assert next_version(root, "brand/new_v%v###%", 3) == 1
    print("  ok  test_next_version_takes_the_highest_not_the_first_gap")


def test_next_version_does_not_confuse_neighbouring_names():
    """`shotA_v003` must not raise the version of `shotB`."""
    with tempfile.TemporaryDirectory() as root:
        os.makedirs(root, exist_ok=True)
        for name in ("shotA_v009.mp4", "shotB_v002.mp4"):
            open(os.path.join(root, name), "w").close()
        assert next_version(root, "shotB_v%v###%", 3) == 3
    print("  ok  test_next_version_does_not_confuse_neighbouring_names")


def test_render_tokens_resolve():
    got = resolve_tokens("%node%/%res%_%fps%fps_%frames%f_%codec%", {
        "node": "SH010_comp", "res": "1920x1080", "fps": "24",
        "frames": 97, "codec": "h264"})
    assert got == "SH010_comp/1920x1080_24fps_97f_h264", got
    # An unknown token is left alone rather than blanked: a silently emptied path segment
    # would collapse two folders into one.
    assert resolve_tokens("a/%nope%/b", {}) == "a/%nope%/b"
    print("  ok  test_render_tokens_resolve")


def test_execute_names_the_file_the_way_the_widgets_say():
    """The whole naming path, through the real `execute`.

    Covers the wiring the unit tests above cannot: that `_resolve_prefix` runs before the
    core's `get_save_image_path`, that `numbering="none"` really drops the _00001_ suffix,
    and that `auto` climbs on the SECOND run rather than overwriting the first.
    """
    import folder_paths
    import nkd_video

    with tempfile.TemporaryDirectory() as out:
        orig = folder_paths.get_output_directory
        folder_paths.get_output_directory = lambda: out
        try:
            def go(**kw):
                params = dict(
                    images=ramp(4), fps=24.0,
                    format={"format": "mp4 / h264", "crf": 30.0, "preset": "veryfast"},
                    filename_prefix="sh010/v%v###%/sh010_v%v###%",
                    save_output=True, pingpong=False, versioning="auto (next free)",
                    version=1, numbering="none")
                params.update(kw)
                r = nkd_video.NKDVideoViewer.execute(**params)
                return r.ui.as_dict()["nkd_video"][0], r.ui.as_dict()["nkd_meta"][0]

            first, meta = go()
            assert meta["version"] == 1, meta
            assert first["filename"] == "sh010_v001.mp4", first
            assert first["subfolder"].replace("\\", "/") == "sh010/v001", first

            second, meta2 = go()
            assert meta2["version"] == 2, meta2      # climbs, never overwrites
            assert second["subfolder"].replace("\\", "/") == "sh010/v002", second

            manual, meta3 = go(versioning="manual", version=47)
            assert meta3["version"] == 47
            assert manual["filename"] == "sh010_v047.mp4", manual

            # Versioning ON with NO token in the prefix: `_v001` is implied, appended to the
            # FILE NAME, and the _00001_ counter is dropped - turning versioning on is the
            # whole statement, typing the token as well is saying it twice.
            bare, metaB = go(filename_prefix="plain/take", numbering="counter")
            assert bare["filename"] == "take_v001.mp4", bare
            assert metaB["version"] == 1
            again, metaC = go(filename_prefix="plain/take", numbering="counter")
            assert again["filename"] == "take_v002.mp4", again
            assert metaC["version"] == 2

            # versioning off: the token must not survive into the name, and the counter
            # comes back when numbering asks for it.
            off, meta4 = go(versioning="off", numbering="counter")
            assert meta4["version"] is None
            assert "%" not in off["filename"] and "#" not in off["filename"], off
            assert off["filename"].endswith("_00001_.mp4"), off
        finally:
            folder_paths.get_output_directory = orig
    print("  ok  test_execute_names_the_file_the_way_the_widgets_say")


def test_bumping_the_version_copies_instead_of_re_encoding():
    """Changing only the destination must not re-render.

    `version` is an input, so ComfyUI's signature changes and the node re-runs - but the
    frames are the same object, so the previous file is copied. Also pins the other
    direction: different frames DO re-encode, or a stale render would be silently shipped
    under a new version number.
    """
    import folder_paths
    import nkd_video

    calls = []
    real = nkd_video.encode_video
    with tempfile.TemporaryDirectory() as out:
        orig_dir = folder_paths.get_output_directory
        folder_paths.get_output_directory = lambda: out
        nkd_video.encode_video = lambda *a, **k: (calls.append(1), real(*a, **k))[1]
        try:
            frames = ramp(6)

            def go(images, version):
                return nkd_video.NKDVideoViewer.execute(
                    images=images, fps=24.0,
                    format={"format": "mp4 / h264", "crf": 30.0, "preset": "veryfast"},
                    filename_prefix="reuse/take", save_output=True, pingpong=False,
                    versioning="manual", version=version, numbering="none",
                ).ui.as_dict()["nkd_video"][0]

            a = go(frames, 1)
            assert len(calls) == 1, calls
            b = go(frames, 2)                       # SAME tensor object, new version
            assert len(calls) == 1, "re-encoded when only the version changed"
            assert b["filename"] == "take_v002.mp4", b
            assert a["filename"] == "take_v001.mp4", a
            # Both files exist and are byte-identical.
            pa = os.path.join(out, "reuse", a["filename"])
            pb = os.path.join(out, "reuse", b["filename"])
            assert open(pa, "rb").read() == open(pb, "rb").read()

            go(ramp(6, h=16), 3)                    # different frames -> must re-encode
            assert len(calls) == 2, "reused a render for different frames"
        finally:
            nkd_video.encode_video = real
            folder_paths.get_output_directory = orig_dir
            nkd_video._ENCODED.clear()
    print("  ok  test_bumping_the_version_copies_instead_of_re_encoding")


def test_execute_wires_up_every_format():
    """Through the real `execute`, once per format.

    The encoders are covered above; what this pins is the WIRING - that a sequence lands in
    a folder of its own, that formats with no browser preview get a poster written and the
    UI payload points at it while `filepath` still points at the render, and that nothing
    in the table reaches `execute` without a branch to handle it.
    """
    import folder_paths
    import nkd_video

    opts = {
        "mp4 / h264": {"crf": 30.0, "preset": "veryfast"},
        "webm / vp9": {"crf": 40.0},
        "mov / prores": {"profile": "proxy"},
        "gif": {"colors": 64, "dither": False},
        "webp": {"quality": 60, "lossless": False},
        "png sequence": {"padding": 4},
    }
    assert set(opts) == set(FORMATS), "a format was added without a case here"

    with tempfile.TemporaryDirectory() as out:
        orig = folder_paths.get_output_directory
        folder_paths.get_output_directory = lambda: out
        try:
            for key, extra in opts.items():
                r = nkd_video.NKDVideoViewer.execute(
                    images=ramp(4), fps=24.0, format={"format": key, **extra},
                    filename_prefix=f"f/{key.split('/')[0].strip()}", save_output=True,
                    pingpong=False, versioning="off", version=1, numbering="none")
                ui = r.ui.as_dict()
                shown, meta = ui["nkd_video"][0], ui["nkd_meta"][0]
                assert meta["preview"] == FORMATS[key]["preview"], key
                assert meta["size"] > 0, key
                # `filepath`, the second output, is always the RENDER - never the poster.
                rendered = r.result[1]
                assert os.path.exists(rendered), (key, rendered)
                if key == "png sequence":
                    assert os.path.isdir(rendered), key
                    frames = [f for f in os.listdir(rendered) if not f.endswith("poster.png")]
                    assert len(frames) == 4, (key, frames)
                else:
                    assert os.path.isfile(rendered), key
                    assert rendered.endswith("." + FORMATS[key]["ext"]), key
                # The UI ref always names the RENDER; the poster rides alongside in the
                # metadata, because whether it is needed is the browser's call (h265) and
                # the download button must never hand over a still instead of the video.
                assert not shown["filename"].endswith("poster.png"), (key, shown)
                needs_poster = FORMATS[key]["poster"]
                assert bool(meta["poster"]) == needs_poster, (key, meta["poster"])
                if needs_poster:
                    on_disk = os.path.join(out, shown["subfolder"], meta["poster"])
                    assert os.path.isfile(on_disk), (key, on_disk)
        finally:
            folder_paths.get_output_directory = orig
            nkd_video._ENCODED.clear()
    print("  ok  test_execute_wires_up_every_format")


def test_node_token_falls_back_to_a_clean_name():
    """An un-renamed node has NO title in the workflow (LiteGraph omits a default one), so
    %node% must not fall through to the numeric node id - `video/73/73_v001.mp4` is not a
    name anyone wants."""
    import nkd_video

    class FakeHidden:
        unique_id = "73"
        extra_pnginfo = {"workflow": {"nodes": [{"id": 73}]}}       # no "title" key

    class Renamed(FakeHidden):
        extra_pnginfo = {"workflow": {"nodes": [{"id": 73, "title": "SH010/comp"}]}}

    node = nkd_video.NKDVideoViewer
    try:
        node.hidden = FakeHidden()
        assert node._node_title() == "NKD", node._node_title()
        node.hidden = Renamed()
        # Sanitised: a title with a slash must not become two folders.
        assert node._node_title() == "SH010_comp", node._node_title()
        node.hidden = None
        assert node._node_title() == "NKD"
    finally:
        node.hidden = None
    print("  ok  test_node_token_falls_back_to_a_clean_name")


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_"):
            fn()
    print("\nNKD Video - all good.")
