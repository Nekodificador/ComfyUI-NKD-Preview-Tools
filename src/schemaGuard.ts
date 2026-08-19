/**
 * Widget-order guard — makes a node's saved values survive a widget reorder.
 *
 * `widgets_values` is POSITIONAL: reordering a node's widgets silently loads every saved
 * workflow's values into the wrong widgets, with no error anywhere. Two levels, both at
 * load time (the only honest moment):
 *
 * 1. REPAIR. Frontend ≥1.49.6 (PR #10392) always SAVES `widgets_values_named`, a
 *    name→value map — only the core's restore-from-it sits behind
 *    `Comfy.Workflow.NamedValuesRestore`, which ships disabled. When the map is present,
 *    values are re-applied BY NAME, so the positional order stops mattering entirely.
 *    Idempotent when the core setting is on.
 * 2. WARN. No map (older frontend) and no current schema stamp → the positional restore
 *    just mis-assigned everything, so say it in a toast. Only fires for `version > 1`:
 *    at version 1 no reorder has happened under the stamp regime, and an absent stamp
 *    only means "saved before stamping existed".
 *
 * Every NKD node registers this; the version is bumped ONLY on a deliberate breaking
 * reorder, which also belongs in the release notes.
 */
import { app as comfyApp } from "./comfyRuntime";
import { findW } from "./domHost";

const PROP = "nkdSchema";

export function guardWidgetOrder(nodeType: any, nodeName: string, version: number): void {
  const origCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function (this: any) {
    const r = origCreated?.apply(this, arguments as any);
    this.properties = this.properties || {};
    this.properties[PROP] = version;
    return r;
  };

  const origConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function (this: any, info: any) {
    const r = origConfigure?.apply(this, arguments as any);
    const named = info?.widgets_values_named;
    if (named && typeof named === "object" && !Array.isArray(named)) {
      // Map order is serialize order, so a DynamicCombo parent lands before the
      // sub-widgets its callback creates, and findW then sees them.
      for (const [name, val] of Object.entries(named)) {
        const w = findW(this, name);
        if (w && w.value !== val) {
          w.value = val;
          w.callback?.(val);
        }
      }
    } else if (version > 1
        && info?.properties?.[PROP] !== version
        && Array.isArray(info?.widgets_values) && info.widgets_values.length) {
      // Checked on the SAVED payload, never `this.properties`: configure MERGES
      // properties, so the stamp written at creation would mask an old save.
      (comfyApp as any).extensionManager?.toast?.add?.({
        severity: "warn",
        summary: `😺${nodeName}`,
        detail: `"${this.title ?? nodeName}" was saved before a widget reorder: its `
          + "values may have loaded into the wrong widgets. Delete and re-add the "
          + "node, then re-check its settings.",
        life: 12000,
      });
    }
    return r;
  };
}
