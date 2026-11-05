import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

/**
 * A menu anchored to a point rather than to an element.
 *
 * `Popover` covers the element-anchored case and is used everywhere a control
 * opens a panel. A context menu is the other shape of the same idea: it opens
 * where the pointer was, which no element in the tree can describe. Rather than
 * bend `Popover` around a synthetic anchor, this keeps the two cases honest —
 * they share the surface tokens and the dismissal rules, not the positioning.
 */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export function ContextMenu({
  at,
  items,
  onClose,
  width = 208,
}: {
  /** Viewport coordinates, or null when closed. */
  at: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!at || !ref.current) return;
    const pad = 8;
    const r = ref.current.getBoundingClientRect();
    // Flip rather than clamp when the menu would overhang: a menu shoved back
    // up the screen covers the row it belongs to.
    const left = at.x + width + pad > window.innerWidth ? Math.max(pad, at.x - width) : at.x;
    const top = at.y + r.height + pad > window.innerHeight ? Math.max(pad, at.y - r.height) : at.y;
    setPos({ top, left });
  }, [at, width, items.length]);

  useEffect(() => {
    if (!at) { setPos(null); return; }
    const dismiss = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    // Capture phase, so a click that also lands on a row behind the menu closes
    // it rather than being swallowed and leaving the menu open.
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('contextmenu', dismiss, true);
    window.addEventListener('blur', onClose);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('contextmenu', dismiss, true);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('keydown', onKey);
    };
  }, [at, onClose]);

  if (!at) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        top: pos?.top ?? at.y,
        left: pos?.left ?? at.x,
        width,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className={cn(
        'fixed z-[9999] py-1 anim-scale',
        'rounded-[var(--radius-md)] border border-[var(--border-default)]',
        'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
      )}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => { onClose(); item.onSelect(); }}
          className={cn(
            'flex items-center gap-2 w-full h-7 px-2.5 text-left text-xs',
            'transition-colors duration-[var(--dur-instant)]',
            item.disabled
              ? 'text-[var(--text-disabled)] cursor-default'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
          )}
        >
          {item.icon && <span className="shrink-0 text-[var(--text-tertiary)]">{item.icon}</span>}
          <span className="truncate">{item.label}</span>
          {item.hint && <span className="ml-auto shrink-0 text-2xs text-[var(--text-disabled)]">{item.hint}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
