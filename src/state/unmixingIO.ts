import {
  checkDetectorCompatibility, detectorNamesOf, extensionFor, matrixFilters, modelFromPath,
  parseUnmixingMatrix, serialiseUnmixingMatrix,
  summarise, toReferenceSpectra, UNMIX_FILE_KIND,
  UNMIX_FILE_VERSION, UnmixingFileError,
  type CompatibilityReport, type ControlProvenance, type MatrixModel, type StoredSpectrum,
  type UnmixingMatrixFile,
} from '@/core/unmixingFile';
import { detectorIndices, similarityMatrix } from '@/core/spectral';
import { platform } from '@/platform';
import { useGates } from './gateStore';
import { useSpectral } from './spectralStore';
import { useWorkspace, type Sample } from './workspaceStore';

/* ==========================================================================
   Saving, loading and reusing a matrix as a standalone file.

   The workspace-level equivalent of this lives in `workspaceIO.ts`; the split
   is deliberate. A workspace is bound to a set of files on this machine. A
   matrix is bound to an *instrument configuration*, so it is portable in a way
   a workspace never is, and the loading path has to work from a brand-new empty
   workspace with nothing to reconcile against.
   ========================================================================== */

const RECENT_KEY = 'mcflow.recentUnmixingMatrices';
const RECENT_LIMIT = 12;

/** An entry in the reuse list. Enough to show a row without reading the file. */
export interface RecentMatrix {
  path: string;
  name: string;
  savedAt: string;
  detectorCount: number;
  fluorophoreCount: number;
  cytometer: string | null;
  /** When this entry was last loaded or saved, for ordering. */
  usedAt: string;
}

/* -------------------------------------------------------------------------
   The reuse library
   ------------------------------------------------------------------------- */

/**
 * Recently used matrices, most recent first.
 *
 * `localStorage` rather than a file in the user's profile: it is a convenience
 * index, not data. Losing it costs one trip through the file picker, so it is
 * not worth a write path that can fail — and a lab that re-images machines
 * keeps its matrices because they are real files elsewhere.
 */
export function recentMatrices(): RecentMatrix[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return (raw as RecentMatrix[])
      .filter((r) => r && typeof r.path === 'string')
      .sort((a, b) => (b.usedAt ?? '').localeCompare(a.usedAt ?? ''));
  } catch {
    return [];
  }
}

export function rememberMatrix(path: string, file: UnmixingMatrixFile): void {
  if (typeof localStorage === 'undefined') return;
  const entry: RecentMatrix = {
    path,
    name: file.name,
    savedAt: file.savedAt,
    detectorCount: file.detectors.count,
    fluorophoreCount: file.spectra.filter((s) => !s.isAutofluorescence).length,
    cytometer: file.instrument.cytometer,
    usedAt: new Date().toISOString(),
  };
  // Keyed by path, so re-saving over the same file updates rather than duplicates.
  const next = [entry, ...recentMatrices().filter((r) => r.path !== path)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* A full or disabled localStorage must not break saving a matrix. */
  }
}

export function forgetMatrix(path: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentMatrices().filter((r) => r.path !== path)));
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------
   Capture
   ------------------------------------------------------------------------- */

/**
 * Build the portable file from the current reference panel.
 *
 * Reads the control assignments and gate names as well as the spectra, because
 * the point of the file is that it explains itself later — "9 signatures, 64
 * detectors" is not something anyone can verify, but "CD3 PerCP-Cy5.5 from
 * Beads_CD3.fcs, gate CD3 +" is.
 */
export function captureUnmixingMatrix(name: string): UnmixingMatrixFile {
  const spectral = useSpectral.getState();
  const samples = useWorkspace.getState().samples;
  const gates = useGates.getState();

  if (spectral.spectra.length === 0) {
    // Named for the panel the matrix would have come from. `kind` is descriptive
    // and set by whatever built the matrix, so it is right here even though
    // there is nothing to save — it still records which panel is empty.
    const noun = spectral.kind === 'compensation' ? 'compensation' : 'unmixing';
    throw new UnmixingFileError(
      `There is no ${noun} matrix to save.`,
      `Gate each control’s positive population, then use Compute ${noun} matrix.`,
    );
  }

  const sampleById = new Map(samples.map((s) => [s.id, s]));

  // Detector configuration comes from a sample that actually contributed a
  // signature — not from whatever happens to be selected, which may not even be
  // a spectral file.
  const source = spectral.spectra
    .map((s) => (s.sourceSampleId ? sampleById.get(s.sourceSampleId) : undefined))
    .find((s): s is Sample => !!s) ?? samples.find((s) => detectorIndices(s.parsed.metadata).length > 0);

  const indices = source ? detectorIndices(source.parsed.metadata) : [];
  const names = source ? detectorNamesOf(source.parsed.metadata, indices) : [];

  const controls: ControlProvenance[] = spectral.controls.map((c) => {
    const sample = sampleById.get(c.sampleId);
    const gate = c.positiveGateId
      ? gates.gatesFor(c.sampleId).find((g) => g.id === c.positiveGateId)
      : undefined;
    const spectrum = spectral.spectra.find((s) => s.sourceSampleId === c.sampleId);
    return {
      label: c.label,
      fileName: sample?.fileName ?? '(file no longer loaded)',
      // An unassigned role cannot reach here — Step 2 blocks on it — but the
      // field is nullable in the model, and the file's schema is not.
      role: c.role ?? 'stain',
      gateName: gate?.name ?? null,
      eventsUsed: spectrum?.eventCount ?? 0,
      // Recorded because it changes what the signature *is*: a self-referencing
      // control's signature has its own negative population subtracted out.
      reference: c.reference,
    };
  });

  const spectra: StoredSpectrum[] = spectral.spectra.map((s) => ({
    id: s.id,
    label: s.label,
    values: Array.from(s.values),
    isAutofluorescence: s.isAutofluorescence,
    eventCount: s.eventCount,
    source: s.source,
    sourceFileName: s.sourceSampleId ? sampleById.get(s.sourceSampleId)?.fileName : undefined,
  }));

  const sim = similarityMatrix(spectral.spectra);
  const md = source?.parsed.metadata;
  const instrument = {
    cytometer: md?.cytometer ?? null,
    cytometerSerial: md?.cytometerSerial ?? null,
    software: md?.software ?? null,
  };

  return {
    kind: UNMIX_FILE_KIND,
    version: UNMIX_FILE_VERSION,
    application: 'MCFlow',
    // Recorded from the matrix, not from the panel that pressed Save. They agree
    // in practice; when they cannot — a spectral matrix loaded and re-saved from
    // wherever the user happens to be standing — what the numbers *are* is the
    // one of the two that survives being emailed.
    model: spectral.kind,
    name,
    savedAt: new Date().toISOString(),
    summary: summarise({
      name,
      spectra: spectral.spectra,
      detectorCount: names.length,
      instrument,
      controls,
      computedAt: spectral.computedAt,
    }),
    instrument,
    detectors: { count: names.length, names, indices },
    spectra,
    autofluorescence: spectra.find((s) => s.isAutofluorescence) ?? null,
    similarity: { size: spectral.spectra.length, values: Array.from(sim) },
    method: spectral.method,
    weights: spectral.weights ? Array.from(spectral.weights) : null,
    controls,
  };
}

/* -------------------------------------------------------------------------
   Save / load
   ------------------------------------------------------------------------- */

/**
 * Save through the platform file dialog. Returns the path, or null if cancelled.
 *
 * **The extension follows the matrix, not the caller.** `captureUnmixingMatrix`
 * has just read `kind` off the store to stamp `model` into the file, and the
 * suggested filename is read from the same answer — so the two cannot disagree,
 * which they could if this took the model as an argument and a caller passed the
 * panel it happened to be in.
 */
export async function saveUnmixingMatrixToFile(name: string): Promise<string | null> {
  const file = captureUnmixingMatrix(name);
  const model: MatrixModel = file.model ?? 'unmixing';
  const p = platform();
  const safe = name.replace(/[^A-Za-z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '') || 'panel';
  const target = await p.saveFileDialog(
    `${safe}.${extensionFor(model)}`,
    matrixFilters(model).slice(0, 1),
  );
  if (!target) return null;
  await p.writeFile(target, serialiseUnmixingMatrix(file));
  rememberMatrix(target, file);
  return target;
}

export interface LoadedMatrix {
  file: UnmixingMatrixFile;
  path: string;
}

/**
 * `.unmixing` or `.compensation`, and nothing else (2026-08-11 Item 17;
 * widened 2026-08-29).
 *
 * Checked rather than merely filtered. The dialog's filter is a convenience —
 * *All files* is one dropdown away, and a path handed in from a saved workspace
 * never went through a dialog at all — so a filter alone would leave a
 * `.fcunmix.json` loading fine while the panel claimed it no longer did. That is
 * the worst of the three states: not supported, not refused, and not stated.
 *
 * **One guard for both extensions, and it is deliberately not two.** The
 * compensation panel accepts a `.unmixing` and the unmixing panel accepts a
 * `.compensation`, because they are the same format and the real check is
 * `checkDetectorCompatibility` — names and order, which is what actually decides
 * whether a matrix may be applied to a sample. Refusing by extension would add a
 * second, weaker gate that fires first and gets it wrong: every square matrix
 * saved before 2026-08-29 is a `.unmixing`, and a 13-detector matrix cannot
 * reach an Aurora file anyway.
 *
 * A `.mcflow.unmixing` written between 2026-08-08 and now **does** pass, and
 * that is not an exemption. Its last extension segment is `unmixing`; the double
 * form was always the same file type to the shell, so refusing it would mean
 * inventing a distinction the operating system does not make in order to reject
 * a file this build writes byte-identically.
 */
export function requireMatrixExtension(path: string): void {
  if (/\.(unmixing|compensation)$/i.test(path)) return;
  throw new UnmixingFileError(
    `“${path.split(/[\\/]/).pop() ?? path}” is not a matrix file.`,
    'MCFlow reads .unmixing and .compensation files. A matrix saved by an older build under another name still loads — rename it first; the contents did not change.',
  );
}

/**
 * Open a matrix through the file picker. Null when cancelled.
 *
 * `prefer` orders the dialog's filters so the panel you are standing in offers
 * its own extension first. It never restricts what is accepted — see
 * `requireMatrixExtension`.
 */
export async function pickUnmixingMatrix(prefer: MatrixModel = 'unmixing'): Promise<LoadedMatrix | null> {
  const p = platform();
  const picked = await p.openTextFile?.(matrixFilters(prefer));
  if (!picked) return null;
  requireMatrixExtension(picked.path);
  return { file: parseUnmixingMatrix(picked.text), path: picked.path };
}

/** Read a matrix from a known path, e.g. the one a workspace recorded. */
export async function readUnmixingMatrix(path: string): Promise<LoadedMatrix> {
  const p = platform();
  if (!p.readFile) {
    throw new UnmixingFileError(
      'Reading a matrix by path needs the desktop app.',
      'In a browser tab, use Load matrix and pick the file.',
    );
  }
  requireMatrixExtension(path);
  const buf = await p.readFile(path);
  return { file: parseUnmixingMatrix(new TextDecoder().decode(buf)), path };
}

/* -------------------------------------------------------------------------
   Applying
   ------------------------------------------------------------------------- */

export interface ApplyReport {
  applied: boolean;
  /** Per-sample compatibility, for every spectral sample currently loaded. */
  checks: Array<{ sampleId: string; sampleName: string; report: CompatibilityReport }>;
  message: string;
}

/**
 * Validate a matrix against the loaded samples, then install it.
 *
 * Validation is per-sample and reported per-sample: a workspace can legitimately
 * hold files from two instruments, and "incompatible" is the wrong answer when
 * the matrix fits four of five samples.
 *
 * The matrix is installed when it is compatible with at least one loaded
 * spectral sample, or when none is loaded at all — loading a matrix into an
 * empty workspace is an explicitly supported flow, and there is nothing to
 * validate against until files arrive.
 */
export function applyUnmixingMatrix(
  file: UnmixingMatrixFile,
  samples: Sample[],
  path?: string | null,
): ApplyReport {
  const spectralSamples = samples.filter((s) => detectorIndices(s.parsed.metadata).length > 0);

  /*
     What the loaded matrix calls itself.

     Until 2026-08-29 a loaded matrix always read as `'unmixing'`, on the
     reasoning that the solve does not care — which is true of the arithmetic and
     false of everything a reader sees. `kind` decides whether `runUnmixing` tags
     its output `'compensated'` or `'unmixed'`, so a compensation panel saved,
     reopened and applied produced parameters labelled *Unmixed* in every picker
     in the application. The file now says; a file written before it says can be
     asked by name, which is the one place a filename is allowed to answer
     anything here, and only because nothing else can.
  */
  const model: MatrixModel = file.model ?? (path ? modelFromPath(path) : 'unmixing');

  const checks = spectralSamples.map((s) => {
    const indices = detectorIndices(s.parsed.metadata);
    return {
      sampleId: s.id,
      sampleName: s.name,
      report: checkDetectorCompatibility(file, detectorNamesOf(s.parsed.metadata, indices)),
    };
  });

  const compatible = checks.filter((c) => c.report.ok);

  if (spectralSamples.length > 0 && compatible.length === 0) {
    // Every loaded sample disagrees. Report the first one's detail rather than a
    // generic refusal — it names the detectors that differ.
    return {
      applied: false,
      checks,
      message: checks[0]?.report.message ?? 'No loaded sample matches this matrix’s detector configuration.',
    };
  }

  useSpectral.setState({
    spectra: toReferenceSpectra(file),
    // The file's own column order, which is what compatibility was just checked
    // against — so the signature plot names its axis even in a workspace with no
    // samples in it yet.
    detectorNames: [...file.detectors.names],
    /*
       The stored method is read and **not** applied.

       A saved file records which solve produced it, which is worth keeping as
       provenance; it is not a preference this build honours, because this build
       has one method. A matrix saved when the OLS/Weighted control existed would
       otherwise reach in and quietly switch the arithmetic back for whoever
       opened it. See `SpectralState.method`.
    */
    weights: file.weights ? Float64Array.from(file.weights) : null,
    kind: model,
    // Every line visible — see `computeMatrix`.
    previewIds: file.spectra.map((s) => s.id),
    computedAt: file.savedAt,
    // The panel came from elsewhere, so any local control assignments describe a
    // different matrix. Clearing them keeps the checklist honest rather than
    // implying these gates produced the loaded signatures.
    controls: [],
    selectedIds: [],
    generalGateId: null,
    /*
       Straight to the *Load unmixing* tab, which is where a matrix is applied.

       This used to set `step: 5`, back when applying was the wizard's last step:
       a loaded matrix had already been through the first four somewhere else,
       and dropping the user on "select your reference controls" would have asked
       them to redo the work the file exists to avoid. That reasoning is intact;
       what changed is that applying is no longer a step, so there is a tab to
       land on instead of a step to skip to.
    */
    tab: 'load',
    loadedFrom: { path: null, name: file.name, savedAt: file.savedAt },
  });

  return {
    applied: true,
    checks,
    message: spectralSamples.length === 0
      ? `Loaded “${file.name}” — ${file.spectra.length} ${model === 'compensation' ? 'rows' : 'signatures'} across ${file.detectors.count} detectors. Import a multicolour sample to ${model === 'compensation' ? 'compensate' : 'unmix'} it.`
      : `Loaded “${file.name}” — compatible with ${compatible.length} of ${spectralSamples.length} loaded sample(s).`,
  };
}

/** Load from the picker, validate, apply and remember, in one action. */
export async function loadUnmixingMatrixFromFile(prefer: MatrixModel = 'unmixing'): Promise<{ report: ApplyReport; file: UnmixingMatrixFile; path: string } | null> {
  const loaded = await pickUnmixingMatrix(prefer);
  if (!loaded) return null;
  const report = applyUnmixingMatrix(loaded.file, useWorkspace.getState().samples, loaded.path);
  if (report.applied) {
    rememberMatrix(loaded.path, loaded.file);
    useSpectral.setState({ loadedFrom: { path: loaded.path, name: loaded.file.name, savedAt: loaded.file.savedAt } });
  }
  return { report, file: loaded.file, path: loaded.path };
}

/** Load a specific path from the reuse list. */
export async function loadUnmixingMatrixByPath(path: string): Promise<{ report: ApplyReport; file: UnmixingMatrixFile }> {
  const loaded = await readUnmixingMatrix(path);
  const report = applyUnmixingMatrix(loaded.file, useWorkspace.getState().samples, path);
  if (report.applied) {
    rememberMatrix(path, loaded.file);
    useSpectral.setState({ loadedFrom: { path, name: loaded.file.name, savedAt: loaded.file.savedAt } });
  }
  return { report, file: loaded.file };
}

export { UnmixingFileError };
