/* ==========================================================================
   What colour a category is drawn in — one palette, one rule, two panels.

   The Compare chart and the UMAP projection both draw one colour per group, and
   until 2026-08-19 they answered the question differently. The chart took a
   group's colour from **its first member's** place in the sample list, so which
   hue a condition got depended on which tube happened to be imported first. The
   projection had a palette of its own, indexed by the order the groups first
   appeared in the loaded files. Two palettes and two rules, so the same two
   conditions came out blue-and-orange in one figure and cyan-and-amber in the
   other, and nothing the user could do brought them into line.

   The rule is the one a reader can see: **a category's colour is its position
   in the order shown.** First column on the x axis, first colour; move it and
   the colour moves with it. Both panels let that order be arranged — the chart
   under its own summary table, the projection in its grouping step — so a chart
   and a map of the same experiment can be made to agree, and they agree by
   construction once they do.

   **The palette is Okabe–Ito** (2026-10-22), not the population palette the
   rule started with. Conditions are what a reader compares across figures, so
   they are what has to survive colour-vision deficiency and a printed page; the
   population palette was tuned to read against both of the application's
   themes, which is a different job. The colours are hexes rather than theme
   tokens because a condition's colour goes onto white paper whatever theme the
   application is in. See `CONDITION_PALETTE`.

   **A name can be given its own colour**, and then it keeps it wherever it is
   drawn and whatever position it takes — `useFigure().conditionColors`, per
   machine. That is the one exception to position, and it is keyed by the name a
   reader sees, so the Compare chart and the map agree about it too.
   ========================================================================== */

import { CONDITION_PALETTE } from '@/core/figure/style';

/** How many hues the condition palette holds before it repeats. */
export const CONDITION_PALETTE_SIZE = CONDITION_PALETTE.length;

/**
 * The colour of the category at `index` in the order shown. Indices wrap; a
 * negative one is clamped to the first colour.
 */
export function conditionColor(index: number): string {
  const i = Math.max(0, Math.floor(index)) % CONDITION_PALETTE_SIZE;
  return CONDITION_PALETTE[i]!;
}

/**
 * The colour of each category, from the order they are drawn in, with any
 * name the user has coloured themselves keeping its own.
 *
 * Takes the *resolved* order — what is on screen, after any arrangement the user
 * has made — because that is what the rule is about. A label repeated in the
 * list keeps its first position rather than taking a second colour, and an
 * overridden name still occupies its position, so the categories after it keep
 * the colours they had.
 */
export function categoryColors(
  ordered: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const out = new Map<string, string>();
  let position = 0;
  for (const label of ordered) {
    if (out.has(label)) continue;
    out.set(label, overrides[label] ?? conditionColor(position));
    position++;
  }
  return out;
}
