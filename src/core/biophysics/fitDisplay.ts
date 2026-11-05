/**
 * A fit, as something drawn over the distribution it describes.
 *
 * ## Why this file exists (2026-10-22)
 *
 * The report was a curve with the right centre and the wrong shape: on a sharp
 * single-population live-control peak the fitted line rose to
 * 0.58 of a histogram that reached 0.94 and was half as wide again, and on the
 * three-population tubes the curves did not trace the bars either. Nothing in
 * the scaling was wrong — both charts drew events per bin against events per
 * bin. What was drawn was the **population fit**, and the population fit is not
 * trying to describe the distribution: it is the admissible model the gates are
 * cut from, so it carries `MIN_SEPARATION`. A sharp peak with a long left tail is
 * described far better by three Gaussians than by one — BIC says so on every
 * untreated tube — but the three sit within 1.5 pooled SDs of each other, so the
 * rule names one population, correctly. One Gaussian over the same events then
 * takes its spread from the tail as well: SD 0.065 against a core of about 0.04,
 * and a peak at 0.59 of the data's.
 *
 * ## Two models, and which question each answers
 *
 *   - The **population fit** (`BiophysicsSample.fit`) decides how many
 *     populations there are and where they divide. It is untouched, and so is
 *     every number the gates, the tree, Statistics and Export report.
 *   - The **description** is what is drawn: the mixture BIC prefers, from one to
 *     `MAX_FIT_COMPONENTS` components, with neither admissibility rule. Those
 *     rules keep an automatic choice from *naming* structure it cannot see. A
 *     drawing names nothing, and a curve that does not trace the histogram is a
 *     false statement about the data, which the rules were never meant to
 *     license.
 *
 * What is drawn is one line per population — the description's components
 * summed by the population interval their means fall in (`populationRows`) —
 * plus the total. Never the individual components (0.35).
 *
 * ## One scale and one smoothing for the model and the bars
 *
 *   - Expected events per bin are exact bin integrals, N·Σ w·[Φ(hi) − Φ(lo)],
 *     where N is what the **displayed** histogram holds — not the count at fit
 *     time, which goes stale the moment a gate is reshaped.
 *   - A display that smooths its bars passes the model through the same
 *     `smooth()` window, and divides both by one number. Smoothing the bars and
 *     not the model lowered one and left the other where it was.
 *   - A continuous curve is sampled four times per bin and at every component's
 *     mode. Two hundred and forty samples across −1…1 is one every 0.0083 —
 *     coarser than the bins — and drew a sharp component up to 13% short.
 *
 * Pure: numbers in, numbers out.
 */
import { smooth } from '@/render/binning';
import { componentMass, componentMode, componentPdf } from './components';
import { MAX_FIT_COMPONENTS, selectMixture, type Histogram1D, type MixtureFit } from './mixture';

/* -------------------------------------------------------------------------
   What is drawn
   ------------------------------------------------------------------------- */

/**
 * The mixture drawn over a distribution: the one BIC prefers, from one to
 * `MAX_FIT_COMPONENTS` components, with no admissibility rule — see the header
 * for why the rules belong to the population fit and not to a drawing.
 */
export function describeDistribution(h: Histogram1D): MixtureFit {
  return selectMixture(h, { maxComponents: MAX_FIT_COMPONENTS, minWeight: 0, minSeparation: 0 }).best;
}

/**
 * Rows per component, summed into rows per **population** (0.35).
 *
 * The description may take three Gaussians to trace one population's sharp
 * peak and long tail; drawing each of them put three dashed lines under one
 * gate that named nothing. A population is drawn as one line — the sum of the
 * components whose means its interval holds, N·Δ·Σ w·φ — so the population
 * lines add up exactly to the drawn sum and each line is one gate's events.
 */
export function populationRows(rows: ModelRows, populationOf: readonly number[], count: number): ModelRows {
  const length = rows.total.length;
  const parts = Array.from({ length: Math.max(1, count) }, () => new Float64Array(length));
  rows.parts.forEach((row, k) => {
    const into = parts[Math.min(parts.length - 1, Math.max(0, populationOf[k] ?? 0))]!;
    for (let i = 0; i < length; i++) into[i] += row[i]!;
  });
  return { total: rows.total, parts };
}

/* -------------------------------------------------------------------------
   The model on the bars' own scale
   ------------------------------------------------------------------------- */

/** A model evaluated on some grid: the sum, then one row per component. */
export interface ModelRows {
  total: Float64Array;
  parts: Float64Array[];
}

/** The binning a display drew its bars at — the fields of a `Histogram1D` it needs. */
export type Binning = Pick<Histogram1D, 'min' | 'width' | 'counts' | 'total'>;

/**
 * Expected events in every bin of `h` under `fit`.
 *
 * Exact bin integrals rather than the density at the centre times the width,
 * and scaled to what `h` holds — the displayed population — so a gate reshaped
 * after the fit moves the curve's area with the bars instead of leaving it at
 * the count the fit once saw.
 */
export function expectedCounts(fit: MixtureFit, h: Binning): ModelRows {
  const bins = h.counts.length;
  const parts = fit.components.map((c) => {
    const row = new Float64Array(bins);
    let below = componentMass(c, Number.NEGATIVE_INFINITY, h.min);
    for (let b = 0; b < bins; b++) {
      // Cumulative, so each bin costs one distribution-function evaluation and
      // the bins tile the axis exactly rather than to rounding at every edge.
      const upTo = componentMass(c, Number.NEGATIVE_INFINITY, h.min + (b + 1) * h.width);
      row[b] = h.total * c.weight * Math.max(0, upTo - below);
      below = upTo;
    }
    return row;
  });
  return { total: sumRows(parts, bins), parts };
}

/**
 * The model as a display that smooths its bars must draw it: through the same
 * `smooth()` window the bars went through. The caller divides both by one
 * number — the tallest smoothed bar — so a curve and a bar of equal height
 * describe the same count.
 */
export function smoothedModel(rows: ModelRows, window: number): ModelRows {
  const parts = rows.parts.map((p) => smooth(p, window));
  return { total: smooth(rows.total, window), parts };
}

/** A continuous curve: positions on the axis, with the model's height at each. */
export interface CurveSamples extends ModelRows {
  x: Float64Array;
}

/** The most samples one curve is drawn with, whatever the zoom. */
const MAX_SAMPLES = 8192;

/**
 * The model as a continuous curve over `[from, to]`, in events per bin of width
 * `binWidth` for `total` events.
 *
 * At least `perBin` samples per bin, **plus every component's mode**, so a peak
 * is drawn at its height rather than between two samples straddling it.
 */
export function curveSamples(
  fit: MixtureFit,
  from: number,
  to: number,
  binWidth: number,
  total: number,
  perBin = 4,
): CurveSamples {
  const span = to - from;
  const steps = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil((span / binWidth) * perBin)));
  const xs: number[] = [];
  for (let i = 0; i <= steps; i++) xs.push(from + (i / steps) * span);
  for (const c of fit.components) {
    const m = componentMode(c);
    if (m > from && m < to) xs.push(m);
  }
  xs.sort((a, b) => a - b);
  const x = Float64Array.from(xs);

  const scale = total * binWidth;
  const parts = fit.components.map((c) => {
    const row = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) row[i] = scale * c.weight * componentPdf(c, x[i]!);
    return row;
  });
  return { x, total: sumRows(parts, x.length), parts };
}

function sumRows(parts: Float64Array[], length: number): Float64Array {
  const out = new Float64Array(length);
  for (const p of parts) for (let i = 0; i < length; i++) out[i] += p[i]!;
  return out;
}

/* -------------------------------------------------------------------------
   How good the description is
   ------------------------------------------------------------------------- */

export interface Goodness {
  /** 1 − SS(residual) / SS(total), over the bins that carry signal. */
  r2: number;
  /** Root-mean-square residual, as a fraction of the tallest bar. */
  rms: number;
  /** How many bins both were computed over. */
  bins: number;
}

/** Below this share of the tallest bar a bin is empty axis, not data. */
const SIGNAL_FLOOR = 0.002;

/**
 * How well a model's expected counts describe the bars.
 *
 * Over the bins where either the data or the model reaches 0.2% of the tallest
 * bar. The rest of a fixed −1…1 axis is empty on both sides, and counting it
 * would let a description score well for agreeing about where nothing is.
 */
export function goodnessOfFit(counts: ArrayLike<number>, expected: ArrayLike<number>): Goodness {
  let peak = 0;
  for (let i = 0; i < counts.length; i++) if (counts[i]! > peak) peak = counts[i]!;
  const floor = peak * SIGNAL_FLOOR;
  const keep: number[] = [];
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! >= floor || expected[i]! >= floor) keep.push(i);
  }
  if (keep.length === 0 || peak <= 0) return { r2: Number.NaN, rms: Number.NaN, bins: 0 };
  let mean = 0;
  for (const i of keep) mean += counts[i]!;
  mean /= keep.length;
  let ssr = 0;
  let sst = 0;
  for (const i of keep) {
    ssr += (counts[i]! - expected[i]!) ** 2;
    sst += (counts[i]! - mean) ** 2;
  }
  return {
    r2: sst > 0 ? 1 - ssr / sst : Number.NaN,
    rms: Math.sqrt(ssr / keep.length) / peak,
    bins: keep.length,
  };
}

/* -------------------------------------------------------------------------
   Reading the drawing against the populations
   ------------------------------------------------------------------------- */

/**
 * The population each drawn component belongs to: the interval holding its
 * mean. The intervals are the population fit's — `populationIntervals` — so the
 * colour a component is drawn in is the colour of the gate it sits under.
 */
export function componentPopulations(
  fit: MixtureFit,
  intervals: ReadonlyArray<{ min: number; max: number }>,
): number[] {
  return fit.components.map((c) => {
    const at = intervals.findIndex((iv) => c.mean >= iv.min && c.mean < iv.max);
    return at >= 0 ? at : 0;
  });
}

/** One drawn population: its share of the events and the moments of its line. */
export interface PopulationLine {
  weight: number;
  mean: number;
  sd: number;
}

/**
 * The share, mean and SD of each population's line — the moments of the
 * components summed into it, so the numbers a legend prints describe the line
 * it prints them beside.
 */
export function populationMoments(fit: MixtureFit, populationOf: readonly number[], count: number): PopulationLine[] {
  return Array.from({ length: Math.max(1, count) }, (_, p) => {
    const cs = fit.components.filter((_, k) => (populationOf[k] ?? 0) === p);
    const w = cs.reduce((a, c) => a + c.weight, 0);
    if (w <= 0) return { weight: 0, mean: Number.NaN, sd: Number.NaN };
    const mean = cs.reduce((a, c) => a + c.weight * c.mean, 0) / w;
    const second = cs.reduce((a, c) => a + c.weight * (c.sd * c.sd + c.mean * c.mean), 0) / w;
    return { weight: w, mean, sd: Math.sqrt(Math.max(0, second - mean * mean)) };
  });
}

/** The one line that names what is drawn — `Gaussian mixture · 2 populations`. */
export function describeModel(populations: number): string {
  return `Gaussian mixture · ${populations} population${populations === 1 ? '' : 's'}`;
}

/**
 * Whether the gate now holds a different population from the one the fit was
 * computed over — more than half a percent apart. The curve follows the gate
 * either way; this is what tells somebody the *populations* have not.
 */
export function fitIsStale(fitTotal: number, displayedTotal: number): boolean {
  return fitTotal > 0 && Math.abs(displayedTotal - fitTotal) / fitTotal > 0.005;
}
