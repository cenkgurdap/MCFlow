import { describe, expect, it } from 'vitest';
import { smooth } from '@/render/binning';
import { DEFAULT_BINS, histogram, selectMixture, type Histogram1D, type MixtureFit } from './mixture';
import { normalCdf } from './components';
import {
  componentPopulations, curveSamples, populationMoments, populationRows, describeDistribution, describeModel, expectedCounts,
  fitIsStale, goodnessOfFit, smoothedModel,
} from './fitDisplay';
import { populationIntervals } from './properties';
import { mixture } from './synthetic';

/* -------------------------------------------------------------------------
   The report these exist for (2026-10-22): a fitted curve with the right
   centre and the wrong height — 0.58 of a live-control histogram reaching 0.94
   — and components that did not trace the bars. Each case below goes through
   the path the two charts take: bin the events, choose the population fit
   (which the gates come from) and the description (which is drawn), then turn
   the description into the rows a chart draws. The height assertions are on
   what is *drawn*, against the bars it is drawn over.
   ------------------------------------------------------------------------- */

const AXIS = { min: -1, max: 1, bins: DEFAULT_BINS };
const max = (a: ArrayLike<number>) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!; return m; };
const sum = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]!; return s; };

/** What the Step 4 chart draws: the tallest point of the continuous sum over the tallest bar. */
function stepFourPeakRatio(h: Histogram1D, fit: MixtureFit): number {
  return max(curveSamples(fit, h.min, h.max, h.width, h.total).total) / max(h.counts);
}

/**
 * What the worksheet draws: 1024 bins and the default 3-bin smoothing, the
 * model through the same window, both over the tallest smoothed bar.
 */
function worksheetPeakRatio(values: Float32Array, fit: MixtureFit): number {
  const panel = histogram(values, { min: -1, max: 1, bins: 1024 })!;
  const bars = smooth(panel.counts, 3);
  const model = smoothedModel(expectedCounts(fit, panel), 3);
  return max(model.total) / max(bars);
}

function r2(h: Histogram1D, fit: MixtureFit): number {
  return goodnessOfFit(h.counts, expectedCounts(fit, h).total).r2;
}

describe('one Gaussian — the estimator and the drawing agree with the truth', () => {
  const values = mixture([{ n: 50000, mean: 0.33, sd: 0.04 }]);
  const h = histogram(values, AXIS)!;
  const population = selectMixture(h).best;
  const drawn = describeDistribution(h);

  it('recovers the centre, spread and weight it was drawn from', () => {
    expect(population.k).toBe(1);
    expect(Math.abs(population.components[0]!.mean - 0.33)).toBeLessThan(0.002);
    // Binned at 0.0078: Sheppard's term adds Δ²/12 to the variance, +0.16% to σ.
    expect(Math.abs(population.components[0]!.sd / 0.04 - 1)).toBeLessThan(0.03);
    expect(population.components[0]!.weight).toBeCloseTo(1, 6);
  });

  it('draws a curve as tall as the bars on the Step 4 chart', () => {
    const ratio = stepFourPeakRatio(h, drawn);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
    expect(r2(h, drawn)).toBeGreaterThan(0.99);
  });

  it('and on the worksheet, smoothed the way the bars are', () => {
    const ratio = worksheetPeakRatio(values, drawn);
    expect(ratio).toBeGreaterThan(0.94);
    expect(ratio).toBeLessThan(1.05);
  });
});

describe('three populations — the treated shape', () => {
  // A treated-sample shape: a sharp, dense mode at −0.64,
  // a broader one beside it, and a wide disordered band. Adjacent separations
  // 1.8 and 4.2 pooled SDs, so all three are admissible populations.
  const values = mixture([
    { n: 6000, mean: -0.64, sd: 0.02 },
    { n: 4000, mean: -0.57, sd: 0.05 },
    { n: 10000, mean: -0.1, sd: 0.15 },
  ]);
  const h = histogram(values, AXIS)!;
  const population = selectMixture(h).best;
  const drawn = describeDistribution(h);

  it('finds three populations where they are', () => {
    expect(population.k).toBe(3);
    // Components come back highest mean first.
    const want = [
      { mean: -0.1, sd: 0.15, weight: 0.5 },
      { mean: -0.57, sd: 0.05, weight: 0.2 },
      { mean: -0.64, sd: 0.02, weight: 0.3 },
    ];
    want.forEach((w, i) => {
      const c = population.components[i]!;
      expect(Math.abs(c.mean - w.mean)).toBeLessThan(0.01);
      expect(Math.abs(c.sd / w.sd - 1)).toBeLessThan(0.1);
      expect(Math.abs(c.weight - w.weight)).toBeLessThan(0.03);
    });
  });

  it('draws a sum that traces the bars', () => {
    expect(r2(h, drawn)).toBeGreaterThan(0.98);
    const ratio = stepFourPeakRatio(h, drawn);
    expect(ratio).toBeGreaterThan(0.93);
    expect(ratio).toBeLessThan(1.05);
  });
});

describe('a sharp peak with a long left tail — the reported live control', () => {
  // A single-population sample on which BIC's own three-component fit puts
  // 87% at 0.336 (sd 0.039), 12% at 0.257 (sd 0.085) and 1% near 0 (sd 0.21).
  // The first two sit 1.46 pooled SDs apart: under `MIN_SEPARATION`, so this is
  // one population — and one Gaussian over it takes the tail's spread.
  const values = mixture([
    { n: 17600, mean: 0.33, sd: 0.035 },
    { n: 2000, mean: 0.24, sd: 0.08 },
    { n: 400, mean: 0.0, sd: 0.2 },
  ]);
  const h = histogram(values, AXIS)!;
  const population = selectMixture(h).best;
  const drawn = describeDistribution(h);

  it('is still counted as one population — the measured rule is the arbiter of that', () => {
    expect(population.k).toBe(1);
  });

  it('draws a curve that reaches the peak, not 0.6 of it', () => {
    expect(stepFourPeakRatio(h, drawn)).toBeGreaterThan(0.9);
    expect(worksheetPeakRatio(values, drawn)).toBeGreaterThan(0.9);
  });

  it('and traces the shoulder and the tail', () => {
    expect(r2(h, drawn)).toBeGreaterThan(0.98);
  });

  it('draws one line for the one population, and that line is the sum', () => {
    const intervals = populationIntervals(population, 'graded');
    const of = componentPopulations(drawn, intervals);
    expect(of.every((p) => p === 0)).toBe(true);
    const rows = populationRows(expectedCounts(drawn, h), of, intervals.length);
    expect(rows.parts).toHaveLength(1);
    rows.parts[0]!.forEach((v, i) => expect(v).toBeCloseTo(rows.total[i]!, 9));
    expect(describeModel(intervals.length)).toBe('Gaussian mixture · 1 population');
  });
});

describe('the drawing is on the bars’ own scale', () => {
  const values = mixture([
    { n: 14000, mean: 0.45, sd: 0.05 },
    { n: 6000, mean: 0.0, sd: 0.06 },
  ]);
  const h = histogram(values, AXIS)!;
  const fit = describeDistribution(h);

  it('integrates to the events the histogram holds', () => {
    expect(sum(expectedCounts(fit, h).total) / h.total).toBeCloseTo(1, 3);
  });

  it('draws every component on the scale of the whole, and they add up to it', () => {
    const rows = expectedCounts(fit, h);
    for (let b = 0; b < h.counts.length; b += 17) {
      expect(rows.parts.reduce((s, p) => s + p[b]!, 0)).toBeCloseTo(rows.total[b]!, 9);
    }
    const curve = curveSamples(fit, -1, 1, h.width, h.total);
    for (let i = 0; i < curve.x.length; i += 97) {
      expect(curve.parts.reduce((s, p) => s + p[i]!, 0)).toBeCloseTo(curve.total[i]!, 9);
    }
  });

  it('follows the gate rather than the count the fit once saw', () => {
    // The same fit laid over half the events: the curve's area must follow the
    // bars it is drawn over. Scaled by the fit's own total it was twice as big.
    const half = histogram(values.subarray(0, 10000), AXIS)!;
    expect(sum(expectedCounts(fit, half).total) / half.total).toBeCloseTo(1, 3);
    expect(fitIsStale(fit.total, half.total)).toBe(true);
    expect(fitIsStale(fit.total, h.total)).toBe(false);
  });

  it('samples every component’s mode, so a sharp peak is drawn at its height', () => {
    const sharp: MixtureFit = { ...fit, components: [{ weight: 1, mean: 0.3137, sd: 0.0079 }] };
    const curve = curveSamples(sharp, -1, 1, 2 / 256, 20000);
    expect(Array.from(curve.x)).toContain(0.3137);
    const peak = 20000 * (2 / 256) / (0.0079 * Math.sqrt(2 * Math.PI));
    expect(max(curve.total) / peak).toBeCloseTo(1, 6);
  });
});

describe('normalCdf', () => {
  it('matches the standard normal table', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.158655, 6);
    expect(normalCdf(-8)).toBeGreaterThan(0);
    expect(normalCdf(-8)).toBeLessThan(1e-14);
  });
});

describe('population lines (0.35)', () => {
  // Known populations: N, weights, means and SDs the drawing must reproduce.
  const N = 20000;
  const truth = [
    { n: 12000, mean: 0.45, sd: 0.04 },
    { n: 5000, mean: 0.1, sd: 0.05 },
    { n: 3000, mean: -0.3, sd: 0.06 },
  ];
  const values = mixture(truth);
  const h = histogram(values, AXIS)!;
  const population = selectMixture(h).best;
  const drawn = describeDistribution(h);
  const intervals = populationIntervals(population, 'graded');
  const of = componentPopulations(drawn, intervals);
  const rows = populationRows(expectedCounts(drawn, h), of, intervals.length);

  it('recovers the known populations', () => {
    expect(population.k).toBe(3);
    const moments = populationMoments(drawn, of, intervals.length);
    truth.forEach((t, i) => {
      expect(moments[i]!.weight).toBeCloseTo(t.n / N, 1);
      expect(Math.abs(moments[i]!.mean - t.mean)).toBeLessThan(0.01);
      expect(Math.abs(moments[i]!.sd - t.sd) / t.sd).toBeLessThan(0.1);
    });
  });

  it('adds up exactly to the drawn sum', () => {
    for (let b = 0; b < h.counts.length; b++) {
      const s = rows.parts.reduce((a, p) => a + p[b]!, 0);
      expect(Math.abs(s - rows.total[b]!)).toBeLessThan(1e-9 * Math.max(1, rows.total[b]!));
    }
  });

  it('draws each population at N·Δ·w·φ — the histogram’s own units', () => {
    const curve = populationRows(curveSamples(drawn, -1, 1, h.width, h.total), of, intervals.length);
    const xs = curveSamples(drawn, -1, 1, h.width, h.total).x;
    drawn.components.forEach((c, k) => {
      const i = xs.findIndex((x) => x === c.mean);
      const own = h.total * h.width * drawn.components
        .filter((_, j) => of[j] === of[k])
        .reduce((a, d) => a + d.weight * Math.exp(-0.5 * ((c.mean - d.mean) / d.sd) ** 2) / (d.sd * Math.sqrt(2 * Math.PI)), 0);
      expect(curve.parts[of[k]!]![i]!).toBeCloseTo(own, 6);
    });
  });

  it('holds N·w events under each line', () => {
    const moments = populationMoments(drawn, of, intervals.length);
    rows.parts.forEach((p, i) => expect(sum(p) / h.total).toBeCloseTo(moments[i]!.weight, 2));
  });
});
