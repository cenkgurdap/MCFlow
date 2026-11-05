import { describe, expect, it } from 'vitest';
import { createTransform } from '@/core/transform';
import { composePlotFigure, type PlotFigureModel } from './plotFigure';
import { DEFAULT_FIGURE_STYLE, mmToPx, ptToPx, type FigureStyle } from './style';

/* -------------------------------------------------------------------------
   The plot composer, checked on the properties the export brief names: the
   figure is its stated width in millimetres, every label its stated size in
   points, the draw order fixed, and nothing in the file depends on the
   application's stylesheet or theme.
   ------------------------------------------------------------------------- */

const lin = (range: number) => createTransform({ kind: 'linear', range });

function density(overrides: Partial<PlotFigureModel> = {}): PlotFigureModel {
  const x = lin(4_194_304);
  const y = lin(4_194_304);
  return {
    kind: 'density',
    view: { xMin: 0, xMax: 4_194_304, yMin: 0, yMax: 4_194_304 },
    xTicks: x.ticks(6, [0, 4_194_304]),
    yTicks: y.ticks(6, [0, 4_194_304]),
    xTitle: 'FSC-A', xUnit: 'a.u.', yTitle: 'SSC-A', yUnit: 'a.u.',
    panelPlotSize: 225,
    raster: (w, h) => `data:image/png;base64,${w}x${h}`,
    gates: [{
      kind: 'path', id: 'g1', name: 'Cells', percent: 81.25, color: '#0072B2',
      points: [[1e6, 1e6], [3e6, 1e6], [3e6, 3e6], [1e6, 3e6]], anchor: [2e6, 3e6], nudge: [0, 0],
    }],
    title: 'Cells', caption: 'Tube 1 · Cells · FSC-A (x-axis) × SSC-A (y-axis)',
    notes: ['Sample: Tube 1'],
    ...overrides,
  };
}

const attr = (svg: string, name: string) => new RegExp(`${name}="([^"]+)"`).exec(svg)?.[1];
const sizes = (svg: string, marker: string) =>
  [...svg.matchAll(new RegExp(`<text[^>]*${marker}[^>]*>`, 'g'))].map((m) => Number(/font-size="([\d.]+)"/.exec(m[0])?.[1]));

describe('a density figure', () => {
  const fig = composePlotFigure(density(), DEFAULT_FIGURE_STYLE, 300 / 96);

  it('is the width the style names, in millimetres', () => {
    expect(attr(fig.svg, 'width')).toBe('85mm');
    expect(fig.width).toBeCloseTo(mmToPx(85), 6);
  });

  it('sets tick values at 7 pt and axis titles at 8 pt, at that width', () => {
    const ticks = sizes(fig.svg, 'data-fig-tick');
    const titles = sizes(fig.svg, 'data-fig-title');
    expect(ticks.length).toBeGreaterThan(4);
    expect(ticks.every((s) => Math.abs(s - ptToPx(7)) < 0.01)).toBe(true);
    expect(titles).toHaveLength(2);
    expect(titles.every((s) => Math.abs(s - ptToPx(8)) < 0.01)).toBe(true);
  });

  it('names the units on both axes', () => {
    expect(fig.svg).toContain('>FSC-A (a.u.)<');
    expect(fig.svg).toContain('>SSC-A (a.u.)<');
  });

  it('draws the events under the gates, and the gates under the axes', () => {
    const at = (layer: string) => fig.svg.indexOf(`data-fig-layer="${layer}"`);
    expect(at('events')).toBeGreaterThan(-1);
    expect(at('events')).toBeLessThan(at('gates'));
    expect(at('gates')).toBeLessThan(at('axes'));
  });

  it('keeps the plot area square, as every 2D plot is', () => {
    const clip = /<clipPath[^>]*><rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)"/.exec(fig.svg)!;
    expect(Number(clip[1])).toBeCloseTo(Number(clip[2]), 2);
  });

  it('renders the event layer at the requested resolution', () => {
    const clip = /<clipPath[^>]*><rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(fig.svg)!;
    const want = Math.round(Number(clip[1]) * (300 / 96));
    expect(fig.svg).toContain(`base64,${want}x${want}`);
  });

  it('labels the gate in its own colour, with no casing stroke', () => {
    expect(fig.svg).toMatch(/<text[^>]*fill="#0072B2"[^>]*data-fig-gate-label="g1"[^>]*>Cells 81\.3%</);
    expect(fig.svg).not.toContain('paint-order');
  });

  it('refers to no stylesheet, custom property or theme', () => {
    expect(fig.svg).not.toContain('var(');
    expect(fig.svg).not.toContain('class=');
  });

  it('draws only the left and bottom spines, and no title or grid, by default', () => {
    expect(fig.svg).toContain('data-fig-spine="open"');
    expect(fig.svg).not.toContain('data-fig-layer="grid"');
    expect(fig.svg).not.toContain('data-fig-title="figure"');
  });

  it('writes the notes into the document', () => {
    expect(fig.svg).toContain('<desc>Sample: Tube 1</desc>');
  });
});

describe('the axes box can be fixed, so separate figures share identical axes', () => {
  const axes: FigureStyle = { ...DEFAULT_FIGURE_STYLE, size: { ...DEFAULT_FIGURE_STYLE.size, mode: 'axes', axesWidthMm: 40 } };
  const box = (svg: string) => Number(/<clipPath[^>]*><rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"/.exec(svg)![1]);

  it('whatever the tick labels need beside it', () => {
    const wide = composePlotFigure(density(), axes, 1);
    const narrow = composePlotFigure(density({
      view: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
      xTicks: lin(1).ticks(6, [-1, 1]), yTicks: lin(1).ticks(6, [-1, 1]),
    }), axes, 1);
    expect(box(wide.svg)).toBeCloseTo(mmToPx(40), 2);
    expect(box(narrow.svg)).toBeCloseTo(mmToPx(40), 2);
    // The figures differ in width; their axes do not.
    expect(wide.width).not.toBeCloseTo(narrow.width, 1);
  });
});

describe('histogram regions', () => {
  const x = lin(1);
  const model = (gates: PlotFigureModel['gates']): PlotFigureModel => ({
    kind: 'histogram',
    view: { xMin: -1, xMax: 1, yMin: 0, yMax: 1 },
    xTicks: x.ticks(6, [-1, 1]),
    yTicks: [0, 0.5, 1].map((v) => ({ display: v, value: v, label: String(v) })),
    xTitle: 'Membrane order', xUnit: 'GP', yTitle: 'Normalised count', yUnit: null,
    panelPlotSize: 225,
    histogram: {
      series: [{ label: 'Tube 1', color: '#0072B2', bins: Float64Array.from({ length: 64 }, (_, i) => Math.exp(-((i - 40) ** 2) / 20)), marked: false, overlaid: false, count: 1000 }],
      xMin: -1, xMax: 1,
    },
    gates, title: '', caption: '', notes: [],
  });

  it('gives each region one hue, and draws a shared boundary once, neutral and dashed', () => {
    const fig = composePlotFigure(model([
      { kind: 'range', id: 'live', name: 'Live', percent: 60, color: '#009E73', axis: 'x', min: -0.2, max: Infinity },
      { kind: 'range', id: 'dead', name: 'Dead', percent: 40, color: '#7F7F7F', axis: 'x', min: -Infinity, max: -0.2 },
    ]), DEFAULT_FIGURE_STYLE, 1);
    expect(fig.svg.match(/data-fig-boundary="shared"/g)).toHaveLength(1);
    expect(fig.svg).toMatch(/<rect[^>]*fill="#009E73"[^>]*fill-opacity="0\.12"/);
    expect(fig.svg).toMatch(/<text[^>]*fill="#009E73"[^>]*data-fig-region-label="Live"/);
    // Labels go above the plot, not on the curve.
    expect(fig.svg.indexOf('data-fig-layer="region-labels"')).toBeGreaterThan(fig.svg.indexOf('data-fig-layer="axes"'));
  });

  it('stacks labels that would collide instead of overprinting them', () => {
    const fig = composePlotFigure(model([
      { kind: 'range', id: 'a', name: 'Internalised / pre-apoptotic', percent: 14.4, color: '#E69F00', axis: 'x', min: -0.6, max: -0.47 },
      { kind: 'range', id: 'b', name: 'Dead', percent: 48.1, color: '#7F7F7F', axis: 'x', min: -Infinity, max: -0.6 },
      { kind: 'range', id: 'c', name: 'Live', percent: 37.5, color: '#009E73', axis: 'x', min: -0.47, max: Infinity },
    ]), DEFAULT_FIGURE_STYLE, 1);
    const ys = [...fig.svg.matchAll(/data-fig-region-label="[^"]+"><tspan x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(ys.map((y) => y.toFixed(1))).size).toBeGreaterThan(1);
  });
});
