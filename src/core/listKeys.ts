/* ==========================================================================
   Arrow-key movement over a list, as a pure function.

   The pointer half of this already exists — `core/rangeSelect.ts` decides what
   a Shift-click covers — and every list that grew that gesture wanted the
   keyboard one too. What was missing was somewhere to put the rule, so this is
   its `blockBetween`: given the rows on screen and where the cursor is, which
   row does this key move it to.

   Deliberately not a hook and deliberately not aware of selection. Moving a
   cursor and changing a selection are two decisions, and which one a plain
   Arrow makes differs by list: a sample row **is** the selection, so the cursor
   drags it along, while a checkbox row accumulates and the cursor passes over
   it untouched. `ui/useListKeys.ts` is where that choice is made; this file
   only answers where the cursor goes.
   ========================================================================== */

/** The modifier state a list handler needs, satisfied by a real `MouseEvent`. */
export interface Mods {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Keys that move the cursor rather than acting on the row under it. */
export type MoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Where a key moves the cursor, or `null` for a key this list does not handle.
 *
 * `ordered` is the rows **on screen**, so a filtered list steps through what it
 * shows. A `focused` that is not among them — never set, or filtered away —
 * reads as no cursor at all and the first press lands on an end, which is what
 * a list does when you tab into it.
 *
 * **Clamped, never wrapped.** Holding ArrowDown at the bottom of a gating tree
 * should stop there; wrapping to the top silently moves a Shift-range across
 * the whole list, which is the opposite of what the key was doing a moment ago.
 */
export function nextFocus(key: string, ordered: readonly string[], focused: string | null): string | null {
  if (ordered.length === 0) return null;
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  if (key === 'Home') return first;
  if (key === 'End') return last;
  if (key !== 'ArrowDown' && key !== 'ArrowUp') return null;

  const at = focused === null ? -1 : ordered.indexOf(focused);
  if (at < 0) return key === 'ArrowDown' ? first : last;
  const to = key === 'ArrowDown' ? at + 1 : at - 1;
  if (to < 0 || to >= ordered.length) return ordered[at]!;
  return ordered[to]!;
}

/** Space and Enter act on the row under the cursor rather than moving it. */
export function isActivateKey(key: string): boolean {
  return key === ' ' || key === 'Enter' || key === 'Spacebar';
}

/**
 * True while the key belongs to a field rather than to the list.
 *
 * Every list here has rows with something typeable in them — the grouping
 * table's group name, the gate tree's inline rename — and an Arrow pressed in
 * one of those is moving a caret. Same predicate the plot canvas uses for the
 * same reason.
 */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
