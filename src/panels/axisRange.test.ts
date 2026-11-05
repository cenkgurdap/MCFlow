import { describe, expect, it } from 'vitest';
import { applyAxisLimits, isAxisLimited, AUTO_LIMITS } from './axisRange';

const FIT = { xMin: 0, xMax: 100, yMin: -10, yMax: 10 };

describe('applyAxisLimits', () => {
  it('shows the whole of the data when nothing is pinned', () => {
    expect(applyAxisLimits(FIT, AUTO_LIMITS)).toEqual(FIT);
  });

  it('applies both bounds of one axis', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: 20, xMax: 60 }))
      .toEqual({ xMin: 20, xMax: 60, yMin: -10, yMax: 10 });
  });

  it('takes one bound on its own — "everything below 10⁴" is a real request', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMax: 40 }))
      .toEqual({ xMin: 0, xMax: 40, yMin: -10, yMax: 10 });
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, yMin: 0 }))
      .toEqual({ xMin: 0, xMax: 100, yMin: 0, yMax: 10 });
  });

  it('leaves the other axis entirely alone', () => {
    const out = applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: 20, xMax: 60 });
    expect(out.yMin).toBe(FIT.yMin);
    expect(out.yMax).toBe(FIT.yMax);
  });

  it('extends past the data when asked — a stated range is not a crop', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: -500, xMax: 500 }))
      .toMatchObject({ xMin: -500, xMax: 500 });
  });

  it('discards an inverted or empty pair, for that axis alone', () => {
    // Half-applying it would draw an axis that disagrees with the numbers in the
    // fields that produced it.
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: 80, xMax: 20 }))
      .toMatchObject({ xMin: 0, xMax: 100 });
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: 50, xMax: 50 }))
      .toMatchObject({ xMin: 0, xMax: 100 });
    // …and the y axis, set legitimately in the same breath, still applies.
    expect(applyAxisLimits(FIT, { xMin: 80, xMax: 20, yMin: 0, yMax: 5 }))
      .toEqual({ xMin: 0, xMax: 100, yMin: 0, yMax: 5 });
  });

  it('discards a non-finite bound', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: Number.NaN, xMax: 60 }))
      .toMatchObject({ xMin: 0, xMax: 100 });
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMax: Number.POSITIVE_INFINITY }))
      .toMatchObject({ xMin: 0, xMax: 100 });
  });

  it('ignores y limits on a histogram, whose y axis is normalised density', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, yMin: 2, yMax: 8 }, true))
      .toEqual({ xMin: 0, xMax: 100, yMin: 0, yMax: 1 });
  });

  it('still applies the x limits on a histogram', () => {
    expect(applyAxisLimits(FIT, { ...AUTO_LIMITS, xMin: 20, xMax: 60 }, true))
      .toEqual({ xMin: 20, xMax: 60, yMin: 0, yMax: 1 });
  });

  it('is a pure function of its inputs — two panels given the same numbers frame the same thing', () => {
    // The property the whole feature exists for, and the one a gesture could
    // never offer.
    const limits = { ...AUTO_LIMITS, xMin: 12.5, xMax: 87.5 };
    expect(applyAxisLimits(FIT, limits)).toEqual(applyAxisLimits(FIT, limits));
    expect(applyAxisLimits({ ...FIT, xMax: 1e6 }, limits)).toMatchObject({ xMin: 12.5, xMax: 87.5 });
  });
});

describe('isAxisLimited', () => {
  it('is false when both ends are auto', () => {
    expect(isAxisLimited(AUTO_LIMITS, 'x')).toBe(false);
    expect(isAxisLimited(AUTO_LIMITS, 'y')).toBe(false);
  });

  it('is true when either end is stated', () => {
    expect(isAxisLimited({ ...AUTO_LIMITS, xMin: 0 }, 'x')).toBe(true);
    expect(isAxisLimited({ ...AUTO_LIMITS, xMax: 0 }, 'x')).toBe(true);
    expect(isAxisLimited({ ...AUTO_LIMITS, xMax: 0 }, 'y')).toBe(false);
  });

  it('counts a bound of zero, which is a value and not an absence', () => {
    expect(isAxisLimited({ ...AUTO_LIMITS, yMin: 0 }, 'y')).toBe(true);
  });
});
