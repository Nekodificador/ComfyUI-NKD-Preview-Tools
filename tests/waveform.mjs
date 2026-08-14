/**
 * NKD Timeline waveform checks.
 *
 *   node --test tests/waveform.mjs
 *
 * src/timeline/waveform.ts is bundled with esbuild first, so this exercises THE SAME code
 * that ships in the bundle, not a copy.
 *
 * The drawing itself needs a canvas, so what is asserted here is everything that decides
 * WHAT gets drawn: the envelope, the per-column aggregation behind it, and the dB curve.
 * A fake 2D context records the rectangles, which is enough to catch the three failures
 * that actually happened: a wave that ignores zoom, a fold that loses one channel, and a
 * dB scale that reads a quiet track as silence.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "nkd-waveform-"));
const outFile = join(outDir, "waveform.mjs");
execFileSync(process.execPath, [
  join(root, "node_modules", "esbuild", "bin", "esbuild"),
  join(root, "src", "timeline", "waveform.ts"),
  "--bundle", "--format=esm", "--platform=node", "--log-level=warning",
  `--outfile=${outFile}`,
], { stdio: "inherit" });

const W = await import(pathToFileURL(outFile).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

/** Just enough AudioBuffer for the renderer: it only reads these four things. */
const buffer = (channels, sampleRate = 48000) => ({
  numberOfChannels: channels.length,
  length: channels[0].length,
  sampleRate,
  duration: channels[0].length / sampleRate,
  getChannelData: (i) => channels[i],
});

/** Sine at `hz`, `seconds` long, scaled by `amp`. */
const tone = (hz, seconds, amp = 1, sampleRate = 48000) => {
  const n = Math.round(seconds * sampleRate);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return d;
};

/** Records fillRect calls; everything else is a no-op. */
function fakeCtx() {
  const rects = [];
  return {
    rects,
    fillStyle: "", strokeStyle: "", lineWidth: 1,
    fillRect: (x, y, w, h) => rects.push({ x, y, w, h, style: null }),
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
}

const COLORS = { peak: "peak", body: "body", zero: "zero" };

/**
 * The distinct x positions that got a bar taller than `minH`.
 *
 * By COLUMN, not by rect: every column is drawn twice (peak outline, then RMS body), so
 * counting rects reports each one twice and an assertion on "one column" never holds.
 */
function loudColumns(ctx, minH = 4) {
  return new Set(ctx.rects.filter((r) => r.w === 1 && r.h > minH).map((r) => r.x));
}

test("envelope: buckets cover the whole buffer and bracket the samples", () => {
  const d = tone(1000, 0.5);
  const env = W.buildEnvelope(buffer([d]));
  assert.equal(env.length, 1);
  assert.equal(env[0].min.length, Math.ceil(d.length / W.ENV_BUCKET));
  // A full-scale sine reaches +-1 and its RMS is 1/sqrt(2). Each bucket is 256 samples of
  // a 1 kHz tone at 48 kHz, i.e. ~5 whole cycles, so every bucket sees both extremes.
  for (let b = 0; b < env[0].min.length - 1; b++) {
    assert.ok(env[0].max[b] > 0.98, `bucket ${b} max ${env[0].max[b]}`);
    assert.ok(env[0].min[b] < -0.98, `bucket ${b} min ${env[0].min[b]}`);
    assert.ok(Math.abs(env[0].rms[b] - Math.SQRT1_2) < 0.05, `bucket ${b} rms`);
  }
});

test("envelope: silence stays exactly zero, no drifting epsilon", () => {
  const env = W.buildEnvelope(buffer([new Float32Array(48000)]));
  for (let b = 0; b < env[0].min.length; b++) {
    assert.equal(env[0].min[b], 0);
    assert.equal(env[0].max[b], 0);
    assert.equal(env[0].rms[b], 0);
  }
});

test("detail follows the zoom: a transient stays one column when zoomed in", () => {
  // Silence with a single full-scale spike 0.5 s in.
  const d = new Float32Array(48000);
  d[24000] = 1;
  const buf = buffer([d]);
  const env = W.buildEnvelope(buf);

  // Zoomed OUT: the whole second across 100 columns. The spike lands in one column.
  const out = fakeCtx();
  W.drawWave(out, buf, env, 0, 1, 0, 0, 100, 20, COLORS, false);
  assert.equal(loudColumns(out).size, 1, "one column carries the spike when zoomed out");

  // Zoomed IN: 20 ms around the spike across 100 columns. It must STILL be one column,
  // not smeared across the 0.45 s bucket the old 400-peak renderer would have used.
  const inn = fakeCtx();
  W.drawWave(inn, buf, env, 0.49, 0.51, 0, 0, 100, 20, COLORS, false);
  assert.equal(loudColumns(inn).size, 1, "still a single column at 50x zoom");
});

test("the old renderer's failure is reconstructed and rejected", () => {
  // 400 buckets over the whole file is what shipped before. On a 60 s file that is 150 ms
  // per bucket; a 1 ms click would be drawn 150 ms wide. Assert the new renderer does not
  // do that: at a zoom of 10 ms across 200 columns, a 1-sample click occupies << half.
  const n = 60 * 48000;
  const d = new Float32Array(n);
  d[30 * 48000] = 1;
  const buf = buffer([d]);
  const env = W.buildEnvelope(buf);
  const ctx = fakeCtx();
  W.drawWave(ctx, buf, env, 29.995, 30.005, 0, 0, 200, 20, COLORS, false);
  const loud = loudColumns(ctx);
  assert.equal(loud.size, 1, `click smeared across ${loud.size} columns`);
});

test("stereo: both channels get a lane, and a fold keeps the quiet side", () => {
  const left = tone(1000, 0.2, 1);
  const right = new Float32Array(left.length);          // silent right
  const buf = buffer([left, right]);
  const env = W.buildEnvelope(buf);

  // Tall enough for two lanes: the top half draws, the bottom is flat.
  const tall = fakeCtx();
  W.drawWave(tall, buf, env, 0, 0.2, 0, 0, 50, 40, COLORS, false);
  const top = tall.rects.filter((r) => r.w === 1 && r.h > 4 && r.y < 20);
  const bottom = tall.rects.filter((r) => r.w === 1 && r.h > 4 && r.y >= 20);
  assert.ok(top.length > 10, "left channel drawn");
  assert.equal(bottom.length, 0, "silent right channel drawn as silence");
  assert.ok(loudColumns(tall).size > 10);

  // Short: folded. A sound present on ONLY ONE channel must still show - reading channel
  // 0 alone (what the old code did) would draw silence for a right-only track.
  const rightOnly = buffer([new Float32Array(left.length), tone(1000, 0.2, 1)]);
  const rEnv = W.buildEnvelope(rightOnly);
  const short = fakeCtx();
  W.drawWave(short, rightOnly, rEnv, 0, 0.2, 0, 0, 50, 16, COLORS, false);
  assert.ok(loudColumns(short).size > 10,
    "a right-only sound is invisible when the fold reads channel 0 only");
});

test("dB scale lifts a quiet track without touching a loud one", () => {
  const quiet = buffer([tone(1000, 0.2, 0.03)]);        // about -30 dBFS
  const env = W.buildEnvelope(quiet);
  const h = 20;

  const lin = fakeCtx();
  W.drawWave(lin, quiet, env, 0, 0.2, 0, 0, 50, h, COLORS, false);
  const linMax = Math.max(...lin.rects.filter((r) => r.w === 1).map((r) => r.h));

  const db = fakeCtx();
  W.drawWave(db, quiet, env, 0, 0.2, 0, 0, 50, h, COLORS, true);
  const dbMax = Math.max(...db.rects.filter((r) => r.w === 1).map((r) => r.h));

  assert.ok(linMax <= 2, `linear draws -30 dBFS as ${linMax}px of ${h}`);
  assert.ok(dbMax > h * 0.4, `dB draws -30 dBFS as only ${dbMax}px of ${h}`);
  assert.ok(dbMax < h, "dB must not clip a -30 dBFS signal to full scale");

  // Full scale is full scale on both, so the toggle cannot mislead about a hot track.
  const loud = buffer([tone(1000, 0.2, 1)]);
  const lEnv = W.buildEnvelope(loud);
  const lDb = fakeCtx();
  W.drawWave(lDb, loud, lEnv, 0, 0.2, 0, 0, 50, h, COLORS, true);
  assert.ok(Math.max(...lDb.rects.filter((r) => r.w === 1).map((r) => r.h)) >= h - 1);
});

test("below the noise floor nothing is drawn, so silence reads as silence in dB", () => {
  const buf = buffer([tone(1000, 0.2, 1e-5)]);          // -100 dBFS
  const env = W.buildEnvelope(buf);
  const ctx = fakeCtx();
  W.drawWave(ctx, buf, env, 0, 0.2, 0, 0, 50, 20, COLORS, true);
  assert.equal(ctx.rects.filter((r) => r.w === 1 && r.h > 1).length, 0);
});

test("only the visible columns are walked", () => {
  // A clip 20000px wide with 800px on screen must not do 20000 columns of work.
  const buf = buffer([tone(1000, 2, 1)]);
  const env = W.buildEnvelope(buf);
  const ctx = fakeCtx();
  W.drawWave(ctx, buf, env, 0, 2, -5000, 0, 20000, 20, COLORS, false, 0, 800);
  const cols = ctx.rects.filter((r) => r.w === 1);
  assert.ok(cols.length > 0, "still draws the visible part");
  // Two passes (peak + body) over at most 5800 columns of clip-space.
  assert.ok(cols.length < 12000, `walked ${cols.length} column rects`);
  for (const r of cols) {
    assert.ok(r.x >= -1 && r.x <= 801, `drew a column at x=${r.x}, outside the viewport`);
  }
});

test("a degenerate rect is a no-op rather than a crash", () => {
  const buf = buffer([tone(1000, 0.1, 1)]);
  const env = W.buildEnvelope(buf);
  for (const [w, h] of [[0, 20], [50, 0], [50, 1], [-3, 20]]) {
    const ctx = fakeCtx();
    W.drawWave(ctx, buf, env, 0, 0.1, 0, 0, w, h, COLORS, false);
    assert.equal(ctx.rects.length, 0, `w=${w} h=${h} drew something`);
  }
  // No envelope yet (decode still in flight) must also be a no-op.
  const ctx = fakeCtx();
  W.drawWave(ctx, buf, [], 0, 0.1, 0, 0, 50, 20, COLORS, false);
  assert.equal(ctx.rects.length, 0);
});
