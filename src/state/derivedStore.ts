/**
 * Derived parameters, as far as the rest of the app is concerned.
 *
 * The design decision that makes this small: a derived parameter is addressed by
 * a **virtual parameter index** that continues past the end of the file's real
 * ones. A 71-parameter Aurora file's first derived parameter is index 71. So
 * `PanelConfig.xParam`, `RectangleGate.xParam`, the axis picker and the
 * statistics table all keep taking a number and none of them has to learn about
 * a second kind of channel — the two places that resolve an index to data,
 * `parametersFor` and `sampleColumn`, are the only ones that know.
 *
 * Definitions live on the workspace, not on a sample: an expression names
 * parameters by their short names, and the point of the feature is that the same
 * derivation applies across a whole sample set. A sample that lacks one of the
 * referenced detectors gets a column of NaN for that parameter rather than an
 * error — an incomplete panel is a legitimate thing to have loaded alongside a
 * complete one.
 *
 * Caching follows the existing `displayColumn` pattern exactly: a `WeakMap`
 * keyed by the `ParsedFcs`, so a sample that is removed takes its cached columns
 * with it, and an inner map keyed by the expression.
 */

import { create } from 'zustand';
import {
  derivedOrder, evaluateExpression, nextDerivedId, parseExpression, validateDefinition,
  type DerivedParameterDef,
} from '@/core/derived';
import { unmixedColumn, unmixedCount, unmixedFor, unmixedVersion } from '@/core/unmixedColumns';
import { timeLabel, timeParameterIndex, timeScaleFor } from '@/core/timeUnits';
import { dataCeiling, type FcsParameter, type ParsedFcs } from '@/core/fcs/types';
import { record, step } from './historyBus';
import { notifyParameterShift } from './parameterShift';
import { useWorkspace } from './workspaceStore';

export type { DerivedParameterDef };

/**
 * How many real parameters a stored index is counted past, or null with nothing
 * loaded.
 *
 * The first sample's, which is the one `restoreWorkspace` initialises panels
 * against. A stored index is one number for every sample, so a workspace mixing
 * instruments with different parameter counts already reads a derived index
 * differently on each; the shift follows the same reading. With no samples there
 * is nothing an index can resolve against, and no gate or panel survives the
 * workspace being emptied.
 */
function realParameterCount(): number | null {
  const first = useWorkspace.getState().samples[0];
  return first ? first.parsed.metadata.parameters.length : null;
}

interface DerivedState {
  defs: DerivedParameterDef[];
  addDef(name: string, expression: string): string;
  updateDef(id: string, patch: Partial<Omit<DerivedParameterDef, 'id'>>): void;
  removeDef(id: string): void;
  /** Replace the set, e.g. from a workspace or a sibling window. */
  setDefs(defs: DerivedParameterDef[]): void;
}

export const useDerived = create<DerivedState>((set, get) => ({
  defs: [],

  /*
     Add and remove announce the shift; `setDefs` does not.

     Both change how many derived indices there are, so both move every unmixed
     index past them — see `parameterShift.ts`. One step each, so the definition
     and every gate and panel it re-pointed come back on a single undo. `setDefs`
     replaces the whole document (a workspace restore, a sibling window) along
     with the gates and panels written against it, which already agree.
  */
  addDef(name, expression) {
    const id = nextDerivedId();
    return step('Add derived parameter', () => {
      const real = realParameterCount();
      const before = get().defs.length;
      set((s) => ({ defs: [...s.defs, { id, name: name.trim(), expression }] }));
      if (real !== null) notifyParameterShift({ from: real + before, delta: 1, orphan: null });
      return id;
    });
  },

  updateDef(id, patch) {
    record('Edit derived parameter', `derived:${id}`);
    set((s) => ({
      defs: s.defs.map((d) => (d.id === id ? { ...d, ...patch, name: (patch.name ?? d.name).trim() } : d)),
    }));
  },

  removeDef(id) {
    const k = get().defs.findIndex((d) => d.id === id);
    if (k < 0) return;
    step('Remove derived parameter', () => {
      const real = realParameterCount();
      set((s) => ({ defs: s.defs.filter((d) => d.id !== id) }));
      if (real !== null) notifyParameterShift({ from: real + k + 1, delta: -1, orphan: real + k });
    });
  },

  setDefs(defs) { set({ defs }); },
}));

/* -------------------------------------------------------------------------
   Parameter list
   ------------------------------------------------------------------------- */

/**
 * A derived parameter presented as an ordinary `FcsParameter`.
 *
 * `range` is measured from the data rather than declared, because there is no
 * `$PnR` to read and several transforms are defined against it — a linear axis
 * takes its domain from `[min, range]`, and a logicle width basis is estimated
 * relative to it. Measuring costs one pass over the (already cached) column.
 */
function describeDerived(
  def: DerivedParameterDef,
  index: number,
  bounds: { min: number; max: number },
): FcsParameter {
  return {
    index: index + 1,
    name: def.name,
    stain: def.expression,
    label: def.name,
    bits: 32,
    range: bounds.max > 0 ? bounds.max : 1,
    amplification: [0, 0],
    gain: null,
    voltage: null,
    // Not `Raw_Fluorescence`: a derived parameter is not a detector, and typing
    // it as one would make `defaultTransformKind` and the spectral panel treat
    // it as a channel that could carry a signature. It defaults to a **linear**
    // axis, because the units of an expression are whatever the expression
    // makes them — a ratio lives in [−1, 1] and a biexponential axis over it
    // says nothing.
    type: 'Derived',
    isDataChannel: true,
  };
}

/**
 * An unmixed abundance presented as an ordinary `FcsParameter`.
 *
 * Named with the identity the matrix carries — "CD3 RY703", not the detector it
 * happened to peak in — because that is the whole point of unmixing and it is
 * what the operator is about to gate on. `stain` is deliberately empty: the
 * label *is* the name, and `ParameterPicker` renders a subtitle only when it is
 * not, which is the fix already recorded for derived parameters rendering their
 * own name twice.
 *
 * `range` is measured for the same reason a derived parameter's is — there is no
 * `$PnR` for a column that was computed. It is a **trimmed** high extent rather
 * than the maximum, because a least-squares abundance has a residual tail that a
 * detector does not; see `unmixedBounds` for the measurement and for what the
 * maximum did to the plot.
 *
 * `type` is `Unmixed_Fluorescence` for a spectral solve, which is the type the
 * FCS parser already produces for a vendor-unmixed file: `defaultTransformKind`
 * gives it a biexponential axis, which is what an abundance wants, and every
 * surface that tags a parameter by type already knows the word. A conventional
 * solve produces `Compensated_Fluorescence` instead — the same shape, the same
 * default transform, and a tag that does not claim the column was unmixed.
 */
function describeUnmixed(
  label: string,
  index: number,
  bounds: { min: number; max: number },
  kind: 'unmixed' | 'compensated' = 'unmixed',
): FcsParameter {
  return {
    index: index + 1,
    name: label,
    stain: '',
    label,
    bits: 32,
    // Already positive and already rounded — see `unmixedBounds`.
    range: bounds.max,
    amplification: [0, 0],
    gain: null,
    voltage: null,
    type: kind === 'compensated' ? 'Compensated_Fluorescence' : 'Unmixed_Fluorescence',
    isDataChannel: true,
  };
}

/**
 * Real parameters, then derived ones, then unmixed ones.
 *
 * **The order is load-bearing and is not the order they were added in.** A
 * derived parameter is addressed by a virtual index continuing past the file's
 * real ones, and its index has to mean the same thing on every sample — a panel
 * that follows the active sample would otherwise plot a different expression on
 * each. Derived definitions are a property of the workspace, so putting them
 * first keeps every index they own identical across samples whether or not a
 * given sample has been unmixed. Putting the unmixed block first would make
 * `71` mean *the first derived parameter* on a raw sample and *the first
 * fluorophore* on an unmixed one.
 *
 * Within the unmixed block the order is the matrix's own signature order, so two
 * samples unmixed from one matrix agree, which is what makes an overlay or a
 * batch statistic across them mean anything.
 */
export function parametersFor(
  parsed: ParsedFcs,
  defs: DerivedParameterDef[],
): FcsParameter[] {
  const real = realParameters(parsed);
  const unmixed = unmixedFor(parsed);
  if (defs.length === 0 && !unmixed) return real;
  const base = real.length + defs.length;
  return [
    ...real,
    ...defs.map((d, i) => describeDerived(d, real.length + i, boundsOf(parsed, defs, real.length + i))),
    ...(unmixed?.labels ?? []).map((label, f) =>
      describeUnmixed(label, base + f, unmixedBounds(parsed, f), unmixed?.kind)),
  ];
}

/* -------------------------------------------------------------------------
   The Time channel, in seconds
   ------------------------------------------------------------------------- */

/**
 * The file's own parameters, with **Time described in seconds**.
 *
 * The Time channel is an integer counter off the acquisition clock and
 * `$TIMESTEP` says what one tick is worth — see `core/timeUnits.ts` for the
 * whole of that, including why the export applies the same scale in a different
 * place. Without this, a Time × SSC-A plot's x axis read `0 1M 2M 3M`:
 * acquisition ticks, formatted like a fluorescence channel, where `3M` is five
 * minutes.
 *
 * **Applied here rather than at the axis.** `parametersFor` and `sampleColumn`
 * are by design the only two functions that resolve a parameter index to data,
 * so converting here means the axis, its ticks, the hover readout, a typed axis
 * limit, a gate drawn on Time and the statistics table are all in seconds
 * without any of them being told. Relabelling only the ticks would have left the
 * axis saying seconds over a readout and a limit field saying ticks — one thing
 * described two ways, which is the defect this project has spent most of its
 * passes removing.
 *
 * `range` is scaled with the values, because it is `$PnR` in the same units and
 * it is what the linear transform's display domain is built from. The `name` is
 * **not** touched: expressions reference parameters by name, and so does the
 * export's own `$PnN` column heading.
 *
 * Cached by `ParsedFcs` so the returned array keeps its identity across renders
 * — every consumer holds this in a `useMemo` and a fresh array each call would
 * re-run the whole plot pipeline on every render. A file with no `$TIMESTEP` and
 * a file with no Time channel both return `parsed.metadata.parameters` itself,
 * so the common path allocates nothing at all.
 */
const timeScaled = new WeakMap<ParsedFcs, FcsParameter[]>();

function realParameters(parsed: ParsedFcs): FcsParameter[] {
  const cached = timeScaled.get(parsed);
  if (cached) return cached;

  const md = parsed.metadata;
  const scale = timeScaleFor(md);
  const ti = timeParameterIndex(md);
  const out = scale === null || ti < 0
    ? md.parameters
    : md.parameters.map((p, i) => (i === ti
      ? { ...p, label: timeLabel(p.label), range: p.range * scale }
      : p));

  timeScaled.set(parsed, out);
  return out;
}

/**
 * The Time column converted to seconds, allocated once per file.
 *
 * A real column is otherwise a zero-copy `subarray`, and this is the one
 * exception — a scaled copy, ~4 bytes per event, held for as long as the sample
 * is loaded. Worth stating because it is a departure from "a real index costs
 * nothing": 170 000 events is 680 kB, against the 48 MB the file's own data
 * already occupies.
 */
const timeSeconds = new WeakMap<ParsedFcs, Float32Array>();

function timeColumn(parsed: ParsedFcs, raw: Float32Array, scale: number): Float32Array {
  const cached = timeSeconds.get(parsed);
  if (cached) return cached;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw[i]! * scale;
  timeSeconds.set(parsed, out);
  return out;
}

/** True for a *derived* index — past the real parameters, before the unmixed ones. */
export function isDerivedIndex(parsed: ParsedFcs, index: number, defs: DerivedParameterDef[]): boolean {
  const real = parsed.metadata.parameters.length;
  return index >= real && index < real + defs.length;
}

/** True for an index in this sample's unmixed block. */
export function isUnmixedIndex(parsed: ParsedFcs, index: number, defs: DerivedParameterDef[]): boolean {
  const base = parsed.metadata.parameters.length + defs.length;
  return index >= base && index < base + unmixedCount(parsed);
}

/* -------------------------------------------------------------------------
   Columns
   ------------------------------------------------------------------------- */

interface CachedColumn {
  values: Float32Array;
  min: number;
  max: number;
}

const cache = new WeakMap<ParsedFcs, Map<string, CachedColumn>>();

function cacheKey(def: DerivedParameterDef): string {
  return `${def.name}|${def.expression}`;
}

/**
 * Raw (pre-transform) values for any parameter index — real, derived or unmixed.
 *
 * The one function every consumer should call instead of slicing
 * `parsed.data` by hand. A real index still resolves to a zero-copy subarray, so
 * nothing pays for the indirection, and an unmixed one does too — the
 * abundances are already column-major, so a fluorophore is a `subarray` of them
 * exactly as a detector is a `subarray` of the file.
 *
 * There is no compensation stage in front of it any more. The pipeline used to
 * read raw → compensated → transformed → display; conventional compensation is
 * gone, so it now reads raw → transformed → display and this function returns
 * the file's own values.
 */
export function sampleColumn(
  parsed: ParsedFcs,
  index: number,
  defs: DerivedParameterDef[],
): Float32Array {
  const n = parsed.metadata.eventCount;
  const real = parsed.metadata.parameters.length;
  if (index < real) {
    const raw = parsed.data.subarray(index * n, (index + 1) * n);
    // Ticks → seconds, on the Time column only. See `realParameters`, which
    // scales the matching `range` and label so the axis and the data agree.
    const scale = timeScaleFor(parsed.metadata);
    return scale !== null && index === timeParameterIndex(parsed.metadata)
      ? timeColumn(parsed, raw, scale)
      : raw;
  }
  if (index < real + defs.length) return derivedColumn(parsed, defs, index).values;
  // Past both blocks: an abundance, or nothing. `unmixedColumn` answers null for
  // a column this sample does not have — a panel saved against a thirteen-
  // signature matrix and reopened against an eight-signature one — and a column
  // of NaN is what "no value" has meant here since derived parameters arrived.
  return unmixedColumn(parsed, index - real - defs.length) ?? new Float32Array(n).fill(NaN);
}

/**
 * What an index resolves to on this sample, as a string — for a cache key.
 *
 * An index is a position, and the thing at a position changes: a derived
 * parameter added in front of the unmixed block moves every abundance up one,
 * and a matrix applied again replaces the abundances under the same file. A
 * cache keyed on the number answered with the column the number had meant the
 * first time it was asked — every gate on an abundance came back empty after a
 * workspace reopened, and read its neighbour's events after a parameter was
 * added (2026-10-28). Keyed on this instead, a cache cannot outlive a change of
 * meaning, because the meaning *is* the key: a real index is itself, a derived
 * one is its definition, an unmixed one is its place in the block on this
 * attachment.
 */
export function parameterKey(parsed: ParsedFcs, index: number, defs: DerivedParameterDef[]): string {
  const real = parsed.metadata.parameters.length;
  if (index < real) return `r${index}`;
  const def = defs[index - real];
  if (def) return `d${def.name}|${def.expression}`;
  return `u${unmixedVersion(parsed)}:${index - real - defs.length}`;
}

/** Measured extent of a derived column, for its declared `range`. */
function boundsOf(
  parsed: ParsedFcs,
  defs: DerivedParameterDef[],
  index: number,
): { min: number; max: number } {
  const c = derivedColumn(parsed, defs, index);
  return { min: c.min, max: c.max };
}

function emptyColumn(n: number): CachedColumn {
  return { values: new Float32Array(n).fill(NaN), min: 0, max: 1 };
}

function derivedColumn(
  parsed: ParsedFcs,
  defs: DerivedParameterDef[],
  index: number,
): CachedColumn {
  const n = parsed.metadata.eventCount;
  const def = defs[index - parsed.metadata.parameters.length];
  if (!def) return emptyColumn(n);

  let per = cache.get(parsed);
  if (!per) { per = new Map(); cache.set(parsed, per); }
  const key = cacheKey(def);
  const hit = per.get(key);
  if (hit) return hit;

  const realNames = parsed.metadata.parameters.map((p) => p.name);
  const parsedExpr = parseExpression(def.expression, [...realNames, ...defs.map((d) => d.name)]);
  if (!parsedExpr.ok) {
    // An invalid expression cannot fail the render — the editor is where it is
    // reported. A column of NaN plots as nothing and gates as false, which is
    // the honest representation of "this parameter has no value".
    const bad = emptyColumn(n);
    per.set(key, bad);
    return bad;
  }

  // Resolve every reference, including references to other derived parameters —
  // in dependency order, so a chain resolves without recursion into this
  // function's own cache slot.
  const columns = new Map<string, Float32Array>();
  const ordered = derivedOrder(defs, realNames);
  for (const name of parsedExpr.references) {
    const realIndex = parsed.metadata.parameters.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (realIndex >= 0) {
      columns.set(name, sampleColumn(parsed, realIndex, defs));
      continue;
    }
    const dep = ordered.find((d) => d.name.toLowerCase() === name.toLowerCase());
    // A dependency that did not survive ordering is in a cycle or is itself
    // invalid; leaving it out gives NaN, which is what `compile` already does.
    if (dep) columns.set(name, derivedColumn(parsed, defs, defs.indexOf(dep) + realNames.length).values);
  }

  const values = evaluateExpression(parsedExpr.ast, columns, n);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) { min = 0; max = 1; }

  const entry: CachedColumn = { values, min, max };
  // Bound the cache the same way `displayColumn` does: each column is 4 bytes ×
  // events, and a workspace can accumulate definitions over a session.
  if (per.size > 16) per.clear();
  per.set(key, entry);
  return entry;
}

/* -------------------------------------------------------------------------
   What an unmixed column's axis is built from
   ------------------------------------------------------------------------- */

/**
 * The axis bounds for one unmixed column — **quantiles, not the extremes**.
 *
 * ## The bug this replaces (2026-08-17)
 *
 * This returned `{ min, max }` over the whole column, `describeUnmixed` handed
 * `max` to the transform as `$PnR`, and `axisMinFor` handed `min` to the axis
 * floor. Both are the wrong number for a *computed* column, and the plot showed
 * it: a scatter on an unmixed abundance opened with the population squeezed
 * into a band with most of the square empty, where the same plot on a raw
 * detector filled it.
 *
 * A detector's `$PnR` is the instrument's stated top and its negatives are
 * bounded by baseline restoration, so its data sits inside the axis it declares.
 * A least-squares abundance declares nothing and has a residual tail at *both*
 * ends, often reaching two orders of magnitude past its middle 98%. Framing on
 * those extremes put half the axis below the first percentile — a third of the plot
 * holding one event in a hundred — and left the population in a narrow band
 * nobody can trace a gate around.
 *
 * So the bounds are a **trimmed** extent of this column's own values, padded and
 * then rounded outward to a round number so the ticks land somewhere a reader
 * expects and two samples of one panel frame alike. Events outside are drawn
 * off-scale, which is what a cytometry plot does with off-scale events and is
 * what typing an axis limit has always done here — `bin2d` and the scatter
 * shader both drop them rather than piling them on the edge.
 *
 * ## Why the trim moved from 0.1% to 1% (2026-08-18)
 *
 * The first version took the 0.1st and 99.9th percentiles, which removed the
 * handful of events that made the axis absurd and left the ones that made it
 * merely wrong. A residual tail is not a population and does not thin out at a
 * rate a fixed tiny quantile can catch: the 99.9th percentile of an abundance
 * can still sit three to five times above its 99th, so a hundred
 * events in a hundred thousand were still setting the top of the axis and the
 * bulk was still drawn smaller than a raw detector's.
 *
 * `TRIM` is 1%, which is the quantile a cytometrist already reads as *"the
 * population, not its stragglers"* — the same one `autoSpec` takes the
 * biexponential width basis from. One event in a hundred at each end is drawn
 * off-scale, and `PAD` then widens what is left by a twentieth before rounding,
 * so a population whose top sits exactly at the 99th percentile is not drawn
 * against the frame.
 *
 * **Sampled, and cached.** `parametersFor` is called on every render of
 * everything that lists parameters, and a quantile needs the values sorted; a
 * stride over at most `QUANTILE_SAMPLE` values is within a rounding error of the
 * exact quantile on a 300 000-event file and costs one sort, once, per column
 * per file. The full-pass version was already O(N) per call and uncached.
 */
interface UnmixedAxis {
  /** Trimmed low extent, padded and rounded down to a round number. */
  min: number;
  /** Trimmed high extent, padded and rounded up to a round number. Always above 0. */
  max: number;
}

/**
 * How much of each end is treated as tail rather than as data.
 *
 * One event in a hundred, at each end. See the note above for why 0.1% was not
 * enough and why this is the quantile rather than a smaller one.
 */
const TRIM = 0.01;

/** How much the trimmed extent is widened before rounding, so nothing is drawn against the frame. */
const PAD = 0.05;

const QUANTILE_SAMPLE = 50000;
const axisCache = new WeakMap<ParsedFcs, { version: number; columns: Map<number, UnmixedAxis> }>();

/** The smallest 1, 2 or 5 × 10ᵏ at or above `v`. Mirrors `niceStep`. */
function roundOut(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  if (norm <= 1) return mag;
  if (norm <= 2) return 2 * mag;
  if (norm <= 5) return 5 * mag;
  return 10 * mag;
}

/** The largest 1, 2 or 5 × 10ᵏ at or below `v`. The floor's counterpart. */
function roundDown(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  if (norm >= 5) return 5 * mag;
  if (norm >= 2) return 2 * mag;
  return mag;
}

/**
 * Widen one end of the trimmed extent **away from the data**.
 *
 * `direction` is +1 for the top of the axis and −1 for the bottom, and the
 * arithmetic has to read it rather than simply scaling up: multiplying a
 * *positive* floor by 1.05 moves it towards the population instead of away from
 * it, which is padding that narrows. Zero is already as wide as it goes.
 */
function widen(v: number, direction: 1 | -1): number {
  if (v === 0) return 0;
  return Math.sign(v) === direction ? v * (1 + PAD) : v / (1 + PAD);
}

function unmixedBounds(parsed: ParsedFcs, column: number): UnmixedAxis {
  // Per attachment: a second solve on the same file is a second set of columns,
  // and the frame measured on the first is not theirs. See `parameterKey`.
  const version = unmixedVersion(parsed);
  let per = axisCache.get(parsed);
  if (!per || per.version !== version) {
    per = { version, columns: new Map() };
    axisCache.set(parsed, per);
  }
  const hit = per.columns.get(column);
  if (hit) return hit;

  const col = unmixedColumn(parsed, column);
  const out = col ? measure(col) : { min: 0, max: 1 };
  per.columns.set(column, out);
  return out;
}

function measure(col: Float32Array): UnmixedAxis {
  const stride = Math.max(1, Math.ceil(col.length / QUANTILE_SAMPLE));
  const kept = new Float64Array(Math.ceil(col.length / stride));
  let k = 0;
  for (let i = 0; i < col.length; i += stride) {
    const v = col[i]!;
    if (Number.isFinite(v)) kept[k++] = v;
  }
  if (k === 0) return { min: 0, max: 1 };
  const a = kept.subarray(0, k);
  a.sort();
  const at = (q: number) => a[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))]!;

  const high = widen(at(1 - TRIM), 1);
  const low = widen(at(TRIM), -1);
  return {
    /*
       The floor follows the data, on whichever side of zero it falls.

       It was pinned at 0 whenever the trimmed low extent was positive, on the
       argument that an abundance scatters about zero and the negative half of
       the axis is where its negative population lives. True — and it does not
       apply to a column whose 1st percentile is positive, because such a column
       *has* no negative population. For a dye every cell carries, the abundance
       runs from well above zero with nothing below, and a floor of 0 on a biexponential axis spent 70% of the
       square on the empty decades underneath it. The population drew in the top
       third of the plot.

       So: negative low extent, negative floor; positive low extent, a floor just
       under it. Rounded to a round number in both directions so the ticks land
       somewhere a reader expects.
    */
    min: low < 0 ? -roundOut(-low) : low > 0 ? roundDown(low) : 0,
    // The top is always positive: a column with no positive value at all is a
    // degenerate solve, and an axis of [0, 0] draws nothing.
    max: high > 0 ? roundOut(high) : 1,
  };
}

/**
 * The declared axis domain for a parameter, in **data units**, or `null` when
 * the parameter has none and the plot should frame on what it measures.
 *
 * Two kinds of parameter answer, for opposite reasons.
 *
 * **An unmixed abundance** declares nothing, so a domain is computed for it:
 * its extremes are residual outliers rather than measurements, and framing on
 * them puts the population in a band. See `unmixedBounds`.
 *
 * **A scatter channel** declares one, and it is the right frame — see
 * `scatterDomain` for why it was not, and what that cost.
 *
 * `null` for a fluorescence detector, which keeps the behaviour every plot in
 * this application was built on: it legitimately reads below zero, where the
 * file declares nothing at all, so its measured extent is the only honest
 * bound. Derived parameters stay `null` too — their range is measured from the
 * expression's own output, and the panels that pin one (Biophysics'
 * distribution worksheets) state their limits outright.
 *
 * Read by `PlotCanvas`, which is the one place that turns a column into a
 * viewport.
 */
export function axisDomainFor(
  parsed: ParsedFcs,
  index: number,
  defs: DerivedParameterDef[],
): { min: number; max: number } | null {
  if (isUnmixedIndex(parsed, index, defs)) {
    return unmixedBounds(parsed, index - parsed.metadata.parameters.length - defs.length);
  }
  const p = parsed.metadata.parameters[index];
  return p ? scatterDomain(p) : null;
}

/**
 * `[0, ceiling]` for a scatter channel, `null` for anything else.
 *
 * ## The report this answers (2026-08-27)
 *
 * *"The first plot's axes move from sample to sample, and the dense region with
 * them — on beads, which are all the same size and must land in the same
 * place."*
 *
 * They did, and the cause was not the top of the axis. Every Aurora tube's
 * FSC-A and SSC-A reach exactly `$PnR`, so the maximum never moved; the
 * **minimum** is one event, and across tubes of the same small one-size
 * particles it can range over a large fraction of full scale — an axis floor
 * decided by the single lowest event in each file. On cell tubes the same
 * minimum barely moves because the acquisition threshold pins it, which is why
 * this was invisible for as long as the data was cells.
 *
 * It is the trap this project already has written down for computed columns —
 * *a column's extremes are not its range, and a tail is not two events* — and
 * the assumption that let scatter escape it was "`$PnR` bounds a detector and
 * its data sits inside the axis". True of the top. The bottom is bounded by
 * nothing, and one stray event is not a measurement of anything.
 *
 * ## Why the declared range rather than a trimmed extent
 *
 * A percentile domain would be steadier, and it would still be a property of
 * *this tube*: that dataset's first percentile still moves by 8% of full scale
 * between files. The requirement is not steadier, it is **identical** — the
 * same particle at the same place in every tube — and only a quantity that does
 * not read the events can promise that. `$PnR` does not: every file from one
 * instrument declares the same one, so the frame is equal by construction, for
 * free, and with no cache.
 *
 * It is also what every other cytometry package draws, and what makes a scatter
 * axis mean anything: FSC is a size measurement, so its absolute position *is*
 * the reading, and two tubes can only be compared on one axis.
 *
 * ## Why scatter and not fluorescence
 *
 * Because a fluorescence channel reads below zero — baseline restoration puts a
 * real negative population there, and `R1-A` reaches −612 on this instrument —
 * and the file declares no floor for it. `[0, $PnR]` would cut that population
 * off. Scatter has no negative population: that dataset's lowest FSC-A across
 * eight tubes is −9 129, two thousandths of full scale, comfortably inside the
 * padding the frame carries anyway.
 *
 * Someone who wants a different frame types it into the axis fields, where the
 * choice is visible, saved and copyable to the panel beside it. Still not a
 * gesture, and still not a zoom.
 */
function scatterDomain(p: FcsParameter): { min: number; max: number } | null {
  if (p.type !== 'Forward_Scatter' && p.type !== 'Side_Scatter') return null;
  const max = dataCeiling(p);
  // A file that declares no range gets the old behaviour rather than an axis of
  // [0, 0], which draws nothing.
  return max > 0 ? { min: 0, max } : null;
}

/**
 * Transform spec floor for a parameter.
 *
 * Real detectors start at 0. A derived parameter does not, and a linear axis
 * whose domain starts at 0 leaves the whole negative half of a ratio plot
 * without a tick or a gridline.
 *
 * **Nor does an unmixed one**, and there it is not an edge case: a least-squares
 * abundance for a fluorophore an event does not carry scatters about zero, so
 * the negative half of the axis is where the entire negative population lives.
 * An axis floored at 0 would pile it into the first pixel column, which is the
 * one thing that makes a threshold un-drawable.
 *
 * The bound can now be **positive** — an abundance every event carries has no
 * negative population, and `unmixedBounds` frames it where it is. `defaultSpecFor`
 * passes this on only when it is below zero, which is the whole of what the
 * field is for: `TransformSpec.min` is read by the linear transform alone, and a
 * log-family axis has its own answer for the bottom of the scale. The *viewport*
 * takes the positive floor through `axisDomainFor`, which is where it belongs.
 */
export function axisMinFor(
  parsed: ParsedFcs,
  index: number,
  defs: DerivedParameterDef[],
): number {
  if (isDerivedIndex(parsed, index, defs)) return Math.min(0, boundsOf(parsed, defs, index).min);
  if (isUnmixedIndex(parsed, index, defs)) {
    // The robust floor, not the column minimum — see `unmixedBounds`. It is
    // already at or below zero, so the `Math.min` the derived branch needs is
    // built into it.
    return unmixedBounds(parsed, index - parsed.metadata.parameters.length - defs.length).min;
  }
  return 0;
}

export { validateDefinition };
