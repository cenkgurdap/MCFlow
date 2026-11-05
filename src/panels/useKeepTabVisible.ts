import { useEffect, useRef } from 'react';
import { scrollToShow } from './tabScroll';

/**
 * Keep the active tab of a scrolling strip in view.
 *
 * One ref, on the scrolling row. The **active tab is found by querying the row**
 * for the attribute it already carries — `data-layout-tab-active` on the layout
 * strip, `data-walk-tab-active` on the wizard's — rather than by a second ref
 * moved from button to button.
 *
 * ## Why a second ref does not work here, which this was written with and the
 * ## harness caught
 *
 * `ref={active ? activeTabRef : undefined}` looks like the obvious way to point
 * at whichever tab is current, and it is wrong in a way that is invisible half
 * the time. When the active tab changes, two sibling buttons re-render: the new
 * one's ref goes from absent to present (attach, `current = node`) and the old
 * one's from present to absent (detach, `current = null`). React processes both
 * **in tree order**, so which one lands last depends on which tab is further
 * left:
 *
 *   - moving **right**, the old tab comes first — detach, then attach. Correct.
 *   - moving **left**, the new tab comes first — attach, then detach to null.
 *     The effect then finds no tab and does nothing.
 *
 * That is precisely the asymmetry in the report this fix is for: walking to the
 * far end of a reference panel scrolled fine, and jumping back to the first
 * worksheet left the strip parked at the other end. Reproducing the reported bug
 * *inside its own fix* is a good argument for not having the ref at all.
 *
 * A plain `useEffect` rather than `useLayoutEffect`, which is the other tempting
 * choice and also wrong. The layout variant runs before the browser has painted
 * — good, in that the strip is never seen at the old offset — but it also runs
 * before the row's overflow has been resolved on the render that *mounted* it,
 * and `offsetLeft` inside a row that has not been laid out yet is 0. That would
 * scroll the strip home every time the bar appeared. One frame of correction on
 * a strip somebody just clicked is not visible; jumping to the wrong end is.
 */
export function useKeepTabVisible<S extends HTMLElement>(
  activeKey: string | number | null,
  tabCount: number,
  /** Attribute selector marking the active tab inside the strip. */
  activeSelector: string,
): React.RefObject<S | null> {
  const stripRef = useRef<S | null>(null);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tab = strip.querySelector<HTMLElement>(activeSelector);
    if (!tab) return;

    /*
       The tab's left edge in the **strip's scroll coordinates**, measured from
       the two boxes rather than read off `offsetLeft`.

       `offsetLeft` is the obvious field and the wrong one, which the harness
       caught after this shipped: it is measured from the nearest *positioned*
       ancestor, and neither bar's scrolling row is positioned — so a tab 85 px
       into the strip's content reported 291, the extra being the sidebar and
       the rest of the window to its left. Every comparison in `scrollToShow` is
       then against a number in a different coordinate space from `scrollLeft`,
       which is why the strip scrolled correctly in one direction and not the
       other.

       Adding `relative` to the strip would also fix it and is worse: it makes
       the fix depend on a class two files away staying where it is, and this
       arithmetic is exact whatever either element's positioning turns out to be.
    */
    const tabBox = tab.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const offsetLeft = tabBox.left - stripBox.left + strip.scrollLeft;

    const next = scrollToShow(
      { scrollLeft: strip.scrollLeft, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth },
      { offsetLeft, offsetWidth: tabBox.width },
    );

    /*
       Written only when it changes.

       Not a micro-optimisation: assigning `scrollLeft` cancels any smooth
       scroll in flight and fires a `scroll` event, so writing the value it
       already holds on every render of a strip somebody is dragging would
       fight the drag. `scrollToShow` returns the current value clamped when
       nothing needs to move, which is what makes this comparison meaningful.
    */
    if (Math.round(next) !== Math.round(strip.scrollLeft)) strip.scrollLeft = next;
  }, [activeKey, tabCount, activeSelector]);

  return stripRef;
}
