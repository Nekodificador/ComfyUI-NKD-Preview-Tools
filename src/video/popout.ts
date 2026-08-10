/**
 * 😺NKD Video Viewer — floating window.
 *
 * The viewer is MOVED into the other window rather than rebuilt there.
 *
 * That is the whole design. `popup_preview.js` re-injects `viewer.html` and re-runs its
 * script inside the PiP document, which means the image viewer exists twice and every fix
 * has to be made in both. Document Picture-in-Picture lets you adopt a live element, so the
 * same `VideoViewer` instance keeps its state, its handlers, its cached filmstrip and its
 * `<video>` - a floating window costs a move and a move back.
 *
 * Same-origin `window.open` accepts an adopted node too, so the no-PiP fallback is the same
 * code path rather than a second implementation.
 */

/** Copy the page's styles across. The PiP document starts EMPTY - no stylesheets at all -
 *  so without this every control renders unstyled and every icon comes out as a tofu box
 *  (the glyphs live in ComfyUI's own PrimeIcons/MDI sheets, not in ours). */
function adoptStyles(target: Document): void {
  // Belt and braces, not a fix for a known break. Every URL in play is root-relative
  // (`/api/view?…`, `materialdesignicons.min.css`), and an `about:blank` document inherits
  // its creator's base URL, so they resolve on their own - measured. But that inheritance is
  // the only thing holding it up, and a stylesheet or a video that silently fails to load in
  // a window you cannot easily debug is a bad way to find out otherwise.
  const baseTag = target.createElement("base");
  baseTag.href = document.baseURI;
  target.head.appendChild(baseTag);
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    target.head.appendChild(node.cloneNode(true));
  }
  const base = target.createElement("style");
  base.textContent =
    "html,body{margin:0;padding:0;height:100%;background:#16181d;overflow:hidden}" +
    ".nkd-vid{height:100%;box-sizing:border-box;padding:6px;" +
    "display:flex;flex-direction:column;gap:6px}" +
    // Same reasoning as the :fullscreen rule: the width cap and aspect-ratio are written
    // INLINE from JS, so only !important can lift them, and here they must go - the window
    // is the frame now.
    ".nkd-vid .nkd-vid-stage{flex:1 1 auto;min-height:0;" +
    "max-width:none!important;aspect-ratio:auto!important}";
  target.head.appendChild(base);
}

export interface Popout {
  close: () => void;
  isOpen: () => boolean;
}

/**
 * Float `root` in its own window, putting it back where it came from on close.
 *
 * `onMoved` fires after each move so the viewer can repaint: the scrub bar is a canvas
 * sized from its client width, and that changed underneath it.
 */
export async function openPopout(
  root: HTMLElement, title: string, onMoved: () => void,
): Promise<Popout | null> {
  const home = root.parentElement;
  if (!home) return null;

  // A stand-in keeps the node's widget from collapsing to nothing while the viewer is away,
  // and says where it went - an empty box would just look broken.
  const placeholder = document.createElement("div");
  placeholder.className = "nkd-vid-away";
  placeholder.textContent = "playing in a floating window";

  const width = Math.max(480, Math.round(root.clientWidth) || 640);
  const height = Math.max(360, Math.round(root.offsetHeight) || 480);

  let win: Window | null = null;
  const pip = (window as any).documentPictureInPicture;
  try {
    win = pip ? await pip.requestWindow({ width, height }) : null;
  } catch {
    win = null;                       // denied, or already showing another PiP
  }
  if (!win) {
    win = window.open("", "nkd-video-viewer",
      `popup=yes,width=${width},height=${height}`);
  }
  if (!win) return null;

  const doc = win.document;
  adoptStyles(doc);
  doc.title = title;
  home.appendChild(placeholder);
  doc.body.appendChild(root);         // adopts the live element, state and all
  root.focus();
  onMoved();

  let open = true;
  // Closing the page must not leave the viewer orphaned in a dead document. Kept in a
  // variable so it can be REMOVED on the way back: pop out and back in a few times and
  // otherwise you accumulate one listener per round trip, each holding a stale window.
  const closeOnExit = () => { try { win?.close(); } catch { /* already gone */ } };
  const goHome = () => {
    if (!open) return;
    open = false;
    window.removeEventListener("beforeunload", closeOnExit);
    home.appendChild(root);           // back into the node, same element
    placeholder.remove();
    onMoved();
  };
  // `pagehide` covers the PiP close button; `beforeunload` the plain popup. Both are
  // registered because which one fires depends on which window we ended up with.
  win.addEventListener("pagehide", goHome);
  win.addEventListener("beforeunload", goHome);
  window.addEventListener("beforeunload", closeOnExit);

  return {
    close: () => { try { win?.close(); } catch { /* already gone */ } goHome(); },
    isOpen: () => open,
  };
}
