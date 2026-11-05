import { signedDecadeTicks, thinLabels } from './ticks';
import type { AxisTick, Transform, TransformSpec } from './types';

/* ==========================================================================
   Logicle / biexponential

   Implementation follows Moore WA & Parks DR, "Update for the logicle data
   scale including operational code implementations", Cytometry A 2012;
   81A:273-277 — the same algorithm GatingML 2.0 specifies and that flowCore
   and FlowKit implement.

   The transform is *defined* as the inverse of a biexponential

       B(y) = a·e^(b·y) − c·e^(−d·y) − f

   so `inverse` (display → value) is closed form and cheap, while `forward`
   (value → display) needs a root find. That asymmetry drives two decisions
   here: forward uses Halley iteration with a Taylor series near data zero, and
   `forwardAll` builds a lookup table from the cheap direction instead of
   iterating once per event.
   ========================================================================== */

const TAYLOR_LENGTH = 16;
const EPSILON = Number.EPSILON;

export interface LogicleParams {
  T: number; W: number; M: number; A: number;
  a: number; b: number; c: number; d: number; f: number;
  w: number; x0: number; x1: number; x2: number;
  xTaylor: number;
  taylor: Float64Array;
}

/**
 * Solve the logicle condition for `d`.
 *
 * Finds the root of `2·(ln d − ln b) + w·(b + d) = 0` on (0, b], which is what
 * makes the two exponential arms join smoothly at data zero. Newton's method
 * safeguarded by bisection — Newton alone escapes the bracket near w → 0.
 */
export function solveD(b: number, w: number): number {
  // w == 0 degenerates to a pure arcsinh-like scale with d == b.
  if (w === 0) return b;

  const tolerance = 2 * b * EPSILON;
  let dLo = 0;
  let dHi = b;
  let d = (dLo + dHi) / 2;
  let lastDelta = dHi - dLo;

  const fb = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * d + fb;

  for (let i = 0; i < 60; i++) {
    const df = 2 / d + w;
    let delta: number;

    if (
      ((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 ||
      Math.abs(1.9 * f) > Math.abs(lastDelta * df)
    ) {
      // Newton would leave the bracket or is converging too slowly.
      delta = (dHi - dLo) / 2;
      d = dLo + delta;
      // Compare against the bracket's low end, not the previous d. The first
      // iteration starts at the midpoint, so comparing against the previous
      // value exits immediately having done nothing.
      if (d === dLo) return d;
    } else {
      delta = f / df;
      const prev = d;
      d -= delta;
      if (d === prev) return d;
    }

    if (Math.abs(delta) < tolerance) return d;
    lastDelta = delta;

    f = 2 * Math.log(d) + w * d + fb;
    if (f === 0) return d;
    if (f < 0) dLo = d;
    else dHi = d;
  }
  // Best effort rather than throwing: an axis that is slightly off beats a plot
  // that refuses to draw.
  return d;
}

export function initLogicle(T: number, W: number, M: number, A: number): LogicleParams {
  const w = W / (M + A);
  const x2 = A / (M + A);
  const x1 = x2 + w;
  const x0 = x2 + 2 * w;
  const b = (M + A) * Math.LN10;
  const d = solveD(b, w);

  const ca = Math.exp(x0 * (b + d));
  const mfa = Math.exp(b * x1) - ca / Math.exp(d * x1);
  const a = T / (Math.exp(b) - mfa - ca / Math.exp(d));
  const c = ca * a;
  const f = -mfa * a;

  // Near data zero the two exponential arms nearly cancel, so the closed form
  // loses most of its significant digits. A Taylor series about x1 is used
  // instead inside a narrow window.
  const xTaylor = x1 + w / 4;
  const taylor = new Float64Array(TAYLOR_LENGTH);
  let posCoef = a * Math.exp(b * x1);
  let negCoef = -c / Math.exp(d * x1);
  for (let i = 0; i < TAYLOR_LENGTH; i++) {
    posCoef *= b / (i + 1);
    negCoef *= -d / (i + 1);
    taylor[i] = posCoef + negCoef;
  }
  // Identically zero by the logicle condition; setting it explicitly avoids
  // accumulating round-off into the series.
  taylor[1] = 0;

  return { T, W, M, A, a, b, c, d, f, w, x0, x1, x2, xTaylor, taylor };
}

function seriesBiexponential(p: LogicleParams, scale: number): number {
  const x = scale - p.x1;
  let sum = p.taylor[TAYLOR_LENGTH - 1]! * x;
  for (let i = TAYLOR_LENGTH - 2; i >= 2; i--) sum = (sum + p.taylor[i]!) * x;
  return (sum * x + p.taylor[0]!) * x;
}

/** Display → value. Closed form, exact. */
export function logicleInverse(p: LogicleParams, scale: number): number {
  // The scale is symmetric about data zero (x1); negatives are reflected.
  const negative = scale < p.x1;
  const s = negative ? 2 * p.x1 - scale : scale;

  const value =
    s < p.xTaylor
      ? seriesBiexponential(p, s)
      : p.a * Math.exp(p.b * s) + p.f - p.c / Math.exp(p.d * s);

  return negative ? -value : value;
}

/** Value → display. Halley iteration; cubic convergence, typically 3-4 steps. */
export function logicleForward(p: LogicleParams, value: number): number {
  if (value === 0) return p.x1;

  const negative = value < 0;
  const v = negative ? -value : value;

  let x =
    v < p.f
      ? p.x1 + v / p.taylor[0]!            // quasi-linear region near zero
      : Math.log(v / p.a) / p.b;           // ordinary logarithm elsewhere

  const tolerance = x > 1 ? 3 * x * EPSILON : 3 * EPSILON;

  for (let i = 0; i < 40; i++) {
    const ae2bx = p.a * Math.exp(p.b * x);
    const ce2mdx = p.c / Math.exp(p.d * x);

    const y =
      x < p.xTaylor
        ? seriesBiexponential(p, x) - v
        : ae2bx + p.f - (ce2mdx + v);

    const abe2bx = p.b * ae2bx;
    const cde2mdx = p.d * ce2mdx;
    const dy = abe2bx + cde2mdx;
    const ddy = p.b * abe2bx - p.d * cde2mdx;

    if (dy === 0) break;
    const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
    if (!Number.isFinite(delta)) break;
    x -= delta;

    if (Math.abs(delta) < tolerance) break;
  }

  return negative ? 2 * p.x1 - x : x;
}

/**
 * Convert a FlowJo biexponential width basis into a logicle `W`.
 *
 * FlowJo parameterises the near-zero linear region by the negative data value
 * it should reach (a negative number such as −10 or −500) rather than by
 * decades. This is the standard conversion, matching flowCore's
 * `estimateLogicle`.
 */
export function widthBasisToW(widthBasis: number, T: number, M: number): number {
  const r = Math.abs(widthBasis);
  if (!(r > 0) || !(T > 0)) return 0.5;
  const W = (M - Math.log10(T / r)) / 2;
  // Out-of-range W produces a non-monotonic scale, so clamp into the legal band.
  return Math.min(M / 2, Math.max(0, W));
}

/**
 * Estimate a width basis from the data's negative tail.
 *
 * The whole purpose of logicle is to resolve events that baseline restoration
 * pushed below zero, so the linear region should be sized to the negatives that
 * are actually present. Uses a low percentile rather than the minimum, which
 * would be dominated by a single outlier.
 */
export function estimateWidth(values: Float32Array, T: number, M: number): number {
  let negCount = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! < 0) negCount++;
  /*
     A handful of negatives in a large column is noise, not a population, and
     `negatives[floor(n * 0.05)]` on twelve of them is `negatives[0]` — the
     single most negative value in the file, which is the outlier the percentile
     is here to step over. Same rule and same constant as `percentileNegative`;
     see the note there for the column that produced it.
  */
  if (negCount < values.length * 0.001) return 0.5;
  // Nothing below zero: a minimal linear region keeps the axis close to log.
  if (negCount < 10) return 0.5;

  const negatives = new Float64Array(negCount);
  let k = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! < 0) negatives[k++] = values[i]!;
  negatives.sort();

  // 5th percentile of the negative values — deep enough to matter, shallow
  // enough to ignore a stray outlier.
  const r = negatives[Math.floor(negCount * 0.05)]!;
  return widthBasisToW(r, T, M);
}

/* ==========================================================================
   Transform implementations
   ========================================================================== */

abstract class BiexponentialBase implements Transform {
  protected readonly p: LogicleParams;
  readonly displayDomain: [number, number] = [0, 1];

  constructor(readonly spec: TransformSpec, W: number, M: number, A: number) {
    const T = spec.range > 0 ? spec.range : 262144;
    // Guard the legal parameter band: W ∈ [0, M/2], A ∈ [−W, M − 2W].
    const safeW = Math.min(M / 2, Math.max(0, W));
    const safeA = Math.min(M - 2 * safeW, Math.max(-safeW, A));
    this.p = initLogicle(T, safeW, M, safeA);
  }

  forward(value: number): number {
    return logicleForward(this.p, value);
  }

  inverse(display: number): number {
    return logicleInverse(this.p, display);
  }

  /**
   * Batch forward transform via a lookup table.
   *
   * `forward` costs a Halley iteration with two `exp` calls per step; running
   * that per event over 170 000 rows is measurable. The inverse direction is
   * closed form, so a monotonic table is built from it once and searched by
   * bisection — no transcendental calls in the hot loop.
   */
  forwardAll(values: Float32Array): Float32Array {
    const N = 8192;
    const [lo, hi] = this.displayDomain;
    const disp = new Float64Array(N);
    const val = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const s = lo + ((hi - lo) * i) / (N - 1);
      disp[i] = s;
      val[i] = logicleInverse(this.p, s);
    }

    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v)) { out[i] = lo; continue; }
      // Outside the table, iterate exactly rather than clamping to the edge.
      // Clamping would pile off-scale events onto the axis boundary — the very
      // artefact these transforms exist to avoid — and would silently disagree
      // with forward(), which extrapolates.
      if (v <= val[0]!) { out[i] = logicleForward(this.p, v); continue; }
      if (v >= val[N - 1]!) { out[i] = logicleForward(this.p, v); continue; }
      let a = 0;
      let b = N - 1;
      while (b - a > 1) {
        const m = (a + b) >> 1;
        if (val[m]! <= v) a = m;
        else b = m;
      }
      const span = val[b]! - val[a]!;
      const t = span > 0 ? (v - val[a]!) / span : 0;
      out[i] = disp[a]! + t * (disp[b]! - disp[a]!);
    }
    return out;
  }

  ticks(): AxisTick[] {
    const raw = signedDecadeTicks((v) => this.forward(v), this.displayDomain, this.p.T, { minor: true });
    // Display domain is [0,1]; 0.055 keeps roughly a label's width apart.
    return thinLabels(raw, 0.055);
  }
}

/** Logicle, parameterised the GatingML way: T, W (decades), M, A. */
export class LogicleTransform extends BiexponentialBase {
  constructor(spec: TransformSpec) {
    const M = spec.decades && spec.decades > 0 ? spec.decades : 4.5;
    const W = spec.width !== undefined ? spec.width : 0.5;
    const A = spec.negativeDecades ?? 0;
    super(spec, W, M, A);
  }
}

/**
 * FlowJo-style biexponential.
 *
 * Same machinery, but `width` is read as a FlowJo *width basis* — the negative
 * data value the linear region should reach — rather than as decades. This is
 * the parameterisation FlowJo workspaces carry, and converting it here means a
 * imported workspace keeps its author's intent.
 */
export class BiexponentialTransform extends BiexponentialBase {
  constructor(spec: TransformSpec) {
    const M = spec.decades && spec.decades > 0 ? spec.decades : 4.5;
    const T = spec.range > 0 ? spec.range : 262144;
    const basis = spec.width !== undefined && spec.width !== 0 ? spec.width : -10;
    super(spec, widthBasisToW(basis, T, M), M, spec.negativeDecades ?? 0);
  }
}
