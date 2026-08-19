/**
 * 😺NKD Video Viewer — the viewer.
 *
 * Built on ONE `<video>`, so the native element does the work it is good at: `loop` is an
 * attribute, shuttle is `playbackRate`, full screen is `requestFullscreen`, saving is a
 * download link. The timeline's `Transport` is deliberately NOT reused - it exists to hold
 * several clips against a shared clock with no single element to follow, which is the
 * opposite of the situation here.
 *
 * The file is served RAW through `/view` (Range supported), and the encoder writes mp4 with
 * `faststart`, so seeking is instant instead of waiting on a full download. That pair is the
 * whole reason this can be scrubbed when Video Helper Suite's preview cannot.
 */
import { api } from "../comfyRuntime";
import { type MediaRef, ensureThumbnails, thumbnailAt, viewUrl } from "../timeline/media";
import { type Popout, openPopout } from "./popout";
import { projectChip, revealButton } from "../projects";
import { trackedChip } from "../labels";

export type CompareMode = "off" | "wipe" | "difference";
const COMPARE_ORDER: CompareMode[] = ["off", "wipe", "difference"];

/**
 * How far the reference may drift from the current clip before it is nudged.
 *
 * Two `<video>` elements never play in lockstep, and correcting every frame is what makes a
 * preview stutter - an h264 seek costs far more than decoding forward. Same threshold and
 * same reasoning as `followPlayback` in the timeline's media layer.
 *
 * Matched by TIME, never by frame: the reference may well have been rendered at another
 * frame rate, and frame 40 of a 30 fps take is not frame 40 of a 24 fps one.
 */
const REF_DRIFT_S = 0.25;

export interface VideoInfo {
  fps: number;
  frame_count: number;
  width: number;
  height: number;
  /** What the browser can do with the file: a seekable <video>, a still <img> that
   *  animates, or nothing at all (h265, ProRes, a PNG sequence) - in which case the
   *  backend wrote a poster frame and `filename` points at that instead. */
  preview: "video" | "image" | "none";
  /** MIME + codec string to ask `canPlayType` about, when `preview` is "video". */
  mime?: string | null;
  /** Fallback still, relative to the same subfolder, when the browser cannot play it. */
  poster?: string | null;
  format: string;
  size: number;
  /** Absolute path on the server, for the copy button. */
  path?: string;
  /** The version `auto`/`manual` actually used, when versioning is on. */
  version?: number | null;
  /** The reference WIRED into the node, already encoded to something seekable. Absent
   *  when nothing is connected, in which case the global slot stands in. */
  reference?: MediaRef | null;
  /** The `_labeled` review copy (always h264/mp4), when any widgets are tracked. */
  labeled?: MediaRef | null;
}

/** Tallest the picture is allowed to get, in logical px. Widening the node must NOT grow
 *  the monitor - same reasoning, and same number, as the timeline's preview. */
const PREVIEW_MAX_H = 260;
const SCRUB_H = 44;
/** L and J step through these, the way every NLE shuttles. */
const SHUTTLE = [1, 2, 4, 8];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  parent?.appendChild(node);
  return node;
};

function button(parent: HTMLElement, icon: string, title: string,
                onClick: () => void): HTMLButtonElement {
  const b = el("button", "nkd-tl-btn", parent);
  b.title = title;
  b.appendChild(el("i", icon));
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

const humanSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export class VideoViewer {
  readonly root: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly still: HTMLImageElement;   // GIF has no seekable stream; show it as-is
  private readonly scrub: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly link: HTMLAnchorElement;
  private readonly pathLine: HTMLElement;
  private readonly chip: { el: HTMLElement; destroy: () => void };
  private readonly labelsChip: { el: HTMLElement; destroy: () => void };

  private ref: MediaRef | null = null;
  /** What the stage is actually showing: the render, or the `_labeled` review copy. The
   *  download link and the path line stay on `ref` — the labeled copy is display only. */
  private shown: MediaRef | null = null;
  private info: VideoInfo | null = null;
  private raf = 0;
  private dragging = false;
  /** Coalesced seek target in seconds, -1 when nothing is pending. See `applySeek`. */
  private want = -1;
  private seeking = false;
  private guard = 0;
  /** Pre-rendered filmstrip. Only the playhead moves while scrubbing, so rebuilding the
   *  strip on every pointermove is pure waste - and it is the expensive half of a draw. */
  private strip = document.createElement("canvas");
  private stripKey = "";
  /** The before/after layer: a second `<video>` stacked over the first. */
  private readonly refVideo: HTMLVideoElement;
  private readonly divider: HTMLElement;
  private readonly compareBtn: HTMLButtonElement;
  private compare: CompareMode = "off";
  private wipe = 0.5;                    // 0..1, how much of the reference is showing
  private holding = false;               // hold B: reference full-frame
  private hasRef = false;
  /** The reference wired into the node. It BEATS the global slot: a connection is a
   *  statement about this node, the slot is whatever happened to run last. */
  private wired: MediaRef | null = null;
  /** Bound once so it can be removed again: a viewer deleted from the graph must not keep
   *  answering the api's events. */
  private readonly onPromptDone = () => { if (!this.wired) void this.loadReference(); };
  private popout: Popout | null = null;
  /** Showing the `_labeled` review copy instead of the clean render. Display only: the
   *  download button and the path line keep pointing at the render. */
  private showLabels = false;
  private labelsBtn: HTMLButtonElement;
  /** Persisted on the node, not in a widget: what the viewer is doing does not change what
   *  the graph produces, and an input would re-encode the video on every toggle. */
  onState: ((s: { loop: boolean; muted: boolean; compare: CompareMode;
                  wipe: number; labels?: boolean }) => void) | null = null;
  onHeightChange: (() => void) | null = null;

  constructor(state?: { loop?: boolean; muted?: boolean; compare?: CompareMode;
                        wipe?: number; labels?: boolean }) {
    this.root = el("div", "nkd-tl nkd-vid");
    this.root.tabIndex = 0;                    // keys only while the viewer has focus

    this.stage = el("div", "nkd-vid-stage", this.root);
    this.video = el("video", "nkd-vid-el", this.stage);
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.loop = state?.loop !== false;   // a preview loops by default
    this.video.muted = !!state?.muted;
    this.still = el("img", "nkd-vid-el", this.stage);
    this.still.style.display = "none";

    // The reference sits ON TOP and is clipped back, so the wipe reads left-to-right as
    // before → after, which is the way every A/B slider in the world works.
    this.refVideo = el("video", "nkd-vid-el nkd-vid-ref", this.stage);
    this.refVideo.playsInline = true;
    this.refVideo.muted = true;          // the mix you judge is the current clip's
    this.refVideo.preload = "auto";
    this.divider = el("div", "nkd-vid-divider", this.stage);
    this.compare = state?.compare ?? "off";
    if (typeof state?.wipe === "number") this.wipe = state.wipe;

    this.scrub = el("canvas", "nkd-vid-scrub", this.root);

    const bar = el("div", "nkd-tl-bar", this.root);
    this.playBtn = button(bar, "pi pi-play", "Play / pause (Space)", () => this.toggle());
    button(bar, "pi pi-step-backward", "Previous frame (←)", () => this.step(-1));
    button(bar, "pi pi-step-forward", "Next frame (→)", () => this.step(1));
    this.loopBtn = button(bar, "pi pi-replay", "Loop", () => {
      this.video.loop = !this.video.loop;
      this.syncButtons();
      this.pushState();
    });
    this.muteBtn = button(bar, "pi pi-volume-up", "Mute", () => {
      this.video.muted = !this.video.muted;
      this.syncButtons();
      this.pushState();
    });
    button(bar, "pi pi-window-maximize", "Full screen (F)", () => this.toggleFullscreen());
    button(bar, "pi pi-external-link",
      "Float in its own window — drag it to a second monitor",
      () => void this.togglePopout());
    this.compareBtn = button(bar, "pi pi-arrows-h",
      "Compare against the reference: off / wipe / difference (C). Hold B to see it whole.",
      () => this.cycleCompare());
    button(bar, "pi pi-bookmark", "Use this render as the reference", () => {
      void this.setAsReference();
    });
    this.showLabels = !!state?.labels;
    this.labelsBtn = button(bar, "pi pi-tag",
      "Show the labeled review copy (tracked widget values burned in)", () => {
        this.showLabels = !this.showLabels;
        this.pushState();
        if (this.ref && this.info) this.setSource(this.ref, this.info);
      });
    this.labelsBtn.style.display = "none";   // only drawn once a labeled copy exists
    // A real <a download>: no fetch, no blob, and the browser's own save dialog.
    this.link = el("a", "nkd-tl-btn", bar);
    this.link.title = "Save a copy";
    this.link.appendChild(el("i", "pi pi-download"));
    // Only drawn when the server is this machine - see `revealAvailable`.
    revealButton(bar, () => this.ref);
    this.chip = projectChip(bar);
    // Every mark in the graph, listed here so untracking never means hunting the node.
    this.labelsChip = trackedChip(bar);

    this.status = el("div", "nkd-tl-status", bar);
    this.status.textContent = "no video yet";

    // Where it actually landed. A token/version scheme you cannot see the result of is just
    // guesswork, and the version is only decided at execute time (by scanning the folder),
    // so this is the only honest moment to show it.
    this.pathLine = el("div", "nkd-vid-path", this.root);
    this.pathLine.title = "Click to copy the full path";
    this.pathLine.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.pathLine.dataset.full || "");
      const was = this.pathLine.textContent;
      this.pathLine.textContent = "copied";
      window.setTimeout(() => { this.pathLine.textContent = was; }, 900);
    });

    this.syncButtons();
    // A compare mode restored from the workflow has to re-fetch the reference: the slot
    // lives on the server and survives nothing but the session.
    if (this.compare !== "off") void this.loadReference();
    else this.applyCompare();
    this.wire();
  }

  // ── Source ──────────────────────────────────────────────────────────────────

  setSource(ref: MediaRef, info: VideoInfo): void {
    this.ref = ref;
    this.info = info;
    this.stripKey = "";                 // a new source invalidates the cached filmstrip
    this.want = -1;
    this.seeking = false;
    window.clearTimeout(this.guard);
    const labeled = info.labeled ?? null;
    this.labelsBtn.style.display = labeled ? "" : "none";
    this.labelsBtn.classList.toggle("on", this.showLabels && !!labeled);
    this.shown = this.showLabels && labeled ? labeled : ref;
    const url = viewUrl(this.shown);
    this.link.href = viewUrl(ref);
    this.link.setAttribute("download", ref.filename);

    const aspect = info.width / Math.max(1, info.height);
    // aspect-ratio gives the height; the max-width cap is what stops a wide node from
    // growing the picture (and turning a portrait clip into a column).
    this.stage.style.aspectRatio = `${info.width} / ${info.height}`;
    this.stage.style.maxWidth = `${Math.round(PREVIEW_MAX_H * aspect)}px`;

    if (this.playable) {
      this.still.style.display = "none";
      this.video.style.display = "";
      if (this.video.src !== url) this.video.src = url;
      ensureThumbnails(this.shown, {
        fps: info.fps, frame_count: info.frame_count,
        duration: info.frame_count / Math.max(1e-6, info.fps),
        width: info.width, height: info.height,
      }, () => this.draw());
    } else {
      // Everything else is a still. A GIF or WebP animates on its own but has no seekable
      // stream, so it IS the file; ProRes, a PNG sequence - and h265 where this browser
      // will not decode it - have no viewable file at all, so the backend's poster stands
      // in. Either way the transport has nothing to drive, and saying so beats shipping a
      // scrub bar that silently does nothing.
      this.video.removeAttribute("src");
      this.video.load();
      this.video.style.display = "none";
      this.still.style.display = "";
      this.still.src = info.poster
        ? viewUrl({ ...ref, filename: info.poster })
        : url;
    }
    // The path line and the download button always point at the RENDER, never at the
    // poster: the poster is a preview artefact, not the thing that was asked for.
    const shown = ref.filename;
    this.link.setAttribute("download", shown);
    const where = `${ref.type}/${ref.subfolder ? ref.subfolder + "/" : ""}${shown}`;
    this.pathLine.textContent = where;
    this.pathLine.dataset.full = info.path || where;
    this.syncButtons();
    this.draw();
    // A fresh render is the "after"; the reference may have been set since the last run.
    this.wired = info.reference ?? null;
    if (this.wired) this.showReference(this.wired);
    else if (this.compare !== "off") void this.loadReference();
    this.onHeightChange?.();
  }

  // ── Compare ─────────────────────────────────────────────────────────────────

  /** Point the "before" layer at a file. */
  private showReference(ref: MediaRef): void {
    const url = viewUrl(ref);
    if (this.refVideo.src !== url) this.refVideo.src = url;
    this.hasRef = true;
    this.applyCompare();
  }

  /** Fetch whatever the global reference slot currently points at. */
  async loadReference(): Promise<void> {
    // A wired reference wins, so this must never quietly replace it - every caller that
    // asks for a reference (restoring a saved compare mode, cycling C, holding B) comes
    // through here.
    if (this.wired) { this.showReference(this.wired); return; }
    try {
      const r = await api.fetchApi("/nkd/ref/get_video");
      if (!r.ok) { this.hasRef = false; this.applyCompare(); return; }
      this.showReference(await r.json());
      return;
    } catch {
      this.hasRef = false;
    }
    this.applyCompare();
  }

  /** Nominate the render on screen as the reference, so the next run can be wiped
   *  against it. Without this you would have to re-queue the graph through a Reference
   *  node just to nominate the thing you are already looking at. */
  async setAsReference(): Promise<void> {
    if (!this.ref) return;
    try {
      await api.fetchApi("/nkd/ref/set_video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.ref),
      });
      await this.loadReference();
      // The button still sets the GLOBAL slot, which other viewers read - but this one is
      // wired, so nothing here will change. Saying so beats a button that reports success
      // and visibly does nothing.
      this.flash(this.wired ? "set for other viewers (this one is wired)"
        : "reference set");
    } catch {
      this.flash("could not set reference");
    }
  }

  private cycleCompare(): void {
    const next = COMPARE_ORDER[(COMPARE_ORDER.indexOf(this.compare) + 1)
      % COMPARE_ORDER.length];
    this.compare = next;
    // A compare mode with nothing to compare against silently shows the render again,
    // which reads as a dead button - and the two ways to supply a reference are not
    // obvious, so name them both. The global slot only fills when an NKD Reference node
    // actually EXECUTES: running this node on its own (its own ▶) targets only this node,
    // so that branch never runs. Wiring `reference` is the answer in that case.
    const done = () => {
      this.applyCompare();
      if (next !== "off" && !this.hasRef) {
        this.flash("no reference — wire `reference`, or run an NKD Reference node");
      }
    };
    if (next !== "off" && !this.hasRef) void this.loadReference().then(done);
    else done();
    this.pushState();
  }

  private applyCompare(): void {
    const on = this.compare !== "off" && this.hasRef;
    const showing = on || (this.holding && this.hasRef);
    this.refVideo.style.display = showing ? "" : "none";
    this.refVideo.style.mixBlendMode = on && this.compare === "difference"
      ? "difference" : "normal";
    // Holding B shows the reference whole; otherwise the wipe clips it from the right.
    const clip = this.holding || this.compare === "difference"
      ? "none" : `inset(0 ${(1 - this.wipe) * 100}% 0 0)`;
    this.refVideo.style.clipPath = clip;
    this.divider.style.display = on && this.compare === "wipe" && !this.holding ? "" : "none";
    this.divider.style.left = `${this.wipe * 100}%`;
    this.compareBtn.classList.toggle("on", this.compare !== "off");
    (this.compareBtn.firstElementChild as HTMLElement).className =
      this.compare === "difference" ? "pi pi-clone" : "pi pi-arrows-h";
    if (showing) this.syncReference(true);
  }

  /**
   * Keep the reference on the same MOMENT as the current clip.
   *
   * Driven from the main element rather than bound to it: matched by time, corrected only
   * past the drift threshold, and told to play or pause alongside. Seeking it every frame
   * is what would turn a smooth comparison into a slideshow.
   */
  private syncReference(force = false): void {
    if (this.refVideo.style.display === "none" || this.refVideo.readyState < 1) return;
    const t = this.video.currentTime;
    if (force || Math.abs(this.refVideo.currentTime - t) > REF_DRIFT_S) {
      try { this.refVideo.currentTime = t; } catch { /* not seekable yet */ }
    }
    if (this.video.paused && !this.refVideo.paused) this.refVideo.pause();
    else if (!this.video.paused && this.refVideo.paused) {
      this.refVideo.playbackRate = this.video.playbackRate;
      void this.refVideo.play().catch(() => {});
    }
  }

  /**
   * Full screen takes the WHOLE widget, not just the picture.
   *
   * Sending only the stage is what left the transport, the scrub bar and the compare
   * controls behind on the page - a full-screen player you cannot scrub is a wallpaper. The
   * root also carries the key handler, so it has to be focused once it is up or Space and
   * the arrows would go to the page instead.
   */
  private toggleFullscreen(): void {
    if (document.fullscreenElement === this.root) {
      void document.exitFullscreen?.().catch(() => {});
      return;
    }
    void this.root.requestFullscreen?.()
      .then(() => {
        this.root.focus();
        this.draw();                 // the scrub bar has a whole new width to fill
      })
      .catch(() => { /* denied by the browser */ });
  }

  /**
   * Send the viewer to its own window, or bring it back.
   *
   * The `<video>` survives the move but does not keep playing across it, so the position
   * and the play state are carried over by hand - landing back at frame 0 after popping out
   * would lose the shot you were looking at.
   */
  private async togglePopout(): Promise<void> {
    if (this.popout?.isOpen()) {
      this.popout.close();
      this.popout = null;
      return;
    }
    const at = this.video.currentTime;
    const wasPlaying = !this.video.paused;
    const restore = () => {
      this.stripKey = "";              // the strip was built for the old width
      this.want = at;
      this.seeking = false;
      this.applySeek();
      if (wasPlaying) void this.video.play().catch(() => {});
      this.draw();
    };
    this.popout = await openPopout(this.root, "😺NKD Video Viewer", restore);
    if (!this.popout) this.flash("the browser refused a floating window");
  }

  private flash(text: string): void {
    const was = this.pathLine.textContent;
    this.pathLine.textContent = text;
    window.setTimeout(() => { this.pathLine.textContent = was; }, 1200);
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  private get fps(): number { return Math.max(1e-6, this.info?.fps ?? 24); }

  /** Where the playhead IS, or where it is heading while a seek is in flight.
   *
   *  Reading `currentTime` alone made the readout and the playhead lag a drag by however
   *  long the decode took; the pending target is what the user actually asked for. */
  private get frame(): number {
    const t = this.want >= 0 ? this.want : this.video.currentTime;
    return Math.floor(t * this.fps + 1e-4);
  }

  private seekFrame(f: number): void {
    const last = Math.max(0, (this.info?.frame_count ?? 1) - 1);
    const clamped = Math.max(0, Math.min(last, f));
    // Land in the MIDDLE of the frame: exactly on the boundary the decoder can hand back
    // the frame before, which reads as an off-by-one while stepping.
    this.want = (clamped + 0.5) / this.fps;
    this.applySeek();
  }

  /**
   * Ask for the pending time, but only one seek at a time.
   *
   * Assigning `currentTime` on every pointermove is what makes a scrub lag: dozens of
   * requests a second land on an element that can service exactly one, and an h264 seek is
   * expensive. Coalescing means the element always works towards the LATEST position and
   * the intermediate ones are simply dropped - the same trick `media.ts` uses for the
   * timeline, which is why that one scrubs smoothly.
   *
   * Two guards that are not optional:
   * - `readyState < 1`: assigning `currentTime` before metadata is IGNORED silently, so no
   *   `seeked` ever fires. Setting `seeking = true` around that wedges the element for the
   *   rest of the session. `loadedmetadata` retries instead.
   * - the watchdog: one lost `seeked` must not make every later seek short-circuit forever.
   */
  private applySeek(): void {
    if (this.seeking || this.want < 0) return;
    if (this.video.readyState < 1) return;      // loadedmetadata will retry
    this.seeking = true;
    try {
      this.video.currentTime = this.want;
    } catch {
      this.seeking = false;
      return;
    }
    window.clearTimeout(this.guard);
    this.guard = window.setTimeout(() => {
      this.seeking = false;
      this.applySeek();
    }, 2000);
  }

  private step(delta: number): void {
    if (!this.playable) return;
    this.video.pause();
    this.seekFrame(this.frame + delta);
    this.syncButtons();
  }

  private toggle(): void {
    if (!this.playable) return;
    if (this.video.paused) {
      this.video.playbackRate = 1;
      void this.video.play().catch(() => { /* autoplay policy */ });
    } else {
      this.video.pause();
    }
    this.syncButtons();
  }

  /** J and L walk the shuttle speeds. Reverse is not offered: no browser plays a stream
   *  backwards, and faking it with a seek per frame is what makes a preview stutter. */
  private shuttle(dir: 1 | -1): void {
    if (!this.playable) return;
    if (dir < 0) { this.step(-1); return; }
    const i = SHUTTLE.indexOf(this.video.playbackRate);
    this.video.playbackRate = SHUTTLE[Math.min(SHUTTLE.length - 1, i + 1)] ?? 1;
    if (this.video.paused) void this.video.play().catch(() => {});
    this.syncButtons();
  }

  /**
   * Can THIS browser actually play it?
   *
   * Not a property of the file. h265 is patent-encumbered, so browsers ship no software
   * decoder and defer to the GPU: the same mp4 plays here and shows nothing on the next
   * machine. Asking `canPlayType` is the only honest answer, and it costs nothing - so the
   * backend states the codec and this decides.
   */
  private get playable(): boolean {
    // The labeled review copy is always h264/mp4, whatever the main format is — so a
    // ProRes or GIF render still gets a scrubbable viewer while the labels are up.
    if (this.showLabels && this.info?.labeled) {
      return this.video.canPlayType('video/mp4; codecs="avc1.42E01E"') !== "";
    }
    if (this.info?.preview !== "video") return false;
    const mime = this.info.mime;
    if (!mime) return true;
    return this.video.canPlayType(mime) !== "";
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  private pushState(): void {
    this.onState?.({
      loop: this.video.loop, muted: this.video.muted,
      compare: this.compare, wipe: this.wipe, labels: this.showLabels,
    });
  }

  private wire(): void {
    const tick = () => {
      this.draw();
      this.syncReference();
      this.raf = this.video.paused ? 0 : requestAnimationFrame(tick);
    };
    this.video.addEventListener("play", () => {
      // Playing is not seeking: drop any pending target so `frame` reads the live time
      // again, or the readout would freeze on wherever the last scrub left it.
      this.want = -1;
      this.syncButtons();
      if (!this.raf) this.raf = requestAnimationFrame(tick);
    });
    this.video.addEventListener("pause", () => { this.syncButtons(); this.draw(); });
    this.video.addEventListener("seeked", () => {
      window.clearTimeout(this.guard);
      this.seeking = false;
      // A newer position may have been requested while this one was in flight: serve it now.
      if (this.want >= 0 && Math.abs(this.want - this.video.currentTime) > 1e-3) {
        this.applySeek();
      } else {
        this.want = -1;
      }
      this.draw();
      this.syncReference(true);
    });
    this.video.addEventListener("loadedmetadata", () => { this.applySeek(); this.draw(); });

    const at = (e: PointerEvent) => {
      const r = this.scrub.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.seekFrame(Math.round(t * ((this.info?.frame_count ?? 1) - 1)));
      // Repaint straight away rather than waiting for `seeked`: the playhead reads the
      // PENDING position, so it tracks the pointer even while the decode is catching up.
      this.draw();
    };
    this.scrub.addEventListener("pointerdown", (e) => {
      if (!this.playable) return;
      this.dragging = true;
      this.scrub.setPointerCapture(e.pointerId);
      this.video.pause();
      at(e);
    });
    this.scrub.addEventListener("pointermove", (e) => { if (this.dragging) at(e); });
    this.scrub.addEventListener("pointerup", (e) => {
      this.dragging = false;
      this.scrub.releasePointerCapture(e.pointerId);
    });

    // Dragging the divider. On the STAGE, not the divider itself: a 2 px line is a
    // miserable drag target, and grabbing anywhere in the picture is what an A/B slider
    // does anyway.
    let wiping = false;
    const setWipe = (e: PointerEvent) => {
      const r = this.stage.getBoundingClientRect();
      this.wipe = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      this.applyCompare();
    };
    this.stage.addEventListener("pointerdown", (e) => {
      if (this.compare !== "wipe" || !this.hasRef) return;
      wiping = true;
      this.stage.setPointerCapture(e.pointerId);
      setWipe(e);
    });
    this.stage.addEventListener("pointermove", (e) => { if (wiping) setWipe(e); });
    this.stage.addEventListener("pointerup", (e) => {
      if (!wiping) return;
      wiping = false;
      this.stage.releasePointerCapture(e.pointerId);
      this.pushState();
    });

    // Scoped to the focused viewer, so these never steal ComfyUI's global shortcuts.
    this.root.addEventListener("keyup", (e) => {
      if (e.key.toLowerCase() === "b" && this.holding) {
        this.holding = false;
        this.applyCompare();
      }
    });
    this.root.addEventListener("keydown", (e) => {
      const k = e.key.toLowerCase();
      const handled = () => { e.preventDefault(); e.stopPropagation(); };
      // Hold B for "before": the whole reference, for as long as it is held. A flash is
      // how you spot a small change; a wipe is how you place it.
      if (k === "b") {
        if (!e.repeat) {
          if (!this.hasRef) void this.loadReference();
          this.holding = true;
          this.applyCompare();
        }
        handled();
        return;
      }
      if (k === "c") { this.cycleCompare(); handled(); return; }
      if (k === "f") { this.toggleFullscreen(); handled(); return; }
      if (k === " ") { this.toggle(); handled(); }
      else if (k === "arrowleft") { this.step(e.shiftKey ? -10 : -1); handled(); }
      else if (k === "arrowright") { this.step(e.shiftKey ? 10 : 1); handled(); }
      else if (k === "l") { this.shuttle(1); handled(); }
      else if (k === "j") { this.shuttle(-1); handled(); }
      else if (k === "k") { this.video.pause(); this.syncButtons(); handled(); }
      else if (k === "home") { this.seekFrame(0); handled(); }
      else if (k === "end") { this.seekFrame(Number.MAX_SAFE_INTEGER); handled(); }
    });

    // The global reference slot is settled at the END OF THE PROMPT, not when this node
    // runs. NKD Reference and the viewer are both output nodes and nothing orders them, so
    // fetching only from `setSource` regularly read the PREVIOUS run's reference - or none
    // at all on the first run, which reads as "the Reference node never fired".
    api.addEventListener("execution_success", this.onPromptDone);

    new ResizeObserver(() => this.draw()).observe(this.scrub);
    // Leaving full screen by Escape never runs the button's code path, so the repaint has
    // to hang off the event rather than off the toggle.
    document.addEventListener("fullscreenchange", () => {
      this.stripKey = "";            // the strip was built for the other width
      requestAnimationFrame(() => this.draw());
    });
  }

  private syncButtons(): void {
    const icon = this.playBtn.firstElementChild as HTMLElement;
    icon.className = this.video.paused ? "pi pi-play" : "pi pi-pause";
    this.loopBtn.classList.toggle("on", this.video.loop);
    (this.muteBtn.firstElementChild as HTMLElement).className =
      this.video.muted ? "pi pi-volume-off" : "pi pi-volume-up";
    this.muteBtn.classList.toggle("on", this.video.muted);
  }

  // ── Scrub bar ───────────────────────────────────────────────────────────────

  /** Height the widget needs, so the node can wrap around it before anything is measured. */
  estimateHeight(width: number): number {
    const aspect = this.info ? this.info.width / Math.max(1, this.info.height) : 16 / 9;
    return Math.min(Math.round((width - 24) / aspect), PREVIEW_MAX_H) + SCRUB_H + 40;
  }

  /**
   * The filmstrip, rendered once and reused.
   *
   * Rebuilt only when the width, the source or the number of available stills changes -
   * `thumbnailAt` scans the whole strip for every column, so doing this per pointermove was
   * the other half of the scrub lag. The count is in the key because stills arrive
   * progressively: the strip fills in as they land, then stops changing.
   */
  private buildStrip(w: number, dpr: number): HTMLCanvasElement {
    const info = this.info!;
    const duration = info.frame_count / this.fps;
    const step = 48;
    const columns = Math.ceil(w / step);
    // Cheap proxy for "how many stills exist now": sample the columns we are about to draw.
    let have = 0;
    for (let i = 0; i < columns; i++) {
      if (thumbnailAt(this.shown!, ((i + 0.5) / columns) * duration)) have++;
    }
    const key = `${this.shown!.filename}|${Math.round(w)}|${dpr}|${have}`;
    if (key === this.stripKey) return this.strip;
    this.stripKey = key;

    this.strip.width = Math.max(1, Math.round(w * dpr));
    this.strip.height = Math.round(SCRUB_H * dpr);
    const sctx = this.strip.getContext("2d")!;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.fillStyle = "#111318";
    sctx.fillRect(0, 0, w, SCRUB_H);
    for (let x = 0; x < w; x += step) {
      const thumb = thumbnailAt(this.shown!, ((x + step / 2) / w) * duration);
      if (!thumb) continue;
      const tw = Math.min(step, w - x);
      sctx.drawImage(thumb, 0, 0, thumb.width * (tw / step), thumb.height,
        x, 0, tw, SCRUB_H);
    }
    sctx.fillStyle = "rgba(0,0,0,0.35)";
    sctx.fillRect(0, 0, w, SCRUB_H);
    return this.strip;
  }

  draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.scrub.clientWidth || 1;
    if (this.scrub.width !== Math.round(w * dpr)) {
      this.scrub.width = Math.round(w * dpr);
      this.scrub.height = Math.round(SCRUB_H * dpr);
    }
    // The canvas has no CSS height on purpose elsewhere in this pack; here it does, so the
    // buffer is derived from a CONSTANT rather than from clientHeight. Reading back a height
    // that was itself set from the buffer is the feedback loop that spills the widget.
    const ctx = this.scrub.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, SCRUB_H);
    ctx.fillStyle = "#111318";
    ctx.fillRect(0, 0, w, SCRUB_H);

    const info = this.info;
    if (!info) { this.status.textContent = "no video yet"; return; }

    if (this.shown && this.playable) {
      ctx.drawImage(this.buildStrip(w, dpr), 0, 0, w, SCRUB_H);

      const px = (this.frame / Math.max(1, info.frame_count - 1)) * w;
      ctx.fillStyle = "rgba(74,180,255,0.20)";
      ctx.fillRect(0, 0, px, SCRUB_H);
      ctx.fillStyle = "#4ab4ff";
      ctx.fillRect(Math.round(px) - 1, 0, 2, SCRUB_H);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      // Say WHY there is no scrub bar, per format. "Nothing happens when I drag" is the
      // worst possible answer, and both cases are the format's doing, not a missing feature.
      ctx.fillText(info.preview === "image"
        ? `${info.format} — plays, but has no seekable stream`
        : `${info.format} — no browser preview, showing the first frame`,
        w / 2, SCRUB_H / 2 + 4);
      ctx.textAlign = "left";
    }

    const rate = this.video.playbackRate !== 1 && !this.video.paused
      ? ` · ${this.video.playbackRate}x` : "";
    this.status.textContent = this.playable
      ? `f ${this.frame} / ${info.frame_count - 1} · ${info.fps.toFixed(2)} fps · `
        + `${info.width}x${info.height} · ${humanSize(info.size)}${rate}`
      : `${info.frame_count} frames · ${info.width}x${info.height} · ${humanSize(info.size)}`;
  }

  destroy(): void {
    api.removeEventListener("execution_success", this.onPromptDone);
    this.chip.destroy();
    this.labelsChip.destroy();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.video.removeAttribute("src");
    this.video.load();
  }
}
