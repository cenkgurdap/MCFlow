import { Matrix, pseudoInverse, SingularValueDecomposition } from 'ml-matrix';
import type { FcsMetadata, ParsedFcs } from './fcs/types';

/* ==========================================================================
   Spectral unmixing.

   A spectral cytometer records every fluorochrome across all detectors rather
   than isolating one dye per detector, so the measured vector for an event is a
   linear combination of the panel's reference spectra:

       y (1×D)  =  x (1×F) · S (F×D)

   where S holds one normalised reference signature per row. Recovering the
   abundances x is an ordinary least-squares problem, solved once as a
   precomputed pseudo-inverse and then applied as a single matrix multiply over
   every event.

   Autofluorescence is treated as its own row of S — an extra "fluorophore"
   extracted from the unstained control — rather than being subtracted as
   background. On spectral platforms that materially improves resolution of dim
   populations, and it is what the instrument vendors' own software does.
   ========================================================================== */

/**
 * How the positive population behind a signature was chosen.
 *
 * `gated` is the workflow every spectral vendor package and FCS Express use:
 * the operator draws the positive population and can see exactly what went into
 * the reference signature. `percentile` is the automatic 98th-percentile estimate, kept as
 * a starting point rather than a silent default — it is a reasonable guess, but
 * a guess the user could neither see nor correct.
 */
export type SignatureSource = 'gated' | 'percentile';

export interface ReferenceSpectrum {
  id: string;
  /** Display name, e.g. "CD3 PerCP-Cy5.5" or "Autofluorescence". */
  label: string;
  /** Normalised intensity per detector, peak scaled to 1. Length = detector count. */
  values: Float64Array;
  /** True for the autofluorescence reference signature. */
  isAutofluorescence: boolean;
  /** Sample the signature was extracted from. */
  sourceSampleId: string | null;
  /** Events that contributed, for the QC panel. */
  eventCount: number;
  /** How those events were selected. Absent on spectra from before this existed. */
  source?: SignatureSource;
  /** The gate that defined the positive population, when `source` is `gated`. */
  gateId?: string | null;
}

export interface UnmixingSetup {
  /** Parameter indices of the detectors, in matrix column order. */
  detectorIndices: number[];
  detectorNames: string[];
  spectra: ReferenceSpectrum[];
}

export type UnmixMethod = 'ols' | 'wls';

/* -------------------------------------------------------------------------
   Detector selection
   ------------------------------------------------------------------------- */

/**
 * The fluorescence detectors of a sample, in file order.
 *
 * Three rules, each a fallback for the one before, and the order is the order of
 * how much the file is actually telling you:
 *
 * 1. `$PnTYPE=Raw_Fluorescence`, which SpectroFlo writes and which is a
 *    statement rather than an inference.
 * 2. Detector-array naming — `UV1-A`, `B14-A` — for a spectral file whose writer
 *    omits `$PnTYPE`.
 * 3. **Any data channel that is not scatter**, added 2026-08-27 for conventional
 *    files. A FACSDiva export has no `$PnTYPE` at all and names its channels
 *    after the filter they sit behind (`yg-LP600 610/20-C-A`), so the first two
 *    rules find nothing and this function used to answer "no detectors" for
 *    every conventional file in existence. `isDataChannel` already excludes
 *    Time; excluding scatter is the whole of the remaining rule.
 *
 * Rule 3 cannot change what rules 1 and 2 answer — it only runs when they find
 * nothing — so no spectral file moves. What it does change is that "does this
 * sample have detectors" is now a question with a sensible answer for a
 * conventional panel, which is what lets one compensation matrix be validated,
 * applied and saved through the same code a spectral one is.
 */
export function detectorIndices(md: FcsMetadata): number[] {
  const raw = md.parameters
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.type === 'Raw_Fluorescence')
    .map(({ i }) => i);
  if (raw.length > 0) return raw;

  const named = md.parameters
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.isDataChannel && /^(UV|V|B|YG|R|G|O)\d{1,2}(-[AHW])?$/i.test(p.name))
    .map(({ i }) => i);
  if (named.length > 0) return named;

  return md.parameters
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.isDataChannel && p.type !== 'Forward_Scatter' && p.type !== 'Side_Scatter')
    .map(({ i }) => i);
}

/* -------------------------------------------------------------------------
   Signature extraction
   ------------------------------------------------------------------------- */

function medianOf(values: Float64Array): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Value at a quantile, nearest-rank. Clamped, so an empty column cannot throw. */
function quantileOf(values: Float64Array, q: number): number {
  if (values.length === 0) return -Infinity;
  const sorted = Float64Array.from(values).sort();
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[i]!;
}

/**
 * Fraction of a control taken as its positive population by the automatic path.
 *
 * The brightest 20% on the peak detector. Named rather than inlined now that
 * both the automatic extraction and the auto-gate seed have to agree on it — if
 * they disagreed, seeding a gate would silently change the signature.
 */
export const DEFAULT_POSITIVE_FRACTION = 0.2;

/** Percentile used to *choose* the peak detector, not to select events. */
const PEAK_DETECTOR_QUANTILE = 0.98;

/**
 * Floor on the background a fold change is measured against, as a fraction of
 * the **median** background across the panel. See `autoGateBound`'s `baseline`.
 */
const BASELINE_FLOOR_FRACTION = 0.25;

export interface SignatureOptions {
  /**
   * Fraction of the brightest events on the peak detector used to define the
   * positive population. Single-stain controls are a mix of stained and
   * unstained beads or cells, so taking the median of *everything* would
   * blend the two and flatten the signature.
   */
  positiveFraction?: number;
  /** Restrict extraction to these event indices (e.g. a gate). */
  eventSubset?: Uint32Array;
}

/**
 * Extract a normalised reference signature from a control sample.
 *
 * Returns the per-detector median of the positive population, scaled so the
 * peak detector is 1. Median rather than mean: single-stain controls routinely
 * carry a few very bright aggregates that drag a mean off the true peak.
 */
export function extractSignature(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  opts: SignatureOptions = {},
): { values: Float64Array; peakDetector: number; eventsUsed: number } {
  const D = detectors.length;
  const values = new Float64Array(D);
  if (D === 0 || eventCount === 0) return { values, peakDetector: 0, eventsUsed: 0 };

  const subset = opts.eventSubset;
  const nAll = subset ? subset.length : eventCount;
  const at = (det: number, k: number) => data[det * eventCount + (subset ? subset[k]! : k)]!;

  // Pass 1: pick the detector to gate on.
  //
  // Not by median — a single-stain control is mostly *unstained* beads, so the
  // all-event median is dominated by background and points at whichever
  // detector has the highest autofluorescence, not at the dye. A high
  // percentile finds where the stained population actually sits. 98th rather
  // than 99th so a handful of bright aggregates cannot capture the choice.
  let gateDetector = 0;
  let gateBrightness = -Infinity;
  const scratch = new Float64Array(nAll);
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < nAll; k++) scratch[k] = at(detectors[d]!, k);
    const p98 = quantileOf(scratch, PEAK_DETECTOR_QUANTILE);
    if (p98 > gateBrightness) { gateBrightness = p98; gateDetector = d; }
  }

  // Pass 2: the positive population is the brightest slice on that detector.
  const frac = Math.min(0.95, Math.max(0.01, opts.positiveFraction ?? DEFAULT_POSITIVE_FRACTION));
  for (let k = 0; k < nAll; k++) scratch[k] = at(detectors[gateDetector]!, k);
  const sortedGate = Float64Array.from(scratch).sort();
  const threshold = sortedGate[Math.floor(sortedGate.length * (1 - frac))] ?? -Infinity;

  const keep: number[] = [];
  for (let k = 0; k < nAll; k++) if (at(detectors[gateDetector]!, k) >= threshold) keep.push(k);
  const eventsUsed = keep.length;
  if (eventsUsed === 0) return { values, peakDetector: gateDetector, eventsUsed: 0 };

  // Pass 3: per-detector median over the positive population.
  const col = new Float64Array(eventsUsed);
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < eventsUsed; k++) col[k] = at(detectors[d]!, keep[k]!);
    values[d] = medianOf(col);
  }

  // The reported peak is the peak of the *resulting* signature — which is what
  // normalisation divides by — and need not be the detector we gated on.
  let peakDetector = 0;
  let peak = -Infinity;
  for (let d = 0; d < D; d++) if (values[d]! > peak) { peak = values[d]!; peakDetector = d; }

  return { values, peakDetector, eventsUsed };
}

/** Scale a signature so its peak detector reads 1. */
/**
 * Extract a reference signature from an explicitly gated positive population.
 *
 * The difference from `extractSignature` is what selects the events. There, a
 * percentile picks them; here the operator already has, by drawing a gate — so
 * this takes the plain median of every gated event rather than re-selecting a
 * bright fraction inside a population that was chosen precisely because it is
 * the bright one. Applying the percentile twice would bias the signature toward
 * the top of the positive population.
 *
 * Same normalisation and the same median-not-mean reasoning as the percentile
 * path, so the two are directly comparable and the unmixing maths downstream
 * cannot tell them apart.
 */
export function extractGatedSignature(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  gatedEvents: Uint32Array,
): { values: Float64Array; raw: Float64Array; peakDetector: number; eventsUsed: number } {
  const D = detectors.length;
  if (D === 0 || gatedEvents.length === 0) {
    return { values: new Float64Array(D), raw: new Float64Array(D), peakDetector: 0, eventsUsed: 0 };
  }
  /*
     Both scalings are returned, and which one a caller wants is not a matter of
     taste.

     `values` is the signature — peak 1, comparable between a bright dye and a
     dim one, and what the matrix is built from. `raw` is the same medians in
     channel units, and it exists because **a subtraction is only meaningful
     between two spectra on the same scale**. Subtracting one normalised
     spectrum from another normalised spectrum is what this code did until
     2026-08-16: a bead's negative population is 100–230× dimmer than its
     positive one, so scaling it to peak 1 first inflated the background by two
     orders of magnitude and the clamp at zero then flattened 35–55 of the 64
     detectors outright. See `computeMatrix`.
  */
  const raw = populationMedians(data, eventCount, detectors, gatedEvents);
  const values = normaliseSignature(raw);

  let peakDetector = 0;
  for (let d = 1; d < D; d++) if (values[d]! > values[peakDetector]!) peakDetector = d;

  return { values, raw, peakDetector, eventsUsed: gatedEvents.length };
}

/**
 * A starting gate for a single-stain control, in the shape of a rectangle.
 *
 * The 98th-percentile heuristic, surfaced as something the user can see and
 * drag rather than applied invisibly. Returns the peak detector and a bound on
 * it; the caller turns that into a real gate on whatever second axis it is
 * plotting, so the result is an ordinary population the operator can adjust,
 * delete, or ignore.
 *
 * The lower bound is the percentile itself, so the seeded gate captures the
 * same events the automatic path would have used — the two agree on day one and
 * diverge only once someone corrects it, which is the point.
 */
export function autoGateBound(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  opts: {
    positiveFraction?: number;
    eventSubset?: Uint32Array;
    /**
     * The unstained control's own per-detector brightness, from
     * `detectorBrightness` — turning "which detector is brightest" into
     * **"which detector gained the most, relative to what it already carried"**.
     *
     * This is the whole of whether peak detection works on cells. A bead has no
     * autofluorescence, so its brightest channel is its dye's and the absolute
     * rule is right. A stained *cell* is autofluorescent everywhere, and on a
     * real cell reference panel the UV detectors carry an order of magnitude more absolute
     * signal from that background than a far-red dye contributes in its own
     * channel — so the absolute rule put CCR7 APC-Fire 810, CD28 Alexa Fluor
     * 700, LiveDead and NKG2A PerCP-Fire 806 all on **UV7-A**, which is not any
     * of their emission maxima and is not even the right laser.
     *
     * **A ratio, not a difference**, and the distinction is not pedantry: a
     * subtraction is in raw channel units, so a detector whose background is
     * 200 000 wins on a 30% wobble over a detector whose background is 500 and
     * whose stain drives it to 40 000. Fold change over background is
     * dimensionless and is what "this channel is where the dye is" actually
     * means. The denominator is floored at a small fraction of the panel's
     * brightest background, so a channel that is quiet in both files cannot win
     * on a few counts of noise divided by almost nothing.
     *
     * Omit it and the absolute rule applies unchanged, which is what a bead
     * panel wants.
     */
    baseline?: Float64Array;
  } = {},
): { peakDetector: number; parameterIndex: number; threshold: number; eventsAbove: number } | null {
  const D = detectors.length;
  const subset = opts.eventSubset;
  const n = subset ? subset.length : eventCount;
  if (D === 0 || n === 0) return null;

  const fraction = Math.min(0.95, Math.max(0.01, opts.positiveFraction ?? DEFAULT_POSITIVE_FRACTION));
  const at = (det: number, k: number) => data[det * eventCount + (subset ? subset[k]! : k)]!;
  const scratch = new Float64Array(n);
  const baseline = opts.baseline && opts.baseline.length === D ? opts.baseline : null;
  /*
     The floor on the denominator, and it is taken from the **median** background
     rather than the brightest.

     A fraction of the brightest was the first attempt and it inverted the fix.
     One detector in a cell panel carries an order of magnitude more
     autofluorescence than the rest, so 2% of *that* is larger than a far-red
     detector's entire background — every dim channel ended up divided by the
     same large constant, which is the absolute rule again with extra steps, and
     CCR7 APC-Fire 810 stayed on UV7-A. A quarter of the median background is
     comparable to a typical detector's own noise, which is the quantity the
     floor is actually guarding against.
  */
  const floor = baseline ? medianOf(Float64Array.from(baseline)) * BASELINE_FLOOR_FRACTION : 0;

  // Detector choice and threshold both follow `extractSignature` exactly, so a
  // seeded gate captures the same events the automatic path would have used.
  let peakDetector = 0;
  let brightest = -Infinity;
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < n; k++) scratch[k] = at(detectors[d]!, k);
    const raw = quantileOf(scratch, PEAK_DETECTOR_QUANTILE);
    const p = baseline ? (raw - baseline[d]!) / Math.max(baseline[d]!, floor) : raw;
    if (p > brightest) { brightest = p; peakDetector = d; }
  }

  for (let k = 0; k < n; k++) scratch[k] = at(detectors[peakDetector]!, k);
  const threshold = quantileOf(scratch, 1 - fraction);
  let above = 0;
  for (let k = 0; k < n; k++) if (scratch[k]! >= threshold) above++;

  return { peakDetector, parameterIndex: detectors[peakDetector]!, threshold, eventsAbove: above };
}

/**
 * Per-detector brightness, on the same quantile `autoGateBound` chooses by.
 *
 * The unstained control's is what a stain's is measured against. Deliberately
 * the same quantile and the same reduction as the detector choice above rather
 * than a median — a background subtracted at one statistic from a signal
 * measured at another is not a subtraction of anything.
 */
export function detectorBrightness(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  eventSubset?: Uint32Array,
): Float64Array {
  const D = detectors.length;
  const out = new Float64Array(D);
  const n = eventSubset ? eventSubset.length : eventCount;
  if (D === 0 || n === 0) return out;
  const scratch = new Float64Array(n);
  for (let d = 0; d < D; d++) {
    const base = detectors[d]! * eventCount;
    for (let k = 0; k < n; k++) scratch[k] = data[base + (eventSubset ? eventSubset[k]! : k)]!;
    out[d] = quantileOf(scratch, PEAK_DETECTOR_QUANTILE);
  }
  return out;
}

export function normaliseSignature(values: Float64Array): Float64Array {
  let peak = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! > peak) peak = values[i]!;
  const out = new Float64Array(values.length);
  if (peak <= 0) return out;
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / peak;
  return out;
}

/**
 * Extract the autofluorescence reference signature from an unstained control.
 *
 * Unlike a stained control there is no positive population to select, so the
 * median of every event is the right estimate.
 */
export function extractAutofluorescence(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  /**
   * Events to use, e.g. the general cells/singlets gate. The unstained control
   * gets the same debris and doublet exclusion as every other control — an
   * autofluorescence reference signature measured over debris describes the debris.
   */
  eventSubset?: Uint32Array,
): { values: Float64Array; eventsUsed: number } {
  const D = detectors.length;
  const values = new Float64Array(D);
  const n = eventSubset ? eventSubset.length : eventCount;
  if (D === 0 || n === 0) return { values, eventsUsed: 0 };

  const col = new Float64Array(n);
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < n; k++) {
      col[k] = data[detectors[d]! * eventCount + (eventSubset ? eventSubset[k]! : k)]!;
    }
    values[d] = medianOf(col);
  }
  return { values: normaliseSignature(values), eventsUsed: n };
}

/* -------------------------------------------------------------------------
   Similarity
   ------------------------------------------------------------------------- */

/**
 * Cosine similarity between two spectra.
 *
 * This is the "similarity index" spectral instrument vendors report. Two
 * fluorochromes above roughly 0.98 are very hard to separate and the panel
 * probably needs rethinking — which is why this is standard pre-unmixing QC.
 */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

/** Full pairwise similarity matrix, row-major. Diagonal is 1. */
export function similarityMatrix(spectra: ReferenceSpectrum[]): Float64Array {
  const n = spectra.length;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    out[i * n + i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(spectra[i]!.values, spectra[j]!.values);
      out[i * n + j] = s;
      out[j * n + i] = s;
    }
  }
  return out;
}

/** The most-similar pair, for the QC callout. */
export function worstPair(spectra: ReferenceSpectrum[], sim: Float64Array): { a: number; b: number; value: number } | null {
  const n = spectra.length;
  if (n < 2) return null;
  let best = { a: 0, b: 1, value: -1 };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = sim[i * n + j]!;
      if (v > best.value) best = { a: i, b: j, value: v };
    }
  }
  return best;
}

/* -------------------------------------------------------------------------
   Unmixing
   ------------------------------------------------------------------------- */

export class UnmixError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'UnmixError';
  }
}

export interface UnmixResult {
  /** Column-major abundances: fluorophore f occupies [f·N, (f+1)·N). */
  data: Float32Array;
  /** One label per unmixed parameter, in column order. */
  labels: string[];
  eventCount: number;
  method: UnmixMethod;
  /** Condition number of Sᵀ — high values mean an ill-posed panel. */
  conditionNumber: number;
}

/**
 * Build the unmixing operator: the pseudo-inverse P (D×F) such that x = y·P.
 *
 * `pseudoInverse` rather than a plain inverse because a panel can be
 * rank-deficient — two near-identical spectra make SᵀS singular — and an SVD
 * pseudo-inverse degrades gracefully where a direct solve throws.
 */
export function buildUnmixOperator(
  spectra: ReferenceSpectrum[],
  weights?: Float64Array,
): { operator: Matrix; conditionNumber: number } {
  const F = spectra.length;
  if (F === 0) throw new UnmixError('No reference spectra assigned.', 'Assign one single-stain control per fluorophore, plus an unstained control.');
  const D = spectra[0]!.values.length;

  // S is F×D. Weighted least squares scales each detector column by √w, which
  // is equivalent to solving the weighted normal equations.
  const rows: number[][] = spectra.map((s) => {
    const row = new Array<number>(D);
    for (let d = 0; d < D; d++) row[d] = weights ? s.values[d]! * Math.sqrt(weights[d]!) : s.values[d]!;
    return row;
  });
  const S = new Matrix(rows);

  let operator: Matrix;
  try {
    // pinv(S) is D×F and satisfies x = y·pinv(S) for y = x·S.
    operator = pseudoInverse(S.transpose());
  } catch {
    throw new UnmixError(
      'The reference spectra could not be inverted.',
      'Two or more spectra are effectively identical, so the panel is not separable. Check the similarity matrix for a pair above 0.98.',
    );
  }

  // Condition number from the ratio of extreme singular values. A large value
  // means the panel is close to unresolvable and the unmixed result will
  // amplify noise — worth surfacing before the user trusts the output.
  let conditionNumber = Infinity;
  try {
    const svd = new SingularValueDecomposition(S.transpose(), { autoTranspose: true });
    const s = Array.from(svd.diagonal).sort((a, b) => b - a);
    const max = s[0] ?? 0;
    const min = s[s.length - 1] ?? 0;
    conditionNumber = min > 0 ? max / min : Infinity;
  } catch {
    conditionNumber = Infinity;
  }

  return { operator: operator.transpose(), conditionNumber };
}

/**
 * Per-detector weights for weighted least squares.
 *
 * Derived from the unstained control's variance per detector: noisy detectors
 * should contribute less to the fit. Detectors with no measurable spread get a
 * neutral weight rather than an infinite one.
 */
export function detectorWeights(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
): Float64Array {
  const D = detectors.length;
  const w = new Float64Array(D);
  for (let d = 0; d < D; d++) {
    let sum = 0;
    let sumSq = 0;
    for (let k = 0; k < eventCount; k++) {
      const v = data[detectors[d]! * eventCount + k]!;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / eventCount;
    const variance = Math.max(1e-9, sumSq / eventCount - mean * mean);
    w[d] = 1 / variance;
  }
  // Normalise so the weights average to 1; the absolute scale is irrelevant to
  // the solution but keeps the operator numerically comfortable.
  let mean = 0;
  for (let d = 0; d < D; d++) mean += w[d]!;
  mean /= D || 1;
  if (mean > 0) for (let d = 0; d < D; d++) w[d]! /= mean;
  return w;
}

/**
 * Unmix a sample.
 *
 * One matrix multiply over every event: (N×D) · (D×F). The raw spectral matrix
 * is never modified — the caller keeps both, per Section 3.3 of the brief.
 */
export function unmix(
  parsed: ParsedFcs,
  setup: UnmixingSetup,
  method: UnmixMethod = 'ols',
  weights?: Float64Array,
): UnmixResult {
  const N = parsed.metadata.eventCount;
  const D = setup.detectorIndices.length;
  const F = setup.spectra.length;
  // Worded without naming the operation: `core/` is store-free, so this module
  // cannot know whether it is solving for a spectral panel or inverting a
  // square one, and "before unmixing" was wrong on half the callers.
  if (F === 0) throw new UnmixError('No reference spectra assigned.', 'Assign a control for each fluorophore first.');
  if (D === 0) throw new UnmixError('This sample has no fluorescence detector channels.');
  for (const s of setup.spectra) {
    if (s.values.length !== D) {
      throw new UnmixError(
        `Reference spectrum "${s.label}" covers ${s.values.length} detectors but this sample has ${D}.`,
        'Controls and samples must be acquired on the same detector configuration.',
      );
    }
  }

  const { operator, conditionNumber } = buildUnmixOperator(setup.spectra, method === 'wls' ? weights : undefined);

  // operator is D×F; read it into a flat array once for the inner loop.
  const P = new Float64Array(D * F);
  for (let d = 0; d < D; d++) for (let f = 0; f < F; f++) P[d * F + f] = operator.get(d, f);

  const out = new Float32Array(F * N);
  const acc = new Float64Array(F);
  const sqrtW = method === 'wls' && weights ? weights : null;

  for (let e = 0; e < N; e++) {
    acc.fill(0);
    for (let d = 0; d < D; d++) {
      let y = parsed.data[setup.detectorIndices[d]! * N + e]!;
      if (sqrtW) y *= Math.sqrt(sqrtW[d]!);
      if (y === 0) continue;
      const off = d * F;
      for (let f = 0; f < F; f++) acc[f]! += y * P[off + f]!;
    }
    for (let f = 0; f < F; f++) out[f * N + e] = acc[f]!;
  }

  return {
    data: out,
    labels: setup.spectra.map((s) => s.label),
    eventCount: N,
    method,
    conditionNumber,
  };
}

/**
 * Median spectrum of a population, **in channel units**.
 *
 * The unnormalised half of `populationSignature`, split out because two spectra
 * can only be added or subtracted while they are still on the instrument's own
 * scale. Everything that merely *compares shapes* wants the normalised form;
 * everything that does arithmetic between two populations wants this one.
 */
export function populationMedians(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  subset?: Uint32Array,
): Float64Array {
  const D = detectors.length;
  const n = subset ? subset.length : eventCount;
  const out = new Float64Array(D);
  if (n === 0) return out;
  const col = new Float64Array(n);
  for (let d = 0; d < D; d++) {
    for (let k = 0; k < n; k++) col[k] = data[detectors[d]! * eventCount + (subset ? subset[k]! : k)]!;
    out[d] = medianOf(col);
  }
  return out;
}

/**
 * Median spectrum of a population, for the signature viewer.
 * Normalised so shapes from different populations are comparable.
 */
export function populationSignature(
  data: Float32Array,
  eventCount: number,
  detectors: number[],
  subset?: Uint32Array,
): Float64Array {
  return normaliseSignature(populationMedians(data, eventCount, detectors, subset));
}
