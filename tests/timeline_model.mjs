/**
 * NKD Timeline model checks.
 *
 *   npm test          (node --test tests/timeline_model.mjs)
 *
 * src/timeline/model.ts is bundled with esbuild before running, so this exercises THE
 * SAME code that ships in the bundle, not a copy.
 *
 * Parity with `nkd_timeline.py` is checked against a table transcribed from the Python
 * implementation (see tests/test_timeline.py). Touch one side only and this table fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = mkdtempSync(join(tmpdir(), "nkd-timeline-"));
const outFile = join(outDir, "model.mjs");
execFileSync(process.execPath, [
  join(root, "node_modules", "esbuild", "bin", "esbuild"),
  join(root, "src", "timeline", "model.ts"),
  "--bundle", "--format=esm", "--platform=node", "--log-level=warning",
  `--outfile=${outFile}`,
], { stdio: "inherit" });

const M = await import(pathToFileURL(outFile).href);
process.on("exit", () => rmSync(outDir, { recursive: true, force: true }));

const clip = (o = {}) => ({
  id: "x", src: "video_0", track: 0, start: 0, trimIn: 0, length: 10, ...o,
});

const WAN = "Wan (4n+1)";
const LTX = "LTX (8n+1)";
const MOCHI = "Mochi (6n+1)";
const MINIMAX = "MiniMax H3 (17n+5)";
const CUSTOM = "custom (multiple of N)";

test("quantize mode names match the Python combo exactly", () => {
  // The combo value IS what gets serialised and sent to the backend, so a typo here
  // means the node silently falls back to no snapping at all.
  assert.deepEqual(M.QUANTIZE_MODES, [
    "free", WAN, "Hunyuan (4n+1)", LTX, "Cosmos (8n+1)", MOCHI, MINIMAX, CUSTOM,
  ]);
});

test("quantizeCount — parity table with Python", () => {
  // Copied from the Python implementation. If it diverges, the editor's ruler lies about
  // what the backend will render.
  const table = [
    [33, LTX, 8, 33], [40, LTX, 8, 33], [41, LTX, 8, 41],
    [16, WAN, 4, 13], [13, WAN, 4, 13],
    [1, LTX, 8, 9], [3, WAN, 4, 5],
    [20, MOCHI, 6, 19], [7, MOCHI, 6, 7],
    // MiniMax H3 is NOT an Nn+1 family: valid counts are 5, 22, 39, 56...
    [124, MINIMAX, 17, 124], [130, MINIMAX, 17, 124], [4, MINIMAX, 17, 5],
    [22, MINIMAX, 17, 22], [21, MINIMAX, 17, 5],
    [0, LTX, 8, 0], [100, "free", 8, 100],
    [100, CUSTOM, 16, 96], [5, CUSTOM, 16, 16],
    // An unknown mode must degrade to no snapping, never to 0.
    [37, "something else", 8, 37],
  ];
  for (const [n, mode, k, want] of table) {
    assert.equal(M.quantizeCount(n, mode, k), want, `${n} ${mode} ${k}`);
  }
  for (const mode of [WAN, LTX, MOCHI, MINIMAX]) {
    for (let n = 1; n < 300; n++) assert.ok(M.quantizeCount(n, mode) >= 5, `${mode} ${n}`);
  }
});

test("MiniMax H3 stops match core's align_frame_count", () => {
  // comfy_extras/nodes_minimax_h3.py:33 walks UP until n % 17 == 5. We round DOWN, so
  // every stop we produce must be a fixed point of that function.
  const alignUp = (n) => { while (n % 17 !== 5) n += 1; return n; };
  for (const s of M.quantizeStops(400, MINIMAX)) {
    assert.equal(alignUp(s), s, `stop ${s} is not on the 17k+5 grid`);
    assert.equal(M.quantizeCount(s, MINIMAX), s);
  }
  assert.equal(M.quantizeCount(124, MINIMAX), 124);   // the node's own default
});

test("quantizeStops — what gets painted on the ruler", () => {
  assert.deepEqual(M.quantizeStops(30, LTX), [9, 17, 25]);
  assert.deepEqual(M.quantizeStops(14, WAN), [5, 9, 13]);
  assert.deepEqual(M.quantizeStops(40, CUSTOM, 16), [16, 32]);
  assert.deepEqual(M.quantizeStops(45, MINIMAX), [5, 22, 39]);
  assert.deepEqual(M.quantizeStops(100, "free"), []);
  // Every stop must be a fixed point of quantizeCount, or the ruler would lie.
  for (const mode of [WAN, LTX, MOCHI, MINIMAX]) {
    for (const s of M.quantizeStops(200, mode)) {
      assert.equal(M.quantizeCount(s, mode), s, `${mode} ${s}`);
    }
  }
});

test("fitRect — parity with fit_frames, and what the preview draws", () => {
  // 2:1 source into a square frame.
  const contain = M.fitRect(200, 100, 64, 64, "contain");
  assert.deepEqual(contain, { x: 0, y: 16, w: 64, h: 32 });   // letterboxed
  const cover = M.fitRect(200, 100, 64, 64, "cover");
  assert.deepEqual(cover, { x: -32, y: 0, w: 128, h: 64 });   // overflows, gets cropped
  assert.deepEqual(M.fitRect(200, 100, 64, 64, "stretch"), { x: 0, y: 0, w: 64, h: 64 });
  // Already matching: every mode is a no-op.
  for (const mode of ["contain", "cover", "stretch"]) {
    assert.deepEqual(M.fitRect(64, 64, 64, 64, mode), { x: 0, y: 0, w: 64, h: 64 }, mode);
  }
  // Degenerate input must not produce NaN.
  assert.deepEqual(M.fitRect(0, 0, 64, 64, "contain"), { x: 0, y: 0, w: 64, h: 64 });
});

test("sourceFrame — resampling between different frame rates", () => {
  const c = clip({ start: 10, trimIn: 5, length: 100 });
  assert.equal(M.sourceFrame(c, 10, 24, 24), 5);
  assert.equal(M.sourceFrame(c, 34, 24, 24), 29);
  assert.equal(M.sourceFrame(c, 34, 30, 24), 35);  // 24 frames x 30/24
  assert.equal(M.sourceFrame(c, 40, 24, 30), 29);  // 30 frames x 24/30
  assert.equal(M.sourceFrame(c, 50, 24, 0), 5);    // invalid fps must not throw
});

test("parseTimeline — never throws on garbage", () => {
  for (const junk of ["", null, undefined, "{{{", "[]", '{"clips":"nope"}', "7"]) {
    const t = M.parseTimeline(junk);
    assert.deepEqual(t.clips, []);
    assert.deepEqual(t.audio, []);
  }
  const t = M.parseTimeline(JSON.stringify({
    clips: [
      { id: "b", src: "video_1", track: 2, start: 10, trimIn: 3, length: 20 },
      { id: "a", src: "video_0", track: 0, start: 0, length: 30 },
      { src: "video_9", length: 0 },   // zero length -> dropped
      { track: 1, length: 5 },         // no src -> dropped
    ],
    audio: [{ src: "audio_0", start: 0, length: 50, gain: 0.5 }],
    ui: { playhead: 12, zoom: 2 },
  }));
  assert.equal(t.clips.length, 2);
  assert.deepEqual(t.clips.map((c) => c.src), ["video_0", "video_1"]); // sorted by track
  assert.equal(t.clips[1].trimIn, 3);
  assert.equal(t.audio[0].gain, 0.5);
  assert.equal(t.ui.playhead, 12);
  assert.equal(M.timelineSpan(t), 50);
  // An audio clip with no id gets one: without it, dragging breaks after a reload.
  assert.ok(t.audio[0].id);
});

test("serialiseTimeline — round trip, no transient fields", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "video_0", track: 1, start: 4, trimIn: 2, length: 8 }],
    audio: [], ui: { playhead: 3, zoom: 1.5 },
  }));
  // Fields the editor hangs on at runtime that must NEVER persist.
  t.clips[0].videoEl = { fake: true };
  t.clips[0].thumbnails = [1, 2, 3];
  const round = M.parseTimeline(M.serialiseTimeline(t));
  assert.deepEqual(round.clips[0], {
    id: "a", src: "video_0", track: 1, start: 4, trimIn: 2, length: 8,
  });
  assert.equal(round.ui.playhead, 3);
  assert.equal(round.ui.zoom, 1.5);
});

test("clipsAt — the higher track is the visible one", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "lo", track: 0, start: 0, length: 20 }),
             clip({ id: "hi", track: 3, start: 5, length: 5 })];
  assert.deepEqual(M.clipsAt(t, 2).map((c) => c.id), ["lo"]);
  assert.deepEqual(M.clipsAt(t, 6).map((c) => c.id), ["hi", "lo"]); // topmost first
  assert.deepEqual(M.clipsAt(t, 50).map((c) => c.id), []);          // a gap
});

test("effectiveCount — what the backend will actually produce", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ start: 0, length: 40 })];
  assert.equal(M.effectiveCount(t, 0, 0, "free"), 40);
  assert.equal(M.effectiveCount(t, 0, 0, LTX), 33);
  assert.equal(M.effectiveCount(t, 10, 0, "free"), 30);   // start_frame is subtracted
  assert.equal(M.effectiveCount(t, 0, 25, "free"), 25);   // explicit frame_count wins
  assert.equal(M.effectiveCount(M.emptyTimeline(), 0, 0, "free"), 0);
});

test("snap — magnets to the nearest candidate within the threshold", () => {
  assert.equal(M.snap(48, [0, 50, 100], 5), 50);
  assert.equal(M.snap(43, [0, 50, 100], 5), 43);   // outside the threshold, untouched
  assert.equal(M.snap(51, [50, 52], 5), 52);       // tie: the last candidate wins
  const t = M.emptyTimeline();
  t.clips = [clip({ start: 10, length: 20 })];
  t.ui.playhead = 7;
  assert.deepEqual([...M.snapCandidates(t)].sort((a, b) => a - b), [0, 7, 10, 30]);
});

test("trimStart — content does not slide under the cut", () => {
  const c = clip({ start: 10, trimIn: 20, length: 30 });   // ends at 40
  M.trimStart(c, 15, 24, 24);
  assert.equal(c.start, 15);
  assert.equal(c.trimIn, 25);        // advanced exactly as much as the edge
  assert.equal(c.start + c.length, 40); // the end does NOT move
  // Cannot trim past the start of the source.
  const d = clip({ start: 10, trimIn: 3, length: 30 });
  M.trimStart(d, 0, 24, 24);
  assert.equal(d.trimIn, 0);
  assert.equal(d.start, 7);          // 10 - 3, the material available
  // Nor invert the clip.
  const e = clip({ start: 0, trimIn: 100, length: 10 });
  M.trimStart(e, 999, 24, 24);
  assert.ok(e.length >= 1);
  // With mismatched rates the trim advances at the SOURCE cadence.
  const f = clip({ start: 0, trimIn: 0, length: 30 });
  M.trimStart(f, 10, 30, 24);
  assert.equal(f.trimIn, 13);        // 10 timeline frames x 30/24 = 12.5 -> 13
});

test("trimEnd — never stretches past the available material", () => {
  const c = clip({ start: 0, trimIn: 0, length: 10 });
  M.trimEnd(c, 50, 100, 24, 24);
  assert.equal(c.length, 50);
  M.trimEnd(c, 500, 100, 24, 24);
  assert.equal(c.length, 100);       // capped at the whole source
  M.trimEnd(c, -5, 100, 24, 24);
  assert.equal(c.length, 1);         // never below a single frame
  // 30 fps source on a 24 fps timeline: 100 source frames give 80 timeline frames.
  const d = clip({ start: 0, trimIn: 0, length: 10 });
  M.trimEnd(d, 999, 100, 30, 24);
  assert.equal(d.length, 80);
});

test("slipClip — moves the content, not the clip", () => {
  const c = clip({ start: 10, trimIn: 20, length: 30 });
  M.slipClip(c, 5, 200, 24, 24);
  assert.equal(c.trimIn, 25);
  assert.equal(c.start, 10);         // position untouched
  assert.equal(c.length, 30);        // duration untouched
  // Cannot run off the end of the source: 30 of 40 frames used -> max trim 10.
  const d = clip({ start: 0, trimIn: 0, length: 30 });
  M.slipClip(d, 999, 40, 24, 24);
  assert.equal(d.trimIn, 10);
  // Nor off the start.
  M.slipClip(d, -999, 40, 24, 24);
  assert.equal(d.trimIn, 0);
});

test("mask lane survives the round trip and counts toward the span", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "v", src: "video_0", start: 0, length: 10 }],
    masks: [{ id: "m", src: "mask_0", start: 20, trimIn: 4, length: 15 }],
    audio: [],
  }));
  assert.equal(t.masks.length, 1);
  assert.equal(t.masks[0].trimIn, 4);
  assert.equal(M.timelineSpan(t), 35);            // the mask lane extends the span
  const round = M.parseTimeline(M.serialiseTimeline(t));
  assert.deepEqual(round.masks[0], {
    id: "m", src: "mask_0", track: 0, start: 20, trimIn: 4, length: 15,
  });
  // A timeline saved before the mask lane existed must still load.
  assert.deepEqual(M.parseTimeline('{"clips":[],"audio":[]}').masks, []);
  // Mask edges are snap candidates too - you align a mask to a cut constantly.
  assert.ok(M.snapCandidates(t).includes(20));
  assert.ok(M.snapCandidates(t).includes(35));
});

test("materialRange — what 'trim to material' crops to", () => {
  const t = M.emptyTimeline();
  assert.equal(M.materialRange(t), null);          // nothing at all
  t.clips = [clip({ start: 30, length: 10 }), clip({ start: 5, length: 10 })];
  t.masks = [clip({ start: 50, length: 4 })];
  assert.deepEqual(M.materialRange(t), { start: 5, end: 54 });
  // Audio alone must NOT define the picture range.
  const onlyAudio = M.emptyTimeline();
  onlyAudio.audio = [{ id: "a", src: "audio_0", start: 0, trimIn: 0, length: 99, gain: 1 }];
  assert.equal(M.materialRange(onlyAudio), null);
});

test("snapFrameToGrid — Shift lands the playhead on a legal cut", () => {
  const LTX8 = "LTX (8n+1)";
  // Measured FROM start_frame: with start 0 the legal ends are 9, 17, 25...
  assert.equal(M.snapFrameToGrid(20, 0, LTX8), 17);
  assert.equal(M.snapFrameToGrid(22, 0, LTX8), 25);
  // Below the first stop it clamps up rather than to a count the model rejects.
  assert.equal(M.snapFrameToGrid(2, 0, LTX8), 9);
  // The grid rides start_frame, so trimming the head does not invalidate every cut.
  assert.equal(M.snapFrameToGrid(120, 100, LTX8), 117);
  // Free mode is a no-op, and every result must be a valid count.
  assert.equal(M.snapFrameToGrid(37, 0, "free"), 37);
  for (const mode of [LTX8, "Wan (4n+1)", "MiniMax H3 (17n+5)"]) {
    for (let f = 0; f < 200; f++) {
      const snapped = M.snapFrameToGrid(f, 0, mode);
      assert.equal(M.quantizeCount(snapped, mode), snapped, `${mode} ${f} -> ${snapped}`);
    }
  }
});

test("track blend — stored per track, degrades on junk", () => {
  const t = M.emptyTimeline();
  assert.equal(M.trackBlend(t, 0), "normal");
  assert.equal(M.trackBlend(t, 9), "normal");       // beyond the list
  M.setTrackBlend(t, 2, "difference");
  assert.equal(M.trackBlend(t, 2), "difference");
  assert.equal(M.trackBlend(t, 1), "normal");       // the gap is filled with normal
  assert.equal(t.tracks.length, 3);
  // Survives the round trip, and an unknown name from a hand-edited file degrades.
  assert.equal(M.trackBlend(M.parseTimeline(M.serialiseTimeline(t)), 2), "difference");
  assert.equal(M.trackBlend(M.parseTimeline('{"tracks":[{"blend":"evil"}]}'), 0), "normal");
  assert.equal(M.trackBlend(M.parseTimeline('{"tracks":["junk"]}'), 0), "normal");
  // The blend names must be exactly the canvas composite operations, or the preview
  // would silently fall back to source-over while the backend blends.
  assert.deepEqual(M.BLEND_MODES, ["normal", "screen", "multiply", "difference"]);
});

test("placementFor — append assembles, stack compares", () => {
  const t = M.emptyTimeline();
  const lane = t.clips;
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 0, track: 0 });
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 0 });
  lane.push(clip({ start: 0, length: 30, track: 0 }));
  // append: after the previous one, same track.
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 30, track: 0 });
  // stack: on top, both from frame 0, which is what makes a before/after comparison.
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 1 });
  lane.push(clip({ start: 0, length: 30, track: 1 }));
  assert.deepEqual(M.placementFor(t, lane, "stack"), { start: 0, track: 2 });
  // append only looks at track 0, so a stacked clip does not push the next append out.
  assert.deepEqual(M.placementFor(t, lane, "append"), { start: 30, track: 0 });
});

test("moveClipToLane — a black-and-white video becomes a mask", () => {
  const t = M.emptyTimeline();
  const c = clip({ id: "vid", src: "video_0", track: 3, start: 10, length: 20 });
  t.clips.push(c);
  M.moveClipToLane(t, c, true);
  assert.equal(t.clips.length, 0);
  assert.deepEqual(t.masks.map((k) => k.id), ["vid"]);
  // Position and trim are kept - only the interpretation changed. The track resets
  // because the mask lane has just the one.
  assert.equal(t.masks[0].start, 10);
  assert.equal(t.masks[0].src, "video_0");
  assert.equal(t.masks[0].track, 0);
  M.moveClipToLane(t, c, false);
  assert.deepEqual(t.clips.map((k) => k.id), ["vid"]);
  assert.equal(t.masks.length, 0);
  // Moving a clip that is not in the source lane must be a no-op, not a duplicate.
  M.moveClipToLane(t, c, false);
  assert.equal(t.clips.length, 1);
});

test("viewWindow — zoom and scroll stay inside the content", () => {
  const ui = { zoom: 1, scroll: 0, playhead: 0 };
  assert.deepEqual(M.viewWindow(ui, 1000), { start: 0, frames: 1000 });
  // Zoom 4 shows a quarter, and scroll picks which quarter.
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4 }, 1000), { start: 0, frames: 250 });
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: 500 }, 1000),
    { start: 500, frames: 250 });
  // Scrolling past the end pins to the last full window, never past it.
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: 9999 }, 1000),
    { start: 750, frames: 250 });
  assert.deepEqual(M.viewWindow({ ...ui, zoom: 4, scroll: -50 }, 1000),
    { start: 0, frames: 250 });
  // Zooming out below "everything fits" is refused, and MAX_ZOOM caps the other end.
  assert.equal(M.viewWindow({ ...ui, zoom: 0.1 }, 1000).frames, 1000);
  assert.equal(M.viewWindow({ ...ui, zoom: 1e9 }, 1000).frames,
    M.viewWindow({ ...ui, zoom: M.MAX_ZOOM }, 1000).frames);
  // Garbage must not produce NaN - the whole coordinate mapping divides by `frames`.
  for (const bad of [NaN, undefined, null, "x"]) {
    const w = M.viewWindow({ zoom: bad, scroll: bad, playhead: 0 }, 1000);
    assert.ok(Number.isFinite(w.start) && Number.isFinite(w.frames) && w.frames > 0);
  }
  // A tiny timeline still yields a usable window rather than collapsing to zero.
  assert.ok(M.viewWindow({ ...ui, zoom: M.MAX_ZOOM }, 10).frames >= 2);
  // The view state round-trips, so a workflow reopens where it was left.
  const t = M.emptyTimeline();
  t.ui.zoom = 6; t.ui.scroll = 42;
  const back = M.parseTimeline(M.serialiseTimeline(t));
  assert.equal(back.ui.zoom, 6);
  assert.equal(back.ui.scroll, 42);
});

test("mute — per clip, omitted from the JSON when off", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "video_0", start: 0, length: 10, muted: true },
            { id: "b", src: "video_1", start: 0, length: 10 }],
    audio: [{ id: "c", src: "audio_0", start: 0, length: 10, muted: true }],
  }));
  assert.equal(t.clips.find((c) => c.id === "a").muted, true);
  assert.equal(t.clips.find((c) => c.id === "b").muted, undefined);
  assert.equal(t.audio[0].muted, true);
  // Survives the round trip, and an unmuted clip carries no key at all.
  const json = JSON.parse(M.serialiseTimeline(t));
  assert.equal(json.clips.find((c) => c.id === "a").muted, true);
  assert.ok(!("muted" in json.clips.find((c) => c.id === "b")));
  assert.equal(json.audio[0].muted, true);
  // A truthy non-boolean from a hand-edited file normalises to true, not to itself.
  assert.equal(M.parseTimeline('{"clips":[{"src":"v","length":1,"muted":"yes"}]}')
    .clips[0].muted, true);
});

test("stack is the default import mode", () => {
  // Layered-by-default: connecting a second video puts it ON TOP, not after.
  assert.equal(M.IMPORT_MODES[0], "stack");
});

test("cropToRange — discards what falls outside in/out", () => {
  const t = M.emptyTimeline();
  t.clips = [
    clip({ id: "before", start: 0, length: 10 }),     // wholly before -> dropped
    clip({ id: "head", start: 5, length: 20 }),       // straddles the in point
    clip({ id: "inside", start: 30, length: 10 }),    // untouched
    clip({ id: "tail", start: 45, length: 20 }),      // straddles the out point
    clip({ id: "after", start: 90, length: 10 }),     // wholly after -> dropped
  ];
  t.masks = [clip({ id: "m", src: "mask_0", start: 0, length: 5 })];
  t.audio = [{ id: "a", src: "audio_0", start: 40, trimIn: 0, length: 40, gain: 1 }];

  const changed = M.cropToRange(t, 10, 60, 24, () => 24);
  assert.equal(changed, true);
  assert.deepEqual(t.clips.map((c) => c.id), ["head", "inside", "tail"]);
  // Nothing may stick out of the range afterwards, in ANY lane.
  for (const lane of [t.clips, t.masks, t.audio]) {
    for (const c of lane) {
      assert.ok(c.start >= 10, `${c.id} starts at ${c.start}`);
      assert.ok(c.start + c.length <= 60, `${c.id} ends at ${c.start + c.length}`);
    }
  }
  // The head cut advances trimIn, so the content does not slide under the cut.
  const head = t.clips.find((c) => c.id === "head");
  assert.equal(head.start, 10);
  assert.equal(head.trimIn, 5);          // 5 frames were cut off the front
  assert.equal(head.length, 15);
  // The tail cut only shortens.
  const tail = t.clips.find((c) => c.id === "tail");
  assert.equal(tail.start, 45);
  assert.equal(tail.trimIn, 0);
  assert.equal(tail.length, 15);
  // An untouched clip is left exactly alone.
  assert.deepEqual(t.clips.find((c) => c.id === "inside"),
    { id: "inside", src: "video_0", track: 0, start: 30, trimIn: 0, length: 10 });
  // Every lane is cropped, not just the picture.
  assert.equal(t.masks.length, 0);
  assert.equal(t.audio[0].length, 20);   // 40..80 clipped to 40..60

  // A second pass changes nothing and reports so, so the button leaves no empty undo.
  assert.equal(M.cropToRange(t, 10, 60, 24, () => 24), false);
});

test("cropToRange — a 30 fps source cuts at its own cadence", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "v", start: 0, trimIn: 0, length: 40 })];
  // 10 timeline frames cut at 24 fps == 12.5 source frames at 30 fps.
  M.cropToRange(t, 10, 40, 24, () => 30);
  assert.equal(t.clips[0].start, 10);
  assert.equal(t.clips[0].trimIn, 13);
  assert.equal(t.clips[0].length, 30);
});

test("slotInUse — a reinterpreted clip must not be re-added as a video", () => {
  // The exact regression: a video moved to the mask lane looks "unplaced" to a per-lane
  // check, so the next slot sync adds it back to the picture lane and the same source
  // ends up in both - the reinterpretation undoing itself on every refresh.
  const t = M.emptyTimeline();
  const c = clip({ id: "v", src: "video_0", start: 0, length: 20 });
  t.clips.push(c);
  assert.equal(M.slotInUse(t, "video_0"), true);
  assert.equal(M.slotInUse(t, "video_1"), false);

  M.moveClipToLane(t, c, true);            // "Interpret as mask"
  assert.equal(t.clips.length, 0);
  assert.equal(M.slotInUse(t, "video_0"), true, "still placed, just in another lane");

  // Audio counts too, so an audio slot is not duplicated either.
  t.audio.push({ id: "a", src: "audio_0", start: 0, trimIn: 0, length: 10, gain: 1 });
  assert.equal(M.slotInUse(t, "audio_0"), true);
  // And a slot nobody references stays free, so real new connections still land.
  assert.equal(M.slotInUse(t, "mask_3"), false);
});

test("trimToPlayhead — Q and E bring an edge to the playhead", () => {
  const mk = () => {
    const t = M.emptyTimeline();
    t.clips = [clip({ id: "v", src: "media_0", start: 0, length: 100 })];
    t.audio = [{ id: "a", src: "media_1", start: 0, trimIn: 0, length: 200, gain: 1 }];
    return t;
  };
  const rate = () => 24;

  // E (end): the tail comes back to the playhead. Nothing else moves.
  let t = mk();
  assert.equal(M.trimToPlayhead(t, 40, "end", 24, rate), true);
  assert.equal(t.clips[0].start, 0);
  assert.equal(t.clips[0].length, 40);
  assert.equal(t.audio[0].length, 40);          // every lane, so a cut is straight across

  // Q (start): the head comes forward AND trimIn advances, so the content does not slide.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 30, "start", 24, rate), true);
  assert.equal(t.clips[0].start, 30);
  assert.equal(t.clips[0].trimIn, 30);
  assert.equal(t.clips[0].start + t.clips[0].length, 100);   // the tail stays put

  // Only ever shortens: a playhead outside the clip is a no-op, so the button leaves no
  // empty undo and a clip can never be stretched by accident.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 500, "start", 24, rate), false);
  assert.equal(M.trimToPlayhead(t, 0, "start", 24, rate), false);   // exactly on the edge
  assert.equal(t.clips[0].length, 100);

  // A selection restricts it: press E with only the audio picked and the video is spared.
  t = mk();
  assert.equal(M.trimToPlayhead(t, 50, "end", 24, rate, new Set(["a"])), true);
  assert.equal(t.audio[0].length, 50);
  assert.equal(t.clips[0].length, 100);

  // A 30 fps source advances its trim at its own cadence.
  t = mk();
  M.trimToPlayhead(t, 10, "start", 24, () => 30);
  assert.equal(t.clips[0].trimIn, 13);
});

test("nativeFpsFor — only where core documents it", () => {
  // Backed by ComfyUI core, each cited in the source:
  assert.equal(M.nativeFpsFor("Wan (4n+1)"), 16);          // nodes_wan.py:526
  assert.equal(M.nativeFpsFor("LTX (8n+1)"), 25);          // nodes_lt.py:549
  assert.equal(M.nativeFpsFor("MiniMax H3 (17n+5)"), 24);  // nodes_minimax_h3.py:29
  // NOT documented anywhere in the repo: these must stay null rather than carry a guess,
  // or the node would warn confidently about a rate nobody verified.
  assert.equal(M.nativeFpsFor("Hunyuan (4n+1)"), null);
  assert.equal(M.nativeFpsFor("Cosmos (8n+1)"), null);
  assert.equal(M.nativeFpsFor("Mochi (6n+1)"), null);
  assert.equal(M.nativeFpsFor("free"), null);
  assert.equal(M.nativeFpsFor("custom (multiple of N)"), null);
  // Every preset carrying a rate must still be a real preset with a real grid.
  for (const mode of Object.keys(M.QUANTIZE_NATIVE_FPS)) {
    assert.ok(M.QUANTIZE_MODES.includes(mode), `${mode} is not a preset`);
    assert.ok(M.quantizeGrid(mode), `${mode} has no grid`);
  }
});

test("clampClipsToSources — a swapped source pulls its clips back in", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "long", src: "media_0", start: 0, trimIn: 0, length: 300 })];
  t.audio = [{ id: "a", src: "media_1", start: 0, trimIn: 0, length: 4000, gain: 1 }];

  // The three-minute track became ten seconds: clips come back inside it.
  const frames = { media_0: 120, media_1: 240 };
  assert.equal(M.clampClipsToSources(t, 24,
    (s) => frames[s] ?? null, () => 24), true);
  assert.equal(t.clips[0].length, 120);
  assert.equal(t.audio[0].length, 240);

  // Idempotent: a second pass reports no change, so the button leaves no empty undo.
  assert.equal(M.clampClipsToSources(t, 24, (s) => frames[s] ?? null, () => 24), false);

  // It only ever SHORTENS - a source that got longer must not undo a deliberate trim.
  assert.equal(M.clampClipsToSources(t, 24, () => 9999, () => 24), false);
  assert.equal(t.clips[0].length, 120);

  // A trim now past the end of the new material resets rather than reading nothing.
  const t2 = M.emptyTimeline();
  t2.clips = [clip({ id: "c", src: "media_0", start: 0, trimIn: 500, length: 50 })];
  assert.equal(M.clampClipsToSources(t2, 24, () => 100, () => 24), true);
  assert.equal(t2.clips[0].trimIn, 0);
  assert.equal(t2.clips[0].length, 50);

  // Unknown length (a tensor source) is left completely alone.
  const t3 = M.emptyTimeline();
  t3.clips = [clip({ id: "c", src: "media_0", length: 999 })];
  assert.equal(M.clampClipsToSources(t3, 24, () => null, () => 24), false);
  assert.equal(t3.clips[0].length, 999);

  // Rate conversion: 120 source frames at 30 fps are only 96 frames of a 24 fps line.
  const t4 = M.emptyTimeline();
  t4.clips = [clip({ id: "c", src: "media_0", length: 999 })];
  M.clampClipsToSources(t4, 24, () => 120, () => 30);
  assert.equal(t4.clips[0].length, 96);
});

test("clipExtent — mark clip, from the selection or from the playhead", () => {
  const t = M.emptyTimeline();
  t.clips = [clip({ id: "a", start: 10, length: 20 }),          // 10..30
             clip({ id: "b", start: 50, length: 10, track: 1 })];  // 50..60
  t.audio = [{ id: "s", src: "media_1", start: 12, trimIn: 0, length: 25, gain: 1 }];

  // No selection: everything under the playhead. A picture+sound pair cut together gives
  // their shared extent, not whichever was found first.
  assert.deepEqual(M.clipExtent(t, 20), { start: 10, end: 37 });
  // A playhead over a single clip marks just that one.
  assert.deepEqual(M.clipExtent(t, 55), { start: 50, end: 60 });
  // Over a gap there is nothing to mark - and it must not throw or return zeros.
  assert.equal(M.clipExtent(t, 45), null);
  assert.equal(M.clipExtent(M.emptyTimeline(), 0), null);

  // With a selection the playhead is irrelevant: it spans exactly what was picked.
  assert.deepEqual(M.clipExtent(t, 999, new Set(["a"])), { start: 10, end: 30 });
  assert.deepEqual(M.clipExtent(t, 0, new Set(["a", "b"])), { start: 10, end: 60 });
  assert.equal(M.clipExtent(t, 20, new Set(["nope"])), null);

  // The end is exclusive, so a clip at 10 of length 20 ends at 30, not 29.
  const ext = M.clipExtent(t, 20, new Set(["a"]));
  assert.equal(ext.end - ext.start, 20);
});

// ── Freeze-frame markers ──────────────────────────────────────────────────────
// Markers are anchored to the CLIP, so the invariant under test is: an edit that moves
// the clip must not change which PICTURE a marker sits on.

test("markers survive a round trip and stay sorted, unique and in range", () => {
  const t = M.parseTimeline(JSON.stringify({
    clips: [{ id: "a", src: "media_0", start: 100, length: 10,
              markers: [7, 3, 3, -1, 10, 99] }],
  }));
  assert.deepEqual(t.clips[0].markers, [3, 7]);        // dupes, negatives and >= length go
  assert.deepEqual(M.parseTimeline(M.serialiseTimeline(t)).clips[0].markers, [3, 7]);
});

test("a clip with no markers keeps them out of the JSON", () => {
  const t = M.parseTimeline(JSON.stringify({ clips: [{ src: "media_0", length: 5 }] }));
  assert.equal("markers" in t.clips[0], false);
  assert.equal(M.serialiseTimeline(t).includes("markers"), false);
});

test("toggleMarker adds, removes, and refuses frames off the clip", () => {
  const c = clip({ start: 100, length: 10 });
  assert.equal(M.toggleMarker(c, 103), true);
  assert.deepEqual(c.markers, [3]);
  assert.equal(M.toggleMarker(c, 105), true);
  assert.deepEqual(c.markers, [3, 5]);
  assert.equal(M.toggleMarker(c, 103), true);          // same frame again: lifts it
  assert.deepEqual(c.markers, [5]);
  assert.equal(M.toggleMarker(c, 99), false);          // before the clip
  assert.equal(M.toggleMarker(c, 110), false);         // one past the end
  assert.deepEqual(c.markers, [5]);
});

test("moving a clip carries its markers to the new absolute frames", () => {
  const t = M.emptyTimeline();
  const c = clip({ start: 100, length: 10, markers: [3] });
  t.clips.push(c);
  assert.deepEqual(M.markerFrames(t), [103]);
  M.moveClip(c, 200, 0);
  assert.deepEqual(M.markerFrames(t), [203]);          // same picture, new position
});

test("trimming the head keeps markers on the same picture", () => {
  const c = clip({ start: 100, length: 10, markers: [2, 6] });
  M.trimStart(c, 104, 24, 24);                         // cut 4 frames off the front
  assert.equal(c.start, 104);
  assert.deepEqual(c.markers, [2]);                    // 6 -> 2, still frame 106; 2 is gone
  assert.deepEqual(M.markerFrames({ clips: [c], masks: [], audio: [] }), [106]);
});

test("trimming the tail drops the markers that went with it", () => {
  const c = clip({ start: 0, length: 10, markers: [2, 8] });
  M.trimEnd(c, 5, 0, 24, 24);
  assert.deepEqual(c.markers, [2]);
});

test("slipping slides markers with the content", () => {
  const c = clip({ start: 0, length: 10, trimIn: 10, markers: [5] });
  M.slipClip(c, 3, 100, 24, 24);                       // content moves 3 frames earlier
  assert.equal(c.trimIn, 13);
  assert.deepEqual(c.markers, [2]);
});

test("markerFrames deduplicates across lanes", () => {
  const t = M.emptyTimeline();
  t.clips.push(clip({ id: "a", start: 0, length: 10, markers: [4] }));
  t.clips.push(clip({ id: "b", track: 1, start: 0, length: 10, markers: [4, 9] }));
  t.masks.push(clip({ id: "c", start: 5, length: 10, markers: [0] }));   // -> frame 5
  assert.deepEqual(M.markerFrames(t), [4, 5, 9]);
});
