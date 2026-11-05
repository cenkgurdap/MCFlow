/**
 * The one function a store calls to say "every sample has gone".
 *
 * A leaf module with no imports, and that is its whole reason for existing —
 * exactly the shape of `historyBus`, for exactly the same reason. Removing the
 * last sample has to clear the gates, the worksheets and the unmixing wizard,
 * and those live in three stores that already import each other in one
 * direction. `workspaceStore` announcing the fact through a slot, and each store
 * answering for its own state, keeps the graph acyclic and keeps "what a reset
 * means" written next to the state it resets rather than in a list somewhere
 * that a fourth store would have to be added to.
 *
 * ## Why this exists at all (2026-08-11, Item 9)
 *
 * Removing every sample left the plot layout, the gate hierarchy and the
 * wizard's control assignments exactly where they were. On screen that looks
 * like a reset — a panel with no sample draws nothing, and the gate tree is
 * scoped to a selected sample that no longer exists — so the state was invisible
 * rather than gone. Importing a new set of files then brought all of it back:
 * a worksheet of plots pointing at parameters from the previous experiment, and
 * a gate hierarchy drawn against a different panel, evaluated against the new
 * data and reported as populations.
 *
 * That is worse than the state persisting visibly. A gate is a *definition* —
 * "FSC-A between these two values" — so it does not fail against unrelated
 * files; it produces a number. Nothing about the resulting statistics table says
 * the strategy came from another experiment.
 *
 * Until a store registers, this is a no-op, which is correct for a unit test
 * that exercises `workspaceStore` on its own.
 */

export type ClearListener = () => void;

const listeners = new Set<ClearListener>();

/**
 * Register a reset. Returns a function to detach again.
 *
 * Called at module scope by each store that owns state belonging to the sample
 * set, so the registration happens the moment the store exists rather than when
 * a component mounts — a panel that has never been opened still has to be
 * cleared.
 */
export function onWorkspaceCleared(fn: ClearListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Every sample has been removed. Announce it.
 *
 * Iterated over a copy, so a listener that detaches itself — or registers
 * another — cannot mutate the set mid-walk.
 */
export function notifyWorkspaceCleared(): void {
  for (const fn of [...listeners]) fn();
}
