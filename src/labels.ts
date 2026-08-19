/**
 * Tracked widgets — mark any widget in the graph, no cables.
 *
 * Right-click a node and the widget under the pointer gets a "Track" entry (the
 * promote-widget gesture, via `canvas.getWidgetAtCursor()`); the mark lives in
 * `node.properties.nkdTracked`, so it travels with the workflow and survives copy/paste
 * without touching any cache signature.
 *
 * What travels to the backend is ONLY the `[node_id, widget]` list, written into the
 * Video Viewer's hidden `labels` input. The VALUES never travel: `hidden.prompt` already
 * carries every widget of every node for the run being executed, so the backend looks
 * them up there and they can never go stale (`label_lines` in `nkd_video.py`).
 */
import { app as comfyApp } from "./comfyRuntime";
import { setWidgetVisible } from "./domHost";
import { type MenuItem, openMenu } from "./projects";

export const TRACKED_PROP = "nkdTracked";
const VIEWER = "NKDVideoViewer";

const tracked = (node: any): string[] =>
  Array.isArray(node?.properties?.[TRACKED_PROP]) ? node.properties[TRACKED_PROP] : [];

/** Every mark in the graph, with its node. */
function entries(): { node: any; name: string }[] {
  const out: { node: any; name: string }[] = [];
  for (const n of comfyApp.graph?._nodes ?? []) {
    for (const name of tracked(n)) out.push({ node: n, name });
  }
  return out;
}

/** The chips repaint whenever the marks change — they live per viewer, the marks are
 *  graph-wide. */
const chips = new Set<() => void>();
const repaintChips = () => chips.forEach((p) => p());

/**
 * The id the PROMPT will actually contain for this mark.
 *
 * A mark on a SUBGRAPH's promoted widget names a node the prompt never has: at queue
 * time the subgraph EXPANDS and its interior gets composite ids (`192:199`). The surface
 * widget maps to an interface input of the same name, whose link lands on the interior
 * node — follow it (recursively: subgraphs nest) and emit the composite id plus the
 * interior widget's real name. Verified live against a promoted `strength_model` on an
 * H3 loader subgraph (2026-08-17). If the structure cannot be walked, fall back to the
 * plain id — the backend has a last-resort match for that shape.
 */
function resolveMark(node: any, widget: string, depth = 0): [string, string] {
  if (depth > 4 || typeof node.isSubgraphNode !== "function" || !node.isSubgraphNode()) {
    return [String(node.id), widget];
  }
  const sg = node.subgraph;
  const inp = sg?.inputs?.find((i: any) => i.name === widget);
  const linkId = inp?.linkIds?.[0];
  const link = linkId != null
    ? (sg.getLink?.(linkId) ?? sg.links?.get?.(linkId) ?? sg.links?.[linkId])
    : null;
  const tgt = link ? sg.getNodeById(link.target_id) : null;
  if (!tgt) return [String(node.id), widget];
  const name = tgt.inputs?.[link.target_slot]?.name ?? widget;
  const inner = resolveMark(tgt, name, depth + 1);
  return [`${node.id}:${inner[0]}`, inner[1]];
}

/** Write the tracked list into every viewer's hidden `labels` input. The widget is an
 *  INPUT on purpose: changing what is tracked must re-run the node to re-burn. Also
 *  shows/hides `labeled_copy`: with nothing tracked there is nothing the knob could do. */
export function syncLabelWidgets(): void {
  const nodes: any[] = comfyApp.graph?._nodes ?? [];
  const list: [string, string][] = [];
  for (const n of nodes) {
    for (const name of tracked(n)) list.push(resolveMark(n, name));
  }
  const json = list.length ? JSON.stringify(list) : "";
  for (const n of nodes) {
    if (n.comfyClass !== VIEWER) continue;
    const w = n.widgets?.find((x: any) => x.name === "labels");
    if (w && w.value !== json) {
      w.value = json;
      w.callback?.(json);
    }
    setWidgetVisible(n, "labeled_copy", list.length > 0);
    n.setDirtyCanvas?.(true, true);
  }
  repaintChips();
}

function toggleTrack(node: any, name: string): void {
  const cur = tracked(node);
  node.properties = node.properties || {};
  node.properties[TRACKED_PROP] = cur.includes(name)
    ? cur.filter((n) => n !== name)
    : [...cur, name];
  syncLabelWidgets();
  node.setDirtyCanvas?.(true, true);
}

/** Widgets worth offering: literal values a run consumes. DOM/tracking widgets, and
 *  widgets converted to inputs (their value is not here any more), are not. */
const listable = (w: any): boolean =>
  !!w?.name && !w.hidden && ["string", "number", "boolean"].includes(typeof w.value);

export function registerTrackedWidgets(): void {
  comfyApp.registerExtension({
    name: "NKD.TrackedWidgets",
    getNodeMenuItems(node: any) {
      const widgets = (node.widgets ?? []).filter(listable);
      // The viewer is excluded: tracking the tracker only produces noise about itself.
      if (!widgets.length || node.comfyClass === VIEWER) return [];
      const cur = tracked(node);
      const items: any[] = [];
      // The promote-widget gesture: name the widget under the pointer. No official hook
      // exists for a widget menu, so this is the node menu KNOWING where it was opened.
      // If a future frontend drops getWidgetAtCursor, the submenu below still covers it.
      const under = comfyApp.canvas?.getWidgetAtCursor?.();
      if (under && widgets.includes(under)) {
        const on = cur.includes(under.name);
        items.push({
          content: `🏷 ${on ? "Untrack" : "Track"} '${under.name}' in labels`,
          callback: () => toggleTrack(node, under.name),
        });
      }
      items.push({
        content: "🏷 Track widgets…",
        submenu: {
          options: widgets.map((w: any) => ({
            content: `${cur.includes(w.name) ? "✓ " : " "}${w.name}`,
            callback: () => toggleTrack(node, w.name),
          })),
        },
      });
      if (cur.length) {
        items.push({
          content: `🏷 Untrack all (${cur.length})`,
          callback: () => {
            node.properties[TRACKED_PROP] = [];
            syncLabelWidgets();
            node.setDirtyCanvas?.(true, true);
          },
        });
      }
      return items;
    },
    nodeCreated(node: any) {
      // Badge on every node carrying marks — an invisible mark that changes the output
      // is the same trap as an unlabelled blend mode. Wrapped per instance and checked
      // per draw: the check is one property read, and tracking can change any time.
      const orig = node.onDrawForeground;
      node.onDrawForeground = function (this: any, ctx: CanvasRenderingContext2D) {
        const r = orig?.apply(this, arguments as any);
        if (!this.flags?.collapsed && tracked(this).length) {
          ctx.save();
          ctx.font = "12px sans-serif";
          ctx.textAlign = "right";
          ctx.fillText("🏷", this.size[0] - 6, -9);   // in the title bar, clear of buttons
          ctx.restore();
        }
        return r;
      };
    },
    // A saved workflow can carry a stale list (a tracked node deleted since, marks made
    // while no viewer existed): recompute once the graph is fully restored.
    afterConfigureGraph() {
      syncLabelWidgets();
    },
  });
}

/** Live value of a node's widget, short enough for a menu row. */
function liveValue(node: any, name: string): string {
  const v = node.widgets?.find((w: any) => w.name === name)?.value;
  const s = v === undefined ? "(linked)" : String(v).replace(/\s+/g, " ").trim();
  return s.length > 40 ? s.slice(0, 39) + "…" : s;
}

/**
 * A `🏷 N` chip for the viewer's toolbar: every mark in the graph, in one place, so
 * untracking never means hunting the node down. Click an entry to untrack it; the entry
 * shows the LIVE value, which is also what would be burned on the next run.
 */
export function trackedChip(parent: HTMLElement): { el: HTMLElement; destroy: () => void } {
  const btn = document.createElement("button");
  btn.className = "nkd-tl-btn";
  btn.title = "Tracked widgets — burned into the _labeled review copy. Click to manage.";
  parent.appendChild(btn);
  const icon = document.createElement("i");
  // pi-tags (plural), NOT pi-tag: the toggle button that shows the labeled copy is
  // pi-tag, and two adjacent buttons with the same glyph was already paid for once
  // (the expand buttons). This one manages the set; the count seals the difference.
  icon.className = "pi pi-tags";
  btn.appendChild(icon);
  const count = document.createElement("span");
  count.className = "nkd-proj-label";
  btn.appendChild(count);

  const paint = () => {
    const n = entries().length;
    count.textContent = String(n);
    // Hidden while nothing is tracked: marking happens on the SOURCE node's menu, so a
    // zero-count chip here could only ever say "go somewhere else".
    btn.style.display = n ? "" : "none";
  };
  paint();
  chips.add(paint);

  btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const items: MenuItem[] = [{ label: "Tracked widgets — click to untrack", header: true }];
    for (const { node, name } of entries()) {
      items.push({
        label: `${node.title ?? node.type} · ${name}: ${liveValue(node, name)}`,
        active: true,
        on: () => toggleTrack(node, name),
      });
    }
    items.push({
      label: "✕ Clear all",
      on: () => {
        for (const { node } of entries()) node.properties[TRACKED_PROP] = [];
        syncLabelWidgets();
        comfyApp.graph?.setDirtyCanvas?.(true, true);
      },
    });
    const r = btn.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, items);
  });

  return { el: btn, destroy: () => { chips.delete(paint); } };
}
