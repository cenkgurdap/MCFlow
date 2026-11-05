import { useMemo, useRef, useState } from 'react';
import {
  BarChart3, ChevronDown, ChevronUp, Download, FileSpreadsheet, GripVertical, ListTree,
  Files, RotateCcw, Sheet, Sigma, Table2, Users,
} from 'lucide-react';
import { ROOT_ID } from '@/core/gating/types';
import { populationPath } from '@/core/gating/tree';
import {
  channelStats, formatStat, PARAMETER_STATS, pickStat, STAT_DECIMALS, STAT_LABELS,
  summariseGroup, type ChannelStats, type GroupSummary, type StatKind,
} from '@/core/statistics';
import {
  moveCategory, moveCategoryTo, orderCategories, orderRows, type RowGrouping,
} from '@/core/statisticsOrder';
import {
  adjustName, ALPHA, compareGroups, formatP, omnibusLine, pairKey, resolveAdjust, stars,
  type Comparison, type ComparisonFamily, type PAdjust,
} from '@/core/significance';
import {
  allPaths, csvRow, populationTree, ROOT_PATH, toggleSubtree, type PlanInput,
} from '@/core/export';
import { blockBetween, withBlock } from '@/core/rangeSelect';
import { writeXlsx } from '@/core/xlsx';
import { defaultSpecFor, evaluateFor, resolveGates, useGates } from '@/state/gateStore';
import { withoutReferenceGates } from '@/core/gating/referenceGates';
import { useExperimentSamples } from '@/state/gateVisibility';
import { parametersFor, sampleColumn, useDerived } from '@/state/derivedStore';
import { useSpectral } from '@/state/spectralStore';
import { groupIdFor, useWorkspace, type Sample, type SampleGroup } from '@/state/workspaceStore';
import {
  isAdjusted, liveDrawn, livePaths, livePopulation, liveStatParam, useChosenSamples, useStatisticsPrefs,
  type BracketLabel, type CompareMeasure, type CompareSpread, type ExportMeasures, type Significance,
} from '@/state/statisticsPrefs';
import { Button, IconButton } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Checkbox, Field, Select } from '@/ui/Field';
import { Callout, ColorChip, EmptyState } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { Popover } from '@/ui/Popover';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { DataTable, sizeToContent, type Column } from '@/ui/Table';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { useListKeys } from '@/ui/useListKeys';
import { platform } from '@/platform';
import { PopulationPicker } from './PopulationPicker';
import { SamplePicker } from './SamplePicker';
import { GroupingTable } from './GroupingTable';
import { categoryColors, conditionColor } from './groupColors';
import { FigureExport, type FigureSource } from './FigureExport';
import { composeCompareFigure } from '@/core/figure/compareFigure';
import { useFigure } from '@/state/figureStore';
import { FIGURE_WIDTHS, layOutBrackets, type CategoryPoint } from './compareChart';

interface Row {
  key: string;
  sampleId: string;
  sampleName: string;
  group: string;
  gateId: string;
  population: string;
  path: string;
  depth: number;
  colorIndex: number;
  count: number;
  percentParent: number;
  percentTotal: number;
  /** Parameter statistic, when one is selected. */
  stat: number;
  /**
   * Every measure of the same column, for the export that offers all of them.
   *
   * The table shows one at a time and always will — seven numeric columns beside
   * a population tree is not a table anybody reads. But a file is not a screen:
   * exporting one measure at a time means running the export seven times and
   * joining the results, which is what the "include all measures" choice removes.
   * `channelStats` computes all seven in the pass that produced the one on
   * screen, so carrying them costs an object per row and no extra arithmetic.
   *
   * Null when no parameter is selected — the counts-only table has no measures.
   */
  stats: ChannelStats | null;
}

/**
 * Cross-sample statistics.
 *
 * Every number here is computed on full data. The plot may subsample points for
 * rendering; a percentage or an MFI never is.
 */
export function StatisticsView() {
  const allSamples = useWorkspace((s) => s.samples);
  /*
     The experiment's samples, not the workspace's (2026-08-12, Item 11).

     The unmixing reference controls are dropped here and in `ExportView`. They
     are in the workspace so a matrix can be built from them; a single stain's
     own median is not a result, and thirteen extra tubes in a table of three
     replicates is noise with nothing to read in it.
  */
  const experiment = useExperimentSamples(allSamples);
  // Minus any left out on this screen or the export's — one choice for both.
  const samples = useChosenSamples(allSamples);
  const groups = useWorkspace((s) => s.groups);
  // Gating is shared across samples unless one has been forked off it, so a
  // sample's gates come from `resolveGates` rather than from a per-sample map.
  const sharedGates = useGates((s) => s.shared);
  const divergentGates = useGates((s) => s.divergent);
  const gateOverrides = useGates((s) => s.overrides);
  /**
   * Derived parameters are parameters here too, and that is the whole of Item 5.
   *
   * This view read `parsed.metadata.parameters` and sliced `parsed.data` by hand,
   * so a derived parameter was absent from the picker and — had anything managed
   * to select one — would have indexed past the end of the buffer. Both problems
   * are the same problem: two places in the app resolve a parameter index to
   * data, `parametersFor` and `sampleColumn`, and this was not going through
   * either of them. It does now, so a derived parameter is treated identically to
   * a real one in the table, the CSV export and the comparison chart.
   */
  const defs = useDerived((s) => s.defs);

  /*
     Every adjustment on this screen lives in a store rather than in `useState`.

     `App.tsx` renders one view out of a ternary, so navigating to Export
     unmounts this component — and with it went the statistic, the measure, the
     population selection, the Table/Compare choice, the column widths and the
     sort, every time somebody looked at the export screen and came back
     (2026-08-05, Item 4). Nothing about the panel changes visually; what changes
     is where the state is scoped. See `state/statisticsPrefs.ts` for why it is a
     store and not a mounted-but-hidden panel.
  */
  const {
    statKind, setStatKind, setStatParam,
    selection, setSelection, showPicker, setShowPicker, showSamples, setShowSamples,
    mode: view, setMode: setView,
    columnWidths, setColumnWidths, sort, setSort,
    grouping, setGrouping, exportMeasures, setExportMeasures,
    reset,
  } = useStatisticsPrefs();
  const storedStatParam = useStatisticsPrefs((s) => s.statParam);
  const adjusted = useStatisticsPrefs(isAdjusted);

  // The signal that a matrix has been applied — see `PlotCanvas`. An unmixed
  // abundance is a parameter, so an MFI over one is a statistic like any other.
  const unmixedResults = useSpectral((s) => s.unmixed);
  const parameters = useMemo(
    () => (samples[0] ? parametersFor(samples[0].parsed, defs) : []),
    [samples, defs, unmixedResults],
  );

  /*
     The stored index, read against the parameters that currently exist.

     Removing the 71-parameter Aurora file and leaving a 6-parameter one behind
     would otherwise have every row indexing past the end of the buffer, under a
     heading naming a detector that is not in the file. Derived rather than
     pruned, so re-importing the sample brings the choice back — see the note on
     invalidation in `statisticsPrefs.ts`.
  */
  const statParam = liveStatParam(storedStatParam, parameters.length);

  /** Every sample's gates and evaluated masks, once; reused by the tree and the rows. */
  const evaluations = useMemo(() => samples.map((s) => {
    // `withoutReferenceGates` unconditionally, with no reference-worksheet
    // exemption: there is no such thing as a reference worksheet in a
    // statistics table, and a control's bracket is setup rather than a result.
    const gates = withoutReferenceGates(resolveGates(sharedGates, divergentGates, gateOverrides, s.id));
    const ev = evaluateFor(s.id, s.parsed, gates, (p) => defaultSpecFor(s.parsed, p));
    return { sample: s, gates, ev };
  }), [samples, sharedGates, divergentGates, gateOverrides]);

  /** The union of every sample's gating, as one tree keyed by population path. */
  const inputs = useMemo<PlanInput[]>(() => evaluations.map(({ sample, gates, ev }) => ({
    sampleId: sample.id,
    sampleName: sample.name,
    gates,
    counts: new Map([...ev.stats].map(([id, st]) => [id, st.count])),
    totalEvents: sample.parsed.metadata.eventCount,
  })), [evaluations]);

  const tree = useMemo(() => populationTree(inputs), [inputs]);
  /*
     Narrowed to the populations that still exist.

     A stored set outlives the gates it names — deleting a gate while the panel
     is on another screen is the ordinary case — and a path nobody can see must
     not go on being counted in "4 of 9 populations". `null` still means "all"
     and stays `null`, so a gate drawn later is included rather than being
     excluded by a set captured before it existed.
  */
  const selectedPaths = useMemo(() => livePaths(selection, allPaths(tree)), [selection, tree]);
  const everything = selection === null || selectedPaths.size === tree.length;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const { sample: s, gates, ev } of evaluations) {
      // Empty unless somebody assigned one. Nothing is inferred from the
      // filename any more — see `regroup`, and Item 10 for the case that
      // produced it: two samples with a shared prefix and opposite conditions,
      // averaged together into one bar of n=2.
      const group = groups.find((g) => g.id === s.groupId)?.name ?? '';

      const statsFor = (gateId: string): ChannelStats | null => {
        if (statParam < 0) return null;
        const mask = ev.masks.get(gateId);
        // Statistics are reported in **raw** parameter units, not display space —
        // an MFI in "logicle units" means nothing outside this app. `sampleColumn`
        // is the one function that resolves an index to those values, real or
        // derived, and a real index still comes back as a zero-copy subarray.
        return channelStats(sampleColumn(s.parsed, statParam, defs), mask ?? null);
      };

      const push = (gateId: string, name: string, path: string, depth: number, colorIndex: number) => {
        const st = ev.stats.get(gateId);
        if (!st) return;
        // Keyed by **path**, never by gate id: an explicitly unlinked sample
        // carries a fork with fresh ids, so an id-keyed selection would include
        // five samples and silently drop the sixth. Same decision as the export.
        if (!selectedPaths.has(path)) return;
        const stats = statsFor(gateId);
        out.push({
          key: `${s.id}:${gateId}`,
          sampleId: s.id, sampleName: s.name, group,
          gateId, population: name, path, depth, colorIndex,
          count: st.count,
          percentParent: st.percentOfParent,
          percentTotal: st.percentOfTotal,
          stat: stats ? pickStat(stats, statKind) : NaN,
          stats,
        });
      };

      push(ROOT_ID, ROOT_PATH, ROOT_PATH, 0, -1);
      for (const g of gates) {
        const path = populationPath(gates, g.id);
        push(g.id, g.name, path, path.split('/').length, g.colorIndex);
      }
    }
    /*
       Sample-major as computed, or gathered by population if that is what has
       been asked for (`core/statisticsOrder.ts`).

       Applied **here**, to the rows themselves, rather than to what the table
       renders — so the export writes the order on screen without being told
       about it, which is the whole point of the option: the reason to group by
       population is to pull one population's twelve rows out into another tool.
       The Compare chart reads these rows too and does not care about their order;
       it groups them by category itself.
    */
    return orderRows(out, grouping);
  }, [evaluations, groups, statParam, statKind, selectedPaths, defs, grouping]);

  /**
   * The Sample column's opening width, fitted to the names actually loaded.
   *
   * The reported problem (2026-08-04, Item 7) is that a fixed `20%` truncated
   * `20250101-Sample B1` to `202606155-Pr…`, leaving a hover tooltip as
   * the only way to read a sample's name in a table *about* samples. A width
   * derived from the content fits them, up to a cap so one long filename cannot
   * take the whole table — and the columns are draggable underneath it, which is
   * what settles the cases an estimate gets wrong.
   */
  const sampleWidth = useMemo(
    () => sizeToContent(samples.map((s) => s.name), { header: 'Sample', min: 140, max: 340 }),
    [samples],
  );

  const columns = useMemo<Column<Row>[]>(() => {
    /*
       There is no Group column here any more (2026-08-04, Item 7).

       It showed an em dash on every row of every workspace where nobody had
       assigned a group, which is the default and stays the default — nothing is
       inferred from a filename. And where groups *are* assigned, the place that
       matters is the Compare tab, where a group is the category a box plot is
       drawn over and is edited in the same panel that shows it. A static column
       repeating that assignment could neither be edited nor acted on.

       `Row.group` is untouched. The chart reads it, and so does the export —
       where "which condition was this?" is exactly the question the person
       opening the file is about to ask, and there is no Compare tab to answer it.
    */
    const base: Column<Row>[] = [
      {
        key: 'sample', header: 'Sample', width: sampleWidth, sticky: true,
        sortValue: (r) => r.sampleName,
        cell: (r) => <span className="truncate text-[var(--text-primary)]" title={r.sampleName}>{r.sampleName}</span>,
      },
      {
        key: 'population', header: 'Population', width: '24%',
        sortValue: (r) => r.path,
        cell: (r) => (
          <span className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: Math.max(0, r.depth - 1) * 10 }}>
            {r.colorIndex >= 0 && <ColorChip color={`var(--pop-${String((r.colorIndex % 12) + 1).padStart(2, '0')})`} />}
            <span className="truncate" title={r.path}>{r.population}</span>
          </span>
        ),
      },
      { key: 'count', header: 'Count', numeric: true, sortValue: (r) => r.count, cell: (r) => formatStat(r.count, 'count') },
      { key: 'pParent', header: '% Parent', numeric: true, sortValue: (r) => r.percentParent, cell: (r) => formatStat(r.percentParent, 'percentParent') },
      { key: 'pTotal', header: '% Total', numeric: true, sortValue: (r) => r.percentTotal, cell: (r) => formatStat(r.percentTotal, 'percentTotal') },
    ];
    if (statParam >= 0) {
      base.push({
        key: 'stat',
        header: `${STAT_LABELS[statKind]} ${parameters[statParam]?.name ?? ''}`,
        numeric: true,
        // The one column that comes and goes, so it is the one that can be
        // missing from a stored width map — every other key is captured by the
        // snapshot the first drag takes. A number here is what the table falls
        // back to when that happens, instead of opening the new column at the
        // 56 px floor beside five columns the user has already sized.
        width: sizeToContent([], { header: `${STAT_LABELS[statKind]} ${parameters[statParam]?.name ?? ''}`, min: 120, max: 240 }),
        sortValue: (r) => r.stat,
        cell: (r) => formatStat(r.stat, statKind),
        title: parameters[statParam]?.type === 'Derived'
          ? `Computed over every event in the population, on ${parameters[statParam]?.stain}`
          : 'Computed on raw channel values over every event in the population',
      });
    }
    return base;
  }, [statParam, statKind, parameters, sampleWidth]);

  /**
   * The exported table, as one header row and one row per table row.
   *
   * Built once and rendered twice, so the CSV and the .xlsx cannot disagree
   * about which columns or what precision — the same argument as `eventColumns`
   * in `core/export.ts`, at a much smaller scale.
   *
   * **`group` is still a column here**, and it is the one place the removal in
   * Item 7 stops. On screen a group is redundant beside the Compare tab that
   * owns it; in a file handed to somebody else it is the difference between six
   * numbers and six numbers per condition, and there is no tab to go and look at.
   */
  const exportTable = () => {
    const paramName = parameters[statParam]?.name ?? 'param';
    /*
       Which measures the file carries — every one, or the one on screen.

       All of them by default. The table shows one measure at a time because
       seven numeric columns beside a population tree is not readable, but that
       is a constraint of the screen and not of the file: the alternative for
       somebody who wants median *and* CV is seven exports and a join, and every
       one of the seven is already computed by the pass that drew the table.
       `PARAMETER_STATS` is the same list the Measure dropdown offers, in the same
       order, so the columns and the control cannot drift apart.

       Empty when no parameter is selected — a counts-only table has no measures,
       and the choice is hidden rather than disabled in that state.
    */
    const kinds: StatKind[] = statParam < 0 ? []
      : exportMeasures === 'all' ? PARAMETER_STATS
        : [statKind];

    const header = ['sample', 'group', 'population', 'population_path', 'count', 'percent_parent', 'percent_total'];
    for (const k of kinds) header.push(`${k}_${paramName}`);

    const body = rows.map((r) => {
      const fields: Array<string | number> = [
        r.sampleName, r.group, r.population, r.path,
        r.count, Number(r.percentParent.toFixed(4)), Number(r.percentTotal.toFixed(4)),
      ];
      for (const k of kinds) {
        const v = r.stats ? pickStat(r.stats, k) : NaN;
        fields.push(Number.isFinite(v) ? Number(v.toFixed(4)) : NaN);
      }
      return fields;
    });
    return { header, body };
  };

  const runExport = async (format: 'csv' | 'xlsx') => {
    const { header, body } = exportTable();
    const p = platform();
    const target = await p.saveFileDialog(
      `statistics.${format}`,
      format === 'xlsx'
        ? [{ name: 'Excel workbook', extensions: ['xlsx'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    );
    if (!target) return;

    if (format === 'xlsx') {
      const book = await writeXlsx([{ name: 'Statistics', header, rows: body }]);
      await p.writeFile(target, book.buffer);
    } else {
      // The CSV keeps its string rendering: `toFixed(4)` writes the trailing
      // zeros a reader expects in a column of percentages, where the workbook's
      // numeric cells get their formatting from the spreadsheet.
      const lines = [csvRow(header), ...body.map((r) => csvRow(
        r.map((v) => (typeof v === 'number' ? (Number.isFinite(v) ? v : '') : v)),
      ))];
      await p.writeFile(target, lines.join('\r\n'));
    }
  };

  // The experiment, not the chosen samples — see the same guard in `ExportView`.
  // With every sample left out the toolbar and the sample list stay on screen,
  // since they are the way back.
  if (experiment.length === 0) {
    return (
      <Panel className="h-full">
        <PanelHeader title="Statistics" icon={<Table2 size={12} />} />
        <EmptyState className="mt-10" icon={<Table2 size={19} />} title="No samples loaded" description="Import files and build a gating strategy to see population statistics." />
      </Panel>
    );
  }

  return (
    <Panel className="h-full">
      <PanelHeader
        title="Statistics"
        count={`${rows.length} rows`}
        icon={<Table2 size={12} />}
        actions={
          <>
            {/* The explicit way back, and the *only* one (2026-08-05, Item 4).
                Clearing this panel used to be a side effect of looking at
                another one, which is the worst possible place for it: it is not
                asked for, not announced, and not undoable. Shown only when
                something has actually been adjusted, so the ordinary case is not
                carrying a control for a state it is already in. */}
            {adjusted && (
              <Tooltip content="Clear every adjustment on this panel — statistic, measure, populations, grouping, column widths and sort">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={12} />}
                  data-statistics-reset=""
                  onClick={reset}
                >
                  Reset
                </Button>
              </Tooltip>
            )}
            <TableExportMenu
              onExport={runExport}
              measures={statParam >= 0 ? exportMeasures : null}
              onMeasuresChange={setExportMeasures}
              measureLabel={STAT_LABELS[statKind]}
            />
          </>
        }
      />

      <div className="flex items-end gap-2 p-2.5 hairline-b">
        <Field label="Parameter statistic" className="w-[190px]">
          {/* Detectors and derived parameters in one list, split by an optgroup
              rather than by a second control. A derived parameter is a parameter
              — it has an index, a column and a range — and everywhere else in the
              app it is offered wherever a real one is; this list was the
              exception, because it read the file's own parameter array instead of
              `parametersFor`. The group heading is there because the *units* of a
              derived parameter are whatever its expression makes them, which is
              worth signalling before someone reads an MFI off a ratio. */}
          <Select value={statParam} onChange={(e) => setStatParam(Number(e.target.value))}>
            <option value={-1}>None (counts only)</option>
            <optgroup label="Detectors">
              {parameters.filter((p) => p.isDataChannel && p.type !== 'Derived').map((p) => (
                <option key={p.index} value={p.index - 1}>{p.label}</option>
              ))}
            </optgroup>
            {parameters.some((p) => p.type === 'Derived') && (
              <optgroup label="Derived">
                {parameters.filter((p) => p.type === 'Derived').map((p) => (
                  <option key={p.index} value={p.index - 1}>{p.label}</option>
                ))}
              </optgroup>
            )}
          </Select>
        </Field>
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Measure
              <InfoHint content="Median is the standard MFI in flow cytometry — it is robust to the bright outliers every sample carries. Geometric mean is computed over positive values only, since compensated channels contain negatives." />
            </span>
          }
          className="w-[140px]"
        >
          <Select value={statKind} onChange={(e) => setStatKind(e.target.value as StatKind)} disabled={statParam < 0}>
            {PARAMETER_STATS.map((k) => <option key={k} value={k}>{STAT_LABELS[k]}</option>)}
          </Select>
        </Field>
        {/* The tree lives behind a disclosure rather than beside the table. A
            checkbox tree over a deep hierarchy is tall, and this panel's whole
            job is the table under it; the summary on the button is what the old
            *Terminal populations only* checkbox was really communicating — how
            much of the hierarchy you are looking at — so that stays visible with
            the control folded away. */}
        <Button
          size="sm"
          variant={showSamples ? 'secondary' : 'ghost'}
          icon={<Files size={12} />}
          className="mb-1"
          data-samples-button=""
          onClick={() => setShowSamples(!showSamples)}
        >
          {samples.length === experiment.length
            ? `All ${experiment.length} samples`
            : `${samples.length} of ${experiment.length} samples`}
        </Button>
        <Button
          size="sm"
          variant={showPicker ? 'secondary' : 'ghost'}
          icon={<ListTree size={12} />}
          className="mb-1"
          onClick={() => setShowPicker(!showPicker)}
        >
          {everything ? `All ${tree.length} populations` : `${selectedPaths.size} of ${tree.length} populations`}
        </Button>
        {/* Table only. The Compare chart groups the same rows by category and
            takes no notice of their order, so offering the control there would
            be a setting with no visible effect. */}
        {view === 'table' && (
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                Group rows by
                <InfoHint content="Sample keeps each file's populations together, which is how the table is computed. Population puts every sample's row for one population in one block — the shape to copy a single population across all your samples into another tool. The export follows whichever is selected." />
              </span>
            }
            className="w-[160px]"
          >
            <Select
              data-row-grouping=""
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as RowGrouping)}
            >
              <option value="sample">Sample</option>
              <option value="population">Population</option>
            </Select>
          </Field>
        )}
        <div className="ml-auto mb-0.5">
          <SegmentedControl
            size="sm"
            value={view}
            onChange={setView}
            segments={[
              { value: 'table', label: 'Table', icon: <Table2 size={11} /> },
              { value: 'chart', label: 'Compare', icon: <BarChart3 size={11} /> },
            ]}
          />
        </div>
      </div>

      {(showSamples || samples.length === 0) && (
        <div className="p-2.5 hairline-b shrink-0">
          <SamplePicker
            samples={experiment}
            hint="Which samples the table, the Compare chart and the export are about. A sample left out stays loaded and keeps its gates; it is only left out of these numbers. The choice is shared with the Export screen and saved with the workspace. Shift-click a second row to take everything between."
          />
        </div>
      )}

      {showPicker && (
        <div className="p-2.5 hairline-b shrink-0">
          <PopulationPicker
            tree={tree}
            selected={selectedPaths}
            everything={everything}
            sampleCount={samples.length}
            countLabel="events across every sample that carries it"
            hint="Every population any loaded sample has — intermediate gates as well as terminal ones. Checking a parent takes everything under it; uncheck a child afterwards to leave it out. Shift-click a second row to take everything between — a range takes exactly the rows it covers, not their subtrees. This is the same tree the export dialog uses, and it is keyed by population path, so a sample that has been unlinked and forked still matches."
            onToggle={(path) => setSelection(toggleSubtree(tree, selectedPaths, path))}
            onSelectBlock={(paths, on) => setSelection(new Set(withBlock([...selectedPaths], paths, on)))}
            onAll={() => setSelection(null)}
            onNone={() => setSelection(new Set())}
          />
        </div>
      )}

      {view === 'table' ? (
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.key}
          resizable
          // Controlled, so a column dragged wider and a column sorted both
          // survive a trip to the Export screen. See `statisticsPrefs.ts`.
          widths={columnWidths}
          onWidthsChange={setColumnWidths}
          sort={sort}
          onSortChange={setSort}
          className="flex-1"
          emptyState={
            samples.length === 0
              ? <EmptyState size="sm" className="mt-8" icon={<Table2 size={15} />} title="No sample selected" description="Check a sample in the list above." />
              : <EmptyState size="sm" className="mt-8" icon={<Table2 size={15} />} title="No populations" description="Draw a gate to populate this table." />
          }
        />
      ) : (
        <ComparisonChart
          rows={rows}
          samples={samples}
          groups={groups}
          statParam={statParam}
          statKind={statKind}
          // Resolved through `parametersFor`, so a derived parameter names itself
          // on the axis rather than coming back undefined off the end of the
          // file's own parameter array.
          statParamName={parameters[statParam]?.name ?? ''}
        />
      )}
    </Panel>
  );
}

/* ========================================================================== */

/**
 * Export the table, in one of two formats.
 *
 * A menu rather than a second button beside the first: CSV and Excel are the
 * same action with a different container, and two buttons would read as two
 * features. CSV stays first and stays the default gesture.
 */
function TableExportMenu({
  onExport, measures, onMeasuresChange, measureLabel,
}: {
  onExport: (format: 'csv' | 'xlsx') => Promise<void>;
  /** Null when no parameter is selected — a counts-only table has no measures. */
  measures: ExportMeasures | null;
  onMeasuresChange: (m: ExportMeasures) => void;
  /** What "the one in the table" currently is, so the option can name it. */
  measureLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  const run = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    try {
      await onExport(format);
      setOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Tooltip content="Export this table as CSV or Excel">
        <Button
          ref={ref}
          // Named, because "Export" is also the label of the top-level view tab
          // and a search of the document by text finds that one first.
          data-table-export-button=""
          size="sm"
          variant="ghost"
          icon={<Download size={12} />}
          loading={busy !== null}
          onClick={() => setOpen((o) => !o)}
        >
          Export
        </Button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={252} align="end">
        <div className="p-1.5 space-y-0.5" data-table-export="">
          {/* What goes in the file, before which container it goes in. The
              measures are a property of the export and are asked once; the two
              buttons underneath are the same export written two ways. Absent
              rather than disabled when no parameter is selected — there is
              nothing for it to choose between on a counts-only table, which is
              the rule the histogram y axis established. */}
          {measures !== null && (
            <>
              <Field label="Measures" className="px-1 pt-0.5 pb-1">
                <Select
                  data-export-measures=""
                  value={measures}
                  onChange={(e) => onMeasuresChange(e.target.value as ExportMeasures)}
                >
                  <option value="all">All measures</option>
                  <option value="current">{measureLabel} only</option>
                </Select>
              </Field>
              <div className="hairline-b mx-1 mb-1" />
            </>
          )}
          <ExportChoice
            icon={<FileSpreadsheet size={13} />}
            title="CSV"
            blurb="Plain text. Opens anywhere."
            onSelect={() => run('csv')}
          />
          <ExportChoice
            icon={<Sheet size={13} />}
            title="Excel"
            blurb="An .xlsx workbook, one sheet."
            onSelect={() => run('xlsx')}
          />
        </div>
      </Popover>
    </>
  );
}

function ExportChoice({
  icon, title, blurb, onSelect,
}: {
  icon: React.ReactNode; title: string; blurb: string; onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      data-export-format={title.toLowerCase()}
      className="flex items-start gap-2 w-full px-2 py-1.5 rounded-[var(--radius-xs)] text-left hover:bg-[var(--surface-hover)]"
    >
      <span className="text-[var(--text-tertiary)] mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="block text-xs text-[var(--text-primary)]">{title}</span>
        <span className="block text-2xs text-[var(--text-tertiary)]">{blurb}</span>
      </span>
    </button>
  );
}

/* ========================================================================== */

/**
 * A bracket's text: stars, `P = 0.0012` / `P < 0.0001`, or the exact P to two
 * significant figures. The leading "=" a bare p-value used to print is gone — a
 * bracket reads as a sentence fragment, and "= 0.0123" is not one.
 */
export function bracketText(p: number, kind: BracketLabel): string {
  if (kind === 'stars') return stars(p);
  if (!Number.isFinite(p)) return '—';
  if (kind === 'exact') {
    if (p >= 0.001) return `P = ${Number(p.toPrecision(2))}`;
    const e = Math.floor(Math.log10(p));
    const sup = String(e).replace(/[-0-9]/g, (c) => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]!);
    return `P = ${(p / 10 ** e).toFixed(1)} × 10${sup}`;
  }
  return formatP(p).replace(/^p/, 'P');
}


/**
 * A category, and the samples that went into it.
 *
 * `summariseGroup` answers everything about the *distribution* and nothing about
 * *whose* numbers those were — it takes a bare `number[]`. That was sufficient
 * while every mark in a category was the same colour; it is not sufficient now
 * that a dot is coloured by the sample it came from, so the members ride along
 * beside the summary rather than the summary being re-derived from them.
 */
interface Category extends GroupSummary {
  points: CategoryPoint[];
}

/**
 * Group comparison chart.
 *
 * This is the differentiator the brief calls out: comparing a population across
 * conditions normally means exporting to Prism or Excel. **Mean ± SD with every
 * sample's own point over it** — with n=3 replicates a summary alone hides how
 * much of the spread is one outlier.
 */
function ComparisonChart({
  rows, samples, groups, statParam, statKind, statParamName,
}: {
  rows: Row[];
  samples: Sample[];
  groups: SampleGroup[];
  statParam: number;
  statKind: StatKind;
  /** Already resolved by the caller — real parameter or derived, both name themselves. */
  statParamName: string;
}) {
  // Stored beside the table's own settings, so switching to Export and back does
  // not drop the measure and the population this chart is drawn for.
  const measure = useStatisticsPrefs((s) => s.measure);
  const setMeasure = useStatisticsPrefs((s) => s.setMeasure);
  const population = useStatisticsPrefs((s) => s.population);
  const setPopulation = useStatisticsPrefs((s) => s.setPopulation);
  const showGrouping = useStatisticsPrefs((s) => s.showGrouping);
  const setShowGrouping = useStatisticsPrefs((s) => s.setShowGrouping);
  const categoryOrder = useStatisticsPrefs((s) => s.categoryOrder);
  const setCategoryOrder = useStatisticsPrefs((s) => s.setCategoryOrder);
  // One width for the chart on screen and the file it writes: the figure style's.
  const compareStyle = useFigure((s) => s.styles.compare);
  const figureWidth = compareStyle.size.widthMm;
  const setFigureWidth = (mm: number) => useFigure.getState().updateStyle('compare', 'size', { mode: 'figure', widthMm: mm });
  const significance = useStatisticsPrefs((s) => s.significance);
  const welch = useStatisticsPrefs((s) => s.welch);
  const family = useStatisticsPrefs((s) => s.family);
  const storedAdjust = useStatisticsPrefs((s) => s.pAdjust);
  const bracketLabel = useStatisticsPrefs((s) => s.bracketLabel);
  // The error bar is the Compare figure style's — one setting, read by the
  // chart on screen and the file alike.
  const compareSpread = compareStyle.compare.spread;
  const setCompareSpread = (spread: CompareSpread) => useFigure.getState().updateStyle('compare', 'compare', { spread });
  const conditionOverrides = useFigure((s) => s.conditionColors);
  const drawn = useStatisticsPrefs((s) => s.drawn);
  const setDrawn = useStatisticsPrefs((s) => s.setDrawn);
  const moveSampleToGroup = useWorkspace((s) => s.moveSampleToGroup);
  /** The chart's own SVG, for the image export. */

  const populations = useMemo(() => [...new Set(rows.map((r) => r.path))].sort(), [rows]);
  /*
     The stored population, or the first one that exists.

     This was `population || populations[0]`, which is correct for the empty
     initial value and wrong for a stored one: a path whose gate has since been
     deleted is still a non-empty string, so it won the `||` and the chart drew
     no categories under a perfectly populated dropdown. `livePopulation` asks
     whether the path is still available rather than whether it is truthy.
  */
  const active = livePopulation(population, populations);

  const valueOf = (r: Row) =>
    measure === 'count' ? r.count
      : measure === 'percentParent' ? r.percentParent
        : measure === 'stat' ? r.stat
          : r.percentTotal;

  /**
   * One category per sample, unless the user has said otherwise.
   *
   * **This is Item 10.** The category used to be the sample's group, and every
   * sample had a group because one was inferred from its filename — so two
   * files whose names shared a prefix were averaged into a single bar labelled
   * with the prefix, whatever the difference between them actually was. A
   * sample's own name is the only grouping the app can know without being told;
   * anything coarser is a claim about the experiment and has to come from the
   * person who ran it.
   */
  const summaries = useMemo<Category[]>(() => {
    /*
       ## A category is one colour, and the colour is where the column sits

       2026-08-11 gave every sample its own hue, against a rule that had given
       the whole chart one. The argument then was that a hue per **sample**
       encodes something a hue per *category* does not: it says which tube a dot
       came from, which is the one question the figure could not answer as soon
       as a category held more than one of them.

       That argument was made about a chart with no groups in it, and it stops
       holding the moment there are. A group is a claim that these three tubes
       are replicates of one condition — so the reader's question is no longer
       "which tube is this dot" but "does this condition differ from that one",
       and three hues inside one column actively fight the answer: the column
       reads as three things that happen to be adjacent rather than as one
       distribution.

       Which hue a category gets was, until 2026-08-19, a property of the sample
       list: a group took its **first member's** palette index, and an ungrouped
       sample kept its own. That is invisible from the figure — the same two
       conditions came out in different colours depending on which tube was
       imported first, and the UMAP projection of the same experiment, colouring
       by the order its groups appeared in, agreed with the chart only by luck.

       It is now the category's **position in the order drawn below**, which is
       the rule both panels follow. Two properties come out of that and are the
       reason for it: the two figures can be made to agree, by putting the groups
       in the same order in each; and the colour is something the reader can
       *see*, since the arrangement is on the axis in front of them. The cost is
       stated in `panels/groupColors.ts`: an ungrouped sample's dot no longer
       matches its sidebar chip, because a rule that treats a lone tube and a
       group differently is the thing that made the two panels disagree.

       Assigned after the ordering below rather than here, since the position is
       not known until the arrangement is resolved.
    */
    const forPop = rows.filter((r) => r.path === active);
    const byCategory = new Map<string, CategoryPoint[]>();
    for (const r of forPop) {
      const key = r.group || r.sampleName;
      const list = byCategory.get(key) ?? [];
      list.push({
        sampleId: r.sampleId,
        sampleName: r.sampleName,
        colorIndex: 0,
        value: valueOf(r),
      });
      byCategory.set(key, list);
    }
    /*
       In the order the user arranged, or as loaded.

       Which category sits beside which is the whole reading of a side-by-side
       comparison — untreated next to its own treatment, doses ascending — and
       until now it fell out of whichever file happened to be imported first.
       Nothing about import order encodes an experimental design and no automatic
       rule could infer one, which is the same reason nothing here groups by
       filename. `orderCategories` merges the stored arrangement against what
       currently exists, so a renamed group or a removed file costs the one
       category rather than the arrangement.
    */
    const natural = [...byCategory.keys()];
    return orderCategories(natural, categoryOrder).map((g, position) => {
      // The colour, from the place the column ends up in. See above.
      const pts = (byCategory.get(g) ?? []).map((p) => ({ ...p, colorIndex: position }));
      return {
        ...summariseGroup(g, pts.map((p) => p.value)),
        // The same filter `summariseGroup` applies to `values`, in the same order,
        // so `points[k]` and `values[k]` are the same measurement.
        points: pts.filter((p) => Number.isFinite(p.value)),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, active, measure, categoryOrder]);

  /** Group names already in use, offered as suggestions so a set stays consistent. */
  const groupNames = useMemo(() => [...new Set(groups.map((g) => g.name))].sort(), [groups]);

  /**
   * The test, when one has been asked for.
   *
   * Runs on `s.values` — **one value per sample**, which is what the chart is
   * already plotting and the only defensible unit. The events inside a tube are
   * not independent replicates of the treatment, so a test over them answers a
   * question nobody asked with an n of three hundred thousand and returns p ≈ 0
   * for any difference at all. See the note at the top of `core/significance.ts`.
   *
   * Null rather than an empty result when significance is off, so every reader
   * below has one thing to check.
   */
  const parametric = significance === 'parametric';
  const adjust = resolveAdjust(parametric, storedAdjust);
  const comparison = useMemo<Comparison | null>(() => {
    if (significance === 'off') return null;
    return compareGroups(
      summaries.map((s) => ({ label: s.group, values: s.values })),
      { parametric, welch, family, adjust },
    );
  }, [significance, parametric, welch, family, adjust, summaries]);

  /*
     Which comparisons carry a bracket — a purely visual choice, made after the
     arithmetic and unable to reach back into it.

     `compareGroups` has already corrected every pair the *family* names by the
     time this runs. If the correction were computed over what is drawn instead,
     hiding four brackets of six would divide the remaining p-values by three, and
     a figure could be made significant by tidying it. That is the one way this
     feature could be quietly and seriously wrong, so the two are separated here
     and asserted apart in `significance.test.ts`.
  */
  const drawnKeys = useMemo(
    () => liveDrawn(drawn, comparison?.pairs ?? []),
    [drawn, comparison],
  );

  if (populations.length === 0) {
    return <EmptyState className="mt-10" icon={<BarChart3 size={19} />} title="Nothing to compare" description="Draw at least one gate to compare populations across samples." />;
  }

  /*
     ## The figure, rather than the diagram
     ## (redesigned 2026-08-10; the statistic corrected 2026-08-11)

     The chart before 2026-08-10 was legible and looked like a debug view: a
     boxed frame, gridlines at fixed quarters regardless of the data, three sizes
     of text within four points of each other, and the axis title crammed at
     x=13. The restraint that pass introduced is all still here — no frame, no
     vertical gridlines, no left spine, one horizontal rule per tick, four real
     type sizes.

     **What 2026-08-11 corrects is the statistic itself, and it is a
     data-representation fix rather than a visual one.** The marks were a box at
     the interquartile range with a heavy rule at the median and whiskers to the
     extremes, and the summary table underneath reported **mean ± SD**. Those are
     two different descriptions of a distribution, drawn and printed six
     millimetres apart under one heading, and with n=3 — which is what a
     replicate set is — they are not close: the median of three numbers *is* the
     middle one, the box's edges are the other two, and neither the box nor the
     rule is what the table says the figure shows. So the marks are now what the
     table always said: a mean bar, an error bar at ± 1 SD, and the samples over
     it.

     Three things go with that change, all from the same report:

     - **A hue per sample**, from the population palette, so which tube a dot
       came from is legible inside a category as well as between categories. See
       `sampleColor` for why the previous pass's argument for one flat tone does
       not survive the dot being per-sample.
     - **Bigger dots** — r 2.6 → 4 — which is the marker floor a dot plot needs
       to be read at all, ringed in the plot surface so overlapping points stay
       countable.
     - **The summary in maximum-contrast ink**, never a data colour, so it cannot
       be mistaken for one more sample. See `SUMMARY_INK`.

     And the axis is framed on the data rather than on zero — `frameTicks`.
  */

  const statFormat = measure === 'count' ? 'count' : measure === 'stat' ? statKind : 'percentTotal';


  /*
     ## The significance annotation, and why it lives inside the SVG

     Same argument the colour key makes in `layOutLegend`: an encoding whose key
     lives in application chrome is an encoding the figure cannot be read without
     the application. A bracket printed beside the plate would not survive the
     export, and the export is what goes into a manuscript.

     **Two categories are annotated by the omnibus test itself**, because with two
     there is one comparison and it *is* the test — a checkbox to hide the only
     bracket, while its p-value is printed under the chart regardless, would be a
     control earning nothing. With three or more, the brackets are the post-hoc
     pairs the operator chose to show, defaulting to the significant ones.

     Indices come back through the labels rather than through the pair's own `a`
     and `b`: `compareGroups` drops an empty category before it numbers anything,
     so its indices are into the categories it could test, not into the ones drawn.
  */
  const bracketSpecs = (() => {
    if (!comparison?.omnibus) return [];
    const label = (p: number) => bracketText(p, bracketLabel);
    if (comparison.pairs.length === 0) {
      return summaries.length === 2
        ? [{ a: 0, b: 1, label: label(comparison.omnibus.p) }]
        : [];
    }
    const indexOf = new Map(summaries.map((s, i) => [s.group, i]));
    return comparison.pairs
      .filter((p) => drawnKeys.has(pairKey(p.labelA, p.labelB)))
      .map((p) => ({
        a: indexOf.get(p.labelA) ?? -1,
        b: indexOf.get(p.labelB) ?? -1,
        label: label(p.pAdjusted),
      }))
      .filter((b) => b.a >= 0 && b.b >= 0 && b.a !== b.b);
  })();
  const { brackets } = layOutBrackets(bracketSpecs);

  const omnibusText = comparison?.omnibus ? omnibusLine(comparison.omnibus) : null;

  const label = measure === 'count' ? 'Count'
    : measure === 'percentParent' ? '% of parent'
      : measure === 'stat' ? `${STAT_LABELS[statKind]}${statParam >= 0 ? ` — ${statParamName}` : ''}`
        : '% of total';

  /** The population's own name — the last segment of its path. */
  const popName = active.split('/').pop() || active;

  /** Category colours: the condition palette by position, then the user's overrides by name. */
  const catColors = categoryColors(summaries.map((x) => x.group), conditionOverrides);

  /**
   * The exported figure: the same categories, points, bars and brackets, laid
   * out by `composeCompareFigure` at the printed size the style asks for.
   */
  const figureSource: FigureSource = {
    type: 'compare',
    categories: summaries.map((x) => ({ name: x.group, color: catColors.get(x.group) ?? conditionColor(0) })),
    kind: 'compare',
    fileStem: `compare-${popName}-${label}`.replace(/[^\w.-]+/g, '_'),
    hasLayer: false,
    shape: 'free',
    options: [],
    compose: (style) => composeCompareFigure({
      categories: summaries.map((x) => ({
        label: x.group,
        color: catColors.get(x.group) ?? conditionColor(0),
        points: x.points.map((pt) => ({ value: pt.value, name: pt.sampleName })),
        summary: x,
      })),
      yTitle: label,
      brackets: brackets.map((b) => ({ a: b.a, b: b.b, label: b.label })),
      title: popName,
      notes: [
        `Population: ${active}.`,
        ...(comparison?.omnibus ? [`Test: ${comparison.omnibus.label}${comparison.postHocLabel ? `, with ${comparison.postHocLabel}` : ''}, on the per-sample values plotted.`] : []),
      ],
    }, style, style.compare),
  };
  /** The chart on screen: the very composition the file is written from. */
  const onScreen = figureSource.compose(compareStyle, 1);

  return (
    <div className="flex-1 overflow-auto p-3 space-y-3">
      <div className="flex items-end gap-2">
        <Field label="Population" className="w-[240px]">
          <Select value={active} onChange={(e) => setPopulation(e.target.value)}>
            {populations.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Measure" className="w-[170px]">
          <Select value={measure} onChange={(e) => setMeasure(e.target.value as CompareMeasure)}>
            <option value="percentTotal">% of total</option>
            <option value="percentParent">% of parent</option>
            <option value="count">Count</option>
            <option value="stat" disabled={statParam < 0}>Parameter statistic</option>
          </Select>
        </Field>
        {/*
            Figure width, beside the figure rather than inside the export dialog.

            It is a composition control, not an output setting: the chart is laid
            out at the chosen width on screen, so the plate somebody is looking
            at *is* the plate that gets written — the same relationship a
            worksheet panel has to its exported image. Putting it in the export
            popover instead would make the file disagree with the screen, which
            is the failure the plot exporter's deleted size presets had.
        */}
        <Field label="Figure width" className="w-[186px]">
          <Select
            data-compare-width=""
            value={String(figureWidth)}
            onChange={(e) => setFigureWidth(Number(e.target.value))}
          >
            {FIGURE_WIDTHS.map((f) => <option key={f.mm} value={f.mm}>{f.label}</option>)}
            {!FIGURE_WIDTHS.some((f) => f.mm === figureWidth) && <option value={figureWidth}>{`${figureWidth} mm`}</option>}
          </Select>
        </Field>
        <Field label="Error bar" className="w-[140px]">
          <Select data-compare-spread="" value={compareSpread} onChange={(e) => setCompareSpread(e.target.value as CompareSpread)}>
            <option value="sd">SD</option>
            <option value="sem">SEM</option>
            <option value="ci95">95% CI</option>
          </Select>
        </Field>
        {/* The category count moved onto the figure itself, top right, so it
            travels with an exported PNG instead of living in chrome that the
            export cannot see. Two copies of one number on one screen is the
            thing this pass has been removing everywhere else. */}
        <Button
          size="sm"
          variant={showGrouping ? 'secondary' : 'ghost'}
          icon={<Users size={12} />}
          className="mb-1"
          onClick={() => setShowGrouping(!showGrouping)}
        >
          {groups.length === 0 ? 'Group samples' : `${groups.length} group${groups.length === 1 ? '' : 's'}`}
        </Button>
        <SignificanceSettings categories={summaries.length} comparison={comparison} />
        <div className="ml-auto mb-1 flex items-center gap-1">
          {comparison?.omnibus && (
            <ComparisonExport
              population={active}
              measureLabel={label}
              summaries={summaries}
              comparison={comparison}
              adjust={adjust}
            />
          )}
          <FigureExport source={() => figureSource} label="Export chart image" />
        </div>
      </div>

      {/* Why there is no test, where the reason is actionable — almost always
          "nothing has been grouped", which is one button to the left. In chrome
          rather than on the figure: an absent test is a fact about the setup, not
          part of the plate. */}
      {comparison?.unavailable && (
        <Callout tone="info" className="max-w-[680px]">{comparison.unavailable}</Callout>
      )}

      {showGrouping && (
        <SampleGrouping
          samples={samples}
          groups={groups}
          groupNames={groupNames}
          onAssign={(ids, name) => ids.forEach((id) => moveSampleToGroup(id, groupIdFor(name)))}
          onClearAll={() => samples.forEach((s) => moveSampleToGroup(s.id, ''))}
        />
      )}

      {/* No border, no rounded card, no padding ring. The figure is the object;
          a chrome frame around it is the thing that made this read as a panel of
          the application rather than as a plate. `--surface-plot` still backs it,
          because that is the surface the export resolves and bakes in. */}
      <div className="bg-white inline-block rounded-[var(--radius-md)] p-1">
        {/* The composer's own SVG (0.35): what is shown is what is written,
            drawn at twice its printed size so it can be read on screen. */}
        {onScreen && (
          <div
            data-compare-chart=""
            className="[&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
            style={{ width: Math.min(820, onScreen.width * 2) }}
            dangerouslySetInnerHTML={{ __html: onScreen.svg.replace(/^<\?xml[^>]*>\s*/, '') }}
          />
        )}
        {omnibusText && <p data-compare-omnibus={comparison?.omnibus?.id ?? ''} className="px-1 pt-0.5 text-2xs tnum text-[#555]">{omnibusText}</p>}
      </div>

      {/*
         The figure legend: the sentence a reader needs in order to know what the
         marks mean, under the plate, in small type, the way a journal sets one.
         The colour *key* is inside the SVG — see `layOutLegend` — because that
         one has to survive being exported.

         **It says mean and SD now**, which is the whole of Item 1: it used to
         describe a box at the interquartile range with the median across it,
         while the table six millimetres below reported the mean and the SD. Two
         descriptions of one distribution under one heading is a figure nobody
         can read, and the maths, the marks and both captions now name the same
         two numbers.

         The last sentence is not a footnote. An axis that does not start at zero
         has to say so, or a reader takes the distance between two dots for a
         ratio.
      */}
      <p className="max-w-[680px] text-2xs leading-snug text-[var(--text-tertiary)]">
        Bar: mean. Whiskers: ± 1 SD. Each dot is one sample, in that sample&rsquo;s own colour;
        <span className="text-[var(--text-secondary)]"> n</span> is the number of samples in the category.
        The y axis is framed on the data rather than starting at zero.
        {/*
           The test names itself in the caption, and says what n counts.

           Both halves matter. A figure carrying asterisks and no test name is
           unpublishable, and a reader who assumes the n is events would read a
           p-value off three hundred thousand degrees of freedom. Only rendered
           when there is a test — a caption describing marks that are not on the
           plate is worse than a short one.
        */}
        {comparison?.omnibus && (
          <>
            {' '}
            <span className="text-[var(--text-secondary)]">{comparison.omnibus.label}</span>
            {comparison.postHocLabel ? `, with ${comparison.postHocLabel}` : ''}
            {', on the per-sample values plotted — n is samples, not events.'}
            {brackets.length > 0 && ` Brackets: ${
              bracketLabel === 'stars'
                ? `* ≤ 0.05, ** ≤ 0.01, *** ≤ 0.001, **** ≤ 0.0001, ns > ${ALPHA}`
                : 'the P value for that comparison'
            }${comparison.pairs.length > 0 ? ', adjusted for multiplicity' : ''}.`}
            {comparison.omnibus.note ? ` ${comparison.omnibus.note}` : ''}
          </>
        )}
      </p>

      {/* Mean ± SD per category, as a plain table rather than a grid of cards.
          Cards gave every category a border and a background — twelve boxes to
          read six numbers out of. A table is what the numbers are.

          It is also where the chart's category order is set (2026-08-13). The
          table already lists the categories in the order the columns are drawn
          in, so it is the surface that shows the thing being changed; a separate
          ordering control somewhere else would be a second list of the same
          names with nothing tying the two together. Same shape as the sample
          list: a drag handle, and a hover-revealed up/down pair for the cases a
          drag is awkward — one row, a trackpad, or a keyboard. */}
      <CategorySummary
        summaries={summaries}
        statFormat={statFormat}
        onMove={(key, delta) => setCategoryOrder(moveCategory(summaries.map((s) => s.group), key, delta))}
        onDrop={(key, targetKey) => setCategoryOrder(moveCategoryTo(summaries.map((s) => s.group), key, targetKey))}
        onResetOrder={categoryOrder.length > 0 ? () => setCategoryOrder([]) : undefined}
      />

      {comparison && comparison.pairs.length > 0 && (
        <PairwiseSummary
          comparison={comparison}
          adjust={adjust}
          drawnKeys={drawnKeys}
          onToggle={(key) => {
            const next = new Set(drawnKeys);
            if (next.has(key)) next.delete(key); else next.add(key);
            setDrawn(next);
          }}
          onSelectBlock={(keys, on) => setDrawn(new Set(withBlock([...drawnKeys], keys, on)))}
          onSetAll={(which) => setDrawn(
            which === 'auto' ? null
              : which === 'none' ? new Set()
                : new Set(comparison.pairs.map((p) => pairKey(p.labelA, p.labelB))),
          )}
          isAuto={drawn === null}
        />
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * Mean ± SD per category — and the control that decides which category sits
 * beside which on the chart above it.
 *
 * ## Why the ordering lives here (2026-08-13)
 *
 * Category order was whatever order the categories were first seen in, which is
 * import order, which encodes nothing. A comparison is read by adjacency —
 * untreated beside its own treatment, doses ascending — so the order is part of
 * the figure and has to be the operator's to set. No rule could infer it: only
 * the person who ran the experiment knows whether *Treatment A* belongs before
 * or after *Treatment B*, and guessing it from a name is the mistake `suggestGroups` was deleted
 * for.
 *
 * This table already lists the categories in the order the columns are drawn, so
 * it is the surface that *shows* the thing being changed. A separate ordering
 * control anywhere else would be a second list of the same names with nothing
 * tying the two together.
 *
 * ## Both routes, for the same reason the sample list has both
 *
 * A drag handle and a hover-revealed up/down pair. The drag is faster over a
 * long list; the arrows are what work on a trackpad, with one row already in the
 * right half of the list, and for anyone driving by keyboard. Both go through
 * `core/reorder.ts` via `statisticsOrder.ts`, so they cannot disagree about what
 * one place down means — which is the failure mode of having two.
 */
function CategorySummary({
  summaries, statFormat, onMove, onDrop, onResetOrder,
}: {
  summaries: Category[];
  statFormat: StatKind;
  onMove(key: string, delta: -1 | 1): void;
  onDrop(key: string, targetKey: string): void;
  /** Absent when nothing has been rearranged — there is nothing to put back. */
  onResetOrder?: () => void;
}) {
  /*
     The dragged key, in component state rather than in `dataTransfer`.

     `getData` returns nothing during `dragover` — deliberately, for privacy —
     so a target that must decide whether to accept *before* the drop cannot read
     the payload. Holding it here also keeps this drag out of the app's shared
     payload types: it never leaves this table, and a category is not a thing any
     other surface can accept.
  */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const many = summaries.length > 1;

  return (
    <div className="space-y-1">
      <table className="text-2xs tabular-nums max-w-[680px]" data-compare-summary="">
        <thead>
          <tr className="text-[var(--text-tertiary)]">
            {many && <th className="w-4 pb-1" aria-label="Reorder" />}
            <th className="text-left font-medium pr-6 pb-1">Category</th>
            <th className="text-right font-medium pr-6 pb-1">n</th>
            <th className="text-right font-medium pr-3 pb-1">Mean ± SD</th>
            {many && <th className="w-12 pb-1" aria-label="Move" />}
          </tr>
        </thead>
        <tbody>
          {summaries.map((s, i) => (
            <tr
              key={s.group}
              data-compare-summary-row={s.group}
              draggable={many}
              onDragStart={(e) => {
                setDragging(s.group);
                e.dataTransfer.effectAllowed = 'move';
                // Something has to be set or Firefox cancels the drag outright.
                e.dataTransfer.setData('text/plain', s.group);
              }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onDragOver={(e) => {
                if (!dragging || dragging === s.group) return;
                // Only claimed while one of *these* rows is in flight, so a file
                // dragged onto the window still reaches the importer underneath.
                e.preventDefault();
                setOver(s.group);
              }}
              onDragLeave={() => setOver((o) => (o === s.group ? null : o))}
              onDrop={(e) => {
                if (!dragging || dragging === s.group) return;
                e.preventDefault();
                e.stopPropagation();
                onDrop(dragging, s.group);
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                'group border-t border-[var(--border-subtle)]',
                many && 'cursor-grab active:cursor-grabbing',
                dragging === s.group && 'opacity-50',
                over === s.group && 'ring-1 ring-inset ring-[var(--accent-500)]',
              )}
            >
              {many && (
                <td className="py-1 text-[var(--text-disabled)]">
                  <GripVertical size={11} aria-hidden />
                </td>
              )}
              <td className="py-1 pr-6 text-[var(--text-secondary)] max-w-[280px] truncate">{s.group}</td>
              <td className="py-1 pr-6 text-right font-mono text-[var(--text-tertiary)]">{s.n}</td>
              <td className="py-1 pr-3 text-right font-mono text-[var(--text-primary)]">
                {formatStat(s.mean, statFormat)}
                <span className="text-[var(--text-disabled)]"> ± {formatStat(s.sd, statFormat)}</span>
              </td>
              {many && (
                <td className="py-0.5">
                  {/* Revealed on hover or focus, like the sample list's pair.
                      Permanently visible they would put twenty-four buttons
                      beside twelve numbers on a table whose job is the numbers. */}
                  <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <IconButton
                      label={`Move ${s.group} up`}
                      size="sm"
                      data-category-up={s.group}
                      disabled={i === 0}
                      onClick={() => onMove(s.group, -1)}
                    >
                      <ChevronUp size={11} />
                    </IconButton>
                    <IconButton
                      label={`Move ${s.group} down`}
                      size="sm"
                      data-category-down={s.group}
                      disabled={i === summaries.length - 1}
                      onClick={() => onMove(s.group, 1)}
                    >
                      <ChevronDown size={11} />
                    </IconButton>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {many && (
        <p className="text-2xs text-[var(--text-tertiary)]">
          Drag a row, or use the arrows, to set the order the categories are drawn in.
          {onResetOrder && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-1 align-baseline"
              data-category-order-reset=""
              onClick={onResetOrder}
            >
              Reset order
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * The comparison, as numbers rather than as a picture.
 *
 * ## Why this is not the Table tab's export
 *
 * That one writes one row per sample per population, under the Table tab's own
 * population selection. A group comparison has no row there: it is a statement
 * about categories, over the one population this chart is drawn for. Folding it
 * in would mean either a rectangular table with a ragged block bolted underneath,
 * or a second population selection quietly disagreeing with the visible one.
 *
 * ## Why the two formats carry different amounts
 *
 * A CSV is one table, so it gets the one table nothing else in the application
 * can produce: the comparisons and their p-values. The workbook gets three sheets
 * — the values the test ran on, the per-category summary, and the test itself —
 * because the values are what makes the result checkable by somebody who was not
 * here, and the whole point of a p-value in a paper is that it can be re-derived.
 */
function ComparisonExport({
  population, measureLabel, summaries, comparison, adjust,
}: {
  population: string;
  measureLabel: string;
  summaries: Category[];
  comparison: Comparison;
  adjust: PAdjust;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  /**
   * Two roundings, because a p-value is not a measurement.
   *
   * A measured value takes `STAT_DECIMALS`, so this file and the statistics table
   * beside it are the same number — the rule the whole panel follows. A p-value
   * cannot: `1.2e-9` written to four decimal places is `0.0000`, which reads as
   * zero and is the one thing a p-value must never be printed as. It keeps six
   * significant figures instead, which is more than the arithmetic earns and
   * costs nothing.
   */
  const round = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(STAT_DECIMALS)) : '');
  const roundP = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : '');

  /** The comparisons themselves — the CSV, and the workbook's third sheet. */
  const testTable = () => {
    const header = ['comparison', 'test', 'statistic_label', 'statistic', 'p', 'adjustment', 'p_adjusted', 'stars'];
    const rows: Array<Array<string | number>> = [];
    const o = comparison.omnibus;
    if (o) {
      rows.push([
        summaries.map((s) => s.group).join(' vs '),
        o.label, o.statisticLabel, round(o.statistic), roundP(o.p), '', '', stars(o.p),
      ]);
    }
    for (const p of comparison.pairs) {
      rows.push([
        `${p.labelA} vs ${p.labelB}`,
        comparison.postHocLabel ?? '', p.statisticLabel, round(p.statistic), roundP(p.p),
        adjustName(adjust), roundP(p.pAdjusted), stars(p.pAdjusted),
      ]);
    }
    return { header, rows };
  };

  const run = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    setError(null);
    try {
      const p = platform();
      const target = await p.saveFileDialog(
        `comparison.${format}`,
        format === 'xlsx'
          ? [{ name: 'Excel workbook', extensions: ['xlsx'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
      );
      if (!target) return;

      const test = testTable();
      if (format === 'csv') {
        const lines = [csvRow(test.header), ...test.rows.map((r) => csvRow(r))];
        await p.writeFile(target, lines.join('\r\n'));
      } else {
        const book = await writeXlsx([
          {
            name: 'Values',
            header: ['population', 'measure', 'category', 'sample', 'value'],
            // One row per sample — the numbers the test actually ran on, so the
            // result can be re-derived by somebody who was not here.
            rows: summaries.flatMap((s) => s.points.map((pt) => [
              population, measureLabel, s.group, pt.sampleName, round(pt.value),
            ])),
          },
          {
            name: 'Summary',
            header: ['category', 'n', 'mean', 'sd', 'median', 'min', 'max'],
            rows: summaries.map((s) => [
              s.group, s.n, round(s.mean), round(s.sd), round(s.median), round(s.min), round(s.max),
            ]),
          },
          { name: 'Comparison', header: test.header, rows: test.rows },
        ]);
        await p.writeFile(target, book.buffer);
      }
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Tooltip content="Export the comparison and its p-values">
        <Button
          ref={ref}
          data-comparison-export-button=""
          size="sm"
          variant="ghost"
          icon={<Download size={12} />}
          loading={busy !== null}
          onClick={() => setOpen((o) => !o)}
        >
          Export comparison
        </Button>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={264} align="end">
        <div className="p-1.5 space-y-0.5" data-comparison-export="">
          <ExportChoice
            icon={<FileSpreadsheet size={13} />}
            title="CSV"
            blurb="The comparisons and their p-values."
            onSelect={() => run('csv')}
          />
          <ExportChoice
            icon={<Sheet size={13} />}
            title="Excel"
            blurb="Three sheets: values, summary, comparison."
            onSelect={() => run('xlsx')}
          />
          {error && <div className="px-1 pt-1"><Callout tone="err">{error}</Callout></div>}
        </div>
      </Popover>
    </>
  );
}

/* ========================================================================== */

/**
 * Every comparison the family covers, and which of them get a bracket.
 *
 * ## Why the choice of brackets lives in this table
 *
 * The same argument the category reordering makes one component up: this table
 * already lists the comparisons, so it is the surface that *shows* the thing being
 * changed. A separate "which brackets" control anywhere else would be a second
 * list of the same pairs with nothing tying the two together.
 *
 * ## The column that is not here
 *
 * There is no way to change the family from this table, and that is deliberate.
 * The adjusted p-values below were corrected across every pair the family names —
 * ticking rows changes what is drawn and nothing else. Letting the ticks set the
 * family would mean six comparisons became three by hiding three brackets, and
 * every remaining p-value would fall by a factor of two. The family is chosen once,
 * in the settings popover, before any of these numbers exist.
 */
function PairwiseSummary({
  comparison, adjust, drawnKeys, onToggle, onSelectBlock, onSetAll, isAuto,
}: {
  comparison: Comparison;
  adjust: PAdjust;
  drawnKeys: Set<string>;
  onToggle(key: string): void;
  /** Shift-click: put a run of comparisons into one state. */
  onSelectBlock(keys: string[], on: boolean): void;
  onSetAll(which: 'auto' | 'all' | 'none'): void;
  /** Whether the drawn set is still "the significant ones", rather than a chosen list. */
  isAuto: boolean;
}) {
  /*
     The anchor for a Shift-range, as a pair key. Six groups is fifteen rows and
     the three buttons above answer only the three questions somebody thought of
     in advance; "these four" is not one of them.

     The row is deliberately **not** a hit target here, unlike the grouping
     table's: these cells hold p-values somebody may want to select and copy.
     The box is the control, and the box is what reads the modifier.
  */
  const anchor = useRef<string | null>(null);
  const ordered = comparison.pairs.map((p) => pairKey(p.labelA, p.labelB));

  const clickRow = (e: { shiftKey: boolean }, key: string) => {
    const from = anchor.current;
    const block = e.shiftKey ? blockBetween(ordered, from, key) : null;
    if (block && from !== null) {
      onSelectBlock(block, drawnKeys.has(from));
      return;
    }
    anchor.current = key;
    onToggle(key);
  };

  /*
     The keyboard, on the same handler. `semantics: 'none'` because this is a
     real table of statistics and a listbox whose options are table rows is a
     lie a screen reader acts on; the cursor ring is the affordance and the
     table keeps reading as a table.
  */
  const keys = useListKeys({ ordered, onActivate: clickRow, semantics: 'none' });

  return (
    <div className="space-y-1 pt-1">
      <div className="flex items-baseline gap-2 max-w-[680px]">
        <span className="text-2xs font-medium text-[var(--text-secondary)]">
          {comparison.postHocLabel}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" data-brackets-auto="" onClick={() => onSetAll('auto')}>
            Significant
          </Button>
          <Button size="sm" variant="ghost" data-brackets-all="" onClick={() => onSetAll('all')}>
            All
          </Button>
          <Button size="sm" variant="ghost" data-brackets-none="" onClick={() => onSetAll('none')}>
            None
          </Button>
        </span>
      </div>

      <table
        {...keys.containerProps}
        className="text-2xs tabular-nums max-w-[680px] focus:outline-none"
        data-compare-pairs=""
      >
        <thead>
          <tr className="text-[var(--text-tertiary)]">
            <th className="w-6 pb-1" aria-label="Draw" />
            <th className="text-left font-medium pr-6 pb-1">Comparison</th>
            <th className="text-right font-medium pr-6 pb-1">
              {comparison.pairs[0]?.statisticLabel ?? ''}
            </th>
            <th className="text-right font-medium pr-6 pb-1">p</th>
            <th className="text-right font-medium pr-4 pb-1">
              {adjustName(adjust)}-adjusted p
            </th>
            <th className="text-left font-medium pb-1">&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {comparison.pairs.map((p) => {
            const key = pairKey(p.labelA, p.labelB);
            const sig = p.pAdjusted <= ALPHA;
            return (
              <tr
                key={key}
                id={keys.rowId(key)}
                data-compare-pair={`${p.labelA} vs ${p.labelB}`}
                data-list-cursor={keys.cursor === key ? '' : undefined}
                className={cn(
                  'group border-t border-[var(--border-subtle)]',
                  keys.cursor === key && 'ring-1 ring-inset ring-[var(--accent-500)]',
                )}
              >
                <td className="py-1">
                  <Checkbox
                    checked={drawnKeys.has(key)}
                    ariaLabel={`Draw a bracket for ${p.labelA} vs ${p.labelB}`}
                    onChange={(_next, e) => keys.onRowClick(e, key)}
                  />
                </td>
                <td className="py-1 pr-6 text-[var(--text-secondary)] max-w-[240px] truncate">
                  {p.labelA} vs {p.labelB}
                </td>
                <td className="py-1 pr-6 text-right font-mono text-[var(--text-tertiary)]">
                  {p.statistic.toFixed(3)}
                </td>
                <td className="py-1 pr-6 text-right font-mono text-[var(--text-tertiary)]">
                  {formatP(p.p).replace('p ', '')}
                </td>
                <td
                  className={cn(
                    'py-1 pr-4 text-right font-mono',
                    sig ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                  )}
                  data-compare-adjusted={String(p.pAdjusted)}
                >
                  {formatP(p.pAdjusted).replace('p ', '')}
                </td>
                <td className="py-1 text-[var(--text-secondary)]">{stars(p.pAdjusted)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-2xs text-[var(--text-tertiary)] max-w-[680px]">
        {/* Stated on the surface where somebody is about to untick rows, which is
            the moment the question occurs to them. */}
        Adjusted across all {comparison.pairs.length} comparison
        {comparison.pairs.length === 1 ? '' : 's'} in the family. Ticking a row draws
        its bracket on the chart and does not change any p-value.
        {isAuto && ' Showing the significant ones.'}
      </p>
    </div>
  );
}

/* ========================================================================== */

/**
 * Which test, and how its results are drawn.
 *
 * A popover rather than three more `Field`s in the header row, which already
 * carries a population, a measure, a grouping button and an exporter. Everything
 * inside is a decision about *method*, and method decisions belong together —
 * choosing parametric and then hunting for the correction two controls away is
 * how a family gets set to something nobody meant.
 *
 * **Nothing here has a default answer beyond `None`.** Parametric or
 * non-parametric is a judgement about the data that a workspace cannot make, the
 * same way it cannot know which files are one condition. What the app does supply
 * is the convention for everything downstream of that judgement, so a single
 * choice produces a complete, named, reproducible test.
 */
function SignificanceSettings({
  categories, comparison,
}: {
  categories: number;
  comparison: Comparison | null;
}) {
  const significance = useStatisticsPrefs((s) => s.significance);
  const setSignificance = useStatisticsPrefs((s) => s.setSignificance);
  const welch = useStatisticsPrefs((s) => s.welch);
  const setWelch = useStatisticsPrefs((s) => s.setWelch);
  const family = useStatisticsPrefs((s) => s.family);
  const setFamily = useStatisticsPrefs((s) => s.setFamily);
  const pAdjust = useStatisticsPrefs((s) => s.pAdjust);
  const setPAdjust = useStatisticsPrefs((s) => s.setPAdjust);
  const bracketLabel = useStatisticsPrefs((s) => s.bracketLabel);
  const setBracketLabel = useStatisticsPrefs((s) => s.setBracketLabel);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  const on = significance !== 'off';
  const parametric = significance === 'parametric';
  const many = categories > 2;

  return (
    <>
      <Tooltip content="Compare the categories with a statistical test">
        <Button
          ref={ref}
          size="sm"
          variant={open || on ? 'secondary' : 'ghost'}
          icon={<Sigma size={12} />}
          className="mb-1"
          data-significance-open=""
          onClick={() => setOpen((o) => !o)}
        >
          {on ? comparison?.omnibus?.label ?? 'Significance' : 'Significance'}
        </Button>
      </Tooltip>

      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={300} align="start">
        <div className="p-2.5 space-y-3" data-significance-panel="">
          <Field
            label="Test"
            hint={
              on
                ? `${categories} categor${categories === 1 ? 'y' : 'ies'} — ${
                  many ? 'omnibus test with multiple comparisons' : 'two-group test'}`
                : 'No test is run until one is chosen.'
            }
          >
            <SegmentedControl
              fullWidth
              size="sm"
              value={significance}
              onChange={(v) => setSignificance(v as Significance)}
              segments={[
                { value: 'off', label: 'None' },
                { value: 'parametric', label: 'Parametric', title: many ? 'One-way ANOVA' : 'Unpaired t-test' },
                { value: 'nonparametric', label: 'Non-param.', title: many ? 'Kruskal-Wallis' : 'Mann-Whitney' },
              ]}
            />
          </Field>

          {/* Welch is a two-group parametric question and is absent otherwise,
              rather than disabled — the same rule the chart exporter follows for
              resolution under PDF. An ANOVA has its own equal-variance assumption
              and no separate switch for it. */}
          {on && parametric && !many && (
            <Checkbox
              checked={welch}
              onChange={setWelch}
              label="Welch's correction for unequal SDs"
            />
          )}

          {on && many && (
            <>
              <Field label="Compare">
                <Select
                  value={family}
                  data-significance-family=""
                  onChange={(e) => setFamily(e.target.value as ComparisonFamily)}
                >
                  <option value="all">Every pair</option>
                  <option value="vsFirst">Each against the first category</option>
                </Select>
              </Field>
              <Field
                label={
                  <span className="inline-flex items-center gap-1.5">
                    Correct for multiplicity
                    <InfoHint content="Comparing every pair of four groups is six tests, so one in five will reach 0.05 by chance alone. The correction is computed over every comparison in the family above — never over the brackets you choose to draw, which would let a figure be made significant by hiding brackets." />
                  </span>
                }
              >
                <Select
                  value={pAdjust}
                  data-significance-adjust=""
                  onChange={(e) => setPAdjust(e.target.value as PAdjust | 'auto')}
                >
                  <option value="auto">
                    {parametric ? 'Holm-Sidak (default)' : 'Bonferroni (default)'}
                  </option>
                  <option value="sidak">Holm-Sidak</option>
                  <option value="holm">Holm</option>
                  <option value="bonferroni">Bonferroni</option>
                </Select>
              </Field>
            </>
          )}

          {on && (
            <Field label="Bracket label">
              <SegmentedControl
                fullWidth
                size="sm"
                value={bracketLabel}
                onChange={(v) => setBracketLabel(v as BracketLabel)}
                segments={[
                  { value: 'stars', label: 'Asterisks' },
                  { value: 'p', label: 'P value' },
                  { value: 'exact', label: 'Exact P' },
                ]}
              />
            </Field>
          )}

          {/*
             The one sentence somebody has to read before trusting the number.

             Every test here runs on the per-sample values the chart plots, which
             is the only unit that answers the question the figure asks. A test
             over events would report p < 0.0001 for any two files whatsoever,
             because it would be measuring how many events were acquired.
          */}
          <p className="text-2xs leading-snug text-[var(--text-tertiary)]">
            Unpaired, two-sided, computed on the per-sample values plotted above —
            <span className="text-[var(--text-secondary)]"> n is the number of samples</span> in
            each category, never the number of events.
          </p>
        </div>
      </Popover>
    </>
  );
}

/* ========================================================================== */

/**
 * Which samples are in which group.
 *
 * A thin adapter over the shared `GroupingTable`, which is where the reasoning
 * for the table shape lives and where the bulk-assignment behaviour is
 * implemented. This function’s whole job is turning samples and groups into
 * rows and an assignment back into `moveSampleToGroup` — the UMAP panel asks the
 * same question of loaded CSV files and gets the same table.
 */
function SampleGrouping({
  samples, groups, groupNames, onAssign, onClearAll,
}: {
  samples: Sample[];
  groups: SampleGroup[];
  /** Names already in use, offered as completions so a set stays consistent. */
  groupNames: string[];
  onAssign: (sampleIds: string[], name: string) => void;
  onClearAll: () => void;
}) {
  const rows = useMemo(
    () => samples.map((s) => ({
      id: s.id,
      name: s.name,
      group: groups.find((g) => g.id === s.groupId)?.name ?? '',
    })),
    [samples, groups],
  );

  return (
    <GroupingTable
      rows={rows}
      groupNames={groupNames}
      onAssign={onAssign}
      onClearAll={onClearAll}
      note="Files with the same group name are one colour. Tick several rows to name them all at once — Shift-click a second row to take everything between. A file with no group is its own colour."
    />
  );
}

/* ========================================================================== */

