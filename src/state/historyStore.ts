/**
 * Undo and redo for the analysis.
 *
 * **Snapshot-based, not command-based.** Every store here already treats its
 * state as immutable — `updateGate`, `updatePanel` and the rest all build new
 * objects rather than mutating in place — so a "snapshot" is a handful of object
 * references, costing nothing to take and nothing to hold. A command log would
 * need an inverse for each of the forty-odd actions, and the inverse of
 * `removeGate` alone is awkward: it re-parents its children on the way out.
 *
 * The same reasoning as `workspaceIO`: what is captured is the **analysis**, not
 * the data. Gates, panels, matrices, assignments. Unmixed results and parsed
 * event arrays are excluded — they are large, they are derived, and an undo
 * stack holding fifty copies of a 170 000-event unmixing would be the single
 * biggest allocation in the app.
 *
 * **Recording is explicit.** A store subscription would be less code and would
 * be wrong: it cannot tell a user's edit from a workspace being loaded or from a
 * sibling window's state arriving over IPC, and "undo" that reverses a sync is
 * worse than no undo at all. Actions call `record()` before they mutate.
 */

import { create } from 'zustand';
import { useGates } from './gateStore';
import { usePlot } from './plotStore';
import { useBiophysics } from './biophysicsStore';
import { useDerived } from './derivedStore';
import { useSpectral } from './spectralStore';
import { setRecorder } from './historyBus';

/**
 * One point in time.
 *
 * Fields are references into the stores, never copies. That is safe precisely
 * because nothing here is ever mutated in place, and it is what makes a
 * hundred-deep stack free.
 */
export interface HistorySnapshot {
  gates: {
    shared: ReturnType<typeof useGates.getState>['shared'];
    divergent: ReturnType<typeof useGates.getState>['divergent'];
    /** Per-sample boundaries for unlinked gates — as undoable as any other edit. */
    overrides: ReturnType<typeof useGates.getState>['overrides'];
    selectedGateId: string | null;
  };
  plot: {
    panels: ReturnType<typeof usePlot.getState>['panels'];
    activePanelId: string;
    activeLayoutId: string;
    activeLayoutName: string;
    /**
     * The active worksheet's kind, and its absence was a bug (2026-08-28).
     *
     * `otherLayouts` carries a `kind` on every layout it holds, but the *active*
     * layout is not in that map — `plotStore` keeps it unpacked in four separate
     * fields, and this snapshot took three of them. So undo restored the active
     * worksheet's id, its name and its panels, and quietly dropped the one field
     * that says whether it is a general sheet, a reference sheet or a biophysics
     * one. Undoing a build left its own worksheet reading as general; undoing a
     * *Discard setup* brought the sheet back without the marker that makes the
     * walk strip appear on it. Both looked like the layout had come back.
     */
    activeLayoutKind: ReturnType<typeof usePlot.getState>['activeLayoutKind'];
    otherLayouts: ReturnType<typeof usePlot.getState>['otherLayouts'];
  };
  spectral: {
    spectra: ReturnType<typeof useSpectral.getState>['spectra'];
    controls: ReturnType<typeof useSpectral.getState>['controls'];
    method: ReturnType<typeof useSpectral.getState>['method'];
    generalGateId: string | null;
    computedAt: string | null;
    /*
       The wizard's own position, captured with everything else.

       Undoing an action taken in Step 3 has to put the panel back on Step 3
       showing the control it was taken on — otherwise Ctrl+Z restores the gates
       correctly and leaves the user looking at a screen that no longer describes
       them.
    */
    selectedIds: ReturnType<typeof useSpectral.getState>['selectedIds'];
    step: ReturnType<typeof useSpectral.getState>['step'];
    walkIndex: number;
  };
  /**
   * The Biophysics pipeline's per-sample records.
   *
   * On the stack for the reason the wizard's `controls` are: the *gates* undo
   * correctly on their own — they are ordinary gates in `gates` above — but the
   * records naming them would not, so Ctrl+Z after a re-fit would restore three
   * gates while the panel still held the two-population fit that replaced them.
   * A fit and the gates it produced are one action.
   *
   * `liveGateId` travels with it for the same reason: undoing past the step that
   * placed the live-cell gate has to leave the pipeline believing it has none,
   * or Step 1 reports itself complete with nothing in the tree. `singletGateId`
   * is placed by the same step in multi mode and travels beside it — it is what
   * the fit is read inside, so a pipeline still naming a gate the undo removed
   * would bin the distribution over nothing.
   *
   * The *step* is not captured, unlike the wizard's. The two panels differ here
   * because their steps do: the wizard's Step 3 shows one control's worksheet, so
   * undoing a gate edit has to put the panel back on that control or the screen
   * stops describing what was restored. Every biophysics step shows the whole
   * sample set, and `walkIndex` — which is the equivalent pointer — is captured.
   */
  biophysics: {
    samples: ReturnType<typeof useBiophysics.getState>['samples'];
    liveGateId: string | null;
    singletGateId: string | null;
    parameterId: string | null;
    walkIndex: number;
    /**
     * Whether the *Cells* gate is one shape for every sample.
     *
     * On the stack because it is a decision, not a position: it decides what
     * Step 1 places and, through `setCellGateShared`, whether the per-sample
     * overrides exist at all — so undoing past that toggle has to put the flag
     * back beside the gates it explains. `mode` is deliberately not here, for
     * the same reason `step` is not: it says where the user is, not what the
     * analysis contains.
     */
    cellGateShared: boolean;
  };
  /**
   * Derived parameter definitions.
   *
   * Analysis, not data — an expression is a decision the user made — so it is on
   * the stack. The *columns* it produces are not: they are recomputed from the
   * definition on demand and cached against the sample, exactly like a
   * transformed column.
   */
  derived: ReturnType<typeof useDerived.getState>['defs'];
}

/** A recorded step: the state *before* it, and what it was called. */
interface Entry {
  label: string;
  state: HistorySnapshot;
}

/**
 * How deep the stack goes.
 *
 * Fifty is well past the point anyone reasons about ("undo back to before I
 * started this gate") and, at reference-sized snapshots, costs nothing.
 */
export const HISTORY_LIMIT = 50;

/**
 * How long a coalescing key stays open, in ms.
 *
 * A gate dragged across the plot calls `updateGate` on every pointer move. Each
 * of those is a state change but only one of them is a *user action*, and an
 * undo stack that makes someone press Ctrl+Z ninety times to reverse one drag is
 * not an undo stack. Consecutive records sharing a key inside this window keep
 * the first one's "before" state, which is exactly the state the drag started
 * from.
 */
const COALESCE_MS = 700;

export function capture(): HistorySnapshot {
  const g = useGates.getState();
  const p = usePlot.getState();
  const s = useSpectral.getState();
  const b = useBiophysics.getState();
  return {
    gates: {
      shared: g.shared, divergent: g.divergent, overrides: g.overrides,
      selectedGateId: g.selectedGateId,
    },
    plot: {
      panels: p.panels, activePanelId: p.activePanelId,
      activeLayoutId: p.activeLayoutId, activeLayoutName: p.activeLayoutName,
      activeLayoutKind: p.activeLayoutKind, otherLayouts: p.otherLayouts,
    },
    spectral: {
      spectra: s.spectra, controls: s.controls, method: s.method,
      generalGateId: s.generalGateId, computedAt: s.computedAt,
      selectedIds: s.selectedIds, step: s.step, walkIndex: s.walkIndex,
    },
    biophysics: {
      samples: b.samples, liveGateId: b.liveGateId, singletGateId: b.singletGateId,
      parameterId: b.parameterId, walkIndex: b.walkIndex, cellGateShared: b.cellGateShared,
    },
    derived: useDerived.getState().defs,
  };
}

export function restore(snap: HistorySnapshot): void {
  // Written through `setState` rather than through each store's actions: an
  // action would apply its own invariants (clearing a viewport, re-selecting a
  // panel) on top of the state being restored, which is the opposite of what
  // restoring means.
  useGates.setState({
    shared: snap.gates.shared,
    divergent: snap.gates.divergent,
    overrides: snap.gates.overrides,
    selectedGateId: snap.gates.selectedGateId,
  });
  usePlot.setState({
    panels: snap.plot.panels,
    activePanelId: snap.plot.activePanelId,
    activeLayoutId: snap.plot.activeLayoutId,
    activeLayoutName: snap.plot.activeLayoutName,
    activeLayoutKind: snap.plot.activeLayoutKind,
    otherLayouts: snap.plot.otherLayouts,
  });
  useSpectral.setState({
    spectra: snap.spectral.spectra,
    controls: snap.spectral.controls,
    method: snap.spectral.method,
    generalGateId: snap.spectral.generalGateId,
    selectedIds: snap.spectral.selectedIds,
    step: snap.spectral.step,
    walkIndex: snap.spectral.walkIndex,
    computedAt: snap.spectral.computedAt,
  });
  useBiophysics.setState({
    samples: snap.biophysics.samples,
    liveGateId: snap.biophysics.liveGateId,
    singletGateId: snap.biophysics.singletGateId,
    parameterId: snap.biophysics.parameterId,
    walkIndex: snap.biophysics.walkIndex,
    cellGateShared: snap.biophysics.cellGateShared,
  });
  useDerived.setState({ defs: snap.derived });
}

/**
 * Do these two snapshots describe the same analysis?
 *
 * Reference equality across the captured fields, which is sound for the same
 * reason snapshots can hold references: a real change always produces a new
 * object. Its job is to keep a button that turned out to be a no-op from
 * costing the user a press of Ctrl+Z that appears to do nothing.
 */
export function sameState(a: HistorySnapshot, b: HistorySnapshot): boolean {
  return (
    a.gates.shared === b.gates.shared &&
    a.gates.divergent === b.gates.divergent &&
    a.gates.overrides === b.gates.overrides &&
    a.plot.panels === b.plot.panels &&
    a.plot.otherLayouts === b.plot.otherLayouts &&
    a.plot.activeLayoutId === b.plot.activeLayoutId &&
    a.plot.activeLayoutName === b.plot.activeLayoutName &&
    a.plot.activeLayoutKind === b.plot.activeLayoutKind &&
    a.spectral.spectra === b.spectral.spectra &&
    a.spectral.controls === b.spectral.controls &&
    a.spectral.method === b.spectral.method &&
    a.spectral.generalGateId === b.spectral.generalGateId &&
    a.spectral.selectedIds === b.spectral.selectedIds &&
    a.biophysics.samples === b.biophysics.samples &&
    a.biophysics.liveGateId === b.biophysics.liveGateId &&
    a.biophysics.singletGateId === b.biophysics.singletGateId &&
    a.biophysics.parameterId === b.biophysics.parameterId &&
    a.biophysics.cellGateShared === b.biophysics.cellGateShared &&
    a.derived === b.derived
  );
}

interface HistoryState {
  past: Entry[];
  future: Entry[];
  /** Set while an undo or redo is being applied, so nothing re-records it. */
  applying: boolean;

  /**
   * Note the state *before* a change, with a name for it.
   *
   * Call it immediately before mutating, not after: what undo needs is where
   * the user was, and after the mutation that is gone. `coalesceKey` folds a
   * continuous gesture — a drag, a slider — into one entry.
   */
  record(label: string, coalesceKey?: string): void;

  undo(): string | null;
  redo(): string | null;
  /** Forget everything, e.g. when a different workspace is opened. */
  reset(): void;

  canUndo(): boolean;
  canRedo(): boolean;
  /** What Ctrl+Z would reverse, for a menu item or a toast. */
  undoLabel(): string | null;
  redoLabel(): string | null;
}

let lastKey: string | null = null;
let lastAt = 0;

export const useHistory = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  applying: false,

  record(label, coalesceKey) {
    // An undo is itself a state change; recording it would make Ctrl+Z toggle
    // between two states forever.
    if (get().applying) return;

    const now = Date.now();
    const continuing = !!coalesceKey && coalesceKey === lastKey && now - lastAt < COALESCE_MS;
    lastKey = coalesceKey ?? null;
    lastAt = now;
    if (continuing) return;

    const state = capture();
    const past = get().past;
    // Nothing changed since the last record, so there is nothing to come back
    // to — a second entry here would be an undo step that does nothing visible.
    if (past.length > 0 && sameState(past[past.length - 1]!.state, state)) return;

    const next = [...past, { label, state }];
    set({
      past: next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next,
      // Any new action abandons the redo branch. This is the standard model and
      // the only one that does not need a tree UI to be comprehensible.
      future: [],
    });
  },

  undo() {
    const { past, future } = get();
    const entry = past[past.length - 1];
    if (!entry) return null;
    // Coalescing must not span an undo: the next edit is a new action even if
    // it shares a key with whatever was happening before.
    lastKey = null;
    set({ applying: true });
    try {
      const current = capture();
      set({
        past: past.slice(0, -1),
        future: [...future, { label: entry.label, state: current }],
      });
      restore(entry.state);
    } finally {
      set({ applying: false });
    }
    return entry.label;
  },

  redo() {
    const { past, future } = get();
    const entry = future[future.length - 1];
    if (!entry) return null;
    lastKey = null;
    set({ applying: true });
    try {
      const current = capture();
      set({
        past: [...past, { label: entry.label, state: current }],
        future: future.slice(0, -1),
      });
      restore(entry.state);
    } finally {
      set({ applying: false });
    }
    return entry.label;
  },

  reset() {
    lastKey = null;
    lastAt = 0;
    set({ past: [], future: [], applying: false });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  undoLabel: () => get().past[get().past.length - 1]?.label ?? null,
  redoLabel: () => get().future[get().future.length - 1]?.label ?? null,
}));

/**
 * Record a step and run it, so a caller cannot record and then forget to act —
 * or act and then record, which captures the wrong state and is invisible until
 * someone presses Ctrl+Z.
 */
export function withHistory<T>(label: string, fn: () => T, coalesceKey?: string): T {
  useHistory.getState().record(label, coalesceKey);
  return fn();
}

/**
 * Wire the stores' `record()` calls to this stack.
 *
 * At import, not behind an init function: a history stack that has to be
 * switched on is a history stack somebody will ship switched off, which is the
 * exact failure this pass exists to fix. `historyBus.isRecording()` makes the
 * connection assertable rather than assumed.
 *
 * Nothing arriving from a sibling window is recorded, and that falls out of the
 * design rather than needing a flag: `windowSync` writes through `setState` and
 * `setLayouts`, neither of which is instrumented. Only actions a user invokes
 * call `record`.
 */
setRecorder((label, coalesceKey) => useHistory.getState().record(label, coalesceKey));
