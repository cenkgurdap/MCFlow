import { create } from 'zustand';
import {
  channelsForDetectors,
  defaultSelection, maxComponentsFor, populationColor, populationColorIndex, populationIntervals, populationNames, probeById,
  propertyById, resolvedPreset, type PopulationScheme,
} from '@/core/biophysics/properties';
import {
  DEFAULT_BINS, fitFixed, histogram, selectMixture, statsOverIntervals,
  type Histogram1D, type MixtureFit,
} from '@/core/biophysics/mixture';
import {
  checkBiophysicsStep, clampStep, emptySample, firstStep, isFitted, pipelineSampleIds, prevStep,
  sampleIndexForLayout, schemeFor, uniqueWorksheetNames,
  type BiophysicsMode, type BiophysicsSample, type BiophysicsStep, type StepCheck,
} from '@/core/biophysics/pipeline';
import { contourToData, densityContour } from '@/core/gating/contour';
import { maskToIndices } from '@/core/gating/tree';
import { ROOT_ID, type Gate, type RangeGate } from '@/core/gating/types';
import { createTransform } from '@/core/transform';
import { parseExpression } from '@/core/derived';
import { timeParameterIndex } from '@/core/timeUnits';
import { PANEL_GAP, panelHeight } from '@/core/layout/geometry';
import { bin2d } from '@/render/binning';
import { defaultSpecFor, evaluateFor, nextGateId, useGates } from './gateStore';
import { sampleColumn, useDerived } from './derivedStore';
import { useSpectral } from './spectralStore';
import { makePanel, nextPanelId, usePlot } from './plotStore';
import { useWorkspace, type Sample } from './workspaceStore';
import { step } from './historyBus';
import { onWorkspaceCleared } from './workspaceCleared';

export type { BiophysicsSample, BiophysicsStep } from '@/core/biophysics/pipeline';

/* ==========================================================================
   Biophysics — a guided pipeline over the systems that already exist.

   ## The one architectural claim this file makes

   Nothing here is a parallel implementation of anything. Read down the imports:
   the gates come from `gateStore`, the plots from `plotStore`, the parameter
   from `derivedStore`, the scatter contour from the same `densityContour` the
   unmixing wizard traces its cell gate with. What is genuinely new is
   `core/biophysics/mixture.ts` and the part of this file that turns a fit into
   gates — about a hundred lines, all of it in `fitSample`.

   That is deliberate and it is the lesson of the last several passes. Duplicate
   or leaked state — the wizard's own gates evaluated on every sample, its own
   worksheets accumulating, its own layout list rendered flat beside the general
   ones — cost three sessions of fixes, and every one of those bugs came from the
   unmixing panel modelling something the rest of the app already modelled. So:

     - A biophysics gate is an ordinary `Gate` in the ordinary hierarchy. It is
       **not** flagged `reference`, because unlike a single stain's bracket it is
       a statement about the experiment: *these cells are dead* is a result. It
       shows in the Analysis tab, in the gate tree, in Statistics and in Export,
       which is the whole point.
     - The property value is an ordinary derived parameter, created through
       `useDerived.addDef` from the same preset the Parameters panel offers.
     - The worksheets are ordinary layouts carrying an ordinary `kind`, which is
       the mechanism the reference worksheets already use.

   There is no biophysics population model, no biophysics statistics and no
   biophysics export, and there is nothing to keep in step with the general ones.

   ## Two kinds of gate, and why they are unlinked rather than owned

   **The cell gate is one gate with per-sample boundaries.** One name, one
   population path, one place in the tree, and `linked: false` so each sample
   carries its own polygon in `overrides` — traced from that sample's own
   scatter. That is exactly the case `linked` was introduced for on 2026-08-03:
   *"a scatter or debris gate that genuinely needs tuning per file, carrying
   marker gates that must stay identical"*. Statistics and Export match samples
   up by population path, so one shared path is what makes *Cells* a column
   rather than six.

   Its state field is still `liveGateId`. The gate was called *Live cells* until
   the name was corrected (see `CELL_GATE_NAME`), and the field is written into
   the workspace format and into every window-sync snapshot — renaming it would
   be a format break and a migration to rename a string nobody sees.

   **The population gates carry `ownerSampleId`.** They cannot be one shared
   definition, and the reason is not the boundaries — it is the *names*. A sample
   whose fit finds two populations has a *Live* and an *Internalised or dead*; a
   sample with three has a *Live*, an *Internalised / pre-apoptotic* and a
   *Dead*. Those are different claims, so they are different populations, and a
   shared gate would have to give one of them a name that is false. Owned gates
   let each sample carry the populations it actually has; the paths that *do*
   match across samples — every sample's *Live* — match, which is what the
   compare tab needs.
   ========================================================================== */

/**
 * The scatter gate's name in the tree. One place, because three things read it.
 *
 * *Cells*, not *Live cells*. It is a scatter gate around intact events — it
 * knows nothing about viability, and the pipeline's own Step 4 is what separates
 * live from dead. Calling it *Live cells* claimed the answer in the name of the
 * step that has not run yet. It is also the same gate, traced by the same three
 * numbers, that the unmixing wizard already calls *Cells* (see `CONTOUR_BINS`),
 * so the two guided panels now agree.
 *
 * Workspaces saved before this carry the old name as data and keep it — a gate
 * name is the user's, and Statistics and Export match on the path they were
 * given.
 */
export const CELL_GATE_NAME = 'Cells';

/**
 * How the cell gate's contour is traced.
 *
 * The same three numbers `spectralStore` uses for the unmixing wizard's cell
 * gate, and deliberately the same rather than tuned separately: it is the same
 * question — *where are the intact cells on scatter* — asked on the same kind of
 * plot, and two answers to it would mean the *Cells* gate on a control and the
 * *Cells* gate on a sample enclosed different fractions of the same cloud for no
 * reason anybody could state. 128 bins follows the shoulder of a scatter
 * population; 24 rays is a polygon somebody can actually drag; 0.82 errs
 * generous, because a starting gate that looks finished and is slightly wrong is
 * worse than one that obviously wants a nudge.
 */
const CONTOUR_BINS = 128;
const CELL_GATE_RAYS = 24;
const CELL_GATE_COVERAGE = 0.82;

/**
 * How much of the scatter cloud the *Cells* gate encloses, by reading.
 *
 * **The two readings want different gates, and this is the one place that
 * differs.** Under the graded reading the tube holds one kind of cell, so the
 * gate's job is to find that cloud and leave out both the debris below it and
 * the dead cells beside it — 0.82 traces the shoulder of a single population,
 * which is what the unmixing wizard's own cell gate does and why the two agree.
 *
 * Under the viability reading it is wrong in two ways at once. PBMCs are not one
 * scatter cloud: lymphocytes and monocytes are two, the monocyte cloud is the
 * sparser of them, and a contour at the densest 82% traces the lymphocytes and
 * calls the monocytes debris. And the dead cells have to stay **in** — Step 4
 * separates live from dead on membrane order, so a scatter gate that has already
 * removed them leaves that step nothing to find and reports every sample as
 * fully live.
 *
 * 0.94 is deliberately loose: in a mixture this gate excludes debris and nothing
 * else, and everything it lets through is something a later step is responsible
 * for telling apart. It is a starting shape like any other and is dragged per
 * sample; erring generous is the right direction for one, because a gate that
 * looks finished and is quietly missing a cell type is worse than one that
 * obviously wants a nudge.
 */
function cellCoverageFor(mode: BiophysicsMode): number {
  return schemeFor(mode) === 'viability' ? 0.94 : CELL_GATE_COVERAGE;
}

/** Width of every panel in a generated biophysics worksheet. See `panelsForSample`. */
const WORKSHEET_PANEL_WIDTH = 430;

/**
 * The one cell-type worksheet's name.
 *
 * Not the sample's name, because it is not a sample's worksheet — it holds the
 * gating strategy, and which sample it is currently pointed at is a control on
 * the panel rather than a property of the sheet. See `buildImmuneWorksheets`.
 */
const IMMUNE_WORKSHEET_NAME = 'Cell types';

interface BiophysicsState {
  step: BiophysicsStep;

  /**
   * One cell type, or many.
   *
   * `single` is the pipeline as first built — a line or a sorted population,
   * where every gated event is the same kind of cell. `multi` brackets it with
   * two more steps: unmixing before, so there are markers to identify cell types
   * with, and cell-type gating after, so the property can be read per type. See
   * `core/biophysics/pipeline.ts` for why the shared four keep their numbers.
   */
  mode: BiophysicsMode;

  /**
   * Whether the *Cells* gate is **one shape for every sample**.
   *
   * `false` is the pipeline as first built: the gate is `linked: false` and each
   * sample carries its own polygon in `overrides`, traced around its own scatter
   * cloud. That is right for a single cell type, where the tubes are one
   * preparation and the debris corner genuinely moves between files.
   *
   * `true` is the default in *multiple cell types* and is what that mode asked
   * for: multicolour samples run on one instrument setting are one experiment,
   * and eight independently-traced polygons mean the *Cells* population is a
   * slightly different question on every file — which is precisely what makes a
   * comparison across them arguable. One shape, checked against every sample by
   * walking, is the same argument Step 5's one worksheet makes.
   *
   * Absent from a workspace written before this, where it reads `false` — the
   * behaviour those gates were actually placed with.
   */
  cellGateShared: boolean;


  /* --- Step 2: what is being measured --- */
  propertyId: string | null;
  probeId: string | null;
  /**
   * The two detectors the property is read on, when they are not the probe's own.
   *
   * `null` — the ordinary case — means the probe's published pair, so a workspace
   * that never touched this carries no answer rather than a copy of the default,
   * and a probe whose bands are corrected in a later build corrects with it.
   * Non-null is a deliberate statement by somebody whose instrument names its
   * detectors differently, and `resolvedPreset` is the only reader.
   */
  channels: readonly [string, string] | null;
  /**
   * Whether the pair above was decided by a person — **not saved**.
   *
   * It exists so an instrument match can be offered once and never re-offered.
   * `channels: null` cannot say the difference between *nobody has been here*
   * and *somebody reset it back to the probe's own bands on purpose*, and
   * without that difference the suggestion would reappear the moment the reset
   * re-rendered the step, which is a control that undoes itself. Set by either
   * of the two things a person can do to the pair — choose one, or reset it —
   * and cleared when the property or the probe changes, because the pair they
   * touched belonged to the old one.
   *
   * Session state, so it is deliberately absent from the persisted keys: a
   * workspace reopened on the same instrument is offered the same match again,
   * which is right, and one reopened on another instrument is offered its own.
   */
  channelsTouched: boolean;
  /** The derived-parameter definition id, once Step 2 has ensured it exists. */
  parameterId: string | null;

  /* --- Step 1: the live-cell gate --- */
  /**
   * The shared live-cell gate.
   *
   * One gate, `linked: false`, with a per-sample boundary in `useGates.overrides`
   * for every sample. See the header note for why that is the right mechanism
   * and not one gate per file.
   */
  liveGateId: string | null;

  /**
   * The doublet cut, in *multiple cell types* only.
   *
   * ## Why the fit moved inside it (2026-08-21)
   *
   * Viability used to be read on *Cells*, which put `Live` and `Dead` beside
   * `Singlets` rather than inside it: a cell type gated out of *Live* was not
   * doublet-excluded, and a doublet of a live and a dead cell counted as one
   * event of intermediate membrane order. Step 5's plot said *inside Singlets*
   * because that is what it should always have meant.
   *
   * So multi mode traces two gates on Step 1 — the cells, then the doublet cut
   * inside them — and everything from Step 3 on is read inside this one:
   * `Cells/Singlets/Live/CD4` is the path a cell type reads as. Single mode is
   * untouched and has no singlet gate; there the fit is read inside *Cells*,
   * which is what Steps 1–4 have always meant there.
   *
   * Shared and linked, like the cell gate in this mode: eight tubes on one
   * instrument setting are one experiment, so the cut is one judgement checked
   * by walking rather than eight traced diagonals. Seeded by
   * `ensureSingletGate`, which finds one by *what it is* and never replaces a
   * gate somebody has moved.
   *
   * `null` on a workspace written before this, and on any sample set with no
   * height channel to discriminate with — `fitPopulationId` falls back to the
   * cell gate in both cases, which is exactly the old behaviour.
   */
  singletGateId: string | null;

  /* --- Per sample --- */
  samples: BiophysicsSample[];
  /**
   * Which sample Step 4's walk is showing — an index into `samples`.
   *
   * A fallback rather than the source of truth. What is on screen is decided by
   * `usePlot().activeLayoutId`; `sampleIndexForLayout` reads it and falls back to
   * this for the interval before the worksheets exist.
   */
  walkIndex: number;

  setStep(step: BiophysicsStep): void;
  /** Switch experiment kind, clamping the step into the new mode's list. */
  setMode(mode: BiophysicsMode): void;
  setProperty(propertyId: string): void;
  setProbe(probeId: string): void;
  /**
   * Re-point the property at two detectors of this instrument.
   *
   * Clears `parameterId`: the definition already created computes the old pair,
   * and leaving the pipeline pointed at it would fit a distribution the equation
   * on screen no longer describes. `ensureParameter` makes or finds the right one
   * on the way out of the step.
   */
  setChannels(a: string, b: string): void;
  /** Back to the probe's published pair. */
  resetChannels(): void;

  /** Whether the current step can be left, and what is missing if not. */
  stepCheck(): StepCheck;
  /** Advance, running whatever the step needs on the way out. */
  next(samples: Sample[]): void;
  back(): void;
  /** Back to Step 1. Gates, worksheets and the parameter are left alone. */
  reset(): void;
  /**
   * Remove every gate, worksheet and parameter this pipeline created.
   *
   * The other half of *Start over*: that one re-runs a pipeline on the same
   * experiment, this one gets rid of it. Returns what went, so the panel can
   * report it rather than claim it. One undo step.
   */
  discardSetup(): { gates: number; worksheets: number };

  /* --- Step 1 --- */
  /**
   * Trace a live-cell gate on every sample and build a worksheet each.
   *
   * Idempotent for a sample that already has a boundary: a gate somebody has
   * dragged is never re-placed, which is the same rule `ensureGated` follows in
   * the unmixing wizard and for the same reason.
   */
  buildLiveGates(samples: Sample[]): { built: number; message?: string };
  /**
   * Set every sample at once: one shared shape, or one traced per sample.
   *
   * Applies the change to the gate that already exists rather than only setting
   * a flag: going shared drops every per-sample override, so the one shape is
   * really what every sample is counted by; going individual traces each
   * sample's own scatter again. A flag nothing acts on is the "set and never
   * read" defect this project keeps recording.
   */
  setCellGateShared(shared: boolean, samples: Sample[]): void;
  /**
   * The same question for **one** sample — the per-row control.
   *
   * Shaped on the unmixing wizard's negative-reference column (2026-08-18): a
   * bulk pair of buttons that states the usual answer, and a control on each row
   * that corrects the one file that differs. A panel of eight tubes is almost
   * always eight copies of one answer, and a segmented control in its own card
   * asking for that answer a second time — which is what this replaces — made
   * the choice look like a setting rather than like the property of a sample it
   * is.
   *
   * `false` traces this sample's own scatter into its `overrides` entry; `true`
   * drops it, so the sample reads the one shared shape again. The gate's
   * `linked` flag follows: unlinked the moment any sample carries its own, back
   * to linked when the last one is given up — which is what stops a drag on
   * another sample's worksheet silently forking a shape that is meant to be
   * shared.
   */
  setSampleGateShared(sample: Sample, shared: boolean): void;

  /* --- Step 2 --- */
  /** Create the property's parameter if the workspace has not got it. Returns its id. */
  ensureParameter(): string | null;
  /** Detector names the property's equation needs and a sample does not have. */
  missingChannels(sample: Sample | undefined): string[];
  /**
   * The pair this instrument names the probe's two bands by, or `null`.
   *
   * Asked of `channelsForDetectors`, so it answers for a file the published pair
   * is **absent** from and for no other. The panel both applies it — once, on
   * arrival, and only while the operator has chosen nothing — and reads it back
   * to say on screen that the pair standing in the dropdowns was matched rather
   * than published.
   */
  suggestedChannels(sample: Sample | undefined): readonly [string, string] | null;
  /**
   * Take that suggestion, if there is one and nothing has been chosen yet.
   *
   * Separate from `setChannels` so the panel's effect cannot overwrite a pair
   * somebody picked, and in the store rather than in the effect so the rule for
   * when a suggestion applies is written once beside the rule for what it is.
   */
  suggestChannels(sample: Sample | undefined): void;

  /* --- Step 3 --- */
  /** Put the property's histogram on every worksheet, on its fixed axis. */
  buildDistributions(samples: Sample[]): number;

  /* --- Step 4 --- */
  /** Fit one sample and turn the result into gates. `k` forces a count. */
  fitSample(sample: Sample, k?: number | null): BiophysicsSample | null;
  /** Fit every sample that has not been fitted yet, and leave the rest alone. */
  fitAll(samples: Sample[], opts?: { force?: boolean }): number;
  /** Show sample `index` of the walk, switching to its worksheet. */
  goToSample(index: number): void;
  /** Index of the sample whose worksheet is on screen. */
  currentSampleIndex(): number;
  /** One sample forward (+1) or back (−1) along the walk. */
  walkBy(delta: number): void;
  /** Move one boundary, adjusting both populations it divides. */
  moveBoundary(sample: Sample, boundaryIndex: number, value: number): void;
  /**
   * Put this sample's splits back where the fit put them.
   *
   * The counterpart of every drag on the review chart and of *Use on every
   * sample*: both write `fit.boundaries`, and until there was somewhere to read
   * the original from, the only way back was a re-fit — which also re-chooses
   * the component count and so discards a count the operator stated. See
   * `BiophysicsSample.fittedBoundaries`. Returns whether anything moved.
   */
  resetBoundaries(sample: Sample): boolean;
  /**
   * The same, for every fitted sample. The undo of *Use on every sample*.
   *
   * Returns how many samples moved. One undo step, like the apply it reverses.
   */
  resetAllBoundaries(samples: Sample[]): number;
  /**
   * Put every other fitted sample's **live boundary** where this one's is.
   *
   * The live boundary is the topmost split — the lower edge of the most-ordered
   * population, which is *Live* under either scheme. It is the one boundary that
   * means the same thing on every sample regardless of how many populations the
   * fit found, which is exactly why it is the only one this copies: on a
   * three-population sample the lower split divides *Dead* from
   * *Internalised / pre-apoptotic*, and those are not the same two populations
   * on a sample that fitted two.
   *
   * Returns how many samples moved. A sample that fitted one population has no
   * boundary and is skipped rather than invented for.
   */
  applyLiveBoundary(samples: Sample[], sourceSampleId: string): number;
  /** The record for a sample, or undefined. */
  recordFor(sampleId: string): BiophysicsSample | undefined;

  /* --- Step 0 and Step 5, multi mode only --- */
  /** How many loaded samples carry unmixed abundances. Step 0's whole question. */
  unmixedSampleCount(samples: Sample[]): number;
  /**
   * The samples this mode's pipeline runs over — see `pipelineSampleIds`.
   *
   * Every step asks this rather than taking the workspace's list, so a window
   * that unmixed a panel and walked straight into Biophysics gates the
   * multicolour samples and not the single-stain controls.
   */
  pipelineSamples(samples: Sample[]): Sample[];
  /**
   * **One** cell-type worksheet: the three plots the pipeline itself implies.
   *
   * Scoped so a gate drawn on it is a child of the population the property was
   * read on, and Statistics reads *Cells/Live/CD4* as one path. See
   * `BiophysicsSample.immuneLayoutId` for why it is one and not one per sample,
   * and `immunePanelsForSample` for what the three are.
   */
  buildImmuneWorksheets(samples: Sample[]): number;
  /** Point the cell-type worksheet at sample `index` of the pipeline's set. */
  showImmuneSample(samples: Sample[], index: number): void;
  /** The cell-type worksheet's layout id, or null before it is built. */
  immuneLayoutId(): string | null;

  /** Replace the whole set, e.g. from a workspace or a sibling window. */
  setAll(state: Partial<Pick<BiophysicsState,
    'step' | 'mode' | 'cellGateShared' | 'propertyId' | 'probeId' | 'channels' | 'parameterId'
    | 'liveGateId' | 'singletGateId' | 'samples' | 'walkIndex'>>): void;
}

/**
 * The parameter definition this pipeline computes from, detectors and all.
 *
 * Three fields decide it, and a panel reading them separately is a panel that can
 * disagree with the store about which equation is about to be created — so it is
 * asked here, once, by both the store and the view.
 *
 * **Not a selector**, unlike `fitPopulationId`: an overridden pair builds a fresh
 * preset object every call, and `useBiophysics(pipelinePreset)` would hand
 * `useSyncExternalStore` a new snapshot each render and loop. Subscribe to the
 * three values and `useMemo` over them, which is the rule for any store-derived
 * object anyway.
 */
export const pipelinePreset = (
  s: Pick<BiophysicsState, 'propertyId' | 'probeId' | 'channels'>,
) => {
  const property = propertyById(s.propertyId);
  return resolvedPreset(property, probeById(property, s.probeId), s.channels);
};

/**
 * The population a fit is read inside, and the parent of the gates it produces.
 *
 * *Multiple cell types* reads viability inside the doublet cut; one cell type
 * reads it inside the cells. **Asked in one place** — the histogram panel, the
 * distribution the fit is run over, the gates' parent and Step 5's trace plot
 * all have to name the same population, and four call sites each deciding for
 * themselves is how a fit comes to be counted over a different set of events
 * than the gates it wrote.
 *
 * Falls back to the cell gate whenever there is no cut: single mode, a workspace
 * written before Step 1 traced one, or a file with no height channel.
 *
 * Exported in the shape of a selector — `useBiophysics(fitPopulationId)` — so a
 * panel asking which population it is looking at asks this and not the two
 * fields behind it.
 */
export function fitPopulationId(s: Pick<BiophysicsState, 'mode' | 'liveGateId' | 'singletGateId'>): string | null {
  return s.mode === 'multi' && s.singletGateId ? s.singletGateId : s.liveGateId;
}

/* -------------------------------------------------------------------------
   Helpers, all store-free
   ------------------------------------------------------------------------- */

/** A scatter parameter by name, for the live gate's axes. Falls back to position. */
function scatterParam(sample: Sample, want: 'FSC' | 'SSC'): number {
  const params = sample.parsed.metadata.parameters;
  const hit = params.findIndex((p) => p.name.toUpperCase().startsWith(`${want}-A`));
  if (hit >= 0) return hit;
  const loose = params.findIndex((p) => p.name.toUpperCase().includes(want));
  if (loose >= 0) return loose;
  return want === 'FSC' ? 0 : Math.min(1, params.length - 1);
}

/**
 * A polygon traced around the scatter cloud, in display space.
 *
 * The same routine `spectralStore.scatterPolygon` runs, against the same
 * `densityContour`, and the reason it is written out again rather than exported
 * from there is direction: `spectralStore` is the unmixing wizard's state, and a
 * second guided panel importing from it would make the wizard a dependency of
 * everything that gates scatter. The *rule* lives in `core/gating/contour.ts`,
 * which is what both call and where a change to the tracing belongs; what is
 * here is the twenty lines of binning that connect a sample to it.
 *
 * `null` when there is nothing to trace, which is a real state: a file with no
 * finite scatter has no cloud, and inventing a shape for it would be worse than
 * saying so.
 */
function scatterPolygon(
  sample: Sample,
  xParam: number,
  yParam: number,
  coverage: number,
  /**
   * Event indices to trace within, or `null` for the whole file.
   *
   * The singlet gate is the case: doublets are a feature of the *cells*, and a
   * contour over the whole file would be traced around the debris corner as
   * much as around the diagonal. `gatedEvents` produces the list.
   */
  subset: Uint32Array | null = null,
) {
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

  // Sampled: the contour of 20 000 events and of 170 000 differ by less than a
  // bin, and this runs once per sample while somebody waits.
  const total = subset ? subset.length : n;
  if (total === 0) return null;
  const stride = Math.max(1, Math.floor(total / 40000));
  const count = Math.ceil(total / stride);
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  let k = 0;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let s = 0; s < total; s += stride) {
    const i = subset ? subset[s]! : s;
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
  const cells = densityContour(grid, { coverage, rays: CELL_GATE_RAYS });
  if (cells.length < 3) return null;

  return { vertices: contourToData(cells, grid, { xMin, xMax, yMin, yMax }), xSpec, ySpec };
}

/**
 * Events inside a gate, through the same evaluation the plots use.
 *
 * A second evaluation path would be a way for the picture and the fit to
 * disagree about which events are being fitted, which is precisely the class of
 * bug this project has spent passes removing. `null` means "no gate", which the
 * caller reads as *the whole file* rather than as an error.
 */
function gatedEvents(sample: Sample, gateId: string | null): Uint32Array | null {
  if (!gateId || gateId === ROOT_ID) return null;
  const gates = useGates.getState().gatesFor(sample.id);
  if (!gates.some((g) => g.id === gateId)) return null;
  const evaluated = evaluateFor(sample.id, sample.parsed, gates, (p) => defaultSpecFor(sample.parsed, p));
  const mask = evaluated.masks.get(gateId);
  return mask ? maskToIndices(mask) : null;
}

/**
 * The distribution each sample was last fitted on, by sample id.
 *
 * A cache, not state: it is derivable from the sample and the live-cell gate at
 * any moment, nothing outside this module reads it, and losing it costs one
 * recomputation. It is deliberately *not* a field on `BiophysicsSample`, because
 * that record is snapshotted by every undo step and written into the workspace
 * file, and 256 bins per sample belong in neither.
 *
 * It exists so `moveBoundary` can recount the populations on every pointer move.
 * Rebuilding the histogram there means re-evaluating the gate tree over a
 * hundred thousand events — tens of milliseconds, during a drag that already
 * writes two gates per move — where recounting 256 bins is free. `fitSample`
 * fills it; a miss falls back to building one.
 */
const fitDistributions = new Map<string, Histogram1D>();

/**
 * The distribution a fit is read off, and the only place it is built.
 *
 * This sample's property values inside the population `fitPopulationId` names,
 * binned on the property's own fixed axis. One function because two callers need
 * it to be the identical binning — the fit, and the recount after a boundary
 * moves — and a recount over a differently-binned distribution would report
 * percentages that do not add up to what the fit was judged against.
 */
function distributionFor(sample: Sample, s: BiophysicsState): Histogram1D | null {
  const property = propertyById(s.propertyId);
  if (!property) return null;
  const index = parameterIndexOf(sample, s.parameterId);
  if (index < 0) return null;
  /*
     `sampleColumn` is the one function that resolves a parameter index to data —
     real, derived or unmixed — so the fit reads exactly the numbers the
     histogram plots and the export writes. Reaching into `parsed.data` here
     would bypass it and index past the end of the buffer on a derived index,
     which is the failure mode the virtual-index design has and the one it has
     already produced once.
  */
  const values = sampleColumn(sample.parsed, index, useDerived.getState().defs);
  return histogram(values, {
    min: property.axis.min,
    max: property.axis.max,
    bins: DEFAULT_BINS,
    subset: gatedEvents(sample, fitPopulationId(s)),
  });
}

/**
 * Write a whole set of boundaries onto a sample — its gates, its shares and its
 * means — in one undo step.
 *
 * **The one place a split is written.** Both gestures that move one — a drag on
 * the review chart, and putting them back where the fit had them — go through
 * here, so they cannot disagree about what a boundary implies. What it implies
 * is three things at once, and leaving any of them out has already produced a
 * bug: the gates are what Statistics counts, the shares and means are what the
 * panel draws beside the split, and `fit.boundaries` is what the chart draws the
 * line from.
 *
 * Every gate is rewritten rather than only the two either side of the moved
 * split. `populationIntervals` is the same function the fit was turned into
 * gates with, so a rewrite is idempotent for the ones that did not move, and it
 * removes the one piece of index arithmetic in this file that had to be got
 * right twice — `boundaries` ascends while `components` descends. It is also
 * what keeps a four-component viability fit at two gates and one split: the
 * scheme decides how many intervals there are, here and at the fit alike.
 */
function writeBoundaries(
  sample: Sample,
  rec: BiophysicsSample,
  nextBounds: number[],
  label: string,
  coalesceKey?: string,
): void {
  if (!rec.fit) return;
  const s = useBiophysics.getState();
  const index = parameterIndexOf(sample, s.parameterId);
  if (index < 0) return;

  const tf = createTransform(defaultSpecFor(sample.parsed, index));
  // ±Infinity is the outermost population's outer edge and stays infinite: a
  // transform of it is not a coordinate, and the renderer is what bounds it.
  const toDisplay = (v: number) => (Number.isFinite(v) ? tf.forward(v) : v);

  const nextFit = { ...rec.fit, boundaries: nextBounds };
  const intervals = populationIntervals(nextFit, schemeFor(s.mode));

  /*
     One undo step, keyed by the caller so a whole drag folds into one too.

     Without the key a drag across the chart fills the stack with an entry per
     pointer move — the defect `coalesceKey` exists for — and without `step` each
     move would be one entry per gate written.
  */
  step(label, () => {
    rec.populationGateIds.forEach((id, i) => {
      const iv = intervals[i];
      if (!iv) return;
      useGates.getState().updateGate(sample.id, id, {
        min: toDisplay(iv.min), max: toDisplay(iv.max),
      } as Partial<Gate>);
    });
  }, coalesceKey);

  /*
     Recount, because moving a split is what changes the populations.

     Until 2026-08-16 a move wrote the boundary and nothing else, so the panel
     drew the line in its new place under a percentage and a mean computed for
     the old one. `MixtureFit.components` deliberately does not move — the fit is
     not re-run on a drag — which is exactly why the numbers cannot come from it.
  */
  const h = fitDistributions.get(sample.id) ?? distributionFor(sample, s);
  if (h) fitDistributions.set(sample.id, h);
  const stats = h ? statsOverIntervals(h, intervals) : null;

  useBiophysics.setState((st) => ({
    samples: st.samples.map((r) =>
      r.sampleId === sample.id && r.fit
        ? {
            ...r,
            fit: nextFit,
            shares: stats ? stats.map((x) => x.share) : r.shares,
            means: stats ? stats.map((x) => x.mean) : r.means,
          }
        : r),
  }));
}

/** The parameter index of a derived definition on a sample, or −1. */
function parameterIndexOf(sample: Sample, defId: string | null): number {
  if (!defId) return -1;
  const defs = useDerived.getState().defs;
  const at = defs.findIndex((d) => d.id === defId);
  if (at < 0) return -1;
  return sample.parsed.metadata.parameters.length + at;
}

/**
 * The panels making up one sample's worksheet.
 *
 * **Placed, not flowed** — the arrangement is the instruction, so letting
 * `placePanels` put them wherever there happened to be room would lose it.
 *
 *   1. **FSC-A × SSC-A**, carrying the live-cell polygon. The same density plot
 *      the Analysis panel would open, with no biophysics-specific rendering.
 *   2. **FSC-A × FSC-H**, scoped to *Cells*, carrying the doublet cut — in
 *      *multiple cell types* only, where Step 1 traces one and the fit is read
 *      inside it. A gate the pipeline places and never shows is a gate nobody
 *      can correct, and this is the plot it is correctable on.
 *   3. **The property's histogram**, scoped to the population the fit is read
 *      inside and pinned to the property's own axis, carrying the fitted
 *      population gates.
 *
 * **The two gates sit side by side and the measurement sits under them**
 * (2026-08-22). Step 1 is one decision made twice — here are the cells, and here
 * is the singlet cut *inside* them — and a parent beside its child reads as that
 * one decision, where a parent above its child reads as two steps. It is also
 * the arrangement Step 5's worksheet uses for the same two plots, so walking
 * from Step 1 to Step 5 does not rearrange a picture the operator has learnt.
 * The histogram is on the row below because it is not a third gate: it is what
 * the two of them were drawn to make measurable.
 *
 * The histogram is only included once the parameter exists — Step 1 runs before
 * Step 2 has chosen a property, so there is nothing for it to plot. That is why
 * this takes `parameterIndex` and returns a short worksheet or a full one, and
 * why `buildDistributions` calls it again on the way into Step 3.
 */
function panelsForSample(
  sample: Sample,
  liveGateId: string | null,
  fitGateId: string | null,
  parameterIndex: number,
  axis: { min: number; max: number } | null,
) {
  const W = WORKSHEET_PANEL_WIDTH;
  const H = panelHeight(W) + PANEL_GAP;

  const xScatter = scatterParam(sample, 'FSC');
  const yScatter = scatterParam(sample, 'SSC');
  const fscH = heightParam(sample, 'FSC');
  // The doublet plot exists only where there is a cut to draw on it: multi mode,
  // a seeded singlet gate, and a height channel to plot it against.
  const singlets = fitGateId && fitGateId !== liveGateId && fscH !== null;

  const scatter = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: null,
    x: 0, y: 0, w: W,
    xParam: xScatter,
    yParam: yScatter,
    // The same spec the traced polygon was computed in, which is what makes the
    // gate land on the cloud it was traced around rather than somewhere
    // reprojected. `initialisedFor` is set, so nothing re-picks these on mount.
    xTransform: defaultSpecFor(sample.parsed, xScatter).kind,
    yTransform: defaultSpecFor(sample.parsed, yScatter).kind,
    plotType: 'density',
    initialisedFor: sample.id,
  });

  // Inside the cells, so the cut is drawn over the cloud it was traced around,
  // and beside them rather than below — see the note above.
  const doublets = singlets ? makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: liveGateId,
    x: W + PANEL_GAP, y: 0, w: W,
    xParam: xScatter,
    yParam: fscH!,
    xTransform: defaultSpecFor(sample.parsed, xScatter).kind,
    yTransform: defaultSpecFor(sample.parsed, fscH!).kind,
    plotType: 'density',
    initialisedFor: sample.id,
  }) : null;

  if (parameterIndex < 0 || !axis) return doublets ? [scatter, doublets] : [scatter];

  const distribution = makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    // Scoped to the population the fit is read inside, which is what makes this
    // the distribution the fit is run over rather than the distribution of the
    // whole file. See `fitPopulationId`.
    populationId: fitGateId,
    x: 0, y: H, w: W,
    xParam: parameterIndex,
    /*
       The y parameter on a histogram panel, stated rather than left at the
       default. A histogram's y axis is event density and plots no parameter at
       all, but the panel still *labels* it from `yParam`, and `makePanel`
       defaults that to index 0 — which on an Aurora file is Time. SSC-A instead.
    */
    yParam: yScatter,
    /*
       The property's own range, pinned.

       `xMin`/`xMax` are explicit axis limits in **data units** — configuration,
       not a view transform, and the one mechanism in this app for a range
       somebody states. A normalised ratio is bounded at ±1 by construction, so
       this is the quantity's range rather than a framing preference, and pinning
       it is what makes two samples' histograms comparable pictures rather than
       two auto-fitted close-ups that look identical.
    */
    xMin: axis.min,
    xMax: axis.max,
    // Linear, because a derived parameter is typed `Derived` and that is what
    // `defaultSpecFor` gives it. Stated rather than inferred for the same reason
    // the reference worksheets state theirs: `initialisedFor` is set, so nothing
    // else will choose.
    xTransform: defaultSpecFor(sample.parsed, parameterIndex).kind,
    yTransform: defaultSpecFor(sample.parsed, yScatter).kind,
    plotType: 'histogram',
    initialisedFor: sample.id,
  });

  return doublets ? [scatter, doublets, distribution] : [scatter, distribution];
}

/**
 * The plots on the cell-type worksheet: **the three the pipeline already
 * implies**, and nothing chosen from a list.
 *
 * ## What this replaces, and why (2026-08-17)
 *
 * It used to take a set of marker indices, tick-picked on Step 5, and pair them
 * two at a time into density plots — CD3 × CD4, CD8 × CD19, whatever order they
 * were clicked in. The pairing was arbitrary and so was the set: a panel of nine
 * abundances offers thirty-six pairs, the step picked them off in fours, and
 * *Unmixed markers* selected every one of them at once. What arrived was a wall
 * of plots of parameter combinations nobody had asked a question about, on a
 * step whose whole job is to hand somebody a place to start gating.
 *
 * The three below are the three the pipeline can actually justify, because each
 * one is a step the pipeline itself already took:
 *
 *   1. **FSC-A × SSC-A**, unscoped, carrying the *Cells* gate — the gate Step 1
 *      placed, on the plot it was traced on, so the walk starts by showing the
 *      shape every later number is a percentage of.
 *   2. **FSC-A × FSC-H**, scoped to *Cells*, carrying a traced **Singlets**
 *      gate — the doublet discrimination that a cell-type readout needs and that
 *      nothing else in this pipeline does. See `ensureSingletGate` for why it is
 *      seeded rather than left to be drawn.
 *   3. **Time × the property**, scoped to *Singlets*, with the y axis pinned to
 *      the property's own range. It is the acquisition read back: a
 *      membrane-order drift over the run is an instrument problem rather than a
 *      biological one, and this is the only plot in the app that would show it.
 *
 * **Time is on x, and the viability split is drawn across it** (2026-08-20).
 *
 * The orientation was the other way round for a day, and the reason was the
 * split: a `RangeGate` used to be drawn against a panel's **x** parameter and
 * nothing else, so putting the property on x was the only way to get the *Live*
 * boundary onto the plot rather than scoping it to one side. That bought a line
 * at the cost of the reading — a quantity against elapsed time is a trace, time
 * runs left to right, and a drift over a run is a slope; turned a quarter over
 * it is none of those. Turning it back lost the line, which was the next report:
 * *Live* and *Dead* were counted in the tree and in Statistics with no boundary
 * anywhere on the plot the counts came from.
 *
 * Both are now true, because the renderer was the thing that was wrong. A range
 * gate is one interval on one parameter; whether it paints as a vertical or a
 * horizontal band is a question about the plot, and `rangeAxisOn` in
 * `panels/panelGates.ts` is where it is asked. So the trace reads as a trace and
 * carries two draggable horizontal bands over it, the split can be adjusted
 * against the events rather than only on Step 4's fit chart, and *Live* can be
 * dragged off the plot to open the first downstream plot of a gating strategy.
 *
 * **And it is scoped to *Singlets*** (2026-08-21), which is where viability is
 * read from Step 3 on — see `singletGateId`. The one thing the plot must not do
 * is show only live events, which was the original report; scoping it to the
 * population the split was fitted inside is what settles that, and it is also
 * what puts the two bands on it at all, since they are that population's
 * children.
 *
 * Everything the user adds beside these survives the walk — `showImmuneSample`
 * re-points panels rather than rebuilding them — so the marker plots that the
 * old step guessed at are two drags away and are the ones they meant.
 */
function immunePanelsForSample(
  sample: Sample,
  cellsId: string | null,
  singletsId: string | null,
  propertyIndex: number,
  axis: { min: number; max: number } | null,
) {
  const W = WORKSHEET_PANEL_WIDTH;
  const H = panelHeight(W) + PANEL_GAP;
  const COLS = 2;

  const fsc = scatterParam(sample, 'FSC');
  const ssc = scatterParam(sample, 'SSC');
  const fscH = heightParam(sample, 'FSC') ?? ssc;
  const time = timeParam(sample);

  const at = (i: number) => ({
    x: (i % COLS) * (W + PANEL_GAP),
    y: Math.floor(i / COLS) * H,
  });

  const plots = [
    // 1 — the cells, on the plot the gate was traced on. Unscoped, so the gate
    // itself is drawn: a panel never draws its own scope gate.
    { xParam: fsc, yParam: ssc, populationId: null },
    // 2 — singlets, inside the cells, carrying the traced doublet cut.
    { xParam: fsc, yParam: fscH, populationId: cellsId },
    // 3 — the property against acquisition time over every singlet, read as a
    // trace: time on x, the quantity on y, with the Live/Dead bands across it.
    { xParam: time, yParam: propertyIndex, populationId: singletsId ?? cellsId },
  ];

  return plots.map((p, i) => makePanel({
    id: nextPanelId(),
    sampleId: sample.id,
    populationId: p.populationId,
    ...at(i),
    w: W,
    xParam: p.xParam,
    yParam: p.yParam,
    xTransform: defaultSpecFor(sample.parsed, p.xParam).kind,
    yTransform: defaultSpecFor(sample.parsed, p.yParam).kind,
    /*
       The property's own range on the **y** axis of plot 3, stated the same way
       the distribution worksheet states it: explicit limits in data units, which
       is configuration rather than a view transform. A normalised ratio is
       bounded by construction, so this is the quantity's range and not a framing
       preference — and it is what makes two samples' traces the same picture, so
       a drift on one is visible beside a flat run on the other.
    */
    ...(i === 2 && axis && propertyIndex >= 0 ? { yMin: axis.min, yMax: axis.max } : {}),
    plotType: 'density',
    initialisedFor: sample.id,
  }));
}

/**
 * The doublet cut on FSC-A × FSC-H, traced inside the cells.
 *
 * ## Why it is seeded now (2026-08-18)
 *
 * It was not, and the reason given was that a doublet cut is a judgement. So is
 * where the cells are, and Step 1 traces that one without being asked — for a
 * reason that applies here word for word: *there is no state in which the
 * operator wants their cells left ungated, and correcting a traced polygon is
 * strictly less work than drawing one*. What the old rule produced was a plot
 * with the right axes, no gate, and nothing under it, on a step whose whole job
 * is to hand somebody a strategy to start from.
 *
 * **Shared, and a child of *Cells*.** Shared because everything else on this
 * worksheet is: it is one gating strategy walked across the samples, and eight
 * traced diagonals would make *Singlets* a different question on every file.
 * A child of *Cells* so it reads as `Cells/Singlets` and the cell-type gates
 * drawn under it read as `Cells/Singlets/CD3` — the ordinary path, which is what
 * makes Statistics pick them up with no special case.
 *
 * Found before it is created, by **what it is** rather than by its name: a
 * polygon child of the cell gate on those two parameters. A gate the operator
 * has drawn there themselves, or renamed, or dragged, is that gate — and is
 * never replaced, which is the rule every seeded gate in this application
 * follows.
 */
const SINGLET_GATE_NAME = 'Singlets';

/**
 * How much of the FSC-A × FSC-H cloud the seeded singlet gate encloses.
 *
 * Looser than the cell gate's 0.82 and for the opposite reason: doublets are a
 * few percent of the events and sit just off the diagonal, so a tight contour
 * cuts into the singlet ridge itself while a generous one leaves a shape that
 * obviously wants a nudge. Erring generous is the right direction for a starting
 * gate, which is the same argument `cellCoverageFor` makes.
 */
const SINGLET_GATE_COVERAGE = 0.9;

function ensureSingletGate(sample: Sample, cellsId: string | null, shared = true): string | null {
  if (!cellsId) return null;
  const x = scatterParam(sample, 'FSC');
  const y = heightParam(sample, 'FSC');
  // No height channel means no doublet discrimination to offer. A plot of FSC-A
  // against SSC-A pretending to be one would be worse than its absence.
  if (y === null) return null;

  const existing = useGates.getState().gatesFor(sample.id).find(
    (g) => g.parentId === cellsId && g.kind === 'polygon' && g.xParam === x && g.yParam === y,
  );
  if (existing) return existing.id;

  const traced = scatterPolygon(sample, x, y, SINGLET_GATE_COVERAGE, gatedEvents(sample, cellsId));
  if (!traced) return null;

  const gate: Gate = {
    id: nextGateId(),
    name: SINGLET_GATE_NAME,
    parentId: cellsId,
    colorIndex: 4,
    // Shared or per-sample exactly as the *Cells* gate is, and set from the same
    // flag: a panel whose cells are traced per file wants its doublet cut traced
    // per file too, and one whose cells are one shape wants one cut. Two gates
    // placed by one step answering the same question two ways is a state nobody
    // asked for. See `traceSingletInto` for the other half.
    linked: shared,
    kind: 'polygon',
    xParam: x,
    yParam: y,
    vertices: traced.vertices,
    xSpec: traced.xSpec,
    ySpec: traced.ySpec,
  };
  useGates.getState().addGate(sample.id, gate);
  return gate.id;
}

/**
 * Trace this sample's own doublet cut into its override of the shared one.
 *
 * The singlet counterpart of the polygon `buildLiveGates` writes for the cell
 * gate, and it is a function rather than a third copy of the same seven lines
 * because three call sites need it to be identical: the build, the bulk
 * *one-each* toggle, and the per-row one.
 *
 * Traced **inside this sample's own cells**, which is why the cell gate's
 * override has to be written before this runs — a doublet cut placed over the
 * whole file's scatter would sit around the debris as well.
 */
function traceSingletInto(sample: Sample, gateId: string, cellsId: string | null): void {
  const x = scatterParam(sample, 'FSC');
  const y = heightParam(sample, 'FSC');
  if (y === null) return;
  const traced = scatterPolygon(sample, x, y, SINGLET_GATE_COVERAGE, gatedEvents(sample, cellsId));
  if (!traced) return;
  const current = useGates.getState().gatesFor(sample.id).find((g) => g.id === gateId);
  if (!current) return;
  useGates.getState().updateGate(sample.id, gateId, {
    ...current,
    kind: 'polygon',
    xParam: x,
    yParam: y,
    vertices: traced.vertices,
    xSpec: traced.xSpec,
    ySpec: traced.ySpec,
  } as Partial<Gate>);
}

/**
 * Move already-fitted population gates onto the population the fit is now read
 * inside, and say how many moved.
 *
 * ## The bug (2026-08-22)
 *
 * Reported as the *Live* / *Dead* split still being absent from the cell-type
 * worksheet's trace plot — the same words as the report `rangeAxisOn` was
 * written for, and a different cause, which is why it survived that fix and the
 * harness check that came with it.
 *
 * A panel scoped to a population draws **its children and nothing else**
 * (`panels/panelGates.ts`). From 2026-08-21 the trace is scoped to *Singlets*,
 * because that is where viability is read. A workspace fitted before that — or
 * any run that reached Step 5 with a fit made while `singletGateId` was null —
 * carries a split parented to *Cells*, one level above the plot's scope. So the
 * gates exist, evaluate, count in the tree and appear in Statistics, and the
 * plot filters every one of them out. An empty plot, and nothing anywhere says
 * why.
 *
 * `fitSample` already refuses to *reuse* a set parented elsewhere, so Step 4
 * heals itself by rebuilding. Steps 3 and 5 do not re-fit, and telling somebody
 * to re-run a fit they have already adjusted is not a fix. This moves them
 * instead, which is exactly the correction and loses nothing: a range gate's
 * interval is a number on the property's axis and means the same thing whichever
 * population it cuts. What changes is the denominator — the split is now a
 * percentage of the singlets, which is the reading that was asked for.
 *
 * Through `reparentGate` rather than `updateGate`: these gates are `linked:
 * false`, and an unlinked gate's `updateGate` writes to that sample's override,
 * where `resolveGates` never reads parentage from. The parent lives on the one
 * shared definition, so one call per gate id settles it for every sample.
 */
function reparentPopulations(records: readonly BiophysicsSample[], parentId: string | null): number {
  if (!parentId) return 0;
  let moved = 0;
  const seen = new Set<string>();
  for (const rec of records) {
    for (const id of rec.populationGateIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const g = useGates.getState().gatesFor(rec.sampleId).find((x) => x.id === id);
      // A gate that is already in the right place, or that no longer exists
      // because somebody deleted the population, is not this function's business.
      if (!g || g.parentId === parentId || g.id === parentId) continue;
      useGates.getState().reparentGate(rec.sampleId, id, parentId);
      moved++;
    }
  }
  return moved;
}

/** A height channel by name — `FSC-H` for the singlet plot. Null when absent. */
function heightParam(sample: Sample, want: 'FSC' | 'SSC'): number | null {
  const params = sample.parsed.metadata.parameters;
  const hit = params.findIndex((p) => p.name.toUpperCase() === `${want}-H`);
  return hit >= 0 ? hit : null;
}

/** The acquisition clock, or FSC-A when the file carries none. */
function timeParam(sample: Sample): number {
  const i = timeParameterIndex(sample.parsed.metadata);
  return i >= 0 ? i : scatterParam(sample, 'FSC');
}

/* -------------------------------------------------------------------------
   The store
   ------------------------------------------------------------------------- */

const initial = defaultSelection();

export const useBiophysics = create<BiophysicsState>((set, get) => ({
  step: 1,
  mode: 'single',
  cellGateShared: false,
  propertyId: initial.propertyId,
  probeId: initial.probeId,
  channels: null,
  channelsTouched: false,
  parameterId: null,
  liveGateId: null,
  singletGateId: null,
  samples: [],
  walkIndex: 0,

  setStep(step) { set({ step: clampStep(get().mode, step) }); },

  setMode(mode) {
    const was = get();
    if (mode === was.mode) return;
    /*
       Where the new mode opens.

       Two rules, and the first is the one that matters. **Switching mode at the
       start of a pipeline starts the new pipeline** — someone on Step 1 who says
       "actually these are PBMCs" is told about the unmixing prerequisite, which
       is the entire reason multi mode has a step before Step 1. Clamping alone
       left them on Cells, having chosen a mode whose first instruction they
       never saw.

       Otherwise the step is clamped and the work is kept: switching at Step 3
       stays on Step 3, and coming back from Step 5 lands on Populations rather
       than on a step this mode does not list.
    */
    const atTheStart = was.step === firstStep(was.mode);
    set({
      mode,
      step: atTheStart ? firstStep(mode) : clampStep(mode, was.step),
    });
    /*
       The mode's own default for the cell gate, applied to the gates and not
       only written as a flag.

       A mixture of cell types is one experiment across its files and wants one
       shape; a single cell type is tubes of one preparation and wants a shape
       each. Switching mode is switching experiment, so it is the right moment
       to reset this, and the per-row control is how somebody says otherwise
       afterwards.

       **Applied here as well as seeded in `buildLiveGates`**, which is the
       correction of the trap this already produced once: Step 1 places its gates
       from a mount effect, so by the time the mode changes the shapes usually
       exist, and a build that only ran when something was *missing* never came
       back to reconcile them. `setCellGateShared` is a no-op when there is no
       gate yet.
    */
    get().setCellGateShared(mode === 'multi', useWorkspace.getState().samples);
  },

  setProperty(propertyId) {
    const property = propertyById(propertyId);
    set({
      propertyId,
      // A probe belongs to a property, so changing the property invalidates the
      // choice under it. Auto-selected when there is exactly one, for the reason
      // `defaultSelection` gives: a list of one is not a guess.
      probeId: property?.probes.length === 1 ? property.probes[0]!.id : null,
      // Detectors chosen for the old property's bands say nothing about the new
      // one's. Cleared with the probe that gave them meaning — and so is the
      // record of having chosen them, so the new probe may offer its own match.
      channels: null,
      channelsTouched: false,
      // The parameter belongs to the old property. Cleared rather than deleted:
      // somebody may have gated on it, and a definition the user can see in the
      // Parameters panel is theirs to remove.
      parameterId: null,
    });
  },

  // Same reasoning one level down: the pair belongs to the probe it was chosen
  // for, so a different dye starts from that dye's own bands.
  setProbe(probeId) { set({ probeId, channels: null, channelsTouched: false, parameterId: null }); },

  // Both of these are a person acting on the pair, so both raise the flag: one
  // states a pair, the other states that the probe's own is the wanted one. See
  // `channelsTouched` for why the second is not the same as never having chosen.
  setChannels(a, b) { set({ channels: [a, b], channelsTouched: true, parameterId: null }); },

  resetChannels() { set({ channels: null, channelsTouched: true, parameterId: null }); },

  recordFor(sampleId) { return get().samples.find((s) => s.sampleId === sampleId); },

  missingChannels(sample) {
    const preset = pipelinePreset(get());
    if (!preset || !sample) return [];
    const names = sample.parsed.metadata.parameters.map((p) => p.name);
    if (parseExpression(preset.expression, names).ok) return [];

    /*
       Which channels the expression *wanted*, asked of the parser rather than
       read out of its error message.

       `parseExpression` needs the known names before it can tokenise — detector
       names contain the minus sign, so the lexer matches the longest known name
       at each position — which means it cannot report what an expression
       references on a file that has none of them. Handing it the file's names
       *and* the identifier-shaped fragments of the preset lets it tokenise, and
       `references` is then the exact list, resolved by the same rule the real
       parse uses rather than by a second one written here.
    */
    const parsed = parseExpression(preset.expression, referencedNames(preset.expression, names));
    if (!parsed.ok) return [];
    const have = new Set(names.map((n) => n.toLowerCase()));
    return parsed.references.filter((r) => !have.has(r.toLowerCase()));
  },

  suggestedChannels(sample) {
    if (!sample) return null;
    const s = get();
    const property = propertyById(s.propertyId);
    const probe = probeById(property, s.probeId);
    const names = sample.parsed.metadata.parameters.map((p) => p.name);
    return channelsForDetectors(probe, names) ?? null;
  },

  suggestChannels(sample) {
    // A pair already stands, or somebody has decided the probe's own is the one
    // they want. Either way it is not this function's to replace.
    if (get().channels || get().channelsTouched) return;
    const pair = get().suggestedChannels(sample);
    if (!pair) return;
    set({ channels: [pair[0], pair[1]], parameterId: null });
  },

  stepCheck() {
    const s = get();
    const samples = useWorkspace.getState().samples;
    const property = propertyById(s.propertyId);
    const first = samples[0];
    const missing = s.missingChannels(first);
    return checkBiophysicsStep(s.step, {
      sampleCount: samples.length,
      gated: s.liveGateId !== null,
      propertyId: s.propertyId,
      probeId: s.probeId,
      parameterResolves: !!property && missing.length === 0,
      missing,
      built: s.samples.filter((r) => r.layoutId).length,
      unmixedSamples: s.unmixedSampleCount(samples),
      immuneBuilt: s.samples.filter((r) => r.immuneLayoutId).length,
    });
  },

  next(samples) {
    const s = get();
    if (!s.stepCheck().ok) return;
    /*
       Each step runs its own work on the way *out* of the step before it, which
       is the shape the unmixing wizard settled on and is worth stating: the work
       belongs to the transition, so pressing Next twice cannot run it twice (the
       panel covers the step while it runs) and arriving at a step by another
       route — the tracker, an undo — finds it already done.
    */
    // Step 0 carries no work of its own. Unmixing happens in the Unmixing panel,
    // which is the point of the step — it routes there rather than modelling it.
    if (s.step === 0) { set({ step: 1 }); return; }
    if (s.step === 1) { set({ step: 2 }); return; }
    if (s.step === 2) {
      get().ensureParameter();
      get().buildDistributions(samples);
      set({ step: 3 });
      return;
    }
    if (s.step === 3) {
      get().fitAll(samples);
      set({ step: 4, walkIndex: 0 });
      const first = get().samples[0]?.layoutId;
      if (first) usePlot.getState().switchLayout(first);
      return;
    }
    // Only multi mode has anywhere to go from Step 4. The worksheets are built
    // on arrival at Step 5 if markers are already chosen — the same "work
    // belongs to the transition" rule the steps above follow — and by the Build
    // button otherwise, because there is nothing to build without markers.
    if (s.step === 4 && s.mode === 'multi') {
      set({ step: 5, walkIndex: 0 });
      // Unconditionally now: the worksheet is the same three plots whatever the
      // panel holds, so there is nothing left to choose before it can be built.
      get().buildImmuneWorksheets(samples);
      const first = get().samples[0]?.immuneLayoutId;
      if (first) usePlot.getState().switchLayout(first);
    }
  },

  back() {
    const s = get();
    const to = prevStep(s.mode, s.step);
    if (to !== s.step) set({ step: to });
  },

  reset() {
    // Gates, worksheets and the parameter are left alone — somebody drew those,
    // and the parameter is now an ordinary definition in the Parameters panel.
    // The same rule as the unmixing wizard's *Start over*. The mode is left
    // alone too: it describes the experiment, not the progress through it.
    // `discardSetup` is the other offer, for when they should all go.
    set({ step: firstStep(get().mode), walkIndex: 0 });
  },

  /**
   * Remove everything this pipeline made, and hand the workspace back.
   *
   * ## Why this exists (2026-08-28)
   *
   * *Start over* deliberately keeps the gates and the worksheets, which is right
   * when you are re-running a pipeline on the same experiment and wrong when you
   * are trying to get rid of one. Until now there was no second answer: a
   * pipeline started by accident could only be undone at the moment it happened,
   * and the reported workaround was **removing every sample and re-importing**.
   *
   * Everything removed here is something the store already tracks by id, so
   * there is no marker to add and nothing is identified by guesswork — which is
   * the difference from the unmixing wizard, whose gates need `Gate.reference`
   * precisely because it does not record them individually.
   *
   * **One `step`, so one Ctrl+Z brings all of it back.** That is what makes a
   * destructive button safe to offer, and it is why the whole thing is written
   * as a single compound action rather than as a sequence the user could be left
   * halfway through.
   *
   * What is **kept**: `mode`, `propertyId`, `probeId` and `channels`. Those are
   * choices about the experiment rather than artefacts in the workspace, and
   * somebody who discards and starts again wants the same probe.
   */
  discardSetup() {
    const before = get();
    if (!before.liveGateId && before.samples.length === 0) return { gates: 0, worksheets: 0 };

    return step('Discard biophysics setup', () => {
      const s = get();

      /*
         Gates, as one set rather than one at a time.

         Order does not matter to `removeGates` — it re-parents the survivors
         against the whole set at once, so a population gate under *Cells* when
         both are going lifts to the root rather than to a gate that is also
         leaving. What it does mean is that a gate the **operator** drew under
         *Cells* survives, at the root: `removeGate` and this take the same view
         that losing a subtree to one press is not recoverable, and that subtree
         is not hypothetical — an unscoped gate nests under whatever is selected
         in the tree, and *Cells* at the root is exactly what tends to be.
      */
      const doomed = new Set<string>();
      for (const r of s.samples) for (const id of r.populationGateIds) doomed.add(id);
      if (s.singletGateId) doomed.add(s.singletGateId);
      if (s.liveGateId) doomed.add(s.liveGateId);
      const gates = useGates.getState().removeGates(doomed);

      /*
         Worksheets: the pipeline's own, by the marker that already distinguishes
         them, plus the one cell-type sheet — which belongs to no sample's
         `layoutId` and would otherwise be the one thing left behind. Same two
         sources the orphan sweep in `buildLiveGates` reads.
      */
      const mine = new Set<string>();
      for (const l of usePlot.getState().allLayouts()) if (l.kind === 'biophysics') mine.add(l.id);
      for (const r of s.samples) if (r.immuneLayoutId) mine.add(r.immuneLayoutId);

      /*
         `removeLayout` refuses to remove the last layout, and rightly — a
         workspace with nowhere to draw is not a state to leave somebody in. If
         every worksheet is one of ours, make a general one first so there is
         something to land on, which is also what the user is asking for: their
         workspace back, not an empty panel.
      */
      if (mine.size >= usePlot.getState().allLayouts().length) usePlot.getState().addLayout();
      for (const id of mine) usePlot.getState().removeLayout(id);

      /*
         The derived parameter, which is the aggressive part and is deliberate.
         The offer is "no trace"; leaving *Membrane order* behind in the
         Parameters panel after it would be a puzzle rather than a courtesy. It
         is named in the confirmation before this runs, and it comes back with
         everything else on undo.
      */
      if (s.parameterId) useDerived.getState().removeDef(s.parameterId);

      // The fits are a module-level cache keyed by sample id, cleared the same
      // way `onWorkspaceCleared` clears it.
      fitDistributions.clear();

      set({
        step: firstStep(s.mode),
        samples: [],
        liveGateId: null,
        singletGateId: null,
        parameterId: null,
        walkIndex: 0,
      });

      return { gates, worksheets: mine.size };
    });
  },

  /* ---------------------------------------------------------------------
     Step 0 and Step 5 — multi mode
     --------------------------------------------------------------------- */

  unmixedSampleCount(samples) {
    const unmixed = useSpectral.getState().unmixed;
    return samples.filter((s) => unmixed[s.id]).length;
  },

  pipelineSamples(samples) {
    const unmixed = useSpectral.getState().unmixed;
    const carrying = new Set(samples.filter((s) => unmixed[s.id]).map((s) => s.id));
    const keep = new Set(pipelineSampleIds(get().mode, samples.map((s) => s.id), carrying));
    return samples.filter((s) => keep.has(s.id));
  },

  immuneLayoutId() {
    const id = get().samples.find((r) => r.immuneLayoutId)?.immuneLayoutId ?? null;
    if (!id) return null;
    // A worksheet the user deleted leaves a stale id behind on every record —
    // the same check `buildImmuneWorksheets` makes before reusing one.
    return usePlot.getState().allLayouts().some((l) => l.id === id) ? id : null;
  },

  buildImmuneWorksheets(samples) {
    const scoped = get().pipelineSamples(samples);
    if (scoped.length === 0) return 0;

    const property = propertyById(get().propertyId);
    const parameterId = get().parameterId;

    step('Build the cell-type worksheet', () => {
      const index = Math.min(Math.max(0, get().walkIndex), scoped.length - 1);
      const showing = scoped[index]!;

      /*
         Idempotent, like `buildLiveGates`. A worksheet that still exists is
         reused and its panels rewritten, rather than a second one being made
         beside it — the duplicate-worksheet defect the unmixing panel shipped
         twice. `immuneLayoutId()` is what checks the id is still a real layout.
      */
      const layoutId = get().immuneLayoutId()
        ?? usePlot.getState().addLayout(IMMUNE_WORKSHEET_NAME, 'biophysics');

      usePlot.getState().renameLayout(layoutId, IMMUNE_WORKSHEET_NAME);
      usePlot.getState().markLayoutKind(layoutId, 'biophysics');
      usePlot.getState().switchLayout(layoutId);

      /*
         The doublet cut, before the plots are placed — so the worksheet arrives
         with a strategy on it rather than with an empty second panel.

         Step 1 has normally traced it already, since the fit is read inside it;
         this finds that one. It stays here for the sample set that reached Step
         5 without it — a workspace written before Step 1 traced one, where
         re-entering Step 1 is not something the user should have to be told to
         do.
      */
      const singletId = get().singletGateId ?? ensureSingletGate(showing, get().liveGateId);
      if (singletId && singletId !== get().singletGateId) set({ singletGateId: singletId });

      // Any split fitted before viability moved inside the cut is moved onto it,
      // or the plot below scopes past it and draws nothing. See
      // `reparentPopulations` for the report this answers.
      reparentPopulations(get().samples, singletId ?? get().liveGateId);

      const panels = immunePanelsForSample(
        showing,
        get().liveGateId,
        singletId,
        parameterIndexOf(showing, parameterId),
        property?.axis ?? null,
      );
      usePlot.getState().setPanels(panels, panels[0]?.id);

      // The same id on every record in the pipeline's set: they all read this
      // worksheet, one at a time.
      const inSet = new Set(scoped.map((x) => x.id));
      const records = [...get().samples];
      for (const x of scoped) {
        if (!records.some((r) => r.sampleId === x.id)) records.push(emptySample(x.id));
      }
      set({
        walkIndex: index,
        samples: records.map((r) => (inSet.has(r.sampleId) ? { ...r, immuneLayoutId: layoutId } : r)),
      });

      // The browser agrees with the sheet from the moment it is built. It also
      // has to: the sheet follows that selection from here on, so leaving the
      // two disagreeing would have the worksheet jump one sample on arrival.
      // See `showImmuneSample` and `BiophysicsWalkBar`.
      useWorkspace.getState().selectSample(showing.id);
    });
    return 1;
  },

  showImmuneSample(samples, index) {
    const scoped = get().pipelineSamples(samples);
    if (scoped.length === 0) return;
    const at = Math.min(Math.max(0, index), scoped.length - 1);
    const target = scoped[at]!;
    const layoutId = get().immuneLayoutId();
    if (!layoutId) { set({ walkIndex: at }); return; }

    usePlot.getState().switchLayout(layoutId);

    /*
       The panels are re-pointed, not rebuilt.

       Everything about the worksheet except which file it reads is the gating
       strategy — the pairs, the positions, the axes, the scope, and any plot the
       user added themselves — so replacing it per sample would throw their work
       away on every step of the walk. Rewriting `sampleId` keeps all of it and
       changes the one thing that is meant to change.

       `initialisedFor` moves with it. A panel whose axes were chosen for another
       sample would otherwise be re-initialised on mount and pick its own, which
       is the mechanism that exists to stop a fresh panel opening on Time.

       Coalesced, so walking six samples is one undo step rather than six.
    */
    step('Show a sample on the cell-type worksheet', () => {
      const panels = usePlot.getState().panels.map((p) => ({
        ...p, sampleId: target.id, initialisedFor: target.id,
      }));
      usePlot.getState().setPanels(panels, usePlot.getState().activePanelId);
    }, 'biophysics-immune-sample');

    /*
       And the sample browser follows (2026-08-19).

       The browser is one of the three ways to move this walk — see
       `BiophysicsWalkBar` — so the arrows and the tab strip have to leave it
       where they leave the worksheet, or the next click on the list is measured
       from a sample nobody is looking at. It is also what the gate tree beneath
       the browser is about: every population on this sheet is gated through that
       tree, and it was reading another file's percentages.

       Outside the `step` above: which sample is selected is not part of the
       analysis, and an undo that put the plots back should not also move the
       cursor in a list.
    */
    useWorkspace.getState().selectSample(target.id);

    set({ walkIndex: at });
  },

  /* ---------------------------------------------------------------------
     Step 1 — the live-cell gate
     --------------------------------------------------------------------- */

  buildLiveGates(all) {
    // The pipeline's own set, so multi mode gates the unmixed samples and leaves
    // the single-stain controls alone. See `pipelineSampleIds`.
    const samples = get().pipelineSamples(all);
    if (samples.length === 0) return { built: 0, message: 'No samples are loaded.' };

    let liveGateId = get().liveGateId;
    const existing = useGates.getState().shared.find((g) => g.id === liveGateId);

    // Traced before anything is recorded, so a file with no scatter to trace
    // leaves no empty step on the undo stack for the user to press Ctrl+Z
    // through.
    const coverage = cellCoverageFor(get().mode);
    const first = samples[0]!;
    const firstTrace = existing
      ? null
      : scatterPolygon(first, scatterParam(first, 'FSC'), scatterParam(first, 'SSC'), coverage);
    if (!existing && !firstTrace) {
      return { built: 0, message: `${first.name} has no scatter data to trace a gate around.` };
    }

    // One step for the whole build, through `step` rather than `record`: it
    // creates a gate, a boundary per sample, a layout per sample and a panel in
    // each — every one of which records on its own — and undoing it has to put
    // all of that back at once rather than in twenty presses.
    const shared = get().cellGateShared;
    // Which samples have already been through Step 1. Read before anything is
    // written, because the seeding loop below asks it and the worksheet loop
    // rewrites it.
    const previous = new Map(get().samples.map((r) => [r.sampleId, r]));

    return step('Place live-cell gates', () => {
    if (!existing) {
      const x = scatterParam(first, 'FSC');
      const y = scatterParam(first, 'SSC');
      const traced = firstTrace!;
      /*
         `linked: false` from the moment it is created, and no `reference` flag.

         Unlinked because the noise floor and the debris corner move between
         files and this gate is the one that has to follow them — the case
         `linked` exists for. Not `reference` because this is analysis: it is the
         population every number downstream is a percentage of, so it belongs in
         the Analysis tab's gate tree, in Statistics and in Export exactly like a
         gate somebody drew. The unmixing wizard's brackets are the opposite case
         and carry the opposite flag.
      */
      const gate: Gate = {
        id: nextGateId(),
        name: CELL_GATE_NAME,
        parentId: null,
        colorIndex: 0,
        // `linked` is the mechanism behind `cellGateShared`: linked means the one
        // shape applies everywhere, unlinked means each sample carries its own in
        // `overrides`. See the field's own note for which mode wants which.
        linked: shared,
        kind: 'polygon',
        xParam: x,
        yParam: y,
        vertices: traced.vertices,
        xSpec: traced.xSpec,
        ySpec: traced.ySpec,
      };
      useGates.getState().addGate(first.id, gate);
      liveGateId = gate.id;
    } else if (existing.linked !== shared
      && Object.keys(useGates.getState().overrides[liveGateId!] ?? {}).length === 0) {
      /*
         A gate placed under the other scope, and carrying no shapes of its own.

         With no overrides, linked and unlinked resolve identically, so matching
         the flag to the default costs nothing and stops the gate tree reporting
         a per-sample gate that no sample has taken up.

         **Only in that state.** An override is a per-row statement somebody
         made on this screen, and a build that ran because a *seventh file was
         imported* must not answer it by re-sharing the other six. `setMode` is
         where a wholesale change of scope is applied, because that is where the
         experiment changed.
      */
      useGates.getState().setGateLinked(first.id, liveGateId!, shared);
    }

    /* ---- A boundary per sample, traced from that sample's own scatter ---- */
    /*
       The gate is unlinked, so `updateGate` writes to this sample's own override
       rather than to the shared shape — which means each sample can be given the
       polygon traced around *its* cloud without any of them moving the others.

       Only where there is no override yet. A boundary somebody has dragged is
       never re-traced, which is the rule every seeded gate in this application
       follows and the reason re-entering a step is safe.

       Skipped entirely when the gate is shared: there is one shape, traced from
       the first sample, and writing an override per sample is exactly what
       "shared" means it must not do.

       And skipped for a sample that has already been through this step, whose
       scope is now whatever the per-row control on Step 1 says it is. Only a
       sample arriving for the first time takes the default — which is what makes
       importing a seventh file safe to do mid-pipeline.
    */
    for (const sample of shared ? [] : samples) {
      if (previous.has(sample.id)) continue;
      if (useGates.getState().overrides[liveGateId!]?.[sample.id]) continue;
      const x = scatterParam(sample, 'FSC');
      const y = scatterParam(sample, 'SSC');
      const traced = scatterPolygon(sample, x, y, coverage);
      if (!traced) continue;
      const current = useGates.getState().gatesFor(sample.id).find((g) => g.id === liveGateId);
      if (!current) continue;
      useGates.getState().updateGate(sample.id, liveGateId!, {
        ...current,
        kind: 'polygon',
        xParam: x,
        yParam: y,
        vertices: traced.vertices,
        xSpec: traced.xSpec,
        ySpec: traced.ySpec,
      } as Partial<Gate>);
    }

    /* ---- The doublet cut, in multi mode only ---- */
    /*
       Traced here rather than on Step 5, because from Step 3 on the fit is read
       inside it — see `singletGateId`. `ensureSingletGate` finds one by what it
       is before it makes one, so re-entering this step never replaces a cut
       somebody has dragged, and Step 5 finds this one rather than seeding a
       second.

       From the first sample, like the cell gate: it is shared and linked, so one
       trace is the experiment's cut and the walk is what checks it. A file with
       no `FSC-H` returns null and the whole thing falls back to reading
       viability inside *Cells*, which is what single mode does anyway.
    */
    const singletGateId = get().mode === 'multi'
      ? ensureSingletGate(first, liveGateId, shared)
      : null;

    // And a cut each where the cells are traced each, in the same state and for
    // the same reason. Skipped for a sample that has been through this step
    // before, exactly as the cell loop above skips it.
    for (const sample of shared || !singletGateId ? [] : samples) {
      if (previous.has(sample.id)) continue;
      if (useGates.getState().overrides[singletGateId!]?.[sample.id]) continue;
      traceSingletInto(sample, singletGateId!, liveGateId);
    }

    /* ---- A worksheet per sample ---- */
    const property = propertyById(get().propertyId);
    const parameterId = get().parameterId;
    const names = uniqueWorksheetNames(samples.map((s) => s.name));
    const plot = usePlot.getState();
    const built: BiophysicsSample[] = [];

    samples.forEach((sample, i) => {
      const prior = previous.get(sample.id) ?? emptySample(sample.id);
      const reusing = !!prior.layoutId && plot.allLayouts().some((l) => l.id === prior.layoutId);
      const layoutId = reusing ? prior.layoutId! : usePlot.getState().addLayout(names[i], 'biophysics');
      usePlot.getState().renameLayout(layoutId, names[i]!);
      usePlot.getState().markLayoutKind(layoutId, 'biophysics');
      usePlot.getState().switchLayout(layoutId);

      const panels = panelsForSample(
        sample,
        liveGateId,
        singletGateId ?? liveGateId,
        parameterIndexOf(sample, parameterId),
        property?.axis ?? null,
      );
      usePlot.getState().setPanels(panels, panels[0]?.id);
      built.push({ ...prior, layoutId });
    });

    set({ samples: built, liveGateId, singletGateId, walkIndex: 0 });

    /* ---- Worksheets with no sample left to belong to ---- */
    /*
       The same reconciliation `buildGatingLayouts` performs, and it is here for
       the same reason: this build **reuses** a sample's existing worksheet and
       **creates** one for a sample that has none, so a worksheet whose sample has
       been removed would otherwise sit in the layout list belonging to nothing —
       and re-importing that file would build it a second one under the same
       name. That defect cost two passes in the unmixing panel; it is not being
       rediscovered here.

       Scoped to `kind === 'biophysics'`, so a general layout and the wizard's own
       reference worksheets are never this function's to remove.

       **The cell-type worksheet is kept**, and it has to be named here because
       it is `kind: 'biophysics'` and belongs to no sample's `layoutId`. Without
       it, re-entering Step 1 after building the cell-type sheet deleted the
       sheet and every gate drawn on it.
    */
    const keep = new Set<string | null>(built.map((r) => r.layoutId));
    for (const r of get().samples) if (r.immuneLayoutId) keep.add(r.immuneLayoutId);
    const orphans = usePlot.getState().allLayouts()
      .filter((l) => l.kind === 'biophysics' && !keep.has(l.id));
    for (const l of orphans) usePlot.getState().removeLayout(l.id);

    const firstLayout = built[0]?.layoutId;
    if (firstLayout) usePlot.getState().switchLayout(firstLayout);

    return { built: built.length };
    });
  },

  setCellGateShared(shared, all) {
    const gateId = get().liveGateId;

    // Nothing placed yet: the flag alone is enough, and `buildLiveGates` will
    // read it when it runs.
    if (!gateId) { set({ cellGateShared: shared }); return; }

    /*
       No early return on the flag already matching.

       It used to bail there, which was right while this was the only way to
       change scope and wrong the moment the per-row control existed: a panel
       with the flag on *shared* and one row switched to its own is a state
       where pressing *One for all* has real work to do, and a guard on the flag
       would have made the button do nothing exactly when it was needed.
    */
    const samples = get().pipelineSamples(all);
    const coverage = cellCoverageFor(get().mode);

    /*
       One undo step. Going either way writes the `linked` flag and then either
       drops every override or adds one per sample, and each of those records on
       its own — six presses of Ctrl+Z to reverse one toggle is the defect `step`
       exists for.
    */
    /*
       The doublet cut moves with the cells (2026-08-21).

       Step 1 places both in multi mode and the fit is read inside the second, so
       a panel with one shape for its cells and eight for its singlets is a state
       the control never offered and nobody could have meant. `null` in single
       mode, where there is no cut.
    */
    const singletId = get().singletGateId;

    step(shared ? 'Share the cell gate' : 'Gate each sample separately', () => {
      const anchor = samples[0];
      if (shared) {
        /*
           `setGateLinked(_, true)` drops the overrides itself, which is the
           whole of "one shape for every sample" — every sample now reads the
           shared polygon. Whichever shape is *in* the shared gate is the one
           they get; it is the first sample's trace unless somebody has since
           dragged it, and a dragged shape is never replaced here for the same
           reason `buildLiveGates` never re-traces one.
        */
        if (anchor) useGates.getState().setGateLinked(anchor.id, gateId, true);
        if (anchor && singletId) useGates.getState().setGateLinked(anchor.id, singletId, true);
      } else {
        if (anchor) useGates.getState().setGateLinked(anchor.id, gateId, false);
        if (anchor && singletId) useGates.getState().setGateLinked(anchor.id, singletId, false);
        // And a shape each, traced from that sample's own scatter — the same
        // seeding `buildLiveGates` does, so the two paths cannot differ. The
        // cells first, because the cut is traced inside them.
        for (const sample of samples) {
          if (useGates.getState().overrides[gateId]?.[sample.id]) continue;
          const x = scatterParam(sample, 'FSC');
          const y = scatterParam(sample, 'SSC');
          const traced = scatterPolygon(sample, x, y, coverage);
          if (!traced) continue;
          const current = useGates.getState().gatesFor(sample.id).find((g) => g.id === gateId);
          if (!current) continue;
          useGates.getState().updateGate(sample.id, gateId, {
            ...current,
            kind: 'polygon',
            xParam: x,
            yParam: y,
            vertices: traced.vertices,
            xSpec: traced.xSpec,
            ySpec: traced.ySpec,
          } as Partial<Gate>);
        }
        for (const sample of singletId ? samples : []) {
          if (useGates.getState().overrides[singletId!]?.[sample.id]) continue;
          traceSingletInto(sample, singletId!, gateId);
        }
      }
      set({ cellGateShared: shared });
    });
  },

  setSampleGateShared(sample, shared) {
    const gateId = get().liveGateId;
    if (!gateId) return;
    const gates = useGates.getState();
    const already = !!gates.overrides[gateId]?.[sample.id];
    if (already === !shared) return;
    // The doublet cut answers this row's question with the cells — see the note
    // in `setCellGateShared`.
    const singletId = get().singletGateId;

    step(shared ? 'Share this sample’s cell gate' : 'Give this sample its own cell gate', () => {
      if (shared) {
        // `clearGateOverride` re-links the gate when it removes the last
        // override, which is what makes "every sample shares" say so in the
        // tree — and what stops the next drag on any worksheet forking a shape
        // that nothing is asking to differ.
        useGates.getState().clearGateOverride(sample.id, gateId);
        if (singletId) useGates.getState().clearGateOverride(sample.id, singletId);
      } else {
        const current = useGates.getState().gatesFor(sample.id).find((g) => g.id === gateId);
        if (!current) return;
        // Unlinked first: `updateGate` routes a write to this sample's own
        // override only once the gate says it is per-sample.
        if (current.linked !== false) useGates.getState().setGateLinked(sample.id, gateId, false);
        const x = scatterParam(sample, 'FSC');
        const y = scatterParam(sample, 'SSC');
        const traced = scatterPolygon(sample, x, y, cellCoverageFor(get().mode));
        /*
           Its own scatter where there is one to trace, and the shape it was
           already reading where there is not. A file with no finite scatter
           still gets an override — the point of the control is that this
           sample's boundary is now its own to drag — it just starts from the
           shared polygon rather than from an invented one.
        */
        useGates.getState().updateGate(sample.id, gateId, {
          ...current,
          ...(traced ? {
            kind: 'polygon' as const,
            xParam: x,
            yParam: y,
            vertices: traced.vertices,
            xSpec: traced.xSpec,
            ySpec: traced.ySpec,
          } : {}),
        } as Partial<Gate>);
        // The cut, inside the cells this sample now owns — after them, so it is
        // traced around the shape that was just written rather than the one it
        // replaced.
        if (singletId) {
          const cut = useGates.getState().gatesFor(sample.id).find((g) => g.id === singletId);
          if (cut) {
            if (cut.linked !== false) useGates.getState().setGateLinked(sample.id, singletId, false);
            traceSingletInto(sample, singletId, gateId);
          }
        }
      }
      // The flag follows the gate. It is the default a *new* sample takes, and
      // `linked` is the gate's own statement of whether any sample has departed
      // from it — two names for one fact, so they are written together.
      const after = useGates.getState().shared.find((g) => g.id === gateId);
      set({ cellGateShared: after?.linked !== false });
    });
  },

  /* ---------------------------------------------------------------------
     Step 2 — the parameter
     --------------------------------------------------------------------- */

  ensureParameter() {
    const preset = pipelinePreset(get());
    if (!preset) return null;

    /*
       Reuse before create, matched on **name and equation together**.

       A workspace where somebody has already defined membrane order from the
       Parameters panel must not gain a second copy of it — two parameters of the
       same name computing the same thing is the duplicate-state defect this
       whole design is written against, and here it would also mean the export
       carrying two identical columns. Matching on the equation as well is what
       stops the reverse mistake: a parameter somebody has *renamed* to "Membrane
       order" while pointing it at a different pair of detectors is not this
       parameter, and adopting it would silently analyse the wrong channels.
    */
    const defs = useDerived.getState().defs;
    const hit = defs.find((d) => d.name === preset.name && d.expression === preset.expression);
    if (hit) { set({ parameterId: hit.id }); return hit.id; }

    /*
       A free name, which is only ever not the preset's own when the detectors
       have been re-pointed.

       The two rules above collide in exactly one case: a workspace already
       holding *Membrane order* over the published bands, whose owner then points
       this pipeline at their own. That is a second, different measurement and it
       needs a second definition — but `validateDefinition` refuses a duplicate
       name, so creating it as *Membrane order* would fail silently at Step 2 and
       leave the pipeline with no parameter. The name cannot carry the channels
       either: brackets and hyphens are rejected for the good reason that an
       equation referencing such a name would be ambiguous. So it counts, which
       is the ordinary thing a second one of something is called, and the
       equation underneath says which is which.
    */
    let name = preset.name;
    for (let n = 2; defs.some((d) => d.name.trim().toLowerCase() === name.toLowerCase()); n++) {
      name = `${preset.name} ${n}`;
    }

    // Through `addDef`, which is what the Parameters panel calls, so the
    // definition that lands in the workspace is byte-identical to the one that
    // panel's own preset row would have produced.
    const id = useDerived.getState().addDef(name, preset.expression);
    set({ parameterId: id });
    return id;
  },

  /* ---------------------------------------------------------------------
     Step 3 — the distribution
     --------------------------------------------------------------------- */

  buildDistributions(samples) {
    const s = get();
    const property = propertyById(s.propertyId);
    if (!property) return 0;
    const byId = new Map(samples.map((x) => [x.id, x]));

    // One step, for the same reason `buildLiveGates` is one: it rebuilds a
    // panel set per worksheet and every `setPanels` records.
    return step('Build distribution worksheets', () => {
      // Same reconciliation as Step 5, and for the same reason: the histogram
      // below is scoped to the population the fit is read inside, so a split
      // left parented above it would be counted and not drawn.
      reparentPopulations(s.samples, fitPopulationId(s));

      let built = 0;
      for (const rec of s.samples) {
        const sample = byId.get(rec.sampleId);
        if (!sample || !rec.layoutId) continue;
        const index = parameterIndexOf(sample, s.parameterId);
        if (index < 0) continue;
        usePlot.getState().switchLayout(rec.layoutId);
        const panels = panelsForSample(sample, s.liveGateId, fitPopulationId(s), index, property.axis);
        usePlot.getState().setPanels(panels, panels[0]?.id);
        built++;
      }

      const first = s.samples[0]?.layoutId;
      if (first) usePlot.getState().switchLayout(first);
      return built;
    });
  },

  /* ---------------------------------------------------------------------
     Step 4 — the fit, and the gates it produces
     --------------------------------------------------------------------- */

  fitSample(sample, k) {
    const s = get();
    const property = propertyById(s.propertyId);
    if (!property) return null;
    const index = parameterIndexOf(sample, s.parameterId);
    if (index < 0) return null;

    const prior = s.samples.find((r) => r.sampleId === sample.id) ?? emptySample(sample.id);

    // The parameter's own values, in data units, over the population the
    // live-cell gate selects. See `distributionFor`.
    const h = distributionFor(sample, s);
    if (!h) return null;

    /*
       How many components, and who decided.

       The same question in both schemes since 2026-08-21: BIC picks under the
       admissibility rules, the operator can overrule with a number, and *Auto*
       hands it back. The viability scheme used to fix it at two, and the thing
       that was protecting — a live cell type never being called a viability
       state — is `populationIntervals`' job and only ever was: however many modes
       the fit needs, **one** boundary is drawn, below the least ordered
       component, and everything above it is live. Fixing the count instead made
       one Gaussian cover the lymphocyte and monocyte modes together and dragged
       the split that matters down with it.
    */
    const scheme = schemeFor(s.mode);
    const maxComponents = maxComponentsFor(scheme);
    /*
       Never fewer than two under viability, and that is the half of the old
       rule that was load-bearing.

       The reading is live-against-dead: a one-component fit has no boundary and
       cannot express it, so *Auto* choosing one leaves a sample with a *Live*
       gate, no *Dead* gate and nothing for Step 5 to gate a cell type under.
       A single-population tube typically separates at 1.0 to 1.4 pooled SDs —
       under `MIN_SEPARATION`, so the rules refuse every split and BIC is never
       asked. A count somebody types by hand is still honoured,
       including 1: stating that a tube holds no dead cells is a judgement, and
       `MEMBRANE_ORDER_VIABILITY` has a name for it.
    */
    const minComponents = scheme === 'viability' ? 2 : 1;
    const forced = k != null;
    const selection = forced ? null : selectMixture(h, { maxComponents, minComponents });
    const fit: MixtureFit = forced
      ? fitFixed(h, Math.min(k!, maxComponents))
      : selection!.best;
    // Per **population**, not per component: a four-component viability fit has
    // two gates, and their shares are counted over the two intervals those gates
    // hold. See `populationIntervals`.
    const intervals = populationIntervals(fit, scheme);
    const stats = statsOverIntervals(h, intervals);
    // Kept so `moveBoundary` can recount without re-gating the sample. See
    // `fitDistributions`.
    fitDistributions.set(sample.id, h);

    /*
       Gates in **display space**, converted through the same spec the histogram
       draws with and the same one `evaluateFor` counts with.

       The fit works in data units because that is what the science is in — a
       membrane order of 0.44 is a number somebody reports — and a gate stores
       the coordinates the user drew in. For this parameter the two happen to
       coincide (a derived parameter is linear, and `LinearTransform.forward` is
       the identity), which is exactly why the conversion has to be here rather
       than assumed: the day a property arrives whose axis is not linear, the
       gates land in the right place and nothing else changes.
    */
    const spec = defaultSpecFor(sample.parsed, index);
    const tf = createTransform(spec);
    const toDisplay = (v: number) =>
      (Number.isFinite(v) ? tf.forward(v) : v);

    const names = populationNames(property, fit.components.length, scheme);
    /*
       One shared population gate per name, or one owned gate per sample.

       **Graded**: owned. Two samples with different component counts get
       differently *named* populations — *Internalised or dead* on a
       two-population sample, *Internalised / pre-apoptotic* and *Dead* on a
       three-population one — so they cannot be one definition without one of
       them carrying a name that is false for the file it is drawn on.

       **Viability**: shared, `linked: false`, a boundary per sample. Every
       sample has the same two populations with the same two names by
       construction — that is what one split buys, whatever each sample's fit
       needed to describe its live cells — so the reason for owning them is gone,
       and sharing them is what makes Step 5 possible: a cell-type gate drawn
       under *Cells/Singlets/Live* is then one gate that means the same thing on
       every file, rather than one gate per sample that has to be drawn eight
       times. The mechanism is the one the *Cells* gate already uses.
    */
    const sharedPopulations = scheme === 'viability';
    // Inside the doublet cut in multi mode, inside the cells in single. The same
    // population `distributionFor` binned, which is what makes the gate's
    // percentage a percentage of the events the fit was judged on.
    const parentId = fitPopulationId(s);

    /*
       One undo step for the whole re-fit, and it has to be one.

       A re-fit is several store writes — the old gates removed, the new ones
       added, the record replaced — and every one of them records on its own. Six
       presses of Ctrl+Z to reverse one press of a button, with the panel
       describing gates that were no longer there for five of them; measured as
       10 gates to 11 on the fit and back to 8 on the undo. `step` is the
       primitive for exactly this and the reasoning is on it.
    */
    const gateIds = step('Fit populations', () => {
      const ids: string[] = [];

      /*
         The shared case: the gates already exist, and only this sample's
         boundary is written.

         Re-creating them per sample would be wrong twice over — the ids would
         change under every cell-type gate parented to *Live*, and each sample's
         fit would overwrite the last one's boundary instead of carrying its own.
         `updateGate` on an unlinked gate writes that sample's override, which is
         the same write a drag on the worksheet performs.
      */
      if (sharedPopulations) {
        /*
           A usable set is one that is *shared* — unlinked, owned by nobody, and
           hanging under the population this fit was read inside.

           Checking only that the ids still exist was not enough: a graded fit's
           gates are in the same `shared` array, carrying `ownerSampleId`, so
           switching mode after fitting two populations in single mode would
           have adopted one sample's owned gates as the whole experiment's and
           written every other sample's boundary into a gate that does not apply
           to them.

           The parent is checked for the same class of reason (2026-08-21): a
           workspace fitted while viability was read inside *Cells* carries two
           gates that are shared, unlinked and in the wrong place, and reusing
           them would leave the split parented to *Cells* while the distribution
           behind it was binned inside *Singlets*. Failing the check drops
           through and builds a fresh set, which is the same path a mode switch
           takes.
        */
        const isSharedPopulation = (id: string) => {
          const g = useGates.getState().shared.find((x) => x.id === id);
          return !!g && g.linked === false && !g.ownerSampleId && g.parentId === parentId;
        };
        const existing = get().samples
          .map((r) => r.populationGateIds)
          .find((list) => list.length === intervals.length && list.every(isSharedPopulation));

        if (existing) {
          existing.forEach((id, i) => {
            const iv = intervals[i]!;
            useGates.getState().updateGate(sample.id, id, {
              min: toDisplay(iv.min), max: toDisplay(iv.max),
            } as Partial<Gate>);
            ids.push(id);
          });
          return ids;
        }
        // Nothing usable yet — anything this sample was carrying from a previous
        // scheme goes, and a fresh shared set is created below.
        for (const id of prior.populationGateIds) {
          if (useGates.getState().gatesFor(sample.id).some((g) => g.id === id)) {
            useGates.getState().removeGate(sample.id, id);
          }
        }
      } else {
        /*
           The old gates go before the new ones arrive.

           A re-fit that produced fewer populations would otherwise leave the
           extra gate behind — flagged as nothing in particular, owned by this
           sample, drawn on this histogram and counted in the tree — which is the
           duplicate-gate bug the unmixing wizard shipped and fixed on
           2026-08-13, arriving here by exactly the same route. `removeGate`
           re-parents anything underneath rather than dropping it, so a gate
           somebody drew inside a population survives the re-fit and lifts to the
           live-cell gate.
        */
        for (const id of prior.populationGateIds) {
          if (useGates.getState().gatesFor(sample.id).some((g) => g.id === id)) {
            useGates.getState().removeGate(sample.id, id);
          }
        }
      }

      // Created least ordered first, so the gate tree and Statistics list Dead →
      // Internalised → Live, left to right along the axis. `ids` stays indexed
      // by population, most ordered first, as every reader of the record expects.
      [...intervals.keys()].reverse().forEach((i) => {
        const iv = intervals[i]!;
        const gate: RangeGate = {
          id: nextGateId(),
          name: names[i]?.name ?? `Population ${i + 1}`,
          // A child of the population it was fitted inside, so its percentage is
          // a percentage of that rather than of the whole file.
          parentId,
          // By what the population is — see `populationColor`.
          colorIndex: populationColorIndex(i, intervals.length),
          color: populationColor(i, intervals.length),
          kind: 'range',
          xParam: index,
          xSpec: spec,
          /*
             This sample's own population, and the names are why.

             Two samples with different component counts get differently *named*
             populations — *Internalised or dead* on a two-population sample,
             *Internalised / pre-apoptotic* and *Dead* on a three-population one
             — so these cannot be one shared definition without one of them
             carrying a name that is false for the file it is drawn on.
             `ownerSampleId` says the gate means something on one file,
             `resolveGates` applies it, and every sample's *Live* still shares a
             path with every other's, which is what Statistics and Export match
             on.
          */
          // Owned in the graded scheme, shared and unlinked in the viability
          // one. See the note above `sharedPopulations`.
          ...(sharedPopulations
            ? { linked: false as const }
            : { ownerSampleId: sample.id }),
          min: toDisplay(iv.min),
          max: toDisplay(iv.max),
        };
        useGates.getState().addGate(sample.id, gate);
        /*
           The creating sample gets an override too, so every sample carries its
           own boundary rather than one of them living in the shared shape.

           Without it the first sample fitted is the odd one out: its split is
           the gate's default, so anything that later rewrites the default —
           a re-seed, a sibling window's snapshot — moves that one sample's
           population and no other. The *Cells* gate is seeded the same way and
           for the same reason.
        */
        if (sharedPopulations) {
          useGates.getState().updateGate(sample.id, gate.id, {
            min: gate.min, max: gate.max,
          } as Partial<Gate>);
        }
        ids[i] = gate.id;
      });

      return ids;
    });

    const next: BiophysicsSample = {
      ...prior,
      fit,
      // Where the fit put them, kept so a drag can be undone without re-fitting.
      // `fit.boundaries` is the live position from here on; this one never moves.
      fittedBoundaries: [...fit.boundaries],
      shares: stats.map((s) => s.share),
      means: stats.map((s) => s.mean),
      populationGateIds: gateIds,
      countSource: forced ? 'user' : 'fitted',
      overruledBic: !forced && selection ? !selection.byBic : false,
    };
    set((st) => ({
      samples: st.samples.some((r) => r.sampleId === sample.id)
        ? st.samples.map((r) => (r.sampleId === sample.id ? next : r))
        : [...st.samples, next],
    }));
    return next;
  },

  fitAll(samples, opts = {}) {
    const byId = new Map(samples.map((x) => [x.id, x]));
    let done = 0;
    for (const rec of get().samples) {
      const sample = byId.get(rec.sampleId);
      if (!sample) continue;
      /*
         A sample that has been fitted is left alone unless `force` says
         otherwise, and a count the operator stated is left alone even then.

         Same asymmetry as `ensureGated`: re-running the automatic choice over a
         decision somebody made is the application overwriting an answer rather
         than offering one. *Re-fit all* on the panel passes `force`, which is
         the explicit request, and it still respects `countSource: 'user'` —
         that is what the per-sample *Auto* button is for.
      */
      if (!opts.force && isFitted(rec)) continue;
      if (opts.force && rec.countSource === 'user') continue;
      if (get().fitSample(sample, null)) done++;
    }
    return done;
  },

  moveBoundary(sample, boundaryIndex, value) {
    const rec = get().samples.find((r) => r.sampleId === sample.id);
    if (!rec?.fit) return;
    const bounds = rec.fit.boundaries;
    if (boundaryIndex < 0 || boundaryIndex >= bounds.length) return;

    /*
       One boundary, two gates.

       The populations abut by construction — the fit divides the axis, it does
       not carve intervals out of it — so moving a split has to move both edges
       or the next drag opens a gap that quietly excludes events from every
       count under it. The gates are still ordinary range gates and are still
       individually draggable on the worksheet; what this adds is the gesture
       that treats the *boundary* as the thing being moved, which is what it is.

       Clamped between its neighbours so a boundary cannot be dragged past the
       one beside it and invert a population. An inverted range gate selects
       nothing, silently.
    */
    const lower = boundaryIndex > 0 ? bounds[boundaryIndex - 1]! : Number.NEGATIVE_INFINITY;
    const upper = boundaryIndex < bounds.length - 1 ? bounds[boundaryIndex + 1]! : Number.POSITIVE_INFINITY;
    const property = propertyById(get().propertyId);
    const lo = Math.max(lower, property?.axis.min ?? Number.NEGATIVE_INFINITY);
    const hi = Math.min(upper, property?.axis.max ?? Number.POSITIVE_INFINITY);
    const clamped = Math.min(hi, Math.max(lo, value));

    const nextBounds = [...bounds];
    nextBounds[boundaryIndex] = clamped;

    // Keyed by the boundary, so nudging one split and then another is two undo
    // steps while a whole drag of either is one.
    writeBoundaries(
      sample, rec, nextBounds,
      'Move population boundary', `biophysics-boundary:${sample.id}:${boundaryIndex}`,
    );
  },

  resetBoundaries(sample) {
    const rec = get().samples.find((r) => r.sampleId === sample.id);
    const original = rec?.fittedBoundaries;
    if (!rec?.fit || !original || original.length !== rec.fit.boundaries.length) return false;
    // Nothing to put back is not a failure, and a button that reports it moved
    // something when it did not is worse than a disabled one.
    if (original.every((v, i) => v === rec.fit!.boundaries[i])) return false;
    writeBoundaries(sample, rec, [...original], 'Reset the population splits');
    return true;
  },

  resetAllBoundaries(all) {
    const byId = new Map(all.map((s) => [s.id, s]));
    // One undo step for the whole reset, exactly like the apply it reverses.
    return step('Reset every sample’s splits', () => {
      let moved = 0;
      for (const rec of get().samples) {
        const sample = byId.get(rec.sampleId);
        if (sample && get().resetBoundaries(sample)) moved++;
      }
      return moved;
    });
  },

  applyLiveBoundary(all, sourceSampleId) {
    const scheme = schemeFor(get().mode);
    const source = get().samples.find((r) => r.sampleId === sourceSampleId);
    const at = source?.fit ? liveBoundaryIndex(source.fit.boundaries.length, scheme) : -1;
    if (!source?.fit || at < 0) return 0;
    const value = source.fit.boundaries[at]!;

    const byId = new Map(all.map((s) => [s.id, s]));
    const targets = get().samples.filter((r) => {
      if (r.sampleId === sourceSampleId || !r.fit) return false;
      return liveBoundaryIndex(r.fit.boundaries.length, scheme) >= 0 && byId.has(r.sampleId);
    });
    if (targets.length === 0) return 0;

    // One undo step for the whole application: `moveBoundary` records per
    // sample, and undoing "put this boundary everywhere" in eight presses is the
    // defect `step` exists for. No coalesce key — this is a button, not a drag.
    step('Apply the live boundary to every sample', () => {
      for (const rec of targets) {
        const sample = byId.get(rec.sampleId)!;
        get().moveBoundary(sample, liveBoundaryIndex(rec.fit!.boundaries.length, scheme), value);
      }
    });
    return targets.length;
  },

  goToSample(index) {
    const { samples } = get();
    const clamped = Math.min(samples.length - 1, Math.max(0, index));
    const target = samples[clamped];
    if (!target) return;
    set({ walkIndex: clamped });
    // Switching the layout is what the tab bar, the walk arrows and the layout
    // dropdown all ultimately do, which is what makes them one control rather
    // than three: `sampleIndexForLayout` reads the result back.
    if (target.layoutId) usePlot.getState().switchLayout(target.layoutId);
  },

  currentSampleIndex() {
    return sampleIndexForLayout(get().samples, usePlot.getState().activeLayoutId, get().walkIndex);
  },

  walkBy(delta) { get().goToSample(get().currentSampleIndex() + delta); },

  setAll(state) { set(state); },
}));

/**
 * Which boundary separates *Live* from everything below it, given how many
 * boundaries a sample's fit produced. `−1` when the fit found one population.
 *
 * `boundaries` ascends while `components` descends — the relationship
 * `moveBoundary` writes out in full — and the two schemes read the ends of that
 * ordering differently:
 *
 *   - **Graded**: the **last** boundary. Component 0 is the most ordered and is
 *     the population being separated out, so its lower edge is the top split.
 *   - **Viability**: the **first**. There is only one split that is a gate at
 *     all — everything above the least ordered component is live, however many
 *     components describe it — and it is that component's upper edge. See
 *     `populationIntervals`.
 *
 * They coincide at two components, which is every viability fit up to
 * 2026-08-21 and is why this took a count and no scheme.
 *
 * Stated once and exported because three places ask: the chart that labels it,
 * the button that copies it, and the store action behind the button.
 */
export function liveBoundaryIndex(
  boundaryCount: number,
  scheme: PopulationScheme = 'graded',
): number {
  if (boundaryCount <= 0) return -1;
  return scheme === 'viability' ? 0 : boundaryCount - 1;
}

/** True for a sample the pipeline has fitted. Re-exported so panels need one import. */
export { isFitted };

/**
 * The names an expression references, resolved against a real parameter list.
 *
 * `parseExpression` needs the list of known names *before* it can tokenise,
 * because detector names contain the minus sign and the tokeniser matches the
 * longest known name at each position. So asking "which names does this
 * expression use" on a file that lacks them needs the names supplied — which is
 * what this does, by handing the parser the preset's own literal channel names
 * alongside the file's. See `core/derived.ts`.
 */
function referencedNames(expression: string, fileNames: readonly string[]): string[] {
  // Anything that looks like a channel: letters, digits, dots and internal
  // hyphens. Deliberately generous — a false positive resolves against the file
  // and drops out, and the alternative is a second tokeniser.
  const found = expression.match(/[A-Za-z][A-Za-z0-9.]*(?:-[A-Za-z0-9.]+)*/g) ?? [];
  return [...new Set([...fileNames, ...found])];
}

/**
 * Everything here belongs to the sample set, so all of it goes when the samples
 * do.
 *
 * The parameter is the one thing deliberately **not** reset: it lives in
 * `useDerived`, which answers for itself, and it is an ordinary definition the
 * user can see and edit in the Parameters panel. `parameterId` is cleared so a
 * fresh import re-resolves rather than pointing at a definition that may have
 * been removed meanwhile.
 */
onWorkspaceCleared(() => {
  // The cache goes with the records it describes — a sample id is reusable, and
  // a stale distribution would recount the next experiment against the last.
  fitDistributions.clear();
  useBiophysics.setState({
    step: 1,
    // Back to single, unlike `reset`. A cleared workspace has no experiment for
    // the mode to describe, so leaving it on multi would open the next import
    // on an unmixing prerequisite for samples nobody has chosen yet.
    mode: 'single',
    cellGateShared: false,
      ...defaultSelection(),
    // The detectors belonged to the instrument whose files have just gone, and
    // so did any decision about them.
    channels: null,
    channelsTouched: false,
    parameterId: null,
    liveGateId: null,
    samples: [],
    walkIndex: 0,
  });
});
