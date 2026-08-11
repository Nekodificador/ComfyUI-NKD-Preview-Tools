/**
 * 😺NKD Timeline — resolución y decodificación de medios en el navegador.
 *
 * Dos decisiones que definen el rendimiento de todo el widget:
 *
 * 1. **El fichero se sirve CRUDO por `/view`.** aiohttp lo entrega con `FileResponse`,
 *    que soporta Range, así que el `<video>` hace seek nativo. Video Helper Suite
 *    transcodifica cada preview a un WebM en streaming sin Range — por eso su preview no
 *    se puede escrubear. No repetir ese error.
 *
 * 2. **Los metadatos exactos vienen del backend.** `<video>.duration` es poco fiable y el
 *    conteo de frames no está expuesto en el DOM; `/nkd/timeline/probe` los saca con PyAV.
 */
import { api } from "../comfyRuntime";

export type MediaRef = { filename: string; subfolder: string; type: string };
export type MediaInfo = {
  fps: number; frame_count: number; duration: number; width: number; height: number;
};

const refKey = (r: MediaRef) => `${r.type}|${r.subfolder}|${r.filename}`;

/** URL del fichero crudo. Vía `api.apiURL` para no romperse tras un proxy o en Desktop
 *  — SA-Nodes escribe "/view?..." a pelo y se rompe ahí. */
/** Bumped by `bustCaches`, and part of every media URL. Overwriting a file keeps its
 *  NAME, so without this the browser would keep serving the old bytes from its own HTTP
 *  cache no matter how much of ours we clear. */
let cacheBust = 0;

export function viewUrl(ref: MediaRef): string {
  const q = new URLSearchParams({
    filename: ref.filename, type: ref.type || "input", subfolder: ref.subfolder || "",
  });
  if (cacheBust) q.set("_nkd", String(cacheBust));
  return api.apiURL(`/view?${q}`);
}

/**
 * Drop every cached view of the media and force a re-fetch.
 *
 * Two different staleness problems: a DIFFERENT file (caught automatically by comparing
 * the resolved reference) and the SAME file with new content, which nothing can detect
 * from the outside - hence the manual button and the URL counter.
 */
export function bustCaches(): void {
  cacheBust += 1;
  infoCache.clear();
  thumbCache.clear();
  audioCache.clear();
  peakCache.clear();
  releaseUnused([]);
}

/** Forget one source, used when a slot silently starts pointing somewhere else. */
export function forget(ref: MediaRef): void {
  const key = refKey(ref);
  stripRefs.delete(key);
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

// ── Resolución del origen a través del grafo ──────────────────────────────────

const FILE_WIDGETS = ["file", "video", "audio", "image", "filename", "path"];
const looksLikeFile = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v !== "none" && /\.[a-z0-9]{2,5}$/i.test(v);

/**
 * Sube por el enlace conectado a `slotName` buscando el nodo que realmente tiene un
 * fichero. Cubre `Load Video → Timeline` (el caso dominante) y cadenas cortas del tipo
 * `Load Video → Trim → Timeline`.
 *
 * ponytail: si la cadena es larga o pasa por un subgrafo, esto devuelve null y el bloque
 * se dibuja como marcador de posición. El empuje de metadatos en ejecución vía websocket
 * cubre ese caso restante — fase 3, no ahora.
 */
export function resolveSource(node: any, slotName: string, maxDepth = 6,
                              depth = 0): MediaRef | null {
  if (depth > maxDepth) return null;
  const slot = node?.inputs?.find((i: any) => i.name === slotName || i.name?.endsWith(`.${slotName}`));
  if (!slot || slot.link == null) return null;
  const link = node.graph?.links?.[slot.link];
  const src = link && node.graph?.getNodeById(link.origin_id);
  if (!src) return null;

  for (const name of FILE_WIDGETS) {
    const w = src.widgets?.find((x: any) => x.name === name);
    if (w && looksLikeFile(w.value)) {
      const raw = String(w.value);
      // ComfyUI anota el origen como "sub/dir/fichero.mp4 [input]".
      const m = /^(.*?)\s*\[(\w+)\]$/.exec(raw);
      const clean = m ? m[1] : raw;
      const cut = clean.lastIndexOf("/");
      return {
        filename: cut >= 0 ? clean.slice(cut + 1) : clean,
        subfolder: cut >= 0 ? clean.slice(0, cut) : "",
        type: m ? m[2] : "input",
      };
    }
  }
  // Sin fichero propio: seguir subiendo por su primera entrada conectada.
  for (const inp of src.inputs ?? []) {
    if (inp.link == null) continue;
    const up = resolveSource(src, inp.name, maxDepth, depth + 1);
    if (up) return up;
  }
  return null;
}

/** What kind of media is wired into a slot, read from the LINK rather than the socket.
 *
 * The socket itself is multi-type ("VIDEO,IMAGE,MASK,AUDIO"), so it cannot say what is
 * actually connected. The link carries the concrete type; if a frontend build leaves it
 * unset, the origin node output is the fallback. Renderer-independent either way.
 */
export type MediaKind = "video" | "image" | "mask" | "audio";

export function slotKind(node: any, slotName: string): MediaKind | null {
  const slot = node?.inputs?.find(
    (i: any) => i.name === slotName || i.name?.endsWith(`.${slotName}`));
  if (!slot || slot.link == null) return null;
  const link = node.graph?.links?.[slot.link];
  let type = link?.type;
  if (!type && link) {
    const src = node.graph?.getNodeById(link.origin_id);
    type = src?.outputs?.[link.origin_slot]?.type;
  }
  const t = String(type ?? "").toUpperCase();
  // VIDEO and AUDIO first: an upstream that reports a union would otherwise be read as
  // whichever name happens to be checked earliest.
  if (t.includes("VIDEO")) return "video";
  if (t.includes("AUDIO")) return "audio";
  if (t.includes("MASK")) return "mask";
  if (t.includes("IMAGE")) return "image";
  return null;
}

// ── Sondeo de metadatos ───────────────────────────────────────────────────────

const infoCache = new Map<string, MediaInfo>();
const infoPending = new Map<string, Promise<MediaInfo | null>>();

/** Metadatos exactos, cacheados y con las peticiones en vuelo deduplicadas: varios
 *  clips de la misma fuente no disparan varios sondeos. */
export function probe(ref: MediaRef): Promise<MediaInfo | null> {
  const key = refKey(ref);
  const hit = infoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const flight = infoPending.get(key);
  if (flight) return flight;

  const q = new URLSearchParams({
    filename: ref.filename, type: ref.type || "input", subfolder: ref.subfolder || "",
  });
  const p = api.fetchApi(`/nkd/timeline/probe?${q}`)
    .then((r: Response) => (r.ok ? r.json() : null))
    .then((info: MediaInfo | null) => {
      if (info && info.frame_count > 0) infoCache.set(key, info);
      return info;
    })
    .catch(() => null)
    .finally(() => infoPending.delete(key));
  infoPending.set(key, p);
  return p;
}

export const cachedInfo = (ref: MediaRef): MediaInfo | undefined =>
  infoCache.get(refKey(ref));

// ── Pool de elementos <video> ─────────────────────────────────────────────────

type Pooled = {
  el: HTMLVideoElement;
  /** Último frame decodificado con éxito. Mientras el <video> busca, `drawImage` daría
   *  negro; re-pintar este buffer es lo que hace que el scrub no parpadee.
   *  (El truco viene de SA-Nodes/node_setup.js.) */
  good: HTMLCanvasElement;
  hasGood: boolean;
  wantTime: number;
  seeking: boolean;
  /** Watchdog for a seek that never reports back. Without it one lost `seeked` wedges the
   *  element for the rest of the session. */
  guard: number;
};

const pool = new Map<string, Pooled>();

function makePooled(ref: MediaRef): Pooled {
  const el = document.createElement("video");
  el.src = viewUrl(ref);
  el.muted = true;             // sin esto el navegador bloquea cualquier reproducción
  el.playsInline = true;
  el.preload = "auto";
  el.crossOrigin = "anonymous";
  const entry: Pooled = {
    el, good: document.createElement("canvas"), hasGood: false, wantTime: -1,
    seeking: false, guard: 0,
  };
  // Metadata is what makes the element seekable. Any time requested before this point was
  // parked rather than applied, so apply it now.
  el.addEventListener("loadedmetadata", () => applySeek(entry));
  el.addEventListener("seeked", () => {
    window.clearTimeout(entry.guard);
    entry.seeking = false;
    captureGood(entry);
    // Mientras buscábamos pudo pedirse otro instante: atenderlo ahora.
    if (entry.wantTime >= 0 && Math.abs(entry.wantTime - el.currentTime) > 1e-3) {
      applySeek(entry);
    }
  });
  el.addEventListener("loadeddata", () => {
    captureGood(entry);
    onPooledReady?.();
    // Fetch the audio only once the picture has its data. Pulling the whole file down for
    // decodeAudioData in parallel competes with the element's own range requests for the
    // per-host connection budget, and the picture is what the user is looking at.
    ensureAudio(ref, () => onPooledReady?.());
  });
  return entry;
}

function captureGood(p: Pooled): void {
  const { el, good } = p;
  if (!el.videoWidth || !el.videoHeight) return;
  if (good.width !== el.videoWidth) good.width = el.videoWidth;
  if (good.height !== el.videoHeight) good.height = el.videoHeight;
  try {
    good.getContext("2d")!.drawImage(el, 0, 0);
    p.hasGood = true;
  } catch {
    /* el frame aún no es dibujable */
  }
}

/**
 * Ask the element to seek, but only once it can.
 *
 * Assigning `currentTime` while `readyState` is HAVE_NOTHING is IGNORED by the browser -
 * silently, without throwing - so `seeked` never fires. Setting `seeking = true` around
 * that leaves the flag stuck forever, every later seek short-circuits on it, and the
 * preview freezes on whatever frame was captured first. It only ever worked after a hard
 * reload because the cached file has its metadata ready in the same tick.
 */
function applySeek(p: Pooled): void {
  if (p.seeking || p.wantTime < 0) return;
  if (p.el.readyState < 1) return;   // not seekable yet; loadedmetadata will retry
  p.seeking = true;
  try {
    p.el.currentTime = p.wantTime;
  } catch {
    p.seeking = false;
    return;
  }
  // A seek that never reports back must not wedge the element permanently.
  window.clearTimeout(p.guard);
  p.guard = window.setTimeout(() => {
    p.seeking = false;
    captureGood(p);
    onPooledReady?.();
  }, 2000);
}

/** Called whenever a pooled element gains something new to show, so the editor can
 *  repaint instead of waiting for the next poll. */
let onPooledReady: (() => void) | null = null;
export function setPooledReadyHandler(fn: () => void): void {
  onPooledReady = fn;
}

export function videoFor(ref: MediaRef): HTMLVideoElement {
  const key = refKey(ref);
  let p = pool.get(key);
  if (!p) {
    p = makePooled(ref);
    pool.set(key, p);
  }
  return p.el;
}

/** Pide un instante. Coalescente: durante un arrastre llegan decenas de peticiones por
 *  segundo y el `<video>` solo puede atender una a la vez. */
export function seekTo(ref: MediaRef, seconds: number, tolerance = 0.02): void {
  const p = pool.get(refKey(ref)) ?? makePooled(ref);
  pool.set(refKey(ref), p);
  const want = Math.max(0, seconds);
  // Pedir el instante en el que el elemento YA está no puede cambiar un píxel, y ocupa el
  // decodificador igual. Medido antes de esto: 78 de 78 seeks en reposo y 340 de 468
  // arrastrando eran exactamente eso. `tolerance` es medio frame de la FUENTE, que es lo
  // que "el mismo frame" significa; la pasa el llamante, que es quien sabe su cadencia.
  //
  // Esto es lo ÚNICO que sobrevivió del intento de borrar el canvas `good`. Aquel canvas
  // resultó no ser deuda: es lo que permite que una capa siga aportando imagen mientras
  // busca, y sin él el overlay de máscara desaparece durante el movimiento y la imagen
  // avanza a tirones. Medir el desperdicio no basta para saber qué se puede quitar.
  if (p.el.readyState >= 1 && !p.seeking
      && Math.abs(p.el.currentTime - want) < tolerance) {
    p.wantTime = want;
    return;
  }
  p.wantTime = want;
  applySeek(p);
}

/** Lo que hay que pintar AHORA: el frame vivo si está listo, y si no el último bueno. */
/**
 * Let the element PLAY and only correct it when it has drifted.
 *
 * During playback, seeking once per displayed frame is what makes a preview stutter: an
 * h264 seek is far more expensive than simply decoding forward. So while running at 1x we
 * hand the browser the job it is good at and step in only past the drift threshold - big
 * enough to absorb ordinary jitter, small enough that a cut is never visibly late.
 */
const DRIFT_S = 0.25;

export function followPlayback(ref: MediaRef, seconds: number): void {
  const p = pool.get(refKey(ref)) ?? makePooled(ref);
  pool.set(refKey(ref), p);
  if (p.el.paused) {
    p.wantTime = Math.max(0, seconds);
    applySeek(p);
    void p.el.play().catch(() => { /* autoplay policy, or not ready yet */ });
    return;
  }
  if (Math.abs(p.el.currentTime - seconds) > DRIFT_S) {
    p.wantTime = Math.max(0, seconds);
    applySeek(p);
  }
}

/** Stop every pooled element. Called when the transport stops, so a clip that scrolled out
 *  from under the playhead does not keep decoding in the background. */
export function pauseAllVideos(): void {
  for (const p of pool.values()) {
    if (!p.el.paused) p.el.pause();
  }
}

const stripRefs = new Set<string>();

/**
 * The picture to draw for a source at `seconds`, whatever kind of source it is.
 *
 * The single place that knows a TENSOR source has no video element behind it. Pointing
 * the pool at its contact sheet would spawn a `<video>` on a PNG: no error, no `seeked`,
 * just a slot that never draws - so route strips to their stills and leave the pool to
 * the sources that actually have a file to seek.
 */
export function pictureAt(ref: MediaRef, seconds: number,
                          playing: boolean): CanvasImageSource | null {
  if (stripRefs.has(refKey(ref))) return thumbnailAt(ref, seconds);
  if (playing) followPlayback(ref, seconds);
  else seekTo(ref, seconds, 0.02);
  return frameSource(ref);
}

export function frameSource(ref: MediaRef): CanvasImageSource | null {
  const p = pool.get(refKey(ref));
  if (!p) return null;
  if (!p.seeking && p.el.readyState >= 2) return p.el;
  return p.hasGood ? p.good : null;
}

/** Suelta los elementos que ya no usa ningún clip — un `<video>` retenido mantiene el
 *  fichero decodificándose en memoria. */
export function releaseUnused(active: Iterable<MediaRef>): void {
  const keep = new Set<string>();
  for (const r of active) keep.add(refKey(r));
  for (const [key, p] of pool) {
    if (keep.has(key)) continue;
    window.clearTimeout(p.guard);
    p.el.removeAttribute("src");
    p.el.load();
    pool.delete(key);
  }
}

// ── Filmstrip thumbnails ──────────────────────────────────────────────────────
// Extracted in the browser from the raw file: no server round trip, no ffmpeg, and it
// starts showing frames while it is still working.

export type Thumb = { time: number; canvas: HTMLCanvasElement };

const thumbCache = new Map<string, Thumb[]>();
const thumbJobs = new Map<string, Promise<void>>();

/** How many stills to pull. Enough to read the shot, few enough to stay cheap - and
 *  fewer for long sources, where seeking is what costs. */
function thumbCount(duration: number): number {
  return Math.max(6, Math.min(48, Math.ceil(duration * 2)));
}

/**
 * Fill the strip for a source, calling `onFrame` as each still lands so the UI can paint
 * progressively instead of waiting for the whole run.
 *
 * Uses its OWN <video>, never the preview pool: thumbnail seeking and scrub seeking would
 * otherwise fight over the same element and both would stutter.
 */
export function ensureThumbnails(ref: MediaRef, info: MediaInfo,
                                 onFrame: () => void): Thumb[] {
  const key = refKey(ref);
  const have = thumbCache.get(key);
  if (have) return have;
  if (thumbJobs.has(key)) return [];

  const strip: Thumb[] = [];
  thumbCache.set(key, strip);
  const job = new Promise<void>((resolve) => {
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
      // Sample at the MIDDLE of each slice: the first frame of a shot is often a fade.
      el.currentTime = ((i + 0.5) / n) * duration;
      // A seek that never resolves (a broken keyframe index) must not hang the strip.
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { i += 1; grab(); }, 2000);
    };
    el.addEventListener("seeked", () => {
      window.clearTimeout(timer);
      if (el.videoWidth && el.videoHeight) {
        const h = 64;
        const c = document.createElement("canvas");
        c.height = h;
        c.width = Math.max(1, Math.round((el.videoWidth / el.videoHeight) * h));
        try {
          c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
          strip.push({ time: el.currentTime, canvas: c });
          onFrame();
        } catch { /* frame not drawable yet */ }
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

/** Which source frame tile `i` shows. Mirrors `strip_frame` in nkd_timeline.py. */
export const stripFrame = (i: number, tiles: number, n: number): number =>
  Math.min(n - 1, Math.floor(((i + 0.5) * n) / tiles));

/**
 * Take a contact sheet the backend wrote for a TENSOR source and file it as that source's
 * thumbnails, so everything downstream treats it like any other filmstrip.
 *
 * An IMAGE/MASK input has no file, so none of the machinery above can reach it - the
 * pooled `<video>`, the probe and the thumbnailer all start from a URL. The backend writes
 * one PNG per tensor slot at the end of a run and this seeds both caches from it, which is
 * why the entry is registered (empty) UP FRONT: otherwise `ensureThumbnails` would spawn a
 * `<video>` job against a PNG.
 *
 * Laid out as a GRID, because at one tile per frame a single row would run tens of
 * thousands of pixels wide and hit the browser's image size limits.
 */
export function adoptStrip(ref: MediaRef, info: MediaInfo, tiles: number, cols: number,
                           onReady: () => void): void {
  const key = refKey(ref);
  stripRefs.add(key);
  if (thumbCache.has(key)) return;
  infoCache.set(key, info);
  const strip: Thumb[] = [];
  thumbCache.set(key, strip);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const rows = Math.max(1, Math.ceil(tiles / cols));
    const tw = img.width / cols;
    const th = img.height / rows;
    for (let i = 0; i < tiles; i++) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(tw));
      c.height = Math.max(1, Math.round(th));
      c.getContext("2d")!.drawImage(
        img, Math.round((i % cols) * tw), Math.round(Math.floor(i / cols) * th),
        c.width, c.height, 0, 0, c.width, c.height);
      // The EXACT frame this tile came from, by the same formula Python used to pick it.
      // Deriving the time from the tile's position instead lands half a tile off, and
      // `thumbnailAt` then hands the overlay a mask from the neighbouring frame.
      strip.push({
        time: stripFrame(i, tiles, info.frame_count) / (info.fps || 1),
        canvas: c,
      });
    }
    onReady();
  };
  img.src = viewUrl(ref);
}

/** Nearest still to `seconds`, or null while the strip is still empty. */
export function thumbnailAt(ref: MediaRef, seconds: number): HTMLCanvasElement | null {
  const strip = thumbCache.get(refKey(ref));
  if (!strip || strip.length === 0) return null;
  let best = strip[0];
  let dist = Math.abs(best.time - seconds);
  for (const t of strip) {
    const d = Math.abs(t.time - seconds);
    if (d < dist) { dist = d; best = t; }
  }
  return best.canvas;
}

// ── Audio: one decode serves both the waveform and playback ───────────────────

const audioCache = new Map<string, AudioBuffer>();
const peakCache = new Map<string, Float32Array>();
const audioJobs = new Map<string, Promise<AudioBuffer | null>>();
let audioCtx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export const PEAK_BUCKETS = 400;

/**
 * Decode a source's audio once and keep it: the peaks for the waveform and the buffer for
 * playback come from the same decode.
 *
 * `decodeAudioData` is handed the raw CONTAINER bytes and the browser pulls the audio
 * track out, which is how a plain .mp4 yields its audio with no demuxing on our side.
 *
 * ponytail: this holds the whole track as PCM (a few minutes of stereo is tens of MB).
 * Fine for reference material; if someone drops an hour-long file in, this is the knob to
 * turn - decode lazily per clip window instead.
 */
export function ensureAudio(ref: MediaRef, onDone: () => void): void {
  const key = refKey(ref);
  // `onDone` fires in EVERY case, including "already decoded" and "someone else is
  // already fetching this". Returning early without it is a silent trap the moment a
  // file's picture and sound arrive on two different sockets - exactly what VHS's loader
  // and `Get Video Components` do: whoever asks second has the callback that PLACES ITS
  // CLIP dropped on the floor, so there is no waveform, no sound and no error.
  if (audioCache.has(key)) {
    onDone();
    return;
  }
  const flight = audioJobs.get(key);
  if (flight) {
    void flight.then(() => onDone());
    return;
  }
  const job = fetch(viewUrl(ref))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("fetch failed"))))
    .then((buf) => audioContext().decodeAudioData(buf))
    .then((decoded) => {
      audioCache.set(key, decoded);
      peakCache.set(key, computePeaks(decoded));
      return decoded;
    })
    .catch(() => null)               // no audio track, or a codec the browser refuses
    .finally(() => {
      audioJobs.delete(key);
      // Even on failure. A clip whose sound this browser cannot decode still has to
      // appear: the backend reads the file itself and will happily mix it, so refusing
      // to place the clip would lose audio from the RENDER over a preview limitation.
      onDone();
    });
  audioJobs.set(key, job);
}

function computePeaks(buf: AudioBuffer): Float32Array {
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

export const peaksFor = (ref: MediaRef): Float32Array | undefined =>
  peakCache.get(refKey(ref));

export const audioBufferFor = (ref: MediaRef): AudioBuffer | undefined =>
  audioCache.get(refKey(ref));
