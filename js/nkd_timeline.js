var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
const int = (v, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const MAX_ZOOM = 400;
function viewWindow(ui, contentFrames) {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, num(ui.zoom, 1)));
  const content = Math.max(2, num(contentFrames, 2));
  const frames = Math.max(2, content / zoom);
  const start = Math.max(0, Math.min(num(ui.scroll, 0), content - frames));
  return { start, frames };
}
const BLEND_MODES = ["normal", "screen", "multiply", "difference"];
const emptyTimeline = () => ({
  v: 1,
  clips: [],
  masks: [],
  audio: [],
  tracks: [],
  ui: { zoom: 1, scroll: 0, playhead: 0 }
});
function trackBlend(t, track) {
  var _a;
  return ((_a = t.tracks[track]) == null ? void 0 : _a.blend) ?? "normal";
}
function setTrackBlend(t, track, blend) {
  while (t.tracks.length <= track) t.tracks.push({ blend: "normal" });
  t.tracks[track].blend = blend;
}
let idCounter = 0;
function newId() {
  idCounter += 1;
  return `c${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
const QUANTIZE_FREE = "free";
const QUANTIZE_CUSTOM = "custom (multiple of N)";
const QUANTIZE_PRESETS = {
  // Split per MODEL, not per grid: Wan and Hunyuan share 4n+1 but were trained at
  // different frame rates, so one grouped entry could not carry an honest expected fps.
  "Wan (4n+1)": [4, 1],
  "Hunyuan (4n+1)": [4, 1],
  "LTX (8n+1)": [8, 1],
  "Cosmos (8n+1)": [8, 1],
  "Mochi (6n+1)": [6, 1],
  // NOT an Nn+1 family: MiniMax H3 walks up until `n % 17 == 5`.
  "MiniMax H3 (17n+5)": [17, 5]
};
const QUANTIZE_NATIVE_FPS = {
  "Wan (4n+1)": 16,
  "LTX (8n+1)": 25,
  "MiniMax H3 (17n+5)": 24
};
function nativeFpsFor(mode) {
  return QUANTIZE_NATIVE_FPS[mode] ?? null;
}
[
  QUANTIZE_FREE,
  ...Object.keys(QUANTIZE_PRESETS),
  QUANTIZE_CUSTOM
];
function quantizeGrid(mode, k = 8) {
  if (mode === QUANTIZE_CUSTOM) return [Math.max(1, int(k, 1)), 0];
  return QUANTIZE_PRESETS[mode] ?? null;
}
function firstStop(step, offset) {
  return offset > 1 ? offset : offset + step;
}
function quantizeCount(n, mode, k = 8) {
  n = Math.max(0, int(n));
  const grid = quantizeGrid(mode, k);
  if (!grid || n === 0) return n;
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  if (n <= low) return low;
  return offset + Math.floor((n - offset) / step) * step;
}
function quantizeStops(max, mode, k = 8) {
  const grid = quantizeGrid(mode, k);
  if (!grid || max <= 0) return [];
  const [step, offset] = grid;
  const stops = [];
  for (let s = firstStop(step, offset); s <= max; s += step) stops.push(s);
  return stops;
}
function parseClipList(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    if (!c || typeof c !== "object" || !c.src) continue;
    const length = int(c.length);
    if (length <= 0) continue;
    out.push({
      id: typeof c.id === "string" && c.id ? c.id : newId(),
      src: String(c.src),
      track: Math.max(0, int(c.track)),
      start: Math.max(0, int(c.start)),
      trimIn: Math.max(0, int(c.trimIn)),
      length,
      ...c.muted ? { muted: true } : {}
    });
  }
  return out;
}
function parseTimeline(raw) {
  const out = emptyTimeline();
  if (!raw || typeof raw !== "string") return out;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!data || typeof data !== "object") return out;
  out.clips = parseClipList(data.clips);
  out.masks = parseClipList(data.masks);
  if (Array.isArray(data.tracks)) {
    out.tracks = data.tracks.map((t) => ({
      blend: BLEND_MODES.includes(t == null ? void 0 : t.blend) ? t.blend : "normal"
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
        ...a.muted ? { muted: true } : {}
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
function serialiseTimeline(t) {
  const plain = (c) => ({
    id: c.id,
    src: c.src,
    track: c.track,
    start: c.start,
    trimIn: c.trimIn,
    length: c.length,
    ...c.muted ? { muted: true } : {}
    // omitted when false: keeps the JSON small
  });
  return JSON.stringify({
    v: 1,
    clips: t.clips.map(plain),
    masks: t.masks.map(plain),
    tracks: t.tracks.map((x) => ({ blend: x.blend })),
    audio: t.audio.map((a) => ({
      id: a.id,
      src: a.src,
      start: a.start,
      trimIn: a.trimIn,
      length: a.length,
      gain: a.gain,
      ...a.muted ? { muted: true } : {}
    })),
    ui: { zoom: t.ui.zoom, scroll: t.ui.scroll, playhead: t.ui.playhead }
  });
}
function sortClips(t) {
  const byTrack = (a, b) => a.track - b.track || a.start - b.start;
  t.clips.sort(byTrack);
  t.masks.sort(byTrack);
  t.audio.sort((a, b) => a.start - b.start);
}
function slotInUse(t, src) {
  return allLanes(t).some((lane) => lane.some((c) => c.src === src));
}
function allLanes(t) {
  return [t.clips, t.masks, t.audio];
}
function sourceFrame(clip, f, srcFps, fps) {
  if (!(fps > 0)) return clip.trimIn;
  return clip.trimIn + Math.round((f - clip.start) * (srcFps / fps));
}
function timelineSpan(t) {
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) end = Math.max(end, c.start + c.length);
  }
  return end;
}
function materialRange(t) {
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
function clipsAt(t, frame) {
  return t.clips.filter((c) => frame >= c.start && frame < c.start + c.length).sort((a, b) => b.track - a.track);
}
function effectiveCount(t, startFrame, frameCount, mode, k = 8) {
  const raw = frameCount > 0 ? frameCount : Math.max(0, timelineSpan(t) - startFrame);
  return quantizeCount(raw, mode, k);
}
function snap(value, candidates, threshold) {
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
function snapCandidates(t, extra = []) {
  const out = [0, t.ui.playhead, ...extra];
  for (const lane of allLanes(t)) {
    for (const c of lane) out.push(c.start, c.start + c.length);
  }
  return out;
}
function snapFrameToGrid(frame, startFrame, mode, k = 8) {
  const grid = quantizeGrid(mode, k);
  if (!grid) return Math.round(frame);
  const [step, offset] = grid;
  const low = firstStop(step, offset);
  const rel = frame - startFrame;
  if (rel <= low) return startFrame + low;
  return startFrame + offset + Math.round((rel - offset) / step) * step;
}
function moveClip(clip, start, track) {
  clip.start = Math.max(0, Math.round(start));
  clip.track = Math.max(0, Math.round(track));
}
function trimStart(clip, newStart, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const end = clip.start + clip.length;
  const minStart = clip.start - Math.floor(clip.trimIn / (ratio || 1));
  const s = Math.max(0, Math.max(minStart, Math.min(Math.round(newStart), end - 1)));
  const delta = s - clip.start;
  clip.trimIn = Math.max(0, clip.trimIn + Math.round(delta * ratio));
  clip.start = s;
  clip.length = end - s;
}
function trimEnd(clip, newEnd, srcFrames, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const maxLen = srcFrames > 0 ? Math.max(1, Math.floor((srcFrames - clip.trimIn) / (ratio || 1))) : Number.MAX_SAFE_INTEGER;
  clip.length = Math.max(1, Math.min(Math.round(newEnd) - clip.start, maxLen));
}
function slipClip(clip, deltaFrames, srcFrames, srcFps, fps) {
  const ratio = fps > 0 ? srcFps / fps : 1;
  const used = Math.ceil(clip.length * ratio);
  const maxTrim = srcFrames > 0 ? Math.max(0, srcFrames - used) : Number.MAX_SAFE_INTEGER;
  clip.trimIn = Math.max(0, Math.min(maxTrim, clip.trimIn + Math.round(deltaFrames * ratio)));
}
function moveClipToLane(t, clip, toMask) {
  const from = toMask ? t.clips : t.masks;
  const to = toMask ? t.masks : t.clips;
  const i = from.indexOf(clip);
  if (i < 0) return;
  from.splice(i, 1);
  clip.track = 0;
  to.push(clip);
  sortClips(t);
}
function cropToRange(t, start, end, fps, rateFor) {
  let changed = false;
  for (const lane of allLanes(t)) {
    const kept = [];
    for (const c of lane) {
      if (c.start + c.length <= start || c.start >= end) {
        changed = true;
        continue;
      }
      const rate = rateFor(c.src) || fps;
      if (c.start + c.length > end) {
        trimEnd(c, end, 0, rate, fps);
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
function trimToPlayhead(t, frame, side, fps, rateFor, only) {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      if (only && !only.has(c.id)) continue;
      if (frame <= c.start || frame >= c.start + c.length) continue;
      const rate = rateFor(c.src) || fps;
      if (side === "start") trimStart(c, frame, rate, fps);
      else trimEnd(c, frame, 0, rate, fps);
      changed = true;
    }
  }
  return changed;
}
function clampClipsToSources(t, fps, srcFramesFor, rateFor) {
  let changed = false;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const srcFrames = srcFramesFor(c.src);
      if (srcFrames === null || srcFrames <= 0) continue;
      const ratio = (rateFor(c.src) || fps) / (fps || 1);
      if (c.trimIn >= srcFrames) {
        c.trimIn = 0;
        changed = true;
      }
      const maxLen = Math.max(1, Math.floor((srcFrames - c.trimIn) / (ratio || 1)));
      if (c.length > maxLen) {
        c.length = maxLen;
        changed = true;
      }
    }
  }
  return changed;
}
function clipExtent(t, frame, ids) {
  let start = Infinity;
  let end = 0;
  for (const lane of allLanes(t)) {
    for (const c of lane) {
      const hit = ids ? ids.has(c.id) : frame >= c.start && frame < c.start + c.length;
      if (!hit) continue;
      start = Math.min(start, c.start);
      end = Math.max(end, c.start + c.length);
    }
  }
  return end > 0 && Number.isFinite(start) ? { start, end } : null;
}
function placementFor(t, lane, mode) {
  if (mode === "stack") {
    const track = lane.reduce((m, c) => Math.max(m, c.track + 1), 0);
    return { start: 0, track };
  }
  const start = lane.filter((c) => c.track === 0).reduce((m, c) => Math.max(m, c.start + c.length), 0);
  return { start, track: 0 };
}
function fitRect(sw, sh, dw, dh, mode) {
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, w: dw, h: dh };
  if (mode === "stretch") return { x: 0, y: 0, w: dw, h: dh };
  const scale = mode === "cover" ? Math.max(dw / sw, dh / sh) : Math.min(dw / sw, dh / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w, h };
}
const refKey = (r) => `${r.type}|${r.subfolder}|${r.filename}`;
let cacheBust = 0;
function viewUrl(ref) {
  const q = new URLSearchParams({
    filename: ref.filename,
    type: ref.type || "input",
    subfolder: ref.subfolder || ""
  });
  if (cacheBust) q.set("_nkd", String(cacheBust));
  return api.apiURL(`/view?${q}`);
}
function bustCaches() {
  cacheBust += 1;
  infoCache.clear();
  thumbCache.clear();
  audioCache.clear();
  peakCache.clear();
  releaseUnused([]);
}
function forget(ref) {
  const key = refKey(ref);
  infoCache.delete(key);
  thumbCache.delete(key);
  audioCache.delete(key);
  peakCache.delete(key);
  const p = pool.get(key);
  if (p) {
    window.clearTimeout(p.guard);
    p.el.removeAttribute("src");
    p.el.load();
    pool.delete(key);
  }
}
const FILE_WIDGETS = ["file", "video", "audio", "image", "filename", "path"];
const looksLikeFile = (v) => typeof v === "string" && v.length > 0 && v !== "none" && /\.[a-z0-9]{2,5}$/i.test(v);
function resolveSource(node, slotName, depth = 0) {
  var _a, _b, _c, _d, _e;
  if (depth > 6) return null;
  const slot = (_a = node == null ? void 0 : node.inputs) == null ? void 0 : _a.find((i) => {
    var _a2;
    return i.name === slotName || ((_a2 = i.name) == null ? void 0 : _a2.endsWith(`.${slotName}`));
  });
  if (!slot || slot.link == null) return null;
  const link = (_c = (_b = node.graph) == null ? void 0 : _b.links) == null ? void 0 : _c[slot.link];
  const src = link && ((_d = node.graph) == null ? void 0 : _d.getNodeById(link.origin_id));
  if (!src) return null;
  for (const name of FILE_WIDGETS) {
    const w = (_e = src.widgets) == null ? void 0 : _e.find((x) => x.name === name);
    if (w && looksLikeFile(w.value)) {
      const raw = String(w.value);
      const m = /^(.*?)\s*\[(\w+)\]$/.exec(raw);
      const clean = m ? m[1] : raw;
      const cut = clean.lastIndexOf("/");
      return {
        filename: cut >= 0 ? clean.slice(cut + 1) : clean,
        subfolder: cut >= 0 ? clean.slice(0, cut) : "",
        type: m ? m[2] : "input"
      };
    }
  }
  for (const inp of src.inputs ?? []) {
    if (inp.link == null) continue;
    const up = resolveSource(src, inp.name, depth + 1);
    if (up) return up;
  }
  return null;
}
function slotKind(node, slotName) {
  var _a, _b, _c, _d, _e, _f;
  const slot = (_a = node == null ? void 0 : node.inputs) == null ? void 0 : _a.find(
    (i) => {
      var _a2;
      return i.name === slotName || ((_a2 = i.name) == null ? void 0 : _a2.endsWith(`.${slotName}`));
    }
  );
  if (!slot || slot.link == null) return null;
  const link = (_c = (_b = node.graph) == null ? void 0 : _b.links) == null ? void 0 : _c[slot.link];
  let type = link == null ? void 0 : link.type;
  if (!type && link) {
    const src = (_d = node.graph) == null ? void 0 : _d.getNodeById(link.origin_id);
    type = (_f = (_e = src == null ? void 0 : src.outputs) == null ? void 0 : _e[link.origin_slot]) == null ? void 0 : _f.type;
  }
  const t = String(type ?? "").toUpperCase();
  if (t.includes("VIDEO")) return "video";
  if (t.includes("AUDIO")) return "audio";
  if (t.includes("MASK")) return "mask";
  if (t.includes("IMAGE")) return "image";
  return null;
}
const infoCache = /* @__PURE__ */ new Map();
const infoPending = /* @__PURE__ */ new Map();
function probe(ref) {
  const key = refKey(ref);
  const hit = infoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = infoPending.get(key);
  if (flight) return flight;
  const q = new URLSearchParams({
    filename: ref.filename,
    type: ref.type || "input",
    subfolder: ref.subfolder || ""
  });
  const p = api.fetchApi(`/nkd/timeline/probe?${q}`).then((r) => r.ok ? r.json() : null).then((info) => {
    if (info && info.frame_count > 0) infoCache.set(key, info);
    return info;
  }).catch(() => null).finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}
const cachedInfo = (ref) => infoCache.get(refKey(ref));
const pool = /* @__PURE__ */ new Map();
function makePooled(ref) {
  const el = document.createElement("video");
  el.src = viewUrl(ref);
  el.muted = true;
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  const entry = {
    el,
    good: document.createElement("canvas"),
    hasGood: false,
    wantTime: -1,
    seeking: false,
    guard: 0
  };
  el.addEventListener("loadedmetadata", () => applySeek(entry));
  el.addEventListener("seeked", () => {
    window.clearTimeout(entry.guard);
    entry.seeking = false;
    captureGood(entry);
    if (entry.wantTime >= 0 && Math.abs(entry.wantTime - el.currentTime) > 1e-3) {
      applySeek(entry);
    }
  });
  el.addEventListener("loadeddata", () => {
    captureGood(entry);
    onPooledReady == null ? void 0 : onPooledReady();
    ensureAudio(ref, () => onPooledReady == null ? void 0 : onPooledReady());
  });
  return entry;
}
function captureGood(p) {
  const { el, good } = p;
  if (!el.videoWidth || !el.videoHeight) return;
  if (good.width !== el.videoWidth) good.width = el.videoWidth;
  if (good.height !== el.videoHeight) good.height = el.videoHeight;
  try {
    good.getContext("2d").drawImage(el, 0, 0);
    p.hasGood = true;
  } catch {
  }
}
function applySeek(p) {
  if (p.seeking || p.wantTime < 0) return;
  if (p.el.readyState < 1) return;
  p.seeking = true;
  try {
    p.el.currentTime = p.wantTime;
  } catch {
    p.seeking = false;
    return;
  }
  window.clearTimeout(p.guard);
  p.guard = window.setTimeout(() => {
    p.seeking = false;
    captureGood(p);
    onPooledReady == null ? void 0 : onPooledReady();
  }, 2e3);
}
let onPooledReady = null;
function setPooledReadyHandler(fn) {
  onPooledReady = fn;
}
function seekTo(ref, seconds) {
  const p = pool.get(refKey(ref)) ?? makePooled(ref);
  pool.set(refKey(ref), p);
  p.wantTime = Math.max(0, seconds);
  applySeek(p);
}
const DRIFT_S = 0.25;
function followPlayback(ref, seconds) {
  const p = pool.get(refKey(ref)) ?? makePooled(ref);
  pool.set(refKey(ref), p);
  if (p.el.paused) {
    p.wantTime = Math.max(0, seconds);
    applySeek(p);
    void p.el.play().catch(() => {
    });
    return;
  }
  if (Math.abs(p.el.currentTime - seconds) > DRIFT_S) {
    p.wantTime = Math.max(0, seconds);
    applySeek(p);
  }
}
function pauseAllVideos() {
  for (const p of pool.values()) {
    if (!p.el.paused) p.el.pause();
  }
}
function frameSource(ref) {
  const p = pool.get(refKey(ref));
  if (!p) return null;
  if (!p.seeking && p.el.readyState >= 2) return p.el;
  return p.hasGood ? p.good : null;
}
function releaseUnused(active) {
  const keep = /* @__PURE__ */ new Set();
  for (const r of active) keep.add(refKey(r));
  for (const [key, p] of pool) {
    if (keep.has(key)) continue;
    window.clearTimeout(p.guard);
    p.el.removeAttribute("src");
    p.el.load();
    pool.delete(key);
  }
}
const thumbCache = /* @__PURE__ */ new Map();
const thumbJobs = /* @__PURE__ */ new Map();
function thumbCount(duration) {
  return Math.max(6, Math.min(48, Math.ceil(duration * 2)));
}
function ensureThumbnails(ref, info, onFrame) {
  const key = refKey(ref);
  const have = thumbCache.get(key);
  if (have) return have;
  if (thumbJobs.has(key)) return [];
  const strip = [];
  thumbCache.set(key, strip);
  const job = new Promise((resolve) => {
    const el = document.createElement("video");
    el.src = viewUrl(ref);
    el.muted = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const duration = info.duration || 1;
    const n = thumbCount(duration);
    let i = 0;
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve();
    };
    const grab = () => {
      if (i >= n) return done();
      el.currentTime = (i + 0.5) / n * duration;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        i += 1;
        grab();
      }, 2e3);
    };
    el.addEventListener("seeked", () => {
      window.clearTimeout(timer);
      if (el.videoWidth && el.videoHeight) {
        const h = 64;
        const c = document.createElement("canvas");
        c.height = h;
        c.width = Math.max(1, Math.round(el.videoWidth / el.videoHeight * h));
        try {
          c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
          strip.push({ time: el.currentTime, canvas: c });
          onFrame();
        } catch {
        }
      }
      i += 1;
      grab();
    });
    el.addEventListener("error", done);
    el.addEventListener("loadeddata", grab, { once: true });
  }).finally(() => thumbJobs.delete(key));
  thumbJobs.set(key, job);
  return strip;
}
function thumbnailAt(ref, seconds) {
  const strip = thumbCache.get(refKey(ref));
  if (!strip || strip.length === 0) return null;
  let best = strip[0];
  let dist = Math.abs(best.time - seconds);
  for (const t of strip) {
    const d = Math.abs(t.time - seconds);
    if (d < dist) {
      dist = d;
      best = t;
    }
  }
  return best.canvas;
}
const audioCache = /* @__PURE__ */ new Map();
const peakCache = /* @__PURE__ */ new Map();
const audioJobs = /* @__PURE__ */ new Map();
let audioCtx = null;
function audioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}
const PEAK_BUCKETS = 400;
function ensureAudio(ref, onDone) {
  const key = refKey(ref);
  if (audioCache.has(key) || audioJobs.has(key)) return;
  const job = fetch(viewUrl(ref)).then((r) => r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch failed"))).then((buf) => audioContext().decodeAudioData(buf)).then((decoded) => {
    audioCache.set(key, decoded);
    peakCache.set(key, computePeaks(decoded));
    onDone();
    return decoded;
  }).catch(() => null).finally(() => audioJobs.delete(key));
  audioJobs.set(key, job);
}
function computePeaks(buf) {
  const data = buf.getChannelData(0);
  const out = new Float32Array(PEAK_BUCKETS);
  const per = Math.max(1, Math.floor(data.length / PEAK_BUCKETS));
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    let peak = 0;
    const from = b * per;
    const to = Math.min(data.length, from + per);
    for (let i = from; i < to; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  return out;
}
const peaksFor = (ref) => peakCache.get(refKey(ref));
const audioBufferFor = (ref) => audioCache.get(refKey(ref));
const SHUTTLE = [1, 2, 4, 8];
class Transport {
  constructor(host) {
    __publicField(this, "host");
    __publicField(this, "raf", 0);
    __publicField(this, "last", 0);
    /** Signed: negative is reverse. 0 means stopped. */
    __publicField(this, "speed", 0);
    /**
     * Sub-frame playhead position, kept HERE as a float.
     *
     * It must never be re-read from `ui.playhead`, which is rounded for display: at 24 fps
     * on a 60 Hz frame loop each tick advances ~0.4 frames, `Math.round` throws that away,
     * and the next tick starts from the same integer again - the playhead sticks while the
     * <video> plays on, until the drift correction yanks the picture backwards. That is the
     * classic accumulate-into-a-rounded-value bug, and it looks exactly like a stutter.
     */
    __publicField(this, "pos", 0);
    __publicField(this, "nodes", []);
    __publicField(this, "gain", null);
    __publicField(this, "onChange", null);
    __publicField(this, "tick", (now) => {
      if (this.speed === 0) {
        this.raf = 0;
        return;
      }
      const dt = Math.min(0.25, (now - this.last) / 1e3);
      this.last = now;
      const fps = this.host.getFps();
      const start = this.host.getStartFrame();
      const end = this.host.getEndFrame();
      this.pos += dt * fps * this.speed;
      if (this.pos >= end - 1) {
        this.pos = start;
        this.restartAudio();
      } else if (this.pos < start) {
        this.pos = end - 1;
        this.restartAudio();
      }
      this.host.seek(Math.round(this.pos));
      this.raf = requestAnimationFrame(this.tick);
    });
    this.host = host;
  }
  get rate() {
    return this.speed;
  }
  /** Space / the play button: toggle between stopped and 1x forward. */
  toggle() {
    if (this.speed === 0) this.play(1);
    else this.stop();
  }
  /** L steps forward through the shuttle speeds, J steps backward. Pressing the opposite
   *  direction first brings it back to a stop, the way every NLE behaves. */
  shuttle(dir) {
    const cur = this.speed;
    if (cur === 0 || Math.sign(cur) !== dir) {
      this.play(dir);
      return;
    }
    const i = SHUTTLE.indexOf(Math.abs(cur));
    this.play(dir * SHUTTLE[Math.min(SHUTTLE.length - 1, i + 1)]);
  }
  play(speed) {
    var _a;
    this.speed = speed;
    this.pos = this.host.getTimeline().ui.playhead;
    this.last = performance.now();
    this.scheduleAudio();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    (_a = this.onChange) == null ? void 0 : _a.call(this);
  }
  stop() {
    var _a;
    this.speed = 0;
    this.stopAudio();
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    (_a = this.onChange) == null ? void 0 : _a.call(this);
  }
  // ── Audio ───────────────────────────────────────────────────────────────────
  stopAudio() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
      }
    }
    this.nodes = [];
  }
  /** Re-schedule from the current position: a mute toggled mid-playback. */
  refreshAudio() {
    if (this.speed === 1) this.restartAudio();
  }
  restartAudio() {
    this.stopAudio();
    this.scheduleAudio();
  }
  /**
   * Schedule every audio clip that is still ahead of the playhead, each at its own offset
   * on the AudioContext clock. Scheduling up front is what keeps it in sync: nudging
   * playback from a rAF loop would drift audibly within seconds.
   *
   * Reverse and shuttle speeds run silent - browsers cannot play a buffer backwards, and
   * pitch-shifted scrub audio is noise rather than information.
   */
  scheduleAudio() {
    this.stopAudio();
    if (this.speed !== 1) return;
    const ctx = audioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const tl = this.host.getTimeline();
    const fps = this.host.getFps();
    const end = this.host.getEndFrame();
    const now = tl.ui.playhead;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    const lanes = [
      ...tl.audio.map((a) => ({ ...a, sourceRate: false })),
      ...tl.clips.map((c) => ({ ...c, gain: 1, sourceRate: true }))
    ];
    for (const a of lanes) {
      if (a.muted) continue;
      const ref = this.host.audioRefFor(a.src);
      if (!ref) continue;
      const buf = audioBufferFor(ref);
      if (!buf) {
        ensureAudio(ref, () => {
          if (this.speed === 1) this.restartAudio();
        });
        continue;
      }
      const clipEnd = Math.min(a.start + a.length, end);
      if (clipEnd <= now) continue;
      const from = Math.max(a.start, now);
      const when = ctx.currentTime + (from - now) / fps;
      const rate = a.sourceRate ? this.host.srcFpsFor(a.src) || fps : fps;
      const offset = a.trimIn / rate + (from - a.start) / fps;
      const duration = (clipEnd - from) / fps;
      if (duration <= 0 || offset >= buf.duration) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = a.gain;
      node.connect(g);
      g.connect(this.gain);
      node.start(when, offset, Math.min(duration, buf.duration - offset));
      this.nodes.push(node);
    }
  }
  /** The user grabbed the playhead while it was running: adopt their position instead of
   *  fighting them back to ours. */
  reanchor(frame) {
    this.pos = frame;
  }
  destroy() {
    var _a;
    this.stop();
    (_a = this.gain) == null ? void 0 : _a.disconnect();
    this.gain = null;
  }
}
const C = {
  bg: "#16181d",
  trackBg: "#1b1e24",
  trackAlt: "#191c21",
  bar: "#1a1c22",
  gridLine: "#0f1114",
  accent: "#4ab4ff",
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
  outside: "rgba(0,0,0,0.55)",
  gap: "rgba(255,209,102,0.07)"
};
const RULER_H = 27;
const IO_BAR_H = 7;
const IO_BAR_TOP = RULER_H - IO_BAR_H;
const IO_GRAB_PX = 7;
const CLIP_HEAD_H = 15;
const MUTE_BOX = 16;
const PREVIEW_MAX_H = 260;
const TRACK_H = 46;
const MASK_H = 30;
const AUDIO_H = 34;
const MIN_VIDEO_TRACKS = 2;
const MAX_VIDEO_TRACKS = 8;
const HANDLE_PX = 10;
const HANDLE_CORE = 4;
const SNAP_PX = 12;
const MIN_LEN = 1;
class TimelineEditor {
  constructor(host) {
    __publicField(this, "host");
    __publicField(this, "root");
    __publicField(this, "canvas");
    __publicField(this, "ctx");
    __publicField(this, "preview");
    __publicField(this, "pctx");
    __publicField(this, "status");
    __publicField(this, "playBtn");
    __publicField(this, "bar");
    __publicField(this, "drag", null);
    __publicField(this, "hover", { kind: "none" });
    __publicField(this, "snapping", true);
    __publicField(this, "raf", 0);
    __publicField(this, "disposed", false);
    __publicField(this, "lastTimelineH", 0);
    /** Undo stack of whole JSON snapshots. None of the three reference implementations has
     *  one, and ComfyUI's graph undo does not understand drags inside a canvas. */
    __publicField(this, "undoStack", []);
    __publicField(this, "redoStack", []);
    /** Ids of the selected clips. A group drag moves all of them together. */
    __publicField(this, "selection", /* @__PURE__ */ new Set());
    __publicField(this, "menu", null);
    /** Show the mask lane tinted over the picture in the monitor. */
    __publicField(this, "maskOverlay", false);
    __publicField(this, "maskBtn");
    /** Scratch canvas for tinting the mask; reused so playback does not allocate. */
    __publicField(this, "tintCanvas", document.createElement("canvas"));
    /** Last quantise/fps pair we warned about, so the toast fires on CHANGE only. */
    __publicField(this, "lastFpsWarning", "");
    __publicField(this, "transport");
    /** Called whenever the intrinsic height changes, so the host can resize the node. */
    __publicField(this, "onHeightChange", null);
    // ── Interaction ─────────────────────────────────────────────────────────────
    __publicField(this, "onDown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startScroll = this.tl.ui.scroll;
        const move = (m) => {
          const width = Math.max(1, this.canvas.getBoundingClientRect().width);
          this.tl.ui.scroll = startScroll - (m.clientX - startX) / width * this.viewFrames;
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
      this.root.focus({ preventScroll: true });
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      if (hit.kind === "mute") {
        this.pushUndo();
        hit.clip.muted = !hit.clip.muted;
        this.host.commit();
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
      const origins = /* @__PURE__ */ new Map();
      const snapshot = (k) => ({
        clip: k,
        from: { start: k.start, length: k.length, trimIn: k.trimIn, track: k.track }
      });
      if (c) {
        if (hit.kind === "clip") {
          for (const lane of [
            this.tl.clips,
            this.tl.masks,
            this.tl.audio
          ]) {
            for (const k of lane) if (this.selection.has(k.id)) origins.set(k.id, snapshot(k));
          }
        }
        if (!origins.has(c.id)) origins.set(c.id, snapshot(c));
      }
      this.drag = {
        hit,
        startX: x,
        before: JSON.stringify(this.tl),
        origin: c ? { start: c.start, length: c.length, trimIn: c.trimIn, track: c.track } : { start: 0, length: 0, trimIn: 0, track: 0 },
        origins,
        moved: false,
        slip: e.altKey
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.addEventListener("pointermove", this.onMove);
      this.canvas.addEventListener("pointerup", this.onUp);
      this.requestRender();
    });
    __publicField(this, "onMove", (e) => {
      if (!this.drag) return;
      e.stopPropagation();
      const { x, y } = this.localPos(e);
      const d = this.drag;
      d.moved = true;
      const gain = e.ctrlKey || e.metaKey ? 0.1 : 1;
      const toGrid = (f) => e.shiftKey ? snapFrameToGrid(
        f,
        this.host.getStartFrame(),
        this.host.getQuantize(),
        this.host.getQuantizeN()
      ) : f;
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
            const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
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
            slipClip(
              c,
              -dFrames,
              (info == null ? void 0 : info.frame_count) ?? 0,
              (info == null ? void 0 : info.fps) ?? this.host.getFps(),
              this.host.getFps()
            );
          } else {
            let start = toGrid(d.origin.start + dFrames);
            if (this.snapping && !e.shiftKey) {
              const cands = snapCandidates(this.tl, [
                this.host.getStartFrame(),
                this.host.getStartFrame() + this.effCount()
              ]).filter((v) => v !== c.start && v !== c.start + c.length);
              const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
              const byHead = snap(start, cands, thr);
              const byTail = snap(start + c.length, cands, thr) - c.length;
              start = Math.abs(byHead - start) <= Math.abs(byTail - start) ? byHead : byTail;
            }
            const track = d.hit.lane !== "video" ? 0 : Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
            const shift = start - d.origin.start;
            const lift = track - d.origin.track;
            let allowed = shift;
            for (const { from } of d.origins.values()) {
              allowed = Math.max(allowed, -from.start);
            }
            for (const { clip: k, from } of d.origins.values()) {
              moveClip(
                k,
                from.start + allowed,
                k === c || this.tl.clips.includes(k) ? from.track + lift : from.track
              );
            }
          }
          break;
        }
        case "edge": {
          const c = d.hit.clip;
          const info = this.infoFor(c);
          const fps = this.host.getFps();
          const srcFps = (info == null ? void 0 : info.fps) ?? fps;
          let frame = toGrid(d.hit.side === "start" ? d.origin.start + dFrames : d.origin.start + d.origin.length + dFrames);
          if (this.snapping && !e.shiftKey) {
            const thr = SNAP_PX / this.logicalWidth * this.viewFrames;
            frame = snap(frame, snapCandidates(this.tl, [
              this.host.getStartFrame(),
              this.host.getStartFrame() + this.effCount()
            ]), thr);
          }
          c.start = d.origin.start;
          c.length = d.origin.length;
          c.trimIn = d.origin.trimIn;
          if (d.hit.side === "start") trimStart(c, frame, srcFps, fps);
          else trimEnd(c, frame, (info == null ? void 0 : info.frame_count) ?? 0, srcFps, fps);
          if (c.length < MIN_LEN) c.length = MIN_LEN;
          break;
        }
      }
      this.requestRender();
    });
    __publicField(this, "onUp", (e) => {
      this.canvas.removeEventListener("pointermove", this.onMove);
      this.canvas.removeEventListener("pointerup", this.onUp);
      try {
        this.canvas.releasePointerCapture(e.pointerId);
      } catch {
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (JSON.stringify(this.tl) === d.before) {
        this.undoStack.pop();
      } else {
        sortClips(this.tl);
        this.host.commit();
      }
      this.requestRender();
    });
    __publicField(this, "onHover", (e) => {
      if (this.drag) return;
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      if (hit.kind !== this.hover.kind || hit.kind === "clip" && this.hover.kind === "clip" && hit.clip !== this.hover.clip) {
        this.hover = hit;
        this.requestRender();
      }
      this.canvas.style.cursor = hit.kind === "mute" ? "pointer" : hit.kind === "edge" || hit.kind === "inPoint" || hit.kind === "outPoint" ? "ew-resize" : hit.kind === "clip" ? e.altKey ? "col-resize" : "grab" : hit.kind === "playhead" ? "grab" : hit.kind === "ruler" ? "pointer" : "default";
    });
    /**
     * Right-click menu. Two jobs that both belong to "this clip is not what you assumed":
     * reinterpreting a black-and-white video as a mask, and setting how its track composites.
     */
    __publicField(this, "onContextMenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = this.localPos(e);
      const hit = this.hitTest(x, y);
      const items = [];
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
            }
          });
        }
        items.push({ label: "Delete", on: () => {
          this.select(c);
          this.deleteSelected();
        } });
      }
      if (y >= RULER_H && y < this.maskTop) {
        const track = Math.max(0, Math.min(this.trackCount - 1, this.trackOf(y)));
        const current = trackBlend(this.tl, track);
        for (const mode of BLEND_MODES) {
          items.push({
            label: `Track ${track} blend: ${mode}`,
            active: mode === current,
            on: () => {
              this.pushUndo();
              setTrackBlend(this.tl, track, mode);
              this.host.commit();
            }
          });
        }
      }
      if (items.length) this.openMenu(e.clientX, e.clientY, items);
    });
    /**
     * Close on a click OUTSIDE the menu.
     *
     * The target check is load-bearing: this listener is on `window` in the CAPTURE phase,
     * so without it a pointerdown on a menu ITEM tears the menu out of the DOM before the
     * item's own `click` ever dispatches - every option silently does nothing.
     */
    __publicField(this, "closeMenuOnce", (e) => {
      if (this.menu && e.target instanceof Node && this.menu.contains(e.target)) return;
      this.closeMenu();
    });
    __publicField(this, "onLeave", () => {
      if (this.drag) return;
      this.hover = { kind: "none" };
      this.requestRender();
    });
    __publicField(this, "onKey", (e) => {
      const step = e.shiftKey ? 10 : 1;
      const key = e.key.toLowerCase();
      const bound = (action, fallback) => key === this.host.getKey(action, fallback);
      let handled = true;
      if (bound("trimHead", "q")) this.trimEdgeToPlayhead("start");
      else if (bound("trimTail", "e")) this.trimEdgeToPlayhead("end");
      else if (bound("markIn", "i")) this.setIn(this.playhead);
      else if (bound("markOut", "o")) this.setOut(this.playhead);
      else if (bound("markClip", "x")) this.markClip();
      else if (bound("zoomFit", "f")) this.zoomFit();
      else switch (key) {
        case " ":
          this.transport.toggle();
          break;
        // J K L: the transport every editor has in their fingers, so not rebindable.
        case "j":
          this.transport.shuttle(-1);
          break;
        case "k":
          this.transport.stop();
          break;
        case "l":
          this.transport.shuttle(1);
          break;
        case "delete":
        case "backspace":
          this.deleteSelected();
          break;
        case "m":
          this.toggleMaskOverlay();
          break;
        case "=":
        case "+":
          this.zoomBy(1.6, this.playhead);
          break;
        case "-":
          this.zoomBy(1 / 1.6, this.playhead);
          break;
        case ",":
          this.seek(this.playhead - step);
          break;
        case ".":
          this.seek(this.playhead + step);
          break;
        case "home":
          this.seek(this.host.getStartFrame());
          break;
        case "end":
          this.seek(this.host.getStartFrame() + this.effCount() - 1);
          break;
        case "z":
          if (e.ctrlKey || e.metaKey) this.undo();
          else handled = false;
          break;
        case "y":
          if (e.ctrlKey || e.metaKey) this.redo();
          else handled = false;
          break;
        default:
          handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        this.requestRender();
      }
    });
    /**
     * Ctrl/Cmd + wheel zooms; plain and shift wheel pan, as does a trackpad horizontal axis.
     *
     * `{ passive: false }` on the listener is load-bearing: browsers treat wheel listeners
     * as passive by default and then IGNORE preventDefault, so without it Ctrl+wheel zooms
     * the whole PAGE instead of the timeline. stopPropagation is the other half - otherwise
     * the same event reaches ComfyUI graph canvas and zooms the graph underneath.
     */
    __publicField(this, "onWheel", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const { x } = this.localPos(e);
      if (e.ctrlKey || e.metaKey) {
        this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, this.frameOf(x));
        return;
      }
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.panBy(raw / this.logicalWidth * this.viewFrames);
    });
    this.host = host;
    this.transport = new Transport({
      getTimeline: () => host.getTimeline(),
      getFps: () => host.getFps(),
      getStartFrame: () => host.getStartFrame(),
      getEndFrame: () => this.host.getStartFrame() + this.effCount(),
      seek: (f) => this.seek(f, true),
      audioRefFor: (src) => {
        var _a;
        return ((_a = host.sourceFor(src)) == null ? void 0 : _a.ref) ?? null;
      },
      srcFpsFor: (src) => {
        var _a, _b;
        return ((_b = (_a = host.sourceFor(src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? host.getFps();
      }
    });
    this.transport.onChange = () => {
      if (this.transport.rate !== 1) pauseAllVideos();
      if (this.transport.rate === 0) this.host.commit();
      this.requestRender();
    };
    this.root = document.createElement("div");
    this.root.className = "nkd-tl";
    this.preview = document.createElement("canvas");
    this.preview.className = "nkd-tl-preview";
    this.pctx = this.preview.getContext("2d");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "nkd-tl-canvas";
    this.ctx = this.canvas.getContext("2d");
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
    setPooledReadyHandler(() => this.requestRender());
    this.root.addEventListener("keydown", this.onKey);
    this.root.tabIndex = 0;
  }
  // ── Control bar ─────────────────────────────────────────────────────────────
  buildBar() {
    const make = (inner, title, on) => {
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
    const icon = (name, title, on) => make(`<i class="pi ${name}"></i>`, title, on);
    const mdi = (name, fallback, title, on) => {
      var _a, _b;
      const b = make(`<i class="mdi ${name}"></i>`, title, on);
      void ((_b = (_a = document.fonts) == null ? void 0 : _a.ready) == null ? void 0 : _b.then(() => {
        if (!document.fonts.check(`16px "Material Design Icons"`)) {
          b.innerHTML = `<i class="pi ${fallback}"></i>`;
        }
      }).catch(() => {
      }));
      return b;
    };
    const bracket = (glyph, title, on) => make(`<span class="nkd-tl-brk">${glyph}</span>`, title, on);
    const paintMagnet = () => {
      magnet.classList.toggle("on", this.snapping);
      const i = magnet.querySelector("i");
      if (i == null ? void 0 : i.classList.contains("mdi")) {
        i.className = `mdi ${this.snapping ? "mdi-magnet-on" : "mdi-magnet"}`;
      }
    };
    const magnet = mdi("mdi-magnet-on", "pi-bolt", "Snapping (magnet)", () => {
      this.snapping = !this.snapping;
      paintMagnet();
    });
    magnet.classList.add("on");
    this.playBtn = icon(
      "pi-play",
      "Play / pause (Space) — J K L to shuttle",
      () => this.transport.toggle()
    );
    this.maskBtn = icon(
      "pi-eye-slash",
      "Show the mask over the picture (M)",
      () => this.toggleMaskOverlay()
    );
    this.bar.append(
      icon("pi-step-backward", "Reverse (J)", () => this.transport.shuttle(-1)),
      this.playBtn,
      icon("pi-step-forward", "Forward (L)", () => this.transport.shuttle(1)),
      bracket("[", "Mark in point at the playhead (I)", () => this.setIn(this.playhead)),
      bracket("]", "Mark out point at the playhead (O)", () => this.setOut(this.playhead)),
      mdi(
        "mdi-select-all",
        "pi-clone",
        "Mark clip: fit in/out to the selected clip (X)",
        () => this.markClip()
      ),
      icon(
        "pi-search-minus",
        "Zoom out (Ctrl + wheel)",
        () => this.zoomBy(1 / 1.6, this.playhead)
      ),
      icon(
        "pi-search-plus",
        "Zoom in (Ctrl + wheel)",
        () => this.zoomBy(1.6, this.playhead)
      ),
      mdi(
        "mdi-fit-to-screen",
        "pi-window-maximize",
        "Fit the whole timeline (F)",
        () => this.zoomFit()
      ),
      mdi(
        "mdi-arrow-collapse-horizontal",
        "pi-arrows-h",
        "Fit the range to the material (no gaps, no mask)",
        () => this.trimToMaterial()
      ),
      mdi(
        "mdi-content-cut",
        "pi-filter",
        "Crop the material to the in/out range (discards the rest)",
        () => this.cropToInOut()
      ),
      icon(
        "pi-sync",
        "Conform: take fps and resolution from the first clip",
        () => this.host.conformToFirstClip()
      ),
      magnet,
      this.maskBtn,
      icon(
        "pi-refresh",
        "Reload the connected media (after changing a file)",
        () => this.reloadSources()
      ),
      icon("pi-undo", "Undo (Ctrl+Z)", () => this.undo()),
      this.status
    );
  }
  // ── Derived state ───────────────────────────────────────────────────────────
  get tl() {
    return this.host.getTimeline();
  }
  get playhead() {
    return this.tl.ui.playhead;
  }
  /** Everything there is to look at, zoom aside. Never 0, or all the maths divides by it. */
  get contentFrames() {
    const span = timelineSpan(this.tl);
    const end = this.host.getStartFrame() + this.effCount();
    return Math.max(24, span, end);
  }
  /** First visible frame. */
  get viewStart() {
    return viewWindow(this.tl.ui, this.contentFrames).start;
  }
  /** How many frames the visible window spans. */
  get viewFrames() {
    return viewWindow(this.tl.ui, this.contentFrames).frames;
  }
  effCount() {
    return effectiveCount(
      this.tl,
      this.host.getStartFrame(),
      this.host.getFrameCount(),
      this.host.getQuantize(),
      this.host.getQuantizeN()
    );
  }
  get trackCount() {
    let max = MIN_VIDEO_TRACKS;
    for (const c of this.tl.clips) max = Math.max(max, c.track + 1);
    return Math.min(max, MAX_VIDEO_TRACKS);
  }
  /** Intrinsic height of the timeline canvas in logical px. */
  get timelineHeight() {
    return RULER_H + this.trackCount * TRACK_H + MASK_H + AUDIO_H;
  }
  /**
   * Pin the canvas height in CSS. Without this the canvas has no CSS height, falls back
   * to its `height` attribute, and `syncSize` reading `clientHeight` to size the backing
   * store makes the two feed each other - the canvas grows every frame and spills far
   * below the node.
   */
  applyTimelineHeight() {
    const h = this.timelineHeight;
    if (h === this.lastTimelineH) return false;
    this.lastTimelineH = h;
    this.canvas.style.height = `${h}px`;
    return true;
  }
  get logicalWidth() {
    return Math.max(1, this.canvas.clientWidth);
  }
  xOf(frame) {
    return (frame - this.viewStart) / this.viewFrames * this.logicalWidth;
  }
  frameOf(x) {
    return Math.round(this.viewStart + x / this.logicalWidth * this.viewFrames);
  }
  /** Row for a track. INVERTED on purpose: the highest track number is the topmost
   *  layer, so it must be the topmost ROW too. Drawing track 0 first would put the
   *  bottom layer at the top of the widget and read backwards against every NLE. */
  trackTop(track) {
    return RULER_H + (this.trackCount - 1 - track) * TRACK_H;
  }
  trackOf(y) {
    const row = Math.floor((y - RULER_H) / TRACK_H);
    return Math.max(0, Math.min(this.trackCount - 1, this.trackCount - 1 - row));
  }
  get maskTop() {
    return RULER_H + this.trackCount * TRACK_H;
  }
  get audioTop() {
    return this.maskTop + MASK_H;
  }
  laneOf(lane) {
    return lane === "video" ? this.tl.clips : lane === "mask" ? this.tl.masks : this.tl.audio;
  }
  laneTop(lane, track) {
    return lane === "video" ? this.trackTop(track) : lane === "mask" ? this.maskTop : this.audioTop;
  }
  laneHeight(lane) {
    return lane === "video" ? TRACK_H : lane === "mask" ? MASK_H : AUDIO_H;
  }
  // ── Hit-testing ─────────────────────────────────────────────────────────────
  hitTest(x, y) {
    if (y < RULER_H) {
      if (y >= IO_BAR_TOP - 2) {
        const dIn = Math.abs(x - this.xOf(this.host.getStartFrame()));
        const dOut = Math.abs(x - this.xOf(this.host.getStartFrame() + this.effCount()));
        if (Math.min(dIn, dOut) <= IO_GRAB_PX) {
          return dIn <= dOut ? { kind: "inPoint" } : { kind: "outPoint" };
        }
      }
      return Math.abs(x - this.xOf(this.playhead)) <= HANDLE_PX ? { kind: "playhead" } : { kind: "ruler" };
    }
    const lane = y >= this.audioTop ? "audio" : y >= this.maskTop ? "mask" : "video";
    const list = lane === "video" ? this.tl.clips.filter((c) => c.track === this.trackOf(y)) : this.laneOf(lane);
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const a = this.xOf(c.start);
      const b = this.xOf(c.start + c.length);
      if (x < a - HANDLE_PX || x > b + HANDLE_PX) continue;
      const top = this.laneTop(lane, c.track) + 3;
      if (lane !== "mask" && b - a > 44 && x >= b - MUTE_BOX && x <= b && y >= top && y <= top + CLIP_HEAD_H) {
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
  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.logicalWidth / Math.max(1, r.width)),
      y: (e.clientY - r.top) * (this.timelineHeight / Math.max(1, r.height))
    };
  }
  openMenu(clientX, clientY, items) {
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
        ev.preventDefault();
        ev.stopPropagation();
        it.on();
        this.closeMenu();
        this.requestRender();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    this.menu = menu;
    setTimeout(() => window.addEventListener("pointerdown", this.closeMenuOnce, true), 0);
  }
  closeMenu() {
    var _a;
    window.removeEventListener("pointerdown", this.closeMenuOnce, true);
    (_a = this.menu) == null ? void 0 : _a.remove();
    this.menu = null;
  }
  select(c) {
    this.selection.clear();
    this.selection.add(c.id);
  }
  // ── Actions ─────────────────────────────────────────────────────────────────
  scrubTo(x) {
    this.seek(this.frameOf(x));
  }
  seek(frame, fromTransport = false) {
    const max = Math.max(0, this.contentFrames - 1);
    this.tl.ui.playhead = Math.max(0, Math.min(max, Math.round(frame)));
    if (fromTransport) {
      this.requestRender();
      return;
    }
    if (this.transport.rate !== 0) this.transport.reanchor(this.tl.ui.playhead);
    this.host.commit();
  }
  /** Requested count BEFORE quantising. In/out edits work on this, never on the
   *  quantised result: feeding a quantised value back in would shrink the range a little
   *  on every pointermove and the out point would crawl left as you drag. */
  rawCount() {
    const explicit = this.host.getFrameCount();
    return explicit > 0 ? explicit : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
  }
  applyIn(frame) {
    const end = this.host.getStartFrame() + this.rawCount();
    const s = Math.max(0, Math.min(Math.round(frame), end - 1));
    this.host.setStartFrame(s);
    this.host.setFrameCount(Math.max(1, end - s));
  }
  applyOut(frame) {
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
  markClip() {
    const at = clipExtent(
      this.tl,
      this.playhead,
      this.selection.size ? this.selection : void 0
    );
    if (!at) return;
    this.pushUndo();
    this.host.setStartFrame(at.start);
    this.host.setFrameCount(Math.max(1, at.end - at.start));
    this.host.commit();
  }
  setIn(frame) {
    this.pushUndo();
    this.applyIn(frame);
  }
  setOut(frame) {
    this.pushUndo();
    this.applyOut(frame);
  }
  /**
   * Crop the output range to the material that actually exists, instead of leaving the
   * empty stretches to come out as gaps in `coverage`. The counterpart to letting a gap
   * BE a region to generate: sometimes you just want the excess gone.
   */
  trimToMaterial() {
    const r = materialRange(this.tl);
    if (!r) return;
    this.pushUndo();
    this.host.setStartFrame(r.start);
    this.host.setFrameCount(Math.max(1, r.end - r.start));
  }
  /** Remove the selected clips. Until now there was no way to take one off at all. */
  deleteSelected() {
    if (this.selection.size === 0) return;
    this.pushUndo();
    for (const lane of [
      this.tl.clips,
      this.tl.masks,
      this.tl.audio
    ]) {
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
  zoomBy(factor, anchorFrame) {
    const ui = this.tl.ui;
    const before = viewWindow(ui, this.contentFrames);
    const rel = (anchorFrame - before.start) / before.frames;
    ui.zoom = Math.min(MAX_ZOOM, Math.max(1, ui.zoom * factor));
    const after = viewWindow(ui, this.contentFrames);
    ui.scroll = anchorFrame - rel * after.frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }
  panBy(frames) {
    this.tl.ui.scroll += frames;
    this.clampScroll();
    this.host.commit();
    this.requestRender();
  }
  /** viewWindow already clamps; store the clamped value so it cannot creep. */
  clampScroll() {
    this.tl.ui.scroll = viewWindow(this.tl.ui, this.contentFrames).start;
  }
  zoomFit() {
    this.tl.ui.zoom = 1;
    this.tl.ui.scroll = 0;
    this.host.commit();
    this.requestRender();
  }
  /**
   * Throw away whatever falls outside the in/out range. The counterpart to fitting the
   * range to the material: here the range is what you decided, and the material gives.
   */
  cropToInOut() {
    const start = this.host.getStartFrame();
    const end = start + this.effCount();
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = cropToRange(
      this.tl,
      start,
      end,
      fps,
      (src) => {
        var _a, _b;
        return ((_b = (_a = this.host.sourceFor(src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? fps;
      }
    );
    if (!changed) {
      this.undoStack.pop();
      return;
    }
    this.selection.clear();
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
  trimEdgeToPlayhead(side) {
    const fps = this.host.getFps();
    this.pushUndo();
    const changed = trimToPlayhead(
      this.tl,
      this.playhead,
      side,
      fps,
      (src) => {
        var _a, _b;
        return ((_b = (_a = this.host.sourceFor(src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? fps;
      },
      this.selection.size ? this.selection : void 0
    );
    if (!changed) {
      this.undoStack.pop();
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
  reloadSources() {
    this.host.reloadSources();
    const fps = this.host.getFps();
    const before = JSON.stringify(this.tl);
    const changed = clampClipsToSources(
      this.tl,
      fps,
      (src) => this.host.srcFramesFor(src),
      (src) => {
        var _a, _b;
        return ((_b = (_a = this.host.sourceFor(src)) == null ? void 0 : _a.info) == null ? void 0 : _b.fps) ?? fps;
      }
    );
    if (changed && JSON.stringify(this.tl) !== before) {
      this.pushUndo();
      this.host.commit();
    }
    this.requestRender();
  }
  toggleMaskOverlay() {
    this.maskOverlay = !this.maskOverlay;
    this.maskBtn.classList.toggle("on", this.maskOverlay);
    this.maskBtn.innerHTML = `<i class="pi ${this.maskOverlay ? "pi-eye" : "pi-eye-slash"}"></i>`;
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
  checkFpsAgainstModel() {
    const mode = this.host.getQuantize();
    const want = nativeFpsFor(mode);
    const fps = this.host.getFps();
    const stamp = `${mode}|${fps}`;
    if (stamp === this.lastFpsWarning) return;
    this.lastFpsWarning = stamp;
    if (want === null || Math.abs(want - fps) < 0.01) return;
    this.host.notify(
      "Frame rate does not match the model",
      `${mode.replace(/\s*\(.*\)$/, "")} is trained at ${want} fps, but the timeline runs at ${fps}. The frame count will be valid, yet the result will play at the wrong speed. Set fps to ${want}, or switch the quantise preset.`,
      "warn"
    );
  }
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.tl));
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  applySnapshot(json) {
    const t = JSON.parse(json);
    const live = this.tl;
    live.clips = t.clips;
    live.audio = t.audio;
    live.ui = t.ui;
    this.host.commit();
  }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(prev);
    this.requestRender();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.tl));
    this.applySnapshot(next);
    this.requestRender();
  }
  /** Place a freshly connected slot, following the node's import mode. */
  addClipForSlot(src, frames, lane = "video") {
    if (slotInUse(this.tl, src)) return;
    const list = this.laneOf(lane);
    this.pushUndo();
    const mode = lane === "audio" ? "append" : this.host.getImportMode();
    const at = placementFor(this.tl, list, mode);
    list.push({
      id: newId(),
      src,
      track: lane === "video" ? at.track : 0,
      start: at.start,
      trimIn: 0,
      length: Math.max(1, Math.round(frames)),
      ...lane === "audio" ? { gain: 1 } : {}
    });
    sortClips(this.tl);
    this.host.commit();
    this.requestRender();
  }
  /** Drop clips whose slot no longer has anything connected. Returns true if it changed
   *  anything, so the caller knows whether to commit. */
  pruneToSlots(live) {
    let changed = false;
    for (const lane of [
      this.tl.clips,
      this.tl.masks,
      this.tl.audio
    ]) {
      const kept = lane.filter((c) => live.has(c.src));
      if (kept.length !== lane.length) {
        lane.length = 0;
        lane.push(...kept);
        changed = true;
      }
    }
    return changed;
  }
  infoFor(c) {
    var _a;
    return ((_a = this.host.sourceFor(c.src)) == null ? void 0 : _a.info) ?? null;
  }
  // ── Render ──────────────────────────────────────────────────────────────────
  requestRender() {
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
  syncSize(cv, ctx, logicalH) {
    var _a, _b, _c;
    const w = cv.clientWidth;
    if (w < 1 || logicalH < 1) return false;
    const graphScale = ((_c = (_b = (_a = window.app) == null ? void 0 : _a.canvas) == null ? void 0 : _b.ds) == null ? void 0 : _c.scale) ?? 1;
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
  render() {
    var _a;
    if (this.disposed) return;
    if (this.applyTimelineHeight()) (_a = this.onHeightChange) == null ? void 0 : _a.call(this);
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
    for (let t = 0; t < this.trackCount; t++) {
      const y = this.trackTop(t);
      ctx.fillStyle = t % 2 ? C.trackAlt : C.trackBg;
      ctx.fillRect(0, y, W, TRACK_H);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, y, W, 1);
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
    for (const [top, h] of [[this.maskTop, MASK_H], [this.audioTop, AUDIO_H]]) {
      ctx.fillStyle = C.trackAlt;
      ctx.fillRect(0, top, W, h);
      ctx.fillStyle = C.gridLine;
      ctx.fillRect(0, top, W, 1);
    }
    this.drawGaps(ctx, start, count);
    for (const c of this.tl.clips) this.drawClip(ctx, c, "video");
    for (const m of this.tl.masks) this.drawClip(ctx, m, "mask");
    for (const a of this.tl.audio) this.drawClip(ctx, a, "audio");
    this.drawOutside(ctx, W, H, start, count);
    this.drawPlayhead(ctx, H);
    this.updateStatus(fps, count);
    this.checkFpsAgainstModel();
  }
  drawRuler(ctx, W, fps) {
    ctx.fillStyle = C.bar;
    ctx.fillRect(0, 0, W, RULER_H);
    const steps = [1, 2, 5, 10, 24, 48, 120, 240, 480, 960, 1920, 4800];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (s / this.viewFrames * W >= 60) {
        step = s;
        break;
      }
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
      const label = step >= 24 ? `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}` : String(f);
      ctx.fillText(label, x + 3, RULER_H / 2 - 1);
    }
    const mode = this.host.getQuantize();
    if (mode !== QUANTIZE_FREE) {
      const start = this.host.getStartFrame();
      ctx.strokeStyle = "rgba(74,180,255,0.55)";
      for (const s of quantizeStops(
        this.contentFrames - start,
        mode,
        this.host.getQuantizeN()
      )) {
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
  drawInOutBar(ctx, W) {
    var _a;
    const a = this.xOf(this.host.getStartFrame());
    const b = this.xOf(this.host.getStartFrame() + this.effCount());
    const y = IO_BAR_TOP;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, y, W, IO_BAR_H);
    ctx.fillStyle = this.host.getQuantize() === QUANTIZE_FREE ? "rgba(74,180,255,0.85)" : "rgba(255,209,102,0.85)";
    ctx.fillRect(a, y, Math.max(1, b - a), IO_BAR_H);
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    const drawBracket = (x, glyph, hot) => {
      ctx.fillStyle = hot ? C.hover : "#f2f6fa";
      ctx.textAlign = glyph === "[" ? "left" : "right";
      ctx.fillText(glyph, glyph === "[" ? x - 1 : x + 1, y + IO_BAR_H / 2);
    };
    const dragging = (_a = this.drag) == null ? void 0 : _a.hit.kind;
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
  drawGaps(ctx, start, count) {
    const top = RULER_H;
    const h = this.trackCount * TRACK_H;
    const end = start + count;
    const spans = this.tl.clips.map((c) => [Math.max(c.start, start), Math.min(c.start + c.length, end)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
    let cursor = start;
    const paint = (a, b) => {
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
  drawClip(ctx, c, lane) {
    const x = this.xOf(c.start);
    const w = Math.max(2, this.xOf(c.start + c.length) - x);
    const y = this.laneTop(lane, c.track) + 3;
    const h = this.laneHeight(lane) - 6;
    const isHover = (this.hover.kind === "clip" || this.hover.kind === "edge") && this.hover.clip === c;
    const isDrag = this.drag && (this.drag.hit.kind === "clip" || this.drag.hit.kind === "edge") && this.drag.hit.clip === c;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 2);
    ctx.fillStyle = lane === "audio" ? C.audioFill : lane === "mask" ? C.maskFill : C.clipFill;
    ctx.fill();
    ctx.clip();
    const selected = this.selection.has(c.id);
    if (h > CLIP_HEAD_H + 4) {
      ctx.fillStyle = selected ? C.accent : lane === "audio" ? C.audioHead : lane === "mask" ? C.maskHead : C.clipHead;
      ctx.fillRect(x, y, w, CLIP_HEAD_H);
    }
    const src = this.host.sourceFor(c.src);
    const body = y + (h > CLIP_HEAD_H + 4 ? CLIP_HEAD_H : 0);
    const bodyH = y + h - body;
    if (src && bodyH > 6) {
      if (lane === "audio") this.drawWaveform(ctx, c, src.ref, x, body, w, bodyH);
      else if (src.info) this.drawFilmstrip(ctx, c, src.ref, src.info, x, body, w, bodyH);
    }
    if (w > 26) {
      ctx.fillStyle = selected ? "#0d1b24" : src ? C.clipName : C.dim;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(
        this.ellipsise(ctx, (src == null ? void 0 : src.label) ?? `${c.src} (no source)`, w - 12),
        x + 5,
        y + CLIP_HEAD_H / 2
      );
    }
    const info = src == null ? void 0 : src.info;
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
    if (selected) {
      ctx.fillStyle = "rgba(74,180,255,0.16)";
      ctx.fillRect(x, y, w, h);
    }
    if (isHover && w > 14) {
      ctx.fillStyle = C.hover;
      ctx.fillRect(x, y, 3, h);
      ctx.fillRect(x + w - 3, y, 3, h);
    }
    ctx.restore();
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 2);
    ctx.strokeStyle = isDrag ? C.active : selected ? C.accent : isHover ? C.hover : C.clipEdge;
    ctx.lineWidth = isDrag || selected || isHover ? 2 : 1;
    ctx.stroke();
  }
  /**
   * Tile stills along the clip so you can read the shot without playing it.
   *
   * Each tile shows the frame at ITS OWN position in the source, honouring trimIn and the
   * timeline/source rate difference - so trimming or slipping the clip re-reads the strip
   * and you see the change immediately.
   */
  drawFilmstrip(ctx, c, ref, info, x, y, w, h) {
    ensureThumbnails(ref, info, () => this.requestRender());
    const probe2 = thumbnailAt(ref, 0);
    if (!probe2) return;
    const tileW = Math.max(8, probe2.width / probe2.height * h);
    const fps = this.host.getFps();
    const srcFps = info.fps || fps;
    ctx.globalAlpha = 0.95;
    for (let tx = x; tx < x + w; tx += tileW) {
      const f = c.start + (tx - x) / Math.max(1, w) * c.length;
      const still = thumbnailAt(ref, sourceFrame(c, f, srcFps, fps) / (srcFps || 1));
      if (!still) break;
      ctx.drawImage(still, tx, y, Math.min(tileW, x + w - tx), h);
    }
    ctx.globalAlpha = 1;
  }
  /** Peaks across the clip's own trimmed span, so trimming re-reads the wave. */
  drawWaveform(ctx, c, ref, x, y, w, h) {
    ensureAudio(ref, () => this.requestRender());
    const peaks = peaksFor(ref);
    const buf = audioBufferFor(ref);
    if (!peaks || !buf) return;
    const totalFrames = Math.max(1, buf.duration * this.host.getFps());
    const from = c.trimIn / totalFrames;
    const to = (c.trimIn + c.length) / totalFrames;
    const mid = y + h / 2;
    ctx.fillStyle = "rgba(150,215,255,0.85)";
    for (let px = 0; px < w; px++) {
      const t = from + (to - from) * (px / Math.max(1, w));
      const peak = peaks[Math.max(0, Math.min(
        PEAK_BUCKETS - 1,
        Math.round(t * (PEAK_BUCKETS - 1))
      ))];
      if (!peak) continue;
      const half = Math.max(0.5, peak * h / 2);
      ctx.fillRect(x + px, mid - half, 1, half * 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillRect(x, mid, w, 1);
  }
  drawSpeaker(ctx, x, y, muted, hot) {
    const s = MUTE_BOX;
    const cx = x + s / 2;
    const cy = y + CLIP_HEAD_H / 2;
    ctx.save();
    ctx.strokeStyle = muted ? C.active : hot ? C.hover : "rgba(255,255,255,0.75)";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
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
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 5);
      ctx.lineTo(cx + 5, cy - 5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx + 2, cy, 4, -0.9, 0.9);
      ctx.stroke();
    }
    ctx.restore();
  }
  /** Truncate to fit, with an ellipsis - a name spilling out of its clip reads as a bug. */
  ellipsise(ctx, text, maxW) {
    if (maxW <= 0) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = lo + hi + 1 >> 1;
      if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : "";
  }
  /** Dim whatever falls outside [start_frame, start_frame+count). */
  drawOutside(ctx, W, H, start, count) {
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
  drawPlayhead(ctx, H) {
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
  drawPreview() {
    var _a;
    const [ow, oh] = this.host.getOutSize();
    this.preview.style.aspectRatio = `${Math.max(1, ow)} / ${Math.max(1, oh)}`;
    this.preview.style.maxWidth = `${Math.round(PREVIEW_MAX_H * (Math.max(1, ow) / Math.max(1, oh)))}px`;
    const h = this.preview.clientHeight;
    if (!this.syncSize(this.preview, this.pctx, h)) return;
    const w = this.preview.clientWidth;
    const ctx = this.pctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
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
    ctx.rect(0, 0, w, h);
    ctx.clip();
    let painted = false;
    for (const clip of stack) {
      const src = this.host.sourceFor(clip.src);
      if (!src) continue;
      const srcFps = ((_a = src.info) == null ? void 0 : _a.fps) ?? this.host.getFps();
      const sf = sourceFrame(clip, this.playhead, srcFps, this.host.getFps());
      const at = sf / (srcFps || 1);
      if (this.transport.rate === 1) followPlayback(src.ref, at);
      else seekTo(src.ref, at);
      const img = frameSource(src.ref);
      if (!img) continue;
      const iw = img.videoWidth || img.width;
      const ih = img.videoHeight || img.height;
      if (!iw || !ih) continue;
      const r = fitRect(iw, ih, w, h, this.host.getFit());
      const blend = trackBlend(this.tl, clip.track);
      ctx.globalCompositeOperation = painted && blend !== "normal" ? blend : "source-over";
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
  drawMaskOverlay(ctx, w, h) {
    var _a;
    const top = this.tl.masks.filter((c) => this.playhead >= c.start && this.playhead < c.start + c.length).sort((a, b) => b.track - a.track)[0];
    if (!top) return;
    const src = this.host.sourceFor(top.src);
    if (!src) return;
    const srcFps = ((_a = src.info) == null ? void 0 : _a.fps) ?? this.host.getFps();
    const at = sourceFrame(top, this.playhead, srcFps, this.host.getFps()) / (srcFps || 1);
    seekTo(src.ref, at);
    const img = frameSource(src.ref);
    if (!img) return;
    const iw = img.videoWidth || img.width;
    const ih = img.videoHeight || img.height;
    if (!iw || !ih) return;
    const tc = this.tintCanvas;
    if (tc.width !== Math.round(w) || tc.height !== Math.round(h)) {
      tc.width = Math.max(1, Math.round(w));
      tc.height = Math.max(1, Math.round(h));
    }
    const tctx = tc.getContext("2d");
    tctx.globalCompositeOperation = "source-over";
    tctx.clearRect(0, 0, tc.width, tc.height);
    tctx.fillStyle = "#000";
    tctx.fillRect(0, 0, tc.width, tc.height);
    const r = fitRect(iw, ih, tc.width, tc.height, this.host.getFit());
    tctx.drawImage(img, r.x, r.y, r.w, r.h);
    tctx.globalCompositeOperation = "multiply";
    tctx.fillStyle = "#ff3b30";
    tctx.fillRect(0, 0, tc.width, tc.height);
    tctx.globalCompositeOperation = "source-over";
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.65;
    ctx.drawImage(tc, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  updateStatus(fps, count) {
    const rate = this.transport.rate;
    this.playBtn.innerHTML = `<i class="pi ${rate === 0 ? "pi-play" : "pi-pause"}"></i>`;
    this.playBtn.classList.toggle("on", rate !== 0);
    const secs = count / (fps || 1);
    const mode = this.host.getQuantize();
    const raw = this.host.getFrameCount() > 0 ? this.host.getFrameCount() : Math.max(0, timelineSpan(this.tl) - this.host.getStartFrame());
    const q = mode !== QUANTIZE_FREE && raw !== count ? ` (${raw}→${count})` : "";
    const shuttle = Math.abs(rate) > 1 || rate < 0 ? ` · ${rate > 0 ? "" : "-"}${Math.abs(rate)}x` : "";
    const sel = this.selection.size ? ` · ${this.selection.size} selected` : "";
    this.status.textContent = `f ${this.playhead}${shuttle}${sel} · ${count} frames${q} · ${secs.toFixed(2)}s @ ${fps} fps`;
  }
  destroy() {
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
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}
const NODE_NAME = "NKDTimeline";
const EXT_NAME = "NKD.PreviewTools.Timeline";
const MIN_W = 380;
const SLOT_RE = /(?:^|\.)(media_\d+)$/;
const TENSOR_DEFAULT_FRAMES = 24;
const KEY_SETTINGS = [
  {
    action: "trimHead",
    id: "NKD.Timeline.Key.TrimHead",
    label: "Trim head to playhead",
    def: "q"
  },
  {
    action: "trimTail",
    id: "NKD.Timeline.Key.TrimTail",
    label: "Trim tail to playhead",
    def: "e"
  },
  { action: "markIn", id: "NKD.Timeline.Key.MarkIn", label: "Mark in", def: "i" },
  { action: "markOut", id: "NKD.Timeline.Key.MarkOut", label: "Mark out", def: "o" },
  {
    action: "markClip",
    id: "NKD.Timeline.Key.MarkClip",
    label: "Mark clip (fit in/out to the clip)",
    def: "x"
  },
  { action: "zoomFit", id: "NKD.Timeline.Key.ZoomFit", label: "Fit timeline", def: "f" }
];
const KEY_SETTING_BY_ACTION = new Map(KEY_SETTINGS.map((k) => [k.action, k.id]));
function readSetting(id, fallback) {
  var _a, _b, _c;
  try {
    const v = (_c = (_b = (_a = app.extensionManager) == null ? void 0 : _a.setting) == null ? void 0 : _b.get) == null ? void 0 : _c.call(_b, id);
    return typeof v === "string" && v.length ? v.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}
const ROW_SAFETY = 8;
const MAX_INSET = 48;
console.log("[NKD Timeline] rev 3.0.0");
const findW = (node, name) => {
  var _a;
  return (_a = node.widgets) == null ? void 0 : _a.find((w) => w.name === name);
};
function hideWidget(w) {
  var _a;
  if (!w) return;
  w.hidden = true;
  if (w.options) w.options.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {
  };
  if ((_a = w.element) == null ? void 0 : _a.style) w.element.style.display = "none";
}
function keepDomWidgetSized(node, container) {
  const MAX_MARGIN = 40;
  let enforcing = false;
  let goodMargin = 15;
  const vueMode = () => {
    var _a;
    return !!((_a = window.LiteGraph) == null ? void 0 : _a.vueNodesMode);
  };
  const clamp = () => {
    var _a, _b;
    if (enforcing) return;
    if (vueMode()) {
      if (container.style.width) container.style.width = "";
      const el = document.querySelector(`[data-node-id="${node.id}"]`);
      if (el && el.style.minWidth !== `${MIN_W}px`) el.style.minWidth = `${MIN_W}px`;
      return;
    }
    const nodeW = (_a = node.size) == null ? void 0 : _a[0];
    if (!nodeW) return;
    const hostW = ((_b = container.parentElement) == null ? void 0 : _b.clientWidth) ?? 0;
    const broken = hostW > 0 && (hostW > nodeW * 1.2 || hostW < nodeW * 0.7);
    if (!broken) {
      if (container.style.width) {
        enforcing = true;
        container.style.width = "";
        requestAnimationFrame(() => {
          enforcing = false;
        });
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
      requestAnimationFrame(() => {
        enforcing = false;
      });
    }
  };
  clamp();
  const ro = new ResizeObserver(clamp);
  ro.observe(container);
  const origResize = node.onResize;
  node.onResize = function(...args) {
    origResize == null ? void 0 : origResize.apply(this, args);
    clamp();
  };
  const iv = window.setInterval(clamp, 250);
  return () => {
    ro.disconnect();
    clearInterval(iv);
  };
}
function makeHost(node, state) {
  const numW = (name, def) => {
    var _a;
    const v = Number((_a = findW(node, name)) == null ? void 0 : _a.value);
    return Number.isFinite(v) ? v : def;
  };
  const setW = (name, value) => {
    var _a;
    const w = findW(node, name);
    if (!w || w.value === value) return;
    w.value = value;
    (_a = w.callback) == null ? void 0 : _a.call(w, value);
  };
  const srcCache = /* @__PURE__ */ new Map();
  const host = {
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
    getQuantize: () => {
      var _a;
      return ((_a = findW(node, "quantize")) == null ? void 0 : _a.value) ?? "free";
    },
    getQuantizeN: () => Math.max(1, Math.round(numW("quantize_n", 8))),
    getFit: () => {
      var _a;
      return ((_a = findW(node, "fit")) == null ? void 0 : _a.value) ?? "contain";
    },
    getImportMode: () => {
      var _a;
      return ((_a = findW(node, "import_mode")) == null ? void 0 : _a.value) ?? "stack";
    },
    getKey: (action, fallback) => readSetting(KEY_SETTING_BY_ACTION.get(action) ?? "", fallback),
    srcFramesFor(src) {
      var _a, _b;
      const info = (_a = host.sourceFor(src)) == null ? void 0 : _a.info;
      if (info == null ? void 0 : info.frame_count) return info.frame_count;
      const ref = (_b = srcCache.get(src)) == null ? void 0 : _b.ref;
      const buf = ref && audioBufferFor(ref);
      return buf ? Math.round(buf.duration * host.getFps()) : null;
    },
    reloadSources() {
      bustCaches();
      srcCache.clear();
      node.setDirtyCanvas(true, true);
    },
    notify(summary, detail, severity = "info") {
      var _a, _b, _c;
      (_c = (_b = (_a = app.extensionManager) == null ? void 0 : _a.toast) == null ? void 0 : _b.add) == null ? void 0 : _c.call(_b, {
        severity,
        summary,
        detail,
        life: 8e3
      });
    },
    getOutSize() {
      var _a;
      const w = Math.round(numW("width", 0));
      const h = Math.round(numW("height", 0));
      if (w > 0 && h > 0) return [w, h];
      const first = state.tl.clips[0];
      const info = first ? (_a = srcCache.get(first.src)) == null ? void 0 : _a.info : null;
      return info ? [info.width, info.height] : [16, 9];
    },
    sourceFor(src) {
      const hit = srcCache.get(src);
      if (hit) {
        if (!hit.info) hit.info = cachedInfo(hit.ref) ?? null;
        return hit;
      }
      const ref = resolveSource(node, src);
      if (!ref) return null;
      const entry = { ref, info: cachedInfo(ref) ?? null, label: ref.filename };
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
      const out = { video: [], image: [], mask: [], audio: [] };
      for (const inp of node.inputs ?? []) {
        const m = SLOT_RE.exec(inp.name ?? "");
        if (!m || inp.link == null) continue;
        const kind = slotKind(node, m[1]);
        if (kind) out[kind].push(m[1]);
      }
      return {
        videos: out.video,
        images: out.image,
        masks: out.mask,
        audios: out.audio
      };
    },
    conformToFirstClip(from) {
      var _a;
      const first = state.tl.clips[0];
      const info = from ?? (first ? (_a = host.sourceFor(first.src)) == null ? void 0 : _a.info : null);
      if (!info) return;
      setW("fps", Number(info.fps.toFixed(3)));
      setW("width", info.width);
      setW("height", info.height);
      node.setDirtyCanvas(true, true);
    },
    clearSourceCache: () => srcCache.clear(),
    /** Read the cache WITHOUT resolving, so the swap detector can compare against it. */
    peekSource: (src) => srcCache.get(src),
    dropSource: (src) => {
      srcCache.delete(src);
    }
  };
  return host;
}
app.registerExtension({
  name: EXT_NAME,
  // Surfaced in ComfyUI's own Settings dialog under "NKD Timeline", so the shortcuts are
  // discoverable and rebindable in the place users already look for them.
  settings: KEY_SETTINGS.map((k) => ({
    id: k.id,
    name: k.label,
    type: "text",
    defaultValue: k.def,
    category: ["NKD Timeline", "Shortcuts", k.label],
    tooltip: `Single key, lower-case. Default: ${k.def}`
  })),
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData == null ? void 0 : nodeData.name) !== NODE_NAME) return;
    if (nodeType.prototype.__nkdTimelineWrapped) return;
    nodeType.prototype.__nkdTimelineWrapped = true;
    const origCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function() {
      var _a;
      const result = origCreated == null ? void 0 : origCreated.apply(this, arguments);
      ensureStyles();
      const node = this;
      const dataW = findW(node, "timeline");
      hideWidget(dataW);
      const ghost = (_a = node.inputs) == null ? void 0 : _a.findIndex((i) => i.name === "timeline");
      if (ghost >= 0) node.removeInput(ghost);
      const state = { tl: parseTimeline(dataW == null ? void 0 : dataW.value) };
      const host = makeHost(node, state);
      const editor = new TimelineEditor(host);
      const container = document.createElement("div");
      container.style.width = "100%";
      container.style.minWidth = `${MIN_W}px`;
      container.appendChild(editor.root);
      let measured = 0;
      let inset = 0;
      const estimate = () => {
        var _a2;
        const w = Math.max(((_a2 = node.size) == null ? void 0 : _a2[0]) ?? MIN_W, MIN_W);
        const [ow, oh] = host.getOutSize();
        return Math.min(Math.round((w - 24) * (oh / Math.max(1, ow))), PREVIEW_MAX_H) + editor.timelineHeight + 40;
      };
      const heightFor = () => (measured > 0 ? measured : estimate()) + ROW_SAFETY + inset;
      node.addDOMWidget("nkd_timeline", "NKD_TIMELINE", container, {
        getValue: () => (dataW == null ? void 0 : dataW.value) ?? "",
        setValue: (v) => {
          if (dataW) dataW.value = v;
          state.tl = parseTimeline(v);
          editor.requestRender();
        },
        serialize: false,
        hideOnZoom: false,
        getMinHeight: heightFor,
        getMaxHeight: heightFor,
        getHeight: heightFor
      });
      const releaseWidth = keepDomWidgetSized(node, container);
      const resizeToContent = () => {
        node.setSize([node.size[0], node.computeSize()[1]]);
        node.setDirtyCanvas(true, true);
      };
      let settling = false;
      const ro = new ResizeObserver(() => {
        var _a2;
        if (settling) return;
        const h = editor.root.offsetHeight;
        if (h < 1) return;
        if (Math.abs(h - measured) <= 1) return;
        measured = h;
        settling = true;
        resizeToContent();
        requestAnimationFrame(() => {
          settling = false;
        });
        const hostH = ((_a2 = container.parentElement) == null ? void 0 : _a2.clientHeight) ?? 0;
        if (hostH > 0) {
          const missing = heightFor() - hostH;
          if (missing > inset && missing <= MAX_INSET) inset = Math.round(missing);
        }
      });
      ro.observe(editor.root);
      editor.onHeightChange = () => requestAnimationFrame(resizeToContent);
      const origResize = node.onResize;
      node.onResize = function(size) {
        origResize == null ? void 0 : origResize.apply(this, arguments);
        if (size[0] < MIN_W) size[0] = MIN_W;
        size[1] = this.computeSize(size[0])[1];
        editor.requestRender();
      };
      const origComputeSize = node.computeSize.bind(node);
      node.computeSize = function() {
        const sz = origComputeSize();
        const needed = heightFor();
        if (sz[1] < needed) sz[1] = needed;
        if (sz[0] < MIN_W) sz[0] = MIN_W;
        return sz;
      };
      const syncQuantumStep = () => {
        var _a2;
        const w = findW(node, "frame_count");
        if (!(w == null ? void 0 : w.options)) return;
        const grid = quantizeGrid(host.getQuantize(), host.getQuantizeN());
        const step = grid ? grid[0] : 1;
        if (w.options.step2 === step) return;
        w.options.step2 = step;
        w.options.step = step * 10;
        const snapped = quantizeCount(
          Number(w.value) || 0,
          host.getQuantize(),
          host.getQuantizeN()
        );
        if (snapped > 0 && snapped !== w.value) {
          w.value = snapped;
          (_a2 = w.callback) == null ? void 0 : _a2.call(w, snapped);
        }
      };
      requestAnimationFrame(() => {
        measured = editor.root.offsetHeight || 0;
        syncQuantumStep();
        resizeToContent();
        editor.requestRender();
      });
      const syncSlots = () => {
        host.clearSourceCache();
        const { videos, images, masks, audios } = host.connectedSlots();
        const live = /* @__PURE__ */ new Set([...videos, ...images, ...masks, ...audios]);
        if (editor.pruneToSlots(live)) host.commit();
        for (const slot of videos) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = (info) => {
            if (!info) return;
            if (state.tl.clips.length === 0 && state.tl.masks.length === 0) {
              host.conformToFirstClip(info);
            }
            const fps = host.getFps();
            editor.addClipForSlot(
              slot,
              Math.round(info.frame_count * (fps / (info.fps || fps))),
              "video"
            );
          };
          if (src.info) place(src.info);
          else void probe(src.ref).then(place);
        }
        const fallback = Math.max(1, host.getFrameCount() || TENSOR_DEFAULT_FRAMES);
        for (const slot of images) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "video");
        }
        for (const slot of masks) {
          if (!slotInUse(state.tl, slot)) editor.addClipForSlot(slot, fallback, "mask");
        }
        for (const slot of audios) {
          if (slotInUse(state.tl, slot)) continue;
          const src = host.sourceFor(slot);
          if (!src) continue;
          const place = () => {
            const buf = audioBufferFor(src.ref);
            editor.addClipForSlot(
              slot,
              buf ? Math.round(buf.duration * host.getFps()) : fallback,
              "audio"
            );
          };
          if (audioBufferFor(src.ref)) place();
          else ensureAudio(src.ref, place);
        }
        const refs = [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => {
          var _a2;
          return (_a2 = host.sourceFor(c.src)) == null ? void 0 : _a2.ref;
        }).filter(Boolean);
        releaseUnused(refs);
        editor.requestRender();
      };
      const origConn = node.onConnectionsChange;
      node.onConnectionsChange = function(...args) {
        const r = origConn == null ? void 0 : origConn.apply(this, args);
        requestAnimationFrame(syncSlots);
        return r;
      };
      const origConfigure = node.onConfigure;
      node.onConfigure = function(...args) {
        const r = origConfigure == null ? void 0 : origConfigure.apply(this, args);
        requestAnimationFrame(() => {
          var _a2;
          state.tl = parseTimeline((_a2 = findW(node, "timeline")) == null ? void 0 : _a2.value);
          syncSlots();
          resizeToContent();
          editor.requestRender();
        });
        return r;
      };
      const detectSourceSwaps = () => {
        for (const slot of new Set(
          [...state.tl.clips, ...state.tl.masks, ...state.tl.audio].map((c) => c.src)
        )) {
          const cached = host.peekSource(slot);
          if (!cached) continue;
          const now = resolveSource(node, slot);
          if (!now || now.filename === cached.ref.filename) continue;
          forget(cached.ref);
          host.dropSource(slot);
          editor.requestRender();
        }
      };
      const tick = window.setInterval(() => {
        syncQuantumStep();
        detectSourceSwaps();
        editor.requestRender();
      }, 300);
      const origRemoved = node.onRemoved;
      node.onRemoved = function(...args) {
        window.clearInterval(tick);
        ro.disconnect();
        releaseWidth();
        editor.destroy();
        releaseUnused([]);
        origRemoved == null ? void 0 : origRemoved.apply(this, args);
      };
      requestAnimationFrame(syncSlots);
      return result;
    };
  }
});
