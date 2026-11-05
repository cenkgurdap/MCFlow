/**
 * How the statistics panel is currently set up.
 *
 * ## Why this store exists
 *
 * `App.tsx` renders one view at a time out of a ternary, so switching to Export
 * **unmounts** `StatisticsView` and every `useState` inside it goes with it.
 * Everything the panel knows about what the user is looking at — which statistic,
 * which measure, which populations, Table or Compare, how wide the columns are,
 * how the table is sorted — lived in those hooks, so a glance at the export
 * screen silently threw away a setup that can take a minute to rebuild
 * (2026-08-05, Item 4). The bug is not in any of those hooks; it is that the
 * state was scoped to the component rather than to the session.
 *
 * ## Why a store rather than keeping the view mounted
 *
 * Hiding the panel with CSS instead of unmounting it would have fixed the
 * symptom in one line, and it is the wrong fix twice over: the statistics table
 * evaluates every gate on every sample to build its rows, so a hidden-but-mounted
 * panel goes on doing that behind the export screen; and the state would still be
 * unreachable from anywhere else, so *Reset to defaults* would have nowhere to
 * live and the workspace could never be given a chance to carry it. This follows
 * `transformPrefs.ts` — the pattern the app already uses for a working
 * preference that outlives the control showing it.
 *
 * ## Session-scoped, deliberately
 *
 * Not saved with the workspace, not synced between windows, not on the undo
 * stack — the same three exclusions `transformPrefs` and `panelSize` carry. This
 * describes *how somebody is looking at* the analysis, not the analysis: two
 * windows onto one workspace should be able to show a table and a chart, and
 * Ctrl+Z after changing a measure should undo the last gate rather than a
 * dropdown. `restoreWorkspace` clears it for the same reason it clears the
 * transform preferences: a stored parameter index and a set of population paths
 * describe the workspace that was open, not the one being loaded.
 *
 * ## Invalidation is by derivation, not by mutation
 *
 * Nothing here watches the gate tree or the sample list. A stored population
 * path that no longer exists is *filtered out when it is read* (see
 * `livePaths`), and a parameter index past the end of the current file's
 * parameters reads back as "none" (see `liveStatParam`). That is the same
 * outcome as pruning the store on every data change, without an effect that
 * fires during render and writes to a store it is subscribed to — and it has one
 * property pruning does not: deleting a gate and undoing the deletion brings the
 * selection back, because the selection was never destroyed on the way through.
 */

import { useMemo } from 'react';
import { create } from 'zustand';
import type { StatKind } from '@/core/statistics';
import type { RowGrouping } from '@/core/statisticsOrder';
import { ALPHA, type ComparisonFamily, type PAdjust, type PairResult } from '@/core/significance';
import { shiftBetween, shiftIndex } from './parameterShift';
import { useDerived } from './derivedStore';
import { useWorkspace } from './workspaceStore';
import { useExperimentSamples } from './gateVisibility';

/** Which of the two screens the panel is showing. */
export type StatisticsMode = 'table' | 'chart';

/** How much of the parameter statistic the table export carries. */
export type ExportMeasures = 'all' | 'current';

/** What the comparison chart plots on its y axis. */
export type CompareMeasure = 'percentTotal' | 'percentParent' | 'count' | 'stat';

/**
 * Which family of test the comparison runs, if any.
 *
 * `'off'` is the default and is a position rather than an omission: a p-value
 * that appears without being asked for is a statistical claim the software made
 * on the operator's behalf, which is the same posture as never inferring a group
 * from a filename. Parametric or non-parametric is a judgement about the data
 * that nothing in a workspace can make.
 */
export type Significance = 'off' | 'parametric' | 'nonparametric';

/** What a bracket over the chart is annotated with. */
export type BracketLabel = 'stars' | 'p' | 'exact';

/** What the error bar on the comparison chart states — held in the Compare figure style since 0.35. */
export type CompareSpread = 'sd' | 'sem' | 'ci95';


export type TableSort = { key: string; dir: 'asc' | 'desc' } | null;

export interface StatisticsPrefState {
  /** Parameter index the statistic is computed over; −1 for counts only. */
  statParam: number;
  statKind: StatKind;
  /**
   * Which populations the table covers, by path. `null` means "every one".
   *
   * Null rather than a pre-filled set, so the default survives a gate being
   * drawn while this view is open: a set captured once would quietly exclude
   * anything added afterwards.
   */
  selection: Set<string> | null;
  /** Whether the population tree is disclosed. */
  showPicker: boolean;
  /**
   * Samples left out of the table, the Compare chart **and the export**, by id.
   *
   * Left out rather than chosen, so a sample imported afterwards is in the
   * analysis without anyone having to say so — the same reason `selection` is
   * null for "every population". One list for both screens: the table, the
   * chart and the files written are about the same samples, or one of them
   * quietly disagrees with the others. Saved with the workspace's session.
   */
  excludedSamples: string[];
  /** Whether the sample list is disclosed. */
  showSamples: boolean;
  mode: StatisticsMode;
  /** Table column widths in px, by column key. Empty until one is dragged. */
  columnWidths: Record<string, number>;
  sort: TableSort;
  /**
   * Whether the table reads sample-by-sample or population-by-population.
   *
   * `'sample'` is how the rows are computed and how a table about files reads.
   * `'population'` pulls every sample's CD4+ row together, which is the shape
   * somebody copying one population across twelve tubes into another tool needs
   * — see `panels/statisticsOrder.ts`. It reorders the rows themselves rather
   * than sorting a column, so the export carries the same order the screen does.
   */
  grouping: RowGrouping;
  /**
   * Which measures the table export writes: every parameter statistic, or only
   * the one on screen. All of them by default — the export is the complete
   * record, and re-exporting six times to collect six measures is what the
   * default is there to stop. Ignored when no parameter is selected.
   */
  exportMeasures: ExportMeasures;

  /* --- Compare view --- */
  measure: CompareMeasure;
  /** Population path the chart is drawn for; empty means "the first one". */
  population: string;
  /** Whether the sample-grouping table is disclosed. */
  showGrouping: boolean;
  /**
   * Category keys in the order the user arranged them; empty means "as loaded".
   *
   * Resolved against the categories that currently exist every time it is read
   * (`orderCategories`), so a renamed group or a removed file leaves the rest of
   * an arrangement standing rather than clearing it.
   */
  categoryOrder: string[];

  /* --- Significance testing --- */
  significance: Significance;
  /** Welch's correction for unequal SDs. Two-group parametric only. */
  welch: boolean;
  /** Which pairs the multiple-comparison correction is computed over. */
  family: ComparisonFamily;
  /**
   * How that family is corrected, or `'auto'` for the convention of whichever
   * test is running — Holm-Sidak after ANOVA, Bonferroni for Dunn's, which is
   * what Prism does and therefore what a reader will recognise.
   */
  pAdjust: PAdjust | 'auto';
  bracketLabel: BracketLabel;
  /**
   * Which comparisons get a bracket on the chart. `null` means the significant
   * ones.
   *
   * **Purely visual, and deliberately separate from `family`.** The correction is
   * computed over every pair the family names, whatever is drawn here — otherwise
   * hiding four brackets of six would divide the remaining p-values by three, and
   * somebody could lower their own p-values by tidying a figure.
   *
   * Null rather than a pre-filled set, for the reason `selection` is: a set
   * captured once would silently exclude a pair that becomes significant after a
   * gate is moved.
   */
  drawn: Set<string> | null;

  setStatParam(index: number): void;
  setStatKind(kind: StatKind): void;
  setSelection(selection: Set<string> | null): void;
  setShowPicker(open: boolean): void;
  setExcludedSamples(ids: string[]): void;
  setShowSamples(open: boolean): void;
  setMode(mode: StatisticsMode): void;
  setColumnWidths(widths: Record<string, number>): void;
  setSort(sort: TableSort): void;
  setGrouping(grouping: RowGrouping): void;
  setExportMeasures(which: ExportMeasures): void;
  setMeasure(measure: CompareMeasure): void;
  setPopulation(path: string): void;
  setShowGrouping(open: boolean): void;
  setCategoryOrder(order: string[]): void;
  setSignificance(significance: Significance): void;
  setWelch(welch: boolean): void;
  setFamily(family: ComparisonFamily): void;
  setPAdjust(adjust: PAdjust | 'auto'): void;
  setBracketLabel(label: BracketLabel): void;
  setDrawn(drawn: Set<string> | null): void;
  /** Back to how the panel opens. The explicit action, and the only reset. */
  reset(): void;
}

/**
 * What the panel opens as.
 *
 * Held as a function rather than an object so *Reset to defaults* cannot hand
 * out a shared `Set` or a shared `Record` that a later edit then mutates into
 * the defaults themselves.
 */
function defaults() {
  return {
    statParam: -1,
    statKind: 'median' as StatKind,
    selection: null,
    showPicker: false,
    excludedSamples: [] as string[],
    showSamples: false,
    mode: 'table' as StatisticsMode,
    columnWidths: {},
    sort: null,
    grouping: 'sample' as RowGrouping,
    exportMeasures: 'all' as ExportMeasures,
    measure: 'percentTotal' as CompareMeasure,
    population: '',
    showGrouping: false,
    categoryOrder: [] as string[],
    significance: 'off' as Significance,
    welch: true,
    family: 'all' as ComparisonFamily,
    pAdjust: 'auto' as PAdjust | 'auto',
    bracketLabel: 'stars' as BracketLabel,
    drawn: null as Set<string> | null,
  };
}

export const useStatisticsPrefs = create<StatisticsPrefState>((set) => ({
  ...defaults(),

  setStatParam: (statParam) => set({ statParam }),
  setStatKind: (statKind) => set({ statKind }),
  setSelection: (selection) => set({ selection }),
  setShowPicker: (showPicker) => set({ showPicker }),
  setExcludedSamples: (excludedSamples) => set({ excludedSamples }),
  setShowSamples: (showSamples) => set({ showSamples }),
  setMode: (mode) => set({ mode }),
  setColumnWidths: (columnWidths) => set({ columnWidths }),
  setSort: (sort) => set({ sort }),
  setGrouping: (grouping) => set({ grouping }),
  setExportMeasures: (exportMeasures) => set({ exportMeasures }),
  setMeasure: (measure) => set({ measure }),
  setPopulation: (population) => set({ population }),
  setShowGrouping: (showGrouping) => set({ showGrouping }),
  setCategoryOrder: (categoryOrder) => set({ categoryOrder }),
  setSignificance: (significance) => set({ significance }),
  setWelch: (welch) => set({ welch }),
  setFamily: (family) => set({ family }),
  setPAdjust: (pAdjust) => set({ pAdjust }),
  setBracketLabel: (bracketLabel) => set({ bracketLabel }),
  setDrawn: (drawn) => set({ drawn }),
  reset: () => set(defaults()),
}));

/**
 * Whether anything has been adjusted away from how the panel opens.
 *
 * What *Reset to defaults* is shown by. A reset control on a panel that is
 * already in its default state is a button that cannot do anything, and one that
 * is permanently visible on a screen whose whole job is a table is 60 px of
 * chrome earning nothing most of the time.
 *
 * Compared field by field against `defaults()` rather than by a dirty flag set
 * from the setters: a flag would stay raised after a user changed a measure and
 * changed it back, and would have to be cleared by every one of ten setters
 * getting the comparison right individually.
 */
export function isAdjusted(s: StatisticsPrefState): boolean {
  const d = defaults();
  return s.statParam !== d.statParam
    || s.statKind !== d.statKind
    || s.selection !== null
    || s.showPicker !== d.showPicker
    || s.excludedSamples.length > 0
    || s.showSamples !== d.showSamples
    || s.mode !== d.mode
    || Object.keys(s.columnWidths).length > 0
    || s.sort !== null
    || s.grouping !== d.grouping
    || s.exportMeasures !== d.exportMeasures
    || s.measure !== d.measure
    || s.population !== d.population
    || s.showGrouping !== d.showGrouping
    || s.categoryOrder.length > 0
    || s.significance !== d.significance
    || s.welch !== d.welch
    || s.family !== d.family
    || s.pAdjust !== d.pAdjust
    || s.bracketLabel !== d.bracketLabel
    || s.drawn !== null;
}

/**
 * The samples Statistics and Export are about: the experiment's samples
 * (`useExperimentSamples` — reference controls never), minus any left out.
 *
 * An id in `excludedSamples` that no longer names a loaded sample simply
 * matches nothing, so removing and re-importing a file brings it back in.
 */
export function useChosenSamples<T extends { id: string }>(all: readonly T[]): T[] {
  const experiment = useExperimentSamples(all);
  const excluded = useStatisticsPrefs((s) => s.excludedSamples);
  return useMemo(
    () => (excluded.length === 0 ? experiment : experiment.filter((s) => !excluded.includes(s.id))),
    [experiment, excluded],
  );
}

/* -------------------------------------------------------------------------
   Reading stored state against data that may have moved under it
   ------------------------------------------------------------------------- */

/**
 * The stored selection, narrowed to populations that still exist.
 *
 * `null` — meaning "all" — stays `null` rather than being expanded here, because
 * "all" has to keep tracking gates drawn later. A stored set is intersected with
 * what the tree currently holds, so a deleted population stops being counted the
 * moment it stops existing and the summary on the disclosure button ("4 of 9
 * populations") stays true.
 */
export function livePaths(selection: Set<string> | null, available: Iterable<string>): Set<string> {
  const all = new Set(available);
  if (selection === null) return all;
  const out = new Set<string>();
  for (const p of selection) if (all.has(p)) out.add(p);
  return out;
}

/**
 * The stored parameter index, or −1 if the loaded data has no such parameter.
 *
 * The case this exists for: a statistic is set on parameter 63 of a 71-parameter
 * Aurora file, then that sample is removed and a 6-parameter file is all that is
 * left. Every column read through `sampleColumn` would be indexing past the end
 * of the buffer, and the table would render a column of `NaN` under a heading
 * naming a detector that is not in the file.
 */
export function liveStatParam(statParam: number, parameterCount: number): number {
  return statParam >= 0 && statParam < parameterCount ? statParam : -1;
}

/**
 * The stored comparison population, or the first available one.
 *
 * The chart used to read `population || populations[0]`, which is right for the
 * empty initial value and wrong for a stored one: a path that has since been
 * deleted is a non-empty string, so it won the `||` and the chart drew no
 * categories at all with a populated dropdown above it.
 */
export function livePopulation(population: string, available: readonly string[]): string {
  return population && available.includes(population) ? population : available[0] ?? '';
}

/**
 * Which comparisons actually get a bracket drawn.
 *
 * `null` — the default — means the significant ones, evaluated against the pairs
 * that exist right now. That has to be derived rather than expanded into a stored
 * set on first read, for the same reason `selection` stays null: a set captured
 * once would go on drawing a bracket over a comparison that stopped being
 * significant when a gate moved, and would never pick up one that started.
 *
 * A stored set is intersected with the pairs currently on the chart, so a
 * category that has been renamed or removed costs its own brackets and leaves the
 * rest of a selection standing — the same merge `orderCategories` does.
 *
 * **This decides nothing about the arithmetic.** `compareGroups` has already
 * corrected every pair over the whole family by the time this is called; all that
 * is chosen here is what is on the plate.
 */
export function liveDrawn(drawn: Set<string> | null, pairs: readonly PairResult[]): Set<string> {
  const keyOf = (p: PairResult) => JSON.stringify([p.labelA, p.labelB]);
  if (drawn === null) {
    return new Set(pairs.filter((p) => p.pAdjusted <= ALPHA).map(keyOf));
  }
  const live = new Set(pairs.map(keyOf));
  const out = new Set<string>();
  for (const k of drawn) if (live.has(k)) out.add(k);
  return out;
}

/*
   The parameter the table summarises is an index like any other, and follows
   its parameter when a derived one is added or removed in front of it — see
   `state/parameterShift.ts`. On the removed one itself it falls back to `-1`,
   which `liveStatParam` already reads as "the panel's own default".

   Read off the definition list rather than the shift bus, because this setup is
   outside the undo stack: an undo of *Add derived parameter* changes the list
   back without anybody announcing it (`shiftBetween`).
*/
useDerived.subscribe((next, prev) => {
  if (next.defs === prev.defs) return;
  const { statParam } = useStatisticsPrefs.getState();
  const first = useWorkspace.getState().samples[0];
  if (statParam < 0 || !first) return;
  const shift = shiftBetween(prev.defs, next.defs, first.parsed.metadata.parameters.length);
  if (shift) useStatisticsPrefs.setState({ statParam: shiftIndex(statParam, shift) ?? -1 });
});

/* -------------------------------------------------------------------------
   Saved with the workspace (2026-10-28)
   ------------------------------------------------------------------------- */

/*
   The setup travels with the workspace, because *"reopen it where I left it"*
   was the request and the table someone had arranged is part of where they
   were. It was reset on every open until then, deliberately — its population
   paths and parameter index belong to one analysis — and that reasoning still
   holds for every *other* way the document changes: a workspace opened without
   a saved setup still gets the defaults. Every field is read back through the
   same guards the panel already applies on render (`liveStatParam`,
   `livePaths`, `liveDrawn`), so a setup naming a population that did not load
   costs only that population.
*/

type PrefData = ReturnType<typeof defaults>;
const SET_FIELDS = ['selection', 'drawn'] as const;

/** The setup as plain JSON — its two sets written as arrays. */
export function captureStatisticsPrefs(): Record<string, unknown> {
  const s = useStatisticsPrefs.getState();
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults()) as (keyof PrefData)[]) {
    const v = s[key];
    out[key] = v instanceof Set ? [...v] : v;
  }
  return out;
}

/**
 * Adopt a saved setup, field by field. A field that is missing, or whose type is
 * not the default's, keeps the default — a file can only ever say something this
 * build already knows how to show.
 */
export function adoptStatisticsPrefs(raw: unknown): void {
  const base = defaults();
  if (typeof raw !== 'object' || raw === null) {
    useStatisticsPrefs.setState(base);
    return;
  }
  const r = raw as Record<string, unknown>;
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base) as (keyof PrefData)[]) {
    const v = r[key];
    if (v === undefined) continue;
    if ((SET_FIELDS as readonly string[]).includes(key)) {
      if (v === null) next[key] = null;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) next[key] = new Set(v);
    } else if (key === 'sort') {
      const o = v as { key?: unknown; dir?: unknown } | null;
      if (o === null || (typeof o === 'object' && typeof o.key === 'string' && (o.dir === 'asc' || o.dir === 'desc'))) next[key] = v;
    } else if (key === 'categoryOrder' || key === 'excludedSamples') {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) next[key] = v;
    } else if (key === 'columnWidths') {
      if (typeof v === 'object' && v !== null && Object.values(v).every((x) => typeof x === 'number')) next[key] = v;
    } else if (typeof v === typeof base[key]) {
      next[key] = v;
    }
  }
  useStatisticsPrefs.setState(next as Partial<StatisticsPrefState>);
}
