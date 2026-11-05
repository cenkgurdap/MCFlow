import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight, Circle, Copy, Grid2x2, Layers, LineChart, Link2, Link2Off, Minus, MousePointer2,
  Pencil, Pentagon, Square, Trash2, TriangleAlert,
} from 'lucide-react';
import { GATE_INK } from './GateLayer';
import { childrenOf, flattenTree } from '@/core/gating/tree';
import { ROOT_ID, type Gate, type PopulationStats } from '@/core/gating/types';
import type { Mods } from '@/core/listKeys';
import { useGates, type DrawTool } from '@/state/gateStore';
import { step } from '@/state/historyBus';
import { openPanelForPopulation, openPanelsForSamples } from '@/state/layoutActions';
import {
  clearSelection, extendGateSelectionTo, selectGateOnly, toggleGateSelection,
} from '@/state/selection';
import { useUI } from '@/state/uiStore';
import { useWorkspace } from '@/state/workspaceStore';
import { setDragGhost, setDragPayload, useDragState } from './dragPayload';
import { GATE_COLOR_SWATCHES, gateColorLabel } from './gateColors';
import { IconButton } from '@/ui/Button';
import { ContextMenu } from '@/ui/ContextMenu';
import { Popover } from '@/ui/Popover';
import { TextInput } from '@/ui/Field';
import { Badge, ColorChip, EmptyState } from '@/ui/Feedback';
import { PanelHeader } from '@/ui/Panel';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { Tooltip } from '@/ui/Tooltip';
import { useListKeys, type ListKeys } from '@/ui/useListKeys';
import { cn } from '@/ui/cn';

/*
   There was a `KIND_ICON` map here — a 10 px square, pentagon, circle, grid or
   dash beside every row, naming the shape the gate was drawn with. It is gone
   (2026-08-04, Item 3), and the reason is worth stating rather than just
   deleting: **the shape a population was drawn with is not a property of the
   population.** Every kind selects a set of events and the set is what the row
   is about; two rows reading 14 350 and 11 873 do not become more comparable
   because one was a rectangle. The shape is visible on the plot, where it is a
   fact you can act on, and it cost 16 px of a 264 px sidebar on every row.

   What stays is the colour swatch, which *is* a property of the population and
   is the control for changing it.
*/

const POP = (i: number) => `var(--pop-${String((i % 12) + 1).padStart(2, '0')})`;

export function GateTree({
  sampleId,
  gates,
  stats,
  errors,
  scopeNote,
}: {
  sampleId: string;
  gates: Gate[];
  stats: Map<string, PopulationStats>;
  errors: Map<string, string>;
  /**
   * What this tree is showing, when it is not the ordinary one-sample view.
   *
   * The line it replaces says "Shared across all 14 samples", which is a true
   * and useful statement about a sample's gating and a false one about a
   * merged reference panel — where each row is counted on a different file.
   * A view that is about something else has to say so where the old sentence
   * was, not somewhere else on the screen.
   */
  scopeNote?: string;
}) {
  const {
    selectedGateId, selectedGateIds, tool,
    setTool, renameGate, reparentGate, setGateLinked, setGateColor,
    applyToAllSamples, unlinkSample, relinkSample, clearGates,
  } = useGates();
  const divergent = useGates((s) => s.divergent);
  const countedName = useWorkspace((s) => s.samples.find((x) => x.id === sampleId)?.name ?? null);
  const samples = useWorkspace((s) => s.samples);
  const forked = sampleId in divergent;

  /**
   * Clicking a node selects it, and does nothing else.
   *
   * It used to also retarget every panel that had not been pinned, on the theory
   * that the tree is the app's index of populations so clicking through it
   * should show them. In use that is wrong: selecting a population is what you
   * do in order to rename it, delete it or read its statistics, and having three
   * plots change what they are displaying as a side effect of a rename is the
   * kind of thing that makes a worksheet feel unsafe to touch. A panel's
   * population changes through its own breadcrumb selector, or by dropping a
   * gate onto it — both of which name the panel explicitly.
   */
  /**
   * The rows as a flat list, in the order this component draws them.
   *
   * `flattenTree` is the same `childrenOf` recursion `GateBranch` renders with,
   * so a Shift-range covers the rows somebody actually saw between the two they
   * clicked. Computed here rather than inside the recursion, which cannot hand
   * anybody a list of itself.
   */
  const order = useMemo(() => flattenTree(gates).map((g) => g.id), [gates]);

  /**
   * Selecting from the tree selects *gates* and nothing else.
   *
   * No panel anchor: this click did not happen on a panel. All three routes
   * clear any panel selection, so a gate selection and a panel selection can
   * never both be live — which is the bug `state/selection.ts` exists for.
   * Clicking "All events" deselects, which is the tree's way of saying nothing
   * is selected.
   *
   * **Shift is tested first**, so Ctrl+Shift extends rather than falling into
   * the toggle branch, and the modifier is read as Ctrl **or** Cmd because the
   * application builds for macOS, where Ctrl+click is the secondary click. This
   * is the sample browser's gesture, on the sample browser's order of tests.
   */
  const selectPopulation = (e: Mods | undefined, gateId: string | null) => {
    if (!gateId) { clearSelection(); return; }
    if (e?.shiftKey) extendGateSelectionTo(gateId, order);
    else if (e?.ctrlKey || e?.metaKey) toggleGateSelection(gateId);
    else selectGateOnly(gateId);
  };

  /**
   * Which populations an action applies to, given the row it was reached from.
   *
   * The selection if that row is in it, otherwise just that row — what every
   * file manager does, and exactly `actionableSampleIds`' rule on the sample
   * list. Without it, right-clicking one row of a selected block would silently
   * act on the block, or silently act on one; both are surprises.
   */
  const batchFor = (gateId: string) => (
    selectedGateIds.includes(gateId) ? selectedGateIds : [gateId]
  );

  /**
   * Ask before deleting — the same confirmation Escape raises.
   *
   * Deleting a gate is deleting analysis, and it must not matter which
   * affordance reached it. The batch goes across whole, so the survivors are
   * resolved against all of it at once; see `GateDeleteConfirm`.
   */
  const askDelete = (gateId: string) => {
    const ids = batchFor(gateId).filter((id) => gates.some((g) => g.id === id));
    if (ids.length === 0) return;
    const name = ids.length === 1
      ? gates.find((g) => g.id === ids[0])?.name ?? ''
      : `${ids.length} populations`;
    useUI.getState().askDeleteGate(sampleId, ids, name);
  };

  /*
     The keyboard, on the same handler the pointer calls. `moveSelects` because
     a gate row **is** the selection, as a sample row is: a plain ArrowDown moves
     it and Shift+ArrowDown extends the range through the identical
     `extendGateSelectionTo` a Shift-click reaches.
  */
  const keys = useListKeys({
    ordered: order,
    onActivate: (mods, id) => selectPopulation(mods, id),
    moveSelects: true,
  });

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; gateId: string | null } | null>(null);
  /**
   * Which row is being renamed inline.
   *
   * Held here rather than inside the row so the context menu's *Rename* can open
   * it — the two affordances have to drive one editor, or "rename" would mean
   * something subtly different depending on how it was reached.
   */
  const [editingId, setEditingId] = useState<string | null>(null);

  const root = stats.get(ROOT_ID);
  const menuGate = menu?.gateId ? gates.find((g) => g.id === menu.gateId) ?? null : null;
  const menuBatch = menuGate ? batchFor(menuGate.id) : [];

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PanelHeader
        title="Gating"
        count={gates.length || undefined}
        actions={
          gates.length > 0 ? (
            <>
              {forked ? (
                <Tooltip content="This sample has its own gating. Put it back on the shared strategy, discarding these gates.">
                  <IconButton label="Relink to shared gating" size="sm" onClick={() => relinkSample(sampleId)}>
                    <Link2 size={13} />
                  </IconButton>
                </Tooltip>
              ) : (
                <Tooltip content="Give this sample its own copy of the gating, so edits here stop affecting the others">
                  <IconButton label="Unlink gating for this sample" size="sm" onClick={() => unlinkSample(sampleId)}>
                    <Link2Off size={13} />
                  </IconButton>
                </Tooltip>
              )}
              {forked && (
                <Tooltip content={`Make this the shared strategy for all ${samples.length} sample(s)`}>
                  <IconButton label="Apply to all samples" size="sm" onClick={() => applyToAllSamples(sampleId)}>
                    <Copy size={13} />
                  </IconButton>
                </Tooltip>
              )}
              <Tooltip content={forked ? 'Delete every gate on this sample' : 'Delete every gate in the shared strategy'}>
                <IconButton label="Clear gates" size="sm" onClick={() => clearGates(sampleId)}>
                  <Trash2 size={13} />
                </IconButton>
              </Tooltip>
            </>
          ) : undefined
        }
      />

      <div className="p-2 space-y-2 hairline-b">
        {/* Icon-only: five labelled segments do not fit a 264px sidebar and
            truncate to "Sel… R… P…", which is worse than no label at all. */}
        <SegmentedControl
          fullWidth
          size="sm"
          value={tool}
          onChange={(t) => setTool(t as DrawTool)}
          segments={[
            { value: 'none', label: <MousePointer2 size={11} />, title: 'Select — click a gate to edit it' },
            { value: 'rectangle', label: <Square size={11} />, title: 'Rectangle — drag on the plot, release to finish' },
            { value: 'polygon', label: <Pentagon size={11} />, title: 'Polygon — click vertices, then click the first point to close. Double-click or Enter also close; Esc cancels.' },
            { value: 'ellipse', label: <Circle size={11} />, title: 'Ellipse — drag on the plot, release to finish' },
            { value: 'quadrant', label: <Grid2x2 size={11} />, title: 'Quadrant — one click places a four-way split' },
            { value: 'range', label: <Minus size={11} />, title: 'Range — drag across a histogram, release to finish' },
          ]}
        />
        {/* Where this sample's gates come from. Shared is the default and the
            common case, so it is stated quietly; a fork is the exception and has
            to be visible, because an edit made here reaches nothing else. */}
        <div className="flex items-center gap-1.5 text-2xs" data-gate-tree-scope={scopeNote ? 'panel' : 'sample'}>
          <Layers size={10} className={!scopeNote && forked ? 'text-[var(--status-warn)]' : 'text-[var(--text-disabled)]'} />
          <span className={!scopeNote && forked ? 'text-[var(--status-warn)]' : 'text-[var(--text-tertiary)]'}>
            {scopeNote ?? (forked
              ? 'Gating for this sample only'
              : `Shared across all ${samples.length} sample${samples.length === 1 ? '' : 's'}`)}
          </span>
        </div>
        {/* Whose numbers these are (2026-10-28). The tree follows the sample
            list's selection, not the plot in front of the user, and a
            percentage that disagreed with the plot beside it — 76.75% against
            78.5% — read as a wrong number until it was traced to a different
            sample. Naming it settles that without changing what is counted. */}
        {!scopeNote && countedName && (
          <div
            data-gate-tree-sample=""
            className="text-2xs text-[var(--text-tertiary)] truncate"
            title="The counts are for the sample selected in Samples, which can differ from the plot on screen."
          >
            {`Counts for ${countedName}`}
          </div>
        )}
      </div>

      <div
        {...keys.containerProps}
        aria-label="Populations"
        className="flex-1 overflow-y-auto p-1 min-h-0 focus:outline-none"
      >
        {/* Root is always present so the hierarchy has a visible anchor and a
            drop target for un-parenting. */}
        <GateRow
          depth={0}
          label="All events"
          count={root?.count ?? 0}
          percentParent={100}
          percentTotal={100}
          color="var(--text-disabled)"
          selected={selectedGateId === null}
          onSelect={() => selectPopulation(undefined, null)}
          isRoot
          isDropTarget={dropId === ROOT_ID}
          acceptsDrop={dragId !== null}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, gateId: null }); }}
          onDragOver={() => setDropId(ROOT_ID)}
          onDrop={() => { if (dragId) reparentGate(sampleId, dragId, null); setDragId(null); setDropId(null); }}
        />

        {gates.length === 0 ? (
          <EmptyState
            size="sm"
            className="mt-4"
            icon={<Square size={15} />}
            title="No gates yet"
            description="Pick a shape above, then drag on the plot to define a population. Gates apply to every sample unless you unlink one."
          />
        ) : (
          <GateBranch
            sampleId={sampleId}
            gates={gates}
            parentId={null}
            depth={1}
            stats={stats}
            errors={errors}
            selectedGateIds={selectedGateIds}
            keys={keys}
            editingId={editingId}
            setEditingId={setEditingId}
            dragId={dragId}
            dropId={dropId}
            setDragId={setDragId}
            setDropId={setDropId}
            onRemove={(id) => askDelete(id)}
            onRename={(id, name) => renameGate(sampleId, id, name)}
            onReparent={(id, parent) => reparentGate(sampleId, id, parent)}
            onSetLinked={(id, linked) => setGateLinked(sampleId, id, linked)}
            /* Colour follows the batch, for the same reason delete does: a
               swatch picked on a row inside a selection is a statement about the
               selection. Wrapped, or eight populations recoloured together would
               be eight undo steps. */
            onSetColor={(id, color) => {
              const ids = batchFor(id);
              if (ids.length === 1) { setGateColor(sampleId, id, color); return; }
              step('Colour populations', () => {
                for (const g of ids) setGateColor(sampleId, g, color);
              });
            }}
            onContextMenu={(e, gateId) => setMenu({ at: { x: e.clientX, y: e.clientY }, gateId })}
          />
        )}
      </div>

      {/* Same opener the worksheet drop calls — one code path, two entry
          points, so the menu cannot drift from the drag. */}
      <ContextMenu
        at={menu?.at ?? null}
        onClose={() => setMenu(null)}
        width={236}
        items={
          menuGate
            ? [
                /* Rename and Open stay singular however many rows are selected:
                   both are questions about one population, and a batch has no
                   answer to either. Delete is the one that reads the batch. */
                {
                  label: 'Rename',
                  hint: 'or double-click',
                  icon: <Pencil size={12} />,
                  onSelect: () => setEditingId(menuGate.id),
                },
                {
                  label: 'Open in new plot',
                  hint: 'scoped',
                  icon: <LineChart size={12} />,
                  onSelect: () => openPanelForPopulation(sampleId, menuGate.id),
                },
                {
                  label: menuBatch.length > 1
                    ? `Delete ${menuBatch.length} populations`
                    : `Delete ${menuGate.name}`,
                  icon: <Trash2 size={12} />,
                  onSelect: () => askDelete(menuGate.id),
                },
              ]
            : [
                {
                  label: 'Open all events in new plot',
                  icon: <LineChart size={12} />,
                  onSelect: () => openPanelsForSamples([sampleId]),
                },
              ]
        }
      />
    </div>
  );
}

/* ========================================================================== */

function GateBranch({
  sampleId, gates, parentId, depth, stats, errors, selectedGateIds, keys, editingId, setEditingId,
  dragId, dropId, setDragId, setDropId,
  onRemove, onRename, onReparent, onSetLinked, onSetColor, onContextMenu,
}: {
  sampleId: string;
  gates: Gate[];
  parentId: string | null;
  depth: number;
  stats: Map<string, PopulationStats>;
  errors: Map<string, string>;
  selectedGateIds: string[];
  /**
   * The cursor, and the way a row click gets in.
   *
   * Threaded as one object rather than as an id, a predicate and a handler —
   * this component's signature is long enough, and the three are never wanted
   * apart. `onRowClick` is why there is no separate `onSelect` prop: every
   * pointer route has to move the cursor as well as the selection, so there is
   * one way in rather than two that can disagree.
   */
  keys: ListKeys;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  dragId: string | null;
  dropId: string | null;
  setDragId: (id: string | null) => void;
  setDropId: (id: string | null) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => boolean;
  onReparent: (id: string, parentId: string | null) => void;
  onSetLinked: (id: string, linked: boolean) => void;
  onSetColor: (id: string, color: string | null) => void;
  onContextMenu: (e: React.MouseEvent, gateId: string) => void;
}) {
  const children = useMemo(() => childrenOf(gates, parentId), [gates, parentId]);
  // Read straight from the store rather than threading another prop through a
  // recursive component whose signature is already long.
  const lastAddedIds = useGates((s) => s.lastAddedIds);

  return (
    <>
      {children.map((g) => {
        const s = stats.get(g.id);
        const hasChildren = childrenOf(gates, g.id).length > 0;
        return (
          <div key={g.id}>
            <GateRow
              depth={depth}
              rowId={keys.rowId(g.id)}
              cursor={keys.cursor === g.id}
              label={g.name}
              justAdded={lastAddedIds.includes(g.id)}
              count={s?.count ?? 0}
              percentParent={s?.percentOfParent ?? 0}
              percentTotal={s?.percentOfTotal ?? 0}
              color={POP(g.colorIndex)}
              selected={selectedGateIds.includes(g.id)}
              error={errors.get(g.id)}
              expandable={hasChildren}
              editing={editingId === g.id}
              onEditing={(on) => setEditingId(on ? g.id : null)}
              // Undefined rather than false on a gate that predates the field:
              // linked is the default and always has been.
              linked={g.linked !== false}
              onSetLinked={(v) => onSetLinked(g.id, v)}
              gateColor={g.color}
              onSetColor={(c) => onSetColor(g.id, c)}
              onSelect={(e) => keys.onRowClick(e, g.id)}
              onRemove={() => onRemove(g.id)}
              onRename={(name) => onRename(g.id, name)}
              draggable
              isDropTarget={dropId === g.id}
              acceptsDrop={dragId !== null}
              onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, g.id); }}
              onDragStart={(e) => {
                setDragId(g.id);
                // One drag, two possible meanings, resolved by where it lands:
                // dropped on another row it reparents (the `dragId` path that
                // already existed), dropped on the worksheet it opens a plot
                // scoped to this population. The payload only matters for the
                // second, and carrying it costs the first nothing.
                const payload = {
                  kind: 'gate' as const,
                  sampleId,
                  gateId: g.id,
                  gateName: g.name,
                  colorIndex: g.colorIndex,
                };
                setDragPayload(e.dataTransfer, payload, g.name);
                setDragGhost(e.dataTransfer, g.name, POP(g.colorIndex));
                useDragState.getState().begin(payload);
              }}
              onDragEnd={() => {
                // Runs on cancel as well as on drop, so an abandoned drag leaves
                // no drop ring and no phantom in-flight payload.
                setDragId(null);
                setDropId(null);
                useDragState.getState().end();
              }}
              onDragOver={() => setDropId(g.id)}
              onDrop={() => {
                if (dragId && dragId !== g.id) onReparent(dragId, g.id);
                setDragId(null);
                setDropId(null);
              }}
            />
            <GateBranch
              sampleId={sampleId}
              gates={gates}
              parentId={g.id}
              depth={depth + 1}
              stats={stats}
              errors={errors}
              selectedGateIds={selectedGateIds}
              keys={keys}
              editingId={editingId}
              setEditingId={setEditingId}
              dragId={dragId}
              dropId={dropId}
              setDragId={setDragId}
              setDropId={setDropId}
              onRemove={onRemove}
              onRename={onRename}
              onReparent={onReparent}
              onSetLinked={onSetLinked}
              onSetColor={onSetColor}
              onContextMenu={onContextMenu}
            />
          </div>
        );
      })}
    </>
  );
}

function GateRow({
  depth, label, count, percentParent, percentTotal, color, selected, error,
  expandable, isRoot, draggable, isDropTarget, justAdded, acceptsDrop = true, editing, onEditing,
  linked, onSetLinked, gateColor, onSetColor,
  rowId, cursor,
  onSelect, onRemove, onRename, onDragStart, onDragEnd, onDragOver, onDrop, onContextMenu,
}: {
  depth: number;
  label: string;
  count: number;
  percentParent: number;
  percentTotal: number;
  color: string;
  selected: boolean;
  error?: string;
  /** Created by the most recent draw — flashes once so the click reads as landed. */
  justAdded?: boolean;
  expandable?: boolean;
  isRoot?: boolean;
  draggable?: boolean;
  isDropTarget?: boolean;
  /**
   * Whether this row is a valid target for the drag in flight.
   *
   * A row only accepts a reparent from *within this tree*. Without the guard, a
   * sample dragged across the sidebar on its way to the worksheet lights up
   * every gate row as droppable and then does nothing when released.
   */
  acceptsDrop?: boolean;
  /** Inline rename is open. Owned by the tree so the context menu can open it too. */
  editing?: boolean;
  onEditing?: (on: boolean) => void;
  /**
   * This gate's boundary is the same on every sample.
   *
   * Per gate, and independent of its parent's state — see `GateBase.linked`.
   * Absent on the root row, which has no boundary to share or fork.
   */
  linked?: boolean;
  onSetLinked?: (linked: boolean) => void;
  /** This gate's explicit outline colour, if it has one. */
  gateColor?: string;
  onSetColor?: (color: string | null) => void;
  /** DOM id, so the focusable container can point the keyboard cursor here. */
  rowId?: string;
  /** The keyboard cursor is on this row. Distinct from being selected. */
  cursor?: boolean;
  /** The click is passed on: the modifiers decide whether this is a range. */
  onSelect: (e: React.MouseEvent) => void;
  onRemove?: () => void;
  /** Returns false when the name is already taken — see `renameGate`. */
  onRename?: (name: string) => boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onDragOver?: () => void;
  onDrop?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [draft, setDraft] = useState(label);
  /**
   * The name this row tried to commit and was refused.
   *
   * `renameGate` returns false when another population already carries the
   * name — see the note on it for why a rename refuses where the naming prompt
   * offers to replace. Without this the editor closed and the row went back to
   * the old name with nothing said, which reads as the rename having been
   * accepted and then lost.
   */
  const [taken, setTaken] = useState<string | null>(null);

  // The draft is seeded whenever the editor opens, from whichever affordance
  // opened it — double-click, or Rename on the context menu.
  useEffect(() => { if (editing) { setDraft(label); setTaken(null); } }, [editing, label]);

  if (editing && onRename) {
    /** Enter, or the confirm. Stays open on a refusal so the name can be fixed. */
    const commit = () => {
      if (onRename(draft)) { setTaken(null); onEditing?.(false); return; }
      setTaken(draft.trim());
    };
    return (
      <div className="pr-1" style={{ paddingLeft: 4 + depth * 13 }}>
        <div className="flex items-center h-[var(--h-row)]">
          <TextInput
            autoFocus
            data-gate-rename-input=""
            aria-invalid={taken ? true : undefined}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); if (taken) setTaken(null); }}
            onFocus={(e) => e.currentTarget.select()}
            /*
               Clicking away **discards** a name that is taken rather than
               committing it. Enter is "I mean this one", and answering it with a
               warning is right; a click somewhere else is "never mind", and
               keeping the editor open by stealing focus back would be the row
               refusing to be left. The old name is still there and nothing was
               written either way.
            */
            onBlur={() => { onRename(draft); onEditing?.(false); }}
            onKeyDown={(e) => {
              // Stopped, so the plot's window-level Escape handler does not also
              // fire and treat this as "delete the selected gate".
              e.stopPropagation();
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') onEditing?.(false);
            }}
            className={cn('h-6 text-xs', taken && 'border-[var(--status-warn)]')}
          />
        </div>
        {taken && (
          <p
            data-gate-rename-taken={taken}
            className="pb-1 pr-1 text-[9.5px] leading-snug text-[var(--status-warn)]"
          >
            A population called <span className="font-medium">{taken}</span> already exists. Populations are
            matched by name in Statistics and in the export, so two cannot share one.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      draggable={draggable}
      id={rowId}
      role="option"
      aria-selected={selected}
      data-gate-row={isRoot ? undefined : label}
      data-list-cursor={cursor ? '' : undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { if (!acceptsDrop) return; e.preventDefault(); onDragOver?.(); }}
      onDrop={(e) => { if (!acceptsDrop) return; e.preventDefault(); onDrop?.(); }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDoubleClick={() => { if (onRename) onEditing?.(true); }}
      style={{ paddingLeft: 4 + depth * 13 }}
      className={cn(
        'group relative flex items-center gap-1.5 h-[var(--h-row)] pr-1.5 rounded-[var(--radius-xs)]',
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        'transition-colors duration-[var(--dur-instant)]',
        selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
        cursor && 'ring-1 ring-[var(--accent-500)] ring-inset',
        isDropTarget && 'ring-1 ring-[var(--accent-500)] ring-inset',
        justAdded && 'anim-flash',
      )}
    >
      {/* A selected gate is marked in its own population colour here and on the
          plot, so the two views agree about which population is which — and so
          "gate selected" never looks like "plot selected", which is the accent
          colour and means Escape deletes without asking. */}
      {selected && !isRoot && (
        <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full" style={{ background: color }} />
      )}
      <ChevronRight
        size={11}
        className={cn('shrink-0 text-[var(--text-disabled)]', expandable ? 'rotate-90' : 'opacity-0')}
      />
      {/* The colour chip is the entry point for the swatch picker, and it shows
          **the colour the gate is actually drawn in** — `g.color` when one has
          been picked, and `--gate-ink` when one has not.

          That second half was the bug (2026-08-04, Item 3). The fallback used to
          be the *population palette* colour, `var(--pop-NN)`, so a gate on its
          default drew a near-black outline on the plot and showed a cyan dot in
          the tree. Two things called "the gate's colour" that were never the same
          value: the outline has followed the theme since 2026-08-03 and the chip
          was still reporting the palette entry it had shown before that.

          `GATE_INK` rather than a literal, and imported from `GateLayer`, which
          is the module that decides what a gate is stroked with — see
          `gateOutlineColor` there, which this now mirrors exactly.

          The population colour has not gone anywhere; it is still the selected
          row's spine, the plot's handle squares and the interior tint. It is
          simply not what the outline is drawn in, so it is not what this reports. */}
      {isRoot ? (
        <span className="w-[9px]" />
      ) : onSetColor ? (
        <GateColorPicker
          current={gateColor}
          fallback={GATE_INK}
          label={label}
          onPick={onSetColor}
        />
      ) : (
        <ColorChip color={gateColor ?? GATE_INK} />
      )}
      <span
        className={cn(
          'text-xs truncate min-w-0',
          selected ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]',
        )}
      >
        {label}
      </span>
      {error && (
        <Tooltip content={error}>
          <TriangleAlert size={11} className="text-[var(--status-err)] shrink-0" />
        </Tooltip>
      )}

      {/* Unlinked is the exception and is the state worth seeing without
          hovering: a gate whose boundary differs between samples is the one
          thing on this tree that makes two samples' numbers incomparable for a
          reason nothing else on screen explains. Linked is the default, so its
          control stays on hover with everything else. */}
      {onSetLinked && linked === false && (
        <Tooltip content="This gate has its own boundary on each sample. Click to link it back — every sample takes the boundary this one has.">
          <button
            data-gate-linked="false"
            aria-label={`${label} is unlinked across samples`}
            className="shrink-0 text-[var(--status-warn)]"
            onClick={(e) => { e.stopPropagation(); onSetLinked(true); }}
          >
            <Link2Off size={11} />
          </button>
        </Tooltip>
      )}

      <span className="ml-auto flex items-baseline gap-2.5 shrink-0 font-mono tnum text-2xs">
        <span className="text-[var(--text-disabled)]">{count.toLocaleString('en-US').replace(/,/g, ' ')}</span>
        <Tooltip content={`${percentTotal.toFixed(3)}% of all events`}>
          <span className={cn('w-[52px] text-right', selected ? 'text-[var(--text-accent)]' : 'text-[var(--text-tertiary)]')}>
            {percentParent.toFixed(2)}%
          </span>
        </Tooltip>
      </span>

      {onSetLinked && linked !== false && (
        <Tooltip content="This gate uses one boundary on every sample. Click to give it its own boundary per sample — useful for a debris or scatter gate that genuinely moves between files.">
          <IconButton
            label={`Unlink ${label} across samples`}
            data-gate-linked="true"
            size="sm"
            className="absolute right-12 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            onClick={(e) => { e.stopPropagation(); onSetLinked(false); }}
          >
            <Link2 size={11} />
          </IconButton>
        </Tooltip>
      )}
      {onRename && (
        <IconButton
          label={`Rename ${label}`}
          size="sm"
          className="absolute right-6 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onEditing?.(true); }}
        >
          <Pencil size={11} />
        </IconButton>
      )}
      {onRemove && (
        <IconButton
          label={`Delete ${label}`}
          size="sm"
          className="absolute right-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
        >
          <Trash2 size={11} />
        </IconButton>
      )}
    </div>
  );
}

/**
 * The gate's colour chip, and the curated swatches behind it.
 *
 * A popover of sixteen fixed colours rather than a colour well: the point of the
 * theme-following default is that nobody has to think about whether a colour is
 * legible on this plot surface, and a free picker hands that problem straight
 * back. See `gateColors.ts` for how the sixteen were chosen.
 *
 * *Follow the theme* is first and is what an unset gate shows, so the way back
 * from a choice is in the same place as the choice.
 */
function GateColorPicker({
  current, fallback, label, onPick,
}: {
  current?: string;
  /**
   * What the gate is stroked with when it carries no explicit colour — the
   * theme's own ink. Passed in rather than defaulted here so the chip and
   * `gateOutlineColor` cannot answer differently; that they once did is Item 3.
   */
  fallback: string;
  label: string;
  onPick: (color: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Tooltip content={`${label} outline — ${gateColorLabel(current)}. Click to change.`}>
        <button
          ref={ref}
          data-gate-color={current ?? 'theme'}
          aria-label={`Colour for ${label}`}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          className="shrink-0 rounded-full h-[9px] w-[9px] border border-[var(--border-strong)]"
          style={{ background: current ?? fallback }}
        />
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={182} align="start">
        <div className="p-2 space-y-2" data-gate-color-picker="">
          <button
            onClick={() => { onPick(null); setOpen(false); }}
            className={cn(
              'flex items-center gap-2 w-full px-1.5 h-6 rounded-[var(--radius-xs)] text-2xs text-left',
              'hover:bg-[var(--surface-hover)]',
              !current && 'bg-[var(--surface-selected)]',
            )}
          >
            <span
              className="h-[11px] w-[11px] rounded-full border border-[var(--border-strong)]"
              style={{ background: 'var(--gate-ink)' }}
            />
            <span className="text-[var(--text-secondary)]">Follow the theme</span>
          </button>
          <div className="grid grid-cols-8 gap-1">
            {GATE_COLOR_SWATCHES.map((s) => (
              <button
                key={s.value}
                title={s.label}
                data-swatch={s.value}
                aria-label={s.label}
                onClick={() => { onPick(s.value); setOpen(false); }}
                className={cn(
                  'h-4 w-4 rounded-[var(--radius-xs)] border',
                  current?.toLowerCase() === s.value.toLowerCase()
                    ? 'border-[var(--accent-500)] ring-1 ring-[var(--accent-500)]'
                    : 'border-[var(--border-strong)]',
                )}
                style={{ background: s.value }}
              />
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}

export { Badge };
