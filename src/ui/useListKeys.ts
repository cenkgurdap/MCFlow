import { useCallback, useId, useRef, useState } from 'react';
import { isActivateKey, nextFocus, typingIn, type Mods } from '@/core/listKeys';

/* ==========================================================================
   Keyboard for a list, wired to the same handler the pointer uses.

   Every list in this application grew Shift-click before it grew a keyboard,
   and the keyboard is where two implementations of one gesture usually appear:
   a click path that toggles and paints a block, and an arrow path that does
   something almost the same. So this hook does not implement selection at all.
   It moves a cursor — `core/listKeys.ts` decides where — and then calls the
   list's own `clickRow` with the modifier state, which means Shift+ArrowDown
   and a Shift-click reach the identical line of code.

   ## One focusable container, not a roving tabindex

   The container holds focus and names the current row through
   `aria-activedescendant`; the rows are not focusable and nothing about their
   own behaviour changes. That is the listbox pattern, and here it is also the
   cheap one: a roving tabindex would mean every row re-rendering to hand the
   next one a `tabIndex`, on a gating tree that redraws on every count.

   ## What a plain Arrow does depends on the list

   `moveSelects` is the whole difference between the two kinds. A sample row or
   a gate row **is** the selection, so the cursor drags it along, as a file
   manager does. A checkbox row accumulates, so the cursor passes over it and
   the ticks only change on Space or with Shift held — which is exactly the
   distinction `core/rangeSelect.ts` already draws between `extendSelectionTo`
   and `withBlock`.
   ========================================================================== */

const NO_MODS: Mods = { shiftKey: false, ctrlKey: false, metaKey: false };

export interface ListKeys {
  /** Spread onto the scrolling container that holds the rows. */
  containerProps: {
    ref: (el: HTMLElement | null) => void;
    tabIndex: number;
    role?: string;
    'aria-multiselectable'?: boolean;
    'aria-activedescendant'?: string | undefined;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onFocus: () => void;
  };
  /** The DOM id for a row, so the container can point at it. */
  rowId: (id: string) => string;
  /**
   * A row's click handler — **the only way in from the pointer.**
   *
   * It moves the cursor and then calls the list's own `onActivate`. Going
   * straight to `onActivate` instead would leave the cursor where the last key
   * put it, so an Arrow after a click would resume from somewhere the user has
   * not been since — which is the bug this shape exists to make impossible.
   */
  onRowClick: (e: Mods, id: string) => void;
  /** The row the cursor is on, for a focus ring. Null until the list is used. */
  cursor: string | null;
}

export function useListKeys({
  ordered,
  onActivate,
  moveSelects = false,
  semantics = 'listbox',
}: {
  /** Row ids in the order shown. A filtered list passes what it shows. */
  ordered: readonly string[];
  /** The list's own click handler. The keyboard calls it; so does the mouse. */
  onActivate: (mods: Mods, id: string) => void;
  /** True when a plain Arrow should select, not merely move the cursor. */
  moveSelects?: boolean;
  /**
   * Whether the container may call itself a listbox.
   *
   * Two of these lists are real `<table>`s — the grouping table and the
   * pairwise summary — and a listbox whose options are table rows is a lie a
   * screen reader acts on. They take `'none'`: the keys work, the cursor ring
   * shows, and the table keeps reading as a table. Everything else is a list of
   * divs or buttons and says so.
   */
  semantics?: 'listbox' | 'none';
}): ListKeys {
  const prefix = useId();
  const box = useRef<HTMLElement | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const rowId = useCallback((id: string) => `${prefix}${id}`, [prefix]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // An Arrow inside a row's own field is moving a caret, not a cursor.
    if (typingIn(e.target)) return;

    if (isActivateKey(e.key)) {
      if (cursor === null) return;
      e.preventDefault();
      onActivate(NO_MODS, cursor);
      return;
    }

    const to = nextFocus(e.key, ordered, cursor);
    if (to === null) return;
    e.preventDefault();
    setCursor(to);
    // `nearest`, so stepping through a long tree scrolls by a row rather than
    // jumping the row under the cursor to the middle of the panel.
    box.current?.ownerDocument.getElementById(rowId(to))?.scrollIntoView({ block: 'nearest' });

    if (e.shiftKey) onActivate({ shiftKey: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey }, to);
    else if (moveSelects) onActivate(NO_MODS, to);
  };

  return {
    containerProps: {
      ref: (el) => { box.current = el; },
      tabIndex: 0,
      ...(semantics === 'listbox' ? {
        role: 'listbox',
        'aria-multiselectable': true,
        'aria-activedescendant': cursor === null ? undefined : rowId(cursor),
      } : {}),
      onKeyDown,
      /*
         Deliberately does **not** seed a cursor.

         Doing so raced the first keypress: the seed had not flushed when the
         Arrow ran, so the Arrow read a null cursor and landed on the first row
         anyway — twice the machinery for the arrival `nextFocus` already gives.
      */
      onFocus: () => {},
    },
    rowId,
    onRowClick: (e, id) => { setCursor(id); onActivate(e, id); },
    cursor,
  };
}
