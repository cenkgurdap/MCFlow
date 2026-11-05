import { useRef } from 'react';
import { nodeState, type PopulationNode } from '@/core/export';
import { blockBetween } from '@/core/rangeSelect';
import { Checkbox } from '@/ui/Field';
import { useListKeys } from '@/ui/useListKeys';
import { Badge } from '@/ui/Feedback';
import { InfoHint } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

/**
 * Which populations an action applies to — a checkbox tree over the gating
 * hierarchy.
 *
 * Built for the Full Gate Export and **shared with the statistics table** since
 * 2026-08-02. Extracting it rather than writing a second one is the whole point:
 * this is the fourth surface in the app that shows a gating tree — the sidebar,
 * the export dialog, the statistics table and the comparison chart's population
 * list — and a second pattern for "choose some populations" would be a second
 * thing to learn for a question the user has already answered once.
 *
 * The three cases both callers need fall out of one control: one gate is one
 * checkbox, several are several, and every gate is what it opens as. Checking a
 * parent takes its subtree — the common request — and a half-checked parent
 * renders `mixed` and completes rather than clears on the next click, because
 * completing is the state anyone reaching for it wants.
 *
 * **Any node at any depth**, which is the property the statistics table did not
 * have: it offered a *Terminal populations only* checkbox, so the choice was
 * all-or-leaves and an intermediate population could not be compared against its
 * own children. A parent population is a real population, not a folder.
 *
 * The rows carry a **sample count** because the tree is the union across
 * samples, not one sample's hierarchy. A population that exists on five of six
 * is exactly the case that shows up later as a missing row, and it should be
 * visible before the action runs rather than only afterwards.
 *
 * ## The whole row is the checkbox, and Shift takes a block
 *
 * Both for the reason the grouping table already records: an 11 px box in a
 * padded cell is a mouse gesture that misses, and ticking a dozen populations
 * out of a real tree is a dozen clicks. Clicking anywhere in a row toggles it;
 * Shift-clicking a second row takes everything between, off `blockBetween` —
 * the one rule every list in the application asks.
 *
 * **A Shift-range takes exactly the rows it covers. A plain click still takes
 * the subtree.** The two are different questions and the difference is visible:
 * a parent whose children fall outside the block renders `mixed`, which this
 * control already draws. Cascading a range would mean "everything between"
 * silently reached past the row the pointer was on, which is not what the
 * gesture says.
 */
export function PopulationPicker({
  tree, selected, everything, sampleCount, label = 'Populations', hint, countLabel = 'events',
  kind = 'population', onToggle, onSelectBlock, onAll, onNone,
}: {
  tree: PopulationNode[];
  selected: ReadonlySet<string>;
  /** Nothing has been narrowed — renders as "All" rather than "n of n". */
  everything: boolean;
  sampleCount: number;
  label?: string;
  hint?: string;
  /** What the right-hand number on each row counts, for the tooltip. */
  countLabel?: string;
  /**
   * What the rows are. `'sample'` is the same control over a flat list of
   * samples — which ones Statistics and Export are about — and marks itself
   * `data-sample-choice` / `data-sample-choice-row` so nothing looking for the
   * population tree finds it instead.
   */
  kind?: 'population' | 'sample';
  onToggle: (path: string) => void;
  /**
   * Shift-click: put a whole block of rows into one state.
   *
   * Optional — without it Shift falls through to a plain click, which is also
   * what happens when there is no anchor to measure from.
   */
  onSelectBlock?: (paths: string[], on: boolean) => void;
  onAll: () => void;
  onNone: () => void;
}) {
  const chosen = tree.filter((n) => selected.has(n.path)).length;
  /*
     Where the last plain click landed. A ref, not state — nothing on screen
     reads it, and re-rendering a tree to record it would be the whole tree
     redrawn to store a string. Held as a path, which is what the rows are keyed
     by everywhere else in the application.
  */
  const anchor = useRef<string | null>(null);

  /**
   * Click a row, or Shift-click to take everything between.
   *
   * Shift is tested first, as it is everywhere else, so Ctrl+Shift extends
   * rather than falling into the toggle branch. The anchor does not move on a
   * Shift-click, and the block takes the **anchor's** state, so a second one
   * inside a block repaints rather than inverting its first half.
   */
  const clickRow = (e: { shiftKey: boolean }, path: string) => {
    const from = anchor.current;
    const block = e.shiftKey && onSelectBlock
      ? blockBetween(tree.map((n) => n.path), from, path)
      : null;
    if (block && from !== null) {
      onSelectBlock!(block, selected.has(from));
      return;
    }
    anchor.current = path;
    onToggle(path);
  };

  // The keyboard, on the same handler the pointer calls. These rows accumulate,
  // so a plain Arrow only moves the cursor: Space ticks one, Shift+Arrow paints
  // a block.
  const keys = useListKeys({ ordered: tree.map((n) => n.path), onActivate: clickRow });

  return (
    <section className="space-y-2" {...(kind === 'sample' ? { 'data-sample-choice': '' } : { 'data-population-picker': '' })}>
      <div className="flex items-center gap-2">
        <p className="eyebrow flex items-center gap-1.5">
          {label}
          {hint && <InfoHint content={hint} />}
        </p>
        <Badge tone={chosen === 0 ? 'warn' : 'accent'}>
          {everything ? 'All' : `${chosen} of ${tree.length}`}
        </Badge>
        <span className="ml-auto flex items-center gap-1.5">
          <button
            onClick={onAll}
            disabled={everything}
            className={cn(
              'text-2xs',
              everything ? 'text-[var(--text-disabled)] cursor-default' : 'text-[var(--text-accent)] hover:underline',
            )}
          >
            Select all
          </button>
          <span className="text-2xs text-[var(--text-disabled)]">·</span>
          <button
            onClick={onNone}
            disabled={chosen === 0}
            className={cn(
              'text-2xs',
              chosen === 0 ? 'text-[var(--text-disabled)] cursor-default' : 'text-[var(--text-accent)] hover:underline',
            )}
          >
            Select none
          </button>
        </span>
      </div>

      <div
        {...keys.containerProps}
        aria-label={label}
        className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] max-h-[240px] overflow-y-auto p-1 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-500)]"
      >
        {tree.map((node) => {
          const state = nodeState(tree, selected, node.path);
          return (
            <div
              key={node.path}
              id={keys.rowId(node.path)}
              role="option"
              aria-selected={state === 'on'}
              {...(kind === 'sample' ? { 'data-sample-choice-row': node.path } : { 'data-population-row': node.path })}
              data-list-cursor={keys.cursor === node.path ? '' : undefined}
              onClick={(e) => keys.onRowClick(e, node.path)}
              className={cn(
                'flex items-center gap-2 h-6 pr-2 rounded-[var(--radius-xs)] cursor-pointer select-none hover:bg-[var(--surface-hover)]',
                keys.cursor === node.path && 'ring-1 ring-inset ring-[var(--accent-500)]',
              )}
              style={{ paddingLeft: 6 + node.depth * 14 }}
            >
              {/* The box keeps the role and the state a reader asks for, and
                  stops the click so the row's own handler does not undo the
                  change it just made. The name is drawn beside it rather than
                  passed as `label`: a label forwards its click to the button as
                  a simulated one, and a gesture that reads Shift cannot be built
                  on an event nothing guarantees carries it. See `Checkbox`. */}
              <Checkbox
                checked={state === 'on'}
                indeterminate={state === 'mixed'}
                ariaLabel={node.name}
                onChange={(_next, e) => { e.stopPropagation(); keys.onRowClick(e, node.path); }}
              />
              <span className="text-2xs truncate max-w-[280px] text-[var(--text-secondary)]">{node.name}</span>
              {/* Only when it is not on every sample. A badge on every row would
                  say nothing; a badge on the one row that differs is the whole
                  message. */}
              {node.sampleCount < sampleCount && (
                <Badge tone="warn">{node.sampleCount} of {sampleCount}</Badge>
              )}
              <span
                className="ml-auto font-mono tnum text-2xs text-[var(--text-tertiary)] shrink-0"
                title={`${node.eventCount.toLocaleString()} ${countLabel}`}
              >
                {node.eventCount.toLocaleString()}
              </span>
            </div>
          );
        })}
        {tree.length === 0 && (
          <p className="px-2 py-2 text-2xs text-[var(--text-disabled)]">
            {kind === 'sample' ? 'No samples loaded.' : 'No populations yet. Draw a gate and it appears here.'}
          </p>
        )}
      </div>
    </section>
  );
}
