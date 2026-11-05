/**
 * The UMAP figure, composed at its printed size.
 *
 * It replaces the map's own SVG as the exported file: tens of thousands of
 * `<circle>` elements in load order, an unequal aspect, and nothing to say what
 * the two axes were. A projection's axes carry no unit and no meaning of their
 * own, so the figure states only what it can:
 *
 *   - **Equal data aspect.** One unit of embedding distance is the same length
 *     across as up, or a cluster's shape is a property of the frame.
 *   - **No ticks and no spines**; optional UMAP1/UMAP2 arrows in the corner
 *     name the axes without pretending they have a scale.
 *   - **Points as one raster layer**, drawn in a seeded random order — loaded
 *     last must not mean painted on top — so the same seed draws the same file.
 *   - **A compact legend under the map**; the run's settings go to the notes.
 *
 * Pure, like every composer here: the panel supplies the raster callback that
 * paints the points, and this module decides where it goes and how big it is.
 */
import { seededRandom } from '@/core/umap/random';
import { drawLegend, layoutLegend, type LegendEntry } from './legend';
import { figureNotes } from './notes';
import { el, fmt, svgDocument, type ComposedFigure } from './svg';
import { FIGURE_INK, figureSize, fontStack, ptToPx, type FigureStyle } from './style';

/** A point's diameter in the file, and its opacity — inside the 1–3 pt, 0.4–0.6 band. */
export const UMAP_POINT_PT = 1.5;
export const UMAP_POINT_ALPHA = 0.5;

export interface UmapFrame {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface UmapFigureModel {
  /** The embedding's own extent, before it is equalised. */
  extent: UmapFrame;
  legend: ReadonlyArray<{ label: string; color: string }>;
  /** Paint the points into a `w × h` canvas framed on `frame`, `pointPx` across; a data URL. */
  raster: ((widthPx: number, heightPx: number, frame: UmapFrame, pointPx: number) => string | null) | null;
  title: string;
  notes: string[];
}

/** Pad the shorter range so one data unit is the same length in x and y of a `w × h` box. */
export function equalAspect(extent: UmapFrame, w: number, h: number): UmapFrame {
  const dx = extent.xMax - extent.xMin || 1;
  const dy = extent.yMax - extent.yMin || 1;
  const perPx = Math.max(dx / w, dy / h);
  const cx = (extent.xMin + extent.xMax) / 2;
  const cy = (extent.yMin + extent.yMax) / 2;
  return { xMin: cx - (perPx * w) / 2, xMax: cx + (perPx * w) / 2, yMin: cy - (perPx * h) / 2, yMax: cy + (perPx * h) / 2 };
}

/** A seeded permutation of `0 … n-1` — the order points are painted in. */
export function drawOrder(n: number, seed: number): Uint32Array {
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const rand = seededRandom(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  return order;
}

/** UMAP1 → and UMAP2 ↑ from the bottom-left corner: names, not a scale. */
function axisArrows(x: number, y: number, len: number, style: FigureStyle): string {
  const w = ptToPx(style.line.axisPt);
  const head = ptToPx(2.5);
  const size = ptToPx(style.font.tickPt);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    el('line', { x1: fmt(x1), y1: fmt(y1), x2: fmt(x2), y2: fmt(y2), stroke: FIGURE_INK, 'stroke-width': fmt(w) });
  const tip = (d: string) => el('path', { d, fill: FIGURE_INK });
  return el('g', { 'data-fig-layer': 'arrows' },
    line(x, y, x + len, y),
    tip(`M${fmt(x + len)} ${fmt(y)}L${fmt(x + len - head)} ${fmt(y - head / 2)}L${fmt(x + len - head)} ${fmt(y + head / 2)}Z`),
    line(x, y, x, y - len),
    tip(`M${fmt(x)} ${fmt(y - len)}L${fmt(x - head / 2)} ${fmt(y - len + head)}L${fmt(x + head / 2)} ${fmt(y - len + head)}Z`),
    el('text', { x: fmt(x + len / 2), y: fmt(y + size * 1.15), 'text-anchor': 'middle', 'font-size': fmt(size), fill: FIGURE_INK }, 'UMAP1'),
    el('text', {
      x: fmt(x - size * 0.45), y: fmt(y - len / 2), 'text-anchor': 'middle', 'font-size': fmt(size), fill: FIGURE_INK,
      transform: `rotate(-90 ${fmt(x - size * 0.45)} ${fmt(y - len / 2)})`,
    }, 'UMAP2'),
  );
}

export function composeUmapFigure(model: UmapFigureModel, style: FigureStyle, layerScale: number): ComposedFigure {
  const { width } = figureSize(style);
  const pad = ptToPx(4);
  const arrows = style.plot.annotate;
  const gutter = arrows ? ptToPx(style.font.tickPt) * 1.6 : 0;
  const side = width - 2 * pad - gutter;
  const box = { x: pad + gutter, y: pad, w: side, h: side };

  const entries: LegendEntry[] = model.legend.map((l) => ({ label: l.label, swatch: 'point', color: l.color }));
  const legend = style.plot.legend && entries.length ? layoutLegend(entries, width - 2 * pad, style) : null;
  const legendTop = box.y + box.h + gutter + ptToPx(3);
  const height = legend ? legendTop + legend.height + pad : box.y + box.h + gutter + pad;

  const frame = equalAspect(model.extent, box.w, box.h);
  const layers: string[] = [];
  const url = model.raster?.(
    Math.max(1, Math.round(box.w * layerScale)), Math.max(1, Math.round(box.h * layerScale)),
    frame, ptToPx(UMAP_POINT_PT) * layerScale,
  );
  if (url) {
    layers.push(el('g', { 'data-fig-layer': 'points' }, el('image', {
      x: fmt(box.x), y: fmt(box.y), width: fmt(box.w), height: fmt(box.h), preserveAspectRatio: 'none', href: url, 'xlink:href': url,
    })));
  }
  if (arrows) layers.push(axisArrows(box.x, box.y + box.h + gutter * 0.25, Math.min(box.w, box.h) * 0.14, style));
  if (legend) {
    layers.push(el('g', { 'data-fig-layer': 'legend' }, drawLegend(legend, pad + (width - 2 * pad - legend.width) / 2, legendTop, style)));
  }

  const notes = figureNotes({ kind: 'UMAP', style, width, height, lines: model.notes, hasLayer: true });
  return {
    svg: svgDocument({
      width, height, body: layers.join(''), fontFamily: fontStack(style.font.family),
      background: style.frame.background === 'white' ? '#ffffff' : null, title: model.title, notes,
    }),
    width,
    height,
    notes,
  };
}
