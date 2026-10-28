/**
 * Align the reference onto the render, for the Popup Preview's compare and Restore.
 *
 * Edit models (Qwen, Klein…) hand back the picture shifted or zoomed by a few pixels, so a
 * wipe shows a seam and a Restore stroke leaves a step. This finds the shift + uniform scale
 * that lays the reference over the render. Pure (luminance in, transform out) so a node test
 * can pin it; the viewer does the canvas half.
 *
 * Model: a reference point q lands at  p = c + d + s·(q − c)  (c = image centre), so the
 * reference is sampled at  q = c + (p − c − d) / s.  d is kept as a FRACTION of the image
 * size, which carries between pyramid levels and survives a change of render resolution.
 *
 * ponytail: brute-force coarse-to-fine search on normalised cross-correlation, no FFT.
 * ~0.5 s on a click; phase correlation if it ever has to run per frame.
 */

/** Luminance of one pyramid level, both pictures in the render's frame. `box` is where the
 *  (unaligned) reference sits in that frame: outside it there is no reference to compare. */
export type AlignLevel = {
  a: Float32Array;   // render
  b: Float32Array;   // reference, drawn into `box`
  w: number;
  h: number;
  box: { x: number; y: number; w: number; h: number };
};
export type Align = { dx: number; dy: number; s: number };

export const IDENTITY: Align = { dx: 0, dy: 0, s: 1 };

/** Normalised cross-correlation of the render against the transformed reference, sampled
 *  every `stride` px. Brightness/contrast changes between the two don't move it. */
export function score(L: AlignLevel, t: Align, stride: number): number {
  const { a, b, w, h, box } = L;
  const cx = w / 2, cy = h / 2, ox = cx + t.dx * w, oy = cy + t.dy * h, inv = 1 / t.s;
  const x0 = box.x, y0 = box.y, x1 = box.x + box.w - 1, y1 = box.y + box.h - 1;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, total = 0;
  for (let y = stride >> 1; y < h; y += stride) {
    const qy = cy + (y - oy) * inv;
    for (let x = stride >> 1; x < w; x += stride) {
      total++;
      const qx = cx + (x - ox) * inv;
      if (qx < x0 || qy < y0 || qx >= x1 || qy >= y1) continue;
      const ix = qx | 0, iy = qy | 0, fx = qx - ix, fy = qy - iy, i = iy * w + ix;
      const top = b[i] + (b[i + 1] - b[i]) * fx;
      const bot = b[i + w] + (b[i + w + 1] - b[i + w]) * fx;
      const vb = top + (bot - top) * fy, va = a[y * w + x];
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  // A transform that slides the reference mostly out of frame "wins" on a sliver: refuse it.
  if (n < total * 0.5) return -Infinity;
  const cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -Infinity;
}

/** Best transform in a window around `t`: shifts in level px, scale steps absolute. */
function refine(L: AlignLevel, t: Align, shift: number, shiftStep: number,
                scale: number, scaleStep: number, stride: number): Align {
  let best = t, bestS = -Infinity;
  for (let s = t.s - scale; s <= t.s + scale + 1e-9; s += scaleStep) {
    for (let y = -shift; y <= shift + 1e-9; y += shiftStep) {
      for (let x = -shift; x <= shift + 1e-9; x += shiftStep) {
        const c = { dx: t.dx + x / L.w, dy: t.dy + y / L.h, s };
        const v = score(L, c, stride);
        if (v > bestS) { bestS = v; best = c; }
      }
    }
  }
  return best;
}

/** Coarse on `small` (~256 px: catches up to ~5 % shift and ±6 % zoom), then three passes on
 *  `large` (~1024 px) down to an eighth of a pixel there. */
export function findAlign(small: AlignLevel, large: AlignLevel): Align {
  let t = refine(small, IDENTITY, 12, 2, 0.06, 0.01, 2);
  t = refine(large, t, 8, 2, 0.01, 0.0025, 4);
  t = refine(large, t, 2, 0.5, 0.0025, 0.000625, 4);
  t = refine(large, t, 0.5, 0.125, 0.0006, 0.0003, 4);
  return t;
}

/** The reference's box in the render's px once aligned (same model as `score`). */
export function alignBox(b: { x: number; y: number; w: number; h: number }, t: Align,
                         cw: number, ch: number) {
  const cx = cw / 2, cy = ch / 2;
  return { x: cx + t.dx * cw + t.s * (b.x - cx), y: cy + t.dy * ch + t.s * (b.y - cy),
           w: b.w * t.s, h: b.h * t.s };
}
