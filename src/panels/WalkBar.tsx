import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Circle } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@/ui/Button';
import { Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { useKeepTabVisible } from './useKeepTabVisible';

/**
 * A tab per generated worksheet, along the bottom of the plot canvas.
 *
 * ## Why this shape at all
 *
 * The layout dropdown in the top bar reaches the same worksheets and is the
 * wrong instrument for this job. It answers *"which of this workspace's layouts
 * am I in"* — a set with no order and no end — from the far corner of the
 * window. Walking a generated set is a sequence of near-identical pages with a
 * defined order and a defined finish, and the convention for that, in this
 * software's own field, is a strip of tabs and a page counter at the bottom of
 * the page.
 *
 * ## Why it is a component rather than two
 *
 * The unmixing wizard has had this strip since 2026-08-07 and the Biophysics
 * pipeline needs the identical thing: prev/next, first/last, a counter, a tab
 * per item with a done marker, and a strip that scrolls to keep the active tab
 * in view. Writing it twice would be 190 lines of JSX in two files that agree on
 * the day they are written — and this project has spent several passes removing
 * exactly that arrangement.
 *
 * So the *presentation* is here and the two bindings are thin: `ControlWalkBar`
 * and `BiophysicsWalkBar` each read their own store, decide whether they own the
 * bottom of the worksheet, and hand this a list. Nothing about the unmixing
 * wizard's behaviour changed when it moved — including every `data-` attribute
 * end-to-end tests drive it by, which is why `testId` exists.
 *
 * ## One current worksheet, several ways to change it
 *
 * Which tab is active is **not** held here. The caller derives it from
 * `activeLayoutId`, because the layout dropdown switches worksheets and knows
 * nothing about either panel — so a worksheet chosen up there would otherwise
 * leave this strip highlighting a different item and the counter reading a
 * different number. Both write the same state and both read it back.
 */
export interface WalkItem {
  /** Stable key, and what the tab is found by from outside. */
  id: string;
  label: string;
  /** Whether this item's work is finished, which decides the tick or the ring. */
  done: boolean;
  /** Appended to the tab's tooltip after the label — a peak detector, a count. */
  detail?: string;
}

export function WalkBar({
  items, index, onGo, testId, tabAttr, itemNoun, leading, trailing,
}: {
  items: WalkItem[];
  /** Position in `items` of the worksheet on screen. Derived, never held here. */
  index: number;
  onGo: (index: number) => void;
  /** The bar's own marker, so a harness can find this strip and not the other. */
  testId: string;
  /** Attribute each tab carries, valued with its label. Same reason. */
  tabAttr: string;
  /** What one item is called, for the button labels: "control", "sample". */
  itemNoun: string;
  /**
   * Rendered before the arrows — for a caller with a second question to ask.
   *
   * The Biophysics pipeline has two kinds of worksheet and this strip walks
   * both, so it needs to say *which kind you are in* as well as *which sample*.
   * Those are orthogonal: the segment names the worksheet, the tabs name the
   * file, and each keeps the other's answer when it changes. A slot rather than
   * a `family` prop because that is the only thing about it this component has
   * any business knowing — the unmixing wizard walks one kind and passes
   * nothing, exactly as it did before this existed.
   */
  leading?: ReactNode;
  /** The right-hand summary — "9/13 gated". Rendered as given. */
  trailing?: ReactNode;
}) {
  /*
     Above any early return the caller might want: a hook cannot be called
     conditionally, and this is the one hook here. The callers do their own
     "should I render at all" check before mounting this, so there is no early
     return in this component — which is the arrangement that makes that safe.
  */
  const stripRef = useKeepTabVisible<HTMLDivElement>(index, items.length, '[data-walk-tab-active]');

  return (
    <div
      {...{ [testId]: '' }}
      data-walk-bar=""
      className="flex items-center gap-1.5 h-9 px-2 shrink-0 hairline-t bg-[var(--surface-sunken)]"
    >
      {leading}

      {/*
         Four buttons, not two, and the outer pair is what this bar was missing
         until 2026-08-11. A generated set is a *sequence* — that is the whole
         argument for a tab strip and a page counter rather than the layout
         dropdown — and the two comparisons somebody makes constantly in a
         sequence are with the neighbour and with the ends. Stepping through nine
         intermediate worksheets to put the first and last side by side is
         eighteen clicks for a glance, and every one of them re-renders plots
         over a 300 000-event file.

         `onGo` is expected to clamp, so first and last need no arithmetic here —
         and they are disabled at the ends rather than wrapping, because a strip
         with a defined finish should not quietly restart.
      */}
      <Tooltip content={`First ${itemNoun}`}>
        <span>
          <IconButton
            label={`First ${itemNoun}`}
            size="sm"
            data-walk-bar-first=""
            disabled={index <= 0}
            onClick={() => onGo(0)}
          >
            <ChevronsLeft size={14} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip content={`Previous ${itemNoun}`}>
        <span>
          <IconButton
            label={`Previous ${itemNoun}`}
            size="sm"
            data-walk-bar-prev=""
            disabled={index <= 0}
            onClick={() => onGo(index - 1)}
          >
            <ChevronLeft size={14} />
          </IconButton>
        </span>
      </Tooltip>
      <span
        className="shrink-0 px-1.5 text-2xs font-mono tnum text-[var(--text-secondary)]"
        data-walk-bar-counter=""
        title={`${items.filter((i) => i.done).length} of ${items.length} ${itemNoun}s done`}
      >
        {index + 1} / {items.length}
      </span>
      <Tooltip content={`Next ${itemNoun}`}>
        <span>
          <IconButton
            label={`Next ${itemNoun}`}
            size="sm"
            data-walk-bar-next=""
            disabled={index >= items.length - 1}
            onClick={() => onGo(index + 1)}
          >
            <ChevronRight size={14} />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip content={`Last ${itemNoun}`}>
        <span>
          <IconButton
            label={`Last ${itemNoun}`}
            size="sm"
            data-walk-bar-last=""
            disabled={index >= items.length - 1}
            onClick={() => onGo(items.length - 1)}
          >
            <ChevronsRight size={14} />
          </IconButton>
        </span>
      </Tooltip>

      {/* The tabs scroll rather than shrink. Eleven items at a legible width is
          wider than the worksheet on a laptop, and a tab strip that squeezes
          every label to four characters has stopped being a way of finding the
          one you want. */}
      <div ref={stripRef} className="flex-1 min-w-0 flex items-stretch gap-px overflow-x-auto">
        {items.map((item, i) => {
          const active = i === index;
          return (
            <button
              key={item.id}
              type="button"
              {...{ [tabAttr]: item.label }}
              data-walk-tab-active={active ? '' : undefined}
              title={`${item.label}${item.detail ? ` · ${item.detail}` : ''}`}
              onClick={() => onGo(i)}
              className={cn(
                'group shrink-0 max-w-[190px] flex items-center gap-1.5 px-2 h-7 self-center rounded-[var(--radius-xs)]',
                'text-2xs whitespace-nowrap transition-colors duration-[var(--dur-fast)]',
                active
                  ? 'bg-[var(--surface-selected)] text-[var(--text-primary)]'
                  : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
              )}
            >
              {/*
                 A tick when the item is done, an empty ring when it is not —
                 and **not a warning** (2026-08-19). It was an amber
                 `AlertTriangle`, which was defensible while this strip only
                 appeared on the step where every item should already be
                 finished. It now appears from the first step of both walks, so
                 the ordinary opening state of the application was a row of
                 orange alerts against work nobody had been asked to do yet — a
                 10 px triangle-with-a-bang that was reported as a broken glyph
                 rather than read as a warning, which is the correct reading of
                 a warning about nothing. Not-yet-done is neutral; only a real
                 problem earns a colour.
              */}
              <span className={cn('shrink-0', item.done ? 'text-[var(--status-ok)]' : 'text-[var(--text-disabled)]')}>
                {item.done ? <Check size={10} /> : <Circle size={8} />}
              </span>
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      {trailing && (
        <span className="shrink-0 pl-1.5 text-2xs text-[var(--text-tertiary)] tnum">{trailing}</span>
      )}
    </div>
  );
}
