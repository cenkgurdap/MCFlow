/* ==========================================================================
   Shift-click over a list of checkboxes.

   Two lists in this application are the same chore. Ticking eleven single
   stains in the Unmixing wizard, and ticking sixteen violet detectors in
   UMAP's parameter list, were both one click per row — and both grew the same
   gesture in the same pass, which is two implementations of one rule unless
   the rule lives somewhere.

   This is deliberately *not* `extendSelectionTo`, and the difference is what
   the list is. A sample browser row **is** the selection, so a range replaces
   it and Shift-clicking back shortens it. These are checkboxes that
   accumulate: a range paints one state over a block and leaves everything
   outside the block alone.
   ========================================================================== */

/**
 * The block a Shift-click covers, or `null` when there is nothing to measure
 * from.
 *
 * `ordered` is the rows **on screen**, so a filtered list takes what it shows
 * and not the hidden rows between them. `null` back means the anchor is not
 * there — never set, or filtered away — and the caller should treat the click
 * as a plain one, which is also what sets the next anchor. Both ends are
 * included, and the direction does not matter.
 */
export function blockBetween<T>(ordered: readonly T[], anchor: T | null, clicked: T): T[] | null {
  if (anchor === null) return null;
  const from = ordered.indexOf(anchor);
  const to = ordered.indexOf(clicked);
  if (from < 0 || to < 0) return null;
  return from <= to ? ordered.slice(from, to + 1) : ordered.slice(to, from + 1);
}

/**
 * Put a whole block into one state, keeping everything outside it.
 *
 * The state to pass is the **anchor's** — the row the range started from —
 * never the clicked row's. Reading the clicked row means Shift-clicking back
 * inside a block you have just selected clears its first half, which is what
 * the gesture for shortening one would look like.
 *
 * Members already present keep their position; new ones join in the order the
 * block gives them, which is the order they are shown in.
 */
export function withBlock<T>(current: readonly T[], block: readonly T[], on: boolean): T[] {
  const inBlock = new Set(block);
  const rest = current.filter((x) => !inBlock.has(x));
  return on ? [...rest, ...block] : rest;
}
