/**
 * Axis transforms.
 *
 * Design note that shapes the whole render path: transforms are applied on the
 * CPU to produce a "display-space" Float32Array, which is then mapped to the
 * viewport linearly. The alternative — evaluating the transform in the vertex
 * shader — falls apart for logicle and hyperlog, which have no closed-form
 * inverse and need Newton iteration. Doing it once per (parameter × transform)
 * and caching keeps the shader trivial and makes every transform equally cheap
 * to render.
 */

export type TransformKind = 'linear' | 'log' | 'biexponential' | 'logicle' | 'hyperlog' | 'asinh';

export interface TransformSpec {
  kind: TransformKind;
  /** `$PnR` — the parameter's declared range; several transforms are defined against it. */
  range: number;
  /**
   * Bottom of the linear axis. Defaults to 0, which is right for a detector.
   *
   * A **derived** parameter is not bounded below by zero — a ratio such as
   * `(FITC-A - APC-A) / (FITC-A + APC-A)` runs to −1 — and a linear axis whose
   * domain starts at 0 puts no tick and no gridline anywhere in the negative
   * half of the plot. Only `linear` reads this; the log-family transforms are
   * defined against decades of `range` and have their own answer for negatives.
   */
  min?: number;
  /** Decades of display range. Used by log, biexponential, logicle, hyperlog. */
  decades?: number;
  /** Width basis in decades of the near-zero linear region (logicle/biexponential `W`). */
  width?: number;
  /** Extra negative decades to show (`A`). */
  negativeDecades?: number;
  /** arcsinh cofactor. Lower values expand the region near zero. */
  cofactor?: number;
}

/**
 * A transform maps raw channel values to a display axis.
 *
 * `forward` is monotonic increasing, so ordering — and therefore gating — is
 * preserved. `inverse` is required so a gate drawn in display space can be
 * reported back in channel units.
 */
export interface Transform {
  readonly spec: TransformSpec;
  /** Raw channel value → display-space value. */
  forward(value: number): number;
  /** Display-space value → raw channel value. */
  inverse(display: number): number;
  /** Display-space bounds corresponding to the parameter's full range. */
  readonly displayDomain: [number, number];
  /**
   * Optional batch path for `forward` over a whole column.
   *
   * Transforms whose forward direction needs a root find (logicle, hyperlog)
   * implement this with a lookup table built from their cheap closed-form
   * inverse; iterating per event would cost tens of milliseconds per column.
   */
  forwardAll?(values: Float32Array): Float32Array;
  /**
   * Tick positions in display space, with the raw value each represents.
   * Transforms choose their own tick strategy: decade ticks for log-like
   * transforms, "nice" round numbers for linear.
   *
   * `view` is the display-space range the axis is **actually showing**, which is
   * the parameter's full extent unless the panel carries explicit limits. A
   * linear axis has to honour it: its ticks are chosen to divide a span nicely,
   * and dividing the parameter's own span produced ticks that stopped short of a
   * typed range and never landed on its boundaries — an axis asked for −1 to 1
   * whose last label was 0.8. The decade transforms ignore it, because a decade
   * sits at an absolute position and a sub-range legitimately shows fewer of
   * them; the caller filters to the view either way.
   */
  ticks(targetCount: number, view?: readonly [number, number]): AxisTick[];
}

export interface AxisTick {
  /** Position in display space. */
  display: number;
  /** Raw channel value at this position. */
  value: number;
  /** Rendered label. Empty string marks a minor tick (drawn, not labelled). */
  label: string;
  minor?: boolean;
}

export const DEFAULT_COFACTOR = 1000;
export const DEFAULT_DECADES = 4.5;
export const DEFAULT_WIDTH = 1;
