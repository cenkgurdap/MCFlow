/**
 * The Time channel's unit, in one place.
 *
 * **The Time parameter is not stored in seconds.** It is an integer counter off
 * the cytometer's acquisition clock, and `$TIMESTEP` (FCS 3.1 §3.2.24) is the
 * number of seconds one tick is worth — `0.0001` on every file in this
 * workspace, so a 24-second run ends at tick 245 000. `$PnG` (gain) is a
 * separate correction the parser has already applied by the time anything reads
 * a column; `$TIMESTEP` is the one conversion left.
 *
 * This module was extracted from `core/export.ts` on 2026-08-10, when the same
 * defect turned up on the plot. The history is worth keeping because it is the
 * same bug found twice in two years' worth of surfaces:
 *
 *  - **2026-08-03, the export.** A CSV was written as `0, 8, 16, 22…` under a
 *    bare `Time` header. Fixed by applying the scale at write time and labelling
 *    the column `Time (s)` — and only when the keyword is present, because a
 *    header claiming a unit the numbers are not in is the same bug relabelled.
 *  - **2026-08-10, the plot.** A Time × SSC-A plot's x axis read `0, 1M, 2M,
 *    3M`: acquisition ticks formatted like an intensity channel, where a `3M` is
 *    five minutes. A Time axis exists to answer "did the flow rate drift during
 *    the run", and that question cannot be asked of an axis whose units are
 *    unstated and four orders of magnitude out.
 *
 * The plot's fix is in `parametersFor` and `sampleColumn`, which are by design
 * the only two functions in the application that resolve a parameter index to
 * data — so the axis, its ticks, the hover readout, the typed axis limits, a
 * gate drawn on Time and the statistics table all get seconds from one place,
 * rather than five surfaces each remembering to multiply.
 *
 * The **export path is deliberately untouched by that** and still applies the
 * scale itself, because it reads `parsed.data` directly rather than going
 * through those two functions. Converting underneath it would double-apply and
 * turn a correct, `$BTIM`/`$ETIM`-verified export into a wrong one, which is
 * worse than the bug being fixed.
 */

import type { FcsMetadata } from './fcs/types';

/**
 * Index of the Time parameter, or −1.
 *
 * By `$PnTYPE`, which the parser normalises and falls back to inferring from the
 * name — so this is the same answer every other view gets rather than a second
 * "is this column called Time?" test.
 */
export function timeParameterIndex(md: FcsMetadata): number {
  return md.parameters.findIndex((p) => p.type === 'Time');
}

/**
 * Seconds per Time-channel tick, or `null` when the file does not say.
 *
 * `null` rather than a default of 1: a missing `$TIMESTEP` means the unit is
 * genuinely unknown, and silently asserting seconds is the bug this exists to
 * fix. Every caller drops the `(s)` to match, so nothing ever claims a unit the
 * numbers are not in.
 */
export function timeScaleFor(md: FcsMetadata): number | null {
  const step = md.timestep;
  return step !== null && Number.isFinite(step) && step > 0 ? step : null;
}

/**
 * Decimal places the Time column needs so the conversion survives rounding.
 *
 * At `$TIMESTEP` 1e-4 the default 4 dp is exactly enough and one tick renders as
 * `0.0001`; at 1e-6 it would render every event as `0`, which is the same class
 * of silent loss as not converting at all. Derived from the step rather than
 * raised globally, because 12 dp on seventy other columns is megabytes of zeros.
 */
export function timePrecision(scale: number, base: number): number {
  return Math.min(12, Math.max(base, Math.ceil(-Math.log10(scale))));
}

/**
 * The heading for a Time parameter whose values are in seconds.
 *
 * Idempotent, so a file that already names its channel `Time (s)` does not end
 * up with two.
 */
export function timeLabel(base: string): string {
  return /\(s\)\s*$/.test(base) ? base : `${base} (s)`;
}
