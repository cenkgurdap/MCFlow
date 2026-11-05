import type { DrawTool } from '@/state/gateStore';

/* ==========================================================================
   One place that maps interaction state onto a CSS cursor.

   Kept out of the components because the cursor is the only continuous signal
   telling a user what a click will do — start a gate, close a polygon, drop a
   population — and scattering `cursor-*` classes across the shapes meant a new
   tool silently inherited the wrong one and read as "nothing is armed".
   ========================================================================== */

/**
 * Screen-space snap radius for the polygon close target, in CSS pixels.
 *
 * Deliberately in pixels rather than data units: the target has to be the same
 * physical size to aim at whatever range the axis happens to span, and a
 * data-space radius would be a different size on every plot.
 */
export const CLOSE_SNAP_PX = 9;

/**
 * Crosshair with a ring at the centre — "clicking here closes the shape",
 * visibly distinct from the plain crosshair used everywhere else on the canvas.
 *
 * Drawn twice, a dark halo under a light stroke, because a plot background can
 * be near-black or near-white and a single-colour cursor disappears into one of
 * them. Built through encodeURIComponent so the `#` in a colour literal cannot
 * be mistaken for a fragment.
 */
const CLOSE_CURSOR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
  '<g fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="3.25" stroke-linecap="round">' +
  '<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/><circle cx="12" cy="12" r="5.25"/></g>' +
  '<g fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round">' +
  '<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/><circle cx="12" cy="12" r="5.25"/></g>' +
  '</svg>';

export const CLOSE_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent(CLOSE_CURSOR_SVG)}") 12 12, pointer`;

export interface CursorInput {
  /** Active gate-drawing tool; 'none' means the pointer selects. */
  gateTool: DrawTool;
  /** Pointer is within `CLOSE_SNAP_PX` of a closable polygon's first vertex. */
  overPolygonClose?: boolean;
  /**
   * A gate is being dragged and the pointer has left its own plot, so releasing
   * opens a new panel instead of moving the shape.
   */
  gateLeavingPlot?: boolean;
  /** This panel is being dragged around the worksheet right now. */
  panelMoving?: boolean;
}

/**
 * CSS cursor for the plot surface.
 *
 * Order matters, most specific first. A gate on its way out of the plot wins
 * outright — the gesture has changed meaning and that has to be visible the
 * instant the boundary is crossed, which is the whole point of the cue. Then the
 * close target, being the smallest hit area; then the drawing tools, because an
 * armed gate tool is what the next click will actually do.
 *
 * **The resting cursor is `grab` again.** It was `default` for one pass, and the
 * reason was sound at the time: `grab` had promised a pan, the pan was removed,
 * and a cursor that promises a gesture the surface does not perform is worse than
 * no cursor change at all. The surface performs one again — with no tool armed, a
 * drag anywhere on the plot background moves the whole panel — so the promise is
 * true, and `grabbing` while the move is in flight completes the pair.
 */
export function plotCursor(i: CursorInput): string {
  if (i.gateLeavingPlot) return 'copy';
  if (i.overPolygonClose && i.gateTool === 'polygon') return CLOSE_CURSOR;
  if (i.gateTool !== 'none') return 'crosshair';
  if (i.panelMoving) return 'grabbing';
  return 'grab';
}

/**
 * The cursor for one gate edit handle, by the handle name `applyGateDrag`
 * dispatches on.
 *
 * Centralised here rather than written beside each `<Handle>` because the
 * mapping is a *claim about what a drag will do*, and a claim spread across four
 * shape components drifts silently: a polygon vertex shipped as `grab` while
 * every other handle on the same gate — the bounding box's eight, which sit a few
 * pixels away — said `nwse-resize`. So hovering exactly on a vertex showed a hand
 * and hovering just off it showed an arrow, on a gesture that in both cases moves
 * geometry. That is Item 10's second half, and it is the reason this is a
 * function with a test rather than a prop.
 *
 * The rules, in the order they are tested:
 *
 *  - `move` — the whole shape translates. Four-way arrows.
 *  - `v<n>` — one polygon vertex. **Also `move`**: dragging a vertex moves a
 *    point in both axes, which is what the four-way arrow means. It was `grab`,
 *    which promises picking the shape up and putting it down somewhere.
 *  - `rx` / `ry` — an ellipse radius, one axis each.
 *  - `min` / `max` — a range boundary, horizontal only.
 *  - a compass direction, optionally prefixed `b` for a polygon's bounding box —
 *    the diagonal or axial resize arrow that matches the corner. `bnw` and `nw`
 *    resolve identically on purpose: they resize by the same rule, from the
 *    opposite corner, and two shapes showing the same affordance must not
 *    describe it differently.
 *
 * Anything unrecognised falls back to `move` rather than to `default`, because
 * every handle that exists moves geometry; a handle whose name this does not know
 * is a bug in this function, and a four-way arrow is the honest answer to "a drag
 * here changes the gate somehow".
 */
export function gateHandleCursor(
  handle: string,
  /**
   * Which axis a range gate's parameter is on, for the two handles that depend
   * on it. A range gate draws as a vertical band on x and a horizontal one on y
   * (`rangeAxisOn`), so its boundaries resize the other way round on each — and
   * an arrow pointing across a line nobody can move that way is a lie about
   * what the drag will do. Defaulted, because every other handle is unaffected.
   */
  rangeAxis: 'x' | 'y' = 'x',
): string {
  if (handle === 'move') return 'move';
  if (/^v\d+$/.test(handle)) return 'move';
  if (handle === 'rx') return 'ew-resize';
  if (handle === 'ry') return 'ns-resize';
  if (handle === 'min' || handle === 'max') return rangeAxis === 'y' ? 'ns-resize' : 'ew-resize';
  const compass = handle.startsWith('b') && handle.length > 1 ? handle.slice(1) : handle;
  switch (compass) {
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    default: return 'move';
  }
}

/**
 * Is the pointer close enough to the first vertex to close the polygon?
 *
 * Both points are in plot-local pixels. Fewer than three vertices is not a
 * shape yet, so there is nothing to close and the click must place a vertex —
 * without that guard, a fast double-click on the first point would "close" a
 * degenerate two-vertex gate matching no events.
 */
export function isNearPolygonClose(
  cursor: { x: number; y: number },
  firstVertex: { x: number; y: number },
  vertexCount: number,
  radius = CLOSE_SNAP_PX,
): boolean {
  if (vertexCount < 3) return false;
  const dx = cursor.x - firstVertex.x;
  const dy = cursor.y - firstVertex.y;
  return dx * dx + dy * dy <= radius * radius;
}
