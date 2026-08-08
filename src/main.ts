/**
 * NKD Timeline - extension registration and the bridge to ComfyUI.
 *
 * The hidden STRING widget `timeline` is the ONLY source of truth: it serialises with the
 * workflow and reaches Python untouched. The DOM widget is just a view (`serialize:false`).
 * Same pattern as the rest of the NKD ecosystem.
 */
import { app as comfyApp } from "./comfyRuntime";
import {
  type FitMode, type ImportMode, type QuantizeMode, type Timeline,
  parseTimeline, quantizeCount, quantizeGrid, serialiseTimeline, slotInUse,
} from "./timeline/model";
import {
  PREVIEW_MAX_H, TimelineEditor, type KeyAction, type TimelineHost,
} from "./timeline/editor";
import {
  type MediaInfo, type MediaRef,
  audioBufferFor, bustCaches, cachedInfo, ensureAudio, forget, probe, releaseUnused,
  resolveSource, slotKind,
} from "./timeline/media";
import { ensureStyles } from "./timeline/styles";

const NODE_NAME = "NKDTimeline";
const EXT_NAME = "NKD.PreviewTools.Timeline";
const MIN_W = 380;
const SLOT_RE = /(?:^|\.)(media_\d+)$/;
// An IMAGE/MASK input is a tensor from another node, so its length cannot be known
// until the graph runs - there is no file to probe. Place it at a workable default
// and let the user trim; the execute-time metadata push will fill this in properly.
const TENSOR_DEFAULT_FRAMES = 24;

/**
 * Rebindable shortcuts, surfaced in ComfyUI's own Settings dialog.
 *
 * Only the ones that genuinely differ between editors: Premiere puts trim-to-playhead on
 * Q/W, Resolve elsewhere. The transport (Space, J/K/L) is the same everywhere, so it stays
 * fixed rather than adding settings nobody will touch.
 */
const KEY_SETTINGS: { action: KeyAction; id: string; label: string; def: string }[] = [
  { action: "trimHead", id: "NKD.Timeline.Key.TrimHead",
    label: "Trim head to playhead", def: "q" },
  { action: "trimTail", id: "NKD.Timeline.Key.TrimTail",
    label: "Trim tail to playhead", def: "e" },
  { action: "markIn", id: "NKD.Timeline.Key.MarkIn", label: "Mark in", def: "i" },
  { action: "markOut", id: "NKD.Timeline.Key.MarkOut", label: "Mark out", def: "o" },
  { action: "markClip", id: "NKD.Timeline.Key.MarkClip",
    label: "Mark clip (fit in/out to the clip)", def: "x" },
  { action: "zoomFit", id: "NKD.Timeline.Key.ZoomFit", label: "Fit timeline", def: "f" },
];
const KEY_SETTING_BY_ACTION = new Map(KEY_SETTINGS.map((k) => [k.action, k.id]));

/** Read a setting, tolerating frontends that predate the settings API. */
function readSetting(id: string, fallback: string): string {
  try {
    const v = (comfyApp as any).extensionManager?.setting?.get?.(id);
    return typeof v === "string" && v.length ? v.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}
// The canvas renderer reserves the widget row a few px short (rounding), which shows up
// as a clipped bottom edge that varies with the aspect ratio.
const ROW_SAFETY = 8;
const MAX_INSET = 48;

// A console version stamp: a cached bundle is the number one confounder when debugging
// frontend behaviour that "should" already be fixed.
console.log("[NKD Timeline] rev 3.0.0");

// ── Widget helpers ────────────────────────────────────────────────────────────

const findW = (node: any, name: string) =>
  node.widgets?.find((w: any) => w.name === name);

/**
 * Hide a tracking widget in BOTH renderers.
 *
 * Deliberately does NOT set `type = "hidden"`: that stops the value from serialising, and
 * `timeline` is exactly the value that must survive a save. `hidden = true` hides it in
 * both renderers AND still serialises.
 */
function hideWidget(w: any): void {
  if (!w) return;
  w.hidden = true;                          // canvas (1.0) and Vue (2.0)
  if (w.options) w.options.hidden = true;   // Vue layout reads it here
  w.computeSize = () => [0, -4];            // collapse the row on canvas
  w.draw = () => {};
  // Belt and braces for stale cached defs that still declare it multiline.
  if (w.element?.style) w.element.style.display = "none";
}

/**
 * Works around the DOM-widget WIDTH bug in the classic renderer: on selection or
 * re-layout, ComfyUI mis-sizes the host `div.dom-widget` - it either balloons to the graph
 * canvas width or collapses to about half - while `node.size[0]` stays correct. Vue mode
 * is fine. So detect "broken" from the PARENT host width (independent of whatever width we
 * force, hence no oscillation) and pin back to `node.size[0]` minus a self-calibrated
 * inset. The 250 ms poll matters: the ResizeObserver does NOT fire when ComfyUI re-lays
 * out the host, which is precisely when it breaks.
 */
function keepDomWidgetSized(node: any, container: HTMLElement): () => void {
  const MAX_MARGIN = 40;
  let enforcing = false;
  let goodMargin = 15;
  const vueMode = () => !!(window as any).LiteGraph?.vueNodesMode;
  const clamp = () => {
    if (enforcing) return;
    // Vue Nodes ignores computeSize for the minimum width and reads the element's inline
    // min-width instead, so it has to be set on the node element itself.
    if (vueMode()) {
      if (container.style.width) container.style.width = "";
      const el = document.querySelector(`[data-node-id="${node.id}"]`) as HTMLElement | null;
      if (el && el.style.minWidth !== `${MIN_W}px`) el.style.minWidth = `${MIN_W}px`;
      return;
    }
    const nodeW = node.size?.[0];
    if (!nodeW) return;
    const hostW = container.parentElement?.clientWidth ?? 0;
    const broken = hostW > 0 && (hostW > nodeW * 1.2 || hostW < nodeW * 0.7);
    if (!broken) {
      if (container.style.width) {
        enforcing = true;
        container.style.width = "";
        requestAnimationFrame(() => { enforcing = false; });
      }
      const cw = container.clientWidth;
      if (cw > 0 && cw <= nodeW && cw >= nodeW - MAX_MARGIN) goodMargin = nodeW - cw;
      return;
    }
    const ref = Math.round(nodeW - goodMargin);
    if (ref > 0 && Math.abs(container.clientWidth - ref) > 2) {
      enforcing = true;
      container.style.boxSizing = "border-box";
      container.style.width = `${ref}px`;
      requestAnimationFrame(() => { enforcing = false; });
    }
  };
  clamp();
  const ro = new ResizeObserver(clamp);
  ro.observe(container);
  const origResize = node.onResize;
  node.onResize = function (this: any, ...args: any[]) {
    origResize?.apply(this, args);
    clamp();
  };
  const iv = window.setInterval(clamp, 250);
  return () => { ro.disconnect(); clearInterval(iv); };
}

// ── Host: everything the editor needs to know about the node ──────────────────

type SourceEntry = { ref: MediaRef; info: MediaInfo | null; label: string };
type Host = TimelineHost & {
  clearSourceCache: () => void;
  peekSource: (src: string) => SourceEntry | undefined;
  dropSource: (src: string) => void;
};

function makeHost(node: any, state: { tl: Timeline }): Host {
  const numW = (name: string, def: number) => {
    const v = Number(findW(node, name)?.value);
    return Number.isFinite(v) ? v : def;
  };
  const setW = (name: string, value: unknown) => {
    const w = findW(node, name);
    if (!w || w.value === value) return;
    w.value = value;
    w.callback?.(value);   // the only hook BOTH renderers fire
  };

  const srcCache = new Map<string, SourceEntry>();

  const host: Host = {
    getTimeline: () => state.tl,
    commit() {
      const w = findW(node, "timeline");
      if (w) w.value = serialiseTimeline(state.tl);
      node.setDirtyCanvas(true, true);
    },
    getFps: () => numW("fps", 24),
    getStartFrame: () => Math.max(0, Math.round(numW("start_frame", 0))),
    setStartFrame: (v) => setW("start_frame", Math.max(0, Math.round(v))),
    getFrameCount: () => Math.max(0, Math.round(numW("frame_count", 0))),
    setFrameCount: (v) => setW("frame_count", Math.max(0, Math.round(v))),
    getQuantize: () => (findW(node, "quantize")?.value ?? "free") as QuantizeMode,
    getQuantizeN: () => Math.max(1, Math.round(numW("quantize_n", 8))),
    getFit: () => (findW(node, "fit")?.value ?? "contain") as FitMode,
    getImportMode: () => (findW(node, "import_mode")?.value ?? "stack") as ImportMode,
    getKey: (action, fallback) =>
      readSetting(KEY_SETTING_BY_ACTION.get(action) ?? "", fallback),
    srcFramesFor(src: string) {
      const info = host.sourceFor(src)?.info;
      if (info?.frame_count) return info.frame_count;
      const ref = srcCache.get(src)?.ref;
      const buf = ref && audioBufferFor(ref);
      // Audio has no frame count of its own: its length is its duration at timeline rate.
      return buf ? Math.round(buf.duration * host.getFps()) : null;
    },
    reloadSources() {
      bustCaches();
      srcCache.clear();
      node.setDirtyCanvas(true, true);
    },
    notify(summary, detail, severity = "info") {
      (comfyApp as any).extensionManager?.toast?.add?.({
        severity, summary, detail, life: 8000,
      });
    },
    getOutSize(): [number, number] {
      const w = Math.round(numW("width", 0));
      const h = Math.round(numW("height", 0));
      if (w > 0 && h > 0) return [w, h];
      const first = state.tl.clips[0];
      const info = first ? srcCache.get(first.src)?.info : null;
      return info ? [info.width, info.height] : [16, 9];
    },
    sourceFor(src: string) {
      const hit = srcCache.get(src);
      if (hit) {
        if (!hit.info) hit.info = cachedInfo(hit.ref) ?? null;
        return hit;
      }
      const ref = resolveSource(node, src);
      if (!ref) return null;
      const entry: SourceEntry = { ref, info: cachedInfo(ref) ?? null, label: ref.filename };
      srcCache.set(src, entry);
      if (!entry.info) {
        void probe(ref).then((info) => {
          entry.info = info;
          node.setDirtyCanvas(true, true);
        });
      }
      return entry;
    },
    connectedSlots() {
      // One socket type for everything, so the kind comes from what is plugged in.
      const out: Record<string, string[]> =
        { video: [], image: [], mask: [], audio: [] };
      for (const inp of node.inputs ?? []) {
        const m = SLOT_RE.exec(inp.name ?? "");
        if (!m || inp.link == null) continue;
        const kind = slotKind(node, m[1]);
        if (kind) out[kind].push(m[1]);
      }
      return {
        videos: out.video, images: out.image, masks: out.mask, audios: out.audio,
      };
    },
    conformToFirstClip(from?: MediaInfo) {
      const first = state.tl.clips[0];
      const info = from ?? (first ? host.sourceFor(first.src)?.info : null);
      if (!info) return;
      setW("fps", Number(info.fps.toFixed(3)));
      setW("width", info.width);
      setW("height", info.height);
      node.setDirtyCanvas(true, true);
    },
    clearSourceCache: () => srcCache.clear(),
    /** Read the cache WITHOUT resolving, so the swap detector can compare against it. */
    peekSource: (src: string) => srcCache.get(src),
    dropSource: (src: string) => { srcCache.delete(src); },
  };
  return host;
}

// ── Registration ──────────────────────────────────────────────────────────────

comfyApp.registerExtension({
  name: EXT_NAME,
  // Surfaced in ComfyUI's own Settings dialog under "NKD Timeline", so the shortcuts are
  // discoverable and rebindable in the place users already look for them.
  settings: KEY_SETTINGS.map((k) => ({
    id: k.id,
    name: k.label,
    type: "text",
    defaultValue: k.def,
    category: ["NKD Timeline", "Shortcuts", k.label],
    tooltip: `Single key, lower-case. Default: ${k.def}`,
  })),
  async beforeRegisterNodeDef(nodeType: any, nodeData: any) {
    if (nodeData?.name !== NODE_NAME) return;
    // Without this guard, "Refresh node definitions" re-runs the hook on the SAME
    // prototype and the wraps stack up: 2^n mounted widgets, and the orphans keep
    // rendering forever as frozen ghosts.
    if (nodeType.prototype.__nkdTimelineWrapped) return;
    nodeType.prototype.__nkdTimelineWrapped = true;

    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (this: any) {
      const result = origCreated?.apply(this, arguments as any);
      ensureStyles();
      const node = this;

      const dataW = findW(node, "timeline");
      hideWidget(dataW);
      // socketless is not honoured by the V3 frontend: it still creates a phantom socket.
      const ghost = node.inputs?.findIndex((i: any) => i.name === "timeline");
      if (ghost >= 0) node.removeInput(ghost);

      const state = { tl: parseTimeline(dataW?.value) };
      const host = makeHost(node, state);
      const editor = new TimelineEditor(host);

      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.minWidth = `${MIN_W}px`;
      container.appendChild(editor.root);

      /**
       * Height reporting.
       *
       * `DOMWidgetImpl.computeLayoutSize` reads ONLY getMinHeight/getMaxHeight/getHeight
       * and NEVER `widget.computeSize`, so those getters are the whole contract. Measure
       * the real rendered content and report THAT: an estimate carries an error that
       * scales with the aspect ratio, so a portrait clip and a landscape one end up with
       * different margins.
       */
      let measured = 0;
      let inset = 0;     // ComfyUI hands the host a bit less than asked; calibrated below
      const estimate = () => {
        const w = Math.max(node.size?.[0] ?? MIN_W, MIN_W);
        const [ow, oh] = host.getOutSize();
        // Same cap the preview itself applies, so the first estimate is not wildly off
        // before the real content height is measured.
        return Math.min(Math.round((w - 24) * (oh / Math.max(1, ow))), PREVIEW_MAX_H)
          + editor.timelineHeight + 40;
      };
      const heightFor = () => (measured > 0 ? measured : estimate()) + ROW_SAFETY + inset;

      const domWidget = node.addDOMWidget("nkd_timeline", "NKD_TIMELINE", container, {
        getValue: () => dataW?.value ?? "",
        setValue: (v: string) => {
          if (dataW) dataW.value = v;
          state.tl = parseTimeline(v);
          editor.requestRender();
        },
        serialize: false,
        hideOnZoom: false,
        getMinHeight: heightFor,
        getMaxHeight: heightFor,
        getHeight: heightFor,
      });
      void domWidget;

      const releaseWidth = keepDomWidgetSized(node, container);

      const resizeToContent = () => {
        // Preserve the user's width: computeSize()[0] is the MINIMUM and would shrink it.
        node.setSize([node.size[0], node.computeSize()[1]]);
        node.setDirtyCanvas(true, true);
      };

      // Re-lock the height whenever the content's real height changes (new track, output
      // aspect changed by conform, control bar wrapping to two rows).
      let settling = false;
      const ro = new ResizeObserver(() => {
        if (settling) return;
        const h = editor.root.offsetHeight;   // offsetHeight, NOT getBoundingClientRect:
        if (h < 1) return;                    // gBCR is screen space and scales with zoom
        if (Math.abs(h - measured) <= 1) return;
        measured = h;
        settling = true;
        resizeToContent();
        requestAnimationFrame(() => { settling = false; });
        // Calibrate the row inset from what the host actually got versus what we asked.
        const hostH = container.parentElement?.clientHeight ?? 0;
        if (hostH > 0) {
          const missing = heightFor() - hostH;
          if (missing > inset && missing <= MAX_INSET) inset = Math.round(missing);
        }
      });
      ro.observe(editor.root);
      editor.onHeightChange = () => requestAnimationFrame(resizeToContent);

      const origResize = node.onResize;
      node.onResize = function (this: any, size: [number, number]) {
        origResize?.apply(this, arguments as any);
        if (size[0] < MIN_W) size[0] = MIN_W;
        size[1] = this.computeSize(size[0])[1];
        editor.requestRender();
      };

      const origComputeSize = node.computeSize.bind(node);
      node.computeSize = function (this: any) {
        const sz = origComputeSize();       // no arguments: passing a width breaks LGN
        const needed = heightFor();
        if (sz[1] < needed) sz[1] = needed;
        if (sz[0] < MIN_W) sz[0] = MIN_W;
        return sz;
      };

      /**
       * Make the frame_count widget step by the model's quantum, so nudging it walks
       * between legal frame counts instead of landing between them. LiteGraph reads
       * `options.step` (10x the visual step, a legacy quirk) and newer frontends read
       * `options.step2`, so both are set.
       */
      const syncQuantumStep = () => {
        const w = findW(node, "frame_count");
        if (!w?.options) return;
        const grid = quantizeGrid(host.getQuantize(), host.getQuantizeN());
        const step = grid ? grid[0] : 1;
        if (w.options.step2 === step) return;
        w.options.step2 = step;
        w.options.step = step * 10;
        // Re-land the current value on the grid so the very next nudge is already legal.
        const snapped = quantizeCount(Number(w.value) || 0, host.getQuantize(),
          host.getQuantizeN());
        if (snapped > 0 && snapped !== w.value) {
          w.value = snapped;
          w.callback?.(snapped);
        }
      };

      requestAnimationFrame(() => {
        measured = editor.root.offsetHeight || 0;
        syncQuantumStep();
        resizeToContent();
        editor.requestRender();
      });

      /**
       * Connections: when a new Load Video is wired in, probe its duration and drop it at
       * the end of track 0 by itself, so the node does something sensible untouched.
       */
      const syncSlots = () => {
        host.clearSourceCache();
        const { videos, images, masks, audios } = host.connectedSlots();
        const live = new Set([...videos, ...images, ...masks, ...audios]);
        if (editor.pruneToSlots(live)) host.commit();

        // `slotInUse` spans every lane on purpose: a video the user reinterpreted as a
        // mask has left the picture lane, and a per-lane check would add it straight back
        // as a video - undoing the reinterpretation on every refresh.
        // Videos carry a real file, so their length is probed exactly.
        for (const slot of videos) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = (info: MediaInfo | null) => {
            if (!info) return;
            // FIRST video on an untouched timeline: adopt its frame rate and size rather
            // than resampling it against an arbitrary default. Only when the timeline is
            // still empty, so it never overrides a rate the user chose.
            if (state.tl.clips.length === 0 && state.tl.masks.length === 0) {
              host.conformToFirstClip(info);
            }
            // The clip is measured in TIMELINE frames, not source frames.
            const fps = host.getFps();
            editor.addClipForSlot(slot,
              Math.round(info.frame_count * (fps / (info.fps || fps))), "video");
          };
          if (src.info) place(src.info);
          else void probe(src.ref).then(place);
        }
        // Tensor sources run 1:1 with the timeline and have no probeable length.
        const fallback = Math.max(1, host.getFrameCount() || TENSOR_DEFAULT_FRAMES);
        for (const slot of images) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "video");
        }
        for (const slot of masks) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "mask");
        }
        // Audio: the true length only exists once the file is decoded, and that decode is
        // the same one the waveform needs - so ask for it and place the clip when it lands.
        for (const slot of audios) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = () => {
            const buf = audioBufferFor(src.ref);
            editor.addClipForSlot(slot,
              buf ? Math.round(buf.duration * host.getFps()) : fallback, "audio");
          };
          if (audioBufferFor(src.ref)) place();
          else ensureAudio(src.ref, place);
        }
        const refs = [...state.tl.clips, ...state.tl.masks, ...state.tl.audio]
          .map((c) => host.sourceFor(c.src)?.ref)
          .filter(Boolean) as MediaRef[];
        releaseUnused(refs);
        editor.requestRender();
      };

      const origConn = node.onConnectionsChange;
      node.onConnectionsChange = function (this: any, ...args: any[]) {
        const r = origConn?.apply(this, args);
        // Autogrow rebuilds its slots; give it a tick before reading them.
        requestAnimationFrame(syncSlots);
        return r;
      };

      const origConfigure = node.onConfigure;
      node.onConfigure = function (this: any, ...args: any[]) {
        const r = origConfigure?.apply(this, args);
        // Widget values are restored AFTER the node is created.
        requestAnimationFrame(() => {
          state.tl = parseTimeline(findW(node, "timeline")?.value);
          syncSlots();
          resizeToContent();
          editor.requestRender();
        });
        return r;
      };

      /**
       * Picking a different file in an upstream Load Video/Audio changes NO connection, so
       * `onConnectionsChange` never fires and the old media would stay on screen. Compare
       * the resolved reference instead, and drop just that source when it moves.
       */
      const detectSourceSwaps = () => {
        for (const slot of new Set(
          [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => c.src))) {
          const cached = host.peekSource(slot);
          if (!cached) continue;
          const now = resolveSource(node, slot);
          if (!now || now.filename === cached.ref.filename) continue;
          forget(cached.ref);
          host.dropSource(slot);
          editor.requestRender();
        }
      };

      // Vue Nodes never calls onDrawBackground, so a low-rate tick is the only common
      // path for reflecting fps / size / fit edits made in the plain widgets.
      const tick = window.setInterval(() => {
        syncQuantumStep();
        detectSourceSwaps();
        editor.requestRender();
      }, 300);

      const origRemoved = node.onRemoved;
      node.onRemoved = function (this: any, ...args: any[]) {
        window.clearInterval(tick);
        ro.disconnect();
        releaseWidth();
        editor.destroy();
        releaseUnused([]);
        origRemoved?.apply(this, args);
      };

      requestAnimationFrame(syncSlots);
      return result;
    };
  },
});
