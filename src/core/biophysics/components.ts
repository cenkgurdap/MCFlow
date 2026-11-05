/**
 * One mixture component's shape, and the arithmetic every reader of a fit needs.
 *
 * ## Why this file exists (2026-10-22)
 *
 * The question "how tall is this component at x, and how much of it falls in
 * this bin" has to be answered the same way by the fitter, the Bayes boundary,
 * the drawn curve and the expected counts, so it is answered once, here. A
 * component is a Gaussian (the skew-normal option of 0.34 was removed in 0.35).
 *
 * Pure.
 */

/** One fitted component: a weight, a centre and a spread, all in data units. */
export interface MixtureComponent {
  /** Share of the distribution, 0…1. The components sum to 1. */
  weight: number;
  /** The component's mean — its true first moment, . */
  mean: number;
  /** Its true standard deviation, . */
  sd: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** The standard normal density. */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/**
 * The standard normal distribution function.
 *
 * Through the complementary error function, to a relative accuracy of about
 * 1e-7 everywhere (the Chebyshev fit from *Numerical Recipes*' `erfcc`) — far
 * finer than a histogram bar can be read, and stable in the far tails where
 * `1 − erf` would cancel.
 */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const erfc = t * Math.exp(
    -x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
      + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
      + t * (-0.82215223 + t * 0.17087277)))))))),
  );
  return z >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
}

/**
 * φ(u) / Φ(u), the inverse Mills ratio — what the skew-normal fit's E-step asks
 * at every bin. Direct where Φ is representable; the asymptotic series below
 * −8, where Φ(u) is a denormal-adjacent sliver and the quotient would be noise.
 */
export function inverseMills(u: number): number {
  if (u > -8) return normalPdf(u) / normalCdf(u);
  const u2 = u * u;
  return -u / (1 - 1 / u2 + 3 / (u2 * u2));
}

/** A component's density at x. */
export function componentPdf(c: MixtureComponent, x: number): number {
  return normalPdf((x - c.mean) / c.sd) / c.sd;
}

/** The share of a component between lo and hi. */
export function componentMass(c: MixtureComponent, lo: number, hi: number): number {
  return normalCdf((hi - c.mean) / c.sd) - normalCdf((lo - c.mean) / c.sd);
}

/** Where a component peaks. */
export function componentMode(c: MixtureComponent): number {
  return c.mean;
}
