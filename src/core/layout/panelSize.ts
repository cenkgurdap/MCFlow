/**
 * The size a new panel opens at — one resolution function, every creation path.
 *
 * Four routes create a panel: the *Add plot* button, *Duplicate*, dropping a
 * sample and dropping a population (plus the context-menu equivalents of the
 * last two, which are the same code path). Every one of them used
 * `PANEL_DEFAULT_WIDTH` directly, so resizing a panel to something readable and
 * then dragging a gate out of it produced a large plot followed by a small one,
 * and the layout had to be repaired by hand once per panel.
 *
 * So the width a user last chose is remembered for the session and becomes the
 * default. It is the same pattern `transformPrefs` already uses for a channel's
 * transform and `openPanel` uses for axes: **a setting the user has stated
 * explicitly beats the project's cold-start choice**, and stating it once should
 * be enough.
 *
 * Two deliberate properties:
 *
 *  - **Only a manual resize writes here.** `resizePanel` is reached from the
 *    eight edge handles and from nowhere else, so the memory records a decision
 *    rather than a side effect of loading a workspace or of a sibling window's
 *    snapshot arriving.
 *  - **It is session state, not analysis.** Module-level, exactly like
 *    `lastViewportWidth`: it is never written to the workspace file, never
 *    broadcast between windows and never on the undo stack. A workspace's panels
 *    carry their own widths, and reopening one shows the sizes it was saved
 *    with — which is correct — and then the memory starts empty again.
 *
 * Store-free so it can be tested directly and so `plotStore` can import it
 * without a cycle.
 */

import { clampWidth, PANEL_DEFAULT_WIDTH } from './geometry';

/** The last width a user resized a panel to, or null if they have not. */
let mostRecent: number | null = null;

/**
 * Record a width the user chose by dragging a resize handle.
 *
 * Clamped on the way in rather than on the way out, so the memory can never hold
 * a width no panel is allowed to have.
 */
export function notePanelWidth(w: number): void {
  if (Number.isFinite(w) && w > 0) mostRecent = clampWidth(w);
}

/**
 * The width a panel created right now should open at.
 *
 * The most recently chosen width, or the project default if nothing has been
 * resized in this session.
 */
export function defaultPanelWidth(): number {
  return mostRecent ?? PANEL_DEFAULT_WIDTH;
}

/** Has the user stated a width this session? Exposed for tests and harnesses. */
export function hasPanelWidthMemory(): boolean {
  return mostRecent !== null;
}

/** Forget it. Tests only — nothing in the app clears this. */
export function resetPanelWidthMemory(): void {
  mostRecent = null;
}
