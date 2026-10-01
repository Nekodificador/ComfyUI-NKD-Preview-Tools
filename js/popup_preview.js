import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
// Shared with the timeline / video viewer. This file is hand-written and does NOT go
// through Vite, so it cannot import from src/ - it imports the built bundle instead. Both
// are served flat from js/, and ESM caches the module, so the bundle's own
// registerExtension calls still run exactly once.
import {
    config as nkdConfig, ensureStyles, loadConfig, mountDomWidget, projectChip,
    revealButton, saveToProject, reveal, revealAvailable,
} from "./nkd_timeline.js";

const NODE_TYPE = "NKDPopupPreviewNode";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildViewUrl(imgData) {
    const p = new URLSearchParams({
        filename: imgData.filename,
        type: imgData.type,
        subfolder: imgData.subfolder ?? "",
        t: Date.now(),
    });
    const raw = api.apiURL(`/view?${p}`);
    // api.apiURL may return a relative path (e.g. "/api/view?...") in Comfy Desktop.
    // Resolve against the api base URL to get an absolute http:// URL.
    try {
        const base = api.api_base ? new URL(api.api_base).origin : null;
        if (base) return new URL(raw, base).href;
    } catch { /* ignore */ }
    // Fallback: try resolving against the ComfyUI server origin from api.
    try {
        const serverUrl = api.api_base || `${location.protocol}//${location.host}`;
        return new URL(raw, serverUrl).href;
    } catch { /* ignore */ }
    return raw;
}

/** Resolves to the natural pixel dimensions of a URL (loads it in a temp Image). */
function loadImageDimensions(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = reject;
        img.src = url;
    });
}

async function getReferenceUrl() {
    try {
        const r = await fetch(api.apiURL("/nkd/ref/get"));
        if (!r.ok) return null;
        const item = await r.json();
        return buildViewUrl(item);
    } catch {
        return null;
    }
}

async function getReferenceMaskUrl() {
    try {
        const r = await fetch(api.apiURL("/nkd/ref/get_mask"));
        if (!r.ok) return null;
        const item = await r.json();
        return buildViewUrl(item);
    } catch {
        return null;
    }
}

// ── Primary node tracking ─────────────────────────────────────────────────────

// nodeId string of the current primary node, or null. The mark itself lives in
// node.properties.nkdPrimary so it travels with the WORKFLOW: a localStorage id would
// leak onto whichever other workflow happens to have a node with the same number.
let primaryNodeId = null;

const PRIMARY_OUTLINE_COLOR = "#4cc9f0";
const PRIMARY_BG_COLOR      = "#1a2a33";
const PRIMARY_OUTLINE_WIDTH = 2.5;
const PRIMARY_DASH          = [8, 4];

function applyPrimaryStyle(node, on) {
    if (!node) return;
    // Set node.color/bgcolor for V2 (Vue) frontend, which doesn't call onDrawForeground.
    // In classic LiteGraph these may be overridden by other extensions (e.g. Jovi
    // Colorizer), but the dashed overlay drawn in onDrawForeground compensates.
    if (on) {
        node.color   = PRIMARY_OUTLINE_COLOR;
        node.bgcolor = PRIMARY_BG_COLOR;
    } else {
        delete node.color;
        delete node.bgcolor;
    }
}

function setPrimary(nodeId) {
    const prev = primaryNodeId;
    primaryNodeId = nodeId ? String(nodeId) : null;

    // Redraw both affected nodes so their button labels and outline refresh.
    for (const id of new Set([prev, primaryNodeId])) {
        if (!id) continue;
        const node = app.graph?.getNodeById(Number(id));
        if (!node) continue;
        applyPrimaryStyle(node, isPrimary(id));
        setMark(node, "nkdPrimary", isPrimary(id));
        node.setDirtyCanvas(true, true);
    }
}

function setMark(node, key, on) {
    if (on) { node.properties ??= {}; node.properties[key] = true; }
    else if (node.properties) delete node.properties[key];
}

/** Adopt the mark a loaded workflow carries; the first marked node wins, copies are cleared. */
function adoptMark(cls, key) {
    let found = null;
    for (const n of app.graph?._nodes ?? []) {
        if (n.comfyClass !== cls || !n.properties?.[key]) continue;
        if (found) setMark(n, key, false); else found = n;
    }
    return found;
}

function isPrimary(nodeId) {
    return String(nodeId) === primaryNodeId;
}

// The popup node the shortcuts act on. Explicit beats implicit: the starred primary, then
// the ONE popup node currently selected, then the one that ran last, then the sole popup
// node. So with several popups the star is optional - the shortcut follows what you are
// working on. Emits a toast and returns null when nothing can be inferred.
let lastActiveId = null;

function resolvePrimaryNode() {
    const nodes = (app.graph?._nodes ?? []).filter(n => n.comfyClass === NODE_TYPE);
    if (primaryNodeId) {
        const n = nodes.find(x => String(x.id) === primaryNodeId);
        if (n) return n;
        setPrimary(null); // marked node is gone
    }
    const sel = Object.values(app.canvas?.selected_nodes ?? {}).filter(n => n.comfyClass === NODE_TYPE);
    if (sel.length === 1) return sel[0];
    const last = nodes.find(x => String(x.id) === lastActiveId);
    if (last) return last;
    if (nodes.length === 1) return nodes[0];
    app.extensionManager?.toast?.add?.({
        severity: "warn",
        summary: nodes.length === 0 ? "No Popup Preview Node" : "Multiple Popup Nodes",
        detail: nodes.length === 0
            ? "Add a Popup Preview node to the graph."
            : "Several Popup Preview nodes exist — select one, or right-click → Set as primary preview.",
        life: 5000,
    });
    return null;
}

// ── Send-to-LoadImage target ──────────────────────────────────────────────────

const LOAD_TARGET_COLOR = "#7a4a1e"; // warm amber outline
const LOAD_TARGET_BG    = "#2a1c10";
let loadTargetId = null;   // mark lives in node.properties.nkdLoadTarget (see primaryNodeId)

function isLoadTarget(nodeId) { return String(nodeId) === loadTargetId; }

function applyLoadTargetStyle(node, on) {
    if (!node) return;
    if (on) { node.color = LOAD_TARGET_COLOR; node.bgcolor = LOAD_TARGET_BG; }
    else    { delete node.color; delete node.bgcolor; }
}

function setLoadTarget(nodeId) {
    const prev = loadTargetId;
    loadTargetId = nodeId ? String(nodeId) : null;
    for (const id of new Set([prev, loadTargetId])) {
        if (!id) continue;
        const node = app.graph?.getNodeById(Number(id));
        if (!node) continue;
        applyLoadTargetStyle(node, isLoadTarget(id));
        setMark(node, "nkdLoadTarget", isLoadTarget(id));
        node.setDirtyCanvas(true, true);
    }
}

// The marked LoadImage node, or the sole one if none is marked, else null.
function resolveLoadImageNode() {
    const loads = (app.graph?._nodes ?? []).filter(n => n.comfyClass === "LoadImage");
    if (loadTargetId) {
        const n = loads.find(x => String(x.id) === loadTargetId);
        if (n) return n;
        setLoadTarget(null); // marked node is gone
    }
    return loads.length === 1 ? loads[0] : null;
}

// Upload the given image URL into input/ and point the target LoadImage at it.
async function sendImageToLoadImage(url) {
    if (!url) {
        app.extensionManager?.toast?.add?.({ severity: "warn", summary: "No Image", detail: "Run the node first to generate an image.", life: 4000 });
        return;
    }
    const node = resolveLoadImageNode();
    if (!node) {
        const count = (app.graph?._nodes ?? []).filter(n => n.comfyClass === "LoadImage").length;
        app.extensionManager?.toast?.add?.({
            severity: "warn",
            summary: count === 0 ? "No Load Image Node" : "No Target Selected",
            detail: count === 0 ? "Add a Load Image node to the graph." : "Right-click a Load Image node → Set as NKD image target.",
            life: 6000,
        });
        return;
    }
    try {
        const blob = await fetch(url).then(r => r.blob());
        const ext  = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
        const fd = new FormData();
        // Unique name per send → the widget value changes, so the thumbnail and
        // the cache both refresh cleanly (prefix makes them easy to prune).
        fd.append("image", blob, `nkd_send_${Date.now()}.${ext}`);
        fd.append("type", "input");
        const resp = await api.fetchApi("/upload/image", { method: "POST", body: fd });
        if (!resp.ok) throw new Error(`upload ${resp.status}`);
        const data = await resp.json(); // { name, subfolder, type }
        const val  = data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
        const w = node.widgets?.find(x => x.name === "image");
        if (w) {
            if (w.options?.values && !w.options.values.includes(val)) w.options.values.push(val);
            w.value = val;
            w.callback?.(val);
        }
        node.setDirtyCanvas?.(true, true);
        app.extensionManager?.toast?.add?.({ severity: "success", summary: "Sent to Load Image", detail: `→ ${node.title || "Load Image"} #${node.id}`, life: 3000 });
    } catch (err) {
        console.error("NKD send to LoadImage error:", err);
        app.extensionManager?.toast?.add?.({ severity: "error", summary: "Send Failed", detail: String(err), life: 6000 });
    }
}

// ── Upstream sampler detection ────────────────────────────────────────────────

const SAMPLER_TYPES = new Set([
    "KSampler", "KSamplerAdvanced", "KSamplerSelect",
    "SamplerCustom", "SamplerCustomAdvanced",
    "KSamplerEfficient", "KSampler (Efficient)",
]);

function findUpstreamSampler(nkdNode) {
    const visited = new Set();
    const queue = [nkdNode];
    while (queue.length) {
        const node = queue.shift();
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        if (visited.size > 20) break;
        if (node !== nkdNode && SAMPLER_TYPES.has(node.type)) return node;
        for (const input of (node.inputs ?? [])) {
            if (!input?.link) continue;
            const link = app.graph.getLink(input.link);
            if (!link) continue;
            const upstream = app.graph.getNodeById(link.origin_id);
            if (upstream && !visited.has(upstream.id)) queue.push(upstream);
        }
    }
    return null;
}

// Every node feeding into `startNode` (the subgraph a partial queue executes).
function collectUpstreamNodes(startNode) {
    const visited = new Set();
    const out = [];
    const queue = [startNode];
    while (queue.length) {
        const node = queue.shift();
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        if (visited.size > 200) break;
        out.push(node);
        for (const input of (node.inputs ?? [])) {
            if (!input?.link) continue;
            const link = app.graph.getLink(input.link);
            if (!link) continue;
            const upstream = app.graph.getNodeById(link.origin_id);
            if (upstream && !visited.has(upstream.id)) queue.push(upstream);
        }
    }
    return out;
}

// ── PopupWin ──────────────────────────────────────────────────────────────────

// ── Viewer DOM factory ────────────────────────────────────────────────────────
// Builds the viewer UI as a DOM element in the host document (shared by the panel, PiP and OS-window modes).
// Based on bEpic Viewer's "move live DOM" pattern: the element is appended to the
// blank window's body — no fetch, no script re-injection needed.

const VIEWER_CSS = `
.nkd-pv-viewer-root *,.nkd-pv-viewer-root *::before,.nkd-pv-viewer-root *::after{box-sizing:border-box;margin:0;padding:0}
.nkd-pv-viewer-root{width:100%;height:100%;background:#080808;overflow:hidden;cursor:grab;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;position:relative;container-type:inline-size;}
.nkd-pv-viewer-root.panning{cursor:grabbing}
.nkd-pv-help{position:absolute;top:14px;left:14px;z-index:8;width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:help;color:rgba(255,255,255,0.55);background:rgba(28,28,28,0.85);border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(6px);opacity:0.5;transition:opacity 0.25s,color 0.14s;}
.nkd-pv-viewer-root:hover .nkd-pv-help{opacity:1}
.nkd-pv-help:hover{color:#fff}
.nkd-pv-help svg{width:15px;height:15px;}
.nkd-pv-help-panel{position:absolute;top:32px;left:0;display:none;width:250px;padding:11px 13px;border-radius:8px;background:rgba(18,18,18,0.97);border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(8px);box-shadow:0 10px 34px rgba(0,0,0,0.55);font:11px/1.75 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:rgba(255,255,255,0.72);}
.nkd-pv-help:hover .nkd-pv-help-panel{display:block}
.nkd-pv-help-panel .k{display:inline-block;min-width:80px;color:#9fe09f;font-family:monospace;}
.nkd-pv-help-panel hr{border:none;border-top:1px solid rgba(255,255,255,0.1);margin:7px 0;}
.nkd-pv-vwrap{width:100%;height:100%;position:relative;overflow:hidden;background-color:#050505;background-image:linear-gradient(45deg,#101010 25%,transparent 25%),linear-gradient(-45deg,#101010 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#101010 75%),linear-gradient(-45deg,transparent 75%,#101010 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
.nkd-pv-vimg,.nkd-pv-refimg{position:absolute;top:0;left:0;display:block;transform-origin:0 0;transition:opacity 0.15s;user-select:none;-webkit-user-drag:none;}
.nkd-pv-refclip{position:absolute;inset:0;display:none;z-index:1;pointer-events:none;overflow:hidden}
.nkd-pv-viewer-root.holding-ref .nkd-pv-vimg{visibility:hidden}
.nkd-pv-viewer-root.holding-ref .nkd-pv-refclip,.nkd-pv-viewer-root.cmp-wipe .nkd-pv-refclip,.nkd-pv-viewer-root.cmp-diff .nkd-pv-refclip{display:block}
.nkd-pv-viewer-root.cmp-diff .nkd-pv-refclip{mix-blend-mode:difference}
.nkd-pv-viewer-root.holding-ref .nkd-pv-refclip{clip-path:none !important;mix-blend-mode:normal !important}
.nkd-pv-wipe{position:absolute;top:0;bottom:0;width:16px;margin-left:-8px;z-index:4;display:none;cursor:ew-resize;touch-action:none}
.nkd-pv-wipe::before{content:"";position:absolute;left:7px;top:0;bottom:0;width:2px;background:rgba(255,255,255,0.85);box-shadow:0 0 6px rgba(0,0,0,0.6)}
.nkd-pv-wipe::after{content:"";position:absolute;left:0;top:50%;margin-top:-8px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 0 6px rgba(0,0,0,0.6)}
.nkd-pv-viewer-root.cmp-wipe .nkd-pv-wipe{display:block}
.nkd-pv-viewer-root.holding-ref .nkd-pv-wipe{display:none}
.nkd-pv-viewer-root:focus{outline:none}
.nkd-pv-live-badge{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:7;display:none;padding:3px 10px;border-radius:10px;font:bold 11px monospace;letter-spacing:1px;color:#fff;background:rgba(180,32,48,0.92);pointer-events:none;}
.nkd-pv-live-badge.on{display:block}.nkd-pv-live-badge.cancelled{background:rgba(120,120,120,0.92)}
.nkd-pv-strip{position:absolute;left:50%;bottom:74px;transform:translateX(-50%);z-index:6;display:none;gap:6px;max-width:80%;overflow-x:auto;padding:5px;border-radius:8px;background:rgba(18,18,18,0.85);border:1px solid rgba(255,255,255,0.1);backdrop-filter:blur(6px);opacity:0;transition:opacity 0.25s;}
.nkd-pv-viewer-root:hover .nkd-pv-strip{opacity:1}
.nkd-pv-strip.on{display:flex}
.nkd-pv-strip img{height:46px;width:auto;border-radius:4px;border:2px solid transparent;cursor:pointer;flex:none;opacity:0.7}
.nkd-pv-strip img.cur{border-color:#7dc97d;opacity:1}
.nkd-pv-count{position:absolute;top:18px;left:50%;margin-left:70px;font:11px monospace;color:rgba(255,255,255,0.5);pointer-events:none;z-index:5;display:none}
.nkd-pv-count.on{display:block}
.nkd-pv-ref-badge{position:absolute;top:38px;left:14px;background:rgba(180,32,48,0.92);color:#fff;font:bold 11px monospace;padding:4px 9px;border-radius:4px;pointer-events:none;display:none;z-index:5;letter-spacing:1px;backdrop-filter:blur(4px);}
.nkd-pv-viewer-root.holding-ref .nkd-pv-ref-badge{display:block}
.nkd-pv-mask-ov{position:absolute;top:0;left:0;transform-origin:0 0;pointer-events:none;display:none;z-index:2;-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-mode:luminance;mask-mode:luminance;}
.nkd-pv-viewer-root.holding-mask .nkd-pv-mask-ov,.nkd-pv-viewer-root.mask-on .nkd-pv-mask-ov{display:block}
.nkd-pv-mask-ctl{display:flex;gap:6px;align-items:center;}
.nkd-pv-btn-mask{user-select:none;background:rgba(40,28,32,0.92);border-color:rgba(255,180,180,0.18);}
.nkd-pv-btn-mask:hover{background:rgba(72,40,48,0.96);color:#fff}
.nkd-pv-btn-mask.active{background:rgba(180,32,48,0.95);color:#fff}
.nkd-pv-mask-color{width:30px;height:30px;padding:0;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:none;cursor:pointer;flex:none;}
.nkd-pv-mask-color::-webkit-color-swatch-wrapper{padding:0;}
.nkd-pv-mask-color::-webkit-color-swatch{border:none;border-radius:5px;}
.nkd-pv-mask-op{width:80px;height:30px;cursor:pointer;accent-color:#7dc97d;}
.nkd-pv-bar,.nkd-pv-btn-close{opacity:0;transition:opacity 0.25s;}
.nkd-pv-viewer-root:hover .nkd-pv-bar,.nkd-pv-viewer-root:hover .nkd-pv-btn-close,.nkd-pv-viewer-root:focus-within .nkd-pv-bar{opacity:1}
/* No hover on touch / PiP-without-pointer: hidden controls would be invisible controls. */
@media (hover:none){.nkd-pv-bar,.nkd-pv-btn-close,.nkd-pv-strip{opacity:1}}
/* One full-width bottom bar split into left (reference) + right (actions)
   groups; space-between keeps them apart and each wraps on its own so the
   clusters never overlap on narrow windows. */
.nkd-pv-bar{position:absolute;left:18px;right:18px;bottom:18px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:8px 16px;z-index:6;}
.nkd-pv-bar-group{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.nkd-pv-bar-right{display:flex;flex-direction:column;align-items:flex-end;gap:8px;margin-left:auto;}
.nkd-pv-bar-row{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;}
.nkd-pv-btn-close{position:absolute;top:14px;right:14px;z-index:6;}
.nkd-pv-btn-hold{user-select:none;background:rgba(40,28,32,0.92);border-color:rgba(255,180,180,0.18);}
.nkd-pv-btn-hold:hover{background:rgba(72,40,48,0.96);color:#fff}
.nkd-pv-btn-hold.active{background:rgba(180,32,48,0.95);color:#fff}
.nkd-pv-vbtn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;line-height:1;white-space:nowrap;background:rgba(28,28,28,0.92);border:1px solid rgba(255,255,255,0.12);color:#ccc;border-radius:6px;cursor:pointer;font-size:13px;backdrop-filter:blur(6px);transition:background 0.14s,color 0.14s;}
.nkd-pv-vbtn svg{width:15px;height:15px;flex:none;display:block;}
/* Narrow viewer → collapse buttons to icon-only (names stay in tooltips). */
@container (max-width:470px){.nkd-pv-vbtn .nkd-pv-lbl{display:none;}.nkd-pv-vbtn{padding:0 9px;}}
.nkd-pv-vbtn:hover{background:rgba(72,72,72,0.96);color:#fff}
.nkd-pv-vbtn:active{transform:scale(0.97)}
.nkd-pv-btn-run{background:rgba(46,58,46,0.92);border-color:rgba(125,201,125,0.35);color:#9fe09f}
.nkd-pv-btn-run:hover{background:rgba(60,84,60,0.96);color:#fff}
.nkd-pv-info{position:absolute;top:18px;left:48px;display:flex;gap:10px;align-items:center;font:11px monospace;color:rgba(255,255,255,0.3);pointer-events:none;z-index:5;}
.nkd-pv-zoom{pointer-events:auto;cursor:pointer;font:inherit;color:rgba(255,255,255,0.55);background:rgba(28,28,28,0.7);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:1px 6px}
.nkd-pv-zoom:hover{color:#fff}
.nkd-pv-px{color:rgba(255,255,255,0.55)}
.nkd-pv-more{position:relative;display:inline-flex}
.nkd-pv-more-menu{position:absolute;bottom:36px;right:0;display:none;flex-direction:column;align-items:stretch;gap:6px;padding:6px;border-radius:8px;background:rgba(18,18,18,0.97);border:1px solid rgba(255,255,255,0.12);box-shadow:0 10px 34px rgba(0,0,0,0.55);z-index:9}
.nkd-pv-more.open .nkd-pv-more-menu{display:flex}
.nkd-pv-more-menu .nkd-pv-vbtn{justify-content:flex-start}
.nkd-pv-more-menu .nkd-pv-lbl{display:inline !important}
.nkd-pv-btn-save.saved{background:rgba(46,58,46,0.92);border-color:rgba(125,201,125,0.35);color:#9fe09f}
.nkd-pv-btn-cmp{background:rgba(28,34,44,0.92)}
.nkd-pv-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:rgba(255,255,255,0.18);pointer-events:none;}
.nkd-pv-empty svg{width:64px;height:64px;}
.nkd-pv-empty p{font:14px/1.4 monospace;margin:0;letter-spacing:0.02em;}
.nkd-pv-empty.hidden{display:none;}
`;

// Inline SVG icons (consistent stroke, currentColor) — replaces emoji/box glyphs
// that rendered at inconsistent sizes and baselines across platforms.
const ICON = {
    run:   '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    fit:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    win:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    save:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    copy:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    load:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    swap:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 4l4 4-4 4M21 8H8M7 20l-4-4 4-4M3 16h13"/></svg>',
    mask:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
    pixel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9 9h1v6M14 9h1v6"/></svg>',
    more:  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    cmp:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
    folder:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function createViewerDOM(opts = {}) {
    const { refUrl = null, refLabel = null, maskUrl = null, apiBase = null, onQueue = null, onSendToLoad = null,
            onSave = null, onReveal = null } = opts;
    // imgMeta is mutable — caller can update via root._nkdSetMeta(meta)
    let imgMeta = opts.imgMeta || null;
    // Reference/mask availability is dynamic — refreshed via root._nkdSetRefs()
    // whenever the workflow runs, so Hold/Mask appear as soon as a ref exists.
    let curRef  = refUrl  || null;
    let curMask = maskUrl || null;

    // Inject CSS once into the host document.
    const styleId = "nkd-viewer-style";
    if (!document.getElementById(styleId)) {
        const st = document.createElement("style");
        st.id = styleId;
        st.textContent = VIEWER_CSS;
        document.head.appendChild(st);
    }

    const root = document.createElement("div");
    root.className = "nkd-pv-viewer-root";
    // Focusable so the shortcuts live on the root (not on `document`): they act only while
    // the pointer is over this viewer, work in any window it is moved to, and leak nothing.
    root.tabIndex = -1;
    root.style.cssText = "width:100%;height:100%;";

    root.innerHTML = `
        <div class="nkd-pv-vwrap">
            <img class="nkd-pv-vimg" alt="" draggable="false">
            <div class="nkd-pv-refclip"><img class="nkd-pv-refimg" alt="" draggable="false"></div>
            <div class="nkd-pv-mask-ov"></div>
            <div class="nkd-pv-empty">
                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" stroke-width="2.5"/>
                    <circle cx="22" cy="26" r="4" stroke="currentColor" stroke-width="2.5"/>
                    <path d="M8 42 L20 30 L30 40 L40 28 L56 44" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
                </svg>
                <p>Run the node to preview an image</p>
            </div>
        </div>
        <div class="nkd-pv-ref-badge">REF</div>
        <div class="nkd-pv-live-badge"></div>
        <div class="nkd-pv-count"></div>
        <div class="nkd-pv-wipe"></div>
        <div class="nkd-pv-strip"></div>
        <div class="nkd-pv-help" title="Gestures & shortcuts">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.1 9.2a3 3 0 0 1 5.8 1c0 2-3 2.3-3 4"/><path d="M12 17h.01"/></svg>
            <div class="nkd-pv-help-panel">
                <div><span class="k">Drag</span> pan image</div>
                <div><span class="k">Wheel</span> zoom</div>
                <div><span class="k">Double-click</span> 1:1 / fit</div>
                <hr>
                <div><span class="k">Shift+Q</span> run / queue</div>
                <div><span class="k">Space</span> hold reference</div>
                <div><span class="k">M</span> mask overlay (peek)</div>
                <div><span class="k">V</span> compare: flash / wipe / diff</div>
                <div><span class="k">S</span> save &middot; <span class="k">C</span> copy image</div>
                <div><span class="k">To Load</span> send to Load Image node</div>
                <div><span class="k">&larr; / &rarr;</span> previous / next in batch</div>
                <div><span class="k">Shift+arrows</span> pan &middot; <span class="k">pinch</span> zoom</div>
                <div><span class="k">0 / F</span> fit &middot; <span class="k">1</span> 1:1 &middot; <span class="k">Esc</span> close</div>
            </div>
        </div>
        <button class="nkd-pv-btn-close nkd-pv-vbtn" title="Close">${ICON.close}<span class="nkd-pv-lbl">Close</span></button>
        <div class="nkd-pv-info"><span class="nkd-pv-dims"></span><button class="nkd-pv-zoom" title="Zoom - click for 100%"></button><span class="nkd-pv-px"></span></div>
        <div class="nkd-pv-bar">
            <div class="nkd-pv-bar-group nkd-pv-bar-left">
                <button class="nkd-pv-btn-hold nkd-pv-vbtn" title="Hold to show reference image (Space)" style="display:${refUrl ? '' : 'none'}">${ICON.swap}<span class="nkd-pv-lbl">Hold for Ref</span></button>
                <button class="nkd-pv-btn-cmp nkd-pv-vbtn" title="Compare mode (V): Flash / Wipe / Diff" style="display:none">${ICON.cmp}<span class="nkd-pv-lbl">Flash</span></button>
                <span class="nkd-pv-mask-ctl" style="display:${maskUrl ? '' : 'none'}">
                    <button class="nkd-pv-btn-mask nkd-pv-vbtn" title="Toggle the reference mask overlay — hold M to peek">${ICON.mask}<span class="nkd-pv-lbl">Mask</span></button>
                    <input type="color" class="nkd-pv-mask-color" title="Overlay colour">
                    <input type="range" class="nkd-pv-mask-op" min="5" max="100" title="Overlay opacity">
                </span>
            </div>
            <div class="nkd-pv-bar-right">
                <div class="nkd-pv-bar-row">
                    <button class="nkd-pv-btn-fit nkd-pv-vbtn" title="Fit image to window (0)">${ICON.fit}<span class="nkd-pv-lbl">Fit Image</span></button>
                    <button class="nkd-pv-btn-100 nkd-pv-vbtn" title="Actual size (1)">${ICON.pixel}<span class="nkd-pv-lbl">1:1 Pixel</span></button>
                </div>
                <div class="nkd-pv-bar-row">
                    <button class="nkd-pv-btn-run nkd-pv-vbtn" title="Queue this node (Shift+Q)" style="display:${onQueue ? '' : 'none'}">${ICON.run}<span class="nkd-pv-lbl">Run</span></button>
                    <button class="nkd-pv-btn-copy nkd-pv-vbtn" title="Copy image to clipboard (C)">${ICON.copy}<span class="nkd-pv-lbl">Copy</span></button>
                    <button class="nkd-pv-btn-save nkd-pv-vbtn" title="Save into the active project's folder (S)">${ICON.folder}<span class="nkd-pv-lbl">Save</span></button>
                    <span class="nkd-pv-more"><button class="nkd-pv-btn-more nkd-pv-vbtn" title="More">${ICON.more}</button><div class="nkd-pv-more-menu"><button class="nkd-pv-btn-adj nkd-pv-vbtn" title="Fit window to image">${ICON.win}<span class="nkd-pv-lbl">Fit Window</span></button><button class="nkd-pv-btn-dl nkd-pv-vbtn" title="Download a copy through the browser">${ICON.save}<span class="nkd-pv-lbl">Download</span></button><button class="nkd-pv-btn-load nkd-pv-vbtn" title="Send image to the target Load Image node" style="display:${onSendToLoad ? '' : 'none'}">${ICON.load}<span class="nkd-pv-lbl">To Load</span></button><button class="nkd-pv-btn-reveal nkd-pv-vbtn" title="Show in the file manager" style="display:none">${ICON.folder}<span class="nkd-pv-lbl">Show in folder</span></button></div></span>
                </div>
            </div>
        </div>`;

    const wrap    = root.querySelector(".nkd-pv-vwrap");
    const img     = root.querySelector(".nkd-pv-vimg");
    const refImg  = root.querySelector(".nkd-pv-refimg");
    const empty   = root.querySelector(".nkd-pv-empty");
    const dims    = root.querySelector(".nkd-pv-dims");
    const btnHold = root.querySelector(".nkd-pv-btn-hold");
    const maskOv  = root.querySelector(".nkd-pv-mask-ov");
    const zoomBtn = root.querySelector(".nkd-pv-zoom");
    const pxEl    = root.querySelector(".nkd-pv-px");
    let pxCtx = null, pxSrc = "", pxLast = 0;   // cached 2D copy of the image for the pixel readout

    let scale = 1, tx = 0, ty = 0, fitScale = 1;
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;
    // userView: the user has zoomed/panned, so a new image (live frame, re-render) keeps the
    // framing instead of snapping back to fit. lastNW: natural width the view was set for.
    let userView = false, lastNW = 0;

    function apply() {
        const rendering = scale > 1.0 ? "pixelated" : "auto";
        img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
        img.style.imageRendering = rendering;
        if (curRef) applyRefTransform(rendering);
        if (curMask) applyMaskTransform();
        zoomBtn.textContent = Math.round(scale * 100) + "%";
    }

    // Overlay the mask 1:1 over the current image's box (it's expected to match
    // the image resolution; mask-size:100% stretches to fit if it doesn't).
    function applyMaskTransform() {
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh) return;
        maskOv.style.width  = nw + "px";
        maskOv.style.height = nh + "px";
        maskOv.style.transform = img.style.transform;
    }

    function applyRefTransform(rendering) {
        const cw = img.naturalWidth, ch = img.naturalHeight;
        const rw = refImg.naturalWidth, rh = refImg.naturalHeight;
        if (!cw || !ch || !rw || !rh) {
            refImg.style.transform = img.style.transform;
            refImg.style.imageRendering = rendering;
            return;
        }
        const cAR = cw / ch, rAR = rw / rh;
        let dispW, dispH, offX = 0, offY = 0;
        if (Math.abs(cAR - rAR) < 1e-3) {
            dispW = cw; dispH = ch;
        } else if (rAR > cAR) {
            dispW = cw; dispH = cw / rAR; offY = (ch - dispH) / 2;
        } else {
            dispH = ch; dispW = ch * rAR; offX = (cw - dispW) / 2;
        }
        refImg.style.width  = dispW + "px";
        refImg.style.height = dispH + "px";
        refImg.style.transform = `translate(${tx + offX * scale}px,${ty + offY * scale}px) scale(${scale})`;
        refImg.style.imageRendering = rendering;
    }

    function fit() {
        const ww = wrap.clientWidth, wh = wrap.clientHeight;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh) return;
        userView = false; lastNW = nw;
        fitScale = Math.min(ww / nw, wh / nh);
        scale = fitScale;
        tx = (ww - nw * fitScale) / 2;
        ty = (wh - nh * fitScale) / 2;
        apply();
        dims.textContent = `${nw} × ${nh} px`;
    }

    root._nkdFit = fit;
    root._nkdSetMeta = (meta) => { imgMeta = meta; setSaved(null); };
    // Batch navigator: thumbnails + counter, driven by the host (which owns the items).
    const strip = root.querySelector(".nkd-pv-strip"), counter = root.querySelector(".nkd-pv-count");
    let batch = { n: 0, i: 0, go: null };
    root._nkdSetBatch = (urls, index, go) => {
        batch = { n: urls.length, i: index, go };
        const multi = urls.length > 1;
        strip.classList.toggle("on", multi); counter.classList.toggle("on", multi);
        counter.textContent = `${index + 1} / ${urls.length}`;
        if (!multi) { strip.textContent = ""; return; }
        if (strip.children.length !== urls.length) {
            strip.textContent = "";
            urls.forEach((u, k) => {
                const t = document.createElement("img");
                t.src = u; t.draggable = false;
                t.addEventListener("click", () => batch.go?.(k));
                strip.appendChild(t);
            });
        }
        [...strip.children].forEach((t, k) => t.classList.toggle("cur", k === index));
    };
    const stepBatch = (d) => { if (batch.n > 1) batch.go?.((batch.i + d + batch.n) % batch.n); };
    // state: "live" | "cancelled" | null. Sampling frames are low-res; without this a cancelled
    // run leaves a blurry frame that reads as the final image.
    const liveBadge = root.querySelector(".nkd-pv-live-badge");
    root._nkdLive = (state, text) => {
        liveBadge.classList.toggle("on", !!state);
        liveBadge.classList.toggle("cancelled", state === "cancelled");
        liveBadge.textContent = text || (state === "cancelled" ? "CANCELLED" : "LIVE");
    };

    img.addEventListener("load", () => {
        pxCtx = null;
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (userView && lastNW && nw && nh) {
            // Same on-screen size whatever the new resolution (TAESD frames are small).
            scale *= lastNW / nw; lastNW = nw;
            fitScale = Math.min(wrap.clientWidth / nw, wrap.clientHeight / nh);
            dims.textContent = `${nw} × ${nh} px`;
            apply();
        } else fit();
        img.style.opacity = "1";
        empty.classList.add("hidden");
    });

    // ── Reference compare (Hold) — always wired, gated on curRef at runtime ──
    refImg.addEventListener("load", apply);
    let holding = false;
    // Latch: a quick click on the button pins the reference (trackpads / touch cannot hold);
    // click again to release. Holding still works as before.
    let latched = false, pressT = 0;
    const showRef = () => { if (!curRef || holding) return; holding = true; root.classList.add("holding-ref"); btnHold.classList.add("active"); };
    const showCur = (force) => { if (!holding || (latched && force !== true)) return; holding = false; latched = false; root.classList.remove("holding-ref"); btnHold.classList.remove("active"); };
    btnHold.addEventListener("mousedown", e => {
        e.preventDefault();
        if (latched) { showCur(true); return; }
        pressT = Date.now(); showRef();
    });
    btnHold.addEventListener("mouseup", () => { if (holding && Date.now() - pressT < 250) latched = true; });
    root.addEventListener("mouseup", showCur);
    root.addEventListener("blur", showCur);
    root.addEventListener("mouseleave", () => {
        showCur();
        // Give the keyboard back to ComfyUI the moment the pointer leaves.
        if (root.ownerDocument.activeElement === root) root.blur();
    });
    root.addEventListener("mouseenter", () => {
        const a = root.ownerDocument.activeElement;
        if (a && a !== root.ownerDocument.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
        root.focus({ preventScroll: true });
    });
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "");
    root.addEventListener("keydown", e => {
        if (e.code !== "Space" || e.repeat || !curRef || typing(e)) return;
        e.preventDefault(); showRef();
    });
    root.addEventListener("keyup", e => { if (e.code === "Space") { e.preventDefault(); showCur(); } });

    // ── Compare modes: flash (hold) / wipe (divider) / diff ─────────────────────
    const cmpBtn = root.querySelector(".nkd-pv-btn-cmp"), wipeEl = root.querySelector(".nkd-pv-wipe"),
          refClip = root.querySelector(".nkd-pv-refclip");
    const MODES = ["flash", "wipe", "diff"];
    let cmpMode = localStorage.getItem("nkd_cmp_mode");
    if (!MODES.includes(cmpMode)) cmpMode = "flash";
    let wipeX = 0.5;
    const syncCmp = () => {
        root.classList.toggle("cmp-wipe", !!curRef && cmpMode === "wipe");
        root.classList.toggle("cmp-diff", !!curRef && cmpMode === "diff");
        cmpBtn.style.display = curRef ? "" : "none";
        cmpBtn.querySelector(".nkd-pv-lbl").textContent = cmpMode[0].toUpperCase() + cmpMode.slice(1);
        wipeEl.style.left = (wipeX * 100) + "%";
        // Reference layer sits on top and reads left = before, right = after.
        refClip.style.clipPath = curRef && cmpMode === "wipe" ? `inset(0 ${(1 - wipeX) * 100}% 0 0)` : "";
    };
    const cycleCmp = () => {
        cmpMode = MODES[(MODES.indexOf(cmpMode) + 1) % MODES.length];
        try { localStorage.setItem("nkd_cmp_mode", cmpMode); } catch { /* ignore */ }
        syncCmp();
    };
    cmpBtn.addEventListener("click", cycleCmp);
    let wipeDrag = false;
    wipeEl.addEventListener("pointerdown", e => { e.preventDefault(); e.stopPropagation(); wipeEl.setPointerCapture(e.pointerId); wipeDrag = true; });
    wipeEl.addEventListener("pointermove", e => {
        if (!wipeDrag) return;
        const r = root.getBoundingClientRect();
        wipeX = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        syncCmp();
    });
    const endWipe = () => { wipeDrag = false; };
    wipeEl.addEventListener("pointerup", endWipe); wipeEl.addEventListener("pointercancel", endWipe);

    // ── Mask overlay (toggle button + M peek) — always wired, gated on curMask ──
    const btnMask = root.querySelector(".nkd-pv-btn-mask");
    const colorIn = root.querySelector(".nkd-pv-mask-color");
    const opIn    = root.querySelector(".nkd-pv-mask-op");
    colorIn.value = localStorage.getItem("nkd_mask_color") || "#ff2f38";
    opIn.value    = localStorage.getItem("nkd_mask_op")    || "50";
    const styleMask = () => { maskOv.style.backgroundColor = colorIn.value; maskOv.style.opacity = String(opIn.value / 100); };
    styleMask();
    colorIn.addEventListener("input", () => { styleMask(); localStorage.setItem("nkd_mask_color", colorIn.value); });
    opIn.addEventListener("input",    () => { styleMask(); localStorage.setItem("nkd_mask_op",    opIn.value); });

    let maskOn = false;
    const setToggle = (on) => { maskOn = on && !!curMask; root.classList.toggle("mask-on", maskOn); btnMask.classList.toggle("active", maskOn); if (maskOn) applyMaskTransform(); };
    btnMask.addEventListener("click", () => setToggle(!maskOn));
    let peeking = false;
    const peekOn  = () => { if (peeking || !curMask) return; peeking = true; applyMaskTransform(); root.classList.add("holding-mask"); };
    const peekOff = () => { if (!peeking) return; peeking = false; root.classList.remove("holding-mask"); };
    root.addEventListener("blur", peekOff);
    root.addEventListener("keydown", e => {
        if ((e.key !== "m" && e.key !== "M") || e.repeat || !curMask || typing(e)) return;
        e.preventDefault(); peekOn();
    });
    root.addEventListener("keyup", e => { if (e.key === "m" || e.key === "M") { e.preventDefault(); peekOff(); } });

    // Update reference/mask availability live (called on every workflow run).
    const refBadge = root.querySelector(".nkd-pv-ref-badge");
    const holdLbl  = btnHold.querySelector(".nkd-pv-lbl");
    const setRefLabel = (label) => {
        // "PREV" = the implicit reference (the render before this one); "REF" = a wired/global one.
        refBadge.textContent = label || "REF";
        holdLbl.textContent  = label === "PREV" ? "Hold for Prev" : "Hold for Ref";
    };
    setRefLabel(refLabel);
    root._nkdSetRefs = (rUrl, mUrl, label) => {
        setRefLabel(label);
        curRef  = rUrl  || null;
        curMask = mUrl  || null;
        btnHold.style.display = curRef ? "" : "none";
        if (curRef) { if (refImg.src !== curRef) refImg.src = curRef; }
        else { holding = false; latched = false; root.classList.remove("holding-ref"); btnHold.classList.remove("active"); }
        root.querySelector(".nkd-pv-mask-ctl").style.display = curMask ? "" : "none";
        if (curMask) { maskOv.style.webkitMaskImage = `url("${curMask}")`; maskOv.style.maskImage = `url("${curMask}")`; }
        else { maskOn = peeking = false; root.classList.remove("holding-mask", "mask-on"); btnMask.classList.remove("active"); }
        syncCmp();
        apply();
    };
    if (curRef) refImg.src = curRef;
    syncCmp();
    if (curMask) { maskOv.style.webkitMaskImage = `url("${curMask}")`; maskOv.style.maskImage = `url("${curMask}")`; }

    // Fit Window button — resizes the panel (floating mode) or the OS window (popup mode)
    root.querySelector(".nkd-pv-btn-adj").addEventListener("click", () => {
        const nw = img.naturalWidth, nh = img.naturalHeight;
        if (!nw || !nh) return;
        const maxW = Math.round(screen.availWidth  * 0.9);
        const maxH = Math.round(screen.availHeight * 0.9);
        // Resize panel to match the image at current zoom level.
        const w = Math.max(320, Math.min(Math.round(nw * scale), maxW));
        const h = Math.max(240, Math.min(Math.round(nh * scale), maxH));
        if (typeof root._nkdResizeTo === "function") {
            root._nkdResizeTo(w, h, { center: false });
        } else {
            const dx = window.outerWidth  - window.innerWidth  || 16;
            const dy = window.outerHeight - window.innerHeight || 39;
            const left = Math.round((screen.availWidth  - w - dx) / 2) + (screen.availLeft ?? 0);
            const top  = Math.round((screen.availHeight - h - dy) / 2) + (screen.availTop  ?? 0);
            window.resizeTo(w + dx, h + dy);
            window.moveTo(left, top);
        }
    });

    if (onQueue) root.querySelector(".nkd-pv-btn-run").addEventListener("click", () => onQueue());

    root.querySelector(".nkd-pv-btn-copy").addEventListener("click", () => copyImageToClipboard(img.src, root.ownerDocument.defaultView || window));
    if (onSendToLoad) root.querySelector(".nkd-pv-btn-load").addEventListener("click", () => onSendToLoad());

    root.querySelector(".nkd-pv-btn-fit").addEventListener("click", fit);
    root.querySelector(".nkd-pv-btn-100").addEventListener("click", () => {
        // If in panel mode, resize panel to image size and center it, then fit zoom.
        if (typeof root._nkdResizeTo === "function") {
            const nw = img.naturalWidth, nh = img.naturalHeight;
            if (nw && nh) {
                const maxW = Math.round(window.innerWidth  * 0.9);
                const maxH = Math.round(window.innerHeight * 0.9);
                const w = Math.min(nw, maxW);
                const h = Math.min(nh, maxH);
                root._nkdResizeTo(w, h, { center: true });
                return;
            }
        }
        // Popup / PiP mode: pan to center at 1:1.
        const rect = wrap.getBoundingClientRect();
        const cx = rect.width / 2, cy = rect.height / 2;
        const r = 1.0 / scale;
        tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = 1.0; userView = true; apply();
    });

    // Download — a browser download of the file that already exists. Uses api.apiURL,
    // which resolves correctly in every context (Desktop returns a relative /api/... path).
    const download = () => {
        if (!imgMeta) return;
        const p = new URLSearchParams({
            filename:  imgMeta.filename,
            type:      imgMeta.type,
            subfolder: imgMeta.subfolder ?? "",
        });
        const a = document.createElement("a");
        a.href     = api.apiURL(`/view?${p}`);
        a.download = imgMeta.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };
    root.querySelector(".nkd-pv-btn-dl").addEventListener("click", download);

    // Save — into the active project's folder. Falls back to the download when the host
    // could not hand us a saver, so the button is never a no-op.
    const saveBtn = root.querySelector(".nkd-pv-btn-save"), saveLbl = saveBtn.querySelector(".nkd-pv-lbl");
    const saveTitle = saveBtn.title;
    function setSaved(saved) {
        saveBtn.classList.toggle("saved", !!saved);
        saveLbl.textContent = saved ? "Saved \u2713" : "Save";
        saveBtn.title = saved ? `Saved: ${saved.path || saved.filename}` : saveTitle;
    }
    saveBtn.addEventListener("click", async () => {
        if (!onSave) { download(); return; }
        const saved = await onSave();
        if (saved) setSaved(saved);
    });

    // "..." menu: the rarely-used actions, so the bar keeps to what is used every run.
    const more = root.querySelector(".nkd-pv-more");
    root.querySelector(".nkd-pv-btn-more").addEventListener("click", e => { e.stopPropagation(); more.classList.toggle("open"); });
    root.querySelector(".nkd-pv-more-menu").addEventListener("click", () => more.classList.remove("open"));
    root.addEventListener("pointerdown", e => { if (!more.contains(e.target)) more.classList.remove("open"); });
    root.addEventListener("mouseleave", () => more.classList.remove("open"));
    const btnReveal = root.querySelector(".nkd-pv-btn-reveal");
    if (onReveal) {
        void revealAvailable().then(ok => { if (ok) btnReveal.style.display = ""; });
        btnReveal.addEventListener("click", () => onReveal());
    }

    // Pan & zoom
    wrap.addEventListener("wheel", e => {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        // Proportional to the delta: a mouse notch (~100) is ~10%, a trackpad trickle is smooth,
        // and a pinch (ctrl+wheel, tiny deltas) gets a stronger gain.
        const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.001));
        const ns = Math.max(fitScale * 0.1, Math.min(scale * factor, fitScale * 32));
        const r = ns / scale;
        tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = ns; userView = true; apply();
    }, { passive: false });

    // Left or middle drag pans the image (consistent with the PiP viewer).
    // Pointer capture instead of document listeners: nothing to remove, and it keeps working
    // when the viewer is moved into another window.
    wrap.addEventListener("pointerdown", e => {
        if (e.button !== 0 && e.button !== 1) return;
        e.preventDefault();
        panning = true; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
        wrap.setPointerCapture(e.pointerId);
        root.classList.add("panning");
    });
    const readPixel = (mx, my) => {
        const nw = img.naturalWidth, nh = img.naturalHeight;
        const ix = Math.floor((mx - tx) / scale), iy = Math.floor((my - ty) / scale);
        if (!nw || ix < 0 || iy < 0 || ix >= nw || iy >= nh) { pxEl.textContent = ""; return; }
        let rgb = "";
        try {
            if (!pxCtx || pxSrc !== img.src) {
                const cv = root.ownerDocument.createElement("canvas");
                cv.width = nw; cv.height = nh;
                pxCtx = cv.getContext("2d", { willReadFrequently: true });
                pxCtx.drawImage(img, 0, 0);
                pxSrc = img.src;
            }
            const [r, g, b] = pxCtx.getImageData(ix, iy, 1, 1).data;
            rgb = `  ${r} ${g} ${b}  #${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
        } catch { /* tainted canvas: coordinates only */ }
        pxEl.textContent = `${ix}, ${iy}${rgb}`;
    };
    wrap.addEventListener("pointermove", e => {
        const now = performance.now();
        if (now - pxLast > 40) {
            pxLast = now;
            const rc = wrap.getBoundingClientRect();
            readPixel(e.clientX - rc.left, e.clientY - rc.top);
        }
        if (!panning) return;
        tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy); userView = true; apply();
    });
    wrap.addEventListener("pointerleave", () => { pxEl.textContent = ""; });
    zoomBtn.addEventListener("click", () => {
        const rc = wrap.getBoundingClientRect(), cx = rc.width / 2, cy = rc.height / 2, r = 1 / scale;
        tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = 1; userView = true; apply();
    });
    const endPan = () => { panning = false; root.classList.remove("panning"); };
    wrap.addEventListener("pointerup", endPan);
    wrap.addEventListener("pointercancel", endPan);
    wrap.addEventListener("dblclick", e => {
        const rect = wrap.getBoundingClientRect();
        if (Math.abs(scale - 1.0) < 0.001) fit();
        else {
            const ns = 1.0, r = ns / scale;
            tx = (e.clientX - rect.left) - (e.clientX - rect.left - tx) * r;
            ty = (e.clientY - rect.top)  - (e.clientY - rect.top  - ty) * r;
            scale = ns; userView = true; apply();
        }
    });

    // Follows the element, not the window: right for the panel, PiP and OS window alike.
    const onSize = () => {
        if (!img.naturalWidth) return;
        if (!userView) fit();
        else { fitScale = Math.min(wrap.clientWidth / img.naturalWidth, wrap.clientHeight / img.naturalHeight); apply(); }
    };
    let ro = new ResizeObserver(onSize);
    ro.observe(wrap);
    // An observer belongs to the window that made it; once the viewer moves into a PiP / OS
    // window it must be re-created from THAT window or its rendering loop never notifies us.
    root._nkdRebind = (w) => {
        ro.disconnect();
        ro = new (w.ResizeObserver || ResizeObserver)(onSize);
        ro.observe(wrap);
    };
    root._nkdDispose = () => ro.disconnect();

    // Keyboard
    root.addEventListener("keydown", e => {
        if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Escape") root.querySelector(".nkd-pv-btn-close").click();
        if ((e.key === "v" || e.key === "V") && curRef) cycleCmp();
        if (e.shiftKey && e.key.startsWith("Arrow")) {
            e.preventDefault();
            const step = 60;
            if (e.key === "ArrowRight") tx -= step;
            if (e.key === "ArrowLeft")  tx += step;
            if (e.key === "ArrowDown")  ty -= step;
            if (e.key === "ArrowUp")    ty += step;
            userView = true; apply();
        } else if (e.key === "ArrowRight") { e.preventDefault(); stepBatch(1); }
        else if (e.key === "ArrowLeft")    { e.preventDefault(); stepBatch(-1); }
        // F, not R: plain R is ComfyUI's "refresh node definitions".
        if (e.key === "0" || e.key === "f" || e.key === "F") fit();
        if (e.key === "1") root.querySelector(".nkd-pv-btn-100").click();
        if (e.key === "s" || e.key === "S") root.querySelector(".nkd-pv-btn-save").click();
        if (e.key === "c" || e.key === "C") root.querySelector(".nkd-pv-btn-copy").click();
    });

    return root;
}

// ── PopupWin ──────────────────────────────────────────────────────────────────

class PopupWin {
    constructor(nodeId) {
        this.nodeId             = String(nodeId);
        this.win                = null;
        this.currentUrl         = null;
        this.currentMeta        = null; // { filename, type, subfolder }
        this._title             = "Preview Window";
        this._opening           = false;
        this._pipMode           = false; // true when the window is a Document PiP
        this._refUrl            = null;  // when set, viewer opens in compare mode
        this._maskUrl           = null;  // when set, viewer offers mask overlay
        this.wiredRef           = null;  // /view item from this node's wired `reference` input
        this.wiredMask          = null;  // /view item from this node's wired `mask` input
        this._container         = null;  // live DOM element (bEpic pattern)
        this._livePreviewHandler = null; // b_preview_with_metadata listener
        this.savedRef           = null;  // where "save to project" last put it
        this.items              = [];    // every image of the latest run (a batch)
        this.index              = 0;     // which of them the viewer shows
        this.prevItems          = [];    // the run before: the implicit A/B reference
        this._refLabel          = null;
        this._imageListeners    = new Set();
    }

    /** Repaint hooks for the in-node panel. A Set, not one callback: the node panel and a
     *  future second consumer must not silently evict each other. */
    onImage(fn) {
        this._imageListeners.add(fn);
        return () => this._imageListeners.delete(fn);
    }

    _notifyImage() {
        for (const fn of this._imageListeners) {
            try { fn(); } catch { /* one bad listener must not stop the rest */ }
        }
    }

    setTitle(title) {
        this._title = title || "Preview Window";
        if (this.win && !this.win.closed) {
            try { this.win.document.title = this._title; } catch { /* cross-origin */ }
        }
    }

    /** Queue this window's own node from the viewer (Run button / Shift+Q). */
    _queueOwnNode() {
        const node = app.graph?.getNodeById(Number(this.nodeId));
        if (node) {
            _queueNode(node);
        } else {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "Node Not Found",
                detail: "This preview's node no longer exists in the graph.",
                life: 5000,
            });
        }
    }

    /** Send this window's current image to the target Load Image node. */
    _sendOwnToLoad() { sendImageToLoadImage(this.currentUrl); }

    /** Save into the active project. Bridged into the separate realms the same way the
     *  Run button is: those documents cannot reach `app`/`api` on their own. */
    _revealOwn() {
        const ref = this.savedRef || this.currentMeta;
        if (ref) void reveal(ref);
    }

    _saveOwn() {
        return saveImage(this, app.graph?.getNodeById(Number(this.nodeId)));
    }

    /** A whole run's images. The previous run becomes the implicit A/B reference. */
    showBatch(images) {
        const same = this.items.length === images.length
            && this.items.every((it, i) => it.filename === images[i].filename);
        if (!same && this.items.length) this.prevItems = this.items;
        this.items = images;
        this.index = 0;
        this.showImage(images[0]);
        this._syncBatch();
    }

    _selectIndex(i) {
        if (i < 0 || i >= this.items.length) return;
        this.index = i;
        const it = this.items[i];
        this.currentUrl  = buildViewUrl(it);
        this.currentMeta = { filename: it.filename, type: it.type, subfolder: it.subfolder ?? "" };
        this.savedRef = null;
        this._notifyImage();
        this._container?._nkdSetMeta?.(this.currentMeta);
        this._updateImage(this.currentUrl);
        this.refreshRefs();
        this._syncBatch();
    }

    _syncBatch() {
        this._container?._nkdSetBatch?.(this.items.map(buildViewUrl), this.index, (i) => this._selectIndex(i));
    }

    /** Called on node execution: update existing window or open a new one. */
    showImage(imgData) {
        this.currentUrl  = buildViewUrl(imgData);
        this.currentMeta = {
            filename:  imgData.filename,
            type:      imgData.type,
            subfolder: imgData.subfolder ?? "",
        };
        this.savedRef = null;      // a new render is not the one that was filed away
        this._notifyImage();
        // Only update if already open; never auto-open on execution.
        if (this.win && !this.win.closed) {
            if (this._container?._nkdSetMeta) this._container._nkdSetMeta(this.currentMeta);
            this._updateImage(this.currentUrl);
            this.refreshRefs();  // a run may have (re)set the reference/mask
        }
    }

    /** Reference image/mask URLs for THIS node: the wired inputs win over the global NKD
     *  Reference slot, mirroring the video viewer's wired `reference`. Nothing wired falls
     *  back to the global slot, so an unwired popup behaves exactly as before. */
    async _resolveRefUrls() {
        const [ref, mask] = await Promise.all([
            this.wiredRef  ? buildViewUrl(this.wiredRef)  : getReferenceUrl(),
            this.wiredMask ? buildViewUrl(this.wiredMask) : getReferenceMaskUrl(),
        ]);
        if (ref) { this._refLabel = null; return [ref, mask]; }
        // No explicit reference anywhere: A/B against the render before this one, so
        // "Hold" answers "did that change help?" with nothing to wire up.
        const prev = this.prevItems[Math.min(this.index, this.prevItems.length - 1)];
        this._refLabel = prev ? "PREV" : null;
        return [prev ? buildViewUrl(prev) : null, mask];
    }

    /** Re-fetch the active reference image/mask and push to the open viewer so
     * Hold/Mask appear as soon as a reference exists — no need to reopen. */
    async refreshRefs() {
        if (!this.win || this.win.closed) return;
        const [refUrl, maskUrl] = await this._resolveRefUrls();
        this._refUrl = refUrl; this._maskUrl = maskUrl;
        this._container?._nkdSetRefs?.(refUrl, maskUrl, this._refLabel);
    }

    /** `executed` does not fire for a cached node, nor after a reload, but the node still shows
     *  its picture from `app.nodeOutputs`. Adopt that so the viewer, Copy and Download work
     *  exactly when the node visibly has an image. No-op once a real run has filled it. */
    ensureCurrent() {
        if (this.currentUrl) return;
        const out = app.nodeOutputs?.[this.nodeId];
        const item = out?.images?.[0];
        if (!item) return;
        this.currentUrl  = buildViewUrl(item);
        this.currentMeta = { filename: item.filename, type: item.type, subfolder: item.subfolder ?? "" };
        if (!this.items.length) { this.items = out.images; this.index = 0; }
        this.wiredRef  = out.nkd_ref?.[0]  || this.wiredRef;
        this.wiredMask = out.nkd_mask?.[0] || this.wiredMask;
    }

    /** Called from node button / context menu. Picks up any active reference
     * image automatically so press-and-hold compare is available in the viewer. */
    async open() {
        this.ensureCurrent();
        if (this.win && !this.win.closed) {
            // PiP windows are always on top; regular windows need a focus call.
            if (!this._pipMode) this.win.focus();
            return;
        }
        [this._refUrl, this._maskUrl] = await this._resolveRefUrls();
        this._openViewer();
    }

    async _openViewer() {
        if (this._opening) return;
        this._opening = true;
        try {
            const isElectron = navigator.userAgent.includes("Electron");
            if (!isElectron && window.documentPictureInPicture) {
                try {
                    await this._openDirectPiP();
                } catch {
                    await this._openFloatingPanel();
                }
            } else if (!isElectron) {
                await this._openWindow();
            } else {
                await this._openFloatingPanel();
            }
        } finally {
            this._opening = false;
        }
    }

    async _openFloatingPanel() {
        // If already open, just bring it to front.
        if (this._panel && document.body.contains(this._panel)) {
            this._panel.style.zIndex = "9999";
            return;
        }

        const { winW, winH, x, y } = await this._calcWindowSize("nkd_panel_bounds");

        // ── Panel shell ────────────────────────────────────────────────────────
        const panel = document.createElement("div");
        this._panel = panel;
        const TITLEBAR_H = 32;

        Object.assign(panel.style, {
            position: "fixed",
            width: winW + "px",
            height: (winH + TITLEBAR_H) + "px",
            left: (Number.isFinite(x) ? Math.min(Math.max(0, x), window.innerWidth - 80) : Math.round((window.innerWidth  - winW) / 2)) + "px",
            top:  (Number.isFinite(y) ? Math.min(Math.max(0, y), window.innerHeight - 40) : Math.round((window.innerHeight - winH - TITLEBAR_H) / 2)) + "px",
            zIndex: "9999",
            display: "flex",
            flexDirection: "column",
            borderRadius: "8px",
            overflow: "hidden",
            boxShadow: "0 8px 40px rgba(0,0,0,0.7)",
            border: "1px solid rgba(255,255,255,0.10)",
            background: "#111",
            fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
            minWidth: "320px",
            minHeight: "200px",
        });

        // ── Title bar (drag handle) ────────────────────────────────────────────
        const titlebar = document.createElement("div");
        Object.assign(titlebar.style, {
            height: TITLEBAR_H + "px",
            minHeight: TITLEBAR_H + "px",
            background: "rgba(30,30,30,0.98)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            cursor: "grab",
            userSelect: "none",
            gap: "8px",
        });

        const titleText = document.createElement("span");
        titleText.textContent = this._title;
        Object.assign(titleText.style, { color: "rgba(255,255,255,0.6)", fontSize: "12px", flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });

        const btnStyle = (el) => {
            Object.assign(el.style, { background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: "13px", padding: "2px 6px", borderRadius: "4px", lineHeight: "1" });
            el.onmouseenter = () => { el.style.background = "rgba(255,255,255,0.1)"; el.style.color = "#fff"; };
            el.onmouseleave = () => { el.style.background = "none"; el.style.color = "rgba(255,255,255,0.5)"; };
        };

        const undockBtn = document.createElement("button");
        undockBtn.title = "Open in separate window";
        undockBtn.innerHTML = "&#x2197;";  // ↗
        btnStyle(undockBtn);
        // Electron blocks window.open — undock only works in a real browser.
        if (navigator.userAgent.includes("Electron")) undockBtn.style.display = "none";

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        Object.assign(closeBtn.style, { background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer", fontSize: "14px", padding: "2px 6px", borderRadius: "4px", lineHeight: "1" });
        closeBtn.onmouseenter = () => { closeBtn.style.background = "rgba(180,32,48,0.8)"; closeBtn.style.color = "#fff"; };
        closeBtn.onmouseleave = () => { closeBtn.style.background = "none"; closeBtn.style.color = "rgba(255,255,255,0.5)"; };

        titlebar.appendChild(titleText);
        titlebar.appendChild(undockBtn);
        titlebar.appendChild(closeBtn);

        // ── Viewer content ─────────────────────────────────────────────────────
        const content = document.createElement("div");
        Object.assign(content.style, { flex: "1", position: "relative", overflow: "hidden", minHeight: "0" });

        panel.appendChild(titlebar);
        panel.appendChild(content);
        document.body.appendChild(panel);
        const saveBounds = () => {
            try {
                localStorage.setItem("nkd_panel_bounds", JSON.stringify({
                    w: panel.offsetWidth, h: panel.offsetHeight - TITLEBAR_H, x: panel.offsetLeft, y: panel.offsetTop }));
            } catch { /* ignore */ }
        };

        // ── Resize handles ─────────────────────────────────────────────────────
        const EDGE = 5, CORNER = 14;
        const resizeDefs = [
            { cursor: "ew-resize",   style: { top: EDGE+"px", right: "0",    width: EDGE+"px", height: `calc(100% - ${EDGE*2}px)`, bottom: "auto", left: "auto" }, dirs: { right: 1 } },
            { cursor: "ew-resize",   style: { top: EDGE+"px", left:  "0",    width: EDGE+"px", height: `calc(100% - ${EDGE*2}px)`, bottom: "auto", right: "auto" }, dirs: { left:  1 } },
            { cursor: "ns-resize",   style: { bottom: "0",    left:  CORNER+"px", height: EDGE+"px", width: `calc(100% - ${CORNER*2}px)`, top: "auto" }, dirs: { bottom: 1 } },
            { cursor: "nwse-resize", style: { bottom: "0",    right: "0",    width: CORNER+"px", height: CORNER+"px", top: "auto", left: "auto" }, dirs: { right: 1, bottom: 1 } },
            { cursor: "nesw-resize", style: { bottom: "0",    left:  "0",    width: CORNER+"px", height: CORNER+"px", top: "auto", right: "auto" }, dirs: { left:  1, bottom: 1 } },
        ];

        for (const def of resizeDefs) {
            const r = document.createElement("div");
            Object.assign(r.style, { position: "absolute", zIndex: "10", ...def.style });
            r.style.cursor = def.cursor;
            panel.appendChild(r);

            r.addEventListener("pointerdown", e => {
                e.preventDefault();
                e.stopPropagation();
                r.setPointerCapture(e.pointerId);
                const start = {
                    x: e.clientX, y: e.clientY,
                    w: panel.offsetWidth, h: panel.offsetHeight,
                    l: panel.offsetLeft,  t: panel.offsetTop,
                };
                const minW = 320, minH = 200 + TITLEBAR_H;

                const onMove = ev => {
                    const dx = ev.clientX - start.x;
                    const dy = ev.clientY - start.y;
                    if (def.dirs.right)  { panel.style.width  = Math.max(minW, start.w + dx) + "px"; }
                    if (def.dirs.bottom) { panel.style.height = Math.max(minH, start.h + dy) + "px"; }
                    if (def.dirs.left)   {
                        const nw = Math.max(minW, start.w - dx);
                        panel.style.width = nw + "px";
                        panel.style.left  = (start.l + start.w - nw) + "px";
                    }
                    container._nkdFit?.();
                };
                const onUp = () => {
                    r.removeEventListener("pointermove", onMove);
                    r.removeEventListener("pointerup",   onUp);
                    saveBounds();
                    container._nkdFit?.();
                };
                r.addEventListener("pointermove", onMove);
                r.addEventListener("pointerup",   onUp);
            });
        }

        // ── Viewer DOM (pan/zoom/save/etc.) ───────────────────────────────────
        const container = createViewerDOM({
            refUrl:  this._refUrl,
            refLabel: this._refLabel,
            maskUrl: this._maskUrl,
            imgMeta: this.currentMeta,
            apiBase: location.origin,
            onQueue: () => this._queueOwnNode(),
            onSendToLoad: () => this._sendOwnToLoad(),
            onSave: () => this._saveOwn(),
            onReveal: () => this._revealOwn(),
        });
        container.style.cssText = "width:100%;height:100%;";
        // Hide the viewer's own close button — the panel titlebar has one.
        const viewerClose = container.querySelector(".nkd-pv-btn-close");
        if (viewerClose) viewerClose.style.display = "none";

        // Fit Window resizes the panel keeping its current position.
        // center=true forces re-centering (used by 1:1 Pixel).
        container._nkdResizeTo = (w, h, { center = false } = {}) => {
            if (center) {
                panel.style.left = Math.round((window.innerWidth  - w) / 2) + "px";
                panel.style.top  = Math.round((window.innerHeight - h - TITLEBAR_H) / 2) + "px";
            } else {
                // Grow/shrink from the panel's current center, not its top-left corner.
                const cx = panel.offsetLeft + panel.offsetWidth  / 2;
                const cy = panel.offsetTop  + panel.offsetHeight / 2;
                panel.style.left = Math.round(cx - w / 2) + "px";
                panel.style.top  = Math.round(cy - (h + TITLEBAR_H) / 2) + "px";
            }
            panel.style.width  = w + "px";
            panel.style.height = (h + TITLEBAR_H) + "px";
            // Wait for reflow before calling fit() so wrap.clientWidth reflects the new size.
            requestAnimationFrame(() => container._nkdFit?.());
        };

        content.appendChild(container);

        // Update img
        const imgEl = container.querySelector(".nkd-pv-vimg");
        if (imgEl && this.currentUrl) { imgEl.style.opacity = "0.4"; imgEl.src = this.currentUrl; }

        this._container = container;
        this._syncBatch();
        this._startLivePreview();

        // ── Close ──────────────────────────────────────────────────────────────
        const closePanel = () => {
            this._stopLivePreview();
            container._nkdDispose?.();
            panel.remove();
            this._panel     = null;
            this._container = null;
            if (this.win) { this.win.closed = true; this.win = null; }
        };
        closeBtn.addEventListener("click", closePanel);
        container.querySelector(".nkd-pv-btn-close").addEventListener("click", closePanel);

        // ── Drag ───────────────────────────────────────────────────────────────
        // Pointer capture on the titlebar: no window listeners to pile up per open.
        let dragging = false, dragX = 0, dragY = 0;
        titlebar.addEventListener("pointerdown", e => {
            if (e.target.closest("button")) return;
            dragging = true;
            dragX = e.clientX - panel.offsetLeft;
            dragY = e.clientY - panel.offsetTop;
            titlebar.style.cursor = "grabbing";
            titlebar.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        titlebar.addEventListener("pointermove", e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - dragX) + "px";
            panel.style.top  = (e.clientY - dragY) + "px";
        });
        const endDrag = () => { if (dragging) saveBounds(); dragging = false; titlebar.style.cursor = "grab"; };
        titlebar.addEventListener("pointerup", endDrag);
        titlebar.addEventListener("pointercancel", endDrag);

        // ── Undock: move container to a real OS window ─────────────────────────
        let popoutWin = null;
        undockBtn.addEventListener("click", () => {
            if (popoutWin && !popoutWin.closed) {
                // Re-dock: move container back into panel
                content.appendChild(container);
                container.style.cssText = "width:100%;height:100%;";
                popoutWin.onbeforeunload = null;
                popoutWin.close();
                popoutWin = null;
                panel.style.display = "flex";
                undockBtn.innerHTML = "&#x2197;";
                undockBtn.title = "Open in separate window";
                container._nkdResizeTo = (w, h, opts = {}) => {
                    if (opts.center) {
                        panel.style.left = Math.round((window.innerWidth  - w) / 2) + "px";
                        panel.style.top  = Math.round((window.innerHeight - h - TITLEBAR_H) / 2) + "px";
                    }
                    panel.style.width  = w + "px";
                    panel.style.height = (h + TITLEBAR_H) + "px";
                    container._nkdFit?.();
                };
                return;
            }

            const pw = panel.offsetWidth, ph = panel.offsetHeight - TITLEBAR_H;
            const left = Math.round((screen.availWidth  - pw) / 2);
            const top  = Math.round((screen.availHeight - ph) / 2);

            const win = window.open("", `nkd_popout_${this.nodeId}`,
                `width=${pw},height=${ph},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no`);
            if (!win) return;

            win.resizeTo(pw, ph);
            win.moveTo(left, top);

            // Copy styles
            const st = win.document.createElement("style");
            st.textContent = VIEWER_CSS + `body{margin:0;overflow:hidden;background:#080808;}`;
            win.document.head.appendChild(st);
            Object.assign(win.document.body.style, { margin: "0", overflow: "hidden", background: "#080808" });
            win.document.title = this._title;

            // Move live container into the OS window
            container.style.cssText = "width:100vw;height:100vh;";
            win.document.body.appendChild(container);

            // Fit Window now resizes the OS window
            container._nkdResizeTo = (w, h, opts = {}) => {
                win.resizeTo(w, h);
                if (opts.center) win.moveTo(Math.round((screen.availWidth - w) / 2), Math.round((screen.availHeight - h) / 2));
                container._nkdFit?.();
            };
            panel.style.display = "none";
            popoutWin = win;
            undockBtn.innerHTML = "&#x2199;";
            undockBtn.title = "Dock back to panel";

            win.onbeforeunload = () => {
                // Re-dock automatically when OS window is closed
                content.appendChild(container);
                container.style.cssText = "width:100%;height:100%;";
                panel.style.display = "flex";
                popoutWin = null;
                undockBtn.innerHTML = "&#x2197;";
                undockBtn.title = "Open in separate window";
                container._nkdResizeTo = (w, h, o = {}) => {
                    if (o.center) {
                        panel.style.left = Math.round((window.innerWidth  - w) / 2) + "px";
                        panel.style.top  = Math.round((window.innerHeight - h - TITLEBAR_H) / 2) + "px";
                    }
                    panel.style.width  = w + "px";
                    panel.style.height = (h + TITLEBAR_H) + "px";
                    container._nkdFit?.();
                };
            };
        });

        // ── Expose fake win interface for _updateImage compatibility ───────────
        this.win = {
            closed: false,
            close: closePanel,
            focus: () => { if (popoutWin && !popoutWin.closed) popoutWin.focus(); else panel.style.zIndex = "9999"; },
        };
    }

    async _calcWindowSize(boundsKey) {
        // A size the user set by hand beats the image-derived default.
        try {
            const b = JSON.parse(localStorage.getItem(boundsKey || ""));
            if (b && b.w >= 200 && b.h >= 150) return { winW: Math.max(320, b.w), winH: Math.max(200, b.h), x: b.x, y: b.y };
        } catch { /* nothing saved */ }
        let winW = 800, winH = 680;
        if (this.currentUrl) {
            try {
                const { w, h } = await loadImageDimensions(this.currentUrl);
                const maxW = Math.round(screen.availWidth  * 0.9);
                const maxH = Math.round(screen.availHeight * 0.9);
                const s = Math.min(1, maxW / w, maxH / h);
                winW = Math.max(320, Math.round(w * s));
                winH = Math.max(240, Math.round(h * s));
            } catch { /* keep defaults */ }
        }
        return { winW, winH };
    }

    /** One viewer for THIS node. The panel, the PiP window and the OS popup all mount the same
     *  thing; PiP and popup used to run a second hand-written copy (viewer.html) that drifted
     *  from this one feature by feature, and needed `window.__nkd_*` bridges to reach the app. */
    _makeViewer() {
        return createViewerDOM({
            refUrl:  this._refUrl,
            refLabel: this._refLabel,
            maskUrl: this._maskUrl,
            imgMeta: this.currentMeta,
            apiBase: location.origin,
            onQueue: () => this._queueOwnNode(),
            onSendToLoad: () => this._sendOwnToLoad(),
            onSave: () => this._saveOwn(),
            onReveal: () => this._revealOwn(),
        });
    }

    /** Mount the viewer into an already-open browser window (PiP or OS popup). */
    _mountInWindow(win) {
        const doc = win.document;
        doc.head.textContent = "";
        doc.body.textContent = "";   // a same-named popup may still hold a stale viewer
        const st = doc.createElement("style");
        st.textContent = VIEWER_CSS + "html,body{margin:0;height:100%;overflow:hidden;background:#080808}";
        doc.head.appendChild(st);
        doc.title = this._title;

        const container = this._makeViewer();
        container.style.cssText = "width:100vw;height:100vh;";
        doc.body.appendChild(container);
        container._nkdRebind?.(win);
        container.querySelector(".nkd-pv-btn-close")?.addEventListener("click", () => win.close());
        // Fit Window / 1:1 resize THIS window, not the main one.
        container._nkdResizeTo = (w, h, { center = false } = {}) => {
            try {
                const dx = win.outerWidth - win.innerWidth, dy = win.outerHeight - win.innerHeight;
                win.resizeTo(w + dx, h + dy);
                if (center) win.moveTo(Math.round((screen.availWidth - w) / 2), Math.round((screen.availHeight - h) / 2));
            } catch { /* PiP cannot be moved */ }
            requestAnimationFrame(() => container._nkdFit?.());
        };
        this._container = container;

        const img = container.querySelector(".nkd-pv-vimg");
        if (img && this.currentUrl) { img.style.opacity = "0.4"; img.src = this.currentUrl; }
        this._syncBatch();

        win.addEventListener("pagehide", () => {
            container._nkdDispose?.();
            if (this._container === container) this._container = null;
            this.win      = null;
            this._pipMode = false;
        });
    }

    /** Primary path (Chrome 116+): a Document PiP window. */
    async _openDirectPiP() {
        const { winW, winH } = await this._calcWindowSize("nkd_pip_size");
        const pipWin = await window.documentPictureInPicture.requestWindow({ width: winW, height: winH });
        this.win      = pipWin;
        this._pipMode = true;
        let pipSaveT = 0;
        pipWin.addEventListener("resize", () => {
            clearTimeout(pipSaveT);
            pipSaveT = setTimeout(() => {
                try { localStorage.setItem("nkd_pip_size", JSON.stringify({ w: pipWin.innerWidth, h: pipWin.innerHeight })); } catch { /* ignore */ }
            }, 300);
        });
        try {
            this._mountInWindow(pipWin);
            this._startLivePreview();
        } catch (err) {
            console.error("NKD PiP viewer load error:", err);
            pipWin.close();
        }
    }

    /** Fallback (no PiP support): a regular popup window. */
    async _openWindow() {
        let winW, winH, left, top;
        try {
            const saved = JSON.parse(localStorage.getItem("nkd_preview_bounds"));
            if (saved && saved.w && saved.h) {
                winW = Math.max(320, saved.w);
                winH = Math.max(240, saved.h);
                left = saved.x || 0;
                top  = saved.y || 0;
            }
        } catch { /* ignore parsing errors */ }

        if (!winW) {
            const dims = await this._calcWindowSize();
            winW = dims.winW;
            winH = dims.winH;
            left = Math.round((screen.availWidth  - winW) / 2) + (screen.availLeft ?? 0);
            top  = Math.round((screen.availHeight - winH) / 2) + (screen.availTop  ?? 0);
        }

        const opts = `width=${winW},height=${winH},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no,scrollbars=no`;
        const win = window.open("", `nkd_preview_${this.nodeId}`, opts);
        if (!win) {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "Popup Blocked",
                detail: "Please allow popups for this site and click 'Open Viewer' on the node.",
                life: 7000,
            });
            return;
        }
        this.win      = win;
        this._pipMode = false;
        this._mountInWindow(win);

        const saveState = () => {
            if (this.win && !this.win.closed) {
                localStorage.setItem("nkd_preview_bounds", JSON.stringify({
                    w: this.win.outerWidth || this.win.innerWidth,
                    h: this.win.outerHeight || this.win.innerHeight,
                    x: this.win.screenX,
                    y: this.win.screenY
                }));
            }
        };
        const saveInterval = setInterval(() => {
            if (!this.win || this.win.closed) clearInterval(saveInterval);
            else saveState();
        }, 500);
        win.addEventListener("beforeunload", () => { saveState(); clearInterval(saveInterval); });
    }

    _updateImage(url) {
        const img = this._container?.querySelector(".nkd-pv-vimg");
        if (img) img.src = url;
    }

    // ── Live preview (TAESD frames) ───────────────────────────────────────────

    _isOpen() {
        return (this._panel && document.body.contains(this._panel))
            || (this.win && !this.win.closed);
    }

    _setLiveFrame(dataUrl) {
        // A self-contained data: URL: works in any window (no per-realm blob partitioning).
        const img = this._container?.querySelector(".nkd-pv-vimg");
        if (!img) return;
        img.src = dataUrl;
        img.style.opacity = "1";
        if (this._liveState !== "live") this._live("live", "LIVE");
    }

    /** Badge state on the in-DOM viewer: "live" | "cancelled" | null. */
    _live(state, text) {
        this._liveState = state;
        try { this._container?._nkdLive?.(state, text); } catch { /* ignore */ }
    }

    _startLivePreview() { /* handled globally in setup() via WebSocket intercept */ }
    _stopLivePreview()  { /* no-op — global listener in setup() manages all popups */ }

    destroy() {
        this._stopLivePreview();
        if (this.win && !this.win.closed) this.win.close();
        try { this._container?._nkdDispose?.(); this._container?.remove(); } catch { /* ignore */ }
        this._container = null;
    }
}

// ── SaveImage ─────────────────────────────────────────────────────────────────

function _noImageToast() {
    app.extensionManager?.toast?.add?.({
        severity: "warn",
        summary: "No Image",
        detail: "Run the node first to generate an image.",
        life: 4000,
    });
}

/** Download a copy through the browser. The Downloads folder is the one place a project
 *  system cannot reach, so this stays available but is no longer what "Save" means. */
function downloadImage(popup) {
    popup?.ensureCurrent();
    if (!popup?.currentMeta) return _noImageToast();
    const { filename, type, subfolder } = popup.currentMeta;
    const p = new URLSearchParams({ filename, type, subfolder: subfolder ?? "" });
    const a = document.createElement("a");
    a.href     = api.apiURL(`/view?${p}`);
    a.download = filename;
    a.click();
}

/**
 * Copy the preview out of temp/ and into the active project's folder.
 *
 * The node's preview is written by the core into temp/, which ComfyUI empties - so
 * "saving" it has to mean putting it somewhere that survives. Where that is comes from the
 * project chip, and `%node%` is filled in here because only the frontend knows the node's
 * title. `applyTextReplacements` expands the core's own `%date:...%` for the same reason it
 * does at prompt-submit time.
 */
async function saveImage(popup, node) {
    const ref = node ? currentRef(node, popup) : popup?.currentMeta;
    if (!ref) return _noImageToast();
    let prefix = undefined;
    const cfg = nkdConfig();
    const wv   = (n) => node?.widgets?.find((w) => w.name === n)?.value;
    const pfx  = String(wv("filename_prefix") || "").trim();   // per-node folder override
    const name = String(wv("filename") || "").trim();          // per-node file name
    // Node fields win over the global project prefix; empty falls back to it. Same
    // folder/name join as the video viewer's `_resolve_prefix`.
    let base = pfx || (cfg ? cfg.image_prefix : undefined);
    if (base !== undefined) {
        if (name) base = `${base.replace(/\/+$/, "")}/${name}`;
        prefix = base.replaceAll("%node%", _cleanTitle(node));
        // The core expands its own %date:...% at prompt-submit time; nothing submits a
        // prompt here, so it has to be done by hand or the token reaches the path literal.
        try {
            prefix = window.comfyAPI?.utils?.applyTextReplacements?.(app, prefix) ?? prefix;
        } catch { /* older frontends: the token just stays literal */ }
    }
    try {
        const saved = await saveToProject(ref, prefix);
        app.extensionManager?.toast?.add?.({
            severity: "success", summary: "Saved",
            detail: `${saved.subfolder ? saved.subfolder + "/" : ""}${saved.filename}`,
            life: 4000,
        });
        popup.savedRef = saved;
        popup._notifyImage();
        return saved;
    } catch (err) {
        app.extensionManager?.toast?.add?.({
            severity: "error", summary: "Could not save", detail: String(err), life: 6000,
        });
        return null;
    }
}

/** The node's TITLE is the naming field, same rule as the video viewer's `%node%`. The
 *  default title carries an emoji and spaces, so it is not usable as a folder name. */
function _cleanTitle(node) {
    const raw = node?.title;
    const bad = !raw || raw === node?.constructor?.title || /[^\w .-]/.test(raw);
    return bad ? "NKD" : raw.trim().replace(/\s+/g, "_");
}

// ── The in-node panel ────────────────────────────────────────────────────────
// Deliberately the SAME dialect as the video viewer: `.nkd-tl-bar` + `.nkd-tl-btn` +
// `.nkd-vid-path`, mounted through the shared `mountDomWidget`. Four emoji-labelled
// LiteGraph buttons and a viewer built out of DOM were two different-looking controls for
// the same job, in the same pack.
//
// The old widgets carried `{ serialize: false }`, so dropping them touches nothing in
// `widgets_values` and no saved workflow is disturbed.

const MIN_PANEL_W = 260;

/**
 * The image this node is currently showing, as a /view item.
 *
 * `popup.currentMeta` is filled from the `executed` websocket event, which does NOT fire
 * for a node served from cache, nor on a page reload, nor when a saved workflow is opened -
 * so on its own it goes null exactly when the node is still visibly showing a picture, and
 * every button that needs a file becomes a silent no-op. `app.nodeOutputs` is where the
 * core keeps what it is actually rendering, so it is the honest source and the fallback.
 */
function currentRef(node, popup) {
    return popup?.currentMeta || app.nodeOutputs?.[node.id]?.images?.[0] || null;
}

function _refUrl(ref) {
    return ref ? buildViewUrl(ref) : null;
}

function _el(tag, cls, parent) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    parent?.appendChild(node);
    return node;
}

function _btn(bar, icon, title, on) {
    const b = _el("button", "nkd-tl-btn", bar);
    b.title = title;
    _el("i", `pi ${icon}`, b);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); on(); });
    b.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    return b;
}

function buildNodePanel(node) {
    ensureStyles();
    void loadConfig();
    const popup = getPopup(String(node.id));

    // NO thumbnail of our own: ComfyUI already renders the node's preview from
    // `app.nodeOutputs`, so a second copy is the same pixels decoded twice and a taller
    // node for nothing. Just the bar and the destination line.
    const root  = _el("div", "nkd-tl nkd-vid");

    // nkd-pp-bar: nowrap + max-content width, so the button row never wraps to a second line
    // and its intrinsic width can be measured (offsetWidth) to set the node's minimum.
    const bar = _el("div", "nkd-tl-bar nkd-pp-bar", root);
    _btn(bar, "pi-external-link", "Open the viewer window", () => openViewer(node));
    _btn(bar, "pi-copy", "Copy the image to the clipboard",
         () => copyImageToClipboard(popup.currentUrl || _refUrl(currentRef(node, popup))));
    _btn(bar, "pi-save", "Save into the active project's folder",
         () => void saveImage(popup, node));
    // Reveals whatever exists: the filed copy once there is one, the temp preview before.
    revealButton(bar, () => popup.savedRef || currentRef(node, popup));
    const star = _btn(bar, "pi-star", "Set as the primary preview",
                      () => { setPrimary(isPrimary(node.id) ? null : node.id);
                              node.graph?.setDirtyCanvas(true, true); });
    const chip = projectChip(bar);

    // Where the image is now, or where "save" would put it. A destination you cannot see
    // before you press the button is the thing this whole feature exists to fix.
    const path = _el("div", "nkd-vid-path", root);
    path.title = "Click to copy";
    path.addEventListener("click", () => {
        void navigator.clipboard?.writeText(path.dataset.full || "");
        const was = path.textContent;
        path.textContent = "copied";
        setTimeout(() => { path.textContent = was; }, 900);
    });

    const mounted = mountDomWidget(node, {
        name: "nkd_popup", type: "NKD_POPUP", root, minWidth: MIN_PANEL_W,
        // The node never gets narrower than the (nowrap) button row, so the buttons never
        // wrap. bar.offsetWidth is intrinsic because .nkd-pp-bar is width:max-content.
        minWidthOf: () => bar.offsetWidth + 1,
        estimate: () => 56,   // one button row plus the path line
    });

    const paint = () => {
        const ref = popup.savedRef || currentRef(node, popup);
        const where = ref
            ? `${popup.savedRef ? "" : (ref.type || "temp") + "/"}${ref.subfolder ? ref.subfolder + "/" : ""}${ref.filename}`
            : "no image yet";
        path.textContent = where;
        path.dataset.full = popup.savedRef?.path || where;
    };
    paint();
    // The `executed` event does not fire for a cached node, nor on reload, so the panel
    // would sit on a stale line until the next real run. Cheap enough to re-read.
    const tick = setInterval(paint, 1000);
    const offImage = popup.onImage(paint);

    const syncPrimary = () => star.classList.toggle("on", isPrimary(node.id));
    syncPrimary();

    node._nkdPanel = {
        destroy: () => { clearInterval(tick); offImage(); chip.destroy(); mounted.release(); },
    };
    requestAnimationFrame(() => mounted.resizeToContent());
    return { syncPrimary, refresh: paint };
}

function openViewer(node) {
    lastActiveId = String(node.id);
    const p = getPopup(String(node.id));
    p.setTitle(node.title || "Preview Window");
    p.open();
}

// ── CopyImage ────────────────────────────────────────────────────────────────

// The clipboard only accepts image/png, and a PiP / OS window must use ITS OWN navigator:
// the main window's clipboard rejects writes while another document has focus.
async function pngBlob(url) {
    const blob = await fetch(url).then(r => r.blob());
    if (blob.type === "image/png") return blob;
    const bmp = await createImageBitmap(blob);
    const c = Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
    c.getContext("2d").drawImage(bmp, 0, 0);
    return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error("png encode failed"))), "image/png"));
}

async function copyImageToClipboard(url, win = window) {
    if (!url) {
        app.extensionManager?.toast?.add?.({
            severity: "warn",
            summary: "No Image",
            detail: "Run the node first to generate an image.",
            life: 4000,
        });
        return;
    }
    try {
        // Promise inside ClipboardItem keeps the click's user gesture alive during the fetch.
        await win.navigator.clipboard.write([new win.ClipboardItem({ "image/png": pngBlob(url) })]);
        app.extensionManager?.toast?.add?.({
            severity: "success",
            summary: "Image Copied",
            detail: "Image copied to clipboard.",
            life: 3000,
        });
    } catch (err) {
        console.error("NKD copy image error:", err?.name, err?.message, err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Copy Failed",
            detail: "Could not copy image. Make sure the page has clipboard permissions.",
            life: 6000,
        });
    }
}

// ── Extension ────────────────────────────────────────────────────────────────

const popups = new Map();

function getPopup(nodeId) {
    const key = String(nodeId);
    if (!popups.has(key)) popups.set(key, new PopupWin(key));
    return popups.get(key);
}

// ── Queue single node ─────────────────────────────────────────────────────────

// Uses the frontend's native partial-execution path (added in 1.19.6) so the
// backend resolves the upstream subgraph itself. This preserves extra_data
// (including preview_method), which the previous monkey-patch approach dropped
// — that was why KSampler latent previews stopped firing under Shift+Q.
async function _queueNode(node) {
    try {
        // Partial execution (3rd arg) skips control_after_generate in ComfyUI, so a
        // randomize/increment seed never advances and the backend keeps returning the
        // cached image. Mirror a normal queue by firing the control callbacks on the
        // upstream subgraph ourselves: beforeQueued covers the "before" WidgetControlMode,
        // afterQueued the default "after" mode. ComfyUI's own partial-execution callbacks
        // (isPartialExecution:true) stay no-ops, so each widget advances exactly once.
        const upstream = collectUpstreamNodes(node);
        const fireControl = (hook) => {
            for (const n of upstream)
                for (const w of (n.widgets ?? []))
                    w[hook]?.({ isPartialExecution: false });
        };
        fireControl("beforeQueued");
        await app.queuePrompt(0, 1, [String(node.id)]);
        fireControl("afterQueued");
    } catch (err) {
        console.error("NKD queue node error:", err);
        app.extensionManager?.toast?.add?.({
            severity: "error",
            summary: "Queue Failed",
            detail: String(err),
            life: 6000,
        });
    }
}

app.registerExtension({
    name: "NKD.PopupPreview",

    commands: [
        {
            id: "NKD.PopupPreview.QueuePrimary",
            label: "NKD: Queue Primary Popup Node",
            icon: "pi pi-play",
            async function() {
                const node = resolvePrimaryNode();
                if (!node) return;
                await _queueNode(node);
            },
        },
        {
            id: "NKD.PopupPreview.OpenPrimary",
            label: "NKD: Open Primary Popup Viewer",
            icon: "pi pi-external-link",
            function() {
                const node = resolvePrimaryNode();
                if (!node) return;
                const p = getPopup(node.id);
                if (p.win && !p.win.closed) {
                    p.destroy();
                } else {
                    p.setTitle(node.title || "Preview Window");
                    p.open();
                }
            },
        },
    ],

    keybindings: [
        {
            commandId: "NKD.PopupPreview.OpenPrimary",
            combo: { key: "q", ctrl: false, alt: false, shift: false },
        },
        {
            commandId: "NKD.PopupPreview.QueuePrimary",
            combo: { key: "q", ctrl: false, alt: false, shift: true },
        },
    ],

    async setup() {
        // Q / Shift+Q come ONLY from the `keybindings` above. A second global keydown
        // listener here fired the same command twice, and since open() is async the
        // second call saw no window yet and opened a second panel.

        api.addEventListener("executed", ({ detail }) => {
            if (!detail?.output?.images?.length) return;
            const node = app.graph?.getNodeById(detail.node);
            if (!node || node.comfyClass !== NODE_TYPE) return;
            const popup = getPopup(node.id);
            // This node's own wired reference/mask (if any) win over the global slot.
            // Absent keys clear it, so unwiring the input reverts to the global reference.
            popup.wiredRef  = detail.output.nkd_ref?.[0]  || null;
            popup.wiredMask = detail.output.nkd_mask?.[0] || null;
            popup.setTitle(node.title || "Preview Window");
            popup._live(null);
            popup._runDone = true;   // later sampler frames of THIS run must not overwrite the result
            popup.showBatch(detail.output.images);
            lastActiveId = String(node.id);
            // Opt-in per node. PiP needs a user gesture, so on a bare run it falls back to the
            // floating panel (see _openViewer).
            if (node.widgets?.find(w => w.name === "open_on_run")?.value && !popup._isOpen()) openViewer(node);
        });

        // Sampling progress feeds the LIVE badge; an interrupted/failed run flags the low-res
        // frame it left behind so it is not mistaken for a result.
        api.addEventListener("progress", ({ detail }) => {
            if (!detail?.max) return;
            for (const p of popups.values())
                if (p._liveState === "live") p._live("live", `LIVE · ${detail.value}/${detail.max}`);
        });
        const flagCancelled = () => {
            for (const p of popups.values()) if (p._liveState === "live") p._live("cancelled");
        };
        api.addEventListener("execution_interrupted", flagCancelled);
        api.addEventListener("execution_error", flagCancelled);

        // A reference node may finish after the preview node in the same run, so
        // also refresh references once the whole prompt completes.
        api.addEventListener("execution_start", () => {
            for (const p of popups.values()) p._runDone = false;
        });
        api.addEventListener("execution_success", () => {
            for (const p of popups.values()) {
                // Run over but still showing a sampling frame (this node was cached, or its
                // result never arrived): put the last real image back instead of staying stuck.
                if (p._liveState === "live") {
                    p._live(null);
                    if (p.currentUrl) p._updateImage(p.currentUrl);
                }
            }
            for (const p of popups.values()) p.refreshRefs();
        });

        // b_preview_with_metadata is dispatched on the bundle's internal ComfyApi
        // instance, not the one exported by /scripts/api.js. Intercept via WebSocket.
        // The socket is created after setup(), so we wait for it.
        let attachedSocket = null;
        const attachWsPreview = () => {
            if (!api.socket || api.socket.readyState !== WebSocket.OPEN) return false;
            // Bind once per socket instance. ComfyUI swaps api.socket for a fresh
            // object on every reconnect, so the guard lets us re-bind to the new one.
            if (api.socket === attachedSocket) return true;
            attachedSocket = api.socket;
            api.socket.addEventListener("message", (e) => {
                if (!(e.data instanceof ArrayBuffer)) return;
                const view = new DataView(e.data);
                const msgType = view.getUint32(0);
                // Only preview-image events carry pixel data (1 = plain, 4 = metadata).
                if (msgType !== 1 && msgType !== 4) return;

                const bytes = new Uint8Array(e.data);

                // Locate the embedded image by its magic signature rather than
                // trusting a fixed header offset: this backend prepends preview
                // metadata (a length-prefixed node id) before the image, which a
                // fixed slice(8) would include and corrupt. Scanning for the magic
                // is robust across ComfyUI preview-format revisions.
                const findImageStart = (buf) => {
                    const limit = Math.min(buf.length - 4, 512);
                    for (let i = 0; i < limit; i++) {
                        // JPEG SOI: FF D8 FF
                        if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
                            return { offset: i, mime: "image/jpeg" };
                        }
                        // PNG: 89 50 4E 47
                        if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4e && buf[i + 3] === 0x47) {
                            return { offset: i, mime: "image/png" };
                        }
                    }
                    return null;
                };

                const found = findImageStart(bytes);
                if (!found) return;

                // The node id (if present) lives in the header that precedes the
                // image. Decode it as latin1 so we can match it against an
                // upstream sampler id for per-node filtering.
                const headerStr = found.offset > 8
                    ? String.fromCharCode.apply(null, bytes.subarray(8, found.offset))
                    : "";

                // Build a self-contained data: URL — works in any browsing context
                // (PiP/popup), unaffected by per-realm blob partitioning or CSP.
                const imgBytes = bytes.subarray(found.offset);
                let binary = "";
                const chunk = 0x8000;
                for (let i = 0; i < imgBytes.length; i += chunk) {
                    binary += String.fromCharCode.apply(null, imgBytes.subarray(i, i + chunk));
                }
                const dataUrl = `data:${found.mime};base64,${btoa(binary)}`;

                const openCount = [...popups.values()].filter(p => p._isOpen()).length;
                for (const popup of popups.values()) {
                    if (!popup._isOpen()) continue;
                    // Filter by upstream sampler when we can identify one and the
                    // header carries a node id; otherwise show the frame anyway
                    // (single generation at a time — no ambiguity in practice).
                    const nkdNode = app.graph?.getNodeById(Number(popup.nodeId));
                    if (nkdNode && headerStr) {
                        const sampler = findUpstreamSampler(nkdNode);
                        if (sampler && !headerStr.includes(String(sampler.id))) continue;
                        // No sampler to match against: with several popups open we cannot tell
                        // whose frame this is, so show it nowhere rather than everywhere.
                        if (!sampler && openCount > 1) continue;
                    }
                    if (popup._runDone) continue;
                    popup._setLiveFrame(dataUrl);
                }
            });
            return true;
        };

        if (!attachWsPreview()) {
            const poll = setInterval(() => { if (attachWsPreview()) clearInterval(poll); }, 300);
        }
        // On reconnect api.socket is replaced and our message listener dies with
        // the old socket — re-bind so live preview survives dropped connections.
        api.addEventListener("reconnected", () => attachWsPreview());
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            this.size = [MIN_PANEL_W, 120];

            // Legacy no-op: on the old frontend this suppressed the node's own thumbnail.
            // Current frontends render the preview from `app.nodeOutputs` instead, so it no
            // longer suppresses anything - and that preview is now the ONE we want, which is
            // why the panel below has no picture of its own.
            this.onExecuted = function () {};

            // Native filename_prefix / filename widgets, a per-node override of the global
            // project prefix (empty = use the global). Frontend-only widgets, NOT schema
            // inputs: the save runs entirely in the frontend, so there is no reason to feed
            // them to the backend and put them in the cache signature. They still serialise
            // into widgets_values and travel with the workflow. The DOM panel widget is
            // serialize:false, so these two are the only serialised widgets — positions stable.
            this.addWidget("text", "filename_prefix", "%project%/%category%/", () => {},
                { tooltip: "Folder for the saved still (tokens: %project% %category% %node% " +
                           "%date:yyyy-MM-dd%). Empty uses the active project's prefix." });
            this.addWidget("text", "filename", "NKD", () => {},
                { tooltip: "File name for the saved still. Empty keeps the prefix's own name." });

            this.addWidget("toggle", "open_on_run", false, () => {},
                { tooltip: "Open the viewer by itself when this node produces an image. " +
                           "Off by default: a window that appears on every run gets in the way." });

            const panel = buildNodePanel(this);

            // Let the node be dragged TALLER than the panel, so ComfyUI's own preview (drawn
            // above the panel from nodeOutputs) grows like a normal Preview Image. The DOM
            // host pins height to its content on every resize — right for the timeline's
            // canvas widget, wrong here — so re-wrap onResize to treat that content height as
            // a FLOOR and keep any larger height the user dragged to.
            const hostResize = this.onResize;
            this.onResize = function (size) {
                const wanted = size[1];              // the height the drag asked for
                hostResize?.apply(this, arguments);  // clamps width + pins height to content
                if (wanted > size[1]) size[1] = wanted;
            };

            // Keep the primary outline painted on each redraw (canvas / classic LiteGraph
            // only; V2 Vue uses node.color instead).
            const origDraw = this.onDrawForeground;
            this.onDrawForeground = function (ctx) {
                panel.syncPrimary();
                origDraw?.call(this, ctx);
                if (!isPrimary(this.id)) return;
                const w = this.size[0];
                const h = this.size[1];
                const titleH = (window.LiteGraph?.NODE_TITLE_HEIGHT) ?? 30;
                ctx.save();
                ctx.strokeStyle = PRIMARY_OUTLINE_COLOR;
                ctx.lineWidth   = PRIMARY_OUTLINE_WIDTH;
                ctx.setLineDash(PRIMARY_DASH);
                ctx.beginPath();
                ctx.roundRect(0, -titleH, w, h + titleH, 8);
                ctx.stroke();
                ctx.restore();
            };

            // Restore highlight if this node is the saved primary.
            if (isPrimary(this.id)) applyPrimaryStyle(this, true);
        };

        // Double-click the node body (not the title, not a widget row) to open the viewer.
        const origDbl = nodeType.prototype.onDblClick;
        nodeType.prototype.onDblClick = function (e, pos) {
            const r = origDbl?.apply(this, arguments);
            const onWidget = (this.widgets ?? []).some(w =>
                w.last_y != null && pos && pos[1] >= w.last_y && pos[1] <= w.last_y + (w.computedHeight ?? 24));
            if (pos && pos[1] > 0 && !onWidget) openViewer(this);
            return r;
        };

        const origTitleChanged = nodeType.prototype.onTitleChanged;
        nodeType.prototype.onTitleChanged = function (title) {
            origTitleChanged?.apply(this, arguments);
            popups.get(String(this.id))?.setTitle(title);
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            origRemoved?.apply(this, arguments);
            const key = String(this.id);
            // Clear primary if this node was the primary one.
            if (isPrimary(key)) setPrimary(null);
            this._nkdPanel?.destroy();
            popups.get(key)?.destroy();
            popups.delete(key);
        };
    },

    // Restore primary + load-target styles after graph load (IDs are stable now).
    afterConfigureGraph() {
        const p = adoptMark(NODE_TYPE, "nkdPrimary");
        primaryNodeId = p ? String(p.id) : null;
        if (p) { applyPrimaryStyle(p, true); p.setDirtyCanvas(true, true); }
        const t = adoptMark("LoadImage", "nkdLoadTarget");
        loadTargetId = t ? String(t.id) : null;
        if (t) { applyLoadTargetStyle(t, true); t.setDirtyCanvas(true, true); }
    },

    getNodeMenuItems(node) {
        if (node.comfyClass === "LoadImage") {
            return [{
                content: isLoadTarget(node.id) ? "◎ Unset NKD image target" : "◎ Set as NKD image target",
                callback: () => setLoadTarget(isLoadTarget(node.id) ? null : node.id),
            }];
        }
        if (node.comfyClass !== NODE_TYPE) return [];
        return [
            {
                content: "↗ Open Viewer",
                callback: () => openViewer(node),
            },
            {
                content: "⧉ Copy Image",
                callback: () => {
                    const p = getPopup(String(node.id));
                    p.ensureCurrent();
                    copyImageToClipboard(p.currentUrl);
                },
            },
            {
                content: "💾 Save to project",
                callback: () => void saveImage(getPopup(String(node.id)), node),
            },
            {
                content: "⤓ Download a copy",
                callback: () => downloadImage(getPopup(String(node.id))),
            },
            {
                content: isPrimary(node.id) ? "★ Unset Primary" : "☆ Set as Primary",
                callback: () => {
                    setPrimary(isPrimary(node.id) ? null : node.id);
                },
            },
        ];
    },
});


// ── NKDReferenceImage tint ──────────────────────────────────────────────────────
// Colour the Reference node by what's wired into its MultiType input, mirroring
// the Mask Painter's green-when-masked cue: IMAGE → blue, MASK → green. The type
// is read from the connected link and cached in _nkdRefKind so onDrawBackground
// can re-assert it cheaply (themes/other extensions overwrite node.color).
const _REF_TYPE      = "NKDReferenceImage";
const _REF_IMG_COLOR = "#1e3a5a", _REF_IMG_BG = "#0f1f30"; // blue  = image
const _REF_MSK_COLOR = "#1e3a1e", _REF_MSK_BG = "#0f1f0f"; // green = mask

function _refConnectedType(node) {
    const inp = node.inputs?.[0];
    if (!inp || inp.link == null) return null;
    const t = node.graph?.getLink(inp.link)?.type;
    return typeof t === "string" ? t.toUpperCase() : null;
}

function _applyRefColor(node) {
    const t = _refConnectedType(node);
    if (t === "MASK")       { node.color = _REF_MSK_COLOR; node.bgcolor = _REF_MSK_BG; node._nkdRefKind = "MASK"; }
    else if (t === "IMAGE") { node.color = _REF_IMG_COLOR; node.bgcolor = _REF_IMG_BG; node._nkdRefKind = "IMAGE"; }
    else                    { delete node.color; delete node.bgcolor; node._nkdRefKind = null; }
    node.setDirtyCanvas?.(true, false);
}

app.registerExtension({
    name: "NKD.ReferenceColor",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== _REF_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            _applyRefColor(this);
        };

        const origConn = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            origConn?.apply(this, arguments);
            _applyRefColor(this);
        };

        // Re-assert the cached tint on draw WITHOUT recomputing or dirtying the
        // canvas (that would loop) — same pattern as the Mask Painter.
        const origDrawBg = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx, canvas) {
            origDrawBg?.call(this, ctx, canvas);
            if (this._nkdRefKind === "MASK") {
                if (this.color   !== _REF_MSK_COLOR) this.color   = _REF_MSK_COLOR;
                if (this.bgcolor !== _REF_MSK_BG)    this.bgcolor = _REF_MSK_BG;
            } else if (this._nkdRefKind === "IMAGE") {
                if (this.color   !== _REF_IMG_COLOR) this.color   = _REF_IMG_COLOR;
                if (this.bgcolor !== _REF_IMG_BG)    this.bgcolor = _REF_IMG_BG;
            }
        };
    },

    // Colour nodes restored from a saved workflow (links are resolved by now).
    afterConfigureGraph() {
        for (const node of app.graph?._nodes ?? []) {
            if (node.comfyClass === _REF_TYPE) _applyRefColor(node);
        }
    },
});
