/**
 * A seeded pseudo-random source, so a projection can be run twice.
 *
 * ## Why this exists
 *
 * UMAP is stochastic in three places at once — the random projection forest that
 * seeds the neighbour search, the initial layout, and the negative sampling
 * inside every optimisation epoch — and `umap-js` reaches for `Math.random` in
 * all of them by default. The consequence is the one that was reported: pressing
 * *Project* twice on the same file, the same columns and the same preset gives
 * two different maps. Not different in the structure they show, but different
 * enough that the same cluster lands somewhere else, which makes a projection
 * impossible to put in a figure and impossible to compare against the one from
 * ten minutes ago.
 *
 * Nothing else in this application is affected, because nothing else in it is
 * random: the subsample is a stride (`strideIndices`), the mixture fit runs from
 * three stated starts, and unmixing is a linear solve. UMAP was the exception,
 * and this is what makes it not one.
 *
 * ## mulberry32
 *
 * Thirty-two bits of state and four operations per draw. Chosen because the
 * alternatives are worse for this job in both directions: `Math.random` cannot
 * be seeded at all, and a Mersenne Twister is 2.5 KB of state and a dependency
 * for a use that has no statistical requirement beyond *uniform enough to sample
 * negatives with*. It passes gjrand's basic suite, which is more than that use
 * needs, and it is short enough to read.
 *
 * A seed of 0 is folded to 1 — mulberry32's state cannot be all zeroes without
 * the first draws being visibly degenerate, and 0 is exactly the number somebody
 * types into a seed field first.
 */
export function seededRandom(seed: number): () => number {
  let a = (Math.floor(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed a fresh panel uses, and the one behind every projection until
 * somebody changes it.
 *
 * A stated constant rather than a timestamp, so *the same settings give the same
 * picture* is true across sessions and across machines, not only within one run
 * of the app. Which number it is means nothing; that it never changes on its own
 * is the whole feature.
 */
export const DEFAULT_UMAP_SEED = 42;

/** A new seed for the re-roll button, in the range the field accepts. */
export function randomSeed(): number {
  return 1 + Math.floor(Math.random() * 999_998);
}
