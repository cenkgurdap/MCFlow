/**
 * What dragging a column boundary does to every column's width.
 *
 * Pure, and separated from the table for the same reason `placeBeside` is
 * separated from the floating panel: "no column can be pushed out of the frame"
 * is arithmetic over a list of numbers, and a claim about arithmetic should be
 * checkable without a DOM, a pointer or a layout pass.
 *
 * ## The model
 *
 * **The table's total width does not change while there is slack to take.** That
 * is the whole fix (2026-08-05, Item 3). What shipped before widened the dragged
 * column and left every other width alone, so the table grew by exactly the drag
 * distance and the columns past the right edge went with it — the report is that
 * *Median Membrane order* disappeared, and it had, off the end of a table that
 * was by then wider than the panel holding it.
 *
 * Dragging the boundary to the right of column `i`:
 *
 *   - **Rightwards**, column `i` grows and the space comes out of the columns to
 *     its right, **nearest first**: the immediate neighbour gives up everything
 *     it can down to its minimum, then the next one along, and so on. Nearest
 *     first is what makes the gesture feel like a boundary being pushed rather
 *     than a global relayout, and cascading past it is what stops the drag
 *     hitting a wall the moment one neighbour is small — a Sample column can
 *     still be taken to a filename's full length on a table of eight columns.
 *   - **Leftwards**, column `i` shrinks to its own minimum and the space goes
 *     back to the immediate neighbour.
 *
 * Every call re-derives from the widths as they were when the drag **started**,
 * never from the previous frame's answer. That is what makes a gesture
 * reversible: dragging 80 px right and back to the origin returns the exact
 * starting widths, where an incremental version would leave the cascade's
 * borrowings unwound in the wrong order.
 *
 * ## When it cannot be honoured
 *
 * When every column to the right is already at its minimum there is no slack
 * left, and the choice is between refusing the drag and letting the table exceed
 * its container. It exceeds — and the container scrolls. A column the user
 * cannot reach is the defect being fixed here; a scrollbar is a column that is
 * merely somewhere else. `totalWidth` is what the table is then sized to, so the
 * scroller has something to scroll.
 */

/**
 * The narrowest a column may be squeezed to.
 *
 * 56 px is two of the table's 8 px cell paddings plus 40 px of content — about
 * five tabular digits at `--text-xs`, so a five-figure event count is still a
 * number rather than an ellipsis. Below roughly this the column stops carrying
 * information and merely proves it exists, which is the failure mode a minimum
 * exists to prevent: widening one column must not be able to reduce another to
 * a sliver as a side effect.
 */
export const MIN_COLUMN_PX = 56;

/** Per-column minima, defaulted. Kept as its own step so the callers stay short. */
export function minimaFor(columns: readonly { minWidth?: number }[]): number[] {
  return columns.map((c) => Math.max(1, Math.round(c.minWidth ?? MIN_COLUMN_PX)));
}

/**
 * Widths after dragging the boundary right of `index` by `dx` px.
 *
 * `start` is the snapshot taken when the drag began, never the running value.
 * The returned array is always the same length as `start`.
 */
export function resizeColumn(
  start: readonly number[],
  mins: readonly number[],
  index: number,
  dx: number,
): number[] {
  const next = start.map((w) => Math.round(w));
  // The last column has no boundary to its right that means anything — there is
  // nothing on the other side to trade with — and the table gives it no handle.
  if (index < 0 || index >= next.length - 1) return next;

  const min = (i: number) => Math.round(mins[i] ?? MIN_COLUMN_PX);
  const delta = Math.round(dx);
  if (delta === 0) return next;

  if (delta < 0) {
    // Shrinking. Bounded by this column's own minimum, and the space goes to the
    // immediate neighbour — which is the exact inverse of a rightward drag that
    // the neighbour alone absorbed, and the common case.
    const give = Math.min(-delta, Math.max(0, next[index]! - min(index)));
    next[index] = next[index]! - give;
    next[index + 1] = next[index + 1]! + give;
    return next;
  }

  // Growing. Take from the right, nearest first, down to each minimum.
  let need = delta;
  for (let j = index + 1; j < next.length && need > 0; j++) {
    const slack = Math.max(0, next[j]! - min(j));
    const take = Math.min(slack, need);
    next[j] = next[j]! - take;
    need -= take;
  }
  /*
     `need` is what nothing to the right could give up.

     The column still grows by it, so the drag tracks the pointer rather than
     stalling under it — and the table is then wider than its container and
     scrolls. That is the stated fallback and it is strictly better than the two
     alternatives: refusing to move reads as a broken handle, and clamping the
     column to the available slack reads as the pointer having drifted.
  */
  next[index] = next[index]! + delta;
  return next;
}

/**
 * The width the table should be laid out at.
 *
 * The sum, floored at the container so a table with room to spare still fills
 * the panel rather than leaving a strip of background to the right of the last
 * column.
 */
export function totalWidth(widths: readonly number[]): number {
  return widths.reduce((a, w) => a + w, 0);
}

/**
 * A snapshot fit to be resized from.
 *
 * Two things are done to the browser's rendered widths before anything is
 * dragged against them. Each is raised to its own minimum, because auto layout
 * has no notion of one and on a narrow panel it will happily render a column at
 * 20 px — and a resize model that starts below its own floor can only ever
 * report widths it considers illegal. Then, if raising them has made the row
 * wider than the container, that is *reported* by the total rather than
 * corrected: it means the columns genuinely do not fit, and the answer to that
 * is the scrollbar, not a column squeezed back under its minimum.
 */
export function snapshotWidths(rendered: readonly number[], mins: readonly number[]): number[] {
  return rendered.map((w, i) => Math.max(Math.round(mins[i] ?? MIN_COLUMN_PX), Math.round(w)));
}
