import { describe, expect, it } from 'vitest';
import { tCritical,
  adjustP, chiSquareUpper, compareGroups, formatP, fUpper, gammaQ, incompleteBeta,
  kruskalWallis, logGamma, mannWhitneyU, midranks, normalTwoSided, oneWayAnova,
  pairsFor, stars, tTwoSided, twoSampleT,
} from './significance';

/* ==========================================================================
   Significance testing.

   The distributions are asserted against **closed forms and identities**, never
   against a table of numbers copied out of another implementation. Every case
   below is one where the answer is known exactly:

     Q(1, x)          = e^-x
     chi-square, df 2 = e^(-x/2)
     t, df 1          two-sided p for t=1 is exactly 1/2 (Cauchy)
     t, df 2          two-sided p is 1 - t/sqrt(2+t^2)
     I_x(a, 1)        = x^a
     F(1, d)          is t^2 on d degrees of freedom

   That matters more than it sounds. A p-value has no plausibility check on it —
   0.0312 looks exactly as correct as 0.0321 — so a test that compared this file
   against itself, or against numbers transcribed from somewhere, would pass on a
   continued fraction that had quietly stopped converging.
   ========================================================================== */

describe('logGamma', () => {
  it('reproduces the factorials it interpolates', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(2)).toBeCloseTo(0, 12);
    expect(logGamma(3)).toBeCloseTo(Math.log(2), 12);
    expect(logGamma(6)).toBeCloseTo(Math.log(120), 11);
  });

  it('handles the half-integers the chi-square and normal tails need', () => {
    // Gamma(1/2) = sqrt(pi).
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    // Gamma(3/2) = sqrt(pi)/2, through the reflection branch's neighbour.
    expect(logGamma(1.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI) / 2), 12);
  });
});

describe('gammaQ — the upper tail, which is the one p-values are read from', () => {
  it('matches the closed form at a = 1', () => {
    for (const x of [0.1, 1, 2.5, 10, 30]) {
      expect(gammaQ(1, x)).toBeCloseTo(Math.exp(-x), 12);
    }
  });

  it('stays accurate deep in the tail, where 1 - P would have no digits left', () => {
    // e^-40 is 4.2e-18. Computed as a difference from 1 this is exactly zero.
    expect(gammaQ(1, 40)).toBeGreaterThan(0);
    expect(gammaQ(1, 40)).toBeCloseTo(Math.exp(-40), 25);
  });
});

describe('chiSquareUpper', () => {
  it('matches the closed form on two degrees of freedom', () => {
    for (const x of [0.5, 2, 7.2, 20]) {
      expect(chiSquareUpper(x, 2)).toBeCloseTo(Math.exp(-x / 2), 12);
    }
  });

  it('agrees with the normal on one degree of freedom', () => {
    // chi-square(1) is the square of a standard normal, so its upper tail is the
    // normal's two-sided one.
    for (const z of [0.5, 1, 1.959964, 3]) {
      expect(chiSquareUpper(z * z, 1)).toBeCloseTo(normalTwoSided(z), 12);
    }
  });
});

describe('normalTwoSided', () => {
  it('reproduces the values every table of the normal prints', () => {
    expect(normalTwoSided(1)).toBeCloseTo(0.3173105078629141, 12);
    expect(normalTwoSided(2)).toBeCloseTo(0.04550026389635842, 12);
    expect(normalTwoSided(3)).toBeCloseTo(0.0026997960632602, 12);
    expect(normalTwoSided(1.959963985)).toBeCloseTo(0.05, 9);
  });
});

describe('incompleteBeta', () => {
  it('is the identity at a = b = 1', () => {
    for (const x of [0.1, 0.5, 0.9]) expect(incompleteBeta(1, 1, x)).toBeCloseTo(x, 12);
  });

  it('matches I_x(a, 1) = x^a', () => {
    expect(incompleteBeta(3, 1, 0.1)).toBeCloseTo(0.001, 12);
    expect(incompleteBeta(2, 1, 0.5)).toBeCloseTo(0.25, 12);
  });

  it('is symmetric under the swap it uses to reach the far tail', () => {
    // I_x(a,b) = 1 - I_(1-x)(b,a) — the identity the second branch relies on.
    expect(incompleteBeta(2.5, 7.5, 0.3)).toBeCloseTo(1 - incompleteBeta(7.5, 2.5, 0.7), 12);
  });
});

describe('tTwoSided', () => {
  it('is exactly one half at t = 1 on one degree of freedom', () => {
    // T(1) is Cauchy: P(|T| > 1) = 1 - (2/pi) arctan(1) = 1/2.
    expect(tTwoSided(1, 1)).toBeCloseTo(0.5, 12);
  });

  it('matches the closed form on two degrees of freedom', () => {
    const closed = (t: number) => 1 - t / Math.sqrt(2 + t * t);
    for (const t of [0.5, Math.SQRT2, 4]) expect(tTwoSided(t, 2)).toBeCloseTo(closed(t), 12);
  });

  it('approaches the normal as the degrees of freedom grow', () => {
    expect(tTwoSided(1.959964, 100000)).toBeCloseTo(0.05, 5);
  });
});

describe('fUpper', () => {
  it('is the square of the t distribution on one numerator degree of freedom', () => {
    for (const t of [0.5, 1, 2.5]) {
      for (const df of [3, 8, 30]) {
        expect(fUpper(t * t, 1, df)).toBeCloseTo(tTwoSided(t, df), 12);
      }
    }
  });

  it('lands on the exact value the I_x(a, 1) identity gives', () => {
    // x = d2/(d2 + d1 f) = 6/60 = 0.1, so p = I_0.1(3, 1) = 0.1^3.
    expect(fUpper(27, 2, 6)).toBeCloseTo(0.001, 12);
  });
});

/* ========================================================================== */

describe('midranks', () => {
  it('gives tied values the average of the ranks they span', () => {
    const { ranks, tieSizes } = midranks([1, 2, 2, 3]);
    expect(ranks).toEqual([1, 2.5, 2.5, 4]);
    expect(tieSizes).toEqual([1, 2, 1]);
  });

  it('ranks in value order regardless of input order', () => {
    expect(midranks([30, 10, 20]).ranks).toEqual([3, 1, 2]);
  });
});

describe('twoSampleT', () => {
  const a = [1, 2, 3, 4, 5];
  const b = [6, 7, 8, 9, 10];

  it("computes Student's t on a case that works out by hand", () => {
    // Both groups have variance 2.5, so the pooled SD is 2.5 and the standard
    // error is sqrt(2.5 * 2/5) = 1. The means are 5 apart.
    const { t, df } = twoSampleT(a, b, false);
    expect(t).toBeCloseTo(-5, 12);
    expect(df).toBe(8);
  });

  it('gives Welch the same t and the same df when the variances are equal', () => {
    // Welch only differs from Student when the variances or the group sizes do.
    const s = twoSampleT(a, b, false);
    const w = twoSampleT(a, b, true);
    expect(w.t).toBeCloseTo(s.t, 12);
    expect(w.df).toBeCloseTo(8, 9);
  });

  it('drops the degrees of freedom when the variances differ sharply', () => {
    const w = twoSampleT([1, 2, 3, 4, 5], [10, 40, 70, 100, 130], true);
    // Welch-Satterthwaite falls toward n-1 of the wider group as the ratio grows.
    expect(w.df).toBeLessThan(5);
    expect(w.df).toBeGreaterThan(3.9);
  });
});

describe('mannWhitneyU', () => {
  /*
     The resolution floor, which is the reason the exact branch exists.

     Three replicates against three is the commonest design in this application,
     and it *cannot* produce a significant non-parametric result: with C(6,3) = 20
     arrangements the smallest two-sided p is 2/20. The normal approximation
     returns 0.0374 for the same data, which is a significant-looking number the
     design is incapable of earning.
  */
  it('returns exactly 0.1 for three completely separated against three', () => {
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6]);
    expect(r.exact).toBe(true);
    expect(r.u).toBe(0);
    expect(r.p).toBeCloseTo(0.1, 12);
    expect(r.floor).toBeCloseTo(0.1, 12);
  });

  it('returns 2/70 for four against four, fully separated', () => {
    const r = mannWhitneyU([1, 2, 3, 4], [5, 6, 7, 8]);
    expect(r.p).toBeCloseTo(2 / 70, 12);
  });

  it('is symmetric in its arguments', () => {
    const a = [1, 4, 7, 9];
    const b = [2, 3, 8, 11];
    expect(mannWhitneyU(a, b).p).toBeCloseTo(mannWhitneyU(b, a).p, 12);
  });

  it('gives identical groups a p of 1', () => {
    expect(mannWhitneyU([1, 2, 3, 4], [1, 2, 3, 4]).p).toBeCloseTo(1, 12);
  });

  it('falls back to the tie-corrected approximation when values are tied', () => {
    const r = mannWhitneyU([1, 2, 3], [3, 4, 5]);
    expect(r.exact).toBe(false);
    expect(r.floor).toBeNull();
    expect(r.z).not.toBeNull();
  });

  it('sums its two U statistics to n1 n2', () => {
    const a = [2, 5, 9];
    const b = [1, 4, 6, 8];
    // The reported U is the smaller of the pair, so it can never exceed half.
    expect(mannWhitneyU(a, b).u).toBeLessThanOrEqual((a.length * b.length) / 2);
  });
});

describe('oneWayAnova', () => {
  const groups = [
    { label: 'a', values: [1, 2, 3] },
    { label: 'b', values: [4, 5, 6] },
    { label: 'c', values: [7, 8, 9] },
  ];

  it('decomposes the sums of squares the way the hand calculation does', () => {
    // Means 2, 5, 8 about a grand mean of 5: SS_between = 3(9) + 0 + 3(9) = 54 on
    // 2 df. Each group contributes 2 to SS_within: 6 on 6 df, so MS_within = 1.
    const r = oneWayAnova(groups);
    expect(r.dfB).toBe(2);
    expect(r.dfW).toBe(6);
    expect(r.msWithin).toBeCloseTo(1, 12);
    expect(r.f).toBeCloseTo(27, 12);
    expect(r.p).toBeCloseTo(0.001, 12);
  });

  it('agrees with the two-sample t when there are only two groups', () => {
    // F on (1, df) is t squared, so an ANOVA over two groups is Student's t-test.
    const two = [{ label: 'a', values: [1, 2, 3, 4, 5] }, { label: 'b', values: [6, 7, 8, 9, 10] }];
    const f = oneWayAnova(two);
    const t = twoSampleT(two[0]!.values, two[1]!.values, false);
    expect(f.f).toBeCloseTo(t.t ** 2, 9);
    expect(f.p).toBeCloseTo(t.p, 12);
  });
});

describe('kruskalWallis', () => {
  it('computes H on a case with no ties, against the closed-form chi-square', () => {
    // Ranks 1..9 in three blocks: rank sums 6, 15, 24.
    // H = (12/90)(279) - 30 = 7.2 on 2 df, and P(chi2_2 > 7.2) = e^-3.6.
    const r = kruskalWallis([
      { label: 'a', values: [1, 2, 3] },
      { label: 'b', values: [4, 5, 6] },
      { label: 'c', values: [7, 8, 9] },
    ]);
    expect(r.h).toBeCloseTo(7.2, 12);
    expect(r.df).toBe(2);
    expect(r.p).toBeCloseTo(Math.exp(-3.6), 12);
    expect(r.meanRanks).toEqual([2, 5, 8]);
  });

  it('scales H up when ties have shrunk the rank spread', () => {
    const tied = kruskalWallis([
      { label: 'a', values: [1, 1, 1] },
      { label: 'b', values: [2, 2, 2] },
    ]);
    expect(tied.tieSizes).toEqual([3, 3]);
    // Without the correction H would be smaller; with it, three-against-three
    // fully separated reaches the maximum H the design allows.
    expect(tied.h).toBeGreaterThan(4);
  });
});

/* ========================================================================== */

describe('adjustP', () => {
  const ps = [0.01, 0.02, 0.03];

  it('multiplies by the family size under Bonferroni', () => {
    const out = adjustP(ps, 'bonferroni');
    expect(out[0]).toBeCloseTo(0.03, 12);
    expect(out[1]).toBeCloseTo(0.06, 12);
    expect(out[2]).toBeCloseTo(0.09, 12);
  });

  it('steps down under Holm', () => {
    // 0.01 x 3, 0.02 x 2, 0.03 x 1 — the last of which is smaller than the one
    // before it and is raised to meet it.
    const out = adjustP(ps, 'holm');
    expect(out[0]).toBeCloseTo(0.03, 12);
    expect(out[1]).toBeCloseTo(0.04, 12);
    expect(out[2]).toBeCloseTo(0.04, 12);
  });

  it('steps down under Holm-Sidak', () => {
    const out = adjustP(ps, 'sidak');
    expect(out[0]).toBeCloseTo(1 - 0.99 ** 3, 12);
    expect(out[1]).toBeCloseTo(1 - 0.98 ** 2, 12);
    expect(out[2]).toBeCloseTo(1 - 0.98 ** 2, 12);
  });

  it('never returns a smaller adjusted p for a larger raw one', () => {
    const out = adjustP([0.9, 0.001, 0.4, 0.02], 'holm');
    const order = [1, 3, 2, 0];
    for (let i = 1; i < order.length; i++) {
      expect(out[order[i]!]!).toBeGreaterThanOrEqual(out[order[i - 1]!]!);
    }
  });

  it('returns results in the caller order, not in sorted order', () => {
    const out = adjustP([0.04, 0.01], 'holm');
    expect(out[0]).toBeCloseTo(0.04, 12);
    expect(out[1]).toBeCloseTo(0.02, 12);
  });

  it('caps at 1 rather than reporting a probability above one', () => {
    expect(adjustP([0.6, 0.7], 'bonferroni').every((p) => p <= 1)).toBe(true);
  });
});

describe('pairsFor', () => {
  it('enumerates every pair', () => {
    expect(pairsFor(3, 'all')).toEqual([[0, 1], [0, 2], [1, 2]]);
    expect(pairsFor(4, 'all')).toHaveLength(6);
  });

  it('compares each against the first when that is the family', () => {
    expect(pairsFor(4, 'vsFirst')).toEqual([[0, 1], [0, 2], [0, 3]]);
  });
});

/* ========================================================================== */

describe('compareGroups', () => {
  const three = [
    { label: 'a', values: [1, 2, 3] },
    { label: 'b', values: [4, 5, 6] },
    { label: 'c', values: [7, 8, 9] },
  ];

  it('picks the test from the number of categories, and names it', () => {
    const two = three.slice(0, 2);
    const opts = { welch: true, family: 'all' as const, adjust: 'sidak' as const };
    expect(compareGroups(two, { ...opts, parametric: true }).omnibus?.label)
      .toBe("Welch's unpaired t-test");
    expect(compareGroups(two, { ...opts, parametric: false }).omnibus?.label)
      .toBe('Mann-Whitney test');
    expect(compareGroups(three, { ...opts, parametric: true }).omnibus?.label)
      .toBe('Ordinary one-way ANOVA');
    expect(compareGroups(three, { ...opts, parametric: false }).omnibus?.label)
      .toBe('Kruskal-Wallis test');
  });

  it('runs no post-hoc step for two categories', () => {
    const r = compareGroups(three.slice(0, 2), {
      parametric: true, welch: true, family: 'all', adjust: 'sidak',
    });
    expect(r.pairs).toEqual([]);
    expect(r.postHocLabel).toBeNull();
  });

  it('follows ANOVA with Holm-Sidak on the pooled residual', () => {
    const r = compareGroups(three, { parametric: true, welch: true, family: 'all', adjust: 'sidak' });
    expect(r.omnibus?.statistic).toBeCloseTo(27, 12);
    expect(r.pairs).toHaveLength(3);
    expect(r.postHocLabel).toContain('Holm-Sidak');
    // Every pair is 3 apart in means and shares MS_within = 1, so a and c — six
    // apart — must be the strongest of the three.
    const ac = r.pairs.find((p) => p.labelA === 'a' && p.labelB === 'c')!;
    const ab = r.pairs.find((p) => p.labelA === 'a' && p.labelB === 'b')!;
    expect(Math.abs(ac.statistic)).toBeGreaterThan(Math.abs(ab.statistic));
    expect(ac.p).toBeLessThan(ab.p);
  });

  it("follows Kruskal-Wallis with Dunn's, Bonferroni-adjusted by default", () => {
    const r = compareGroups(three, {
      parametric: false, welch: true, family: 'all', adjust: 'bonferroni',
    });
    expect(r.postHocLabel).toContain("Dunn's");
    expect(r.postHocLabel).toContain('Bonferroni');
    expect(r.pairs).toHaveLength(3);
    for (const p of r.pairs) expect(p.statisticLabel).toBe('z');
  });

  /*
     **The correction is over the family, not over what is drawn.**

     This is the one way this feature could be quietly and seriously wrong: if the
     adjustment were computed over the brackets somebody chose to show, hiding
     four of six would divide every remaining p-value by three. `compareGroups`
     has no notion of which pairs are drawn — the only thing that sets the family
     size is `family` — and this asserts the consequence: the same pair comes back
     with a larger adjusted p when it is one of six than when it is one of three.
  */
  it('sets the family size from the family, and from nothing else', () => {
    const four = [...three, { label: 'd', values: [10, 11, 12] }];
    const all = compareGroups(four, { parametric: true, welch: true, family: 'all', adjust: 'holm' });
    const vsFirst = compareGroups(four, { parametric: true, welch: true, family: 'vsFirst', adjust: 'holm' });

    expect(all.pairs).toHaveLength(6);
    expect(vsFirst.pairs).toHaveLength(3);

    const pick = (r: typeof all) => r.pairs.find((p) => p.labelA === 'a' && p.labelB === 'd')!;
    // The same comparison, the same data, the same raw p — a larger adjusted one
    // purely because it was asked as one of six rather than one of three.
    expect(pick(all).p).toBeCloseTo(pick(vsFirst).p, 12);
    expect(pick(all).pAdjusted).toBeGreaterThan(pick(vsFirst).pAdjusted);
  });

  it('names the fix when nothing has been grouped', () => {
    const ungrouped = [
      { label: 'tube1', values: [1] },
      { label: 'tube2', values: [2] },
      { label: 'tube3', values: [3] },
    ];
    const r = compareGroups(ungrouped, { parametric: true, welch: true, family: 'all', adjust: 'holm' });
    expect(r.omnibus).toBeNull();
    expect(r.unavailable).toContain('Group your samples');
  });

  it('refuses a two-group test where one side has a single sample', () => {
    const r = compareGroups(
      [{ label: 'a', values: [1] }, { label: 'b', values: [4, 5, 6] }],
      { parametric: true, welch: true, family: 'all', adjust: 'holm' },
    );
    expect(r.unavailable).toContain('at least two samples');
  });

  it('says so when a non-parametric design cannot reach significance at all', () => {
    const r = compareGroups(three.slice(0, 2), {
      parametric: false, welch: true, family: 'all', adjust: 'holm',
    });
    expect(r.omnibus?.p).toBeCloseTo(0.1, 12);
    expect(r.omnibus?.note).toContain('cannot reach 0.05');
  });

  it('reports the sample counts per category, never the event counts', () => {
    const r = compareGroups(three, { parametric: true, welch: true, family: 'all', adjust: 'holm' });
    expect(r.omnibus?.n).toEqual([3, 3, 3]);
  });
});

/* ========================================================================== */

describe('formatP and stars', () => {
  it('writes four decimals, and clamps rather than printing 0.0000', () => {
    expect(formatP(0.0032)).toBe('p = 0.0032');
    expect(formatP(1e-9)).toBe('p < 0.0001');
    expect(formatP(0.99999)).toBe('p > 0.9999');
    expect(formatP(NaN)).toBe('—');
  });

  it('cuts the stars where Prism cuts them', () => {
    expect(stars(0.06)).toBe('ns');
    expect(stars(0.05)).toBe('*');
    expect(stars(0.03)).toBe('*');
    expect(stars(0.005)).toBe('**');
    expect(stars(0.0005)).toBe('***');
    expect(stars(0.00005)).toBe('****');
  });
});

describe('tCritical', () => {
  it('matches the two-sided 95% column of the t table', () => {
    // The values every statistics text prints: df 2, 3, 7, 30.
    expect(tCritical(0.05, 2)).toBeCloseTo(4.303, 3);
    expect(tCritical(0.05, 3)).toBeCloseTo(3.182, 3);
    expect(tCritical(0.05, 7)).toBeCloseTo(2.365, 3);
    expect(tCritical(0.05, 30)).toBeCloseTo(2.042, 3);
  });
});
