import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from './cn';

/* ---------------------------------------------------------------------------
   Badge / Pill
   ------------------------------------------------------------------------ */
type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info';

const TONE_BADGE: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-active)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-500)]/15 text-[var(--text-accent)]',
  ok: 'bg-[var(--status-ok-bg)] text-[var(--status-ok)]',
  warn: 'bg-[var(--status-warn-bg)] text-[var(--status-warn)]',
  err: 'bg-[var(--status-err-bg)] text-[var(--status-err)]',
  info: 'bg-[var(--status-info-bg)] text-[var(--status-info)]',
};

export function Badge({
  children,
  tone = 'neutral',
  mono,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 h-4 px-1.5 rounded-[var(--radius-xs)] text-2xs font-medium whitespace-nowrap select-none',
        mono && 'font-mono tnum',
        TONE_BADGE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small colour chip identifying a population. Square, not circular — reads
 *  as a swatch tied to plotted data rather than a status dot. */
export function ColorChip({ color, size = 9, className }: { color: string; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-[2px]', className)}
      style={{ width: size, height: size, background: color, boxShadow: `0 0 0 1px ${color}55` }}
    />
  );
}

/* ---------------------------------------------------------------------------
   Callout — inline explanatory / warning block
   ------------------------------------------------------------------------ */
const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <Info size={13} />,
  accent: <Info size={13} />,
  info: <Info size={13} />,
  ok: <CheckCircle2 size={13} />,
  warn: <AlertTriangle size={13} />,
  err: <XCircle size={13} />,
};

const TONE_CALLOUT: Record<Tone, string> = {
  neutral: 'bg-[var(--surface-raised)] border-[var(--border-default)] text-[var(--text-secondary)]',
  accent: 'bg-[var(--accent-500)]/8 border-[var(--accent-500)]/25 text-[var(--text-secondary)]',
  info: 'bg-[var(--status-info-bg)] border-[var(--status-info)]/25 text-[var(--text-secondary)]',
  ok: 'bg-[var(--status-ok-bg)] border-[var(--status-ok)]/25 text-[var(--text-secondary)]',
  warn: 'bg-[var(--status-warn-bg)] border-[var(--status-warn)]/25 text-[var(--text-secondary)]',
  err: 'bg-[var(--status-err-bg)] border-[var(--status-err)]/25 text-[var(--text-secondary)]',
};

const TONE_FG: Record<Tone, string> = {
  neutral: 'text-[var(--text-tertiary)]',
  accent: 'text-[var(--text-accent)]',
  info: 'text-[var(--status-info)]',
  ok: 'text-[var(--status-ok)]',
  warn: 'text-[var(--status-warn)]',
  err: 'text-[var(--status-err)]',
};

export function Callout({
  tone = 'neutral',
  title,
  children,
  actions,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex gap-2.5 p-2.5 rounded-[var(--radius-md)] border text-xs leading-snug',
        TONE_CALLOUT[tone],
        className,
      )}
    >
      <span className={cn('shrink-0 mt-px', TONE_FG[tone])}>{TONE_ICON[tone]}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {title && <p className="font-medium text-[var(--text-primary)]">{title}</p>}
        {children && <div className="text-[var(--text-secondary)]">{children}</div>}
        {actions && <div className="flex items-center gap-1.5 pt-0.5">{actions}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Progress
   ------------------------------------------------------------------------ */
export function ProgressBar({
  value,
  max = 1,
  label,
  detail,
  className,
}: {
  value: number;
  max?: number;
  label?: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn('w-full space-y-1.5', className)}>
      {(label || detail) && (
        <div className="flex items-baseline justify-between gap-3">
          {label && <span className="text-xs text-[var(--text-secondary)] truncate">{label}</span>}
          {detail && <span className="text-2xs font-mono tnum text-[var(--text-tertiary)] shrink-0">{detail}</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemax={max}
        className="h-1 w-full rounded-full bg-[var(--surface-active)] overflow-hidden"
      >
        <div
          className="h-full rounded-full bg-[var(--accent-500)] transition-[width] duration-[var(--dur-normal)] ease-[var(--ease-standard)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   EmptyState — every reachable dead end gets one of these, never bare text.
   ------------------------------------------------------------------------ */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'md',
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center anim-fade',
        size === 'sm' ? 'gap-2 p-5' : 'gap-3 p-10',
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            'grid place-items-center rounded-[var(--radius-lg)] text-[var(--text-disabled)]',
            'bg-[var(--surface-raised)] border border-[var(--border-subtle)]',
            size === 'sm' ? 'h-8 w-8' : 'h-11 w-11',
          )}
        >
          {icon}
        </div>
      )}
      <div className="space-y-1 max-w-[38ch]">
        <p className={cn('text-[var(--text-secondary)] font-medium', size === 'sm' ? 'text-xs' : 'text-base')}>
          {title}
        </p>
        {description && (
          <p className={cn('text-[var(--text-tertiary)] leading-snug', size === 'sm' ? 'text-2xs' : 'text-xs')}>
            {description}
          </p>
        )}
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   StatTile — a single headline number. Used in metadata summaries and the
   pre-export confirmation.
   ------------------------------------------------------------------------ */
export function StatTile({
  label,
  value,
  unit,
  tone = 'neutral',
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  tone?: Tone;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      // A stable hook, so "this screen no longer has a row of stat tiles" is a
      // claim a harness can make about the elements rather than about the words
      // inside them. Added when the unmixing Gate step's three-tile header was
      // removed (2026-08-10).
      data-stat-tile=""
      className={cn(
        'flex flex-col gap-0.5 px-2.5 py-2 rounded-[var(--radius-md)]',
        'bg-[var(--surface-raised)] border border-[var(--border-subtle)]',
        className,
      )}
      title={typeof hint === 'string' ? hint : undefined}
    >
      <span className="eyebrow truncate">{label}</span>
      <span className="flex items-baseline gap-1 min-w-0">
        <span className={cn('font-mono tnum text-lg leading-tight tracking-[var(--tracking-tight)] truncate', TONE_FG[tone] === 'text-[var(--text-tertiary)]' ? 'text-[var(--text-primary)]' : TONE_FG[tone])}>
          {value}
        </span>
        {unit && <span className="text-2xs text-[var(--text-tertiary)] shrink-0">{unit}</span>}
      </span>
    </div>
  );
}
