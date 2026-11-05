import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, Atom, Circle, CornerDownLeft, Download, FlaskConical, Grid2x2, Grid3x3, Moon,
  Network, Pentagon, Save, Search, Sigma, Square, Sun, Table2, Upload, Waves,
} from 'lucide-react';
import { platform } from '@/platform';
import { resolveGates, useGates } from '@/state/gateStore';
import { usePlot } from '@/state/plotStore';
import { useUI, type MainView } from '@/state/uiStore';
import { spilloverPanel, useViewLock, viewLockReason } from '@/state/viewLock';
import { useWorkspace } from '@/state/workspaceStore';
import { openWorkspaceFile, saveWorkspaceToFile } from '@/state/workspaceIO';
import { loadUnmixingMatrixFromFile, saveUnmixingMatrixToFile } from '@/state/unmixingIO';
import { Kbd } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

interface Command {
  id: string;
  label: string;
  group: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void | Promise<void>;
}

/**
 * Command palette (Ctrl/Cmd+K).
 *
 * Jump to any sample, gate, view or action by typing — the modern-app touch
 * neither FlowJo nor FCS Express has. Samples and gates are included as
 * commands, not just menu items, because "which of my 16 samples was the CD14
 * control" is the question a palette is actually for.
 */
export function CommandPalette() {
  const open = useUI((s) => s.commandPaletteOpen);
  const setOpen = useUI((s) => s.setCommandPaletteOpen);
  const setView = useUI((s) => s.setView);
  const view = useUI((s) => s.view);
  const theme = useUI((s) => s.theme);
  const toggleTheme = useUI((s) => s.toggleTheme);
  const setNotice = useUI((s) => s.setNotice);

  const samples = useWorkspace((s) => s.samples);
  const selectSample = useWorkspace((s) => s.selectSample);
  const importFiles = useWorkspace((s) => s.importFiles);
  const selectedSampleId = useWorkspace((s) => s.selectedSampleId);

  // Gating is shared across samples unless one has been forked off it, so a
  // sample's gates come from `resolveGates` rather than from a per-sample map.
  const sharedGates = useGates((s) => s.shared);
  const divergentGates = useGates((s) => s.divergent);
  const gateOverrides = useGates((s) => s.overrides);
  const selectGate = useGates((s) => s.selectGate);
  const setGateTool = useGates((s) => s.setTool);
  const setPlotType = usePlot((s) => s.setPlotType);
  const activePanelId = usePlot((s) => s.activePanelId);
  const addPanel = usePlot((s) => s.addPanel);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const biophysicsLock = useViewLock('biophysics');
  /*
     The second lock reason, and it has to be in this memo's deps for the same
     reason the first one is. Which spillover panel applies is a question about
     the loaded samples, so it changes on an import or an acquisition-type
     override rather than on anything the spectral store does — and a list built
     once at mount would go on offering the wrong one.
  */
  const compensationLock = useViewLock('compensation');

  const commands = useMemo<Command[]>(() => {
    // Which spillover panel the two matrix commands mean — asked of the one
    // place that answers it, because the *File* menu asks the same question.
    const spillover = spilloverPanel(view);
    const conventional = spillover === 'compensation';
    const matrixNoun = conventional ? 'compensation matrix' : 'unmixing matrix';
    const matrixIcon = conventional ? <Grid3x3 size={13} /> : <Waves size={13} />;

    const views: Array<[MainView, string, React.ReactNode]> = [
      ['analysis', 'Analysis', <Activity size={13} key="a" />],
      ['parameters', 'Parameters', <Sigma size={13} key="p" />],
      ['unmixing', 'Unmixing', <Waves size={13} key="s" />],
      ['compensation', 'Compensation', <Grid3x3 size={13} key="c" />],
      ['statistics', 'Statistics', <Table2 size={13} key="t" />],
      ['export', 'Export', <Download size={13} key="e" />],
      ['umap', 'UMAP', <Network size={13} key="u" />],
      ['biophysics', 'Biophysics', <Atom size={13} key="b" />],
    ];

    const cmds: Command[] = [
      /*
         Locked views are dropped from the list rather than shown greyed out.
         The palette is a search — every row in it is something to run — and a
         row that cannot run is a result the query matched and the user cannot
         use. The switcher, which is always on screen, is where the reason is
         said. See `state/viewLock.ts`.

         `viewLockReason` reads the store imperatively, so `biophysicsLock` is in
         this memo's deps as the value that invalidates it. Without it the list is
         built once with whatever the lock said at mount — the "computed once at
         mount" trap, in the one place it would be invisible.
      */
      ...views.filter(([v]) => !viewLockReason(v)).map(([v, label, icon]) => ({
        id: `view:${v}`, label: `Go to ${label}`, group: 'Views', icon,
        run: () => setView(v),
      })),

      {
        id: 'file:import', label: 'Import .fcs files', group: 'File', icon: <Upload size={13} />,
        run: async () => importFiles(await platform().pickFcsFiles()),
      },
      {
        id: 'file:save', label: 'Save workspace…', group: 'File', icon: <Save size={13} />,
        hint: 'Gates, derived parameters, transforms and layout',
        run: async () => {
          setBusy('Saving workspace…');
          try { await saveWorkspaceToFile('MCFlow workspace'); } finally { setBusy(null); }
        },
      },
      {
        id: 'file:open', label: 'Open workspace…', group: 'File', icon: <FlaskConical size={13} />,
        hint: 'Re-reads the original .fcs files',
        run: async () => {
          setBusy('Restoring workspace…');
          // `openWorkspaceFile` reports its own outcome — see `reportRestore`.
          try { await openWorkspaceFile(); } finally { setBusy(null); }
        },
      },
      {
        id: 'file:save-unmixing', label: `Save ${matrixNoun}…`, group: 'File', icon: matrixIcon,
        hint: `A portable ${conventional ? '.compensation' : '.unmixing'}, reusable in any workspace`,
        run: async () => {
          setView(spillover);
          setBusy(`Saving ${matrixNoun}…`);
          try {
            const path = await saveUnmixingMatrixToFile(conventional ? 'Compensation panel' : 'Unmixing panel');
            if (path) setNotice({ tone: 'ok', text: `Saved to ${path}` });
          } catch (e) {
            setNotice({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
          } finally { setBusy(null); }
        },
      },
      {
        id: 'file:load-unmixing', label: `Load ${matrixNoun}…`, group: 'File', icon: matrixIcon,
        hint: 'Validated against the loaded samples’ detector configuration',
        run: async () => {
          setView(spillover);
          setBusy(`Loading ${matrixNoun}…`);
          try {
            const r = await loadUnmixingMatrixFromFile(conventional ? 'compensation' : 'unmixing');
            if (r) setNotice({ tone: r.report.applied ? 'ok' : 'err', text: r.report.message });
          } catch (e) {
            setNotice({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
          } finally { setBusy(null); }
        },
      },
      ...(platform().newWindow
        ? [{
            id: 'window:new', label: 'New window', group: 'File', icon: <Grid2x2 size={13} />,
            hint: 'An empty second MCFlow, for a separate experiment',
            run: () => { void platform().newWindow?.(); },
          }]
        : []),

      {
        id: 'plot:scatter', label: 'Dot plot', group: 'Plot', icon: <Circle size={13} />,
        run: () => { setView('analysis'); setPlotType(activePanelId, 'scatter'); },
      },
      {
        id: 'plot:density', label: 'Density plot', group: 'Plot', icon: <Grid2x2 size={13} />,
        run: () => { setView('analysis'); setPlotType(activePanelId, 'density'); },
      },
      {
        id: 'plot:histogram', label: 'Histogram', group: 'Plot', icon: <Square size={13} />,
        run: () => { setView('analysis'); setPlotType(activePanelId, 'histogram'); },
      },

      {
        id: 'gate:rect', label: 'Draw rectangle gate', group: 'Gating', icon: <Square size={13} />,
        run: () => { setView('analysis'); setGateTool('rectangle'); },
      },
      {
        id: 'gate:poly', label: 'Draw polygon gate', group: 'Gating', icon: <Pentagon size={13} />,
        run: () => { setView('analysis'); setGateTool('polygon'); },
      },
      {
        id: 'gate:ellipse', label: 'Draw ellipse gate', group: 'Gating', icon: <Circle size={13} />,
        run: () => { setView('analysis'); setGateTool('ellipse'); },
      },
      {
        id: 'gate:quad', label: 'Draw quadrant gate', group: 'Gating', icon: <Grid2x2 size={13} />,
        run: () => { setView('analysis'); setGateTool('quadrant'); },
      },

      {
        id: 'plot:add', label: 'Add a plot to the layout', group: 'Plot', icon: <Grid2x2 size={13} />,
        run: () => { setView('analysis'); addPanel(); },
      },
      {
        id: 'ui:theme', label: theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        group: 'View', icon: theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />,
        run: toggleTheme,
      },
    ];

    for (const s of samples) {
      cmds.push({
        id: `sample:${s.id}`,
        label: s.name,
        group: 'Samples',
        icon: <FlaskConical size={13} />,
        hint: `${s.parsed.metadata.eventCount.toLocaleString()} events`,
        run: () => { selectSample(s.id); setView('analysis'); },
      });
    }

    for (const g of resolveGates(sharedGates, divergentGates, gateOverrides, selectedSampleId ?? '')) {
      cmds.push({
        id: `gate:${g.id}`,
        label: g.name,
        group: 'Populations',
        icon: <Square size={13} />,
        hint: g.kind,
        run: () => { selectGate(g.id); setView('analysis'); },
      });
    }

    return cmds;
  }, [samples, sharedGates, divergentGates, gateOverrides, selectedSampleId, theme, view, setView, toggleTheme, selectSample, selectGate, setGateTool, setPlotType, activePanelId, addPanel, importFiles, biophysicsLock, compensationLock]);

  /** Subsequence match, so "cd3pc" finds "CD3 PerCP-Cy5.5". */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const scored: Array<{ c: Command; score: number }> = [];
    for (const c of commands) {
      const hay = `${c.group} ${c.label}`.toLowerCase();
      const direct = hay.indexOf(q);
      if (direct >= 0) { scored.push({ c, score: 1000 - direct }); continue; }
      let qi = 0;
      for (let i = 0; i < hay.length && qi < q.length; i++) if (hay[i] === q[qi]) qi++;
      if (qi === q.length) scored.push({ c, score: 100 - hay.length / 10 });
    }
    return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
  }, [commands, query]);

  useEffect(() => { if (open) { setQuery(''); setActive(0); } }, [open]);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const runActive = async () => {
    const c = matches[active];
    if (!c) return;
    setOpen(false);
    await c.run();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-start justify-center pt-[14vh] bg-[var(--scrim)] anim-fade"
      onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <div
        className={cn(
          'w-[min(620px,92vw)] flex flex-col overflow-hidden anim-scale',
          'rounded-[var(--radius-lg)] border border-[var(--border-default)]',
          'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
        )}
      >
        <div className="flex items-center gap-2 px-3 h-11 hairline-b">
          <Search size={15} className="text-[var(--text-disabled)] shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(matches.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); void runActive(); }
              else if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="Search samples, populations, views and actions…"
            className="flex-1 bg-transparent outline-none text-base text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
          />
          {busy && <span className="text-2xs text-[var(--text-tertiary)]">{busy}</span>}
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <p className="text-xs text-[var(--text-tertiary)] text-center py-8">
              Nothing matches “{query}”.
            </p>
          )}
          {matches.map((c, i) => {
            const newGroup = i === 0 || matches[i - 1]!.group !== c.group;
            return (
              <div key={c.id}>
                {newGroup && <p className="eyebrow px-2 pt-2 pb-1">{c.group}</p>}
                <button
                  data-i={i}
                  // The command this row runs. `data-i` is a position, which is
                  // exactly what changes when the list is filtered — so anything
                  // asking "is this command offered" has to ask by identity.
                  data-command={c.id}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => void runActive()}
                  className={cn(
                    'flex items-center gap-2.5 w-full h-8 px-2 rounded-[var(--radius-sm)] text-left',
                    'transition-colors duration-[var(--dur-instant)]',
                    i === active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <span className={i === active ? 'text-[var(--text-accent)]' : 'text-[var(--text-tertiary)]'}>{c.icon}</span>
                  <span className="text-xs text-[var(--text-primary)] truncate">{c.label}</span>
                  {c.hint && <span className="text-2xs text-[var(--text-disabled)] truncate">{c.hint}</span>}
                  {i === active && <CornerDownLeft size={11} className="ml-auto text-[var(--text-disabled)] shrink-0" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="hairline-t px-3 h-7 flex items-center gap-3 text-[10px] text-[var(--text-disabled)]">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="inline-flex items-center gap-1"><Kbd>⏎</Kbd> run</span>
          <span className="ml-auto">{matches.length} of {commands.length}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
