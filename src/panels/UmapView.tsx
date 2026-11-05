import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Circle, Dices, FileUp,
  Network, RotateCcw, Tags, Trash2, X,
} from 'lucide-react';
import { UMAP_PRESETS, parameterPresetsFor, presetById } from '@/core/umap/presets';
import { UMAP_SCALINGS, UMAP_COFACTOR } from '@/core/umap/matrix';
import { blockBetween } from '@/core/rangeSelect';
import { LEGEND_DOT, LEGEND_SIZE, layoutLegend } from '@/core/umap/legend';
import { composeUmapFigure, drawOrder, equalAspect, UMAP_POINT_ALPHA } from '@/core/figure/umapFigure';
import { FigureExport, type FigureSource } from './FigureExport';
import { orderedGroups } from '@/core/umap/groups';
import { randomSeed } from '@/core/umap/random';
import { UMAP_STEPS, useUmap, type UmapStep } from '@/state/umapStore';
import { Button, IconButton, Spinner } from '@/ui/Button';
import { Field } from '@/ui/Field';
import { Badge, Callout, EmptyState } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { useListKeys } from '@/ui/useListKeys';
import { cn } from '@/ui/cn';
import { categoryColors, conditionColor } from './groupColors';
import { GroupingTable } from './GroupingTable';
import { PipelineDone } from './PipelineDone';

/**
 * UMAP — a two-dimensional map of the events in an exported table.
 *
 * ## What it is for
 *
 * Everything else in this application answers a question about one or two
 * parameters at a time. A panel of thirty markers has more structure in it than
 * thirty biaxial plots can show, and the usual reason to reach for a projection
 * is to ask whether two groups of samples differ **at all** before deciding
 * which markers to go and look at. That is the question this panel answers, and
 * it is why the output is one plot coloured by group rather than a suite of
 * analyses.
 *
 * ## Deliberately few choices
 *
 * UMAP exposes a dozen parameters. Two of them mean anything to somebody who has
 * not read the paper — how much local structure to keep, and how long to spend —
 * and they move together, so they are one axis with three stops. Everything else
 * is fixed. A projection with the wrong `spread` and the right `minDist` is not
 * a result anybody can act on; a projection somebody understands is.
 *
 * The parameter presets are **rules over column names**, never lists of markers.
 * Nothing here knows which column is CD4, and it does not read a filename to
 * find out — the same rule that governs reference controls and grouping.
 *
 * ## Why it will not hang the application
 *
 * The fit runs in a worker (`core/umap/worker.ts`) and every preset caps the
 * total number of points. Both are load-bearing: 300 000 events on the main
 * thread is a window that stops responding to the button that would cancel it.
 * The subsample is a stride rather than a head, because an export is in
 * acquisition order.
 */
export function UmapView() {
  const step = useUmap((s) => s.step);
  const setStep = useUmap((s) => s.setStep);
  const next = useUmap((s) => s.next);
  const back = useUmap((s) => s.back);
  const datasets = useUmap((s) => s.datasets);
  const clearAll = useUmap((s) => s.clearAll);
  const check = useUmap((s) => s.stepCheck)();

  const header = (
    <PanelHeader
      title="UMAP"
      icon={<Network size={12} />}
      count={datasets.length > 0 ? `${datasets.length} files` : undefined}
      actions={datasets.length > 0 ? (
        <Tooltip content="Unload every file and start again.">
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} data-umap-reset="" onClick={clearAll}>
            Start over
          </Button>
        </Tooltip>
      ) : undefined}
    />
  );

  return (
    <Panel className="h-full">
      {header}

      <div className="flex items-stretch gap-px px-2.5 py-2 hairline-b shrink-0" data-umap-tracker="">
        {UMAP_STEPS.map(({ step: n, label }) => {
          const state = n === step ? 'current' : n < step ? 'done' : 'todo';
          const reachable = n <= step || (n === step + 1 && check.ok);
          return (
            <button
              key={n}
              type="button"
              disabled={!reachable}
              data-umap-step-n={n}
              data-umap-step-state={state}
              onClick={() => reachable && setStep(n as UmapStep)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-2xs font-medium',
                'first:rounded-l-[var(--radius-sm)] last:rounded-r-[var(--radius-sm)]',
                'transition-colors duration-[var(--dur-fast)]',
                state === 'current' && 'bg-[var(--surface-selected)] text-[var(--text-primary)]',
                state === 'done' && 'bg-[var(--surface-active)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
                state === 'todo' && 'bg-[var(--surface-raised)] text-[var(--text-disabled)]',
                !reachable && 'cursor-not-allowed',
              )}
            >
              <span className={cn(
                'grid place-items-center w-4 h-4 rounded-full text-[9px] tnum shrink-0',
                state === 'current' ? 'bg-[var(--accent-500)] text-[var(--n-dark-950)]'
                  : `bg-[var(--surface-overlay)] ${state === 'done' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-disabled)]'}`,
              )}
              >
                {state === 'done' ? <Check size={9} /> : n}
              </span>
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="relative flex-1 overflow-auto min-h-0" data-umap-step={step}>
        {step === 1 && <StepLoad />}
        {step === 2 && <StepGroups />}
        {step === 3 && <StepParameters />}
        {step === 4 && <StepProjection />}
      </div>

      <div className="flex items-center gap-2 p-2.5 hairline-t shrink-0 bg-[var(--surface-sunken)]">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={12} />} disabled={step === 1} data-umap-back="" onClick={back}>
          Back
        </Button>
        <p className={cn('flex-1 min-w-0 text-2xs leading-snug', check.ok ? 'text-[var(--text-tertiary)]' : 'text-[var(--status-warn)]')}>
          {check.ok ? '' : check.reason}
        </p>
        {step < 4 && (
          <Tooltip content={check.ok ? '' : check.reason}>
            <span>
              <Button
                size="sm"
                variant="primary"
                trailing={<ArrowRight size={12} />}
                disabled={!check.ok}
                data-umap-next=""
                onClick={next}
              >
                Next
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </Panel>
  );
}

/* ========================================================================== */

/**
 * Step 1 — load the exported tables.
 *
 * A file input and a drop target, both reading through the browser's own File
 * API rather than through a new IPC route. The panel's input is text a user
 * chose, which the platform layer already has no opinion about, and adding a
 * fifth pair of IPC handlers to read a file the browser can hand over directly
 * would be five touchpoints to keep level for no capability.
 */
function StepLoad() {
  const datasets = useUmap((s) => s.datasets);
  const addFiles = useUmap((s) => s.addFiles);
  const removeDataset = useUmap((s) => s.removeDataset);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const take = async (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list).filter((f) => /\.(csv|tsv|txt)$/i.test(f.name));
    if (files.length === 0) { setMessage('Those are not CSV files.'); return; }
    setBusy(true);
    try {
      const read = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
      setMessage(addFiles(read).message ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-2.5 space-y-2.5" data-umap-step-load="">
      <div
        data-umap-dropzone=""
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files); }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 p-6 rounded-[var(--radius-md)]',
          'border border-dashed transition-colors duration-[var(--dur-fast)]',
          over
            ? 'border-[var(--accent-500)] bg-[var(--surface-selected)]'
            : 'border-[var(--border-default)] bg-[var(--surface-raised)]',
        )}
      >
        {busy ? <Spinner size={16} className="text-[var(--text-accent)]" /> : <FileUp size={18} className="text-[var(--text-tertiary)]" />}
        <p className="text-xs text-[var(--text-primary)]">Drop exported CSV files here</p>
        <p className="text-2xs text-[var(--text-tertiary)] text-center max-w-sm leading-snug">
          Same CSV format exported with MCFlow: one per sample and population, a header row of parameter names,
          then one row per event. Every file must have the same columns.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv,.tsv,.txt"
          data-umap-file-input=""
          className="hidden"
          onChange={(e) => { void take(e.target.files); e.target.value = ''; }}
        />
        <Button size="sm" variant="secondary" data-umap-choose="" onClick={() => inputRef.current?.click()}>
          Choose files…
        </Button>
      </div>

      {message && <Callout tone="warn">{message}</Callout>}

      {datasets.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
          <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
            <span className="flex-1 min-w-0">Loaded</span>
            <span className="tnum">
              {datasets.reduce((a, d) => a + d.table.count, 0).toLocaleString()} events ·{' '}
              {datasets[0]!.table.headers.length} columns
            </span>
          </p>
          {datasets.map((d, i) => (
            <div
              key={d.id}
              data-umap-file={d.name}
              className={cn('flex items-center gap-2 px-2.5 h-7', i > 0 && 'hairline-t')}
            >
              <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{d.name}</span>
              <span className="text-2xs font-mono tnum text-[var(--text-disabled)] shrink-0">
                {d.table.count.toLocaleString()}
              </span>
              <IconButton size="sm" label={`Remove ${d.name}`} onClick={() => removeDataset(d.id)}>
                <Trash2 size={11} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 2 — say which files belong together.
 *
 * **The same table Statistics uses**, `GroupingTable`, over datasets instead of
 * samples. What was here before was one text field per row and a *Use file
 * names* button, which is the interface Statistics replaced on 2026-08-04 for
 * reasons that apply verbatim here: with twenty files, assigning a condition
 * meant typing it twenty times, and one typo produced a twenty-first category of
 * one. Ticking rows and typing the name once is the same gesture in both panels
 * now, and there is one implementation of it.
 *
 * *Use file names* went with it, and is not a loss: an ungrouped file is already
 * its own category, so pressing it wrote out by hand exactly what the default
 * already meant.
 *
 * Nothing is grouped automatically and no structure is read out of a filename:
 * this application has twice shipped a bug that came from inferring the design
 * of an experiment from what the files were called, and a projection coloured by
 * a guess is a figure that is wrong in a way nobody checks.
 */
function StepGroups() {
  const datasets = useUmap((s) => s.datasets);
  const groupOrder = useUmap((s) => s.groupOrder);
  const setGroup = useUmap((s) => s.setGroup);
  const toggleIncluded = useUmap((s) => s.toggleIncluded);
  const moveGroup = useUmap((s) => s.moveGroup);
  const resetGroupOrder = useUmap((s) => s.resetGroupOrder);

  const rows = useMemo(
    () => datasets.map((d) => ({ id: d.id, name: d.name, group: d.group, included: d.included })),
    [datasets],
  );
  const known = useMemo(
    () => Array.from(new Set(datasets.map((d) => d.group.trim()).filter(Boolean))).sort(),
    [datasets],
  );

  return (
    <div className="p-2.5 space-y-2.5" data-umap-step-groups="">
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <Tags size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            Give each file a group. The projection is coloured by group, so this is what the plot compares.
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            Files with the same group name are one colour. Tick several rows to name them all at once —
            Shift-click a second row to take everything between.
          </p>
        </div>
      </div>

      <GroupingTable
        rows={rows}
        noun="file"
        maxWidth={9999}
        groupNames={known}
        onAssign={(ids, name) => ids.forEach((id) => setGroup(id, name))}
        onClearAll={() => datasets.forEach((d) => setGroup(d.id, ''))}
        onToggleIncluded={toggleIncluded}
        note="A file with no group is its own colour."
      />

      <GroupOrder
        order={orderedGroups(datasets, groupOrder)}
        onMove={moveGroup}
        onReset={groupOrder.length > 0 ? resetGroupOrder : undefined}
      />
    </div>
  );
}

/**
 * Which group is drawn in which colour — and the control that changes it.
 *
 * The colour comes from the **position**, here and in the Compare chart, so this
 * short list is both the key and the way to set it: put *Control* first in both
 * panels and the two figures agree. Before this existed the projection's colours
 * fell out of the order the files were loaded in, which is not a thing anybody
 * can see or correct.
 *
 * Arrows rather than a drag, and always visible rather than revealed on hover:
 * the chart's own reordering hides its pair behind a hover because it sits on a
 * table of numbers whose job is the numbers, and this list has no other job. It
 * is the same `moveCategory` underneath, so one press means one place in both.
 *
 * Hidden below two groups. One group is one colour and there is no order to set.
 */
function GroupOrder({
  order, onMove, onReset,
}: {
  order: string[];
  onMove(label: string, delta: -1 | 1): void;
  /** Absent when nothing has been arranged — there is nothing to put back. */
  onReset?: () => void;
}) {
  const colorOf = useMemo(() => categoryColors(order), [order]);
  if (order.length < 2) return null;

  return (
    <div className="space-y-1" data-umap-group-order="">
      <p className="text-2xs font-medium text-[var(--text-secondary)]">Colour order</p>
      <ul className="space-y-0.5">
        {order.map((label, i) => (
          <li
            key={label}
            data-group-row={label}
            className="flex items-center gap-2 h-6 px-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--surface-raised)]"
          >
            <span
              aria-hidden
              data-group-swatch={label}
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: colorOf.get(label) }}
            />
            <span className="text-2xs text-[var(--text-primary)] truncate">{label}</span>
            <span className="ml-auto flex items-center gap-0.5 shrink-0">
              <IconButton
                label={`Move ${label} earlier`}
                size="sm"
                data-group-up={label}
                disabled={i === 0}
                onClick={() => onMove(label, -1)}
              >
                <ChevronUp size={11} />
              </IconButton>
              <IconButton
                label={`Move ${label} later`}
                size="sm"
                data-group-down={label}
                disabled={i === order.length - 1}
                onClick={() => onMove(label, 1)}
              >
                <ChevronDown size={11} />
              </IconButton>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
        The first group takes the first colour. The Compare chart colours its columns the same way, so
        arranging both the same way makes the two figures agree.
        {onReset && (
          <Button size="sm" variant="ghost" className="ml-1 align-baseline" onClick={onReset}>
            Reset order
          </Button>
        )}
      </p>
    </div>
  );
}

/* ========================================================================== */

/** Step 3 — which columns the distance between two cells is measured over. */
function StepParameters() {
  const headers = useUmap((s) => s.headers)();
  const selected = useUmap((s) => s.selected);
  const applyPreset = useUmap((s) => s.applyParameterPreset);
  const toggleColumn = useUmap((s) => s.toggleColumn);
  const setColumns = useUmap((s) => s.setColumns);
  const scaling = useUmap((s) => s.scaling);
  const setScaling = useUmap((s) => s.setScaling);
  const cofactor = useUmap((s) => s.cofactor);
  const setCofactor = useUmap((s) => s.setCofactor);
  const [query, setQuery] = useState('');
  /*
     Where the last plain click landed, for Shift-click.

     A ref rather than state: it changes on every click and nothing on screen
     reads it, so re-rendering the list of seventy-one rows to record it would
     be seventy-one rows redrawn to store a number. Held as a *column* index,
     which survives the filter changing underneath it.
  */
  const anchor = useRef<number | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = headers.map((h, i) => ({ h, i }));
    return q ? all.filter(({ h }) => h.toLowerCase().includes(q)) : all;
  }, [headers, query]);

  // Computed off the live headers, so *Parameters only* is absent rather than
  // inert on an export that has no computed columns in it.
  const presets = useMemo(() => parameterPresetsFor(headers), [headers]);

  /**
   * Click a row, or Shift-click to take everything between.
   *
   * Ticking sixteen violet detectors was sixteen clicks, and the presets above
   * only answer the questions somebody thought of in advance — *the UV and
   * violet blocks* is not one of them and could not be.
   *
   * **Shift is tested first**, as it is in the sample browser, so Ctrl+Shift
   * extends rather than falling into the toggle branch; Ctrl alone is the
   * toggle, which is what a plain click already does on a list of checkboxes.
   * The anchor **does not move** — the row a plain click landed on stays the
   * origin however many Shift-clicks follow — and the rest of the rule, which
   * rows the block covers and which state it takes, is `blockBetween`: the
   * Unmixing wizard's control list asks it the same question.
   */
  const clickRow = (e: { shiftKey: boolean }, index: number) => {
    const block = e.shiftKey ? blockBetween(shown.map((c) => c.i), anchor.current, index) : null;
    if (block) {
      setColumns(block, selected.includes(anchor.current!));
      return;
    }
    anchor.current = index;
    toggleColumn(index);
  };

  /*
     The keyboard, on that same handler, so Shift+ArrowDown and a Shift-click
     reach the identical line. Row ids are strings because the hook is generic
     over lists whose rows are named by path, by sample id or, here, by column
     index; the parse is the only place the two representations meet.
  */
  const keys = useListKeys({
    ordered: shown.map((c) => String(c.i)),
    onActivate: (mods, id) => clickRow(mods, Number(id)),
  });

  return (
    <div className="p-2.5 space-y-2.5" data-umap-step-parameters="">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Tooltip key={p.id} content={p.hint}>
            <Button
              size="sm"
              variant="ghost"
              data-umap-param-preset={p.id}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </Button>
          </Tooltip>
        ))}
        <span className="flex-1" />
        <Badge tone={selected.length >= 2 ? 'accent' : 'warn'}>
          <span data-umap-selected-count="">{selected.length}</span> of {headers.length}
        </Badge>
      </div>

      {/*
          The scale the distance is measured on, next to the columns it applies
          to — because it is a question about those columns and not about how
          long the optimisation should run, which is what Step 4 asks.

          It exists because a Gate Export holds raw channel values: this panel
          centred and scaled them and nothing else, so a fluorescence column's
          five decades and its long upper tail went into a Euclidean distance
          intact and the map came back looking like noise. See `UMAP_SCALINGS`.
      */}
      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            Value scaling
            <InfoHint content="A Gate Export holds raw channel values, and UMAP measures straight-line distance. Without compressing the decades first, the distance between two events is nearly the distance between their two brightest channels and the projection carries no structure. Arcsinh is the standard answer and the same curve this application's axes draw." />
          </span>
        }
        hint={UMAP_SCALINGS.find((x) => x.id === scaling)?.hint}
      >
        <SegmentedControl
          fullWidth
          size="sm"
          name="umap-scaling"
          value={scaling}
          onChange={setScaling}
          segments={UMAP_SCALINGS.map((x) => ({ value: x.id, label: x.label, title: x.hint }))}
        />
      </Field>

      {scaling === 'asinh' && (
        <div className="flex items-center gap-2">
          <label className="text-2xs text-[var(--text-secondary)] shrink-0" htmlFor="umap-cofactor">
            Cofactor
          </label>
          <input
            id="umap-cofactor"
            type="number"
            min={1}
            step={100}
            value={cofactor}
            data-umap-cofactor=""
            onChange={(e) => setCofactor(e.currentTarget.valueAsNumber)}
            className={cn(
              'w-24 h-6 px-1.5 rounded-[var(--radius-sm)] tnum text-2xs text-right',
              'bg-[var(--surface-base)] border border-[var(--border-subtle)] text-[var(--text-primary)]',
              'focus:outline-none focus:border-[var(--accent-500)]',
            )}
          />
          <IconButton
            label="Back to the default cofactor"
            size="sm"
            data-umap-cofactor-reset=""
            disabled={cofactor === UMAP_COFACTOR}
            onClick={() => setCofactor(UMAP_COFACTOR)}
          >
            <RotateCcw size={12} />
          </IconButton>
          <span className="text-2xs text-[var(--text-tertiary)] leading-snug min-w-0 flex-1">
            Values well below it stay linear; well above it, logarithmic. Lower it to spread the dim
            end of a channel out.
          </span>
        </div>
      )}

      <Field
        label="Parameters"
        hint="Click a row to take it. Shift-click a second one for everything between, or use the arrow keys and Space."
      >
        <input
          value={query}
          data-umap-param-search=""
          placeholder="Filter columns…"
          onChange={(e) => setQuery(e.target.value)}
          className="w-full h-7 px-2 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] text-2xs text-[var(--text-primary)]"
        />
      </Field>

      <div
        {...keys.containerProps}
        aria-label="Parameters"
        className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden max-h-80 overflow-y-auto focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-500)]"
      >
        {shown.map(({ h, i }, row) => {
          const on = selected.includes(i);
          return (
            <button
              key={i}
              id={keys.rowId(String(i))}
              type="button"
              role="option"
              aria-selected={on}
              /* Out of the tab order: the container holds focus for the whole
                 list, so Tab steps past it rather than through seventy-one
                 rows. */
              tabIndex={-1}
              data-umap-param={h}
              data-umap-param-on={on ? '' : undefined}
              data-list-cursor={keys.cursor === String(i) ? '' : undefined}
              onClick={(e) => keys.onRowClick(e, String(i))}
              className={cn(
                'flex items-center gap-2 w-full px-2.5 h-7 text-left',
                row > 0 && 'hairline-t',
                on ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                keys.cursor === String(i) && 'ring-1 ring-inset ring-[var(--accent-500)]',
              )}
            >
              <span className={cn('shrink-0', on ? 'text-[var(--text-accent)]' : 'text-[var(--text-disabled)]')}>
                {on ? <Check size={11} /> : <Circle size={9} />}
              </span>
              <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{h}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */

/** Step 4 — run it, look at it, save it. */
function StepProjection() {
  const datasets = useUmap((s) => s.datasets);
  const groupOrder = useUmap((s) => s.groupOrder);
  const preset = useUmap((s) => s.preset);
  const setPreset = useUmap((s) => s.setPreset);
  const seed = useUmap((s) => s.seed);
  const setSeed = useUmap((s) => s.setSeed);
  const run = useUmap((s) => s.run);
  const cancel = useUmap((s) => s.cancel);
  const running = useUmap((s) => s.running);
  const progress = useUmap((s) => s.progress);
  const error = useUmap((s) => s.error);
  const result = useUmap((s) => s.result);
  const svgRef = useRef<SVGSVGElement>(null);

  /**
   * Group label per dataset index, and the colour each label draws in.
   *
   * An ungrouped file falls back to **its own name**, not to a shared
   * *Ungrouped* bucket. Pooling them was a claim that those files are one
   * condition, made by the application rather than by the user, and it is the
   * same claim the Compare chart refuses to make when it gives an ungrouped
   * sample its own bar.
   */
  const groups = useMemo(() => {
    const labels = datasets.map((d) => d.group.trim() || d.name);
    /*
       Coloured by position, in the order the grouping step arranges.

       The same rule and the same twelve colours the Compare chart uses, so the
       chart and the map of one experiment can be put on one page and agree —
       see `panels/groupColors.ts`. Before 2026-08-19 this was a private
       eight-colour palette indexed by whichever order the files happened to be
       loaded in, which is neither visible nor correctable from here.

       Over **every** loaded file rather than only the included ones, so holding
       a file out of a projection does not renumber the colours of the groups
       that stayed. The key below is the other half of that: it names only what
       is drawn.
    */
    const order = orderedGroups(datasets, groupOrder);
    const colorOf = categoryColors(order);
    return {
      labelOf: labels,
      order,
      colorFor: colorOf,
      colorOf: labels.map((l) => colorOf.get(l) ?? conditionColor(0)),
    };
  }, [datasets, groupOrder]);

  const active = datasets.filter((d) => d.included);
  const settings = presetById(preset);
  const budget = Math.min(
    settings.maxPoints,
    active.reduce((a, d) => a + d.table.count, 0),
  );

  const SIZE = 460;
  /*
     The key is part of the drawing, and this is how much taller it makes it.

     Not a strip the exporter adds — the entries are elements of the map's own
     SVG, drawn once for the screen and the file both. `layoutLegend` carries
     the argument; the short version is that the exporter serialises this
     element and nothing else, so anything left outside it is a figure's worth
     of colours with no names against them.
  */
  const legend = useMemo(() => {
    // Only the groups that are drawn. A file held out of the projection keeps
    // its group's colour — the order is over every loaded file, so the ones that
    // stayed do not shift — but naming it in the key of a figure it contributed
    // nothing to would be a legend entry pointing at no marks.
    const drawn = new Set(datasets.filter((d) => d.included).map((d) => d.group.trim() || d.name));
    return layoutLegend(
      groups.order
        .filter((label) => drawn.has(label))
        .map((label) => ({ label, color: groups.colorFor.get(label) ?? conditionColor(0) })),
      SIZE,
    );
  }, [datasets, groups]);
  const HEIGHT = SIZE + legend.height;

  /**
   * The exported figure. The same points, colours and seed as the map above,
   * composed by `composeUmapFigure` at the printed size the style asks for;
   * what used to be the caption — columns, count, scaling, seed — is in the notes.
   */
  const umapSource: FigureSource | null = result ? {
    type: 'umap',
    kind: 'umap',
    fileStem: `umap-${result.preset}`,
    hasLayer: true,
    shape: 'square',
    options: ['legend', 'annotate'],
    optionLabels: { annotate: { label: 'UMAP1 and UMAP2 arrows', hint: 'Names the two axes in the corner — a projection has no scale to tick.' } },
    compose: (style, layerScale) => {
      const perGroup = new Map<string, number>();
      for (const pt of result.points) {
        const g = groups.labelOf[pt.dataset] ?? '';
        perGroup.set(g, (perGroup.get(g) ?? 0) + 1);
      }
      const scaleNote = result.scaling === 'asinh'
        ? `arcsinh, cofactor ${result.cofactor.toLocaleString()}`
        : result.scaling === 'unit' ? 'per-event shape' : 'no value scaling';
      return composeUmapFigure({
        extent: result.extent,
        legend: legend.items.map((it) => ({ label: it.label, color: it.color })),
        raster: (w, h, frame, pointPx) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const g = c.getContext('2d');
          if (!g) return null;
          g.globalAlpha = UMAP_POINT_ALPHA;
          const sx = w / (frame.xMax - frame.xMin);
          const sy = h / (frame.yMax - frame.yMin);
          for (const i of drawOrder(result.points.length, result.seed)) {
            const pt = result.points[i]!;
            g.fillStyle = groups.colorOf[pt.dataset] ?? conditionColor(0);
            g.beginPath();
            g.arc((pt.x - frame.xMin) * sx, h - (pt.y - frame.yMin) * sy, pointPx / 2, 0, 2 * Math.PI);
            g.fill();
          }
          return c.toDataURL('image/png');
        },
        title: 'UMAP',
        notes: [
          `Parameters (${result.columns.length}): ${result.columns.join(', ')}.`,
          `Events: ${result.points.length.toLocaleString()} — ${[...perGroup].map(([g, n]) => `${g} ${n.toLocaleString()}`).join(', ')}.`,
          'Subsampling: a stride through each file, shared in proportion to its events with a floor per file, up to the preset’s cap.',
          `Scaling: ${scaleNote}. Seed ${result.seed}; points drawn in a seeded random order, ${UMAP_POINT_ALPHA} opacity.`,
        ],
      }, style, layerScale);
    },
  } : null;
  const view = equalAspect(result?.extent ?? { xMin: -1, xMax: 1, yMin: -1, yMax: 1 }, SIZE, SIZE);
  /** Seeded, so the same run draws the same picture; never the load order. */
  const order = useMemo(() => (result ? drawOrder(result.points.length, result.seed) : new Uint32Array(0)), [result]);
  const toX = (v: number) => ((v - view.xMin) / (view.xMax - view.xMin)) * SIZE;
  const toY = (v: number) => SIZE - ((v - view.yMin) / (view.yMax - view.yMin)) * SIZE;


  return (
    <div className="p-2.5 space-y-2.5" data-umap-step-projection="">
      {/* Terminal state, once there is a projection to be terminal about. This
          is the shape all four guided panels end in — see `PipelineDone`. */}
      {result && !running && (
        <PipelineDone
          testId="data-umap-done"
          title="Projection complete"
          next={[{ view: 'statistics', label: 'Statistics', hint: 'A projection is a picture — the numbers behind it are gated populations' }]}
        >
          {result.points.length.toLocaleString()} events projected from {active.length} file
          {active.length === 1 ? '' : 's'}. Save it as an image below. Nothing here is part of the
          workspace, so it is not saved with your analysis and is gone when the workspace clears.
        </PipelineDone>
      )}

      <div className="grid grid-cols-3 gap-2">
        {UMAP_PRESETS.map((p) => {
          const on = p.id === preset;
          return (
            <button
              key={p.id}
              type="button"
              data-umap-preset={p.id}
              data-umap-preset-on={on ? '' : undefined}
              disabled={running}
              onClick={() => setPreset(p.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 p-2 text-left rounded-[var(--radius-md)] border',
                on ? 'border-[var(--accent-500)] bg-[var(--surface-selected)]'
                  : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <span className={cn('text-2xs font-medium', on ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]')}>
                {p.label}
              </span>
              <span className="text-2xs text-[var(--text-tertiary)] leading-snug">{p.hint}</span>
              <span className="text-2xs font-mono tnum text-[var(--text-disabled)]">
                up to {p.maxPoints.toLocaleString()} events
              </span>
            </button>
          );
        })}
      </div>

      {/*
          The random state.

          UMAP is stochastic in three places at once, so the same file, columns
          and preset gave a different map every press — different enough that a
          cluster landed somewhere else and no projection could be put in a
          figure or compared with the one from ten minutes ago. Fixed by default;
          the field and the re-roll are what let somebody check that a structure
          is not an artefact of one initialisation. See `seededRandom`.
      */}
      <div className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)]">
        <label
          className="text-2xs text-[var(--text-secondary)] shrink-0"
          htmlFor="umap-seed"
        >
          Random state
        </label>
        <input
          id="umap-seed"
          type="number"
          min={1}
          max={999999}
          step={1}
          value={seed}
          disabled={running}
          data-umap-seed=""
          onChange={(e) => setSeed(e.currentTarget.valueAsNumber)}
          className={cn(
            'w-20 h-6 px-1.5 rounded-[var(--radius-sm)] tnum text-2xs text-right',
            'bg-[var(--surface-base)] border border-[var(--border-subtle)] text-[var(--text-primary)]',
            'focus:outline-none focus:border-[var(--accent-500)] disabled:opacity-50',
          )}
        />
        <Tooltip content="A different starting point. The structure should survive it; where it lands will not.">
          <span>
            <IconButton
              label="New random state"
              size="sm"
              data-umap-reseed=""
              disabled={running}
              onClick={() => setSeed(randomSeed())}
            >
              <Dices size={12} />
            </IconButton>
          </span>
        </Tooltip>
        <span className="text-2xs text-[var(--text-tertiary)] leading-snug min-w-0 flex-1">
          Held fixed, so the same settings give the same projection every time.
        </span>
      </div>

      <div className="flex items-center gap-2">
        {running ? (
          <Button size="sm" variant="secondary" icon={<X size={12} />} data-umap-cancel="" onClick={cancel}>
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={<Network size={12} />} data-umap-run="" onClick={run}>
            {result ? 'Run again' : 'Run projection'}
          </Button>
        )}
        <span className="text-2xs text-[var(--text-tertiary)] tnum">
          {running && progress
            ? `Optimising — epoch ${progress.epoch} of ${progress.total}`
            : `${budget.toLocaleString()} of ${active.reduce((a, d) => a + d.table.count, 0).toLocaleString()} events, ${active.length} files`}
        </span>
        <span className="flex-1" />
        {result && (
          <>
            <FigureExport source={() => umapSource} label="Export map image" />
          </>
        )}
      </div>

      {error && <Callout tone="warn" data-umap-error="">{error}</Callout>}

      {!result && !running && (
        <EmptyState
          className="mt-6"
          icon={<Network size={19} />}
          title="No projection yet"
          description="Pick how long to spend and press Run. Quick look is enough to see whether the groups separate at all."
        />
      )}

      {result && (
        <div className="space-y-2">
          {/*
              No border, no padding ring — the plate is the figure, which is the
              rule the Compare chart already states over its own container.

              The map's surface is the element's own background, not a rect
              inside the drawing, and it is `--surface-plot`: the surface every
              other plot in this application is drawn on, so a figure of it
              lands on white paper rather than on a shade of the application.

              Both halves of that matter. A rect would survive the *Transparent
              background* switch and hand back exactly the grey rectangle the
              switch exists to remove; `background` is not one of the properties
              `inlineComputedStyles` copies, so the clone carries none of it and
              `svgToString` is left as the single thing deciding whether an
              exported figure has a background at all.
          */}
          <div className="flex justify-center">
            <svg
              ref={svgRef}
              width={SIZE}
              height={HEIGHT}
              viewBox={`0 0 ${SIZE} ${HEIGHT}`}
              data-umap-plot=""
              className="max-w-full h-auto block rounded-[var(--radius-md)]"
              style={{ background: 'var(--surface-plot)' }}
            >
              <g data-umap-points="">
                {Array.from(order, (i) => {
                  const p = result.points[i]!;
                  return (
                    <circle
                      key={i}
                      cx={toX(p.x)}
                      cy={toY(p.y)}
                      r={1.4}
                      fill={groups.colorOf[p.dataset] ?? conditionColor(0)}
                      opacity={UMAP_POINT_ALPHA}
                    />
                  );
                })}
              </g>

              {/*
                  The colour key, inside the map rather than under it.

                  It was an HTML row below this element until an exported figure
                  came back as coloured clouds with nothing naming the colours —
                  the exporter serialises this SVG and nothing else, which is
                  what keeps PNG and PDF identical and is why the key has to be
                  in here to be in them.

                  Set in the plot's own label colour and the UI face, like every
                  other piece of type on a plot surface in this application. A
                  measurement would be `--font-numeric`; a group's name is not
                  one.
              */}
              <g
                data-umap-legend=""
                fontFamily="var(--font-ui)"
                fontSize={LEGEND_SIZE}
                fill="var(--plot-label)"
              >
                {legend.items.map((item) => (
                  <g key={item.label}>
                    <circle cx={item.dotX} cy={SIZE + item.y} r={LEGEND_DOT} fill={item.color} />
                    <text x={item.textX} y={SIZE + item.y} dominantBaseline="middle">{item.label}</text>
                  </g>
                ))}
              </g>
            </svg>
          </div>

          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            {result.points.length.toLocaleString()} events over {result.columns.length} parameters,{' '}
            {(result.elapsed / 1000).toFixed(1)} s. The axes have no units — UMAP preserves which cells are near
            each other, not how far apart they are, so distance between clusters means nothing and cluster
            shape means very little.
          </p>
        </div>
      )}
    </div>
  );
}
