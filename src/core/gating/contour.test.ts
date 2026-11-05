import { describe, expect, it } from 'vitest';
import {
  blurGrid, contourToData, denseComponents, densityContour, densityInterval, densityThreshold,
  maskCentroid, radialOutline, type DensityGrid,
} from './contour';
import { inPolygon, polygonArea } from './geometry';

/** A grid of `w × h` cells with a callback filling each. */
function grid(w: number, h: number, f: (x: number, y: number) => number): DensityGrid {
  const bins = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bins[y * w + x] = f(x, y);
  return { bins, width: w, height: h };
}

/** A round Gaussian-ish blob centred at (cx, cy). */
function blob(w: number, h: number, cx: number, cy: number, sigma: number, peak: number): DensityGrid {
  return grid(w, h, (x, y) => {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    const v = peak * Math.exp(-d2 / (2 * sigma * sigma));
    return v < 0.01 ? 0 : v;
  });
}

function add(a: DensityGrid, b: DensityGrid): DensityGrid {
  const bins = new Float32Array(a.width * a.height);
  for (let i = 0; i < bins.length; i++) bins[i] = a.bins[i]! + b.bins[i]!;
  return { bins, width: a.width, height: a.height };
}

/** Fraction of the grid's total signal that falls inside the polygon. */
function enclosed(g: DensityGrid, poly: { x: number; y: number }[]): number {
  let inside = 0;
  let total = 0;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const v = g.bins[y * g.width + x]!;
      if (v <= 0) continue;
      total += v;
      if (inPolygon(poly, x + 0.5, y + 0.5)) inside += v;
    }
  }
  return total === 0 ? 0 : inside / total;
}

describe('densityThreshold', () => {
  it('is the density of the last cell needed to reach the coverage', () => {
    // Four cells: 80, 10, 6, 4. 80% of 100 is 80, met by the first cell alone.
    const g: DensityGrid = { bins: new Float32Array([80, 10, 6, 4]), width: 2, height: 2 };
    expect(densityThreshold(g, 0.8)).toBe(80);
  });

  it('descends far enough when the signal is spread out', () => {
    const g: DensityGrid = { bins: new Float32Array([40, 30, 20, 10]), width: 2, height: 2 };
    // 40 + 30 = 70 < 80; 40 + 30 + 20 = 90 >= 80.
    expect(densityThreshold(g, 0.8)).toBe(20);
  });

  it('is invariant to a uniform rescaling of the counts', () => {
    const a: DensityGrid = { bins: new Float32Array([40, 30, 20, 10]), width: 2, height: 2 };
    const b: DensityGrid = { bins: new Float32Array([400, 300, 200, 100]), width: 2, height: 2 };
    expect(densityThreshold(b, 0.8)).toBe(densityThreshold(a, 0.8) * 10);
  });

  it('returns 0 for an empty grid', () => {
    expect(densityThreshold({ bins: new Float32Array(16), width: 4, height: 4 }, 0.8)).toBe(0);
  });
});

describe('denseComponents', () => {
  it('drops a region carrying too little signal to be a population', () => {
    // A dense 2x2 block top-left carrying 200, a sparse 3x3 bottom-right
    // carrying 45. The sparse one covers more cells and a fifth of the weight.
    const g = grid(10, 10, (x, y) => {
      if (x < 2 && y < 2) return 50;
      if (x >= 7 && y >= 7) return 5;
      return 0;
    });
    const mask = denseComponents(g, 1, 0.5);
    expect(mask[0]).toBe(1);
    expect(mask[9 * 10 + 9]).toBe(0);
    expect(mask.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('keeps a genuine second population beside the first', () => {
    /*
       The reason this is not "the largest component". A general scatter gate on
       PBMCs has to hold lymphocytes, monocytes and granulocytes — three separate
       clouds, none of them debris — and keeping only the heaviest would gate one
       of the three and call it "Cells".
    */
    const g = grid(10, 10, (x, y) => {
      if (x < 2 && y < 2) return 50;
      if (x >= 7 && y >= 7) return 20;
      return 0;
    });
    const mask = denseComponents(g, 1);
    expect(mask[0]).toBe(1);
    expect(mask[9 * 10 + 9]).toBe(1);
  });

  it('is 4-connected — a diagonal touch is two regions', () => {
    const g = grid(4, 4, (x, y) => ((x === 0 && y === 0) || (x === 1 && y === 1) ? 10 : 0));
    // Equal weight, so with a share floor both survive; at a floor above 1 only
    // the heaviest can, and there is exactly one cell in it.
    expect(denseComponents(g, 1, 1.5).reduce((a, b) => a + b, 0)).toBe(0);
    expect(denseComponents(g, 1, 1).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('is empty when nothing reaches the threshold', () => {
    const g = grid(4, 4, () => 1);
    expect(denseComponents(g, 5).some((v) => v === 1)).toBe(false);
  });
});

describe('maskCentroid', () => {
  it('finds the middle of a symmetric blob', () => {
    const g = blob(40, 40, 20, 12, 4, 100);
    const mask = denseComponents(g, densityThreshold(g, 0.8));
    const c = maskCentroid(g, mask);
    expect(c.x).toBeCloseTo(20.5, 0);
    expect(c.y).toBeCloseTo(12.5, 0);
  });

  it('falls back to the grid centre with an empty mask', () => {
    const g = grid(10, 20, () => 0);
    expect(maskCentroid(g, new Uint8Array(200))).toEqual({ x: 5, y: 10 });
  });
});

describe('radialOutline', () => {
  it('produces one vertex per ray, in angle order', () => {
    const g = blob(60, 60, 30, 30, 6, 100);
    const mask = denseComponents(g, densityThreshold(g, 0.8));
    const poly = radialOutline(g, mask, maskCentroid(g, mask), 16);
    expect(poly).toHaveLength(16);
    // Angle-ordered means the signed area has one sign; a self-intersecting
    // outline would not.
    expect(Math.abs(polygonArea(poly))).toBeGreaterThan(0);
  });

  it('traces a round blob as something close to round', () => {
    const g = blob(80, 80, 40, 40, 8, 100);
    const mask = denseComponents(g, densityThreshold(g, 0.8));
    const c = maskCentroid(g, mask);
    const poly = radialOutline(g, mask, c, 24);
    const radii = poly.map((p) => Math.hypot(p.x - c.x, p.y - c.y));
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    expect(max / min).toBeLessThan(1.15);
  });

  it('follows an elongated blob rather than circumscribing it', () => {
    // Twice as wide as it is tall.
    const g = grid(80, 80, (x, y) => {
      const v = 100 * Math.exp(-(((x - 40) ** 2) / (2 * 14 * 14) + ((y - 40) ** 2) / (2 * 7 * 7)));
      return v < 0.01 ? 0 : v;
    });
    const mask = denseComponents(g, densityThreshold(g, 0.8));
    const c = maskCentroid(g, mask);
    const poly = radialOutline(g, mask, c, 32);
    const across = Math.abs(poly[0]!.x - c.x);
    const up = Math.abs(poly[8]!.y - c.y);
    expect(across / up).toBeGreaterThan(1.6);
  });
});

describe('blurGrid', () => {
  it('conserves signal to within a rounding error', () => {
    const g = blob(40, 40, 20, 20, 5, 100);
    const before = Array.from(g.bins as Float32Array).reduce((a, b) => a + b, 0);
    const after = Array.from(blurGrid(g, 2).bins as Float32Array).reduce((a, b) => a + b, 0);
    expect(after / before).toBeGreaterThan(0.97);
    expect(after / before).toBeLessThan(1.03);
  });

  it('spreads an isolated cell into its neighbours', () => {
    const g = grid(9, 9, (x, y) => (x === 4 && y === 4 ? 100 : 0));
    const b = blurGrid(g, 1.5);
    expect(b.bins[4 * 9 + 4]!).toBeLessThan(100);
    expect(b.bins[4 * 9 + 3]!).toBeGreaterThan(0);
  });

  it('returns the same grid at radius 0', () => {
    const g = grid(4, 4, () => 1);
    expect(blurGrid(g, 0)).toBe(g);
  });
});

describe('densityContour', () => {
  it('encloses about the coverage it was asked for', () => {
    const g = blob(100, 100, 50, 50, 12, 100);
    const poly = densityContour(g, { coverage: 0.8, rays: 32 });
    const frac = enclosed(g, poly);
    expect(frac).toBeGreaterThan(0.75);
    expect(frac).toBeLessThan(0.98);
  });

  it('takes in more of the distribution at a higher coverage', () => {
    const g = blob(100, 100, 50, 50, 12, 100);
    const tight = polygonArea(densityContour(g, { coverage: 0.5, rays: 32 }));
    const loose = polygonArea(densityContour(g, { coverage: 0.9, rays: 32 }));
    expect(Math.abs(loose)).toBeGreaterThan(Math.abs(tight));
  });

  it('excludes a debris corner that a bounding box would swallow', () => {
    /*
       The claim this whole module exists for. A dense population at (60, 60)
       plus a sparse debris smear in the (5, 5) corner: the axis-aligned box
       around the 2nd-to-92nd percentile of each axis independently spans both,
       because the corner moves the low percentile on *both* axes.
    */
    const population = blob(100, 100, 60, 60, 9, 100);
    const debris = blob(100, 100, 6, 6, 4, 6);
    const g = add(population, debris);

    const poly = densityContour(g, { coverage: 0.8, rays: 32 });
    expect(poly.length).toBe(32);
    expect(inPolygon(poly, 60, 60)).toBe(true);
    expect(inPolygon(poly, 6, 6)).toBe(false);

    // And the bounding box of the same polygon does contain the debris, which is
    // what the previous rectangle gate was.
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThan(20);
    expect(Math.min(...ys)).toBeGreaterThan(20);
  });

  it('keeps the denser of two populations when only one can be gated', () => {
    const heavy = blob(100, 100, 30, 30, 8, 100);
    const light = blob(100, 100, 75, 75, 8, 12);
    const poly = densityContour(add(heavy, light), { coverage: 0.7, rays: 24 });
    expect(inPolygon(poly, 30, 30)).toBe(true);
    expect(inPolygon(poly, 75, 75)).toBe(false);
  });

  it('returns nothing for an empty grid rather than a gate around everything', () => {
    expect(densityContour({ bins: new Float32Array(400), width: 20, height: 20 })).toEqual([]);
  });

  it('never produces a vertex outside the grid', () => {
    // A blob pressed into the corner, where a naive radius would run off.
    const g = blob(50, 50, 2, 2, 6, 100);
    const poly = densityContour(g, { rays: 20 });
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(50);
      expect(p.y).toBeLessThanOrEqual(50);
    }
  });
});

describe('contourToData', () => {
  it('maps cell coordinates onto the binned range', () => {
    const poly = [{ x: 0, y: 0 }, { x: 100, y: 50 }];
    const out = contourToData(poly, { width: 100, height: 50 }, { xMin: -1, xMax: 4, yMin: 0, yMax: 10 });
    expect(out[0]).toEqual({ x: -1, y: 0 });
    expect(out[1]).toEqual({ x: 4, y: 10 });
  });

  it('is linear in the cell coordinate', () => {
    const out = contourToData(
      [{ x: 25, y: 25 }],
      { width: 100, height: 100 },
      { xMin: 0, xMax: 8, yMin: 0, yMax: 8 },
    );
    expect(out[0]!.x).toBeCloseTo(2);
    expect(out[0]!.y).toBeCloseTo(2);
  });
});

/* ==========================================================================
   densityInterval — the one-dimensional seed, for a baseline worksheet
   ========================================================================== */

/** Normal-ish samples, deterministic, so a failure is reproducible. */
function normal(n: number, mean: number, sd: number, seed = 1): number[] {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    // Sum of twelve uniforms minus six: mean 0, variance 1, and no logs to
    // guard against a zero from the generator.
    let acc = 0;
    for (let k = 0; k < 12; k++) acc += rand();
    out.push(mean + (acc - 6) * sd);
  }
  return out;
}

function fraction(values: Float32Array, iv: { min: number; max: number }): number {
  let inside = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! >= iv.min && values[i]! <= iv.max) inside++;
  return inside / values.length;
}

describe('densityInterval', () => {
  it('brackets the bulk of a unimodal distribution', () => {
    const values = Float32Array.from(normal(20000, 0.5, 0.06));
    const iv = densityInterval(values, { min: 0, max: 1, coverage: 0.98 })!;
    expect(iv).not.toBeNull();
    expect(iv.min).toBeLessThan(0.5);
    expect(iv.max).toBeGreaterThan(0.5);
    expect(fraction(values, iv)).toBeGreaterThan(0.96);
    // And it is an interval, not the whole axis — the point is that it excludes
    // something.
    expect(iv.max - iv.min).toBeLessThan(0.6);
  });

  it('leaves a sparse tail outside', () => {
    // A clean population at 0.4 with 1.5% of the events smeared up at 0.9 — the
    // contaminating subpopulation this seed exists to exclude.
    const main = normal(20000, 0.4, 0.05);
    const tail = normal(300, 0.9, 0.02, 99);
    const values = Float32Array.from([...main, ...tail]);
    const iv = densityInterval(values, { min: 0, max: 1, coverage: 0.97 })!;
    expect(iv.max).toBeLessThan(0.8);
    expect(iv.min).toBeGreaterThan(0.1);
  });

  it('keeps a real second population, which a density floor would cut', () => {
    // Two genuine modes. Growing greedily by density reaches the smaller one
    // before it reaches the tails, so both are inside.
    const values = Float32Array.from([...normal(12000, 0.3, 0.03), ...normal(6000, 0.6, 0.03, 7)]);
    const iv = densityInterval(values, { min: 0, max: 1, coverage: 0.98 })!;
    expect(iv.min).toBeLessThan(0.3);
    expect(iv.max).toBeGreaterThan(0.6);
  });

  it('honours a subset of event indices', () => {
    const values = Float32Array.from([...normal(6000, 0.2, 0.02), ...normal(6000, 0.8, 0.02, 3)]);
    // Only the upper population.
    const subset = new Uint32Array(6000);
    for (let i = 0; i < 6000; i++) subset[i] = 6000 + i;
    const iv = densityInterval(values, { min: 0, max: 1, coverage: 0.98, subset })!;
    expect(iv.min).toBeGreaterThan(0.6);
  });

  it('reports the coverage it achieved', () => {
    const values = Float32Array.from(normal(5000, 0.5, 0.05));
    const iv = densityInterval(values, { min: 0, max: 1, coverage: 0.9 })!;
    expect(iv.coverage).toBeGreaterThanOrEqual(0.9);
    expect(iv.coverage).toBeLessThanOrEqual(1);
  });

  it('is null when there is nothing in range', () => {
    expect(densityInterval(new Float32Array(0), { min: 0, max: 1 })).toBeNull();
    expect(densityInterval(Float32Array.from([5, 6, 7]), { min: 0, max: 1 })).toBeNull();
    expect(densityInterval(Float32Array.from([NaN, NaN]), { min: 0, max: 1 })).toBeNull();
  });

  it('is null for an empty range rather than dividing by it', () => {
    expect(densityInterval(Float32Array.from([1, 2]), { min: 1, max: 1 })).toBeNull();
  });
});
