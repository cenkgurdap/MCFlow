/**
 * The one moment a stored parameter index changes meaning, announced.
 *
 * A leaf with no imports, for the reason `workspaceCleared.ts` is one: the
 * stores that hold an index — gates, panels, the statistics setup — import
 * `derivedStore`, so `derivedStore` cannot import them back. It says what moved
 * through this slot and each store answers for its own fields.
 *
 * ## Why an index moves at all (2026-10-28)
 *
 * The parameter list is **real → derived → unmixed**, and the order is a
 * correctness property: a derived index has to mean the same thing on every
 * sample whether or not that sample was unmixed (see `parametersFor`). The
 * price is that an abundance's index is `real + defs.length + k`, so adding a
 * derived parameter moves every abundance one place up and removing one moves
 * them down. Nothing followed them. The report was *"I gated a sample, added
 * MT potential through an equation, and the Live/Dead plot's axis became MT
 * potential and every gate moved"*: index 71 had meant the first abundance and
 * now meant the new definition, and each gate on an abundance had landed on its
 * neighbour.
 *
 * Re-keying every stored parameter by name would have touched every reader of
 * an index. Shifting the stored numbers at the single moment the count changes
 * keeps the order, keeps the readers, and leaves nothing on screen to move.
 */

export interface ParameterShift {
  /** The first index that moves. Everything at or above it shifts by `delta`. */
  from: number;
  /** +1 when a definition was appended, −1 when one was removed. */
  delta: number;
  /**
   * The index that no longer names anything — the removed definition's own —
   * or null on an add. Below `from`, so `shiftIndex` reports it separately
   * rather than moving it onto whichever parameter slid into its place.
   */
  orphan: number | null;
}

export type ShiftListener = (shift: ParameterShift) => void;

const listeners = new Set<ShiftListener>();

/** Register a remap. Called at module scope by each store holding an index. */
export function onParameterShift(fn: ShiftListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The parameter list has changed shape. Iterated over a copy, like every bus here. */
export function notifyParameterShift(shift: ParameterShift): void {
  for (const fn of [...listeners]) fn(shift);
}

/**
 * The shift between two definition lists, or null when they are not one add or
 * one removal apart.
 *
 * For a holder of an index that the undo stack does **not** snapshot. Gates and
 * panels are put back by an undo together with the definitions, so the bus is
 * enough for them; the Statistics setup is per window and outside history, so an
 * undo of *Add derived parameter* would put the definitions back and leave its
 * index shifted. Reading the change off the list itself answers an add, a
 * removal, an undo and a redo alike. A wholesale replacement — a workspace
 * restore — answers null, and the restore resets that holder anyway.
 */
export function shiftBetween(
  prev: readonly { id: string }[],
  next: readonly { id: string }[],
  real: number,
): ParameterShift | null {
  if (next.length === prev.length + 1 && prev.every((d, i) => d.id === next[i]!.id)) {
    return { from: real + prev.length, delta: 1, orphan: null };
  }
  if (next.length === prev.length - 1) {
    const k = prev.findIndex((d, i) => d.id !== next[i]?.id);
    if (k >= 0 && next.every((d, i) => d.id === prev[i < k ? i : i + 1]!.id)) {
      return { from: real + k + 1, delta: -1, orphan: real + k };
    }
  }
  return null;
}

/**
 * Where one stored index now points: the same number, the shifted one, or null
 * for the orphan — an index whose parameter is gone.
 */
export function shiftIndex(index: number, shift: ParameterShift): number | null {
  if (index === shift.orphan) return null;
  return index >= shift.from ? index + shift.delta : index;
}
