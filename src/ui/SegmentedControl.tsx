import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface Segment<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
  /**
   * Put a gap and a rule in front of this segment.
   *
   * For a control whose segments are not all peers. The view switcher is the one
   * that needs it: Analysis → Parameters → Unmixing → Statistics → Export is a
   * sequence — each is a stage of the work done with every file — and Biophysics
   * is a guided analysis that runs *on top of* that sequence rather than being
   * the step after Export. Rendered as a real separator element between two
   * buttons, so the sliding indicator's measured geometry is unaffected: it
   * reads `offsetLeft` off the buttons themselves and does not care what sits
   * between them.
   *
   * Deliberately not a "group" API taking arrays of segments. One optional flag
   * on the segment that starts the second group says the same thing, costs
   * nothing at every other call site, and cannot produce an empty group.
   */
  gapBefore?: boolean;
}

/**
 * Segmented control — for switching between a small set of mutually exclusive
 * modes (Scatter / Density / Histogram, Raw / Unmixed).
 *
 * Segments size to their own content; the sliding indicator is positioned from
 * measured geometry rather than an assumed equal split. Forcing equal widths
 * looks tidy in a mock but truncates real labels the moment one option is
 * longer than the others ("Conventional" vs "Spectral").
 */
export function SegmentedControl<T extends string>({
  value,
  segments,
  onChange,
  size = 'md',
  tone = 'neutral',
  fullWidth,
  iconOnly,
  className,
  name,
}: {
  value: T;
  segments: Segment<T>[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  /**
   * How the selected segment is coloured.
   *
   * `neutral` — a raised chip in the neutral ramp, which is right for a control
   * sitting *inside* a plot panel, where the accent is already spoken for by the
   * panel's own selection state and by every armed gate tool.
   *
   * `accent` — the lilac wash and accent text. Opt-in rather than the default
   * (2026-08-10) because "which view am I in" is the one segmented control in
   * the app that is a piece of top-level navigation rather than a setting, and a
   * navigation tab that is a slightly lighter grey than the tab beside it does
   * not say where you are. Every other instance of this component is a setting
   * and stays neutral; recolouring all of them would make the accent mean
   * "selected", which is what the neutral chip already means.
   */
  tone?: 'neutral' | 'accent';
  /** Stretch to fill the container, splitting remaining space evenly. */
  fullWidth?: boolean;
  /**
   * Show each segment's icon and drop its text.
   *
   * For a control that has to survive a container too narrow for its labels — the
   * plot-type switch in a compact panel toolbar, where the alternative is the
   * row overflowing and clipping whatever is last in it. The label is kept as the
   * accessible name and, with `title`, as the tooltip, so nothing is lost except
   * the pixels. A segment with no icon still renders its label, because an empty
   * button is worse than a wide one.
   */
  iconOnly?: boolean;
  className?: string;
  /**
   * Emitted as `data-segmented`, so a control can be found by what it is for.
   * Several of these exist on screen at once — the view switcher, the plot type,
   * the acquisition override — and they are otherwise indistinguishable to
   * anything looking at the DOM from outside.
   */
  name?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);

  const activeIdx = Math.max(0, segments.findIndex((s) => s.value === value));

  useLayoutEffect(() => {
    const measure = () => {
      const btn = btnRefs.current[activeIdx];
      const list = listRef.current;
      if (!btn || !list) return;
      setInd({ left: btn.offsetLeft, width: btn.offsetWidth });
    };
    measure();
    // Re-measure when the container resizes (panel drag) or fonts finish loading.
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    for (const b of btnRefs.current) if (b) ro.observe(b);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => ro.disconnect();
  }, [activeIdx, segments.length]);

  const h = size === 'sm' ? 'h-6' : 'h-[var(--h-control)]';

  return (
    <div
      ref={listRef}
      role="tablist"
      data-segmented={name}
      className={cn(
        'relative inline-flex items-stretch p-0.5 rounded-[var(--radius-sm)] shrink-0',
        'bg-[var(--surface-sunken)] border border-[var(--border-subtle)]',
        fullWidth && 'flex w-full',
        h,
        className,
      )}
    >
      {ind && (
        <div
          aria-hidden
          className={cn(
            'absolute top-0.5 bottom-0.5 rounded-[var(--radius-xs)] border',
            'transition-[transform,width] duration-[var(--dur-normal)] ease-[var(--ease-emphasis)]',
            tone === 'accent'
              ? 'bg-[var(--surface-selected)] border-[var(--accent-500)]/45'
              : 'bg-[var(--surface-raised)] border-[var(--border-default)]',
          )}
          style={{ transform: `translateX(${ind.left}px)`, width: ind.width, left: 0 }}
        />
      )}
      {segments.map((s, i) => {
        const active = s.value === value;
        const hideLabel = !!iconOnly && !!s.icon;
        const button = (
          <button
            key={s.value}
            ref={(el) => { btnRefs.current[i] = el; }}
            role="tab"
            aria-selected={active}
            disabled={s.disabled}
            title={s.title}
            // The label survives as the accessible name when the text is hidden;
            // an icon-only tab that announces nothing is a tab nobody can use.
            aria-label={hideLabel && typeof s.label === 'string' ? s.label : undefined}
            onClick={() => onChange(s.value)}
            className={cn(
              'relative z-10 flex items-center justify-center gap-1.5 min-w-0',
              hideLabel ? 'px-1' : 'px-2.5',
              'text-2xs whitespace-nowrap rounded-[var(--radius-xs)] select-none',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
              fullWidth && 'flex-1',
              active
                ? cn('font-medium', tone === 'accent' ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]')
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
              s.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {s.icon}
            {!hideLabel && <span className={cn(fullWidth && 'truncate')}>{s.label}</span>}
          </button>
        );
        if (!s.gapBefore || i === 0) return button;
        return (
          <div key={`g${s.value}`} className="contents">
            <span
              aria-hidden
              data-segment-gap=""
              // The rule is inset vertically so it reads as a separator between
              // two groups rather than as a full-height edge, which at this size
              // would look like the border of a second control.
              className="relative z-10 self-stretch my-[3px] mx-1.5 w-px shrink-0 bg-[var(--border-default)]"
            />
            {button}
          </div>
        );
      })}
    </div>
  );
}

/** Underline tabs — for top-level view switching where segments would be too heavy. */
export function Tabs<T extends string>({
  value,
  tabs,
  onChange,
  className,
}: {
  value: T;
  tabs: { value: T; label: ReactNode; badge?: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex items-stretch gap-0 h-8 hairline-b', className)}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              'relative flex items-center gap-1.5 px-3 text-xs whitespace-nowrap select-none',
              'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
              // Accent text on the active tab, matching the top-bar view
              // switcher. These are the app's other navigation surface — the
              // Unmixing panel's two tabs, the statistics table/compare split —
              // and the underline beneath them was already `--accent-500`, so
              // the label was the only part of an active tab still neutral.
              active
                ? 'text-[var(--text-accent)] font-medium'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
            )}
          >
            {t.label}
            {t.badge}
            <span
              aria-hidden
              className={cn(
                'absolute left-2 right-2 bottom-0 h-[1.5px] rounded-full transition-opacity duration-[var(--dur-normal)]',
                active ? 'bg-[var(--accent-500)] opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
