/**
 * NKD Timeline - the canvas editor.
 *
 * Everything is painted into one 2D canvas (ruler + tracks + playhead) and interaction is
 * resolved by hit-testing. The editor knows nothing about ComfyUI: it talks to the node
 * through `TimelineHost`, which is what lets the same component mount both in the node and
 * in a modal later.
 *
 * SIZING - the timeline canvas gets an EXPLICIT CSS height in px. A canvas with no CSS
 * height falls back to its `height` attribute as intrinsic size, so reading `clientHeight`
 * to compute the backing store makes the two chase each other and the canvas grows without
 * bound on every frame. The preview canvas is the other case: its height is driven by
 * `aspect-ratio`, the pattern proven in NKD Sigmas.
 */
import {
  type Clip, type FitMode, type QuantizeMode, type Timeline,
  QUANTIZE_FREE,
  BLEND_MODES, type BlendMode, type ImportMode,
  clipsAt, cropToRange, effectiveCount, fitRect, materialRange, moveClip, moveClipToLane,
  clampClipsToSources, clipExtent, expandClipsToSources, nativeFpsFor, newId, slotInUse, splitClip,
  trimToPlayhead,
  placementFor, quantizeStops, setTrackBlend, slipClip, snap, snapCandidates,
  MAX_ZOOM, snapFrameToGrid, sortClips, sourceFrame, timelineSpan, trackBlend, trimEnd,
  trimStart, viewWindow, markerFrames, toggleMarker,
} from "./model";
import {
  type MediaInfo, type MediaRef,
  PEAK_BUCKETS, audioBufferFor, ensureAudio, ensureThumbnails,
  pauseAllVideos, peaksFor, pictureAt, setPooledReadyHandler, thumbnailAt,
} from "./media";
import { Transport } from "./player";

export interface TimelineHost {
  getTimeline(): Timeline;
  /** Persist the JSON into the hidden widget and mark the node dirty. */
  commit(): void;
  getFps(): number;
  getStartFrame(): number;
  setStartFrame(v: number): void;
  getFrameCount(): number;
  setFrameCount(v: number): void;
  getQuantize(): QuantizeMode;
  getQuantizeN(): number;
  getOutSize(): [number, number];
  getFit(): FitMode;
  /** Record for the material wired into an Autogrow slot ("video_0"), if resolvable. */
  sourceFor(src: string): { ref: MediaRef; info: MediaInfo | null; label: string } | null;
  /** Autogrow slots that have something connected, by kind. */
  connectedSlots(): {
    videos: string[]; images: string[]; masks: string[]; audios: string[];
  };
  /** Copy fps / width / height into the node's widgets, from `from` when given (used for
   *  the automatic conform on the first connection) or from the first clip otherwise. */
  conformToFirstClip(from?: MediaInfo): void;
  /** Where newly connected sources land. */
  getImportMode(): ImportMode;
  /** User-rebindable key for an action, lower-case. */
  getKey(action: KeyAction, fallback: string): string;
  /** Surface a message in ComfyUI's own toast area. */
  notify(summary: string, detail: string, severity?: "info" | "warn"): void;
  /** Drop every cached view of the connected media and re-resolve from scratch. */
  reloadSources(): void;
  /** Source length in SOURCE frames, or null while unknown. */
  srcFramesFor(src: string): number | null;
}

// NKD palette for the chrome (see the nkd-node skill); the clips themselves follow the
// NLE convention instead - flat blue blocks, no gradients, which is what an editor's eye
// reads as "a clip" and what keeps a dense timeline legible.
const C = {
  bg: "#16181d",
  trackBg: "#1b1e24",
  trackAlt: "#191c21",
  bar: "#1a1c22",
  border: "#3a3d46",
  gridLine: "#0f1114",
  accent: "#4ab4ff",
  text: "#c8d0e0",
  dim: "rgba(255,255,255,0.45)",
  faint: "rgba(255,255,255,0.20)",
  hover: "#ffd166",
  active: "#ff6b6b",
  // Premiere-ish clip colours: one flat fill, a slightly lighter header band, a dark
  // outline. No gradient.
  clipFill: "#1d5673",
  clipHead: "#2a7099",
  clipEdge: "#0e2c3d",
  audioFill: "#1a4a63",
  audioHead: "#246186",
  // The mask lane reads as monochrome, because that is what it produces.
  maskFill: "#3a3f45",
  maskHead: "#565d66",
  clipName: "#e8f2f8",
  // Freeze-frame markers. Green, because every other signal on a clip is already blue
  // (selection), amber (hover/gaps) or red (active drag).
  marker: "#7bd88f",
  markerLine: "rgba(123,216,143,0.55)",
  outside: "rgba(0,0,0,0.55)",
  gap: "rgba(255,209,102,0.07)",
} as const;

const RULER_H = 27;
const IO_BAR_H = 7;                       // in/out bar at the bottom of the ruler
const IO_BAR_TOP = RULER_H - IO_BAR_H;
const IO_GRAB_PX = 7;
const CLIP_HEAD_H = 15;                   // name band inside a clip
const MUTE_BOX = 16;                      // hit box of the per-clip mute toggle
/**
 * Tallest the preview is allowed to get, in logical px.
 *
 * Widening the node must NOT grow the picture. An NLE splits the space the other way: the
 * monitor is a fixed panel and the timeline takes the width. Without a cap, an
 * aspect-driven preview makes the node taller every time you drag it wider - and a
 * portrait clip turns it into a column.
 */
export const PREVIEW_MAX_H = 260;
const TRACK_H = 46;
const MASK_H = 30;
const AUDIO_H = 34;
const MIN_VIDEO_TRACKS = 2;
const MAX_VIDEO_TRACKS = 8;
const HANDLE_PX = 10;      // grab radius of an edge
// Area ratio above which a source is worth warning about. 6x is a bit over 2.4x per
// axis - the point where the decoding a scrub throws away stops being noise. 4K into
// 832x480 is 21x.
const SCALE_WARN_RATIO = 6;
const HANDLE_CORE = 4;     // dead zone in the middle so tiny clips stay movable
const SNAP_PX = 12;
const MIN_LEN = 1;

/** Which lane a clip lives in. Masks get their own because they are composited into the
 *  `mask` output rather than the picture, but they behave identically to drag. */
type Lane = "video" | "mask" | "audio";

/** Actions whose key can be rebound in ComfyUI settings. The transport (space, J/K/L)
 *  and the in/out marks (I/O) are the same in every editor, so they stay fixed. */
export type KeyAction =
  | "trimHead" | "trimTail" | "markIn" | "markOut" | "markClip" | "zoomFit" | "marker"
  | "blade";

type Hit =
  | { kind: "none" }
  | { kind: "ruler" }
  | { kind: "playhead" }
  | { kind: "inPoint" }
  | { kind: "outPoint" }
  | { kind: "mute"; clip: Clip; lane: Lane }
  | { kind: "clip"; clip: Clip; lane: Lane }
  | { kind: "edge"; clip: Clip; side: "start" | "end"; lane: Lane };

type ClipOrigin = { start: number; length: number; trimIn: number; track: number };

type Drag = {
  hit: Hit;
  startX: number;
  before: string;
  origin: ClipOrigin;
  /** Every clip moving in this drag, by id. One entry for a single drag, many for a
   *  group. Snapshots, so each move recomputes from the ORIGINAL state - accumulating
   *  deltas drifts. */
  origins: Map<string, { clip: Clip; from: ClipOrigin }>;
  moved: boolean;
  slip: boolean;
};

export class TimelineEditor {
  private readonly host: TimelineHost;
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly preview: HTMLCanvasElement;
  private readonly pctx: CanvasRenderingContext2D;
  private readonly status: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;
  readonly bar: HTMLDivElement;

  private drag: Drag | null = null;
  private hover: Hit = { kind: "none" };
  private snapping = true;
  private raf = 0;
  private disposed = false;
  private lastTimelineH = 0;
  /** Undo stack of whole JSON snapshots. None of the three reference implementations has
   *  one, and ComfyUI's graph undo does not understand drags inside a canvas. */
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** Ids of the selected clips. A group drag moves all of them together. */
  private selection = new Set<string>();
  private menu: HTMLDivElement | null = null;
  /** Show the mask lane tinted over the picture in the monitor. */
  private maskOverlay = false;
  private maskBtn!: HTMLButtonElement;
  /** Scratch canvas for tinting the mask; reused so playback does not allocate. */
  private readonly tintCanvas = document.createElement("canvas");
  /** Last quantise/fps pair we warned about, so the toast fires on CHANGE only. */
  private lastFpsWarning = "";
  /** Last (sources, output size) pair warned about. See `checkSourceScale`. */
  private lastScaleWarning = ""; 
  readonly transport: Transport;
  /** Called whenever the intrinsic height changes, so the host can resize the node. */
  onHeightChange: (() => void) | null = null;

  constructor(host: TimelineHost) {
    this.host = host;
    this.transport = new Transport({
      getTimeline: () => host.getTimeline(),
      getFps: () => host.getFps(),
      getStartFrame: () => host.getStartFrame(),
      getEndFrame: () => this.host.getStartFrame() + this.effCount(),
      seek: (f) => this.seek(f, true),
      audioRefFor: (src) => host.sourceFor(src)?.ref ?? null,
      srcFpsFor: (src) => host.sourceFor(src)?.info?.fps ?? host.getFps(),
    });
    this.transport.onChange = () => {
      if (this.transport.rate !== 1) pauseAllVideos();
      if (this.transport.rate === 0) this.host.commit();   // persist on stop
      this.requestRender();
    };
    this.root = document.createElement("div");
    this.root.className = "nkd-tl";

    this.preview = document.createElement("canvas");
    this.preview.className = "nkd-tl-preview";
    this.pctx = this.preview.getContext("2d")!;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "nkd-tl-canvas";
    this.ctx = this.canvas.getContext("2d")!;

    this.bar = document.createElement("div");
    this.bar.className = "nkd-tl-bar";
    this.status = document.createElement("span");
    this.status.className = "nkd-tl-status";

    this.buildBar();
    this.root.append(this.preview, this.canvas, this.bar);
    this.applyTimelineHeight();

    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onHover);
    this.canvas.addEventListener("pointerleave", this.onLeave);
    this.canvas.addEventListener("contextmenu", this.onContextMenu);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    // Repaint as soon as a source has a frame to show, rather than waiting for a poll.
    setPooledReadyHandler(() => this.requestRender());
    this.root.addEventListener("keydown", this.onKey);
    this.root.tabIndex = 0;
  }

  // ── Control bar ─────────────────────────────────────────────────────────────

  private buildBar(): void {
    const make = (inner: string, title: string, on: () => void) => {
      const b = document.createElement("button");
      b.className = "nkd-tl-btn";
      b.title = title;
      b.innerHTML = inner;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        on();
        this.requestRender();
      });
      return b;
    };
    // PrimeIcons: ComfyUI already loads the font, so it costs nothing and inherits
    // colour/hover. Never emoji - they ignore `color` and read as stickers.
    const icon = (name: string, title: string, on: () => void) =>
      make(`<i class="pi ${name}"></i>`, title, on);

    /**
     * Material Design Icons, for the handful of meanings PrimeIcons simply does not have
     * - a magnet above all, which is THE symbol for snapping in every editor.
     *
     * ComfyUI loads the MDI font too (verified in the running app: `fonts.check` passes
     * and every name below resolves), but its stylesheet only supplies the `content`, not
     * the `font-family` - so the CSS here sets it. Since this pack ships publicly and
     * another install might not carry MDI, each button keeps a PrimeIcons fallback that
     * swaps in once fonts settle, rather than leaving a tofu box in the bar.
     */
    const mdi = (name: string, fallback: string, title: string, on: () => void) => {
      const b = make(`<i class="mdi ${name}"></i>`, title, on);
      void document.fonts?.ready?.then(() => {
        if (!document.fonts.check(`16px "Material Design Icons"`)) {
          b.innerHTML = `<i class="pi ${fallback}"></i>`;
        }
      }).catch(() => { /* no font API: leave the MDI markup as-is */ });
      return b;
    };
    // In/out are plain brackets. Every icon set draws "sign-in"/"sign-out" as arrows
    // pointing the opposite way to what an editor expects, and `[`/`]` are exactly the
    // marks the ruler shows - monochrome text, inherits currentColor like any icon.
    const bracket = (glyph: string, title: string, on: () => void) =>
      make(`<span class="nkd-tl-brk">${glyph}</span>`, title, on);

    // The icon itself changes with the state, like the per-clip speaker: `magnet-on`
    // draws the attraction lines, so the state reads without relying on colour alone.
    const paintMagnet = () => {
      magnet.classList.toggle("on", this.snapping);
      const i = magnet.querySelector("i");
      if (i?.classList.contains("mdi")) {
        i.className = `mdi ${this.snapping ? "mdi-magnet-on" : "mdi-magnet"}`;
      }
    };
    const magnet = mdi("mdi-magnet-on", "pi-bolt", "Snapping (magnet)", () => {
      this.snapping = !this.snapping;
      paintMagnet();
    });
    magnet.classList.add("on");

    this.playBtn = icon("pi-play", "Play / pause (Space) — J K L to shuttle",
      () => this.transport.toggle());
    this.maskBtn = icon("pi-eye-slash", "Show the mask over the picture (M)",
      () => this.toggleMaskOverlay());

    this.bar.append(
      icon("pi-step-backward", "Reverse (J)", () => this.transport.shuttle(-1)),
      this.playBtn,
      icon("pi-step-forward", "Forward (L)", () => this.transport.shuttle(1)),
      bracket("[", "Mark in point at the playhead (I)", () => this.setIn(this.playhead)),
      bracket("]", "Mark out point at the playhead (O)", () => this.setOut(this.playhead)),
      mdi("mdi-select-all", "pi-clone",
        "Mark clip: fit in/out to the selected clip (X)", () => this.markClip()),
      icon("pi-search-minus", "Zoom out (Ctrl + wheel)",
        () => this.zoomBy(1 / 1.6, this.playhead)),
      icon("pi-search-plus", "Zoom in (Ctrl + wheel)",
        () => this.zoomBy(1.6, this.playhead)),
      mdi("mdi-fit-to-screen", "pi-window-maximize", "Fit the whole timeline (F)",
        () => this.zoomFit()),
      mdi("mdi-arrow-collapse-horizontal", "pi-arrows-h",
        "Fit the range to the material (no gaps, no mask)",
        () => this.trimToMaterial()),
      // Deliberately NOT another horizontal arrow. Its neighbour above is the exact
      // inverse and was already `mdi-arrow-collapse-horizontal` with a `pi-arrows-h`
      // fallback: two adjacent buttons whose fallbacks were the SAME glyph, told apart
      // only by a tooltip. Neko could not find this one, which is the whole review of
      // that idea. Distinct icon, distinct fallback, and the verb first in the tooltip.
      mdi("mdi-arrow-expand-all", "pi-arrows-alt",
        "Show all the material: open the SELECTED clips to their full length "
        + "(all of them if nothing is selected)",
        () => this.expandToSources()),
      mdi("mdi-content-cut", "pi-filter",
        "Crop the material to the in/out range (discards the rest)",
        () => this.cropToInOut()),
      icon("pi-sync", "Conform: take fps and resolution from the first clip",
        () => this.host.conformToFirstClip()),
      magnet,
      this.maskBtn,
      icon("pi-refresh", "Reload the connected media (after changing a file)",
        () => this.reloadSources()),
      icon("pi-undo", "Undo (Ctrl+Z)", () => this.undo()),
      this.status,
    );
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  private get tl(): Timeline { return this.host.getTimeline(); }
  private get playhead(): number { return this.tl.ui.playhead; }

  /** Everything there is to look at, zoom aside. Never 0, or all the maths divides by it. */
  private get contentFrames(): number {
    const span = timelineSpan(this.tl);
    const end = this.host.getStartFrame() + this.effCount();
    return Math.max(24, span, end);
  }

  /** First visible frame. */
  private get viewStart(): number {
    return viewWindow(this.tl.ui, this.contentFrames).start;
  }

  /** How many frames the visible window spans. */
  private get viewFrames(): number {
    return viewWindow(this.tl.ui, this.contentFrames).frames;
  }

  private effCount(): number {
    return effectiveCount(this.tl, this.host.getStartFrame(), this.host.getFrameCount(),
      this.host.getQuantize(), this.host.getQuantizeN());
  }

  private get trackCount(): number {
    let max = MIN_VIDEO_TRACKS;
    for (const c of this.tl.clips) max = Math.max(max, c.track + 1);
    return Math.min(max, MAX_VIDEO_TRACKS);
  }

  /** Intrinsic height of the timeline canvas in logical px. */
  get timelineHeight(): number {
    return RULER_H + this.trackCount * TRACK_H + MASK_H + AUDIO_H;
  }

  /**
   * Pin the canvas height in CSS. Without this the canvas has no CSS height, falls back
   * to its `height` attribute, and `syncSize` reading `clientHeight` to size the backing
   * store makes the two feed each other - the canvas grows every frame and spills far
   * below the node.
   */
  private applyTimelineHeight(): boolean {
    const h = this.timelineHeight;
    if (h === this.lastTimelineH) return false;
    this.lastTimelineH = h;
    this.canvas.style.height = `${h}px`;
    return true;
  }

  private get logicalWidth(): number {
    return Math.max(1, this.canvas.clientWidth);
  }

  private xOf(frame: number): number {
    return ((frame - this.viewStart) / this.viewFrames) * this.logicalWidth;
  }

  private frameOf(x: number): number {
    return Math.round(this.viewStart + (x / this.logicalWidth) * this.viewFrames);
  }

  /** Row for a track. INVERTED on purpose: the highest track number is the topmost
   *  layer, so it must be the topmost ROW too. Drawing track 0 first would put the
   *  bottom layer at the top of the widget and read backwards against every NLE. */
  private trackTop(track: number): number {
    return RULER_H + (this.trackCount - 1 - track) * TRACK_H;
  }

  private trackOf(y: number): number {
    const row = Math.floor((y - RULER_H) / TRACK_H);
    return Math.max(0, Math.min(this.trackCount - 1, this.trackCount - 1 - row));
  }

  private get maskTop(): number {
    return RULER_H + this.trackCount * TRACK_H;
  }

  private get audioTop(): number {
    return this.maskTop + MASK_H;
  }

  private laneOf(lane: Lane): Clip[] {
    return lane === "video" ? this.tl.clips
      : lane === "mask" ? this.tl.masks
      : (this.tl.audio as unknown as Clip[]);
  }

  private laneTop(lane: Lane, track: number): number {
    return lane === "video" ? this.trackTop(track)
      : lane === "mask" ? this.maskTop : this.audioTop;
  }

  private laneHeight(lane: Lane): number {
    return lane === "video" ? TRACK_H : lane === "mask" ? MASK_H : AUDIO_H;
  }

  // ── Hit-testing ─────────────────────────────────────────────────────────────

  private hitTest(x: number, y: number): Hit {
    if (y < RULER_H) {
      // The in/out bar owns the bottom strip of the ruler (the Premiere idiom), so its
      // brackets are grabbable without stealing the whole ruler from scrubbing.
      if (y >= IO_BAR_TOP - 2) {
        const dIn = Math.abs(x - this.xOf(this.host.getStartFrame()));
        const dOut = Math.abs(x - this.xOf(this.host.getStartFrame() + this.effCount()));
        if (Math.min(dIn, dOut) <= IO_GRAB_PX) {
          return dIn <= dOut ? { kind: "inPoint" } : { kind: "outPoint" };
        }
      }
      return Math.abs(x - this.xOf(this.playhead)) <= HANDLE_PX
        ? { kind: "playhead" } : { kind: "ruler" };
    }
    const lane: Lane = y >= this.audioTop ? "audio"
      : y >= this.maskTop ? "mask" : "video";
    const list = lane === "video"
      ? this.tl.clips.filter((c) => c.track === this.trackOf(y))
      : this.laneOf(lane);
    // Back to front: the last one drawn is the visible one, so it answers first.
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const a = this.xOf(c.start);
      const b = this.xOf(c.start + c.length);
      if (x < a - HANDLE_PX || x > b + HANDLE_PX) continue;
      // The mute toggle sits inside the header, so it must be tested BEFORE the edges
      // and the body or it would never be reachable.
      const top = this.laneTop(lane, c.track) + 3;
      if (lane !== "mask" && b - a > 44 && x >= b - MUTE_BOX && x <= b
          && y >= top && y <= top + CLIP_HEAD_H) {
        return { kind: "mute", clip: c, lane };
      }
      if (Math.abs(x - a) <= HANDLE_PX && x - a < (b - a) / 2 - HANDLE_CORE) {
        return { kind: "edge", clip: c, side: "start", lane };
      }
      if (Math.abs(x - b) <= HANDLE_PX && b - x < (b - a) / 2 - HANDLE_CORE) {
        return { kind: "edge", clip: c, side: "end", lane };
      }
      if (x >= a && x <= b) return { kind: "clip", clip: c, lane };
    }
    return { kind: "none" };
  }

  private localPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    // Logical/CSS ratio: the graph canvas is scaled by a transform, so raw clientX is
    // wrong at any zoom other than 1.
    return {
      x: (e.clientX - r.left) * (this.logicalWidth / Math.max(1, r.width)),
      y: (e.clientY - r.top) * (this.timelineHeight / Math.max(1, r.height)),
    };
  }

  // ── Interaction ─────────────────────────────────────────────────────────────

  private onDown = (e: PointerEvent): void => {
    // Middle button pans, as it does in every editor. preventDefault stops Windows from
    // starting its autoscroll cursor on top of us.
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startScroll = this.tl.ui.scroll;
      const move = (m: PointerEvent) => {
        const width = Math.max(1, this.canvas.getBoundingClientRect().width);
        this.tl.ui.scroll = startScroll - ((m.clientX - startX) / width) * this.viewFrames;
        this.clampScroll();
        this.requestRender();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this.host.commit();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    // preventScroll or the wrapper scrolls and hides the control bar.
    this.root.focus({ preventScroll: true });
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);

    if (hit.kind === "mute") {
      this.pushUndo();
      hit.clip.muted = !hit.clip.muted;
      this.host.commit();
      // Re-schedule so the change is audible immediately rather than at the next play.
      if (this.transport.rate === 1) this.transport.refreshAudio();
      this.requestRender();
      return;
    }
    if (hit.kind !== "none") this.pushUndo();
    if (hit.kind === "ruler" || hit.kind === "playhead") this.scrubTo(x);

    const c = hit.kind === "clip" || hit.kind === "edge" ? hit.clip : null;
    const additive = e.ctrlKey || e.metaKey;
    if (c) {
      if (additive) {
        if (this.selection.has(c.id)) this.selection.delete(c.id);
        else this.selection.add(c.id);
      } else if (!this.selection.has(c.id)) {
        this.selection.clear();
        this.selection.add(c.id);
      }
    } else if (hit.kind === "none" && !additive) {
      this.selection.clear();
    }

    // A group drag moves every selected clip; an edge drag is always just the one.
    const origins = new Map<string, { clip: Clip; from: ClipOrigin }>();
    const snapshot = (k: Clip) => ({
      clip: k, from: { start: k.start, length: k.length, trimIn: k.trimIn, track: k.track },
    });
    if (c) {
      if (hit.kind === "clip") {
        for (const lane of [this.tl.clips, this.tl.masks,
                            this.tl.audio as unknown as Clip[]]) {
          for (const k of lane) if (this.selection.has(k.id)) origins.set(k.id, snapshot(k));
        }
      }
      if (!origins.has(c.id)) origins.set(c.id, snapshot(c));
    }

    this.drag = {
      hit, startX: x,
      before: JSON.stringify(this.tl),
      origin: c
        ? { start: c.start, length: c.length, trimIn: c.trimIn, track: c.track }
        : { start: 0, length: 0, trimIn: 0, track: 0 },
      origins,
      moved: false,
      slip: e.altKey,
    };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.requestRender();
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopPropagation();
    const { x, y } = this.localPos(e);
    const d = this.drag;
    d.moved = true;
    // SHIFT snaps to the model's quantisation grid, so a cut can be dropped exactly on a
    // block boundary the model accepts. CTRL is the x0.1 fine drag (the pack convention
    // puts that on Shift, but landing on legal frames matters more on a timeline).
    const gain = e.ctrlKey || e.metaKey ? 0.1 : 1;
    const toGrid = (f: number) => (e.shiftKey
      ? snapFrameToGrid(f, this.host.getStartFrame(), this.host.getQuantize(),
        this.host.getQuantizeN())
      : f);
    const dFrames = Math.round((x - d.startX) * gain / this.logicalWidth * this.viewFrames);

    switch (d.hit.kind) {
      case "ruler":
      case "playhead":
        this.seek(toGrid(this.frameOf(d.startX + (x - d.startX) * gain)));
        break;
      case "inPoint":
      case "outPoint": {
        let frame = toGrid(this.frameOf(d.startX + (x - d.startX) * gain));
        if (this.snapping && !e.shiftKey) {
          const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
          frame = snap(frame, snapCandidates(this.tl), thr);
        }
        if (d.hit.kind === "inPoint") this.applyIn(frame);
        else this.applyOut(frame);
        break;
      }
      case "clip": {
        const c = d.hit.clip;
        const info = this.infoFor(c);
        if (d.slip) {
          c.trimIn = d.origin.trimIn;
          slipClip(c, -dFrames, info?.frame_count ?? 0, info?.fps ?? this.host.getFps(),
            this.host.getFps());
        } else {
          let start = toGrid(d.origin.start + dFrames);
          if (this.snapping && !e.shiftKey) {
            const cands = snapCandidates(this.tl, [this.host.getStartFrame(),
              this.host.getStartFrame() + this.effCount()])
              .filter((v) => v !== c.start && v !== c.start + c.length);
            const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
            // Magnet by BOTH edges: butting the tail up is as common as the head.
            const byHead = snap(start, cands, thr);
            const byTail = snap(start + c.length, cands, thr) - c.length;
            start = Math.abs(byHead - start) <= Math.abs(byTail - start) ? byHead : byTail;
          }
          // Audio clips have no track: passing their undefined `track` through
          // Math.round would write NaN into the model.
          const track = d.hit.lane !== "video" ? 0
            : Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
          const shift = start - d.origin.start;
          const lift = track - d.origin.track;
          // No clip may be pushed off the left edge, so the whole group stops together
          // rather than piling up against zero and losing its relative spacing.
          let allowed = shift;
          for (const { from } of d.origins.values()) {
            allowed = Math.max(allowed, -from.start);
          }
          for (const { clip: k, from } of d.origins.values()) {
            moveClip(k, from.start + allowed,
              k === c || this.tl.clips.includes(k) ? from.track + lift : from.track);
          }
        }
        break;
      }
      case "edge": {
        const c = d.hit.clip;
        const info = this.infoFor(c);
        const fps = this.host.getFps();
        const srcFps = info?.fps ?? fps;
        let frame = toGrid(d.hit.side === "start"
          ? d.origin.start + dFrames
          : d.origin.start + d.origin.length + dFrames);
        if (this.snapping && !e.shiftKey) {
          const thr = (SNAP_PX / this.logicalWidth) * this.viewFrames;
          frame = snap(frame, snapCandidates(this.tl, [this.host.getStartFrame(),
            this.host.getStartFrame() + this.effCount()]), thr);
        }
        // Always from the ORIGINAL state, never accumulating: accumulating drifts.
        c.start = d.origin.start;
        c.length = d.origin.length;
        c.trimIn = d.origin.trimIn;
        if (d.hit.side === "start") trimStart(c, frame, srcFps, fps);
        else trimEnd(c, frame, info?.frame_count ?? 0, srcFps, fps);
        if (c.length < MIN_LEN) c.length = MIN_LEN;
        break;
      }
      default:
        break;
    }
    this.requestRender();
  };

  private onUp = (e: PointerEvent): void => {
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (JSON.stringify(this.tl) === d.before) {
      this.undoStack.pop();   // no actual change: do not pollute the undo stack
    } else {
      sortClips(this.tl);
      this.host.commit();
    }
    this.requestRender();
  };

  private onHover = (e: PointerEvent): void => {
    if (this.drag) return;
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);
    if (hit.kind !== this.hover.kind
        || (hit.kind === "clip" && this.hover.kind === "clip" && hit.clip !== this.hover.clip)) {
      this.hover = hit;
      this.requestRender();
    }
    this.canvas.style.cursor =
      hit.kind === "mute" ? "pointer"
      : hit.kind === "edge" || hit.kind === "inPoint" || hit.kind === "outPoint" ? "ew-resize"
      : hit.kind === "clip" ? (e.altKey ? "col-resize" : "grab")
      : hit.kind === "playhead" ? "grab"
      : hit.kind === "ruler" ? "pointer" : "default";
  };

  /**
   * Right-click menu. Two jobs that both belong to "this clip is not what you assumed":
   * reinterpreting a black-and-white video as a mask, and setting how its track composites.
   */
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = this.localPos(e);
    const hit = this.hitTest(x, y);
    const items: { label: string; on: () => void; active?: boolean }[] = [];

    if (hit.kind === "clip" || hit.kind === "edge") {
      const c = hit.clip;
      if (hit.lane === "video" || hit.lane === "mask") {
        const toMask = hit.lane === "video";
        items.push({
          label: toMask ? "Interpret as mask" : "Interpret as video",
          on: () => {
            this.pushUndo();
            moveClipToLane(this.tl, c, toMask);
            this.host.commit();
          },
        });
      }
      if (c.markers?.length) {
        // A stray marker on a long clip is hard to find and therefore hard to un-toggle.
        items.push({
          label: `Clear ${c.markers.length} marker${c.markers.length > 1 ? "s" : ""}`,
          on: () => {
            this.pushUndo();
            delete c.markers;
            this.host.commit();
          },
        });
      }
      if (hit.lane === "video") {
        // Picture off, sound on: the span becomes a region to generate while its own audio
        // keeps playing. This is what "cut the middle out and refill it" needs, and it
        // avoids inventing an audio lane that points back at a video slot.
        items.push({
          label: c.audioOnly ? "Restore picture" : "Audio only (picture becomes a gap)",
          active: !!c.audioOnly,
          on: () => {
            this.pushUndo();
            if (c.audioOnly) delete c.audioOnly; else c.audioOnly = true;
            this.host.commit();
            this.requestRender();
          },
        });
      }
      items.push({
        label: "Split at playhead",
        on: () => { this.select(c); this.bladeAtPlayhead(); },
      });
      items.push({ label: "Delete", on: () => { this.select(c); this.deleteSelected(); } });
    }

    // Blend applies to the video track under the cursor, so right-clicking empty space in
    // a track still gets you there.
    if (y >= RULER_H && y < this.maskTop) {
      const track = Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
      const current = trackBlend(this.tl, track);
      for (const mode of BLEND_MODES) {
        items.push({
          label: `Track ${track} blend: ${mode}`,
          active: mode === current,
          on: () => {
            this.pushUndo();
            setTrackBlend(this.tl, track, mode as BlendMode);
            this.host.commit();
          },
        });
      }
    }
    if (items.length) this.openMenu(e.clientX, e.clientY, items);
  };

  private openMenu(clientX: number, clientY: number,
                   items: { label: string; on: () => void; active?: boolean }[]): void {
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "nkd-tl-menu";
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;
    for (const it of items) {
      const row = document.createElement("button");
      row.className = "nkd-tl-menu-item";
      row.textContent = it.label;
      if (it.active) row.classList.add("on");
      row.addEventListener("pointerdown", (ev) => {
        // pointerdown, not click: nothing between here and the click can swallow it, and
        // the menu closes on the same gesture that chose the item.
        ev.preventDefault();
        ev.stopPropagation();
        it.on();
        this.closeMenu();
        this.requestRender();
      });
      menu.appendChild(row);
    }
    // Appended to the body, not the node: inside the graph canvas the menu would be
    // clipped by the node box and scaled by the canvas zoom transform.
    document.body.appendChild(menu);
    this.menu = menu;
    setTimeout(() => window.addEventListener("pointerdown", this.closeMenuOnce, true), 0);
  }

  /**
   * Close on a click OUTSIDE the menu.
   *
   * The target check is load-bearing: this listener is on `window` in the CAPTURE phase,
   * so without it a pointerdown on a menu ITEM tears the menu out of the DOM before the
   * item's own `click` ever dispatches - every option silently does nothing.
   */
  private closeMenuOnce = (e: Event): void => {
    if (this.menu && e.target instanceof Node && this.menu.contains(e.target)) return;
    this.closeMenu();
  };

  private closeMenu(): void {
    window.removeEventListener("pointerdown", this.closeMenuOnce, true);
    this.menu?.remove();
    this.menu = null;
  }

  private select(c: Clip): void {
    this.selection.clear();
    this.selection.add(c.id);
  }

  private onLeave = (): void => {
    if (this.drag) return;
    this.hover = { kind: "none" };
    this.requestRender();
  };

  private onKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 10 : 1;
    const key = e.key.toLowerCase();
    // Rebindable first, so a user-chosen key wins over the built-in meaning of the same
    // letter. Premiere puts trim-to-playhead on Q/W; the defaults here are Q/E and both
    // are changeable in Settings -> NKD Timeline.
    const bound = (action: KeyAction, fallback: string) =>
      key === this.host.getKey(action, fallback);
    let handled = true;
    // Shift+M first: M is the marker key in every NLE, so the marker gets the bare letter
    // and the mask overlay - which also has a button - moves up a modifier.
    if (key === "m" && e.shiftKey) this.toggleMaskOverlay();
    else if (bound("marker", "m")) this.toggleMarkerAtPlayhead();
    else if (bound("trimHead", "q")) this.trimEdgeToPlayhead("start");
    else if (bound("trimTail", "e")) this.trimEdgeToPlayhead("end");
    else if (bound("markIn", "i")) this.setIn(this.playhead);
    else if (bound("markOut", "o")) this.setOut(this.playhead);
    else if (bound("markClip", "x")) this.markClip();
    else if (bound("blade", "w")) this.bladeAtPlayhead();
    else if (bound("zoomFit", "f")) this.zoomFit();
    else switch (key) {
      case " ": this.transport.toggle(); break;
      // J K L: the transport every editor has in their fingers, so not rebindable.
      case "j": this.transport.shuttle(-1); break;
      case "k": this.transport.stop(); break;
      case "l": this.transport.shuttle(1); break;
      case "delete":
      case "backspace": this.deleteSelected(); break;
      case "=":
      case "+": this.zoomBy(1.6, this.playhead); break;
      case "-": this.zoomBy(1 / 1.6, this.playhead); break;
      case ",": this.seek(this.playhead - step); break;
      case ".": this.seek(this.playhead + step); break;
      case "home": this.seek(this.host.getStartFrame()); break;
      case "end": this.seek(this.host.getStartFrame() + this.effCount() - 1); break;
      case "z": if (e.ctrlKey || e.metaKey) this.undo(); else handled = false; break;
      case "y": if (e.ctrlKey || e.metaKey) this.redo(); else handled = false; break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      this.requestRender();
    }
  };

  // ── Actions ─────────────────────────────────────────────────────────────────

  private scrubTo(x: number): void {
    this.seek(this.frameOf(x));
  }

  private seek(frame: number, fromTransport = false): void {
    const max = Math.max(0, this.contentFrames - 1);
    this.tl.ui.playhead = Math.max(0, Math.min(max, Math.round(frame)));
    if (fromTransport) {
      // Playback moves the playhead every frame. Serialising the whole timeline into the
      // widget at 60 Hz is pure waste, so just repaint; it is persisted on stop.
      this.requestRender();
      return;
    }
    // A manual scrub during playback wins: let the transport carry on from here instead
    // of snapping back to wherever it had got to.
    if (this.transport.rate !== 0) this.transport.reanchor(this.tl.ui.playhead);
    this.host.commit();
  }

  /** Requested count BEFORE quantising. In/out edits work on this, never on the
   *  quantised result: feeding a quantised value back in would shrink the range a little
   *  on every pointermove and the out point would crawl left as you drag. */
  private rawCount(): number {
    const explicit = this.host.getFrameCount();
    return explicit > 0
      ? explicit
      : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
  }

  private applyIn(frame: number): void {
    const end = this.host.getStartFrame() + this.rawCount();
    const s = Math.max(0, Math.min(Math.round(frame), end - 1));
    this.host.setStartFrame(s);
    this.host.setFrameCount(Math.max(1, end - s));
  }

  private applyOut(frame: number): void {
    const s = this.host.getStartFrame();
    this.host.setFrameCount(Math.max(1, Math.round(frame) - s + 1));
  }

  /**
   * Snap in/out to a clip's own extent - Resolve calls it "mark clip".
   *
   * Uses the selection when there is one, otherwise everything under the playhead, the
   * same rule as the trim keys. Saves squinting at frame numbers to render exactly one
   * shot.
   */
  private markClip(): void {
    const at = clipExtent(this.tl, this.playhead,
      this.selection.size ? this.selection : undefined);
    if (!at) return;
    this.pushUndo();
    this.host.setStartFrame(at.start);
    this.host.setFrameCount(Math.max(1, at.end - at.start));
    this.host.commit();
  }

  /**
   * Drop or lift a freeze-frame marker at the playhead - Resolve's M.
   *
   * With a selection it marks those clips, so a marker can be put on a mask or an audio
   * clip too; with nothing selected it takes the TOPMOST picture clip, which is the one
   * whose frame the monitor is actually showing. Marking every layer under the playhead
   * would be pointless: they all resolve to the same output frame anyway.
   */
  private toggleMarkerAtPlayhead(): void {
    const f = this.playhead;
    let targets: Clip[];
    if (this.selection.size) {
      targets = [this.tl.clips, this.tl.masks, this.tl.audio as unknown as Clip[]]
        .flat().filter((c) => this.selection.has(c.id));
    } else {
      targets = clipsAt(this.tl, f).slice(0, 1);
    }
    this.pushUndo();
    let changed = false;
    for (const c of targets) changed = toggleMarker(c, f) || changed;
    if (!changed) {
      this.undoStack.pop();       // playhead off the clip: leave no empty undo behind
      return;
    }
    this.host.commit();
    this.requestRender();
  }

  private setIn(frame: number): void {
    this.pushUndo();
    this.applyIn(frame);
  }

  private setOut(frame: number): void {
    this.pushUndo();
    this.applyOut(frame);
  }

  /**
   * Crop the output range to the material that actually exists, instead of leaving the
   * empty stretches to come out as gaps in `coverage`. The counterpart to letting a gap
   * BE a region to generate: sometimes you just want the excess gone.
   */
  private trimToMaterial(): void {
    const r = materialRange(this.tl);
    if (!r) return;
    this.pushUndo();
    this.host.setStartFrame(r.start);
    this.host.setFrameCount(Math.max(1, r.end - r.start));
  }

  /** Remove the selected clips. Until now there was no way to take one off at all. */
  private deleteSelected(): void {
    if (this.selection.size === 0) return;
    this.pushUndo();
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      const kept = lane.filter((c) => !this.selection.has(c.id));
      lane.length = 0;
      lane.push(...kept);
    }
    this.selection.clear();
    this.host.commit();
  }

  // -- Zoom and pan ------------------------------------------------------------

  /** Zoom keeping `anchorFrame` under the same pixel. Anything else feels like the
   *  timeline jumps away from whatever you were looking at. */
  private zoomBy(factor: number, anchorFrame: number): void {
    const ui = this.tl.ui;
    const before = viewWindow(ui, this.contentFrames);
    const rel = (anchorFrame - before.start) / before.frames;   // 0..1 across the view
    ui.zoom = Math.min(MAX_ZOOM, Math.max(1, ui.zoom * factor));
    const after = viewWindow(ui, this.contentFrames);
    ui.scroll = anchorFrame - rel * after.frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }

  private panBy(frames: number): void {
    this.tl.ui.scroll += frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }

  /** viewWindow already clamps; store the clamped value so it cannot creep. */
  private clampScroll(): void {
    this.tl.ui.scroll = viewWindow(this.tl.ui, this.contentFrames).start;
  }

  private zoomFit(): void {
    this.tl.ui.zoom = 1;
    this.tl.ui.scroll = 0;
    this.host.commit();
    this.requestRender();
  }

  /**
   * Ctrl/Cmd + wheel zooms; plain and shift wheel pan, as does a trackpad horizontal axis.
   *
   * `{ passive: false }` on the listener is load-bearing: browsers treat wheel listeners
   * as passive by default and then IGNORE preventDefault, so without it Ctrl+wheel zooms
   * the whole PAGE instead of the timeline. stopPropagation is the other half - otherwise
   * the same event reaches ComfyUI graph canvas and zooms the graph underneath.
   */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const { x } = this.localPos(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, this.frameOf(x));
      return;
    }
    // A trackpad reports sideways movement in deltaX; a mouse wheel only has deltaY, so
    // both drive the pan and whichever axis moved more wins.
    const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.panBy((raw / this.logicalWidth) * this.viewFrames);
  };

  /**
   * Throw away whatever falls outside the in/out range. The counterpart to fitting the
   * range to the material: here the range is what you decided, and the material gives.
   */
  private cropToInOut(): void {
    const start = this.host.getStartFrame();
    const end = start + this.effCount();
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = cropToRange(this.tl, start, end, fps,
      (src) => this.host.sourceFor(src)?.info?.fps ?? fps);
    if (!changed) {
      this.undoStack.pop();          // nothing to do: do not leave a no-op undo behind
      return;
    }
    this.selection.clear();          // ids may have gone with the clips
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }

  /**
   * Bring one edge of a clip to the playhead instead of dragging it there.
   *
   * With a selection it acts only on those clips; with nothing selected it takes
   * everything under the playhead, which is the quick way to make a straight cut across
   * picture and sound at once.
   */
  private trimEdgeToPlayhead(side: "start" | "end"): void {
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = trimToPlayhead(this.tl, this.playhead, side, fps,
      (src) => this.host.sourceFor(src)?.info?.fps ?? fps,
      this.selection.size ? this.selection : undefined);
    if (!changed) {
      this.undoStack.pop();      // playhead outside everything: leave no empty undo
      return;
    }
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }

  /**
   * Re-read everything that is connected.
   *
   * A slot pointing at a DIFFERENT file is picked up on its own (the resolved reference
   * changes), but the same filename with new content is invisible from here - overwrite a
   * render and nothing about the graph changes. Hence the button.
   *
   * Clips keep their positions and trims; they are only pulled back inside the new
   * material when it turns out shorter, so swapping a three-minute track for a ten-second
   * one does not leave a clip reading the last frame forever.
   */
  reloadSources(): void {
    this.host.reloadSources();
    this.retightenToSources();
    this.requestRender();
  }

  /**
   * Pull every clip back inside the material it points at, if that material turned out
   * shorter. Idempotent, and it only ever SHORTENS, so it is safe to run on the tick.
   *
   * It has to run there and not just from the reload button: swapping the file in an
   * upstream Load Video is detected automatically, but the new length only arrives when
   * the probe lands a tick or two LATER - and until something re-clamps, the clip is
   * longer than its file, which the backend renders as the last frame repeating.
   */
  /**
   * Open clips out to the whole of their source - the button for "show me everything, I
   * will cut it myself". The counterpart to `retightenToSources`.
   *
   * Acts on the SELECTION when there is one. Expanding everything would also unroll a
   * three-minute audio bed nobody asked about and drag the view out with it, which is the
   * usual reason this button gets pressed once and never again.
   */
  expandToSources(): void {
    const fps = this.host.getFps();
    const ids = this.selection.size ? new Set(this.selection) : undefined;
    this.pushUndo();
    const changed = expandClipsToSources(this.tl, fps,
      (src) => this.host.srcFramesFor(src),
      (src) => this.host.sourceFor(src)?.info?.fps ?? fps,
      ids);
    if (!changed) {
      this.undoStack.pop();       // nothing to expand: leave no empty undo behind
      return;
    }
    this.host.commit();
    this.zoomFit();               // a clip that just grew tenfold is off screen otherwise
    this.requestRender();
  }

  retightenToSources(): boolean {
    const fps = this.host.getFps();
    const before = JSON.stringify(this.tl);
    const changed = clampClipsToSources(this.tl, fps,
      (src) => this.host.srcFramesFor(src),
      (src) => this.host.sourceFor(src)?.info?.fps ?? fps);
    if (!changed || JSON.stringify(this.tl) === before) return false;
    this.pushUndo();
    this.host.commit();
    return true;
  }

  /**
   * Blade at the playhead - the razor every NLE has.
   *
   * Acts on the selection when there is one, otherwise on everything the playhead crosses
   * in every lane, which is the same rule as Q/E and X. Cutting picture and sound in one
   * keystroke is the point: cutting only the topmost clip would desync them.
   */
  private bladeAtPlayhead(): void {
    const fps = this.host.getFps();
    const at = this.playhead;
    const made: Clip[] = [];
    this.pushUndo();
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      // Snapshot: splitting appends to the same array we are walking.
      for (const c of [...lane]) {
        if (this.selection.size && !this.selection.has(c.id)) continue;
        const right = splitClip(c, at, this.rateOf(c), fps);
        if (right) { lane.push(right); made.push(right); }
      }
    }
    if (!made.length) return;      // the playhead was not strictly inside anything
    sortClips(this.tl);
    // Select the right-hand halves: the usual next move is to delete the middle, and this
    // is the piece the user just brought into existence.
    this.selection.clear();
    for (const c of made) this.selection.add(c.id);
    this.host.commit();
    this.requestRender();
  }

  /** Source frame rate for a clip, or the timeline's when it has none of its own. */
  private rateOf(c: Clip): number {
    return this.host.sourceFor(c.src)?.info?.fps ?? this.host.getFps();
  }

  private toggleMaskOverlay(): void {
    this.maskOverlay = !this.maskOverlay;
    this.maskBtn.classList.toggle("on", this.maskOverlay);
    this.maskBtn.innerHTML =
      `<i class="pi ${this.maskOverlay ? "pi-eye" : "pi-eye-slash"}"></i>`;
    this.requestRender();
  }

  /**
   * Warn when the chosen model grid does not match the timeline rate.
   *
   * A frame count on the right grid but at the wrong rate still renders - it just comes
   * out at the wrong speed, which is the kind of mistake you only notice after the run.
   * Only fires for families whose rate ComfyUI core actually documents, and only when the
   * pair CHANGES, so it never nags while you scrub.
   */
  private checkFpsAgainstModel(): void {
    const mode = this.host.getQuantize();
    const want = nativeFpsFor(mode);
    const fps = this.host.getFps();
    const stamp = `${mode}|${fps}`;
    if (stamp === this.lastFpsWarning) return;
    this.lastFpsWarning = stamp;
    if (want === null || Math.abs(want - fps) < 0.01) return;
    this.host.notify(
      "Frame rate does not match the model",
      `${mode.replace(/\s*\(.*\)$/, "")} is trained at ${want} fps, but the timeline `
      + `runs at ${fps}. The frame count will be valid, yet the result will play at the `
      + `wrong speed. Set fps to ${want}, or switch the quantise preset.`,
      "warn");
  }

  /**
   * Warn when the material is far bigger than the output it is being rendered to.
   *
   * A seek costs however many pixels have to be decoded from the last keyframe, and the
   * browser cannot be asked to decode a `<video>` at reduced resolution - that knob simply
   * does not exist. So a 4K source into an 832x480 output decodes 21x the pixels it needs,
   * on every scrub step, per layer, and nothing downstream can claw that back. Measured on
   * exactly that case: two 4K layers spend 85% of wall time inside seeks and the monitor
   * updates ~6 times a second.
   *
   * This is the cheapest possible fix for it: SAY SO. The user can conform the material
   * and get both a usable preview and a much faster render, but only if anyone tells them
   * the ratio, which until now nothing did.
   */
  private checkSourceScale(): void {
    const [ow, oh] = this.host.getOutSize();
    const outPx = Math.max(1, ow * oh);
    let worst: { src: string; w: number; h: number; ratio: number } | null = null;
    const seen = new Set<string>();
    for (const c of [...this.tl.clips, ...this.tl.masks]) {
      if (seen.has(c.src)) continue;
      seen.add(c.src);
      const info = this.host.sourceFor(c.src)?.info;
      if (!info?.width || !info.height) continue;      // tensor, or not probed yet
      const ratio = (info.width * info.height) / outPx;
      if (!worst || ratio > worst.ratio) {
        worst = { src: c.src, w: info.width, h: info.height, ratio };
      }
    }
    // Stamped on the WORST offender and the output size, so it fires once per situation
    // rather than on every repaint - the same discipline as the frame-rate warning.
    const stamp = worst ? `${worst.src}|${worst.w}x${worst.h}|${ow}x${oh}` : "";
    if (stamp === this.lastScaleWarning) return;
    this.lastScaleWarning = stamp;
    if (!worst || worst.ratio < SCALE_WARN_RATIO) return;
    this.host.notify(
      "Material much larger than the output",
      `${worst.src} is ${worst.w}x${worst.h} and this timeline renders ${ow}x${oh} - `
      + `${Math.round(worst.ratio)}x more pixels than needed. The browser cannot decode a `
      + `video at reduced size, so every scrub step pays for all of them: the preview will `
      + `be choppy and each render decodes the same waste. Conforming the source to `
      + `${ow}x${oh} costs nothing in quality here, since the timeline scales it to exactly `
      + `that anyway.`,
      "warn");
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.tl));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private applySnapshot(json: string): void {
    const t = JSON.parse(json);
    const live = this.tl;
    live.clips = t.clips;
    live.audio = t.audio;
    live.ui = t.ui;
    this.host.commit();
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(prev);
    this.requestRender();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(next);
    this.requestRender();
  }

  /** Place a freshly connected slot, following the node's import mode. */
  addClipForSlot(src: string, frames: number, lane: Lane = "video",
                 sync?: { start: number; trimIn: number; length: number }): void {
    // Across ALL lanes, not just this one: a clip moved to the mask lane must not be
    // re-added to the picture lane the next time the slots are synced.
    if (slotInUse(this.tl, src)) return;
    const list = this.laneOf(lane);
    this.pushUndo();
    // Audio never stacks: two takes on separate audio tracks would just both play.
    const mode = lane === "audio" ? "append" : this.host.getImportMode();
    // `sync` lands the clip ON another one instead of wherever the import mode would put
    // it - used when the same FILE is already on the timeline and this is its other half.
    const at = sync ?? placementFor(this.tl, list, mode);
    list.push({
      id: newId(), src,
      track: lane === "video" ? (at as { track?: number }).track ?? 0 : 0,
      start: at.start,
      trimIn: sync ? sync.trimIn : 0,
      length: Math.max(1, Math.round(sync ? sync.length : frames)),
      ...(lane === "audio" ? { gain: 1 } : {}),
    } as Clip);
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }

  /** Drop clips whose slot no longer has anything connected. Returns true if it changed
   *  anything, so the caller knows whether to commit. */
  pruneToSlots(live: Set<string>): boolean {
    let changed = false;
    for (const lane of [this.tl.clips, this.tl.masks,
                        this.tl.audio as unknown as Clip[]]) {
      const kept = lane.filter((c) => live.has(c.src));
      if (kept.length !== lane.length) {
        lane.length = 0;
        lane.push(...kept);
        changed = true;
      }
    }
    return changed;
  }

  private infoFor(c: Clip): MediaInfo | null {
    return this.host.sourceFor(c.src)?.info ?? null;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  requestRender(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /**
   * Size the backing store for a known LOGICAL height. The logical height is passed in,
   * never read back from the element, so there is no feedback loop.
   */
  private syncSize(cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
                    logicalH: number): boolean {
    const w = cv.clientWidth;
    if (w < 1 || logicalH < 1) return false;
    // HiDPI plus graph zoom: without ds.scale the canvas is blurry when zoomed in.
    const graphScale = (window as any).app?.canvas?.ds?.scale ?? 1;
    const s = Math.max(1, window.devicePixelRatio || 1) * Math.max(1, graphScale);
    const bw = Math.round(w * s);
    const bh = Math.round(logicalH * s);
    if (cv.width !== bw || cv.height !== bh) {
      cv.width = bw;
      cv.height = bh;
    }
    ctx.setTransform(bw / w, 0, 0, bh / logicalH, 0, 0);
    return true;
  }

  render(): void {
    if (this.disposed) return;
    // A new track changes the intrinsic height: repin the CSS and tell the host to resize
    // the node, or the extra track would spill below the node frame.
    if (this.applyTimelineHeight()) this.onHeightChange?.();
    this.drawPreview();
    if (!this.syncSize(this.canvas, this.ctx, this.timelineHeight)) return;

    const ctx = this.ctx;
    const W = this.logicalWidth;
    const H = this.timelineHeight;
    const fps = this.host.getFps();
    const start = this.host.getStartFrame();
    const count = this.effCount();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    this.drawRuler(ctx, W, fps);

    // Track lanes: flat alternating rows separated by a dark hairline, the way an NLE
    // reads. Video tracks are drawn top-down but numbered bottom-up in an NLE; here the
    // higher index still sits on top, which is what the compositing order means.
    for (let t = 0; t < this.trackCount; t++) {
      const y = this.trackTop(t);   // already inverted: higher track, higher row
      ctx.fillStyle = t % 2 ? C.trackAlt : C.trackBg;
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, y, W, 1);
      // A non-normal blend changes what you get, so it must never be invisible.
      const blend = trackBlend(this.tl, t);
      if (blend !== "normal") {
        ctx.fillStyle = C.hover;
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText(blend, W - 4, y + 3);
        ctx.textAlign = "left";
      }
    }
    for (const [top, h] of [[this.maskTop, MASK_H], [this.audioTop, AUDIO_H]] as const) {
      ctx.fillStyle = C.trackAlt;
      ctx.fillRect(0, top, W, h);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, top, W, 1);
    }

    this.drawGaps(ctx, start, count);

    for (const c of this.tl.clips) this.drawClip(ctx, c, "video");
    for (const m of this.tl.masks) this.drawClip(ctx, m, "mask");
    for (const a of this.tl.audio as unknown as Clip[]) this.drawClip(ctx, a, "audio");

    this.drawOutside(ctx, W, H, start, count);
    this.drawPlayhead(ctx, H);
    this.updateStatus(fps, count);
    this.checkFpsAgainstModel();
    this.checkSourceScale();
  }

  private drawRuler(ctx: CanvasRenderingContext2D, W: number, fps: number): void {
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, 0, W, RULER_H);

    // Step ladder: the first step leaving >=60px between marks wins.
    const steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920, 4800];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if ((s / this.viewFrames) * W >= 60) { step = s; break; }
    }
    ctx.strokeStyle = C.faint;
    ctx.fillStyle = C.dim;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    const from = Math.floor(this.viewStart / step) * step;
    for (let f = from; f <= this.viewStart + this.viewFrames; f += step) {
      const x = Math.round(this.xOf(f)) + 0.5;
      if (x < -40 || x > W + 40) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 6);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      const secs = f / (fps || 1);
      const label = step >= 24
        ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`
        : String(f);
      ctx.fillText(label, x + 3, RULER_H / 2 - 1);
    }

    // Valid quantise stops, measured FROM start_frame: these are the only end points the
    // model will accept. Seeing them beats finding out when the sampler blows up.
    const mode = this.host.getQuantize();
    if (mode !== QUANTIZE_FREE) {
      const start = this.host.getStartFrame();
      ctx.strokeStyle = "rgba(74,180,255,0.55)";
      for (const s of quantizeStops(this.contentFrames - start, mode,
                                    this.host.getQuantizeN())) {
        const x = Math.round(this.xOf(start + s)) + 0.5;
        if (x < 0 || x > W) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 5);
        ctx.stroke();
      }
    }

    this.drawInOutBar(ctx, W);
  }

  /**
   * The in/out range as a draggable bar along the bottom of the ruler, with `[` and `]`
   * brackets as the grab handles - the same idiom as an NLE's work-area bar, so the range
   * can be set by dragging instead of only from the buttons.
   */
  private drawInOutBar(ctx: CanvasRenderingContext2D, W: number): void {
    const a = this.xOf(this.host.getStartFrame());
    const b = this.xOf(this.host.getStartFrame() + this.effCount());
    const y = IO_BAR_TOP;

    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, y, W, IO_BAR_H);
    ctx.fillStyle = this.host.getQuantize() === QUANTIZE_FREE
      ? "rgba(74,180,255,0.85)" : "rgba(255,209,102,0.85)";
    ctx.fillRect(a, y, Math.max(1, b - a), IO_BAR_H);

    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const drawBracket = (x: number, glyph: string, hot: boolean) => {
      ctx.fillStyle = hot ? C.hover : "#f2f6fa";
      ctx.textAlign = glyph === "[" ? "left" : "right";
      ctx.fillText(glyph, glyph === "[" ? x - 1 : x + 1, y + IO_BAR_H / 2);
    };
    const dragging = this.drag?.hit.kind;
    drawBracket(a, "[", this.hover.kind === "inPoint" || dragging === "inPoint");
    drawBracket(b, "]", this.hover.kind === "outPoint" || dragging === "outPoint");
    ctx.textAlign = "left";
  }

  /**
   * Amber shading over the stretches with NO material inside the output range.
   *
   * By merged intervals, not frame by frame: a 10 000 frame timeline would mean 10 000
   * iterations (each filtering and sorting every clip) on EVERY render and the scrub would
   * stutter. Merging the covered spans and inverting them is O(C log C).
   */
  private drawGaps(ctx: CanvasRenderingContext2D, start: number, count: number): void {
    const top = RULER_H;
    const h = this.trackCount * TRACK_H;
    const end = start + count;
    const spans = this.tl.clips
      // An `audioOnly` clip contributes sound and NO picture, so its span is a region to
      // generate - which is exactly what the backend does (nkd_timeline.py, the `audioOnly`
      // branch skips writing pixels). Counting it as material here made the editor lie
      // about the one thing that flag exists to do.
      .filter((c) => !c.audioOnly)
      .map((c) => [Math.max(c.start, start), Math.min(c.start + c.length, end)] as const)
      .filter(([a, b]) => b > a)
      .sort((p, q) => p[0] - q[0]);

    let cursor = start;
    const paint = (a: number, b: number) => {
      if (b <= a) return;
      const xa = this.xOf(a);
      const xb = this.xOf(b);
      ctx.fillStyle = C.gap;
      ctx.fillRect(xa, top, xb - xa, h);
      if (xb - xa > 46) {
        ctx.fillStyle = "rgba(255,209,102,0.6)";
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("generate", (xa + xb) / 2, top + h / 2);
        ctx.textAlign = "left";
      }
    };
    for (const [a, b] of spans) {
      if (a > cursor) paint(cursor, a);
      cursor = Math.max(cursor, b);
    }
    paint(cursor, end);
  }

  private drawClip(ctx: CanvasRenderingContext2D, c: Clip, lane: Lane): void {
    const x = this.xOf(c.start);
    const w = Math.max(2, this.xOf(c.start + c.length) - x);
    const y = this.laneTop(lane, c.track) + 3;
    const h = this.laneHeight(lane) - 6;
    const isHover = (this.hover.kind === "clip" || this.hover.kind === "edge")
      && this.hover.clip === c;
    const isDrag = this.drag
      && (this.drag.hit.kind === "clip" || this.drag.hit.kind === "edge")
      && this.drag.hit.clip === c;

    ctx.save();
    ctx.beginPath();
    // Barely-rounded corners and a FLAT fill: an NLE clip is a solid block, and a
    // gradient on every clip turns a dense timeline into mush.
    ctx.roundRect(x, y, w, h, 2);
    // An `audioOnly` clip BEHAVES like an audio clip - it contributes sound and its picture
    // is a hole - so it reads like one, whichever lane it happens to sit on.
    const soundOnly = !!c.audioOnly && lane !== "audio";
    ctx.fillStyle = lane === "audio" || soundOnly ? C.audioFill
      : lane === "mask" ? C.maskFill : C.clipFill;
    ctx.fill();
    ctx.clip();

    // Header band carrying the name, like Premiere's clip label strip. A selected clip
    // gets the accent band: selection has to be visible while the cursor is ON the clip,
    // which is exactly when you are about to act on it.
    const selected = this.selection.has(c.id);
    if (h > CLIP_HEAD_H + 4) {
      ctx.fillStyle = selected ? C.accent
        : lane === "audio" || soundOnly ? C.audioHead
        : lane === "mask" ? C.maskHead : C.clipHead;
      ctx.fillRect(x, y, w, CLIP_HEAD_H);
    }

    const src = this.host.sourceFor(c.src);
    const body = y + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    const bodyH = y + h - body;
    if (src && bodyH > 6) {
      // The waveform is what this clip actually contributes, so it replaces the filmstrip.
      // A video clip's trimIn counts SOURCE frames, so the wave needs the SOURCE rate.
      if (lane === "audio") {
        this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH, this.host.getFps());
      } else if (soundOnly) {
        this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH,
          src.info?.fps || this.host.getFps());
      } else if (src.info) {
        this.drawFilmstrip(ctx, c, src.ref, src.info, x, body, w, bodyH);
      }
    }
    // Diagonal hatch over the body: "the picture here is a hole", the same thing the amber
    // `generate` wash says about the track underneath.
    if (soundOnly) this.drawHatch(ctx, x, y, w, h);

    if (w > 26) {
      ctx.fillStyle = selected ? "#0d1b24" : src ? C.clipName : C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      // The colour and the hatch carry the signal at any width; the word is what makes it
      // unambiguous, so it only shows when there is room to spare beside the name.
      const label = (src?.label ?? `${c.src} (no source)`)
        + (soundOnly && w > 150 ? "  ·  audio only" : "");
      ctx.fillText(this.ellipsise(ctx, label, w - 12), x + 5, y + CLIP_HEAD_H / 2);
    }
    // Frame-rate warning: without it the resampling happens silently.
    const info = src?.info;
    const fps = this.host.getFps();
    ctx.textBaseline = "alphabetic";
    if (info && Math.abs(info.fps - fps) > 0.01 && w > 66) {
      ctx.fillStyle = C.hover;
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText(`${info.fps.toFixed(2)} → ${fps.toFixed(2)} fps`, x + 5, y + h - 5);
    } else if (!info && src && w > 66) {
      ctx.fillStyle = C.faint;
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText("probing…", x + 5, y + h - 5);
    }
    if (lane !== "mask" && w > 44 && h > CLIP_HEAD_H) {
      this.drawSpeaker(ctx, x + w - MUTE_BOX, y, !!c.muted, isHover);
    }
    this.drawMarkers(ctx, c, y, h);
    // Plus a wash over the body, the way an NLE marks a selection.
    if (selected) {
      ctx.fillStyle = "rgba(74,180,255,0.16)";
      ctx.fillRect(x, y, w, h);
    }
    // Trim handles only show on hover - permanent ones are visual noise on every clip.
    if (isHover && w > 14) {
      ctx.fillStyle = C.hover;
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
    }
    ctx.restore();

    // Outline last, unclipped, so it is not shaved to half a pixel by the clip region.
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2);
    // Priority: dragging > SELECTED > hover. Letting hover win made the selection vanish
    // the moment the pointer was over the very clip you had just picked.
    ctx.strokeStyle = isDrag ? C.active
      : selected ? C.accent
      : isHover ? C.hover : C.clipEdge;
    ctx.lineWidth = isDrag || selected || isHover ? 2 : 1;
    ctx.stroke();
  }

  /**
   * Freeze-frame markers: a pennant on the clip's head band plus a hairline down the body,
   * so a marked frame is findable at any zoom without hunting for a 1px tick.
   *
   * Called from inside `drawClip`'s clip region, so a marker never bleeds past its clip.
   */
  private drawMarkers(ctx: CanvasRenderingContext2D, c: Clip, y: number, h: number): void {
    if (!c.markers?.length) return;
    const head = h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : h;
    for (const m of c.markers) {
      const mx = Math.round(this.xOf(c.start + m)) + 0.5;
      ctx.fillStyle = C.markerLine;
      ctx.fillRect(mx, y + head, 1, h - head);
      ctx.fillStyle = C.marker;
      ctx.beginPath();
      ctx.moveTo(mx - 4, y);
      ctx.lineTo(mx + 4, y);
      ctx.lineTo(mx, y + Math.min(7, head));
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Tile stills along the clip so you can read the shot without playing it.
   *
   * Each tile shows the frame at ITS OWN position in the source, honouring trimIn and the
   * timeline/source rate difference - so trimming or slipping the clip re-reads the strip
   * and you see the change immediately.
   */
  private drawFilmstrip(ctx: CanvasRenderingContext2D, c: Clip, ref: MediaRef,
                        info: MediaInfo, x: number, y: number, w: number, h: number): void {
    ensureThumbnails(ref, info, () => this.requestRender());
    const probe = thumbnailAt(ref, 0);
    if (!probe) return;
    const tileW = Math.max(8, (probe.width / probe.height) * h);
    const fps = this.host.getFps();
    const srcFps = info.fps || fps;
    ctx.globalAlpha = 0.95;
    for (let tx = x; tx < x + w; tx += tileW) {
      // Which timeline frame this tile sits on, then which source second that is.
      const f = c.start + ((tx - x) / Math.max(1, w)) * c.length;
      const still = thumbnailAt(ref, sourceFrame(c, f, srcFps, fps) / (srcFps || 1));
      if (!still) break;
      ctx.drawImage(still, tx, y, Math.min(tileW, x + w - tx), h);
    }
    ctx.globalAlpha = 1;
  }

  /** Peaks across the clip's own trimmed span, so trimming re-reads the wave. */
  /**
   * @param trimRate  fps that `c.trimIn` is counted in. An audio clip trims in TIMELINE
   *   frames, a video clip in SOURCE frames - passing the timeline rate for a video whose
   *   source runs at another cadence slides the whole wave off the picture it belongs to.
   */
  private drawWaveform(ctx: CanvasRenderingContext2D, c: Clip, ref: MediaRef,
                       x: number, y: number, w: number, h: number,
                       trimRate: number): void {
    ensureAudio(ref, () => this.requestRender());
    const peaks = peaksFor(ref);
    const buf = audioBufferFor(ref);
    if (!peaks || !buf) return;
    // Scale from the DECODED DURATION, not from a probed frame count: an audio file has
    // no video stream, so the probe never returns one and the wave would be drawn against
    // the bucket count instead of against real time.
    const total = Math.max(1e-6, buf.duration);
    const from = c.trimIn / Math.max(1, trimRate) / total;
    const to = from + c.length / this.host.getFps() / total;
    const mid = y + h / 2;
    ctx.fillStyle = "rgba(150,215,255,0.85)";
    for (let px = 0; px < w; px++) {
      const t = from + (to - from) * (px / Math.max(1, w));
      const peak = peaks[Math.max(0, Math.min(PEAK_BUCKETS - 1,
        Math.round(t * (PEAK_BUCKETS - 1))))];
      if (!peak) continue;
      const half = Math.max(0.5, (peak * h) / 2);
      ctx.fillRect(x + px, mid - half, 1, half * 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x, mid, w, 1);
  }

  /** Amber diagonals, the same colour the `generate` wash uses: this stretch produces no
   *  picture. Called inside `drawClip`'s clip region, so it never bleeds past the block. */
  private drawHatch(ctx: CanvasRenderingContext2D, x: number, y: number,
                    w: number, h: number): void {
    const step = 8;
    ctx.save();
    ctx.strokeStyle = "rgba(255,209,102,0.22)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -h; i < w; i += step) {
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawSpeaker(ctx: CanvasRenderingContext2D, x: number, y: number,
                      muted: boolean, hot: boolean): void {
    const s = MUTE_BOX;
    const cx = x + s / 2;
    const cy = y + CLIP_HEAD_H / 2;
    ctx.save();
    ctx.strokeStyle = muted ? C.active : hot ? C.hover : "rgba(255,255,255,0.75)";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    // Cone: a small box plus a triangle opening to the right.
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy - 2);
    ctx.lineTo(cx - 2, cy - 2);
    ctx.lineTo(cx + 1, cy - 5);
    ctx.lineTo(cx + 1, cy + 5);
    ctx.lineTo(cx - 2, cy + 2);
    ctx.lineTo(cx - 4, cy + 2);
    ctx.closePath();
    ctx.fill();
    if (muted) {
      ctx.beginPath();               // struck through when silent
      ctx.moveTo(cx - 5, cy + 5);
      ctx.lineTo(cx + 5, cy - 5);
      ctx.stroke();
    } else {
      ctx.beginPath();               // one arc is enough at this size
      ctx.arc(cx + 2, cy, 4, -0.9, 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Truncate to fit, with an ellipsis - a name spilling out of its clip reads as a bug. */
  private ellipsise(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : "";
  }

  /** Dim whatever falls outside [start_frame, start_frame+count). */
  private drawOutside(ctx: CanvasRenderingContext2D, W: number, H: number,
                       start: number, count: number): void {
    const a = this.xOf(start);
    const b = this.xOf(start + count);
    ctx.fillStyle = C.outside;
    if (a > 0) ctx.fillRect(0, RULER_H, a, H - RULER_H);
    if (b < W) ctx.fillRect(b, RULER_H, W - b, H - RULER_H);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1;
    for (const x of [a, b]) {
      const px = Math.round(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(px, RULER_H);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }

  private drawPlayhead(ctx: CanvasRenderingContext2D, H: number): void {
    const x = Math.round(this.xOf(this.playhead)) + 0.5;
    ctx.strokeStyle = C.active;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = C.active;
    ctx.beginPath();
    ctx.moveTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Top pane: the frame under the playhead, composed EXACTLY as the backend will compose
   * it - the canvas is the output frame, and `fit` is applied live. Changing contain /
   * cover / stretch is visible immediately instead of only after a run.
   */
  private drawPreview(): void {
    const [ow, oh] = this.host.getOutSize();
    // aspect-ratio drives the height (the proven NKD Sigmas pattern); the widget height
    // formula resolves the same number, so node and content agree by construction.
    // max-width caps it by HEIGHT (width = maxH x aspect), and `margin: 0 auto` in the
    // stylesheet centres it, so extra node width goes to the timeline instead.
    this.preview.style.aspectRatio = `${Math.max(1, ow)} / ${Math.max(1, oh)}`;
    this.preview.style.maxWidth =
      `${Math.round(PREVIEW_MAX_H * (Math.max(1, ow) / Math.max(1, oh)))}px`;
    const h = this.preview.clientHeight;
    if (!this.syncSize(this.preview, this.pctx, h)) return;
    const w = this.preview.clientWidth;
    const ctx = this.pctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // BOTTOM-UP through every covering clip, applying each track's blend. That is the
    // whole point of stacking: with `difference`, two versions of a shot cancel to black
    // wherever they agree. `globalCompositeOperation` names map 1:1 onto the backend's
    // maths, so this preview IS the composite, not an impression of it.
    const stack = clipsAt(this.tl, this.playhead).reverse();
    if (stack.length === 0) {
      ctx.fillStyle = C.dim;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("gap — region to generate", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);   // cover overflows the frame; the backend crops, so do we
    ctx.clip();
    let painted = false;
    for (const clip of stack) {
      const src = this.host.sourceFor(clip.src);
      if (!src) continue;
      const srcFps = src.info?.fps ?? this.host.getFps();
      const sf = sourceFrame(clip, this.playhead, srcFps, this.host.getFps());
      const at = sf / (srcFps || 1);
      // Forward at 1x: let it play. Anything else (scrub, shuttle, reverse) seeks.
      const img = pictureAt(src.ref, at, this.transport.rate === 1);
      if (!img) continue;
      const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLCanvasElement).width;
      const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLCanvasElement).height;
      if (!iw || !ih) continue;
      const r = fitRect(iw, ih, w, h, this.host.getFit());
      const blend = trackBlend(this.tl, clip.track);
      // The lowest layer always draws straight: blending against the initial black would
      // make `multiply` erase it. Same rule the backend applies.
      ctx.globalCompositeOperation = painted && blend !== "normal"
        ? (blend as GlobalCompositeOperation) : "source-over";
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      painted = true;
    }
    if (this.maskOverlay) this.drawMaskOverlay(ctx, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
  }

  /**
   * Tint the mask lane over the picture, so what the mask actually covers is visible
   * without wiring a preview node.
   *
   * The mask is drawn to a scratch canvas and multiplied with red - black stays black,
   * white becomes red - then screened over the monitor, so it lights up the covered area
   * and leaves the rest alone.
   *
   * Only file-backed mask clips can be shown: a MASK arriving as a tensor from another
   * node has no file for the browser to read. That is the same limit as clip lengths, and
   * the execute-time metadata push is what lifts it.
   */
  private drawMaskOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const top = this.tl.masks
      .filter((c) => this.playhead >= c.start && this.playhead < c.start + c.length)
      .sort((a, b) => b.track - a.track)[0];
    if (!top) return;
    const src = this.host.sourceFor(top.src);
    if (!src) return;
    const srcFps = src.info?.fps ?? this.host.getFps();
    const at = sourceFrame(top, this.playhead, srcFps, this.host.getFps()) / (srcFps || 1);
    const img = pictureAt(src.ref, at, false);
    if (!img) return;
    const iw = (img as HTMLVideoElement).videoWidth || (img as HTMLCanvasElement).width;
    const ih = (img as HTMLVideoElement).videoHeight || (img as HTMLCanvasElement).height;
    if (!iw || !ih) return;

    const tc = this.tintCanvas;
    if (tc.width !== Math.round(w) || tc.height !== Math.round(h)) {
      tc.width = Math.max(1, Math.round(w));
      tc.height = Math.max(1, Math.round(h));
    }
    const tctx = tc.getContext("2d")!;
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, tc.width, tc.height);
    tctx.fillStyle = "#000";
    tctx.fillRect(0, 0, tc.width, tc.height);
    const r = fitRect(iw, ih, tc.width, tc.height, this.host.getFit());
    tctx.drawImage(img, r.x, r.y, r.w, r.h);
    tctx.globalCompositeOperation = "multiply";   // white -> red, black stays black
    tctx.fillStyle = "#ff3b30";
    tctx.fillRect(0, 0, tc.width, tc.height);
    tctx.globalCompositeOperation = "source-over";

    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.65;
    ctx.drawImage(tc, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  private updateStatus(fps: number, count: number): void {
    const rate = this.transport.rate;
    this.playBtn.innerHTML = `<i class="pi ${rate === 0 ? "pi-play" : "pi-pause"}"></i>`;
    this.playBtn.classList.toggle("on", rate !== 0);
    const secs = count / (fps || 1);
    const mode = this.host.getQuantize();
    const raw = this.host.getFrameCount() > 0
      ? this.host.getFrameCount()
      : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
    const q = mode !== QUANTIZE_FREE && raw !== count ? ` (${raw}→${count})` : "";
    const shuttle = Math.abs(rate) > 1 || rate < 0 ? ` · ${rate > 0 ? "" : "-"}${Math.abs(rate)}x` : "";
    const sel = this.selection.size ? ` · ${this.selection.size} selected` : "";
    // Markers only count once they land inside the rendered range - the same filter the
    // backend applies - so the readout matches the string that comes out of the node.
    const start = this.host.getStartFrame();
    const marks = markerFrames(this.tl)
      .filter((f) => f >= start && f < start + count).length;
    const mk = marks ? ` · ${marks} marker${marks > 1 ? "s" : ""}` : "";
    this.status.textContent =
      `f ${this.playhead}${shuttle}${sel}${mk} · ${count} frames${q} · ${secs.toFixed(2)}s @ ${fps} fps`;
  }

  destroy(): void {
    this.disposed = true;
    this.closeMenu();
    this.transport.destroy();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onHover);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.root.removeEventListener("keydown", this.onKey);
    this.root.remove();
  }
}
