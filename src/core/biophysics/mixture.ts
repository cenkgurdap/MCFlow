/**
 * Automatic population detection in a one-dimensional distribution.
 *
 * **This is the one genuinely new piece of numerics the Biophysics pipeline
 * needed.** Everything else it does — scatter gating, histograms, derived
 * parameters, statistics, export — already existed and is reused. Nothing in the
 * application before this could look at a distribution and answer *"how many
 * populations are in here, and where do they divide"*; `autoGateBound` finds one
 * threshold on the assumption that there is a positive population, and
 * `densityInterval` brackets one mode on the assumption that there is exactly
 * one. Both are the right rule for the question they were written for and
 * neither can be asked this one.
 *
 * A membrane-order distribution is the case that needs it. The same cell line on
 * two days can show three resolved populations, two, or one broad smear, and
 * which of those it is *is the result* — so a fixed number of brackets is not a
 * default that is sometimes wrong, it is a claim the data has not been asked
 * about.
 *
 * ## What it does
 *
 * A Gaussian mixture fitted by expectation-maximisation for **k = 1, 2 and 3**,
 * with the Bayesian information criterion choosing between them, subject to two
 * admissibility rules that BIC on its own does not express. The boundaries
 * between the chosen components are the points where the two neighbouring
 * components are equally likely — the Bayes decision boundary — which is the
 * only split that does not systematically hand events to one population.
 *
 * ## Everything here is pure
 *
 * No store, no renderer, no `Sample`. It takes numbers and returns numbers, so
 * the rule can be asserted against synthetic distributions whose answer is known
 * — which is the only way to test a fit at all, since on real data there is
 * nothing to compare the answer to except another opinion. `state/biophysicsStore`
 * is what turns the result into gates.
 *
 * ## Three decisions worth knowing before changing anything
 *
 * 1. **It fits a binned histogram, not the events.** 300 000 events at k = 3 is
 *    900 000 responsibilities per iteration and the fit runs per sample while
 *    somebody waits; 256 bins is 768. The estimator is the same one — a binned
 *    likelihood is the exact likelihood of the binned data — and the cost of the
 *    approximation is bounded by the bin width, which is why `sd` is floored at
 *    one bin: a component narrower than the histogram's own resolution has not
 *    been resolved by it.
 *
 * 2. **Initialisation is deterministic, and there are three of them.** EM finds
 *    a *local* optimum, so where it starts decides what it finds; a random
 *    start would make the same file give different population counts on
 *    different runs, which for a scientific result is not a rough edge but
 *    disqualifying. The usual fix — many random restarts, keep the best — is
 *    therefore not available. What replaces it is three **stated** starts, each
 *    of which is right about a different shape of distribution, with the highest
 *    likelihood winning. See `startsFor`.
 *
 * 3. **BIC is necessary and not sufficient**, and the two extra rules are stated
 *    rather than tuned into the penalty. With enough events BIC will happily
 *    split one skewed population into two Gaussians, because two Gaussians
 *    genuinely do describe a skewed distribution better than one does; and it
 *    will keep a component holding 0.3% of events, because a small improvement
 *    in likelihood still beats a fixed penalty at n = 300 000. Neither of those
 *    is a *population*. See `MIN_COMPONENT_WEIGHT` and `MIN_SEPARATION`.
 */

import { componentPdf, type MixtureComponent } from './components';

// The component type lives with its arithmetic in `components.ts`, re-exported
// so every existing import keeps working.
export type { MixtureComponent } from './components';

/** A fit at one component count. */
export interface MixtureFit {
  /** Components ordered by **descending mean** — see `orderByMean`. */
  components: MixtureComponent[];
  k: number;
  /** Log-likelihood of the binned data under this fit. */
  logLikelihood: number;
  /** Bayesian information criterion; lower is better. */
  bic: number;
  /**
   * The `k − 1` split points, **ascending**, in data units.
   *
   * Ascending while `components` descends is deliberate and is the thing to hold
   * in mind here: `boundaries[i]` is the *lower* edge of `components[i]` and the
   * *upper* edge of `components[i + 1]`. Component 0 is the highest-valued
   * population and runs from `boundaries[0]` to `+∞`.
   */
  boundaries: number[];
  converged: boolean;
  iterations: number;
  /** Events the fit was computed over. */
  total: number;
}

/** Why a candidate fit was refused, for the panel to show. */
export type Rejection = 'weight' | 'separation';

export interface MixtureCandidate {
  fit: MixtureFit;
  /** Absent when the fit is admissible. */
  rejected?: Rejection;
}

export interface MixtureSelection {
  /** The chosen fit. Never null — k = 1 is always admissible. */
  best: MixtureFit;
  /** Every k that was tried, in ascending order, with why each was refused. */
  candidates: MixtureCandidate[];
  /** True when `best` is what BIC alone would have chosen. */
  byBic: boolean;
}

/* -------------------------------------------------------------------------
   The two rules BIC does not express
   ------------------------------------------------------------------------- */

/**
 * The smallest share of the distribution a component may hold and still count.
 *
 * 2%. Below that a "population" is a tail being modelled, and the give-away is
 * that its boundary moves further between two runs of the same experiment than
 * its mean does. It is also the number that stops the fit reporting three
 * populations on a clean unimodal sample: at large n a third component holding
 * 0.4% of events improves the likelihood by more than the BIC penalty costs,
 * every time, because the penalty grows with `log n` and the likelihood grows
 * with `n`.
 *
 * A typical case: a 3-component fit finds a component holding **0.2%** of gated
 * events — a real dead fraction, but not a population an unsupervised fit has
 * resolved, since its own boundary is further from the data than its width.
 * It is refused here. Somebody who wants it says so, on Step 4, which is what
 * the *Populations* override is for.
 *
 * A rejected k does **not** reject the ones above it — a 3-component fit can be
 * admissible where the 2-component fit is not, since EM lands somewhere else
 * entirely — so every candidate is judged on its own.
 */
export const MIN_COMPONENT_WEIGHT = 0.02;

/**
 * How far apart adjacent components must be, in pooled standard deviations.
 *
 * **1.5**, chosen empirically by sweeping thresholds from 1.0 to 2.4 over
 * single- and multi-population samples. The two ends of the range are two
 * different mistakes:
 *
 *   - **Too low** and the fit splits one skewed population in two. A skewed
 *     single population typically puts its best 2-component split near **1.1**
 *     pooled SDs — a boundary drawn through the middle of one peak, with the
 *     smaller "population" holding about 1% of events. Two Gaussians genuinely do
 *     describe a skewed distribution better than one does, so BIC prefers it;
 *     that is exactly the thing BIC cannot be asked.
 *   - **Too high** and a real split is refused. Two genuine, partly overlapping
 *     populations can separate at only **1.7–1.8** pooled SDs, and a threshold
 *     of 1.8 reports one population on them.
 *
 * 1.5 sits between the two with room either side, and it is a geometric
 * statement rather than a fitted number: at 1.5 pooled SDs two components' ±1 SD
 * intervals have stopped overlapping by more than half, which is about where a
 * shoulder becomes something a cytometrist would draw a line through. The
 * textbook alternative is 2.0 — the point at which an equally-weighted
 * two-component mixture becomes genuinely bimodal — and the measurement above is
 * the reason it is not used: a resolvable shoulder is a population, and 2.0
 * refuses it.
 */
export const MIN_SEPARATION = 1.5;

/**
 * The default ceiling on component count.
 *
 * Three, for the **graded** reading — a series of states read off one cell type,
 * where every component is a population and a fourth would be a fourth thing to
 * name.
 */
export const MAX_COMPONENTS = 3;

/**
 * The most components any caller may ask for, whatever ceiling it states.
 *
 * A structural guard rather than a scientific claim, and the distinction is the
 * point: `MAX_COMPONENTS` says what the graded reading is willing to *name*,
 * this says what the fitter will run. The **viability** reading raised its own
 * ceiling to four on 2026-08-21 (see `maxComponentsFor`) because there a
 * component is not a population — a mixture of PBMCs holds several live cell
 * types with genuinely different membrane order, and describing them with one
 * Gaussian each puts the one boundary that matters in a better place than
 * forcing them into two ever did. Four is where that stops buying anything:
 * beyond it EM is fitting the shoulder of the shoulder, and every extra
 * component is another local optimum for three deterministic starts to miss.
 */
export const MAX_FIT_COMPONENTS = 4;

/* -------------------------------------------------------------------------
   Binning
   ------------------------------------------------------------------------- */

export interface Histogram1D {
  /** Bin centres, ascending. */
  centres: Float64Array;
  /** Events in each bin. */
  counts: Float64Array;
  width: number;
  /** Events binned — those inside `[min, max]` and finite. */
  total: number;
  min: number;
  max: number;
}

export interface HistogramOptions {
  min: number;
  max: number;
  bins?: number;
  /**
   * Event indices to include — a gated population.
   *
   * The same shape `densityInterval` takes and for the same reason: the caller
   * already has a `Uint32Array` of gated indices from `maskToIndices`, and
   * copying the values out to a dense array first would allocate a second copy
   * of the population on every fit.
   */
  subset?: Uint32Array | null;
}

/**
 * Default bins. 256 over a fixed −1…1 axis is a bin every 0.0078 of membrane
 * order, which is finer than any real population's spread by two orders of
 * magnitude and coarse enough that a 20 000-event sample still has ~80 events in
 * its modal bin.
 */
export const DEFAULT_BINS = 256;

/**
 * Bin a column over a stated range.
 *
 * Values outside `[min, max]` are **dropped, not clamped**. Clamping would pile
 * every out-of-range event into the first and last bins, which for a ratio
 * parameter bounded at ±1 by construction means anything numerically outside it
 * — a 0/0 from an event with no signal in either channel — lands as a spike the
 * fit would model as a population.
 *
 * `null` when nothing lands in the range, which is a real state and not an
 * error: an empty gate has no distribution, and inventing one for it would be
 * worse than saying so.
 */
export function histogram(values: Float32Array, opts: HistogramOptions): Histogram1D | null {
  const bins = Math.max(8, Math.floor(opts.bins ?? DEFAULT_BINS));
  const { min, max } = opts;
  const span = max - min;
  if (!(span > 0)) return null;

  const counts = new Float64Array(bins);
  const scale = bins / span;
  let total = 0;

  const add = (v: number) => {
    if (!Number.isFinite(v)) return;
    const b = Math.floor((v - min) * scale);
    if (b < 0 || b >= bins) return;
    counts[b]!++;
    total++;
  };
  if (opts.subset) for (let i = 0; i < opts.subset.length; i++) add(values[opts.subset[i]!]!);
  else for (let i = 0; i < values.length; i++) add(values[i]!);

  if (total === 0) return null;

  const width = span / bins;
  const centres = new Float64Array(bins);
  for (let b = 0; b < bins; b++) centres[b] = min + (b + 0.5) * width;

  return { centres, counts, width, total, min, max };
}

/* -------------------------------------------------------------------------
   Expectation-maximisation
   ------------------------------------------------------------------------- */

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function gaussian(x: number, mean: number, sd: number): number {
  const z = (x - mean) / sd;
  return Math.exp(-0.5 * z * z) / (sd * SQRT_2PI);
}

export interface FitOptions {
  maxIterations?: number;
  /** Relative change in log-likelihood below which the fit has settled. */
  tolerance?: number;
}

const DEFAULT_MAX_ITERATIONS = 300;
const DEFAULT_TOLERANCE = 1e-7;

/**
 * The value below which `q` of the binned events lie.
 *
 * Used for initialisation only, so linear interpolation inside the bin is more
 * precision than it needs — but it costs nothing and it stops two components
 * starting in the *same* bin on a distribution whose mass is concentrated, which
 * is a degenerate start EM cannot always escape.
 */
function quantile(h: Histogram1D, q: number): number {
  const want = h.total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let b = 0; b < h.counts.length; b++) {
    const c = h.counts[b]!;
    if (acc + c >= want) {
      const within = c > 0 ? (want - acc) / c : 0.5;
      return h.min + (b + within) * h.width;
    }
    acc += c;
  }
  return h.max;
}

/* -------------------------------------------------------------------------
   Where EM starts, three ways
   ------------------------------------------------------------------------- */

/** One set of starting parameters for EM. */
interface Start {
  means: Float64Array;
  sds: Float64Array;
  weights: Float64Array;
}

/**
 * Weights and spreads implied by assigning every bin to its nearest centre.
 *
 * The hard-assignment counterpart of one EM step, and it is what turns a bare
 * list of starting *positions* into a full starting parameter set. Starting
 * every component at the same width — which is what the original single start
 * did — hands a narrow population and a broad one the same spread, and EM spends
 * its first iterations undoing that rather than separating them.
 */
function partitionFrom(h: Histogram1D, centres: number[], minSd: number): Start {
  const k = centres.length;
  const means = new Float64Array(k);
  const sds = new Float64Array(k);
  const weights = new Float64Array(k);
  const n = new Float64Array(k);
  const sx = new Float64Array(k);
  const sxx = new Float64Array(k);

  for (let b = 0; b < h.counts.length; b++) {
    const w = h.counts[b]!;
    if (w === 0) continue;
    const x = h.centres[b]!;
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < k; c++) {
      const d = Math.abs(x - centres[c]!);
      if (d < bestD) { bestD = d; best = c; }
    }
    n[best] += w;
    sx[best] += w * x;
    sxx[best] += w * x * x;
  }

  for (let c = 0; c < k; c++) {
    const count = n[c]!;
    if (count <= 0) {
      // An empty cluster keeps its seed position and a nominal share. It is not
      // re-seeded, for the same reason a vanished component is not: EM is
      // allowed to report that this distribution has fewer than `k` parts.
      means[c] = centres[c]!;
      sds[c] = minSd;
      weights[c] = 0;
      continue;
    }
    const mean = sx[c]! / count;
    means[c] = mean;
    sds[c] = Math.max(minSd, Math.sqrt(Math.max(0, sxx[c]! / count - mean * mean)));
    weights[c] = count / h.total;
  }
  return { means, sds, weights };
}

/** Evenly spaced quantiles — the original start, and the one that never fails. */
function quantileStart(h: Histogram1D, k: number, minSd: number): Start {
  const centres: number[] = [];
  for (let c = 0; c < k; c++) centres.push(quantile(h, (c + 0.5) / k));
  return partitionFrom(h, centres, minSd);
}

/**
 * Lloyd's algorithm on the binned data, seeded from the quantiles.
 *
 * Cheap — twenty passes over 256 bins — and it is the start that fixes the case
 * where the quantiles land inside one dominant peak because the other population
 * holds 8% of events. k-means moves the centres onto the two clumps before EM
 * ever sees them; from the raw quantile start EM often cannot get there, because
 * the gradient it would have to climb runs through a worse likelihood.
 */
function kMeansStart(h: Histogram1D, k: number, minSd: number): Start {
  let centres: number[] = [];
  for (let c = 0; c < k; c++) centres.push(quantile(h, (c + 0.5) / k));

  for (let iter = 0; iter < 20; iter++) {
    const n = new Float64Array(k);
    const sx = new Float64Array(k);
    for (let b = 0; b < h.counts.length; b++) {
      const w = h.counts[b]!;
      if (w === 0) continue;
      const x = h.centres[b]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = Math.abs(x - centres[c]!);
        if (d < bestD) { bestD = d; best = c; }
      }
      n[best] += w;
      sx[best] += w * x;
    }
    const moved = centres.map((c, i) => (n[i]! > 0 ? sx[i]! / n[i]! : c));
    let shift = 0;
    for (let c = 0; c < k; c++) shift = Math.max(shift, Math.abs(moved[c]! - centres[c]!));
    centres = moved;
    if (shift <= h.width * 1e-3) break;
  }
  return partitionFrom(h, centres, minSd);
}

/**
 * The `k` tallest modes of the smoothed distribution.
 *
 * **The start that matters most on real data**, and the reason is the shape of
 * the problem: a population *is* a mode, so seeding a component on each of the
 * `k` biggest ones asks EM to refine an answer rather than to search for one.
 * The other two starts divide the axis by mass, which is a different question
 * and gets a different answer whenever the populations are unequal in size.
 *
 * Smoothed first, with a box kernel a few bins wide, because raw counts on a
 * 256-bin histogram of 15 000 events have dozens of one-bin local maxima that
 * are sampling noise. `null` when the distribution genuinely has fewer than `k`
 * modes — that is information, and the other starts still run.
 */
function modeStart(h: Histogram1D, k: number, minSd: number): Start | null {
  const bins = h.counts.length;
  const radius = Math.max(1, Math.round(bins / 64));
  const smooth = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    let n = 0;
    for (let j = b - radius; j <= b + radius; j++) {
      if (j < 0 || j >= bins) continue;
      sum += h.counts[j]!;
      n++;
    }
    smooth[b] = n > 0 ? sum / n : 0;
  }

  // A peak is a bin no lower than everything within the kernel's reach and
  // strictly higher than at least one side, so a flat shoulder does not register
  // as a mode and a plateau reports once rather than `2·radius + 1` times.
  const peaks: Array<{ at: number; height: number }> = [];
  for (let b = 0; b < bins; b++) {
    const v = smooth[b]!;
    if (v <= 0) continue;
    let dominates = true;
    let strict = false;
    for (let j = b - radius; j <= b + radius; j++) {
      if (j < 0 || j >= bins || j === b) continue;
      if (smooth[j]! > v) { dominates = false; break; }
      if (smooth[j]! < v) strict = true;
    }
    if (dominates && strict) peaks.push({ at: h.centres[b]!, height: v });
  }
  if (peaks.length < k) return null;

  const chosen = [...peaks]
    .sort((a, b) => b.height - a.height)
    .slice(0, k)
    .map((p) => p.at)
    .sort((a, b) => a - b);
  return partitionFrom(h, chosen, minSd);
}

/**
 * Every start EM will be run from, in a fixed order.
 *
 * Fixed order and a fixed set: the result is whichever of them reaches the
 * highest likelihood, and ties go to the earlier one, so the whole procedure is
 * a pure function of the histogram. That is the property that matters — see the
 * note at the top of the file about why random restarts are not an option here.
 */
function startsFor(h: Histogram1D, k: number, minSd: number): Start[] {
  if (k <= 1) return [quantileStart(h, 1, minSd)];
  const modes = modeStart(h, k, minSd);
  return modes ? [quantileStart(h, k, minSd), kMeansStart(h, k, minSd), modes]
    : [quantileStart(h, k, minSd), kMeansStart(h, k, minSd)];
}

/**
 * Fit `k` Gaussians to a binned distribution by expectation-maximisation.
 *
 * **Every start in `startsFor` is run, and the highest likelihood wins.** EM
 * converges to a local optimum, and on a distribution with an unequal split the
 * optimum it reaches from a quantile seed is routinely not the best one
 * available; running the three stated starts is the deterministic form of the
 * usual many-random-restarts fix. Ties go to the earlier start, which keeps the
 * whole thing a pure function of the histogram.
 *
 * Inside one run the estimator is the standard one over weighted points, where
 * the weights are the bin counts and the points are the bin centres. Two details
 * are not standard and both are about not producing a fit that is arithmetically
 * fine and scientifically meaningless:
 *
 *   - **`sd` is floored at one bin width.** Without a floor, a component that
 *     lands on a single tall bin collapses towards zero variance and its
 *     likelihood diverges — the classic unbounded-likelihood failure of Gaussian
 *     mixtures, which on real data presents as one "population" one bin wide
 *     holding 0.1% of events and a suspiciously excellent BIC.
 *   - **A component whose weight reaches zero is left where it is** rather than
 *     re-seeded. A vanished component is information: it is EM saying this
 *     distribution does not have `k` parts, and `MIN_COMPONENT_WEIGHT` is what
 *     reads that off. Restarting it would hide the answer.
 */
export function fitMixture(h: Histogram1D, k: number, opts: FitOptions = {}): MixtureFit {
  const minSd = Math.max(h.width, (h.max - h.min) * 1e-4);
  let best: MixtureFit | null = null;
  for (const start of startsFor(h, k, minSd)) {
    const fit = fitMixtureFrom(h, k, start, minSd, opts);
    // Strictly greater, so the first start wins a tie and the order in
    // `startsFor` is the tie-break rather than floating-point luck.
    if (!best || fit.logLikelihood > best.logLikelihood) best = fit;
  }
  return best!;
}

/** One EM run, from one stated start. See `fitMixture`. */
function fitMixtureFrom(
  h: Histogram1D,
  k: number,
  start: Start,
  minSd: number,
  opts: FitOptions,
): MixtureFit {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const bins = h.counts.length;

  // Copied, so a start can be handed to more than one run and so the arrays the
  // caller built are never written through.
  const means = Float64Array.from(start.means);
  const sds = Float64Array.from(start.sds);
  const weights = Float64Array.from(start.weights);
  // A start that left a cluster empty would otherwise begin with a component
  // that can never gain responsibility, since its weight multiplies into every
  // posterior. A floor lets EM decide, which is the whole point of not
  // re-seeding it.
  for (let c = 0; c < k; c++) {
    if (!(weights[c]! > 0)) weights[c] = 1e-6;
    if (!(sds[c]! >= minSd)) sds[c] = minSd;
  }

  const resp = new Float64Array(bins * k);
  let logL = -Infinity;
  let converged = false;
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    /* ---- E step, and the likelihood falls out of it ---- */
    let nextLogL = 0;
    for (let b = 0; b < bins; b++) {
      const n = h.counts[b]!;
      if (n === 0) continue;
      const x = h.centres[b]!;
      let sum = 0;
      for (let c = 0; c < k; c++) {
        const p = weights[c]! * gaussian(x, means[c]!, sds[c]!);
        resp[b * k + c] = p;
        sum += p;
      }
      if (sum > 0) {
        for (let c = 0; c < k; c++) resp[b * k + c] = resp[b * k + c]! / sum;
        // × width, so this is the probability of the *bin* rather than a density
        // — a constant offset across every k, but one that makes the number a
        // log-likelihood rather than a log-density and the BIC comparable with
        // one computed any other way.
        nextLogL += n * Math.log(sum * h.width);
      } else {
        // Numerically unreachable under every component at once: spread the
        // responsibility evenly rather than dividing by zero. The bin then pulls
        // every component towards it, which is the behaviour that recovers.
        for (let c = 0; c < k; c++) resp[b * k + c] = 1 / k;
        nextLogL += n * Math.log(Number.MIN_VALUE);
      }
    }

    if (Number.isFinite(logL) && Math.abs(nextLogL - logL) <= tolerance * Math.abs(logL)) {
      logL = nextLogL;
      converged = true;
      iterations++;
      break;
    }
    logL = nextLogL;

    /* ---- M step ---- */
    for (let c = 0; c < k; c++) {
      let n = 0;
      let sx = 0;
      for (let b = 0; b < bins; b++) {
        const w = h.counts[b]! * resp[b * k + c]!;
        n += w;
        sx += w * h.centres[b]!;
      }
      if (n <= 0) { weights[c] = 0; continue; }
      const mean = sx / n;
      let sv = 0;
      for (let b = 0; b < bins; b++) {
        const d = h.centres[b]! - mean;
        sv += h.counts[b]! * resp[b * k + c]! * d * d;
      }
      weights[c] = n / h.total;
      means[c] = mean;
      sds[c] = Math.max(minSd, Math.sqrt(sv / n));
    }
  }

  const components: MixtureComponent[] = [];
  for (let c = 0; c < k; c++) {
    components.push({ weight: weights[c]!, mean: means[c]!, sd: sds[c]! });
  }
  orderByMean(components);

  /*
     Free parameters: k means, k standard deviations, and k − 1 weights, since
     the last one is fixed by the others summing to one. The count is what makes
     the penalty grow with k, and getting it wrong by one is the difference
     between this criterion and no criterion at all.
  */
  const params = 3 * k - 1;
  const bic = -2 * logL + params * Math.log(h.total);

  return {
    components,
    k,
    logLikelihood: logL,
    bic,
    boundaries: boundariesFor(components),
    converged,
    iterations,
    total: h.total,
  };
}

/**
 * Highest mean first.
 *
 * The order is the interpretation. A membrane-order distribution reads from
 * ordered to disordered — most ordered is the intact live cell, least ordered is
 * the dead one — so component 0 being the highest-valued population is what lets
 * the naming rule be a straight index into a list of labels rather than a
 * per-property comparison. See `core/biophysics/properties.ts`.
 *
 * Sorted in place; the array is built here and handed out once.
 */
export function orderByMean(components: MixtureComponent[]): void {
  components.sort((a, b) => b.mean - a.mean);
}

/* -------------------------------------------------------------------------
   Boundaries
   ------------------------------------------------------------------------- */

/**
 * Where two adjacent components are equally likely.
 *
 * The Bayes decision boundary: the point at which an event is as likely to have
 * come from one component as from the other, weights included. That is the split
 * that minimises misassignment, and it is *not* the midpoint — a broad
 * population sitting beside a tight one claims more of the space between them,
 * which is exactly right and is what a hand-drawn bracket does by eye.
 *
 * Setting `w₁·φ₁(x) = w₂·φ₂(x)` and taking logs gives a quadratic in `x`. Two
 * cases have to be handled and both occur on real data:
 *
 *   - **Equal spreads** collapse the quadratic term and the boundary is the one
 *     root of a linear equation. Tested for by magnitude rather than by
 *     equality, since two independently fitted SDs are never exactly equal.
 *   - **Very unequal spreads** give two roots, one of them outside the interval
 *     between the means — the far side, where a wide flat component overtakes a
 *     narrow tall one again. Only the root *between* the means is a boundary;
 *     the other is real and is not a population edge.
 *
 * When neither root lies between the means — possible when one component's
 * weight is small enough that it never dominates anywhere — the fallback is the
 * point dividing the gap in proportion to the two spreads, which is the same
 * answer the quadratic gives in the equal-weight case and degrades gracefully.
 */
export function boundaryBetween(lower: MixtureComponent, upper: MixtureComponent): number {
  return gaussianBoundary(lower, upper);
}

/** The closed-form Bayes boundary between two Gaussians — see `boundaryBetween`. */
function gaussianBoundary(lower: MixtureComponent, upper: MixtureComponent): number {
  const a = lower;
  const b = upper;
  const va = a.sd * a.sd;
  const vb = b.sd * b.sd;
  const A = 1 / (2 * va);
  const B = 1 / (2 * vb);

  const fallback = a.mean + ((b.mean - a.mean) * a.sd) / (a.sd + b.sd || 1);
  const wa = Math.max(a.weight, Number.MIN_VALUE);
  const wb = Math.max(b.weight, Number.MIN_VALUE);
  const c = Math.log(wa / a.sd) - Math.log(wb / b.sd);

  const q2 = B - A;
  const q1 = 2 * (A * a.mean - B * b.mean);
  const q0 = B * b.mean * b.mean - A * a.mean * a.mean + c;

  const lo = Math.min(a.mean, b.mean);
  const hi = Math.max(a.mean, b.mean);
  const inGap = (x: number) => Number.isFinite(x) && x >= lo && x <= hi;

  // Scaled against the linear term, so "the spreads are equal" is judged
  // relative to the equation rather than against an absolute epsilon that would
  // mean something different on a ±1 ratio and on a 4.2M channel.
  if (Math.abs(q2) <= 1e-12 * (Math.abs(q1) + 1)) {
    if (Math.abs(q1) <= Number.MIN_VALUE) return fallback;
    const x = -q0 / q1;
    return inGap(x) ? x : fallback;
  }

  const disc = q1 * q1 - 4 * q2 * q0;
  if (disc < 0) return fallback;
  const root = Math.sqrt(disc);
  const x1 = (-q1 + root) / (2 * q2);
  const x2 = (-q1 - root) / (2 * q2);
  if (inGap(x1)) return x1;
  if (inGap(x2)) return x2;
  return fallback;
}

/** Every split point of a fit, ascending. See `MixtureFit.boundaries`. */
export function boundariesFor(components: readonly MixtureComponent[]): number[] {
  const out: number[] = [];
  // `components` descends, so walking it backwards walks the boundaries upwards.
  for (let i = components.length - 1; i > 0; i--) {
    out.push(boundaryBetween(components[i]!, components[i - 1]!));
  }
  return out;
}

/* -------------------------------------------------------------------------
   Model selection
   ------------------------------------------------------------------------- */

/** Separation of two components, in pooled standard deviations. */
export function separation(a: MixtureComponent, b: MixtureComponent): number {
  const pooled = Math.sqrt((a.sd * a.sd + b.sd * b.sd) / 2);
  if (!(pooled > 0)) return Infinity;
  return Math.abs(a.mean - b.mean) / pooled;
}

export interface SelectionOptions extends FitOptions {
  maxComponents?: number;
  /**
   * The fewest components to consider. One by default.
   *
   * Two under the **viability** scheme, and it is not a tuning choice: that
   * reading is live-against-dead, and a one-component fit has no boundary, so it
   * cannot express the answer at all. Left at one, a single-population sample —
   * whose components typically separate at 1.0–1.4 pooled SDs, under
   * `MIN_SEPARATION` — is read as one population, and comes back with a *Live*
   * gate, no *Dead* gate and
   * nothing for Step 5 to hang a cell type under.
   *
   * The admissibility rules are what that floor overrides, and it is the same
   * override `fitFixed` makes for a count somebody typed: the rules exist to
   * keep an *automatic* choice from claiming structure it cannot see, not to
   * refuse a split the reading is defined by. Which is why the floor is stated
   * by the caller rather than assumed here.
   */
  minComponents?: number;
  minWeight?: number;
  minSeparation?: number;
  /**
   * The fitter to run at each count — `fitMixture` unless stated.
   */
  fit?: (h: Histogram1D, k: number, opts: FitOptions) => MixtureFit;
}

/** Why this fit cannot be believed, or `undefined` if it can. */
export function rejectionFor(fit: MixtureFit, opts: SelectionOptions = {}): Rejection | undefined {
  const minWeight = opts.minWeight ?? MIN_COMPONENT_WEIGHT;
  const minSeparation = opts.minSeparation ?? MIN_SEPARATION;
  // k = 1 has no weight to be small — the one component holds everything — and
  // nothing to be separated from, so it is admissible by construction. That is
  // what makes `select` total: there is always an answer.
  if (fit.k <= 1) return undefined;
  if (fit.components.some((c) => c.weight < minWeight)) return 'weight';
  for (let i = 1; i < fit.components.length; i++) {
    if (separation(fit.components[i - 1]!, fit.components[i]!) < minSeparation) return 'separation';
  }
  return undefined;
}

/**
 * Fit every allowed component count and choose between them.
 *
 * The chosen fit is the **admissible** one with the lowest BIC. `byBic` records
 * whether that is also the lowest BIC overall, so the panel can say *"BIC
 * preferred three; two of them were 1.2 SDs apart"* rather than presenting a
 * number with no account of itself — the same reasoning as the wizard's *Next*
 * button stating why it is disabled.
 *
 * Ties go to the **smaller** k. A tie means the extra component bought nothing
 * measurable, and the smaller model is the one that claims less.
 *
 * When every candidate is rejected the answer is the smallest one considered —
 * `minComponents`, which is 1 by default and 2 for a reading that is defined by
 * having a split. There is always an answer.
 */
export function selectMixture(h: Histogram1D, opts: SelectionOptions = {}): MixtureSelection {
  const maxK = Math.max(1, Math.min(MAX_FIT_COMPONENTS, opts.maxComponents ?? MAX_COMPONENTS));
  const minK = Math.max(1, Math.min(maxK, Math.floor(opts.minComponents ?? 1)));
  const candidates: MixtureCandidate[] = [];
  const fitAt = opts.fit ?? fitMixture;
  for (let k = minK; k <= maxK; k++) {
    const fit = fitAt(h, k, opts);
    candidates.push({ fit, rejected: rejectionFor(fit, opts) });
  }

  const better = (a: MixtureFit, b: MixtureFit) => a.bic < b.bic - 1e-9 || (a.bic <= b.bic + 1e-9 && a.k < b.k);

  let best = candidates[0]!.fit;
  for (const c of candidates) {
    if (c.rejected) continue;
    if (better(c.fit, best)) best = c.fit;
  }
  let bicBest = candidates[0]!.fit;
  for (const c of candidates) if (better(c.fit, bicBest)) bicBest = c.fit;

  return { best, candidates, byBic: bicBest.k === best.k };
}

/**
 * Fit a fixed number of components, bypassing the model selection.
 *
 * What the *Populations* override on Step 4 calls. It is a separate entry point
 * rather than a flag on `selectMixture` because it means something different: the
 * user has stated the count, so the admissibility rules do not apply — they exist
 * to keep the *automatic* choice honest, and applying them to a stated one would
 * mean typing 3 and silently getting 2.
 */
export function fitFixed(h: Histogram1D, k: number, opts: FitOptions = {}): MixtureFit {
  return fitMixture(h, Math.max(1, Math.min(MAX_FIT_COMPONENTS, Math.round(k))), opts);
}

/* -------------------------------------------------------------------------
   Reading a fit back
   ------------------------------------------------------------------------- */

/**
 * The mixture density at `x`, for drawing the fitted curve over a histogram.
 *
 * In events-per-unit rather than probability-per-unit, so the curve and the bars
 * are on one vertical scale: multiply by the total and by the bin width and the
 * result is *the number of events this fit expects in a bin at x*, which is what
 * the histogram bar beside it is showing. A curve normalised to its own peak
 * would sit on the distribution convincingly and say nothing about whether the
 * fit is any good, which is the one thing the overlay exists to show.
 */
export function densityAt(fit: MixtureFit, x: number, binWidth: number): number {
  let sum = 0;
  for (const c of fit.components) sum += c.weight * componentPdf(c, x);
  return sum * fit.total * binWidth;
}

/** One component's own contribution at `x`, on the same scale. */
export function componentDensityAt(
  fit: MixtureFit,
  index: number,
  x: number,
  binWidth: number,
): number {
  const c = fit.components[index];
  if (!c) return 0;
  return c.weight * componentPdf(c, x) * fit.total * binWidth;
}

/**
 * The half-open interval each component owns, ordered like `components`.
 *
 * The ends are infinite rather than clamped to the data's range, and that is the
 * same decision `seedGates` makes for a positive bracket: a population's gate
 * has one boundary the fit computed and one that is "everything beyond", and
 * inventing a far edge from the observed extent would make the gate exclude the
 * next sample's outliers for no stated reason.
 */
export function intervalsFor(fit: MixtureFit): Array<{ min: number; max: number }> {
  const b = fit.boundaries;
  return fit.components.map((_, i) => ({
    // `boundaries` ascends while `components` descends, so component i's lower
    // edge is the boundary at the mirrored index.
    min: i < b.length ? b[b.length - 1 - i]! : Number.NEGATIVE_INFINITY,
    max: i > 0 ? b[b.length - i]! : Number.POSITIVE_INFINITY,
  }));
}

/** What each population actually holds, once the boundaries are where they are. */
export interface PopulationStat {
  /** Binned events inside this population's interval. */
  count: number;
  /** That count as a fraction of everything binned. */
  share: number;
  /** Mean of the property over those events, or `NaN` for an empty population. */
  mean: number;
}

/**
 * What the data does, per population, for the boundaries as they now stand.
 *
 * **Not the component weight and not the component mean**, and the difference is
 * the whole reason this exists. Those two are what the *model* says; these are
 * what the *events* do once the splits are drawn, and the two always disagree
 * where populations overlap — a component holding 30% of the mixture can own 34%
 * of the events, because it takes the part of its neighbour that fell on its
 * side of the line. The gates count events, so these are the numbers that match
 * what the gate reports and what Statistics will report, and showing a fitted
 * parameter beside a gate saying something else is one fact described two ways.
 *
 * It is also what makes a boundary drag legible: `MixtureFit.components` does
 * not move when a split moves, so a panel reading the fit showed a frozen
 * percentage and a frozen mean under a line the operator was dragging.
 *
 * Computed from the binned distribution rather than the raw values, which costs
 * one pass over 256 bins instead of one over a hundred thousand events — cheap
 * enough to run on every pointer move — and is the same reduction the shares
 * have always used, so the two cannot drift apart.
 */
export function populationStats(h: Histogram1D, fit: MixtureFit): PopulationStat[] {
  return statsOverIntervals(h, intervalsFor(fit));
}

/**
 * The same reduction over intervals somebody else decided.
 *
 * Split out because a component is not always a population. The viability
 * reading fits up to four components and gates **two** — everything above the
 * lowest split is live — so its shares have to be counted over the two intervals
 * the gates actually hold, not over the four the fit produced. See
 * `populationIntervals` in `properties.ts`, which is what supplies them.
 */
export function statsOverIntervals(
  h: Histogram1D,
  intervals: ReadonlyArray<{ min: number; max: number }>,
): PopulationStat[] {
  const counts = intervals.map(() => 0);
  const sums = intervals.map(() => 0);
  for (let b = 0; b < h.counts.length; b++) {
    const n = h.counts[b]!;
    if (n === 0) continue;
    const x = h.centres[b]!;
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i]!;
      if (x >= iv.min && x < iv.max) { counts[i] += n; sums[i] += n * x; break; }
    }
  }
  return counts.map((c, i) => ({
    count: c,
    share: h.total > 0 ? c / h.total : 0,
    mean: c > 0 ? sums[i]! / c : Number.NaN,
  }));
}

/**
 * The share of binned events actually falling in each component's interval.
 *
 * The half of `populationStats` that predates it, kept because most callers want
 * only this and a `.map` at every one of them says less than a name does.
 */
export function empiricalShares(h: Histogram1D, fit: MixtureFit): number[] {
  return populationStats(h, fit).map((s) => s.share);
}
