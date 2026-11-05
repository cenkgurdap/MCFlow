import {
  checkReloaded, parseWorkspace, serialiseWorkspace,
  WORKSPACE_EXTENSION, WORKSPACE_FILTERS, WORKSPACE_VERSION, WorkspaceError,
  type WorkspaceFile, type WorkspaceSampleRef, type WorkspaceSession,
} from '@/core/workspace';
import { baseName, candidatePaths, relativeFrom, resolveFrom } from '@/core/workspacePaths';
import { readCounts } from '@/core/fcs/parser';
import { clampStep, firstStep, lastStep, reachedStep } from '@/core/biophysics/pipeline';
import type { ControlAssignment, PanelTab } from '@/core/unmixing/wizard';
import { modelFromPath } from '@/core/unmixingFile';
import type { BiophysicsSample } from '@/core/biophysics/pipeline';
import { asLayoutKind } from '@/core/layout/layoutKind';
import { platform, type FileRef } from '@/platform';
import { useBiophysics } from './biophysicsStore';
import { useDerived } from './derivedStore';
import { useGates } from './gateStore';
import { DEFAULT_LAYOUT_ID, makePanel, usePlot, type LayoutDef, type PanelConfig } from './plotStore';
import { useSpectral } from './spectralStore';
import { useHistory } from './historyStore';
import { useTransformPrefs } from './transformPrefs';
import { adoptStatisticsPrefs, captureStatisticsPrefs, useStatisticsPrefs } from './statisticsPrefs';
import { useUI, type MainView } from './uiStore';
import { viewLockReason } from './viewLock';
import { useDirty } from './dirtyStore';
import { captureUnmixingMatrix } from './unmixingIO';
import { acquisitionTypeOf, useWorkspace } from './workspaceStore';

/**
 * Capture the whole analysis state into a serialisable workspace.
 *
 * `workspacePath` is where it is about to be written, when that is known — it
 * is what each sample's relative path is measured from (`core/workspacePaths`).
 */
export function captureWorkspace(name = 'Untitled workspace', workspacePath: string | null = null): WorkspaceFile {
  const ws = useWorkspace.getState();
  const gates = useGates.getState();
  const spectral = useSpectral.getState();
  const bio = useBiophysics.getState();
  const plot = usePlot.getState();

  return {
    version: WORKSPACE_VERSION,
    name,
    savedAt: new Date().toISOString(),
    application: 'MCFlow',

    samples: ws.samples.map((s) => ({
      id: s.id,
      name: s.name,
      fileName: s.fileName,
      filePath: s.filePath,
      relativePath: workspacePath && s.filePath ? relativeFrom(workspacePath, s.filePath) : null,
      groupId: s.groupId,
      colorIndex: s.colorIndex,
      acquisitionOverride: s.acquisitionOverride,
      eventCount: s.parsed.metadata.eventCount,
      parameterCount: s.parsed.metadata.parameterCount,
    })),
    groups: ws.groups.map((g) => ({ id: g.id, name: g.name })),

    gating: { shared: gates.shared, divergent: gates.divergent, overrides: gates.overrides },
    derivedParameters: useDerived.getState().defs,

    spectral: {
      spectra: spectral.spectra.map((s) => ({
        id: s.id,
        label: s.label,
        values: Array.from(s.values),
        isAutofluorescence: s.isAutofluorescence,
        sourceSampleId: s.sourceSampleId,
        eventCount: s.eventCount,
      })),
      method: spectral.method,
      // The external matrix by reference *and* by value. The path keeps the
      // link to a matrix the lab maintains centrally; the inlined copy is what
      // makes the workspace still open correctly once it has been emailed to
      // someone who does not have that path.
      matrixPath: spectral.loadedFrom?.path ?? null,
      matrixFile: spectral.spectra.length > 0 ? safeCaptureMatrix(spectral.loadedFrom?.name) : null,
      /*
         Which samples the matrix was applied to (2026-08-12, Item 12).

         The ids and not the abundances — see the note in `workspace.ts`. A
         sample id is its file path, which is what every other cross-reference
         in this file keys on, so this lines up on reload for exactly as long
         as the files are still where they were.
      */
      applied: Object.keys(spectral.unmixed),
      // The wizard's own setup, so the reference worksheets saved beside it are
      // still worksheets *of* something, and so Statistics and Export still
      // know which tubes are controls (Item 11).
      controls: spectral.controls,
      generalGateId: spectral.generalGateId,
      // Which panel built it — see `WorkspaceFile.spectral.model`.
      model: spectral.kind,
      // What the solve was weighted with — see `WorkspaceFile.spectral.weights`.
      weights: spectral.weights ? Array.from(spectral.weights) : null,
      detectorNames: spectral.detectorNames,
      computedAt: spectral.computedAt,
    },

    /*
       The Biophysics pipeline's bookkeeping, and nothing that is already
       elsewhere.

       No gates and no parameter: both are ordinary objects written by the two
       blocks above this one, which is the property the whole panel was built
       for. What is written here is which of those gates is the live-cell gate,
       which are each sample's populations, and the fit behind them — the facts
       that name the gates rather than the gates themselves. See the note on
       `WorkspaceFile.biophysics`.

       The step is in `session` below, not here: it is where the operator was,
       not what the analysis is.
    */
    biophysics: {
      propertyId: bio.propertyId,
      probeId: bio.probeId,
      // Null unless the detectors were re-pointed, so a file says nothing rather
      // than freezing a copy of whichever pair this build ships as the default.
      channels: bio.channels ? [bio.channels[0], bio.channels[1]] : null,
      parameterId: bio.parameterId,
      liveGateId: bio.liveGateId,
      singletGateId: bio.singletGateId,
      samples: bio.samples,
      mode: bio.mode,
      // How the *Cells* gate is shared. Written because it decides what Step 1
      // does when it is re-entered, and because it is the state that explains
      // the gates already in the file — one polygon or one per sample.
      cellGateShared: bio.cellGateShared,
      // The component shape the fits were made with — it is what the saved
      // gates were cut from, so a reopened file must re-fit with the same one.
    },

    /*
       Where the operator was (2026-10-28).

       Until then a workspace reopened on Analysis with Biophysics back at its
       first step and the Statistics setup reset, deliberately: a step saved
       over files that have since moved would reopen on a step with nothing
       behind it. The request was the opposite — *"start where it was left"* —
       and the hazard is answered on the way in rather than by not writing it
       down: `restoreSession` clamps the step to what actually loaded, the same
       bound the step tracker puts on a forward jump.
    */
    session: {
      view: useUI.getState().view,
      selectedSampleId: ws.selectedSampleId,
      biophysicsStep: bio.step,
      biophysicsWalkIndex: bio.walkIndex,
      unmixingTab: spectral.tab,
      statistics: captureStatisticsPrefs(),
    },

    plot: {
      panels: plot.panels,
      // `columns` is legacy — panels carry coordinates now — but it is still
      // written so a workspace saved here opens sensibly in an older build.
      columns: 1,
      layouts: plot.allLayouts().map((l) => ({ ...l, columns: l.columns ?? 1 })),
      activeLayoutId: plot.activeLayoutId,
    },
  };
}

/**
 * Snapshot the matrix for inlining, without letting that fail a workspace save.
 *
 * A workspace whose matrix could not be captured is still worth saving — the
 * gates and layout are the expensive part — so this degrades to `null` rather
 * than throwing out of `captureWorkspace`.
 */
function safeCaptureMatrix(name: string | undefined): WorkspaceFile['spectral']['matrixFile'] {
  try {
    return captureUnmixingMatrix(name ?? 'Workspace panel');
  } catch {
    return null;
  }
}

export interface RestoreResult {
  restored: number;
  missing: string[];
  warnings: string[];
}

/** Where each of a workspace's data files was found, and which were not. */
export interface ResolvedSamples {
  /** Found, each under its **saved** sample id at the path it was found at. */
  found: Array<{ sample: WorkspaceSampleRef; path: string; size: number }>;
  missing: WorkspaceSampleRef[];
}

/**
 * Find each sample's file: the recorded path, then relative to the workspace,
 * then by name beside it (`core/workspacePaths`).
 *
 * Separate from the restore so an interactive open can ask about the missing
 * ones — and locate them — before anything is torn down.
 */
export async function resolveSampleFiles(w: WorkspaceFile, workspacePath: string | null): Promise<ResolvedSamples> {
  const p = platform();
  const found: ResolvedSamples['found'] = [];
  const missing: WorkspaceSampleRef[] = [];
  for (const s of w.samples) {
    let hit: ResolvedSamples['found'][number] | null = null;
    for (const path of candidatePaths(s, workspacePath)) {
      try {
        const stat = await p.statFile?.(path);
        hit = { sample: s, path, size: stat?.size ?? 0 };
        break;
      } catch { /* not here — try the next place */ }
    }
    if (hit) found.push(hit);
    else missing.push(s);
  }
  return { found, missing };
}

/**
 * Re-point missing samples at files in a folder somebody chose, by file name.
 *
 * Exact name, case aside, and only ever the name the sample itself recorded —
 * this re-finds a file, it never decides what a file is.
 */
export async function locateInFolder(resolved: ResolvedSamples, files: string[]): Promise<ResolvedSamples> {
  const p = platform();
  const byName = new Map(files.map((f) => [baseName(f).toLowerCase(), f]));
  const found = [...resolved.found];
  const missing: WorkspaceSampleRef[] = [];
  for (const s of resolved.missing) {
    const path = byName.get(s.fileName.toLowerCase());
    if (!path) { missing.push(s); continue; }
    try {
      const stat = await p.statFile?.(path);
      found.push({ sample: s, path, size: stat?.size ?? 0 });
    } catch {
      missing.push(s);
    }
  }
  return { found, missing };
}

/** A missing sample and a file that is probably it — offered, never applied unasked. */
export interface SuggestedMatch {
  sample: WorkspaceSampleRef;
  path: string;
  size: number;
}

/** A file name with case, spaces, underscores, hyphens and dots taken out. */
const looseName = (name: string) => name.replace(/\.fcs$/i, '').toLowerCase().replace(/[\s_.\-]+/g, '');

/**
 * Files in `files` that are probably missing samples under a new name
 * (2026-10-28).
 *
 * A dataset renamed after the workspace was saved — `…_Pro12A_1.fcs` becoming
 * `… Pro12A1.fcs` — matched nothing, and the workspace opened with none of its
 * data. **Two conditions, and the second is the one that counts**: the names
 * agree once separators and case are ignored, *and* the file holds exactly the
 * event and parameter counts the workspace recorded for that sample. The count
 * is read from the file's header, so it is a statement about the data rather
 * than about the name. Even so, a match is a suggestion: the never-infer-from-a-
 * filename rule holds, and the prompt asks before any is used.
 */
export async function suggestMatches(missing: WorkspaceSampleRef[], files: string[]): Promise<SuggestedMatch[]> {
  const p = platform();
  const out: SuggestedMatch[] = [];
  const taken = new Set<string>();
  for (const s of missing) {
    if (!(s.eventCount > 0)) continue;
    const want = looseName(s.fileName);
    for (const path of files) {
      if (taken.has(path) || looseName(baseName(path)) !== want) continue;
      try {
        const counts = readCounts(await p.readFile!(path));
        if (!counts || counts.eventCount !== s.eventCount || counts.parameterCount !== s.parameterCount) continue;
        const stat = await p.statFile?.(path);
        out.push({ sample: s, path, size: stat?.size ?? 0 });
        taken.add(path);
        break;
      } catch { /* unreadable — not a match */ }
    }
  }
  return out;
}

export interface RestoreOptions {
  /** Where the workspace file is, so its samples can be looked for beside it. */
  workspacePath?: string | null;
  /** Already resolved — by an open that asked about missing files first. */
  resolved?: ResolvedSamples;
}

/**
 * Restore a workspace.
 *
 * Samples are re-read from their files — the workspace stores the analysis, not
 * the data — so a file that cannot be found is reported rather than silently
 * producing an empty population.
 */
export async function restoreWorkspace(json: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
  const w = parseWorkspace(json);
  const p = platform();
  const resolved = opts.resolved ?? await resolveSampleFiles(w, opts.workspacePath ?? null);

  const missing = resolved.missing.map((s) => s.name);
  const warnings: string[] = [];
  /*
     Under the **saved** id, wherever the file was found. A sample id is what
     every gate fork, override, control assignment and Biophysics record keys
     on, so a file found somewhere new keeps all of it attached; only `path`
     says where it now is, and the next save records that.
  */
  const refs: FileRef[] = resolved.found.map(({ sample, path, size }) => ({
    id: sample.id,
    name: sample.fileName,
    path,
    size,
    read: () => p.readFile!(path),
  }));

  const ws = useWorkspace.getState();
  ws.removeAll();
  if (refs.length > 0) await ws.importFiles(refs);
  // A file that was found and then could not be read — permission refused,
  // truncated, a cloud placeholder — is as missing as one that was not found,
  // and has to be said in the same place.
  for (const f of useWorkspace.getState().failures) {
    warnings.push(`Could not read “${f.fileName}”: ${f.message}`);
  }

  // Re-apply the saved identity: import derives names from filenames and puts
  // every sample in no group, which would discard any renaming and grouping.
  const loaded = useWorkspace.getState().samples;
  for (const s of w.samples) {
    const match = loaded.find((x) => x.id === s.id || (s.filePath !== null && x.filePath === s.filePath));
    if (!match) continue;
    ws.renameSample(match.id, s.name);
    if (s.acquisitionOverride) ws.setAcquisitionOverride(match.id, s.acquisitionOverride);
    const note = checkReloaded(s, match.parsed.metadata.eventCount, match.parsed.metadata.parameterCount);
    if (note) warnings.push(note);
  }
  /*
     Groups (2026-10-28). Saved since groups existed and never read back, so
     every reopened workspace had lost its conditions — and with them the
     Compare chart's categories. Re-applied by the saved id; a group's name is
     restored after its members, since a group exists only while it has one.
  */
  for (const s of w.samples) {
    if (s.groupId && loaded.some((x) => x.id === s.id)) useWorkspace.getState().moveSampleToGroup(s.id, s.groupId);
  }
  for (const g of w.groups) {
    const live = useWorkspace.getState().groups.find((x) => x.id === g.id);
    if (live && live.name !== g.name) useWorkspace.getState().renameGroup(g.id, g.name);
  }

  useDerived.getState().setDefs(w.derivedParameters);

  const restoredControls = (w.spectral.controls ?? []) as ControlAssignment[];
  useSpectral.setState({
    spectra: w.spectral.spectra.map((s) => ({ ...s, values: Float64Array.from(s.values) })),
    method: w.spectral.method,
    /*
       Saved, then the file it came from, then `'unmixing'`.

       Three sources in decreasing order of authority rather than one, because a
       workspace can predate the field while still recording the path of a
       `.compensation` — and reading it back as spectral would relabel every
       parameter on reload. See `WorkspaceFile.spectral.model`.
    */
    kind: w.spectral.model
      ?? w.spectral.matrixFile?.model
      ?? (w.spectral.matrixPath ? modelFromPath(w.spectral.matrixPath) : 'unmixing'),
    previewIds: w.spectral.spectra.slice(0, 4).map((s) => s.id),
    /*
       The weights the abundances were solved with (2026-10-28).

       Never restored until then, so a reopened workspace re-solved unweighted
       — or with the weights of whatever matrix the session last held, since
       `onWorkspaceCleared` keeps them — and every gate drawn on an abundance sat
       over different events. Written explicitly since; the inlined matrix's own
       copy answers for a file written before. **Null, never inherited**, when
       neither has them: a matrix with no weights is solved unweighted, which is
       what it was solved as.
    */
    weights: (() => {
      const v = w.spectral.weights ?? w.spectral.matrixFile?.weights ?? null;
      return v ? Float64Array.from(v) : null;
    })(),
    detectorNames: w.spectral.detectorNames?.length
      ? [...w.spectral.detectorNames]
      : [...(w.spectral.matrixFile?.detectors.names ?? [])],
    computedAt: w.spectral.computedAt ?? w.spectral.matrixFile?.savedAt ?? null,
    // Provenance survives the round-trip, so a reopened workspace still says
    // which shared matrix file its panel came from.
    loadedFrom: w.spectral.matrixFile
      ? {
          path: w.spectral.matrixPath ?? null,
          name: w.spectral.matrixFile.name,
          savedAt: w.spectral.matrixFile.savedAt,
        }
      : null,
    /*
       The wizard's setup (2026-08-12, Items 11 and 12).

       Narrowed to controls whose file was actually found, because everything
       downstream indexes `samples` by these ids — a control naming a file that
       has moved would put a row in the Assign table with nothing behind it and
       keep that tube out of Statistics on the strength of it.

       `selectedIds` is set from the same list rather than saved separately:
       Step 1's ticks and the assignments derived from them cannot disagree if
       only one of them is written down.
    */
    controls: restoredControls.filter((c) => loaded.some((s) => s.id === c.sampleId)),
    selectedIds: restoredControls
      .map((c) => c.sampleId)
      .filter((id) => loaded.some((s) => s.id === id)),
    generalGateId: w.spectral.generalGateId ?? null,
  });

  /*
     The Biophysics pipeline, narrowed to samples that were actually found.

     Same rule and same reason as the wizard's controls above: every record here
     indexes `samples` by id, and one naming a file that has moved would put a
     tab in the walk with nothing behind it and a fit drawn over no data. The
     gates those records name are *not* narrowed — they came back with `gating`
     like every other gate, and a population gate whose sample is missing is
     simply a gate that evaluates on nothing, which is what a gate has always
     done when its file is gone.

     `step` is restored to 1 rather than saved: see the note in
     `captureWorkspace`.
  */
  const restoredBio = (w.biophysics?.samples ?? []) as BiophysicsSample[];
  const mode = w.biophysics?.mode === 'multi' ? 'multi' as const : 'single' as const;
  useBiophysics.getState().setAll({
    // The mode's own first step, for the same reason the step is reset at all:
    // multi opens on its unmixing prerequisite, which is where a reopened
    // multi-cell experiment should start.
    step: mode === 'multi' ? 0 : 1,
    mode,
    // Absent in a workspace written before 2026-08-17, and `false` is the
    // behaviour those gates were placed with — one polygon per sample. Reading
    // it as the new multi-mode default would describe the file wrongly.
    cellGateShared: w.biophysics?.cellGateShared === true,
    // Absent before 2026-10-22 and read as Gaussian — every fit in such a file.
    propertyId: w.biophysics?.propertyId ?? null,
    probeId: w.biophysics?.probeId ?? null,
    channels: w.biophysics?.channels ?? null,
    parameterId: w.biophysics?.parameterId ?? null,
    liveGateId: w.biophysics?.liveGateId ?? null,
    singletGateId: w.biophysics?.singletGateId ?? null,
    samples: restoredBio.filter((r) => loaded.some((s) => s.id === r.sampleId)),
    walkIndex: 0,
  });

  /*
     ## Re-apply the matrix, before any panel is mounted (2026-08-12, Item 12)

     The reported bug: a workspace saved with unmixed plots and a gating tree
     built on them reopened showing **raw detector parameters**, as though the
     matrix had never been applied. Everything needed to draw those plots was in
     the file — the matrix, the panels, their axes, the gates — and the one
     thing that was not is the only thing that makes an antibody addressable as
     a parameter: `attachUnmixed`, which nothing on the load path called.

     Awaited, and placed **above** the panel restore rather than below it. The
     abundances have to be attached before a panel mounts, because a panel whose
     `xParam` names an antibody index resolves that index against the parameter
     list as it stands — and against a list of raw detectors alone it silently
     lands on a detector. Attaching afterwards would leave the first render
     wrong and correct it a frame later, which is a plot that changes what it is
     plotting while somebody is looking at it.

     Failures are reported rather than thrown. A matrix whose detectors no
     longer match the files it is being applied to is a real situation — the
     files may have been re-exported from the instrument — and it belongs in the
     warnings beside "3 files could not be found", not as an exception that
     abandons a half-restored workspace.
  */
  const applied = (w.spectral.applied ?? [])
    .map((id) => loaded.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);
  if (applied.length > 0 && w.spectral.spectra.length > 0) {
    await useSpectral.getState().runUnmixing(applied);
    for (const f of useSpectral.getState().failures) {
      warnings.push(`Could not re-apply the matrix to “${f.sampleName}”: ${f.message}`);
    }
  }

  /*
     ## The gates go in *after* the matrix (2026-10-28)

     They were written before it, and `runUnmixing` yields between samples so
     its progress bar can paint. Anything that rendered in that gap — the gate
     tree's counts, a mounted plot — evaluated every gate on an abundance
     against a parameter list that did not have one yet, read a column of NaN,
     and the column cache kept it: the reopened workspace showed its gates with
     no cells in them. The cache is keyed on the attachment now
     (`parameterKey`), which is the fix; this ordering means nothing can ask
     the question too early in the first place.

     Gates and spectra key off sample ids, which survive a file being found
     somewhere new. The shared hierarchy needs no such alignment, which is one
     more reason it is the default: it applies to whatever ended up loaded.
  */
  useGates.setState({
    shared: w.gating.shared,
    divergent: w.gating.divergent,
    // Absent on every workspace saved before 2026-08-03, which had no way to
    // unlink one gate — so an empty map is the correct reading of its absence.
    overrides: w.gating.overrides ?? {},
    selectedGateId: null,
  });

  // The restored axes are authoritative, so each panel keeps its saved
  // `initialisedFor` — otherwise initialiseFor would reset them to FSC/SSC.
  const firstSampleId = useWorkspace.getState().samples[0]?.id ?? null;
  const hydrate = (panels: unknown[]): PanelConfig[] =>
    (panels as PanelConfig[]).map((p) => ({
      ...makePanel(),
      ...p,
      initialisedFor: p.initialisedFor ?? firstSampleId,
    }));

  const restoredPanels = hydrate(w.plot.panels);
  const savedLayouts = w.plot.layouts ?? [];

  if (savedLayouts.length > 0) {
    const layouts: LayoutDef[] = savedLayouts.map((l) => {
      const panels = hydrate(l.panels);
      return {
        id: l.id,
        name: l.name,
        panels,
        columns: l.columns || 1,
        activePanelId: l.activePanelId ?? panels[0]?.id ?? '',
        // Only a value this build knows is accepted. A file naming a kind it
        // does not recognise restores as general, which is the same rule
        // `makePanel` applies to a ramp name it no longer knows — and the rule
        // now lives beside the type in `asLayoutKind` rather than as a literal
        // comparison here, which is what stopped it going out of date when
        // `'biophysics'` was added.
        ...(asLayoutKind(l.kind) ? { kind: asLayoutKind(l.kind)! } : {}),
      } satisfies LayoutDef;
    });
    usePlot.getState().setLayouts(layouts, w.plot.activeLayoutId ?? layouts[0]!.id);
  } else {
    // A v1/v2 workspace has one unnamed layout. It becomes the single layout
    // rather than gaining a phantom second one.
    usePlot.getState().setLayouts([{
      id: DEFAULT_LAYOUT_ID,
      name: 'Main',
      panels: restoredPanels.length ? restoredPanels : [makePanel({ initialisedFor: firstSampleId })],
      // Legacy: panels saved before they carried coordinates are laid out from
      // the column count they were saved with, so a reopened workspace looks
      // like the one that was closed.
      columns: w.plot.columns || 1,
      activePanelId: restoredPanels[0]?.id ?? '',
    }], DEFAULT_LAYOUT_ID);
  }

  // A different workspace is a different document. Undoing back across the load
  // would restore the previous workspace's gates onto this one's samples, which
  // is not "the state before" in any sense the user means. The session's
  // per-parameter transform choices go for the same reason: they described the
  // channels of the workspace that was open, and the one being opened carries
  // its own axis transforms explicitly.
  useHistory.getState().reset();
  useTransformPrefs.getState().clear();
  // And the statistics panel's setup, for exactly the same reason: it names a
  // parameter index and a set of population paths belonging to the workspace
  // that was open. A workspace that saved its own setup brings that instead
  // (`restoreSession`); one that did not gets the defaults, never the setup of
  // the analysis that was open before it.
  useStatisticsPrefs.getState().reset();
  restoreSession(w.session ?? {});
  // A workspace just loaded is identical to the file it came from, so there is
  // nothing to prompt about on close. It has to be cleared *after* the restore
  // rather than before: rebuilding the sample list marks the workspace dirty on
  // the way through, which is right for an import and wrong for a load.
  useDirty.getState().markSaved();

  if (missing.length > 0) {
    warnings.unshift(
      `${missing.length} file(s) could not be found: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}. A workspace stores file paths, not event data.`,
    );
  }

  return { restored: useWorkspace.getState().samples.length, missing, warnings };
}

const TABS: readonly PanelTab[] = ['new', 'load', 'file'];

const VIEWS: readonly MainView[] = [
  'analysis', 'parameters', 'unmixing', 'compensation', 'statistics', 'export', 'umap', 'biophysics',
];

/**
 * Put the operator back where they were — as far as what loaded allows.
 *
 * Every field is a suggestion checked against the restored state, never an
 * instruction: the view must be one `viewLock` would let them open, the sample
 * must have loaded, and the Biophysics step is bounded by `reachedStep`, the
 * same bound the step tracker puts on a forward jump. An absent field changes
 * nothing, which is how a workspace written before 2026-10-28 — and every
 * sibling-window rehydrate, which carries no session — reopens exactly as it
 * always did.
 */
function restoreSession(session: WorkspaceSession): void {
  if (session.statistics) adoptStatisticsPrefs(session.statistics);

  const ws = useWorkspace.getState();
  if (session.selectedSampleId && ws.samples.some((s) => s.id === session.selectedSampleId)) {
    ws.selectSample(session.selectedSampleId);
  }

  if (typeof session.biophysicsStep === 'number') {
    const bio = useBiophysics.getState();
    const reached = reachedStep(bio.mode, bio.samples, bio.liveGateId, bio.parameterId);
    const step = clampStep(bio.mode, Math.min(session.biophysicsStep, Math.max(reached, firstStep(bio.mode))));
    const walk = session.biophysicsWalkIndex;
    useBiophysics.setState({
      step,
      walkIndex: typeof walk === 'number' && walk >= 0 && walk < Math.max(1, bio.samples.length) ? walk : 0,
    });
  }

  // The Compensation panel reopened on *New* after being left on *From this
  // file*: the tab is where somebody was in that panel, like the step is here.
  const tab = TABS.find((t) => t === session.unmixingTab);
  if (tab) useSpectral.getState().setTab(tab);

  const view = VIEWS.find((v) => v === session.view);
  if (view && viewLockReason(view) === null) useUI.getState().setView(view);
}

/**
 * Open a workspace the user has chosen, asking about any data file that cannot
 * be found before anything is torn down.
 *
 * The one interactive open — File ▸ Open, the command palette, a workspace
 * double-clicked in the shell, a launch naming one — so every route finds a
 * moved file the same way and reports through `reportRestore`. Returns null
 * when the user cancels at the missing-files prompt; throws `WorkspaceError`
 * for a file that is not a workspace, before anything has changed.
 */
export async function openWorkspaceAt(path: string, text: string): Promise<RestoreResult | null> {
  const w = parseWorkspace(text);
  const p = platform();
  let resolved = await resolveSampleFiles(w, path);
  // Renamed files are looked for beside the workspace before anyone is asked.
  let files = resolved.missing.length > 0 ? ((await p.listFcs?.(resolveFrom(path, '.'))) ?? []) : [];

  while (resolved.missing.length > 0) {
    const suggestions = await suggestMatches(resolved.missing, files);
    const choice = await useUI.getState().askMissingFiles({
      workspace: baseName(path),
      missing: resolved.missing.map((s) => s.fileName),
      total: w.samples.length,
      suggestions: suggestions.map((m) => ({
        saved: m.sample.fileName, found: baseName(m.path), events: m.sample.eventCount,
      })),
    });
    if (choice === 'cancel') return null;
    if (choice === 'skip') break;
    if (choice === 'accept') {
      const used = new Set(suggestions.map((m) => m.sample.id));
      resolved = {
        found: [...resolved.found, ...suggestions.map(({ sample, path: at, size }) => ({ sample, path: at, size }))],
        missing: resolved.missing.filter((s) => !used.has(s.id)),
      };
      continue;
    }
    files = (await p.pickFolder()).map((r) => r.path).filter((x): x is string => !!x);
    if (files.length > 0) resolved = await locateInFolder(resolved, files);
  }

  const result = await restoreWorkspace(text, { workspacePath: path, resolved });
  // A file written before the session block was: where it was left is read off
  // what it restored (`inferSession`), through the same checks a saved one gets.
  if (!w.session || Object.keys(w.session).length === 0) restoreSession(inferSession());
  else if (!w.session.view) useUI.getState().setView('analysis');
  return result;
}

/**
 * Where an older workspace was left, read off what it restored (2026-10-28).
 *
 * Every workspace saved before the `session` block reopened on Analysis with
 * Biophysics at its first step — after a long pipeline, an analysis that looks
 * like nothing happened. The file does record the worksheet that was on screen,
 * and that names the panel: a Biophysics sheet was being read in Biophysics, a
 * control's reference sheet in Unmixing or Compensation. The step is the
 * furthest the saved work supports, and the sample is the one the sheet on
 * screen belongs to. Only for an interactive open — a sibling window's
 * rehydrate carries no session either and must not move the other's view.
 */
function inferSession(): WorkspaceSession {
  const plot = usePlot.getState();
  const bio = useBiophysics.getState();
  const record = bio.samples.find((r) => r.layoutId === plot.activeLayoutId || r.immuneLayoutId === plot.activeLayoutId);
  const view: MainView = plot.activeLayoutKind === 'biophysics' || record ? 'biophysics'
    : plot.activeLayoutKind === 'reference'
      ? (useSpectral.getState().kind === 'compensation' ? 'compensation' : 'unmixing')
      : 'analysis';
  return {
    view,
    ...(record ? { selectedSampleId: record.sampleId } : {}),
    ...(bio.liveGateId ? { biophysicsStep: lastStep(bio.mode) } : {}),
  };
}

/**
 * Say what an open did — every open, through one function.
 *
 * File ▸ Open used to discard the result entirely: a workspace whose files had
 * all moved restored zero samples and the window simply stayed empty, which is
 * how *"it opens empty"* reached us with no message to go on. Nothing that
 * restores zero of several samples is reported as anything but an error.
 */
export function reportRestore(path: string, outcome: RestoreResult | null | Error): void {
  const setNotice = useUI.getState().setNotice;
  const name = baseName(path);
  if (outcome === null) return;
  if (outcome instanceof Error) {
    setNotice({ tone: 'err', text: `Could not open ${name}: ${outcome.message}` });
    return;
  }
  const { restored, missing, warnings } = outcome;
  if (restored === 0 && (missing.length > 0 || warnings.length > 0)) {
    setNotice({
      tone: 'err',
      text: `${name} opened with none of its data files — ${warnings[0] ?? 'they could not be found'}`,
    });
    return;
  }
  if (warnings.length > 0) {
    const more = warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : '';
    setNotice({ tone: 'warn', text: `${warnings[0]}${more}` });
    return;
  }
  setNotice({ tone: 'ok', text: `Opened ${name} — ${restored} sample${restored === 1 ? '' : 's'}` });
}

/** Save through the platform's file dialog. Returns the path, or null if cancelled. */
export async function saveWorkspaceToFile(name: string): Promise<string | null> {
  const p = platform();
  const target = await p.saveFileDialog(`${name}.${WORKSPACE_EXTENSION}`, [
    { name: 'MCFlow workspace', extensions: [WORKSPACE_EXTENSION] },
  ]);
  if (!target) return null;

  // Take the per-workspace lock before writing. Another instance holding this
  // file is exactly the case the lock exists for, and finding out *after*
  // overwriting it would be no protection at all.
  if (p.claimWorkspace && !(await p.claimWorkspace(target))) return null;

  await p.writeFile(target, serialiseWorkspace(captureWorkspace(name, target)));
  await p.setWorkspacePath?.(target);
  // What was on screen is now what is on disk. This is the only place that is
  // true, which is why it is the only place that clears the flag on a save.
  useDirty.getState().markSaved();
  return target;
}

/**
 * Open a workspace file, taking its lock first.
 *
 * Separate from `restoreWorkspace`, which takes text and knows nothing about
 * where it came from — that is what lets the window-sync path reuse it without
 * dragging the lock along.
 */
export async function openWorkspaceFile(): Promise<{ path: string; result: RestoreResult } | null> {
  const p = platform();
  // Both extensions. A workspace saved before 2026-08-03 is a `.fcws.json` and
  // opens unchanged — the format did not move, only what a save writes.
  const picked = await p.openTextFile?.(WORKSPACE_FILTERS);
  if (!picked) return null;
  if (p.claimWorkspace && !(await p.claimWorkspace(picked.path))) return null;
  // Reported here rather than by each caller, so File ▸ Open, the palette and
  // anything added later cannot open a workspace silently (`reportRestore`).
  try {
    const result = await openWorkspaceAt(picked.path, picked.text);
    reportRestore(picked.path, result);
    if (!result) return null;
    await p.setWorkspacePath?.(picked.path);
    return { path: picked.path, result };
  } catch (e) {
    reportRestore(picked.path, e instanceof Error ? e : new Error(String(e)));
    return null;
  }
}

export { WorkspaceError, acquisitionTypeOf };
