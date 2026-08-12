"""Active project + category, shared by every NKD node.

The problem this solves: `filename_prefix` is already a template engine (see
`resolve_tokens` in `nkd_video.py`), but the only way to point a graph at a different
project was to retype that string in every node. So this adds no path machinery of its
own - it adds two TOKENS, `%project%` and `%category%`, and one place that decides what
they expand to.

Deliberately GLOBAL rather than a per-node widget: switching project is a "what am I
working on right now" statement about the machine, not about the workflow. A saved
workflow carries no project, so handing it to someone else does not drag your folder
layout along with it.

**The cache is pure** - it only mirrors the file, keyed by mtime - which is why it can
live in a module global. Anything MUTABLE that an aiohttp route reads has to hang off
`PromptServer.instance` instead (see the long note in `nodes.py`); a hot reload only
empties a cache, but it forks mutable state into two copies that never meet.
"""

from __future__ import annotations

import json
import os
import re

import folder_paths

CONFIG_NAME = "nkd_projects.json"

# What a fresh install gets. The three categories are the ones that actually come up when
# you are cutting shots: something you are still poking at, something you want to look at
# once, and something that goes in the edit.
DEFAULT_CONFIG = {
    "active": {"project": "Default", "category": "test"},
    "categories": ["draft", "test", "final"],
    "projects": [{"name": "Default"}],
    # Where the Popup Preview drops a saved still. Not a widget: one global shape is the
    # whole point, and a per-node override can be added later if a preview ever needs one.
    "image_prefix": "%project%/%category%/%node%",
}

# Same character class the core's `applyTextReplacements` uses on a substituted widget
# value, minus the slash - a project's `path` is allowed to be several folders deep.
_BAD = re.compile(r'[<>:*|"?\x00-\x1f\x7f]')

_cache: tuple[float, dict] | None = None


def config_path() -> str:
    return os.path.join(folder_paths.get_user_directory(), CONFIG_NAME)


def sanitize_name(name: str) -> str:
    """A single path SEGMENT: no separators, no traversal, no reserved characters."""
    clean = _BAD.sub("_", str(name)).replace("\\", "_").replace("/", "_")
    return clean.strip(" .") or "Untitled"


def sanitize_path(path: str) -> str:
    """A relative sub-path: separators survive, traversal does not."""
    raw = str(path).replace("\\", "/").split("/")
    parts = [sanitize_name(p) for p in raw if p.strip(" .") != ""]
    return "/".join(parts) or "Untitled"


def _normalise(raw: dict) -> dict:
    """Fill in whatever the file is missing, so a hand-edited JSON cannot brick the UI."""
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(raw if isinstance(raw, dict) else {})

    projects = []
    for entry in cfg.get("projects") or []:
        # A bare string is the obvious thing to type by hand, so accept it.
        if isinstance(entry, str):
            entry = {"name": entry}
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        item = {"name": str(entry["name"])}
        if entry.get("path"):
            item["path"] = str(entry["path"])
        projects.append(item)
    cfg["projects"] = projects or list(DEFAULT_CONFIG["projects"])

    cats = [str(c) for c in (cfg.get("categories") or []) if str(c).strip()]
    cfg["categories"] = cats or list(DEFAULT_CONFIG["categories"])

    active = cfg.get("active") if isinstance(cfg.get("active"), dict) else {}
    names = [p["name"] for p in cfg["projects"]]
    project = str(active.get("project") or "")
    category = str(active.get("category") or "")
    cfg["active"] = {
        "project": project if project in names else names[0],
        "category": category if category in cfg["categories"] else cfg["categories"][0],
    }
    cfg["image_prefix"] = str(cfg.get("image_prefix") or DEFAULT_CONFIG["image_prefix"])
    return cfg


def load() -> dict:
    """The config, cached by mtime. Creates the file on first use."""
    global _cache
    path = config_path()
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        cfg = _normalise({})
        save(cfg)
        return cfg
    if _cache is not None and _cache[0] == mtime:
        return _cache[1]
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = _normalise(json.load(fh))
    except Exception as exc:
        # A broken file must not take the render down with it: fall back to defaults and
        # say so, rather than writing over whatever the user was editing.
        print(f"[NKD Projects] {CONFIG_NAME} unreadable ({exc!r}); using defaults")
        return _normalise({})
    _cache = (mtime, cfg)
    return cfg


def save(cfg: dict) -> dict:
    """Write the whole config back and refresh the cache."""
    global _cache
    cfg = _normalise(cfg)
    path = config_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2, ensure_ascii=False)
    try:
        _cache = (os.path.getmtime(path), cfg)
    except OSError:
        _cache = None
    return cfg


def set_active(project: str | None, category: str | None) -> dict:
    """Switch project and/or category. Unknown values are ignored, not invented."""
    cfg = dict(load())
    active = dict(cfg["active"])
    if project and project in [p["name"] for p in cfg["projects"]]:
        active["project"] = project
    if category and category in cfg["categories"]:
        active["category"] = category
    cfg["active"] = active
    return save(cfg)


def tokens() -> dict:
    """`{project, category}` ready to drop into `resolve_tokens`.

    `%project%` expands to the project's `path` when it has one - that is the hook for
    "this project already has its folders" - and to its sanitised name otherwise.
    """
    cfg = load()
    name = cfg["active"]["project"]
    entry = next((p for p in cfg["projects"] if p["name"] == name), None)
    folder = sanitize_path(entry["path"]) if entry and entry.get("path") else sanitize_name(name)
    return {"project": folder, "category": sanitize_name(cfg["active"]["category"])}


def signature() -> str:
    """What the active selection contributes to a node's cache signature.

    Without this the selection is invisible to ComfyUI: it is not an input, so switching
    project would leave every signature identical and a re-run would hand back the cached
    UI without ever writing the file in the new folder. Silent, and the worst kind.
    """
    t = tokens()
    return f"{t['project']}/{t['category']}"


def uses_tokens(prefix: str) -> bool:
    return "%project%" in prefix or "%category%" in prefix
