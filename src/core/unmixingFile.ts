import type { FcsMetadata } from './fcs/types';
import type { ReferenceSpectrum, SignatureSource, UnmixMethod } from './spectral';

/* ==========================================================================
   The portable matrix — `.unmixing` and `.compensation`.

   A workspace records one analysis. A panel outlives it: the same eight
   fluorophores get run every week, on the same instrument, against a new
   multicolour sample each time. Storing the matrix only inside `.fcws.json`
   made it a property of one afternoon's work, so reusing it meant reopening the
   workspace it happened to be computed in.

   This file is the matrix as its own artefact. It carries enough context to be
   read months later by someone who was not there — which instrument, which
   control files, which panel, when — because a bare matrix of 9×64 floats is
   not something anyone can sanity-check by eye.

   Deliberately JSON rather than a binary format: it is small (~40 kB for a
   9-signature Aurora panel), it survives email and version control, and a
   scientist can open it and read the fluorophore names. Nothing here is on a
   hot path.
   ========================================================================== */

export const UNMIX_FILE_VERSION = 1;
/**
 * What a spectral save writes: `Panel-name.unmixing`.
 *
 * **This reverses the settled decision of 2026-08-08 and it drops the
 * compatibility that decision kept** (2026-08-11, Item 17), so both halves are
 * worth stating rather than being discovered.
 *
 * The extension has been three things. `.fcunmix.json` until 2026-08-08, when it
 * became `.mcflow.unmixing` on the reasoning that had moved the workspace from
 * `.fcws.json` to `.mcflow` five days earlier: a double extension ending in
 * `.json` hands the file to whatever edits JSON. That reasoning stands, and it
 * is satisfied by `.unmixing` alone — the leading `.mcflow.` was doing no work
 * the OS can see, because Windows and macOS both key an association off the
 * *last* segment, so `Panel.mcflow.unmixing` and `Panel.unmixing` were already
 * the same file type to the shell and the second is the one a person can read.
 *
 * And **the older extensions are no longer read.** The 2026-08-08 rename kept
 * them in the open dialog; this one does not, by explicit instruction. The
 * consequence is stated in `requireMatrixExtension`, which refuses a file whose
 * name ends in neither this nor `COMP_FILE_EXTENSION` rather than parsing it and
 * hoping — a matrix that loads under a name this build does not claim is a
 * compatibility promise made by accident.
 *
 * Nothing about the *format* has ever moved. This is still the same JSON, still
 * identified from the inside by `UNMIX_FILE_KIND`, and a `.fcunmix.json`
 * renamed to `.unmixing` loads perfectly — which is the migration, and it is one
 * rename per file rather than a compatibility path in the reader.
 */
export const UNMIX_FILE_EXTENSION = 'unmixing';

/**
 * And what a compensation save writes: `Panel-name.compensation` (2026-08-29).
 *
 * **The format is unchanged and both extensions parse through the same reader.**
 * That is the whole design, and it is worth stating because the obvious reading
 * of two extensions is two formats. A square spillover matrix and a spectral
 * signature panel are the same JSON — detector names, an order, a row per dye —
 * for the same reason there is one solver: `pseudoInverse` of a square,
 * well-conditioned S *is* its inverse. What differs is which panel produced it
 * and which words describe it.
 *
 * So why two names at all? Because the extension is what a person reads in a
 * folder six months later, and *multicolour samples.unmixing* sitting next to a
 * conventional experiment tells them something untrue about their instrument.
 * The same argument that moved `.fcws.json` to `.mcflow` and `.mcflow.unmixing`
 * to `.unmixing`: the name is a claim about the file, and a wrong claim costs
 * more than a duplicate one.
 *
 * `model` inside the file is the authoritative answer; the extension is the
 * answer for a file written before that field existed, and for a person.
 */
export const COMP_FILE_EXTENSION = 'compensation';

export const UNMIX_FILE_KIND = 'mcflow-unmixing-matrix';

/** Which panel a matrix came from. Prose and provenance, never arithmetic. */
export type MatrixModel = 'unmixing' | 'compensation';

/**
 * What the open dialog offers, with the caller's own kind first.
 *
 * **Both, in both panels.** The filter is a convenience and *All files* is one
 * dropdown away, so a list naming only one extension would imply a refusal the
 * reader does not make — and `requireMatrixExtension` accepts either, because
 * the file it is guarding is the same file. Ordering rather than excluding is
 * what makes the default right without making the other one a dead end: a lab
 * whose square matrices predate 2026-08-29 has a folder full of `.unmixing`,
 * and telling them to rename would be inventing work for a file that loads.
 *
 * `json` sat in this list until 2026-08-11 so that a `.fcunmix.json` saved
 * before the first rename stayed visible; it is gone with the read support it
 * existed for.
 */
export function matrixFilters(prefer: MatrixModel = 'unmixing') {
  const unmixing = { name: 'MCFlow unmixing matrix', extensions: [UNMIX_FILE_EXTENSION] };
  const compensation = { name: 'MCFlow compensation matrix', extensions: [COMP_FILE_EXTENSION] };
  return [
    ...(prefer === 'compensation' ? [compensation, unmixing] : [unmixing, compensation]),
    { name: 'All files', extensions: ['*'] },
  ];
}

/** The extension a save writes for each model. */
export function extensionFor(model: MatrixModel): string {
  return model === 'compensation' ? COMP_FILE_EXTENSION : UNMIX_FILE_EXTENSION;
}

/**
 * What a filename claims to be — the fallback when the file itself does not say.
 *
 * Only ever consulted for a file with no `model` field, which means one written
 * before 2026-08-29. Everything since carries its own answer, and that is the
 * order these two are asked in: this project does not infer from a filename,
 * and the exception is a file that has nothing else to offer.
 */
export function modelFromPath(path: string): MatrixModel {
  return /\.compensation$/i.test(path) ? 'compensation' : 'unmixing';
}

/** One signature, as stored. `Float64Array` does not survive JSON. */
export interface StoredSpectrum {
  id: string;
  label: string;
  values: number[];
  isAutofluorescence: boolean;
  eventCount: number;
  /** How the positive population was chosen: drawn, or the percentile estimate. */
  source?: SignatureSource;
  /** File the signature came from, for the provenance summary. */
  sourceFileName?: string;
}

/**
 * The instrument the controls were acquired on.
 *
 * Recorded because a matrix is only valid for the configuration that produced
 * it: detector gains, filters and laser powers all fold into the reference
 * signatures. Two Auroras are not interchangeable, which is why the serial
 * number is kept alongside the model.
 */
export interface InstrumentIdentity {
  cytometer: string | null;      // $CYT
  cytometerSerial: string | null; // $CYTSN
  software: string | null;        // CREATOR / $SYS
}

/** What a control contributed, in the terms the operator used. */
export interface ControlProvenance {
  label: string;
  fileName: string;
  /**
   * `autofluorescence` joined the pair on 2026-08-06.
   *
   * Widening rather than replacing, so a file written before it stays readable:
   * every value the old schema could hold is still one this one accepts. The
   * roles are the wizard's Step 2 roles, and the reason there are three rather
   * than two is that some panels carry a dedicated autofluorescence tube
   * alongside the unstained one and some treat them as the same file.
   */
  role: 'stain' | 'unstained' | 'autofluorescence';
  /** Name of the positive gate, when there was one. */
  gateName: string | null;
  eventsUsed: number;
  /**
   * Where this control's negative baseline came from — `self` for beads.
   *
   * Optional because a file written before the reference mode existed cannot
   * say, and absent means what the app did then: a separate unstained control.
   */
  reference?: 'unstained' | 'self';
}

export interface UnmixingMatrixFile {
  kind: typeof UNMIX_FILE_KIND;
  version: number;
  application: string;
  /**
   * Which panel built it — *not* which format this is (2026-08-29).
   *
   * `kind` above is the format marker and has never moved; this says whether
   * the rows are spectral signatures across the whole detector array or
   * spillover coefficients normalised to each dye's primary detector. It is
   * what lets a loaded matrix arrive already knowing what to call itself, so
   * applying one tags its parameters *Comp* rather than *Unmixed*.
   *
   * Optional, and absent means a file written before this field existed. No
   * version bump: a reader that ignores it loses nothing but the noun, and
   * `modelFromPath` answers for the files that predate it.
   */
  model?: MatrixModel;
  /** Panel name, chosen by the user when saving. */
  name: string;
  savedAt: string;
  /** One-paragraph plain-English description, for reading it back cold. */
  summary: string;

  instrument: InstrumentIdentity;

  detectors: {
    count: number;
    /** `$PnN` names in matrix column order — this is what compatibility checks. */
    names: string[];
    /** Parameter indices in the source files, for reference only. */
    indices: number[];
  };

  /** Every signature including autofluorescence, in matrix row order. */
  spectra: StoredSpectrum[];
  /**
   * The autofluorescence signature, called out separately.
   *
   * It is also present in `spectra` — this is a pointer, not a second copy, so
   * a reader can find it without re-deriving "the one with the flag set".
   */
  autofluorescence: StoredSpectrum | null;

  /** Row-major n×n cosine similarity, so the QC view needs no recomputation. */
  similarity: { size: number; values: number[] };

  method: UnmixMethod;
  /** Per-detector WLS weights, when they were derived. */
  weights: number[] | null;

  controls: ControlProvenance[];
}

export class UnmixingFileError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'UnmixingFileError';
  }
}

/* -------------------------------------------------------------------------
   Writing
   ------------------------------------------------------------------------- */

/**
 * Human-readable one-paragraph summary, generated at save time.
 *
 * Written into the file rather than derived on load so it describes what was
 * true when the matrix was computed. A summary regenerated later from whatever
 * happens to be loaded would quietly describe a different thing.
 */
export function summarise(input: {
  name: string;
  spectra: ReferenceSpectrum[];
  detectorCount: number;
  instrument: InstrumentIdentity;
  controls: ControlProvenance[];
  computedAt: string | null;
}): string {
  const stains = input.spectra.filter((s) => !s.isAutofluorescence);
  const af = input.spectra.some((s) => s.isAutofluorescence);
  const when = input.computedAt ? new Date(input.computedAt) : new Date();
  const instrument = [input.instrument.cytometer, input.instrument.cytometerSerial]
    .filter(Boolean)
    .join(' ');

  const files = input.controls.map((c) => c.fileName);
  const fileList = files.length <= 4
    ? files.join(', ')
    : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;

  return [
    `${input.name}: ${stains.length} fluorophore${stains.length === 1 ? '' : 's'}`,
    af ? ' plus an autofluorescence signature' : ' with no autofluorescence signature',
    ` across ${input.detectorCount} detectors`,
    instrument ? `, acquired on ${instrument}` : '',
    `. Computed ${when.toLocaleDateString()} ${when.toLocaleTimeString()}`,
    files.length ? ` from ${fileList}.` : '.',
  ].join('');
}

export function serialiseUnmixingMatrix(file: UnmixingMatrixFile): string {
  return JSON.stringify(file, null, 2);
}

/* -------------------------------------------------------------------------
   Reading
   ------------------------------------------------------------------------- */

/**
 * Parse and validate a matrix file, under either extension.
 *
 * Nothing here reads the filename: the `kind` marker inside the file is what
 * identifies it, which is why the rename cost no compatibility. A
 * `.fcunmix.json` written last month parses through this function unchanged.
 *
 * Validates rather than trusting. This file is explicitly designed to be
 * emailed between labs and reloaded months later, so the failure a user will
 * actually hit is a wrong or truncated file — which has to say so rather than
 * half-loading into a panel that then unmixes to garbage.
 */
export function parseUnmixingMatrix(json: string): UnmixingMatrixFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new UnmixingFileError(
      'This file is not valid JSON.',
      'A matrix file is plain JSON — it may have been truncated, or it is not a matrix file at all.',
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new UnmixingFileError('This file does not contain a matrix.');
  }

  const f = raw as Partial<UnmixingMatrixFile>;

  // The kind marker is checked before anything else: a workspace file is also
  // valid JSON with a `version`, and telling someone their matrix is corrupt
  // when they picked the wrong file is a worse error than the one they made.
  if (f.kind !== UNMIX_FILE_KIND) {
    throw new UnmixingFileError(
      'This is not an MCFlow matrix file.',
      f.kind === undefined && Array.isArray((f as { samples?: unknown[] }).samples)
        ? 'It looks like a workspace (.mcflow, or .fcws.json if it was saved before 2026-08-03). Use File ▸ Open Workspace for that.'
        : `Expected a file marked "${UNMIX_FILE_KIND}".`,
    );
  }
  if (typeof f.version !== 'number') {
    throw new UnmixingFileError('This matrix file has no version and cannot be read safely.');
  }
  if (f.version > UNMIX_FILE_VERSION) {
    throw new UnmixingFileError(
      `This matrix was saved by a newer version of MCFlow (format ${f.version}, this build reads ${UNMIX_FILE_VERSION}).`,
      'Update MCFlow, or ask whoever sent it to export from an older version.',
    );
  }
  if (!Array.isArray(f.spectra) || f.spectra.length === 0) {
    throw new UnmixingFileError('This matrix file contains no reference spectra.');
  }
  if (!f.detectors || !Array.isArray(f.detectors.names)) {
    throw new UnmixingFileError('This matrix file records no detector configuration.', 'Without it there is no way to check the matrix against a sample.');
  }

  const detectorCount = f.detectors.count ?? f.detectors.names.length;

  // Every spectrum must span the recorded detector count, or the matrix is
  // internally inconsistent and `unmix` would throw much further downstream
  // with a message about the sample rather than about the file.
  for (const s of f.spectra) {
    if (!Array.isArray(s.values) || s.values.length !== detectorCount) {
      throw new UnmixingFileError(
        `Reference spectrum “${s.label ?? 'unnamed'}” covers ${Array.isArray(s.values) ? s.values.length : 0} detectors but the file records ${detectorCount}.`,
        'The file is internally inconsistent and was probably edited by hand.',
      );
    }
  }

  const similaritySize = f.similarity?.size ?? 0;
  const similarityValues = Array.isArray(f.similarity?.values) ? f.similarity!.values : [];

  return {
    kind: UNMIX_FILE_KIND,
    version: f.version,
    application: f.application ?? 'MCFlow',
    // Left `undefined` when the file does not say, rather than defaulted to
    // `'unmixing'` here: the caller knows the path and `modelFromPath` is a
    // better guess than this function can make. Defaulting would hide that.
    model: f.model === 'compensation' || f.model === 'unmixing' ? f.model : undefined,
    name: f.name ?? 'Unnamed panel',
    savedAt: f.savedAt ?? new Date().toISOString(),
    summary: f.summary ?? '',
    instrument: {
      cytometer: f.instrument?.cytometer ?? null,
      cytometerSerial: f.instrument?.cytometerSerial ?? null,
      software: f.instrument?.software ?? null,
    },
    detectors: {
      count: detectorCount,
      names: f.detectors.names,
      indices: Array.isArray(f.detectors.indices) ? f.detectors.indices : [],
    },
    spectra: f.spectra,
    autofluorescence: f.autofluorescence ?? f.spectra.find((s) => s.isAutofluorescence) ?? null,
    similarity: similaritySize > 0 && similarityValues.length === similaritySize * similaritySize
      ? { size: similaritySize, values: similarityValues }
      : { size: 0, values: [] },
    method: f.method === 'wls' ? 'wls' : 'ols',
    weights: Array.isArray(f.weights) && f.weights.length === detectorCount ? f.weights : null,
    controls: Array.isArray(f.controls) ? f.controls : [],
  };
}

/** Turn stored spectra back into the in-memory form the unmixer takes. */
export function toReferenceSpectra(file: UnmixingMatrixFile): ReferenceSpectrum[] {
  return file.spectra.map((s) => ({
    id: s.id,
    label: s.label,
    values: Float64Array.from(s.values),
    isAutofluorescence: s.isAutofluorescence,
    // The sample it came from is not in this workspace — and saying so is more
    // honest than pointing at an id that may coincidentally exist here.
    sourceSampleId: null,
    eventCount: s.eventCount,
    source: s.source,
  }));
}

/* -------------------------------------------------------------------------
   Compatibility
   ------------------------------------------------------------------------- */

export interface CompatibilityReport {
  ok: boolean;
  /** Single-sentence verdict, safe to show as-is. */
  message: string;
  /** Detectors in the file but not the sample, by name. */
  missing: string[];
  /** Detectors in the sample but not the file. */
  extra: string[];
  /** Positions where both have a detector but the names differ. */
  reordered: Array<{ index: number; expected: string; found: string }>;
  fileDetectorCount: number;
  sampleDetectorCount: number;
}

/**
 * Check a saved matrix against a sample's detector configuration.
 *
 * Names, not just counts. Two Aurora configurations can both have 64 detectors
 * and still be different instruments — and applying a matrix built for one to
 * data from the other produces plausible-looking numbers that are wrong, which
 * is the worst possible failure mode. So the check reports *which* detectors
 * differ rather than a bare yes/no.
 */
export function checkDetectorCompatibility(
  file: UnmixingMatrixFile,
  sampleDetectorNames: string[],
): CompatibilityReport {
  const expected = file.detectors.names;
  const found = sampleDetectorNames;

  const expectedSet = new Set(expected);
  const foundSet = new Set(found);
  const missing = expected.filter((n) => !foundSet.has(n));
  const extra = found.filter((n) => !expectedSet.has(n));

  const reordered: CompatibilityReport['reordered'] = [];
  for (let i = 0; i < Math.min(expected.length, found.length); i++) {
    if (expected[i] !== found[i]) reordered.push({ index: i, expected: expected[i]!, found: found[i]! });
  }

  const base = {
    missing,
    extra,
    reordered,
    fileDetectorCount: expected.length,
    sampleDetectorCount: found.length,
  };

  if (expected.length !== found.length) {
    return {
      ...base,
      ok: false,
      message:
        `This matrix was built for ${expected.length} detectors but the sample has ${found.length}. ` +
        (missing.length ? `Missing here: ${list(missing)}. ` : '') +
        (extra.length ? `Not in the matrix: ${list(extra)}.` : ''),
    };
  }

  if (missing.length > 0 || extra.length > 0) {
    return {
      ...base,
      ok: false,
      message:
        `Both have ${expected.length} detectors, but they are not the same set. ` +
        (missing.length ? `In the matrix but not the sample: ${list(missing)}. ` : '') +
        (extra.length ? `In the sample but not the matrix: ${list(extra)}.` : ''),
    };
  }

  if (reordered.length > 0) {
    // Same detectors, different order. The matrix columns are positional, so
    // applying it would silently pair each signature with the wrong detector.
    const first = reordered[0]!;
    return {
      ...base,
      ok: false,
      message:
        `The detectors match but are in a different order — ${reordered.length} position${reordered.length === 1 ? '' : 's'} differ, ` +
        `starting at position ${first.index + 1} (matrix has ${first.expected}, sample has ${first.found}).`,
    };
  }

  return {
    ...base,
    ok: true,
    message: `Compatible: ${expected.length} detectors match by name and order.`,
  };
}

/** Detector names of a sample, in the order `detectorIndices` yields them. */
export function detectorNamesOf(md: FcsMetadata, indices: number[]): string[] {
  return indices.map((i) => md.parameters[i]?.name ?? `#${i}`);
}

/** "A, B and C", truncated — an error message listing 64 detectors helps nobody. */
function list(names: string[], limit = 6): string {
  if (names.length <= limit) {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}
