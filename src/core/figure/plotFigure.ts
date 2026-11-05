/**
 * A worksheet plot — density, dot, contour or histogram — composed at its
 * printed size.
 *
 * ## What the panel supplies, and what this decides (2026-10-22)
 *
 * **Content is the panel's.** `PlotCanvas` assembles the model from the objects
 * it renders with: its view, its own tick lists, the gates it hands `GateLayer`
 * (already reprojected into its display space), their statistics and label
 * nudges, the histogram rows `histogramRows` gives `HistogramLayer`, the fit
 * rows `FitOverlay` draws, and the event layer drawn by the panel's own
 * `densitySpec` / `pointCloudDraw` at whatever pixel size is asked for. Nothing
 * about *what* is plotted is restated here.
 *
 * **Typography and geometry are the style's.** The figure is laid out at the
 * width the style names, the axes box is what the labels leave — square for a
 * 2D plot, because a population's shape is read off the aspect ratio — and every
 * line, font and gap is in points. In `axes` mode the box is fixed and the
 * figure grows around it, so separately exported panels share identical axes.
 *
 * ## The rules a reviewer will check
 *
 *   - Gate outlines are thin and their names and percentages are set in the
 *     gate's own colour, with no casing stroke — a stroked label is written as
 *     a Type3 font in PDF, which Acrobat reports as an error.
 *   - A histogram region is **one hue**: its band at α 0.12, its own boundary,
 *     its name and percentage. A boundary two regions share is drawn once, as a
 *     thin neutral dashed line, rather than twice in two colours. The labels sit
 *     in a strip above the plot, stacked where they would collide, never on the
 *     curve.
 *   - A fitted sum is solid and dark; components are dashed in their
 *     population's colour; the legend says which is which and how good the fit is.
 *   - Draw order is fixed: events, histogram, regions, fit, gates, axes, labels.
 */
import type { Goodness, PopulationLine } from '@/core/biophysics/fitDisplay';
import type { AxisTick } from '@/core/transform';
import {
  axisMetrics, bottomDepth, bottomOverhang, drawAxes, drawGrid, leftDepth, placeTicks,
  type Box, type FigureTick,
} from './axes';
import { drawLegend, layoutLegend, type LegendEntry } from './legend';
import { CAP_HEIGHT, DESCENDER, measureText } from './measure';
import { ASPECTS, FIGURE_INK, fontStack, mmToPx, ptToPx, type FigureStyle } from './style';
import { el, esc, fmt, minusSigns, pathD, svgDocument, type ComposedFigure } from './svg';

/* -------------------------------------------------------------------------
   The model
   ------------------------------------------------------------------------- */

/** A gate as the figure draws it, in the panel's display space. */
export type FigureGate =
  | {
    kind: 'path';
    id: string; name: string; percent: number | null; color: string;
    points: Array<[number, number]>;
    /** The label's anchor — centre of the gate's bounds, at its top. */
    anchor: [number, number];
    /** The user's nudge of the label on screen, in CSS pixels. */
    nudge: [number, number];
  }
  | {
    kind: 'ellipse';
    id: string; name: string; percent: number | null; color: string;
    cx: number; cy: number; rx: number; ry: number; angle: number;
    anchor: [number, number];
    nudge: [number, number];
  }
  | {
    kind: 'quadrant';
    id: string; color: string;
    x: number; y: number;
    labels: Array<{ quadrant: 0 | 1 | 2 | 3; name: string; percent: number | null; color: string }>;
  }
  | {
    kind: 'range';
    id: string; name: string; percent: number | null; color: string;
    axis: 'x' | 'y';
    min: number; max: number;
  };

export interface FigureHistogram {
  /** Each row normalised exactly as `HistogramLayer` normalises it, across `[xMin, xMax]`. */
  series: Array<{ label: string; color: string; bins: Float64Array; marked: boolean; overlaid: boolean; count: number }>;
  xMin: number;
  xMax: number;
}

export interface FigureFit {
  /** Positions along x, in display units. */
  x: Float64Array;
  /** The model, divided by the same number as the bars. */
  total: Float64Array;
  /** One row per population, most ordered first; empty when there is one population. */
  parts: Float64Array[];
  partColors: string[];
  /** `Gaussian mixture · 2 populations`. */
  model: string;
  goodness: Goodness;
  /** Each population's name and the moments of its line, most ordered first. */
  populations: Array<PopulationLine & { name: string; color: string }>;
  /** Data minus model, per bar, on the bars' scale — for the residual strip. */
  residual: Float64Array | null;
}

export interface PlotFigureModel {
  kind: 'density' | 'scatter' | 'histogram' | 'contour';
  view: { xMin: number; xMax: number; yMin: number; yMax: number };
  xTicks: readonly AxisTick[];
  yTicks: readonly AxisTick[];
  xTitle: string;
  xUnit: string | null;
  yTitle: string;
  yUnit: string | null;
  /** The plot square's side on screen, in CSS pixels — what label nudges are measured against. */
  panelPlotSize: number;
  /** The event layer at a pixel size, drawn by the panel's own settings. */
  raster?: ((widthPx: number, heightPx: number) => string | null) | null;
  contours?: { paths: Array<Array<[number, number]>>; color: string } | null;
  gates: FigureGate[];
  histogram?: FigureHistogram | null;
  fit?: FigureFit | null;
  colourBar?: { stops: readonly string[]; label: string } | null;
  saturated?: { count: number; total: number } | null;
  /** A short name for the figure — the population, or the sample. */
  title: string;
  /** The descriptive line: sample · population · which parameter is on which axis. */
  caption: string;
  /** Facts for the notes: sample, population, events, parameters, transforms. */
  notes: string[];
}

/* -------------------------------------------------------------------------
   Composition
   ------------------------------------------------------------------------- */


const pct = (p: number | null) => (p === null || !Number.isFinite(p) ? '' : `${p.toFixed(1)}%`);
const withUnit = (title: string, unit: string | null, style: FigureStyle) =>
  style.text.units && unit && !title.endsWith(`(${unit})`) ? `${title} (${unit})` : title;

/** Compose a plot figure. `layerScale` is device pixels per user unit for the event layer. */
export function composePlotFigure(model: PlotFigureModel, style: FigureStyle, layerScale: number): ComposedFigure {
  const m = axisMetrics(style);
  const twoD = model.kind !== 'histogram';
  const v = model.view;
  const note = ptToPx(style.font.notePt);
  const titleSize = ptToPx(style.font.titlePt);
  const pad = ptToPx(3);
  const family = style.font.family;
  const xTitle = withUnit(model.xTitle, model.xUnit, style);
  const yTitle = twoD ? withUnit(model.yTitle, model.yUnit, style) : model.yTitle;
  const hist = model.histogram ?? null;
  const fit = model.fit ?? null;
  const regions = model.gates.filter((g): g is Extract<FigureGate, { kind: 'range' }> => g.kind === 'range' && (!twoD || g.axis === 'x'))
    .filter(() => !twoD);
  const residual = !twoD && style.plot.residual && fit?.residual ? fit.residual : null;
  const colourBar = twoD && style.plot.colourBar && model.colourBar ? model.colourBar : null;

  /* ---- horizontal: what the labels need either side of the box ---- */
  const yAtUnit = placeTicks(model.yTicks, [v.yMin, v.yMax], 1, true);
  const left0 = leftDepth(yAtUnit, yTitle, m) + pad;
  const barWidth = colourBar ? pad + ptToPx(5) + m.gap + measureText('High', m.tick, family) + pad : 0;
  const outer = mmToPx(style.size.widthMm);

  let boxW: number;
  let left = left0;
  let right = pad + barWidth;
  if (style.size.mode === 'axes') {
    boxW = mmToPx(style.size.axesWidthMm);
    const over = bottomOverhang(placeTicks(model.xTicks, [v.xMin, v.xMax], boxW, false), boxW, m);
    left = Math.max(left0, over.left + pad);
    right = Math.max(pad, over.right + pad / 2) + barWidth;
  } else {
    // Twice: the overhang of the last x value depends on the box width, which
    // depends on the overhang. The second pass is within a fraction of a unit.
    boxW = outer - left - right;
    for (let pass = 0; pass < 2; pass++) {
      const over = bottomOverhang(placeTicks(model.xTicks, [v.xMin, v.xMax], boxW, false), boxW, m);
      left = Math.max(left0, over.left + pad);
      right = Math.max(pad, over.right + pad / 2) + barWidth;
      boxW = Math.max(40, outer - left - right);
    }
  }
  const width = style.size.mode === 'axes' ? left + boxW + right : outer;
  const xTicks = placeTicks(model.xTicks, [v.xMin, v.xMax], boxW, false);

  /* ---- vertical: title, caption, region labels, legend, residual ---- */
  const titleBlock = style.text.title && model.title ? titleSize * 1.35 : 0;
  const captionLines = style.text.caption && model.caption
    ? wrap(model.caption, width - 2 * pad, m.label, family)
    : [];
  const captionBlock = captionLines.length * m.label * 1.3;
  const letterBlock = style.text.panelLetter ? titleSize * (CAP_HEIGHT + DESCENDER) + pad / 2 : 0;
  const regionRows = layoutRegionLabels(regions, v, boxW, note, family);
  const regionBlock = regionRows.rows > 0 ? regionRows.rows * note * 2.3 + pad / 2 : 0;
  const top = pad + Math.max(letterBlock, titleBlock + captionBlock + regionBlock);

  const legendEntries = buildLegend(hist, fit, style);
  const legend = legendEntries.length > 0 ? layoutLegend(legendEntries, width - 2 * pad, style) : null;

  let boxH: number;
  if (twoD) boxH = boxW;
  else if (style.size.mode === 'axes') boxH = mmToPx(style.size.axesHeightMm);
  else if (style.size.aspect === 'free') boxH = -1; // decided once the bottom is known
  else boxH = boxW / ASPECTS[style.size.aspect];

  const residualH = residual ? Math.max(ptToPx(14), (boxH > 0 ? boxH : boxW * 0.6) * 0.22) : 0;
  const residualGap = residual ? pad * 1.2 : 0;
  const bottom = bottomDepth(xTicks, xTitle, m) + residualGap + residualH + (legend ? pad + legend.height : 0) + pad;
  if (boxH < 0) boxH = Math.max(boxW * 0.25, mmToPx(style.size.heightMm) - top - bottom);
  const height = top + boxH + bottom;

  const box: Box = { x: left, y: top, w: boxW, h: boxH };
  const toX = (d: number) => box.x + ((d - v.xMin) / (v.xMax - v.xMin || 1)) * box.w;
  const toY = (d: number) => box.y + box.h - ((d - v.yMin) / (v.yMax - v.yMin || 1)) * box.h;
  const yTicks = placeTicks(model.yTicks, [v.yMin, v.yMax], boxH, true);
  const nudgeScale = model.panelPlotSize > 0 ? boxW / model.panelPlotSize : 1;

  const layers: string[] = [];
  const clipId = 'mcflow-plot-area';
  layers.push(el('defs', {}, el('clipPath', { id: clipId }, el('rect', { x: box.x, y: box.y, width: box.w, height: box.h }))));
  if (style.frame.grid) layers.push(drawGrid(box, xTicks, yTicks, m));

  /* ---- events ---- */
  if (twoD && model.raster) {
    const url = model.raster(Math.max(1, Math.round(box.w * layerScale)), Math.max(1, Math.round(box.h * layerScale)));
    if (url) {
      layers.push(el('g', { 'data-fig-layer': 'events' }, el('image', {
        x: box.x, y: box.y, width: box.w, height: box.h, preserveAspectRatio: 'none', href: url, 'xlink:href': url,
      })));
    }
  }
  if (model.contours && model.contours.paths.length > 0) {
    layers.push(el('g', {
      'data-fig-layer': 'contours', 'clip-path': `url(#${clipId})`, fill: 'none',
      stroke: model.contours.color, 'stroke-width': ptToPx(style.line.dataPt) * 0.75, 'stroke-linejoin': 'round',
    }, ...model.contours.paths.map((p) => el('path', { d: pathD(p.map(([x, y]) => [toX(x), toY(y)] as [number, number])) }))));
  }

  /* ---- histogram ---- */
  if (hist) {
    const rows: string[] = [];
    for (const s of hist.series) {
      const n = s.bins.length;
      const bw = box.w * ((hist.xMax - hist.xMin) / (v.xMax - v.xMin || 1)) / n;
      const x0 = toX(hist.xMin);
      const base = toY(0);
      const outline: Array<[number, number]> = [[x0, base]];
      for (let i = 0; i < n; i++) {
        const y = toY(Math.min(1.2, s.bins[i]!));
        outline.push([x0 + i * bw, y], [x0 + (i + 1) * bw, y]);
      }
      outline.push([x0 + n * bw, base]);
      const fillOpacity = s.marked ? 0.18 : s.overlaid ? 0.1 : 0.25;
      rows.push(
        el('path', { d: pathD(outline, true), fill: s.color, 'fill-opacity': fillOpacity, stroke: 'none' }),
        el('path', {
          d: pathD(outline), fill: 'none', stroke: s.color, 'stroke-width': ptToPx(style.line.dataPt) * 0.8,
          'stroke-linejoin': 'round', 'data-fig-series': s.marked ? 'marked' : 'distribution',
        }),
      );
    }
    layers.push(el('g', { 'data-fig-layer': 'histogram', 'clip-path': `url(#${clipId})` }, ...rows));
  }

  /* ---- regions: one hue each ---- */
  if (regions.length > 0) layers.push(drawRegions(regions, v, box, toX, style));

  /* ---- the fit ---- */
  if (fit && hist) layers.push(drawFit(fit, toX, toY, clipId, style, note));

  /* ---- gates on a 2D plot ---- */
  if (twoD) layers.push(drawGates(model.gates, box, toX, toY, nudgeScale, clipId, style, note));

  /* ---- residual strip ---- */
  let axisBox = box;
  if (residual && hist) {
    const rBox: Box = { x: box.x, y: box.y + box.h + residualGap, w: box.w, h: residualH };
    layers.push(drawResidual(residual, hist, v, rBox, style, m));
    axisBox = rBox;
  }

  /* ---- axes ---- */
  if (residual) {
    // The main plot keeps its spines and ticks but gives its values to the
    // strip beneath it, which carries the x axis for both.
    layers.push(drawAxes(box, { ticks: xTicks.map((t) => ({ ...t, label: '' })), title: '' }, { ticks: yTicks, title: yTitle }, style, m));
    layers.push(drawAxes(axisBox, { ticks: xTicks, title: xTitle }, null, style, m));
  } else {
    layers.push(drawAxes(box, { ticks: xTicks, title: xTitle }, { ticks: yTicks, title: yTitle }, style, m));
  }

  /* ---- labels above the plot, legend below it, colour key beside it ---- */
  if (regionRows.rows > 0) layers.push(drawRegionLabels(regionRows, box, note));
  if (legend) {
    const legendY = axisBox.y + axisBox.h + bottomDepth(xTicks, xTitle, m) + pad;
    layers.push(drawLegend(legend, Math.max(pad, box.x - leftDepth(yTicks, yTitle, m)), legendY, style));
  }
  if (colourBar) layers.push(drawColourBar(colourBar, box, m));
  // Goodness of fit, small and out of the way: the top-right corner of the plot.
  if (fit && hist && style.plot.goodness && Number.isFinite(fit.goodness.r2)) {
    layers.push(el('text', {
      x: box.x + box.w - note * 0.3, y: box.y + note * (CAP_HEIGHT + 0.3), 'text-anchor': 'end', 'font-size': note, fill: '#555555', 'data-fig-goodness': '',
    }, `R² = ${fit.goodness.r2.toFixed(3)}`));
  }

  /* ---- panel letter, title, caption ---- */
  const head: string[] = [];
  if (style.text.panelLetter) {
    head.push(el('text', {
      x: pad / 2, y: pad / 2 + titleSize * CAP_HEIGHT, 'font-size': titleSize, 'font-weight': 'bold', 'data-fig-panel-letter': '',
    }, esc(style.text.panelLetter)));
  }
  let headY = pad;
  if (titleBlock > 0) {
    head.push(el('text', { x: box.x + box.w / 2, y: headY + titleSize * CAP_HEIGHT, 'text-anchor': 'middle', 'font-size': titleSize, 'font-weight': 'bold', 'data-fig-title': 'figure' }, esc(model.title)));
    headY += titleBlock;
  }
  captionLines.forEach((line, i) => {
    head.push(el('text', { x: width / 2, y: headY + m.label * (CAP_HEIGHT + i * 1.3), 'text-anchor': 'middle', 'font-size': m.label, 'data-fig-caption': '' }, esc(line)));
  });
  if (head.length > 0) layers.push(el('g', { 'data-fig-layer': 'heading', fill: FIGURE_INK }, ...head));

  const notes = plotNotes(model, fit, style);
  return {
    svg: svgDocument({
      width, height, body: layers.join(''), fontFamily: fontStack(family),
      background: style.frame.background === 'white' ? '#ffffff' : null,
      title: model.caption || model.title, notes: notes.join('\n'),
    }),
    width,
    height,
    notes: notes.join('\n'),
  };
}

/* -------------------------------------------------------------------------
   Pieces
   ------------------------------------------------------------------------- */

function buildLegend(hist: FigureHistogram | null, fit: FigureFit | null, style: FigureStyle): LegendEntry[] {
  if (!style.plot.legend || !hist) return [];
  const out: LegendEntry[] = [];
  const data = hist.series.filter((s) => !s.marked);
  // A lone distribution with no fit needs no key: the axis already names it.
  if (data.length <= 1 && !fit) return [];
  for (const s of data) {
    out.push({ label: `${s.label} (n = ${s.count.toLocaleString('en-US')})`, swatch: 'fill', color: s.color, opacity: s.overlaid ? 0.15 : 0.3 });
  }
  if (fit) {
    out.push({ label: 'Gaussian mixture (sum)', swatch: 'line', color: FIGURE_INK });
    // Least ordered first: left to right along the membrane-order axis.
    if (fit.parts.length > 0) {
      [...fit.populations].reverse().forEach((p) => {
        out.push({ label: minusSigns(`${p.name}: μ = ${p.mean.toFixed(3)}, σ = ${p.sd.toFixed(3)} (${Math.round(p.weight * 100)}%)`), swatch: 'line', color: p.color });
      });
    }
  }
  return out;
}

function drawFit(
  fit: FigureFit,
  toX: (d: number) => number,
  toY: (d: number) => number,
  clipId: string,
  style: FigureStyle,
  note: number,
): string {
  const line = ptToPx(style.line.dataPt);
  const curve = (row: Float64Array) => pathD(Array.from(row, (y, i) => [toX(fit.x[i]!), toY(Math.min(1.25, y))] as [number, number]));
  const parts = fit.parts.map((row, i) => el('path', {
    d: curve(row), fill: 'none', stroke: fit.partColors[i] ?? FIGURE_INK, 'stroke-width': line * 0.85,
    'data-fig-fit': 'population',
  }));
  const sum = el('path', {
    d: curve(fit.total), fill: 'none', stroke: FIGURE_INK, 'stroke-width': line, 'stroke-linejoin': 'round', 'data-fig-fit': 'sum',
  });
  const out = [el('g', { 'data-fig-layer': 'fit', 'clip-path': `url(#${clipId})` }, ...parts, sum)];
  if (style.plot.annotate) {
    const rows = fit.parts.length > 0 ? fit.parts : [fit.total];
    const labels = rows.map((row, i) => {
      const c = fit.populations[i]!;
      // At the line's own tallest point, which is where a reader looks for it.
      let at = 0;
      for (let j = 1; j < row.length; j++) if (row[j]! > row[at]!) at = j;
      return el('text', {
        x: toX(fit.x[at]!), y: toY(Math.min(1.1, row[at]!)) - note * 0.5, 'text-anchor': 'middle', 'font-size': note,
        fill: fit.partColors[i] ?? FIGURE_INK, 'data-fig-annotation': '',
      }, esc(minusSigns(`μ ${c.mean.toFixed(3)}, σ ${c.sd.toFixed(3)}`)));
    });
    out.push(el('g', {}, ...labels));
  }
  return out.join('');
}

function drawRegions(
  regions: Array<Extract<FigureGate, { kind: 'range' }>>,
  v: PlotFigureModel['view'],
  box: Box,
  toX: (d: number) => number,
  style: FigureStyle,
): string {
  const lineW = ptToPx(style.line.gatePt);
  const bands: string[] = [];
  const edges: Array<{ x: number; colors: string[] }> = [];
  const addEdge = (d: number, color: string) => {
    if (!Number.isFinite(d) || d <= v.xMin || d >= v.xMax) return;
    const x = toX(d);
    const hit = edges.find((e) => Math.abs(e.x - x) < 0.25);
    if (hit) hit.colors.push(color); else edges.push({ x, colors: [color] });
  };
  for (const r of regions) {
    const x0 = toX(Math.max(v.xMin, Number.isFinite(r.min) ? r.min : v.xMin));
    const x1 = toX(Math.min(v.xMax, Number.isFinite(r.max) ? r.max : v.xMax));
    // A region that spans the whole axis has no extent to mark — its band would
    // be a tint over the entire plot. It keeps its label.
    const whole = !(r.min > v.xMin) && !(r.max < v.xMax);
    if (x1 > x0 && !whole) bands.push(el('rect', { x: x0, y: box.y, width: x1 - x0, height: box.h, fill: r.color, 'fill-opacity': 0.12, 'data-fig-region': r.name }));
    addEdge(r.min, r.color);
    addEdge(r.max, r.color);
  }
  /*
     A boundary is drawn in its population's colour (0.35). One two regions
     share is dashed in both — alternating dashes of the region on each side —
     so it reads as the edge of each rather than as a third, inked thing.
  */
  const lines = edges.flatMap((e) => {
    const base = { x1: e.x, y1: box.y, x2: e.x, y2: box.y + box.h, 'stroke-width': lineW };
    if (e.colors.length < 2) return [el('line', { ...base, stroke: e.colors[0], 'data-fig-boundary': 'own' })];
    const dash = lineW * 3;
    return [
      el('line', { ...base, stroke: e.colors[0], 'stroke-dasharray': `${fmt(dash)} ${fmt(dash)}`, 'data-fig-boundary': 'shared' }),
      el('line', { ...base, stroke: e.colors[1], 'stroke-dasharray': `${fmt(dash)} ${fmt(dash)}`, 'stroke-dashoffset': fmt(dash) }),
    ];
  });
  return el('g', { 'data-fig-layer': 'regions' }, ...bands, ...lines);
}

interface RegionLabelLayout {
  rows: number;
  labels: Array<{ name: string; percent: string; color: string; x: number; row: number; anchor: 'start' | 'middle' | 'end' }>;
}

/**
 * Where each region's name and percentage go: centred over the stretch of the
 * axis it owns, in the strip above the plot, on the lowest row it does not
 * collide with a neighbour on.
 */
function layoutRegionLabels(
  regions: Array<Extract<FigureGate, { kind: 'range' }>>,
  v: PlotFigureModel['view'],
  boxW: number,
  size: number,
  family: FigureStyle['font']['family'],
): RegionLabelLayout {
  if (regions.length === 0) return { rows: 0, labels: [] };
  const span = v.xMax - v.xMin || 1;
  const at = (d: number) => ((d - v.xMin) / span) * boxW;
  const items = regions.map((r) => {
    const lo = at(Math.max(v.xMin, Number.isFinite(r.min) ? r.min : v.xMin));
    const hi = at(Math.min(v.xMax, Number.isFinite(r.max) ? r.max : v.xMax));
    const w = Math.max(measureText(r.name, size, family), measureText(pct(r.percent), size, family));
    let x = (lo + hi) / 2;
    let anchor: 'start' | 'middle' | 'end' = 'middle';
    if (x - w / 2 < 0) { x = 0; anchor = 'start'; } else if (x + w / 2 > boxW) { x = boxW; anchor = 'end'; }
    const start = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
    return { r, x, w, anchor, start, end: start + w };
  }).sort((a, b) => a.start - b.start);

  const rowEnds: number[] = [];
  const labels: RegionLabelLayout['labels'] = [];
  const gap = size * 0.6;
  for (const it of items) {
    let row = rowEnds.findIndex((end) => it.start >= end + gap);
    if (row < 0) { row = rowEnds.length; rowEnds.push(-Infinity); }
    rowEnds[row] = it.end;
    labels.push({ name: it.r.name, percent: pct(it.r.percent), color: it.r.color, x: it.x, row, anchor: it.anchor });
  }
  return { rows: rowEnds.length, labels };
}

function drawRegionLabels(layout: RegionLabelLayout, box: Box, size: number): string {
  const rowH = size * 2.3;
  const out = layout.labels.map((l) => {
    // Row 0 sits nearest the plot; later rows stack upwards, away from it.
    const baseline2 = box.y - size * 0.45 - l.row * rowH;
    const baseline1 = baseline2 - size * 1.1;
    return el('text', { 'text-anchor': l.anchor, 'font-size': size, fill: l.color, 'data-fig-region-label': l.name },
      el('tspan', { x: box.x + l.x, y: baseline1 }, esc(l.name)),
      el('tspan', { x: box.x + l.x, y: baseline2 }, esc(l.percent)));
  });
  return el('g', { 'data-fig-layer': 'region-labels' }, ...out);
}

function drawGates(
  gates: FigureGate[],
  box: Box,
  toX: (d: number) => number,
  toY: (d: number) => number,
  nudgeScale: number,
  clipId: string,
  style: FigureStyle,
  note: number,
): string {
  const lineW = ptToPx(style.line.gatePt);
  const shapes: string[] = [];
  const labels: string[] = [];
  const family = style.font.family;
  const place = (text: string, x: number, y: number, color: string, id: string) => {
    const w = measureText(text, note, family);
    // The label stays inside the plot: alignment changes at an edge rather
    // than the anchor being clamped, which would still put half of it outside.
    let anchor: 'start' | 'middle' | 'end' = 'middle';
    let lx = x;
    if (x - w / 2 < box.x + 2) { anchor = 'start'; lx = box.x + 2; } else if (x + w / 2 > box.x + box.w - 2) { anchor = 'end'; lx = box.x + box.w - 2; }
    const ly = Math.min(box.y + box.h - 2, Math.max(box.y + note * CAP_HEIGHT + 2, y));
    labels.push(el('text', { x: lx, y: ly, 'text-anchor': anchor, 'font-size': note, fill: color, 'data-fig-gate-label': id }, esc(text)));
  };

  for (const g of gates) {
    if (g.kind === 'path' || g.kind === 'ellipse') {
      if (g.kind === 'path') {
        shapes.push(el('path', {
          d: pathD(g.points.map(([x, y]) => [toX(x), toY(y)] as [number, number]), true),
          stroke: g.color, 'data-fig-gate': g.id,
        }));
      } else {
        const cx = toX(g.cx);
        const cy = toY(g.cy);
        shapes.push(el('ellipse', {
          cx, cy, rx: Math.abs(toX(g.cx + g.rx) - cx), ry: Math.abs(toY(g.cy + g.ry) - cy),
          transform: g.angle ? `rotate(${fmt((-g.angle * 180) / Math.PI)} ${fmt(cx)} ${fmt(cy)})` : null,
          stroke: g.color, 'data-fig-gate': g.id,
        }));
      }
      const text = [g.name, pct(g.percent)].filter(Boolean).join(' ');
      place(text, toX(g.anchor[0]) + g.nudge[0] * nudgeScale, toY(g.anchor[1]) - note * 0.45 + g.nudge[1] * nudgeScale, g.color, g.id);
    } else if (g.kind === 'quadrant') {
      const x = toX(g.x);
      const y = toY(g.y);
      shapes.push(
        el('line', { x1: x, y1: box.y, x2: x, y2: box.y + box.h, stroke: g.color, 'data-fig-gate': g.id }),
        el('line', { x1: box.x, y1: y, x2: box.x + box.w, y2: y, stroke: g.color }),
      );
      for (const q of g.labels) {
        const text = [q.name, pct(q.percent)].filter(Boolean).join(' ');
        const right = q.quadrant === 1 || q.quadrant === 2;
        const upper = q.quadrant === 2 || q.quadrant === 3;
        labels.push(el('text', {
          x: right ? box.x + box.w - 2 : box.x + 2,
          y: upper ? box.y + note * CAP_HEIGHT + 2 : box.y + box.h - note * DESCENDER - 2,
          'text-anchor': right ? 'end' : 'start', 'font-size': note, fill: q.color, 'data-fig-gate-label': `${g.id}:${q.quadrant}`,
        }, esc(text)));
      }
    } else if (g.kind === 'range') {
      const lo = Number.isFinite(g.min) ? g.min : -Infinity;
      const hi = Number.isFinite(g.max) ? g.max : Infinity;
      if (g.axis === 'x') {
        const x0 = Number.isFinite(lo) ? toX(lo) : box.x;
        const x1 = Number.isFinite(hi) ? toX(hi) : box.x + box.w;
        shapes.push(el('rect', { x: Math.max(box.x, x0), y: box.y, width: Math.max(0, Math.min(box.x + box.w, x1) - Math.max(box.x, x0)), height: box.h, fill: g.color, 'fill-opacity': 0.12, stroke: 'none' }));
        for (const e of [lo, hi]) if (Number.isFinite(e)) shapes.push(el('line', { x1: toX(e), y1: box.y, x2: toX(e), y2: box.y + box.h, stroke: g.color }));
        place([g.name, pct(g.percent)].filter(Boolean).join(' '), (Math.max(box.x, x0) + Math.min(box.x + box.w, x1)) / 2, box.y + note * CAP_HEIGHT + 2, g.color, g.id);
      } else {
        const y0 = Number.isFinite(lo) ? toY(lo) : box.y + box.h;
        const y1 = Number.isFinite(hi) ? toY(hi) : box.y;
        shapes.push(el('rect', { x: box.x, y: Math.max(box.y, y1), width: box.w, height: Math.max(0, Math.min(box.y + box.h, y0) - Math.max(box.y, y1)), fill: g.color, 'fill-opacity': 0.12, stroke: 'none' }));
        for (const e of [lo, hi]) if (Number.isFinite(e)) shapes.push(el('line', { x1: box.x, y1: toY(e), x2: box.x + box.w, y2: toY(e), stroke: g.color }));
        place([g.name, pct(g.percent)].filter(Boolean).join(' '), box.x + box.w / 2, Math.max(box.y, y1) + note * CAP_HEIGHT + 2, g.color, g.id);
      }
    }
  }
  return el('g', { 'data-fig-layer': 'gates' },
    el('g', { 'clip-path': `url(#${clipId})`, fill: 'none', 'stroke-width': lineW }, ...shapes),
    el('g', {}, ...labels));
}

function drawResidual(
  residual: Float64Array,
  hist: FigureHistogram,
  v: PlotFigureModel['view'],
  box: Box,
  style: FigureStyle,
  m: ReturnType<typeof axisMetrics>,
): string {
  let peak = 0;
  for (const r of residual) peak = Math.max(peak, Math.abs(r));
  const limit = Math.max(0.05, Math.ceil(peak / 0.05) * 0.05);
  const n = residual.length;
  const toX = (d: number) => box.x + ((d - v.xMin) / (v.xMax - v.xMin || 1)) * box.w;
  const toY = (r: number) => box.y + box.h / 2 - (r / limit) * (box.h / 2);
  const bw = (toX(hist.xMax) - toX(hist.xMin)) / n;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const y = toY(residual[i]!);
    pts.push([toX(hist.xMin) + i * bw, y], [toX(hist.xMin) + (i + 1) * bw, y]);
  }
  const ticks: FigureTick[] = [
    { at: box.h / 2 - box.h / 2, label: `${trimNumber(limit)}` },
    { at: box.h / 2, label: '0' },
    { at: box.h, label: `-${trimNumber(limit)}` },
  ];
  return el('g', { 'data-fig-layer': 'residual' },
    el('line', { x1: box.x, y1: toY(0), x2: box.x + box.w, y2: toY(0), stroke: FIGURE_INK, 'stroke-width': m.axisWidth * 0.6, 'stroke-dasharray': `${fmt(m.axisWidth * 3)} ${fmt(m.axisWidth * 3)}` }),
    el('path', { d: pathD(pts), fill: 'none', stroke: FIGURE_INK, 'stroke-width': ptToPx(style.line.dataPt) * 0.7 }),
    drawAxes(box, null, { ticks, title: 'Residual' }, { ...style, frame: { ...style.frame, spines: 'open' } }, m));
}

function drawColourBar(bar: NonNullable<PlotFigureModel['colourBar']>, box: Box, m: ReturnType<typeof axisMetrics>): string {
  const w = ptToPx(5);
  const x = box.x + box.w + ptToPx(3);
  const id = 'mcflow-density-ramp';
  const stops = bar.stops.map((c, i) => el('stop', { offset: fmt(i / Math.max(1, bar.stops.length - 1)), 'stop-color': c }));
  return el('g', { 'data-fig-layer': 'colour-bar' },
    el('defs', {}, el('linearGradient', { id, x1: 0, y1: 1, x2: 0, y2: 0 }, ...stops)),
    el('rect', { x, y: box.y, width: w, height: box.h, fill: `url(#${id})`, stroke: FIGURE_INK, 'stroke-width': m.axisWidth * 0.6 }),
    el('text', { x: x + w + m.gap, y: box.y + m.tick * CAP_HEIGHT, 'font-size': m.tick, fill: FIGURE_INK }, 'High'),
    el('text', { x: x + w + m.gap, y: box.y + box.h, 'font-size': m.tick, fill: FIGURE_INK }, 'Low'),
    el('text', {
      x: x + w / 2, y: box.y + box.h / 2, 'font-size': m.tick, fill: FIGURE_INK, 'text-anchor': 'middle',
      transform: `rotate(-90 ${fmt(x - m.gap)} ${fmt(box.y + box.h / 2)})`,
    }, esc(bar.label)));
}

function trimNumber(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/** Break text into lines no wider than `width`, at spaces. */
export function wrap(text: string, width: number, size: number, family: FigureStyle['font']['family']): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measureText(next, size, family) > width) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** What the notes say about a plot figure, beyond what the panel supplied. */
function plotNotes(model: PlotFigureModel, fit: FigureFit | null, style: FigureStyle): string[] {
  const out = [...model.notes];
  if (fit) {
    out.push(`Fit: ${fit.model}; R² = ${fit.goodness.r2.toFixed(4)}, RMS residual = ${(fit.goodness.rms * 100).toFixed(2)}% of the tallest bar (over ${fit.goodness.bins} bins).`);
    [...fit.populations].reverse().forEach((c) => {
      out.push(minusSigns(`  ${c.name}: weight ${(c.weight * 100).toFixed(1)}%, mean ${c.mean.toFixed(4)}, SD ${c.sd.toFixed(4)}.`));
    });
    out.push('Drawn: the sum (black) and one line per population (the Gaussians under its gate, summed), in expected events per bar, divided by the same number as the bars.');
  }
  if (model.saturated && model.saturated.count > 0) {
    const share = (model.saturated.count / Math.max(1, model.saturated.total)) * 100;
    out.push(style.plot.clipSaturated
      ? `${model.saturated.count.toLocaleString('en-US')} events (${share.toFixed(2)}%) at the detector's maximum are not drawn; they are counted in every gate and statistic.`
      : `${model.saturated.count.toLocaleString('en-US')} events (${share.toFixed(2)}%) sit at the detector's maximum and are drawn there.`);
  }
  return out;
}
