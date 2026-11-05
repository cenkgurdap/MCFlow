import { describe, expect, it } from 'vitest';
import {
  createTransform, decadeLabel, defaultTransformKind, formatTick, siPrefixFor, splitDecadeLabel,
  linearTicks, niceStep, transformColumn,
} from './index';

describe('niceStep', () => {
  it.each([
    [0.7, 1], [1, 1], [1.5, 2], [2, 2], [3, 5], [5, 5], [7, 10], [10, 10],
    [17, 20], [230, 500], [1_100_000, 2_000_000], [0.023, 0.05],
  ])('niceStep(%f) = %f', (input, expected) => {
    expect(niceStep(input)).toBeCloseTo(expected, 10);
  });

  it('never returns zero or NaN for degenerate input', () => {
    for (const v of [0, -1, NaN, Infinity]) expect(niceStep(v)).toBe(1);
  });
});

describe('linearTicks', () => {
  it('produces round numbers covering the range', () => {
    expect(linearTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('stays inside the domain', () => {
    for (const t of linearTicks(13, 87, 6)) {
      expect(t).toBeGreaterThanOrEqual(13);
      expect(t).toBeLessThanOrEqual(87);
    }
  });

  it('handles an Aurora scatter range without drifting', () => {
    const ticks = linearTicks(0, 4_194_304, 5);
    expect(ticks[0]).toBe(0);
    expect(ticks.length).toBeGreaterThan(2);
    // Spacing must stay exactly uniform — accumulating += step drifts.
    const step = ticks[1]! - ticks[0]!;
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]! - ticks[i - 1]!).toBeCloseTo(step, 6);
    }
  });

  it('returns nothing for an inverted or empty domain', () => {
    expect(linearTicks(10, 10, 5)).toEqual([]);
    expect(linearTicks(10, 0, 5)).toEqual([]);
  });

  it('terminates on a degenerate target count', () => {
    expect(linearTicks(0, 1, 0)).toEqual([]);
  });
});

describe('formatTick', () => {
  it.each([
    [0, 1, '0'],
    [1_000_000, 1_000_000, '1M'],
    [4_000_000, 1_000_000, '4M'],
    [2_500_000, 500_000, '2.5M'],
    [50_000, 10_000, '50k'],
    [750, 250, '750'],
    [0.5, 0.1, '0.5'],
  ])('formatTick(%f, %f) = %s', (v, step, expected) => {
    expect(formatTick(v, step)).toBe(expected);
  });

  it('labels a whole axis in one prefix rather than one per tick', () => {
    // The Aurora's FSC-A range at a half-million step: it used to read
    // 0, 500K, 1M, 1.5M … — three notations on one axis.
    const ticks = createTransform({ kind: 'linear', range: 4_194_304 }).ticks(10, [0, 4_194_304]);
    const labels = ticks.map((t) => t.label);
    expect(labels.slice(0, 4)).toEqual(['0', '0.5M', '1M', '1.5M']);
    expect(labels.every((l) => l === '0' || l.endsWith('M'))).toBe(true);
  });

  it('keeps plain numbers where four digits are shorter than a prefix', () => {
    expect(siPrefixFor([0, 1000, 2000, 3000], 1000)).toBe('');
    expect(siPrefixFor([0, 50_000, 100_000, 250_000], 50_000)).toBe('k');
    expect(siPrefixFor([0, 1_000_000, 4_000_000], 1_000_000)).toBe('M');
  });
});

describe('decadeLabel', () => {
  it('renders superscript exponents', () => {
    expect(decadeLabel(0)).toBe('10⁰');
    expect(decadeLabel(4)).toBe('10⁴');
    expect(decadeLabel(-2)).toBe('10⁻²');
  });
});

describe('splitDecadeLabel', () => {
  /*
     The renderer needs to know where the exponent starts so it can draw it at a
     size somebody can read — a Unicode superscript is 58% of the digit height
     and thinner-stroked, which at 9.5 px is a smudge. The string itself is
     unchanged, so nothing that stores, compares or exports a label moves.
  */
  it.each([
    ['10⁴', '10', '4'],
    ['10⁰', '10', '0'],
    ['10⁻²', '10', '-2'],
    // A signed axis writes the minus in front of the mantissa, not in the
    // exponent — so the two forms above and below must both come apart cleanly.
    ['-10³', '-10', '3'],
  ])('%s splits into %s and %s', (label, base, exponent) => {
    expect(splitDecadeLabel(label)).toEqual({ base, exponent });
  });

  it.each(['0', '', '1M', '250', '-0.5', '2.5e3'])('leaves %s alone', (label) => {
    expect(splitDecadeLabel(label)).toEqual({ base: label, exponent: '' });
  });

  it('round-trips every decade a log axis can emit', () => {
    for (let e = -3; e <= 7; e++) {
      const { base, exponent } = splitDecadeLabel(decadeLabel(e));
      expect(base).toBe('10');
      expect(Number(exponent)).toBe(e);
    }
  });
});

describe('linear transform', () => {
  const t = createTransform({ kind: 'linear', range: 4_194_304 });

  it('is the identity', () => {
    for (const v of [0, 1, -5, 1e6]) {
      expect(t.forward(v)).toBe(v);
      expect(t.inverse(v)).toBe(v);
    }
  });

  it('spans the parameter range', () => {
    expect(t.displayDomain).toEqual([0, 4_194_304]);
  });

  it('labels ticks compactly', () => {
    const labels = t.ticks(5).map((k) => k.label);
    expect(labels[0]).toBe('0');
    expect(labels.some((l) => l.endsWith('M'))).toBe(true);
  });
});

describe('log transform', () => {
  const t = createTransform({ kind: 'log', range: 1e4, decades: 4 });

  it('maps decades to unit steps in display space', () => {
    expect(t.forward(1e4)).toBeCloseTo(4, 10);
    expect(t.forward(1e3)).toBeCloseTo(3, 10);
    expect(t.forward(1e2)).toBeCloseTo(2, 10);
    expect(t.forward(1)).toBeCloseTo(0, 10);
  });

  it('round-trips through inverse', () => {
    for (const v of [1, 10, 500, 9999]) {
      expect(t.inverse(t.forward(v))).toBeCloseTo(v, 4);
    }
  });

  it('is monotonic, so gate ordering survives the transform', () => {
    let prev = -Infinity;
    for (let v = -500; v < 1e4; v += 37) {
      const d = t.forward(v);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('clamps zero and negatives to the axis floor rather than producing NaN', () => {
    for (const v of [0, -1, -612.2, -1e6]) {
      const d = t.forward(v);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBe(0);
    }
  });

  it('emits labelled decade ticks and unlabelled minor ticks', () => {
    const ticks = t.ticks(5);
    const major = ticks.filter((k) => !k.minor);
    expect(major.map((k) => k.label)).toContain('10⁴');
    expect(ticks.some((k) => k.minor)).toBe(true);
    expect(ticks.filter((k) => k.minor).every((k) => k.label === '')).toBe(true);
  });
});

describe('defaultTransformKind', () => {
  it.each([
    ['Time', 'linear'],
    ['Forward_Scatter', 'linear'],
    ['Side_Scatter', 'linear'],
    // A derived parameter's units are whatever its expression makes them —
    // a ratio lives in [-1, 1] — so there is no dynamic range to compress.
    ['Derived', 'linear'],
    // Fluorescence defaults to biexponential, not log and not logicle. Log is
    // simply wrong: real channels carry negatives (R1-A reaches -612 in the test
    // files) which a log axis stacks onto the bottom edge as an uninterpretable
    // line. Between the signed transforms, biexponential is what FlowJo and FCS
    // Express open a fluorescence channel with, so it is what a cytometrist
    // expects to see; logicle remains one click away on the axis.
    ['Raw_Fluorescence', 'biexponential'],
    ['Unmixed_Fluorescence', 'biexponential'],
    // A compensated channel is a fluorescence measurement like any other, and
    // it reads below zero for the same reason: the subtraction that removes
    // spillover routinely takes a dim channel under it.
    ['Compensated_Fluorescence', 'biexponential'],
    ['Other', 'biexponential'],
  ])('%s -> %s', (type, expected) => {
    expect(defaultTransformKind(type)).toBe(expected);
  });
});

describe('transformColumn', () => {
  it('applies the transform elementwise into a new array', () => {
    const t = createTransform({ kind: 'log', range: 1e4, decades: 4 });
    const src = Float32Array.from([1, 10, 100, 1000, 10000]);
    const out = transformColumn(src, t);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).not.toBe(src);
    expect(Array.from(out).map((v) => Math.round(v))).toEqual([0, 1, 2, 3, 4]);
    // Source must be untouched — it is the cached raw column.
    expect(Array.from(src)).toEqual([1, 10, 100, 1000, 10000]);
  });

  it('leaves no non-finite values behind for real-world negatives', () => {
    const t = createTransform({ kind: 'log', range: 4_194_304 });
    const out = transformColumn(Float32Array.from([-612.2, -1, 0, 1, 1e6]), t);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('unimplemented transforms degrade instead of throwing', () => {
  it.each(['biexponential', 'logicle', 'hyperlog', 'asinh'] as const)('%s falls back to log', (kind) => {
    const t = createTransform({ kind, range: 1e4, decades: 4 });
    expect(Number.isFinite(t.forward(1000))).toBe(true);
    expect(t.ticks(5).length).toBeGreaterThan(0);
  });
});
