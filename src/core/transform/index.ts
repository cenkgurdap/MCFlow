import {
  DEFAULT_COFACTOR,
  DEFAULT_DECADES,
  type AxisTick,
  type Transform,
  type TransformKind,
  type TransformSpec,
} from './types';
import { BiexponentialTransform, estimateWidth, LogicleTransform } from './logicle';
import { HyperlogTransform } from './hyperlog';
import { AsinhTransform } from './asinh';

// decadeLabel lives in ./ticks so the import graph stays acyclic — this module
// imports the transform classes, which import ./ticks.
import { decadeLabel } from './ticks';

export * from './types';
export { estimateWidth, solveD, widthBasisToW } from './logicle';
export { decadeLabel, signedDecadeTicks, splitDecadeLabel, thinLabels } from './ticks';

/* ==========================================================================
   Tick helpers
   ========================================================================== */

/**
 * "Nice" round tick step — 1, 2, 5 or 10 × a power of ten.
 * The classic Heckbert algorithm; ticks land on numbers a reader expects.
 */
export function niceStep(rawStep: number): number {
  if (!(rawStep > 0) || !Number.isFinite(rawStep)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

/** Evenly spaced nice ticks covering [min, max]. */
export function linearTicks(min: number, max: number, target: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || target < 1) return [];
  const step = niceStep((max - min) / target);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  // Guard against pathological step sizes producing an unbounded loop.
  for (let v = start, i = 0; v <= max + step * 1e-9 && i < 1000; v += step, i++) {
    // Re-derive from the index to stop floating-point drift accumulating.
    out.push(Math.round((start + i * step) / step) * step);
  }
  return out;
}

/** The SI prefix an axis is labelled in: none, kilo or mega. */
export type SiPrefix = '' | 'k' | 'M';

/**
 * One prefix for a whole axis, chosen from its largest tick and its step.
 *
 * **Per axis, not per value** (2026-10-22). Choosing the suffix tick by tick
 * labelled one axis `500K, 1M, 1.5M` — three magnitudes in three notations,
 * which is the opposite of readable. Mega once the axis reaches a million and
 * a step can be written in tenths of one; kilo from ten thousand; plain below
 * that, where four digits are shorter than a prefix and a decimal. Lowercase
 * `k`, which is how SI writes kilo.
 */
export function siPrefixFor(values: readonly number[], step: number): SiPrefix {
  let top = 0;
  for (const v of values) if (Math.abs(v) > top) top = Math.abs(v);
  if (top >= 1e6 && step >= 1e5) return 'M';
  if (top >= 1e4 && step >= 100) return 'k';
  return '';
}

const SI_FACTOR: Record<SiPrefix, number> = { '': 1, k: 1e3, M: 1e6 };

/**
 * Format an axis value compactly, in its axis's prefix.
 *
 * Scatter channels on an Aurora run to 4 194 304, which is unreadable in full
 * at tick size, so magnitudes are abbreviated. Small values keep enough decimal
 * places to stay distinguishable from their neighbours, and no trailing zeros.
 * Without a stated prefix the value chooses its own, as a lone label must.
 */
export function formatTick(value: number, step: number, prefix: SiPrefix = siPrefixFor([value], step)): string {
  if (value === 0) return '0';
  const f = SI_FACTOR[prefix];
  return `${trimZeros(value / f, step / f)}${prefix}`;
}

function trimZeros(v: number, step: number): string {
  const decimals = step > 0 && step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  const s = v.toFixed(decimals);
  // Only strip zeros that follow a decimal point — trimming them unconditionally
  // turns 750 into 75 and 50K into 5K.
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '') || '0';
}


/* ==========================================================================
   Linear
   ========================================================================== */

class LinearTransform implements Transform {
  readonly displayDomain: [number, number];
  constructor(readonly spec: TransformSpec) {
    this.displayDomain = [spec.min ?? 0, spec.range || 1];
  }
  forward(v: number): number { return v; }
  inverse(d: number): number { return d; }
  ticks(target: number, view?: readonly [number, number]): AxisTick[] {
    // The range being shown, not the parameter's own. See `Transform.ticks`.
    const [lo, hi] = view && view[1] > view[0] ? view : this.displayDomain;
    const values = linearTicks(lo, hi, target);
    const step = values.length > 1 ? values[1]! - values[0]! : hi - lo;
    // One prefix for the axis — see `siPrefixFor`.
    const prefix = siPrefixFor(values, step);
    return values.map((v) => ({ display: v, value: v, label: formatTick(v, step, prefix) }));
  }
}

/* ==========================================================================
   Logarithmic
   ========================================================================== */

/**
 * Base-10 log over `decades`, mapped to display space [0, decades].
 *
 * Flow data routinely contains zero and negative values after baseline
 * restoration — a fluorescence channel can reach several hundred below zero — which plain
 * log cannot represent. Those values are clamped to the bottom of the axis and
 * pile up there visibly. That pile-up is not a rendering artefact to hide; it
 * is the reason logicle and biexponential exist, and the user should be able to
 * see it and switch.
 */
class LogTransform implements Transform {
  readonly displayDomain: [number, number];
  private readonly decades: number;
  private readonly top: number;

  constructor(readonly spec: TransformSpec) {
    this.decades = spec.decades && spec.decades > 0 ? spec.decades : DEFAULT_DECADES;
    this.top = spec.range > 1 ? spec.range : Math.pow(10, this.decades);
    this.displayDomain = [0, this.decades];
  }

  /** Smallest representable value — the bottom of the visible decades. */
  private get floor(): number {
    return this.top / Math.pow(10, this.decades);
  }

  forward(v: number): number {
    const f = this.floor;
    if (!(v > f)) return 0;
    return this.decades + Math.log10(v / this.top);
  }

  inverse(d: number): number {
    return this.top * Math.pow(10, d - this.decades);
  }

  ticks(): AxisTick[] {
    const out: AxisTick[] = [];
    const topExp = Math.log10(this.top);
    const loExp = Math.ceil(topExp - this.decades);
    for (let e = loExp; e <= Math.floor(topExp); e++) {
      const value = Math.pow(10, e);
      out.push({ display: this.forward(value), value, label: decadeLabel(e) });
      // Minor ticks at 2..9 × 10^e, unlabelled.
      for (let m = 2; m <= 9; m++) {
        const mv = m * value;
        if (mv >= this.top) break;
        out.push({ display: this.forward(mv), value: mv, label: '', minor: true });
      }
    }
    return out;
  }
}

/* ==========================================================================
   Factory
   ========================================================================== */

/** Build a transform for the given specification. */
export function createTransform(spec: TransformSpec): Transform {
  switch (spec.kind) {
    case 'linear':
      return new LinearTransform(spec);
    case 'log':
      return new LogTransform(spec);
    case 'logicle':
      return new LogicleTransform(spec);
    case 'biexponential':
      return new BiexponentialTransform(spec);
    case 'hyperlog':
      return new HyperlogTransform(spec);
    case 'asinh':
      return new AsinhTransform(spec);
    default: {
      // Exhaustiveness guard: an unknown kind still renders as log rather than
      // throwing and blanking the plot.
      const _never: never = spec.kind;
      void _never;
      return new LogTransform({ ...spec, kind: 'log' });
    }
  }
}

export const IMPLEMENTED_TRANSFORMS: TransformKind[] = [
  'linear', 'log', 'biexponential', 'logicle', 'hyperlog', 'asinh',
];

/** Human-readable names, shared by the axis button and the inspector. */
export const TRANSFORM_LABELS: Record<TransformKind, string> = {
  linear: 'Linear',
  log: 'Log',
  biexponential: 'Biexponential',
  logicle: 'Logicle',
  hyperlog: 'Hyperlog',
  asinh: 'Arcsinh',
};

/**
 * Sensible default transform for a parameter.
 *
 * **Scatter and time are linear.** They are bounded, positive and read directly
 * as magnitudes; a log-family axis on FSC-A helps nobody.
 *
 * **Derived parameters are linear too.** The units of an expression are whatever
 * the expression makes them — a ratio lives in [−1, 1] — so there is no
 * fluorescence-like dynamic range to compress.
 *
 * **Everything else is biexponential.** Plain log is simply wrong for real flow
 * data: baseline restoration pushes a meaningful fraction of events below zero
 * (R1-A in the test files reaches −612) and a log axis stacks all of them onto
 * the bottom edge as an uninterpretable line. Between the signed transforms,
 * biexponential is what FlowJo and FCS Express open a fluorescence channel with
 * and therefore what a cytometrist expects to see; logicle, hyperlog and arcsinh
 * remain one click away on the axis. Logicle used to be the default here and its
 * width basis is estimated per channel, which is defensible and is not what
 * anyone was expecting.
 */
export function defaultTransformKind(parameterType: string): TransformKind {
  switch (parameterType) {
    case 'Time':
    case 'Forward_Scatter':
    case 'Side_Scatter':
    case 'Derived':
      return 'linear';
    default:
      return 'biexponential';
  }
}

/**
 * Apply a transform across a whole column.
 *
 * Uses the transform's batch path when it has one. Logicle and hyperlog need a
 * root find per value in the forward direction, which is far too slow to run
 * per event; both instead build a lookup table from their closed-form inverse.
 *
 * Allocates a new array — callers are expected to cache the result.
 */
export function transformColumn(values: Float32Array, transform: Transform): Float32Array {
  if (transform.forwardAll) return transform.forwardAll(values);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = transform.forward(values[i]!);
  return out;
}

/**
 * Pick transform parameters that suit the data.
 *
 * For logicle-family transforms the width of the linear region should reflect
 * the negatives actually present in the channel, which is what makes the
 * difference between a resolved negative population and a smear at the axis.
 */
export function autoSpec(kind: TransformKind, range: number, values?: Float32Array): TransformSpec {
  const base: TransformSpec = { kind, range, decades: DEFAULT_DECADES };
  if (kind === 'logicle' || kind === 'hyperlog') {
    return { ...base, width: values ? estimateWidth(values, range, DEFAULT_DECADES) : 0.5 };
  }
  if (kind === 'biexponential') {
    // Width is a FlowJo width basis here — a negative data value, not decades.
    return { ...base, width: values ? -Math.max(10, Math.abs(percentileNegative(values))) : -10 };
  }
  if (kind === 'asinh') return { ...base, cofactor: DEFAULT_COFACTOR };
  return base;
}

/**
 * 5th percentile of the negative values, or −10 when there is no negative
 * *population* to size the linear region to.
 *
 * "No negative population" is a fraction, not a count. A bare `n < 10` guard
 * left a 111 000-event column with twelve negatives taking `neg[0]` — the single
 * most negative value in the file, which is precisely the stray outlier the
 * percentile exists to step over. An unmixed abundance with a dozen negatives
 * got a width basis four decades below anything else in the column, which made the near-linear region wider
 * than the data.
 *
 * `MIN_NEGATIVE_FRACTION` is what "a population" means here. Below it the
 * negatives are noise on an otherwise positive channel and the honest answer is
 * the minimal linear region, which is what −10 asks for.
 */
const MIN_NEGATIVE_FRACTION = 0.001;

function percentileNegative(values: Float32Array): number {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! < 0) n++;
  if (n < 10 || n < values.length * MIN_NEGATIVE_FRACTION) return -10;
  const neg = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! < 0) neg[k++] = values[i]!;
  neg.sort();
  return neg[Math.floor(n * 0.05)]!;
}
