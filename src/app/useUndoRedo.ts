/**
 * Ctrl+Z and Ctrl+Shift+Z, and the one decision they have to get right.
 *
 * Two undos exist in any desktop app: the text field's, and the document's.
 * Whichever the user means is decided entirely by where focus is, so this
 * checks that first and gets out of the way when the answer is "the field".
 * Getting it backwards is worse than having no shortcut — a Ctrl+Z meant to fix
 * a typo would silently roll back a gating strategy instead.
 *
 * Registered on `window` rather than through the native menu because the app
 * also runs as a plain web page (`npm run dev`), where there is no menu at all.
 * The menu items send `menu:undo`/`menu:redo` here so both routes end up in the
 * same function.
 */

import { useEffect } from 'react';
import { platform } from '@/platform';
import { useHistory } from '@/state/historyStore';
import { useUI } from '@/state/uiStore';

/** Is focus somewhere that owns its own undo? */
export function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

export function performUndo(): void {
  const label = useHistory.getState().undo();
  // Silence would be indistinguishable from a shortcut that is not bound —
  // which is exactly how this feature came to be reported as not working.
  useUI.getState().setNotice(
    label ? { tone: 'ok', text: `Undid: ${label}` } : { tone: 'warn', text: 'Nothing left to undo.' },
  );
}

export function performRedo(): void {
  const label = useHistory.getState().redo();
  useUI.getState().setNotice(
    label ? { tone: 'ok', text: `Redid: ${label}` } : { tone: 'warn', text: 'Nothing to redo.' },
  );
}

export function useUndoRedo(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      // The field's own undo stack wins while the caret is in one.
      if (inTextField(e.target)) return;

      e.preventDefault();
      // Ctrl+Y is the Windows redo; Ctrl+Shift+Z is the cross-platform one.
      if (key === 'y' || e.shiftKey) performRedo();
      else performUndo();
    };

    window.addEventListener('keydown', onKey);

    // The native menu route. `document.execCommand` is what restores the
    // field's own behaviour when the menu fires while a text field has focus —
    // the accelerator reaches the menu before the keydown handler above, so
    // without this the menu item would be the one that gets it wrong.
    const p = platform();
    const offs = p.onNativeEvent
      ? [
          p.onNativeEvent('menu:undo', () => {
            if (inTextField(document.activeElement)) document.execCommand('undo');
            else performUndo();
          }),
          p.onNativeEvent('menu:redo', () => {
            if (inTextField(document.activeElement)) document.execCommand('redo');
            else performRedo();
          }),
        ]
      : [];

    return () => {
      window.removeEventListener('keydown', onKey);
      for (const off of offs) off();
    };
  }, []);
}
