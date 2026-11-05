import { useEffect, useRef } from 'react';
import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useUI } from '@/state/uiStore';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';

/**
 * "These data files were not found" — asked while a workspace is being opened.
 *
 * ## Why this exists (2026-10-28)
 *
 * A workspace stores paths, not events. Opened after its data had moved — a
 * folder renamed, a copy on a colleague's machine, a Windows workspace opened on
 * a Mac — it found nothing at the recorded paths, restored zero samples, and
 * File ▸ Open said nothing: the window simply stayed empty. The open now looks
 * beside the workspace first (`core/workspacePaths.ts`), and only what is still
 * missing after that reaches this card.
 *
 * *Locate folder…* re-points the missing files by their own names and asks
 * again if any are still missing; *Open without them* restores what was found;
 * *Cancel* leaves the current workspace untouched — nothing has been torn down
 * yet when this is showing. Same light card as the gate-delete confirmation,
 * because it is the same kind of question: an explicit choice, not a takeover.
 */
export function MissingFilesPrompt() {
  const pending = useUI((s) => s.pendingMissingFiles);
  const answer = useUI((s) => s.answerMissingFiles);
  const locateRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (pending) locateRef.current?.focus(); }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      answer('cancel');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pending, answer]);

  if (!pending) return null;

  const n = pending.missing.length;
  const shown = pending.missing.slice(0, 6);
  const suggested = pending.suggestions;

  return (
    <div
      data-missing-files=""
      role="alertdialog"
      aria-label="Data files not found"
      className={cn(
        'fixed left-1/2 -translate-x-1/2 z-[60] w-[min(60ch,calc(100vw-32px))] mc-panel-in',
        'flex items-start gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)]',
        'border border-[var(--status-warn)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]',
      )}
      style={{ top: 'calc(var(--h-topbar) + 12px)' }}
    >
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--status-warn)]" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-[var(--text-primary)]">
          <span className="tnum">{n}</span> of <span className="tnum">{pending.total}</span> data file{pending.total === 1 ? '' : 's'} for{' '}
          <strong className="font-medium">{pending.workspace}</strong> {n === 1 ? 'was' : 'were'} not found.
        </p>
        <p className="text-2xs text-[var(--text-tertiary)] mt-0.5">
          A workspace stores where its data was, not the data. Point it at the folder the files are in now and every gate and fit stays attached.
        </p>
        {suggested.length > 0 ? (
          /*
             Renamed files, offered and not used: the name agrees once spacing and
             case are ignored and the file holds the event count the workspace
             recorded. Nothing is relinked until *Use these* is pressed — a
             suggestion stays a suggestion until somebody touches it.
          */
          <div data-missing-suggestions="" className="mt-1.5">
            <p className="text-2xs text-[var(--text-secondary)]">
              Suggested — found under a new name, with the same number of events:
            </p>
            <ul className="mt-1 max-h-28 overflow-auto font-mono text-[10px] text-[var(--text-secondary)]">
              {suggested.map((m) => (
                <li key={m.saved} className="truncate" title={`${m.saved} → ${m.found}`}>
                  {m.saved} → {m.found} <span className="tnum text-[var(--text-tertiary)]">· {m.events.toLocaleString()} events</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ul className="mt-1.5 max-h-24 overflow-auto font-mono text-[10px] text-[var(--text-secondary)]">
            {shown.map((f) => <li key={f} className="truncate" title={f}>{f}</li>)}
            {n > shown.length && <li className="text-[var(--text-tertiary)]">…and {n - shown.length} more</li>}
          </ul>
        )}
        <div className="flex items-center gap-1.5 mt-2">
          {suggested.length > 0 && (
            <Button size="sm" variant="primary" onClick={() => answer('accept')}>
              Use these <span className="tnum">{suggested.length}</span>
            </Button>
          )}
          <Button
            ref={locateRef}
            size="sm"
            variant={suggested.length > 0 ? 'secondary' : 'primary'}
            icon={<FolderOpen size={11} />}
            onClick={() => answer('locate')}
          >
            Locate folder…
          </Button>
          <Button size="sm" variant="secondary" onClick={() => answer('skip')}>Open without them</Button>
          <Button size="sm" variant="ghost" onClick={() => answer('cancel')}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
