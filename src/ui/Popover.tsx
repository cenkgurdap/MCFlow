import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

type Align = 'start' | 'center' | 'end';

/**
 * Anchored popover.
 *
 * Portalled so panel `overflow` cannot clip it, flipped when it would run off
 * the bottom of the window, and dismissed on outside click or Escape. Used for
 * the axis parameter pickers and any other menu that needs to escape a panel.
 */
export function Popover({
  open,
  onClose,
  anchor,
  children,
  align = 'start',
  width,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchor: HTMLElement | null;
  children: ReactNode;
  align?: Align;
  width?: number;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !panelRef.current) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = panelRef.current!.getBoundingClientRect();
      const gap = 5;
      const pad = 8;
      const w = width ?? p.width;

      let left = align === 'center' ? a.left + a.width / 2 - w / 2 : align === 'end' ? a.right - w : a.left;
      left = Math.min(Math.max(pad, left), window.innerWidth - w - pad);

      const below = window.innerHeight - a.bottom - gap - pad;
      const above = a.top - gap - pad;
      // Flip upward only when there is meaningfully more room there.
      const flip = below < Math.min(p.height, 220) && above > below;
      const maxHeight = Math.max(120, flip ? above : below);
      const top = flip ? Math.max(pad, a.top - gap - Math.min(p.height, maxHeight)) : a.bottom + gap;

      setPos({ top, left, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, align, width]);

  const handlePointerDown = useCallback(
    (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    },
    [anchor, onClose],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, handlePointerDown, onClose]);

  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  /**
   * Focus whatever the content marked, once the panel is actually on screen.
   *
   * Keyed on `pos`, which is what makes it correct. React's own `autoFocus`
   * calls `focus()` during commit — at which point this panel is still
   * `visibility: hidden` at -9999, and a hidden element cannot take focus, so
   * the call is silently a no-op. That is why clicking an axis label needed a
   * second click into the search box before typing filtered anything. Focusing
   * inside the positioning effect has the same problem: `setPos` has not been
   * committed yet, so the element is still hidden when the call is made. Only
   * the render *after* `pos` exists has a visible panel to focus into.
   */
  useLayoutEffect(() => {
    if (!open || !pos) return;
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }, [open, pos]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn(
        'fixed z-[9998] flex flex-col overflow-hidden anim-scale',
        'rounded-[var(--radius-md)] border border-[var(--border-default)]',
        'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
