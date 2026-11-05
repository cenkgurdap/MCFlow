import { platform } from '@/platform';
import type { Gate } from '@/core/gating/types';
import type { DerivedParameterDef } from '@/core/derived';
import type { LayoutKind } from '@/core/layout/layoutKind';
import { asBiophysicsMode, clampStep, type BiophysicsSample } from '@/core/biophysics/pipeline';
import { useBiophysics } from './biophysicsStore';
import { useDerived } from './derivedStore';
import { useGates } from './gateStore';
import { makePanel, usePlot, type LayoutDef, type PanelConfig } from './plotStore';
import { useSpectral } from './spectralStore';
import { useWorkspace } from './workspaceStore';
import { restoreWorkspace } from './workspaceIO';
import { serialiseWorkspace, type WorkspaceFile } from '@/core/workspace';

/* ==========================================================================
   Keeping several windows on one workspace in step.

   Two windows on the same workspace are two views of one analysis, not two
   copies of it. A gate drawn in either has to appear in both, immediately, or
   the second window is worse than useless — it is actively misleading.

   The mechanism follows the architecture already in place rather than fighting
   it. `A workspace stores analysis, not data` is the existing decision, and it
   is exactly what makes this tractable: the shared document is small, plain
   JSON, and event data never crosses a process boundary. Each window reads its
   own .fcs files from disk once and then exchanges only the analysis on top.

   Direction of travel:

       window A mutates a store
         -> `snapshot()` on the next tick, debounced
         -> main process rebroadcasts to siblings on the same workspace
         -> window B `apply()`s it with `applying` set, so its own subscription
            does not echo the change straight back

   The debounce matters more than it looks: dragging a gate handle fires a store
   update per pointer move, and without it a drag in one window would put a
   frame of IPC between every frame of rendering in the other.
   ========================================================================== */

/** Fields that make up one workspace's shared analysis state. */
export interface SharedSnapshot {
  /** Monotonic per-origin, so a late-arriving stale patch can be discarded. */
  seq: number;
  /** Which window produced it, so a window can ignore its own echo. */
  origin: string;

  samples: Array<{
    id: string;
    name: string;
    filePath: string | null;
    groupId: string;
    acquisitionOverride: 'conventional' | 'spectral' | null;
  }>;
  groups: Array<{ id: string; name: string }>;
  selectedSampleId: string | null;

  gating: {
    shared: Gate[];
    divergent: Record<string, Gate[]>;
    /** Per-sample boundaries for unlinked gates. Optional: a sibling on an older build sends none. */
    overrides?: Record<string, Record<string, Gate>>;
  };
  derivedParameters: DerivedParameterDef[];

  spectral: {
    spectra: Array<{ id: string; label: string; values: number[]; isAutofluorescence: boolean; sourceSampleId: string | null; eventCount: number }>;
    method: 'ols' | 'wls';
    computedAt: string | null;
  };

  // `kind` travels with the rest: a sibling window that adopted a workspace
  // holding thirteen reference worksheets has to know they are reference
  // worksheets, or its own layout dropdown lists them as general ones. Typed as
  // the shared union since 2026-08-14, so a biophysics worksheet crosses the
  // boundary as one rather than arriving as a general layout.
  layouts: Array<{ id: string; name: string; panels: PanelConfig[]; activePanelId: string; kind?: LayoutKind }>;

  /**
   * The Biophysics pipeline's own setup, as it stands.
   *
   * Sent for the same reason the unmixing wizard's assignments are saved with a
   * workspace: the worksheets travel as layouts with `kind: 'biophysics'` and
   * are orphans without the records that name them, and the fits are what the
   * review chart and the histogram overlay draw. The *gates* need nothing here —
   * they are ordinary gates and travel in `gating` with everything else, which
   * is the whole architectural claim of that panel arriving as a property of the
   * sync rather than as an extra field.
   *
   * Optional: a sibling on a build without the panel sends none, and reading its
   * absence as "no pipeline set up" is the honest interpretation.
   */
  biophysics?: {
    step: number;
    mode?: string;
    cellGateShared?: boolean;
    propertyId: string | null;
    probeId: string | null;
    channels?: [string, string] | null;
    parameterId: string | null;
    liveGateId: string | null;
    singletGateId?: string | null;
    samples: BiophysicsSample[];
  };
}

/** This window's identity. Assigned by the main process; a fallback in-browser. */
let windowId = `w${Math.random().toString(36).slice(2, 8)}`;
let seq = 0;

/**
 * The content of a snapshot, ignoring who sent it and when.
 *
 * Used to tell an echo from a real divergence after applying a remote
 * snapshot — see the end of `applyOne`. Comparing content rather than timing is
 * what makes that check exact: two states either say the same thing or they do
 * not.
 */
function contentOf(snap: SharedSnapshot): string {
  const { seq: _seq, origin: _origin, ...rest } = snap;
  return JSON.stringify(rest);
}

/**
 * True while a remote snapshot is being installed.
 *
 * Without this, applying an incoming change fires every store subscription,
 * which would broadcast it straight back to the window it came from — two
 * windows would then trade the same edit forever.
 */
let applying = false;

export function isApplyingRemote(): boolean {
  return applying;
}

export function setWindowId(id: string): void {
  windowId = id;
}

export function currentWindowId(): string {
  return windowId;
}

/* -------------------------------------------------------------------------
   Capture
   ------------------------------------------------------------------------- */

export function snapshot(): SharedSnapshot {
  const ws = useWorkspace.getState();
  const gates = useGates.getState();
  const spectral = useSpectral.getState();
  const bio = useBiophysics.getState();
  const plot = usePlot.getState();

  return {
    seq: ++seq,
    origin: windowId,
    samples: ws.samples.map((s) => ({
      id: s.id,
      name: s.name,
      filePath: s.filePath,
      groupId: s.groupId,
      acquisitionOverride: s.acquisitionOverride,
    })),
    groups: ws.groups.map((g) => ({ id: g.id, name: g.name })),
    selectedSampleId: ws.selectedSampleId,
    gating: { shared: gates.shared, divergent: gates.divergent, overrides: gates.overrides },
    derivedParameters: useDerived.getState().defs,
    spectral: {
      spectra: spectral.spectra.map((s) => ({
        id: s.id,
        label: s.label,
        values: Array.from(s.values),
        isAutofluorescence: s.isAutofluorescence,
        sourceSampleId: s.sourceSampleId,
        eventCount: s.eventCount,
      })),
      method: spectral.method,
      computedAt: spectral.computedAt,
    },
    biophysics: {
      step: bio.step,
      mode: bio.mode,
      cellGateShared: bio.cellGateShared,
      propertyId: bio.propertyId,
      probeId: bio.probeId,
      channels: bio.channels ? [bio.channels[0], bio.channels[1]] : null,
      parameterId: bio.parameterId,
      liveGateId: bio.liveGateId,
      singletGateId: bio.singletGateId,
      samples: bio.samples,
    },
    layouts: plot.allLayouts(),
  };
}

/* -------------------------------------------------------------------------
   Apply
   ------------------------------------------------------------------------- */

/**
 * Serialised apply queue.
 *
 * Applying is asynchronous — a changed file set means re-reading .fcs files,
 * which takes about a second — and snapshots keep arriving while that runs.
 * Letting two applies overlap loses data in the worst possible way: the slow
 * one finishes last and writes its *older* gate list over the newer one that
 * arrived meanwhile, so a gate drawn in the other window appears and then
 * silently vanishes.
 *
 * So applies run one at a time, and only the newest queued snapshot is applied
 * — the intermediate ones are already superseded by it.
 */
let applyChain: Promise<void> = Promise.resolve();
let queued: SharedSnapshot | null = null;

export function applySnapshot(snap: SharedSnapshot): Promise<void> {
  if (snap.origin === windowId) return applyChain;
  // Handed over. From here this window has a workspace of its own to speak for.
  awaitingHandoff = false;
  // Latest wins: a snapshot is a whole state, not a delta, so an older one
  // waiting in the queue has nothing left to contribute.
  if (queued && queued.origin === snap.origin && queued.seq > snap.seq) return applyChain;
  queued = snap;
  applyChain = applyChain.then(async () => {
    const next = queued;
    queued = null;
    if (next) await applyOne(next);
  });
  return applyChain;
}

/**
 * Install a snapshot from another window.
 *
 * Sample *identity* syncs; sample *data* does not. When the file set differs
 * the window re-reads the .fcs files itself, which is the same path
 * `restoreWorkspace` takes and costs about a second — the alternative is
 * shipping 156 MB of Float32Array over IPC on every window open.
 */
async function applyOne(snap: SharedSnapshot): Promise<void> {
  applying = true;
  try {
    const ws = useWorkspace.getState();
    const currentIds = ws.samples.map((s) => s.id).sort().join('|');
    const incomingIds = snap.samples.map((s) => s.id).sort().join('|');

    if (currentIds !== incomingIds) {
      // The file set itself changed — an import or a removal. Rebuild from the
      // paths, then fall through and apply the analysis on top.
      await rehydrateSamples(snap);
    } else {
      for (const s of snap.samples) {
        const match = ws.samples.find((x) => x.id === s.id);
        if (!match) continue;
        if (match.name !== s.name) ws.renameSample(s.id, s.name);
        if (match.acquisitionOverride !== s.acquisitionOverride) {
          ws.setAcquisitionOverride(s.id, s.acquisitionOverride);
        }
      }
    }

    useGates.setState({
      shared: snap.gating.shared,
      divergent: snap.gating.divergent,
      overrides: snap.gating.overrides ?? {},
    });
    useDerived.setState({ defs: snap.derivedParameters });

    useSpectral.setState({
      spectra: snap.spectral.spectra.map((s) => ({ ...s, values: Float64Array.from(s.values) })),
      method: snap.spectral.method,
      computedAt: snap.spectral.computedAt,
    });

    // Absent from a sibling on a build without the panel, and from every
    // snapshot written before it existed. Leaving this window's own state alone
    // in that case is the honest reading: the sender said nothing about it.
    if (snap.biophysics) {
      // Clamped into the mode the snapshot carries rather than into 1-4: a
      // sibling window on multi mode's Step 5 must not arrive here as Step 4.
      const mode = asBiophysicsMode(snap.biophysics.mode);
      useBiophysics.getState().setAll({
        step: clampStep(mode, snap.biophysics.step),
        mode,
        cellGateShared: snap.biophysics.cellGateShared === true,
        propertyId: snap.biophysics.propertyId,
        probeId: snap.biophysics.probeId,
        channels: snap.biophysics.channels ?? null,
        parameterId: snap.biophysics.parameterId,
        liveGateId: snap.biophysics.liveGateId,
        singletGateId: snap.biophysics.singletGateId ?? null,
        samples: snap.biophysics.samples,
      });
    }

    // Layouts: this window keeps showing the layout it was showing. Only its
    // *content* updates, and only if the other window edited that same layout.
    // A window viewing the statistics layout does not get yanked to the gating
    // one because someone added a plot there.
    const plot = usePlot.getState();
    const layouts: LayoutDef[] = snap.layouts.map((l) => ({
      ...l,
      panels: l.panels.map((p) => makePanel(p)),
    }));

    // A window owns the layout it is looking at. A sibling's snapshot is always
    // slightly behind — it cannot know about a layout created here a moment
    // ago — so a layout missing from it means "not yet seen", never "deleted".
    // Dropping it would make a brand-new layout flicker away the instant the
    // other window happened to broadcast anything.
    if (!layouts.some((l) => l.id === plot.activeLayoutId)) {
      layouts.push({
        id: plot.activeLayoutId,
        name: plot.activeLayoutName,
        panels: plot.panels,
        activePanelId: plot.activePanelId,
        ...(plot.activeLayoutKind ? { kind: plot.activeLayoutKind } : {}),
      });
    }
    plot.setLayouts(layouts, plot.activeLayoutId);
  } finally {
    applying = false;
  }

  // Did anything of ours survive that the sender did not know about?
  //
  // Broadcasts are suppressed while applying, so a gate the user drew in the
  // half-second a remote apply was in flight would otherwise be dropped on the
  // floor — it never reaches the other window, and the next snapshot from
  // there overwrites it. Comparing the resulting state against what arrived
  // distinguishes that from a plain echo: an echo is byte-identical, a local
  // edit is not.
  //
  // **Except on the first apply this window ever performs.**
  //
  // A window that has just loaded has had no time for a local edit, so any
  // difference it finds here is a difference by construction — and pushing it
  // back is actively harmful, because the push tells the sender this window's
  // *whole* state, sample list included. A window handed an early snapshot (one
  // broadcast before its sibling had finished importing) would answer with "no
  // samples" and the sibling would rehydrate itself to empty to match. That has
  // now happened twice: once through the layout-window adoption this guard
  // originally named, and again on 2026-08-03 when the on-load hand-off was
  // re-pointed at any window holding a workspace path. The condition is stated
  // as what it always meant — *nothing of ours can have survived yet* — rather
  // than as the one path that used to reach it.
  //
  // The sender learns about anything real from the first genuine edit, which is
  // soon enough for a window that has not been touched.
  if (firstApply) {
    firstApply = false;
    return;
  }
  if (contentOf(snapshot()) !== contentOf(snap)) push();
}

/** Re-read the sample files named in a snapshot. */
async function rehydrateSamples(snap: SharedSnapshot): Promise<void> {
  // `restoreWorkspace` already does exactly this — resolve paths, import, then
  // re-apply names and overrides — so a minimal workspace document is built
  // around the snapshot rather than duplicating that logic here.
  // Through the workspace serialiser, so a one-sided gate's open end reaches the
  // sibling as Infinity rather than as the null JSON would write.
  await restoreWorkspace(serialiseWorkspace({
    version: 5,
    name: 'shared',
    savedAt: new Date().toISOString(),
    application: 'MCFlow',
    samples: snap.samples.map((s) => ({
      id: s.id,
      name: s.name,
      fileName: (s.filePath ?? '').split(/[\\/]/).pop() ?? s.id,
      filePath: s.filePath,
      groupId: s.groupId,
      colorIndex: 0,
      acquisitionOverride: s.acquisitionOverride,
      // Zero means "unknown", which suppresses the changed-underneath warning:
      // this is a live sync, not a reload of something saved earlier.
      eventCount: 0,
      parameterCount: 0,
    })),
    groups: snap.groups,
    gating: snap.gating,
    derivedParameters: snap.derivedParameters,
    spectral: { spectra: snap.spectral.spectra, method: snap.spectral.method },
    plot: { panels: [], columns: 1, layouts: [], activeLayoutId: null },
  } as WorkspaceFile));
}

/* -------------------------------------------------------------------------
   Wiring
   ------------------------------------------------------------------------- */

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Queue a broadcast of this window's state.
 *
 * Debounced at 120 ms: below the point where a collaborator notices lag, above
 * the pointer-move rate of a gate drag — so dragging a handle broadcasts once
 * when it lands rather than sixty times on the way there.
 *
 * Suppressed while a remote snapshot is being applied, because every store
 * write that apply performs would otherwise be echoed straight back. Edits made
 * by the *user* during that window are not lost: `applyOne` compares the
 * resulting state against what it was handed and pushes if they differ.
 */
/*
   `awaitingAdoption`, `needsLayoutName`, `ownLayoutId` and `claimingOwnLayout`
   are deleted (2026-08-03, Item 7). All four existed for one situation: a window
   opened through *New Layout Window*, which started empty and was handed its
   sibling's whole workspace over IPC a moment later. That window had to stay
   silent until the handover (announcing "no samples" reads as "the user removed
   everything" and the sibling would wipe itself to match), take a layout id of
   its own before anything arrived, re-assert that id after `rehydrateSamples`
   reset it, and name the layout once it knew how many the workspace had.

   None of it is reachable now. **New Window opens an independent, blank
   instance** — nothing is handed to it, so there is nothing to wait for and
   nothing to adopt. What remains of the sync is the case that was always
   well-founded and is untouched: two windows that each open the *same*
   workspace file stay in step, and both of them are ordinary windows with real
   state to announce from the moment they load it.

   One of the four survives in substance under a different name. `justClaimed`
   suppressed the divergence push-back on the adoption that gave a layout window
   its own layout; it is now `firstApply`, and it suppresses it on the first
   apply of *any* window. See the note at the end of `applyOne` — the hazard it
   guards against is not specific to layout windows and reappeared the moment the
   on-load hand-off was re-pointed at any window holding a workspace path.
*/

/**
 * True until this window has applied one snapshot from a sibling.
 *
 * Read by the divergence check at the end of `applyOne`, where the note explains
 * why the first apply is the one case that must not push back.
 */
let firstApply = true;

/**
 * True while this window is waiting to be handed a workspace it opened onto.
 *
 * Set by `sync:expect`, which the main process sends when a window loads onto a
 * workspace file some *other* window already holds. Until the hand-off arrives
 * this window has nothing to contribute and must not say so: broadcasting "no
 * samples, no gates" is indistinguishable from the user having removed
 * everything, and the sibling wipes itself to match.
 *
 * This is the `awaitingAdoption` flag from the shared-view architecture, kept
 * and re-scoped rather than deleted with it. Its trigger changed — it was "this
 * is a layout window", it is now "this window opened onto a workspace somebody
 * else already has" — and its reason did not. It was deleted on 2026-08-03 along
 * with the rest of that machinery and put straight back the same day, because
 * the harness caught a window A losing its gates to a freshly-opened window B's
 * empty announcement. The lesson is in *Traps*.
 *
 * The timeout is the safety valve: if no snapshot arrives — the sibling closed
 * underneath it, or its state is genuinely empty — this window stops waiting and
 * behaves like any other rather than going mute for the session.
 */
let awaitingHandoff = false;

function push(): void {
  if (applying || awaitingHandoff) return;
  const p = platform();
  if (!p.broadcastState) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!applying) p.broadcastState!(snapshot() as unknown as Record<string, unknown>);
  }, 120);
}

/**
 * Start syncing this window with its siblings.
 *
 * A no-op outside Electron, and a no-op on a second call, so a React strict-mode
 * double-mount cannot install two subscriptions and double every broadcast.
 */
export function startWindowSync(): () => void {
  if (started) return () => {};
  const p = platform();
  if (!p.broadcastState || !p.onNativeEvent) return () => {};
  started = true;

  const unsubs = [
    useWorkspace.subscribe(push),
    useGates.subscribe(push),
    useDerived.subscribe(push),
    useSpectral.subscribe(push),
    useBiophysics.subscribe(push),
    usePlot.subscribe(push),
    p.onNativeEvent('sync:apply', (...args) => {
      void applySnapshot(args[0] as SharedSnapshot);
    }),
    p.onNativeEvent('sync:window-id', (...args) => {
      setWindowId(String(args[0]));
    }),
  ];

  /*
     Ask, rather than wait to be told.

     Both of the things this window needs at startup — its own id, and whether it
     has siblings holding the same workspace file — used to be *pushed* from the
     main process on `did-finish-load`. That event fires when the document has
     loaded, which is before React has mounted and before the handlers above
     exist, so a pushed message can land on nothing and does. The id already had
     a pull path for exactly that reason; the hand-off did not, and adding one is
     what makes it reliable rather than usually-fine.

     The order matters and is the whole of the fix:

       1. Learn whether a sibling exists.
       2. If one does, go quiet — an empty announcement from a window that is
          about to be handed a workspace reads as "the user removed everything",
          and the sibling will wipe itself to match.
       3. Ask for the sibling's last snapshot and apply it.
       4. Only then start announcing.

     A window with no sibling skips straight to 4, which is every first window and
     every window opened through File ▸ New Window.
  */
  void (async () => {
    let info: { windowId: string | null; onThisWorkspace: number } | undefined;
    try {
      info = await p.windowInfo?.();
    } catch { /* browser fallback, or the window is already closing */ }
    if (!started) return;
    if (info?.windowId) setWindowId(info.windowId);

    const hasSibling = (info?.onThisWorkspace ?? 0) > 1;
    if (!hasSibling) { push(); return; }

    awaitingHandoff = true;
    // The safety valve: if nothing comes back — the sibling closed underneath
    // this window, or its state is genuinely empty — stop waiting rather than
    // going mute for the session.
    setTimeout(() => {
      if (!awaitingHandoff) return;
      awaitingHandoff = false;
      push();
    }, 5000);

    try {
      const snap = await p.requestSync?.();
      if (snap) await applySnapshot(snap as SharedSnapshot);
      else { awaitingHandoff = false; push(); }
    } catch {
      awaitingHandoff = false;
      push();
    }
  })();

  return () => {
    started = false;
    if (timer) clearTimeout(timer);
    for (const off of unsubs) off();
  };
}
