import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { cn } from './cn';

type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * Tooltip. Portalled so it is never clipped by a panel's overflow, and
 * flip-aware so it stays on screen near window edges.
 *
 * `rich` mode widens the bubble and left-aligns the text — used for the
 * explanatory export-option help required by the Full Gate Export UI, where the
 * content is a sentence or two rather than a label.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  rich = false,
  delay = 260,
  disabled,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  rich?: boolean;
  delay?: number;
  disabled?: boolean;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; side: Side } | null>(null);

  const show = useCallback(() => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), delay);
  }, [delay, disabled]);

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !bubbleRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const b = bubbleRef.current.getBoundingClientRect();
    const gap = 7;
    const pad = 8;
    let s = side;

    // Flip if the preferred side doesn't fit.
    if (s === 'top' && a.top - b.height - gap < pad) s = 'bottom';
    else if (s === 'bottom' && a.bottom + b.height + gap > window.innerHeight - pad) s = 'top';
    else if (s === 'left' && a.left - b.width - gap < pad) s = 'right';
    else if (s === 'right' && a.right + b.width + gap > window.innerWidth - pad) s = 'left';

    let top: number, left: number;
    if (s === 'top') { top = a.top - b.height - gap; left = a.left + a.width / 2 - b.width / 2; }
    else if (s === 'bottom') { top = a.bottom + gap; left = a.left + a.width / 2 - b.width / 2; }
    else if (s === 'left') { top = a.top + a.height / 2 - b.height / 2; left = a.left - b.width - gap; }
    else { top = a.top + a.height / 2 - b.height / 2; left = a.right + gap; }

    // Clamp into the viewport.
    left = Math.min(Math.max(pad, left), window.innerWidth - b.width - pad);
    top = Math.min(Math.max(pad, top), window.innerHeight - b.height - pad);
    setPos({ top, left, side: s });
  }, [open, side]);

  if (!content) return <>{children}</>;

  return (
    <>
      <span
        ref={anchorRef}
        aria-describedby={open ? id : undefined}
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
        onClick={hide}
        className="contents"
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            id={id}
            ref={bubbleRef}
            role="tooltip"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className={cn(
              'fixed z-[9999] pointer-events-none anim-scale',
              'rounded-[var(--radius-sm)] border border-[var(--border-default)]',
              'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
              rich
                ? 'max-w-[280px] px-2.5 py-2 text-2xs leading-[1.5] text-left text-[var(--text-secondary)]'
                : 'max-w-[240px] px-2 py-1 text-2xs text-center text-[var(--text-primary)]',
            )}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The ⓘ affordance. Pairs a tooltip with a small, low-contrast glyph that
 * brightens on hover — used next to any option whose meaning isn't obvious
 * from its label alone.
 */
export function InfoHint({
  content,
  side = 'top',
  size = 12,
  className,
}: {
  content: ReactNode;
  side?: Side;
  size?: number;
  className?: string;
}) {
  return (
    <Tooltip content={content} side={side} rich delay={120}>
      <button
        type="button"
        tabIndex={0}
        aria-label="More information"
        onClick={(e) => e.preventDefault()}
        className={cn(
          'inline-grid place-items-center shrink-0 align-middle cursor-help',
          'text-[var(--text-disabled)] hover:text-[var(--text-accent)]',
          'transition-colors duration-[var(--dur-fast)]',
          className,
        )}
      >
        <Info size={size} strokeWidth={2} />
      </button>
    </Tooltip>
  );
}

/** Keyboard shortcut hint, e.g. inside the command palette or a tooltip. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center h-[17px] min-w-[17px] px-1',
        'rounded-[var(--radius-xs)] border border-[var(--border-default)] bg-[var(--surface-sunken)]',
        'font-mono text-[10px] leading-none text-[var(--text-tertiary)] select-none',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
