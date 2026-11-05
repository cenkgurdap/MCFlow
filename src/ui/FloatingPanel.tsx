import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GripHorizontal, X } from 'lucide-react';
import { cn } from './cn';
import { IconButton } from './Button';

/**
 * A settings panel that opens **beside** what it configures, and can be moved.
 *
 * `Popover` — the anchored one next door — is right for a menu: it hangs off its
 * trigger, it is dismissed by the next click anywhere, and it is gone in a second.
 * It was wrong for the colour-levels panel, and the report said exactly why: the
 * panel opened over the plot it was adjusting, so every setting was changed
 * blind, and there was nothing to do about it but drag the whole plot out from
 * under it. A control surface you are meant to *watch the effect of* has two
 * requirements a popover does not meet — it must not cover its subject, and when
 * the layout leaves it no choice, the user must be able to move it.
 *
 * So this is a third thing, not a variant of either:
 *
 *   - **Placed beside `beside`, not below `anchor`.** The trigger is a 20 px icon
 *     in a toolbar; hanging a 280 px panel off it puts the panel over the graph
 *     every time. `beside` is the panel element being configured, and the
 *     placement is: to its right, else to its left, else — only if neither side
 *     has room in the window — as far off its edge as will fit. `placeBeside` is
 *     pure and unit-tested, because "never covers the plot" is a claim about
 *     arithmetic that should not need a screenshot to check.
 *   - **Movable, from a header grip.** Pointer capture on the header, clamped to
 *     the window on release so it cannot be thrown off-screen.
 *   - **Not dismissed by an outside click.** Adjusting a plot means clicking the
 *     plot; a panel that closed when you touched your subject would be unusable.
 *     Escape and the close button dismiss it.
 */
export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }

export interface Placement { left: number; top: number }

/** Gap between the plot panel and the settings panel, and from the window edge. */
const GAP = 8;

/**
 * Where a panel of `size` goes beside `subject`, within `viewport`.
 *
 * Right first, then left, and only then overlapping. "Overlapping" still pushes
 * as far as the window allows rather than centring: the failure the user reported
 * is a panel *centred* on the plot, and a panel pinned to the window edge with the
 * plot beside it is a different and much better failure.
 *
 * Vertically it aligns to the subject's top and then slides up to stay on screen,
 * so the panel and the plot read as a pair.
 */
export function placeBeside(
  subject: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const right = subject.right + GAP;
  const left = subject.left - GAP - size.width;

  const x = right + size.width + GAP <= viewport.width
    ? right
    : left >= GAP
      ? left
      // Neither side fits. Take whichever edge of the window leaves more of the
      // subject visible, which is the right edge when the subject is left of
      // centre and vice versa.
      : subject.left + subject.width / 2 < viewport.width / 2
        ? Math.max(GAP, viewport.width - size.width - GAP)
        : GAP;

  const y = Math.min(
    Math.max(GAP, subject.top),
    Math.max(GAP, viewport.height - size.height - GAP),
  );
  return { left: Math.round(x), top: Math.round(y) };
}

export function FloatingPanel({
  open, onClose, beside, title, width = 280, bodyScroll = true, children,
}: {
  open: boolean;
  onClose: () => void;
  /** The element this configures — placement is *beside* it, never over it. */
  beside: HTMLElement | null;
  title: string;
  width?: number;
  /**
   * `false` for a panel that lays out its own scrolling regions — the figure
   * exporter keeps its preview fixed and scrolls only its settings. A second
   * scroll box around those is a scrollbar that scrolls a scrollbar.
   */
  bodyScroll?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  /** Set once the user drags it: after that, placement is theirs, not ours. */
  const moved = useRef(false);

  // Placement runs once per opening. Re-running it on every render would fight
  // the drag below, and re-running it on resize would yank a panel the user had
  // deliberately put somewhere.
  useLayoutEffect(() => {
    if (!open) { moved.current = false; setPos(null); return; }
    const el = ref.current;
    if (!el || !beside) return;
    const size = { width, height: el.offsetHeight || 320 };
    setPos(placeBeside(beside.getBoundingClientRect(), size, {
      width: window.innerWidth, height: window.innerHeight,
    }));
  }, [open, beside, width]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onGripDown = useCallback((e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    const start = el.getBoundingClientRect();
    const ox = e.clientX - start.left;
    const oy = e.clientY - start.top;
    // Capture on the grip, not the window: this drag cannot leave the panel in a
    // meaningful sense, and capture is what keeps it alive over the plot canvas —
    // which has its own pointer handlers and would otherwise swallow the moves.
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* not all targets support it */ }
    moved.current = true;

    const move = (ev: PointerEvent) => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setPos({
        left: Math.round(Math.min(Math.max(0, ev.clientX - ox), window.innerWidth - w)),
        top: Math.round(Math.min(Math.max(0, ev.clientY - oy), window.innerHeight - h)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={title}
      data-floating-panel=""
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: typeof window === 'undefined' ? width : Math.min(width, window.innerWidth - 24),
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn(
        'fixed z-[9998] flex flex-col overflow-hidden anim-scale',
        'rounded-[var(--radius-md)] border border-[var(--border-default)]',
        'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
      )}
    >
      <div
        data-drag-handle=""
        onPointerDown={onGripDown}
        className={cn(
          'flex items-center gap-1.5 px-2 h-7 shrink-0 cursor-move select-none',
          'hairline-b bg-[var(--surface-raised)]',
        )}
      >
        <GripHorizontal size={12} className="text-[var(--text-tertiary)]" />
        <span className="text-2xs font-medium text-[var(--text-secondary)] flex-1">{title}</span>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={11} />
        </IconButton>
      </div>
      {bodyScroll
        ? <div className="overflow-y-auto max-h-[70vh]">{children}</div>
        : <div className="min-h-0 flex-1 flex flex-col max-h-[calc(100vh-150px)]">{children}</div>}
    </div>,
    document.body,
  );
}
