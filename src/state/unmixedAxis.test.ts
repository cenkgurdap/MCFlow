import { describe, expect, it } from 'vitest';
import { attachUnmixed, detachUnmixed } from '@/core/unmixedColumns';
import { autoSpec, createTransform } from '@/core/transform';
import type { ParsedFcs } from '@/core/fcs/types';
import { axisDomainFor, parametersFor } from './derivedStore';

/* ==========================================================================
   2026-08-17 — an unmixed parameter's axis comes from its own distribution.

   The report: a plot with an unmixed abundance on an axis opens with the
   population squeezed into a band and most of the square empty, where the same
   plot on a raw detector fills it.

   The mechanism: `describeUnmixed` handed the column's
   **maximum** to the transform as its `$PnR` and `axisMinFor` handed it the
   **minimum**, and a least-squares abundance has a residual tail at both ends
   that a detector does not, so half the display axis could sit below the
   first percentile.

   These tests are written against that shape: a column whose bulk is small
   and which carries two extreme outliers.
   ========================================================================== */

/** Just enough of a `ParsedFcs` to be a registry key and a parameter list. */
function fakeSample(realParameters: number): ParsedFcs {
  return {
    metadata: {
      parameters: Array.from({ length: realParameters }, (_, i) => ({
        index: i + 1,
        name: `D${i + 1}`,
        stain: '',
        label: `D${i + 1}`,
        bits: 32,
        range: 4194304,
        amplification: [0, 0] as [number, number],
        gain: null,
        voltage: null,
        type: 'Raw_Fluorescence',
        isDataChannel: true,
      })),
      eventCount: 0,
      keywords: {},
    },
    data: new Float32Array(0),
  } as unknown as ParsedFcs;
}

/**
 * A column shaped like a real abundance: a negative population, a positive
 * population, and one outlier at each end four decades past everything else.
 */
function abundance(): Float32Array {
  const n = 10000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Half negative around −500, half positive around 20 000.
    out[i] = i % 2 === 0 ? -400 - (i % 200) : 18000 + (i % 4000);
  }
  out[0] = -1.49e6;
  out[1] = 8.58e5;
  return out;
}

const REAL = 3;

function withAbundance<T>(values: Float32Array, run: (parsed: ParsedFcs) => T): T {
  const parsed = fakeSample(REAL);
  attachUnmixed(parsed, {
    data: values,
    eventCount: values.length,
    labels: ['CD56 PerCP-eFluor 710'],
    columns: [0],
  });
  try { return run(parsed); } finally { detachUnmixed(parsed); }
}

describe('axisDomainFor', () => {
  it('is null for a real detector, which frames on its own data as it always has', () => {
    withAbundance(abundance(), (parsed) => {
      expect(axisDomainFor(parsed, 0, [])).toBeNull();
      expect(axisDomainFor(parsed, REAL - 1, [])).toBeNull();
    });
  });

  it('gives an unmixed parameter a domain that excludes the residual outliers', () => {
    withAbundance(abundance(), (parsed) => {
      const domain = axisDomainFor(parsed, REAL, [])!;
      expect(domain).not.toBeNull();
      // Well inside the extremes at both ends — that is the whole fix.
      expect(domain.min).toBeGreaterThan(-1.49e6);
      expect(domain.max).toBeLessThan(8.58e5);
      // And still holding the populations that matter.
      expect(domain.min).toBeLessThanOrEqual(-500);
      expect(domain.max).toBeGreaterThanOrEqual(22000);
    });
  });

  it('rounds outward to a round number, so two samples of a panel frame alike', () => {
    withAbundance(abundance(), (parsed) => {
      const { min, max } = axisDomainFor(parsed, REAL, [])!;
      const round = (v: number) => {
        const a = Math.abs(v);
        if (a === 0) return true;
        const mantissa = a / Math.pow(10, Math.floor(Math.log10(a)));
        return [1, 2, 5, 10].some((m) => Math.abs(mantissa - m) < 1e-9);
      };
      expect(round(min)).toBe(true);
      expect(round(max)).toBe(true);
    });
  });

  it('puts the floor below the negative population when there is one', () => {
    const values = new Float32Array(10000);
    for (let i = 0; i < values.length; i++) values[i] = i % 2 === 0 ? -500 - (i % 200) : 20000;
    withAbundance(values, (parsed) => {
      const { min } = axisDomainFor(parsed, REAL, [])!;
      expect(min).toBeLessThanOrEqual(-700);
    });
  });

  /*
     2026-08-18 — and follows the data upward when there is not.

     The floor was pinned at 0 whenever the trimmed low extent was positive, on
     the argument that an abundance's negative population lives below zero. It
     does — in a column that has one. For a dye every cell carries, the
     abundance has nothing underneath, and a floor of 0 on a biexponential axis
     spent most of the square on empty decades.
  */
  it('frames a wholly positive abundance where it is, not five decades below it', () => {
    const values = new Float32Array(10000);
    for (let i = 0; i < values.length; i++) values[i] = 85000 + (i % 60000) * 24;
    withAbundance(values, (parsed) => {
      const { min, max } = axisDomainFor(parsed, REAL, [])!;
      expect(min).toBeGreaterThan(0);
      // Under the population, but within a decade of it rather than at zero.
      expect(min).toBeLessThanOrEqual(85000);
      expect(min).toBeGreaterThanOrEqual(8500);
      expect(max).toBeGreaterThan(min);
    });
  });

  it('never gives a top of zero, which would draw nothing', () => {
    const allNegative = new Float32Array(1000).fill(-5000);
    withAbundance(allNegative, (parsed) => {
      expect(axisDomainFor(parsed, REAL, [])!.max).toBeGreaterThan(0);
    });
  });

  it('is what the parameter declares as its range, so the transform agrees', () => {
    withAbundance(abundance(), (parsed) => {
      const params = parametersFor(parsed, []);
      expect(params[REAL]!.type).toBe('Unmixed_Fluorescence');
      expect(params[REAL]!.range).toBe(axisDomainFor(parsed, REAL, [])!.max);
    });
  });

  /*
     The property the whole change is for, stated as a measurement rather than as
     a range: how much of the axis the middle 98% of the events occupies.

     Framing on the extremes gave 45% on the real CD56 column. The declared
     domain is by construction the axis, so the same fraction is computed against
     it here and has to be far higher.
  */
  /*
     2026-08-18 — the follow-up report: better, still not right.

     A residual tail is not two events. Trimming at the 0.1st and 99.9th
     percentiles removed the pair that made the axis absurd and left the band
     that made it merely wrong — a few hundred events in a hundred thousand,
     sitting a decade past the population, still setting the top. The trim is 1%
     now, so a straggler band thinner than that cannot reach the axis.
  */
  it('is not moved by a straggler band thinner than the trim', () => {
    const n = 10000;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) values[i] = 10000 + (i % 500);
    // 0.5% of the column, a decade above everything else. Inside the old 0.1%
    // trim at both ends, so it used to be the number the axis was built from.
    for (let i = 0; i < 50; i++) values[i] = 300000;

    withAbundance(values, (parsed) => {
      const { max } = axisDomainFor(parsed, REAL, [])!;
      expect(max).toBeGreaterThanOrEqual(10500);
      expect(max).toBeLessThan(300000);
    });
  });

  it('leaves the bulk of the events filling most of the axis', () => {
    withAbundance(abundance(), (parsed) => {
      const domain = axisDomainFor(parsed, REAL, [])!;
      const values = abundance();
      const spec = { ...autoSpec('biexponential', domain.max, values), min: domain.min };
      const tf = createTransform(spec);

      const sorted = Float64Array.from(values);
      sorted.sort();
      const at = (q: number) => sorted[Math.round(q * (sorted.length - 1))]!;

      const axis = tf.forward(domain.max) - tf.forward(domain.min);
      const bulk = tf.forward(at(0.99)) - tf.forward(at(0.01));
      expect(bulk / axis).toBeGreaterThan(0.75);
    });
  });
});

describe('the biexponential width basis', () => {
  it('ignores a negative tail that is not a population', () => {
    // 111 000 events, twelve of them negative and one of those far out — the
    // shape of a dye every cell carries. The old rule took
    // `negatives[floor(12 * 0.05)]`, which is index 0: the single most negative
    // value in the file. It came out at −9.35e6, four decades below anything
    // else in the column, and made the near-linear region wider than the data.
    const values = new Float32Array(111000).fill(4000);
    for (let i = 0; i < 12; i++) values[i] = -100;
    values[0] = -9.35e6;

    const spec = autoSpec('biexponential', 1e5, values);
    expect(spec.width).toBe(-10);
  });

  it('and the count guard alone was not enough, which is why it is a fraction', () => {
    // Twelve negatives clears `n < 10` outright. The old guard would have taken
    // the outlier here too; what makes them noise is that they are 0.01% of the
    // column, not that there are few of them in absolute terms.
    const values = new Float32Array(111000).fill(4000);
    for (let i = 0; i < 12; i++) values[i] = -9.35e6;
    expect(autoSpec('biexponential', 1e5, values).width).toBe(-10);
  });

  it('still takes the percentile when the negatives are a real population', () => {
    const values = new Float32Array(10000);
    for (let i = 0; i < 10000; i++) values[i] = i % 2 === 0 ? -300 - (i % 100) : 4000;
    const spec = autoSpec('biexponential', 1e5, values);
    expect(spec.width).toBeLessThan(-100);
  });
});
