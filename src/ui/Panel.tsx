import { useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn';

/**
 * Panel — a docked region of the IDE-style shell. Panels are flush surfaces
 * separated by hairlines, never floating cards with shadows.
 */
export function Panel({
  children,
  className,
  surface = 'base',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  surface?: 'sunken' | 'base' | 'raised';
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const bg =
    surface === 'sunken'
      ? 'bg-[var(--surface-sunken)]'
      : surface === 'raised'
        ? 'bg-[var(--surface-raised)]'
        : 'bg-[var(--surface-base)]';
  return (
    <div className={cn('flex flex-col min-h-0 min-w-0', bg, className)} {...rest}>
      {children}
    </div>
  );
}

/** Fixed-height panel header. Title left, actions right. */
export function PanelHeader({
  title,
  count,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  /** Rendered as a muted numeral after the title, e.g. sample count. */
  count?: number | string;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-center gap-2 h-8 px-2.5 shrink-0 hairline-b select-none',
        className,
      )}
    >
      {/* The accent, not the neutral tertiary it was until 2026-08-10. A panel
          header carries one 12 px glyph and one uppercase label; in the neutral
          ramp the glyph is the same weight as the rule under it and reads as
          part of the hairline. It is the smallest place the accent can say
          "this is a region heading" without colouring the words. */}
      {icon && <span className="text-[var(--text-accent)] shrink-0">{icon}</span>}
      <h2 className="eyebrow truncate">{title}</h2>
      {count !== undefined && (
        <span className="text-2xs font-mono tnum text-[var(--text-disabled)]">{count}</span>
      )}
      <div className="ml-auto flex items-center gap-0.5 shrink-0">{actions}</div>
    </header>
  );
}

/**
 * Collapsible section inside a panel. Used throughout the inspector so every
 * property group behaves identically.
 */
export function PanelSection({
  title,
  children,
  defaultOpen = true,
  actions,
  dense,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
  dense?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('hairline-b last:border-b-0', className)}>
      <div className="flex items-center gap-1 h-7 pl-1.5 pr-2 group">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1 flex-1 min-w-0 text-left rounded-[var(--radius-xs)] hover:bg-[var(--surface-hover)] h-full px-1 -mx-0.5 transition-colors duration-[var(--dur-fast)]"
        >
          <ChevronRight
            size={12}
            className={cn(
              'shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
              open && 'rotate-90',
            )}
          />
          <span className="eyebrow truncate">{title}</span>
        </button>
        {actions && (
          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-[var(--dur-fast)]">
            {actions}
          </div>
        )}
      </div>
      {open && (
        <div className={cn('anim-fade', dense ? 'px-2 pb-2 space-y-1' : 'px-2.5 pb-3 space-y-2.5')}>
          {children}
        </div>
      )}
    </section>
  );
}

/** A labelled key/value row for read-only metadata display. */
export function MetaRow({
  label,
  value,
  mono = true,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 min-h-[18px]">
      <span className="text-2xs text-[var(--text-tertiary)] shrink-0 w-[92px] truncate">{label}</span>
      <span
        title={title}
        className={cn(
          'text-xs text-[var(--text-primary)] min-w-0 truncate',
          mono && 'font-mono tnum',
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Thin vertical rule for separating toolbar groups. */
export function VDivider({ className }: { className?: string }) {
  return <div className={cn('w-px h-4 bg-[var(--border-default)] shrink-0', className)} />;
}
