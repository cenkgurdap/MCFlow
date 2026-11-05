/* ==========================================================================
   The colour key, laid out in the figure's own coordinates.

   The key used to be HTML underneath the map — a wrapping row of dots and
   names, sitting on the panel's background rather than in the drawing. It read
   perfectly on screen and was absent from every exported file, so a PNG or a
   PDF of a projection arrived as coloured clouds with nothing anywhere saying
   which colour was which condition.

   The exporter serialises the map's SVG element and nothing else, and that is
   the property that keeps PNG and PDF from drifting apart — so the fix is to
   put the key *inside* that element, not to teach the exporter about a second
   one. (The two axis names on a worksheet plot are drawn back at export time,
   but only because each is an interactive picker on screen. A key is text.)

   What is left here is the arithmetic: where each entry sits, wrapping across
   the figure's width the way the flex row wrapped across the panel's, and how
   much taller the figure is for carrying it. The view draws that once, and the
   file gets the same geometry the screen does.
   ========================================================================== */

import { textWidth } from '../plotExport';

/** One entry: a colour and what it means. */
export interface LegendItem {
  label: string;
  color: string;
}

/** An entry with a place, in SVG user units relative to the strip's top. */
export interface PlacedLegendItem extends LegendItem {
  /** Centre of the swatch. */
  dotX: number;
  /** Where the label's baseline starts. */
  textX: number;
  /** Vertical middle of the row, shared by both. */
  y: number;
}

export interface LegendLayout {
  items: PlacedLegendItem[];
  /** How much taller the figure is for carrying the key. Zero when empty. */
  height: number;
}

/**
 * Type size. 11 px is `--text-2xs`, which is what the key was set in as HTML,
 * and the size `CAPTION_SIZE` sets the caption above the plot in — the two are
 * the same size for the same reason.
 */
export const LEGEND_SIZE = 11;
/** Swatch radius. A disc, because the marks it explains are discs. */
export const LEGEND_DOT = 3.5;
/** Line box for one row of entries. */
const ROW = 15;
/** Swatch to its own label. */
const DOT_GAP = 5;
/** One entry to the next. */
const ENTRY_GAP = 14;
/** Between the plot and the first row. */
const PAD = 8;
/** Side margin, so an entry never touches the edge. */
const SIDE = 6;

/**
 * Place the entries, wrapping to as many rows as it takes.
 *
 * Rows are broken first and centred after, because a row cannot be centred
 * until it is known what else is on it — and centred, because the caption above
 * the figure is centred and a key hugging the left edge under a square plot
 * reads as a misalignment rather than as a choice.
 */
export function layoutLegend(items: LegendItem[], width: number): LegendLayout {
  if (items.length === 0) return { items: [], height: 0 };

  const widthOf = (item: LegendItem) => LEGEND_DOT * 2 + DOT_GAP + textWidth(item.label, LEGEND_SIZE);
  const max = Math.max(40, width - SIDE * 2);

  const rows: LegendItem[][] = [[]];
  let used = 0;
  for (const item of items) {
    const w = widthOf(item);
    const row = rows[rows.length - 1]!;
    // A single entry wider than the figure still gets its own row rather than
    // being dropped — a group's name is not something to truncate silently.
    if (row.length > 0 && used + ENTRY_GAP + w > max) {
      rows.push([item]);
      used = w;
    } else {
      row.push(item);
      used += (row.length > 1 ? ENTRY_GAP : 0) + w;
    }
  }

  const placed: PlacedLegendItem[] = [];
  rows.forEach((row, r) => {
    const total = row.reduce((a, it) => a + widthOf(it), 0) + ENTRY_GAP * (row.length - 1);
    const y = PAD + r * ROW + ROW / 2;
    let x = Math.max(SIDE, (width - total) / 2);
    for (const item of row) {
      placed.push({ ...item, dotX: x + LEGEND_DOT, textX: x + LEGEND_DOT * 2 + DOT_GAP, y });
      x += widthOf(item) + ENTRY_GAP;
    }
  });

  return { items: placed, height: PAD + rows.length * ROW };
}
