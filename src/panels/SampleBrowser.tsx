import { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronUp, FileText, FolderOpen, FolderPlus, LineChart,
  ListX, Search, Trash2, Upload, X,
} from 'lucide-react';
import { platform } from '@/platform';
import type { Mods } from '@/core/listKeys';
import { actionableSampleIds, canMoveSamples, useWorkspace, type Sample } from '@/state/workspaceStore';
import { openPanelsForSamples } from '@/state/layoutActions';
import { FileInfoDialog } from './FileInfoDialog';
import { setDragGhost, setDragPayload, useDragState, isInternalDrag } from './dragPayload';
import { Button, IconButton } from '@/ui/Button';
import { ContextMenu } from '@/ui/ContextMenu';
import { TextInput } from '@/ui/Field';
import { Badge, Callout, EmptyState, ProgressBar } from '@/ui/Feedback';
import { Panel, PanelHeader, VDivider } from '@/ui/Panel';
import { Tooltip } from '@/ui/Tooltip';
import { useListKeys } from '@/ui/useListKeys';
import { cn } from '@/ui/cn';

export function SampleBrowser() {
  const {
    samples, selectedSampleId, multiSelection, progress, failures,
    selectSample, toggleSampleInSelection, extendSelectionTo, pressSample,
    removeSamples, removeAll, importFiles, dismissFailures,
    moveSamples, moveSamplesBy,
  } = useWorkspace();

  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; sampleId: string } | null>(null);
  const [fileInfoFor, setFileInfoFor] = useState<string | null>(null);
  const dragDepth = useRef(0);
  /**
   * Reordering, held here rather than on the row.
   *
   * The same two pieces of state the gate tree uses for its reparent drag —
   * which row is in flight, which row is under the pointer — and deliberately
   * the same mechanism: native HTML5 drag-and-drop, so the one gesture that
   * already exists on this row (drag it onto the worksheet to plot it) and the
   * new one cannot fight over the pointer. Where a row is released decides which
   * it was: on another row, a reorder; anywhere else, whatever that target does.
   */
  const [reorderDrop, setReorderDrop] = useState<string | null>(null);
  /**
   * Which samples the in-flight reorder is carrying, captured at drag start.
   *
   * A list rather than the one id it used to be, and resolved **once** when the
   * gesture begins rather than on release. The selection cannot change mid-drag,
   * but the row under the pointer can and does, and a batch re-derived from
   * whatever is under the cursor at drop time would move the target rather than
   * the thing that was picked up.
   *
   * It is also what every row's drop guard reads: releasing a five-row selection
   * onto one of its own members must be a no-op, and "is this row the one being
   * dragged" only answered that for one of the five.
   */
  const [reorderBatch, setReorderBatch] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? samples.filter((s) => s.name.toLowerCase().includes(q)) : samples;
  }, [samples, query]);

  /**
   * Rows in the order they are rendered, which is what a Shift-range means.
   *
   * Load order, flat — the same order `index` numbers. It used to be walked
   * group by group, which meant a Shift-range could quietly select rows that
   * were nowhere near each other in the list.
   */
  const visibleOrder = useMemo(() => filtered.map((s) => s.id), [filtered]);

  /**
   * A click on a row, whichever modifier is held — and the one handler the
   * keyboard calls too.
   *
   * Shift is tested first, and the order is the fix. It used to read Ctrl, then
   * Shift, so Ctrl+Shift-click took the toggle branch and added one row where
   * every list in every file manager extends a range. Shift is the range
   * modifier whether or not Ctrl is also down; Ctrl alone is the toggle.
   */
  const clickRow = (e: Mods, id: string) => {
    if (e.shiftKey) extendSelectionTo(id, visibleOrder);
    else if (e.ctrlKey || e.metaKey) toggleSampleInSelection(id);
    else selectSample(id);
  };

  /*
     The keyboard. `moveSelects` because a sample row **is** the selection: a
     plain ArrowDown moves it, as a file manager does, and Shift+ArrowDown
     extends the range through the very same `extendSelectionTo` a Shift-click
     calls. A checkbox list gets the other answer — see `useListKeys`.
  */
  const keys = useListKeys({ ordered: visibleOrder, onActivate: clickRow, moveSelects: true });

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    // An internal sample drag that lands back in the sidebar is a no-op, not an
    // import attempt.
    if (isInternalDrag(e.dataTransfer)) return;
    const refs = await platform().fromDataTransfer(e.dataTransfer.files);
    if (refs.length) await importFiles(refs);
  };

  const menuTargets = menu ? actionableSampleIds(useWorkspace.getState(), menu.sampleId) : [];

  return (
    <Panel
      surface="sunken"
      className="h-full relative"
      // Depth counting: dragenter/leave fire for every descendant, so a naive
      // boolean flickers as the pointer crosses child elements.
      onDragEnter={(e: React.DragEvent) => {
        // Dragging a sample row within the sidebar must not raise the
        // "Drop to import" curtain — it is not a file, and the curtain would
        // cover the list the user is dragging out of.
        if (isInternalDrag(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e: React.DragEvent) => { if (!isInternalDrag(e.dataTransfer)) e.preventDefault(); }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={onDrop}
    >
      <PanelHeader
        title="Samples"
        count={samples.length || undefined}
        actions={
          <>
            {/* Step the *shown* sample, before the import controls, so the two
                pairs of arrows in this panel are never adjacent — see
                `StepSamples`. */}
            <StepSamples
              order={visibleOrder}
              selectedId={selectedSampleId}
              onSelect={(id) => selectSample(id)}
            />
            <Tooltip content="Import .fcs files">
              <IconButton label="Import files" size="sm" onClick={async () => importFiles(await platform().pickFcsFiles())}>
                <FolderPlus size={13} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Import a folder of .fcs files">
              <IconButton label="Import folder" size="sm" onClick={async () => importFiles(await platform().pickFolder())}>
                <FolderOpen size={13} />
              </IconButton>
            </Tooltip>
            {/*
                Remove the selection, beside remove-everything and never in
                place of it.

                It appears only while more than one row is selected, which is
                the only state in which the two differ and is what keeps the
                destructive pair from reading as one ambiguous button. The row's
                own control and the context menu take the same batch; this is
                the copy that is visible without hovering a row or knowing there
                is a menu, which is how the gap was reported.
            */}
            {multiSelection.length > 1 && (
              <Tooltip content={`Remove the ${multiSelection.length} selected samples`}>
                <IconButton
                  label={`Remove ${multiSelection.length} selected samples`}
                  size="sm"
                  data-remove-selected=""
                  onClick={() => removeSamples(multiSelection)}
                >
                  <ListX size={13} />
                </IconButton>
              </Tooltip>
            )}
            {samples.length > 0 && (
              <Tooltip content="Remove all samples">
                <IconButton label="Remove all samples" size="sm" onClick={removeAll}>
                  <Trash2 size={13} />
                </IconButton>
              </Tooltip>
            )}
          </>
        }
      />

      {samples.length > 0 && (
        <div className="px-2 py-2">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)] pointer-events-none" />
            <TextInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter samples…"
              className="pl-7 h-6 text-2xs"
            />
          </div>
        </div>
      )}

      {progress.active && (
        <div className="px-2.5 py-2 hairline-b">
          <ProgressBar
            value={progress.done}
            max={progress.total}
            label={progress.current ? `Reading ${progress.current}` : 'Reading files'}
            detail={`${progress.done} / ${progress.total}`}
          />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {progress.active && samples.length === 0 ? (
          // First import: show placeholder rows rather than falling through to
          // the "no matches" state, which would claim nothing matches an empty
          // filter while files are still being read.
          <div className="px-1 pt-1 space-y-1.5" aria-label="Loading samples">
            {Array.from({ length: Math.min(progress.total || 4, 8) }, (_, i) => (
              <div key={i} className="flex items-center gap-2 h-[var(--h-row)] pl-2 pr-2">
                <div className="skeleton h-2 w-3 rounded-[2px]" />
                <div className="skeleton h-2.5" style={{ width: `${62 + ((i * 17) % 34)}%` }} />
              </div>
            ))}
          </div>
        ) : samples.length === 0 ? (
          <EmptyState
            className="mt-6"
            icon={<Upload size={19} />}
            title="No samples loaded"
            description="Drop .fcs files anywhere in this panel, or import a folder to begin."
            action={
              <Button variant="primary" icon={<FolderPlus size={13} />} onClick={async () => importFiles(await platform().pickFcsFiles())}>
                Import files
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            size="sm"
            className="mt-4"
            icon={<Search size={15} />}
            title="No matches"
            description={`Nothing matches “${query}”.`}
            action={<Button size="sm" variant="ghost" onClick={() => setQuery('')}>Clear filter</Button>}
          />
        ) : (
          /* One flat list, numbered straight through.
             The rows used to be collected under collapsible headers named after
             a prefix guessed from the filenames. Two things were wrong with it:
             the grouping was inferred rather than stated, so it asserted a
             relationship between files that may not exist; and it cost a header
             row plus an indent per group in the narrowest column in the window,
             to organise a list whose useful order is the order the files were
             loaded in. The index is what a user actually refers to a sample by.

             The groups themselves are untouched in the data model — import still
             assigns them, and anything that batches by condition still can. This
             is about what the list *renders*. */
          <div
            {...keys.containerProps}
            aria-label="Samples"
            className="space-y-px pt-0.5 focus:outline-none"
          >
            {filtered.map((s) => {
              const position = samples.indexOf(s);
              /*
                 The batch this row's controls act on.

                 `actionableSampleIds` is the same rule the drag and the context
                 menu already used: the whole selection if this row is in it,
                 otherwise this row alone. Reading it here rather than inside the
                 row keeps every route to a reorder — arrow, drag, and the drop
                 handler below — resolving the batch identically.
              */
              const batch = actionableSampleIds(useWorkspace.getState(), s.id);
              const batched = batch.length > 1;
              return (
                <SampleRow
                  key={s.id}
                  sample={s}
                  index={position + 1}
                  active={s.id === selectedSampleId}
                  inSelection={multiSelection.length > 1 && multiSelection.includes(s.id)}
                  batchSize={batched ? batch.length : 0}
                  // Reordering is disabled while a filter is on. The list on
                  // screen is then a subset, so "move this one down" has no
                  // single answer — down past the next visible row, or down one
                  // place in the real list, are different moves and the user can
                  // only see one of them.
                  reorderable={!query.trim()}
                  // Asked of the *batch*, not of this row. With the bottom three
                  // rows selected, the middle one's Down arrow was enabled on the
                  // strength of its own index and moved a block that had nowhere
                  // to go.
                  canMoveUp={canMoveSamples(useWorkspace.getState(), s.id, -1)}
                  canMoveDown={canMoveSamples(useWorkspace.getState(), s.id, 1)}
                  isDropTarget={reorderDrop === s.id && !reorderBatch.includes(s.id)}
                  acceptsReorder={reorderBatch.length > 0 && !reorderBatch.includes(s.id)}
                  onReorderStart={() => setReorderBatch(batch)}
                  onReorderEnd={() => { setReorderDrop(null); setReorderBatch([]); }}
                  onReorderOver={() => setReorderDrop(s.id)}
                  onReorderDrop={() => {
                    // The batch that was picked up, not the one row under the
                    // pointer when it was released — `reorderBatch` was resolved
                    // at drag start, before any of this ran.
                    if (reorderBatch.length && !reorderBatch.includes(s.id)) {
                      moveSamples(reorderBatch, position);
                    }
                    setReorderDrop(null);
                    setReorderBatch([]);
                  }}
                  onMoveBy={(delta) => moveSamplesBy(batch, delta)}
                  onSelect={(e) => keys.onRowClick(e, s.id)}
                  rowId={keys.rowId(s.id)}
                  cursor={keys.cursor === s.id}
                  // A plain press selects before anything else can consume the
                  // click. See `pressSample` — the hover controls sit over the
                  // right of the row and were eating it.
                  onPress={(e) => {
                    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
                    pressSample(s.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ at: { x: e.clientX, y: e.clientY }, sampleId: s.id });
                  }}
                  /*
                     The batch, exactly as the reorder arrows and the drag take
                     it: the whole selection when this row is in one, this row
                     alone otherwise. A row that says *5* on its handle and
                     removes one of the five would be two rules on one row.
                  */
                  onRemove={() => removeSamples(batch)}
                />
              );
            })}
          </div>
        )}
      </div>

      {failures.length > 0 && (
        <div className="hairline-t p-2">
          <Callout
            tone="err"
            title={`${failures.length} file${failures.length === 1 ? '' : 's'} could not be read`}
            actions={
              <Button size="sm" variant="ghost" icon={<X size={11} />} onClick={dismissFailures}>
                Dismiss
              </Button>
            }
          >
            <ul className="space-y-1.5">
              {failures.slice(0, 4).map((f) => (
                <li key={f.fileName}>
                  <span className="font-medium text-[var(--text-primary)] break-all">{f.fileName}</span>
                  <br />
                  {f.message}
                  {f.hint && <span className="block text-[var(--text-tertiary)] mt-0.5">{f.hint}</span>}
                </li>
              ))}
              {failures.length > 4 && <li className="text-[var(--text-tertiary)]">…and {failures.length - 4} more.</li>}
            </ul>
          </Callout>
        </div>
      )}

      {/* Non-drag path to the same action, so the feature is discoverable
          without knowing the FCS Express convention — and reachable without
          pointer-drag proficiency. Calls the identical opener the drop does. */}
      <ContextMenu
        at={menu?.at ?? null}
        onClose={() => setMenu(null)}
        items={[
          {
            label: menuTargets.length > 1 ? `Open ${menuTargets.length} samples in new plots` : 'Open in new plot',
            icon: <LineChart size={12} />,
            onSelect: () => openPanelsForSamples(menuTargets),
          },
          {
            // The keyword dump's new home. Reference material about one file,
            // reached from that file — rather than holding the bottom of the
            // inspector open for a list nobody reads twice in a session.
            label: 'File info…',
            icon: <FileText size={12} />,
            onSelect: () => { if (menu) setFileInfoFor(menu.sampleId); },
          },
          {
            // Counted, like the open-in-plots entry above it: removing samples
            // is not on the undo stack — a snapshot cannot put 156 MB of events
            // back — so the number of rows about to go is said before the press
            // rather than discovered after it.
            label: menuTargets.length > 1 ? `Remove ${menuTargets.length} samples` : 'Remove sample',
            icon: <Trash2 size={12} />,
            onSelect: () => removeSamples(menuTargets),
          },
        ]}
      />

      <FileInfoDialog sampleId={fileInfoFor} onClose={() => setFileInfoFor(null)} />

      {dragging && (
        <div className="absolute inset-0 z-30 grid place-items-center bg-[var(--surface-sunken)]/92 anim-fade pointer-events-none">
          <div className="flex flex-col items-center gap-2.5 px-6 py-8 mx-3 rounded-[var(--radius-lg)] border-2 border-dashed border-[var(--accent-500)]">
            <Upload size={22} className="text-[var(--text-accent)]" />
            <p className="text-base font-medium text-[var(--text-primary)]">Drop to import</p>
            <p className="text-2xs text-[var(--text-tertiary)]">.fcs files only — anything else is ignored</p>
          </div>
        </div>
      )}
    </Panel>
  );
}

/**
 * Step which sample is being *shown*, without hunting for the next row.
 *
 * A second pair of arrows in this panel, and the distinction from the first pair
 * is the whole of why it earns the space: the arrows on a **row** change the
 * order of the list, and these change **which sample you are looking at**. One
 * edits the workspace; the other is navigation and edits nothing.
 *
 * Paging through a plate one file at a time is the single most common thing
 * anybody does in this panel — the plot follows the sidebar selection, so
 * "advance to the next sample" is how twelve replicates get compared — and until
 * now it meant finding and clicking a 28 px row, then finding the next one, in a
 * list that scrolls. That is a targeting problem for a gesture with no target:
 * the user does not want *that* sample, they want the one after this one.
 *
 * ## Why they are up here rather than on the row
 *
 * Two reasons. They belong to the list rather than to any sample in it, so a
 * per-row copy would be N copies of one control. And the row already carries a
 * hover-revealed up/down pair for reordering — putting a second, differently
 * meaning up/down pair a few pixels away would make both untrustworthy. The
 * header is a different place, with a different visibility rule and its own
 * tooltips, so the two never have to be told apart by aim.
 *
 * ## The visibility rule
 *
 * Shown only when there is more than one sample **and** one is selected. With a
 * single sample there is nowhere to step; with nothing selected there is no
 * "current" to step *from*, and an arrow that has to invent a starting point
 * would be choosing a sample rather than moving through them. Both halves are
 * the requirement as stated, and both are honest about what the control does.
 *
 * The order is the **visible** one, so a filtered list steps through what is on
 * screen. That is the opposite of the rule for the reorder arrows, which are
 * disabled entirely while a filter is on — and the asymmetry is right: "one
 * place down" in a filtered list is ambiguous because it changes data the user
 * cannot see, whereas "the next one of these" is exactly what a filtered list is
 * for.
 */
function StepSamples({
  order,
  selectedId,
  onSelect,
}: {
  /** Sample ids in the order the list is rendering them. */
  order: string[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const at = selectedId ? order.indexOf(selectedId) : -1;
  if (order.length < 2 || at < 0) return null;

  const step = (delta: -1 | 1) => {
    const next = order[at + delta];
    if (next) onSelect(next);
  };

  return (
    <>
      <Tooltip content="Show the previous sample">
        <span>
          <IconButton
            label="Show the previous sample"
            size="sm"
            data-step-sample-prev=""
            disabled={at <= 0}
            onClick={() => step(-1)}
          >
            <ChevronUp size={13} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip content="Show the next sample">
        <span>
          <IconButton
            label="Show the next sample"
            size="sm"
            data-step-sample-next=""
            disabled={at >= order.length - 1}
            onClick={() => step(1)}
          >
            <ChevronDown size={13} />
          </IconButton>
        </span>
      </Tooltip>
      <VDivider className="mx-0.5" />
    </>
  );
}

function SampleRow({
  sample, index, active, inSelection, batchSize,
  reorderable, canMoveUp, canMoveDown, isDropTarget, acceptsReorder,
  onReorderStart, onReorderEnd, onReorderOver, onReorderDrop, onMoveBy,
  onSelect, onPress, onContextMenu, onRemove, rowId, cursor,
}: {
  sample: Sample;
  /** 1-based position in the sample list. */
  index: number;
  active: boolean;
  /** Part of a multi-selection, but not the primary — so the batch reads as one. */
  inSelection: boolean;
  /** How many samples this row's controls would move; 0 when it is only itself. */
  batchSize: number;
  /** False while a filter is on, where "one place down" has no visible meaning. */
  reorderable: boolean;
  /** Whether the whole batch can move that way — see `canMoveSamples`. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  isDropTarget: boolean;
  /** A reorder is in flight and this row is a valid target for it. */
  acceptsReorder: boolean;
  onReorderStart(): void;
  onReorderEnd(): void;
  onReorderOver(): void;
  onReorderDrop(): void;
  onMoveBy(delta: number): void;
  onSelect(e: React.MouseEvent): void;
  /** Pointer-down anywhere on the row, before any control can swallow the click. */
  onPress(e: React.PointerEvent): void;
  onContextMenu(e: React.MouseEvent): void;
  onRemove(): void;
  /** DOM id, so the focusable container can point the keyboard cursor at it. */
  rowId: string;
  /** The keyboard cursor is on this row. Distinct from being selected. */
  cursor: boolean;
}) {
  // The **whole** name, not the name with its group prefix stripped. Stripping
  // it only made sense while a header above the row was carrying the part that
  // had been removed; with the headers gone it would delete the one thing
  // distinguishing `…-CTRL 3` from `…-LATB 3` and leave two rows reading the
  // same. Truncation with a tooltip loses nothing permanently; stripping does.
  const label = sample.name;
  const renameSample = useWorkspace((s) => s.renameSample);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sample.name);

  const commit = () => {
    renameSample(sample.id, draft);
    setEditing(false);
  };
  const beginEdit = () => {
    setDraft(sample.name);
    setEditing(true);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 h-[var(--h-row)] pl-5 pr-1.5">
        <TextInput
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onFocus={(e) => e.currentTarget.select()}
          className="h-6 text-xs"
        />
      </div>
    );
  }
  const hasWarnings = sample.parsed.warnings.some(
    (w) => w.code === 'data-size-mismatch' || w.code === 'non-finite-values',
  );

  const color = `var(--pop-${String((sample.colorIndex % 12) + 1).padStart(2, '0')})`;

  return (
    <div
      // Native HTML5 DnD, matching the gate tree's existing reparent drag and
      // the sidebar's own file-import drop. See dragPayload.ts for why.
      draggable
      onDragStart={(e) => {
        // Whatever the user grabbed defines the batch: the whole selection if
        // this row is in it, otherwise just this row.
        const ids = actionableSampleIds(useWorkspace.getState(), sample.id);
        const label = ids.length > 1 ? `${ids.length} samples` : sample.name;
        setDragPayload(e.dataTransfer, { kind: 'sample', sampleIds: ids }, label);
        setDragGhost(e.dataTransfer, ids.length > 1 ? `${ids.length} samples` : sample.name, color, ids.length);
        useDragState.getState().begin({ kind: 'sample', sampleIds: ids });
        if (reorderable) onReorderStart();
      }}
      // Fires for a cancelled drag as well as a completed one, so Escape or a
      // release over nothing leaves no highlight behind.
      onDragEnd={() => { useDragState.getState().end(); onReorderEnd(); }}
      // A sample dropped on another *sample* is a reorder; dropped on the
      // worksheet it is still a plot. One drag, two meanings, resolved by where
      // it lands — the same rule the gate tree already uses.
      onDragOver={(e) => { if (!acceptsReorder) return; e.preventDefault(); onReorderOver(); }}
      onDrop={(e) => { if (!acceptsReorder) return; e.preventDefault(); e.stopPropagation(); onReorderDrop(); }}
      onPointerDown={onPress}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={beginEdit}
      id={rowId}
      role="option"
      aria-selected={active || inSelection}
      data-sample-row={sample.name}
      data-in-selection={inSelection || (active && batchSize > 1) ? '' : undefined}
      data-list-cursor={cursor ? '' : undefined}
      className={cn(
        'group relative flex items-center gap-2 h-[var(--h-row)] pl-2 pr-1.5 rounded-[var(--radius-xs)]',
        'cursor-grab active:cursor-grabbing',
        'transition-colors duration-[var(--dur-instant)]',
        cursor && 'ring-1 ring-inset ring-[var(--accent-500)]',
        /*
           Three states, and the middle one used to be indistinguishable from the
           first.

           A secondary row was `--surface-active` — a flat white 7% wash, against
           `--surface-hover`'s 4%. Two washes three points apart, one of which
           appears under the pointer anyway, is not a selection anyone can see,
           and it was in the wrong *family*: the primary row is lilac, so the
           rows moving with it read as a different kind of thing rather than as
           the same selection one step down.

           Both are the accent now, at two strengths, plus an accent rail down
           the left edge of every row in the batch — which is what makes an
           adjacent run read as one block rather than as several rows that happen
           to be shaded. The rail is the part that survives a colourblind reading
           of two lilac washes.
        */
        active ? 'bg-[var(--surface-selected)]'
          : inSelection ? 'bg-[var(--surface-selected-weak)]'
            : 'hover:bg-[var(--surface-hover)]',
        (inSelection || (active && batchSize > 1))
          && 'before:absolute before:left-0 before:inset-y-0 before:w-[2px] before:bg-[var(--accent-500)] before:rounded-full',
        isDropTarget && 'ring-1 ring-[var(--accent-500)] ring-inset',
      )}
    >
      {/* A number, not a swatch. The swatch was decorative — nothing on a plot
          is coloured by it, so it invited the reading that it identified the
          sample's events, which is what a *population* colour does. An index is
          what the list actually offers: a stable position to refer to. */}
      <span className="w-4 shrink-0 text-right font-mono tnum text-[10px] text-[var(--text-disabled)]">
        {index}
      </span>
      {/* Everything the row has left, given to the name.
          The count and the spectral tag are gone from here: between them they
          took about 70 px of a 200 px row — a third of it — to show a number
          that is on screen twice already (the inspector's Events tile, the
          status bar's total) and a two-letter tag repeated on almost every row
          of a spectral experiment, which is exactly when a tag stops
          distinguishing anything. What was being squeezed out was the sample
          name, which is the only thing in the row that identifies the sample.
          `min-w-0` is what lets the flex child actually shrink to its
          ellipsis instead of overflowing the row. */}
      <span
        // The name is what the row shows; the full path is here, on hover, however
        // the file arrived — imported, double-clicked or reopened with a workspace.
        title={`${sample.name}\n${sample.filePath ?? sample.fileName}\nDrag onto the worksheet to plot it · double-click to rename`}
        className={cn(
          'text-xs truncate min-w-0 flex-1',
          active ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]',
        )}
      >
        {label}
      </span>

      {hasWarnings && (
        <Tooltip content={sample.parsed.warnings.find((w) => w.code === 'data-size-mismatch')?.message ?? 'Data warnings'}>
          <AlertTriangle size={11} className="shrink-0 text-[var(--status-warn)] group-hover:opacity-0 transition-opacity duration-[var(--dur-fast)]" />
        </Tooltip>
      )}

      {/* The controls sit *on top of* the row's right edge, absolutely
          positioned, so the row never reflows on hover and the name keeps its
          full width when the pointer is elsewhere.

          Two arrows beside the remove button rather than only drag-to-reorder.
          A drag is the fast way to move a row a long way; one place up is the
          common request and is fiddly to aim at 22 px of row height, and the
          arrows are also the only route for anyone not using a pointer. Both go
          through the same store action. */}
      <span className="absolute right-1 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-[var(--dur-fast)]">
        {reorderable && (
          <>
            {/* The tooltip names the batch when there is one. An arrow that is
                about to move five rows should say so before it is pressed —
                otherwise the only way to discover that the selection came along
                is to watch four other rows jump. */}
            <Tooltip content={batchSize > 1 ? `Move ${batchSize} samples up` : 'Move up'}>
              <IconButton
                label={batchSize > 1 ? `Move ${batchSize} selected samples up` : `Move ${sample.name} up`}
                size="sm"
                disabled={!canMoveUp}
                data-move-up={sample.name}
                onClick={(e) => { e.stopPropagation(); onMoveBy(-1); }}
              >
                <ChevronUp size={12} />
              </IconButton>
            </Tooltip>
            <Tooltip content={batchSize > 1 ? `Move ${batchSize} samples down` : 'Move down'}>
              <IconButton
                label={batchSize > 1 ? `Move ${batchSize} selected samples down` : `Move ${sample.name} down`}
                size="sm"
                disabled={!canMoveDown}
                data-move-down={sample.name}
                onClick={(e) => { e.stopPropagation(); onMoveBy(1); }}
              >
                <ChevronDown size={12} />
              </IconButton>
            </Tooltip>
          </>
        )}
        <Tooltip content={batchSize > 1 ? `Remove the ${batchSize} selected samples` : 'Remove sample'}>
          <IconButton
            label={batchSize > 1 ? `Remove ${batchSize} selected samples` : `Remove ${sample.name}`}
            size="sm"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
          >
            <X size={12} />
          </IconButton>
        </Tooltip>
      </span>
    </div>
  );
}

/** Grouping separators use narrow no-break spaces so numbers stay compact. */
export function formatFull(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

export { Badge };
