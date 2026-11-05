/**
 * Axes for a composed figure — spines, ticks, tick values and titles.
 *
 * Every size comes from the `FigureStyle`, in points: a 7 pt tick value is 7 pt
 * in the column the figure is printed at, because the figure is laid out at that
 * size rather than scaled to it. The ticks themselves are the panel's own —
 * `Transform.ticks` over the range on show, the same list the screen draws — so
 * a figure is labelled where the panel is.
 *
 * Two depths are exported beside the drawing: how much room each axis needs
 * outside the box. A layout asks them before it knows where the box is, which
 * is the only way a y axis with `1,000,000` on it and one with `0.5` on it can
 * both have their labels fully on the page.
 */
import type { AxisTick } from '@/core/transform';
import { CAP_HEIGHT, DESCENDER, measureText } from './measure';
import { FIGURE_INK, FIGURE_MUTED, ptToPx, type FigureStyle, type FontFamily } from './style';
import { el, esc, fmt, pathD, tickLabelBody } from './svg';

/** A rectangle in user units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A tick on a figure axis: where it is along the axis, in user units from the box's origin edge. */
export interface FigureTick {
  at: number;
  label: string;
  minor?: boolean;
}

/** Every size an axis drawing reads, in user units. */
export interface AxisMetrics {
  family: FontFamily;
  tick: number;
  label: number;
  tickLen: number;
  /** How far ticks reach outside the box — the tick length when they point out. */
  tickOut: number;
  gap: number;
  titleGap: number;
  axisWidth: number;
}

export function axisMetrics(style: FigureStyle): AxisMetrics {
  const tickLen = ptToPx(style.line.tickLenPt);
  return {
    family: style.font.family,
    tick: ptToPx(style.font.tickPt),
    label: ptToPx(style.font.labelPt),
    tickLen,
    tickOut: style.line.tickDir === 'out' ? tickLen : 0,
    gap: ptToPx(1.5),
    titleGap: ptToPx(2.5),
    axisWidth: ptToPx(style.line.axisPt),
  };
}

/** Ticks from a transform, placed along an axis of `length` user units. */
export function placeTicks(
  ticks: readonly AxisTick[],
  view: readonly [number, number],
  length: number,
  flip: boolean,
): FigureTick[] {
  const [lo, hi] = view;
  const span = hi - lo || 1;
  const out: FigureTick[] = [];
  for (const t of ticks) {
    if (t.display < lo - span * 1e-9 || t.display > hi + span * 1e-9) continue;
    const f = (t.display - lo) / span;
    out.push({ at: (flip ? 1 - f : f) * length, label: t.label, minor: t.minor });
  }
  return out;
}

const labelled = (ticks: readonly FigureTick[]) => ticks.filter((t) => !t.minor && t.label !== '');

/** Width of the widest value an axis prints. */
export function widestLabel(ticks: readonly FigureTick[], m: AxisMetrics): number {
  let w = 0;
  for (const t of labelled(ticks)) w = Math.max(w, labelWidth(t.label, m.tick, m.family));
  return w;
}

/** A tick label's width, with a decade's exponent at the size `tickLabelBody` draws it. */
export function labelWidth(label: string, size: number, family: FontFamily): number {
  const sup = /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+$/.exec(label);
  if (!sup) return measureText(label.replace(/^-/, '−'), size, family);
  return measureText(label.slice(0, sup.index).replace(/^-/, '−'), size, family)
    + measureText('0'.repeat(sup[0].length), size * 0.72, family);
}

/** Room a bottom axis needs below the box. */
export function bottomDepth(ticks: readonly FigureTick[], title: string, m: AxisMetrics): number {
  const values = labelled(ticks).length > 0 ? m.gap + m.tick * (CAP_HEIGHT + DESCENDER) : 0;
  const name = title ? m.titleGap + m.label * (CAP_HEIGHT + DESCENDER) : 0;
  return m.tickOut + values + name;
}

/** Room a left axis needs beside the box. */
export function leftDepth(ticks: readonly FigureTick[], title: string, m: AxisMetrics): number {
  const values = labelled(ticks).length > 0 ? m.gap + widestLabel(ticks, m) : 0;
  const name = title ? m.titleGap + m.label * (CAP_HEIGHT + DESCENDER) : 0;
  return m.tickOut + values + name;
}

/**
 * How far the outermost x values reach past the box's two sides — a value is
 * centred on its tick, so the last one hangs half its width off the end.
 */
export function bottomOverhang(ticks: readonly FigureTick[], boxW: number, m: AxisMetrics): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const t of labelled(ticks)) {
    const half = labelWidth(t.label, m.tick, m.family) / 2;
    left = Math.max(left, half - t.at);
    right = Math.max(right, t.at + half - boxW);
  }
  return { left, right };
}

/** Light lines across the box at the major ticks — off unless the style asks. */
export function drawGrid(box: Box, xTicks: readonly FigureTick[], yTicks: readonly FigureTick[], m: AxisMetrics): string {
  const lines: string[] = [];
  for (const t of xTicks) {
    if (t.minor) continue;
    lines.push(el('line', { x1: box.x + t.at, y1: box.y, x2: box.x + t.at, y2: box.y + box.h }));
  }
  for (const t of yTicks) {
    if (t.minor) continue;
    lines.push(el('line', { x1: box.x, y1: box.y + t.at, x2: box.x + box.w, y2: box.y + t.at }));
  }
  return el('g', { 'data-fig-layer': 'grid', stroke: FIGURE_MUTED, 'stroke-width': m.axisWidth * 0.6, fill: 'none' }, ...lines);
}

/**
 * Spines, ticks, values and titles.
 *
 * `x` ticks are measured from the box's left edge, `y` ticks from its top. An
 * axis passed as `null` draws no spine, ticks or title — a UMAP map has none.
 */
export function drawAxes(
  box: Box,
  x: { ticks: readonly FigureTick[]; title: string } | null,
  y: { ticks: readonly FigureTick[]; title: string } | null,
  style: FigureStyle,
  m: AxisMetrics,
): string {
  const parts: string[] = [];
  const bottom = box.y + box.h;
  const right = box.x + box.w;

  if (style.frame.spines === 'box') {
    parts.push(el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: 'none', 'data-fig-spine': 'box' }));
  } else if (x && y) {
    // One path through the corner, so the two spines meet in a mitre rather
    // than as two butt ends overlapping.
    parts.push(el('path', { d: pathD([[box.x, box.y], [box.x, bottom], [right, bottom]]), fill: 'none', 'data-fig-spine': 'open' }));
  } else if (x) {
    parts.push(el('line', { x1: box.x, y1: bottom, x2: right, y2: bottom, 'data-fig-spine': 'bottom' }));
  } else if (y) {
    parts.push(el('line', { x1: box.x, y1: box.y, x2: box.x, y2: bottom, 'data-fig-spine': 'left' }));
  }

  const dir = style.line.tickDir === 'out' ? 1 : -1;
  if (x) {
    for (const t of x.ticks) {
      const len = t.minor ? m.tickLen * 0.55 : m.tickLen;
      parts.push(el('line', { x1: box.x + t.at, y1: bottom, x2: box.x + t.at, y2: bottom + dir * len }));
    }
  }
  if (y) {
    for (const t of y.ticks) {
      const len = t.minor ? m.tickLen * 0.55 : m.tickLen;
      parts.push(el('line', { x1: box.x, y1: box.y + t.at, x2: box.x - dir * len, y2: box.y + t.at }));
    }
  }
  const strokes = el('g', {
    stroke: FIGURE_INK, 'stroke-width': m.axisWidth, fill: 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter',
  }, ...parts);

  const text: string[] = [];
  if (x) {
    const baseline = bottom + m.tickOut + m.gap + m.tick * CAP_HEIGHT;
    for (const t of labelled(x.ticks)) {
      text.push(el('text', { x: box.x + t.at, y: baseline, 'text-anchor': 'middle', 'font-size': m.tick, 'data-fig-tick': 'x' }, tickLabelBody(t.label, m.tick)));
    }
    if (x.title) {
      const values = labelled(x.ticks).length > 0 ? m.gap + m.tick * (CAP_HEIGHT + DESCENDER) : 0;
      const titleBaseline = bottom + m.tickOut + values + m.titleGap + m.label * CAP_HEIGHT;
      text.push(el('text', { x: box.x + box.w / 2, y: titleBaseline, 'text-anchor': 'middle', 'font-size': m.label, 'data-fig-title': 'x' }, esc(x.title)));
    }
  }
  if (y) {
    const xRight = box.x - m.tickOut - m.gap;
    for (const t of labelled(y.ticks)) {
      text.push(el('text', { x: xRight, y: box.y + t.at + (m.tick * CAP_HEIGHT) / 2, 'text-anchor': 'end', 'font-size': m.tick, 'data-fig-tick': 'y' }, tickLabelBody(t.label, m.tick)));
    }
    if (y.title) {
      const values = labelled(y.ticks).length > 0 ? m.gap + widestLabel(y.ticks, m) : 0;
      // Rotated a quarter turn back, so the glyphs' ascent points away from
      // the axis and the descenders towards it.
      const cx = box.x - m.tickOut - values - m.titleGap - m.label * DESCENDER;
      const cy = box.y + box.h / 2;
      text.push(el('text', {
        x: cx, y: cy, transform: `rotate(-90 ${fmt(cx)} ${fmt(cy)})`, 'text-anchor': 'middle', 'font-size': m.label, 'data-fig-title': 'y',
      }, esc(y.title)));
    }
  }

  return el('g', { 'data-fig-layer': 'axes' }, strokes, el('g', { fill: FIGURE_INK }, ...text));
}
