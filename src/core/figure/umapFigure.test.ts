import { describe, expect, it } from 'vitest';
import { composeUmapFigure, drawOrder, equalAspect } from './umapFigure';
import { DEFAULT_FIGURE_STYLE, mmToPx, ptToPx } from './style';

describe('the UMAP figure', () => {
  const style = { ...DEFAULT_FIGURE_STYLE, plot: { ...DEFAULT_FIGURE_STYLE.plot, legend: true, annotate: true } };
  let asked: { w: number; h: number; pointPx: number } | null = null;
  const fig = composeUmapFigure({
    extent: { xMin: -5, xMax: 15, yMin: 0, yMax: 5 },
    legend: [{ label: 'Control', color: '#0072B2' }, { label: 'Treated', color: '#D55E00' }],
    raster: (w, h, _frame, pointPx) => { asked = { w, h, pointPx }; return 'data:image/png;base64,AA=='; },
    title: 'UMAP',
    notes: ['Seed 42.'],
  }, style, 3);

  it('is as wide as the style says, in millimetres', () => {
    expect(fig.width).toBeCloseTo(mmToPx(style.size.widthMm), 6);
    expect(fig.svg).toMatch(/<svg[^>]*width="[\d.]+mm"/);
  });

  it('paints the points as one image at the layer scale, at the stated point size', () => {
    expect(asked).not.toBeNull();
    expect(asked!.w).toBe(asked!.h);
    expect(asked!.pointPx).toBeCloseTo(ptToPx(1.5) * 3, 6);
    expect(fig.svg.match(/<image/g)).toHaveLength(1);
  });

  it('draws no ticks, names its axes with arrows, and puts the legend after the points', () => {
    expect(fig.svg).not.toContain('data-fig-tick');
    expect(fig.svg).toContain('>UMAP1<');
    expect(fig.svg).toContain('>UMAP2<');
    expect(fig.svg.indexOf('data-fig-layer="legend"')).toBeGreaterThan(fig.svg.indexOf('data-fig-layer="points"'));
    expect(fig.notes).toContain('Seed 42.');
  });
});

describe('the pieces', () => {
  it('equalises the aspect so one unit is one length both ways', () => {
    const f = equalAspect({ xMin: -5, xMax: 15, yMin: 0, yMax: 5 }, 100, 100);
    expect(f.xMax - f.xMin).toBeCloseTo(f.yMax - f.yMin, 9);
    expect(f.xMin).toBeLessThanOrEqual(-5);
    expect(f.yMin).toBeLessThanOrEqual(0);
    expect(f.yMax).toBeGreaterThanOrEqual(5);
  });

  it('draws in a seeded order: a permutation, the same for the same seed', () => {
    const a = drawOrder(1000, 42);
    expect([...a].sort((x, y) => x - y)).toEqual([...Array(1000).keys()]);
    expect(drawOrder(1000, 42)).toEqual(a);
    expect(drawOrder(1000, 7)).not.toEqual(a);
    // Not the load order: the last file loaded must not be painted last.
    expect([...a.slice(0, 10)]).not.toEqual([...Array(10).keys()]);
  });
});
