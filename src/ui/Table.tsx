import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { MIN_COLUMN_PX, minimaFor, resizeColumn, snapshotWidths, totalWidth } from './columnResize';
import { cn } from './cn';

export interface Column<R> {
  key: string;
  header: ReactNode;
  /** Cell renderer. Return a primitive for the default styling. */
  cell: (row: R, index: number) => ReactNode;
  /** Sort key extractor. Omit to make the column unsortable. */
  sortValue?: (row: R) => number | string;
  align?: 'left' | 'right' | 'center';
  /** Numeric columns get tabular monospace so digits line up column-wise. */
  numeric?: boolean;
  width?: number | string;
  /** Narrowest this column may be squeezed to. Defaults to `MIN_COLUMN_PX`. */
  minWidth?: number;
  sticky?: boolean;
  title?: string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

/**
 * A starting width that fits the longest of these strings.
 *
 * Estimated from character count rather than measured with a canvas, and the
 * estimate is the point: this is the width a column *opens* at, and it is
 * followed by a drag handle that settles any disagreement. Measuring exactly
 * would mean a hidden canvas, the loaded webfont, and a re-measure on every data
 * change, to place a value the user can move with one gesture.
 *
 * 6.15 px is Inter's average advance at `--text-sm`'s 12 px over the characters
 * these columns actually hold — digits, latin letters, hyphens and spaces. It
 * over-estimates a run of `l`s and under-estimates a run of `W`s; both are
 * within one drag.
 *
 * The cap matters more than the estimate. Without one, a single 90-character
 * filename would take the whole table and push every number off the right edge,
 * which is worse than the truncation this exists to fix.
 */
export function sizeToContent(
  values: Iterable<string>,
  { min = 96, max = 320, header = '' }: { min?: number; max?: number; header?: string } = {},
): number {
  let longest = header.length;
  for (const v of values) if (v.length > longest) longest = v.length;
  // 20 px of cell padding, plus room for the sort chevron in the heading.
  return Math.round(Math.min(max, Math.max(min, longest * 6.15 + 36)));
}

/**
 * DataTable — the statistics table primitive.
 *
 * Design notes: no zebra striping (it fights with population colour chips and
 * adds visual noise at high row counts); row separation comes from a single
 * hairline. Header is sticky, numerals are tabular, and the sort affordance is
 * only visible on hover until a column is actually sorted.
 */
export function DataTable<R>({
  rows,
  columns,
  rowKey,
  onRowClick,
  selectedKey,
  dense,
  emptyState,
  maxHeight,
  resizable,
  widths: controlledWidths,
  onWidthsChange,
  sort: controlledSort,
  onSortChange,
  className,
}: {
  rows: R[];
  columns: Column<R>[];
  rowKey: (row: R, index: number) => string;
  onRowClick?: (row: R, index: number) => void;
  selectedKey?: string;
  dense?: boolean;
  emptyState?: ReactNode;
  maxHeight?: number | string;
  /**
   * Column borders can be dragged to re-width the column to their left.
   *
   * Opt-in, and the reason it is not simply always on is that a `<td>` here is
   * `truncate max-w-0` — every cell ellipsises at whatever share of the width
   * the browser gives its column, so a name longer than its share is unreadable
   * and the only recourse was the `title` tooltip. That is the reported problem
   * with the Sample column (2026-08-04, Item 7). Dragging is the answer to it,
   * and `sizeToContent` below is the answer to needing to drag at all on the
   * first look.
   */
  resizable?: boolean;
  /**
   * Column widths, in px by column key — controlled, when a caller passes them.
   *
   * Uncontrolled by default, which is right for a table that lives as long as
   * the screen holding it. The statistics table does not: it is unmounted every
   * time the user looks at Export, so its widths are held in a store and handed
   * back here (2026-08-05, Item 4).
   */
  widths?: Record<string, number>;
  onWidthsChange?: (widths: Record<string, number>) => void;
  /** Sort state — controlled alongside `widths`, and for the same reason. */
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  className?: string;
}) {
  const [ownSort, setOwnSort] = useState<SortState>(null);
  // `undefined` means uncontrolled; `null` is a real value here — "no sort" —
  // so the two cannot be collapsed into one `??`.
  const sort = controlledSort === undefined ? ownSort : controlledSort;
  const setSort = onSortChange ?? setOwnSort;
  /**
   * Explicit widths, in px, once anything has been dragged.
   *
   * Empty until the first drag, and that is deliberate: an auto-layout table
   * fits its columns to its container, which is right until somebody disagrees.
   * The first drag captures **every** column's rendered width, not just the one
   * being dragged — otherwise the browser redistributes the remaining space
   * across the others and two columns move for one gesture.
   *
   * Used only when the caller has not supplied `widths`.
   */
  const [ownWidths, setOwnWidths] = useState<Record<string, number>>({});
  const widths = controlledWidths ?? ownWidths;
  const headRef = useRef<HTMLTableRowElement>(null);

  /*
     One live callback, read by the pointermove closure.

     The drag installs its listeners once and they run for the life of the
     gesture; capturing `onWidthsChange` directly would pin whichever function
     identity existed at pointerdown, and a parent that re-creates its handler
     each render — which a store-backed one does — would have its later writes
     going to a callback nobody is listening to any more.
  */
  const commit = useRef<(w: Record<string, number>) => void>(() => {});
  useEffect(() => {
    commit.current = (w) => {
      if (onWidthsChange) onWidthsChange(w);
      else setOwnWidths(w);
    };
  }, [onWidthsChange]);

  const fixed = Object.keys(widths).length > 0;
  const minima = useMemo(() => minimaFor(columns), [columns]);

  const beginResize = useCallback((index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cells = headRef.current?.querySelectorAll('th');
    if (!cells) return;

    /*
       The starting widths, measured rather than read back from state.

       Measured because until the first drag there is no state to read — auto
       layout has decided the widths and the numbers exist only in the rendered
       cells. And raised to each column's minimum on the way in, so the resize
       arithmetic never starts from a width it considers illegal. See
       `snapshotWidths`.
    */
    const rendered = columns.map((_, i) => cells[i]?.getBoundingClientRect().width ?? MIN_COLUMN_PX);
    const snapshot = snapshotWidths(rendered, minima);
    const startX = e.clientX;

    /*
       Listeners on `window`, not pointer capture on the handle.

       The header is inside an `overflow: auto` scroller and the pointer
       routinely leaves the 7 px handle within the first few pixels of the drag;
       capture on an element that the browser may re-layout under the cursor is
       the mechanism this project has already been bitten by twice — see the gate
       resize handles in PROGRESS.md under *Traps*.
    */
    const move = (ev: PointerEvent) => {
      // Always from the snapshot and the total travel, never from the previous
      // frame — which is what makes a drag out and back land exactly home even
      // when the way out took space from three columns. See `resizeColumn`.
      const next = resizeColumn(snapshot, minima, index, ev.clientX - startX);
      const record: Record<string, number> = {};
      columns.forEach((c, i) => { record[c.key] = next[i]!; });
      commit.current(record);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // On the body, so the cursor stays a resize arrow while the pointer is out
    // over the rows rather than flickering back to the row's own cursor.
    document.body.style.cursor = 'col-resize';
  }, [columns, minima]);

  /**
   * How wide the table is laid out, once widths are explicit.
   *
   * The sum, with `min-width: 100%` under it. Two regimes fall out of that pair
   * and both are wanted: while the columns fit, the sum *is* the container and
   * the table simply fills it; once a drag has run the columns past what the
   * panel can hold — every one of them at its minimum and still too wide — the
   * sum exceeds the container and the scroller shows a horizontal bar.
   *
   * What cannot happen either way is a column with no way to reach it. That was
   * the reported defect: the table grew by the drag distance with every other
   * width left alone, so the rightmost columns went past the panel edge, and the
   * table was still `width: 100%` — so there was nothing to scroll.
   */
  /**
   * The width to lay a column out at, for a column that has one.
   *
   * A stored map can be missing a key: the statistics table grows a statistic
   * column when a parameter is chosen, and a width map captured before that
   * knows nothing about it. Falling back to the column's own declared width —
   * when that is a number — opens it at the size it was designed for rather than
   * at the resize floor, and only then at the floor.
   */
  const widthOf = useCallback(
    (c: Column<R>) => widths[c.key] ?? (typeof c.width === 'number' ? c.width : MIN_COLUMN_PX),
    [widths],
  );

  const laidOut = fixed ? totalWidth(columns.map(widthOf)) : undefined;

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (typeof va === 'number' && typeof vb === 'number') {
        // NaN sorts last regardless of direction — a missing stat is not a low stat.
        if (Number.isNaN(va)) return 1;
        if (Number.isNaN(vb)) return -1;
        return (va - vb) * mult;
      }
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * mult;
    });
  }, [rows, columns, sort]);

  // Computed from the current value rather than passed as an updater: a
  // controlled `setSort` is the parent's plain setter and takes a value, not a
  // function of the previous one.
  const toggleSort = (key: string) =>
    setSort(sort?.key !== key ? { key, dir: 'desc' } : sort.dir === 'desc' ? { key, dir: 'asc' } : null);

  const rowH = dense ? 'h-[22px]' : 'h-[var(--h-row)]';

  return (
    <div
      className={cn('relative overflow-auto min-h-0', className)}
      style={{ maxHeight }}
    >
      {/* `table-fixed` only once something has been dragged. Auto layout is the
          better default — it fits the content — and it is also the layout that
          *ignores* a width the user has just set, because it treats one as a
          suggestion to be traded off against the others.

          `w-full` goes with it, replaced by an explicit width and a 100% floor:
          a table pinned at `width: 100%` cannot be scrolled to, because there is
          never anything past its right edge to scroll to. */}
      <table
        data-table-width={laidOut}
        style={laidOut === undefined ? undefined : { width: laidOut, minWidth: '100%' }}
        className={cn('border-collapse text-xs', fixed ? 'table-fixed' : 'w-full')}
      >
        <thead className="sticky top-0 z-10">
          <tr ref={headRef}>
            {columns.map((c, ci) => {
              const active = sort?.key === c.key;
              const sortable = !!c.sortValue;
              const w = fixed ? widthOf(c) : undefined;
              return (
                <th
                  key={c.key}
                  scope="col"
                  title={c.title}
                  data-column={c.key}
                  style={{ width: w ?? c.width, minWidth: w }}
                  className={cn(
                    'group relative bg-[var(--surface-base)] hairline-b px-2 h-7 font-medium whitespace-nowrap',
                    'text-2xs uppercase tracking-[var(--tracking-wide)]',
                    active ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
                    c.align === 'right' || c.numeric ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.sticky && 'sticky left-0 z-20',
                  )}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={cn(
                        'inline-flex items-center gap-1 max-w-full hover:text-[var(--text-primary)] transition-colors duration-[var(--dur-fast)]',
                        c.align === 'right' || c.numeric ? 'flex-row-reverse' : '',
                      )}
                    >
                      <span className="truncate">{c.header}</span>
                      {active ? (
                        sort.dir === 'asc' ? <ArrowUp size={10} className="shrink-0" /> : <ArrowDown size={10} className="shrink-0" />
                      ) : (
                        <ChevronsUpDown
                          size={10}
                          className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity duration-[var(--dur-fast)]"
                        />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                  {/* The grip sits on the boundary, half in each column, and is
                      7 px of target around a 1 px line — the same "small ink,
                      real target" rule the gate handles follow. The last column
                      has no boundary to its right that means anything, so it
                      gets none. */}
                  {resizable && ci < columns.length - 1 && (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize column`}
                      data-column-resize={c.key}
                      onPointerDown={(e) => beginResize(ci, e)}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        'absolute top-0 -right-[3px] z-10 h-full w-[7px] cursor-col-resize select-none',
                        'after:absolute after:inset-y-1 after:left-[3px] after:w-px after:rounded-full',
                        'after:bg-transparent hover:after:bg-[var(--border-strong)]',
                        'after:transition-colors after:duration-[var(--dur-fast)]',
                      )}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const key = rowKey(row, i);
            const selected = key === selectedKey;
            return (
              <tr
                key={key}
                onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                className={cn(
                  rowH,
                  'transition-colors duration-[var(--dur-instant)]',
                  onRowClick && 'cursor-pointer',
                  selected ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={{ width: fixed ? widthOf(c) : c.width }}
                    className={cn(
                      'px-2 hairline-b truncate',
                      // `max-w-0` is what makes `truncate` bite under auto
                      // layout; under `table-fixed` the column width already
                      // does, and keeping it would collapse every explicit width
                      // back to nothing.
                      !fixed && 'max-w-0',
                      c.numeric && 'font-mono tnum',
                      c.align === 'right' || c.numeric ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                      c.sticky && cn('sticky left-0 z-[1]', selected ? 'bg-[var(--surface-raised)]' : 'bg-[var(--surface-base)]'),
                    )}
                  >
                    {c.cell(row, i)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length === 0 && emptyState}
    </div>
  );
}
