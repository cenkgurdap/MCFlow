import type { DerivedParameterDef } from './derived';
import type { Gate } from './gating/types';
import type { UnmixingMatrixFile } from './unmixingFile';
import type { LayoutKind } from './layout/layoutKind';
import { PANEL_VIEW_DEFAULTS } from './layout/panelDefaults';

/* ==========================================================================
   Workspace serialisation.

   The workspace records *analysis*, not data: file paths, gates, derived
   parameters, the unmixing panel, transform choices and layout. Event data is
   re-read from the original .fcs files on load, which keeps a workspace file in
   the tens of kilobytes rather than hundreds of megabytes and means the source
   data stays the single source of truth.

   **v5 dropped the `compensation` block**, and compensation coming back on
   2026-08-27 does not bring it back. That block held a per-file matrix editor's
   own state, and there is no such editor now: a compensation matrix is the same
   object as an unmixing matrix, stored in the same place, so it round-trips
   through the spectral block with no field of its own and no version bump. A v4
   file's matrices and assignments are still read and discarded — they describe
   a model this application no longer has.
   ========================================================================== */

export const WORKSPACE_VERSION = 5;

/**
 * The extension a workspace saves as, **`mcflow` since 2026-08-03**.
 *
 * It was `fcws.json`, and the `.json` on the end was the problem: Windows hands
 * a `.json` file to whatever edits JSON, so double-clicking a saved analysis
 * opened a wall of text in Notepad rather than the application that wrote it.
 * The contents are still JSON and still readable as such — what changed is that
 * the file now says which program owns it, which is the only thing an extension
 * is for.
 *
 * The **format** is unchanged; this is not a version bump. See
 * `WORKSPACE_FILTERS` for how an older file still opens.
 */
export const WORKSPACE_EXTENSION = 'mcflow';

/** The extension every workspace saved before 2026-08-03 carries. */
export const LEGACY_WORKSPACE_EXTENSION = 'fcws.json';

/**
 * What the open dialog offers, newest first.
 *
 * Both are listed rather than only the new one, because a workspace saved last
 * week is not less of a workspace: `parseWorkspace` reads a `.fcws.json` exactly
 * as it always did — the change is in what a *save* produces, not in what a load
 * accepts. `json` is included in the first filter's extension list for the same
 * reason: a `.fcws.json` is matched by it, so the default filter opens
 * everything rather than hiding the user's own history behind a dropdown.
 */
export const WORKSPACE_FILTERS = [
  { name: 'MCFlow workspace', extensions: ['mcflow', 'json'] },
  { name: 'All files', extensions: ['*'] },
];

export interface WorkspaceSampleRef {
  id: string;
  name: string;
  fileName: string;
  /** Absolute path; null when the file arrived via drag-drop in a browser. */
  filePath: string | null;
  /**
   * The same file, relative to the workspace file's own folder, with `/`
   * separators — or absent.
   *
   * Written since 2026-10-28 so a workspace still finds its data after the
   * folder holding both was moved, copied to another machine, or opened on the
   * other operating system, where the absolute path cannot exist at all
   * (`core/workspacePaths.ts`). Absent on an older file and on a sample that
   * sits on another drive than the workspace.
   */
  relativePath?: string | null;
  groupId: string;
  colorIndex: number;
  acquisitionOverride: 'conventional' | 'spectral' | null;
  /** Recorded so a reload can warn if the file changed underneath. */
  eventCount: number;
  parameterCount: number;
}

export interface WorkspaceSpectrum {
  id: string;
  label: string;
  values: number[];
  isAutofluorescence: boolean;
  sourceSampleId: string | null;
  eventCount: number;
}

export interface WorkspaceFile {
  version: number;
  name: string;
  savedAt: string;
  application: string;

  samples: WorkspaceSampleRef[];
  groups: Array<{ id: string; name: string }>;

  /**
   * The gating strategy, shared across samples, plus any explicit forks.
   *
   * v4. Up to v3 this was `gatesBySample` — one independent hierarchy per file,
   * with a manual copy step to replicate it. That model is preserved for the
   * cases that used it: `migrateGating` reads a v3 block and only produces
   * `divergent` entries for samples whose hierarchy genuinely differs from the
   * others. Everything that was already the same collapses into `shared`, which
   * is what it was always trying to be.
   */
  gating: WorkspaceGating;

  /**
   * Parameters computed from other parameters, e.g. a ratio of two detectors.
   *
   * Defined once for the workspace rather than per sample: an expression names
   * parameters by their short name, and the whole point is that the same
   * derivation applies across a sample set.
   */
  derivedParameters: DerivedParameterDef[];

  spectral: {
    spectra: WorkspaceSpectrum[];
    method: 'ols' | 'wls';
    /**
     * Path of the matrix file this panel came from, when it came from one.
     * `.unmixing` since 2026-08-11; `.mcflow.unmixing` and `.fcunmix.json`
     * before it, and those are no longer read — a workspace recording one gets
     * the refusal `requireUnmixingExtension` states rather than a silent
     * failure. Nothing here cares about the name; the reader does.
     *
     * Recorded so the workspace can say where its matrix lives and reload the
     * file if it has since been recomputed — a shared lab matrix is expected to
     * be updated in place.
     */
    matrixPath?: string | null;
    /**
     * A full copy of that file's contents, inlined.
     *
     * Both, not either. The path alone breaks the moment the workspace is
     * emailed to a collaborator or the matrix is moved into an archive folder;
     * the copy alone loses the connection to a matrix the lab maintains
     * centrally. With both, a workspace opens correctly on any machine and
     * still knows which shared file it was derived from.
     */
    matrixFile?: UnmixingMatrixFile | null;

    /*
       ## What was applied, and to what (2026-08-12, Item 12)

       Until now this block described a **matrix** and nothing about its use, so
       a workspace saved with unmixed plots and gates built on them reopened
       with the matrix present and applied to nothing. The abundances were gone,
       so `parametersFor` offered raw detectors only, and every panel whose axis
       named an antibody fell back to a detector index — the plot still drew,
       under a label the axis picker no longer had, showing a different
       measurement. That is data loss on reload wearing the appearance of a
       display glitch, and it is what these three fields exist to stop.

       **The abundances themselves are deliberately not stored.** They are a
       13 × 309 560 `Float32Array` — larger than the `.fcs` they came from — and
       storing them would break the rule this whole format is built on: *a
       workspace stores analysis, not data*. What is stored is which samples the
       matrix was applied to; `restoreWorkspace` re-reads the events, re-solves
       and gets the same numbers, because the solve is deterministic in the
       matrix and the data and both are recovered exactly.

       All three are optional and absent from every workspace written before
       this, which is the honest reading: those files recorded no application,
       and none is restored. No version bump, for the same reason the panel's
       nullable fields and `LayoutDef.kind` needed none.
    */

    /** Samples the matrix had been applied to when the workspace was saved. */
    applied?: string[];
    /*
       The weights the abundances were solved with, and the detector order the
       matrix names (2026-10-28).

       `matrixFile` carries the weights too, but it is optional — its capture is
       allowed to fail without failing the save — and the restore never read
       them from it. A reopened workspace therefore re-solved with `weights:
       null`, which is the unweighted fit, or with whatever weights the session
       held from another matrix: different abundances under gates drawn in
       display space against the weighted ones. Written here so the solve that
       reopens a workspace is the solve that saved it.
    */
    weights?: number[] | null;
    detectorNames?: string[];
    computedAt?: string | null;
    /**
     * The wizard's Step 1–3 setup: which tubes are controls and what each one is.
     *
     * Saved because two things now depend on it after a reload and neither can
     * re-derive it. The reference worksheets are saved as layouts of their own
     * (`kind: 'reference'`) and are orphans without the assignments that name
     * them; and Statistics and Export exclude control samples (Item 11), which
     * they can only do while the app still knows which tubes were ticked.
     */
    controls?: unknown[];
    /** The shared scatter gate the reference worksheets were built on. */
    generalGateId?: string | null;
    /**
     * Which panel built the matrix — `SpectralState.kind` (2026-08-29).
     *
     * Saved because it cannot be re-derived and because it is *read*: it decides
     * whether re-applying the matrix on reload tags its parameters `Comp` or
     * `Unmixed`. Without it a compensation workspace reopened as a spectral one
     * — the numbers identical, every label in the application wrong.
     *
     * Optional, no version bump. Absent means `'unmixing'`, which is what every
     * workspace written before compensation existed meant.
     */
    model?: 'unmixing' | 'compensation';
  };

  /**
   * The Biophysics pipeline's setup (2026-08-14).
   *
   * **Optional, and carrying no version bump**, for the same reason
   * `spectral.controls` and `LayoutDef.kind` needed none: a workspace written
   * before it has no biophysics pipeline, and an absent block is the correct
   * reading of that rather than a missing field to be defaulted around.
   *
   * ## What is here and what deliberately is not
   *
   * The **gates are not here**, and their absence is the point. The live-cell
   * gate and every population gate are ordinary gates and are already written in
   * `gating` with everything else — so a workspace reopened by a build with no
   * Biophysics panel still has them, still evaluates them, still counts them in
   * Statistics and still writes them from Export. The parameter is likewise an
   * ordinary entry in `derivedParameters`. What is left for this block is the
   * bookkeeping that cannot be re-derived: which of those gates is which, which
   * property was being measured, and the fits the review chart draws.
   *
   * The **fits are stored** rather than recomputed on load, and that is not a
   * violation of *a workspace stores analysis, not data*. A `MixtureFit` is nine
   * numbers per sample — three components and two boundaries — and it is a
   * *result*: recomputing it would re-run model selection against gates the user
   * may since have moved, so a saved analysis would come back describing itself
   * differently from how it was left.
   */
  biophysics?: {
    propertyId: string | null;
    probeId: string | null;
    /**
     * The two detectors the property was read on, when they are not the probe's.
     *
     * Absent on anything written before 2026-08-24, where absent reads as null
     * and the probe's published pair is used — exactly the analysis those files
     * hold, since it was the only pair they could have been made with. No
     * migration and no version bump, the same reading `mode` and `singletGateId`
     * get.
     */
    channels?: [string, string] | null;
    /** Id of the entry in `derivedParameters` this pipeline computed from. */
    parameterId: string | null;
    /** The shared cell gate, whose per-sample boundaries are in `gating.overrides`. */
    liveGateId: string | null;
    /**
     * The shared doublet cut, in *multiple cell types* — the population the fit
     * is read inside and the parent of *Live* and *Dead*.
     *
     * Absent on anything written before 2026-08-21, where absent reads as null
     * and viability is read inside the cell gate: exactly the analysis those
     * files hold. No migration and no version bump, the same reading `mode` gets.
     */
    singletGateId?: string | null;
    /** One record per sample: its worksheet, its population gates and its fit. */
    samples?: unknown[];
    /**
     * `'single'` or `'multi'`. Absent on every workspace written before modes
     * existed, and absent reads as `'single'` — which is what those files are,
     * because it was the only pipeline there was. No migration and no version
     * bump: an older build reading a `'multi'` workspace ignores the field and
     * restores the four steps it knows, which is a true subset of the analysis.
     */
    mode?: unknown;
    /**
     * Whether the *Cells* gate is one shape across the samples.
     *
     * Absent on every workspace written before 2026-08-17, and absent reads as
     * `false` — one polygon per sample, which is the behaviour those files'
     * gates were actually placed with. Same rule as `mode`: no migration and no
     * version bump, because an older build ignores the field and the gates
     * themselves already say what they are.
     */
    cellGateShared?: unknown;
  };

  /**
   * Plot layouts. v3 stores named layouts, one per layout window; v2 stores a
   * single `panels[]`; a v1 file has one inline config. `parseWorkspace`
   * migrates both forward.
   */
  /**
   * Where the operator was (2026-10-28): the view, the sample on screen, the
   * Biophysics step and the Statistics setup.
   *
   * Absent on an older file, which reopens on Analysis exactly as it always
   * has. Read back through `restoreSession`, which treats every field as a
   * suggestion checked against what actually loaded — a step whose
   * prerequisites are missing is clamped, a sample that was not found is not
   * selected — so a file can never put the application somewhere it could not
   * have got to by itself.
   */
  session?: WorkspaceSession;

  plot: {
    panels: unknown[];
    columns: number;
    /** Named layouts beyond the active one. Empty on a v1/v2 file. */
    layouts?: WorkspaceLayout[];
    activeLayoutId?: string | null;
  };
}

export interface WorkspaceSession {
  view?: string;
  selectedSampleId?: string | null;
  biophysicsStep?: number;
  biophysicsWalkIndex?: number;
  /** Which tab of the Unmixing / Compensation panel was open. */
  unmixingTab?: string;
  /** The Statistics panel's setup, with its sets written as arrays. */
  statistics?: Record<string, unknown> | null;
}

export interface WorkspaceGating {
  /** The hierarchy every linked sample uses. */
  shared: Gate[];
  /** Samples explicitly forked off it, by sample id. */
  divergent: Record<string, Gate[]>;
  /**
   * Per-sample boundaries for individually unlinked gates: `gateId → sampleId → gate`.
   *
   * Added 2026-08-03 and **optional**, which is why it carries no version bump:
   * a workspace saved before it has no unlinked gates, so an absent block and an
   * empty one describe the same analysis. See `resolveGates`.
   */
  overrides?: Record<string, Record<string, Gate>>;
}

/**
 * Bring a v1–v3 `gatesBySample` block forward.
 *
 * The judgement here is which of the old per-sample hierarchies were *meant* to
 * be one strategy. In practice almost all of them were: `copyStrategy` existed
 * precisely so a user could stamp one hierarchy across a set, and samples that
 * were never gated carry an empty list. So:
 *
 *   - samples with no gates are simply linked; they have nothing to preserve,
 *   - hierarchies with the same shape (kinds, names, parentage, geometry —
 *     everything but the regenerated ids) are one strategy wearing several
 *     copies, and collapse into `shared`,
 *   - anything left genuinely differs and stays a fork, because silently
 *     merging two different gating strategies would change someone's numbers.
 *
 * The most common hierarchy wins the `shared` slot, so the fewest samples end
 * up forked.
 */
export function migrateGating(gatesBySample: Record<string, Gate[]> | undefined): WorkspaceGating {
  const entries = Object.entries(gatesBySample ?? {}).filter(([, gs]) => gs.length > 0);
  if (entries.length === 0) return { shared: [], divergent: {} };

  const shapeOf = (gates: Gate[]): string =>
    JSON.stringify(gates.map((g) => {
      // Ids are regenerated by `cloneStrategy`, so two copies of one strategy
      // never match on them. Parentage is compared by *position* in the list,
      // which is stable across a clone.
      const parentIndex = gates.findIndex((p) => p.id === g.parentId);
      const { id: _id, parentId: _parentId, ...rest } = g;
      return { ...rest, parentIndex };
    }));

  const byShape = new Map<string, string[]>();
  for (const [sampleId, gates] of entries) {
    const key = shapeOf(gates);
    byShape.set(key, [...(byShape.get(key) ?? []), sampleId]);
  }

  let bestKey = '';
  let bestCount = -1;
  for (const [key, ids] of byShape) {
    if (ids.length > bestCount) { bestKey = key; bestCount = ids.length; }
  }

  const sharedSampleId = byShape.get(bestKey)![0]!;
  const divergent: Record<string, Gate[]> = {};
  for (const [sampleId, gates] of entries) {
    if (shapeOf(gates) !== bestKey) divergent[sampleId] = gates;
  }
  return { shared: gatesBySample![sharedSampleId]!, divergent };
}

/** One named multi-panel layout. A window views exactly one of these. */
export interface WorkspaceLayout {
  id: string;
  name: string;
  panels: unknown[];
  columns: number;
  activePanelId?: string | null;
  /**
   * `'reference'` for a worksheet the unmixing wizard generated, `'biophysics'`
   * for one the Biophysics pipeline did. Absent — and therefore general — on
   * every layout in every workspace written before 2026-08-10, which is the
   * honest reading: those files predate the distinction. No version bump, for
   * the same reason the panel's nullable fields needed none, and none for
   * `'biophysics'` joining the union on 2026-08-14 either: a value a reader does
   * not recognise falls through to *general*, which is the correct reading of a
   * worksheet whose owning panel this build has never heard of.
   */
  kind?: LayoutKind;
}

export class WorkspaceError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * Parse and validate a workspace file.
 *
 * Validates rather than trusting: a workspace is a file a user can hand to a
 * collaborator, edit by hand, or produce with a different version of the app,
 * so a malformed one has to fail with an explanation rather than half-loading
 * into an inconsistent state.
 */
export function parseWorkspace(json: string): WorkspaceFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new WorkspaceError(
      'This file is not valid JSON.',
      'A workspace file is plain JSON — it may have been truncated or is not a workspace at all.',
    );
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new WorkspaceError('This file does not contain a workspace object.');
  }
  const w = raw as Partial<WorkspaceFile>;

  if (typeof w.version !== 'number') {
    throw new WorkspaceError('This file has no workspace version and cannot be read safely.');
  }
  if (w.version > WORKSPACE_VERSION) {
    throw new WorkspaceError(
      `This workspace was saved by a newer version of MCFlow (format ${w.version}, this build reads ${WORKSPACE_VERSION}).`,
      'Update MCFlow, or ask whoever sent it to export from an older version.',
    );
  }
  if (!Array.isArray(w.samples)) {
    throw new WorkspaceError('This workspace has no sample list.');
  }

  // Fill in anything a v1 file may legitimately omit, so downstream code never
  // has to defend against partial objects.
  return {
    version: w.version,
    name: w.name ?? 'Untitled workspace',
    savedAt: w.savedAt ?? new Date().toISOString(),
    application: w.application ?? 'MCFlow',
    samples: w.samples,
    groups: w.groups ?? [],
    // v4 stores `gating`; anything older stores `gatesBySample` and is migrated.
    // Through `repairGateBounds` — see `keepInfinity` for the bounds a save lost.
    gating: repairGating(w.gating ?? migrateGating((raw as { gatesBySample?: Record<string, Gate[]> }).gatesBySample)),
    derivedParameters: Array.isArray(w.derivedParameters) ? w.derivedParameters : [],
    // A v4 file's `compensation` block is deliberately not read: the feature it
    // described is gone, and carrying the matrices forward as dead data would
    // leave a workspace claiming a correction the app can no longer apply.
    spectral: {
      spectra: w.spectral?.spectra ?? [],
      method: w.spectral?.method ?? 'ols',
      matrixPath: w.spectral?.matrixPath ?? null,
      matrixFile: w.spectral?.matrixFile ?? null,
      // Absent on every workspace saved before 2026-08-12. An empty list is the
      // correct reading of that absence in both cases: no application was
      // recorded, so none is restored, and no tube was recorded as a control,
      // so every one of them counts as part of the experiment.
      applied: Array.isArray(w.spectral?.applied) ? w.spectral.applied : [],
      controls: Array.isArray(w.spectral?.controls) ? w.spectral.controls : [],
      generalGateId: w.spectral?.generalGateId ?? null,
      // Read since 2026-10-28. `model` was written from the start and dropped
      // here, so the restore fell back to the inlined file's own field — the
      // same answer whenever that file was captured, and none when it was not.
      ...(w.spectral?.model === 'unmixing' || w.spectral?.model === 'compensation' ? { model: w.spectral.model } : {}),
      weights: numberArray(w.spectral?.weights),
      detectorNames: Array.isArray(w.spectral?.detectorNames)
        ? w.spectral.detectorNames.filter((x): x is string => typeof x === 'string')
        : [],
      computedAt: typeof w.spectral?.computedAt === 'string' ? w.spectral.computedAt : null,
    },
    // Absent on every workspace written before 2026-08-14. An empty pipeline is
    // the correct reading of that: no property was recorded, so none is
    // restored, and the gates such a file does carry are ordinary gates that
    // load through `gating` regardless.
    biophysics: {
      propertyId: w.biophysics?.propertyId ?? null,
      probeId: w.biophysics?.probeId ?? null,
      // Two strings or nothing. A malformed pair is dropped rather than
      // half-adopted: one channel of an override is not an analysis, and the
      // probe's own pair is the honest reading of a file that cannot say.
      channels: channelPair(w.biophysics?.channels),
      parameterId: w.biophysics?.parameterId ?? null,
      liveGateId: w.biophysics?.liveGateId ?? null,
      singletGateId: w.biophysics?.singletGateId ?? null,
      samples: Array.isArray(w.biophysics?.samples) ? w.biophysics.samples : [],
      // Anything that is not 'multi' is single — the same total reading
      // `asLayoutKind` gives an unrecognised layout kind, and for the same
      // reason: a value this build does not know must resolve to the one that
      // draws something rather than to a step list with a hole in it.
      mode: w.biophysics?.mode === 'multi' ? 'multi' : 'single',
      cellGateShared: w.biophysics?.cellGateShared === true,
    },
    session: typeof w.session === 'object' && w.session !== null ? w.session : {},
    plot: migratePlot(w.plot as Record<string, unknown> | undefined),
  };
}

/** Finite numbers, or null for anything else — a weight vector with a hole in it is not one. */
function numberArray(v: unknown): number[] | null {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v : null;
}

/**
 * A detector override, or null for every shape that is not one.
 *
 * Absent, null, the wrong length, or holding anything that is not a non-empty
 * string all mean the same thing to the pipeline — use the probe's own bands —
 * so they are all read as null here rather than each being handled downstream.
 */
function channelPair(v: unknown): [string, string] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v;
  if (typeof a !== 'string' || typeof b !== 'string' || !a.trim() || !b.trim()) return null;
  return [a, b];
}

/**
 * Bring a v1 plot block forward.
 *
 * v1 stored one plot's settings inline; v2 stores `panels[]`. Rather than
 * refusing an older file, its single config is wrapped into a one-element array
 * so an existing workspace keeps working.
 */
function migratePlot(plot: Record<string, unknown> | undefined): WorkspaceFile['plot'] {
  if (plot && Array.isArray(plot.panels)) {
    return {
      panels: plot.panels,
      columns: typeof plot.columns === 'number' ? plot.columns : 1,
      // A v2 file has one unnamed layout; it becomes the active one and the
      // named-layout list stays empty, so an older workspace opens as it always
      // did rather than gaining a phantom second layout.
      layouts: Array.isArray(plot.layouts) ? (plot.layouts as WorkspaceLayout[]) : [],
      activeLayoutId: typeof plot.activeLayoutId === 'string' ? plot.activeLayoutId : null,
    };
  }
  if (!plot) return { panels: [], columns: 1, layouts: [], activeLayoutId: null };
  const { xParam, yParam, xTransform, yTransform, plotType, densityScale, ramp, binCount, smoothing, pointSize, showGrid } = plot;
  return {
    columns: 1,
    layouts: [],
    activeLayoutId: null,
    panels: [{
      id: 'p_migrated',
      sampleId: null,
      xParam: xParam ?? 0,
      yParam: yParam ?? 1,
      xTransform: xTransform ?? 'linear',
      yTransform: yTransform ?? 'linear',
      xOverrides: {},
      yOverrides: {},
      viewport: null,
      plotType: plotType ?? 'scatter',
      densityScale: densityScale ?? 'log',
      // Whatever a v1 file says here, `makePanel` re-checks it: Abyss, Ember,
      // Glacier and Flame were all valid names once and none of them is one now.
      ramp: ramp ?? PANEL_VIEW_DEFAULTS.ramp,
      binCount: binCount ?? 256,
      smoothing: smoothing ?? PANEL_VIEW_DEFAULTS.smoothing,
      overlayIds: [],
      pointSize: pointSize ?? PANEL_VIEW_DEFAULTS.pointSize,
      // A v1 file predates the setting; `null` takes the count-derived alpha,
      // which is what those plots were drawn with.
      alpha: null,
      showGrid: showGrid ?? true,
      initialisedFor: null,
    }],
  };
}

export function serialiseWorkspace(w: WorkspaceFile): string {
  return JSON.stringify(w, keepInfinity, 2);
}

/*
   ## ±Infinity survives a save (2026-10-28)

   A one-sided gate is stored with an infinite end: Biophysics' *Live* runs to
   `+Infinity` and *Dead* from `-Infinity`, and the unmixing wizard seeds every
   positive gate as `{ min: threshold, max: +Infinity }`. `JSON.stringify` writes
   Infinity as `null`, a `null` bound compares as 0, and every such gate came
   back from a save empty — the report was *"Cells works, Live shows 0"*. Written
   as ±`Number.MAX_VALUE`, which round-trips exactly and still lies beyond every
   value a column can hold, so even an older build reads the file correctly; read
   back to ±Infinity by `repairGateBounds`, so the state after a reopen is the
   state that was saved.
*/
function keepInfinity(_key: string, value: unknown): unknown {
  if (value === Infinity) return Number.MAX_VALUE;
  if (value === -Infinity) return -Number.MAX_VALUE;
  return value;
}

const LOWER = ['min', 'xMin', 'yMin'] as const;
const UPPER = ['max', 'xMax', 'yMax'] as const;

/**
 * A gate as it was before it was written: ±Infinity bounds restored.
 *
 * Every workspace saved before 2026-10-28 carries `null` where a one-sided
 * gate's open end was, and a `null` bound has no other possible meaning — no
 * gate is drawn to "nothing" — so this is a repair, not a guess. It is what lets
 * a workspace written by any earlier build reopen with its *Live* population and
 * its seeded reference gates counting the events they counted when it was saved.
 */
export function repairGateBounds<G extends Gate>(gate: G): G {
  const g = gate as unknown as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  const fix = (key: string, open: number) => {
    const v = g[key];
    if (!(key in g) || (v !== null && Math.abs(v as number) !== Number.MAX_VALUE)) return;
    out ??= { ...g };
    out[key] = v === null ? open : Math.sign(v as number) * Infinity;
  };
  for (const k of LOWER) fix(k, -Infinity);
  for (const k of UPPER) fix(k, Infinity);
  return (out ?? gate) as G;
}

function repairGating(g: WorkspaceGating): WorkspaceGating {
  return {
    shared: g.shared.map(repairGateBounds),
    divergent: Object.fromEntries(Object.entries(g.divergent ?? {}).map(([id, list]) => [id, list.map(repairGateBounds)])),
    ...(g.overrides ? {
      overrides: Object.fromEntries(Object.entries(g.overrides).map(([gateId, per]) => [
        gateId, Object.fromEntries(Object.entries(per).map(([sampleId, gate]) => [sampleId, repairGateBounds(gate)])),
      ])),
    } : {}),
  };
}

export interface ReloadReport {
  /** Samples whose file could be found and re-read. */
  restored: string[];
  /** Samples whose file is missing — the workspace stores paths, not data. */
  missing: WorkspaceSampleRef[];
  /** Samples whose event count no longer matches what was saved. */
  changed: Array<{ ref: WorkspaceSampleRef; nowEvents: number }>;
}

/** Compare a reloaded sample against what the workspace recorded. */
export function checkReloaded(ref: WorkspaceSampleRef, eventCount: number, parameterCount: number): string | null {
  if (eventCount !== ref.eventCount) {
    return `“${ref.name}” now has ${eventCount.toLocaleString()} events but the workspace recorded ${ref.eventCount.toLocaleString()}. Gate statistics will differ from when it was saved.`;
  }
  if (parameterCount !== ref.parameterCount) {
    return `“${ref.name}” now has ${parameterCount} parameters but the workspace recorded ${ref.parameterCount}. Gates may reference the wrong channels.`;
  }
  return null;
}
