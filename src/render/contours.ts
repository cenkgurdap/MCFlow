/**
 * Probability contours over a binned, smoothed density.
 *
 * ## Why (2026-10-22)
 *
 * A pseudocolour map is the right picture on screen and a heavy one on a page:
 * it is a raster, it carries a colour key or none, and a 1024² grid over a
 * fifteen-thousand-event tube reads as a speckle. A contour plot draws the same
 * density as a few vector lines a reader can follow, which is why journals and
 * other analysis packages offer it beside the map. Each line encloses a stated
 * share of the events — 10, 30, 50, 70 and 90% — so its meaning does not depend
 * on the ramp, the scaling or the sample size.
 *
 * The density is binned and smoothed the way the map's is — `bin2d` then
 * `smoothHistogram2d` — on a coarser grid (128²), and with a wider window: the
 * map's Auto rule is tuned for a picture, where texture is honest, and on a
 * contour it left twenty islands where there was one population. The window is
 * a kernel density bandwidth instead — Scott's rule in two dimensions,
 * σ ∝ n^(−1/6), on a robust spread (the smaller of SD and IQR/1.349, so the gap
 * between two populations does not count as spread) — see `contourWindow`. The lines are traced by marching squares
 * over cell centres, saddles decided by the centre value, and joined into
 * polylines; the grid is bordered with zeros so every line closes.
 *
 * Pure.
 */
import { bin2d, smoothHistogram2d, type Histogram2D } from './binning';
import { SMOOTHING_MAX } from './colorLevels';

/** The shares of events the lines enclose, densest first. */
export const CONTOUR_FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9] as const;

/** The grid a contour plot is traced on. */
export const CONTOUR_BINS = 128;

/**
 * The density above which the cells hold each share of the events — so the line
 * at that density encloses that share.
 */
export function probabilityLevels(h: Histogram2D, fractions: readonly number[] = CONTOUR_FRACTIONS): number[] {
  const values = Float64Array.from(h.bins).sort().reverse();
  let total = 0;
  for (const v of values) total += v;
  if (!(total > 0)) return fractions.map(() => Number.NaN);
  return fractions.map((f) => {
    let acc = 0;
    for (const v of values) {
      acc += v;
      if (acc >= f * total) return v;
    }
    return 0;
  });
}

type Point = [number, number];

/**
 * Lines at `level` through a grid of values at cell centres, in grid units
 * (cell `i` is centred at `i + 0.5`).
 */
export function marchingSquares(values: ArrayLike<number>, width: number, height: number, level: number): Point[][] {
  // A zero border, so a line reaching the edge of the grid closes rather than
  // stopping open at it.
  const W = width + 2;
  const H = height + 2;
  const v = (x: number, y: number) => (x <= 0 || y <= 0 || x > width || y > height ? 0 : values[(y - 1) * width + (x - 1)]!);
  const at = (x: number, y: number): Point => [x - 0.5, y - 0.5];
  const lerp = (a: Point, b: Point, va: number, vb: number): Point => {
    const t = va === vb ? 0.5 : (level - va) / (vb - va);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  const segments: Array<[Point, Point]> = [];
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const v0 = v(x, y);
      const v1 = v(x + 1, y);
      const v2 = v(x + 1, y + 1);
      const v3 = v(x, y + 1);
      const code = (v0 >= level ? 1 : 0) | (v1 >= level ? 2 : 0) | (v2 >= level ? 4 : 0) | (v3 >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const p0 = at(x, y);
      const p1 = at(x + 1, y);
      const p2 = at(x + 1, y + 1);
      const p3 = at(x, y + 1);
      const bottom = () => lerp(p0, p1, v0, v1);
      const right = () => lerp(p1, p2, v1, v2);
      const top = () => lerp(p3, p2, v3, v2);
      const left = () => lerp(p0, p3, v0, v3);
      switch (code) {
        case 1: case 14: segments.push([left(), bottom()]); break;
        case 2: case 13: segments.push([bottom(), right()]); break;
        case 3: case 12: segments.push([left(), right()]); break;
        case 4: case 11: segments.push([right(), top()]); break;
        case 6: case 9: segments.push([bottom(), top()]); break;
        case 7: case 8: segments.push([left(), top()]); break;
        case 5: case 10: {
          // A saddle: the centre decides whether the two high corners connect.
          const centre = (v0 + v1 + v2 + v3) / 4;
          const joined = centre >= level;
          if ((code === 5) === joined) { segments.push([left(), top()]); segments.push([bottom(), right()]); }
          else { segments.push([left(), bottom()]); segments.push([right(), top()]); }
          break;
        }
        default: break;
      }
    }
  }
  return joinSegments(segments);
}

/** Chain segments that share endpoints into polylines. */
function joinSegments(segments: Array<[Point, Point]>): Point[][] {
  const key = (p: Point) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
  const byEnd = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const p of [a, b]) {
      const k = key(p);
      const list = byEnd.get(k);
      if (list) list.push(i); else byEnd.set(k, [i]);
    }
  });
  const used = new Uint8Array(segments.length);
  const lines: Point[][] = [];
  const next = (p: Point): Point | null => {
    for (const i of byEnd.get(key(p)) ?? []) {
      if (used[i]) continue;
      used[i] = 1;
      const [a, b] = segments[i]!;
      return key(a) === key(p) ? b : a;
    }
    return null;
  };
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: Point[] = [segments[i]![0], segments[i]![1]];
    for (let p = next(line[line.length - 1]!); p; p = next(line[line.length - 1]!)) line.push(p);
    for (let p = next(line[0]!); p; p = next(line[0]!)) line.unshift(p);
    lines.push(line);
  }
  return lines;
}

/** A closed polyline's area, in grid cells (shoelace). */
function loopArea(line: Point[]): number {
  let a = 0;
  for (let i = 0; i < line.length - 1; i++) a += line[i]![0] * line[i + 1]![1] - line[i + 1]![0] * line[i]![1];
  return Math.abs(a) / 2;
}

export interface ContourSet {
  /** The share of events each level encloses. */
  fraction: number;
  /** Polylines in the viewport's own units. */
  lines: Point[][];
}

/**
 * The smoothing window for a contour grid: a kernel density bandwidth by
 * Scott's rule, h = σ · n^(−1/6), where σ is the robust spread of the events in
 * grid cells — the mean over the two axes of min(SD, IQR/1.349) — turned into
 * the window that delivers it (`σ = (w − 1)/√6`).
 */
export function contourWindow(
  x: Float32Array,
  y: Float32Array,
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number },
  mask?: Uint8Array | null,
): number {
  const xs: number[] = [];
  const ys: number[] = [];
  const stride = Math.max(1, Math.floor(x.length / 20000));
  for (let i = 0; i < x.length; i += stride) {
    if (mask && !mask[i]) continue;
    const a = x[i]!;
    const b = y[i]!;
    if (a < viewport.xMin || a >= viewport.xMax || b < viewport.yMin || b >= viewport.yMax) continue;
    xs.push(a);
    ys.push(b);
  }
  const n = xs.length * stride;
  if (xs.length < 10) return 3;
  const spread = (v: number[], span: number) => {
    const s = [...v].sort((p, q) => p - q);
    const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]!;
    let mean = 0;
    for (const t of v) mean += t;
    mean /= v.length;
    let ss = 0;
    for (const t of v) ss += (t - mean) ** 2;
    const sd = Math.sqrt(ss / (v.length - 1));
    const robust = Math.min(sd, (q(0.75) - q(0.25)) / 1.349) || sd;
    return (robust / (span || 1)) * CONTOUR_BINS;
  };
  const sigma = ((spread(xs, viewport.xMax - viewport.xMin) + spread(ys, viewport.yMax - viewport.yMin)) / 2) * n ** (-1 / 6);
  return Math.max(3, Math.min(SMOOTHING_MAX, Math.round(sigma * Math.sqrt(6) + 1)));
}

/**
 * Probability contours for events in a viewport — the lines a contour plot
 * draws, in the viewport's units, densest first. `smoothing` is the grid's
 * window, or the density bandwidth from `contourWindow` when absent.
 */
export function contourLines(
  x: Float32Array,
  y: Float32Array,
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number },
  opts: { mask?: Uint8Array | null; smoothing?: number } = {},
): { sets: ContourSet[]; smoothing: number } {
  const raw = bin2d(x, y, viewport.xMin, viewport.xMax, viewport.yMin, viewport.yMax, CONTOUR_BINS, CONTOUR_BINS, opts.mask ?? null);
  const smoothing = opts.smoothing ?? contourWindow(x, y, viewport, opts.mask);
  const h = smoothHistogram2d(raw, smoothing);
  const levels = probabilityLevels(h);
  const sx = (viewport.xMax - viewport.xMin) / CONTOUR_BINS;
  const sy = (viewport.yMax - viewport.yMin) / CONTOUR_BINS;
  const sets = CONTOUR_FRACTIONS.map((fraction, i) => {
    const level = levels[i]!;
    if (!(level > 0)) return { fraction, lines: [] };
    // A closed loop smaller than one grid cell is a fleck of noise on the flat
    // top of a peak, not a region a reader could point at; it is left out.
    const lines = marchingSquares(h.bins, h.width, h.height, level)
      .filter((line) => loopArea(line) >= 1)
      .map((line) => line.map(([gx, gy]) => [viewport.xMin + gx * sx, viewport.yMin + gy * sy] as Point));
    return { fraction, lines };
  });
  return { sets, smoothing };
}
