/**
 * The compare chart's arithmetic, without the chart.
 *
 * Pure, and separated from `StatisticsView` for the reason every other pure
 * module in this project is separated from its renderer: *"where does the y axis
 * start"* and *"does this key fit on one line"* are questions about numbers and
 * strings, and a question about numbers should be answerable without mounting a
 * component. Both were previously inline in a 1400-line view and asserted by
 * nothing, which is how the axis spent 2026-08-10 to 2026-08-11 forcing zero
 * onto a ratio that lives between 0.44 and 0.47.
 */

import { formatStat, type StatKind } from '@/core/statistics';
import { tickText } from '@/core/figure/compareFigure';
import { WIDTH_PRESETS } from '@/core/figure/style';

/** 1, 2 or 5 × a power of ten — the same ladder `linearTicks` walks. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

/** How much of the span is left as air above and below the data. */
export const FRAME_PAD = 0.08;

/**
 * The y axis: framed on the data, with ticks on round numbers inside it.
 *
 * **Two separate decisions, and the first one changed on 2026-08-11 (Item 1).**
 *
 * *Where the axis starts and ends.* It used to be `Math.min(0, …)` to the
 * highest tick above the maximum — zero was forced into every axis, on the
 * reasoning that a bar chart with a non-zero baseline overstates its
 * differences. That reasoning was right about the chart this no longer is. A bar
 * encodes magnitude by its length from the baseline, so moving the baseline
 * rescales the encoding; a **dot** encodes it by position against a labelled
 * axis, which is why every scatter-with-mean figure in the literature frames on
 * its data. Forcing zero onto a membrane-order index that lives between 0.44 and
 * 0.47 spends 95% of the plot on empty space and leaves the differences the
 * figure exists to show inside two pixels. So: the extent it is given — which
 * the caller takes over the points **and** the error bars — padded by
 * `FRAME_PAD`, and no zero unless the data goes there.
 *
 * *Where the ticks go.* Unchanged — the `niceStep` ladder, so the labels are
 * numbers somebody chose. What is new is that the ticks are placed *inside* the
 * framed range rather than the range being widened out to the ticks: widening is
 * what re-introduced the slack this item is about, up to a whole step at each
 * end.
 *
 * Falls back to the padded bounds themselves when fewer than two ticks land
 * inside — an axis with one line on it cannot be read.
 */
export function frameTicks(
  min: number,
  max: number,
  target = 5,
): { lo: number; hi: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi === lo) {
    // Every sample identical — which happens on `% of parent` of a root
    // population, where the answer really is 100 for all of them. A window
    // around the value beats a zero-height axis.
    const pad = Math.max(Math.abs(hi) * 0.05, 0.5);
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * FRAME_PAD;
    lo -= pad;
    hi += pad;
  }

  const step = niceStep((hi - lo) / target);
  const first = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let i = 0; i < 40; i++) {
    const v = first + i * step;
    if (v > hi + step * 1e-9) break;
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return ticks.length > 1 ? { lo, hi, ticks } : { lo, hi, ticks: [lo, hi] };
}

/**
 * A tick label, at the precision the tick *spacing* earns.
 *
 * `formatStat` is the table's formatter and gives a percentage two decimal
 * places, which is right in a column of numbers being compared against each
 * other and wrong on an axis: an axis stepping by 20 read `0.00 20.00 40.00
 * 60.00 80.00 100.00`, six labels carrying twelve digits that are all zero and
 * that widen the left margin to hold them. A count keeps its own grouped
 * formatting.
 *
 * **A parameter statistic takes the same rule since 0.34.** It kept
 * `formatStat`'s four decimals so the axis matched the table digit for digit,
 * and printed `0.4400 0.4500 0.4600`; an axis tick is a position on a scale,
 * not a reported value, and the table and the export keep their four decimals.
 * `tickText` is the figure composer's own rule, so screen and file agree.
 */
export function axisTickLabel(v: number, ticks: number[], kind: StatKind): string {
  if (kind === 'count') return formatStat(v, kind);
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;
  return tickText(v, step);
}

/* -------------------------------------------------------------------------
   Figure width
   ------------------------------------------------------------------------- */

/**
 * How wide the figure is, in millimetres of paper.
 *
 * ## Why a size control here, when the plot exporter's was removed
 *
 * The per-plot exporter offered *On-screen / 85 mm / 178 mm / 300 mm* and those
 * presets were deleted on 2026-08-18, because a cytometry plot is framed in a
 * square panel and rescaling it afterwards is a claim about a figure that was
 * already composed — *a figure is the size of the panel it was framed in*. That
 * rule is not being reversed. It is being obeyed: the width chosen here is the
 * width the chart is **laid out at**, on screen, before anything is exported.
 * Margins, slot widths, whether the category labels rotate and how many legend
 * rows there are are all recomputed from it, so what leaves the application is
 * the figure that was composed rather than a scaled photograph of a wider one.
 *
 * ## Why millimetres, and why these three
 *
 * A CSS pixel is defined at 96 per inch and this application's exporters already
 * take that literally — `pagePointSize` writes 72/96 points per unit and puts no
 * scaling anywhere on the path. So the chart has always had a physical size, and
 * at its old fixed 680 units that size was 180 mm: a double-column figure. The
 * three widths are the three a journal asks for, and the type stays at the size
 * it is set at — 10 units is 7.5 pt at any of them, which is why the layout is
 * recomputed rather than scaled. Scaling a 180 mm figure down to 85 mm would set
 * the same labels at 3.5 pt.
 */
export const FIGURE_WIDTHS = WIDTH_PRESETS;

/** The default: single column, as every figure type starts (0.35). */
export const DEFAULT_FIGURE_MM = 85;

/** CSS pixels per millimetre — 96 per inch, which is what the exporters assume. */
export const PX_PER_MM = 96 / 25.4;

/** A figure width in millimetres, as the SVG's own width. */
export function chartPixelWidth(mm: number): number {
  // Any width a figure style can hold; outside a page's range, the default.
  const known = Number.isFinite(mm) && mm >= 40 && mm <= 250 ? mm : DEFAULT_FIGURE_MM;
  return Math.round(known * PX_PER_MM);
}

/** A drawing dimension in millimetres of paper, for a hint under a control. */
export function millimetres(px: number): number {
  return Math.round((px / PX_PER_MM) * 10) / 10;
}

/** One sample's value inside a category, with the identity the dot is coloured by. */
export interface CategoryPoint {
  sampleId: string;
  sampleName: string;
  /**
   * The palette index this dot is **drawn** in — not the sample's own.
   *
   * It was `Sample.colorIndex` outright when it arrived on 2026-08-11, and from
   * 2026-08-12 the *group's* colour — its first member's index — wherever the
   * sample had been put in one. Since 2026-08-19 it is the category's **place on
   * the x axis**, which is the rule the UMAP projection colours by too; see
   * `panels/groupColors.ts`. Named for what it does to the mark rather than for
   * where the number came from, because those have never been the same question.
   */
  colorIndex: number;
  value: number;
}

/** Baseline-to-baseline distance of one legend row. */
export const LEGEND_LINE = 14;
/** How many sample keys are worth printing before the key is worse than none. */
export const LEGEND_LIMIT = 16;

/**
 * Flow a sample key across the width of the plot, wrapping.
 *
 * Laid out here rather than in the markup because it is arithmetic and the SVG's
 * own height depends on the answer — the canvas has to be as tall as the legend
 * turns out to be, and the exported PNG is that canvas. Widths are estimated
 * from the 9.5 px UI face's advance, which is the same approximation the
 * rotate-or-not decision uses.
 *
 * Past `LEGEND_LIMIT` samples the key stops being one: forty rows of colour
 * chips is a second table, and the palette has only twelve hues to give. The
 * overflow is stated as a final entry rather than silently dropped, and every
 * dot still names itself on hover whatever the count.
 */
export function layOutLegend(
  samples: readonly CategoryPoint[],
  width: number,
): { items: Array<{ p: CategoryPoint; x: number; row: number }>; rows: number; overflow: number } {
  if (samples.length === 0) return { items: [], rows: 0, overflow: 0 };
  const shown = samples.slice(0, LEGEND_LIMIT);
  const items: Array<{ p: CategoryPoint; x: number; row: number }> = [];
  let x = 0;
  let row = 0;
  for (const p of shown) {
    const w = 12 + p.sampleName.length * 5 + 14;
    if (x > 0 && x + w > width) { row++; x = 0; }
    items.push({ p, x, row });
    x += w;
  }
  return { items, rows: row + 1, overflow: samples.length - shown.length };
}

/* -------------------------------------------------------------------------
   Significance brackets
   ------------------------------------------------------------------------- */

/** Baseline-to-baseline distance of one bracket rung, in plot units. */
export const BRACKET_LINE = 17;
/** How far the first rung floats above the tallest mark it spans. */
export const BRACKET_GAP = 10;

/** One comparison, before it has been given a height to sit at. */
export interface BracketSpec {
  /** Category indices, in drawing order. `a` is always to the left of `b`. */
  a: number;
  b: number;
  label: string;
}

export interface Bracket extends BracketSpec {
  /** Which rung this bracket sits on; 0 is closest to the data. */
  row: number;
}

/**
 * Stack the brackets so none of them crosses another.
 *
 * The arithmetic, away from the markup, for the same reason `layOutLegend` is:
 * the SVG's own height depends on the answer, and the canvas the exported PNG is
 * rasterised from has to be as tall as the brackets turn out to be. Getting this
 * wrong does not draw a wrong number — it clips the top bracket out of the
 * figure, which is worse, because the figure still looks finished.
 *
 * **Shortest span lowest.** Sorted by width and then by left edge, each bracket
 * takes the lowest rung on which it does not touch one already placed. That is
 * the convention every paper figure uses and it is not merely aesthetic: a long
 * bracket drawn under a short one it contains would have to cross it, and a
 * reader cannot then tell which pair either end belongs to.
 *
 * Endpoints count as occupied — two brackets sharing a category sit on different
 * rungs — because their vertical ticks would otherwise land on the same x.
 */
export function layOutBrackets(specs: readonly BracketSpec[]): { brackets: Bracket[]; rows: number } {
  if (specs.length === 0) return { brackets: [], rows: 0 };

  const ordered = [...specs].sort((p, q) => (p.b - p.a) - (q.b - q.a) || p.a - q.a);
  // One list of occupied spans per rung, so placement is a scan rather than a
  // grid the category count would have to be known to size.
  const occupied: Array<Array<[number, number]>> = [];
  const brackets: Bracket[] = [];

  for (const spec of ordered) {
    const lo = Math.min(spec.a, spec.b);
    const hi = Math.max(spec.a, spec.b);
    let row = 0;
    while (occupied[row]?.some(([s, e]) => lo <= e && s <= hi)) row++;
    (occupied[row] ??= []).push([lo, hi]);
    brackets.push({ a: lo, b: hi, label: spec.label, row });
  }

  return { brackets, rows: occupied.length };
}
