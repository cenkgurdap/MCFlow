import type { FcsMetadata } from './fcs/types';
import type { ReferenceSpectrum, UnmixingSetup } from './spectral';

/* ==========================================================================
   Conventional compensation.

   ## Why this is back (2026-08-27)

   Compensation was built, shipped and removed on 2026-07-28, and the reason
   given was a measurement: `$SPILLOVER` is a 64×64 identity with
   `APPLY COMPENSATION = FALSE` in every real file, so the feature was a no-op
   wearing a control panel. That was true, and it was true of *the Aurora*. Every
   dataset in this repository came off one.

   A conventional reference panel carried a 13×13 spillover matrix with
   62 non-zero off-diagonals, the largest 0.87, `APPLY COMPENSATION = TRUE`, and
   **uncompensated data underneath it**. Measured rather than assumed: in the CD2
   PerCP-Cy5.5 single stain the positive population reads 0.265 of its primary
   detector in `r-LP685 720/30-B-A`, against the 0.2650 the file itself states.
   So the premise the removal rested on was a fact about one instrument, and the
   honest correction is to put the feature back for the instruments it is about.

   ## Compensation is unmixing with a square matrix

   That is the whole reason this file is ~200 lines and not a second solver.

   A spectral panel measures F fluorophores on D ≫ F detectors and recovers the
   abundances by least squares. A conventional panel measures F fluorophores on
   the F detectors they peak in, and recovers them by inverting an F×F matrix.
   Both are `y = x · S`, and the pseudo-inverse `core/spectral.ts` already builds
   *is* the inverse when S is square and well-conditioned. So this module builds
   S and hands it to `unmix()`; there is one solver in this application and this
   is not a second one.

   Two things differ, and both are properties of S rather than of the solve:

   - **A row is normalised to its dye's primary detector, not to its peak.** For
     a well-behaved dye those are the same detector; when they are not, the
     operator has said which one carries the dye, and the diagonal has to be 1
     or the compensated value comes out in units nobody can gate on. This is what
     makes the output *the classical compensated value in the detector's own
     scale* — the same number FlowJo and FACSDiva print — rather than an
     abundance in arbitrary units.
   - **There is no autofluorescence row.** A spectral solve gains resolution from
     one, because it has detectors to spare. A square system has none: an extra
     row makes F+1 unknowns from F measurements, and `pseudoInverse` will not say
     so — it degrades gracefully, which is exactly the trap that put ±28 million
     into a background abundance when a panel carried two background tubes. The
     unstained tube is the negative reference each signature is subtracted
     against, and that is the whole of its job here.

   ## What is *not* here

   No pipeline stage. The architecture is `raw → transformed → display` with no
   correction step, and compensated columns are **attached, never substituted**,
   through the same registry unmixed abundances use. `parsed.data` is still the
   file's own values. That is what lets Statistics, Export, Biophysics and every
   picker work on a compensated panel without one special case between them.
   ========================================================================== */

/**
 * A square spillover matrix, in the orientation the FCS standard defines.
 *
 * `values[i * size + j]` is the fraction of the dye whose primary detector is
 * `i` that is measured in detector `j`, so the measured vector is `y = x · S`
 * and the compensated one is `x = y · S⁻¹`. The diagonal is 1.
 *
 * `detectors` names the rows *and* the columns — they are the same list, which
 * is what makes the system square and is the one thing that has to be true for
 * any of this to mean anything.
 */
export interface CompensationMatrix {
  detectors: string[];
  /** Row-major `size × size`. */
  values: Float64Array;
  size: number;
}

/**
 * Read the matrix the acquisition software wrote into the file.
 *
 * This is the path most conventional users will take and it costs nothing: the
 * parser already turns `$SPILLOVER` / `SPILL` into a `SpilloverMatrix`, and
 * FACSDiva computed it from the same single stains at acquisition. `null` when
 * the file carries none, or when it carries the identity — an identity matrix
 * says the writer had nothing to correct, and applying it would produce a copy
 * of the raw channels under a second set of names.
 *
 * The diagonal is normalised to 1 rather than trusted. A row scaled by anything
 * else is still algebraically fine, but it puts that dye's compensated values on
 * a scale of the file's choosing, and the point of the diagonal being 1 is that
 * a gate drawn on the raw detector still means something on the compensated one.
 */
export function matrixFromFile(md: FcsMetadata): CompensationMatrix | null {
  const sp = md.spillover;
  if (!sp || sp.isIdentity || sp.size === 0) return null;
  return normaliseDiagonal({
    detectors: [...sp.parameters],
    values: Float64Array.from(sp.values),
    size: sp.size,
  });
}

/**
 * Which detector a dye is measured on: the one its signature peaks in.
 *
 * Taken over the **signature**, which is `positive median − negative median` in
 * channel units, and that qualifier is the whole of it. *"The brightest
 * detector"* is the wrong question about a stained cell — cells are
 * autofluorescent across the UV block more brightly than a far-red dye is in its
 * own channel, and asking it of raw medians once put four far-red dyes on UV7-A.
 * Asking it of the difference removes the background first, which is what makes
 * the answer about the dye.
 *
 * It is a **default**, not a decision: the panel shows it and the operator can
 * re-point it, exactly as the unmixing wizard's assignment step does. Nothing
 * downstream may infer a primary detector any other way.
 */
export function primaryDetectorOf(signature: Float64Array): number {
  let best = 0;
  for (let d = 1; d < signature.length; d++) if (signature[d]! > signature[best]!) best = d;
  return best;
}

/** One control's contribution to the matrix. */
export interface CompensationRow {
  /** Display name for the compensated parameter, e.g. "CD2 PerCP-Cy5.5". */
  label: string;
  /**
   * Index into `detectorNames` of the detector this dye is measured on.
   *
   * Chosen by `primaryDetectorOf` and confirmed or corrected by the operator.
   */
  primary: number;
  /**
   * The signature in **channel units** — `positive median − negative median`,
   * one value per detector in `detectorNames` order.
   *
   * Channel units, not normalised, because the row is about to be divided by its
   * own primary and a spectrum that has already been divided by its peak cannot
   * be. `extractGatedSignature` returns exactly this as `raw`.
   */
  signature: Float64Array;
}

export class CompensationError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'CompensationError';
  }
}

/**
 * Build the matrix from one signature per single stain.
 *
 * ## Why it spans every detector and not just the claimed ones
 *
 * The minimal square system is one row and one column per dye — eleven of each
 * on that panel, leaving out the two detectors no dye peaks in, both named
 * *Available*. That is the textbook construction and it is what this returned
 * first. Two things make the full detector set better, and neither costs an
 * answer:
 *
 * - **It changes nothing.** With identity rows for the unclaimed detectors, S is
 *   `[[A, B], [0, I]]`, so `S⁻¹` is `[[A⁻¹, −A⁻¹B], [0, I]]` and the eleven real
 *   compensated values are `y·A⁻¹` exactly — the minimal system's answer, to the
 *   bit. The extra columns are the unclaimed detectors' own compensated values,
 *   which is what FACSDiva shows for them too.
 * - **A matrix is validated by detector name *and order*.** `.unmixing` files
 *   are checked against `detectorIndices` of the file they are applied to, and a
 *   matrix spanning eleven of thirteen detectors matches no file at all. One
 *   shape for a matrix read out of a file and a matrix built from controls is
 *   also one shape for everything downstream to reason about.
 *
 * Two controls claiming one detector is refused rather than solved. It makes S
 * singular, and `pseudoInverse` answers a singular system with plausible numbers
 * instead of an error — the failure mode this project has already been bitten by
 * twice, and the condition number is the only reader that notices.
 */
export function matrixFromControls(
  rows: CompensationRow[],
  detectorNames: string[],
): CompensationMatrix {
  if (rows.length === 0) {
    throw new CompensationError(
      'No single-stain controls assigned.',
      'Assign one control per fluorophore, and gate its positive and negative populations.',
    );
  }

  const size = detectorNames.length;
  const claimed = new Map<number, string>();
  for (const r of rows) {
    const held = claimed.get(r.primary);
    if (held !== undefined) {
      throw new CompensationError(
        `${held} and ${r.label} are both assigned to ${detectorNames[r.primary] ?? 'the same detector'}.`,
        'Compensation solves one dye per detector. Re-point one of them, or drop the control.',
      );
    }
    if (r.primary < 0 || r.primary >= size) {
      throw new CompensationError(`${r.label} is assigned to a detector this panel does not have.`);
    }
    claimed.set(r.primary, r.label);
    const own = r.signature[r.primary];
    if (own === undefined || !(own > 0)) {
      throw new CompensationError(
        `${r.label} reads nothing on ${detectorNames[r.primary] ?? 'its assigned detector'}.`,
        'The positive population is not above the negative one on that detector. Check the gates, or pick the detector the dye actually peaks in.',
      );
    }
  }

  const values = new Float64Array(size * size);
  // Identity first: a detector no dye peaks in contributes itself and nothing
  // else, which is the only honest row for a fluorophore that was never in a
  // tube. FACSDiva writes the same rows for the same detectors.
  for (let i = 0; i < size; i++) values[i * size + i] = 1;

  for (const r of rows) {
    const own = r.signature[r.primary]!;
    for (let j = 0; j < size; j++) values[r.primary * size + j] = (r.signature[j] ?? 0) / own;
  }
  return { detectors: [...detectorNames], values, size };
}

/** Which rows of a matrix a control claimed, by detector index. Identity elsewhere. */
export function claimedDetectors(rows: CompensationRow[]): Map<number, string> {
  return new Map(rows.map((r) => [r.primary, r.label]));
}

/**
 * What each compensated column is called, one per row of the matrix.
 *
 * Three sources, in order of how much anybody actually said:
 *
 * 1. **What the operator typed** — the control's label, for a detector a dye was
 *    assigned to. Nothing beats somebody naming their own panel.
 * 2. **`$PnS`** — the marker the instrument recorded on that detector. On a
 *    FACSDiva file this is populated (`CD3 FITC`), which is why reading the
 *    matrix out of the file gives usable names with nobody assigning anything.
 *    It is the file's own statement, not an inference from one.
 * 3. **The detector's name**, when neither of the above says anything useful.
 *
 * The fallback matters more than it looks. A conventional panel can have detectors whose
 * `$PnS` is the literal string *Available*, and two parameters with one name is
 * a picker nobody can use — so a name already taken drops to the detector, which
 * is unique by construction.
 */
export function compensationLabels(
  md: FcsMetadata,
  matrix: CompensationMatrix,
  assigned?: Map<number, string>,
): string[] {
  const taken = new Set<string>();
  return matrix.detectors.map((detector, i) => {
    const parameterIndex = md.parameters.findIndex((p) => p.name === detector);
    const stain = parameterIndex >= 0 ? md.parameters[parameterIndex]!.stain.trim() : '';
    for (const candidate of [assigned?.get(i), stain, detector]) {
      const name = candidate?.trim();
      if (name && !taken.has(name)) { taken.add(name); return name; }
    }
    // Every earlier candidate is taken, which means two detectors share a name.
    // Number it rather than return a duplicate.
    let n = 2;
    while (taken.has(`${detector} ${n}`)) n++;
    taken.add(`${detector} ${n}`);
    return `${detector} ${n}`;
  });
}

/**
 * Turn a matrix into the setup `unmix()` takes.
 *
 * `detectorIndices` comes from the **matrix's** names, in the matrix's order,
 * because the columns are positional: a matrix applied to the right detectors in
 * the wrong order produces plausible numbers rather than an error. That is the
 * same rule `checkDetectorCompatibility` states for a saved `.unmixing`, and it
 * is checked here rather than assumed because a matrix read out of one file may
 * be applied to another.
 *
 * `labels` names each compensated parameter, one per row. Passed in rather than
 * computed here because the two sources differ — from the file the name is the
 * detector's `$PnS`, from the controls it is what the operator typed — and
 * `compensationLabels` is where that order of preference lives. Defaults to the
 * detector names, which is always available and never ambiguous.
 */
export function compensationSetup(
  md: FcsMetadata,
  matrix: CompensationMatrix,
  labels: string[] = matrix.detectors,
): UnmixingSetup {
  const detectorIndices: number[] = [];
  const missing: string[] = [];
  for (const name of matrix.detectors) {
    const i = md.parameters.findIndex((p) => p.name === name);
    if (i < 0) missing.push(name);
    else detectorIndices.push(i);
  }
  if (missing.length > 0) {
    throw new CompensationError(
      `This sample has no detector named ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` (and ${missing.length - 3} more)` : ''}.`,
      'A compensation matrix is positional. Samples must be acquired on the same detector configuration as the controls.',
    );
  }

  const spectra: ReferenceSpectrum[] = matrix.detectors.map((name, i) => ({
    id: `comp-${i}`,
    label: labels[i] ?? name,
    values: matrix.values.slice(i * matrix.size, (i + 1) * matrix.size),
    // Never. A square system has no room for a background row, and the flag is
    // what `surfacedSignatures` reads to decide which columns become parameters
    // — every one of these does.
    isAutofluorescence: false,
    sourceSampleId: null,
    eventCount: 0,
  }));

  return { detectorIndices, detectorNames: [...matrix.detectors], spectra };
}

/**
 * The largest spillover in the matrix, and between which pair.
 *
 * What a panel shows to answer *"is this matrix doing anything, and where"*. A
 * coefficient above ~0.5 is a pair of dyes that would be better resolved on the
 * instrument than in software, which is the same thing the unmixing panel says
 * about a cosine above 0.9.
 */
export function worstSpillover(m: CompensationMatrix): { from: number; to: number; value: number } | null {
  let best: { from: number; to: number; value: number } | null = null;
  for (let i = 0; i < m.size; i++) {
    for (let j = 0; j < m.size; j++) {
      if (i === j) continue;
      const v = Math.abs(m.values[i * m.size + j]!);
      if (!best || v > best.value) best = { from: i, to: j, value: v };
    }
  }
  return best;
}

/**
 * How far two matrices over the same detectors disagree.
 *
 * Written for the comparison that validates this module: a matrix computed here
 * from a conventional panel's single stains against the one FACSDiva wrote into the same
 * files at acquisition. An external reference is worth more than any number of
 * self-consistent tests — it is the role FCS Express played for the unmixing
 * signatures — and this is the function that states the result.
 *
 * `null` when the two do not span the same detectors, which is not a small
 * difference to report as a large one.
 */
export function matrixDeviation(a: CompensationMatrix, b: CompensationMatrix): {
  max: number;
  mean: number;
  /**
   * The middle coefficient's disagreement.
   *
   * Reported beside the mean because on a real panel the two say different
   * things: against FACSDiva on that panel the median was 0.004 and the mean
   * 0.010, and the gap is three compound controls rather than a general
   * disagreement. A mean alone would hide that; a maximum alone would be all
   * anyone saw.
   */
  median: number;
  /** How many off-diagonal coefficients were compared. */
  count: number;
  at: { from: string; to: string } | null;
} | null {
  const index = new Map(b.detectors.map((d, i) => [d, i]));
  if (a.detectors.some((d) => !index.has(d))) return null;

  const diffs: number[] = [];
  let max = 0;
  let sum = 0;
  let at: { from: string; to: string } | null = null;
  for (let i = 0; i < a.size; i++) {
    for (let j = 0; j < a.size; j++) {
      if (i === j) continue;
      const bi = index.get(a.detectors[i]!)!;
      const bj = index.get(a.detectors[j]!)!;
      const d = Math.abs(a.values[i * a.size + j]! - b.values[bi * b.size + bj]!);
      diffs.push(d);
      sum += d;
      if (d > max) { max = d; at = { from: a.detectors[i]!, to: a.detectors[j]! }; }
    }
  }
  const n = diffs.length;
  diffs.sort((x, y) => x - y);
  return {
    max,
    mean: n ? sum / n : 0,
    median: n ? diffs[n >> 1]! : 0,
    count: n,
    at,
  };
}

/** Scale every row so its own detector reads exactly 1. */
function normaliseDiagonal(m: CompensationMatrix): CompensationMatrix {
  const out = Float64Array.from(m.values);
  for (let i = 0; i < m.size; i++) {
    const d = out[i * m.size + i]!;
    // A zero or negative diagonal is a broken row, not a scale to divide by.
    // Left as it is: `buildUnmixOperator`'s condition number is what reports it,
    // and silently rescaling by a near-zero would turn one bad row into a matrix
    // of enormous numbers.
    if (!(d > 0) || d === 1) continue;
    for (let j = 0; j < m.size; j++) out[i * m.size + j]! /= d;
  }
  return { ...m, values: out };
}
