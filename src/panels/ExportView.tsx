import { useCallback, useMemo, useState } from 'react';
import {
  CheckCircle2, Download, FileSpreadsheet, FolderTree, Layers, Sheet, Sparkles,
} from 'lucide-react';
import {
  allPaths, defaultColumns, eventHeaders, eventRows, eventsToCsv, formatBytes, indicesFor,
  planFullExport, populationTree, ROOT_PATH, statusLabel, toggleSubtree,
  targetPath, workbookPath, type ExtraColumn, type ExportFormat, type ExportShape,
  type ExportTarget, type ManifestEntry, type PlanInput,
} from '@/core/export';
import { withBlock } from '@/core/rangeSelect';
import type { ParsedFcs } from '@/core/fcs/types';
import { unmixedColumn, unmixedFor } from '@/core/unmixedColumns';
import { writeXlsx, type SheetSpec } from '@/core/xlsx';
import { platform } from '@/platform';
import { sampleColumn, useDerived } from '@/state/derivedStore';
import { defaultSpecFor, displayColumn, evaluateFor, resolveGates, useGates } from '@/state/gateStore';
import { withoutReferenceGates } from '@/core/gating/referenceGates';
import { useExperimentSamples } from '@/state/gateVisibility';
import { useSpectral } from '@/state/spectralStore';
import { useWorkspace } from '@/state/workspaceStore';
import { Button } from '@/ui/Button';
import { Checkbox } from '@/ui/Field';
import { Badge, Callout, EmptyState, ProgressBar, StatTile } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { DataTable } from '@/ui/Table';
import { InfoHint } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { PopulationPicker } from './PopulationPicker';
import { SamplePicker } from './SamplePicker';
import { useChosenSamples } from '@/state/statisticsPrefs';

type RunState =
  | { phase: 'idle' }
  | { phase: 'running'; done: number; total: number; current: string }
  | {
      phase: 'done';
      entries: ManifestEntry[];
      root: string;
      shape: ExportShape;
      format: ExportFormat;
      bytes: number;
      /** Writer notes — e.g. a sheet that hit Excel's row limit. Deduplicated. */
      notes: string[];
    };

/**
 * Gate Export.
 *
 * Named *Full Gate Export* until 2026-08-10. The word was true of the first
 * version and stopped being true on 2026-07-31, when the population picker
 * arrived: the panel exports whichever populations are ticked, at any depth and
 * across any branch, so "full" described a shape it no longer had. Everything
 * else about it is unchanged, including `planFullExport`, which really does plan
 * the full cross product before the selection narrows it.
 *
 * Neither FlowJo nor FCS Express will export every gated population from every
 * loaded sample in one action, so this is built as an explicit, named feature
 * rather than a checkbox: the output shape is previewed before committing, and
 * the run ends with a results summary rather than a toast.
 *
 * ## What this panel used to say, and why it no longer says it
 *
 * There was a headline — *Every population, every sample, one pass* — and a
 * paragraph under it explaining what the feature was for. Both are gone
 * (2026-08-04, Item 11). They were written when nobody had used this screen; by
 * now the four tiles across the top state the same facts as numbers, the picker
 * below states which populations, and the preview states what will be written.
 * A paragraph that repeats the controls beneath it is 90 px of scroll between
 * the user and the thing they came to do.
 *
 * ## Two formats and two shapes
 *
 * CSV or Excel — **FCS 3.1 is removed**, see `ExportFormat` — crossed with one
 * file per population or one workbook per sample. Only three of the four
 * combinations exist, because "a tab per population" is not a thing a CSV can
 * be: a CSV file is one table of text. That constraint is stated in the UI
 * rather than enforced silently, which is the whole of the second half of Item
 * 11 — the card is visibly disabled while CSV is selected, it says why, and a
 * shape chosen under Excel and then orphaned by switching to CSV falls back with
 * a callout rather than quietly producing something else.
 */
export function ExportView() {
  const allSamples = useWorkspace((s) => s.samples);
  /*
     The experiment's samples, not the workspace's (2026-08-12, Item 11).

     The unmixing reference controls are dropped, here and in `StatisticsView`.
     A single-stain tube is setup: it is loaded so a matrix can be built from
     it, and writing its events out beside the multicolour sample's puts files
     in the folder that nothing downstream has a use for.
  */
  const experiment = useExperimentSamples(allSamples);
  // Minus any left out here or on the Statistics screen — one choice for both,
  // so the files written are about the samples the table and chart show.
  const samples = useChosenSamples(allSamples);
  // Gating is shared across samples unless one has been forked off it, so a
  // sample's gates come from `resolveGates` rather than from a per-sample map.
  const sharedGates = useGates((s) => s.shared);
  const divergentGates = useGates((s) => s.divergent);
  // And an individually unlinked gate has a boundary per sample, which the
  // export has to resolve per sample or it writes one sample's events under
  // another's name. See `resolveGates`.
  const gateOverrides = useGates((s) => s.overrides);

  /**
   * CSV is the default and stays the default.
   *
   * Excel was added beside it rather than in front of it (Item 11 is explicit
   * about this). CSV is what every downstream tool reads without a library, it
   * is what a five-minute export should produce if nobody thought about the
   * question, and .xlsx is the answer to a specific want — tabs, or a
   * destination that is literally Excel.
   */
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [shape, setShape] = useState<ExportShape>('per-population');
  const [run, setRun] = useState<RunState>({ phase: 'idle' });

  /*
     Values and column headers are no longer choices, and the defaults they were
     removed in favour of are the ones nearly everybody had.

     **Values: raw channel values.** That is what the instrument recorded and
     what every downstream package assumes; the *transformed* option wrote the
     display-space numbers, which reproduce a figure and are actively misleading
     fed into anything that assumes linear data. Offering it as a peer of the
     right answer, on a screen nobody re-reads, is how a statistics package ends
     up averaging logicle values.

     **Headers: the detector short name, `$PnN`.** Unique within a file by the
     standard's own rules, what `$SPILLOVER` and every gate definition reference,
     and what the same channel is called on every other surface in this app.
     `$PnS` is empty in every file in this workspace, so the *both* form rendered
     as the detector name followed by empty brackets.

     Both are stated in the preview note below rather than being invisible, which
     is the trade a removed setting has to make: the behaviour has to be
     discoverable even when the control is not.
  */
  const valueMode = 'raw' as const;
  const naming = 'name' as const;

  /**
   * Include the user's own derived parameters as columns.
   *
   * A checkbox, unlike the unmixed columns below, and the asymmetry is the whole
   * of the decision. An unmixed abundance is the output of the reference panel
   * this application exists to build — if a sample has one, it is what the
   * export is *for*, and asking is asking a question with one answer. A derived
   * parameter is an arbitrary expression somebody typed; "membrane order" may be
   * the point of the analysis or may be a scratch calculation from an hour ago,
   * and only the person who wrote it knows which.
   *
   * Off by default for the same reason.
   */
  const [includeDerived, setIncludeDerived] = useState(false);

  /**
   * Which populations to export, by path. `null` means "every one".
   *
   * Null rather than a pre-filled set, so the default survives a gate being drawn
   * while this view is open: a set captured at mount would quietly exclude anything
   * added afterwards, which is the same class of bug as a stale caret. It becomes a
   * real set on the first click, and *All populations* puts it back to null.
   */
  const [selection, setSelection] = useState<Set<string> | null>(null);

  const md = samples[0]?.parsed.metadata;

  /**
   * The shape that will actually run.
   *
   * Coerced rather than reset on switch, so a user who picks the workbook shape,
   * flips to CSV to compare the preview, and flips back finds their choice where
   * they left it. `orphaned` is what the UI says about the coercion — silently
   * exporting a different shape than the one showing as selected is exactly the
   * failure Item 11 asks to be prevented.
   */
  const orphaned = format === 'csv' && shape === 'workbook-per-sample';
  const effectiveShape: ExportShape = orphaned ? 'per-population' : shape;

  /**
   * Every parameter the file carries, Time included, in file order.
   *
   * There is no selection step and no control that produces one. An export is the
   * events of a population, all of them and all of their measurements; deciding
   * which of seventy-one columns matter is a question for whatever opens the
   * file, where the answer can be changed without re-running a five-minute
   * export. The Time channel in particular is not optional — `$TIMESTEP` QC is
   * the one thing a re-export cannot reconstruct.
   */
  const columns = useMemo(() => (md ? defaultColumns(md) : []), [md]);

  /* -------------------------------------------------------------------------
     Computed columns: unmixed abundances, and optionally derived parameters
     ------------------------------------------------------------------------- */

  const derivedDefs = useDerived((s) => s.defs);
  /*
     The reactivity signal for the abundances, not the abundances themselves.

     They live in a `WeakMap` keyed by `ParsedFcs` and a `WeakMap` has no
     subscribers, so this store record — replaced wholesale by `runUnmixing` and
     by `clearUnmixed` — is what tells a component that the set of unmixed
     parameters has moved. Same rule `PlotCanvas` follows.
  */
  const unmixedResults = useSpectral((s) => s.unmixed);
  // Which model produced those columns, for the noun this screen prints. It is
  // the same `kind` the pickers tag with, so Export cannot call a column
  // *unmixed* while every axis menu calls it *Comp*.
  const matrixKind = useSpectral((s) => s.kind);
  /*
     Which signatures are antibodies and which are baselines.

     Autofluorescence and unstained are references the solve needs and are not
     measurements of anything anybody stains for: their abundance column is "how
     much of this cell's signal was cellular background", which is diagnostic
     rather than phenotypic.

     **The exclusion moved into the registry on 2026-08-11 (Item 15)**, and this
     is what it bought. This function used to re-derive it — `isAutofluorescence`
     matched by index when the counts lined up and by label when they did not —
     which was a second implementation of a rule the similarity matrix already
     had, and a third surface, the axis picker, had never had at all. Now
     `unmixedFor` returns the surfaced set and nothing here has to decide: the
     columns this export writes are, by construction, the parameters the pickers
     offer.

     Still straight off the registry rather than through `sampleColumn`'s virtual
     index. It is the same zero-copy `Float32Array` a plot draws, with no index
     arithmetic in between to drift out of step with the parameter list.
  */
  const antibodyColumns = useCallback((parsed: ParsedFcs): ExtraColumn[] => {
    const u = unmixedFor(parsed);
    if (!u) return [];
    return u.labels.map((header, f) => ({
      header,
      values: unmixedColumn(parsed, f) ?? new Float32Array(0),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unmixedResults]);

  const derivedColumns = useCallback((parsed: ParsedFcs): ExtraColumn[] => {
    if (!includeDerived) return [];
    const real = parsed.metadata.parameters.length;
    return derivedDefs.map((d, i) => ({
      header: d.name,
      values: sampleColumn(parsed, real + i, derivedDefs),
    }));
  }, [includeDerived, derivedDefs]);

  /** Everything appended after the file's own parameters, for one sample. */
  const extraFor = useCallback(
    (parsed: ParsedFcs): ExtraColumn[] => [...antibodyColumns(parsed), ...derivedColumns(parsed)],
    [antibodyColumns, derivedColumns],
  );

  /**
   * What the extra columns will be, per loaded sample.
   *
   * Per sample rather than once, because unmixing is per file: a workspace can
   * hold the multicolour tube that was unmixed alongside the controls that were
   * not, and those samples get different column sets in the same run. The
   * summary below reports the range rather than pretending there is one number.
   */
  const extraSummary = useMemo(() => {
    const counts = samples.map((s) => ({
      name: s.name,
      unmixed: antibodyColumns(s.parsed).length,
      derived: derivedColumns(s.parsed).length,
    }));
    const unmixedMax = counts.reduce((a, c) => Math.max(a, c.unmixed), 0);
    return {
      counts,
      unmixedMax,
      unmixedSamples: counts.filter((c) => c.unmixed > 0).length,
      derivedCount: counts[0]?.derived ?? 0,
      /** The widest row any file will produce — what the size estimate needs. */
      widest: counts.reduce((a, c) => Math.max(a, c.unmixed + c.derived), 0),
      names: samples[0] ? antibodyColumns(samples[0].parsed).map((c: ExtraColumn) => c.header) : [],
    };
  }, [samples, antibodyColumns, derivedColumns]);

  /** Evaluate every sample once; reused by the plan, the preview and the run. */
  const evaluations = useMemo(() => {
    return samples.map((s) => {
      // The wizard's own gates are never populations to export — see the note
      // on the same line in `StatisticsView`.
      const gates = withoutReferenceGates(resolveGates(sharedGates, divergentGates, gateOverrides, s.id));
      const ev = evaluateFor(s.id, s.parsed, gates, (p) => defaultSpecFor(s.parsed, p));
      return { sample: s, gates, ev };
    });
  }, [samples, sharedGates, divergentGates, gateOverrides]);

  const inputs = useMemo<PlanInput[]>(() => evaluations.map(({ sample, gates, ev }) => ({
    sampleId: sample.id,
    sampleName: sample.name,
    gates,
    counts: new Map([...ev.stats].map(([id, st]) => [id, st.count])),
    totalEvents: sample.parsed.metadata.eventCount,
  })), [evaluations]);

  /** Every population any loaded sample has, as one tree keyed by path. */
  const tree = useMemo(() => populationTree(inputs), [inputs]);

  /** Resolved selection — the whole tree until the user narrows it. */
  const selectedPaths = useMemo(() => selection ?? allPaths(tree), [selection, tree]);
  const everything = selection === null || selectedPaths.size === tree.length;

  const plan = useMemo(() => planFullExport(
    inputs,
    // The widest row any file will produce, so the size estimate accounts for
    // thirteen abundance columns rather than reporting the raw panel's width for
    // a file that is about to carry 84.
    columns.length + extraSummary.widest,
    effectiveShape,
    selectedPaths.has(ROOT_PATH),
    format,
    selectedPaths,
    // The summary below reads off this, so it follows the tree live: `selectedPaths`
    // is a dependency and the plan is recomputed on every check.
  ), [inputs, columns.length, extraSummary.widest, effectiveShape, format, selectedPaths]);

  /** Options shared by the preview and the run, so the two cannot disagree. */
  const csvOptions = (parsed: (typeof samples)[number]['parsed']) => ({
    columns: { indices: columns, naming },
    valueMode,
    // Per sample, because unmixing is per file — see `extraSummary`.
    extraColumns: extraFor(parsed),
    transformed: (p: number) => displayColumn(parsed, p, defaultSpecFor(parsed, p)),
  });

  /** First few rows of exactly what will be written. */
  const preview = useMemo(() => {
    const first = plan.targets[0];
    if (!first || !md) return null;
    const entry = evaluations.find((e) => e.sample.id === first.sampleId);
    if (!entry) return null;
    const indices = indicesFor(entry.ev.masks, first.gateId);
    const extra = extraFor(entry.sample.parsed);
    return eventsToCsv(entry.sample.parsed, indices, {
      ...csvOptions(entry.sample.parsed),
      columns: { indices: columns.slice(0, 6), naming },
      // The first three computed columns, so the preview *shows* them rather
      // than only claiming them in prose underneath. Truncated like the file's
      // own, and the note below says how many of each are being elided.
      extraColumns: extra.slice(0, 3),
      maxRows: 4,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, evaluations, columns, naming, valueMode, md, extraFor]);

  /**
   * The files the run will produce, each with what it will hold.
   *
   * Per population that is a row count; per sample it is a tab count *and* a row
   * total, because "how big is this workbook" and "how many populations did I
   * get" are different questions and the second is the one the shape exists to
   * answer. Both are derived from `plan.targets`, which is what the run iterates
   * — so the preview is a claim that can be checked against the bytes afterwards
   * rather than a decoration.
   */
  const filePreview = useMemo(() => {
    if (effectiveShape === 'workbook-per-sample') {
      const bySample = new Map<string, { file: string; tabs: number; events: number }>();
      for (const t of plan.targets) {
        const row = bySample.get(t.sampleId)
          ?? { file: workbookPath(t.sampleName), tabs: 0, events: 0 };
        row.tabs++;
        row.events += t.eventCount;
        bySample.set(t.sampleId, row);
      }
      return [...bySample.values()];
    }
    return plan.targets.map((t) => ({ file: targetPath(t, format), tabs: 0, events: t.eventCount }));
  }, [plan, format, effectiveShape]);

  const shownFiles = filePreview.slice(0, 6);

  const start = async () => {
    const p = platform();
    const root = await p.chooseExportDir();
    if (!root) return;

    const entries: ManifestEntry[] = [...plan.skipped];
    let bytes = 0;
    // A set, because the same note lands once per file and 84 identical lines
    // would bury anything else the run had to say.
    const notes = new Set<string>();

    /** One target's events, as the generator the XLSX writer consumes. */
    const rowsFor = (t: ExportTarget) => {
      const entry = evaluations.find((e) => e.sample.id === t.sampleId)!;
      const indices = indicesFor(entry.ev.masks, t.gateId);
      return eventRows(entry.sample.parsed, indices, csvOptions(entry.sample.parsed));
    };

    if (effectiveShape === 'workbook-per-sample') {
      /* One workbook per sample, every population of it a tab.

         Grouped by sample id rather than by name: two loaded files can share a
         display name, and merging their populations into one workbook would put
         one sample's events under the other's tabs. They collide on the
         *filename* instead, which is visible, rather than in the contents,
         which is not. */
      const bySample = new Map<string, ExportTarget[]>();
      for (const t of plan.targets) {
        bySample.set(t.sampleId, [...(bySample.get(t.sampleId) ?? []), t]);
      }
      const groups = [...bySample.entries()];

      for (let i = 0; i < groups.length; i++) {
        const [sampleId, targets] = groups[i]!;
        const entry = evaluations.find((e) => e.sample.id === sampleId);
        const name = targets[0]!.sampleName;
        setRun({ phase: 'running', done: i, total: groups.length, current: `${name} — ${targets.length} tabs` });
        // Yield so the progress bar paints; otherwise the export is a freeze.
        await new Promise((r) => setTimeout(r, 0));

        if (!entry) {
          for (const t of targets) entries.push({ ...t, status: 'failed', file: null, reason: 'Sample no longer loaded' });
          continue;
        }

        const rel = workbookPath(name);
        try {
          const header = eventHeaders(entry.sample.parsed, csvOptions(entry.sample.parsed));
          const sheets: SheetSpec[] = targets.map((t) => ({
            name: t.populationName,
            header,
            rows: rowsFor(t),
          }));
          const book = await writeXlsx(sheets);
          await p.writeFile(p.joinPath(root, rel), book.buffer);
          bytes += book.buffer.byteLength;

          for (const w of book.truncated) {
            notes.add(`"${w.sheet}" was cut to Excel's limit of 1 048 576 rows — ${w.rows.toLocaleString()} events did not fit. Export that population as CSV to keep all of them.`);
          }
          // The tab name is what a reader will look for, and `sheetName` may
          // have shortened or de-duplicated it, so report the name that is
          // actually in the file rather than the one that was asked for.
          targets.forEach((t, k) => {
            entries.push({ ...t, status: 'written', file: `${rel} › ${book.sheetNames[k] ?? t.populationName}` });
          });
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          for (const t of targets) entries.push({ ...t, status: 'failed', file: null, reason });
        }
      }
    } else {
      for (let i = 0; i < plan.targets.length; i++) {
        const t = plan.targets[i]!;
        setRun({ phase: 'running', done: i, total: plan.targets.length, current: `${t.sampleName} › ${t.populationName}` });
        await new Promise((r) => setTimeout(r, 0));

        const entry = evaluations.find((e) => e.sample.id === t.sampleId);
        if (!entry) {
          entries.push({ ...t, status: 'failed', file: null, reason: 'Sample no longer loaded' });
          continue;
        }

        const rel = targetPath(t, format);
        try {
          if (format === 'xlsx') {
            const book = await writeXlsx([{
              name: t.populationName,
              header: eventHeaders(entry.sample.parsed, csvOptions(entry.sample.parsed)),
              rows: rowsFor(t),
            }]);
            await p.writeFile(p.joinPath(root, rel), book.buffer);
            bytes += book.buffer.byteLength;
            for (const w of book.truncated) {
              notes.add(`"${w.sheet}" was cut to Excel's limit of 1 048 576 rows — ${w.rows.toLocaleString()} events did not fit. Export that population as CSV to keep all of them.`);
            }
          } else {
            const indices = indicesFor(entry.ev.masks, t.gateId);
            const csv = eventsToCsv(entry.sample.parsed, indices, csvOptions(entry.sample.parsed));
            await p.writeFile(p.joinPath(root, rel), csv);
            bytes += csv.length;
          }
          entries.push({ ...t, status: 'written', file: rel });
        } catch (e) {
          entries.push({ ...t, status: 'failed', file: null, reason: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // Nothing else is written. There was an `export_manifest.csv` and an
    // `export_manifest.json` here, listing every combination attempted; the same
    // list is the results table below, which is where anyone actually read it,
    // and the filenames now carry the sample and the population so a folder can
    // be read without one.
    setRun({ phase: 'done', entries, root, shape: effectiveShape, format, bytes, notes: [...notes] });
  };

  // Asked of the experiment, not of the chosen samples: with every sample
  // unticked this screen must stay up, because the list that ticks one back is
  // on it. Asking `samples` here replaced the whole panel — picker included —
  // with "Import samples", and only an import brought it back.
  if (experiment.length === 0) {
    return (
      <Panel className="h-full">
        <PanelHeader title="Export" icon={<Download size={12} />} />
        <EmptyState className="mt-10" icon={<Download size={19} />} title="Nothing to export" description="Import samples and build a gating strategy first." />
      </Panel>
    );
  }

  if (run.phase === 'done') return <ExportResults run={run} onBack={() => setRun({ phase: 'idle' })} />;

  const ext = format === 'xlsx' ? 'xlsx' : 'csv';

  return (
    <Panel className="h-full">
      <PanelHeader title="Export" icon={<Download size={12} />} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] p-5 space-y-5">
          {/* The headline and the paragraph that used to sit here are gone — see
              the component note. The badges stay: they are the two facts the
              tiles below do not carry, namely which feature this is and the
              shape of the run as a product. */}
          <div className="flex items-center gap-2">
            {/* "Gate Export", not "Full Gate Export". *Full* was doing no work:
                the panel exports whichever populations are ticked in the picker
                below, which has been any set across any depth since 2026-07-31,
                so the badge named a shape the feature stopped having. */}
            <Badge tone="accent">Gate Export</Badge>
            <Badge mono>{plan.sampleCount} × {plan.populationCount}</Badge>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <StatTile label="Samples" value={plan.sampleCount} />
            <StatTile label="Populations" value={plan.populationCount} />
            <StatTile label="Files" value={plan.fileCount} tone="accent" />
            <StatTile label="Est. size" value={formatBytes(plan.estimatedBytes)} />
          </div>

          {/* ---- Format ---- */}
          <section className="space-y-2">
            <p className="eyebrow">File format</p>
            <div className="grid grid-cols-2 gap-2">
              <ShapeCard
                selected={format === 'csv'}
                onSelect={() => setFormat('csv')}
                icon={<FileSpreadsheet size={15} />}
                title="CSV"
                blurb="Plain text, one row per event. Opens anywhere. The default."
                hint="The right choice when the destination is R, pandas, Prism, or anything reading a file without a library. It stays the default now that Excel exists beside it: a CSV has no row limit, no sheet concept to get wrong, and nothing between the numbers and whatever reads them."
              />
              <ShapeCard
                selected={format === 'xlsx'}
                onSelect={() => setFormat('xlsx')}
                icon={<Sheet size={15} />}
                title="Excel"
                blurb="An .xlsx workbook. Needed for the per-sample tabs shape below."
                hint="The right choice when the destination is literally Excel, or when you want one file per sample with a tab per population. Note the ceiling: a worksheet holds 1 048 576 rows, so a population larger than that has to go out as CSV. Values are written as numbers, rounded to the same 4 decimal places the CSV uses."
              />
            </div>
            {/* Neither format carries instrument metadata, and that is a real
                change rather than a footnote — it is what removing the FCS
                option cost. Said once, here, beside the choice it applies to.

                The sentence that followed it — "FCS 3.1 output has been
                removed" — is gone (2026-08-11, Item 2). It was release history,
                addressed to somebody who remembered a format this panel has not
                offered since 2026-08-04, and it answered a question nobody
                standing here is asking. What the two formats *do* carry is the
                part that still matters. */}
            <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
              Both formats carry the numbers only — no cytometer, laser or acquisition keywords, and no spillover
              matrix.
            </p>
          </section>

          {/* ---- Shape ---- */}
          <section className="space-y-2">
            <p className="eyebrow">Output shape</p>
            <div className="grid grid-cols-2 gap-2">
              <ShapeCard
                selected={effectiveShape === 'per-population'}
                onSelect={() => setShape('per-population')}
                icon={<FolderTree size={15} />}
                title="One file per population"
                blurb={`A flat list of Sample_Population.${ext} in the folder you choose.`}
                hint="Best for manual review, Prism and scripted analysis — you can open exactly the one population you care about without filtering a huge file. The filename carries the sample and the population, so there is no folder to nest and no index file to read."
              />
              <ShapeCard
                selected={!orphaned && shape === 'workbook-per-sample'}
                disabled={format === 'csv'}
                onSelect={() => setShape('workbook-per-sample')}
                icon={<Layers size={15} />}
                title="One file per sample, a tab per population"
                blurb={
                  format === 'csv'
                    ? 'Excel only — a CSV file is a single table and has no tabs.'
                    : 'Sample.xlsx, with every population of that sample as a worksheet.'
                }
                hint="Best when the unit of work is a sample: one file per file you loaded, and the populations are tabs along the bottom rather than files to find. Only available in Excel format, because a CSV is one table of text — there is nowhere in the format for a second sheet to go."
              />
            </div>
            {orphaned && (
              <Callout tone="warn" title="Falling back to one file per population">
                A tab per population needs a format that has tabs, and CSV does not — a <code>.csv</code> is a single
                table of text. This run will write one file per population. Switch the format to Excel above to get
                the workbook shape back; the choice is remembered, not discarded.
              </Callout>
            )}
          </section>

          {/* ---- Columns ----

              No *Values* dropdown and no *Column headers* dropdown: raw channel
              values under the detector short name, always. See the note beside
              `valueMode` for why those two answers won outright rather than
              staying as choices. No channel selection either — every parameter
              goes out, Time included.

              What is here instead is the two kinds of column the app *computes*,
              which until now could be plotted and gated and not exported. */}
          <section className="space-y-2">
            <p className="eyebrow">Computed columns</p>

            {extraSummary.unmixedMax > 0 ? (
              <Callout tone="ok" title={`${extraSummary.unmixedMax} ${matrixKind === 'compensation' ? 'compensated' : 'unmixed'} antibody columns are included automatically`}>
                <span className="block">
                  {extraSummary.unmixedSamples === samples.length
                    ? `Every sample in this workspace has ${matrixKind === 'compensation' ? 'a compensation' : 'an unmixing'} matrix applied.`
                    : `${extraSummary.unmixedSamples} of ${samples.length} samples have ${matrixKind === 'compensation' ? 'a compensation' : 'an unmixing'} matrix applied; the rest export their detectors only.`}
                  {' '}
                  Each fluorophore’s per-event abundance goes out beside the raw detectors, which is what makes an
                  export usable for UMAP, clustering or any downstream tool that takes a table of cells × markers.
                </span>
                <span className="block mt-1 font-mono text-[10px] break-words text-[var(--text-tertiary)]">
                  {extraSummary.names.join(' · ')}
                </span>
                <span className="block mt-1 text-[var(--text-tertiary)]">
                  Autofluorescence and unstained references are left out: they are signatures the solve needs rather
                  than markers anybody stained for.
                </span>
              </Callout>
            ) : derivedDefs.length === 0 ? (
              /*
                 One line, and only when there is genuinely nothing to compute
                 (2026-08-11, Item 3).

                 What stood here explained the *mechanism* — that unmixing a
                 sample adds its abundances automatically and that there is no
                 setting for it — which is a description of a feature that is
                 not happening, delivered at the moment it is least useful. This
                 section has one job in this state: say that it is empty. If a
                 custom parameter exists the checkbox below already speaks for
                 it, so this renders only when neither kind is defined.
              */
              <p data-no-computed-columns="" className="text-2xs text-[var(--text-tertiary)] leading-snug">
                No parameters defined, so there are no computed columns.
              </p>
            ) : null}

            {derivedDefs.length > 0 && (
              // Not wrapped in a `<label>`: `Checkbox` renders a `<button
              // role="checkbox">`, and a label forwards its click to a labelable
              // descendant, so the row would toggle twice and therefore not at
              // all. That trap is recorded on `Checkbox` itself.
              <div data-include-derived="" className="space-y-0.5">
                <Checkbox
                  checked={includeDerived}
                  onChange={setIncludeDerived}
                  label={
                    <span className="text-xs text-[var(--text-primary)]">
                      Include {derivedDefs.length} custom parameter{derivedDefs.length === 1 ? '' : 's'} as columns
                    </span>
                  }
                />
                <p className="text-2xs text-[var(--text-tertiary)] leading-snug pl-[22px]">
                  {derivedDefs.map((d) => d.name).join(' · ')} — one value per event, per sample, computed from the
                  equation defined in the Parameters panel.
                </p>
              </div>
            )}
          </section>

          {/* ---- Which samples ---- */}
          <SamplePicker
            samples={experiment}
            hint="Which samples are exported. A sample left out stays loaded and keeps its gates. The choice is shared with the Statistics screen and saved with the workspace. Shift-click a second row to take everything between."
          />
          {samples.length === 0 && experiment.length > 0 && (
            <p className="text-2xs text-[var(--status-warn)]">
              No sample selected, so there is nothing to export. Check a sample above.
            </p>
          )}

          {/* ---- Which populations ---- */}
          <PopulationPicker
            tree={tree}
            selected={selectedPaths}
            everything={everything}
            sampleCount={plan.sampleCount}
            hint="Every population any loaded sample has. Checking a parent takes everything under it, which is the usual request; uncheck a child afterwards to leave it out. Shift-click a second row to take everything between — a range takes exactly the rows it covers, not their subtrees. A population that only some samples carry says so on its row, and the ones that are missing are still listed in the results table."
            onToggle={(path) => setSelection(toggleSubtree(tree, selectedPaths, path))}
            onSelectBlock={(paths, on) => setSelection(new Set(withBlock([...selectedPaths], paths, on)))}
            onAll={() => setSelection(null)}
            onNone={() => setSelection(new Set())}
          />
          {selectedPaths.size === 0 && (
            <p className="text-2xs text-[var(--status-warn)]">
              Nothing selected, so there is nothing to export. Check a population above.
            </p>
          )}

          {/* ---- Preview ---- */}
          <section className="space-y-2">
            <p className="eyebrow flex items-center gap-1.5">
              Preview
              <InfoHint content="The files that will actually be written, with the options above applied, and the first rows of the first one — so the output is never a surprise." />
            </p>
            <div
              data-file-preview=""
              className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5 text-[10px] font-mono leading-relaxed text-[var(--text-secondary)] overflow-x-auto"
            >
              {shownFiles.map((f) => (
                <div key={f.file} data-preview-file={f.file} className="flex items-baseline gap-3">
                  <span className="truncate">{f.file}</span>
                  <span className="ml-auto shrink-0 tnum text-[var(--text-tertiary)]">
                    {f.tabs > 0 ? `${f.tabs} tabs · ` : ''}{f.events.toLocaleString()} events
                  </span>
                </div>
              ))}
              {filePreview.length > 6 && (
                <div className="text-[var(--text-disabled)]">
                  … and {filePreview.length - 6} more, {(plan.totalEvents - shownFiles.reduce((a, f) => a + f.events, 0)).toLocaleString()} events between them
                </div>
              )}
              {filePreview.length === 0 && <div className="text-[var(--text-disabled)]">Nothing to write.</div>}
            </div>
            {preview && (
              <pre className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5 text-[10px] font-mono leading-relaxed text-[var(--text-secondary)] overflow-x-auto">
                {preview}
                {'\n…'}
              </pre>
            )}
            {/* No `($PnN)` (2026-08-11, Item 5). The keyword is the standard's
                name for the field the header is taken from, which is worth
                knowing when you are reading the FCS specification and is noise
                when you are reading a preview: "their detector names" already
                says which of the two names a column carries, and the bracketed
                keyword only tells somebody who already knew. */}
            <p className="text-2xs text-[var(--text-tertiary)]">
              Showing the first 6 of {columns.length} file columns
              {extraSummary.widest > 0 && ` and the first ${Math.min(3, extraSummary.widest)} of ${extraSummary.widest} computed ones`}
              {' '}— raw channel values under their detector names, every parameter in the file, Time
              included.
              {format === 'xlsx' && ' Excel gets the same values as numbers rather than text, one worksheet row per event.'}
            </p>
          </section>

          {plan.skipped.length > 0 && (
            <Callout tone="warn" title={`${plan.skipped.length} combination(s) will be skipped`}>
              {plan.skipped.filter((s) => s.status === 'skipped-empty').length} population(s) contain no events and{' '}
              {plan.skipped.filter((s) => s.status === 'skipped-missing').length} gate(s) are not defined on every
              sample. All of them are listed in the results table when the run finishes.
            </Callout>
          )}

          {run.phase === 'running' && (
            <ProgressBar value={run.done} max={run.total} label={run.current} detail={`${run.done} / ${run.total}`} />
          )}

          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="primary"
              size="lg"
              icon={<Sparkles size={13} />}
              loading={run.phase === 'running'}
              disabled={plan.fileCount === 0}
              onClick={start}
            >
              Export {plan.fileCount} file{plan.fileCount === 1 ? '' : 's'}
            </Button>
            <p className="text-2xs text-[var(--text-tertiary)]">
              {plan.sampleCount} samples × {plan.populationCount} populations ={' '}
              {plan.targets.length} population exports, {plan.totalEvents.toLocaleString()} events, about{' '}
              {formatBytes(plan.estimatedBytes)}.
            </p>
          </div>

          {!platform().canWriteFiles && (
            <Callout tone="warn" title="Running in a browser tab">
              Files will be handed to the download manager one at a time rather than written into a folder tree. Use
              the desktop app for a full export.
            </Callout>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ========================================================================== */

function ShapeCard({
  selected, disabled, onSelect, icon, title, blurb, hint,
}: {
  selected: boolean;
  /**
   * Offered, and not available from here.
   *
   * Rendered rather than hidden, because the reason a shape is unavailable is a
   * property of the *format* chosen two sections above — and a card that
   * disappears leaves nothing on screen to connect the two. It says why in its
   * own blurb.
   */
  disabled?: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  blurb: string;
  hint: string;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      aria-disabled={disabled}
      className={cn(
        'flex flex-col items-start gap-1.5 p-3 rounded-[var(--radius-md)] border text-left',
        'transition-colors duration-[var(--dur-fast)]',
        disabled
          ? 'border-[var(--border-subtle)] opacity-55 cursor-not-allowed'
          : selected
            ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/8'
            : 'border-[var(--border-default)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={selected && !disabled ? 'text-[var(--text-accent)]' : 'text-[var(--text-tertiary)]'}>{icon}</span>
        <span className="text-xs font-medium text-[var(--text-primary)]">{title}</span>
        <InfoHint content={hint} />
      </span>
      <span className="text-2xs text-[var(--text-tertiary)] leading-snug">{blurb}</span>
    </button>
  );
}

/**
 * Results summary.
 *
 * Not a toast: after writing dozens of files the user needs to see what landed
 * where and, crucially, what did not.
 */
function ExportResults({ run, onBack }: { run: Extract<RunState, { phase: 'done' }>; onBack: () => void }) {
  const written = run.entries.filter((e) => e.status === 'written');
  const skipped = run.entries.filter((e) => e.status !== 'written');
  // Under the workbook shape one file holds many populations, so "written" rows
  // and files written are different numbers and both are worth stating.
  const files = new Set(written.map((e) => (e.file ?? '').split(' › ')[0])).size;

  return (
    <Panel className="h-full">
      <PanelHeader title="Export complete" icon={<CheckCircle2 size={12} />} />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] p-5 space-y-4">
          <Callout
            tone={skipped.some((s) => s.status === 'failed') ? 'warn' : 'ok'}
            title={
              run.shape === 'workbook-per-sample'
                ? `${files} workbook(s) written, ${written.length} population tabs`
                : `${files} ${run.format === 'xlsx' ? 'Excel' : 'CSV'} file(s) written`
            }
          >
            <span className="font-mono break-all">{run.root}</span>
          </Callout>

          <div className="grid grid-cols-4 gap-2">
            {/* "Completed", not "Written". The tile is the one thing on this
                screen that says the run finished successfully, and *written* is
                a description of the mechanism — a reader checking whether an
                export worked wants the outcome. The `status` field keeps its own
                vocabulary; this is what it renders as. */}
            <StatTile label="Completed" value={written.length} tone="ok" />
            <StatTile label="Events" value={written.reduce((a, e) => a + e.eventCount, 0).toLocaleString()} />
            <StatTile label="Skipped" value={skipped.length} tone={skipped.length ? 'warn' : 'neutral'} />
            <StatTile label="Size" value={formatBytes(run.bytes)} />
          </div>

          {run.notes.length > 0 && (
            <Callout tone="warn" title="Worth knowing about these files">
              <ul className="list-disc pl-4 space-y-0.5">
                {run.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </Callout>
          )}

          <div className="flex items-center gap-2">
            {/* The first file written, not a manifest — that is what the button
                used to point at, and it no longer exists. A file rather than the
                directory because `revealInFolder` selects its argument, so
                landing on a real export is more use than landing on the folder
                with nothing highlighted. Falls back to the folder when a run
                produced nothing at all. The tab suffix is stripped: `›` names a
                worksheet inside the file, not a path on disk. */}
            <Button
              variant="secondary"
              icon={<FolderTree size={13} />}
              onClick={() => {
                const first = written[0]?.file?.split(' › ')[0];
                platform().revealInFolder(first ? platform().joinPath(run.root, first) : run.root);
              }}
            >
              Reveal in folder
            </Button>
            <Button variant="ghost" icon={<Layers size={13} />} onClick={onBack}>New export</Button>
          </div>

          <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
            <DataTable
              rows={run.entries}
              rowKey={(e, i) => `${e.sampleId}:${e.gateId}:${i}`}
              maxHeight={340}
              resizable
              columns={[
                { key: 'sample', header: 'Sample', width: '22%', sortValue: (e) => e.sampleName, cell: (e) => e.sampleName },
                { key: 'pop', header: 'Population', width: '26%', sortValue: (e) => e.populationPath, cell: (e) => <span title={e.populationPath}>{e.populationName}</span> },
                { key: 'events', header: 'Events', numeric: true, sortValue: (e) => e.eventCount, cell: (e) => e.eventCount.toLocaleString() },
                {
                  key: 'status', header: 'Status', width: '18%',
                  sortValue: (e) => e.status,
                  /* Sentence case, like every other word this application puts
                     on screen (2026-08-11, Item 4). The lowercase spelling was
                     the `status` field's own vocabulary rendered verbatim —
                     `written`, `skipped-empty` — and a badge is a label, not a
                     serialisation. `statusLabel` maps the one to the other in a
                     single place so the two cannot drift; the field keeps its
                     own spelling, which is what the results are keyed by. */
                  cell: (e) => (
                    <Badge tone={e.status === 'written' ? 'ok' : e.status === 'failed' ? 'err' : 'warn'}>
                      {statusLabel(e.status)}
                    </Badge>
                  ),
                },
                {
                  key: 'file', header: run.shape === 'workbook-per-sample' ? 'File › tab' : 'File', width: '28%',
                  cell: (e) => <span className="text-[var(--text-tertiary)]" title={e.reason}>{e.file ?? e.reason ?? ''}</span>,
                },
              ]}
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}
