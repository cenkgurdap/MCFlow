/** FCS domain model. See PROGRESS.md for how these map onto the test data. */

export type FcsVersion = 'FCS2.0' | 'FCS3.0' | 'FCS3.1' | 'FCS3.2';

/**
 * `$PnTYPE` values written by SpectroFlo, plus two this application adds.
 *
 * `Derived` is not an FCS type — no parser ever produces one. It marks a
 * parameter computed from an expression over the others (see `core/derived.ts`),
 * and it exists as a type rather than as a flag so the two places that branch on
 * what a parameter *is* — the default transform, and the spectral panel's idea
 * of what can carry a signature — keep working without a second question.
 *
 * `Compensated_Fluorescence` is the same idea for the conventional side, and it
 * exists for one reason: a compensated CD2 channel tagged *Unmixed* on every
 * picker is a claim about how it was computed, and it is the wrong claim. The
 * two are the same shape — a computed fluorescence column attached to the file,
 * biexponential by default, framed on its own trimmed distribution — so nothing
 * else in the application branches on the difference. The tag does.
 */
export type ParameterType =
  | 'Time'
  | 'Forward_Scatter'
  | 'Side_Scatter'
  | 'Raw_Fluorescence'
  | 'Unmixed_Fluorescence'
  | 'Compensated_Fluorescence'
  | 'Derived'
  | 'Other';

export interface FcsParameter {
  /** 1-based index as it appears in the file (`$P{index}N`). */
  index: number;
  /** `$PnN` — short detector name, e.g. "B2-A", "FSC-A". Always present. */
  name: string;
  /** `$PnS` — stain/marker name, e.g. "CD4 FITC". Empty in all current test files. */
  stain: string;
  /** Display label: stain when known, otherwise the detector name. */
  label: string;
  /** `$PnB` — bits per value in the DATA segment. */
  bits: number;
  /** `$PnR` — range; the value one past the maximum. */
  range: number;
  /** `$PnE` amplification: [decades, offset]. [0,0] means linear. */
  amplification: [decades: number, offset: number];
  /** `$PnG` — gain. Values are divided by this when it is present and ≠ 1. */
  gain: number | null;
  /** `$PnV` — detector voltage. */
  voltage: number | null;
  /** `$PnTYPE`, normalised. Inferred from the name when the keyword is absent. */
  type: ParameterType;
  /** True for scatter and fluorescence channels — i.e. not Time. */
  isDataChannel: boolean;
}

/** A parsed spillover/compensation matrix. */
export interface SpilloverMatrix {
  /** Detector names, in matrix row/column order. */
  parameters: string[];
  /** Row-major `n × n` values. */
  values: Float64Array;
  size: number;
  /**
   * True when the matrix is the identity within tolerance — i.e. the acquisition
   * software wrote raw, uncompensated data. Applying it would be a no-op, and the
   * UI should say so rather than offering a meaningless toggle.
   */
  isIdentity: boolean;
}

export type AcquisitionType = 'conventional' | 'spectral';

export interface FcsMetadata {
  version: FcsVersion;
  /** Every TEXT-segment keyword, verbatim, including non-standard ones. */
  keywords: Record<string, string>;
  parameters: FcsParameter[];
  eventCount: number;
  parameterCount: number;

  cytometer: string | null;        // $CYT
  cytometerSerial: string | null;  // $CYTSN
  instrument: string | null;       // $INST
  operator: string | null;         // $OP
  project: string | null;          // $PROJ
  originalFilename: string | null; // $FIL
  software: string | null;         // CREATOR / $SYS
  /** Parsed from $DATE + $BTIM, null when unparseable. */
  acquiredAt: Date | null;
  beginTime: string | null;        // $BTIM
  endTime: string | null;          // $ETIM
  /** $TIMESTEP — seconds per Time-channel unit. */
  timestep: number | null;
  volume: number | null;           // $VOL, microlitres

  spillover: SpilloverMatrix | null;
  /** True when APPLY COMPENSATION is explicitly "TRUE". */
  compensationApplied: boolean;

  dataType: 'I' | 'F' | 'D' | 'A';
  byteOrder: 'little' | 'big';
  mode: string;
  /** Byte offset of the next dataset, or 0 when this is the only one. */
  nextData: number;
}

export interface ParsedFcs {
  metadata: FcsMetadata;
  /**
   * Event values in **column-major** order: parameter p occupies
   * `[p * eventCount, (p + 1) * eventCount)`.
   *
   * FCS stores events row-major, but every consumer here reads one or two
   * parameters at a time — plotting, gating, statistics — so the transpose is done
   * once at parse time to make those reads contiguous. Use `column()` for a
   * zero-copy view.
   */
  data: Float32Array;
  /** Non-fatal problems worth surfacing in the UI (see `FcsWarning`). */
  warnings: FcsWarning[];
}

export interface FcsWarning {
  code:
    | 'header-offset-mismatch'
    | 'data-size-mismatch'
    | 'missing-spillover'
    | 'identity-spillover'
    | 'non-finite-values'
    | 'multiple-datasets'
    | 'deprecated-mode'
    | 'unusual-parameter-count'
    | 'missing-time-channel'
    | 'supplemental-text';
  message: string;
  /** Detail for the metadata panel; not shown inline. */
  detail?: string;
}

/**
 * The largest value this parameter can hold **after parsing**, or 0 when the
 * file does not say.
 *
 * `$PnR` is the declared range and is the answer for the ordinary case, but it
 * is a statement about the *channel* values in the DATA segment and two of the
 * parser's post-read corrections move the ceiling off it:
 *
 * - `$PnE` log amplification rewrites integer channel `c` as `f2 · 10^(d·c/R)`,
 *   so the top of the scale becomes `f2 · 10^d` and `$PnR` is nowhere in the
 *   data any more.
 * - `$PnG` gain divides every value, ceiling included.
 *
 * Both are applied in `readData`, so anything asking "how far does this axis
 * go" has to ask them too. Nothing here reads the events: this is what the file
 * *declares*, which is the whole point — it is identical on every tube from one
 * instrument, where a measured extent is not.
 */
export function dataCeiling(p: FcsParameter): number {
  const [decades, zeroValue] = p.amplification;
  const top = decades > 0
    ? (zeroValue === 0 ? 1 : zeroValue) * Math.pow(10, decades)
    : p.range;
  if (!(top > 0) || !Number.isFinite(top)) return 0;
  return p.gain !== null && p.gain !== 0 && p.gain !== 1 ? top / p.gain : top;
}

/**
 * The value a detector's events pile up at when they are off scale, or null for
 * a parameter that has none (Time, a derived or an unmixed column).
 *
 * One definition for both readers: a figure's *leave out the pile* option, and
 * the density levels, which must never be set by the row of events stacked on
 * the top of an axis — on an Aurora tube that row is the densest cell in the
 * plot, five times the real core.
 */
export function saturationCeiling(p: FcsParameter | undefined): number | null {
  if (!p || !(p.type === 'Forward_Scatter' || p.type === 'Side_Scatter' || p.type === 'Raw_Fluorescence')) return null;
  const top = dataCeiling(p);
  return top > 0 ? top : null;
}

/** Zero-copy view of one parameter's values. */
export function column(parsed: ParsedFcs, parameterIndex: number): Float32Array {
  const n = parsed.metadata.eventCount;
  const start = parameterIndex * n;
  return parsed.data.subarray(start, start + n);
}

/** Thrown for files that cannot be parsed at all. Message is user-facing. */
export class FcsParseError extends Error {
  constructor(
    message: string,
    /** What the user can actually do about it. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'FcsParseError';
  }
}
