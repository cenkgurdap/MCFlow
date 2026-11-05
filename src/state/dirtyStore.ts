import { create } from 'zustand';
import { platform } from '@/platform';
import { setDirtyMarker } from './historyBus';

/* ==========================================================================
   Has anything changed since the last save?

   One boolean, and the interesting part is where it is set from rather than
   what it holds.

   **Every analysis edit already announces itself.** `record()` is called before
   any mutation the undo stack is meant to be able to reverse — a gate drawn, a
   panel moved, an axis retyped, a derived parameter edited — precisely because
   a *subscription* cannot tell a user's edit from a workspace load or from a
   sibling window's state arriving over IPC. That distinction is exactly the one
   a dirty flag needs too, so this rides the same signal rather than inventing a
   second one that would drift out of step with it.

   What `record()` does not cover is the sample list: importing, removing,
   renaming and reordering are changes to the workspace that the undo stack
   deliberately does not hold (the stack is analysis, and a snapshot of it cannot
   put a removed sample's 156 MB back). Those call `markDirty` directly.

   Cleared on save, and on load: a workspace just opened is by definition
   identical to the file it came from.
   ========================================================================== */

interface DirtyState {
  dirty: boolean;
  markDirty(): void;
  markSaved(): void;
}

export const useDirty = create<DirtyState>((set, get) => ({
  dirty: false,
  markDirty() {
    if (get().dirty) return;
    set({ dirty: true });
    // The main process is what has to refuse a close, and it cannot read a
    // renderer store — so the flag is pushed rather than polled. Only on a
    // *change* of the boolean, so a gate drag does not send sixty messages.
    void platform().setDirty?.(true);
  },
  markSaved() {
    if (!get().dirty) return;
    set({ dirty: false });
    void platform().setDirty?.(false);
  },
}));

/**
 * Attach to the record bus.
 *
 * Called once, from the same place `historyStore` attaches. Anything that calls
 * `record()` marks the workspace dirty, which is the whole of the reuse Item 8
 * asks for.
 */
export function startDirtyTracking(): () => void {
  return setDirtyMarker(() => useDirty.getState().markDirty());
}
