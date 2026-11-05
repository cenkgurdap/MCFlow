/**
 * Does this pointer-down start a panel move?
 *
 * The previous pass made a 12 px rail on the left edge the *only* way to move a
 * panel, having found that "drag it by the header" put the gesture on top of the
 * toolbar's controls. That diagnosis was right and the remedy was too strict: in
 * use, a panel with one small grab point is a panel you have to aim at before you
 * can arrange anything, and a worksheet is arranged constantly.
 *
 * So the rule is inverted. **The whole panel background moves it** — all four
 * corners and edges of the margin, the toolbar's empty space, and the plot area
 * itself — and the exceptions are named:
 *
 *  - a **control**: a button, a field, the axis pickers, the breadcrumb. A drag
 *    that starts on a control means the user is aiming at the control, which was
 *    the entire reason the rail existed;
 *  - a **resize handle**: the eight edge and corner strips. They stay small and
 *    precise so they take as little of the drag-to-move area as possible, and
 *    they keep their own gesture;
 *  - a **gate**: its shape, its vertices and its handles edit the gate. This is
 *    the priority the hover-tooltip fix is also about — a gesture that lands on a
 *    gate is about that gate;
 *  - **any press at all while a drawing tool is armed.** Not the data rectangle
 *    only — see below.
 *
 * Individual **event points are deliberately not an exception.** There is no
 * click-to-inspect-an-event gesture — the hover tooltip is passive and does not
 * consume a press — so a drag starting over a dense cloud is as unambiguous a
 * "move this panel" as one starting over empty space.
 *
 * ## An armed tool is a hard lock, not a priority
 *
 * The previous version of this rule refused a move only when the pointer was
 * *inside the data rectangle*, on the reasoning that a gate cannot be drawn in
 * the axis margin so a tool has no claim there. That reasoning was wrong about
 * how gating is actually done. A gate is very often started **just outside the
 * cloud** — at or a pixel past the axis — precisely so the edge events are not
 * clipped, and that is exactly the region the old rule handed back to
 * drag-to-move. The reported symptom was a panel lurching across the worksheet
 * when the user meant to place the first corner of a rectangle near the origin,
 * and it appeared only in sparse corners because those are the only places
 * anybody aims that close to an edge.
 *
 * So while any tool is armed the panel does not move **anywhere** — margins,
 * corners, bare toolbar row, all of it — and `PlotCanvas` clamps a press in the
 * margin into the data rectangle rather than discarding it, so the gesture the
 * user made is the gesture they get. There is no scenario, with a tool armed,
 * where a drag on a panel means "move this panel"; disarming the tool is one
 * keystroke (Escape) and is the way to move it.
 *
 * The cost is stated plainly: a panel cannot be dragged while a tool is armed.
 * That is the intended trade. A hit test that is right 95% of the time is worse
 * than a rule with no exceptions, because the 5% is silent and destroys the
 * arrangement rather than the gate.
 *
 * Kept pure so the rule can be asserted directly, and so `PlotCanvas` reads as a
 * DOM probe plus one call rather than as a nest of conditions.
 */

/**
 * Anything inside a panel that owns its own pointer gesture.
 *
 * Matched with `closest()` from the event target, so a click on the label inside
 * a button is a click on the button. `data-no-panel-drag` is the escape hatch for
 * anything that needs to opt out without being one of the above — the naming
 * prompt uses it.
 */
const CHROME_SELECTORS = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[data-resize-handle]',
  '[data-no-panel-drag]',
];

export const NO_DRAG_SELECTOR = [...CHROME_SELECTORS, '[data-gate]'].join(',');

/**
 * The same list **without gates**, for the plot surface's own draw handler.
 *
 * The distinction is small and it broke a feature. Now that a press in the axis
 * margin *draws* rather than being discarded, the surface has to skip presses that
 * belong to a control — the axis parameter pickers sit in those margins, and
 * opening one with a tool armed must not place a vertex. Reusing
 * `NO_DRAG_SELECTOR` for that looked right and quietly excluded **gates** too,
 * which made it impossible to draw a gate *over* an existing one — and drawing
 * inside a parent is how every child population in a hierarchy gets made. The
 * symptom was that the first gate of a strategy could be drawn and the second
 * could not.
 *
 * A gate is an exception to *moving the panel*, because a press on a gate is about
 * that gate. It is not an exception to *drawing*, because with a tool armed the
 * press is about the new shape and the old one is just what happens to be
 * underneath it.
 */
export const PLOT_CONTROL_SELECTOR = CHROME_SELECTORS.join(',');

export interface PanelDragProbe {
  /** Left button. A right-click opens a context menu and must not move anything. */
  primaryButton: boolean;
  /** `closest(NO_DRAG_SELECTOR)` matched something inside this panel. */
  onOwnGesture: boolean;
  /**
   * A gate-drawing tool is selected in the toolbar.
   *
   * On its own enough to refuse the move. There is deliberately no `inDataRect`
   * beside it any more: qualifying the lock by position is what let a press near
   * an axis move the panel instead of starting a gate.
   */
  toolArmed: boolean;
  /** A finished gate is waiting to be named; it owns the panel until it resolves. */
  naming: boolean;
}

/**
 * The rule, stated once.
 *
 * Order matters only in that every clause is a veto: a move starts when nothing
 * objects. Written as a chain of refusals rather than as a positive test because
 * "the background" is defined by what it is not, and enumerating the exceptions
 * is the only form of that definition which stays true when a control is added.
 */
export function shouldMovePanel(p: PanelDragProbe): boolean {
  if (!p.primaryButton) return false;
  if (p.naming) return false;
  if (p.onOwnGesture) return false;
  // **Unconditional.** An armed drawing tool takes the whole panel, not the data
  // rectangle within it. See the note above for why the positional version of
  // this clause was the bug rather than a refinement of it.
  if (p.toolArmed) return false;
  return true;
}
