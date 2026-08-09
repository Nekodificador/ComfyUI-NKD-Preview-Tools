/**
 * NKD Freeze Frames - show one output socket per marked frame.
 *
 * There is no dynamic OUTPUT in the ComfyUI node API: `Autogrow` is inputs-only and
 * `DynamicOutput` is an empty abstract class. The runtime indexes the tuple a node returns
 * by slot number, so a socket invented here beyond the schema fails with an IndexError at
 * execution time. The schema therefore declares the ceiling and this file hides the tail.
 *
 * Which is why sockets are only ever removed from the END. `images` and `count` are the
 * first two outputs and are never touched; dropping a socket in the middle would slide
 * every later index down and silently repoint a saved link at a different frame.
 */
import { app as comfyApp } from "./comfyRuntime";
import { effectiveCount, markerFrames, parseTimeline } from "./timeline/model";

export const FREEZE_NODE = "NKDFreezeFrames";
/** `images` and `count`. Never trimmed, never reordered. */
const FIXED_OUTPUTS = 2;
/** Mirrors MAX_FREEZE_OUTPUTS in nkd_timeline.py. Touch one, touch the other. */
const MAX_FRAME_OUTPUTS = 16;

const widgetValue = (node: any, name: string): any =>
  node?.widgets?.find((w: any) => w.name === name)?.value;

const num = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/**
 * How many markers an NKD Timeline node will emit, by the same rule its backend uses:
 * absolute marker frames, shifted into the rendered range and dropped when they fall
 * outside it. Duplicated here rather than waited for, because the count has to be known
 * BEFORE the graph runs - that is the whole point of drawing the sockets.
 */
function markerCountOf(timelineNode: any): number {
  const tl = parseTimeline(widgetValue(timelineNode, "timeline"));
  const start = Math.max(0, num(widgetValue(timelineNode, "start_frame"), 0));
  const count = effectiveCount(
    tl, start, Math.max(0, num(widgetValue(timelineNode, "frame_count"), 0)),
    // The widget is named `model` since 2026-08-09: what you pick IS the model, and the
    // frame grid follows from it.
    String(widgetValue(timelineNode, "model") ?? ""),
    num(widgetValue(timelineNode, "quantize_n"), 8));
  return markerFrames(tl).filter((f) => f >= start && f < start + count).length;
}

export const TIMELINE_NODE = "NKDTimeline";

/**
 * Follow a link back until an NKD Timeline `markers` output turns up.
 *
 * Not one hop: chaining the string through a PreviewAny (to read it while editing) or any
 * other passthrough is an obvious thing to do, and a single-hop lookup gives up there and
 * leaves the node stuck at one socket. Same recursive shape as `resolveSource` in
 * media.ts, same bounded depth, first match wins - a wrong guess only mis-sizes the
 * sockets, and `linkedDepth` already stops that from cutting a live link.
 */
function findMarkerSource(node: any, slotName: string, depth = 0): any | null {
  if (!node || depth > 4) return null;
  const slot = node.inputs?.find((i: any) => i.name === slotName);
  if (!slot || slot.link == null) return null;
  const link = node.graph?.links?.[slot.link];
  const origin = link && node.graph?.getNodeById(link.origin_id);
  if (!origin) return null;
  if (origin.type === TIMELINE_NODE
      && origin.outputs?.[link.origin_slot]?.name === "markers") {
    return origin;
  }
  for (const inp of origin.inputs ?? []) {
    if (inp.link == null) continue;
    const up = findMarkerSource(origin, inp.name, depth + 1);
    if (up) return up;
  }
  return null;
}

/**
 * Frames this node is going to produce, or null when it cannot be known yet.
 *
 * Null is not zero: a `frames` string coming from somewhere unreadable only has a value at
 * execution time, and guessing would tear down sockets the user had wired.
 */
function wantedFrames(node: any): number | null {
  const slot = node.inputs?.find((i: any) => i.name === "frames");
  if (slot?.link != null) {
    const timeline = findMarkerSource(node, "frames");
    return timeline ? markerCountOf(timeline) : null;
  }
  const text = widgetValue(node, "frames");
  if (typeof text !== "string") return null;
  return (text.match(/-?\d+/g) ?? []).length;
}

/** Highest frame socket that is actually wired, so a resync can never cut a live link. */
function linkedDepth(node: any): number {
  let depth = 0;
  node.outputs?.forEach((o: any, i: number) => {
    if (i >= FIXED_OUTPUTS && o?.links?.length) depth = Math.max(depth, i + 1);
  });
  return depth;
}

export function syncFreezeOutputs(node: any): void {
  if (!node?.outputs) return;
  const n = wantedFrames(node);
  if (n === null) return;
  // At least one frame socket even with nothing marked yet: a node with no visible output
  // looks broken.
  const want = FIXED_OUTPUTS + Math.min(MAX_FRAME_OUTPUTS, Math.max(1, n));
  const target = Math.max(want, linkedDepth(node));
  if (node.outputs.length === target) return;
  while (node.outputs.length > target) node.removeOutput(node.outputs.length - 1);
  while (node.outputs.length < target) {
    node.addOutput(`frame_${node.outputs.length - FIXED_OUTPUTS + 1}`, "IMAGE");
  }
  node.setDirtyCanvas?.(true, true);
}

/** Re-sync every Freeze Frames node in the graph. Called when a timeline commits, so
 *  pressing M upstream grows the sockets straight away instead of after a run. */
export function syncAllFreezeNodes(): void {
  for (const n of comfyApp.graph?._nodes ?? []) {
    if (n.type === FREEZE_NODE) syncFreezeOutputs(n);
  }
}

export function registerFreezeFrames(): void {
  comfyApp.registerExtension({
    name: "NKD.FreezeFrames",
    async beforeRegisterNodeDef(nodeType: any, nodeData: any) {
      if (nodeData?.name !== FREEZE_NODE) return;
      if (nodeType.prototype.__nkdFreezeWrapped) return;   // "Refresh node definitions"
      nodeType.prototype.__nkdFreezeWrapped = true;

      const origCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function (this: any) {
        const r = origCreated?.apply(this, arguments as any);
        const w = this.widgets?.find((x: any) => x.name === "frames");
        if (w) {
          const origCb = w.callback;
          w.callback = (...args: any[]) => {
            const out = origCb?.apply(w, args);
            syncFreezeOutputs(this);
            return out;
          };
        }
        // Deferred: litegraph is still building the node from the def right now, so the
        // schema's 16 sockets do not all exist yet.
        setTimeout(() => syncFreezeOutputs(this), 0);
        return r;
      };

      const origConn = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function (this: any) {
        const r = origConn?.apply(this, arguments as any);
        syncFreezeOutputs(this);
        return r;
      };

      // On load litegraph restores whatever socket count the workflow was saved with, so
      // the sync has to run again afterwards - and after, not during, or removeOutput
      // races the link restoration.
      const origConfigure = nodeType.prototype.onConfigure;
      nodeType.prototype.onConfigure = function (this: any) {
        const r = origConfigure?.apply(this, arguments as any);
        setTimeout(() => syncFreezeOutputs(this), 0);
        return r;
      };
    },
  });
}
