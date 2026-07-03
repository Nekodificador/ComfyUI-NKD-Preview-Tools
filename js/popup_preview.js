import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "NKDPopupPreviewNode";
const LS_PRIMARY = "nkd_primary_node_id";

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

function viewerHtmlUrl() {
    // Build the viewer URL relative to this script file:
    // import.meta.url = .../extensions/<pack>/js/popup_preview.js
    // viewer.html sits at  .../extensions/<pack>/js/viewer.html
    return new URL("viewer.html", import.meta.url).href;
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

// ── Primary node tracking ─────────────────────────────────────────────────────

// nodeId string of the current primary node, or null.
let primaryNodeId = localStorage.getItem(LS_PRIMARY) ?? null;

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

    if (primaryNodeId) {
        localStorage.setItem(LS_PRIMARY, primaryNodeId);
    } else {
        localStorage.removeItem(LS_PRIMARY);
    }

    // Redraw both affected nodes so their button labels and outline refresh.
    for (const id of new Set([prev, primaryNodeId])) {
        if (!id) continue;
        const node = app.graph?.getNodeById(Number(id));
        if (!node) continue;
        applyPrimaryStyle(node, isPrimary(id));
        node.setDirtyCanvas(true, true);
    }
}

function isPrimary(nodeId) {
    return String(nodeId) === primaryNodeId;
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
            const link = app.graph.links[input.link];
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
            const link = app.graph.links[input.link];
            if (!link) continue;
            const upstream = app.graph.getNodeById(link.origin_id);
            if (upstream && !visited.has(upstream.id)) queue.push(upstream);
        }
    }
    return out;
}

// ── PopupWin ──────────────────────────────────────────────────────────────────

// ── Viewer DOM factory ────────────────────────────────────────────────────────
// Builds the viewer UI as a DOM element in the host document (never in viewer.html).
// Based on bEpic Viewer's "move live DOM" pattern: the element is appended to the
// blank window's body — no fetch, no script re-injection needed.

const VIEWER_CSS = `
.nkd-viewer-root *,.nkd-viewer-root *::before,.nkd-viewer-root *::after{box-sizing:border-box;margin:0;padding:0}
.nkd-viewer-root{width:100%;height:100%;background:#080808;overflow:hidden;cursor:grab;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;position:relative;}
.nkd-viewer-root.panning{cursor:grabbing}
.nkd-vwrap{width:100%;height:100%;position:relative;overflow:hidden;background-color:#050505;background-image:linear-gradient(45deg,#101010 25%,transparent 25%),linear-gradient(-45deg,#101010 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#101010 75%),linear-gradient(-45deg,transparent 75%,#101010 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0;}
.nkd-vimg,.nkd-refimg{position:absolute;top:0;left:0;display:block;transform-origin:0 0;transition:opacity 0.15s;user-select:none;-webkit-user-drag:none;}
.nkd-refimg{display:none;z-index:1}
.nkd-viewer-root.holding-ref .nkd-vimg{visibility:hidden}
.nkd-viewer-root.holding-ref .nkd-refimg{display:block}
.nkd-ref-badge{position:absolute;top:14px;left:14px;background:rgba(180,32,48,0.92);color:#fff;font:bold 11px monospace;padding:4px 9px;border-radius:4px;pointer-events:none;display:none;z-index:5;letter-spacing:1px;backdrop-filter:blur(4px);}
.nkd-viewer-root.holding-ref .nkd-ref-badge{display:block}
.nkd-bar,.nkd-btn-close,.nkd-btn-hold{opacity:0;transition:opacity 0.25s;}
.nkd-viewer-root:hover .nkd-bar,.nkd-viewer-root:hover .nkd-btn-close,.nkd-viewer-root:hover .nkd-btn-hold{opacity:1}
.nkd-bar{position:absolute;bottom:18px;right:18px;display:flex;gap:8px;z-index:6;}
.nkd-btn-close{position:absolute;top:14px;right:14px;z-index:6;}
.nkd-btn-hold{position:absolute;bottom:18px;left:18px;z-index:6;user-select:none;background:rgba(40,28,32,0.92);border-color:rgba(255,180,180,0.18);}
.nkd-btn-hold:hover{background:rgba(72,40,48,0.96);color:#fff}
.nkd-btn-hold.active{background:rgba(180,32,48,0.95);color:#fff}
.nkd-vbtn{background:rgba(28,28,28,0.92);border:1px solid rgba(255,255,255,0.12);color:#ccc;padding:6px 15px;border-radius:6px;cursor:pointer;font-size:13px;backdrop-filter:blur(6px);transition:background 0.14s,color 0.14s;}
.nkd-vbtn:hover{background:rgba(72,72,72,0.96);color:#fff}
.nkd-btn-run{background:rgba(46,58,46,0.92);border-color:rgba(125,201,125,0.35);color:#9fe09f}
.nkd-btn-run:hover{background:rgba(60,84,60,0.96);color:#fff}
.nkd-dims{position:absolute;bottom:60px;left:18px;font:11px monospace;color:rgba(255,255,255,0.22);pointer-events:none;z-index:5;}
.nkd-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:rgba(255,255,255,0.18);pointer-events:none;}
.nkd-empty svg{width:64px;height:64px;}
.nkd-empty p{font:14px/1.4 monospace;margin:0;letter-spacing:0.02em;}
.nkd-empty.hidden{display:none;}
`;

function createViewerDOM(opts = {}) {
    const { refUrl = null, apiBase = null, onQueue = null } = opts;
    // imgMeta is mutable — caller can update via root._nkdSetMeta(meta)
    let imgMeta = opts.imgMeta || null;
    const compareMode = !!refUrl;

    // Inject CSS once into the host document.
    const styleId = "nkd-viewer-style";
    if (!document.getElementById(styleId)) {
        const st = document.createElement("style");
        st.id = styleId;
        st.textContent = VIEWER_CSS;
        document.head.appendChild(st);
    }

    const root = document.createElement("div");
    root.className = "nkd-viewer-root";
    root.style.cssText = "width:100%;height:100%;";

    root.innerHTML = `
        <div class="nkd-vwrap">
            <img class="nkd-vimg" alt="" draggable="false">
            <img class="nkd-refimg" alt="" draggable="false">
            <div class="nkd-empty">
                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <rect x="8" y="12" width="48" height="40" rx="4" stroke="currentColor" stroke-width="2.5"/>
                    <circle cx="22" cy="26" r="4" stroke="currentColor" stroke-width="2.5"/>
                    <path d="M8 42 L20 30 L30 40 L40 28 L56 44" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
                </svg>
                <p>Run the node to preview an image</p>
            </div>
        </div>
        <div class="nkd-ref-badge">REF</div>
        <button class="nkd-btn-close nkd-vbtn">&#x2715; Close</button>
        <button class="nkd-btn-hold nkd-vbtn" style="display:${compareMode ? '' : 'none'}">&#x21C4; Hold for Ref</button>
        <div class="nkd-dims"></div>
        <div class="nkd-bar">
            <button class="nkd-btn-run nkd-vbtn" style="display:${onQueue ? '' : 'none'}">&#x25B6; Run</button>
            <button class="nkd-btn-fit nkd-vbtn">&#x26F6; Fit Image</button>
            <button class="nkd-btn-100 nkd-vbtn">1:1 Pixel</button>
            <button class="nkd-btn-adj nkd-vbtn">&#x2921; Fit Window</button>
            <button class="nkd-btn-save nkd-vbtn">&#x1F4BE; Save</button>
        </div>`;

    const wrap    = root.querySelector(".nkd-vwrap");
    const img     = root.querySelector(".nkd-vimg");
    const refImg  = root.querySelector(".nkd-refimg");
    const empty   = root.querySelector(".nkd-empty");
    const dims    = root.querySelector(".nkd-dims");
    const btnHold = root.querySelector(".nkd-btn-hold");

    let scale = 1, tx = 0, ty = 0, fitScale = 1;
    let panning = false, sx = 0, sy = 0, stx = 0, sty = 0;

    function apply() {
        const rendering = scale > 1.0 ? "pixelated" : "auto";
        img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
        img.style.imageRendering = rendering;
        if (compareMode) applyRefTransform(rendering);
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
        fitScale = Math.min(ww / nw, wh / nh);
        scale = fitScale;
        tx = (ww - nw * fitScale) / 2;
        ty = (wh - nh * fitScale) / 2;
        apply();
        dims.textContent = `${nw} × ${nh} px`;
    }

    root._nkdFit = fit;
    root._nkdSetMeta = (meta) => { imgMeta = meta; };

    img.addEventListener("load", () => {
        fit();
        img.style.opacity = "1";
        empty.classList.add("hidden");
    });

    if (compareMode) {
        refImg.src = refUrl;
        refImg.addEventListener("load", apply);

        let holding = false;
        const showRef = () => { if (holding) return; holding = true; root.classList.add("holding-ref"); btnHold.classList.add("active"); };
        const showCur = () => { if (!holding) return; holding = false; root.classList.remove("holding-ref"); btnHold.classList.remove("active"); };
        btnHold.addEventListener("mousedown", e => { e.preventDefault(); showRef(); });
        root.addEventListener("mouseup", showCur);
        root.addEventListener("blur", showCur);
        document.addEventListener("keydown", e => {
            if (e.code !== "Space" || e.repeat) return;
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            e.preventDefault(); showRef();
        });
        document.addEventListener("keyup", e => { if (e.code === "Space") { e.preventDefault(); showCur(); } });
    }

    // Fit Window button — resizes the panel (floating mode) or the OS window (popup mode)
    root.querySelector(".nkd-btn-adj").addEventListener("click", () => {
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

    if (onQueue) root.querySelector(".nkd-btn-run").addEventListener("click", () => onQueue());

    root.querySelector(".nkd-btn-fit").addEventListener("click", fit);
    root.querySelector(".nkd-btn-100").addEventListener("click", () => {
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
        tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = 1.0; apply();
    });

    // Save — use api.apiURL which always resolves correctly in any context
    root.querySelector(".nkd-btn-save").addEventListener("click", () => {
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
    });

    // Pan & zoom
    wrap.addEventListener("wheel", e => {
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const ns = Math.max(fitScale * 0.1, Math.min(scale * factor, fitScale * 32));
        const r = ns / scale;
        tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = ns; apply();
    }, { passive: false });

    wrap.addEventListener("mousedown", e => {
        if (e.button !== 0) return;
        panning = true; sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
        root.classList.add("panning");
    });
    document.addEventListener("mousemove", e => {
        if (!panning) return;
        tx = stx + (e.clientX - sx); ty = sty + (e.clientY - sy); apply();
    });
    document.addEventListener("mouseup", () => { panning = false; root.classList.remove("panning"); });
    wrap.addEventListener("dblclick", e => {
        const rect = wrap.getBoundingClientRect();
        if (Math.abs(scale - 1.0) < 0.001) fit();
        else {
            const ns = 1.0, r = ns / scale;
            tx = (e.clientX - rect.left) - (e.clientX - rect.left - tx) * r;
            ty = (e.clientY - rect.top)  - (e.clientY - rect.top  - ty) * r;
            scale = ns; apply();
        }
    });

    window.addEventListener("resize", fit);

    // Keyboard
    document.addEventListener("keydown", e => {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (e.key === "Escape") root.querySelector(".nkd-btn-close").click();
        if (e.key === "0" || e.key === "r") fit();
        if (e.key === "1") root.querySelector(".nkd-btn-100").click();
        if (e.key === "s" || e.key === "S") root.querySelector(".nkd-btn-save").click();
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
        this._container         = null;  // live DOM element (bEpic pattern)
        this._livePreviewHandler = null; // b_preview_with_metadata listener
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

    /** Called on node execution: update existing window or open a new one. */
    showImage(imgData) {
        this.currentUrl  = buildViewUrl(imgData);
        this.currentMeta = {
            filename:  imgData.filename,
            type:      imgData.type,
            subfolder: imgData.subfolder ?? "",
        };
        // Only update if already open; never auto-open on execution.
        if (this.win && !this.win.closed) {
            // Update meta in the live DOM container (blank-window mode).
            if (this._container?._nkdSetMeta) this._container._nkdSetMeta(this.currentMeta);
            this._updateImage(this.currentUrl);
            this._pushMeta();
        }
    }

    /** Called from node button / context menu. Picks up any active reference
     * image automatically so press-and-hold compare is available in the viewer. */
    async open() {
        if (this.win && !this.win.closed) {
            // PiP windows are always on top; regular windows need a focus call.
            if (!this._pipMode) this.win.focus();
            return;
        }
        this._refUrl = await getReferenceUrl();
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

        const { winW, winH } = await this._calcWindowSize();

        // ── Panel shell ────────────────────────────────────────────────────────
        const panel = document.createElement("div");
        this._panel = panel;
        const TITLEBAR_H = 32;

        Object.assign(panel.style, {
            position: "fixed",
            width: winW + "px",
            height: (winH + TITLEBAR_H) + "px",
            left: Math.round((window.innerWidth  - winW) / 2) + "px",
            top:  Math.round((window.innerHeight - winH - TITLEBAR_H) / 2) + "px",
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
                    container._nkdFit?.();
                };
                r.addEventListener("pointermove", onMove);
                r.addEventListener("pointerup",   onUp);
            });
        }

        // ── Viewer DOM (pan/zoom/save/etc.) ───────────────────────────────────
        const container = createViewerDOM({
            refUrl:  this._refUrl,
            imgMeta: this.currentMeta,
            apiBase: location.origin,
            onQueue: () => this._queueOwnNode(),
        });
        container.style.cssText = "width:100%;height:100%;";
        // Hide the viewer's own close button — the panel titlebar has one.
        const viewerClose = container.querySelector(".nkd-btn-close");
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
        const imgEl = container.querySelector(".nkd-vimg");
        if (imgEl && this.currentUrl) { imgEl.style.opacity = "0.4"; imgEl.src = this.currentUrl; }

        this._container = container;
        this._startLivePreview();

        // ── Close ──────────────────────────────────────────────────────────────
        const closePanel = () => {
            this._stopLivePreview();
            panel.remove();
            this._panel     = null;
            this._container = null;
            if (this.win) { this.win.closed = true; this.win = null; }
        };
        closeBtn.addEventListener("click", closePanel);
        container.querySelector(".nkd-btn-close").addEventListener("click", closePanel);

        // ── Drag ───────────────────────────────────────────────────────────────
        let dragging = false, dragX = 0, dragY = 0;
        titlebar.addEventListener("mousedown", e => {
            if (e.target === closeBtn) return;
            dragging = true;
            dragX = e.clientX - panel.offsetLeft;
            dragY = e.clientY - panel.offsetTop;
            titlebar.style.cursor = "grabbing";
            e.preventDefault();
        });
        window.addEventListener("mousemove", e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - dragX) + "px";
            panel.style.top  = (e.clientY - dragY) + "px";
        });
        window.addEventListener("mouseup", () => { dragging = false; titlebar.style.cursor = "grab"; });

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
            document: { getElementById: (id) => id === "img" ? imgEl : null },
        };
    }

    async _calcWindowSize() {
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

    /** Primary path (Chrome 116+): open viewer.html directly inside a PiP window. */
    async _openDirectPiP() {
        const { winW, winH } = await this._calcWindowSize();

        const pipWin = await window.documentPictureInPicture.requestWindow({ width: winW, height: winH });

        // Register cleanup immediately so the window is tracked from the start.
        this.win      = pipWin;
        this._pipMode = true;
        pipWin.addEventListener("pagehide", () => {
            this._stopLivePreview();
            this.win      = null;
            this._pipMode = false;
        });

        try {
            // Fetch viewer.html and inject it into the blank PiP document.
            const html   = await fetch(viewerHtmlUrl()).then(r => r.text());
            const parser = new DOMParser();
            const parsed = parser.parseFromString(html, "text/html");

            // Inject <style> blocks into PiP <head>.
            parsed.querySelectorAll("style").forEach(s => {
                const ns = pipWin.document.createElement("style");
                ns.textContent = s.textContent;
                pipWin.document.head.appendChild(ns);
            });

            // Inject body markup without scripts (innerHTML doesn't execute them).
            const bodyClone = parsed.body.cloneNode(true);
            bodyClone.querySelectorAll("script").forEach(s => s.remove());
            pipWin.document.body.innerHTML = bodyClone.innerHTML;

            // Hand off the compare-mode reference URL BEFORE running the
            // viewer script — it reads window.__nkd_ref_url at IIFE time.
            if (this._refUrl) {
                pipWin.__nkd_ref_url = this._refUrl;
            }
            // Hand off image metadata for the save panel.
            if (this.currentMeta) {
                pipWin.__nkd_img_meta = this.currentMeta;
            }
            // Bridge Run button / Shift+Q back to the main realm: queue THIS
            // window's node (the PiP document can't reach app/api on its own).
            pipWin.__nkd_queue = () => this._queueOwnNode();

            // Execute scripts in the PiP window's context by appending new elements.
            parsed.querySelectorAll("script").forEach(s => {
                const ns = pipWin.document.createElement("script");
                ns.textContent = s.textContent;
                pipWin.document.body.appendChild(ns);
                // Each script runs synchronously when appended; the IIFE in
                // viewer.html executes here and binds events to pipWin.document.
            });

            // Set title and seed the initial image (location.search is empty in PiP).
            pipWin.document.title = this._title;
            const pipImg = pipWin.document.getElementById("img");
            if (pipImg && this.currentUrl) {
                pipImg.style.opacity = "0.4";
                pipImg.src = this.currentUrl;
            }
            this._startLivePreview();
        } catch (err) {
            console.error("NKD PiP viewer load error:", err);
            pipWin.close();
        }
    }

    /** Fallback (no PiP support): open viewer.html in a regular popup window. */
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

        const qpInit = { img: this.currentUrl ?? "", title: this._title };
        if (this._refUrl) {
            qpInit.ref     = this._refUrl;
            qpInit.compare = "1";
        }
        if (this.currentMeta) {
            qpInit.meta_filename  = this.currentMeta.filename;
            qpInit.meta_type      = this.currentMeta.type;
            qpInit.meta_subfolder = this.currentMeta.subfolder;
        }
        const qp  = new URLSearchParams(qpInit);
        const url = `${viewerHtmlUrl()}?${qp}`;

        this.win      = window.open(url, `nkd_preview_${this.nodeId}`, opts);
        this._pipMode = false;

        if (!this.win) {
            app.extensionManager?.toast?.add?.({
                severity: "warn",
                summary: "Popup Blocked",
                detail: "Please allow popups for this site and click 'Open Viewer' on the node.",
                life: 7000,
            });
            return;
        }

        // Same bridge as the PiP path (see _openDirectPiP): the popup runs in a
        // separate realm, so wire its Run button / Shift+Q back to queue our node.
        this.win.addEventListener("load", () => {
            try { this.win.__nkd_queue = () => this._queueOwnNode(); } catch { /* cross-origin */ }
        });

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

        this.win.addEventListener("beforeunload", () => {
            saveState();
            clearInterval(saveInterval);
            this.win = null;
        });
    }

    _pushMeta() {
        // In blank-window mode metadata is captured in the closure of createViewerDOM;
        // for PiP/regular-window mode update the window global.
        if (!this._container && this.win && !this.win.closed) {
            try { this.win.__nkd_img_meta = this.currentMeta; } catch { /* cross-origin */ }
        }
    }

    _updateImage(url) {
        try {
            const img = this._container
                ? this._container.querySelector(".nkd-vimg")
                : this.win.document.getElementById("img");
            if (!img) { this._openViewer(); return; }
            img.src = url;
        } catch {
            this.win        = null;
            this._pipMode   = false;
            this._container = null;
            this._openViewer();
        }
    }

    // ── Live preview (TAESD frames) ───────────────────────────────────────────

    _isOpen() {
        return (this._panel && document.body.contains(this._panel))
            || (this.win && !this.win.closed);
    }

    _setLiveFrame(dataUrl) {
        // dataUrl is a self-contained data: URL (works in any realm, no CSP
        // blob: dependency, no revocation needed).
        let img = null;
        if (this._container) {
            img = this._container.querySelector(".nkd-vimg");
        } else if (this.win && !this.win.closed) {
            try { img = this.win.document.getElementById("img"); } catch { return; }
        }
        if (!img) return;

        img.src = dataUrl;
        img.style.opacity = "1";
        const doc = img.ownerDocument;
        const emptyState = doc?.getElementById("empty-state");
        if (emptyState) emptyState.classList.add("hidden");
    }

    _startLivePreview() { /* handled globally in setup() via WebSocket intercept */ }
    _stopLivePreview()  { /* no-op — global listener in setup() manages all popups */ }

    destroy() {
        this._stopLivePreview();
        if (this.win && !this.win.closed) this.win.close();
        try { this._container?.remove(); } catch { /* ignore */ }
        this._container = null;
    }
}

// ── SaveImage ─────────────────────────────────────────────────────────────────

function saveImage(popup) {
    if (!popup?.currentMeta) {
        app.extensionManager?.toast?.add?.({
            severity: "warn",
            summary: "No Image",
            detail: "Run the node first to generate an image.",
            life: 4000,
        });
        return;
    }
    const { filename, type, subfolder } = popup.currentMeta;
    const p = new URLSearchParams({ filename, type, subfolder: subfolder ?? "" });
    const url = api.apiURL(`/view?${p}`);
    const a = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
}

// ── CopyImage ────────────────────────────────────────────────────────────────

async function copyImageToClipboard(url) {
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
        const blob = await fetch(url).then(r => r.blob());
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        app.extensionManager?.toast?.add?.({
            severity: "success",
            summary: "Image Copied",
            detail: "Image copied to clipboard.",
            life: 3000,
        });
    } catch (err) {
        console.error("NKD copy image error:", err);
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
                if (!primaryNodeId) {
                    app.extensionManager?.toast?.add?.({
                        severity: "warn",
                        summary: "No Primary Node",
                        detail: "Mark a Popup Preview node as primary first.",
                        life: 5000,
                    });
                    return;
                }
                const node = app.graph?.getNodeById(Number(primaryNodeId));
                if (!node) {
                    app.extensionManager?.toast?.add?.({
                        severity: "warn",
                        summary: "Primary Node Not Found",
                        detail: "The primary node no longer exists in the graph.",
                        life: 5000,
                    });
                    setPrimary(null);
                    return;
                }
                await _queueNode(node);
            },
        },
        {
            id: "NKD.PopupPreview.OpenPrimary",
            label: "NKD: Open Primary Popup Viewer",
            icon: "pi pi-external-link",
            function() {
                if (!primaryNodeId) {
                    app.extensionManager?.toast?.add?.({
                        severity: "warn",
                        summary: "No Primary Node",
                        detail: "Mark a Popup Preview node as primary first.",
                        life: 5000,
                    });
                    return;
                }
                const node = app.graph?.getNodeById(Number(primaryNodeId));
                if (!node) {
                    app.extensionManager?.toast?.add?.({
                        severity: "warn",
                        summary: "Primary Node Not Found",
                        detail: "The primary node no longer exists in the graph.",
                        life: 5000,
                    });
                    setPrimary(null);
                    return;
                }
                const p = getPopup(primaryNodeId);
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
        // Global keydown so shortcuts work regardless of where focus is.
        document.addEventListener("keydown", (e) => {
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.key !== "q" && e.key !== "Q") return;
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
            if (e.shiftKey) {
                e.preventDefault();
                app.extensionManager?.command?.execute?.("NKD.PopupPreview.QueuePrimary");
            } else {
                e.preventDefault();
                app.extensionManager?.command?.execute?.("NKD.PopupPreview.OpenPrimary");
            }
        });

        api.addEventListener("executed", ({ detail }) => {
            if (!detail?.output?.images?.length) return;
            const node = app.graph?.getNodeById(detail.node);
            if (!node || node.comfyClass !== NODE_TYPE) return;
            const popup = getPopup(node.id);
            popup.setTitle(node.title || "Preview Window");
            popup.showImage(detail.output.images[0]);
        });

        // b_preview_with_metadata is dispatched on the bundle's internal ComfyApi
        // instance, not the one exported by /scripts/api.js. Intercept via WebSocket.
        // The socket is created after setup(), so we wait for it.
        const attachWsPreview = () => {
            if (!api.socket || api.socket.readyState !== WebSocket.OPEN) return false;
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

                for (const popup of popups.values()) {
                    if (!popup._isOpen()) continue;
                    // Filter by upstream sampler when we can identify one and the
                    // header carries a node id; otherwise show the frame anyway
                    // (single generation at a time — no ambiguity in practice).
                    const nkdNode = app.graph?.getNodeById(Number(popup.nodeId));
                    if (nkdNode && headerStr) {
                        const sampler = findUpstreamSampler(nkdNode);
                        if (sampler && !headerStr.includes(String(sampler.id))) continue;
                    }
                    popup._setLiveFrame(dataUrl);
                }
            });
            return true;
        };

        if (!attachWsPreview()) {
            const poll = setInterval(() => { if (attachWsPreview()) clearInterval(poll); }, 300);
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);
            this.size = [210, 172];

            // Suppress the default node thumbnail.
            this.onExecuted = function () {};

            this.addWidget("button", "↗ Open Viewer", null, () => {
                const p = getPopup(String(this.id));
                p.setTitle(this.title || "Preview Window");
                p.open();
            }, { serialize: false });

            this.addWidget("button", "⧉ Copy Image", null, () => {
                const p = getPopup(String(this.id));
                copyImageToClipboard(p.currentUrl);
            }, { serialize: false });

            this.addWidget("button", "💾 Save Image", null, () => {
                saveImage(getPopup(String(this.id)));
            }, { serialize: false });

            // Primary toggle button — label reflects state with filled/empty star.
            const primaryWidget = this.addWidget("button", _primaryLabel(this.id), null, () => {
                if (isPrimary(this.id)) {
                    setPrimary(null);
                } else {
                    setPrimary(this.id);
                }
                _setWidgetLabel(primaryWidget, _primaryLabel(this.id));
                this.graph?.setDirtyCanvas(true, true);
            }, { serialize: false });

            // Keep label in sync and paint primary outline on each redraw
            // (canvas / classic LiteGraph only; V2 Vue uses node.color instead).
            const origDraw = this.onDrawForeground;
            this.onDrawForeground = function (ctx) {
                _setWidgetLabel(primaryWidget, _primaryLabel(this.id));
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
            popups.get(key)?.destroy();
            popups.delete(key);
        };
    },

    // Restore primary state after graph load (node IDs are now stable).
    afterConfigureGraph() {
        if (!primaryNodeId) return;
        const node = app.graph?.getNodeById(Number(primaryNodeId));
        if (!node || node.comfyClass !== NODE_TYPE) {
            // Saved ID no longer maps to a valid popup node — clear it.
            setPrimary(null);
        } else {
            applyPrimaryStyle(node, true);
            node.setDirtyCanvas(true, true);
        }
    },

    getNodeMenuItems(node) {
        if (node.comfyClass !== NODE_TYPE) return [];
        return [
            {
                content: "↗ Open Viewer",
                callback: () => {
                    const p = getPopup(String(node.id));
                    p.setTitle(node.title || "Preview Window");
                    p.open();
                },
            },
            {
                content: "⧉ Copy Image",
                callback: () => {
                    const p = getPopup(String(node.id));
                    copyImageToClipboard(p.currentUrl);
                },
            },
            {
                content: "💾 Save Image",
                callback: () => saveImage(getPopup(String(node.id))),
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

function _primaryLabel(nodeId) {
    return isPrimary(nodeId) ? "★ Primary" : "☆ Set as Primary";
}

// V2 renderer reads widget.displayName, which is `label || name`. Setting only
// `name` is invisible if `label` was ever assigned. Always set both.
function _setWidgetLabel(widget, text) {
    if (!widget) return;
    widget.label = text;
    widget.name  = text;
}
