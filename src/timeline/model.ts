/**
 * NKD Timeline - data model and frame maths.
 *
 * PURE module: no DOM, no ComfyUI, no canvas. Everything that can go wrong silently lives
 * here so `tests/timeline_model.mjs` can exercise it under plain node.
 *
 * ALGORITHM PARITY - `quantizeCount`, `quantizeStops` and `sourceFrame` must behave
 * EXACTLY like `quantize_count`, `quantize_stops` and `source_frame` in `nkd_timeline.py`,
 * and QUANTIZE_MODES must match its list string for string (the combo value is what gets
 * serialised and sent to the backend). Touch one, touch the other: a divergence here means
 * the editor's ruler lies about what the backend will render, which is the worst class of
 * bug this tool can have.
 */

export type Clip = {
  id: string;
  src: string;      // "video_0" - the Autogrow slot key
  track: number;    // higher track sits on top, and is drawn on a HIGHER row
  start: number;    // frame on the timeline
  trimIn: number;   // frame inside the source
  length: number;   // duration in timeline frames
  /** Silences this clip's own audio. Only meaningful where there is any. */
  muted?: boolean;
  /**
   * Freeze-frame markers, as offsets from `start` in TIMELINE frames, sorted and unique.
   *
   * Anchored to the CLIP, not to the timeline: the point of a marker is "this exact frame
   * of this material", so moving the clip carries them along and the frozen picture does
   * not change. Trimming and slipping adjust them for the same reason - see
   * `shiftMarkers`/`pruneMarkers`.
   */
  markers?: number[];
};

export type AudioClip = {
  id: string;
  src: string;      // "audio_0"
  start: number;
  trimIn: number;
  length: number;
  gain: number;
  muted?: boolean;
};

/** `zoom` is how many times the content extent is magnified (1 = everything fits).
 *  `scroll` is the first visible frame. Both persist, so a workflow reopens where it was. */
export type TimelineUI = { zoom: number; scroll: number; playhead: number };

const int = (v: unknown, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const MAX_ZOOM = 400;

/** Visible window, given the full content extent. Clamped so the view can never sit
 *  outside the content or magnify past MAX_ZOOM. */
export function viewWindow(ui: TimelineUI, contentFrames: number):
    { start: number; frames: number } {
  // Coerce through a finite check, NOT `ui.zoom || 1`: a non-numeric string is truthy, so
  // `||` lets it through and `Math.max(1, "x")` is NaN - which would then poison every
  // frame-to-pixel mapping in the editor.
  const zoom = Math.min(MAX_ZOOM, Math.max(1, num(ui.zoom, 1)));
  const content = Math.max(2, num(contentFrames, 2));
  const frames = Math.max(2, content / zoom);
  const start = Math.max(0, Math.min(num(ui.scroll, 0), content - frames));
  return { start, frames };
}

/**
 * How a track composites onto what is already under it.
 *
 * These four are exactly the ones a canvas can do natively via
 * `globalCompositeOperation`, so the preview shows the real result rather than an
 * approximation of it. `difference` is the one that earns its place: stack a before and an
 * after and anything non-black is what changed.
 */
export const BLEND_MODES = ["normal", "screen", "multiply", "difference"] as const;
export type BlendMode = typeof BLEND_MODES[number];

export type TrackState = { blend: BlendMode };

/** How a newly connected source lands on the timeline. */
export const IMPORT_MODES = ["stack", "append"] as const;
export type ImportMode = typeof IMPORT_MODES[number];

/** `masks` is the mask lane. Its clips may point at ANY slot - a real MASK, an image
 *  sequence or even a video - and whatever they point at is read as luminance. */
export type Timeline = {
  v: 1; clips: Clip[]; masks: Clip[]; audio: AudioClip[];
  /** Per video track, indexed by track number. Sparse: missing means normal. */
  tracks: TrackState[];
  ui: TimelineUI;
};

export const emptyTimeline = (): Timeline => ({
  v: 1, clips: [], masks: [], audio: [], tracks: [],
  ui: { zoom: 1, scroll: 0, playhead: 0 },
});

export function trackBlend(t: Timeline, track: number): BlendMode {
  return t.tracks[track]?.blend ?? "normal";
}

export function setTrackBlend(t: Timeline, track: number, blend: BlendMode): void {
  while (t.tracks.length <= track) t.tracks.push({ blend: "normal" });
  t.tracks[track].blend = blend;
}

let idCounter = 0;
/** Stable unique ids. LTX Director documents that a clip without an id breaks dragging
 *  after a reload; a counter is deterministic and cannot collide. */
export function newId(): string {
  idCounter += 1;
  return `c${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── Frame-count quantisation (parity with Python) ─────────────────────────────
// Video models only accept certain frame counts. Presets are named after the model
// families rather than the bare formula, because "which of these is Wan" is the actual
// question at the moment of choosing. Values come from ComfyUI core's EmptyLatent nodes.

export const QUANTIZE_FREE = "free";
export const QUANTIZE_CUSTOM = "custom (multiple of N)";

/** mode -> [step, offset]; a valid count is `offset + step*k`. */
export const QUANTIZE_PRESETS: Record<string, [number, number]> = {
  // Split per MODEL, not per grid: Wan and Hunyuan share 4n+1 but were trained at
  // different frame rates, so one grouped entry could not carry an honest expected fps.
  "Wan (4n+1)": [4, 1],
  "Hunyuan (4n+1)": [4, 1],
  "LTX (8n+1)": [8, 1],
  "Cosmos (8n+1)": [8, 1],
  "Mochi (6n+1)": [6, 1],
  // NOT an Nn+1 family: MiniMax H3 walks up until `n % 17 == 5`.
  "MiniMax H3 (17n+5)": [17, 5],
};

/**
 * Frame rate each family was trained at, ONLY where ComfyUI core states it outright:
 *   Wan        16  comfy_extras/nodes_wan.py:526 ("model trained with 16 fps")
 *   LTX        25  comfy_extras/nodes_lt.py:549 (LTXVConditioning frame_rate default)
 *   MiniMax H3 24  comfy_extras/nodes_minimax_h3.py:29 (FPS = 24)
 * Hunyuan, Cosmos and Mochi are absent on purpose: the repo documents no rate for them,
 * and a guess would produce a confident warning that might simply be wrong.
 */
export const QUANTIZE_NATIVE_FPS: Record<string, number> = {
  "Wan (4n+1)": 16,
  "LTX (8n+1)": 25,
  "MiniMax H3 (17n+5)": 24,
};

/** The rate this preset expects, or null when nobody documented one. */
export function nativeFpsFor(mode: QuantizeMode): number | null {
  return QUANTIZE_NATIVE_FPS[mode] ?? null;
}

export const QUANTIZE_MODES = [
  QUANTIZE_FREE, ...Object.keys(QUANTIZE_PRESETS), QUANTIZE_CUSTOM,
];

export type QuantizeMode = string;

export function quantizeGrid(mode: QuantizeMode, k = 8): [number, number] | null {
  if (mode === QUANTIZE_CUSTOM) return [Math.max(1, int(k, 1)), 0];
  return QUANTIZE_PRESETS[mode] ?? null;
}

/**
 * Smallest useful valid count.
 *
 * `offset` alone is arithmetically valid, but for the Nn+1 families that means a single
 * frame, which is never what someone dragging a timeline meant. So the floor is one full
 * group up unless the offset already lands somewhere sensible:
 * 4n+1 -> 5, 8n+1 -> 9, 6n+1 -> 7, 17n+5 -> 5, multiple of N -> N.
 */
export function firstStop(step: number, offset: number): number {
  return offset > 1 ? offset : offset + step;
}

/** Round a frame count DOWN to the nearest valid stop, never below the first one. */
export function quantizeCount(n: number, mode: QuantizeMode, k = 8): number {
  n = Math.max(0, int(n));
  const grid = quantizeGrid(mode, k);
  if (!grid || n === 0) return n;
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  if (n <= low) return low;
  return offset + Math.floor((n - offset) / step) * step;
}

/** Every valid stop within [0, max] - what the editor paints on the ruler. */
export function quantizeStops(max: number, mode: QuantizeMode, k = 8): number[] {
  const grid = quantizeGrid(mode, k);
  if (!grid || max <= 0) return [];
  const [step, offset] = grid;
  const stops: number[] = [];
  for (let s = firstStop(step, offset); s <= max; s += step) stops.push(s);
  return stops;
}

// ── Freeze-frame markers ──────────────────────────────────────────────────────

/** Sorted, unique, inside `[0, length)`. The single gatekeeper: everything that touches
 *  markers goes through here, so no other code has to remember the invariant. */
function cleanMarkers(raw: unknown, length: number): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const m of raw) {
    const v = int(m, -1);
    if (v >= 0 && v < length) seen.add(v);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Drop markers that a trim or a source change pushed outside the clip. */
export function pruneMarkers(clip: Clip): void {
  if (!clip.markers) return;
  const kept = cleanMarkers(clip.markers, clip.length);
  if (kept.length) clip.markers = kept;
  else delete clip.markers;
}

/** Slide markers by `delta` clip-local frames, then prune. Used wherever the content
 *  moves under a fixed clip window (head trim, slip) so a marker keeps pointing at the
 *  picture it was put on rather than at a position. */
export function shiftMarkers(clip: Clip, delta: number): void {
  if (!clip.markers || !delta) return;
  clip.markers = clip.markers.map((m) => m - Math.round(delta));
  pruneMarkers(clip);
}

/** Add or remove a marker at absolute timeline frame `f`. False if `f` is off the clip. */
export function toggleMarker(clip: Clip, f: number): boolean {
  const off = Math.round(f) - clip.start;
  if (off < 0 || off >= clip.length) return false;
  const next = (clip.markers ?? []).filter((m) => m !== off);
  if (next.length === (clip.markers?.length ?? 0)) next.push(off);
  clip.markers = next.sort((a, b) => a - b);
  if (!clip.markers.length) delete clip.markers;
  return true;
}

/**
 * Every marker as an ABSOLUTE timeline frame, sorted and deduplicated.
 *
 * Across every lane: a clip reinterpreted as a mask keeps the markers it was given, and
 * two stacked clips marked at the same instant are one output frame, not two.
 */
export function markerFrames(t: Timeline): number[] {
  const out = new Set<number>();
  for (const lane of allLanes(t)) {
    for (const c of lane) for (const m of c.markers ?? []) out.add(c.start + m);
  }
  return [...out].sort((a, b) => a - b);
}

// ── Defensive parsing ─────────────────────────────────────────────────────────

function parseClipList(raw: any): Clip[] {
  const out: Clip[] = [];
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if (!c || typeof c !== "object" || !c.src) continue;
    const length = int(c.length);
    if (length <= 0) continue;
    const markers = cleanMarkers(c.markers, length);
    out.push({
      id: typeof c.id === "string" && c.id ? c.id : newId(),
      src: String(c.src),
      track: Math.max(0, int(c.track)),
      start: Math.max(0, int(c.start)),
      trimIn: Math.max(0, int(c.trimIn)),
      length,
      ...(c.muted ? { muted: true } : {}),
      ...(markers.length ? { markers } : {}),
    });
  }
  return out;
}

/** Never throws. Corrupt JSON degrades to an empty timeline, same as in Python. */
export function parseTimeline(raw: string | null | undefined): Timeline {
  const out = emptyTimeline();
  if (!raw || typeof raw !== "string") return out;
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object") return out;

  out.clips = parseClipList(data.clips);
  out.masks = parseClipList(data.masks);
  if (Array.isArray(data.tracks)) {
    out.tracks = data.tracks.map((t: any) => ({
      blend: (BLEND_MODES as readonly string[]).includes(t?.blend)
        ? (t.blend as BlendMode) : "normal",
    }));
  }
  if (Array.isArray(data.audio)) {
    for (const a of data.audio) {
      if (!a || typeof a !== "object" || !a.src) continue;
      const length = int(a.length);
      if (length <= 0) continue;
      out.audio.push({
        id: typeof a.id === "string" && a.id ? a.id : newId(),
        src: String(a.src),
        start: Math.max(0, int(a.start)),
        trimIn: Math.max(0, int(a.trimIn)),
        length,
        gain: num(a.gain, 1),
        ...(a.muted ? { muted: true } : {}),
      });
    }
  }
  if (data.ui && typeof data.ui === "object") {
    out.ui.zoom = Math.min(MAX_ZOOM, Math.max(1, num(data.ui.zoom, 1)));
    out.ui.scroll = Math.max(0, num(data.ui.scroll, 0));
    out.ui.playhead = Math.max(0, int(data.ui.playhead));
  }
  sortClips(out);
  return out;
}

/** Writes ONLY the persistent fields. Everything transient the editor hangs off a clip
 *  (video elements, thumbnails, blob URLs) lives outside the model precisely so nobody
 *  has to remember to strip it here. */
export function serialiseTimeline(t: Timeline): string {
  const plain = (c: Clip) => ({
    id: c.id, src: c.src, track: c.track,
    start: c.start, trimIn: c.trimIn, length: c.length,
    ...(c.muted ? { muted: true } : {}),   // omitted when false: keeps the JSON small
    ...(c.markers?.length ? { markers: c.markers } : {}),
  });
  return JSON.stringify({
    v: 1,
    clips: t.clips.map(plain),
    masks: t.masks.map(plain),
    tracks: t.tracks.map((x) => ({ blend: x.blend })),
    audio: t.audio.map((a) => ({
      id: a.id, src: a.src, start: a.start,
      trimIn: a.trimIn, length: a.length, gain: a.gain,
      ...(a.muted ? { muted: true } : {}),
    })),
    // ZOOM AND SCROLL ARE DELIBERATELY ABSENT. This string is a node INPUT, and a widget
    // value goes verbatim into ComfyUI's cache signature (comfy_execution/caching.py:126),
    // so anything written here invalidates the render. Where the user happens to be
    // looking changes nothing about the output, yet it would cost a full re-render on
    // every wheel tick. It lives in `node.properties` instead, which persists with the
    // workflow but is not an input. The playhead DOES stay: it drives `current_frame` /
    // `current_image`, so invalidating on a scrub is the point.
    ui: { playhead: t.ui.playhead },
  });
}

/** The view state kept OUT of the widget, for the host to park in `node.properties`. */
export function viewState(t: Timeline): { zoom: number; scroll: number } {
  return { zoom: t.ui.zoom, scroll: t.ui.scroll };
}

export function sortClips(t: Timeline): void {
  const byTrack = (a: Clip, b: Clip) => a.track - b.track || a.start - b.start;
  t.clips.sort(byTrack);
  t.masks.sort(byTrack);
  t.audio.sort((a, b) => a.start - b.start);
}

/**
 * Is this Autogrow slot already placed ANYWHERE on the timeline?
 *
 * Must span every lane, not just the one being filled. A clip reinterpreted as a mask
 * leaves the picture lane, and a per-lane check would then decide the slot was unplaced
 * and add it back as a video - so the same source ends up in both lanes on the next
 * refresh, and the reinterpretation silently undoes itself.
 */
export function slotInUse(t: Timeline, src: string): boolean {
  return allLanes(t).some((lane) => lane.some((c) => c.src === src));
}

/** Every lane, for the operations that do not care which is which. */
export function allLanes(t: Timeline): Clip[][] {
  return [t.clips, t.masks, t.audio as unknown as Clip[]];
}

// ── Frame maths ───────────────────────────────────────────────────────────────

/**
 * Source frame corresponding to timeline frame `f`.
 * With mismatched frame rates this IS the resampling: 30 -> 24 drops, 24 -> 30 repeats.
 */
export function sourceFrame(clip: Clip, f: number, srcFps: number, fps: number): number {
  if (!(fps > 0)) return clip.trimIn;
  return clip.trimIn + Math.round((f - clip.start) * (srcFps / fps));
}

/** Last frame occupied by any track. */
export function timelineSpan(t: Timeline): number {
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) end = Math.max(end, c.start + c.length);
  }
  return end;
}

/** First frame covered by any picture lane, and the last. Used by "trim to material",
 *  which crops the output range to what actually exists instead of leaving gaps that
 *  turn into mask. Returns null when there is nothing at all. */
export function materialRange(t: Timeline): { start: number; end: number } | null {
  let start = Infinity;
  let end = 0;
  for (const lane of [t.clips, t.masks]) {
    for (const c of lane) {
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}

/** Clips covering `frame`, topmost first - the one you actually see. */
export function clipsAt(t: Timeline, frame: number): Clip[] {
  return t.clips
    .filter((c) => frame >= c.start && frame < c.start + c.length)
    .sort((a, b) => b.track - a.track);
}

/** The count the backend will actually produce, given the editor's current state. */
export function effectiveCount(
  t: Timeline, startFrame: number, frameCount: number,
  mode: QuantizeMode, k = 8,
): number {
  const raw = frameCount > 0 ? frameCount : Math.max(0, timelineSpan(t) - startFrame);
  return quantizeCount(raw, mode, k);
}

// ── Snapping ──────────────────────────────────────────────────────────────────

/** Nearest candidate within `threshold`, or `value` if none is close enough.
 *  LTX Director duplicates this logic three times; here it is one function. */
export function snap(value: number, candidates: number[], threshold: number): number {
  let best = value;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - value);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Every clip edge plus the origin and the playhead: the natural magnets of an edit. */
export function snapCandidates(t: Timeline, extra: number[] = []): number[] {
  const out = [0, t.ui.playhead, ...extra];
  for (const lane of allLanes(t)) {
    for (const c of lane) out.push(c.start, c.start + c.length);
  }
  return out;
}

/**
 * Snap an absolute frame onto the model's quantisation grid, measured FROM `startFrame`.
 *
 * These are the only places a cut can land and still leave the model a frame count it
 * accepts, so holding the modifier while scrubbing lands the playhead exactly on a legal
 * block boundary.
 */
export function snapFrameToGrid(frame: number, startFrame: number,
                                 mode: QuantizeMode, k = 8): number {
  const grid = quantizeGrid(mode, k);
  if (!grid) return Math.round(frame);
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  const rel = frame - startFrame;
  if (rel <= low) return startFrame + low;
  return startFrame + offset + Math.round((rel - offset) / step) * step;
}

// ── Editing ───────────────────────────────────────────────────────────────────

/** Move a clip, without letting it fall off the left edge. */
export function moveClip(clip: Clip, start: number, track: number): void {
  clip.start = Math.max(0, Math.round(start));
  clip.track = Math.max(0, Math.round(track));
}

/** Trim the left edge: moves `start` and `trimIn` together so the content does not slide
 *  under the cut. Respects how much source material lies before it. */
export function trimStart(clip: Clip, newStart: number, srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const end = clip.start + clip.length;
  const minStart = clip.start - Math.floor(clip.trimIn / (ratio || 1));
  const s = Math.max(0, Math.max(minStart, Math.min(Math.round(newStart), end - 1)));
  const delta = s - clip.start;
  clip.trimIn = Math.max(0, clip.trimIn + Math.round(delta * ratio));
  clip.start = s;
  clip.length = end - s;
  // The clip's origin moved but its content did not, so every marker is now `delta`
  // frames closer to the head. Without this a head trim would silently slide the freeze
  // frames onto different pictures.
  shiftMarkers(clip, delta);
}

/** Trim the right edge: only the duration changes. */
export function trimEnd(clip: Clip, newEnd: number, srcFrames: number,
                        srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const maxLen = srcFrames > 0
    ? Math.max(1, Math.floor((srcFrames - clip.trimIn) / (ratio || 1)))
    : Number.MAX_SAFE_INTEGER;
  clip.length = Math.max(1, Math.min(Math.round(newEnd) - clip.start, maxLen));
  pruneMarkers(clip);   // whatever fell off the tail is gone with it
}

/** Slip: move the content INSIDE the clip without touching position or duration.
 *  "Same slot, different part of the source" - constant use in video-to-video. */
export function slipClip(clip: Clip, deltaFrames: number, srcFrames: number,
                          srcFps: number, fps: number): void {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const used = Math.ceil(clip.length * ratio);
  const maxTrim = srcFrames > 0 ? Math.max(0, srcFrames - used) : Number.MAX_SAFE_INTEGER;
  const before = clip.trimIn;
  clip.trimIn = Math.max(0, Math.min(maxTrim, clip.trimIn + Math.round(deltaFrames * ratio)));
  // Content slid under a stationary window, so a content-anchored marker slides with it -
  // by the trim actually APPLIED, which the clamps above may have cut short.
  shiftMarkers(clip, (clip.trimIn - before) / (ratio || 1));
}

/**
 * Reinterpret a clip as a mask, or back again.
 *
 * A black-and-white video IS a mask most of the time - it just arrived through a video
 * input. Rather than force a conversion node upstream, the clip moves to the mask lane and
 * the backend reads whatever it points at as luminance.
 */
export function moveClipToLane(t: Timeline, clip: Clip, toMask: boolean): void {
  const from = toMask ? t.clips : t.masks;
  const to = toMask ? t.masks : t.clips;
  const i = from.indexOf(clip);
  if (i < 0) return;
  from.splice(i, 1);
  clip.track = 0;
  to.push(clip);
  sortClips(t);
}

/**
 * Discard everything outside [start, end): clips wholly outside are dropped, clips that
 * straddle an edge are cut back to it.
 *
 * The inverse of `materialRange` + trim-to-material: that one moves the RANGE to fit the
 * material, this one cuts the MATERIAL to fit the range. Frame numbering is deliberately
 * left alone - rebasing to zero would have to rewrite `start_frame`, which can be driven
 * by a link from another node, and the rendered output is identical either way.
 *
 * `rateFor` gives each source native rate: a video clip counts `trimIn` in SOURCE frames,
 * so cutting its head has to advance the trim at that cadence, while audio and tensor
 * clips run at the timeline rate.
 *
 * Returns true if anything changed.
 */
export function cropToRange(t: Timeline, start: number, end: number, fps: number,
                            rateFor: (src: string) => number): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    const kept: Clip[] = [];
    for (const c of lane) {
      if (c.start + c.length <= start || c.start >= end) {
        changed = true;                      // entirely outside: gone
        continue;
      }
      const rate = rateFor(c.src) || fps;
      if (c.start + c.length > end) {
        trimEnd(c, end, 0, rate, fps);       // 0 = no source cap; we only ever shorten
        changed = true;
      }
      if (c.start < start) {
        trimStart(c, start, rate, fps);
        changed = true;
      }
      kept.push(c);
    }
    if (kept.length !== lane.length) {
      lane.length = 0;
      lane.push(...kept);
    }
  }
  return changed;
}

/**
 * Pull one edge of a clip up to the playhead - Premiere's trim-to-playhead.
 *
 * The point is not having to find a three-minute clip's edge and drag it all the way
 * back: park the playhead where the cut belongs and the edge comes to you.
 *
 * The playhead must be strictly INSIDE a clip for it to be affected, so this only ever
 * shortens. `only` restricts it to a selection; without it every clip under the playhead
 * in every lane is trimmed, which is what makes it fast when you just want the cut.
 *
 * Returns true if anything changed.
 */
export function trimToPlayhead(t: Timeline, frame: number, side: "start" | "end",
                               fps: number, rateFor: (src: string) => number,
                               only?: Set<string>): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      if (only && !only.has(c.id)) continue;
      if (frame <= c.start || frame >= c.start + c.length) continue;
      const rate = rateFor(c.src) || fps;
      if (side === "start") trimStart(c, frame, rate, fps);
      else trimEnd(c, frame, 0, rate, fps);   // 0 = no source cap; only ever shortens
      changed = true;
    }
  }
  return changed;
}

/**
 * Pull clips back inside the material they point at.
 *
 * A source can change under a clip - swap the file in a Load Audio and the old three
 * minutes may become ten seconds - and a clip left longer than its source would just read
 * its last frame on repeat. Only ever SHORTENS: a source that got longer must not silently
 * undo a trim the user made on purpose.
 *
 * `srcFramesFor` returns the source length in SOURCE frames (null when unknown), and
 * `rateFor` its native rate, because a clip's `trimIn` counts source frames while its
 * `length` counts timeline frames.
 *
 * Returns true if anything changed.
 */
export function clampClipsToSources(t: Timeline, fps: number,
                                    srcFramesFor: (src: string) => number | null,
                                    rateFor: (src: string) => number): boolean {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const srcFrames = srcFramesFor(c.src);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c.src) || fps) / (fps || 1);
      if (c.trimIn >= srcFrames) {        // the trim itself is now past the end
        c.trimIn = 0;
        changed = true;
      }
      const maxLen = Math.max(1, Math.floor((srcFrames - c.trimIn) / (ratio || 1)));
      if (c.length > maxLen) {
        c.length = maxLen;
        pruneMarkers(c);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Extent of a set of clips - Resolve's "mark clip" needs exactly this.
 *
 * With `ids` it spans the selection; without, everything covering `frame` in every lane.
 * The union rather than one clip, so marking a picture+sound pair that was cut together
 * gives their shared extent instead of whichever happened to be found first.
 *
 * Returns null when there is nothing to mark.
 */
export function clipExtent(t: Timeline, frame: number, ids?: Set<string>):
    { start: number; end: number } | null {
  let start = Infinity;
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const hit = ids
        ? ids.has(c.id)
        : frame >= c.start && frame < c.start + c.length;
      if (!hit) continue;
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}

/** Where a newly connected source should land. `stack` puts each one on its own track
 *  from frame 0, which is what you want when the timeline is being used to compare two
 *  versions rather than to assemble a sequence. */
export function placementFor(t: Timeline, lane: Clip[], mode: ImportMode):
    { start: number; track: number } {
  if (mode === "stack") {
    const track = lane.reduce((m, c) => Math.max(m, c.track + 1), 0);
    return { start: 0, track };
  }
  const start = lane.filter((c) => c.track === 0)
    .reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return { start, track: 0 };
}

// ── Fit (parity with `fit_frames` in Python) ──────────────────────────────────

export type FitMode = "contain" | "cover" | "stretch";

/** Destination rect for drawing a `sw x sh` source into a `dw x dh` output.
 *  The editor's preview uses this so what you scrub is what gets rendered. */
export function fitRect(sw: number, sh: number, dw: number, dh: number, mode: FitMode):
    { x: number; y: number; w: number; h: number } {
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: dw, h: dh };
  if (mode === "stretch") return { x: 0, y: 0, w: dw, h: dh };
  const scale = mode === "cover"
    ? Math.max(dw / sw, dh / sh)   // fill the frame, overflow is cropped
    : Math.min(dw / sw, dh / sh);  // contain: fit whole, remainder is black
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
