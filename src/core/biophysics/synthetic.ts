/* ==========================================================================
   Synthetic distributions whose answer is known — for tests only.

   The only way to test a fit. On real data there is nothing to compare the
   result against except another opinion, which is why the correctness of the
   estimator, and of how a fit is drawn, lives in the suites that import this.

   The generator is a fixed linear congruential sequence rather than
   `Math.random`, so a failure is reproducible and a marginal case cannot pass on
   one run and fail on the next. That matters more than usual here: the whole
   claim of the fitting module is that the same file gives the same answer twice.

   Shared rather than copied because two suites draw from it — `mixture.test.ts`
   for the estimator and `fitDisplay.test.ts` for the drawing — and two copies of
   a seeded generator are two sequences the moment one of them is edited.
   Nothing in the application imports it.
   ========================================================================== */

/** A fixed linear congruential sequence on [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Box–Muller over the fixed sequence above. */
export function normals(n: number, mean: number, sd: number, seed: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = Math.max(1e-12, r());
    const v = r();
    const mag = Math.sqrt(-2 * Math.log(u));
    out.push(mean + sd * mag * Math.cos(2 * Math.PI * v));
    if (out.length < n) out.push(mean + sd * mag * Math.sin(2 * Math.PI * v));
  }
  return out;
}

/** Several Gaussian parts concatenated, each from its own stated seed. */
export function mixture(
  parts: Array<{ n: number; mean: number; sd: number }>,
  seed = 12345,
): Float32Array {
  const all: number[] = [];
  parts.forEach((p, i) => all.push(...normals(p.n, p.mean, p.sd, seed + i * 7919)));
  return Float32Array.from(all);
}
