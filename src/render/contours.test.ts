import { describe, expect, it } from 'vitest';
import { normals } from '@/core/biophysics/synthetic';
import { contourLines, marchingSquares, probabilityLevels } from './contours';
import { bin2d } from './binning';

/* -------------------------------------------------------------------------
   Probability contours: each line encloses its stated share of the events.
   Checked on a known 2D Gaussian, where the share inside a contour can be
   counted directly.
   ------------------------------------------------------------------------- */

const N = 40000;
const xs = Float32Array.from(normals(N, 0.5, 0.08, 101));
const ys = Float32Array.from(normals(N, 0.5, 0.08, 202));
const view = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };

/** Ray-cast point-in-polygon. */
function inside(p: [number, number], poly: Array<[number, number]>): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('probability contours', () => {
  const { sets } = contourLines(xs, ys, view);

  it('trace one closed line per level around a single population', () => {
    for (const s of sets) {
      expect(s.lines.length, `${s.fraction}`).toBe(1);
      const line = s.lines[0]!;
      const [a, b] = [line[0]!, line[line.length - 1]!];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
    }
  });

  it('enclose the share of events each one is labelled with', () => {
    for (const s of sets) {
      const poly = s.lines[0]!;
      let n = 0;
      for (let i = 0; i < N; i += 4) if (inside([xs[i]!, ys[i]!], poly)) n++;
      expect(n / (N / 4), `${s.fraction}`).toBeCloseTo(s.fraction, 1);
    }
  });

  it('nest, the densest innermost', () => {
    const area = (p: Array<[number, number]>) => Math.abs(p.reduce((a, [x, y], i) => {
      const [nx, ny] = p[(i + 1) % p.length]!;
      return a + x * ny - nx * y;
    }, 0)) / 2;
    const areas = sets.map((s) => area(s.lines[0]!));
    for (let i = 1; i < areas.length; i++) expect(areas[i]!).toBeGreaterThan(areas[i - 1]!);
  });
});

describe('the pieces', () => {
  it('finds the density that holds each share', () => {
    const h = bin2d(xs, ys, 0, 1, 0, 1, 64, 64);
    const [l50] = probabilityLevels(h, [0.5]);
    let above = 0;
    let total = 0;
    for (const v of h.bins) { total += v; if (v >= l50!) above += v; }
    expect(above / total).toBeGreaterThanOrEqual(0.5);
    expect(above / total).toBeLessThan(0.55);
  });

  it('closes a line that runs into the edge of the grid', () => {
    const grid = new Float32Array(16).fill(1);
    const lines = marchingSquares(grid, 4, 4, 0.5);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line[0]).toEqual(line[line.length - 1]);
  });
});
