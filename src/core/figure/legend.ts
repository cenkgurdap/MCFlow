/**
 * A compact legend, laid out in rows and drawn inside the figure.
 *
 * Inside the SVG for the reason the UMAP colour key moved there: anything that
 * sits beside a figure instead of in it is in no exported file. Entries wrap to
 * the width they are given, so one legend serves an 85 mm column and a 183 mm
 * page without a second layout.
 */
import { CAP_HEIGHT, DESCENDER, measureText } from './measure';
import { FIGURE_INK, ptToPx, type FigureStyle } from './style';
import { el, esc, fmt } from './svg';

export interface LegendEntry {
  label: string;
  /** How the entry's mark is drawn: a filled square, a line, a dashed line or a dot. */
  swatch: 'fill' | 'line' | 'dashed' | 'point';
  color: string;
  /** Fill opacity for a `fill` or `point` swatch, matching what it stands for. */
  opacity?: number;
}

export interface LegendLayout {
  width: number;
  height: number;
  rows: Array<Array<{ entry: LegendEntry; x: number; width: number }>>;
  size: number;
  rowHeight: number;
}

const SWATCH_EM = 1.6;

/** Rows of entries no wider than `maxWidth`. */
export function layoutLegend(entries: readonly LegendEntry[], maxWidth: number, style: FigureStyle): LegendLayout {
  const size = ptToPx(style.font.labelPt);
  const rowHeight = size * 1.35;
  const swatch = size * SWATCH_EM;
  const between = size * 1.1;
  const rows: LegendLayout['rows'] = [];
  let row: LegendLayout['rows'][number] = [];
  let x = 0;
  let widest = 0;
  for (const entry of entries) {
    const width = swatch + size * 0.35 + measureText(entry.label, size, style.font.family);
    if (row.length > 0 && x + width > maxWidth) {
      rows.push(row);
      widest = Math.max(widest, x - between);
      row = [];
      x = 0;
    }
    row.push({ entry, x, width });
    x += width + between;
  }
  if (row.length > 0) { rows.push(row); widest = Math.max(widest, x - between); }
  return { width: widest, height: rows.length * rowHeight, rows, size, rowHeight };
}

/** The legend with its top-left corner at (`x`, `y`). */
export function drawLegend(layout: LegendLayout, x: number, y: number, style: FigureStyle): string {
  const { size, rowHeight } = layout;
  const swatch = size * SWATCH_EM;
  const line = ptToPx(style.line.dataPt);
  const items: string[] = [];
  layout.rows.forEach((row, r) => {
    const baseline = y + r * rowHeight + (rowHeight + size * (CAP_HEIGHT - DESCENDER)) / 2;
    const mid = baseline - (size * CAP_HEIGHT) / 2;
    for (const { entry, x: ex } of row) {
      const sx = x + ex;
      let mark: string;
      if (entry.swatch === 'fill') {
        const s = size * 0.8;
        mark = el('rect', {
          x: sx + (swatch - s) / 2, y: mid - s / 2, width: s, height: s,
          fill: entry.color, 'fill-opacity': entry.opacity ?? 0.35, stroke: entry.color, 'stroke-width': line * 0.8,
        });
      } else if (entry.swatch === 'point') {
        mark = el('circle', { cx: sx + swatch / 2, cy: mid, r: size * 0.3, fill: entry.color, 'fill-opacity': entry.opacity ?? 1 });
      } else {
        mark = el('line', {
          x1: sx, y1: mid, x2: sx + swatch, y2: mid, stroke: entry.color, 'stroke-width': line,
          'stroke-dasharray': entry.swatch === 'dashed' ? `${fmt(line * 3)} ${fmt(line * 2)}` : null,
        });
      }
      items.push(mark, el('text', { x: sx + swatch + size * 0.35, y: baseline, 'font-size': size }, esc(entry.label)));
    }
  });
  return el('g', { 'data-fig-layer': 'legend', fill: FIGURE_INK }, ...items);
}
