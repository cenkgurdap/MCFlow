/**
 * Where a gate's caption goes, so it is inside the plot and readable.
 *
 * ## The bug (2026-08-09)
 *
 * A range gate's caption was anchored at the middle of the band's *visible*
 * extent, `textAnchor="middle"`, with the anchor clamped into
 * `[2, plotW - 2]`. Clamping the anchor is not clamping the text: a centred
 * label two pixels from the right edge still puts *half its width* past that
 * edge, and the panel's SVG stops there. So the seeded positive gate on every
 * single stain — an unbounded interval whose visible middle sits far to the
 * right — rendered as `CD4 RB744 + 20.0`, with the percent sign and often a
 * digit cut off. The number the whole step exists to produce was the part that
 * fell off.
 *
 * ## What this returns instead
 *
 * An anchor *and* an alignment. Switching to `end` at `plotW - margin` is exact
 * where clamping is approximate: the right-hand edge of the text lands on the
 * margin whatever the text turns out to measure, so no estimate of glyph width
 * can make it overflow. The estimate below only decides *which* of the three
 * alignments applies, and being a few pixels out there costs a label anchored to
 * the edge slightly sooner than it needed to be — never a clipped one.
 *
 * `measure` is deliberately a parameter with a default rather than a call into
 * the DOM. A canvas `measureText` would be exact, but it needs a font string
 * that resolves — and `getComputedStyle().font` comes back **empty** when the
 * family arrives through a custom property, which is already recorded in
 * PROGRESS.md as the trap that made a harness click three characters early.
 * A per-character average over a 10 px UI font is stable, has no dependency on
 * layout having happened, and is testable.
 */

/** Mean advance width per character, as a fraction of the font size. */
const CHAR_WIDTH_RATIO = 0.56;

/** Clear space kept between the text and either edge of the plot. */
export const LABEL_MARGIN = 4;

export type LabelAnchor = 'start' | 'middle' | 'end';

export interface LabelPlacement {
  x: number;
  anchor: LabelAnchor;
}

/** Rough rendered width of a line, in pixels. */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

/**
 * Place a caption horizontally: centred where it fits, pinned to an edge where
 * it does not.
 *
 * `lines` rather than one string because the caption is stacked — the widest
 * line is what has to fit, and asking the caller to work that out would be a
 * rule living in two places.
 */
export function placeGateLabel({
  center,
  plotW,
  lines,
  fontSize = 10,
  margin = LABEL_MARGIN,
}: {
  center: number;
  plotW: number;
  lines: string[];
  fontSize?: number;
  margin?: number;
}): LabelPlacement {
  const width = Math.max(0, ...lines.map((l) => estimateTextWidth(l, fontSize)));
  const half = width / 2;

  // A caption wider than the plot cannot satisfy both edges. Start-align it, so
  // the *name* is what survives — a truncated identity still says which gate this
  // is, where a truncated percentage says nothing at all.
  if (width >= plotW - margin * 2) return { x: margin, anchor: 'start' };

  if (center + half > plotW - margin) return { x: plotW - margin, anchor: 'end' };
  if (center - half < margin) return { x: margin, anchor: 'start' };
  return { x: center, anchor: 'middle' };
}
