/**
 * Unmixed abundances, attached to the file they were computed from.
 *
 * ## The bug this exists to fix (2026-08-09)
 *
 * `runUnmixing` produced a full `UnmixResult` per sample — the maths was right,
 * the condition number was right, the labels were right — and wrote it into
 * `useSpectral().unmixed`, which **nothing outside the Unmixing panel ever
 * read**. The panel then said, in a green callout, that the unmixed parameters
 * were "on every axis picker in this window". They were on none of them. Going
 * to the Analysis tab and building a plot showed the same seventy-one raw
 * detectors it always had, and the feature that the whole four-step wizard
 * exists to enable — immunophenotyping an unmixed multicolour sample — could not
 * be started.
 *
 * It is the shape PROGRESS.md keeps recording under *state that is set and never
 * un-set*, one turn further on: state that is **set and never read**. Every
 * individual write was correct and no test failed, because every test asserted
 * on the store the value was written into.
 *
 * ## Why a registry keyed by `ParsedFcs`
 *
 * Because that is what the readers have in their hands. The two functions that
 * resolve a parameter index to data — `parametersFor` and `sampleColumn` — take
 * a `ParsedFcs`, and so does `defaultSpecFor`, which is what decides the display
 * space a gate on that parameter is evaluated in. None of them takes a sample
 * id, and threading one through every call site would mean a list of places that
 * have to remember, which is the thing that went wrong in the first place.
 *
 * A `WeakMap` keyed by the object being extended is also already this project's
 * idiom for exactly this: `derivedStore`'s column cache and `displayColumn`'s
 * cache are both one. A sample that is removed takes its abundances with it, at
 * no cost and with nothing to remember.
 *
 * **The columns are attached, never substituted.** Raw detector data is
 * untouched — `parsed.data` is the file's own values and stays that way — and an
 * unmixed parameter takes a *virtual index* past the end of the real ones,
 * exactly as a derived parameter does. That is what makes "switch between raw
 * and unmixed on any plot axis" true rather than a slogan.
 *
 * ## Reactivity
 *
 * A `WeakMap` has no subscribers, so it cannot be the signal that a component
 * re-renders on. `useSpectral().unmixed` is that signal — it is replaced
 * wholesale by `runUnmixing` and by `clearUnmixed`, and the components that show
 * a parameter list read it into their `useMemo` dependencies. Both are written
 * in one place each (`installUnmixed` / `clearUnmixed` in `spectralStore`), so
 * there is one moment at which the record and the registry can disagree, and it
 * is a moment in one function.
 */

import type { ParsedFcs } from './fcs/types';

/**
 * What an unmixed parameter set is, from the point of view of anything that
 * plots one.
 *
 * Structurally a subset of `core/spectral`'s `UnmixResult`, and deliberately
 * declared here rather than imported from it: this module is a leaf, imported by
 * `derivedStore`, and `core/spectral` pulls in the whole solver. Assigning an
 * `UnmixResult` to it is checked by the compiler at the one call site that does.
 */
export interface UnmixedColumns {
  /**
   * Column-major abundances, **as the solve produced them**: signature `f`
   * occupies `[f·N, (f+1)·N)`, including the signatures this file does not
   * surface as parameters.
   */
  data: Float32Array;
  /**
   * One label per *surfaced* parameter, in the order they appear on a picker.
   *
   * Not one per block of `data` — see `columns`. This is what
   * `unmixedCount` counts and what `parametersFor` names.
   */
  labels: string[];
  /**
   * Which block of `data` each label reads, same length and order as `labels`.
   *
   * **This is the whole of 2026-08-11, Item 15.** A matrix's signature list
   * includes the autofluorescence or unstained reference, and it has to: the
   * solve needs somewhere to put cell background, and taking it out would change
   * every antibody's abundance. What it must not do is arrive on an axis picker
   * beside `CD3 RY703` as though *Unstained* were a marker somebody stained for.
   * Its abundance answers "how much of this cell's signal was background", which
   * is a diagnostic about the fit rather than a measurement of the cell.
   *
   * The exclusion rule already existed in two places — the similarity matrix
   * (2026-08-08) and the export's antibody columns (2026-08-10), both reading
   * `ReferenceSpectrum.isAutofluorescence` — and the parameter list was the third
   * surface, which had never applied it. An index map rather than a filtered
   * copy of `data`, because the abundances are a 13 × 309 560 `Float32Array` and
   * a column is still a zero-copy `subarray` of it either way.
   */
  columns: number[];
  eventCount: number;
  /**
   * Which solve produced these columns.
   *
   * Read by `parametersFor` and by nothing else — it decides the parameter
   * *type*, which decides the two-letter tag a picker prints. Optional and
   * defaulting to `unmixed`, so a workspace or a code path written before
   * compensation existed keeps the answer it always gave.
   */
  kind?: 'unmixed' | 'compensated';
}

const registry = new WeakMap<ParsedFcs, UnmixedColumns>();

/*
   Which attachment a file is on, as a number that only goes up.

   A `ParsedFcs` is the key every column cache in this application uses, and it
   stays the same object while abundances come and go underneath it — attached
   by a solve, replaced by a second solve, removed by *Clear results*. A cache
   keyed on the file and a parameter index alone therefore keeps answering with
   whatever the index meant the first time it was asked: a workspace reopened
   with its gates restored a moment before the matrix was re-applied cached a
   column of NaN for every abundance, and every gate drawn on one stayed empty
   for the rest of the session (2026-10-28). The version is what such a key has
   to carry. Global rather than per file, so two attachments never share a
   number, even across a detach.
*/
let attachments = 0;
const versions = new WeakMap<ParsedFcs, number>();

/**
 * Which of a matrix's signatures become parameters, and where each one reads.
 *
 * Stated once so the registry and anything else that has to make the same
 * distinction — the export's computed columns, a future report — agree by
 * construction rather than by both remembering. Structurally typed on purpose:
 * this module is a leaf and does not import `core/spectral`.
 */
export function surfacedSignatures(
  spectra: ReadonlyArray<{ label: string; isAutofluorescence: boolean }>,
): { labels: string[]; columns: number[] } {
  const labels: string[] = [];
  const columns: number[] = [];
  spectra.forEach((s, i) => {
    if (s.isAutofluorescence) return;
    labels.push(s.label);
    columns.push(i);
  });
  return { labels, columns };
}

/** Attach a sample's abundances. Replaces whatever was there. */
export function attachUnmixed(parsed: ParsedFcs, columns: UnmixedColumns): void {
  registry.set(parsed, columns);
  versions.set(parsed, ++attachments);
}

/** Forget a sample's abundances, e.g. *Clear results*. */
export function detachUnmixed(parsed: ParsedFcs): void {
  registry.delete(parsed);
  versions.set(parsed, ++attachments);
}

/**
 * Which attachment this file's abundances are — 0 when it has never had any.
 *
 * For a cache key, and only for one: see the note on `attachments`.
 */
export function unmixedVersion(parsed: ParsedFcs): number {
  return versions.get(parsed) ?? 0;
}

/** This sample's abundances, or null when it has not been unmixed. */
export function unmixedFor(parsed: ParsedFcs): UnmixedColumns | null {
  return registry.get(parsed) ?? null;
}

/** How many unmixed parameters this sample carries. Zero when it has none. */
export function unmixedCount(parsed: ParsedFcs): number {
  return registry.get(parsed)?.labels.length ?? 0;
}

/**
 * One unmixed column, zero-copy.
 *
 * `null` for a column the result does not have, which is a real state rather
 * than a bug: a panel saved against a thirteen-signature matrix and reopened
 * against an eight-signature one names a parameter that no longer exists, and
 * the honest answer is "no data" rather than a neighbouring fluorophore's.
 */
export function unmixedColumn(parsed: ParsedFcs, column: number): Float32Array | null {
  const u = registry.get(parsed);
  if (!u || column < 0 || column >= u.labels.length) return null;
  // Through the index map: `column` is a position in the parameter list, and the
  // block it reads is not the same number once a reference has been left out.
  const block = u.columns[column];
  if (block === undefined) return null;
  const n = u.eventCount;
  return u.data.subarray(block * n, (block + 1) * n);
}
