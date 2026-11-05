import { describe, expect, it } from 'vitest';
import { summariseGroup } from '@/core/statistics';
import {
  beeswarm, composeCompareFigure, DEFAULT_COMPARE_OPTIONS, summaryExtent, summaryLabel, tickText,
  type CompareModel,
} from './compareFigure';
import { DEFAULT_FIGURE_STYLE, ptToPx } from './style';
import { measureText } from './measure';

const model = (spread = 0.01): CompareModel => ({
  categories: [
    { label: 'Control', color: '#0072B2', points: [0.441, 0.452, 0.447].map((v, i) => ({ value: v, name: `Control${i}` })), summary: summariseGroup('Control', [0.441, 0.452, 0.447]) },
    { label: 'Treated', color: '#D55E00', points: [0.401, 0.392 + spread, 0.398].map((v, i) => ({ value: v, name: `Treated${i}` })), summary: summariseGroup('Treated', [0.401, 0.392 + spread, 0.398]) },
  ],
  yTitle: 'Median — membrane order',
  brackets: [{ a: 0, b: 1, label: 'P = 0.0012' }],
  title: 'Cells',
  notes: ['Test: Welch’s t-test, two-sided.'],
});

describe('the Compare figure', () => {
  const fig = composeCompareFigure(model(), DEFAULT_FIGURE_STYLE, DEFAULT_COMPARE_OPTIONS);

  it('draws every point before the bars, so no bar is hidden', () => {
    const lastPoint = fig.svg.lastIndexOf('data-fig-point');
    const firstBar = fig.svg.indexOf('data-fig-layer="summary"');
    expect(lastPoint).toBeGreaterThan(0);
    expect(firstBar).toBeGreaterThan(lastPoint);
  });

  it('fills points translucently with no edge by default — no halo', () => {
    expect(fig.svg).toMatch(/<circle[^>]*fill="#0072B2" fill-opacity="0\.6" stroke="none"/);
    expect(fig.svg).not.toContain('stroke="#ffffff"');
  });

  it('labels the y axis with its quantity and prints no trailing zeros', () => {
    expect(fig.svg).toContain('>Median — membrane order<');
    const ticks = [...fig.svg.matchAll(/data-fig-tick="y">([^<]+)</g)].map((m) => m[1]!);
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.every((t) => !/\.\d*0$/.test(t))).toBe(true);
  });

  it('shows n per category, and the bracket text as given', () => {
    expect(fig.svg.match(/data-fig-n="[^"]+">n = 3</g)).toHaveLength(2);
    expect(fig.svg).toContain('>P = 0.0012<');
  });

  it('says in the notes what the points and bars are', () => {
    expect(fig.notes).toContain('Points: one per sample. Bars: mean ± SD.');
    expect(fig.notes).toContain('n per category: Control 3, Treated 3.');
  });

  it('sets its type at the style’s sizes', () => {
    const sizes = [...fig.svg.matchAll(/<text[^>]*font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    const allowed = [7, 8, 9].map(ptToPx);
    expect(sizes.every((s) => allowed.some((a) => Math.abs(a - s) < 0.01))).toBe(true);
  });
});

describe('the summary', () => {
  const s = summariseGroup('A', [1, 2, 3, 4]);
  it('draws the error bar it is asked for', () => {
    expect(summaryExtent(s, { centre: 'mean', spread: 'sd' }).hi - 2.5).toBeCloseTo(s.sd, 9);
    expect(summaryExtent(s, { centre: 'mean', spread: 'sem' }).hi - 2.5).toBeCloseTo(s.sem, 9);
    expect(summaryExtent(s, { centre: 'mean', spread: 'ci95' }).hi - 2.5).toBeCloseTo(s.ci95, 9);
    expect(summaryExtent(s, { centre: 'median', spread: 'iqr' })).toEqual({ centre: s.median, lo: s.q1, hi: s.q3 });
    expect(summaryLabel({ centre: 'mean', spread: 'ci95' })).toBe('mean with 95% confidence interval');
  });
});

describe('the pieces', () => {
  it('trims tick values to the decimals their step needs', () => {
    expect(tickText(0.35, 0.05)).toBe('0.35');
    expect(tickText(0.4, 0.05)).toBe('0.4');
    expect(tickText(12.5, 2.5)).toBe('12.5');
    expect(tickText(-0.2, 0.1)).toBe('−0.2');
  });

  it('places beeswarm points so that none overlap', () => {
    const values = [5, 5, 5, 5.01, 5.02, 6, 6, 6, 6, 6];
    const toY = (v: number) => 100 - v * 10;
    const d = 6;
    const xs = beeswarm(values, toY, d);
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        expect(Math.hypot(xs[i]! - xs[j]!, toY(values[i]!) - toY(values[j]!))).toBeGreaterThanOrEqual(d * 0.97);
      }
    }
    // The same input gives the same placement.
    expect(beeswarm(values, toY, d)).toEqual(xs);
  });
});

describe('long category names', () => {
  it('rotate, and the first one stays on the page', () => {
    const long = (label: string, values: number[]) => ({
      label, color: '#0072B2', points: values.map((v, i) => ({ value: v, name: `${label}${i}` })), summary: summariseGroup(label, values),
    });
    const fig = composeCompareFigure({
      categories: [long('A very long category name one', [1, 2]), long('A very long category name two', [2, 3]), long('Three', [3, 4])],
      yTitle: 'Count', brackets: [], title: '', notes: [],
    }, { ...DEFAULT_FIGURE_STYLE, size: { ...DEFAULT_FIGURE_STYLE.size, widthMm: 85 } }, DEFAULT_COMPARE_OPTIONS);
    const first = /<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*rotate\(-40[^>]*>A very long category name one</.exec(fig.svg);
    expect(first).not.toBeNull();
    const width = measureText('A very long category name one', ptToPx(DEFAULT_FIGURE_STYLE.font.tickPt), DEFAULT_FIGURE_STYLE.font.family);
    expect(Number(first![1]) - width * Math.cos((40 * Math.PI) / 180)).toBeGreaterThan(0);
  });
});
