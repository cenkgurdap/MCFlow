/**
 * The Compare chart — per-sample values by category — composed as a journal
 * figure, and drawn on screen from the same string.
 *
 * ## What it fixes, and why the screen draws the file (2026-10-22)
 *
 * The chart was hand-written JSX laid out at a column width, with its own
 * literal type sizes, dots drawn *over* the mean and SD bars with a white ring
 * in the plot surface, ±1 SD the only error bar, ticks printed to four decimals
 * (`0.3500`), p-value brackets reading `= 0.0123`, and the test it named left in
 * HTML the export never saw. Now:
 *
 *   - **Points first, summaries on top.** A sample's point is filled at α 0.6
 *     with no edge by default (0.35: an edge of its own hue is an option), and the
 *     centre line and error bars are drawn over the points, so a bar is never
 *     hidden by the scatter and the scatter is still visible through itself.
 *   - **Placement is a beeswarm** (deterministic: each point takes the nearest
 *     free offset, densest values first) held inside the jitter width, and a point's
 *     size is a diameter in points.
 *   - **Error bars are chosen**: SD, SEM, the 95% confidence interval of the
 *     mean (t on n − 1), or the interquartile range around a median — and the
 *     notes state which, with n per category.
 *   - Ticks take as many decimals as their step needs and no more.
 *
 * The on-screen chart renders this composer's output, so the panel and the file
 * are one drawing at one width — the rule the Compare chart's column width
 * already followed, now read from the shared `FigureStyle`.
 *
 * Pure.
 */
import type { GroupSummary } from '@/core/statistics';
import { niceStep } from '@/core/transform';
import { axisMetrics, drawAxes, drawGrid, leftDepth, type Box, type FigureTick } from './axes';
import { CAP_HEIGHT, DESCENDER, measureText } from './measure';
import { ASPECTS, DEFAULT_FIGURE_STYLE, FIGURE_INK, fontStack, mmToPx, ptToPx, type FigureStyle } from './style';
import { el, esc, fmt, minusSigns, pathD, svgDocument, type ComposedFigure } from './svg';

export interface CompareCategory {
  label: string;
  color: string;
  /** One per sample, in the order the samples are listed. */
  points: Array<{ value: number; name: string }>;
  summary: GroupSummary;
}

export interface CompareModel {
  categories: CompareCategory[];
  /** The quantity, with its unit — `Median — membrane order`. */
  yTitle: string;
  /** Brackets between categories, by index, with their text already formatted. */
  brackets: Array<{ a: number; b: number; label: string }>;
  title: string;
  notes: string[];
}

export type CompareCentre = 'mean' | 'median';
export type CompareSpread = 'sd' | 'sem' | 'ci95' | 'iqr' | 'none';

/** How points and summaries are drawn — the Compare figure style's own block. */
export type CompareOptions = FigureStyle['compare'];

export const DEFAULT_COMPARE_OPTIONS: CompareOptions = DEFAULT_FIGURE_STYLE.compare;

/** What a summary's centre and spread are called, in a legend or the notes. */
export function summaryLabel(o: { centre: CompareCentre; spread: CompareSpread }): string {
  if (o.spread === 'iqr' || o.centre === 'median') return o.spread === 'none' ? 'median' : 'median and interquartile range';
  const spread = { sd: '± SD', sem: '± SEM', ci95: 'with 95% confidence interval', iqr: '', none: '' }[o.spread];
  return spread ? `mean ${spread}` : 'mean';
}

/** The centre and the two ends of the bar a category's summary draws. */
export function summaryExtent(s: GroupSummary, o: { centre: CompareCentre; spread: CompareSpread }): { centre: number; lo: number; hi: number } {
  if (o.spread === 'iqr' || o.centre === 'median') {
    return o.spread === 'none' ? { centre: s.median, lo: s.median, hi: s.median } : { centre: s.median, lo: s.q1, hi: s.q3 };
  }
  const e = o.spread === 'sd' ? s.sd : o.spread === 'sem' ? s.sem : o.spread === 'ci95' ? s.ci95 : 0;
  const half = s.n > 1 && Number.isFinite(e) ? e : 0;
  return { centre: s.mean, lo: s.mean - half, hi: s.mean + half };
}

/** Tick values over a padded range, and the step that names their decimals. */
export function compareTicks(lo: number, hi: number): { ticks: number[]; step: number; lo: number; hi: number } {
  const span = hi - lo || Math.abs(hi) || 1;
  const a = lo - span * 0.08;
  const b = hi + span * 0.08;
  const step = niceStep((b - a) / 5);
  const ticks: number[] = [];
  for (let v = Math.ceil(a / step) * step, i = 0; v <= b + step * 1e-9 && i < 50; v += step, i++) {
    ticks.push(Math.round(v / step) * step);
  }
  return { ticks, step, lo: a, hi: b };
}

/** A tick value with exactly the decimals its step needs, no trailing zeros. */
export function tickText(v: number, step: number): string {
  // As many decimals as write the step exactly — 0.05 needs two, 2.5 needs one.
  let decimals = step > 0 ? Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) : 0;
  while (decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6) decimals++;
  const s = (Math.abs(v) < step * 1e-6 ? 0 : v).toFixed(decimals);
  return minusSigns(s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
}

/**
 * Horizontal offsets for a column of points: each takes the nearest free spot
 * to the centre line, densest values first, so a beeswarm is the same picture
 * on every run. Offsets are in user units; `diameter` is the spacing.
 */
export function beeswarm(values: readonly number[], toY: (v: number) => number, diameter: number): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const placed: Array<{ x: number; y: number }> = [];
  const out = new Array<number>(values.length).fill(0);
  for (const { v, i } of order) {
    const y = toY(v);
    let x = 0;
    for (let k = 0; k < 200; k++) {
      const cand = k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * diameter * 0.5;
      if (placed.every((p) => Math.hypot(p.x - cand, p.y - y) >= diameter * 0.98)) { x = cand; break; }
    }
    placed.push({ x, y });
    out[i] = x;
  }
  return out;
}

export function composeCompareFigure(model: CompareModel, style: FigureStyle, opts: CompareOptions = style.compare): ComposedFigure {
  const m = axisMetrics(style);
  const family = style.font.family;
  const note = ptToPx(style.font.notePt);
  const titleSize = ptToPx(style.font.titlePt);
  const pad = ptToPx(3);
  const cats = model.categories;

  /* ---- the y range: every point and every bar end ---- */
  const extents = cats.map((c) => summaryExtent(c.summary, opts));
  const all = cats.flatMap((c, i) => [...c.points.map((p) => p.value), extents[i]!.lo, extents[i]!.hi]).filter(Number.isFinite);
  const frame = compareTicks(all.length ? Math.min(...all) : 0, all.length ? Math.max(...all) : 1);
  const yLabels = frame.ticks.map((v) => tickText(v, frame.step));
  const yUnit: FigureTick[] = frame.ticks.map((v, i) => ({ at: 1 - (v - frame.lo) / (frame.hi - frame.lo), label: yLabels[i]! }));

  /* ---- horizontal layout ---- */
  let left = leftDepth(yUnit, model.yTitle, m) + pad;
  const right = pad;
  const across = (l: number) => {
    const w = style.size.mode === 'axes' ? mmToPx(style.size.axesWidthMm) : Math.max(60, mmToPx(style.size.widthMm) - l - right);
    return { boxW: w, width: style.size.mode === 'axes' ? l + w + right : mmToPx(style.size.widthMm), slot: cats.length > 0 ? w / cats.length : w };
  };
  let { boxW, width, slot } = across(left);
  const labelSize = m.tick;
  const widest = cats.reduce((w, c) => Math.max(w, measureText(c.label, labelSize, family)), 0);
  const rotate = widest > slot - 4;
  const angle = 40;
  const rad = (angle * Math.PI) / 180;
  if (rotate && cats.length > 0) {
    // A rotated name hangs to the left of its column, so the first one decides
    // how far the plot sits from the edge — or it runs off the page.
    const hang = measureText(cats[0]!.label, labelSize, family) * Math.cos(rad);
    for (let k = 0; k < 3 && pad + hang - slot / 2 > left + 0.5; k++) {
      left = pad + hang - slot / 2;
      ({ boxW, width, slot } = across(left));
    }
  }
  const labelDepth = rotate
    ? widest * Math.sin(rad) + labelSize * (CAP_HEIGHT + DESCENDER) * Math.cos(rad)
    : labelSize * (CAP_HEIGHT + DESCENDER);
  const nDepth = note * (CAP_HEIGHT + DESCENDER) + m.gap;

  /* ---- vertical layout ---- */
  const bracketRows = layBrackets(model.brackets);
  const bracketLine = note * 1.7;
  const bracketBand = bracketRows.rows > 0 ? bracketRows.rows * bracketLine + pad : 0;
  const titleBlock = style.text.title && model.title ? titleSize * 1.35 : 0;
  const letterBlock = style.text.panelLetter ? titleSize * (CAP_HEIGHT + DESCENDER) + pad / 2 : 0;
  const top = pad + Math.max(letterBlock, titleBlock + bracketBand);
  const bottom = m.tickOut + m.gap + labelDepth + nDepth + pad;
  let boxH: number;
  if (style.size.mode === 'axes') boxH = mmToPx(style.size.axesHeightMm);
  else if (style.size.aspect === 'free') boxH = Math.max(boxW * 0.3, mmToPx(style.size.heightMm) - top - bottom);
  else boxH = boxW / ASPECTS[style.size.aspect];
  const height = top + boxH + bottom;
  const box: Box = { x: left, y: top, w: boxW, h: boxH };
  const toY = (v: number) => box.y + box.h - ((v - frame.lo) / (frame.hi - frame.lo)) * box.h;
  const cx = (i: number) => box.x + slot * (i + 0.5);
  const yTicks: FigureTick[] = frame.ticks.map((v, i) => ({ at: toY(v) - box.y, label: yLabels[i]! }));

  const layers: string[] = [];
  if (style.frame.grid) layers.push(drawGrid(box, [], yTicks, m));

  /* ---- points, first ---- */
  const d = ptToPx(opts.markerPt);
  const edge = ptToPx(opts.edgePt);
  const points: string[] = [];
  if (opts.points) {
    cats.forEach((c, i) => {
      // A beeswarm — the same picture on every run — held inside the jitter width.
      const offsets = beeswarm(c.points.map((p) => p.value), toY, d);
      const limit = Math.min(slot * 0.42, mmToPx(opts.jitterMm) / 2);
      c.points.forEach((p, k) => {
        if (!Number.isFinite(p.value)) return;
        points.push(el('circle', {
          cx: cx(i) + Math.max(-limit, Math.min(limit, offsets[k]!)), cy: toY(p.value), r: d / 2,
          fill: c.color, 'fill-opacity': opts.opacity,
          stroke: opts.edge ? c.color : 'none', 'stroke-width': opts.edge ? edge : null,
          'data-fig-point': c.label,
        }, el('title', {}, esc(`${p.name}: ${p.value}`))));
      });
    });
  }
  layers.push(el('g', { 'data-fig-layer': 'points' }, ...points));

  /* ---- summaries, on top of the points ---- */
  const line = ptToPx(opts.summaryPt);
  const bars: string[] = [];
  if (opts.summary) cats.forEach((c, i) => {
    const e = extents[i]!;
    if (!Number.isFinite(e.centre)) return;
    const half = Math.max(d * 1.4, slot * 0.26);
    const cap = Math.max(d * 0.8, slot * 0.1);
    if (e.hi > e.lo) {
      bars.push(
        el('line', { x1: cx(i), y1: toY(e.lo), x2: cx(i), y2: toY(e.hi), 'data-fig-spread': c.label }),
        el('line', { x1: cx(i) - cap, y1: toY(e.lo), x2: cx(i) + cap, y2: toY(e.lo) }),
        el('line', { x1: cx(i) - cap, y1: toY(e.hi), x2: cx(i) + cap, y2: toY(e.hi) }),
      );
    }
    bars.push(el('line', { x1: cx(i) - half, y1: toY(e.centre), x2: cx(i) + half, y2: toY(e.centre), 'stroke-width': line * 1.7, 'data-fig-centre': c.label }));
  });
  layers.push(el('g', { 'data-fig-layer': 'summary', stroke: FIGURE_INK, 'stroke-width': line, 'stroke-linecap': 'butt', fill: 'none' }, ...bars));

  /* ---- axes: a left spine with ticks, and a baseline ---- */
  layers.push(drawAxes(box, { ticks: [], title: '' }, { ticks: yTicks, title: model.yTitle }, style, m));

  /* ---- category labels and n ---- */
  const labels: string[] = [];
  const labelTop = box.y + box.h + m.tickOut + m.gap;
  cats.forEach((c, i) => {
    if (rotate) {
      const x = cx(i);
      const y = labelTop + labelSize * CAP_HEIGHT * Math.cos(rad);
      labels.push(el('text', { x, y, 'text-anchor': 'end', 'font-size': labelSize, transform: `rotate(-${angle} ${fmt(x)} ${fmt(y)})`, 'data-fig-category': c.label }, esc(c.label)));
    } else {
      labels.push(el('text', { x: cx(i), y: labelTop + labelSize * CAP_HEIGHT, 'text-anchor': 'middle', 'font-size': labelSize, 'data-fig-category': c.label }, esc(c.label)));
    }
    labels.push(el('text', {
      x: cx(i), y: labelTop + labelDepth + m.gap + note * CAP_HEIGHT, 'text-anchor': 'middle', 'font-size': note, fill: '#555555', 'data-fig-n': c.label,
    }, `n = ${c.summary.n}`));
  });
  layers.push(el('g', { 'data-fig-layer': 'categories', fill: FIGURE_INK }, ...labels));

  /* ---- brackets ---- */
  if (bracketRows.rows > 0) {
    const out: string[] = [];
    const leg = note * 0.45;
    for (const b of bracketRows.placed) {
      const y = box.y - pad / 2 - b.row * bracketLine;
      const x1 = cx(b.a);
      const x2 = cx(b.b);
      out.push(el('path', { d: pathD([[x1, y + leg], [x1, y], [x2, y], [x2, y + leg]]), fill: 'none', stroke: FIGURE_INK, 'stroke-width': m.axisWidth }));
      out.push(el('text', { x: (x1 + x2) / 2, y: y - note * 0.3, 'text-anchor': 'middle', 'font-size': note, fill: FIGURE_INK, 'data-fig-bracket': '' }, esc(minusSigns(b.label))));
    }
    layers.push(el('g', { 'data-fig-layer': 'brackets' }, ...out));
  }

  /* ---- panel letter and title ---- */
  const head: string[] = [];
  if (style.text.panelLetter) {
    head.push(el('text', { x: pad / 2, y: pad / 2 + titleSize * CAP_HEIGHT, 'font-size': titleSize, 'font-weight': 'bold', 'data-fig-panel-letter': '' }, esc(style.text.panelLetter)));
  }
  if (titleBlock > 0) {
    head.push(el('text', { x: box.x + box.w / 2, y: pad + titleSize * CAP_HEIGHT, 'text-anchor': 'middle', 'font-size': titleSize, 'font-weight': 'bold', 'data-fig-title': 'figure' }, esc(model.title)));
  }
  if (head.length) layers.push(el('g', { 'data-fig-layer': 'heading', fill: FIGURE_INK }, ...head));

  const notes = [
    ...model.notes,
    `Points: one per sample. Bars: ${summaryLabel(opts)}.`,
    `n per category: ${cats.map((c) => `${c.label} ${c.summary.n}`).join(', ')}.`,
    `Placement: beeswarm (deterministic) within ${opts.jitterMm} mm; points ${opts.markerPt} pt at opacity ${opts.opacity}${opts.edge ? `, edge ${opts.edgePt} pt` : ''}.`,
  ].join('\n');
  return {
    svg: svgDocument({
      width, height, body: layers.join(''), fontFamily: fontStack(family),
      background: style.frame.background === 'white' ? '#ffffff' : null, title: model.title, notes,
    }),
    width,
    height,
    notes,
  };
}

/** Bracket rows: shortest span lowest, and no two brackets sharing an end on one row. */
function layBrackets(brackets: CompareModel['brackets']): { rows: number; placed: Array<{ a: number; b: number; label: string; row: number }> } {
  const sorted = brackets
    .map((b) => ({ ...b, a: Math.min(b.a, b.b), b: Math.max(b.a, b.b) }))
    .sort((p, q) => (p.b - p.a) - (q.b - q.a) || p.a - q.a);
  const rows: Array<Array<{ a: number; b: number }>> = [];
  const placed: Array<{ a: number; b: number; label: string; row: number }> = [];
  for (const b of sorted) {
    let row = rows.findIndex((r) => r.every((o) => b.b < o.a || b.a > o.b));
    if (row < 0) { row = rows.length; rows.push([]); }
    rows[row]!.push(b);
    placed.push({ ...b, row });
  }
  return { rows: rows.length, placed };
}
