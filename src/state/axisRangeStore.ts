import { create } from 'zustand';
import type { Viewport } from './plotStore';

/* ==========================================================================
   What each panel's axes would show if nothing were pinned.

   The axis settings live in the inspector, which is nowhere near the code that
   computes a plot's data extent — that happens inside `PlotCanvas`, from
   columns it has gathered for its own population and subsample. Without this,
   the min/max fields would have to open empty and the user would be typing a
   range with no idea what the data's range is, which is the one thing they need
   to know before typing anything.

   So a panel publishes its auto-fitted extent as it renders, and the inspector
   reads it. Deliberately *not* part of `PanelConfig`: it is a measurement of the
   data, not a setting, so it must not be saved with the workspace, synced to
   another window, or land in the undo stack — the same reasoning that keeps
   `lastViewportWidth` out of the panel model.
   ========================================================================== */

interface AxisRangeState {
  /** Auto-fitted extent per panel id, before any explicit limits are applied. */
  fitted: Record<string, Viewport>;
  note(panelId: string, v: Viewport): void;
  forget(panelId: string): void;
}

export const useAxisRanges = create<AxisRangeState>((set, get) => ({
  fitted: {},

  note(panelId, v) {
    const prev = get().fitted[panelId];
    /*
       Identity guard, not an optimisation: `PlotCanvas` notes this from an
       effect that runs on every render, and writing an equal value would
       re-render every subscriber — including the inspector — in a loop.

       ## `Object.is`, not `===`   (2026-08-14)

       The guard was four `===` comparisons, and `NaN === NaN` is **false**. So a
       viewport with a NaN bound could never match the value already stored, the
       guard could never fire, and the effect → write → render → effect cycle had
       nothing to stop it — an unbounded loop from a single bad number, in the
       one store written from a render effect.

       It has to be `Object.is` on each field rather than on the object, because
       `v` is freshly built by the caller every time and would never be identical
       whatever it holds.

       `extent()` currently guarantees finite bounds, which is why this has not
       been seen — but "the caller happens to sanitise its input" is not a
       property a loop guard should depend on, and every transform's `inverse` is
       between it and this. A guard that cannot fire is worse than no guard,
       because the code reads as protected.
    */
    if (prev
      && Object.is(prev.xMin, v.xMin) && Object.is(prev.xMax, v.xMax)
      && Object.is(prev.yMin, v.yMin) && Object.is(prev.yMax, v.yMax)) {
      return;
    }
    set((s) => ({ fitted: { ...s.fitted, [panelId]: v } }));
  },

  forget(panelId) {
    set((s) => {
      if (!(panelId in s.fitted)) return {};
      const next = { ...s.fitted };
      delete next[panelId];
      return { fitted: next };
    });
  },
}));

/** The auto extent for a panel, or null before it has drawn once. */
export function fittedRangeOf(panelId: string | null | undefined): Viewport | null {
  if (!panelId) return null;
  return useAxisRanges.getState().fitted[panelId] ?? null;
}
