/**
 * Popup Preview reference-alignment checks.
 *
 *   node --test tests/align.mjs
 *
 * src/align.ts is bundled with esbuild first, so this runs the code that ships. The picture
 * is analytic: the reference is the render pushed through a KNOWN shift + zoom, and the
 * search has to hand that transform back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "nkd-align-"));
const outFile = join(outDir, "align.mjs");
execFileSync(process.execPath, [
  join(root, "node_modules", "esbuild", "bin", "esbuild"),
  join(root, "src", "align.ts"),
  "--bundle", "--format=esm", "--platform=node", "--log-level=warning",
  `--outfile=${outFile}`,
], { stdio: "inherit" });
const A = await import(pathToFileURL(outFile).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

// Blobs of several sizes: enough structure to lock onto, nothing periodic to alias on.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const blobs = Array.from({ length: 24 }, () => ({ x: rnd(), y: rnd(), r: 0.02 + rnd() * 0.08, k: rnd() * 2 - 1 }));
const f = (u, v) => blobs.reduce((s, b) => s + b.k * Math.exp(-((u - b.x) ** 2 + (v - b.y) ** 2) / (b.r * b.r)), 0);

/** One level: the render, and the reference that the transform `t` lays exactly over it. */
function level(w, h, t, gain = 1, bias = 0) {
  const a = new Float32Array(w * h), b = new Float32Array(w * h), cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    a[y * w + x] = f(x / w, y / h);
    const px = cx + t.dx * w + t.s * (x - cx), py = cy + t.dy * h + t.s * (y - cy);
    b[y * w + x] = gain * f(px / w, py / h) + bias;
  }
  return { a, b, w, h, box: { x: 0, y: 0, w, h } };
}

const close = (got, want, w) => {
  assert.ok(Math.abs(got.dx - want.dx) * w < 0.75, `dx ${got.dx} vs ${want.dx}`);
  assert.ok(Math.abs(got.dy - want.dy) * w < 0.75, `dy ${got.dy} vs ${want.dy}`);
  assert.ok(Math.abs(got.s - want.s) < 0.0015, `s ${got.s} vs ${want.s}`);
};

test("recovers a shift + zoom like an edit model's", () => {
  const t = { dx: 0.013, dy: -0.021, s: 1.031 };
  close(A.findAlign(level(256, 144, t), level(1024, 576, t)), t, 1024);
});

test("an aligned pair stays put", () => {
  close(A.findAlign(level(256, 144, A.IDENTITY), level(1024, 576, A.IDENTITY)), A.IDENTITY, 1024);
});

test("a brighter, flatter reference still aligns (NCC ignores gain and offset)", () => {
  const t = { dx: -0.008, dy: 0.004, s: 0.976 };
  close(A.findAlign(level(256, 144, t, 0.6, 0.3), level(1024, 576, t, 0.6, 0.3)), t, 1024);
});

test("alignBox moves the box the way score samples it", () => {
  const t = { dx: 0.01, dy: -0.02, s: 1.1 };
  const b = A.alignBox({ x: 0, y: 0, w: 1000, h: 500 }, t, 1000, 500);
  // centre stays the centre plus d; size scales by s
  assert.equal(b.w, 1100); assert.equal(b.h, 550);
  assert.ok(Math.abs(b.x + b.w / 2 - (500 + 10)) < 1e-9);
  assert.ok(Math.abs(b.y + b.h / 2 - (250 - 10)) < 1e-9);
});
