import { create } from 'zustand';
// The 1-D mixture numerics, reused rather than restated. Pure, store-free and
// generic over a histogram; see `bracketOn` for why the split point cannot be a
// percentile.
import { fitMixture, histogram, rejectionFor } from '@/core/biophysics/mixture';
import {
  autoGateBound, detectorBrightness, detectorIndices, detectorWeights, extractAutofluorescence,
  extractGatedSignature, extractSignature, normaliseSignature, similarityMatrix, unmix, UnmixError,
  type ReferenceSpectrum, type UnmixMethod, type UnmixResult,
} from '@/core/spectral';
import {
  applyReferenceDefaults, checkStep, controlIndexForLayout, controlIsGated, detectorName,
  LAST_STEP, orderControls, peakForParameter, suggestLabel, suggestRole, uniqueLayoutNames,
  type ControlAssignment, type ControlRole, type FieldSource, type PanelTab, type ReferenceMode,
  type StepCheck, type WizardStep,
} from '@/core/unmixing/wizard';
import {
  claimedDetectors, compensationLabels, compensationSetup, matrixFromControls, matrixFromFile,
  CompensationError, type CompensationRow,
} from '@/core/compensation';
import { PANEL_GAP, panelHeight } from '@/core/layout/geometry';
import { attachUnmixed, detachUnmixed, surfacedSignatures } from '@/core/unmixedColumns';
import { createTransform } from '@/core/transform';
import { contourToData, densityContour, densityInterval } from '@/core/gating/contour';
import { bin2d } from '@/render/binning';
import { maskToIndices } from '@/core/gating/tree';
import { ROOT_ID, type Gate } from '@/core/gating/types';
import { defaultSpecFor, evaluateFor, nextGateId, useGates } from './gateStore';
import { makePanel, nextPanelId, usePlot } from './plotStore';
import { acquisitionTypeOf, useWorkspace, type Sample } from './workspaceStore';
import { record } from './historyBus';
import { onWorkspaceCleared } from './workspaceCleared';

export type { ControlAssignment, ControlRole, PanelTab, ReferenceMode, WizardStep } from '@/core/unmixing/wizard';

export interface UnmixFailure {
  sampleId: string;
  sampleName: string;
  message: string;
  hint?: string;
}

/** Why the compute action is unavailable, in the user's terms. */
export interface Readiness {
  ready: boolean;
  /** Labels of fluorophores still lacking a positive gate. */
  ungated: string[];
  hasUnstained: boolean;
  stainCount: number;
}

/** The general gate's name in the tree — one place, because four things look it up. */
export const GENERAL_GATE_NAME = 'Cells';

/**
 * How the general gate's contour is traced.
 *
 * 128 bins over the display-space extent is fine enough to follow the shoulder
 * of a scatter population and coarse enough that a 20 000-event sample still
 * fills its cells. 24 rays is a polygon somebody can actually edit — every
 * vertex is a drag target, and 64 of them turns a gate into a hairbrush.
 * Coverage errs generous for the reason a *starting* gate should: one that looks
 * finished and is slightly wrong is worse than one that obviously wants a nudge.
 */
const CONTOUR_BINS = 128;
const GENERAL_GATE_RAYS = 24;
const GENERAL_GATE_COVERAGE = 0.82;

interface SpectralState {
  spectra: ReferenceSpectrum[];
  /**
   * `$PnN` of each detector, in matrix column order.
   *
   * A signature is 64 numbers with no names attached, and the plot that draws
   * them was labelling its x axis *Detectors* — true, and no help at all in
   * deciding whether a peak is in the right channel. The names live here rather
   * than being looked up from a sample at the point of drawing, because the
   * matrix outlives the samples: one loaded from a `.unmixing` into an empty
   * workspace has detector names (the file records them, and that is what
   * compatibility is checked by) and no sample to read them off.
   *
   * Empty when nothing has been computed or loaded. A reader that finds fewer
   * names than values falls back to the position.
   */
  detectorNames: string[];
  /**
   * How the abundances are solved for. **Weighted least squares, always.**
   *
   * There used to be an OLS/Weighted control in the panel and it was removed on
   * 2026-08-08. The arithmetic behind it was never the problem — the two are
   * genuinely different solves and `spectral.test.ts` measures both the
   * difference and the fact that weighting a noisy detector block down beats
   * weighting it equally. What was wrong is that the control changed a *stored
   * preference* and nothing re-ran the unmixing, so flipping it produced no
   * observable difference at all until the sample was unmixed again.
   *
   * Given they had to be told apart, the answer is one method rather than a
   * better toggle: weighting each detector by the inverse of its variance in
   * the unstained sample is the standard treatment for photon-counting
   * detectors, whose noise scales with the signal they carry, and it is what
   * the spectral literature and the vendor packages describe. Offering the
   * unweighted fit beside it asks an operator to arbitrate a numerical
   * question, mid-experiment, with nothing on screen to arbitrate it from.
   *
   * The field stays because `unmix` takes it and because a saved matrix records
   * it; nothing sets it to `'ols'` any more.
   */
  method: UnmixMethod;
  /**
   * Per-detector weights, measured from the unstained or autofluorescence
   * sample. `null` when the panel has neither, which makes the weighted solve
   * degrade to the unweighted one — stated on screen rather than silently.
   *
   * Always `null` for a compensation matrix, and that is not an omission.
   * Weighted least squares is what buys a spectral panel resolution out of
   * sixty-four detectors solving for thirteen dyes; a square system has one
   * solution and no residual to weight, so `unmix` returns the same numbers
   * either way and calling them "weighted" would be a claim about nothing.
   */
  weights: Float64Array | null;
  /**
   * Which model the matrix in `spectra` is.
   *
   * **Descriptive, never a mode.** Nothing branches on this to decide what to
   * compute — `computeMatrix` asks the *controls* whether they came off a
   * conventional instrument, so the data decides and this records what it
   * decided. What reads it is prose: whether the panel says *signatures* or
   * *spillover coefficients*, and whether a matrix tile calls itself an
   * unmixing matrix or a compensation matrix.
   *
   * **Saved with the matrix, and it has to be** (2026-08-29). This was session
   * state until it was not: the reasoning was that a file carries detector
   * names, an order and the numbers, which is everything needed to apply it, so
   * a matrix loaded back could read as `'unmixing'` and be applied identically
   * — *because the solve does not care*. True of the arithmetic and false of
   * everything else, because this is what `runUnmixing` tags its output with. A
   * compensation panel saved and reopened came back with the right numbers
   * under `Unmixed` in every picker in the application.
   *
   * So it is written into the matrix file as `model` and into the workspace as
   * `spectral.model`, and both are read back. The lesson is the general one:
   * *the solve does not care* is not the same as *nothing cares*.
   */
  kind: 'unmixing' | 'compensation';
  /**
   * sampleId → unmixed result. Raw data is never replaced.
   *
   * Also the **reactivity signal** for the parameter lists: the abundances
   * themselves live in `core/unmixedColumns`, keyed by `ParsedFcs` so that the
   * two functions resolving a parameter index to data can find them without a
   * sample id, and a `WeakMap` has no subscribers. This record is replaced
   * wholesale whenever that registry changes, so a component that wants to
   * re-render when a matrix is applied reads it. See `attachUnmixed`.
   */
  unmixed: Record<string, UnmixResult>;
  /*
     `viewUnmixed` is deleted (2026-08-09).

     It meant *"show unmixed parameters **rather than** raw detectors on plots"*,
     which is the wrong model and was also never read by anything — it was set by
     `runUnmixing` and by `clearUnmixed` and consulted nowhere, which is the same
     defect as the abundances themselves. An unmixed parameter is a parameter: it
     sits on every axis picker beside the detectors, tagged, and a plot shows
     whichever one its axis names. There is nothing for a global mode switch to
     mean.
  */
  running: { active: boolean; done: number; total: number; current: string | null };
  failures: UnmixFailure[];
  /** Populations overlaid in the signature viewer. */
  previewIds: string[];

  /* --- The four-step wizard --- */

  /**
   * Which of the panel's two top-level tabs is showing.
   *
   * `new` is the wizard — Select, Assign, Gate, Compute. `load` is the other
   * thing anybody does with a matrix: open one that already exists and put it on
   * a sample in *this* workspace.
   *
   * They are tabs rather than one flow because they are not stages of each
   * other. Applying used to be Step 5, which said that unmixing a sample is the
   * last leg of building a panel — and it is not: a panel is built once and
   * applied every week, usually to files nobody had when it was built, often on
   * another machine. Anybody arriving to apply a saved matrix had to walk past
   * four steps about controls they were never going to select.
   */
  tab: PanelTab;
  setTab(tab: PanelTab): void;

  /** Which step the wizard is showing. See `core/unmixing/wizard.ts`. */
  step: WizardStep;
  /**
   * Samples ticked in Step 1, in the order the sample list shows them.
   *
   * Held separately from `controls` so Step 1 is a plain selection with no side
   * effects: ticking a sample does not create an assignment, give it a role, or
   * touch its gates. Step 2 is where the two are reconciled.
   */
  selectedIds: string[];
  /**
   * Controls assigned to the panel, gated or not, **in peak-detector order**.
   *
   * The order is a property of this array rather than something each reader
   * sorts for itself, which is the whole of Item 1: the Assign table, the
   * worksheet tab bar, the layout dropdown and the walk all list the same
   * eleven files, and until this pass three of them listed it in import order
   * while the fourth listed it by detector. `orderControls` is applied wherever
   * a peak is established — `syncControls`, `remeasurePeaks`, `setControlPeak` —
   * and nowhere else, so nothing re-sorts underneath a click.
   */
  controls: ControlAssignment[];
  /**
   * Which control Step 3's walk is showing — an index into `controls`.
   *
   * A fallback rather than the source of truth. What is on screen is decided by
   * `usePlot().activeLayoutId`, because that is the thing both the tab bar and
   * the layout dropdown actually change; `controlIndexForLayout` reads it and
   * falls back to this for the interval before the worksheets exist.
   */
  walkIndex: number;
  /**
   * Column widths for Step 2's table, in px by column key.
   *
   * Here rather than in the component for the reason `statisticsPrefs` exists:
   * the wizard renders one step at a time, so every move to Step 3 and back
   * unmounts this table, and a width dragged before the move would be gone
   * after it. Session state — never saved, never synced, never undone.
   */
  assignWidths: Record<string, number>;
  /**
   * The shared general gate, once Step 3 has created it.
   *
   * **One gate in the shared hierarchy**, not one per control. Gating in this
   * app is shared across samples by default, so a single coarse gate is on every
   * control the moment it is drawn — which is exactly the "universal general
   * gate" the workflow calls for, with no separate mechanism behind it. Making
   * it specific to one control is `setGateLinked(sampleId, id, false)`, the same
   * per-gate unlink the regular gate tree offers.
   *
   * This replaces `generalGateSource`, which named a *sample* whose whole
   * strategy was replicated onto the others with `copyStrategy`. That produced
   * one independent gate per control with fresh ids — so adjusting "the general
   * gate" meant adjusting eight of them, and every per-control positive gate
   * reference was invalidated each time it was re-applied.
   */
  generalGateId: string | null;
  /** When the matrix was last computed, for the saved-file summary. */
  computedAt: string | null;
  /**
   * Provenance when the panel came from a matrix file rather than from
   * controls in this workspace.
   *
   * Worth tracking separately from `computedAt`: a loaded matrix has no local
   * controls and no local gates, so the reference panel has to say where its
   * signatures came from or it looks like a panel someone forgot to gate.
   * `path` is null in a browser tab, where the picker yields a name only.
   */
  loadedFrom: { path: string | null; name: string; savedAt: string } | null;

  addFromSample(sample: Sample, opts?: { asAutofluorescence?: boolean; label?: string }): void;
  removeSpectrum(id: string): void;
  renameSpectrum(id: string, label: string): void;
  clearSpectra(): void;
  togglePreview(id: string): void;
  /**
   * Replace the whole visible set — the signature plot's *select all / none*.
   *
   * A setter rather than two actions, because "show everything" and "show
   * nothing" are one control with two states and the plot's own button reads
   * which one it is offering off `previewIds`. Session state like the rest of
   * this record: it is what is drawn, not what was measured.
   */
  setPreviewIds(ids: string[]): void;
  runUnmixing(samples: Sample[]): Promise<void>;
  clearUnmixed(): void;

  /* --- Step 1: select --- */
  toggleSelected(sampleId: string): void;
  setSelected(sampleIds: string[]): void;
  clearSelection(): void;

  /* --- Step 2: assign --- */
  /** Reconcile `controls` with `selectedIds`, keeping any assignment already made. */
  syncControls(samples: Sample[]): void;
  setControlRole(sampleId: string, role: ControlRole | null): void;
  setControlReference(sampleId: string, reference: ReferenceMode): void;
  /**
   * Put every single stain on the same negative reference. Returns how many moved.
   *
   * A panel is almost always one or the other — beads carry their own negative,
   * stained cells read one unstained tube — so setting fourteen rows one at a
   * time is fourteen clicks to state one fact. Baselines are untouched: an
   * unstained or autofluorescence tube has no negative reference to choose.
   */
  setAllReferences(reference: ReferenceMode): number;
  relabelControl(sampleId: string, label: string): void;
  /** Override the measured emission maximum with a detector chosen by hand. */
  setControlPeak(sample: Sample, parameterIndex: number): void;
  setAssignWidths(widths: Record<string, number>): void;

  /* --- Step 3: gate --- */
  /** Build one worksheet per control and seed the general and positive gates. */
  buildGatingLayouts(samples: Sample[]): { built: number; message?: string };
  /** Show control `index` of the walk, switching to its worksheet. */
  goToControl(index: number): void;
  /** Index of the control whose worksheet is on screen. See `walkIndex`. */
  currentControlIndex(): number;
  /** One control forward (+1) or back (−1) along the walk. */
  walkBy(delta: number): void;
  /** Give this control its own copy of the general gate's boundary. */
  unlinkGeneralGate(sampleId: string): void;
  /** Put it back on the shared one, discarding the per-control boundary. */
  relinkGeneralGate(sampleId: string): void;
  setControlGate(sampleId: string, gateId: string | null, origin?: 'user' | 'auto'): void;
  /** Seed one control's adjustable gates from the percentile heuristic. */
  autoGateControl(sample: Sample): string | null;
  /**
   * Seed every control that has no gates yet, and leave the rest alone.
   *
   * Runs on arrival at Step 3 and on every move of the walk. There is no button:
   * see the note in the implementation.
   */
  ensureGated(samples: Sample[]): number;

  /* --- Navigation --- */
  setStep(step: WizardStep): void;
  /** Whether the current step can be left, and what is missing if not. */
  stepCheck(): StepCheck;
  /** Advance, running whatever the step needs on the way out. */
  next(samples: Sample[]): void;
  back(): void;
  /** Back to Step 1 with nothing selected. Gates and layouts are left alone. */
  resetWizard(): void;

  /* --- Step 4 --- */
  /** Whether every fluorophore is ready, and what is missing if not. */
  readiness(): Readiness;
  /** Build the reference panel from the gated populations. Explicit, never automatic. */
  computeMatrix(samples: Sample[]): { ok: boolean; message?: string };
  /**
   * Install the matrix the acquisition software wrote into a file.
   *
   * The conventional panel's short path, and for most people the only one they
   * need: FACSDiva computed a spillover matrix from these same single stains
   * before the tubes were even off the machine and wrote it into every file it
   * exported. Reading it is not a shortcut past the wizard, it is a different
   * and better-founded source — that matrix was built by somebody watching the
   * plots at acquisition time.
   *
   * `sample` is which file to read it out of; the matrix is then applied to
   * whatever the user asks, exactly as a loaded `.unmixing` is.
   */
  useFileMatrix(sample: Sample): { ok: boolean; message?: string };
}

/**
 * Events inside a control's positive gate, or inside the general gate alone
 * when no positive gate is set.
 *
 * Goes through the same `evaluateFor` the plots use, so what the operator sees
 * on screen is exactly what feeds the signature — a second evaluation path
 * would be a way for the picture and the maths to disagree.
 */
export function gatedEventsFor(sample: Sample, gateId: string | null): Uint32Array | null {
  const gates = useGates.getState().gatesFor(sample.id);
  if (gates.length === 0 || !gateId || gateId === ROOT_ID) return null;
  const evaluated = evaluateFor(sample.id, sample.parsed, gates, (p) =>
    defaultSpecFor(sample.parsed, p),
  );
  const mask = evaluated.masks.get(gateId);
  return mask ? maskToIndices(mask) : null;
}

/** The general gate's own population on a control, if one exists. */
function generalGateEvents(sample: Sample, generalGateId: string | null): Uint32Array | null {
  if (!generalGateId) return null;
  const gates = useGates.getState().gatesFor(sample.id);
  return gates.some((g) => g.id === generalGateId) ? gatedEventsFor(sample, generalGateId) : null;
}

/*
   `classifyControl` is deleted (2026-08-06).

   It read a filename, decided whether the sample "looked like" a control, and
   decided whether it was unstained — three claims about an experiment inferred
   from a string, made silently, and correctable only by noticing they had been
   made. It is the same defect as `suggestGroups`, deleted on 2026-08-03 for
   merging two opposite conditions on a shared filename prefix, and it is removed
   for the same reason rather than being improved: there is no filename convention
   the app can rely on, and a wrong guess in this position produces an unmixing
   matrix built from the wrong signatures.

   What replaced it is Steps 1 and 2 — a tick and a dropdown. `parseControlIdentity`
   still exists and still populates `Sample.identity`; nothing reads it to make a
   decision any more.
*/

/**
 * The detector a control is brightest in, measured from the file.
 *
 * The one thing in this workflow the app *can* work out for itself, because it
 * is a measurement rather than an inference: the 98th percentile of every
 * detector, and the largest wins. `autoGateBound` already computes exactly this
 * on its way to a threshold, so this reuses it rather than restating the rule —
 * a second implementation would be a way for the detected peak and the seeded
 * gate to disagree about which channel they are talking about.
 *
 * Computed over the whole file before any gate exists, and recomputed inside the
 * general gate once there is one, which is the refinement the workflow calls for.
 *
 * **Against the unstained control's own profile whenever the panel has one.** On
 * beads the absolute rule is right — a bead has no autofluorescence, so its
 * brightest channel is its dye's. On stained *cells* it is not: a PBMC is
 * autofluorescent across the UV and violet blocks, and that background is
 * brighter than a far-red dye's own signal. Measured on the real panel, the
 * absolute rule put CCR7 APC-Fire 810, CD28 Alexa Fluor 700, LiveDead and NKG2A
 * PerCP-Fire 806 all on **UV7-A**, which is not any of their emission maxima.
 * See `autoGateBound`'s `baseline`.
 */
function measurePeak(sample: Sample, within?: Uint32Array | null, baseline?: Float64Array | null) {
  const dets = detectorIndices(sample.parsed.metadata);
  if (dets.length === 0) return null;
  const bound = autoGateBound(sample.parsed.data, sample.parsed.metadata.eventCount, dets, {
    eventSubset: within ?? undefined,
    baseline: baseline ?? undefined,
  });
  if (!bound) return null;
  return {
    peak: {
      detector: bound.peakDetector,
      parameterIndex: bound.parameterIndex,
      name: detectorName(sample.parsed.metadata, bound.parameterIndex),
    },
    threshold: bound.threshold,
  };
}

/**
 * Point one control's **positive** spectrum plot at a different population.
 *
 * Reaches into whichever layout owns it, active or stashed, because the choice
 * that triggers this is made in the Unmixing panel and the worksheet it affects
 * may not be the one on screen. Panels are found by *what they are* — the
 * spectrum plot of this sample — rather than by an id recorded on the control,
 * so a worksheet somebody has rearranged still resolves and one that no longer
 * has a spectrum plot is a no-op rather than an error.
 *
 * **`except` is the negative spectrum, and it has to be excluded by name.** A
 * self-referencing control's worksheet carries two spectrum plots now (see
 * `panelsForControl`), and without this the *Signature population* dropdown
 * pointed both of them at the positive gate — leaving the operator with the same
 * picture twice and no negative reference on screen at all.
 */
function rescopeSpectrumPanel(
  layoutId: string,
  sampleId: string,
  populationId: string | null,
  except?: string | null,
): void {
  const plot = usePlot.getState();
  const matches = (p: { plotType: string; sampleId: string | null; populationId: string | null }) =>
    p.plotType === 'spectrum' && p.sampleId === sampleId && !(except && p.populationId === except);

  if (plot.activeLayoutId === layoutId) {
    usePlot.setState({
      panels: plot.panels.map((p) => (matches(p) ? { ...p, populationId } : p)),
    });
    return;
  }
  const target = plot.otherLayouts[layoutId];
  if (!target) return;
  usePlot.setState({
    otherLayouts: {
      ...plot.otherLayouts,
      [layoutId]: {
        ...target,
        panels: target.panels.map((p) => (matches(p) ? { ...p, populationId } : p)),
      },
    },
  });
}

/** A scatter parameter by name, for the general gate's axes. Falls back to position. */
/**
 * Build a square spillover matrix from the same gated controls the spectral
 * path uses.
 *
 * The wizard is one wizard. Selecting the controls, naming them, measuring each
 * one's brightest detector and gating its positive population are the same four
 * steps whichever instrument the tubes came off, so nothing above this function
 * knows which model is being built — it is only the arithmetic at the end that
 * differs, and it differs in exactly two ways.
 *
 * **Every signature is a subtraction.** In the spectral solve a
 * `reference: 'unstained'` control needs no negative subtracted here, because
 * the panel carries the unstained tube as its own autofluorescence row and the
 * least-squares fit solves for it. A square system has no such row — see
 * `core/compensation.ts` for why it cannot — so the background has to come off
 * the signature itself, and the negative comes from the control's own negative
 * gate when it has one and from the unstained tube when it does not. That is
 * the universal-negative arrangement every conventional package offers, and
 * the reason the unstained tube is still required.
 *
 * **The row is normalised to the dye's primary detector**, which is Step 2's
 * measured peak unless somebody re-pointed it, rather than to whatever the
 * signature happens to be tallest in. `matrixFromControls` does that division
 * and refuses the two cases that cannot be solved.
 */
function compensationFrom(
  controls: ControlAssignment[],
  samples: Sample[],
  generalGateId: string | null,
): { ok: true; spectra: ReferenceSpectrum[]; detectorNames: string[] } | { ok: false; message: string } {
  const sampleOf = (id: string) => samples.find((s) => s.id === id) ?? null;

  /*
     The universal negative, in channel units.

     Measured over the background tube's own refining gate when it has one and
     the general cells gate otherwise — the same population the spectral path
     extracts autofluorescence from, so the two readings of "what an unstained
     cell looks like" cannot come apart.
  */
  const background = controls.find((c) => c.role === 'unstained')
    ?? controls.find((c) => c.role === 'autofluorescence')
    ?? null;
  let universalNegative: Float64Array | null = null;
  let detectorNames: string[] = [];

  if (background) {
    const sample = sampleOf(background.sampleId);
    if (sample) {
      const dets = detectorIndices(sample.parsed.metadata);
      const within = background.positiveGateId
        ? gatedEventsFor(sample, background.positiveGateId)
        : generalGateEvents(sample, generalGateId);
      universalNegative = extractGatedSignature(
        sample.parsed.data,
        sample.parsed.metadata.eventCount,
        dets,
        within ?? Uint32Array.from({ length: sample.parsed.metadata.eventCount }, (_, i) => i),
      ).raw;
      detectorNames = dets.map((d) => sample.parsed.metadata.parameters[d]?.name ?? `#${d}`);
    }
  }

  const rows: CompensationRow[] = [];
  let named: Sample | null = null;

  for (const c of controls) {
    if (c.role !== 'stain') continue;
    const sample = sampleOf(c.sampleId);
    if (!sample) continue;
    const dets = detectorIndices(sample.parsed.metadata);
    if (dets.length === 0) continue;
    const n = sample.parsed.metadata.eventCount;

    const positive = gatedEventsFor(sample, c.positiveGateId);
    if (!positive || positive.length === 0) {
      return { ok: false, message: `“${c.label}” has no events in its positive gate.` };
    }
    const pos = extractGatedSignature(sample.parsed.data, n, dets, positive);

    let negative = universalNegative;
    if (c.reference === 'self' && c.negativeGateId) {
      const events = gatedEventsFor(sample, c.negativeGateId);
      if (!events || events.length === 0) {
        return { ok: false, message: `“${c.label}” has no events in its negative gate.` };
      }
      negative = extractGatedSignature(sample.parsed.data, n, dets, events).raw;
    }
    if (!negative) {
      return {
        ok: false,
        message: 'A compensation matrix needs a negative to subtract. Assign an unstained control, or give each stain its own negative gate.',
      };
    }

    const signature = new Float64Array(dets.length);
    for (let d = 0; d < dets.length; d++) signature[d] = pos.raw[d]! - negative[d]!;
    /*
       Step 2's peak, not this signature's. They agree on a well-behaved dye,
       and where they do not the operator has said which detector carries the
       stain — a dropdown they can see beats an argmax they cannot.
    */
    rows.push({ label: c.label, primary: c.peak?.detector ?? pos.peakDetector, signature });
    if (!named) {
      named = sample;
      if (detectorNames.length === 0) {
        detectorNames = dets.map((d) => sample.parsed.metadata.parameters[d]?.name ?? `#${d}`);
      }
    }
  }

  if (rows.length === 0) return { ok: false, message: 'No control produced a usable signature.' };
  const md = (named ?? sampleOf(background?.sampleId ?? ''))?.parsed.metadata;
  if (!md) return { ok: false, message: 'No control produced a usable signature.' };

  try {
    const matrix = matrixFromControls(rows, detectorNames);
    const labels = compensationLabels(md, matrix, claimedDetectors(rows));
    const setup = compensationSetup(md, matrix, labels);
    return { ok: true, spectra: setup.spectra, detectorNames: setup.detectorNames };
  } catch (e) {
    return { ok: false, message: e instanceof CompensationError ? e.message : String(e) };
  }
}

function scatterParam(sample: Sample, want: 'FSC' | 'SSC'): number {
  const params = sample.parsed.metadata.parameters;
  const hit = params.findIndex((p) => p.name.toUpperCase().startsWith(`${want}-A`));
  if (hit >= 0) return hit;
  const loose = params.findIndex((p) => p.name.toUpperCase().includes(want));
  if (loose >= 0) return loose;
  return want === 'FSC' ? 0 : Math.min(1, params.length - 1);
}

export const useSpectral = create<SpectralState>((set, get) => ({
  spectra: [],
  detectorNames: [],
  method: 'wls',
  weights: null,
  kind: 'unmixing',
  unmixed: {},
  running: { active: false, done: 0, total: 0, current: null },
  failures: [],
  previewIds: [],
  tab: 'new',
  step: 1,
  selectedIds: [],
  controls: [],
  walkIndex: 0,
  assignWidths: {},
  generalGateId: null,
  computedAt: null,
  loadedFrom: null,

  addFromSample(sample, opts = {}) {
    const dets = detectorIndices(sample.parsed.metadata);
    if (dets.length === 0) return;
    const asAF = opts.asAutofluorescence ?? false;
    const spectrum: ReferenceSpectrum = asAF
      ? {
          id: sample.id,
          label: opts.label ?? 'Autofluorescence',
          values: extractAutofluorescence(sample.parsed.data, sample.parsed.metadata.eventCount, dets).values,
          isAutofluorescence: true,
          sourceSampleId: sample.id,
          eventCount: sample.parsed.metadata.eventCount,
        }
      : (() => {
          const sig = extractSignature(sample.parsed.data, sample.parsed.metadata.eventCount, dets);
          return {
            id: sample.id,
            // The sample's own name when the caller does not say. Nothing is
            // parsed out of the filename any more — see the note above.
            label: opts.label ?? sample.name,
            values: normaliseSignature(sig.values),
            isAutofluorescence: false,
            sourceSampleId: sample.id,
            eventCount: sig.eventsUsed,
          };
        })();

    set((s) => ({
      spectra: [...s.spectra.filter((x) => x.id !== spectrum.id), spectrum]
        .sort((a, b) => Number(a.isAutofluorescence) - Number(b.isAutofluorescence)),
    }));
  },

  removeSpectrum(id) {
    record('Remove reference spectrum');
    set((s) => ({ spectra: s.spectra.filter((x) => x.id !== id), previewIds: s.previewIds.filter((x) => x !== id) }));
  },

  renameSpectrum(id, label) {
    record('Rename reference spectrum');
    set((s) => ({ spectra: s.spectra.map((x) => (x.id === id ? { ...x, label: label.trim() || x.label } : x)) }));
  },

  clearSpectra() {
    record('Clear reference panel');
    set({ spectra: [], detectorNames: [], previewIds: [], weights: null, kind: 'unmixing', computedAt: null, loadedFrom: null });
  },

  togglePreview(id) {
    set((s) => ({
      previewIds: s.previewIds.includes(id) ? s.previewIds.filter((x) => x !== id) : [...s.previewIds, id],
    }));
  },

  setPreviewIds(ids) { set({ previewIds: [...ids] }); },

  async runUnmixing(samples) {
    const { spectra, method, weights, kind } = get();
    if (spectra.length === 0) return;

    set({ running: { active: true, done: 0, total: samples.length, current: null }, failures: [] });
    const unmixed: Record<string, UnmixResult> = { ...get().unmixed };
    const failures: UnmixFailure[] = [];

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      set({ running: { active: true, done: i, total: samples.length, current: s.name } });
      // Yield so the progress bar paints between samples.
      await new Promise((r) => setTimeout(r, 0));

      try {
        const dets = detectorIndices(s.parsed.metadata);
        const result = unmix(
          s.parsed,
          { detectorIndices: dets, detectorNames: dets.map((d) => s.parsed.metadata.parameters[d]!.name), spectra },
          method,
          weights ?? undefined,
        );
        unmixed[s.id] = result;
        /*
           And **this** is what puts them on the axis pickers.

           Until 2026-08-09 the line above was the whole of it: a full result,
           correct in every number, written into a store record that nothing
           outside this panel read. The panel then told the user the parameters
           were on every axis picker in the window, and they were on none.

           `attachUnmixed` is the other half — it hands the abundances to the two
           functions that resolve a parameter index to data, so a fluorophore
           becomes a parameter in exactly the way a derived one does. The record
           above stays because it is what the UI subscribes to and what the
           badges and counts read; the registry is what the plots read. They are
           written together, here, which is the only place either is set.
        */
        /*
           Antibody abundances only (2026-08-11, Item 15).

           `result` carries one column per signature, autofluorescence included —
           it has to, because that column is what the solve put the cell
           background into and the antibody columns are only right *because* it
           exists. What reaches the parameter list is the subset a person would
           call a marker: `surfacedSignatures` drops the references and hands
           over an index map, so a column is still a zero-copy `subarray` of the
           same abundances and nothing is recomputed or copied.

           `unmixed[s.id]` above keeps the **full** result, and deliberately: it
           is provenance and the reactivity signal, and the condition number and
           the label list it reports are properties of the whole solve.
        */
        attachUnmixed(s.parsed, {
          data: result.data,
          eventCount: result.eventCount,
          // Which solve produced them, so a compensated channel is not tagged
          // *Unmixed* on every picker in the application.
          kind: kind === 'compensation' ? 'compensated' : 'unmixed',
          ...surfacedSignatures(spectra),
        });
      } catch (e) {
        failures.push({
          sampleId: s.id,
          sampleName: s.name,
          message: e instanceof UnmixError ? e.message : String(e),
          hint: e instanceof UnmixError ? e.hint : undefined,
        });
      }
    }

    set({
      unmixed,
      failures,
      running: { active: false, done: samples.length, total: samples.length, current: null },
    });
  },

  clearUnmixed() {
    // The registry goes with the record, or the parameters would stay on every
    // picker after the results they came from had been cleared.
    for (const s of useWorkspace.getState().samples) detachUnmixed(s.parsed);
    set({ unmixed: {}, failures: [] });
  },

  /* ---------------------------------------------------------------------
     Step 1 — explicit selection
     --------------------------------------------------------------------- */

  toggleSelected(sampleId) {
    set((s) => ({
      selectedIds: s.selectedIds.includes(sampleId)
        ? s.selectedIds.filter((x) => x !== sampleId)
        : [...s.selectedIds, sampleId],
    }));
  },

  setSelected(sampleIds) { set({ selectedIds: [...sampleIds] }); },
  clearSelection() { set({ selectedIds: [] }); },

  /* ---------------------------------------------------------------------
     Step 2 — roles, labels and reference modes
     --------------------------------------------------------------------- */

  syncControls(samples) {
    const { selectedIds, controls } = get();
    const existingById = new Map(controls.map((c) => [c.sampleId, c]));
    const order = new Map(samples.map((s, i) => [s.id, i]));

    const chosen = selectedIds
      .filter((id) => order.has(id))
      // Sidebar order, so Step 2's rows sit in the order Step 1's ticks were
      // shown in rather than the order they were clicked.
      .sort((a, b) => order.get(a)! - order.get(b)!);
    // The names the label suggestion measures shared boilerplate against — the
    // *selection*, not the workspace. A file that was not ticked says nothing
    // about what distinguishes the ones that were.
    const siblings = chosen.map((id) => samples.find((s) => s.id === id)?.name ?? id);

    const next = chosen.map((id) => {
      const existing = existingById.get(id);
      // An assignment already made survives a return to Step 1 and back.
      // De-selecting and re-selecting is how it is cleared, which is the same
      // gesture that made it.
      if (existing) return existing;
      const sample = samples.find((s) => s.id === id)!;
      return {
        sampleId: id,
        label: suggestLabel(sample.name, siblings),
        labelSource: 'suggested' as FieldSource,
        role: suggestRole(sample.name),
        roleSource: 'suggested' as FieldSource,
        // Corrected below by `applyReferenceDefaults` once every row exists —
        // the default is a property of the panel, and the panel is not complete
        // until the last row has been given its suggested role.
        reference: 'unstained' as ReferenceMode,
        referenceSource: 'suggested' as FieldSource,
        // Left null here and filled in by `remeasurePeaks` below, once every row
        // exists. A stain's peak is measured *against the unstained control*,
        // and which control that is is not known until the last row has been
        // given its suggested role — so measuring a row as it is created would
        // put the answer in the column that the build then silently replaces.
        peak: null,
        peakSource: 'suggested' as FieldSource,
        positiveGateId: null,
        negativeGateId: null,
        gateOrigin: null,
        layoutId: null,
      } satisfies ControlAssignment;
    });

    const byId = new Map(samples.map((s) => [s.id, s]));
    // Ordered here, where the peaks are measured, and not again anywhere else.
    set({ controls: orderControls(remeasurePeaks(applyReferenceDefaults(next), byId)) });
  },

  setControlRole(sampleId, role) {
    record('Set control role');
    set((s) => ({
      // Through `applyReferenceDefaults`, so assigning or unassigning the
      // Unstained role moves every single stain that is still on a suggestion.
      // Without it the panel keeps the answer to a question that has changed:
      // ticking an unstained control after the fact left eleven bead-style rows
      // referencing themselves.
      //
      // Re-ordered because the role decides the *rank*: baselines walk first, so
      // marking a row Unstained moves it to the front of every list at once.
      controls: orderControls(applyReferenceDefaults(
        s.controls.map((c) => (c.sampleId === sampleId ? { ...c, role, roleSource: 'user' } : c)),
      )),
      computedAt: null,
    }));
  },

  setControlReference(sampleId, reference) {
    record('Set reference mode');
    set((s) => ({
      controls: s.controls.map((c) => (c.sampleId === sampleId
        // Switching mode discards the negative gate: a self-referencing
        // control's negative population is on its own file, and a control that
        // has stopped self-referencing has no use for it. Leaving it would keep
        // a gate nothing reads and let Step 3 report a control as complete on
        // the strength of it.
        ? {
            ...c, reference, referenceSource: 'user' as FieldSource,
            negativeGateId: reference === 'self' ? c.negativeGateId : null,
          }
        : c)),
      computedAt: null,
    }));
  },

  setAllReferences(reference) {
    const affected = get().controls.filter((c) => c.role === 'stain' && c.reference !== reference).length;
    if (affected === 0) return 0;
    record('Set every negative reference');
    set((s) => ({
      // Same rule as the single-row write, applied across the stains: switching
      // away from `self` discards the negative gate, because it lives on a file
      // that is no longer the negative reference. Baselines are left alone —
      // `reference` means nothing on a tube that *is* the baseline.
      controls: s.controls.map((c) => (c.role === 'stain'
        ? {
            ...c, reference, referenceSource: 'user' as FieldSource,
            negativeGateId: reference === 'self' ? c.negativeGateId : null,
          }
        : c)),
      computedAt: null,
    }));
    return affected;
  },

  setAssignWidths(widths) { set({ assignWidths: widths }); },

  relabelControl(sampleId, label) {
    record('Relabel control');
    set((s) => ({
      controls: s.controls.map((c) => (c.sampleId === sampleId
        ? { ...c, label: label.trim() || c.label, labelSource: 'user' as FieldSource }
        : c)),
    }));
  },

  setControlPeak(sample, parameterIndex) {
    const peak = peakForParameter(
      sample.parsed.metadata,
      detectorIndices(sample.parsed.metadata),
      parameterIndex,
    );
    if (!peak) return;
    record('Set peak detector');

    /*
       The old gates are **deleted**, not merely forgotten.

       Dropping the ids from the assignment was the original fix and it left the
       gates themselves in the hierarchy, on a channel this control no longer
       looks at — dead populations, counted by the statistics table and offered
       by the export. It became visible rather than merely untidy once a gate
       could belong to one sample: on a panel where two stains share a detector,
       re-picking the same detector produced *two* gates named "CD27 RB705 +" on
       the same histogram, one of them a ghost of the previous seeding.

       Removing them is safe because this action is what invalidates them: a
       gate is a threshold on a detector, and the detector has just changed.
    */
    const stale = get().controls.find((c) => c.sampleId === sample.id);
    for (const id of [stale?.positiveGateId, stale?.negativeGateId]) {
      if (id) useGates.getState().removeGate(sample.id, id);
    }

    set((s) => ({
      /*
         Re-ordered, because correcting a peak detector is exactly the event the
         order is a function of. Item 1 asks for an order that does not reshuffle
         when a worksheet is opened; a manual correction is the other thing
         entirely — the measurement it was sorted by has changed, so the row
         moves, once, at the moment somebody moves it.
      */
      controls: orderControls(s.controls.map((c) => {
        if (c.sampleId !== sample.id) return c;
        /*
           The gates go with the channel.

           A positive gate is a threshold *on a detector*; leaving it in place
           while the control's peak moves to another one would leave a gate on
           the old channel still counting events and still satisfying Step 3,
           while every plot in this control's layout showed the new one. The
           re-seed happens automatically on the next visit — see `ensureGated`.
        */
        return {
          ...c, peak, peakSource: 'user' as FieldSource,
          positiveGateId: null, negativeGateId: null, gateOrigin: null,
        };
      })),
      computedAt: null,
    }));
  },

  /* ---------------------------------------------------------------------
     Step 3 — one worksheet per control
     --------------------------------------------------------------------- */

  buildGatingLayouts(samples) {
    const byId = new Map(samples.map((s) => [s.id, s]));
    const controls = get().controls.filter((c) => byId.has(c.sampleId));
    if (controls.length === 0) return { built: 0, message: 'No selected control is still loaded.' };

    // One step for the whole build: it creates a gate, several layouts and a
    // panel per control, and undoing it has to put all of that back at once.
    record('Build gating layouts');

    // Through the same helper Step 2 uses, so the detector shown in the Assign
    // table is the detector the layout is built on. It used to be measured a
    // second time here, with a rule the column had never seen.
    const measured = remeasurePeaks(controls, byId);

    /* ---- The shared general gate ---- */
    const gateStore = useGates.getState();
    let generalGateId = get().generalGateId;
    const existing = gateStore.shared.find((g) => g.id === generalGateId);
    if (!existing) {
      /*
         Drawn on the first control and thereby on every one of them.

         Gating in this app is shared across samples unless a sample is
         explicitly forked, so adding one gate to the shared hierarchy *is* the
         universal general gate — there is no replication step and nothing to
         keep in sync. The workflow's "Make specific to this control" is then
         the per-gate unlink the regular tree already offers, which moves one
         control's boundary and leaves the other eight where they are.
      */
      const first = byId.get(measured[0]!.sampleId)!;
      const x = scatterParam(first, 'FSC');
      const y = scatterParam(first, 'SSC');
      const traced = scatterPolygon(first, x, y);
      /*
         `reference: true` and **no `ownerSampleId`** — the two are not
         alternatives, and this gate is the one that shows why (Item 11).

         It is deliberately shared across every control: one cell gate, drawn on
         the first of them and used by all, which is the arrangement the Gate
         step's copy describes. Giving it an owner would break that. But shared
         in MCFlow means shared with **every sample in the workspace**, so it sat
         at the root of the gate tree in general layouts too, over multicolour
         data it was never drawn on — and, being at the root and usually
         selected, it collected the user's own gates as children.

         The flag says which part of the application it belongs to, which is the
         question `ownerSampleId` was never asking.
      */
      const gate: Gate = traced
        ? {
            id: nextGateId(),
            name: GENERAL_GATE_NAME,
            parentId: null,
            colorIndex: 0,
            reference: true,
            kind: 'polygon',
            xParam: x,
            yParam: y,
            vertices: traced.vertices,
            xSpec: traced.xSpec,
            ySpec: traced.ySpec,
          }
        : {
            // Only when the file has no binnable scatter at all, which means
            // there is no contour to trace. A box around everything is a worse
            // gate than a traced one and a better one than none — Step 4 needs
            // *a* parent population, and this one at least says so on screen.
            id: nextGateId(),
            name: GENERAL_GATE_NAME,
            parentId: null,
            colorIndex: 0,
            reference: true,
            kind: 'rectangle',
            xParam: x,
            yParam: y,
            ...scatterBounds(first, x, y),
          };
      gateStore.addGate(first.id, gate);
      generalGateId = gate.id;
    }

    /* ---- A worksheet per control ---- */
    // `measured` is already in peak-detector order — `remeasurePeaks` preserves
    // the order of what it is given and every path into `controls` orders it —
    // but a re-measure can move a row, so this settles it once more before the
    // worksheets are named and numbered against it.
    const ordered = orderControls(measured);
    const names = uniqueLayoutNames(ordered);
    const plot = usePlot.getState();
    const built: ControlAssignment[] = [];

    ordered.forEach((c, i) => {
      const sample = byId.get(c.sampleId)!;
      // Reuse the layout this control already had, so re-running the build after
      // adding one control does not orphan the eight the user has been working in.
      // `'reference'` is what tells the rest of the application that this
      // worksheet belongs to the wizard rather than to the user — see
      // `LayoutDef.kind`. Without it the layout dropdown listed thirteen
      // generated worksheets and one general layout as one flat list.
      const reusing = !!c.layoutId && plot.allLayouts().some((l) => l.id === c.layoutId);
      const layoutId = reusing ? c.layoutId! : usePlot.getState().addLayout(names[i], 'reference');
      usePlot.getState().renameLayout(layoutId, names[i]!);
      usePlot.getState().markLayoutKind(layoutId, 'reference');
      usePlot.getState().switchLayout(layoutId);

      /*
         Gated before the panels are made, not after, and the order is the point.

         The gates are what the histogram panel draws and what the
         spectrum panel is scoped to, so a layout built first and gated second
         opens showing a plot of the wrong population and corrects itself a
         moment later. Seeding here also means every control is gated by the time
         Step 3 is on screen, which is what removed the two auto-gate buttons —
         see `ensureGated`.
      */
      /*
         `baselines` here and nowhere else, and the asymmetry is the point.

         A single stain's gate is *required*, so `ensureGated` tops it up on
         arrival at Step 3 and on every move of the walk — nobody wants a stain
         left ungated, and re-seeding one that was deleted is the right answer.

         A baseline's is *offered*. "No refining gate, measure the whole gated
         sample" is a legitimate and common final answer, and it is what the
         Signature population dropdown calls **Cells (whole gated sample)** —
         so a top-up pass would put the seeded gate back every time somebody
         chose it, which is the application overwriting a decision rather than
         making one.

         **Only on this control's first build**, which is what the sentence that
         used to end this comment — "building the worksheets is the one moment
         there is nothing to overwrite" — was claiming and did not check. The
         build is not one moment; it runs again every time Step 2 is left. So
         clearing an unstained control's clean gate, stepping back to fix a
         label and coming forward again put the gate straight back, over a
         decision the operator had just made, and left the cleared one in the
         tree beside it — one of the two ways a worksheet came to carry two
         brackets called *Autofluorescence clean* (2026-08-13).

         Reusing a worksheet is exactly the test for "this control has been
         built before": a re-added control gets a fresh assignment with no
         layout, so it is seeded again and lands where it would have if it had
         only ever been added once.
      */
      const gated = seedGates(sample, c, generalGateId, { baselines: !reusing });
      const panels = panelsForControl(sample, gated, generalGateId);
      usePlot.getState().setPanels(panels, panels[0]?.id);
      built.push({ ...gated, layoutId });
    });

    set({
      controls: built,
      generalGateId,
      walkIndex: 0,
      computedAt: null,
    });

    /* ---- Reference worksheets with no control left to belong to ---- */
    /*
       ## The duplicate-layout bug (2026-08-12, Item 8)

       This build **reuses** a control's existing worksheet and **creates** one
       for a control that has none — and until now it did nothing at all about a
       worksheet whose control has gone. That is the whole of the reported
       defect: take the Autofluorescence control back out at Step 1, come
       forward again, and its worksheet is still in the layout list with its
       name and its plots, belonging to nothing. Put the control back and
       `syncControls` builds it a **fresh** assignment with `layoutId: null` —
       correctly, since de-selecting is how an assignment is cleared — so this
       loop makes it a second worksheet under the same name. Two tabs called
       *Autofluorescence*, one of them inert, and another pair on every
       add/remove cycle after that.

       Removing them here rather than where a control is de-selected, and the
       distinction matters: Step 1 is a *tick*, and a user who unticks a control
       and immediately re-ticks it has changed nothing and must lose nothing.
       The worksheets are built when Step 2 is left, so the worksheets are
       reconciled when Step 2 is left. One place decides what the set of
       reference worksheets is, which is the same argument `LayoutDef.kind` was
       introduced under: an inference in a second place is right until it is not.

       Scoped to `kind === 'reference'` — a general layout is somebody's own work
       and is never this function's to remove, whatever it is called.
    */
    const keep = new Set(built.map((c) => c.layoutId));
    const orphans = usePlot.getState().allLayouts()
      .filter((l) => l.kind === 'reference' && !keep.has(l.id));
    for (const l of orphans) usePlot.getState().removeLayout(l.id);

    /* ---- Reference gates with no control left to belong to ---- */
    /*
       ## The duplicate-gate bug (2026-08-13)

       The same defect as the one above, one level down, and reported after the
       one above had been fixed: the worksheets stopped duplicating and the
       *gates* on them did not. Two brackets called *Autofluorescence clean* on
       one histogram, then three; two *CD4 PE-Fire 744 +* labels drawn over
       each other with two entries in the tree behind them.

       Everything the paragraph above says about worksheets is true of gates
       word for word. `syncControls` clears a de-selected control's assignment,
       and that assignment held the **only** pointer to the gates the wizard had
       seeded for it — so re-adding the control seeded a second set while the
       first stayed in the strategy, flagged `reference`, owned by that sample,
       and therefore still drawn on that sample's own worksheet.

       Reconciled here for the same reason and against the same list: the gates
       are seeded when Step 2 is left, so the gates are reconciled when Step 2 is
       left, from `built` — the setup as it now stands rather than as it was.

       `pruneReferenceGates` states what survives and why it is keyed by gate id
       rather than by sample. The one thing to keep in mind here is that the
       ids come from **`built`** and not from `get().controls`: `built` is what
       the seeding loop just produced, so a gate created three lines ago is in
       the keep set and a gate from the pass before it is not.
    */
    const keepGates = new Set<string>();
    if (generalGateId) keepGates.add(generalGateId);
    for (const c of built) {
      if (c.positiveGateId) keepGates.add(c.positiveGateId);
      if (c.negativeGateId) keepGates.add(c.negativeGateId);
    }
    useGates.getState().pruneReferenceGates(keepGates);

    // Open on the first control of the walk.
    const firstLayout = built[0]?.layoutId;
    if (firstLayout) usePlot.getState().switchLayout(firstLayout);

    return { built: built.length };
  },

  goToControl(index) {
    const { controls } = get();
    const clamped = Math.min(controls.length - 1, Math.max(0, index));
    const target = controls[clamped];
    if (!target) return;
    set({ walkIndex: clamped });
    // Switching the layout is what the tab bar, the walk arrows and the layout
    // dropdown all ultimately do, which is what makes them one control rather
    // than three: `controlIndexForLayout` reads the result back.
    if (target.layoutId) usePlot.getState().switchLayout(target.layoutId);
  },

  currentControlIndex() {
    return controlIndexForLayout(
      get().controls,
      usePlot.getState().activeLayoutId,
      get().walkIndex,
    );
  },

  walkBy(delta) {
    get().goToControl(get().currentControlIndex() + delta);
  },

  unlinkGeneralGate(sampleId) {
    const id = get().generalGateId;
    if (!id) return;
    const gates = useGates.getState();

    /*
       Two things, and the second is what makes the button honest.

       `linked: false` is a property of the **gate**, not of a sample's copy of
       it — it says "this gate's boundary may differ per sample", globally. So
       flipping it alone marks every control as unlinked while none of them
       actually has a boundary of its own, and the panel would report nine
       controls as specific after one click.

       Seeding this control's override from the shape it is showing right now is
       what makes it specific in fact rather than in principle. The user then
       drags from where the gate already was, which is also the only sensible
       starting point.
    */
    gates.setGateLinked(sampleId, id, false);
    const current = useGates.getState().gatesFor(sampleId).find((g) => g.id === id);
    if (current) useGates.getState().updateGate(sampleId, id, { ...current, linked: false });
    set({ computedAt: null });
  },

  relinkGeneralGate(sampleId) {
    const id = get().generalGateId;
    if (!id) return;
    // This control's own boundary only. `setGateLinked(true)` would discard
    // every *other* control's as well — see `clearGateOverride`.
    useGates.getState().clearGateOverride(sampleId, id);
    set({ computedAt: null });
  },

  setControlGate(sampleId, gateId, origin = 'user') {
    record('Set control gate');
    const control = get().controls.find((c) => c.sampleId === sampleId);
    set((s) => ({
      controls: s.controls.map((c) =>
        c.sampleId === sampleId ? { ...c, positiveGateId: gateId, gateOrigin: gateId ? origin : null } : c),
      // The panel is stale the moment its inputs change; recomputing is explicit.
      computedAt: null,
    }));
    /*
       The spectrum plot follows, and it has to.

       That plot is the check on what the gate selected — a signature peaking in
       the wrong laser block is visible there and nowhere else until the matrix
       has already been computed — so a population chosen here and a population
       plotted there being two different things would defeat the one plot that
       could have caught it. `generalGateId` is the fallback for the same reason
       `panelsForControl` uses it: "no population chosen" means the whole gated
       control.
    */
    if (control?.layoutId) {
      rescopeSpectrumPanel(
        control.layoutId,
        sampleId,
        gateId ?? get().generalGateId,
        control.reference === 'self' ? control.negativeGateId : null,
      );
    }
  },

  autoGateControl(sample) {
    const control = get().controls.find((c) => c.sampleId === sample.id);
    if (!control) return null;
    // Keyed so a whole pass — which calls this once per control — comes back in
    // one press of Ctrl+Z rather than eleven.
    record('Auto-gate control', 'auto-gate');
    const seeded = seedGates(sample, control, get().generalGateId);
    set((s) => ({
      controls: s.controls.map((c) => (c.sampleId === sample.id ? seeded : c)),
      computedAt: null,
    }));
    return seeded.positiveGateId;
  },

  ensureGated(samples) {
    /*
       Item 7, and the reason there is no button here any more.

       Auto-gating was two opt-in actions — *Re-seed this control's gate* and
       *Auto-gate anything ungated* — and neither had a reason to be one. There
       is no state in which the operator wants a control's positive population
       left ungated: they want it correct, and correcting a seeded gate is
       strictly less work than drawing one. So it simply happens, on arrival at
       Step 3 and on every move of the walk, for any control that has no gate.

       **Only for a control that has none.** A gate the user has dragged is the
       answer to this question, and re-seeding it would be the app overwriting
       the work the step exists to collect.

       ## Naming a gate is not the same as having one (2026-08-13)

       The other half of the duplicate-gate investigation, and the direction the
       build's reconciliation cannot cover: an assignment outliving the gate it
       points at. Deleting a bracket from the tree is an ordinary gesture — it is
       what somebody reaches for on seeing two of them — and it leaves the id on
       the assignment, where `controlIsGated` reads it and reports the control as
       done. Step 4 then refuses it with *"has no events in its positive gate"*
       about a gate that is not there, next to a tree the user can see a bracket
       in.

       So the ids are checked against the strategy before they are believed. A
       stain is re-seeded, which is exactly what the paragraph above promises for
       a control with no gate; a baseline is only cleared, because its gate is
       offered rather than required and "measure the whole gated population" is
       what having none means.
    */
    const byId = new Map(samples.map((s) => [s.id, s]));

    /** The assignment with any id the strategy no longer holds dropped. */
    const believable = (c: ControlAssignment): ControlAssignment => {
      const gates = useGates.getState().gatesFor(c.sampleId);
      const held = (id: string | null) => (id && gates.some((g) => g.id === id) ? id : null);
      const positiveGateId = held(c.positiveGateId);
      const negativeGateId = held(c.negativeGateId);
      if (positiveGateId === c.positiveGateId && negativeGateId === c.negativeGateId) return c;
      return {
        ...c,
        positiveGateId,
        negativeGateId,
        // Nothing seeded it and nobody chose it, because it is not there.
        gateOrigin: positiveGateId ? c.gateOrigin : null,
      };
    };

    const current = get().controls;
    const checked = current.map((c) => (byId.has(c.sampleId) ? believable(c) : c));
    // `believable` returns its input by identity when it changed nothing, so
    // this is the whole test for "some assignment named a gate that is gone".
    const dangling = checked.some((c, i) => c !== current[i]);
    const pending = checked.filter((c) => !controlIsGated(c) && byId.has(c.sampleId));
    if (pending.length === 0 && !dangling) return 0;

    record('Auto-gate controls', 'auto-gate');
    const nextById = new Map(checked.map((c) => [c.sampleId, c]));
    let n = 0;
    for (const c of pending) {
      const seeded = seedGates(byId.get(c.sampleId)!, c, get().generalGateId);
      if (seeded.positiveGateId !== c.positiveGateId || seeded.negativeGateId !== c.negativeGateId) n++;
      nextById.set(c.sampleId, seeded);
    }
    set((s) => ({
      controls: s.controls.map((c) => nextById.get(c.sampleId) ?? c),
      // A gate that has gone changes the population a signature is measured
      // over just as much as a gate that has arrived, so the panel is stale
      // either way.
      computedAt: n > 0 || dangling ? null : s.computedAt,
    }));
    return n;
  },

  /* ---------------------------------------------------------------------
     Navigation
     --------------------------------------------------------------------- */

  setTab(tab) { set({ tab }); },
  setStep(step) { set({ step }); },

  stepCheck() {
    const { step, selectedIds, controls } = get();
    return checkStep(step, selectedIds, controls);
  },

  next(samples) {
    const { step } = get();
    if (!get().stepCheck().ok) return;

    // Each step does its own work on the way out rather than on the way in, so
    // the arriving screen is already correct — a Step 3 that built its layouts
    // in an effect after mounting would flash an empty worksheet first.
    if (step === 1) get().syncControls(samples);
    if (step === 2) get().buildGatingLayouts(samples);

    set({ step: Math.min(LAST_STEP, step + 1) as WizardStep });
  },

  back() { set((s) => ({ step: Math.max(1, s.step - 1) as WizardStep })); },

  resetWizard() {
    // The undo label is read in the Edit menu, where there is no panel heading
    // to say which setup was reset. It follows the matrix for the same reason
    // the extension does.
    record(get().kind === 'compensation' ? 'Reset compensation setup' : 'Reset unmixing setup');
    /*
       Deliberately leaves gates and worksheets in place. They are analysis —
       somebody drew them — and a wizard that deleted a morning's gating because
       the user wanted to re-pick a control would be unforgivable. The worksheets
       are named and remain switchable from the layout dropdown.

       **In place until the next build, which is a narrower claim than it was.**
       Two reconciliations run when Step 2 is left, and both read the setup as it
       then stands: reference worksheets with no control are removed (2026-08-12,
       Item 8) and so are the wizard's own gates (2026-08-13). So starting over
       and walking the wizard again does clear what the previous setup left — and
       that is the point of both, since "start over" is exactly the statement
       that the previous setup no longer describes anything. What neither touches
       is a gate the operator drew or a layout the operator made; those are not
       the wizard's, and this sentence is the whole of what the paragraph above
       was ever promising.
    */
    //
    // `tab` goes back to the wizard with it: this action *is* the wizard's, and
    // leaving it on the other tab would put the panel on a screen with no
    // visible sign anything had happened.
    set({ tab: 'new', step: 1, selectedIds: [], controls: [], walkIndex: 0 });
  },

  readiness() {
    const { controls } = get();
    const stains = controls.filter((c) => c.role === 'stain');
    return {
      ready: stains.length > 0 && stains.every(controlIsGated),
      ungated: stains.filter((c) => !controlIsGated(c)).map((c) => c.label),
      hasUnstained: controls.some((c) => c.role === 'unstained' || c.role === 'autofluorescence'),
      stainCount: stains.length,
    };
  },

  computeMatrix(samples) {
    const { controls, generalGateId } = get();
    const check = get().readiness();
    if (!check.ready) {
      return {
        ok: false,
        message: check.stainCount === 0
          ? 'Assign at least one single-stain control.'
          : `Still ungated: ${check.ungated.join(', ')}.`,
      };
    }

    /*
       **Which model gets built is a question about the controls, not a mode.**

       There is no platform switch anywhere in this application, and there is
       deliberately no dialogue on launch asking what kind of cytometer you own.
       A conventional file and a spectral file are different in ways the file
       itself states — thirteen filtered detectors against sixty-four array
       positions — and `detectAcquisitionType` has answered that question at
       import since long before compensation existed, with a per-sample override
       on the sample browser for the case it gets wrong.

       So: controls that all came off a conventional instrument build a square
       spillover matrix; anything else builds a spectral one. **Every**, not
       *some*, because a mixed set is not a conventional panel — a matrix over
       the primary detectors of eleven dyes cannot describe a sixty-four
       detector control, and the general solve is the one that can describe
       both.
    */
    const resolved = controls
      .map((c) => samples.find((s) => s.id === c.sampleId))
      .filter((s): s is Sample => !!s);
    if (resolved.length > 0 && resolved.every((s) => acquisitionTypeOf(s) === 'conventional')) {
      const built = compensationFrom(controls, samples, generalGateId);
      if (!built.ok) return built;
      set({
        spectra: built.spectra,
        detectorNames: built.detectorNames,
        // See `weights`: a square system has no residual to weight.
        weights: null,
        kind: 'compensation',
        previewIds: built.spectra.map((s) => s.id),
        computedAt: new Date().toISOString(),
        loadedFrom: null,
      });
      return { ok: true };
    }

    const spectra: ReferenceSpectrum[] = [];
    let weights: Float64Array | null = null;

    /*
       **One background signature, however many background tubes there are.**

       A panel routinely carries both an *Unstained* tube and a dedicated
       *Autofluorescence* tube, and until 2026-08-16 both became rows of S. They
       are two measurements of the same spectrum — their cosine similarity is
       essentially 1 — so the matrix was rank-deficient by construction: it
       became ill-conditioned and the two background abundances came out orders
       of magnitude larger than any real signal. The pseudo-inverse does not throw for this; it splits the shared
       direction between the two rows and amplifies the noise in everything
       measured against them.

       The tube whose role is explicitly `autofluorescence` wins, because that
       role *is* the statement "this file is the autofluorescence reference".
       Nothing is discarded: the unstained tube still supplies the WLS weights
       below, and it is still the baseline every stain's peak detector is
       measured against in `baselineProfile`. What it no longer does is claim to
       be a second, independent fluorophore.
    */
    const backgrounds = controls.filter((c) => c.role === 'unstained' || c.role === 'autofluorescence');
    const signingBackground = backgrounds.find((c) => c.role === 'autofluorescence') ?? backgrounds[0] ?? null;

    for (const c of controls) {
      const sample = samples.find((s) => s.id === c.sampleId);
      if (!sample) continue;
      const dets = detectorIndices(sample.parsed.metadata);
      if (dets.length === 0) continue;
      const n = sample.parsed.metadata.eventCount;

      if (c.role === 'unstained' || c.role === 'autofluorescence') {
        /*
           The general gate, unless this control has been refined further.

           There is no *positive* population on an unstained tube — nothing is
           stained — so the default is the same cells/singlets gate every other
           control uses. What changed on 2026-08-08 is that the default stopped
           being the only answer: an unstained worksheet now carries a histogram
           like every other, and a gate drawn on it (dead cells out, debris out)
           is a better population to measure autofluorescence over than the
           whole general-gated one. `positiveGateId` is where that choice lands,
           which is why the field is read here rather than skipped for baselines.
        */
        const within = c.positiveGateId
          ? gatedEventsFor(sample, c.positiveGateId)
          : generalGateEvents(sample, generalGateId);
        if (c.positiveGateId && (!within || within.length === 0)) {
          return { ok: false, message: `“${c.label}” has no events in its refining gate.` };
        }
        if (c === signingBackground) {
          const af = extractAutofluorescence(sample.parsed.data, n, dets, within ?? undefined);
          spectra.push({
            id: sample.id, label: c.label, values: af.values,
            isAutofluorescence: true, sourceSampleId: sample.id, eventCount: af.eventsUsed,
            source: within ? 'gated' : 'percentile', gateId: c.positiveGateId,
          });
        }
        // The unstained tube is also the right source for WLS weights: they
        // describe per-detector noise, which is what an unstained sample is a
        // measurement of. An autofluorescence-only panel supplies them too, and
        // a tube that did not become the background signature still supplies
        // these — measuring noise is a job for every background file there is.
        weights = detectorWeights(sample.parsed.data, n, dets);
        continue;
      }

      const events = gatedEventsFor(sample, c.positiveGateId);
      if (!events || events.length === 0) {
        return { ok: false, message: `“${c.label}” has no events in its positive gate.` };
      }
      const sig = extractGatedSignature(sample.parsed.data, n, dets, events);
      /*
         A self-referencing control's own negative population is subtracted here.

         This is the whole of what `reference: 'self'` means at the maths. A bead
         control's positive population sits on top of the same background its
         negative population is made of, so the raw positive median describes the
         dye *plus* the bead; the difference is the dye. A `reference: 'unstained'`
         control needs no subtraction here because the panel already carries the
         unstained tube as its own autofluorescence signature, and the unmixing
         solves for it.

         **`raw`, not `values`, and that is the entire correctness of it.** Both
         spectra are peak-normalised when they arrive, and a bead's negative
         population is 100–230× dimmer than its positive one — so subtracting the
         normalised negative subtracted the background at roughly two hundred
         times its real amplitude, and `Math.max(0, …)` then quietly flattened
         most of the detectors to exactly zero. The signatures still looked
         plausible and still peaked in the right channel, but the residual error
         moved one dye's signal into another's abundance. Subtracting in channel
         units reproduces an independent reference matrix.
      */
      let values = sig.values;
      if (c.reference === 'self' && c.negativeGateId) {
        const negEvents = gatedEventsFor(sample, c.negativeGateId);
        if (!negEvents || negEvents.length === 0) {
          return { ok: false, message: `“${c.label}” has no events in its negative gate.` };
        }
        const neg = extractGatedSignature(sample.parsed.data, n, dets, negEvents);
        const diff = new Float64Array(sig.raw.length);
        for (let i = 0; i < diff.length; i++) diff[i] = Math.max(0, sig.raw[i]! - neg.raw[i]!);
        values = normaliseSignature(diff);
      }
      spectra.push({
        id: sample.id, label: c.label, values,
        isAutofluorescence: false, sourceSampleId: sample.id, eventCount: sig.eventsUsed,
        source: 'gated', gateId: c.positiveGateId,
      });
    }

    if (spectra.length === 0) return { ok: false, message: 'No control produced a usable signature.' };

    // The detector names come from a file that actually contributed a signature,
    // for the reason `captureUnmixingMatrix` states: whatever is selected in the
    // sidebar may not even be a spectral file.
    const named = samples.find((s) => spectra.some((x) => x.sourceSampleId === s.id));
    const detectorNames = named
      ? detectorIndices(named.parsed.metadata).map((d) => named.parsed.metadata.parameters[d]?.name ?? `#${d}`)
      : [];

    spectra.sort((a, b) => Number(a.isAutofluorescence) - Number(b.isAutofluorescence));
    set({
      spectra,
      detectorNames,
      weights,
      kind: 'unmixing',
      /*
         Every signature visible, not the first four.

         The viewer opened with four of thirteen lines drawn and nine
         checkboxes to find and tick, which inverts what the plot is for: the
         question it answers is "do any two of these have the same shape", and
         that is a question about the panel rather than about a subset somebody
         has already chosen. Narrowing afterwards is a click; discovering that
         the plot was hiding most of the panel is not.
      */
      previewIds: spectra.map((s) => s.id),
      computedAt: new Date().toISOString(),
      // Computed here, from these controls — no longer whatever file was loaded.
      loadedFrom: null,
    });
    return { ok: true };
  },

  useFileMatrix(sample) {
    const md = sample.parsed.metadata;
    const matrix = matrixFromFile(md);
    if (!matrix) {
      return {
        ok: false,
        message: md.spillover
          ? 'The matrix in this file is the identity — the acquisition software had nothing to correct.'
          : 'This file carries no spillover matrix. Build one from single-stain controls instead.',
      };
    }
    try {
      const labels = compensationLabels(md, matrix);
      const setup = compensationSetup(md, matrix, labels);
      record('Use the acquisition matrix');
      set({
        spectra: setup.spectra,
        detectorNames: setup.detectorNames,
        weights: null,
        kind: 'compensation',
        previewIds: setup.spectra.map((s) => s.id),
        computedAt: new Date().toISOString(),
        /*
           It came from somewhere, and saying where is the point.

           `loadedFrom` is what the panel reads to caption a matrix it did not
           build, and a matrix out of a file is exactly that — it names the tube
           it was read from rather than a path, because the file is in the
           workspace rather than on disk beside it.
        */
        loadedFrom: {
          path: null,
          name: `${sample.name} · acquisition matrix`,
          savedAt: md.acquiredAt ? md.acquiredAt.toISOString() : new Date().toISOString(),
        },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof CompensationError ? e.message : String(e) };
    }
  },
}));

/*
   The wizard belongs to the sample set; the matrix does not.

   When the last sample is removed, every field below names a file that has gone:
   the ticked ids, the control assignments, the layouts they generated, the
   general gate the gate store has just dropped, and the per-sample unmixing
   results. Leaving them meant the next import arrived at a Step 3 walk over
   controls that no longer existed, with `controlIsGated` reading gate ids from a
   hierarchy that had been cleared.

   **`spectra`, `weights`, `computedAt` and `loadedFrom` deliberately stay.** A
   matrix is a property of an *instrument configuration*, not of one afternoon's
   files — that is the entire reason it is a portable file of its own, and
   loading one into an empty workspace is a supported first action. Throwing it
   away because the samples it will be applied to have not been imported yet
   would be the same mistake in the other direction.

   `previewIds` stays with them, since it names signatures rather than samples.
*/
onWorkspaceCleared(() => {
  useSpectral.setState({
    selectedIds: [],
    controls: [],
    step: 1,
    walkIndex: 0,
    generalGateId: null,
    assignWidths: {},
    unmixed: {},
    failures: [],
    running: { active: false, done: 0, total: 0, current: null },
  });
});

/** Cached similarity matrix for the current panel. */
export function currentSimilarity(): Float64Array {
  return similarityMatrix(useSpectral.getState().spectra);
}

/* -------------------------------------------------------------------------
   Building a control's gating layout
   ------------------------------------------------------------------------- */

/**
 * The unstained control's per-detector brightness, or null.
 *
 * Null is the bead case and it is a real answer rather than a missing one: a
 * panel with no unstained tube has no autofluorescence background to subtract,
 * and a bead's brightest channel *is* its dye's.
 *
 * Measured over the whole file rather than inside the general gate, because it
 * is wanted before any gate exists — `buildGatingLayouts` chooses the peaks
 * first and gates second, so that the histogram it builds is already on the
 * right channel.
 */
function baselineProfile(
  controls: readonly ControlAssignment[],
  byId: Map<string, Sample>,
): Float64Array | null {
  const base = controls.find((c) => c.role === 'unstained')
    ?? controls.find((c) => c.role === 'autofluorescence');
  const sample = base ? byId.get(base.sampleId) : undefined;
  if (!sample) return null;
  const dets = detectorIndices(sample.parsed.metadata);
  if (dets.length === 0) return null;
  return detectorBrightness(sample.parsed.data, sample.parsed.metadata.eventCount, dets);
}

/**
 * Measure the peak detector for every control still holding a suggestion.
 *
 * One helper, called from Step 2 and again from the build, because the alternative
 * is what this replaced: `syncControls` measured each row as it created it and
 * the build measured them all again with a different rule, so the Assign table
 * showed one detector and every plot in Step 3 used another. A column that is
 * quietly overruled by the next step is worse than no column.
 *
 * It has to run over the **completed** set rather than per row, because a stain's
 * peak is measured against the unstained control and which control that is is not
 * known until the last row has a role. A detector chosen from the dropdown is a
 * statement and is never re-measured; a baseline control is not measured against
 * itself, since subtracting the unstained profile from the unstained control
 * leaves noise and the argmax of noise is arbitrary.
 */
function remeasurePeaks(
  controls: readonly ControlAssignment[],
  byId: Map<string, Sample>,
): ControlAssignment[] {
  const baseline = baselineProfile(controls, byId);
  return controls.map((c) => {
    if (c.peakSource === 'user') return c;
    const sample = byId.get(c.sampleId);
    if (!sample) return c;
    const m = measurePeak(sample, null, c.role === 'stain' ? baseline : null);
    return m ? { ...c, peak: m.peak } : c;
  });
}

/**
 * Seed a control's gates and return the assignment they belong to.
 *
 * Writes to the gate store and returns the updated `ControlAssignment` rather
 * than touching the spectral store, so the two callers — the build, which is
 * mid-way through a batch and sets `controls` once at the end, and `ensureGated`,
 * which is topping up — do not need two versions of the same rule.
 *
 * A control that already has everything its reference mode requires is returned
 * untouched. That is the whole of what stops a walk re-seeding over a gate
 * somebody has dragged.
 */
function seedGates(
  sample: Sample,
  control: ControlAssignment,
  generalGateId: string | null,
  opts: { baselines?: boolean } = {},
): ControlAssignment {
  if (control.role !== 'stain') {
    return opts.baselines ? seedBaselineGate(sample, control, generalGateId) : control;
  }
  if (controlIsGated(control)) return control;

  // Seeded inside the general gate when there is one, so the gate respects
  // the same debris exclusion everything else does — and so the peak channel is
  // refined against the gated population rather than the raw file.
  const within = generalGateEvents(sample, generalGateId);
  const parentId = within ? generalGateId : null;

  /*
     The channel is taken, not re-decided, and that is a correctness fix rather
     than a tidy-up.

     This used to call `measurePeak` again and overwrite `control.peak` with the
     answer. Two rules for one question, and the second one had less information:
     `buildGatingLayouts` chooses the peak against the unstained control's own
     background — which is what puts a far-red dye on a far-red detector — and
     this call had no baseline, so it silently put CCR7 APC-Fire 810, CD28 Alexa
     Fluor 700, LiveDead and NKG2A back on UV7-A a moment after the right answer
     had been worked out. Every plot in the layout then agreed with each other
     and with nothing else.

     One place chooses the channel; this one only thresholds it.
  */
  const peak = control.peak ?? measurePeak(sample, within)?.peak ?? null;
  if (!peak) return control;

  /*
     Two bounds with a gap between them, not one shared cut — see `bracketOn`,
     which also explains why they come back already in **display space**.

     That part matters and has cost a fix before: gates are stored in the
     coordinates the user drew in, and writing a raw channel value straight into
     one compares 29 687 against a scale running 0…1, so the seeded gate captures
     nothing and the panel it seeds can never be computed.
  */
  const spec = defaultSpecFor(sample.parsed, peak.parameterIndex);
  const bracket = bracketOn(sample, peak.parameterIndex, within);
  if (bracket === null) return control;
  const min = bracket.positiveMin;
  const negativeMax = bracket.negativeMax;

  const gates = useGates.getState().gatesFor(sample.id);
  let positiveGateId = control.positiveGateId;
  let negativeGateId = control.negativeGateId;

  if (!positiveGateId) {
    // A range gate on the peak detector: one dimensional, because the threshold
    // is one dimensional. Drawing a rectangle would invent a second bound the
    // heuristic never computed and imply a precision it does not have.
    const positive: Gate = {
      id: nextGateId(),
      name: `${control.label} +`,
      parentId,
      colorIndex: gates.length,
      kind: 'range',
      xParam: peak.parameterIndex,
      xSpec: spec,
      /*
         This gate exists on this control's file and nowhere else.

         Two single stains routinely share a peak detector — two dyes with the
         same emission maximum is ordinary panel design, not a mistake — and a
         panel draws every range gate that sits on its x parameter. So without
         an owner, CD8 PerCP-eFluor 710's worksheet drew CD27 RB705's gate
         too, labelled and with a percentage, over CD8's histogram: two gates on
         one plot, one of them measuring a population nobody had asked about.
         The number was arithmetically right and referred to nothing.

         Marking the owner fixes it at the source rather than at the renderer —
         `resolveGates` filters, so evaluation, the tree, the statistics table
         and the export all agree that this population belongs to one file.
      */
      ownerSampleId: sample.id,
      // Setup, not analysis: kept out of general layouts, Statistics and
      // Export (2026-08-12, Item 11). See `withoutReferenceGates`.
      reference: true,
      min,
      max: Number.POSITIVE_INFINITY,
    };
    useGates.getState().addGate(sample.id, positive);
    positiveGateId = positive.id;
  }

  /*
     A self-referencing control also gets its negative gate here, on the same
     histogram.

     Beads carry both populations in one tube, so the negative is a real
     population on this file and needs a real gate. It ends at the **median of
     the negatives**, not at the positive gate's floor — the two used to meet,
     which put the dim half of the positive population inside the negative
     reference. See `bracketOn`. `-Infinity` below it, rather than inventing a
     lower bound the heuristic never computed.
  */
  if (control.reference === 'self' && !negativeGateId) {
    const negative: Gate = {
      id: nextGateId(),
      name: `${control.label} −`,
      parentId,
      colorIndex: gates.length + 1,
      kind: 'range',
      xParam: peak.parameterIndex,
      xSpec: spec,
      // Same file, same reason as the positive gate above.
      ownerSampleId: sample.id,
      reference: true,
      min: Number.NEGATIVE_INFINITY,
      max: negativeMax,
    };
    useGates.getState().addGate(sample.id, negative);
    negativeGateId = negative.id;
  }

  return { ...control, peak, positiveGateId, negativeGateId, gateOrigin: 'auto' };
}

/**
 * Coverage the seeded baseline gate encloses.
 *
 * 0.98, and the two ends of the range are both wrong for a reason. Lower — say
 * the 0.80 the scatter contour uses — would cut into the population itself: a
 * scatter plot's periphery is debris, but the tails of an unstained control's
 * distribution in its brightest channel are the same cells as the middle. Higher
 * than about 0.99 and the gate encloses everything, which is a gate that does
 * nothing and merely has to be deleted.
 */
const BASELINE_COVERAGE = 0.98;

/**
 * Seed a single **clean population** gate on an unstained or autofluorescence
 * worksheet (2026-08-09).
 *
 * These two roles arrived at Step 3 with a histogram and no gate on it, where
 * every single stain arrived with one. That is defensible — a baseline has no
 * positive population, and `controlIsGated` says so, which is why the step never
 * demanded one — but "nothing is required" and "nothing is offered" are
 * different things, and the second left the operator drawing from scratch on
 * exactly the tube whose debris and dead cells most want excluding: the
 * autofluorescence signature is measured over this population, and it goes into
 * the matrix.
 *
 * **A single interval, not a positive/negative split.** A stain's seed is a
 * threshold with everything above it, because a stain has a positive population
 * by definition; nothing on an unstained tube is stained, so bracketing it in
 * two would draw a boundary through one distribution and label the halves as
 * though they meant something. What this places is the main body of the
 * distribution with the sparse tails outside — see `densityInterval` for how the
 * bounds are found and why a plain percentile interval is not good enough.
 *
 * The gate is `positiveGateId`, which is the field the *Signature population*
 * picker binds to and the field `computeMatrix` reads for a baseline. So the
 * choice is stated on screen the moment it is made, in a dropdown that also
 * offers the whole gated sample — and it is an ordinary draggable range gate,
 * belonging to this file alone like every other seeded gate.
 *
 * Returned untouched when the control already has one, which is what stops a
 * revisit overwriting a gate somebody has moved.
 */
function seedBaselineGate(
  sample: Sample,
  control: ControlAssignment,
  generalGateId: string | null,
): ControlAssignment {
  if (control.positiveGateId) return control;
  const peak = control.peak;
  if (!peak) return control;

  const within = generalGateEvents(sample, generalGateId);
  const parentId = within ? generalGateId : null;

  // In display space, because that is what a gate stores and what the histogram
  // draws — the same reasoning as the threshold conversion in `seedGates`, and
  // the same spec, so the interval lands where the plot shows it.
  const spec = defaultSpecFor(sample.parsed, peak.parameterIndex);
  const tf = createTransform(spec);
  const n = sample.parsed.metadata.eventCount;
  const raw = sample.parsed.data.subarray(peak.parameterIndex * n, (peak.parameterIndex + 1) * n);
  const display = new Float32Array(n);
  for (let i = 0; i < n; i++) display[i] = tf.forward(raw[i]!);

  let lo = Infinity;
  let hi = -Infinity;
  const visit = (i: number) => {
    const v = display[i]!;
    if (!Number.isFinite(v)) return;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  if (within) for (let i = 0; i < within.length; i++) visit(within[i]!);
  else for (let i = 0; i < n; i++) visit(i);
  if (!Number.isFinite(lo) || !(hi > lo)) return control;

  const iv = densityInterval(display, {
    min: lo, max: hi, coverage: BASELINE_COVERAGE, subset: within,
  });
  if (!iv) return control;

  const gates = useGates.getState().gatesFor(sample.id);
  const gate: Gate = {
    id: nextGateId(),
    name: `${control.label} clean`,
    parentId,
    colorIndex: gates.length,
    kind: 'range',
    xParam: peak.parameterIndex,
    xSpec: spec,
    // This control's file and nowhere else, for the reason every seeded gate
    // carries an owner: two controls can peak in the same detector.
    ownerSampleId: sample.id,
    reference: true,
    min: iv.min,
    max: iv.max,
  };
  useGates.getState().addGate(sample.id, gate);
  return { ...control, positiveGateId: gate.id, gateOrigin: 'auto' };
}

/**
 * The positive-population threshold on one *named* detector, in raw units.
 *
 * `autoGateBound` picks the brightest channel and thresholds it in one pass,
 * which is right when nobody has said which channel to use. When somebody has,
 * the choice has to be honoured and only the threshold recomputed — so this runs
 * the same percentile rule against the one channel it was given.
 */
function thresholdOn(sample: Sample, parameterIndex: number, within?: Uint32Array | null): number | null {
  const bound = autoGateBound(
    sample.parsed.data,
    sample.parsed.metadata.eventCount,
    [parameterIndex],
    { eventSubset: within ?? undefined },
  );
  return bound ? bound.threshold : null;
}

/** Events sampled when bracketing a control's two populations. See `bracketOn`. */
const BRACKET_SAMPLE_CAP = 200_000;
/** Bins the peak channel is split on. Same count and reasoning as `DEFAULT_BINS`. */
const BRACKET_BINS = 256;

/**
 * Where a single stain's **negative** population ends and its **positive** one
 * begins — as two separate bounds, in **display space**, with a gap between them.
 *
 * ## What was wrong (2026-08-15)
 *
 * The seeded pair used to meet at one number: `autoGateBound`'s percentile, with
 * the positive gate running from it to `+∞` and the negative from `−∞` to the
 * same value. Two separate faults, and both were reported as *"automatic gating
 * is horrible"*.
 *
 * **The split point was a fixed percentile of the whole tube**
 * (`DEFAULT_POSITIVE_FRACTION`, the top 20%), which is a guess about how much of
 * the tube is stained rather than a reading of where the two populations
 * actually divide. On a control where the dye takes half the events it lands in
 * the middle of the positive peak — which is exactly the reported symptom, a
 * positive gate holding about half the positive population. On a control where
 * the dye takes 8% it lands *inside the negative population*, and the positive
 * gate then holds mostly negatives. The percentile is never right except by
 * coincidence, because the quantity it is estimating is not a property of the
 * instrument.
 *
 * **And the two bounds were the same number**, so every event was in exactly one
 * of them: the negative reference contained the dim half of the positive
 * population, which is the one thing a negative reference must not contain, and
 * there was nowhere for the events the rule is least sure about to sit in
 * neither gate.
 *
 * ## The rule
 *
 * 1. **Find the split from the shape of the distribution.** Fit two Gaussians to
 *    the peak channel and take the Bayes decision boundary between them — the
 *    point where an event is as likely to have come from one as the other, which
 *    is a valley in the histogram rather than a quantile of it. `core/biophysics/
 *    mixture.ts` is exactly this calculation and is pure, generic 1-D numerics;
 *    a second implementation here would be a way for two parts of the same
 *    application to disagree about where a population divides.
 * 2. **Take the outer half of each side.** The negative gate ends at the median
 *    of the events below the split, the positive gate starts at the median of
 *    those above it. Each reference is then drawn from the half of its own
 *    population furthest from the boundary — the part there is no argument
 *    about — and the events *between* the two medians are in neither gate.
 *
 * Medians rather than another percentile, because the quantity wanted is
 * literally *half of this population* and a median is that by definition,
 * whatever shape the population turns out to be.
 *
 * **In display space throughout**, which is not a convenience: a fluorescence
 * channel is bimodal on a logicle axis and unimodal-with-a-tail on a linear one,
 * so a mixture fitted in raw units would be fitting the wrong picture. It is
 * also the space the gate is stored in, so nothing is converted afterwards.
 *
 * ## When it declines
 *
 * `rejectionFor` is the same admissibility rule the Biophysics fit uses, and if
 * the two components are closer than `MIN_SEPARATION` pooled SDs or one holds
 * under `MIN_COMPONENT_WEIGHT` of the events, there is **no resolved positive
 * population here** — a dim stain, or a control that did not work. The fallback
 * is the old percentile, for both bounds, which puts the operator back where
 * they were rather than seeding a confident-looking gate around a split the data
 * does not support. Both gates are ordinary range gates either way, and dragging
 * one no longer moves the other.
 */
function bracketOn(
  sample: Sample,
  parameterIndex: number,
  within?: Uint32Array | null,
): { negativeMax: number; positiveMin: number } | null {
  const n = sample.parsed.metadata.eventCount;
  const total = within ? within.length : n;
  if (total === 0) return null;

  const spec = defaultSpecFor(sample.parsed, parameterIndex);
  // The transform, not a destructured `forward`: `Logicle.forward` reads
  // `this.p`, so pulling the method off the object strips its lookup table.
  const tf = createTransform(spec);
  const base = parameterIndex * n;

  // Sampled, like every other whole-control pass in this file: a median over
  // 200 000 events and over 300 000 differ far below the width of a bin.
  const stride = Math.max(1, Math.floor(total / BRACKET_SAMPLE_CAP));
  const values = new Float32Array(Math.ceil(total / stride));
  let count = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < total; k += stride) {
    const i = within ? within[k]! : k;
    const v = tf.forward(sample.parsed.data[base + i]!);
    if (!Number.isFinite(v)) continue;
    values[count] = v;
    /*
       The extent is taken from the **stored** value, not from `v`.

       `tf.forward` returns a double and `values` is a `Float32Array`, so the
       write rounds. Reading `lo` off the double leaves it a hair *above* the
       float32 that is actually in the array, and `histogram` drops anything
       below its `min` rather than clamping it — so every event at the minimum
       fell outside the range. Measured on the fixture: 245 of 293 events
       silently vanished, leaving a one-population histogram, no split, and a
       fallback to the percentile the whole function exists to replace. The read
       costs nothing and is the only version of this that is correct.
    */
    const stored = values[count++]!;
    if (stored < lo) lo = stored;
    if (stored > hi) hi = stored;
  }
  if (count === 0) return null;

  /** The percentile rule, in display space — what this falls back to. */
  const percentile = (): { negativeMax: number; positiveMin: number } | null => {
    const raw = thresholdOn(sample, parameterIndex, within);
    if (raw === null) return null;
    const at = tf.forward(raw);
    return { negativeMax: at, positiveMin: at };
  };

  if (!(hi > lo)) return percentile();

  /*
     The range is opened by one bin at the top, because `histogram` **drops**
     values outside `[min, max)` rather than clamping them — deliberately, see
     its own note — and `max` itself is outside. Binning over the exact extent
     therefore throws away every event at the maximum, which on a control whose
     positive population saturates is the whole positive population, leaving a
     one-population histogram and a fit that correctly reports no split.
  */
  const h = histogram(values.subarray(0, count), {
    min: lo, max: hi + (hi - lo) / BRACKET_BINS, bins: BRACKET_BINS,
  });
  if (!h) return percentile();

  const fit = fitMixture(h, 2);
  if (rejectionFor(fit) || fit.boundaries.length !== 1) return percentile();
  const split = fit.boundaries[0]!;

  /*
     Both medians are read off the histogram, not by sorting the values.

     The answer agrees to within one bin — 1/256 of the channel's display range,
     which is finer than any gate placement this seeds — and it is the *same*
     binning the split was computed on, so the two numbers cannot disagree about
     where the boundary is. Sorting two arrays of up to 200 000 doubles per
     control, on a panel of thirteen, was the alternative.
  */
  const bins = h.counts.length;
  const splitBin = Math.min(bins, Math.max(0, Math.ceil((split - h.min) / h.width)));
  /** The bin the median of `[from, to)` falls in, or −1 if that range is empty. */
  const medianBin = (from: number, to: number): number => {
    let total = 0;
    for (let b = from; b < to; b++) total += h.counts[b]!;
    if (total === 0) return -1;
    let acc = 0;
    for (let b = from; b < to; b++) {
      acc += h.counts[b]!;
      if (acc * 2 >= total) return b;
    }
    return to - 1;
  };

  /*
     Each bound is the **outer edge** of its median bin, not the bin's centre.

     A gate should contain the whole bin its bound was computed from, and taking
     the centre cuts through it — which on a population narrower than one bin
     removes the population entirely. Measured on the fixture: a positive gate
     floored at the centre of the bin holding every positive event selected
     none of them. Biasing each bound away from the split is also the direction
     that keeps the pair from closing up.

     A side with nothing in it falls back to the split, which is the honest
     answer: an all-positive tube has no negative population to take the lower
     half of, and inventing a bound below the data would seed a gate around
     nothing. It cannot normally happen — an admissible two-component fit has
     events on both sides by construction — but the guard costs nothing.
  */
  const lowBin = medianBin(0, splitBin);
  const highBin = medianBin(splitBin, bins);
  return {
    negativeMax: lowBin < 0 ? split : h.min + (lowBin + 1) * h.width,
    positiveMin: highBin < 0 ? split : h.min + highBin * h.width,
  };
}

/**
 * A polygon traced around the scatter cloud, in display space.
 *
 * The general gate's starting shape, and the thing that replaced a percentile
 * **box** on 2026-08-07. The box took the 2nd-to-92nd percentile of each axis
 * *independently*, which is a rectangle around the population's bounding extent
 * rather than around the population: on real cell scatter it enclosed the debris
 * below the lymphocyte cloud and the saturated rim above it, because a debris
 * corner moves the low percentile on both axes at once. Everything the general
 * gate exists to exclude was inside it.
 *
 * The events are binned in **display space** — the same coordinates the plot
 * draws in and the same coordinates a gate stores — so the polygon that comes
 * back lands exactly on the cloud the user is looking at. Binning in raw units
 * and converting afterwards would put a linear grid over a logicle axis and
 * bunch the whole contour into the bottom decade.
 *
 * `null` when there is nothing to trace, which is a real state: a file with no
 * finite scatter has no cloud, and inventing a shape for it would be worse than
 * saying so.
 */
function scatterPolygon(sample: Sample, xParam: number, yParam: number): {
  vertices: { x: number; y: number }[];
  xSpec: ReturnType<typeof defaultSpecFor>;
  ySpec: ReturnType<typeof defaultSpecFor>;
} | null {
  const n = sample.parsed.metadata.eventCount;
  if (n === 0) return null;

  const xSpec = defaultSpecFor(sample.parsed, xParam);
  const ySpec = defaultSpecFor(sample.parsed, yParam);
  // Kept as the transform, not a destructured method — `Logicle.forward` reads
  // `this.p`, so pulling it off the object strips the lookup table it needs.
  const tx = createTransform(xSpec);
  const ty = createTransform(ySpec);

  const xRaw = sample.parsed.data.subarray(xParam * n, (xParam + 1) * n);
  const yRaw = sample.parsed.data.subarray(yParam * n, (yParam + 1) * n);

  // Sampled, for the same reason `scatterBounds` samples: the contour of 20 000
  // events and of 170 000 differ by less than a bin, and this runs once per
  // control while somebody waits.
  const stride = Math.max(1, Math.floor(n / 40000));
  const count = Math.ceil(n / stride);
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  let k = 0;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const xv = tx.forward(xRaw[i]!);
    const yv = ty.forward(yRaw[i]!);
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
    xs[k] = xv;
    ys[k] = yv;
    k++;
    if (xv < xMin) xMin = xv;
    if (xv > xMax) xMax = xv;
    if (yv < yMin) yMin = yv;
    if (yv > yMax) yMax = yv;
  }
  if (k === 0 || xMax <= xMin || yMax <= yMin) return null;

  const grid = bin2d(xs.subarray(0, k), ys.subarray(0, k), xMin, xMax, yMin, yMax, CONTOUR_BINS, CONTOUR_BINS);
  const cells = densityContour(grid, { coverage: GENERAL_GATE_COVERAGE, rays: GENERAL_GATE_RAYS });
  if (cells.length < 3) return null;

  return {
    vertices: contourToData(cells, grid, { xMin, xMax, yMin, yMax }),
    xSpec,
    ySpec,
  };
}

/**
 * A percentile box around the bulk of a scatter plot, in display space.
 *
 * The fallback for a file `scatterPolygon` cannot trace, and nothing else. See
 * the note there for why it stopped being the general gate's shape.
 */
function scatterBounds(sample: Sample, xParam: number, yParam: number) {
  const axis = (p: number) => {
    const spec = defaultSpecFor(sample.parsed, p);
    // Kept as the transform, not a destructured method — see the note in
    // `autoGateControl`. `Logicle.forward` reads `this`.
    const tf = createTransform(spec);
    const n = sample.parsed.metadata.eventCount;
    const col = sample.parsed.data.subarray(p * n, (p + 1) * n);
    // Sampled rather than sorted in full: a percentile of 170 000 events is the
    // same to three decimal places as a percentile of 20 000 of them, and this
    // runs once per control while the user is waiting.
    const stride = Math.max(1, Math.floor(n / 20000));
    const vals: number[] = [];
    for (let i = 0; i < n; i += stride) {
      const v = col[i]!;
      if (Number.isFinite(v)) vals.push(v);
    }
    vals.sort((a, b) => a - b);
    if (vals.length === 0) return { lo: 0, hi: 1 };
    const at = (q: number) => tf.forward(vals[Math.min(vals.length - 1, Math.floor(q * (vals.length - 1)))]!);
    return { lo: at(0.02), hi: at(0.92) };
  };
  const x = axis(xParam);
  const y = axis(yParam);
  return { xMin: x.lo, xMax: x.hi, yMin: y.lo, yMax: y.hi };
}

/**
 * Width of every panel in a generated control layout.
 *
 * One number for all three, because they are stacked and a column of plots that
 * do not share an edge reads as three unrelated figures. 430 is the smallest
 * width at which a panel keeps its full toolbar (`PANEL_COMPACT_BELOW`), which
 * matters here — these are the panels the operator changes an axis on.
 */
const CONTROL_PANEL_WIDTH = 430;

/**
 * The panels making up one control's gating layout.
 *
 * **Three, stacked, in the order the work happens** — scatter, then the peak
 * channel, then the full spectrum — which is the arrangement the reference
 * software uses and the one the coordinates are stated for. Letting
 * `placePanels` flow them would put the relationship between the three wherever
 * there happened to be room, and the relationship is the instruction.
 *
 *   1. **Scatter**, carrying the shared general gate as a traced polygon.
 *   2. **The peak detector as a histogram**, carrying the positive gate — and
 *      the negative gate too when the control references itself.
 *   3. **The full spectrum** of whatever is currently gated, which is the check
 *      that the gate above it selected the population it was meant to: a
 *      signature peaking in the wrong detector is visible here and nowhere else
 *      until the matrix has already been computed.
 *
 * **All three, for every role.** An unstained or autofluorescence worksheet used
 * to be two plots — scatter and spectrum — on the reasoning that a baseline has
 * no positive population to gate, which is true and was the wrong conclusion.
 * The histogram is not only there to hold a positive gate: it is where a
 * distribution is *looked at*, and an unstained tube is exactly the file whose
 * dead cells and debris somebody may want out of the autofluorescence signature.
 * So the plot is there and the gating tools work on it, with nothing seeded and
 * nothing required — the refinement is offered rather than demanded, which is
 * the difference between it and a single stain's gate. See `controlIsGated`.
 *
 * The separate *negative reference* panel that used to sit beside the histogram
 * is gone. For a self-referencing control the negative is a gate on this same
 * histogram, where it belongs — the two populations are in one distribution and
 * putting them on two plots hid the gap between them. For a control referencing
 * a separate unstained tube, the negative is that tube's own layout, one step
 * earlier in the same walk.
 */
function panelsForControl(
  sample: Sample,
  control: ControlAssignment,
  generalGateId: string | null,
) {
  const W = CONTROL_PANEL_WIDTH;
  const H = panelHeight(W) + PANEL_GAP;

  /* ---- 1. Scatter, with the general gate ---- */
  const general = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: null,
    x: 0, y: 0, w: W,
    xParam: scatterParam(sample, 'FSC'),
    yParam: scatterParam(sample, 'SSC'),
    // Same reason as the histogram below — and the same spec the traced polygon
    // was computed in, which is what makes it land on the cloud it was traced
    // around rather than somewhere reprojected.
    xTransform: defaultSpecFor(sample.parsed, scatterParam(sample, 'FSC')).kind,
    yTransform: defaultSpecFor(sample.parsed, scatterParam(sample, 'SSC')).kind,
    plotType: 'density',
    initialisedFor: sample.id,
  });

  /*
     The y parameter on a histogram panel, stated rather than left at the default.

     A histogram's y axis is normalised density and does not plot a parameter at
     all — but the panel still *labels* it from `yParam`, and `makePanel` defaults
     that to index 0, which on an Aurora file is **Time**. So a generated
     histogram came up captioned "Time" down its left edge. SSC-A instead: it is
     what the axis reads as, and it is also the sensible second axis if somebody
     switches the panel to a 2D plot, where peak-against-peak would be a diagonal.
  */
  const histY = scatterParam(sample, 'SSC');
  const peakParam = control.peak?.parameterIndex ?? scatterParam(sample, 'FSC');

  /* ---- 2. The peak detector, with this control's own gates ---- */
  const histogram = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: generalGateId,
    x: 0, y: H, w: W,
    xParam: peakParam,
    yParam: histY,
    /*
       Stated, not left to `makePanel`'s `linear` default.

       `initialisedFor` is set — these panels arrive configured rather than
       inferring their axes on mount — and that is exactly what stops
       `initialiseFor` picking the transform for them. A fluorescence
       detector on a linear axis puts every negative and the whole first
       decade into the leftmost pixel column, so the histogram came up as a
       spike at zero and a flat line, with the gate squeezed against the
       axis. It is also the spec the *gate* was created in, so stating it
       here is what keeps the picture and the count in the same space.
    */
    xTransform: defaultSpecFor(sample.parsed, peakParam).kind,
    yTransform: defaultSpecFor(sample.parsed, histY).kind,
    plotType: 'histogram',
    initialisedFor: sample.id,
  });

  /* ---- 3. The full spectrum of the gated population ---- */
  /*
     A self-referencing control gets **two**, side by side: negative on the left,
     positive on the right.

     The reason is that this control carries both references, and only one of
     them was being looked at. A bead tube's negative population *is* the panel's
     negative reference for that dye — it is subtracted, it decides where zero
     is, and a negative gate that has caught the dim edge of the positive
     population poisons the matrix in a way nothing downstream announces. One
     spectrum plot, wired to the positive gate, showed the half of the answer
     that was already the easiest to check.

     Both are live: they are ordinary panels scoped to ordinary gates, so
     dragging either gate on the histogram above redraws the spectrum under it,
     and the two can be compared as they move. Left is negative and right is
     positive because that is the order they sit in on the histogram above them.

     This is also why `seedGates` runs before the panels are made: a spectrum
     scoped to the general gate would show the whole control on every layout —
     the same picture for every stain in the panel, which is exactly the plot
     that cannot answer the question it is here to answer. A baseline control has
     nothing gated by default and its general-gate population *is* the answer,
     until somebody refines it — which `setControlGate` writes into the same
     field and mirrors onto this panel.
  */
  /*
     Both at full width, side by side, rather than two half-width plots.

     A spectrum panel carries sixty-four rotated detector labels along its
     bottom edge; at half of 430 they overlap into a grey band and the plot stops
     being readable, which would trade the fix for the thing it was fixing. The
     worksheet scrolls.
  */
  /*
     ---- Conventional panels stop here (2026-08-28) ----

     A spectrum plot draws a value per detector along an axis, and it reads as a
     spectrum because on this spectral instrument the detectors *are* one: 64
     array positions in wavelength order, so the shape of the line is the shape
     of the emission and two dyes are told apart by looking at it.

     Thirteen filter blocks on a conventional cytometer are not that. They are
     not contiguous, they are not ordered by wavelength across lasers, and the
     line joining them describes nothing — it invites reading a slope between
     `v-LP600 610/20-D-A` and `v-LP750 800/60-A-A` as if the gap meant something.
     The scatter and the peak histogram above are the two plots that answer the
     question a compensation control is gated to answer: where is the positive
     population, and does the gate hold it.

     Asked of `acquisitionTypeOf`, so it follows the same per-sample answer the
     rest of the application uses and honours the manual override.
  */
  if (acquisitionTypeOf(sample) === 'conventional') return [general, histogram];

  const showsNegative = control.reference === 'self' && !!control.negativeGateId;

  const positiveSpectrum = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: control.positiveGateId ?? generalGateId,
    x: showsNegative ? W + PANEL_GAP : 0,
    y: H * 2,
    w: W,
    xParam: peakParam,
    yParam: histY,
    plotType: 'spectrum',
    initialisedFor: sample.id,
  });

  if (!showsNegative) return [general, histogram, positiveSpectrum];

  const negativeSpectrum = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: control.negativeGateId,
    x: 0,
    y: H * 2,
    w: W,
    xParam: peakParam,
    yParam: histY,
    plotType: 'spectrum',
    initialisedFor: sample.id,
  });

  return [general, histogram, negativeSpectrum, positiveSpectrum];
}
