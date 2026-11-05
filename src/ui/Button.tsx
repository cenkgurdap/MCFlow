import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  // Primary is the only filled accent surface in the app. Used sparingly —
  // one per view — so it always reads as "the action".
  primary:
    'bg-[var(--action-primary-bg)] text-[var(--action-primary-fg)] font-medium ' +
    'hover:bg-[var(--action-primary-bg-hover)] active:brightness-95 ' +
    'disabled:bg-[var(--surface-active)] disabled:text-[var(--text-disabled)]',
  secondary:
    'bg-[var(--surface-raised)] text-[var(--text-primary)] border border-[var(--border-default)] ' +
    'hover:bg-[var(--surface-overlay)] hover:border-[var(--border-strong)] active:bg-[var(--surface-active)] ' +
    'disabled:text-[var(--text-disabled)] disabled:border-[var(--border-subtle)] disabled:bg-transparent',
  ghost:
    'bg-transparent text-[var(--action-ghost-fg)] ' +
    'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] active:bg-[var(--surface-active)] ' +
    'disabled:text-[var(--text-disabled)] disabled:bg-transparent',
  subtle:
    'bg-[var(--surface-hover)] text-[var(--text-secondary)] ' +
    'hover:bg-[var(--surface-active)] hover:text-[var(--text-primary)] ' +
    'disabled:text-[var(--text-disabled)]',
  danger:
    'bg-transparent text-[var(--status-err)] border border-[var(--status-err)]/35 ' +
    'hover:bg-[var(--status-err-bg)] hover:border-[var(--status-err)]/60 ' +
    'disabled:text-[var(--text-disabled)] disabled:border-[var(--border-subtle)] disabled:bg-transparent',
};

const SIZE: Record<Size, string> = {
  sm: 'h-6 px-2 text-2xs gap-1 rounded-[var(--radius-xs)]',
  md: 'h-[var(--h-control)] px-2.5 text-xs gap-1.5 rounded-[var(--radius-sm)]',
  lg: 'h-[var(--h-control-lg)] px-3.5 text-sm gap-2 rounded-[var(--radius-sm)]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Leading glyph — pass a Lucide icon element sized 14/16. */
  icon?: ReactNode;
  /** Trailing glyph, e.g. a chevron or keyboard hint. */
  trailing?: ReactNode;
  /** Replaces content with a spinner and blocks interaction. */
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, loading, fullWidth, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'relative inline-flex items-center justify-center whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,opacity] duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
        'disabled:cursor-not-allowed',
        fullWidth && 'w-full',
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span
          aria-hidden
          className="absolute inset-0 grid place-items-center"
        >
          <Spinner size={size === 'sm' ? 10 : 12} />
        </span>
      )}
      <span className={cn('inline-flex items-center', SIZE[size].match(/gap-[\d.]+/)?.[0], loading && 'opacity-0')}>
        {icon}
        {children}
        {trailing}
      </span>
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Required — icon-only controls must still be reachable by name. */
  label: string;
  active?: boolean;
}

const ICON_SIZE: Record<Size, string> = {
  sm: 'h-6 w-6 rounded-[var(--radius-xs)]',
  md: 'h-[var(--h-control)] w-[var(--h-control)] rounded-[var(--radius-sm)]',
  lg: 'h-[var(--h-control-lg)] w-[var(--h-control-lg)] rounded-[var(--radius-sm)]',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', label, active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-grid place-items-center shrink-0 select-none',
        'transition-[background-color,border-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
        'disabled:cursor-not-allowed',
        ICON_SIZE[size],
        VARIANT[variant],
        active && 'bg-[var(--surface-selected)] text-[var(--text-accent)]',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Indeterminate spinner. A rotating arc, not a bouncing dot row. */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={cn('shrink-0', className)}
      style={{ animation: 'mc-spin 720ms linear infinite' }}
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.75" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}
