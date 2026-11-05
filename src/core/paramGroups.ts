import type { FcsParameter } from './fcs/types';

/* ==========================================================================
   Grouping detector names by the laser that excited them.

   A spectral instrument names its detectors after the excitation line and the
   position in that line's array — `UV1-A`, `V16-A`, `YG10-A` — which is a real
   structure, and one an analyst already thinks in ("the violet block", "the
   red end"). A flat list of 71 of them throws that structure away and leaves a
   column nobody can scan.

   The grouping is derived from the names rather than declared per instrument,
   because the names are what a file actually carries; there is no keyword for
   "which laser". A name that does not match any convention lands in *Other*
   rather than being forced into a group it does not belong to — a wrong group
   is worse than no group, since it asserts something about the optics.
   ========================================================================== */

export type ParamGroupKey =
  | 'uv' | 'violet' | 'blue' | 'yellowgreen' | 'red'
  | 'scatter' | 'time' | 'unmixed' | 'compensated' | 'derived' | 'other';

export interface ParamGroup {
  key: ParamGroupKey;
  label: string;
  /** Indices into the array that was grouped, in their original order. */
  items: number[];
}

/**
 * Group order, and the label each group carries.
 *
 * Laser lines first and in wavelength order — UV, violet, blue, yellow-green,
 * red — because that is the order they appear on every instrument's detector
 * map and in the file's own parameter list. Scatter and time follow: they are
 * short, always present, and never what someone is hunting through 16 entries
 * to find.
 */
const ORDER: Array<{ key: ParamGroupKey; label: string }> = [
  { key: 'uv', label: 'UV lasers' },
  { key: 'violet', label: 'Violet lasers' },
  { key: 'blue', label: 'Blue lasers' },
  { key: 'yellowgreen', label: 'Yellow-green lasers' },
  { key: 'red', label: 'Red lasers' },
  { key: 'scatter', label: 'Scatter' },
  { key: 'time', label: 'Time' },
  // Computed parameters after measured ones, and unmixed before derived because
  // an abundance is closer to a measurement than an expression is. An unmixed
  // parameter is named after a fluorophore — "CD3 RY703" — so it matches no
  // detector convention and would otherwise land in *Other* beside the channels
  // an instrument could not be identified from, which is exactly the wrong
  // company for the parameters somebody is about to do all their gating on.
  { key: 'unmixed', label: 'Unmixed' },
  // The conventional counterpart, and never present at the same time: a
  // workspace's controls are one instrument's or the other's.
  { key: 'compensated', label: 'Compensated' },
  { key: 'derived', label: 'Derived' },
  { key: 'other', label: 'Other' },
];

/**
 * `UV1-A`, `V16-H`, `YG10-A`, `B14-A`, `R8-A`.
 *
 * The alternation is longest-first on purpose: `V` would otherwise swallow the
 * `UV` prefix's second letter and file every UV detector under violet, and `Y`
 * would do the same to `YG`. The suffix is one of the standard signal
 * measures — area, height, width — and its absence means this is not a
 * detector name at all.
 */
const DETECTOR = /^(UV|YG|V|B|R)(\d+)-([AHW])$/i;

const LINE_TO_GROUP: Record<string, ParamGroupKey> = {
  UV: 'uv',
  V: 'violet',
  B: 'blue',
  YG: 'yellowgreen',
  R: 'red',
};

/** Which group a single parameter belongs to. */
export function groupOf(p: Pick<FcsParameter, 'name' | 'type'>): ParamGroupKey {
  if (p.type === 'Time') return 'time';
  if (p.type === 'Derived') return 'derived';
  if (p.type === 'Unmixed_Fluorescence') return 'unmixed';
  if (p.type === 'Compensated_Fluorescence') return 'compensated';

  const name = p.name.trim();
  // Scatter is checked before the detector pattern: `B-H` and `SSC-B-A` exist
  // on spectral instruments as extra scatter channels, and `B` there names the
  // *blue* scatter detector, not the blue laser's fluorescence array.
  if (/^(FSC|SSC)\b/i.test(name)) return 'scatter';

  const m = DETECTOR.exec(name);
  if (m) return LINE_TO_GROUP[m[1]!.toUpperCase()] ?? 'other';

  if (/^time$/i.test(name)) return 'time';
  return 'other';
}

/**
 * Split a parameter list into ordered, non-empty groups.
 *
 * Empty groups are dropped rather than rendered with a zero count: a
 * conventional file has no UV block, and an accordion of five empty headers is
 * a worse list than the flat one this replaced.
 */
export function groupParameters(params: Array<Pick<FcsParameter, 'name' | 'type'>>): ParamGroup[] {
  const buckets = new Map<ParamGroupKey, number[]>();
  params.forEach((p, i) => {
    const key = groupOf(p);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  });

  const out: ParamGroup[] = [];
  for (const { key, label } of ORDER) {
    const items = buckets.get(key);
    if (items && items.length) out.push({ key, label, items });
  }
  return out;
}
