import type { LayoutKind } from './layoutKind';

/**
 * Which strip owns the bottom of the worksheet.
 *
 * ## Why this exists
 *
 * Three components answer this question — `LayoutBar`, `ControlWalkBar` and
 * `BiophysicsWalkBar` — and until now each answered it separately: the two walk
 * bars rendered on their own panel's `isWalking*` predicate and `LayoutBar`
 * rendered when neither did. That was described as mutually exclusive *by
 * construction*, and it was, but the construction was missing a term.
 *
 * A walk predicate asks whether a guided panel is **mid-pipeline**. It does not
 * ask which worksheet is on screen. So *New layout* during a Biophysics walk
 * created a general worksheet, switched to it, and left the Biophysics strip at
 * the bottom — a strip that lists samples and therefore had no tab for the
 * worksheet the user was now standing in. The layout existed, was in the top
 * dropdown, and was unreachable from the bottom of the window. The same hole is
 * open in the unmixing wizard's Step 3 and always was.
 *
 * The missing term is the active worksheet's own `kind`. **A guided strip owns
 * the bottom only while the worksheet on screen is one that guided panel
 * generated.** Step outside the walk and the general strip takes over, which is
 * what makes the general worksheet reachable and is also the honest answer: a
 * walk bar on a worksheet outside the walk is navigation for somewhere else.
 *
 * Stated here as one total function over the four inputs rather than as a
 * condition each component refines, because that is precisely the shape that
 * failed — the components did agree, and agreed on something incomplete.
 */
export type BottomBar = 'reference' | 'biophysics' | 'layouts' | 'none';

export function bottomBarOwner(input: {
  /** `isWalkingControls(tab, step, controls)` — the unmixing wizard is at Step 3. */
  walkingControls: boolean;
  /**
   * `isWalkingSamples(samples, activeLayoutId)` — the worksheet on screen is one
   * the Biophysics pipeline generated, either a per-sample distribution sheet or
   * the one cell-type sheet. It stopped being a question about the *step* on
   * 2026-08-18; see `biophysicsWalk` for why that was the same defect this
   * module was written for, one level down.
   */
  walkingSamples: boolean;
  /** The `kind` of the worksheet currently on screen. `undefined` is a general one. */
  activeLayoutKind: LayoutKind | undefined;
  /** Worksheets reachable in this window, the active one included. */
  layoutCount: number;
}): BottomBar {
  const { walkingControls, walkingSamples, activeLayoutKind, layoutCount } = input;

  if (walkingControls && activeLayoutKind === 'reference') return 'reference';
  if (walkingSamples && activeLayoutKind === 'biophysics') return 'biophysics';

  // One worksheet is not a choice, and a strip offering it is a row of chrome
  // that never does anything. This is the common case for a fresh workspace.
  return layoutCount >= 2 ? 'layouts' : 'none';
}
