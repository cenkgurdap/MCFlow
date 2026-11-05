/**
 * Is that difference real?
 *
 * The Compare chart already draws mean ± SD per category with every sample's own
 * point over it, and then stopped one step short of the question the figure was
 * opened to answer. Getting an answer meant exporting to Prism or Excel — the
 * one round trip this application had left in an otherwise closed loop.
 *
 * ## The unit of analysis, which is the whole correctness argument
 *
 * **`n` is the number of samples, never the number of events.** Everything here
 * runs on the per-sample values `summariseGroup` already produces — one median,
 * or one percentage, per tube. That is not a convenience; it is the only defensible
 * unit. A t-test over the 300 000 events of two files reports p ≈ 0 for any
 * difference whatsoever, because it is answering "do these two *files* differ"
 * with a sample size of 300 000 rather than "do these two *conditions* differ"
 * with a sample size of 3. Events within a tube are not independent replicates of
 * the treatment, and a test that treats them as such is pseudoreplication with a
 * p-value attached.
 *
 * ## Prism's numbers, on purpose
 *
 * Cytometrists read GraphPad Prism output, so the test names, the defaults and
 * the arithmetic here are the ones they already recognise, and where Prism offers
 * a choice MCFlow's default is Prism's:
 *
 *   | Categories | Parametric              | Non-parametric              |
 *   |------------|------------------------|-----------------------------|
 *   | 2          | unpaired t, Welch on   | Mann-Whitney U              |
 *   | 3+         | ordinary one-way ANOVA | Kruskal-Wallis              |
 *   | 3+ post-hoc| Holm-Sidak pairwise t  | Dunn, Bonferroni-adjusted   |
 *
 * Unpaired throughout. Replicate tubes are not repeated measures, and there is
 * nothing in a workspace that could say which tube in one condition pairs with
 * which in another.
 *
 * Tukey's HSD is deliberately absent: it needs the studentized range
 * distribution, and Prism's own guidance recommends Holm-Sidak over it for the
 * case with no confidence intervals — which is this one.
 *
 * ## Why the distributions are written out here
 *
 * MCFlow has eight runtime dependencies and the manuscript's Methods says so.
 * `jstat` or `simple-statistics` would make that nine for two hundred lines of
 * numerics that have been settled since Numerical Recipes: a Lanczos log-gamma,
 * a Lentz continued fraction for the incomplete beta, a series-and-CF pair for
 * the incomplete gamma. Every one is asserted against published values in
 * `significance.test.ts` rather than against itself.
 *
 * Tail accuracy is the reason `gammaQ` is the primitive rather than `gammaP`:
 * a p-value of 1e-8 computed as `1 - 0.99999999` has no significant digits left.
 *
 * Pure and store-free, like everything else in `core/`.
 */

/* -------------------------------------------------------------------------
   Distributions
   ------------------------------------------------------------------------- */

/** Lanczos g = 7, n = 9 — good to ~15 significant figures over the range used here. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(z: number): number {
  // Reflection for the left half-plane; the series below is only valid for z ≥ 0.5.
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let series = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) series += LANCZOS[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(series);
}

const TINY = 1e-300;
const EPS = 3e-16;

/** Continued fraction for the incomplete beta, by the modified Lentz method. */
function betaCf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    // Even step.
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    // Odd step.
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/**
 * The regularised incomplete beta, I_x(a, b).
 *
 * The continued fraction converges quickly only on one side of the distribution's
 * mass, so the far side is evaluated through the symmetry I_x(a,b) = 1 − I_(1−x)(b,a).
 * The prefactor is unchanged by that swap, which is why one `lb` serves both.
 */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  const lb = logGamma(a + b) - logGamma(a) - logGamma(b)
    + a * Math.log(x) + b * Math.log1p(-x);
  return x < (a + 1) / (a + b + 2)
    ? (Math.exp(lb) * betaCf(a, b, x)) / a
    : 1 - (Math.exp(lb) * betaCf(b, a, 1 - x)) / b;
}

/**
 * The regularised **upper** incomplete gamma, Q(a, x) = 1 − P(a, x).
 *
 * Upper rather than lower, because that is the tail every p-value here is read
 * from. Series below x = a+1 where Q would be the difference of two near-equal
 * numbers, continued fraction above it where Q is computed directly.
 */
export function gammaQ(a: number, x: number): number {
  if (!(x >= 0) || !(a > 0)) return NaN;
  if (x === 0) return 1;
  const prefix = Math.exp(-x + a * Math.log(x) - logGamma(a));

  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let i = 0; i < 1000; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * prefix;
  }

  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return prefix * h;
}

/** Two-sided p from Student's t on `df` degrees of freedom. */
export function tTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t) || !(df > 0)) return NaN;
  return incompleteBeta(df / 2, 0.5, df / (df + t * t));
}

/**
 * The two-sided critical value of Student's t: the t at which `tTwoSided`
 * equals `alpha`. Bisection on the distribution function this file already
 * trusts, rather than a second approximation of it — for a 95% confidence
 * interval, `tCritical(0.05, n − 1)`.
 */
export function tCritical(alpha: number, df: number): number {
  if (!(df > 0) || !(alpha > 0 && alpha < 1)) return NaN;
  let lo = 0;
  let hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(F > f) for an F distribution on (d1, d2) degrees of freedom. */
export function fUpper(f: number, d1: number, d2: number): number {
  if (!(f > 0)) return 1;
  if (!Number.isFinite(f)) return 0;
  return incompleteBeta(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
}

/** P(χ² > x) on `df` degrees of freedom. */
export function chiSquareUpper(x: number, df: number): number {
  if (!(x > 0)) return 1;
  return gammaQ(df / 2, x / 2);
}

/**
 * Two-sided p from the standard normal — erfc(|z|/√2), evaluated in the tail.
 *
 * Written as a single `gammaQ` rather than `2 * (1 − Φ(|z|))`: at z = 6 the
 * latter is the difference of two numbers agreeing to nine places, and the answer
 * is 2e-9.
 */
export function normalTwoSided(z: number): number {
  if (!Number.isFinite(z)) return NaN;
  return gammaQ(0.5, (z * z) / 2);
}

/* -------------------------------------------------------------------------
   Ranks and small summaries
   ------------------------------------------------------------------------- */

const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/** Sample variance, n−1 in the denominator — these are replicates, not a population. */
function variance(v: readonly number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
}

/**
 * Midranks, and the size of every group of tied values.
 *
 * Tied values share the average of the ranks they span — the convention every
 * rank test here assumes, and the reason each of them carries a tie correction:
 * ties shrink the variance of the rank sum, so ignoring them makes a test
 * conservative by an amount that grows with how coarse the measurements are.
 */
export function midranks(values: readonly number[]): { ranks: number[]; tieSizes: number[] } {
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(values.length);
  const tieSizes: number[] = [];
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && values[order[j + 1]!]! === values[order[i]!]!) j++;
    // Ranks are 1-based, and the shared rank is the midpoint of the run.
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k]!] = shared;
    tieSizes.push(j - i + 1);
    i = j + 1;
  }
  return { ranks, tieSizes };
}

/** Σ(t³ − t) over the tie runs — the correction term every rank test divides by. */
const tieTerm = (tieSizes: readonly number[]) => tieSizes.reduce((a, t) => a + (t ** 3 - t), 0);

/** Exact binomial coefficient. C(40, 20) is 1.4e11, well inside a double. */
function choose(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return Math.round(out);
}

/* -------------------------------------------------------------------------
   Results
   ------------------------------------------------------------------------- */

export type TestId = 'welch' | 'student' | 'mannWhitney' | 'anova' | 'kruskal';
export type PostHocId = 'holmSidak' | 'dunn';
/** How a family of pairwise p-values is corrected for multiplicity. */
export type PAdjust = 'holm' | 'sidak' | 'bonferroni';
/** Which pairs the correction is computed over. */
export type ComparisonFamily = 'all' | 'vsFirst';

export interface Group {
  label: string;
  /** One value per sample. Never per event — see the note at the top of this file. */
  values: number[];
}

export interface OmnibusResult {
  id: TestId;
  /** How the test names itself, on screen and in the exported file. */
  label: string;
  /** `t`, `U`, `F` or `H`. */
  statisticLabel: string;
  statistic: number;
  /** Formatted degrees of freedom — `3.87`, `2, 9`, `2` — or empty where there are none. */
  df: string;
  p: number;
  /** Per-category sample counts, in category order. */
  n: number[];
  /**
   * Anything the reader has to know in order to read the p-value: that it is an
   * approximation, that ties were corrected for, or that the design cannot reach
   * significance at all. Never a warning about the result — only about the method.
   */
  note: string | null;
}

export interface PairResult {
  /** Indices into the groups array, as given. */
  a: number;
  b: number;
  labelA: string;
  labelB: string;
  /** `t` or `z`. */
  statisticLabel: string;
  statistic: number;
  p: number;
  /** Corrected over the whole family — see `compareGroups`. */
  pAdjusted: number;
}

export interface Comparison {
  omnibus: OmnibusResult | null;
  pairs: PairResult[];
  /** How the post-hoc test names itself, or null when there is no post-hoc step. */
  postHocLabel: string | null;
  /** Why there is nothing to report. Null when there is. */
  unavailable: string | null;
}

export interface CompareOptions {
  parametric: boolean;
  /** Welch's correction for unequal SDs. Two-group parametric only; on by default. */
  welch: boolean;
  family: ComparisonFamily;
  adjust: PAdjust;
}

/* -------------------------------------------------------------------------
   The two-sample tests
   ------------------------------------------------------------------------- */

/** Unpaired t, with or without Welch's correction for unequal variances. */
export function twoSampleT(
  a: readonly number[],
  b: readonly number[],
  welch: boolean,
): { t: number; df: number; p: number } {
  const na = a.length;
  const nb = b.length;
  const va = variance(a);
  const vb = variance(b);
  const delta = mean(a) - mean(b);

  if (welch) {
    const sa = va / na;
    const sb = vb / nb;
    const se = Math.sqrt(sa + sb);
    const t = delta / se;
    // Welch-Satterthwaite. Undefined when either group has no spread at all,
    // which the caller turns into a stated reason rather than a NaN on screen.
    const df = (sa + sb) ** 2 / ((sa * sa) / (na - 1) + (sb * sb) / (nb - 1));
    return { t, df, p: tTwoSided(Math.abs(t), df) };
  }

  const df = na + nb - 2;
  const pooled = ((na - 1) * va + (nb - 1) * vb) / df;
  const t = delta / Math.sqrt(pooled * (1 / na + 1 / nb));
  return { t, df, p: tTwoSided(Math.abs(t), df) };
}

/**
 * Mann-Whitney U, exact where the design allows it.
 *
 * **The exact branch is not an optimisation, it is the point.** With three
 * replicates against three there are only C(6,3) = 20 distinguishable
 * arrangements, so the smallest two-sided p the test can produce is 2/20 = 0.10:
 * n = 3 per group *cannot* reach 0.05 non-parametrically, whatever the data does.
 * The normal approximation hides that behind a plausible-looking 0.037. The floor
 * is returned so the caller can say it out loud instead of printing `ns` under a
 * figure where the two groups plainly do not overlap.
 *
 * Ties break the exact enumeration — the null distribution is no longer the one
 * counted here — so those fall through to the tie-corrected normal approximation.
 */
export function mannWhitneyU(
  a: readonly number[],
  b: readonly number[],
): { u: number; p: number; exact: boolean; floor: number | null; z: number | null } {
  const n1 = a.length;
  const n2 = b.length;
  const { ranks, tieSizes } = midranks([...a, ...b]);
  let r1 = 0;
  for (let i = 0; i < n1; i++) r1 += ranks[i]!;
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const tied = tieSizes.some((t) => t > 1);

  if (!tied && n1 <= 20 && n2 <= 20) {
    const total = choose(n1 + n2, n1);
    const counts = uCounts(n1, n2);
    let atOrBelow = 0;
    for (let k = 0; k <= u; k++) atOrBelow += counts[k]!;
    return {
      u,
      p: Math.min(1, (2 * atOrBelow) / total),
      exact: true,
      floor: (2 * counts[0]!) / total,
      z: null,
    };
  }

  const N = n1 + n2;
  const sd = Math.sqrt(((n1 * n2) / 12) * (N + 1 - tieTerm(tieSizes) / (N * (N - 1))));
  const z = (u1 - (n1 * n2) / 2) / sd;
  return { u, p: normalTwoSided(Math.abs(z)), exact: false, floor: null, z };
}

/**
 * How many arrangements give each value of U, for U = 0 … n1·n2.
 *
 * The standard recurrence N(m,n,u) = N(m−1,n,u−n) + N(m,n−1,u): either the next
 * item drawn belongs to the first sample, in which case it is preceded by all n
 * of the second, or it belongs to the second and contributes nothing.
 */
function uCounts(n1: number, n2: number): Float64Array {
  const max = n1 * n2;
  const width = max + 1;
  const memo = new Float64Array((n1 + 1) * (n2 + 1) * width).fill(-1);
  const at = (m: number, n: number, u: number) => (m * (n2 + 1) + n) * width + u;

  const count = (m: number, n: number, u: number): number => {
    if (u < 0 || u > m * n) return 0;
    if (m === 0 || n === 0) return u === 0 ? 1 : 0;
    const k = at(m, n, u);
    const seen = memo[k]!;
    if (seen >= 0) return seen;
    const v = count(m - 1, n, u - n) + count(m, n - 1, u);
    memo[k] = v;
    return v;
  };

  const out = new Float64Array(width);
  for (let u = 0; u <= max; u++) out[u] = count(n1, n2, u);
  return out;
}

/* -------------------------------------------------------------------------
   The k-sample tests
   ------------------------------------------------------------------------- */

/** Ordinary one-way ANOVA. `msWithin` is carried out for the post-hoc step. */
export function oneWayAnova(groups: readonly Group[]): {
  f: number; dfB: number; dfW: number; p: number; msWithin: number;
} {
  const all = groups.flatMap((g) => g.values);
  const grand = mean(all);
  const dfB = groups.length - 1;
  const dfW = all.length - groups.length;

  let ssB = 0;
  let ssW = 0;
  for (const g of groups) {
    const m = mean(g.values);
    ssB += g.values.length * (m - grand) ** 2;
    for (const v of g.values) ssW += (v - m) ** 2;
  }

  const msWithin = ssW / dfW;
  const f = ssB / dfB / msWithin;
  return { f, dfB, dfW, p: fUpper(f, dfB, dfW), msWithin };
}

/** Kruskal-Wallis H, tie-corrected, against χ² on k−1 degrees of freedom. */
export function kruskalWallis(groups: readonly Group[]): {
  h: number; df: number; p: number; meanRanks: number[]; tieSizes: number[]; n: number;
} {
  const all = groups.flatMap((g) => g.values);
  const N = all.length;
  const { ranks, tieSizes } = midranks(all);

  const meanRanks: number[] = [];
  let sum = 0;
  let offset = 0;
  for (const g of groups) {
    let r = 0;
    for (let i = 0; i < g.values.length; i++) r += ranks[offset + i]!;
    offset += g.values.length;
    meanRanks.push(r / g.values.length);
    sum += (r * r) / g.values.length;
  }

  let h = (12 / (N * (N + 1))) * sum - 3 * (N + 1);
  // Ties shrink the spread of the rank sums, so H is scaled back up by exactly
  // the amount they shrank it. C is 1 when nothing is tied.
  const c = 1 - tieTerm(tieSizes) / (N ** 3 - N);
  if (c > 0) h /= c;

  const df = groups.length - 1;
  return { h, df, p: chiSquareUpper(h, df), meanRanks, tieSizes, n: N };
}

/* -------------------------------------------------------------------------
   Multiplicity
   ------------------------------------------------------------------------- */

/**
 * A family of raw p-values, corrected.
 *
 * Holm and Holm-Sidak are step-down procedures: the smallest p is corrected as if
 * it were one of m comparisons, the next as one of m−1, and so on — uniformly
 * more powerful than plain Bonferroni while controlling the same family-wise
 * error rate. The running maximum enforces monotonicity, without which a larger
 * raw p could come back with a smaller adjusted one.
 *
 * Returned in the caller's order, not in sorted order.
 */
export function adjustP(ps: readonly number[], method: PAdjust): number[] {
  const m = ps.length;
  if (m === 0) return [];
  if (method === 'bonferroni') return ps.map((p) => Math.min(1, p * m));

  const order = ps.map((_, i) => i).sort((a, b) => ps[a]! - ps[b]!);
  const out = new Array<number>(m);
  let running = 0;
  for (let r = 0; r < m; r++) {
    const i = order[r]!;
    const raw = method === 'sidak'
      ? 1 - (1 - ps[i]!) ** (m - r)
      : (m - r) * ps[i]!;
    running = Math.max(running, Math.min(1, raw));
    out[i] = running;
  }
  return out;
}

/** The pairs a family covers, as indices into the category list. */
export function pairsFor(count: number, family: ComparisonFamily): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (family === 'vsFirst') {
    for (let j = 1; j < count; j++) out.push([0, j]);
    return out;
  }
  for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) out.push([i, j]);
  return out;
}

/**
 * A stable key for one pair, by label rather than by index.
 *
 * Which brackets are drawn has to survive the categories being reordered, and the
 * reordering control sits six millimetres away. `JSON.stringify` because a group
 * name is an arbitrary string and any separator character could appear in one.
 */
export const pairKey = (labelA: string, labelB: string) => JSON.stringify([labelA, labelB]);

/* -------------------------------------------------------------------------
   The one entry point
   ------------------------------------------------------------------------- */

const NAMES: Record<TestId, string> = {
  welch: "Welch's unpaired t-test",
  student: 'Unpaired t-test',
  mannWhitney: 'Mann-Whitney test',
  anova: 'Ordinary one-way ANOVA',
  kruskal: 'Kruskal-Wallis test',
};

const ADJUST_NAMES: Record<PAdjust, string> = {
  holm: 'Holm',
  sidak: 'Holm-Sidak',
  bonferroni: 'Bonferroni',
};

/** How each correction names itself in a control and in an exported file. */
export const adjustName = (a: PAdjust) => ADJUST_NAMES[a];

/**
 * The correction to use, given what the operator asked for.
 *
 * `'auto'` is the convention of whichever test is running rather than one method
 * for both: Holm-Sidak after an ANOVA, Bonferroni for Dunn's. Those are Prism's
 * defaults, so a reader who checks a number against Prism gets the same one.
 * Resolved through this function rather than by storing a different default per
 * family, which is how two settings come to disagree about what is in force.
 */
export function resolveAdjust(parametric: boolean, stored: PAdjust | 'auto'): PAdjust {
  if (stored !== 'auto') return stored;
  return parametric ? 'sidak' : 'bonferroni';
}

const unavailable = (why: string): Comparison => ({
  omnibus: null, pairs: [], postHocLabel: null, unavailable: why,
});

/** Degrees of freedom, written the way a result line reads them. */
const dfText = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/**
 * Compare the categories, and say what could not be compared and why.
 *
 * **The correction is over the family, not over what gets drawn.** `pairs` covers
 * every comparison the chosen family names, and `pAdjusted` is computed across
 * all of them. Which of those the chart draws a bracket for is a separate,
 * purely visual choice made by the caller — because the alternative lets somebody
 * lower their own p-values by hiding brackets, which is the one way this feature
 * could be quietly and seriously wrong.
 */
export function compareGroups(groups: readonly Group[], opts: CompareOptions): Comparison {
  const usable = groups.filter((g) => g.values.length > 0);
  if (usable.length < 2) return unavailable('Two or more categories are needed to compare.');
  if (usable.every((g) => g.values.length < 2)) {
    // The overwhelmingly common case: nobody has grouped anything, so every
    // category is a single tube. Names the fix rather than the failure.
    return unavailable('Every category holds one sample. Group your samples to compare conditions.');
  }

  const n = usable.map((g) => g.values.length);

  /* --- Two categories --- */
  if (usable.length === 2) {
    const [a, b] = [usable[0]!, usable[1]!];
    if (a.values.length < 2 || b.values.length < 2) {
      return unavailable('Both categories need at least two samples for a two-group test.');
    }

    if (!opts.parametric) {
      const { u, p, exact, floor } = mannWhitneyU(a.values, b.values);
      const note = exact
        ? (floor !== null && floor > 0.05
          ? `Exact two-sided p. With ${n[0]} against ${n[1]} samples the smallest p this test can return is ${floor.toFixed(4)}, so it cannot reach 0.05 whatever the difference.`
          : 'Exact two-sided p.')
        : 'Normal approximation, corrected for ties.';
      return {
        omnibus: { id: 'mannWhitney', label: NAMES.mannWhitney, statisticLabel: 'U', statistic: u, df: '', p, n, note },
        pairs: [], postHocLabel: null, unavailable: null,
      };
    }

    const { t, df, p } = twoSampleT(a.values, b.values, opts.welch);
    if (!Number.isFinite(t) || !Number.isFinite(df)) {
      return unavailable('Neither category varies, so a t-test has no scale to measure the difference against.');
    }
    const id: TestId = opts.welch ? 'welch' : 'student';
    return {
      omnibus: {
        id, label: NAMES[id], statisticLabel: 't', statistic: t, df: dfText(df), p, n,
        note: opts.welch ? "Welch's correction for unequal SDs." : 'Assumes both categories have the same SD.',
      },
      pairs: [], postHocLabel: null, unavailable: null,
    };
  }

  /* --- Three or more --- */
  const pairIndices = pairsFor(usable.length, opts.family);

  if (!opts.parametric) {
    const { h, df, p, meanRanks, tieSizes, n: N } = kruskalWallis(usable);
    // Dunn's compares mean ranks from the pooled ranking the omnibus test just
    // did — not a fresh ranking per pair, which would be a different test.
    const spread = (N * (N + 1)) / 12 - tieTerm(tieSizes) / (12 * (N - 1));
    const raw = pairIndices.map(([i, j]) => {
      const se = Math.sqrt(spread * (1 / n[i]! + 1 / n[j]!));
      const z = (meanRanks[i]! - meanRanks[j]!) / se;
      return { i, j, z, p: normalTwoSided(Math.abs(z)) };
    });
    const adjusted = adjustP(raw.map((r) => r.p), opts.adjust);
    return {
      omnibus: {
        id: 'kruskal', label: NAMES.kruskal, statisticLabel: 'H', statistic: h,
        df: dfText(df), p, n,
        note: tieSizes.some((t) => t > 1) ? 'Corrected for ties.' : null,
      },
      pairs: raw.map((r, k) => ({
        a: r.i, b: r.j, labelA: usable[r.i]!.label, labelB: usable[r.j]!.label,
        statisticLabel: 'z', statistic: r.z, p: r.p, pAdjusted: adjusted[k]!,
      })),
      postHocLabel: `Dunn's multiple comparisons test, ${ADJUST_NAMES[opts.adjust]}-adjusted`,
      unavailable: null,
    };
  }

  const { f, dfB, dfW, p, msWithin } = oneWayAnova(usable);
  if (!(dfW >= 1)) {
    return unavailable('Every category holds one sample, so there is no within-group variation to test against.');
  }
  if (!Number.isFinite(f)) {
    return unavailable('No category varies, so an ANOVA has no residual to measure against.');
  }
  // Pairwise t on the pooled residual from the ANOVA — the same MS_within and the
  // same df for every pair, which is what makes this a post-hoc test rather than
  // a stack of independent t-tests.
  const raw = pairIndices.map(([i, j]) => {
    const t = (mean(usable[i]!.values) - mean(usable[j]!.values))
      / Math.sqrt(msWithin * (1 / n[i]! + 1 / n[j]!));
    return { i, j, t, p: tTwoSided(Math.abs(t), dfW) };
  });
  const adjusted = adjustP(raw.map((r) => r.p), opts.adjust);
  return {
    omnibus: {
      id: 'anova', label: NAMES.anova, statisticLabel: 'F', statistic: f,
      df: `${dfText(dfB)}, ${dfText(dfW)}`, p, n, note: 'Assumes every category has the same SD.',
    },
    pairs: raw.map((r, k) => ({
      a: r.i, b: r.j, labelA: usable[r.i]!.label, labelB: usable[r.j]!.label,
      statisticLabel: 't', statistic: r.t, p: r.p, pAdjusted: adjusted[k]!,
    })),
    postHocLabel: `${ADJUST_NAMES[opts.adjust]} multiple comparisons test`,
    unavailable: null,
  };
}

/* -------------------------------------------------------------------------
   How a p-value is written down
   ------------------------------------------------------------------------- */

/** The threshold the stars are cut at, and the only one. */
export const ALPHA = 0.05;

/**
 * Prism's rendering, deliberately.
 *
 * Four decimals, matching `STAT_DECIMALS` and therefore the rest of this panel;
 * and clamped at both ends rather than printed as `0.0000`, which claims a
 * precision the arithmetic does not have and reads as exactly zero.
 */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.0001) return 'p < 0.0001';
  if (p > 0.9999) return 'p > 0.9999';
  return `p = ${p.toFixed(4)}`;
}

/** `ns` through `****`, at .05 / .01 / .001 / .0001 — the convention Prism prints. */
export function stars(p: number): string {
  if (!Number.isFinite(p)) return '';
  if (p > 0.05) return 'ns';
  if (p > 0.01) return '*';
  if (p > 0.001) return '**';
  if (p > 0.0001) return '***';
  return '****';
}

/** The omnibus line as one sentence — `Ordinary one-way ANOVA F(2, 6) = 14.21, p = 0.0052`. */
export function omnibusLine(r: OmnibusResult): string {
  const stat = r.df
    ? `${r.statisticLabel}(${r.df}) = ${r.statistic.toFixed(2)}`
    : `${r.statisticLabel} = ${r.statistic.toFixed(2)}`;
  return `${r.label}  ${stat}, ${formatP(r.p)}`;
}
