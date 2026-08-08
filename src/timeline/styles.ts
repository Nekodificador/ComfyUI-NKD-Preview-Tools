/**
 * Widget CSS, injected by hand into a <style> with a fixed id.
 *
 * Deliberately NOT `vite-plugin-css-injected-by-js`: with multiple entries the plugin
 * picks which chunk carries all the CSS, and a desynchronised scope-id leaves the widget
 * with no styles at all (documented in the nkd-node skill). A <style> with an id is
 * idempotent and cannot desynchronise.
 *
 * Note there is no `height` on `.nkd-tl-canvas`: it is pinned in px from JS, because the
 * timeline has a fixed intrinsic height while the preview derives its own from
 * `aspect-ratio`.
 */
const STYLE_ID = "nkd-timeline-styles";

const CSS = `
.nkd-tl {
  display: flex; flex-direction: column; gap: 4px;
  width: 100%; box-sizing: border-box;
  font: 12px system-ui, sans-serif; color: #c8d0e0;
  outline: none;
  container-type: inline-size;
}
.nkd-tl-preview {
  /* max-width is set from JS (height cap x aspect) and margin auto centres it, so
     widening the node stretches the TIMELINE rather than the monitor. */
  width: 100%; display: block; margin: 0 auto;
  background: #000; border: 1px solid #3a3d46; border-radius: 6px;
  min-height: 60px;
}
.nkd-tl-canvas {
  width: 100%; display: block;
  background: #111318; border: 1px solid #3a3d46; border-radius: 6px;
  touch-action: none;   /* the drag is ours, not the browser's scroll */
}
.nkd-tl-bar {
  display: flex; align-items: center; gap: 4px; flex-wrap: wrap;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px 6px;
}
.nkd-tl-btn {
  background: #252830; border: 1px solid #3a3d46; border-radius: 4px;
  color: #c8d0e0; cursor: pointer;
  padding: 3px 7px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
}
.nkd-tl-btn:hover { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn.on { border-color: #4ab4ff; color: #4ab4ff; }
.nkd-tl-btn .pi { font-size: 12px; color: inherit; }
/* ComfyUI loads the MDI font but its stylesheet only sets the glyph content, not the
   family - so it has to be named here or every MDI button renders as a tofu box.
   (No backticks in this file: the CSS lives in a template literal.) */
.nkd-tl-btn .mdi {
  font-family: "Material Design Icons"; font-size: 14px; color: inherit;
  line-height: 1; font-style: normal;
}
/* In/out brackets: monochrome text, sized in the button so the box does not depend on
   the host's base font. Matches the [ ] drawn on the ruler. */
.nkd-tl-brk {
  font: bold 13px ui-monospace, monospace; color: inherit;
  display: block; width: 12px; line-height: 12px;
}
.nkd-tl-status {
  margin-left: auto; color: rgba(255,255,255,0.45);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
/* Right-click menu. Lives on <body>, not inside the node: within the graph canvas it
   would be clipped by the node box and scaled by the canvas zoom transform. */
.nkd-tl-menu {
  position: fixed; z-index: 10000; min-width: 170px;
  background: #1a1c22; border: 1px solid #3a3d46; border-radius: 6px;
  padding: 4px; box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  font: 12px system-ui, sans-serif;
}
.nkd-tl-menu-item {
  display: block; width: 100%; text-align: left;
  background: none; border: 0; border-radius: 4px;
  color: #c8d0e0; padding: 5px 8px; cursor: pointer;
}
.nkd-tl-menu-item:hover { background: #252830; color: #4ab4ff; }
.nkd-tl-menu-item.on { color: #4ab4ff; }
.nkd-tl-menu-item.on::after { content: " ✓"; }
/* Container query, not a media query: the node resizes, the window does not. */
@container (max-width: 330px) { .nkd-tl-status { display: none; } }
`;

export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
