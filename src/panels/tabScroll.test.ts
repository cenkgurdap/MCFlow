import { describe, expect, it } from 'vitest';
import { scrollToShow, TAB_SCROLL_PAD } from './tabScroll';

/* ==========================================================================
   The bottom strips' scroll position — 2026-08-12, Item 6.

   Reported as the active tab's highlight being unreadable after walking to the
   end of a reference panel and jumping back to the first control. Nothing was
   wrong with which tab was marked; the strip simply never moved. Asserted here
   rather than against a rendered bar because the whole of it is four numbers,
   and a check that needs a real scrollbar and a laptop-width window is a check
   nobody runs.
   ========================================================================== */

/** A strip 400 px wide holding 1000 px of tabs. */
const strip = (scrollLeft: number) => ({ scrollLeft, clientWidth: 400, scrollWidth: 1000 });
const tab = (offsetLeft: number, offsetWidth = 100) => ({ offsetLeft, offsetWidth });

describe('scrollToShow', () => {
  it('leaves a strip alone when the active tab is already comfortably inside', () => {
    expect(scrollToShow(strip(200), tab(250))).toBe(200);
  });

  it('scrolls back to the start for the first tab — the reported case', () => {
    // Parked at the far right after walking to the last control, then the user
    // jumps to the first. Before this fix the strip stayed where it was and the
    // active tab was off the left edge.
    expect(scrollToShow(strip(600), tab(0))).toBe(0);
  });

  it('brings a tab past the right edge just inside it', () => {
    // Tab spans 500…600 in a strip showing 0…400.
    expect(scrollToShow(strip(0), tab(500))).toBe(600 + TAB_SCROLL_PAD - 400);
  });

  it('brings a tab past the left edge just inside it', () => {
    // Tab spans 100…200; the strip is showing 300…700.
    expect(scrollToShow(strip(300), tab(100))).toBe(100 - TAB_SCROLL_PAD);
  });

  it('never scrolls past the end of the content', () => {
    // The last tab, hard against the right edge of 1000 px of content.
    const at = scrollToShow(strip(0), tab(900));
    expect(at).toBe(600);
    expect(at).toBeLessThanOrEqual(1000 - 400);
  });

  it('never scrolls to a negative offset', () => {
    // The padding would take a tab at 0 to -12; the strip has no such position.
    expect(scrollToShow(strip(50), tab(0))).toBe(0);
  });

  it('shows the start of a tab wider than the strip, not its end', () => {
    // A worksheet with a long name on a narrow window. Two worksheets are told
    // apart by the beginning of the name, so that is the end that must be shown.
    const wide = scrollToShow(strip(0), tab(500, 700));
    expect(wide).toBe(500 - TAB_SCROLL_PAD);
  });

  it('reports the clamped current position, so a caller can skip a no-op write', () => {
    // A strip whose scrollLeft is somehow past its own maximum — which happens
    // when tabs are removed while it is scrolled right — comes back in range
    // rather than being echoed as-is.
    expect(scrollToShow({ scrollLeft: 900, clientWidth: 400, scrollWidth: 1000 }, tab(950))).toBe(600);
  });

  it('does nothing at all when everything fits', () => {
    // scrollWidth === clientWidth: no scrolling is possible and none is asked for.
    expect(scrollToShow({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }, tab(300))).toBe(0);
  });
});
