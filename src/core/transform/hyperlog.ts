import { signedDecadeTicks, thinLabels } from './ticks';
import type { AxisTick, Transform, TransformSpec } from './types';

/* ==========================================================================
   Hyperlog (Bagwell 2005), as specified in GatingML 2.0 §6.2.

   Defined as the inverse of

       EH(y) = a·e^(b·y) + c·y − f

   i.e. an exponential with a linear term rather than the second, opposing
   exponential that logicle uses. EH is strictly increasing (a, b, c > 0), so
   the root find is unconditionally well behaved — no reflection about data
   zero and no Taylor patch are needed, which makes this the simpler of the two.
   ========================================================================== */

export interface HyperlogParams {
  T: number; W: number; M: number; A: number;
  a: number; b: number; c: number; f: number;
  w: number; x0: number; x1: number; x2: number;
}

export function initHyperlog(T: number, W: number, M: number, A: number): HyperlogParams {
  const w = W / (M + A);
  const x2 = A / (M + A);
  const x1 = x2 + w;
  const x0 = x2 + 2 * w;
  const b = (M + A) * Math.LN10;

  // w == 0 would divide by zero below; fall back to a minimal linear term so
  // the scale degrades to a plain exponential instead of producing NaN.
  const e0 = Math.exp(b * x0);
  const ca = w > 0 ? e0 / w : Math.exp(b * x1) * b;
  const fa = Math.exp(b * x1) + ca * x1;
  const a = T / (Math.exp(b) + ca - fa);

  return { T, W, M, A, a, b, c: ca * a, f: fa * a, w, x0, x1, x2 };
}

/** Display → value. Closed form. */
export function hyperlogInverse(p: HyperlogParams, y: number): number {
  return p.a * Math.exp(p.b * y) + p.c * y - p.f;
}

/** Value → display. Newton, safeguarded by bisection over a widened bracket. */
export function hyperlogForward(p: HyperlogParams, value: number): number {
  // EH(x1) == 0 by construction, so data zero maps exactly to x1.
  if (value === 0) return p.x1;

  // Bracket. The nominal domain is [0,1] but values beyond T (saturating
  // detectors do reach it) need room, so the bracket is widened until it spans.
  let lo = 0;
  let hi = 1;
  let guard = 0;
  while (hyperlogInverse(p, lo) > value && guard++ < 60) lo -= 1;
  guard = 0;
  while (hyperlogInverse(p, hi) < value && guard++ < 60) hi += 1;

  let y =
    Math.abs(value) < p.a
      ? p.x1 + value / (p.a * p.b * Math.exp(p.b * p.x1) + p.c) // linear near zero
      : Math.log(Math.max((value + p.f) / p.a, Number.MIN_VALUE)) / p.b;
  if (!Number.isFinite(y) || y < lo || y > hi) y = (lo + hi) / 2;

  for (let i = 0; i < 60; i++) {
    const e = p.a * Math.exp(p.b * y);
    const fy = e + p.c * y - p.f - value;
    if (fy > 0) hi = y;
    else lo = y;

    const dfy = p.b * e + p.c;
    let next = dfy > 0 ? y - fy / dfy : (lo + hi) / 2;
    // Fall back to bisection whenever Newton leaves the bracket.
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;

    const delta = Math.abs(next - y);
    y = next;
    if (delta < 1e-12 || hi - lo < 1e-14) break;
  }
  return y;
}

export class HyperlogTransform implements Transform {
  private readonly p: HyperlogParams;
  readonly displayDomain: [number, number] = [0, 1];

  constructor(readonly spec: TransformSpec) {
    const M = spec.decades && spec.decades > 0 ? spec.decades : 4.5;
    const T = spec.range > 0 ? spec.range : 262144;
    const W = Math.min(M / 2, Math.max(0, spec.width !== undefined ? spec.width : 0.5));
    const A = Math.min(M - 2 * W, Math.max(-W, spec.negativeDecades ?? 0));
    this.p = initHyperlog(T, W, M, A);
  }

  forward(value: number): number {
    return hyperlogForward(this.p, value);
  }

  inverse(display: number): number {
    return hyperlogInverse(this.p, display);
  }

  /** Batch path via a lookup table — see the note on the logicle equivalent. */
  forwardAll(values: Float32Array): Float32Array {
    const N = 8192;
    const [lo, hi] = this.displayDomain;
    const disp = new Float64Array(N);
    const val = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const s = lo + ((hi - lo) * i) / (N - 1);
      disp[i] = s;
      val[i] = hyperlogInverse(this.p, s);
    }

    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (!Number.isFinite(v)) { out[i] = lo; continue; }
      // Outside the table, iterate exactly — see the note on the logicle path.
      if (v <= val[0]!) { out[i] = hyperlogForward(this.p, v); continue; }
      if (v >= val[N - 1]!) { out[i] = hyperlogForward(this.p, v); continue; }
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
    return thinLabels(raw, 0.055);
  }
}
