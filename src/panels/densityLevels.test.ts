/**
 * A density plot's colours encode the data — not the event count, the canvas
 * size, the pixel ratio, or a few hundred events stacked on the axis.
 *
 * The report (2026-10-28): two replicate tubes, one gate, near-identical
 * percentages, and one plot's periphery navy where the other's was cyan — the
 * old Auto window rounded per file, 3.5002 to 4 and 3.4992 to 3. These are the
 * properties that make that impossible, asserted on the same functions
 * the plot draws with (`buildDensityLevels`, `paintDensity`).
 *
 * Replicates and subsamples are compared as **distributions of colour** —
 * event-weighted quantiles of the ramp position — because two draws of one
 * population differ cell by cell by their Poisson noise, and that is the data
 * being honest, not the mapping drifting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paintDensity } from '@/render/binning';
import { quantum, type ColorLevelSpec } from '@/render/colorLevels';
import {
  binDensity, buildDensityLevels, densityWindow,
  type DensityDrawArgs, type DensityLevels,
} from './DensityLayer';

const g = globalThis as { ImageData?: unknown };
const hadImageData = !!g.ImageData;
beforeAll(() => {
  if (!hadImageData) {
    g.ImageData = class {
      data: Uint8ClampedArray;
      constructor(readonly width: number, readonly height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
});
afterAll(() => { if (!hadImageData) delete g.ImageData; });

/** Deterministic normal deviates — a seeded LCG through Box–Muller. */
function normals(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/** A population on [0, 100]²: a core and a sparse halo, plus an optional pile on y = 100. */
function sample(n: number, seed: number, opts: { spread?: number; pile?: number } = {}) {
  const r = normals(seed);
  const spread = opts.spread ?? 6;
  const pile = opts.pile ?? 0;
  const x = new Float32Array(n + pile);
  const y = new Float32Array(n + pile);
  for (let i = 0; i < n; i++) {
    const halo = i % 20 === 0;
    x[i] = 40 + r() * (halo ? 18 : spread);
    y[i] = 45 + r() * (halo ? 18 : spread);
  }
  // A real pile is a line along the ceiling, far denser than the core.
  for (let i = n; i < n + pile; i++) { x[i] = 40 + 0.2 * r(); y[i] = 100; }
  return { x, y };
}

const VIEW = { xMin: -10, xMax: 110, yMin: -10, yMax: 110 };
const PERCENTILE: ColorLevelSpec = { style: 'percentile', scaling: 'linear' };
const LINEAR: ColorLevelSpec = { style: 'linear', scaling: 'linear' };
const CEILINGS = { x: null, y: 100 * (1 - 1e-7) };

function args(d: { x: Float32Array; y: Float32Array }, extra: Partial<DensityDrawArgs> = {}): DensityDrawArgs {
  return {
    x: d.x, y: d.y, viewport: VIEW, bins: 256, scale: 'log', ramp: 'rainbow',
    levels: PERCENTILE, smoothingAuto: true, smoothing: 3, outlierSize: 1, ceilings: CEILINGS, ...extra,
  };
}

const position = (b: DensityLevels, v: number) => b.table.positions[quantum(v * b.unit)]!;

/** Ramp position at a data point. */
function positionAt(a: DensityDrawArgs, px: number, py: number): number {
  const b = buildDensityLevels(a);
  const bx = Math.floor(((px - VIEW.xMin) / (VIEW.xMax - VIEW.xMin)) * b.h.width);
  const by = Math.floor(((py - VIEW.yMin) / (VIEW.yMax - VIEW.yMin)) * b.h.height);
  return position(b, b.h.bins[by * b.h.width + bx]!);
}

/** Event-weighted quantiles of the ramp position over a plot. */
function colourQuantiles(a: DensityDrawArgs, qs = [0.1, 0.5, 0.9]): number[] {
  const b = buildDensityLevels(a);
  const cells: Array<[number, number]> = [];
  let total = 0;
  for (let i = 0; i < b.h.bins.length; i++) {
    const v = b.h.bins[i]!;
    if (v > 0) { cells.push([position(b, v), v]); total += v; }
  }
  cells.sort((p, q) => p[0] - q[0]);
  const out: number[] = [];
  let acc = 0;
  let j = 0;
  for (const q of qs) {
    while (j < cells.length - 1 && acc + cells[j]![1] < q * total) acc += cells[j++]![1];
    out.push(cells[j]![0]);
  }
  return out;
}

function expectClose(a: number[], b: number[], tolerance: number, label = '') {
  a.forEach((v, i) => expect(Math.abs(v - b[i]!), `${label} quantile ${i}: ${v} vs ${b[i]}`).toBeLessThan(tolerance));
}

describe('a density plot is a property of the distribution, not of the file', () => {
  it('gives identical colours when every event is there twice, at one window', () => {
    // The levels cancel the count. Auto would narrow the kernel for the doubled
    // file — it holds twice the events — so the window is held fixed to ask the
    // levels alone.
    const one = sample(20_000, 7);
    const two = { x: Float32Array.from([...one.x, ...one.x]), y: Float32Array.from([...one.y, ...one.y]) };
    for (const levels of [PERCENTILE, LINEAR]) {
      const a = buildDensityLevels(args(one, { levels, smoothingAuto: false, smoothing: 3.5 }));
      const b = buildDensityLevels(args(two, { levels, smoothingAuto: false, smoothing: 3.5 }));
      const ia = paintDensity(a.h, a.table, { ramp: 'rainbow', unit: a.unit });
      const ib = paintDensity(b.h, b.table, { ramp: 'rainbow', unit: b.unit });
      expect(Array.from(ib.data)).toEqual(Array.from(ia.data));
    }
  });

  it('smooths by the events the plot holds, and by nothing else', () => {
    // A 300 000-event tube smoothed like a 15 000-event one read as thick. The
    // window follows the binned count, continuously, so a large file is smoothed
    // less and two replicates of near-equal n are smoothed all but alike.
    const small = buildDensityLevels(args(sample(2_000, 1)));
    const large = buildDensityLevels(args(sample(200_000, 2)));
    expect(large.smoothing).toBeLessThan(small.smoothing);
    const binned = binDensity(args(sample(2_000, 1))).raw.totalCount;
    expect(small.smoothing).toBe(densityWindow({ bins: 256, smoothingAuto: true }, binned));
    expect(densityWindow({ bins: 256, smoothingAuto: false, smoothing: 3 }, 200_000)).toBe(3);
  });

  it('gives nearly the same colours on a half-size subsample', () => {
    const full = sample(40_000, 11);
    const half = { x: full.x.filter((_, i) => i % 2 === 0), y: full.y.filter((_, i) => i % 2 === 0) };
    // Percentile is invariant to the count; Linear is not quite, and should not
    // be: a lone event is 1/N of its sample, so at half the events the sparse
    // periphery genuinely reads one step denser. That is the estimate being
    // coarser, not the mapping drifting.
    expectClose(colourQuantiles(args(full)), colourQuantiles(args(half)), 0.05, 'percentile');
    expectClose(colourQuantiles(args(full, { levels: LINEAR })), colourQuantiles(args(half, { levels: LINEAR })), 0.1, 'linear');
  });

  it('is not moved by events piled at the top of the axis', () => {
    // 600 events on the ceiling: 3% of the sample, packed into a few cells far
    // denser than the core — on an Aurora tube the pile measured five times the
    // core's peak.
    const clean = sample(20_000, 3);
    const piled = sample(20_000, 3, { pile: 600 });
    for (const levels of [PERCENTILE, LINEAR]) {
      for (const [px, py] of [[40, 45], [46, 45], [40, 53], [33, 40]] as const) {
        expect(Math.abs(positionAt(args(clean, { levels }), px, py) - positionAt(args(piled, { levels }), px, py)))
          .toBeLessThan(0.02);
      }
    }
    // And the guard is what does it: without the ceilings the pile sets the scale.
    const guarded = positionAt(args(piled, { levels: LINEAR }), 40, 45);
    const unguarded = positionAt(args(piled, { levels: LINEAR, ceilings: null }), 40, 45);
    expect(guarded - unguarded).toBeGreaterThan(0.1);
  });

  it('excludes nothing when the axes have no ceiling', () => {
    expect(binDensity(args(sample(5_000, 5), { ceilings: null })).pile).toBeNull();
  });
});

describe('two replicates, each levelled against itself', () => {
  it('colour alike, because near-equal counts are smoothed near-alike', () => {
    // The tubes of the report: one distribution, two draws, slightly different n.
    const a = sample(24_232, 21);
    const b = sample(24_303, 22);
    for (const levels of [PERCENTILE, LINEAR]) {
      expectClose(colourQuantiles(args(a, { levels, bins: 1024 })), colourQuantiles(args(b, { levels, bins: 1024 })), 0.03, levels.style);
    }
  });
});
