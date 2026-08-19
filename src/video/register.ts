/**
 * 😺NKD Video Viewer — node registration.
 *
 * The backend returns a UI payload under its OWN key (`nkd_video`) rather than
 * `ui.PreviewVideo`. That is deliberate: the core key would make ComfyUI render its own
 * player as well, so the node would carry two.
 */
import { app as comfyApp } from "../comfyRuntime";
import { findW, hideWidget, mountDomWidget, setWidgetVisible } from "../domHost";
import { syncLabelWidgets } from "../labels";
import { guardWidgetOrder } from "../schemaGuard";
import { ensureStyles } from "../timeline/styles";
import { VideoViewer, type VideoInfo } from "./viewer";

const NODE_NAME = "NKDVideoViewer";
const MIN_W = 320;

/** Widget-order schema version for `guardWidgetOrder` (repair by widgets_values_named,
 *  or toast on an old positional save). v2: 2026-08-17 — the two saves moved to the end,
 *  defaults went production. Bump ONLY on a deliberate breaking reorder. */
const SCHEMA_VERSION = 2;
/** Viewer state lives HERE, never in a widget: an input is part of the cache signature
 *  (`CacheKeySetInputSignature`), so toggling loop would re-encode the whole video. */
const STATE_PROP = "nkdVideoView";

/**
 * Naming templates, offered from the CONTEXT MENU rather than a widget.
 *
 * Applying a template is an ACTION, and a combo is a state: pick "Versioned", then hand-edit
 * `filename_prefix`, and the combo keeps claiming "Versioned" when it is no longer true. A
 * menu item fills the field and disappears, which is what actually happened. It also costs
 * no permanent widget row for something used once per node.
 *
 * They live here and not in Python because `%date:...%` is expanded by the core frontend at
 * submit time (`applyTextReplacements`); a template applied in the backend would ship the
 * raw token into the path. Writing the widget also keeps ONE source of truth - what
 * `filename_prefix` shows is exactly what runs.
 *
 * ponytail: three canned strings. The real answer is a token picker (clickable pills that
 * insert %node%, %v###%, %res%…) so the vocabulary is discoverable instead of memorised -
 * deferred by Neko to a later phase, deliberately.
 */
/**
 * `[label, folder, name]`. A template with a `name` fills BOTH widgets, which is the point
 * of the split: the folder stays the project's and the naming scheme changes on its own.
 * `name: ""` means the old shape - one string carrying the whole path.
 */
const NAMING_TEMPLATES: [string, string, string][] = [
  ["Project (versioned)", "%project%/%category%", "%node%_v%v###%"],
  ["Project (flat)", "%project%/%category%", "%node%"],
  ["Project + dated folder", "%project%/%category%/%date:yyyy-MM-dd%", "%node%_v%v###%"],
  ["Simple (dated folder)", "video/%date:yyyy-MM-dd%/%node%", ""],
  ["Versioned (Nuke layout)", "video/%node%/v%v###%", "%node%_v%v###%"],
  ["Flat", "video/%node%", ""],
];

function applyTemplate(node: any, folder: string, name: string): void {
  const prefix = findW(node, "filename_prefix");
  if (!prefix) return;
  prefix.value = folder;
  prefix.callback?.(folder);
  // Always written, including the empty case: a template that left a previous name in place
  // would silently produce a path neither template describes.
  const file = findW(node, "filename");
  if (file) {
    file.value = name;
    file.callback?.(name);
  }
  const tpl = `${folder}/${name}`;
  // A template carrying %v###% is useless with versioning off, and silently writing the
  // literal token into a filename is the failure nobody would attribute to this menu.
  const versioning = findW(node, "versioning");
  if (versioning && tpl.includes("%v#") && versioning.value === "off") {
    versioning.value = "auto (next free)";
    versioning.callback?.(versioning.value);
  }
  node.setDirtyCanvas(true, true);
}

/** Reveal `version` only when it is the one actually in use. A knob that does nothing is
 *  worse than no knob. */
function wireNaming(node: any): void {
  const versioning = findW(node, "versioning");
  const syncVersion = () => {
    const mode = versioning?.value ?? "off";
    setWidgetVisible(node, "version", mode === "manual");
    // Versioning overrides `numbering` in Python, so showing the widget would be showing a
    // control that no longer does anything.
    setWidgetVisible(node, "numbering", mode === "off");
    node.setDirtyCanvas(true, true);
  };
  if (versioning) {
    const orig = versioning.callback;
    versioning.callback = function () {
      const r = orig?.apply(this, arguments as any);
      syncVersion();
      return r;
    };
  }
  syncVersion();
}

export function registerVideoViewer(): void {
  comfyApp.registerExtension({
    name: "NKD.PreviewTools.Video",
    getNodeMenuItems(node: any) {
      if (node.comfyClass !== NODE_NAME) return [];
      return NAMING_TEMPLATES.map(([label, folder, name]) => ({
        content: `⎘ Name: ${label}`,
        callback: () => applyTemplate(node, folder, name),
      }));
    },
    async beforeRegisterNodeDef(nodeType: any, nodeData: any) {
      if (nodeData?.name !== NODE_NAME) return;
      // Without this guard, "Refresh node definitions" re-runs the hook on the SAME
      // prototype and the wraps stack up, leaving orphan widgets rendering forever.
      if (nodeType.prototype.__nkdVideoWrapped) return;
      nodeType.prototype.__nkdVideoWrapped = true;

      guardWidgetOrder(nodeType, "NKD Video Viewer", SCHEMA_VERSION);

      const origCreated = nodeType.prototype.onNodeCreated;
      nodeType.prototype.onNodeCreated = function (this: any) {
        const result = origCreated?.apply(this, arguments as any);
        ensureStyles();
        const node = this;

        wireNaming(node);
        // The tracked-widgets list rides in here (src/labels.ts). Data channel, not UI —
        // and `hidden = true`, never `type = "hidden"`, so the value still serialises.
        hideWidget(findW(node, "labels"));
        // A viewer dropped into a graph that already has marks must pick them up.
        requestAnimationFrame(syncLabelWidgets);
        const viewer = new VideoViewer(node.properties?.[STATE_PROP]);
        viewer.onState = (s) => {
          node.properties = node.properties || {};
          node.properties[STATE_PROP] = s;
        };

        const mounted = mountDomWidget(node, {
          name: "nkd_video",
          type: "NKD_VIDEO",
          root: viewer.root,
          minWidth: MIN_W,
          estimate: () => viewer.estimateHeight(Math.max(node.size?.[0] ?? MIN_W, MIN_W)),
          onResize: () => viewer.draw(),
        });
        viewer.onHeightChange = () => requestAnimationFrame(mounted.resizeToContent);

        // The result of the last run, replayed on reload: ComfyUI re-sends the cached UI
        // for an output node, so a workflow reopened without re-running still shows its
        // video instead of an empty box.
        const adopt = (message: any) => {
          const ref = message?.nkd_video?.[0];
          const info = message?.nkd_meta?.[0] as VideoInfo | undefined;
          if (!ref || !info) return;
          viewer.setSource(ref, info);
        };
        const origExecuted = node.onExecuted;
        node.onExecuted = function (this: any, message: any) {
          origExecuted?.apply(this, arguments as any);
          adopt(message);
        };

        const origRemoved = node.onRemoved;
        node.onRemoved = function (this: any) {
          viewer.destroy();
          mounted.release();
          origRemoved?.apply(this, arguments as any);
        };

        return result;
      };
    },
  });
}
