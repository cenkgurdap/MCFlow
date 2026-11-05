import { describe, expect, it } from 'vitest';
import { channelStats, formatStat, STAT_DECIMALS, summariseGroup } from './statistics';

/* ==========================================================================
   Population statistics, and how they are written down.

   `formatStat` had no tests until 2026-08-11, which is how a magnitude ladder
   giving five different precisions survived beside an export that has always
   written four decimal places. Item 6 is the claim that the two agree, so it is
   asserted rather than described.
   ========================================================================== */

describe('formatStat — Item 6, four decimals for a parameter statistic', () => {
  it('writes four decimals whatever the magnitude', () => {
    expect(STAT_DECIMALS).toBe(4);
    // The reported case: a median of 0.455 on screen against 0.4551 in the file.
    expect(formatStat(0.45512, 'median')).toBe('0.4551');
    expect(formatStat(1.5, 'mean')).toBe('1.5000');
    expect(formatStat(142.25, 'geoMean')).toBe('142.2500');
    expect(formatStat(12500.5, 'sd')).toBe('12500.5000');
  });

  it('no longer abbreviates a large value into a different number', () => {
    // `4.20M` was a lossy rendering of a number the file carries in full, under
    // a heading that invites a comparison with it.
    const s = formatStat(4_200_000.125, 'mean');
    expect(s).not.toContain('M');
    expect(s).toBe('4200000.1250');
  });

  it('rounds the same way the export does', () => {
    for (const v of [0.12345, 1.000049, 987.65432, -0.00005]) {
      expect(formatStat(v, 'median')).toBe(v.toFixed(4));
    }
  });

  it('leaves counts and percentages alone', () => {
    // Neither is a parameter value, and neither is what the export's four
    // decimals apply to.
    expect(formatStat(15333, 'count')).toBe('15 333');
    expect(formatStat(89.9765, 'percentParent')).toBe('89.98');
    expect(formatStat(12.3456, 'cv')).toBe('12.35');
  });

  it('says nothing rather than zero for an empty population', () => {
    expect(formatStat(NaN, 'median')).toBe('—');
    expect(formatStat(Infinity, 'mean')).toBe('—');
  });
});

describe('summariseGroup — what the compare chart plots', () => {
  it('reports the mean and the sample SD', () => {
    const s = summariseGroup('g', [2, 4, 6]);
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(4, 12);
    // n−1 in the denominator: these are replicates, not a population.
    expect(s.sd).toBeCloseTo(2, 12);
  });

  it('gives a single sample no spread, so its error bar has no length', () => {
    const s = summariseGroup('g', [7]);
    expect(s.n).toBe(1);
    expect(s.mean).toBe(7);
    expect(s.sd).toBe(0);
  });

  it('drops non-finite values rather than poisoning the mean', () => {
    const s = summariseGroup('g', [1, NaN, 3]);
    expect(s.n).toBe(2);
    expect(s.values).toEqual([1, 3]);
    expect(s.mean).toBe(2);
  });

  /*
     The error bar can reach past the data, which is why the chart takes its
     extent over mean ± sd as well as over the points. Two samples far apart is
     the case that produces it.
  */
  it('can put mean ± sd outside the range of the values', () => {
    const s = summariseGroup('g', [0, 10]);
    expect(s.mean - s.sd).toBeLessThan(0);
    expect(s.mean + s.sd).toBeGreaterThan(10);
  });
});

describe('channelStats', () => {
  it('returns NaN rather than 0 for an empty selection', () => {
    const st = channelStats(new Float32Array([1, 2, 3]), new Uint8Array([0, 0, 0]));
    expect(st.count).toBe(0);
    expect(Number.isNaN(st.mean)).toBe(true);
    expect(Number.isNaN(st.median)).toBe(true);
  });
});

describe('summariseGroup — error bars', () => {
  it('reports the SEM and the 95% confidence half-width beside the SD', () => {
    const s = summariseGroup('A', [1, 2, 3, 4]);
    expect(s.sd).toBeCloseTo(1.2910, 4);
    expect(s.sem).toBeCloseTo(0.6455, 4);
    // t(0.975, 3) = 3.182
    expect(s.ci95).toBeCloseTo(3.1824 * 0.6455, 3);
    expect(Number.isNaN(summariseGroup('B', [5]).sem)).toBe(true);
  });
});
