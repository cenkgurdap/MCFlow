import { useEffect, useRef } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react';
import { withoutGates } from '@/core/gating/referenceGates';
import { useGates } from '@/state/gateStore';
import { useUI } from '@/state/uiStore';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';

/** Stable empty list — see the selector below. */
const NO_GATES: never[] = [];

/**
 * "Delete this population?" — the second action Escape requires.
 *
 * Escape removes a selected **plot** on the first press and asks before removing
 * a selected **gate**, and the asymmetry is deliberate. A plot is four settings
 * and an arrangement; a gate is analysis — it carries a name someone chose, it
 * has statistics computed against it, and deleting one re-parents its children
 * rather than taking them with it, which is a change to the shape of the whole
 * strategy. One keystroke should not be able to do that quietly.
 *
 * Deliberately light: a small card, not a modal that takes over the window.
 * The requirement is an explicit second action, and clicking *Delete* or
 * pressing Enter is one. Escape cancels — a cancel key that sometimes confirms
 * is the one thing it must never be, so a second Escape does **not** go through.
 *
 * ## It confirms a batch, and a batch of one is the same batch
 *
 * The tree selects several populations, so this asks about a set and hands that
 * set to `removeGates` — one action, one undo, and the survivors resolved
 * against the whole set at once. A population under *Cells* when both are going
 * lifts to the root, not to *Cells*, and a chain unpicked one removal at a time
 * gets that wrong; see `withoutGates`. A single deletion goes down this same
 * path rather than a shorter one, because two paths is how the two answers come
 * to differ.
 */
export function GateDeleteConfirm() {
  const pending = useUI((s) => s.pendingGateDelete);
  const cancel = useUI((s) => s.cancelDeleteGate);
  const removeGates = useGates((s) => s.removeGates);
  // `NO_GATES` rather than a fresh `[]`: a zustand selector is compared by
  // identity, so returning a new array literal on every call makes the store
  // look like it changed on every render and the component re-renders forever.
  const gates = useGates((s) => (pending ? s.divergent[pending.sampleId] ?? s.shared : NO_GATES));
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Focused before paint, not inside `requestAnimationFrame`: Chromium throttles
  // rAF to about 1 Hz in a background window, and a confirmation that is not
  // ready when it appears is a confirmation that eats the keystroke answering it.
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        removeGates(new Set(pending.gateIds));
        cancel();
      }
    };
    // Capture, so this runs ahead of the plot canvas's own window-level Escape
    // handler — which would otherwise re-open the confirmation it just closed.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, cancel, removeGates]);

  if (!pending) return null;

  const doomed = new Set(pending.gateIds);
  const many = pending.gateIds.length > 1;
  /*
     How many populations survive underneath the set — re-parented upward rather
     than deleted, which is the merciful behaviour but not the obvious one, so it
     is stated rather than discovered.

     Asked of `withoutGates` — the function that will actually do it — as "whose
     parent changed", rather than by summing subtree sizes. With three gates in a
     chain all going, summing counts the same survivor once per ancestor and
     reports six populations moving where two do.
  */
  const before = new Map(gates.map((g) => [g.id, g.parentId ?? null]));
  const childCount = withoutGates(gates, doomed)
    .filter((g) => (g.parentId ?? null) !== before.get(g.id)).length;

  return (
    <div
      data-gate-delete-confirm=""
      role="alertdialog"
      aria-label={`Delete ${pending.name}?`}
      className={cn(
        'fixed left-1/2 -translate-x-1/2 z-[60] max-w-[52ch] mc-panel-in',
        'flex items-start gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)]',
        'border border-[var(--status-err)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]',
      )}
      style={{ top: 'calc(var(--h-topbar) + 12px)' }}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--status-err)]" />
      <div className="min-w-0">
        <p className="text-xs text-[var(--text-primary)]">
          Delete <strong className="font-medium">{pending.name}</strong>?
        </p>
        <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">
          {childCount > 0
            ? `${childCount} population${childCount === 1 ? ' moves' : 's move'} up to the parent rather than being deleted. Ctrl+Z brings ${many ? 'them' : 'it'} back.`
            : `Ctrl+Z brings ${many ? 'them' : 'it'} back.`}
        </p>
        <div className="flex items-center gap-1.5 mt-2">
          <Button
            ref={confirmRef}
            size="sm"
            variant="danger"
            icon={<Trash2 size={11} />}
            onClick={() => { removeGates(doomed); cancel(); }}
          >
            Delete
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          <span className="ml-1 text-[10px] text-[var(--text-disabled)]">⏎ delete · Esc keep</span>
        </div>
      </div>
    </div>
  );
}
