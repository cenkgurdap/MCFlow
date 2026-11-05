import { useMemo, useRef, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import { blockBetween, withBlock } from '@/core/rangeSelect';
import { Button } from '@/ui/Button';
import { useListKeys } from '@/ui/useListKeys';
import { Checkbox, TextInput } from '@/ui/Field';
import { Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

/**
 * Which things are in which group — the one table, used by two panels.
 *
 * ## What it is
 *
 * **A table, one row per thing** (2026-08-04, Item 9). What this replaced was a
 * stack of text fields with the sample name in a shrinking span beside each one,
 * and it had two problems that only appear at scale. With six samples the name
 * and its field are obviously paired; with fifty they are two columns of
 * unaligned text on a scrolling list, and the question "which sample is this
 * field for" has to be answered by eye on every row. And every assignment was
 * one field at a time — putting twenty-five files into `Control` meant typing
 * `Control` twenty-five times, with a typo on any one of them silently producing
 * a twenty-sixth category of one.
 *
 * So: a fixed heading, a read-only name column, an editable group column, a
 * checkbox per row, and a bar that applies one typed name to everything ticked.
 * The search box narrows the rows so a subset can be selected without scrolling
 * past the rest — and it deliberately narrows *what is shown*, not what is
 * selected, so a selection survives changing the filter and can be built up
 * across several searches.
 *
 * ## Why it lives here rather than in Statistics
 *
 * The UMAP panel asks the identical question of a set of loaded CSV files, and
 * the first version of it shipped a different answer: one text field per row and
 * a *Use file names* button. Two grouping interfaces in one application is two
 * places to fix a bulk-assignment bug, and the second one was the weaker of the
 * two by every measure that made the first one worth building. It is generic
 * over `{ id, name, group }` and knows nothing about samples or datasets.
 *
 * `included` and `onToggleIncluded` are optional and UMAP's alone: a loaded file
 * can be held out of a projection without being unloaded, which has no analogue
 * in a workspace where every sample is always evaluated.
 *
 * ## The whole row is the checkbox
 *
 * Ticking used to mean hitting an 11px box in a 7px-padded cell, which is a
 * mouse gesture that misses. Clicking anywhere in a row — the name, the empty
 * space after it, the box — toggles that row, and the three things inside a row
 * that are *not* a selection gesture stop the click themselves: the group field
 * (typing in it must not also tick it), the include toggle, and the checkbox,
 * which would otherwise fire its own `onChange` and the row's handler and end
 * where it started.
 *
 * ## And a block of rows is one gesture
 *
 * Shift-click a second row and everything between takes the first row's state —
 * `blockBetween` and `withBlock`, the same two functions UMAP's parameter list
 * and the Unmixing wizard's control list ask. Eight samples into two conditions
 * was eight clicks in a table whose rows are already in the order the blocks
 * want, and no preset could have been written to offer that: which rows are one
 * condition is exactly the question this panel exists to be told the answer to.
 *
 * ## Where *Clear every group* lives
 *
 * Under the heading of the column it clears, not in a footer. It empties the
 * Group column and nothing else, and a control's meaning is read off what it
 * sits above; from the bottom bar it read as "clear the table". The note moved
 * the opposite way, to the top, because it explains what grouping *does* and is
 * worth reading before the rows rather than after them.
 *
 * ## Nothing here infers anything
 *
 * That is unchanged and is the point of the panel existing: `suggestGroups` was
 * deleted on 2026-08-03 because it merged `…-Probe-Control` with
 * `…-Probe-TreatmentA` on their shared prefix — the part of two filenames that is the
 * same about the samples, with the condition in the part that differs. A row is
 * its own category until somebody says otherwise here.
 */
export interface GroupingRow {
  id: string;
  name: string;
  /** The assigned group, empty for none. */
  group: string;
  /** Optional, UMAP only: whether this row takes part at all. */
  included?: boolean;
}

export function GroupingTable({
  rows, groupNames, onAssign, onClearAll, onToggleIncluded, noun = 'sample', note, maxWidth = 640,
}: {
  rows: GroupingRow[];
  /** Names already in use, offered as completions so a set stays consistent. */
  groupNames: string[];
  onAssign: (ids: string[], name: string) => void;
  /** Omitted when nothing is grouped — the link has nothing to clear. */
  onClearAll?: () => void;
  onToggleIncluded?: (id: string) => void;
  noun?: string;
  note?: React.ReactNode;
  maxWidth?: number;
}) {
  const [filter, setFilter] = useState('');
  /**
   * Ticked rows, by id.
   *
   * By id and not by index, so it survives the filter, a re-sort and a row being
   * removed — the last of which is why the apply step intersects with the rows
   * that still exist rather than trusting the set.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState('');

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    // Matches the group as well as the name: "show me everything already in
    // Control" is the same question as "show me these files", and it is the one
    // that makes re-assigning a whole group a single gesture.
    return rows.filter((r) => r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q));
  }, [rows, filter]);

  const visibleIds = visible.map((r) => r.id);
  const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id));
  const someVisiblePicked = visibleIds.some((id) => picked.has(id));
  const pickedCount = rows.filter((r) => picked.has(r.id)).length;
  const grouped = rows.some((r) => r.group.trim());

  /*
     Every write to `picked` goes through the previous value, never through the
     `picked` this render closed over.

     Not a style preference — it is a correctness fix the harness found. Two
     ticks in one tick of the event loop both read the *same* stale set and the
     second write discards the first, so a rapid pair of clicks selects one row.
     React batches state updates, which is exactly what makes the closure form
     wrong here. It is also why the toggle below reads the row's state off
     `prev` rather than taking it as an argument from the render.
  */

  /*
     Where the last plain click landed, for Shift-click.

     A ref, not state: it changes on every click and nothing on screen reads it.
     Held as a **row id**, so it survives the filter changing underneath it —
     and `blockBetween` treats an id that has been filtered away as no anchor at
     all, which is the right reading when the row it would measure from is not
     on screen.
  */
  const anchor = useRef<string | null>(null);

  /**
   * Click a row, or Shift-click to take everything between.
   *
   * Putting eight samples into two conditions was eight clicks in a table whose
   * rows are already sorted into the blocks somebody wants. **Shift is tested
   * first**, as it is in the sample browser, so Ctrl+Shift extends rather than
   * falling into the toggle branch; Ctrl alone is the toggle, which is what a
   * plain click already does on a list of checkboxes.
   *
   * The anchor **does not move** on a Shift-click — the row a plain click
   * landed on stays the origin however many follow — so a range can be grown
   * and shrunk rather than ratcheting. Which rows the block covers and which
   * state it takes is `blockBetween` and `withBlock`: UMAP's parameter list and
   * the Unmixing wizard's control list ask them the same question.
   */
  const clickRow = (e: { shiftKey: boolean }, id: string) => {
    const from = anchor.current;
    const block = e.shiftKey ? blockBetween(visibleIds, from, id) : null;
    if (block && from !== null) {
      // Through `prev` for the reason above, and painted with the **anchor's**
      // state so a second Shift-click inside a block repaints it rather than
      // clearing the half it covers.
      setPicked((prev) => new Set(withBlock([...prev], block, prev.has(from))));
      return;
    }
    anchor.current = id;
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /*
     The keyboard, on the same handler. `semantics: 'none'` because this is a
     real table and a listbox whose options are table rows is a lie; the cursor
     ring is the affordance. A plain Arrow moves the cursor and leaves the ticks
     alone — these rows accumulate — so Space ticks one and Shift+Arrow paints a
     block, which is the click gesture said with keys.
  */
  const keys = useListKeys({ ordered: visibleIds, onActivate: clickRow, semantics: 'none' });

  const toggleAllVisible = () => setPicked((prev) => {
    const next = new Set(prev);
    // Clearing only clears what is *shown*, for the same reason the filter does
    // not touch the selection: the two together are how a selection is built
    // from more than one search.
    if (allVisiblePicked) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });

  const applyBulk = () => {
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    onAssign(ids, bulk.trim());
    setBulk('');
    setPicked(new Set());
  };

  return (
    <section
      data-sample-grouping=""
      className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden"
      style={{ maxWidth }}
    >
      {note && (
        <p className="p-2 hairline-b text-2xs text-[var(--text-tertiary)] leading-snug">{note}</p>
      )}

      <div className="flex items-center gap-2 p-2 hairline-b">
        <div className="relative flex-1 min-w-0">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)]" />
          <TextInput
            data-group-filter=""
            aria-label={`Filter ${noun}s by name or group`}
            placeholder={`Filter ${noun}s…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-6 text-2xs pl-6"
          />
        </div>
        <span className="text-2xs text-[var(--text-tertiary)] tnum shrink-0">
          {visible.length === rows.length
            ? `${rows.length} ${noun}${rows.length === 1 ? '' : 's'}`
            : `${visible.length} of ${rows.length}`}
        </span>
      </div>

      {/* The bulk bar appears with a selection rather than sitting there empty.
          It is the answer to fifty samples, and with nothing ticked it has
          nothing to say. */}
      {pickedCount > 0 && (
        <div data-bulk-assign="" className="flex items-center gap-2 p-2 hairline-b bg-[var(--surface-selected)]">
          <span className="text-2xs text-[var(--text-secondary)] shrink-0 tnum">{pickedCount} selected</span>
          <TextInput
            list="mcflow-group-names"
            data-bulk-group-input=""
            aria-label={`Group name for the ${pickedCount} selected ${noun}s`}
            placeholder="Group name — blank clears"
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyBulk(); }}
            className="h-6 text-2xs flex-1 min-w-0"
          />
          <Button size="sm" variant="primary" icon={<Check size={11} />} onClick={applyBulk}>
            Apply
          </Button>
          <Tooltip content="Clear the selection">
            <Button
              size="sm"
              variant="ghost"
              data-bulk-clear=""
              icon={<X size={11} />}
              onClick={() => setPicked(new Set())}
            />
          </Tooltip>
        </div>
      )}

      <datalist id="mcflow-group-names">
        {groupNames.map((n) => <option key={n} value={n} />)}
      </datalist>

      <div {...keys.containerProps} className="max-h-[260px] overflow-y-auto focus:outline-none">
        <table className="w-full text-2xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[var(--surface-base)]">
              <th className="hairline-b w-7 px-2 h-6">
                <Checkbox
                  checked={allVisiblePicked}
                  indeterminate={!allVisiblePicked && someVisiblePicked}
                  onChange={toggleAllVisible}
                  label={undefined}
                />
              </th>
              <th className="hairline-b px-1 h-6 text-left font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                <span data-col-label="">{noun.charAt(0).toUpperCase() + noun.slice(1)}</span>
              </th>
              {/* Wide enough for the heading and the clear link side by side —
                  the link is what decides the column's width, and wrapping it
                  under the heading would read as a second row of chrome. */}
              <th className="hairline-b px-2 h-6 w-[215px] text-left font-medium uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)]">
                <span className="flex items-center justify-between gap-2 whitespace-nowrap">
                  {/* Labelled separately from the clear link, so a reader — a
                      harness, a screen reader — can ask for the column's name
                      and not get the name plus a button caption. */}
                  <span data-col-label="">Group</span>
                  {grouped && onClearAll && (
                    <button
                      data-clear-groups=""
                      className="normal-case tracking-normal text-[var(--text-accent)] hover:underline"
                      onClick={() => { onClearAll(); setPicked(new Set()); }}
                    >
                      Clear every group
                    </button>
                  )}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const on = picked.has(r.id);
              const out = r.included === false;
              return (
                <tr
                  key={r.id}
                  id={keys.rowId(r.id)}
                  data-grouping-row={r.name}
                  data-picked={on ? '' : undefined}
                  data-list-cursor={keys.cursor === r.id ? '' : undefined}
                  onClick={(e) => keys.onRowClick(e, r.id)}
                  className={cn(
                    'h-7 cursor-pointer select-none',
                    on ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                    keys.cursor === r.id && 'ring-1 ring-inset ring-[var(--accent-500)]',
                    out && 'opacity-45',
                  )}
                >
                  {/* The box still works, and stops the click so the row's own
                      handler does not undo the change it just made. */}
                  <td className="hairline-b px-2 align-middle" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={on} ariaLabel={r.name} onChange={(_next, e) => keys.onRowClick(e, r.id)} />
                  </td>
                  {/* Read-only, and that is the fix: the name is a label, never
                      an input, so there is no row where it is unclear which of
                      the two fields identifies the row. */}
                  <td className="hairline-b px-1 max-w-0 truncate text-[var(--text-secondary)]" title={r.name}>
                    {onToggleIncluded && (
                      <button
                        type="button"
                        aria-pressed={!out}
                        data-umap-included={out ? undefined : ''}
                        title={out ? 'Include this file' : 'Exclude this file from the projection'}
                        onClick={(e) => { e.stopPropagation(); onToggleIncluded(r.id); }}
                        className={cn('mr-1.5 align-middle', out ? 'text-[var(--text-disabled)]' : 'text-[var(--text-accent)]')}
                      >
                        {out ? <X size={11} /> : <Check size={11} />}
                      </button>
                    )}
                    {r.name}
                  </td>
                  <td className="hairline-b px-2" onClick={(e) => e.stopPropagation()}>
                    <TextInput
                      list="mcflow-group-names"
                      aria-label={`Group for ${r.name}`}
                      data-group-input={r.name}
                      placeholder="its own category"
                      className="h-5 text-2xs"
                      // Keyed by the assigned name so an external change — the
                      // bulk bar above, or Clear every group — reaches an
                      // uncontrolled input that would otherwise keep showing
                      // whatever was last typed into it.
                      key={`${r.id}:${r.group}`}
                      defaultValue={r.group}
                      // On blur rather than per keystroke: a half-typed group
                      // name would split a category in two and redraw the chart
                      // on every letter.
                      onBlur={(e) => onAssign([r.id], e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                    />
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={3} className="px-2 py-3 text-center text-[var(--text-disabled)]">No {noun} matches that filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
