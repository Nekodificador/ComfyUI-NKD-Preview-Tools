/**
 * 😺NKD Timeline — waveform drawing, the way an audio editor draws one.
 *
 * The old renderer reduced the WHOLE FILE to 400 absolute peaks of ONE channel. On a
 * three-minute source that is 0.45 s per bucket, so zooming in added no detail at all: you
 * got a wider staircase of the same blocks. It also could not tell a sustained sound from
 * a single transient, because a peak alone does not carry loudness.
 *
 * What Audition and Fairlight draw instead, and what this draws:
 *
 * - **min/max per pixel column**, so the wave is asymmetric and a click stays one pixel
 *   wide instead of being averaged into the neighbourhood.
 * - **an RMS body inside the peak outline**, which is the part that reads as loudness.
 * - **detail that follows the zoom**, down to the individual sample.
 * - **channels side by side**, because a problem on one side is invisible in a fold.
 *
 * The precomputed envelope is ONE level, not a mip pyramid. At 48 kHz ten minutes of
 * stereo is ~112k buckets, and aggregating those across ~1000 columns is sub-millisecond -
 * a pyramid would be more code to maintain for time we cannot measure.
 */

/** Samples per stored bucket. Below this the raw channel data is read directly, so this is
 *  the point where precomputation stops paying and is not a resolution limit. */
export const ENV_BUCKET = 256;

export type ChannelEnvelope = {
  min: Float32Array; max: Float32Array;
  /** RMS of the bucket, NOT the mean. Aggregating several buckets means averaging their
   *  SQUARES and taking the root - averaging the RMS values directly under-reads. */
  rms: Float32Array;
};

export function buildEnvelope(buf: AudioBuffer): ChannelEnvelope[] {
  const out: ChannelEnvelope[] = [];
  const n = Math.max(1, Math.ceil(buf.length / ENV_BUCKET));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    const mn = new Float32Array(n);
    const mx = new Float32Array(n);
    const rms = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      const from = b * ENV_BUCKET;
      const to = Math.min(d.length, from + ENV_BUCKET);
      let lo = 0, hi = 0, sq = 0;
      for (let i = from; i < to; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
      }
      mn[b] = lo;
      mx[b] = hi;
      rms[b] = to > from ? Math.sqrt(sq / (to - from)) : 0;
    }
    out.push({ min: mn, max: mx, rms });
  }
  return out;
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** Below this height there is no room for two readable lanes, so the channels fold. */
const STEREO_MIN_H = 28;
/** dB view floor. -60 is where a room tone stops being worth a pixel. */
const DB_FLOOR = -60;

/** Amplitude to the 0..1 the drawing uses, keeping the sign. In dB mode a quiet dialogue
 *  track becomes readable instead of a flat line, which is the whole point of the toggle. */
function scale(v: number, db: boolean): number {
  if (!db) return v;
  const m = Math.abs(v);
  if (m <= 1e-6) return 0;
  const d = 20 * Math.log10(m);
  if (d <= DB_FLOOR) return 0;
  return (1 - d / DB_FLOOR) * (v < 0 ? -1 : 1);
}

export type WaveColors = { peak: string; body: string; zero: string };

type Col = { min: number; max: number; rms: number };

/**
 * min/max/RMS over a sample range, from the envelope when the range is wide enough to make
 * that exact, and from the raw samples when it is not.
 *
 * Reading buckets for a range NARROWER than one bucket is what makes a zoomed-in wave look
 * like a staircase: every column inside the bucket reports the same three numbers.
 */
function column(buf: AudioBuffer, env: ChannelEnvelope[], chans: number[],
                s0: number, s1: number, out: Col): void {
  let lo = 0, hi = 0, sq = 0, n = 0;
  if (s1 - s0 >= ENV_BUCKET) {
    const b0 = Math.max(0, Math.floor(s0 / ENV_BUCKET));
    // FLOOR, not ceil. Rounding the end up makes a column claim the bucket the NEXT column
    // starts in, so neighbours share one and a single-sample click is drawn two columns
    // wide. Flooring is still gapless - this column ends on exactly the bucket the next
    // one begins at - and the guard covers the degenerate case.
    const b1 = Math.max(b0 + 1, Math.floor(s1 / ENV_BUCKET));
    for (const ch of chans) {
      const e = env[ch];
      if (!e) continue;
      const end = Math.min(e.min.length, b1);
      for (let b = b0; b < end; b++) {
        if (e.min[b] < lo) lo = e.min[b];
        if (e.max[b] > hi) hi = e.max[b];
        sq += e.rms[b] * e.rms[b];
        n++;
      }
    }
  } else {
    const i0 = Math.max(0, Math.floor(s0));
    // At least one sample, or a column narrower than a sample reports nothing at all.
    const i1 = Math.max(i0 + 1, Math.ceil(s1));
    for (const ch of chans) {
      const d = buf.getChannelData(ch);
      const end = Math.min(d.length, i1);
      for (let i = i0; i < end; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
        n++;
      }
    }
  }
  out.min = lo;
  out.max = hi;
  out.rms = n ? Math.sqrt(sq / n) : 0;
}

/** One channel lane. `x0`/`x1` are the columns actually worth drawing (see `drawWave`). */
function lane(ctx: CanvasRenderingContext2D, buf: AudioBuffer, env: ChannelEnvelope[],
              chans: number[], fromSec: number, toSec: number,
              x: number, y: number, w: number, h: number,
              x0: number, x1: number, colors: WaveColors, db: boolean): void {
  const mid = y + h / 2;
  const half = h / 2;
  const sr = buf.sampleRate;
  const spanSec = Math.max(1e-9, toSec - fromSec);
  const samplesPerPx = (spanSec * sr) / Math.max(1, w);

  ctx.fillStyle = colors.zero;
  ctx.fillRect(x + x0, mid, x1 - x0, 1);

  // Under one sample per column the bars degenerate to dots with gaps between them, which
  // reads as noise rather than as a wave. This is the zoom where an editor switches to the
  // interpolated sample line, so do the same.
  if (samplesPerPx < 1) {
    ctx.strokeStyle = colors.peak;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const d = buf.getChannelData(chans[0]);
    for (let px = x0; px < x1; px++) {
      const i = Math.round((fromSec + spanSec * (px / Math.max(1, w))) * sr);
      const v = scale(i >= 0 && i < d.length ? d[i] : 0, db);
      const py = mid - v * half;
      if (px === x0) ctx.moveTo(x + px + 0.5, py);
      else ctx.lineTo(x + px + 0.5, py);
    }
    ctx.stroke();
    return;
  }

  const col: Col = { min: 0, max: 0, rms: 0 };
  // Two passes so the peak outline never has to be re-selected per column: fill styles are
  // the expensive part of a per-pixel loop.
  ctx.fillStyle = colors.peak;
  for (let px = x0; px < x1; px++) {
    const t0 = fromSec + spanSec * (px / Math.max(1, w));
    const t1 = fromSec + spanSec * ((px + 1) / Math.max(1, w));
    column(buf, env, chans, t0 * sr, t1 * sr, col);
    const top = mid - scale(col.max, db) * half;
    const bot = mid - scale(col.min, db) * half;
    ctx.fillRect(x + px, top, 1, Math.max(1, bot - top));
  }
  ctx.fillStyle = colors.body;
  for (let px = x0; px < x1; px++) {
    const t0 = fromSec + spanSec * (px / Math.max(1, w));
    const t1 = fromSec + spanSec * ((px + 1) / Math.max(1, w));
    column(buf, env, chans, t0 * sr, t1 * sr, col);
    const r = scale(col.rms, db) * half;
    if (r <= 0.5) continue;
    ctx.fillRect(x + px, mid - r, 1, r * 2);
  }
}

/**
 * Draw `buf`'s span [fromSec, toSec) into the rect (x, y, w, h).
 *
 * @param visibleX0 / @param visibleX1  Absolute canvas x bounds worth drawing. A clip at
 *   high zoom can be tens of thousands of pixels wide while a thousand of them are on
 *   screen; the canvas clip region hides the rest, but the LOOP still ran, and this
 *   renderer does real work per column. Costs one clamp, saves the frame budget.
 */
export function drawWave(ctx: CanvasRenderingContext2D, buf: AudioBuffer,
                         env: ChannelEnvelope[], fromSec: number, toSec: number,
                         x: number, y: number, w: number, h: number,
                         colors: WaveColors, db: boolean,
                         visibleX0 = -Infinity, visibleX1 = Infinity): void {
  if (w <= 0 || h <= 2 || !env.length) return;
  const x0 = Math.max(0, Math.floor(visibleX0 - x));
  const x1 = Math.min(Math.ceil(w), Math.ceil(visibleX1 - x));
  if (x1 <= x0) return;

  if (env.length >= 2 && h >= STEREO_MIN_H) {
    const lh = h / 2;
    lane(ctx, buf, env, [0], fromSec, toSec, x, y, w, lh, x0, x1, colors, db);
    lane(ctx, buf, env, [1], fromSec, toSec, x, y + lh, w, lh, x0, x1, colors, db);
    return;
  }
  // Folded: the extremes of BOTH channels, not just channel 0. A sound that only exists on
  // the right would otherwise be drawn as silence.
  const all = env.map((_, i) => i);
  lane(ctx, buf, env, all, fromSec, toSec, x, y, w, h, x0, x1, colors, db);
}
