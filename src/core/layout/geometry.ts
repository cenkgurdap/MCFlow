/**
 * Worksheet geometry: where panels sit, and how big they are.
 *
 * The worksheet used to be a CSS grid — panels went into cells in insertion
 * order, and "move this plot next to that one" was not a thing you could do. A
 * cytometry worksheet is a figure being assembled: the arrangement carries
 * meaning (a gating path reads left to right, replicates line up in a column),
 * and an arrangement that the tool picks for you is one you spend the session
 * working around.
 *
 * So panels carry explicit coordinates and the worksheet is a positioned canvas.
 * Two consequences, both deliberate:
 *
 *  - **The canvas grows to fit its content.** Dropping a plot to the right of
 *    the last one extends the scrollable area rather than wrapping it onto the
 *    next row, because wrapping is the grid behaviour this replaces.
 *  - **"Empty space" is any rectangle that overlaps nothing**, which is what the
 *    drag-to-create gestures now test against.
 *
 * Kept pure and store-free so the placement rules can be tested directly, and so
 * `plotStore` and `PlotGrid` can both use them without either importing the
 * other.
 */

/**
 * Plot-area margins, in CSS pixels.
 *
 * Lives here rather than in `PlotCanvas` because the worksheet has to know how
 * tall a panel of a given width will be *before* it is rendered — placement,
 * overlap and canvas bounds all depend on it — and two copies of these numbers
 * would drift the first time an axis label needed more room.
 *
 * Every one of them is as small as the thing inside it. `left` is the y-axis
 * parameter control laid on its side (26 px) plus the widest tick label; `bottom`
 * is the x tick labels plus the x control; `top` and `right` are only enough to
 * keep the last tick label from being clipped. They were larger, and the space
 * was doing nothing: a plot is what a panel is for, and chrome is what is left.
 */
export const PLOT_MARGIN = { top: 8, right: 8, bottom: 42, left: 55 } as const;

/*
 * There is no drag rail any more.
 *
 * `PANEL_RAIL_W` was 12 px of chrome down the left edge, and it was the *only*
 * thing that moved a panel. That restriction was right about the hazard and too
 * strict about the remedy: what must not move a panel is a **control** and a
 * **gate**, not the whole panel. So the entire background — the margins, the
 * toolbar's empty space, the plot area itself with no tool armed — is now the
 * drag region, and the rail is gone along with the pixels it was costing the
 * square. See `panels/panelDragTarget.ts` for the rule that replaced it.
 */

/** Toolbar row above the plot surface (`h-8`). */
export const PANEL_TOOLBAR_H = 32;

/**
 * Below this width a panel drops its footer and its optional toolbar controls.
 *
 * At the new default size four panels fit across a normal worksheet, which is
 * the point — but four panels across means each one is about 300 px, and a
 * toolbar that fits at 520 px does not fit at 300.
 */
export const PANEL_COMPACT_BELOW = 430;

/**
 * Default panel width, in CSS pixels.
 *
 * Four across a typical worksheet — about 1200 px once the sidebar and the
 * inspector have taken theirs — is the density goal, and 290 is the **largest**
 * width that still meets it exactly: `4 × 290 + 4 × PANEL_GAP = 1200`. One pixel
 * more and the fourth panel wraps.
 *
 * That is the whole of the room a size increase had to give, which is worth
 * stating plainly: the panel toolbar did not fit at 280 — the delete control was
 * being clipped by the toolbar's own `overflow-hidden` — and ten more pixels do
 * not fix that on their own. What fixes it is the toolbar going **icon-only**
 * below `PANEL_COMPACT_BELOW`, plus the rail and the sample pin both being gone.
 * The increase is taken because it is free, not because it was sufficient.
 *
 * 520 remains the *maximum*: about the size of a printed figure panel, and past
 * it a plot stops being readable as one object.
 */
export const PANEL_DEFAULT_WIDTH = 290;
export const PANEL_MIN_WIDTH = 190;
export const PANEL_MAX_WIDTH = 520;

/** Gap left between panels when the layout places them automatically. */
export const PANEL_GAP = 10;

/**
 * Drag snapping, in CSS pixels.
 *
 * Light enough to be invisible as a constraint and heavy enough that two panels
 * dragged to "about the same place" line up exactly. Panels are *not* confined
 * to a lattice — this only quantises where a drag lands.
 */
export const DRAG_SNAP = 8;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function snapTo(v: number, step = DRAG_SNAP): number {
  return Math.round(v / step) * step;
}

export function clampWidth(w: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(w)));
}

/** Is a panel of this width in its cramped layout? */
export function isCompactWidth(w: number): boolean {
  return w < PANEL_COMPACT_BELOW;
}

/**
 * Height of the plot **surface** for a given panel width.
 *
 * The data rectangle is square — both axes of a cytometry plot are the same kind
 * of measurement, and a population that is round at 1:1 becomes an ellipse at
 * 2:1 and reads as a different population — so the surface is that square plus
 * the axis margins, which are added back rather than eaten out of it.
 *
 * One number for every plot type. A density plot used to give up a strip on the
 * right to its colour bar, which made its square smaller than a dot plot's at
 * the same panel width; the bar is gone, so all three types now draw the same
 * square and switching between them changes only how the events are marked.
 */
export function plotSurfaceHeight(width: number): number {
  const square = width - PLOT_MARGIN.left - PLOT_MARGIN.right;
  return Math.max(160, Math.max(120, square) + PLOT_MARGIN.top + PLOT_MARGIN.bottom);
}

/**
 * Total panel height — the toolbar and the plot surface, and nothing else.
 *
 * There is no footer any more. It carried the visible axis range and the words
 * "Fitted to data"; with zoom gone a plot is *always* fitted to its data, so the
 * caption said the same thing on every panel forever and the range it printed is
 * already written along both axes. Twenty-four pixels of chrome for a constant.
 */
export function panelHeight(width: number): number {
  return PANEL_TOOLBAR_H + plotSurfaceHeight(width);
}

/** The box a panel of this width occupies at this position. */
export function panelRect(x: number, y: number, w: number): Rect {
  return { x, y, w, h: panelHeight(w) };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when a rectangle touches nothing already on the worksheet. */
export function isFree(candidate: Rect, existing: Rect[]): boolean {
  return !existing.some((r) => overlaps(candidate, r));
}

/**
 * Where the next automatically-placed panel goes.
 *
 * Row-major scan on a lattice of the panel's own size plus the gap: left to
 * right along the visible width, then down. It reads like the grid it replaces
 * for anyone who never drags anything, which is the point — free positioning
 * should be available, not compulsory.
 *
 * `viewportWidth` only decides where the scan wraps. A panel is never refused
 * for want of room: the canvas grows instead, which is what `contentBounds`
 * below is for.
 */
export function nextFreePosition(
  existing: Rect[],
  width: number,
  viewportWidth: number,
): { x: number; y: number } {
  const h = panelHeight(width);
  const stepX = width + PANEL_GAP;
  const stepY = h + PANEL_GAP;
  const perRow = Math.max(1, Math.floor((viewportWidth + PANEL_GAP) / stepX));

  for (let row = 0; row < 500; row++) {
    for (let col = 0; col < perRow; col++) {
      const candidate = { x: PANEL_GAP + col * stepX, y: PANEL_GAP + row * stepY, w: width, h };
      if (isFree(candidate, existing)) return { x: candidate.x, y: candidate.y };
    }
  }
  // Pathological only — 500 rows of panels. Land below everything rather than
  // on top of something.
  const bottom = existing.reduce((m, r) => Math.max(m, r.y + r.h), 0);
  return { x: PANEL_GAP, y: bottom + PANEL_GAP };
}

/**
 * The nearest free position to where a drop landed.
 *
 * A release that overlaps an existing panel is not refused — refusing a drop
 * gives the user nothing to act on — it is nudged outward in a widening ring
 * until it fits. Falls back to the ordinary scan if it cannot find room nearby.
 */
export function nearestFreePosition(
  desired: { x: number; y: number },
  existing: Rect[],
  width: number,
  viewportWidth: number,
): { x: number; y: number } {
  const h = panelHeight(width);
  const start = { x: Math.max(0, snapTo(desired.x)), y: Math.max(0, snapTo(desired.y)) };
  if (isFree({ ...start, w: width, h }, existing)) return start;

  const step = DRAG_SNAP * 4;
  for (let ring = 1; ring <= 40; ring++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const candidate = {
        x: Math.max(0, start.x + dx * ring * step),
        y: Math.max(0, start.y + dy * ring * step),
        w: width,
        h,
      };
      if (isFree(candidate, existing)) return { x: candidate.x, y: candidate.y };
    }
  }
  return nextFreePosition(existing, width, viewportWidth);
}

/**
 * How large the scrollable canvas has to be.
 *
 * Content extent plus one gap, floored at the visible size so an almost-empty
 * worksheet does not present a scrollbar for nothing. This is what makes a panel
 * dragged past the right-hand edge extend the worksheet instead of being clipped
 * or bounced back.
 */
export function contentBounds(
  rects: Rect[],
  viewport: { width: number; height: number },
): { width: number; height: number } {
  let right = 0;
  let bottom = 0;
  for (const r of rects) {
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return {
    width: Math.max(viewport.width, right + PANEL_GAP),
    height: Math.max(viewport.height, bottom + PANEL_GAP),
  };
}

/**
 * Which way a resize handle points.
 *
 * The compass letters are the handle's own position on the panel, so `'nw'` is
 * the top-left corner and dragging it moves both the top and the left edge.
 */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * Width change for a pointer delta, projected onto the one free dimension.
 *
 * A panel has exactly one degree of freedom — the plot area is square, so the
 * height follows the width through `plotSurfaceHeight` — which makes an
 * aspect-locked resize entirely a question of turning a two-dimensional pointer
 * delta into one number.
 *
 * For an edge that is one component of the delta, signed so that dragging away
 * from the panel grows it. For a **corner** it is the least-squares fit of
 * `(dw, dw)` to the delta, i.e. their mean: drag diagonally by ten pixels and
 * the panel grows by ten, and a drag that wanders off the diagonal still tracks
 * the pointer rather than snapping between the two axes — which is what picking
 * the dominant component would do.
 */
export function widthDelta(dir: ResizeDir, dx: number, dy: number): number {
  const ax = dir.includes('e') ? dx : dir.includes('w') ? -dx : null;
  const ay = dir.includes('s') ? dy : dir.includes('n') ? -dy : null;
  if (ax !== null && ay !== null) return (ax + ay) / 2;
  return ax ?? ay ?? 0;
}

/**
 * How far the content sits from the worksheet's origin.
 *
 * The canvas is sized from its content, so it already *grows* to hold a panel
 * dropped past the right-hand edge — but growing alone is not symmetric. Delete
 * the panel that caused the growth and the remaining ones may all sit far from
 * the origin, leaving a band of empty worksheet before the first plot that
 * nothing will ever reclaim: the bounds are computed from the far edge, and the
 * near edge is never considered.
 *
 * This is the near edge. Applying it as a translation to every panel preserves
 * the arrangement exactly — every relative position is unchanged — while pulling
 * the whole figure back against the top-left, which is what "fit to content"
 * means from the other side. Never negative: it only ever reclaims dead space,
 * so it cannot push content away from the origin.
 */
export function contentOffset(rects: Rect[]): { dx: number; dy: number } {
  if (rects.length === 0) return { dx: 0, dy: 0 };
  let minX = Infinity;
  let minY = Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
  }
  return { dx: Math.max(0, minX - PANEL_GAP), dy: Math.max(0, minY - PANEL_GAP) };
}

/**
 * Scale that fits every panel into the viewport, for *zoom to fit*.
 *
 * Never above 1: a worksheet with two plots on it should show them at their
 * real size rather than magnifying them to fill the window, which would undo
 * the reason panels are capped in the first place.
 */
export function fitScale(
  rects: Rect[],
  viewport: { width: number; height: number },
): number {
  if (rects.length === 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const bounds = contentBounds(rects, { width: 0, height: 0 });
  const scale = Math.min(viewport.width / bounds.width, viewport.height / bounds.height);
  return Math.min(1, Math.max(0.2, scale));
}

/**
 * Positions for a layout migrated from the old grid.
 *
 * A workspace saved before panels had coordinates has only insertion order and
 * a column count, which is exactly enough to reproduce what it looked like — so
 * a migrated worksheet opens in the arrangement it was saved in rather than
 * being re-flowed into something the user has to recognise.
 */
export function positionsForGrid(
  count: number,
  columns: number,
  width = PANEL_DEFAULT_WIDTH,
): Array<{ x: number; y: number }> {
  const cols = Math.max(1, columns);
  const h = panelHeight(width);
  return Array.from({ length: count }, (_, i) => ({
    x: PANEL_GAP + (i % cols) * (width + PANEL_GAP),
    y: PANEL_GAP + Math.floor(i / cols) * (h + PANEL_GAP),
  }));
}
