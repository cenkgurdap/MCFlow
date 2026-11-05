import { describe, expect, it } from 'vitest';
import {
  boundariesFor, boundaryBetween, componentDensityAt, densityAt, empiricalShares, fitFixed,
  fitMixture, histogram, intervalsFor, populationStats, rejectionFor, selectMixture, separation,
  MAX_COMPONENTS, MAX_FIT_COMPONENTS, MIN_COMPONENT_WEIGHT, MIN_SEPARATION,
  type MixtureComponent,
} from './mixture';
import { maxComponentsFor } from './properties';
// Seeded distributions whose answer is known — see the note in `synthetic.ts`.
import { mixture } from './synthetic';

const AXIS = { min: -1, max: 1, bins: 256 };

describe('histogram', () => {
  it('bins over the stated range and counts what lands in it', () => {
    const h = histogram(Float32Array.from([-0.5, 0, 0.5]), AXIS)!;
    expect(h.total).toBe(3);
    expect(h.counts.length).toBe(256);
    expect(h.width).toBeCloseTo(2 / 256, 12);
  });

  it('drops out-of-range values rather than clamping them', () => {
    // The case this exists for: a 0/0 event on a ratio parameter. Clamped, it
    // would be a spike in the first bin that the fit models as a population.
    const h = histogram(Float32Array.from([0, 0, 4, -9, NaN, Infinity]), AXIS)!;
    expect(h.total).toBe(2);
  });

  it('is null when nothing lands in the range, rather than an empty fit', () => {
    expect(histogram(Float32Array.from([5, 6]), AXIS)).toBeNull();
    expect(histogram(Float32Array.from([0]), { min: 1, max: 1 })).toBeNull();
  });

  it('honours a subset, so the fit runs on a gated population', () => {
    const values = Float32Array.from([0.1, 0.9, 0.2, 0.8]);
    const h = histogram(values, { ...AXIS, subset: Uint32Array.from([0, 2]) })!;
    expect(h.total).toBe(2);
  });
});

describe('fitMixture', () => {
  it('recovers one component from one Gaussian', () => {
    const h = histogram(mixture([{ n: 20000, mean: 0.4, sd: 0.05 }]), AXIS)!;
    const fit = fitMixture(h, 1);
    expect(fit.components).toHaveLength(1);
    expect(fit.components[0]!.mean).toBeCloseTo(0.4, 2);
    expect(fit.components[0]!.sd).toBeCloseTo(0.05, 2);
    expect(fit.components[0]!.weight).toBeCloseTo(1, 6);
    expect(fit.boundaries).toEqual([]);
  });

  it('recovers two components, their weights and their means', () => {
    const h = histogram(mixture([
      { n: 15000, mean: 0.45, sd: 0.05 },
      { n: 5000, mean: 0.10, sd: 0.06 },
    ]), AXIS)!;
    const fit = fitMixture(h, 2);
    expect(fit.components[0]!.mean).toBeCloseTo(0.45, 2);
    expect(fit.components[1]!.mean).toBeCloseTo(0.10, 2);
    expect(fit.components[0]!.weight).toBeCloseTo(0.75, 2);
    expect(fit.components[1]!.weight).toBeCloseTo(0.25, 2);
  });

  it('orders components by descending mean, whatever order they were generated in', () => {
    const h = histogram(mixture([
      { n: 4000, mean: -0.5, sd: 0.06 },
      { n: 8000, mean: 0.5, sd: 0.06 },
      { n: 6000, mean: 0.0, sd: 0.06 },
    ]), AXIS)!;
    const fit = fitMixture(h, 3);
    const means = fit.components.map((c) => c.mean);
    expect(means[0]!).toBeGreaterThan(means[1]!);
    expect(means[1]!).toBeGreaterThan(means[2]!);
  });

  it('is deterministic — the same data gives the same fit twice', () => {
    // The property the whole module rests on. A random start would make one
    // file report two populations on Monday and three on Tuesday.
    const h = histogram(mixture([
      { n: 9000, mean: 0.4, sd: 0.05 },
      { n: 3000, mean: 0.0, sd: 0.07 },
    ]), AXIS)!;
    expect(fitMixture(h, 2)).toEqual(fitMixture(h, 2));
  });

  it('floors the spread at one bin, so a single tall bin cannot diverge', () => {
    // Every event in one place. Without the floor the variance goes to zero and
    // the likelihood is unbounded — the classic Gaussian-mixture failure, which
    // presents as a suspiciously excellent BIC on a one-bin "population".
    const h = histogram(Float32Array.from(new Array(5000).fill(0.25)), AXIS)!;
    const fit = fitMixture(h, 1);
    expect(fit.components[0]!.sd).toBeGreaterThanOrEqual(h.width);
    expect(Number.isFinite(fit.logLikelihood)).toBe(true);
    expect(Number.isFinite(fit.bic)).toBe(true);
  });

  it('penalises 3k − 1 free parameters, which is what makes BIC a criterion', () => {
    const h = histogram(mixture([{ n: 8000, mean: 0.3, sd: 0.08 }]), AXIS)!;
    const one = fitMixture(h, 1);
    const two = fitMixture(h, 2);
    // Reconstruct the penalty from the two numbers rather than restating the
    // formula: (bic + 2·logL) / log n is the parameter count.
    const params = (f: typeof one) => (f.bic + 2 * f.logLikelihood) / Math.log(h.total);
    expect(params(one)).toBeCloseTo(2, 6);
    expect(params(two)).toBeCloseTo(5, 6);
  });

  it('converges rather than running to the iteration cap on ordinary data', () => {
    const h = histogram(mixture([
      { n: 9000, mean: 0.45, sd: 0.05 },
      { n: 4000, mean: 0.05, sd: 0.06 },
    ]), AXIS)!;
    const fit = fitMixture(h, 2);
    expect(fit.converged).toBe(true);
    expect(fit.iterations).toBeLessThan(300);
  });
});

describe('boundaryBetween', () => {
  const at = (mean: number, sd: number, weight: number): MixtureComponent => ({ mean, sd, weight });

  it('splits two equal Gaussians at their midpoint', () => {
    expect(boundaryBetween(at(0, 0.1, 0.5), at(1, 0.1, 0.5))).toBeCloseTo(0.5, 6);
  });

  it('gives the broader population more of the gap', () => {
    // Not the midpoint, and that is the point: an event between a tight
    // population and a broad one is more likely to have come from the broad one.
    const b = boundaryBetween(at(0, 0.05, 0.5), at(1, 0.25, 0.5));
    expect(b).toBeLessThan(0.5);
    expect(b).toBeGreaterThan(0);
  });

  it('moves towards the rarer population as the weights diverge', () => {
    const even = boundaryBetween(at(0, 0.1, 0.5), at(1, 0.1, 0.5));
    const lopsided = boundaryBetween(at(0, 0.1, 0.95), at(1, 0.1, 0.05));
    expect(lopsided).toBeGreaterThan(even);
  });

  it('always lands between the two means', () => {
    for (const [sdA, sdB, wA] of [[0.02, 0.4, 0.5], [0.4, 0.02, 0.5], [0.1, 0.1, 0.999], [0.3, 0.05, 0.001]]) {
      const b = boundaryBetween(at(0.1, sdA!, wA!), at(0.8, sdB!, 1 - wA!));
      expect(b).toBeGreaterThanOrEqual(0.1);
      expect(b).toBeLessThanOrEqual(0.8);
    }
  });

  it('is the point where the two weighted densities are equal', () => {
    const a = at(0.1, 0.06, 0.7);
    const b = at(0.6, 0.12, 0.3);
    const x = boundaryBetween(a, b);
    const d = (c: MixtureComponent) =>
      (c.weight / c.sd) * Math.exp(-0.5 * ((x - c.mean) / c.sd) ** 2);
    expect(d(a)).toBeCloseTo(d(b), 6);
  });

  it('ascends, while the components it came from descend', () => {
    const components = [at(0.6, 0.05, 0.4), at(0.2, 0.05, 0.4), at(-0.2, 0.05, 0.2)];
    const b = boundariesFor(components);
    expect(b).toHaveLength(2);
    expect(b[0]!).toBeLessThan(b[1]!);
  });
});

describe('intervalsFor', () => {
  const components = [
    { mean: 0.6, sd: 0.05, weight: 0.4 },
    { mean: 0.2, sd: 0.05, weight: 0.4 },
    { mean: -0.2, sd: 0.05, weight: 0.2 },
  ];
  const fit = {
    components, k: 3, logLikelihood: 0, bic: 0,
    boundaries: boundariesFor(components), converged: true, iterations: 1, total: 100,
  };

  it('gives the highest population an open top and the lowest an open bottom', () => {
    const iv = intervalsFor(fit);
    expect(iv[0]!.max).toBe(Number.POSITIVE_INFINITY);
    expect(iv[2]!.min).toBe(Number.NEGATIVE_INFINITY);
  });

  it('abuts — one population ends exactly where the next begins', () => {
    const iv = intervalsFor(fit);
    expect(iv[0]!.min).toBe(iv[1]!.max);
    expect(iv[1]!.min).toBe(iv[2]!.max);
  });

  it('orders like the components, highest first', () => {
    const iv = intervalsFor(fit);
    expect(iv[0]!.min).toBeGreaterThan(iv[1]!.min);
  });
});

describe('rejectionFor', () => {
  const build = (components: MixtureComponent[]) => ({
    components, k: components.length, logLikelihood: 0, bic: 0,
    boundaries: boundariesFor(components), converged: true, iterations: 1, total: 1000,
  });

  it('never refuses one component — it holds everything and is separated from nothing', () => {
    expect(rejectionFor(build([{ mean: 0, sd: 0.1, weight: 1 }]))).toBeUndefined();
  });

  it('refuses a component too small to be a population', () => {
    const fit = build([
      { mean: 0.5, sd: 0.05, weight: 0.995 },
      { mean: -0.5, sd: 0.05, weight: 0.005 },
    ]);
    expect(rejectionFor(fit)).toBe('weight');
  });

  it('refuses two components too close to be told apart', () => {
    const fit = build([
      { mean: 0.30, sd: 0.10, weight: 0.5 },
      { mean: 0.22, sd: 0.10, weight: 0.5 },
    ]);
    expect(rejectionFor(fit)).toBe('separation');
  });

  it('accepts the well-separated case, and refuses the overlapping one', () => {
    // The two measurements `MIN_SEPARATION` is set from. A genuine split at
    // ~1.75 pooled SDs is admitted; a spurious one at ~1.07 is not.
    const wide = { mean: 0.45, sd: 0.05, weight: 0.73 };
    const low = { mean: 0.20, sd: 0.11, weight: 0.27 };
    expect(separation(wide, low)).toBeGreaterThan(MIN_SEPARATION);
    expect(rejectionFor(build([wide, low]))).toBeUndefined();

    const a = { mean: 0.455, sd: 0.045, weight: 0.99 };
    const b = { mean: 0.394, sd: 0.06, weight: 0.01 };
    expect(separation(a, b)).toBeLessThan(MIN_SEPARATION);
    expect(rejectionFor(build([a, b]))).toBeDefined();
  });

  it('takes its thresholds from the caller, which is how the probe sweeps them', () => {
    const fit = build([
      { mean: 0.4, sd: 0.1, weight: 0.6 },
      { mean: 0.24, sd: 0.1, weight: 0.4 },
    ]);
    expect(rejectionFor(fit, { minSeparation: 2.0 })).toBe('separation');
    expect(rejectionFor(fit, { minSeparation: 1.0 })).toBeUndefined();
  });
});

describe('selectMixture', () => {
  it('finds one population in one Gaussian', () => {
    const h = histogram(mixture([{ n: 20000, mean: 0.4, sd: 0.06 }]), AXIS)!;
    expect(selectMixture(h).best.k).toBe(1);
  });

  it('finds two in two well-separated populations', () => {
    const h = histogram(mixture([
      { n: 14000, mean: 0.45, sd: 0.05 },
      { n: 6000, mean: 0.05, sd: 0.06 },
    ]), AXIS)!;
    const sel = selectMixture(h);
    expect(sel.best.k).toBe(2);
    expect(sel.best.components[0]!.mean).toBeGreaterThan(sel.best.components[1]!.mean);
  });

  it('finds three in three', () => {
    const h = histogram(mixture([
      { n: 10000, mean: 0.55, sd: 0.045 },
      { n: 6000, mean: 0.15, sd: 0.05 },
      { n: 4000, mean: -0.35, sd: 0.05 },
    ]), AXIS)!;
    expect(selectMixture(h).best.k).toBe(3);
  });

  it('does not force three onto a sample that has two', () => {
    // The requirement stated in the brief, and the reason the admissibility
    // rules exist at all: BIC on its own will keep adding components.
    const h = histogram(mixture([
      { n: 12000, mean: 0.45, sd: 0.05 },
      { n: 8000, mean: -0.05, sd: 0.06 },
    ]), AXIS)!;
    expect(selectMixture(h).best.k).toBe(2);
  });

  it('refuses a third population that holds almost nothing', () => {
    const h = histogram(mixture([
      { n: 20000, mean: 0.45, sd: 0.05 },
      { n: 8000, mean: 0.0, sd: 0.06 },
      { n: 30, mean: -0.7, sd: 0.04 },
    ]), AXIS)!;
    const sel = selectMixture(h);
    expect(sel.best.k).toBe(2);
    // Refused, and the *reason* is deliberately not asserted here: EM does not
    // necessarily find the 30-event population at all — a third component is as
    // likely to land on the shoulder of the main peak, which is refused on
    // separation instead. Both are correct refusals of the same claim. The two
    // reasons are tested directly against constructed fits above, where the
    // component the rule is about is the one under test rather than whichever
    // one the optimiser happened to produce.
    expect(sel.candidates[2]!.rejected).toBeDefined();
  });

  it('says when its answer is not the one BIC alone would give', () => {
    // A sharp peak on a broad pedestal, which is what a skewed population looks
    // like to a mixture: two Gaussians describe it far better than one, so BIC
    // prefers to split, and their means are a third of a pooled SD apart, so
    // there is no boundary between them that means anything. This is a skewed
    // single population with the contrast exaggerated, and it is the
    // case the panel has to be able to *account for* rather than merely announce
    // "1 population" about.
    const h = histogram(mixture([
      { n: 20000, mean: 0.45, sd: 0.03 },
      { n: 10000, mean: 0.42, sd: 0.14 },
    ]), AXIS)!;
    const sel = selectMixture(h);
    expect(sel.best.k).toBe(1);
    expect(sel.byBic).toBe(false);
    expect(sel.candidates[1]!.rejected).toBe('separation');
  });

  it('reports every candidate, so the panel can explain the choice', () => {
    const h = histogram(mixture([{ n: 9000, mean: 0.2, sd: 0.07 }]), AXIS)!;
    const sel = selectMixture(h);
    expect(sel.candidates.map((c) => c.fit.k)).toEqual([1, 2, 3]);
  });

  it('defaults to the graded ceiling and never exceeds the fitter\'s', () => {
    const h = histogram(mixture([{ n: 5000, mean: 0.2, sd: 0.07 }]), AXIS)!;
    // No ceiling stated: the graded reading's, which is the measured one.
    expect(selectMixture(h).candidates).toHaveLength(MAX_COMPONENTS);
    // A ceiling above what the fitter will run is clamped to it, not honoured.
    expect(selectMixture(h, { maxComponents: 9 }).candidates).toHaveLength(MAX_FIT_COMPONENTS);
  });

  it('honours the viability scheme\'s higher ceiling', () => {
    const h = histogram(mixture([{ n: 5000, mean: 0.2, sd: 0.07 }]), AXIS)!;
    expect(selectMixture(h, { maxComponents: maxComponentsFor('viability') })
      .candidates.map((c) => c.fit.k)).toEqual([1, 2, 3, 4]);
  });

  it('lets a small enough weight through when the caller lowers the bar', () => {
    const h = histogram(mixture([
      { n: 20000, mean: 0.5, sd: 0.045 },
      { n: 300, mean: -0.4, sd: 0.05 },
    ]), AXIS)!;
    expect(selectMixture(h).best.k).toBe(1);
    expect(selectMixture(h, { minWeight: 0.001 }).best.k).toBe(2);
  });
});

describe('fitFixed', () => {
  it('gives the stated count even where the automatic rules would refuse it', () => {
    // The override on Step 4. The admissibility rules keep the *automatic*
    // choice honest; applying them to a stated one would mean typing 3 and
    // silently getting 2.
    const h = histogram(mixture([{ n: 20000, mean: 0.3, sd: 0.08 }]), AXIS)!;
    expect(selectMixture(h).best.k).toBe(1);
    expect(fitFixed(h, 3).components).toHaveLength(3);
  });

  it('clamps to the allowed range rather than refusing', () => {
    const h = histogram(mixture([{ n: 4000, mean: 0.3, sd: 0.08 }]), AXIS)!;
    expect(fitFixed(h, 0).k).toBe(1);
    // The fitter's structural ceiling, not the graded reading's — a user who
    // states 4 under the viability scheme gets 4.
    expect(fitFixed(h, 12).k).toBe(MAX_FIT_COMPONENTS);
    expect(fitFixed(h, 4).components).toHaveLength(4);
  });
});

describe('reading a fit back', () => {
  const h = histogram(mixture([
    { n: 14000, mean: 0.45, sd: 0.05 },
    { n: 6000, mean: 0.0, sd: 0.06 },
  ]), AXIS)!;
  const fit = selectMixture(h).best;

  it('draws the curve in events per bin, so it can be laid over the bars', () => {
    // Integrating the curve over the bins recovers the event count. A curve
    // normalised to its own peak would sit on the distribution convincingly and
    // say nothing about whether the fit is any good.
    let area = 0;
    for (let i = 0; i < h.centres.length; i++) area += densityAt(fit, h.centres[i]!, h.width);
    expect(area).toBeCloseTo(h.total, -2);
  });

  it('draws each component on the same scale as the whole', () => {
    const x = 0.45;
    const parts = fit.components.reduce(
      (acc, _, i) => acc + componentDensityAt(fit, i, x, h.width), 0,
    );
    expect(parts).toBeCloseTo(densityAt(fit, x, h.width), 6);
    expect(componentDensityAt(fit, 99, x, h.width)).toBe(0);
  });

  it('reports what the gates will count, not what the model claims', () => {
    // Two overlapping populations always disagree: a component holding 30% of
    // the mixture owns more than 30% of the events once a boundary is drawn,
    // because it takes the part of its neighbour that fell on its side.
    const shares = empiricalShares(h, fit);
    expect(shares).toHaveLength(2);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(shares[0]!).toBeCloseTo(fit.components[0]!.weight, 1);
  });

  it('every event lands in exactly one population', () => {
    const shares = empiricalShares(h, fit);
    expect(shares.every((s) => s >= 0)).toBe(true);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('reports the mean of the events in each gate, not the fitted mean', () => {
    // The two are close on a clean fit, which is what makes the distinction easy
    // to miss: each population's *observed* mean is pulled toward the boundary by
    // whatever it took from its neighbour.
    const stats = populationStats(h, fit);
    expect(stats).toHaveLength(2);
    expect(stats[0]!.mean).toBeCloseTo(0.45, 1);
    expect(stats[1]!.mean).toBeCloseTo(0.0, 1);
    expect(stats.reduce((a, s) => a + s.count, 0)).toBe(h.total);
  });

  it('both numbers move when a boundary does — the fit’s own do not', () => {
    /*
       The regression for the dead readout under a draggable split.

       `moveBoundary` writes a new `boundaries` array and leaves `components`
       alone, deliberately: re-fitting on every pointer move is slow and a moving
       target. So anything a panel shows beside a boundary has to be read from
       the interval, not from the component — which is the bug this replaced,
       where the percentage and the membrane order stayed frozen while the line
       moved under them.
    */
    const before = populationStats(h, fit);
    const moved = { ...fit, boundaries: fit.boundaries.map((b) => b + 0.1) };
    const after = populationStats(h, moved);

    // Raising the split hands events from the upper population to the lower one.
    expect(after[0]!.share).toBeLessThan(before[0]!.share);
    expect(after[1]!.share).toBeGreaterThan(before[1]!.share);
    // And both means follow their own population's new extent.
    expect(after[0]!.mean).toBeGreaterThan(before[0]!.mean);
    expect(after[1]!.mean).toBeGreaterThan(before[1]!.mean);
    // The model said nothing new.
    expect(moved.components[0]!.mean).toBe(fit.components[0]!.mean);
  });

  it('an emptied population reports no mean rather than a zero', () => {
    // A boundary dragged off the end leaves one interval with nothing in it. A
    // mean of 0 there is a membrane order somebody could read as a measurement.
    const emptied = { ...fit, boundaries: fit.boundaries.map(() => 1.1) };
    const stats = populationStats(h, emptied);
    expect(stats[0]!.count).toBe(0);
    expect(Number.isNaN(stats[0]!.mean)).toBe(true);
    expect(stats[0]!.share).toBe(0);
  });
});

describe('multi-start EM', () => {
  /*
     The property the three starts exist for.

     A small, well-separated second population is the case a single quantile
     start gets wrong: the quantiles both land inside the dominant peak, and EM
     from there converges to a local optimum that puts both components on that
     peak and models the minority population as a tail. Seeding on the two modes
     of the smoothed histogram finds it, and `fitMixture` keeps whichever start
     reached the higher likelihood — so this asserts the answer rather than the
     mechanism.
  */
  const lopsided = histogram(
    mixture([{ n: 9200, mean: -0.35, sd: 0.06 }, { n: 800, mean: 0.45, sd: 0.05 }]),
    AXIS,
  )!;

  it('finds a minority population a single quantile start would miss', () => {
    const fit = fitMixture(lopsided, 2);
    const means = fit.components.map((c) => c.mean).sort((a, b) => a - b);
    expect(means[0]).toBeCloseTo(-0.35, 1);
    expect(means[1]).toBeCloseTo(0.45, 1);
    // And the split is admissible, so `selectMixture` can actually reach it.
    expect(rejectionFor(fit)).toBeUndefined();
    expect(selectMixture(lopsided).best.k).toBe(2);
  });

  it('is deterministic — the same histogram gives the same fit', () => {
    // The whole reason the restarts are stated rather than random. A population
    // count that changes between two runs of the same file is not a result.
    const a = fitMixture(lopsided, 3);
    const b = fitMixture(lopsided, 3);
    expect(a.components).toEqual(b.components);
    expect(a.logLikelihood).toBe(b.logLikelihood);
    expect(a.boundaries).toEqual(b.boundaries);
  });

  it('never scores worse than the quantile start alone', () => {
    // `fitMixture` keeps the best of the three by log-likelihood, so adding a
    // start cannot make the answer worse — which is what makes it safe to add
    // one. A unimodal distribution is where the extra starts have nothing to
    // find, and it must still converge to the obvious answer.
    const one = histogram(mixture([{ n: 8000, mean: 0.2, sd: 0.09 }]), AXIS)!;
    const fit = fitMixture(one, 1);
    expect(fit.components[0]!.mean).toBeCloseTo(0.2, 1);
    expect(selectMixture(one).best.k).toBe(1);
  });

  it('honours a component ceiling below MAX_COMPONENTS', () => {
    // What the viability scheme passes: two populations is the reading, so a
    // third must not be reachable however the distribution is shaped.
    const three = histogram(
      mixture([
        { n: 3000, mean: -0.5, sd: 0.05 },
        { n: 3000, mean: 0, sd: 0.05 },
        { n: 3000, mean: 0.5, sd: 0.05 },
      ]),
      AXIS,
    )!;
    expect(selectMixture(three).best.k).toBe(3);
    expect(selectMixture(three, { maxComponents: 2 }).best.k).toBe(2);
  });
});

describe('the two thresholds', () => {
  it('are stated as constants rather than buried in the selection', () => {
    // Both are read by the panel's own explanation of a refused fit; a literal inside `rejectionFor` would make
    // the number the panel prints and the number it applies two things.
    expect(MIN_COMPONENT_WEIGHT).toBeGreaterThan(0);
    expect(MIN_COMPONENT_WEIGHT).toBeLessThan(0.1);
    expect(MIN_SEPARATION).toBeGreaterThan(1);
    expect(MIN_SEPARATION).toBeLessThan(2);
  });
});
