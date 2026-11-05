/**
 * Which transform a parameter should open with.
 *
 * Two rules, and the second is why this module exists at all:
 *
 *  1. A parameter put on an axis for the first time gets the default for its
 *     kind — linear for scatter, biexponential for fluorescence. Previously
 *     changing an axis kept whatever transform the *previous* parameter had, so
 *     dropping FITC-A onto an axis that had been showing FSC-A produced a linear
 *     fluorescence plot: a spike on the axis floor and nothing else.
 *
 *  2. A transform the user chose explicitly wins, for that parameter, everywhere
 *     — including on the next panel they put it on. Someone who switches B2-A to
 *     hyperlog has said what they want B2-A to look like; overriding that with
 *     "the default for a fluorescence channel" the next time they select it is
 *     the app arguing with them.
 *
 * Keyed by parameter **name**, not index: the same detector is index 40 in one
 * file and index 12 in another, and the choice is about the channel.
 *
 * Session-scoped on purpose. It is a working preference, not analysis: a
 * workspace already records the transform of every axis it contains, so
 * reopening one shows exactly the transforms it was saved with whether or not
 * this store survives.
 */

import { create } from 'zustand';
import { defaultTransformKind, type TransformKind } from '@/core/transform';
import type { FcsParameter } from '@/core/fcs/types';

interface TransformPrefState {
  /** parameter name → the transform the user picked for it. */
  byParameter: Record<string, TransformKind>;
  remember(parameterName: string, kind: TransformKind): void;
  forget(parameterName: string): void;
  clear(): void;
}

export const useTransformPrefs = create<TransformPrefState>((set) => ({
  byParameter: {},
  remember(parameterName, kind) {
    if (!parameterName) return;
    set((s) => ({ byParameter: { ...s.byParameter, [parameterName]: kind } }));
  },
  forget(parameterName) {
    set((s) => {
      if (!(parameterName in s.byParameter)) return {};
      const next = { ...s.byParameter };
      delete next[parameterName];
      return { byParameter: next };
    });
  },
  clear() { set({ byParameter: {} }); },
}));

/** The transform a parameter should open with: the user's choice, or its default. */
export function transformFor(parameter: FcsParameter | undefined): TransformKind {
  if (!parameter) return 'linear';
  return useTransformPrefs.getState().byParameter[parameter.name]
    ?? defaultTransformKind(parameter.type);
}
