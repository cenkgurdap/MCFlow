/**
 * What is selected, right now: some gates, or some panels, or nothing.
 *
 * ## One invariant, and it is not about cardinality
 *
 * **A gate selection and a panel selection are mutually exclusive.** That is
 * what this file was written for and it is the whole of what it enforces. Both
 * sides now hold a *set* — panels since 2026-08-12, gates since 2026-08-22 —
 * because a set is what lets several plots be moved, or several populations
 * deleted, in one gesture instead of one at a time.
 *
 * This file used to say there was no multi-select for gates and none was
 * implied, on the grounds that deleting three gates re-parents three subtrees
 * and that is not a thing to do casually. The objection was right and it has
 * been answered elsewhere: `core/gating/referenceGates.ts`'s `withoutGates`
 * resolves the survivors against the **whole** doomed set at once — a
 * population under *Cells* when both are going lifts to the root, not to
 * *Cells* — and the store's `removeGates` is one history step over it. So a
 * multi-gate delete is not a loosening of that rule; it is the only
 * implementation of it that gets a chain right, which is why Biophysics'
 * *Discard setup* has been built on it since 2026-08-28.
 *
 * The two live in different stores —
 * `gateStore.selectedGateId` and `plotStore.selectedPanelId` — because a gate is
 * analysis and a panel is an arrangement, and they are read by entirely
 * different things. But they were also *independent*, and that was a real bug:
 * clicking a gate set the gate selection and nothing ever cleared it, so from
 * the first gate click onwards Escape always asked about that gate and a plot
 * could never be selected for deletion again. The two states had no rule
 * relating them, so there was no place to put one.
 *
 * This is that place. Three functions, and every selecting gesture in the app
 * goes through one of them, so "can both be selected at once?" is answered here
 * rather than by whichever handler happens to fire last.
 *
 * `selectedPanelId` keeps a second job: it is where a keystroke is routed to, so
 * a gate selected on a panel records that panel as its anchor. That is not a
 * second selection — the panel does not render as selected while a gate is —
 * it is how Escape knows which of several mounted canvases should act.
 */

import { useGates } from './gateStore';
import { usePlot } from './plotStore';

/**
 * Select a gate. Anchored to the panel it was clicked on, if there was one.
 *
 * The anchor is written to `selectedPanelId` and the panel **set** is emptied:
 * that is what keeps a gate selection from also lighting up a plot as selected
 * and putting it in front of a multi-delete. The distinction between the two
 * fields exists for exactly this call.
 */
export function selectGateOnly(gateId: string, panelId: string | null = null): void {
  useGates.getState().selectGate(gateId);
  usePlot.getState().setPanelSelection([], panelId);
}

/**
 * Ctrl+click a gate — add it to the selection, or take it back out.
 *
 * The panel side is emptied for the same reason `selectGateOnly` empties it:
 * this is a statement about which *populations* are selected, and leaving a
 * plot selected alongside would leave Escape with two things to act on.
 */
export function toggleGateSelection(gateId: string): void {
  useGates.getState().toggleGateInSelection(gateId);
  usePlot.getState().setPanelSelection([], null);
}

/**
 * Shift+click a gate — take everything between the anchor and this row.
 *
 * `ordered` is the tree **as the sidebar draws it** (`flattenTree`), so a range
 * covers the rows somebody actually saw between the two they clicked.
 */
export function extendGateSelectionTo(gateId: string, ordered: string[]): void {
  useGates.getState().extendGateSelectionTo(gateId, ordered);
  usePlot.getState().setPanelSelection([], null);
}

/**
 * Select one panel and nothing else — a plain click.
 *
 * Collapses any multi-selection down to this panel, for the reason
 * `selectSample` does the same to a batch of samples: anything else means a
 * stale set from three clicks ago silently rides along on the next drag or the
 * next Escape.
 */
export function selectPanelOnly(panelId: string): void {
  useGates.getState().selectGate(null);
  usePlot.getState().setSelectedPanel(panelId);
}

/**
 * Ctrl+click — add this panel to the selection, or take it back out.
 *
 * Clears any gate selection first, because the two kinds stay exclusive: a
 * Ctrl+click is a statement about which *plots* are selected, and leaving a
 * gate selected alongside would leave Escape with two things to act on.
 */
export function togglePanelSelection(panelId: string): void {
  useGates.getState().selectGate(null);
  usePlot.getState().togglePanelInSelection(panelId);
}

/** Nothing is selected. Clicking empty worksheet space means this. */
export function clearSelection(): void {
  useGates.getState().selectGate(null);
  usePlot.getState().setSelectedPanel(null);
}
