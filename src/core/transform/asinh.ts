import { signedDecadeTicks, thinLabels } from './ticks';
import { DEFAULT_COFACTOR, type AxisTick, type Transform, type TransformSpec } from './types';

/**
 * Inverse hyperbolic sine.
 *
 * The simplest of the signed-log family and the one CyTOF and mass-cytometry
 * workflows standardise on. Both directions are closed form, so unlike logicle
 * and hyperlog there is no root find and no lookup table — `forward` is exact
 * and cheap enough to run per event.
 *
 * The cofactor sets the width of the near-linear region: values much smaller
 * than it stay roughly linear, values much larger become logarithmic. Lower
 * cofactors expand the region around zero.
 */
export class AsinhTransform implements Transform {
  private readonly cofactor: number;
  readonly displayDomain: [number, number];

  constructor(readonly spec: TransformSpec) {
    const c = spec.cofactor && spec.cofactor > 0 ? spec.cofactor : DEFAULT_COFACTOR;
    this.cofactor = c;
    const T = spec.range > 0 ? spec.range : 262144;
    const top = Math.asinh(T / c);
    // Symmetric about zero: the negative half is where baseline-restored events
    // live, and clipping it would defeat the point of using arcsinh at all.
    this.displayDomain = [-top, top];
  }

  forward(value: number): number {
    return Math.asinh(value / this.cofactor);
  }

  inverse(display: number): number {
    return this.cofactor * Math.sinh(display);
  }

  ticks(): AxisTick[] {
    const T = this.spec.range > 0 ? this.spec.range : 262144;
    const raw = signedDecadeTicks((v) => this.forward(v), this.displayDomain, T, { minor: true });
    const span = this.displayDomain[1] - this.displayDomain[0];
    return thinLabels(raw, span * 0.055);
  }
}
