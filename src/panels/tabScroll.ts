/**
 * Where a scrolling tab strip has to sit for its active tab to be readable.
 *
 * Pure, and separate from the two bars that use it, for the reason every other
 * pure module here is separate from its renderer: *"is this tab off the left
 * edge"* is arithmetic over four numbers, and arithmetic that needs a mounted
 * component and a real scrollbar to assert is arithmetic nobody asserts.
 *
 * ## The bug this is the fix for (2026-08-12, Item 6)
 *
 * Both bottom strips — `ControlWalkBar` during the wizard's walk and
 * `LayoutBar` the rest of the time — render every worksheet as a tab in an
 * `overflow-x-auto` row and mark the current one. Neither ever moved the row.
 * That is invisible while the tabs fit and wrong the moment they do not: eleven
 * reference controls at a legible width are wider than the worksheet on a
 * laptop, so walking to the far-red end scrolls the strip fully right, and
 * jumping back to the first control then leaves the active tab — the one thing
 * on the strip that says where you are — off the left edge with the strip still
 * parked at the other end. Everything else on screen was correct, which is what
 * made it read as the highlight being lost rather than as a scroll position.
 *
 * ## Why `scrollIntoView` is not what this calls
 *
 * `Element.scrollIntoView` walks **every** scrollable ancestor, and this strip
 * has two that must not move: the worksheet canvas, which is positioned and
 * would jump under the plots, and the window itself under a page zoom. It also
 * has no way to express the padding below — `inline: 'nearest'` lands the tab
 * flush against the edge it entered from, which is legible and looks like a
 * clipping bug. One `scrollLeft` write on the one element that should move is
 * both narrower and testable.
 */

/** Air left between the active tab and the edge it was brought in from. */
export const TAB_SCROLL_PAD = 12;

/** The measurements this needs, named so a test does not have to build a DOM. */
export interface StripMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface TabMetrics {
  /**
   * Left edge **in the strip's own scroll coordinates**: 0 is the strip's first
   * pixel of content, whatever it is currently scrolled to.
   *
   * Deliberately not documented as "`offsetLeft`", which is what it said until
   * the harness caught it. `HTMLElement.offsetLeft` is measured from the
   * nearest *positioned* ancestor, and neither bar's scrolling row is
   * positioned — so a tab reported an offset that included the sidebar and
   * every other unpositioned box to its left. On the real strip that made a tab
   * at content-x 85 report 291, which is inside the visible window either way
   * going one direction and outside it going the other. See the hook for how it
   * is measured now.
   */
  offsetLeft: number;
  offsetWidth: number;
}

/**
 * The `scrollLeft` that makes `tab` visible inside `strip`, or the one it
 * already has when it already is.
 *
 * **Nearest-edge, not centring.** A tab one pixel past the right edge is
 * brought just inside it rather than hauled to the middle: centring moves every
 * other tab on the strip for a step that moved one, and stepping through eleven
 * controls with a centring rule scrolls the strip on all eleven presses even
 * where nothing needed to move. This scrolls exactly when something is out of
 * view, which is also what makes it safe to call on every render.
 *
 * Clamped to the strip's own range, so the first tab lands the strip at 0
 * rather than at a negative offset the browser would silently clamp anyway —
 * the clamp is here so the returned number is the number the element will hold,
 * and a caller comparing them to avoid a redundant write gets the right answer.
 */
export function scrollToShow(
  strip: StripMetrics,
  tab: TabMetrics,
  pad = TAB_SCROLL_PAD,
): number {
  const max = Math.max(0, strip.scrollWidth - strip.clientWidth);
  const clamp = (v: number) => Math.min(max, Math.max(0, v));

  const left = tab.offsetLeft;
  const right = tab.offsetLeft + tab.offsetWidth;

  /*
     A tab too wide to fit is shown from its **start**, and this is tested
     first because the general rules below get it wrong.

     Both bars cap a tab's width, so this needs a narrow window to reach — but
     when it is reached, "bring the nearest edge in" resolves to the *right*
     edge whenever such a tab begins to the right of the viewport, which parks
     the strip on the last few characters of the label. Two worksheets are told
     apart by the beginning of a name ("CD4 RB744" against "CD8 BUV805"), so
     the end is the half with nothing to say.
  */
  if (tab.offsetWidth + pad * 2 > strip.clientWidth) return clamp(left - pad);

  // Off the left edge — or partly under it. Bring its left edge in.
  if (left - pad < strip.scrollLeft) return clamp(left - pad);

  // Off the right edge. Bring its right edge in.
  if (right + pad > strip.scrollLeft + strip.clientWidth) {
    return clamp(right + pad - strip.clientWidth);
  }

  // Already visible, and the strip does not move.
  return clamp(strip.scrollLeft);
}
