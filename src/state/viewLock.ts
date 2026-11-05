/**
 * Which views a guided pipeline holds shut while it is mid-flight, and why.
 *
 * ## The report this answers (2026-08-13)
 *
 * Select the reference controls, press Next into *Assign*, then click Biophysics
 * by mistake and come back. The unmixing setup is no longer the setup you left:
 * every loaded sample now carries a *Cells* gate, there are biophysics worksheets
 * in the layout list beside the control worksheets, and the gate tree the wizard's
 * Step 3 walks reads as somebody else's analysis.
 *
 * Nothing there is a bug in either panel. Both build the same three objects —
 * gates, layouts, the worksheet a sample's plots sit on — and neither asks
 * whether the other is holding them. The second one to start wins, silently, and
 * the loss is only visible on the way back.
 *
 * **Biophysics no longer builds on open** (2026-08-28): Step 1 shows a start
 * screen and places nothing until *Find the cells* is pressed, so merely looking
 * at the panel is free and the collision needs an actual press. The lock is kept
 * anyway and is now the narrower claim its wording makes — *starting* it there
 * would overwrite the control worksheets — because the alternative is a panel
 * that opens, invites a press, and refuses it.
 *
 * ## Why a lock rather than a merge
 *
 * The two pipelines are not concurrent by design: Biophysics' *Multiple cell
 * types* mode has unmixing as its **step 0** and routes to this very panel to do
 * it. So "unmix, then read biophysics" is the supported order and "do both at
 * once" was never a workflow — it is a misclick. A lock states the order the
 * product already assumes; teaching two wizards to share gates would model a
 * situation nobody wants to be in.
 *
 * ## Why this is one function and not three conditions
 *
 * Three surfaces can move the view — the switcher in the top bar, the *View* menu
 * and the command palette — and a guard in two of them is a guard in none. They
 * all ask here. `bottomBar.ts` exists for the same reason and says so; this is the
 * same shape one layer up.
 *
 * The lock is never silent: the switcher's segment is disabled and carries the
 * reason as its tooltip, and the two imperative routes post it to the notice bar,
 * so a refused click always says something. *Start over* in the Unmixing panel's
 * header clears the setup and the lock with it, from any step.
 */
import { wizardInProgress, type PanelTab } from '@/core/unmixing/wizard';
import { useSpectral } from './spectralStore';
import { acquisitionTypeOf, useWorkspace, type Sample } from './workspaceStore';
import type { MainView } from './uiStore';

/**
 * What a refused click says. One string, because the tooltip on the disabled
 * segment and the notice a menu item posts are the same sentence, and two copies
 * of it drift.
 */
export const UNMIXING_LOCK_REASON =
  'Finish or abandon the spillover setup first — starting Biophysics gates every '
  + 'sample and builds a worksheet each, which would overwrite the control '
  + 'worksheets. Use Start over in the Unmixing or Compensation panel to abandon it.';

/**
 * What the two spillover panels say when the loaded data is the other kind.
 *
 * ## Why this is a lock and not two hidden segments (2026-08-27)
 *
 * *Unmixing* and *Compensation* answer the same question — which fluorophore
 * produced this signal — for instruments that make it a different question.
 * A spectral panel measures thirteen dyes on sixty-four detectors and solves by
 * least squares; a conventional one measures each dye on the detector it peaks
 * in and inverts a square matrix. Neither is a setting: the file states which
 * it is, and `detectAcquisitionType` has read that at import since long before
 * either panel existed.
 *
 * So the panel that does not match the data is **shown and disabled, carrying
 * the reason**, rather than removed. A segment that vanishes teaches nobody
 * what it was for, and the answer to *"where is compensation"* on a spectral
 * workspace has to be a sentence rather than an absence.
 *
 * **Only when every sample is the other kind**, and an empty workspace locks
 * neither: loading a saved matrix into an empty workspace is a supported first
 * action on both sides, and a workspace holding both instruments needs both. The
 * per-sample override on the sample browser is the escape hatch for a file
 * classified wrongly.
 */
const MISMATCH: Record<'unmixing' | 'compensation', string> = {
  unmixing: 'These samples were acquired on a conventional cytometer — a few filtered '
    + 'detectors rather than a spectral array. Use Compensation, which inverts a '
    + 'spillover matrix over those detectors.',
  compensation: 'These samples were acquired on a spectral cytometer, where every '
    + 'fluorophore is measured across the whole detector array. Use Unmixing, which '
    + 'solves for all of them at once.',
};

/**
 * Two reasons a view can be shut, and one function that knows both.
 *
 * Three surfaces can move the view — the switcher in the top bar, the *View*
 * menu and the command palette — and a guard in two of them is a guard in none.
 * That was already true of the Biophysics lock and it is why this file exists;
 * adding a second reason here rather than a second condition in three places is
 * the same argument, unchanged.
 */
const wizardLock = (
  view: MainView,
  tab: PanelTab,
  step: 1 | 2 | 3 | 4,
  controlCount: number,
  matrixComputed: boolean,
): string | null => (
  /*
     Biophysics, while the spillover setup is mid-flight.

     It seeds a *Cells* gate across every loaded sample from a mount effect,
     which lands on top of the control worksheets the wizard is building. Both
     panels are right on their own; they are two owners of one set of objects,
     and the second to start wins silently.
  */
  view === 'biophysics' && wizardInProgress(tab, step, controlCount, matrixComputed)
    ? UNMIXING_LOCK_REASON
    : null
);

/** The other reason: this panel is for the other kind of instrument. */
const mismatchLock = (view: MainView, samples: readonly Sample[]): string | null => {
  if (view !== 'unmixing' && view !== 'compensation') return null;
  let spectral = 0;
  let conventional = 0;
  for (const s of samples) {
    if (acquisitionTypeOf(s) === 'spectral') spectral++;
    else conventional++;
  }
  if (view === 'unmixing' && conventional > 0 && spectral === 0) return MISMATCH.unmixing;
  if (view === 'compensation' && spectral > 0 && conventional === 0) return MISMATCH.compensation;
  return null;
};

/**
 * Which of the two spillover panels a matrix command means (2026-08-29).
 *
 * The *File* menu and the command palette both offer *Save/Load matrix*, and
 * both are global: they are reachable from Analysis, from Export, from anywhere.
 * Until now both were hard-wired to Unmixing — label, icon and a `setView` that
 * fired before the dialog — so on a conventional workspace the menu offered to
 * save an unmixing matrix, moved the user off Compensation to do it, and then
 * wrote a `.compensation`, because the extension follows the matrix.
 *
 * Three answers in decreasing order of authority: **the panel you are standing
 * in**, then **the only one the samples permit** — which is exactly what
 * `mismatchLock` already computes, so this asks it rather than counting sample
 * types a second time — then Unmixing, which is the right default for the empty
 * workspace where neither is locked and nothing else is known.
 */
export function spilloverPanel(view: MainView): 'unmixing' | 'compensation' {
  if (view === 'unmixing' || view === 'compensation') return view;
  const samples = useWorkspace.getState().samples;
  if (mismatchLock('unmixing', samples) && !mismatchLock('compensation', samples)) return 'compensation';
  return 'unmixing';
}

/** Why `view` cannot be opened right now, or `null` when it can. */
export function viewLockReason(view: MainView): string | null {
  const { tab, step, controls, spectra } = useSpectral.getState();
  return wizardLock(view, tab, step, controls.length, spectra.length > 0)
    ?? mismatchLock(view, useWorkspace.getState().samples);
}

/**
 * The reactive form, for a control that has to render as unavailable.
 *
 * Returns a string or `null` — a primitive, so each selector is stable and
 * cannot loop the way a fresh object would.
 *
 * Two subscriptions, because the two reasons live in two stores and both move
 * on their own: which panel applies changes the moment a file is imported or
 * its acquisition type is overridden, and a segment reading only the spectral
 * store would stay greyed after the data underneath it had changed.
 */
export function useViewLock(view: MainView): string | null {
  const wizard = useSpectral((s) => wizardLock(view, s.tab, s.step, s.controls.length, s.spectra.length > 0));
  const mismatch = useWorkspace((s) => mismatchLock(view, s.samples));
  return wizard ?? mismatch;
}
