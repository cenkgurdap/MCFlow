import { create } from 'zustand';
import { parseFcs, detectAcquisitionType, type DetectionResult } from '@/core/fcs/parser';
import { FcsParseError, type AcquisitionType, type ParsedFcs } from '@/core/fcs/types';
import { displayNameFromFile, parseControlIdentity, type ControlIdentity } from '@/core/naming';
import { canMoveBlock, moveBlock, moveBlockBy } from '@/core/reorder';
import { useDirty } from './dirtyStore';
import { notifyWorkspaceCleared } from './workspaceCleared';

/** See the note in `regroup`. */
const markWorkspaceDirty = () => useDirty.getState().markDirty();
import type { FileRef } from '@/platform';

export interface Sample {
  id: string;
  /** Editable display name; seeded from the filename. */
  name: string;
  fileName: string;
  filePath: string | null;
  fileSize: number;
  groupId: string;
  parsed: ParsedFcs;
  detection: DetectionResult;
  /** User override; when set it wins over `detection.type`. */
  acquisitionOverride: AcquisitionType | null;
  /** Parsed from the filename — a suggestion for the reference-control panel. */
  identity: ControlIdentity;
  /** Index into the population palette, for consistent colouring across views. */
  colorIndex: number;
}

export interface SampleGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface LoadFailure {
  fileName: string;
  message: string;
  hint?: string;
}

export interface LoadProgress {
  active: boolean;
  done: number;
  total: number;
  current: string | null;
}

interface WorkspaceState {
  samples: Sample[];
  groups: SampleGroup[];
  selectedSampleId: string | null;
  /**
   * Additional samples selected alongside the primary one.
   *
   * Kept separate from `selectedSampleId` rather than replacing it, because
   * everything else in the app — the inspector, panels set to follow, the
   * spectral and compensation views — is single-sample and stays that way. This
   * exists so a batch of replicates can be dragged onto the worksheet in one
   * gesture; it is a selection for *acting on*, not for viewing. Always includes
   * the primary id.
   */
  multiSelection: string[];
  /**
   * Where a Shift-range measures from.
   *
   * Held explicitly rather than read off `selectedSampleId`, which is what it
   * used to be and is not the same thing. `toggleSampleInSelection` reassigns
   * the primary when the primary is the row being dropped — correct for the
   * inspector, which must never show a sample outside the selection, and wrong
   * for an anchor, which is a record of where the user last started a selection
   * and has no business moving because a different row was ticked off.
   *
   * Set by a plain click and by a Ctrl-click; deliberately **not** by a
   * Shift-click, so repeated Shift-clicks re-measure from the same origin and a
   * range can be grown and shrunk rather than ratcheting.
   */
  selectionAnchor: string | null;
  progress: LoadProgress;
  failures: LoadFailure[];

  importFiles(refs: FileRef[]): Promise<void>;
  removeSample(id: string): void;
  /**
   * Remove several samples at once — the selection, in one act.
   *
   * The list could always be emptied a row at a time or all at once, and picking
   * six of eight tubes out of a plate was six presses with the list re-numbering
   * itself under the pointer between them. This is the third thing the batch
   * rule already resolved for reordering, dragging and the context menu
   * (`actionableSampleIds`), so removal now answers it the same way.
   *
   * `removeSample` is this with one id. One implementation, because the two
   * differ only in how many rows go, and the selection repair afterwards — which
   * sample is primary, what is left of the multi-selection, whether the anchor a
   * range would measure from still exists — is exactly the part that is easy to
   * get subtly different in a second copy.
   */
  removeSamples(ids: readonly string[]): void;
  removeAll(): void;
  renameSample(id: string, name: string): void;
  selectSample(id: string | null): void;
  /** Ctrl/Cmd-click: add or drop one sample from the multi-selection. */
  toggleSampleInSelection(id: string): void;
  /** Shift-click: select everything from the anchor to `id` over the visible order. */
  extendSelectionTo(id: string, ordered: string[]): void;
  /**
   * Select `id` unless it is already in the selection — a press, not a click.
   *
   * What every file manager does on pointer-down: pressing a row outside the
   * selection makes it *the* selection before anything acts on it, and pressing
   * a row already inside one leaves the batch alone so the action applies to
   * all of it. Without this the row's own click handler is the only thing that
   * selects, and the hover controls sitting over the right of the row consume
   * the click before it gets there — so a press on the right third of a row
   * changed nothing at all, and the Shift-click after it measured from whatever
   * had been selected before.
   */
  pressSample(id: string): void;
  setAcquisitionOverride(id: string, type: AcquisitionType | null): void;
  /**
   * Move a sample to another position in the list.
   *
   * The list's order *is* the order — the index on each row, the order the
   * statistics table and the export walk samples in, and the order the workspace
   * saves — so there is no separate sort field to keep in step. `toIndex` is the
   * target's position in the current list; see `moveItem`.
   */
  moveSample(sampleId: string, toIndex: number): void;
  /** One position up (−1) or down (+1). The arrows on a row. */
  moveSampleBy(sampleId: string, delta: number): void;
  /**
   * Move several samples at once, as one block.
   *
   * The multi-selection could be *made* since 2026-08-03 and could be dragged
   * onto the worksheet, but every reorder took a single id — so a five-row
   * selection dragged within the list moved one row and left the other four
   * behind, which reads as multi-select not existing rather than as reordering
   * being incomplete. Both singular actions above are now these with one id,
   * so there is one set of semantics rather than two that drift.
   *
   * Non-contiguous selections gather; relative order is preserved. See
   * `core/reorder.ts`, where both are properties with tests.
   */
  moveSamples(sampleIds: readonly string[], toIndex: number): void;
  /** The whole selection one position up (−1) or down (+1). */
  moveSamplesBy(sampleIds: readonly string[], delta: number): void;
  moveSampleToGroup(sampleId: string, groupId: string): void;
  renameGroup(groupId: string, name: string): void;
  toggleGroupCollapsed(groupId: string): void;
  dismissFailures(): void;
}

/** Resolved acquisition type, honouring any manual override. */
export function acquisitionTypeOf(s: Sample): AcquisitionType {
  return s.acquisitionOverride ?? s.detection.type;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  samples: [],
  groups: [],
  selectedSampleId: null,
  multiSelection: [],
  selectionAnchor: null,
  progress: { active: false, done: 0, total: 0, current: null },
  failures: [],

  async importFiles(refs) {
    const fcs = refs.filter((r) => r.name.toLowerCase().endsWith('.fcs'));
    if (fcs.length === 0) return;

    set({ progress: { active: true, done: 0, total: fcs.length, current: null }, failures: [] });

    const loaded: Sample[] = [];
    const failures: LoadFailure[] = [];
    const existing = new Set(get().samples.map((s) => s.filePath ?? s.fileName));

    for (let i = 0; i < fcs.length; i++) {
      const ref = fcs[i]!;
      set((st) => ({ progress: { ...st.progress, done: i, current: ref.name } }));
      // Yield so the progress bar actually paints between files.
      await new Promise((r) => setTimeout(r, 0));

      if (existing.has(ref.path ?? ref.name)) continue;

      try {
        const parsed = parseFcs(await ref.read());
        loaded.push({
          id: ref.id,
          name: displayNameFromFile(ref.name),
          fileName: ref.name,
          filePath: ref.path,
          fileSize: ref.size,
          groupId: '',
          parsed,
          detection: detectAcquisitionType(parsed.metadata),
          acquisitionOverride: null,
          identity: parseControlIdentity(ref.name),
          colorIndex: 0,
        });
      } catch (e) {
        failures.push(
          e instanceof FcsParseError
            ? { fileName: ref.name, message: e.message, hint: e.hint }
            : {
                fileName: ref.name,
                message: e instanceof Error ? e.message : 'Unknown error while reading this file.',
                hint: 'This is unexpected — the file may be unreadable or the disk may have failed.',
              },
        );
      }
    }

    // A file's embedded `$SPILLOVER` is parsed and shown in the inspector, and
    // since 2026-08-27 the Compensation panel can read it — but **nothing is
    // applied on import**. A matrix is applied when somebody presses a button
    // in a panel and says which samples to apply it to, which is the same rule
    // an unmixing matrix follows and the reason an FCS file arriving in this
    // application still holds the numbers the instrument wrote.

    const all = [...get().samples, ...loaded];
    const { samples, groups } = regroup(all);

    const selectedSampleId = get().selectedSampleId ?? samples[0]?.id ?? null;
    set({
      samples,
      groups,
      failures,
      progress: { active: false, done: fcs.length, total: fcs.length, current: null },
      selectedSampleId,
      multiSelection: selectedSampleId ? [selectedSampleId] : [],
      selectionAnchor: selectedSampleId,
    });
  },

  removeSample(id) { get().removeSamples([id]); },

  removeSamples(ids) {
    const gone = new Set(ids);
    if (gone.size === 0) return;
    const remaining = get().samples.filter((s) => !gone.has(s.id));
    if (remaining.length === get().samples.length) return;
    const { samples, groups } = regroup(remaining);
    set((st) => ({
      samples,
      groups,
      /*
         The primary falls back to the top of what is left, and only when it was
         one of the ones removed. Asked of the set rather than of a single id, so
         removing five rows including the shown one lands on the first survivor
         instead of on a sample that is no longer in the list.
      */
      selectedSampleId: gone.has(st.selectedSampleId ?? '')
        ? (samples[0]?.id ?? null)
        : st.selectedSampleId,
      multiSelection: st.multiSelection.filter((x) => !gone.has(x)),
      // A range must never measure from a row that is no longer in the list.
      selectionAnchor: gone.has(st.selectionAnchor ?? '') ? null : st.selectionAnchor,
    }));
    // Removing rows one at a time is the same act as pressing *Remove all*, and
    // it has to end in the same place. Announcing on the transition to empty —
    // rather than in `removeAll` alone — is what makes "the workspace has no
    // samples" the condition, which is what it always was.
    if (samples.length === 0) notifyWorkspaceCleared();
  },

  removeAll() {
    markWorkspaceDirty();
    set({
      samples: [], groups: [], selectedSampleId: null, multiSelection: [],
      selectionAnchor: null, failures: [],
    });
    /*
       And the analysis with them (2026-08-11, Item 9).

       Announced rather than performed here: the worksheets, the gate hierarchy
       and the unmixing wizard each know what clearing them means, and this store
       has no business importing three others to say so. `restoreWorkspace` calls
       this on its way in and then writes the saved gates and layouts on top,
       which is why the order there is still correct.

       See `state/workspaceCleared.ts` for what this was fixing and why leaving
       the state in place was worse than it looked.
    */
    notifyWorkspaceCleared();
  },

  renameSample(id, name) {
    set((st) => ({
      samples: st.samples.map((s) => (s.id === id ? { ...s, name: name.trim() || s.name } : s)),
    }));
  },

  selectSample(id) {
    // A plain click collapses the multi-selection: anything else means a stale
    // batch from three clicks ago silently rides along on the next drag. It is
    // also where a Shift-range will measure from next.
    set({ selectedSampleId: id, multiSelection: id ? [id] : [], selectionAnchor: id });
  },

  toggleSampleInSelection(id) {
    set((st) => {
      const current = st.multiSelection.length > 0
        ? st.multiSelection
        : st.selectedSampleId ? [st.selectedSampleId] : [];
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      // Deselecting the primary hands that role to whatever is left, so the
      // inspector never ends up showing a sample no longer in the selection.
      const primary = next.includes(st.selectedSampleId ?? '') ? st.selectedSampleId : next[0] ?? null;
      // The row just touched becomes the anchor whether it was added or dropped,
      // which is what makes Ctrl-click-then-Shift-click select from *there*.
      return { multiSelection: next, selectedSampleId: primary, selectionAnchor: id };
    });
  },

  extendSelectionTo(id, ordered) {
    set((st) => {
      const to = ordered.indexOf(id);
      if (to < 0) return st;
      /*
         The anchor, then the primary, then nothing.

         `selectionAnchor` is the sample the last plain or Ctrl click landed on.
         `selectedSampleId` is the fallback for a workspace restored from a file
         and for the very first gesture after import, where a primary exists and
         an anchor may not; a filter that has hidden the anchor lands here too,
         and treating that as "no anchor" is right — the row it would measure
         from is not on screen.
      */
      const anchor = ordered.includes(st.selectionAnchor ?? '')
        ? st.selectionAnchor!
        : st.selectedSampleId ?? '';
      const from = ordered.indexOf(anchor);
      // Nothing to extend from — the same as a plain click, and it sets the
      // anchor so the *next* Shift-click has one.
      if (from < 0) return { multiSelection: [id], selectedSampleId: id, selectionAnchor: id };
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      /*
         The anchor stays both primary and anchor. Extending a selection should
         not move the inspector off the sample you started from, and it must not
         move the origin either: Shift-clicking row 9 and then row 5 selects 1–5,
         where re-anchoring on each Shift-click would select 5–9 and make a range
         impossible to shrink.
      */
      return {
        multiSelection: ordered.slice(lo, hi + 1),
        selectedSampleId: anchor,
        selectionAnchor: anchor,
      };
    });
  },

  pressSample(id) {
    set((st) => {
      const inSelection = st.multiSelection.includes(id);
      if (inSelection) return {};
      return { selectedSampleId: id, multiSelection: [id], selectionAnchor: id };
    });
  },

  setAcquisitionOverride(id, type) {
    set((st) => ({
      samples: st.samples.map((s) => (s.id === id ? { ...s, acquisitionOverride: type } : s)),
    }));
  },

  moveSample(sampleId, toIndex) {
    get().moveSamples([sampleId], toIndex);
  },

  moveSampleBy(sampleId, delta) {
    get().moveSamplesBy([sampleId], delta);
  },

  moveSamples(sampleIds, toIndex) {
    set((st) => {
      const from = indicesOf(st.samples, sampleIds);
      if (from.length === 0) return {};
      // Back through `regroup` so the palette indices follow the new order —
      // `colorIndex` is `i % 12`, so a sample that moves takes the colour of the
      // slot it moved into rather than carrying its old one up the list.
      return regroup(moveBlock(st.samples, from, toIndex));
    });
  },

  moveSamplesBy(sampleIds, delta) {
    set((st) => {
      const from = indicesOf(st.samples, sampleIds);
      if (from.length === 0) return {};
      return regroup(moveBlockBy(st.samples, from, delta));
    });
  },

  moveSampleToGroup(sampleId, groupId) {
    set((st) => regroup(st.samples.map((s) => (s.id === sampleId ? { ...s, groupId } : s))));
  },

  renameGroup(groupId, name) {
    set((st) => ({
      groups: st.groups.map((g) => (g.id === groupId ? { ...g, name: name.trim() || g.name } : g)),
    }));
  },

  toggleGroupCollapsed(groupId) {
    set((st) => ({
      groups: st.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)),
    }));
  },

  dismissFailures() {
    set({ failures: [] });
  },
}));

/**
 * Refresh palette indices, and rebuild the group list from what is assigned.
 *
 * **Nothing is inferred here any more** (2026-08-03). This used to run
 * `suggestGroups` over the display names and cluster them, which merged
 * `…-Probe-Control` and `…-Probe-TreatmentA` into one comparison category of n=2 on
 * the strength of a shared prefix — collapsing precisely the difference the two
 * files were loaded to show. A filename is a filename; it is not a statement
 * about which samples are replicates of each other, and the app has no way to
 * tell the two apart.
 *
 * So a sample belongs to a group only when somebody put it in one
 * (`moveSampleToGroup`), and `groups` is the set of assignments that exist. A
 * sample with no group is its own category in the comparison chart, which is the
 * honest default: it makes the chart show what was loaded rather than what the
 * names looked like.
 */
function regroup(samples: Sample[]): { samples: Sample[]; groups: SampleGroup[] } {
  /*
     Every change to the sample list is a change to the workspace.

     Marked here rather than at each of the six call sites, because every one of
     them goes through this function — import, removal, rename, reorder,
     regroup — and a seventh that forgot would be a silent hole in the
     unsaved-changes prompt. The undo stack does not cover any of this (a
     snapshot cannot put a removed sample's event data back), so `record()` never
     fires for it and `dirtyStore` would otherwise never hear about it.

     `restoreWorkspace` clears the flag again after it finishes, which is what
     stops *loading* a workspace from immediately reporting it as modified.
  */
  markWorkspaceDirty();
  if (samples.length === 0) return { samples: [], groups: [] };

  const next = samples.map((s, i) => ({ ...s, colorIndex: i % 12 }));

  // In first-assigned order, so the chart's categories follow the order the user
  // built them rather than an alphabetical one they did not choose.
  const groups: SampleGroup[] = [];
  for (const s of next) {
    if (!s.groupId) continue;
    if (groups.some((g) => g.id === s.groupId)) continue;
    groups.push({ id: s.groupId, name: groupNameOf(s.groupId), collapsed: false });
  }

  return { samples: next, groups };
}

/** `manual:treated` → `treated`. A group id carries its own name; there is nothing else to look it up in. */
function groupNameOf(groupId: string): string {
  return groupId.startsWith('manual:') ? groupId.slice('manual:'.length) : groupId;
}

/** The id a named group is stored under. Empty name means no group at all. */
export function groupIdFor(name: string): string {
  const clean = name.trim();
  return clean ? `manual:${clean}` : '';
}

/* -------------------------------------------------------------------------
   Derived selectors
   ------------------------------------------------------------------------- */

export function selectedSample(state: WorkspaceState): Sample | null {
  return state.samples.find((s) => s.id === state.selectedSampleId) ?? null;
}

/**
 * Sample ids a batch action should apply to, in sidebar order.
 *
 * Falls back to the primary selection, so "act on the selection" needs no
 * special case for the ordinary one-sample situation. Ordered by `samples`
 * rather than by click order, so dragging three replicates out lays them into
 * the grid in the order they appear in the list.
 */
export function actionableSampleIds(state: WorkspaceState, include?: string): string[] {
  const set = new Set(state.multiSelection.length > 0
    ? state.multiSelection
    : state.selectedSampleId ? [state.selectedSampleId] : []);
  // Dragging or right-clicking a row outside the selection acts on that row —
  // matching how every file manager behaves.
  if (include && !set.has(include)) return [include];
  return state.samples.filter((s) => set.has(s.id)).map((s) => s.id);
}

export function totalEvents(samples: Sample[]): number {
  return samples.reduce((a, s) => a + s.parsed.metadata.eventCount, 0);
}

/** Where these ids sit in the list, ignoring any that are not in it. */
function indicesOf(samples: readonly Sample[], ids: readonly string[]): number[] {
  const wanted = new Set(ids);
  const out: number[] = [];
  samples.forEach((s, i) => { if (wanted.has(s.id)) out.push(i); });
  return out;
}

/**
 * Whether the batch a row belongs to can move that way — what the arrows disable on.
 *
 * Asked of the whole batch rather than of the row, and that distinction is the
 * bug it replaces: `isLast` was the row's own `index === samples.length - 1`, so
 * with the bottom three rows selected the middle one's Down arrow stayed enabled
 * and pressing it moved a block that had nowhere to go. The batch is whatever
 * `actionableSampleIds` says it is, so a row outside the selection still answers
 * for itself.
 */
export function canMoveSamples(state: WorkspaceState, rowId: string, delta: number): boolean {
  const ids = actionableSampleIds(state, rowId);
  return canMoveBlock(state.samples.length, indicesOf(state.samples, ids), delta);
}
