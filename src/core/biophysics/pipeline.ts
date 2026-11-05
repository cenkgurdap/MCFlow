/**
 * The rules behind the four-step Biophysics pipeline.
 *
 * Pure, and separated from the store for the reason every other pure module in
 * this project is: *"can this step be left yet"* is a question about a list of
 * records, and a question about a list should be answerable without a renderer,
 * a store, or a file on disk. What is left in `state/biophysicsStore` is the
 * state and the side effects — creating layouts, seeding gates, running the fit.
 *
 * The shape deliberately mirrors `core/unmixing/wizard.ts`: same `StepCheck`
 * with a blocking `reason` and non-blocking `advice`, same "which worksheet am I
 * on is read off `activeLayoutId`" rule, same walk. Two guided workflows that
 * behave differently in the small are two workflows to learn.
 *
 * ## The steps
 *
 * 1. **Cells** — a traced scatter gate per sample, placed automatically and
 *    adjustable. Named for what it encloses: intact events. Whether they are
 *    alive is Step 4's answer, not this one's.
 * 2. **Property** — which biophysical property, and which probe measured it.
 *    Creates the derived parameter if the workspace has not got it.
 * 3. **Distribution** — the property's histogram on the gated population, on the
 *    property's own fixed axis.
 * 4. **Populations** — fit each sample's distribution independently, turn the
 *    result into gates, and let the operator correct it.
 *
 * There is no fifth step, and its absence is a decision rather than an omission.
 * Statistics and Export read the gates and the parameter this pipeline creates
 * exactly as they read any other, because they *are* any other — so a Biophysics
 * statistics screen would be a second implementation of a panel that already
 * works, kept in step by hand. The pipeline's job ends when the analysis exists.
 */

import type { MixtureFit } from './mixture';
import type { PopulationScheme } from './properties';

/**
 * What kind of experiment the pipeline is walking.
 *
 * **`single`** is one cell type — a line, a sorted population — where every event
 * in the gate is the same thing and the only question is how the property is
 * distributed across it. That is the pipeline as originally built.
 *
 * **`multi`** is a mixed population, PBMCs being the case it was written for,
 * where the property has to be read *per cell type*. It needs two things the
 * single case does not: unmixed markers to identify the cell types with, and a
 * gating step at the end to identify them.
 */
export type BiophysicsMode = 'single' | 'multi';

export function asBiophysicsMode(v: unknown): BiophysicsMode {
  return v === 'multi' ? 'multi' : 'single';
}

/**
 * How a mode reads the property's distribution.
 *
 * One cell type is read as a graded series of states; a mixture is read for
 * viability only. The reasoning is on `PopulationScheme`, and it is a claim
 * about the biology rather than a preference — in PBMCs the intermediate band is
 * monocytes, which are live.
 */
export function schemeFor(mode: BiophysicsMode): PopulationScheme {
  return mode === 'multi' ? 'viability' : 'graded';
}

/**
 * Which of the loaded samples the pipeline runs over.
 *
 * **Single mode: all of them.** Multi mode: the ones carrying unmixed
 * abundances, when any do.
 *
 * The case this answers is the ordinary one — somebody unmixes a panel in the
 * Unmixing panel and walks straight into Biophysics in the same window, where
 * the workspace holds the single-stain controls beside the multicolour samples.
 * Gating cells on a single-stain bead control and fitting its membrane order is
 * meaningless work on a worksheet per control.
 *
 * **This is not inferring anything from a filename.** Which samples a matrix was
 * applied to is a fact the workspace records — the caller passes the ids — and it
 * is exactly the set the mode's own Step 0 exists to establish. When no matrix
 * has been applied at all the answer is every sample, because files unmixed on
 * the instrument arrive with their markers as ordinary parameters and nothing can
 * tell them apart without guessing.
 */
export function pipelineSampleIds(
  mode: BiophysicsMode,
  sampleIds: readonly string[],
  unmixed: ReadonlySet<string>,
): string[] {
  if (mode !== 'multi') return [...sampleIds];
  const hit = sampleIds.filter((id) => unmixed.has(id));
  return hit.length > 0 ? hit : [...sampleIds];
}

/**
 * The four steps both modes share, numbered as they always were.
 *
 * Multi mode does **not** renumber them. It adds a step before (0, unmixing) and
 * a step after (5, immune gating), which is why `BiophysicsStep` runs 0 to 5 and
 * why 1 to 4 still mean exactly what they meant: `isWalkingSamples` still asks
 * for step 4, a `step` read out of a workspace saved before modes existed is
 * still the step it names, and the harnesses that drive `setStep(2)` still land
 * on Property. Renumbering would have made one number mean two things depending
 * on a mode flag stored elsewhere — the same defect as a parameter index that
 * moves, and this project has paid for that one already.
 */
export const BIOPHYSICS_STEPS = [
  { step: 1, key: 'cells', label: 'Cells' },
  { step: 2, key: 'property', label: 'Property' },
  { step: 3, key: 'distribution', label: 'Distribution' },
  { step: 4, key: 'populations', label: 'Populations' },
] as const;

/** Multi mode's own two, at either end of the shared four. */
export const UNMIXING_STEP = { step: 0, key: 'unmixing', label: 'Unmixing' } as const;
export const IMMUNE_STEP = { step: 5, key: 'immune', label: 'Cell types' } as const;

export type BiophysicsStep = 0 | 1 | 2 | 3 | 4 | 5;

export interface BiophysicsStepDef {
  step: BiophysicsStep;
  key: string;
  label: string;
}

/** The steps a mode walks, in order. The tracker and the walk both read this. */
export function stepsFor(mode: BiophysicsMode): readonly BiophysicsStepDef[] {
  return mode === 'multi'
    ? [UNMIXING_STEP, ...BIOPHYSICS_STEPS, IMMUNE_STEP]
    : [...BIOPHYSICS_STEPS];
}

/** Where a mode starts. Multi opens on its unmixing prerequisite. */
export function firstStep(mode: BiophysicsMode): BiophysicsStep {
  return mode === 'multi' ? 0 : 1;
}

/** Where a mode ends — the step with no *Next*. */
export function lastStep(mode: BiophysicsMode): BiophysicsStep {
  return mode === 'multi' ? 5 : 4;
}

/** The step after this one within a mode, or the same step at the end. */
export function nextStep(mode: BiophysicsMode, step: BiophysicsStep): BiophysicsStep {
  const steps = stepsFor(mode);
  const i = steps.findIndex((s) => s.step === step);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1]!.step : step;
}

/** The step before this one within a mode, or the same step at the start. */
export function prevStep(mode: BiophysicsMode, step: BiophysicsStep): BiophysicsStep {
  const steps = stepsFor(mode);
  const i = steps.findIndex((s) => s.step === step);
  return i > 0 ? steps[i - 1]!.step : step;
}

/**
 * A step read from a file, a sibling window, or a mode change.
 *
 * Switching from multi to single while standing on step 0 or 5 would otherwise
 * leave the panel on a step its own tracker does not list, which renders as a
 * blank body and no way back. Clamped into the mode instead, the same way
 * `sanitisePanel` clamps a value it no longer recognises.
 */
export function clampStep(mode: BiophysicsMode, step: number): BiophysicsStep {
  const steps = stepsFor(mode);
  if (steps.some((s) => s.step === step)) return step as BiophysicsStep;
  return step < firstStep(mode) ? firstStep(mode) : lastStep(mode);
}

/**
 * The last step of the shared four. Named, because a number spelled by hand in
 * three files drifts. Multi mode continues past it — see `lastStep`.
 */
export const LAST_BIOPHYSICS_STEP: BiophysicsStep = 4;

/** Whether a step can be left, and what is missing if not. */
export interface StepCheck {
  ok: boolean;
  /** Why not — shown on the disabled Next button and beside it. */
  reason: string;
  /** True but not blocking. See the note on the unmixing wizard's own field. */
  advice?: string;
}

/**
 * Where a sample's population count came from.
 *
 * `fitted` is the automatic choice; `user` means somebody used the *Populations*
 * override on Step 4. The distinction is load-bearing in the same way
 * `FieldSource` is in the unmixing wizard: a re-fit must not silently undo a
 * count the operator stated, and the panel has to be able to say which of the
 * two a number is.
 */
export type CountSource = 'fitted' | 'user';

/**
 * One sample, as the pipeline tracks it.
 *
 * The **gates are the analysis** and everything else here is bookkeeping about
 * how they were placed — which is why `populationGateIds` is a list of ids into
 * the ordinary gate hierarchy rather than a population model of its own. There
 * is no second representation of a biophysics population anywhere; delete this
 * record and the gates are still gates, still in the tree, still counted by
 * Statistics and still written by Export.
 */
export interface BiophysicsSample {
  sampleId: string;
  /** The generated worksheet, once Step 1 has built them. */
  layoutId: string | null;
  /**
   * The cell-type worksheet, in multi mode, once Step 5 has built it.
   *
   * A second layout rather than more panels on the first, because the two are
   * read at different times and by different questions: the distribution
   * worksheet answers *how is this property spread*, the cell-type worksheet
   * answers *which cells am I looking at*.
   *
   * **It is the same id on every record**, because there is one cell-type
   * worksheet for the whole experiment (2026-08-15). It was one per sample, and
   * that was the defect: a cell-type gating strategy is a strategy — CD3 then
   * CD4 then CD45RA, the same plots and the same gates on every file — and
   * building six worksheets meant drawing it six times, with nothing making the
   * sixth agree with the first. Now one worksheet re-points its panels at each
   * sample in turn and the gates on it are ordinary shared gates, so the
   * strategy is drawn once and every sample is measured by it. The field stays
   * per-record so a workspace written before this reads back unchanged.
   */
  immuneLayoutId: string | null;
  /**
   * Population gates on the distribution, **most ordered first** — the same
   * order as `MixtureFit.components` and as `populationNames`.
   */
  populationGateIds: string[];
  /** The last fit computed for this sample, for the review chart and the overlay. */
  fit: MixtureFit | null;
  /**
   * Where the fit itself put the splits, kept so they can be put back.
   *
   * `fit.boundaries` is the **live** position and moves with every drag — it has
   * to, because the gates, the shares and the means are all read off it. So
   * "undo my nudge" had nowhere to read from: the fit is not re-run on a drag
   * (re-fitting on every pointer move is both slow and a moving target), and
   * re-running it to reset would also re-choose the component count on a sample
   * whose count the operator had stated.
   *
   * Written once per fit, never by a drag. Absent on a workspace saved before
   * 2026-08-18, where reset simply has nothing to offer and says so.
   */
  fittedBoundaries?: number[];
  /** Share of gated events actually inside each gate, in the same order. */
  shares: number[];
  /**
   * Mean of the property inside each gate, in the same order.
   *
   * The observed mean, not `MixtureFit.components[i].mean` — see
   * `populationStats`. The fitted mean is a parameter of the model and does not
   * move when a boundary does, so a panel showing it under a draggable split
   * reported a number that was right for the fit and wrong for the population on
   * screen. Absent on a workspace written before 2026-08-16; readers fall back
   * to the component mean, which is what those files' panels were showing.
   */
  means?: number[];
  countSource: CountSource;
  /**
   * True when the automatic choice was not what BIC alone preferred.
   *
   * Kept so the panel can account for the number rather than merely stating it —
   * *"BIC preferred three; two of them were 1.2 SDs apart"* is the difference
   * between a result and an assertion.
   */
  overruledBic: boolean;
}

/** A fresh record for a sample that has not been through the pipeline. */
export function emptySample(sampleId: string): BiophysicsSample {
  return {
    sampleId,
    layoutId: null,
    immuneLayoutId: null,
    populationGateIds: [],
    fit: null,
    shares: [],
    means: [],
    countSource: 'fitted',
    overruledBic: false,
  };
}

/** Has this sample been fitted and gated? */
export function isFitted(s: BiophysicsSample): boolean {
  return s.fit !== null && s.populationGateIds.length > 0;
}

/**
 * How far the work has actually got: the furthest step whose prerequisites
 * exist.
 *
 * Step 5 once its worksheets exist, 4 once any sample is fitted, 3 once the
 * parameter and a distribution worksheet exist, 2 once *Cells* is drawn. Two
 * readers: the step tracker bounds a forward jump with it, and a reopened
 * workspace clamps the step it was saved on to it (2026-10-28) — the files
 * behind a step can have gone missing between the save and the open, and a
 * restore must not put the operator anywhere the tracker would not let them
 * walk to.
 */
export function reachedStep(
  mode: BiophysicsMode,
  records: readonly BiophysicsSample[],
  liveGateId: string | null,
  parameterId: string | null,
): BiophysicsStep {
  if (records.some((r) => r.immuneLayoutId)) return 5;
  if (records.some(isFitted)) return 4;
  if (parameterId && records.some((r) => r.layoutId)) return 3;
  return liveGateId ? 2 : firstStep(mode);
}

/**
 * Which sample the worksheet currently on screen belongs to.
 *
 * The layout is the fact, for the reason `controlIndexForLayout` states: there
 * are three ways to change worksheet — the walk arrows, the bottom tab strip and
 * the layout dropdown in the title bar — and the third knows nothing about this
 * pipeline. Deriving the position from `activeLayoutId` makes all three one
 * control rather than three copies to keep level.
 *
 * `fallback` covers the interval before the worksheets exist, and any layout
 * that is not one of theirs.
 */
export function sampleIndexForLayout(
  samples: readonly BiophysicsSample[],
  activeLayoutId: string | null,
  fallback: number,
): number {
  /*
     The distribution worksheets only, and `immuneLayoutId` deliberately not.

     Step 4 walks one worksheet per sample, so the layout on screen identifies
     the sample. Step 5's worksheet is **one for the whole experiment** and
     carries the same id on every record, so matching it would report sample 0
     whichever sample the panels are pointed at. Step 5 tracks its own position
     in `walkIndex` instead, which is the fallback this already takes.
  */
  const hit = activeLayoutId
    ? samples.findIndex((s) => s.layoutId === activeLayoutId)
    : -1;
  if (hit >= 0) return hit;
  return Math.min(Math.max(0, fallback), Math.max(0, samples.length - 1));
}

/**
 * Which set of worksheets the one on screen belongs to, or `null`.
 *
 * Asked by the bottom tab strip. **It is a question about the worksheet on
 * screen, not about the step**, and that is the correction of 2026-08-18: the
 * predicate it replaces asked *"is the pipeline on Step 4"*, which is the exact
 * shape recorded as *a predicate about a mode is not a predicate
 * about what is on screen*. Step 1 builds a worksheet per sample and Steps 2 and
 * 3 rewrite their panels, so the arrows and the tabs were missing for three of
 * the four steps that have something to walk, and present on none of Step 5.
 *
 *   - `'samples'` — one of the per-sample distribution worksheets. The tabs
 *     switch layout, which is what `sampleIndexForLayout` reads back.
 *   - `'cell-types'` — the one cell-type worksheet (multi mode). There is a
 *     single layout there, so the tabs **re-point** it at another sample rather
 *     than switching to another sheet; the position comes from `walkIndex`,
 *     which is why `sampleIndexForLayout` deliberately ignores `immuneLayoutId`.
 *
 * `null` for a general worksheet, which is what hands the bottom back to
 * `LayoutBar` — see `core/layout/bottomBar.ts` for why that clause exists.
 */
export type BiophysicsWalk = 'samples' | 'cell-types';

export function biophysicsWalk(
  samples: readonly BiophysicsSample[],
  activeLayoutId: string | null,
): BiophysicsWalk | null {
  if (!activeLayoutId) return null;
  if (samples.some((s) => s.layoutId === activeLayoutId)) return 'samples';
  if (samples.some((s) => s.immuneLayoutId === activeLayoutId)) return 'cell-types';
  return null;
}

/**
 * Whether the pipeline is walking worksheets right now — the boolean
 * `bottomBarOwner` takes. Kept as its own name because that module documents its
 * input by it, and because "is a walk happening" and "which walk" are two
 * questions with one answer that should not be computed twice.
 */
export function isWalkingSamples(
  samples: readonly BiophysicsSample[],
  activeLayoutId: string | null,
): boolean {
  return biophysicsWalk(samples, activeLayoutId) !== null;
}

/**
 * Which walks have worksheets to walk, in the order they are offered.
 *
 * Asked by the bottom strip so it can say *which of the two kinds of worksheet
 * you are standing in* — which until now it never did. There are two, they are
 * built at different times, and a tab in the strip means a different thing in
 * each: on `samples` it switches worksheet, on `cell-types` it re-points the one
 * worksheet at another file. A strip that draws the same row of sample names for
 * both, with nothing naming the difference, is the report this exists to answer.
 *
 * Derived from the records rather than from `step` or `mode`, for the reason
 * `biophysicsWalk` states one function up: what is on screen is a question about
 * the worksheets, not about where the panel has got to. It also means the
 * cell-type segment cannot appear before Step 5 has built that sheet, so
 * offering the choice can never be what builds it — *a guided panel builds when
 * it is asked to, never on arrival*.
 */
export function walkFamilies(samples: readonly BiophysicsSample[]): BiophysicsWalk[] {
  const out: BiophysicsWalk[] = [];
  if (samples.some((s) => s.layoutId)) out.push('samples');
  if (samples.some((s) => s.immuneLayoutId)) out.push('cell-types');
  return out;
}

/**
 * Where a sample sits in the *other* walk's list — the counterpart of
 * `sampleIndexForLayout`, and the reason crossing between the two walks is not
 * simply carrying the index over.
 *
 * The two walks index two different lists. `goToSample` indexes the pipeline's
 * own `BiophysicsSample[]`; `showImmuneSample` indexes `pipelineSamples(...)`,
 * which is the workspace list filtered to the unmixed files. They are built from
 * one set and normally agree — and *normally* is the whole problem: a file
 * imported after Step 1 is in the second before it is in the first, and Step 1's
 * top-up is what closes the gap. Crossing by position would put the operator on
 * a neighbouring sample without saying so, which is a silent wrong answer of
 * exactly the shape this project keeps recording.
 *
 * So the crossing is by sample id, and `fallback` — clamped — covers the case
 * where the target list genuinely does not hold it yet.
 */
export function crossWalkIndex(
  targetIds: readonly string[],
  sampleId: string | null,
  fallback: number,
): number {
  const hit = sampleId ? targetIds.indexOf(sampleId) : -1;
  if (hit >= 0) return hit;
  return Math.min(Math.max(0, fallback), Math.max(0, targetIds.length - 1));
}

/* -------------------------------------------------------------------------
   Step gating
   ------------------------------------------------------------------------- */

/** Step 1 — there is something to gate, and every sample has a live gate. */
export function checkCells(sampleCount: number, gated: boolean): StepCheck {
  if (sampleCount === 0) {
    return { ok: false, reason: 'Load at least one sample to analyse.' };
  }
  if (!gated) {
    return { ok: false, reason: 'The live-cell gate has not been placed yet.' };
  }
  return { ok: true, reason: '' };
}

/**
 * Step 2 — a property and a probe are chosen, and the parameter resolves.
 *
 * `parameterResolves` is false when the property's equation names a detector the
 * loaded files do not have — a Pro12A panel acquired on an instrument with a
 * different violet block, say. That is a real configuration and it fails here
 * with the channels named rather than three steps later with an empty histogram,
 * which is the whole argument for checking a step on the way out of it.
 */
export function checkProperty(
  propertyId: string | null,
  probeId: string | null,
  parameterResolves: boolean,
  missing: string[],
): StepCheck {
  if (!propertyId) return { ok: false, reason: 'Choose a biophysical property.' };
  if (!probeId) return { ok: false, reason: 'Choose the probe this property was measured with.' };
  if (!parameterResolves) {
    return {
      ok: false,
      reason: missing.length > 0
        ? `This property is computed from ${missing.join(' and ')}, which the loaded files do not have.`
        : 'This property’s parameter cannot be computed from the loaded files.',
    };
  }
  return { ok: true, reason: '' };
}

/** Step 3 — the distribution worksheets exist. */
export function checkDistribution(built: number): StepCheck {
  if (built === 0) {
    return { ok: false, reason: 'No distribution has been built yet.' };
  }
  return { ok: true, reason: '' };
}

/**
 * Step 0 (multi only) — is there anything to identify cell types with?
 *
 * **Advice, never a refusal.** A matrix applied in the Unmixing panel is the
 * usual route and the one the step recommends, but files unmixed on the
 * instrument arrive with their markers already as ordinary parameters and this
 * pipeline cannot tell the difference — nor should it guess, which is the same
 * rule that stops anything here being inferred from a filename. Blocking would
 * refuse a legitimate workspace to enforce a preference.
 *
 * What it can say is what the last step will need, early enough to act on.
 */
export function checkUnmixing(unmixedSamples: number, sampleCount: number): StepCheck {
  if (sampleCount === 0) {
    return { ok: false, reason: 'Load the samples for this experiment.' };
  }
  if (unmixedSamples === 0) {
    return {
      ok: true,
      reason: '',
      advice: 'No unmixing matrix is applied. Carry on if these files are already unmixed — '
        + 'otherwise unmix first, so the last step has markers to gate cell types with.',
    };
  }
  if (unmixedSamples < sampleCount) {
    return {
      ok: true,
      reason: '',
      advice: `${unmixedSamples} of ${sampleCount} samples carry unmixed markers. `
        + 'The rest will only offer their raw detectors on the cell-type step.',
    };
  }
  return { ok: true, reason: '' };
}

/**
 * Step 5 (multi only) — cell-type gating.
 *
 * The last step, so like Step 4 it has no *Next* and nothing to refuse. Whether
 * a CD4 gate is in the right place is a judgement made on the worksheet; this
 * pipeline's job is to put the plots there.
 *
 * It used to take a marker count as well, because the step asked which
 * parameters to pair into plots. That is gone (2026-08-17) — see
 * `immunePanelsForSample` for why a grid of marker pairs was the wrong thing to
 * build — so the only state left worth reporting is that the worksheet has not
 * been built.
 */
export function checkImmune(built: number): StepCheck {
  if (built === 0) {
    return {
      ok: true,
      reason: '',
      advice: 'Build the worksheet to start gating cell types on it.',
    };
  }
  return { ok: true, reason: '' };
}

/** The check for a step, so the panel has one place to ask. */
export function checkBiophysicsStep(
  step: BiophysicsStep,
  ctx: {
    sampleCount: number;
    gated: boolean;
    propertyId: string | null;
    probeId: string | null;
    parameterResolves: boolean;
    missing: string[];
    built: number;
    /** Multi mode only — samples carrying unmixed abundances. */
    unmixedSamples?: number;
    /** Multi mode only — cell-type worksheets built. */
    immuneBuilt?: number;
  },
): StepCheck {
  switch (step) {
    case 0: return checkUnmixing(ctx.unmixedSamples ?? 0, ctx.sampleCount);
    case 1: return checkCells(ctx.sampleCount, ctx.gated);
    case 2: return checkProperty(ctx.propertyId, ctx.probeId, ctx.parameterResolves, ctx.missing);
    case 3: return checkDistribution(ctx.built);
    case 5: return checkImmune(ctx.immuneBuilt ?? 0);
    // Step 4 has no Next in single mode, and in multi mode leaving it needs
    // nothing that is not already true. Whether a sample's fit looks right is a
    // judgement the operator makes on the worksheet, which is the point of it.
    default: return { ok: true, reason: '' };
  }
}

/**
 * A worksheet name per sample that is unique within the set.
 *
 * Two samples with the same name is a mistake worth surviving rather than
 * refusing — the worksheets are found by id, so a duplicate name breaks nothing
 * — but a walk showing the same label twice with no way to tell which is which
 * is exactly the ambiguity a tab strip exists to remove. Same rule and same
 * reasoning as `uniqueLayoutNames`.
 */
export function uniqueWorksheetNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const base = raw.trim() || 'Sample';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}
