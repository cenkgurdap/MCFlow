import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useWorkspace } from '@/state/workspaceStore';
import { IconButton } from '@/ui/Button';
import { TextInput } from '@/ui/Field';
import { MetaRow } from '@/ui/Panel';
import { Tooltip } from '@/ui/Tooltip';
import { formatFull } from './SampleBrowser';

/* ==========================================================================
   The raw FCS TEXT segment, on request.

   These keywords are worth keeping — they are the file's own account of how it
   was acquired, and the only place to check a claim the parser makes about it —
   but they are reference material, consulted perhaps twice in a session and
   never while analysing. They held the bottom third of the inspector, which is
   the most valuable column in the window and now holds the axis settings that
   are edited constantly.

   So: same list, same filter, reached from the sample's own context menu, which
   is where a question about *that file* is asked from anyway.
   ========================================================================== */

export function FileInfoDialog({ sampleId, onClose }: { sampleId: string | null; onClose: () => void }) {
  const sample = useWorkspace((s) => s.samples.find((x) => x.id === sampleId));
  const [q, setQ] = useState('');

  useEffect(() => { setQ(''); }, [sampleId]);

  useEffect(() => {
    if (!sampleId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sampleId, onClose]);

  const md = sample?.parsed.metadata;

  // Per-parameter keywords ($P12N, $P12B …) are excluded: 71 parameters
  // generate about 500 of them and they are already listed, resolved, in the
  // inspector's Parameters section.
  const entries = useMemo(() => {
    if (!md) return [] as Array<[string, string]>;
    const query = q.trim().toLowerCase();
    return Object.entries(md.keywords)
      .filter(([k]) => !/^\$?P\d+[A-Z]*$/i.test(k))
      .filter(([k, v]) => !query || k.toLowerCase().includes(query) || v.toLowerCase().includes(query))
      .sort(([a], [b]) => a.localeCompare(b));
  }, [md, q]);

  if (!sample || !md) return null;

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/45 anim-fade"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={`File info — ${sample.name}`}
    >
      <div className="w-[min(720px,88vw)] max-h-[80vh] flex flex-col rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)] mc-panel-in">
        <header className="flex items-center gap-2 h-10 px-3 hairline-b shrink-0">
          <div className="min-w-0">
            <p className="text-xs text-[var(--text-primary)] truncate">{sample.name}</p>
            <p className="text-[10px] text-[var(--text-tertiary)] truncate" title={sample.filePath ?? sample.fileName}>
              {sample.fileName}
            </p>
          </div>
          <IconButton label="Close" size="sm" className="ml-auto" onClick={onClose}><X size={13} /></IconButton>
        </header>

        <div className="px-3 py-2 space-y-0.5 hairline-b shrink-0">
          <MetaRow label="Events" value={formatFull(md.eventCount)} />
          <MetaRow label="Parameters" value={String(md.parameterCount)} />
          <MetaRow label="FCS version" value={md.version} />
          <MetaRow label="Cytometer" value={md.cytometer ?? '—'} mono={false} />
        </div>

        <div className="px-3 py-2 shrink-0">
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-disabled)] pointer-events-none" />
            <TextInput
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Filter ${Object.keys(md.keywords).length} keywords…`}
              className="pl-6 h-6 text-2xs"
            />
          </div>
          <p className="text-[10px] text-[var(--text-disabled)] pt-1">
            Per-parameter keywords ($PnN, $PnB …) are listed under Parameters in the inspector.
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-px">
          {entries.map(([k, v]) => (
            <Tooltip key={k} content={v.length > 60 ? v : ''} side="left" rich>
              <div className="flex items-baseline gap-2 px-1 py-0.5 rounded-[var(--radius-xs)] hover:bg-[var(--surface-hover)]">
                <span className="font-mono text-[10px] text-[var(--text-tertiary)] w-[130px] shrink-0 truncate">{k}</span>
                <span className="font-mono text-[10px] text-[var(--text-primary)] min-w-0 truncate">{v}</span>
              </div>
            </Tooltip>
          ))}
          {entries.length === 0 && (
            <p className="text-2xs text-[var(--text-tertiary)] px-1 py-3">No keyword matches “{q}”.</p>
          )}
        </div>
      </div>
    </div>
  );
}
