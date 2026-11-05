/**
 * What order the Statistics panel puts things in — table rows, and the compare
 * chart's categories.
 *
 * Both are the same shape of question and both are pure, so they sit together
 * away from a 1500-line view: given the natural order and what the user has said,
 * what is the order. `panels/compareChart.ts` holds the chart's *geometry*; this
 * is its sequence, and it is in `core/` because `statisticsPrefs` stores the
 * answers and a store must not reach up into `panels/` for a type.
 *
 * ## Why the table needs it (2026-08-13)
 *
 * The table is built sample-major — every population of one sample, then every
 * population of the next — because that is the order the rows are computed in.
 * That is the right default: it reads down a file at a time. It is the wrong
 * order for the question "how does CD4+ compare across my twelve tubes", where
 * the twelve rows that answer it are scattered eleven rows apart. Pulling one
 * population's rows together by hand in Excel is what the report was about, and
 * it is a re-sort of rows that already exist.
 *
 * **Not a sort column.** Sorting by Population would do it, and then the sort is
 * spent: the rows within a population would be in path order rather than in the
 * sample order the workspace is arranged in, and the user could no longer sort by
 * anything else without losing the grouping. Grouping is the row order the table
 * *starts* in; a column sort still applies on top and still means what it says.
 *
 * ## Why the chart needs it
 *
 * Category order is the whole reading of a side-by-side comparison — untreated
 * beside its own treatment, doses ascending — and it fell out of whichever sample
 * happened to be loaded first. Nothing about load order encodes an experimental
 * design, and no automatic rule could: only the person who ran it knows whether
 * *Treatment A* belongs before or after *Treatment B*.
 */
import { moveItem } from '@/core/reorder';

/** Which way round the table's rows are grouped. */
export type RowGrouping = 'sample' | 'population';

/** The two fields row ordering is decided from. Anything with these can be sorted. */
interface Orderable {
  sampleId: string;
  path: string;
}

/**
 * Rows in the requested order.
 *
 * `'sample'` returns the input untouched — it is already sample-major, and
 * re-deriving it would be a chance to get it wrong. `'population'` sorts by the
 * order each path was **first seen** rather than alphabetically, so the
 * populations stay in gating-tree order (a parent above its children) instead of
 * being scrambled into `Cells`, `Cells/Live`, `Cells/Dead` becoming
 * `Cells/Dead`, `Cells/Live`, `Cells`. Ties keep the incoming sample order, which
 * is the workspace's own.
 *
 * A new array either way, and never a mutation of the caller's: the input is a
 * memoised value several other readers hold.
 */
export function orderRows<T extends Orderable>(rows: readonly T[], grouping: RowGrouping): T[] {
  if (grouping === 'sample') return [...rows];

  const pathRank = new Map<string, number>();
  const sampleRank = new Map<string, number>();
  for (const r of rows) {
    if (!pathRank.has(r.path)) pathRank.set(r.path, pathRank.size);
    if (!sampleRank.has(r.sampleId)) sampleRank.set(r.sampleId, sampleRank.size);
  }

  return [...rows].sort((a, b) => {
    const byPath = (pathRank.get(a.path) ?? 0) - (pathRank.get(b.path) ?? 0);
    return byPath !== 0 ? byPath : (sampleRank.get(a.sampleId) ?? 0) - (sampleRank.get(b.sampleId) ?? 0);
  });
}

/* -------------------------------------------------------------------------
   Compare chart categories
   ------------------------------------------------------------------------- */

/**
 * The categories to draw, in the user's order.
 *
 * `stored` is a list of category keys somebody has arranged; `natural` is what
 * the data currently holds. The two disagree constantly — a group is renamed, a
 * sample is removed, a new tube is imported — so this is a merge rather than a
 * lookup:
 *
 *   - a stored key that no longer exists is dropped, not left as a gap;
 *   - a category the stored list has never seen goes to the **end**, in natural
 *     order, because appearing in the middle of an arrangement somebody made is
 *     the one place it would be mistaken for part of that arrangement.
 *
 * The alternative — clearing the whole order whenever the categories change —
 * throws away an arrangement because one file was added, which is exactly when
 * the arrangement is most expensive to redo.
 */
export function orderCategories(natural: readonly string[], stored: readonly string[]): string[] {
  const live = new Set(natural);
  const kept = stored.filter((k) => live.has(k));
  const seen = new Set(kept);
  return [...kept, ...natural.filter((k) => !seen.has(k))];
}

/**
 * One category moved — one place with a delta, or onto another's row.
 *
 * Both go through `core/reorder.ts:moveItem`, which is the convention the sample
 * list already reorders by: `to` is an index into the list as it stands, so
 * dropping a row onto another puts it where that one was and pushes it clear, and
 * `from ± 1` swaps a pair. A second reordering convention living beside the first
 * is how a drag and an arrow come to disagree about what "one place down" means,
 * and that file says so at the top.
 *
 * Takes the *resolved* order — what is on screen — and returns a full order, so
 * the first press on a chart nobody has arranged stores a complete list rather
 * than a fragment `orderCategories` would then append everything else to. A move
 * off either end is a no-op rather than a wrap.
 */
export function moveCategory(order: readonly string[], key: string, delta: -1 | 1): string[] {
  const from = order.indexOf(key);
  if (from < 0 || from + delta < 0 || from + delta >= order.length) return [...order];
  return moveItem(order, from, from + delta);
}

/** The drag equivalent: `key` takes `targetKey`'s place. */
export function moveCategoryTo(order: readonly string[], key: string, targetKey: string): string[] {
  const from = order.indexOf(key);
  const to = order.indexOf(targetKey);
  if (from < 0 || to < 0) return [...order];
  return moveItem(order, from, to);
}
