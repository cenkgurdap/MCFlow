import { tCritical } from './significance';
/**
 * Population statistics.
 *
 * Everything here runs on **full data** — never on the display subsample. The
 * plot may thin points for rendering speed; a percentage or an MFI never is.
 */

export type StatKind = 'count' | 'percentParent' | 'percentTotal' | 'mean' | 'median' | 'geoMean' | 'cv' | 'sd' | 'min' | 'max';

export const STAT_LABELS: Record<StatKind, string> = {
  count: 'Count',
  percentParent: '% Parent',
  percentTotal: '% Total',
  mean: 'Mean',
  median: 'Median',
  geoMean: 'Geo. mean',
  cv: 'CV %',
  sd: 'SD',
  min: 'Min',
  max: 'Max',
};

/** Statistics that describe a population rather than a parameter within it. */
export const POPULATION_STATS: StatKind[] = ['count', 'percentParent', 'percentTotal'];
export const PARAMETER_STATS: StatKind[] = ['median', 'mean', 'geoMean', 'cv', 'sd', 'min', 'max'];

export interface ChannelStats {
  count: number;
  mean: number;
  median: number;
  /** Geometric mean over positive values only — see the note below. */
  geoMean: number;
  sd: number;
  /** Coefficient of variation, as a percentage. */
  cv: number;
  min: number;
  max: number;
}

const EMPTY: ChannelStats = {
  count: 0, mean: NaN, median: NaN, geoMean: NaN, sd: NaN, cv: NaN, min: NaN, max: NaN,
};

/**
 * Statistics for one parameter over the events selected by `mask`.
 *
 * A gate with no events returns NaN rather than 0 for every measure — zero is a
 * real value a channel can take, and reporting it for "no data" silently
 * corrupts any downstream comparison.
 */
export function channelStats(values: Float32Array, mask?: Uint8Array | null): ChannelStats {
  const n = values.length;
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return { ...EMPTY };

  const mean = sum / count;

  // Second pass for variance: a single-pass sum-of-squares loses precision badly
  // at flow magnitudes (values reach 4.2M, so v² reaches 1.7e13).
  let sumSq = 0;
  // Geometric mean is defined only for positive values. Flow data routinely
  // contains negatives after baseline restoration, so those are excluded and
  // the count is reported separately rather than silently producing NaN.
  let logSum = 0;
  let positive = 0;
  const selected = new Float64Array(count);
  let k = 0;

  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    const d = v - mean;
    sumSq += d * d;
    if (v > 0) { logSum += Math.log(v); positive++; }
    selected[k++] = v;
  }

  const variance = count > 1 ? sumSq / (count - 1) : 0;
  const sd = Math.sqrt(variance);

  selected.sort();
  const mid = count >> 1;
  const median = count % 2 ? selected[mid]! : (selected[mid - 1]! + selected[mid]!) / 2;

  return {
    count,
    mean,
    median,
    geoMean: positive > 0 ? Math.exp(logSum / positive) : NaN,
    sd,
    // CV is meaningless when the mean straddles zero, which happens on a
    // compensated channel centred on background.
    cv: mean !== 0 ? Math.abs((sd / mean) * 100) : NaN,
    min,
    max,
  };
}

/** Read one statistic out of a computed set. */
export function pickStat(stats: ChannelStats, kind: StatKind): number {
  switch (kind) {
    case 'count': return stats.count;
    case 'mean': return stats.mean;
    case 'median': return stats.median;
    case 'geoMean': return stats.geoMean;
    case 'cv': return stats.cv;
    case 'sd': return stats.sd;
    case 'min': return stats.min;
    case 'max': return stats.max;
    default: return NaN;
  }
}

/**
 * Decimal places a parameter statistic is shown to — **four**, and the same four
 * `core/export.ts` writes.
 *
 * This is the whole of 2026-08-11, Item 6. A median of `0.455` on screen and
 * `0.4551` in the exported CSV are two renderings of one number, and the person
 * comparing them has no way to know that: the difference looks like the export
 * having recomputed something. It is stated once, here, and read by the
 * statistics table, the compare chart's axis and the mean ± SD summary under it,
 * so all four surfaces round in one place rather than in four.
 */
export const STAT_DECIMALS = 4;

/**
 * Format a statistic for display.
 *
 * A parameter statistic — mean, median, geometric mean, SD, min, max — is
 * **always four decimal places**, whatever its magnitude. That replaces a
 * magnitude ladder (`4.20M`, `12.3K`, `142`, `1.23`, `0.455`), and the ladder is
 * exactly what Item 6 is about: five different precisions, none of them the
 * export's, so the same MFI read differently depending on how large it happened
 * to be. `4.20M` is also a *lossy* rendering of a number the file carries in
 * full, which on a screen headed "Median" invites a comparison that cannot be
 * made.
 *
 * Counts stay integers with a thin space every three digits, and percentages
 * keep two places: neither is a parameter value and neither is what the export's
 * four decimals apply to.
 */
export function formatStat(value: number, kind: StatKind): string {
  if (!Number.isFinite(value)) return '—';
  if (kind === 'count') return Math.round(value).toLocaleString('en-US').replace(/,/g, ' ');
  if (kind === 'percentParent' || kind === 'percentTotal' || kind === 'cv') return value.toFixed(2);
  return value.toFixed(STAT_DECIMALS);
}

/* -------------------------------------------------------------------------
   Group comparison
   ------------------------------------------------------------------------- */

export interface GroupSummary {
  group: string;
  values: number[];
  n: number;
  mean: number;
  sd: number;
  median: number;
  min: number;
  max: number;
  /** Quartiles, for the box plot. */
  q1: number;
  q3: number;
  /** Standard error of the mean, SD / √n. */
  sem: number;
  /** Half-width of the 95% confidence interval of the mean, t(0.975, n−1) · SEM. */
  ci95: number;
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const frac = pos - lo;
  return sorted[lo + 1] !== undefined ? sorted[lo]! + frac * (sorted[lo + 1]! - sorted[lo]!) : sorted[lo]!;
}

/** Summarise one measure across the samples of a group. */
export function summariseGroup(group: string, values: number[]): GroupSummary {
  const finite = values.filter((v) => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) {
    return { group, values, n: 0, mean: NaN, sd: NaN, median: NaN, min: NaN, max: NaN, q1: NaN, q3: NaN, sem: NaN, ci95: NaN };
  }
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sorted = [...finite].sort((a, b) => a - b);
  const sd = Math.sqrt(variance);
  const sem = n > 1 ? sd / Math.sqrt(n) : NaN;
  return {
    group,
    values: finite,
    n,
    mean,
    sd,
    sem,
    ci95: n > 1 ? tCritical(0.05, n - 1) * sem : NaN,
    median: quantileSorted(sorted, 0.5),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    q1: quantileSorted(sorted, 0.25),
    q3: quantileSorted(sorted, 0.75),
  };
}
