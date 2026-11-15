"""Share copies carry the picture and nothing else.

A render posted in public should not hand over the graph that made it. Each format has to
come out with no prompt / workflow inside and with the same content it went in with.

Run: python tests/test_share.py   (with ComfyUI's interpreter)
"""
import json
import os
import sys
import tempfile
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))

import av  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image as PILImage  # noqa: E402
from PIL.PngImagePlugin import PngInfo  # noqa: E402

from nkd_video import copy_without_metadata  # noqa: E402

GRAPH = json.dumps({"1": {"class_type": "KSampler", "inputs": {"seed": 42}}})
PIXELS = (np.random.default_rng(0).random((48, 64, 3)) * 255).astype(np.uint8)


def test_png(tmp):
    src, dst = os.path.join(tmp, "a.png"), os.path.join(tmp, "a_share.png")
    info = PngInfo()
    info.add_text("prompt", GRAPH)
    info.add_text("workflow", GRAPH)
    PILImage.fromarray(PIXELS).save(src, pnginfo=info)
    assert "workflow" in PILImage.open(src).info          # the fixture really carries it
    copy_without_metadata(src, dst)
    out = PILImage.open(dst)
    assert not {"prompt", "workflow"} & set(out.info), out.info.keys()
    assert b"KSampler" not in open(dst, "rb").read()
    assert np.array_equal(np.asarray(out), PIXELS)        # lossless


def test_jpeg_and_webp(tmp):
    exif = PILImage.Exif()
    exif[0x010F] = "workflow:" + GRAPH                     # where the core puts it for these
    for ext, kw in (("jpg", {"quality": 90}), ("webp", {"lossless": True})):
        src, dst = os.path.join(tmp, f"b.{ext}"), os.path.join(tmp, f"b_share.{ext}")
        PILImage.fromarray(PIXELS).save(src, exif=exif, **kw)
        assert b"KSampler" in open(src, "rb").read()
        copy_without_metadata(src, dst)
        assert b"KSampler" not in open(dst, "rb").read(), ext
        a, b = (np.asarray(PILImage.open(f)).astype(int) for f in (src, dst))
        assert np.array_equal(a, b), ext          # neither is re-encoded with loss


def test_mp4(tmp):
    src, dst = os.path.join(tmp, "c.mp4"), os.path.join(tmp, "c_share.mp4")
    with av.open(src, mode="w", options={"movflags": "use_metadata_tags+faststart"}) as out:
        out.metadata["prompt"] = GRAPH
        out.metadata["workflow"] = GRAPH
        stream = out.add_stream("libx264", rate=Fraction(24))
        stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
        for i in range(12):
            frame = av.VideoFrame.from_ndarray(np.roll(PIXELS, i * 3, axis=1), format="rgb24")
            out.mux(stream.encode(frame))
        out.mux(stream.encode(None))
    with av.open(src) as inp:
        assert "workflow" in inp.metadata                  # the fixture really carries it
    copy_without_metadata(src, dst)
    assert b"KSampler" not in open(dst, "rb").read()
    with av.open(src) as a, av.open(dst) as b:
        assert not {"prompt", "workflow"} & set(b.metadata), b.metadata
        fa = [f.to_ndarray(format="rgb24") for f in a.decode(video=0)]
        fb = [f.to_ndarray(format="rgb24") for f in b.decode(video=0)]
        assert len(fb) == len(fa) == 12
        assert all(np.array_equal(x, y) for x, y in zip(fa, fb))   # remux: same frames, bit for bit


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as tmp:
        test_png(tmp)
        test_jpeg_and_webp(tmp)
        test_mp4(tmp)
    print("share copies: ok")
