import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from './cn';

/**
 * Drag handle between docked panels.
 *
 * The visible hairline stays 1px; the grab area is widened to 7px and offset so
 * it straddles the border. Hit targets under ~6px feel broken, but a visibly
 * thick divider makes the shell look like a 90s splitter window — so the two are
 * decoupled. Highlight only appears on hover/drag.
 */
export function Splitter({
  onResize,
  side,
  className,
}: {
  /** Called with the pointer's client X during drag. */
  onResize: (clientX: number) => void;
  /** Which edge of the center region this splitter sits on. */
  side: 'left' | 'right';
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const raf = useRef<number | undefined>(undefined);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const x = e.clientX;
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => onResize(x));
    },
    [dragging, onResize],
  );

  const stop = useCallback(() => setDragging(false), []);

  useEffect(() => {
    if (!dragging) return;
    // Suppress text selection and keep the resize cursor while dragging even
    // when the pointer leaves the 7px strip.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      className={cn(
        'relative z-20 w-px shrink-0 cursor-col-resize group',
        'bg-[var(--border-subtle)]',
        className,
      )}
    >
      <div
        className={cn(
          'absolute inset-y-0 w-[7px]',
          side === 'left' ? '-left-[3px]' : '-right-[3px]',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'absolute inset-y-0 -inset-x-px transition-colors duration-[var(--dur-fast)] ease-[var(--ease-standard)]',
          dragging
            ? 'bg-[var(--accent-500)]'
            : 'bg-transparent group-hover:bg-[var(--accent-500)]/45',
        )}
      />
    </div>
  );
}
