import { beforeEach, describe, expect, it } from 'vitest';
import { composeCompareFigure } from '@/core/figure/compareFigure';
import { FIGURE_KINDS, type FigureKind } from '@/core/figure/style';
import type { GroupSummary } from '@/core/statistics';
import { useFigure } from './figureStore';

/*
   Settings per figure type (0.35). The report: a density plot's settings were
   applied to the Compare chart, because every type read one style. Each type
   now has its own; only the typeface and the width are shared.
*/

const summary = (values: number[]): GroupSummary => {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const sorted = [...values].sort((a, b) => a - b);
  return { n, mean, sd, sem: sd / Math.sqrt(n), ci95: 2 * sd, median: sorted[1]!, q1: sorted[0]!, q3: sorted[2]!, min: sorted[0]!, max: sorted[2]!, values } as unknown as GroupSummary;
};
const compare = (kind: FigureKind) => composeCompareFigure({
  categories: [
    { label: 'A', color: '#0072B2', points: [0.3, 0.32, 0.31].map((value, i) => ({ value, name: `a${i}` })), summary: summary([0.3, 0.32, 0.31]) },
    { label: 'B', color: '#D55E00', points: [0.2, 0.22, 0.25].map((value, i) => ({ value, name: `b${i}` })), summary: summary([0.2, 0.22, 0.25]) },
  ],
  yTitle: 'Median — membrane order', brackets: [], title: 'x', notes: [],
}, useFigure.getState().styles[kind]).svg;

describe('figure settings are per type', () => {
  beforeEach(() => useFigure.getState().resetAll());

  it('a change to one type leaves every other type, and its figure, untouched', () => {
    const before = Object.fromEntries(FIGURE_KINDS.map((k) => [k, JSON.stringify(useFigure.getState().styles[k])]));
    const compareBefore = compare('compare');
    const s = useFigure.getState();
    s.updateStyle('density', 'line', { dataPt: 3, axisPt: 2 });
    s.updateStyle('density', 'font', { tickPt: 12 });
    s.updateStyle('density', 'compare', { markerPt: 12, edge: true });
    for (const k of FIGURE_KINDS) {
      if (k === 'density') continue;
      expect(JSON.stringify(useFigure.getState().styles[k])).toBe(before[k]);
    }
    expect(compare('compare')).toBe(compareBefore);
    expect(useFigure.getState().styles.density.line.dataPt).toBe(3);
  });

  it('shares the typeface and the width, and nothing else', () => {
    const s = useFigure.getState();
    s.updateStyle('histogram', 'size', { widthMm: 120 });
    s.updateStyle('histogram', 'font', { family: 'Helvetica' });
    for (const k of FIGURE_KINDS) {
      expect(useFigure.getState().styles[k].size.widthMm).toBe(120);
      expect(useFigure.getState().styles[k].font.family).toBe('Helvetica');
    }
  });

  it('resets one type to its defaults, keeping the shared settings', () => {
    const s = useFigure.getState();
    s.updateStyle('compare', 'size', { widthMm: 180 });
    s.updateStyle('compare', 'compare', { opacity: 1 });
    s.updateStyle('umap', 'plot', { legend: false });
    s.resetStyle('compare');
    expect(useFigure.getState().styles.compare.compare.opacity).toBe(0.6);
    expect(useFigure.getState().styles.compare.size.widthMm).toBe(180);
    expect(useFigure.getState().styles.umap.plot.legend).toBe(false);
  });
});
