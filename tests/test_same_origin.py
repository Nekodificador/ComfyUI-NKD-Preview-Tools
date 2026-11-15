"""😺NKD cross-site gate for the routes that write project config.

Guards that `_is_cross_site` refuses only what the browser marks `cross-site`, the same
policy as ComfyUI's own origin check: same-site (proxy, sibling subdomain) and a missing
header pass, as they do for the rest of the API.

Run: python tests/test_same_origin.py   (with ComfyUI's interpreter)
"""
import importlib
import importlib.util
import os
import sys
import types

_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PKG_DIR)
sys.path.insert(0, os.path.dirname(os.path.dirname(_PKG_DIR)))

# nodes.py does `from . import nkd_projects, ...`, so it needs a real package context -
# `import nodes` on its own would also collide with ComfyUI core's own nodes.py, which
# sits higher on sys.path. Register this dir as a synthetic package and import nodes.py
# as a submodule of it.
_PKG_NAME = "nkd_pt_pkg"
_pkg = types.ModuleType(_PKG_NAME)
_pkg.__path__ = [_PKG_DIR]
sys.modules[_PKG_NAME] = _pkg

# nodes.py registers its routes on the live PromptServer singleton at import time; outside
# a running server that's just an aiohttp RouteTableDef, so a bare stand-in is enough to
# satisfy the module-level `PromptServer.instance.routes`.
from aiohttp import web as _web  # noqa: E402
from server import PromptServer as _PromptServer  # noqa: E402

if getattr(_PromptServer, "instance", None) is None:
    class _StubServer:
        routes = _web.RouteTableDef()
    _PromptServer.instance = _StubServer()

nodes = importlib.import_module(f"{_PKG_NAME}.nodes")


class _FakeRequest:
    def __init__(self, headers=None):
        self.headers = headers or {}


def test_only_cross_site_refused():
    for h in ({"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "same-site"},
              {"Sec-Fetch-Site": "none"}, {}):
        assert nodes._is_cross_site(_FakeRequest(h)) is False, h
    assert nodes._is_cross_site(_FakeRequest({"Sec-Fetch-Site": "cross-site"})) is True


if __name__ == "__main__":
    test_only_cross_site_refused()
    print("test_same_origin: all passed")
