import type { LayoutKind } from './layoutKind';

/**
 * The order and the grouping of a window's worksheets.
 *
 * ## Why this is a module rather than a hook in each list
 *
 * Two surfaces list every worksheet in the window — the bottom tab strip
 * (`panels/LayoutBar`) and the dropdown in the title bar (`LayoutSwitcher` in
 * `App.tsx`) — and until now each held its own copy of this: the same three
 * filters, the same `ranked` comparator, the same dependency array, differing
 * only in whether the result came back flat or grouped. They were two views of
 * one list that agreed because they had been written on the same afternoon.
 *
 * That is the arrangement this project keeps removing, and it had already gone
 * quietly wrong here: the Biophysics cell-type worksheet's id lives in
 * `immuneLayoutId` rather than in any sample's `layoutId`, so it matched no rank
 * in either copy and landed last *by falling off the end of the comparator*.
 * Correct, and correct for no reason anybody had written down — which is a thing
 * that stays correct exactly until the comparator is touched.
 *
 * So the rule is stated once, here, and it names the cell-type sheet rather than
 * letting it fall out: it is **its own group**. It is one worksheet for the whole
 * experiment where the others are one per sample, which is a different kind of
 * thing to be looking at and is precisely the distinction the bottom strip's
 * worksheet switch was added to make legible. A list that buries it at the end
 * of eight sample names is the same confusion one surface further out.
 *
 * Pure, and in `core/` so both callers can reach it — the store reads stay in
 * the two components, which pass the three orderings in.
 */
export interface OrderedLayout {
  id: string;
  name: string;
  kind: LayoutKind | undefined;
}

/**
 * The four groups, each already ordered, in the order they are offered.
 *
 * Separate arrays rather than one list with a group tag, because both callers
 * need the boundaries: the dropdown renders an `<optgroup>` per group and the
 * tab strip draws them in sequence. A tag would have each caller re-derive the
 * runs, which is the same duplication one level down.
 */
export interface LayoutGroups {
  /** What *New layout* makes, plus the boot worksheet. `kind === undefined`. */
  general: OrderedLayout[];
  /** The unmixing wizard's, in its own peak-detector walk order. */
  reference: OrderedLayout[];
  /** Biophysics distribution worksheets — one per sample, in the pipeline's order. */
  perSample: OrderedLayout[];
  /** The one Biophysics cell-type worksheet, once Step 5 has built it. */
  cellTypes: OrderedLayout[];
}

/**
 * Rank by position in `ids`, then by id so the order is total and stable.
 *
 * Anything not in `ids` sorts after everything that is. That is a real case and
 * not a fallback nobody hits — a worksheet whose owning panel has forgotten it,
 * mid-rebuild — so it is spelled out rather than left to arithmetic.
 */
function ranked(ids: ReadonlyArray<string | null>) {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return (a: OrderedLayout, b: OrderedLayout) =>
    ((rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    || a.id.localeCompare(b.id);
}

export function groupLayouts(
  layouts: readonly OrderedLayout[],
  order: {
    /** `controls.map(c => c.layoutId)` — the unmixing wizard's walk order. */
    controls: ReadonlyArray<string | null>;
    /** `samples.map(s => s.layoutId)` — the Biophysics pipeline's sample order. */
    bioSamples: ReadonlyArray<string | null>;
    /**
     * `immuneLayoutId()` — the one cell-type worksheet, or `null`.
     *
     * Asked for by id rather than inferred from "the biophysics layout that is
     * in no sample's `layoutId`". Both are true today; only one of them says
     * what it means, and the other is an inference in a second place, which is
     * the failure mode `spectralStore` records at length.
     */
    cellTypes: string | null;
  },
): LayoutGroups {
  const biophysics = layouts.filter((l) => l.kind === 'biophysics');
  return {
    general: layouts.filter((l) => l.kind === undefined).sort((a, b) => a.id.localeCompare(b.id)),
    reference: layouts.filter((l) => l.kind === 'reference').sort(ranked(order.controls)),
    perSample: biophysics.filter((l) => l.id !== order.cellTypes).sort(ranked(order.bioSamples)),
    cellTypes: biophysics.filter((l) => l.id === order.cellTypes),
  };
}

/** The same four groups as one list, for a surface that draws them in a row. */
export function flattenLayoutGroups(g: LayoutGroups): OrderedLayout[] {
  return [...g.general, ...g.reference, ...g.perSample, ...g.cellTypes];
}
