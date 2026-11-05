import { create } from 'zustand';

export type Theme = 'dark' | 'light';

/**
 * The views a user can reach, in the order the switcher lists them.
 *
 * `parameters` sits between analysis and unmixing because that is the order the
 * work happens in: gate the data, define whatever the panel needs computing, then
 * resolve the spillover.
 *
 * **`unmixing` and `compensation` are siblings, not alternatives to configure.**
 * They are the same question for two kinds of instrument, and which one applies
 * is read from the files rather than chosen — see `state/viewLock.ts`. Both are
 * always in the list; the one that does not match the loaded samples is
 * disabled with the reason on it.
 *
 * **`umap` and `biophysics` come after a gap.** The first six are one pipeline
 * — gate, compute, unmix, summarise, write out — and each is a stage of the work
 * everybody does with every file. The last two are a different *kind* of thing:
 * analyses that run **on top of** that pipeline rather than being a step in it,
 * and which most workspaces never open. Sixth in a row of six would say Export
 * is followed by Biophysics, which is not a sentence anybody would write down.
 *
 * `umap` is first of the two because it reads the pipeline's own output — the
 * export — so it is the nearer of the two to the row before it. Biophysics is
 * last and set further apart: it is the only view that owns a multi-step
 * experimental protocol rather than a single question, and the switcher gives it
 * a wider gap to say so.
 *
 * The style guide is deliberately absent. It was a Stage 1 development aid for
 * signing off the design tokens, never a feature — `src/dev/StyleGuide.tsx`
 * still exists and still compiles, but nothing imports it, so it is not in the
 * bundle and there is no route to it.
 */
export type MainView =
  | 'analysis' | 'parameters' | 'unmixing' | 'compensation' | 'statistics' | 'export'
  | 'umap' | 'biophysics';

const THEME_KEY = 'mcflow.theme';
const GATE_HINT_KEY = 'mcflow.gateHintsShown';

/**
 * How many times the click-to-close hint appears before it stops.
 *
 * Three: enough that the gesture is learned, few enough that it never becomes
 * furniture for someone who already knows it. Dismissing it once retires it.
 */
export const GATE_HINT_LIMIT = 3;

/**
 * The theme, from what was last chosen on this machine.
 *
 * **Light is the default** (2026-08-13). Both themes are complete and either is
 * a fine place to work; what decides the default is where the output goes. A
 * figure exported from this application is going into a manuscript, a slide or a
 * poster, all of which are white, and a plot framed and read against a near-black
 * surface is being judged on a background it will never be printed on. Somebody
 * who prefers dark chooses it once and the choice is remembered.
 *
 * Per machine, in `localStorage`, and deliberately not in the workspace: which
 * theme somebody works in is a property of the person, not of the analysis, and
 * a workspace carrying one would re-theme a colleague's screen on open.
 */
function readStoredTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : 'light';
}

function readGateHintsShown(): number {
  if (typeof localStorage === 'undefined') return 0;
  const n = Number.parseInt(localStorage.getItem(GATE_HINT_KEY) ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export type MissingFilesChoice = 'accept' | 'locate' | 'skip' | 'cancel';

export interface MissingFilesPrompt {
  /** The workspace's name, as its file is called. */
  workspace: string;
  /** File names still not found. */
  missing: string[];
  /** How many data files the workspace names in all. */
  total: number;
  /** Files found under another name that hold the recorded event count — offered, not used. */
  suggestions: Array<{ saved: string; found: string; events: number }>;
  answer: (choice: MissingFilesChoice) => void;
}

interface UIState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  view: MainView;
  setView: (v: MainView) => void;

  sidebarWidth: number;
  inspectorWidth: number;
  sidebarCollapsed: boolean;
  inspectorCollapsed: boolean;
  setSidebarWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  /** Times the gate-drawing hint has been shown; persisted across sessions. */
  gateHintsShown: number;
  noteGateHintShown: () => void;
  dismissGateHint: () => void;

  /**
   * A transient message from an action that has no panel of its own.
   *
   * Loading an unmixing matrix from the native menu is the case that needed it:
   * the result — applied, or rejected because the detectors differ — has to
   * reach the user, and the menu has nowhere to put it. Deliberately one slot
   * rather than a queue: these are results of a thing the user just did, so the
   * newest is always the relevant one.
   */
  notice: { tone: 'ok' | 'warn' | 'err'; text: string } | null;
  setNotice: (n: { tone: 'ok' | 'warn' | 'err'; text: string } | null) => void;

  /**
   * A gate deletion waiting to be confirmed.
   *
   * Escape deletes the selected **plot** outright and asks before deleting the
   * selected **gate**, and the asymmetry is the point: a plot is an arrangement
   * of a handful of settings and is one Ctrl+Z away, whereas a gate is analysis
   * — it has a name someone chose, statistics computed from it, possibly
   * children that get re-parented on the way out. One keystroke should not be
   * able to do that silently.
   *
   * It lives here rather than in the plot or the tree because either can hold
   * the selection, and two confirmations that could both be open at once is
   * exactly the ambiguity this is meant to remove.
   *
   * **A batch, always, even of one.** The tree can select several populations,
   * and a set removed together has to be resolved together — see `removeGates`.
   * A single delete going down a second path is how the two answers come to
   * disagree about where a surviving child lands. `name` is what to call the
   * batch: one gate's name, or a count.
   */
  pendingGateDelete: { sampleId: string; gateIds: string[]; name: string } | null;
  askDeleteGate: (sampleId: string, gateIds: string[], name: string) => void;
  cancelDeleteGate: () => void;

  /**
   * A workspace being opened whose data files were not all found (2026-10-28).
   *
   * The open waits on `answer`: *Locate folder…* re-points the missing files by
   * name and asks again if any are still missing, *Open without them* restores
   * what was found, *Cancel* opens nothing. Asked **before** the restore runs,
   * so a located file is restored like any other — under its saved sample id,
   * with every gate, fit and control assignment still attached.
   */
  pendingMissingFiles: MissingFilesPrompt | null;
  askMissingFiles: (prompt: Omit<MissingFilesPrompt, 'answer'>) => Promise<MissingFilesChoice>;
  answerMissingFiles: (choice: MissingFilesChoice) => void;

  /*
     `isLayoutWindow` is deleted (2026-08-03, Item 7). It was set from a
     `?layout=1` query the main process appended when it created an additional
     *view* of a workspace, and it suppressed first-run behaviour in a window
     that was about to be handed its sibling's state. File ▸ New Window opens an
     independent, blank instance now — there is nothing to adopt and nothing to
     suppress, and every window is an ordinary one.
  */

  /**
   * The axis the inspector's axis settings are pointed at.
   *
   * The settings themselves always follow the *active panel* — same rule the
   * population selector already uses — so this only says which of the two axes
   * was last reached for, which is what a double-click on an axis is asking to
   * edit. Transient: it is a pointer at a UI surface, not part of the analysis.
   */
  axisFocus: { panelId: string; axis: 'x' | 'y' } | null;
  /** Point the inspector at an axis, revealing the inspector if it is collapsed. */
  focusAxis: (panelId: string, axis: 'x' | 'y') => void;
}

export const useUI = create<UIState>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (t) => {
    applyTheme(t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
    set({ theme: t });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  // Analysis is where the work happens, and now the landing view: the app used
  // to open on the style guide, which was only ever right while it was being
  // designed.
  view: 'analysis',
  setView: (v) => set({ view: v }),

  sidebarWidth: 264,
  inspectorWidth: 296,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  setSidebarWidth: (w) => set({ sidebarWidth: Math.min(460, Math.max(190, w)) }),
  setInspectorWidth: (w) => set({ inspectorWidth: Math.min(520, Math.max(240, w)) }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  gateHintsShown: readGateHintsShown(),
  noteGateHintShown: () => {
    const next = get().gateHintsShown + 1;
    try { localStorage.setItem(GATE_HINT_KEY, String(next)); } catch { /* private mode */ }
    set({ gateHintsShown: next });
  },
  dismissGateHint: () => {
    // An explicit dismissal means "I know this" — retire the hint outright
    // rather than showing it the remaining times.
    try { localStorage.setItem(GATE_HINT_KEY, String(GATE_HINT_LIMIT)); } catch { /* private mode */ }
    set({ gateHintsShown: GATE_HINT_LIMIT });
  },

  notice: null,
  setNotice: (n) => set({ notice: n }),

  pendingGateDelete: null,
  askDeleteGate: (sampleId, gateIds, name) => set({ pendingGateDelete: { sampleId, gateIds, name } }),
  cancelDeleteGate: () => set({ pendingGateDelete: null }),

  pendingMissingFiles: null,
  askMissingFiles: (prompt) => new Promise<MissingFilesChoice>((resolve) => {
    // A second open while one is still asking answers the first with Cancel,
    // so no promise is left waiting on a card that is no longer shown.
    get().pendingMissingFiles?.answer('cancel');
    set({ pendingMissingFiles: { ...prompt, answer: resolve } });
  }),
  answerMissingFiles: (choice) => {
    const p = get().pendingMissingFiles;
    set({ pendingMissingFiles: null });
    p?.answer(choice);
  },

  axisFocus: null,
  focusAxis: (panelId, axis) => set({
    axisFocus: { panelId, axis },
    // A shortcut that opens a panel has to actually open it. Double-clicking an
    // axis with the inspector collapsed would otherwise appear to do nothing —
    // which is how the transform popover's own discoverability problem started.
    inspectorCollapsed: false,
  }),
}));

/**
 * `readIsLayoutWindow` is deleted with the flag it read — see the note on the
 * state above. No `?layout=1` is appended to any window's URL any more.
 */
