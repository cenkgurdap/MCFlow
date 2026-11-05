import { create } from 'zustand';
import { createTransform, defaultTransformKind, transformColumn, type TransformKind, type TransformSpec } from '@/core/transform';
import { autoSpec } from '@/core/transform';
import { evaluateGates, cloneStrategy, wouldCycle, type EvaluatedTree, type GateContext } from '@/core/gating/tree';
// Aliased because the store exposes an action of the same name over the same
// rule; this is the pure one, which takes a list and returns a list.
import { pruneReferenceGates as pruneGateList, withoutGates } from '@/core/gating/referenceGates';
import { nameCollision } from '@/core/gating/suggestName';
import { ROOT_ID, type Gate, type GateKind } from '@/core/gating/types';
import type { ParsedFcs } from '@/core/fcs/types';
import { axisMinFor, parameterKey, parametersFor, sampleColumn, useDerived } from './derivedStore';
import { record } from './historyBus';
import { onWorkspaceCleared } from './workspaceCleared';
import { onParameterShift, shiftIndex } from './parameterShift';

export type DrawTool = 'none' | 'rectangle' | 'polygon' | 'ellipse' | 'quadrant' | 'range';

/** How a parameter is being displayed, so gates evaluate in the space they were drawn in. */
export interface AxisSpec {
  parameterIndex: number;
  kind: TransformKind;
  spec: TransformSpec;
}

/* ==========================================================================
   Where a sample's gates come from.

   Gating used to be strictly per-sample: `bySample[sampleId]`, one hierarchy
   each, and `copyStrategy` to replicate one onto the others. That is the wrong
   default. A panel of samples is nearly always the *same* experiment measured
   several times, and the gating strategy is a property of the experiment, not of
   any one file — so drawing a lymphocyte gate on replicate 1 and then finding
   replicate 2 ungated is a chore with no analytical content, repeated once per
   sample, every session.

   So the hierarchy is **shared by default**. `shared` is the workspace's gating
   strategy; every loaded sample uses it, including samples imported after the
   gates were drawn. Membership is still evaluated per sample against that
   sample's own event data — sharing the *definition* is not sharing the result.

   `divergent` is the escape hatch, and it is deliberately explicit: a sample in
   it has been forked and no longer tracks the shared strategy. That is what the
   old per-sample model was good for — one control that genuinely needs a
   different gate — and it is still reachable, now as a decision rather than as
   the thing that happens by default.
   ========================================================================== */

interface GateState extends GateSource {
  /** The gating strategy every linked sample uses. */
  shared: Gate[];
  /** Samples explicitly forked off the shared strategy, by sample id. */
  divergent: Record<string, Gate[]>;
  /** Per-sample boundaries for gates marked `linked: false`. See `resolveGates`. */
  overrides: GateOverrides;
  selectedGateId: string | null;
  /**
   * Every selected gate, primary included.
   *
   * The sample browser's shape (`workspaceStore`), for the same reason and with
   * the same division of labour: `selectedGateId` is the **primary** — what the
   * plot marks, what a rename or a scoped plot is about, what every reader that
   * predates multi-select already asks for — and this is the set an action
   * applies to. Empty exactly when `selectedGateId` is null, and it always
   * contains the primary otherwise, so no reader has to check both.
   */
  selectedGateIds: string[];
  /**
   * Where a Shift-range measures from.
   *
   * Held apart from the primary, which is what `workspaceStore` learned the
   * hard way: a toggle may reassign the primary, and an anchor is a record of
   * where the user last *started* a selection. Set by a plain click and by a
   * Ctrl-click, deliberately **not** by a Shift-click, so repeated Shift-clicks
   * re-measure from one origin and a range can be grown and shrunk rather than
   * ratcheting outwards.
   */
  gateSelectionAnchor: string | null;
  tool: DrawTool;
  /** Vertices placed so far while drawing a polygon. */
  pendingPolygon: { x: number; y: number }[] | null;
  /**
   * Gates created by the most recent draw, so the tree can flash them.
   *
   * A gate finalises with a click on the plot, several hundred pixels from the
   * tree it appears in; without a confirmation there the user cannot tell a
   * successful draw from a click that did nothing. A list rather than one id
   * because a quadrant creates four populations in one gesture and flashing
   * only the last of them would read as three that failed.
   */
  lastAddedIds: string[];
  /** When that draw happened, used to group a quadrant's four adds. */
  lastAddedAt: number;

  gatesFor(sampleId: string): Gate[];
  /** True when this sample has been forked off the shared strategy. */
  isDivergent(sampleId: string): boolean;
  /**
   * Let one gate's boundary differ per sample, or put it back.
   *
   * Relinking discards every per-sample boundary that gate had, which is the
   * same trade `relinkSample` makes at the hierarchy level: keeping them would
   * leave state nothing can reach and nothing can show.
   */
  setGateLinked(sampleId: string, gateId: string, linked: boolean): void;
  /**
   * Drop **one** sample's own boundary, keeping every other sample's.
   *
   * `setGateLinked(id, true)` is the all-or-nothing form: it re-links the gate
   * and discards every per-sample boundary at once, which is right for "put this
   * gate back to one shape everywhere" and wrong for "this one control did not
   * need its own after all" (2026-08-06). The unmixing workflow needs the second
   * — eight controls sharing a general gate while the ninth has its own is the
   * ordinary case, and undoing the ninth must not disturb the eight.
   *
   * Re-links the gate when the last override goes, so a gate marked as varying
   * per sample is always a gate that actually does.
   */
  clearGateOverride(sampleId: string, gateId: string): void;
  /**
   * Set this gate's outline and label colour, or `null` for the theme default.
   *
   * A property of the gate rather than of a sample's copy of it, so a
   * deliberately-recoloured gate looks the same on every sample — which is the
   * point of colouring it.
   */
  setGateColor(sampleId: string, gateId: string, color: string | null): void;
  addGate(sampleId: string, gate: Gate): void;
  updateGate(sampleId: string, gateId: string, patch: Partial<Gate>): void;
  removeGate(sampleId: string, gateId: string): void;
  /**
   * Rename a population. **False when the name is already taken on this sample**
   * and nothing is written — see the implementation for why a rename refuses
   * where the naming prompt offers to replace.
   */
  renameGate(sampleId: string, gateId: string, name: string): boolean;
  /**
   * Redefine an existing population with a freshly drawn shape.
   *
   * The gesture behind it (2026-08-12, Item 9): draw the gate you actually
   * wanted, then pick the population it should *be* from the naming prompt's
   * list. What that used to take was deleting the old gate — losing its
   * children with it — drawing the new one, and renaming it.
   *
   * **The identity is the old gate's and the shape is the new one's.** `id`,
   * `parentId` and `colorIndex` are kept, so every child stays parented, every
   * panel scoped to this population keeps pointing at it, the label offsets
   * keyed by gate id survive, and the population's colour does not change
   * underneath the tree. Everything that describes the *boundary* — the kind,
   * the axes, the geometry, the transform specs — comes from the new gate,
   * which is what makes this a redefinition rather than a rename.
   */
  replaceGate(sampleId: string, gateId: string, shape: Gate, name?: string): void;
  reparentGate(sampleId: string, gateId: string, newParentId: string | null): void;
  /**
   * Drop every gate the unmixing wizard created that is not in `keep`.
   *
   * The wizard's own reconciliation, called once at the end of a build — see
   * `pruneReferenceGates` for the rule and the bug. It lives here rather than in
   * `spectralStore` because the gates it removes can be in three places at once:
   * the shared strategy, any forked sample's copy of it, and the per-gate
   * overrides. One write covers all three, which is also what makes the whole
   * reconciliation a single undo step rather than one per stale gate.
   *
   * Returns how many went, so the caller can tell "nothing to do" — the ordinary
   * case — from a real cleanup without diffing the store.
   */
  pruneReferenceGates(keep: ReadonlySet<string>): number;
  /**
   * Remove a named set of gates, wherever they are, in one write.
   *
   * The counterpart of `pruneReferenceGates` for a caller that knows the ids
   * rather than a marker, and it exists for the same three reasons: a gate can
   * be in the shared strategy, in any forked sample's copy of it, and in the
   * per-gate overrides; one write covers all three; and the whole removal is a
   * single undo step rather than one per gate.
   *
   * **Not a loop over `removeGate`.** That takes one sample id, so it writes
   * either the shared strategy or *that* sample's fork depending on which the
   * sample has — reaching every copy would mean a call per sample and a
   * different one per gate. It also resolves each removal on its own, and a
   * population gate under *Cells* when both are going has to lift to the root
   * rather than to *Cells*: the survivors are re-parented against the whole set
   * at once, which is what `withoutGates` does.
   *
   * Returns how many went, so a caller can tell "nothing to do" from a real
   * removal without diffing the store.
   */
  removeGates(ids: ReadonlySet<string>): number;
  /**
   * Select one gate and only that one — a plain click, and every programmatic
   * selection in the application.
   *
   * Collapses the set to it and moves the anchor to it, which is what lets every
   * caller written before multi-select existed stay correct without an edit.
   */
  selectGate(id: string | null): void;
  /** Ctrl/Cmd-click: add or drop one gate from the selection. */
  toggleGateInSelection(id: string): void;
  /** Shift-click: select everything from the anchor to `id` over the order shown. */
  extendGateSelectionTo(id: string, ordered: string[]): void;
  setTool(t: DrawTool): void;
  setPendingPolygon(v: { x: number; y: number }[] | null): void;
  /**
   * Give this sample its own hierarchy, forked from what it shows now.
   * Ids are regenerated, so the fork and the shared strategy are independent.
   */
  unlinkSample(sampleId: string): void;
  /** Put a forked sample back on the shared strategy, discarding its fork. */
  relinkSample(sampleId: string): void;
  /** Promote one sample's hierarchy to the shared one and drop every fork. */
  applyToAllSamples(sampleId: string): void;
  /**
   * Copy one sample's whole strategy onto others as forks.
   *
   * Kept for the deliberate case — "make these three match that one, and leave
   * the rest alone". It is no longer needed to get gates onto a new sample; that
   * is what the shared strategy does on its own.
   */
  copyStrategy(fromSampleId: string, toSampleIds: string[]): void;
  clearGates(sampleId: string): void;
  /**
   * Drop the whole hierarchy — shared, every fork, every per-gate override.
   *
   * Called when the last sample is removed. A gate is a definition rather than a
   * selection, so it survives the data it was drawn against and produces
   * populations from the next file set without complaining; see
   * `state/workspaceCleared.ts` for why that is the bug rather than a feature.
   */
  resetGating(): void;
}

/** Subscribe to whatever decides one sample's gates. Stable reference. */
export function gatesOfSample(sampleId: string | null | undefined) {
  return (s: GateSource): Gate[] =>
    (sampleId ? resolveGates(s.shared, s.divergent, s.overrides, sampleId) : s.shared);
}

/** The three pieces of state a sample's gate list is resolved from. */
export interface GateSource {
  shared: Gate[];
  divergent: Record<string, Gate[]>;
  overrides: GateOverrides;
}

/**
 * Per-sample boundaries for individually unlinked gates.
 *
 * `gateId → sampleId → the whole gate as it stands on that sample`. The whole
 * gate rather than a geometry patch, because "which fields are geometry"
 * differs per kind — a rectangle has four, a polygon has a vertex list, an
 * ellipse has five — and a resolution step that had to know would be a fifth
 * place that breaks when a sixth kind arrives. What is *taken* from the override
 * is stated once, in `resolveGates`.
 */
export type GateOverrides = Record<string, Record<string, Gate>>;

/**
 * One sample's gate list, for a caller that already holds the state.
 *
 * Views that iterate over every sample — statistics, export — subscribe once and
 * call this per sample, rather than subscribing per sample or rebuilding a map
 * on every render.
 *
 * Two mechanisms compose here and they are not the same thing:
 *
 *   - **`divergent`** forks a sample's *whole hierarchy*. That sample stops
 *     tracking the shared strategy entirely — different gates, different ids,
 *     possibly a different shape of tree.
 *   - **`overrides`** moves *one gate's boundary* on one sample, for a gate
 *     explicitly marked `linked: false`. Everything else about that gate — its
 *     name, its parent, its colour — still comes from the one hierarchy, so the
 *     population path is unchanged and the export and the statistics table still
 *     match it up across samples.
 *
 * The override wins where it applies, which is the point; a gate that is linked,
 * or has no entry for this sample, comes through untouched.
 */
export function resolveGates(
  shared: Gate[],
  divergent: Record<string, Gate[]>,
  overrides: GateOverrides,
  sampleId: string,
): Gate[] {
  const base = ownedBy(divergent[sampleId] ?? shared, sampleId);
  // The common case: nothing is unlinked, so the shared list is returned by
  // identity and every memo downstream of it stays valid.
  if (!base.some((g) => g.linked === false)) return base;

  /*
     Memoised on the *identity* of its three inputs, and that is not a
     micro-optimisation — it is what makes the function safe to call from a
     Zustand selector.

     `useGates(gatesOfSample(id))` compares what the selector returns by
     reference to decide whether to re-render. A function that builds a fresh
     array every call therefore reports a change on every render, which is a
     render loop: React error #185, immediately, the moment any gate was
     unlinked. Every input here is immutable and replaced wholesale on change, so
     caching on identity is exactly correct and the invalidation is free.

     The alternative — memoising at each call site — was rejected for the reason
     this project keeps recording: it would be right in the four places that
     remembered and silently wrong in the fifth.
  */
  let byOverrides = resolveCache.get(base);
  if (!byOverrides) { byOverrides = new WeakMap(); resolveCache.set(base, byOverrides); }
  let bySample = byOverrides.get(overrides);
  if (!bySample) { bySample = new Map(); byOverrides.set(overrides, bySample); }
  const hit = bySample.get(sampleId);
  if (hit) return hit;

  const out = base.map((g) => {
    if (g.linked === false) {
      const own = overrides[g.id]?.[sampleId];
      // Identity, parentage and colour stay with the one hierarchy; only the
      // shape comes from the override. Spreading the override *under* those
      // fields is what states that, in one place.
      if (own) {
        return {
          ...own,
          id: g.id, name: g.name, parentId: g.parentId,
          colorIndex: g.colorIndex, linked: false, kind: g.kind,
        } as Gate;
      }
    }
    return g;
  });
  bySample.set(sampleId, out);
  return out;
}

const resolveCache = new WeakMap<Gate[], WeakMap<GateOverrides, Map<string, Gate[]>>>();

/**
 * Drop the gates that belong to some *other* sample.
 *
 * `ownerSampleId` is absent on every gate anyone draws, so the overwhelmingly
 * common case is the first line: nothing is owned, and the list comes back by
 * identity with no allocation and no behaviour change. See `GateBase` for what
 * the field is for and which bug it fixes.
 *
 * Memoised on the identity of the source array, for the same reason
 * `resolveGates` is: this runs inside a Zustand selector, and a selector that
 * builds a fresh array every call reports a change on every render — React error
 * #185, immediately. Every input is immutable and replaced wholesale on change,
 * so caching on identity is exact.
 */
function ownedBy(gates: Gate[], sampleId: string): Gate[] {
  if (!gates.some((g) => g.ownerSampleId !== undefined)) return gates;
  let per = ownerCache.get(gates);
  if (!per) { per = new Map(); ownerCache.set(gates, per); }
  const hit = per.get(sampleId);
  if (hit) return hit;
  const out = gates.filter((g) => g.ownerSampleId === undefined || g.ownerSampleId === sampleId);
  per.set(sampleId, out);
  return out;
}

const ownerCache = new WeakMap<Gate[], Map<string, Gate[]>>();

/** The three selection fields, which are only ever written together. */
type GateSelection = Pick<GateState, 'selectedGateId' | 'selectedGateIds' | 'gateSelectionAnchor'>;

/** Nothing selected. */
const NO_SELECTION: GateSelection = { selectedGateId: null, selectedGateIds: [], gateSelectionAnchor: null };

/** Exactly one gate selected — a plain click, and every programmatic selection. */
const onlyGate = (id: string): GateSelection => ({
  selectedGateId: id, selectedGateIds: [id], gateSelectionAnchor: id,
});

/**
 * The selection with everything the predicate rejects dropped.
 *
 * One rule for every path that can destroy a gate — `removeGate`, `removeGates`
 * and `pruneReferenceGates` — because a gate that no longer exists must not stay
 * selected: Escape and the delete key both act on the selection, and the tree
 * would show nothing highlighted. The primary falls back to whatever survives
 * rather than to null, so removing one of three leaves two selected and one of
 * them primary.
 */
function selectionKeeping(s: GateSelection, keep: (id: string) => boolean): GateSelection {
  const ids = s.selectedGateIds.filter(keep);
  return {
    selectedGateIds: ids,
    selectedGateId: s.selectedGateId && keep(s.selectedGateId)
      ? s.selectedGateId
      : ids[ids.length - 1] ?? null,
    gateSelectionAnchor: s.gateSelectionAnchor && keep(s.gateSelectionAnchor)
      ? s.gateSelectionAnchor
      : null,
  };
}

let gateSeq = 0;
export function nextGateId(): string {
  return `g${Date.now().toString(36)}${(gateSeq++).toString(36)}`;
}

/** Bumped when a new drawing gesture starts; see `addGate`. */
let addGesture = 0;

/** Default name for a newly drawn gate of each kind. */
export function defaultGateName(kind: GateKind, existing: Gate[]): string {
  const stem = kind === 'quadrant' ? 'Q' : kind.charAt(0).toUpperCase() + kind.slice(1);
  let n = 1;
  while (existing.some((g) => g.name === `${stem} ${n}`)) n++;
  return `${stem} ${n}`;
}

export const useGates = create<GateState>((set, get) => {
  /**
   * Write a sample's gate list back to wherever it came from.
   *
   * The single place the shared/divergent split is resolved for a *write*. Every
   * mutation goes through it, so "am I editing the shared strategy or this
   * sample's fork?" is answered once rather than at each of five actions — and a
   * sixth cannot get it wrong by omission.
   */
  const writeFor = (sampleId: string, next: (gates: Gate[]) => Gate[]) =>
    set((s) => {
      const fork = s.divergent[sampleId];
      return fork
        ? { divergent: { ...s.divergent, [sampleId]: next(fork) } }
        : { shared: next(s.shared) };
    });

  return {
    shared: [],
    divergent: {},
    overrides: {},
    ...NO_SELECTION,
    tool: 'none',
    pendingPolygon: null,
    lastAddedIds: [],
    lastAddedAt: 0,

    gatesFor(sampleId) {
      const s = get();
      return resolveGates(s.shared, s.divergent, s.overrides, sampleId);
    },

    isDivergent(sampleId) {
      return sampleId in get().divergent;
    },

    setGateColor(sampleId, gateId, color) {
      record('Change gate colour', `gate-color:${gateId}`);
      writeFor(sampleId, (gates) => gates.map((g) => {
        if (g.id !== gateId) return g;
        // `undefined` rather than `null`, so "no colour" is the field being
        // absent — which is what `gateInk` and every serialisation already treat
        // as "use the theme's".
        const next = { ...g } as Gate;
        if (color) next.color = color;
        else delete next.color;
        return next;
      }));
    },

    setGateLinked(sampleId, gateId, linked) {
      record(linked ? 'Link gate across samples' : 'Unlink gate');
      // The flag lives on the one hierarchy, not on a sample's copy — it is a
      // statement about how the gate behaves everywhere.
      writeFor(sampleId, (gates) =>
        gates.map((g) => (g.id === gateId ? ({ ...g, linked } as Gate) : g)));
      if (linked) {
        set((s) => {
          if (!s.overrides[gateId]) return {};
          const next = { ...s.overrides };
          delete next[gateId];
          return { overrides: next };
        });
      }
    },

    clearGateOverride(sampleId, gateId) {
      const own = get().overrides[gateId];
      if (!own?.[sampleId]) return;
      record('Share gate again');

      const rest = { ...own };
      delete rest[sampleId];

      set((s) => {
        const next = { ...s.overrides };
        if (Object.keys(rest).length === 0) delete next[gateId];
        else next[gateId] = rest;
        return { overrides: next };
      });

      // Nothing varies any more, so the flag should stop saying it does — a gate
      // left `linked: false` with no overrides resolves identically but reports
      // itself as per-sample in the tree and in every badge that reads it.
      if (Object.keys(rest).length === 0) {
        writeFor(sampleId, (gates) =>
          gates.map((g) => (g.id === gateId ? ({ ...g, linked: true } as Gate) : g)));
      }
    },

    addGate(sampleId, gate) {
      // A quadrant is one gesture that calls this four times, so all four share a
      // gesture token and fold into a single undo step; a gate drawn deliberately
      // later gets a new token and its own step. The 250 ms window is the same one
      // the tree already uses to decide which gates flash together.
      if (Date.now() - get().lastAddedAt >= 250) addGesture++;
      record('Add gate', `gate-add:${addGesture}`);
      writeFor(sampleId, (gates) => [...gates, gate]);
      set((s) => {
        const now = Date.now();
        // Adds within a few frames of each other are one gesture — a quadrant
        // calls this four times in a row and all four should flash together.
        const sameGesture = now - s.lastAddedAt < 250;
        return {
          ...onlyGate(gate.id),
          tool: 'none',
          pendingPolygon: null,
          lastAddedIds: sameGesture ? [...s.lastAddedIds, gate.id] : [gate.id],
          lastAddedAt: now,
        };
      });
    },

    updateGate(sampleId, gateId, patch) {
      // Keyed by gate, so dragging one shape across the plot is a single undo step
      // however many pointer moves it took, while dragging a second gate
      // afterwards is a step of its own.
      record('Edit gate', `gate-edit:${gateId}`);

      /*
         An unlinked gate's boundary belongs to the sample it was adjusted on.

         This is the write half of Item 5 and the reason the read half can stay
         simple: the shared hierarchy never learns about the move, so every other
         sample keeps the boundary it had, and `resolveGates` hands each sample
         its own. The override is seeded from the gate *as this sample currently
         sees it* — which is the shared shape the first time, so the first nudge
         moves from where the shape was rather than from wherever the shared one
         happens to be.
      */
      const current = get().gatesFor(sampleId).find((g) => g.id === gateId);
      if (current && current.linked === false) {
        set((s) => ({
          overrides: {
            ...s.overrides,
            [gateId]: { ...s.overrides[gateId], [sampleId]: { ...current, ...patch } as Gate },
          },
        }));
        return;
      }

      writeFor(sampleId, (gates) =>
        gates.map((g) => (g.id === gateId ? ({ ...g, ...patch } as Gate) : g)));
    },

    removeGate(sampleId, gateId) {
      record('Delete gate');
      // Its per-sample boundaries go with it, or they would sit in `overrides`
      // keyed to a gate that no longer exists and be silently adopted by the
      // next gate to be issued the same id.
      set((s) => {
        if (!s.overrides[gateId]) return {};
        const next = { ...s.overrides };
        delete next[gateId];
        return { overrides: next };
      });
      writeFor(sampleId, (gates) => {
        // Removing a parent re-parents its children upward rather than deleting
        // them — losing a whole subtree to one misclick is not recoverable.
        const removed = gates.find((g) => g.id === gateId);
        return gates
          .filter((g) => g.id !== gateId)
          .map((g) => (g.parentId === gateId ? { ...g, parentId: removed?.parentId ?? null } : g));
      });
      set((s) => selectionKeeping(s, (id) => id !== gateId));
    },

    /*
       Name and parentage are hierarchy-level and go straight to `writeFor`.

       They used to delegate to `updateGate`, which was harmless until an
       unlinked gate existed: `updateGate` now routes a write to *this sample's*
       boundary, so a rename would have landed in the override and every other
       sample would have kept the old name. A population's name and its place in
       the tree are one thing across the workspace — that is precisely what makes
       a population *path* comparable between samples, which the export and the
       statistics table are both keyed by. Only the boundary is per sample.
    */
    renameGate(sampleId, gateId, name) {
      /*
         A name already in use is refused, and the refusal is here rather than
         in the tree row.

         The naming prompt has asked about a collision since 2026-08-12, because
         two populations under one name give the export's path column, the
         compare chart's picker and the statistics table's grouping two answers
         each. A rename reached the store directly and never asked, so the same
         workspace could be talked out of the rule by using the other affordance
         — double-click a row, type the name of the population next to it, and
         there were two. The check belongs where every caller passes: the tree's
         inline editor, the context menu's *Rename* and anything added later.

         Refused rather than offered as a replacement, which is what the prompt
         does. There the two gates are *a shape being drawn* and *a population
         that exists*, and taking the second one over is a real intent. Here they
         are two populations that both already hold events, both have children
         and both are counted — and there is no merge that is not somebody
         losing an analysis they cannot see from a text field in the sidebar.
      */
      const clean = name.trim() || 'Unnamed';
      if (nameCollision(get().gatesFor(sampleId), clean, gateId)) return false;

      record('Rename gate');
      // One write, one source of truth. Every view that shows a population name —
      // the tree, the plot breadcrumb, the statistics table, the population
      // selector, the exporter's path column — reads it off this same `Gate`, so
      // there is nothing else to keep in step.
      writeFor(sampleId, (gates) =>
        gates.map((g) => (g.id === gateId ? ({ ...g, name: clean } as Gate) : g)));
      return true;
    },

    replaceGate(sampleId, gateId, shape, name) {
      record('Replace gate');
      /*
         Any per-sample boundary for this gate goes, and it has to.

         `overrides` holds *whole gates* keyed by id — one sample's own version
         of this boundary, set by unlinking it. Those were drawn against the
         shape being replaced; leaving them would mean the samples that had
         been unlinked kept the old population under the new name while
         everything else moved, which is one population reporting two things.
         Unlinking again is how somebody re-states the exception.
      */
      set((s) => {
        if (!s.overrides[gateId]) return {};
        const next = { ...s.overrides };
        delete next[gateId];
        return { overrides: next };
      });
      writeFor(sampleId, (gates) => gates.map((g) => {
        if (g.id !== gateId) return g;
        // Spread the new shape *under* the kept identity, so no leftover field
        // of the old kind survives — a rectangle replaced by a range must not
        // keep `yMin`, which would make it two shapes at once to anything
        // reading structurally.
        const { id: _id, parentId: _parentId, colorIndex: _colorIndex, name: _name, ...geometry } = shape;
        return {
          ...geometry,
          id: g.id,
          parentId: g.parentId,
          colorIndex: g.colorIndex,
          name: (name ?? g.name).trim() || g.name,
          ...(g.ownerSampleId !== undefined ? { ownerSampleId: g.ownerSampleId } : {}),
        } as Gate;
      }));
      set(onlyGate(gateId));
    },

    reparentGate(sampleId, gateId, newParentId) {
      const gates = get().gatesFor(sampleId);
      if (wouldCycle(gates, gateId, newParentId)) return;
      record('Move gate');
      const parentId = newParentId === ROOT_ID ? null : newParentId;
      writeFor(sampleId, (gates2) =>
        gates2.map((g) => (g.id === gateId ? ({ ...g, parentId } as Gate) : g)));
    },

    pruneReferenceGates(keep) {
      const s = get();
      const shared = pruneGateList(s.shared, keep);
      /*
         Every fork as well, and the ids in one are its own.

         `divergent` is only ever written by `unlinkSample`, `copyStrategy` and
         `applyToAllSamples`, and all three go through `cloneStrategy`, which
         regenerates every id — so a forked sample's copy of a wizard gate is
         **not** in `keep` and goes. That is the right answer rather than a
         casualty: the wizard's assignments name the shared ids, so a control
         whose whole hierarchy has been forked is one the wizard can no longer
         find a gate for at all, and leaving the clone would leave a bracket on
         screen that nothing in the setup points at. `ensureGated` seeds it a
         real one on the next move of the walk. Children lift either way, so
         nothing the operator drew under it is lost.

         Seeding into a fork is also why this cannot be narrowed to `shared`:
         `addGate` writes through `writeFor`, so a forked control's duplicates
         accumulate in its fork and nowhere else.
      */
      const divergent: Record<string, Gate[]> = {};
      for (const [id, fork] of Object.entries(s.divergent)) divergent[id] = pruneGateList(fork, keep);

      /*
         What actually went, by difference rather than by predicate.

         Asked this way rather than as "which gates did the predicate name", so
         the answer is about the state and not about the rule: the early return
         below is then exactly "nothing was removed", and the override cleanup
         reaches the gates this call removed and no others. Filtering `overrides`
         against what is merely *alive* would also sweep up an entry left behind
         by some other path — plausibly right, and not this action's business,
         and it would put a write and an undo step on a build that changed
         nothing.
      */
      const alive = new Set(shared.map((g) => g.id));
      for (const fork of Object.values(divergent)) for (const g of fork) alive.add(g.id);
      const removed = new Set<string>();
      for (const g of s.shared) if (!alive.has(g.id)) removed.add(g.id);
      for (const fork of Object.values(s.divergent)) {
        for (const g of fork) if (!alive.has(g.id)) removed.add(g.id);
      }
      if (removed.size === 0) return 0;

      record('Remove unused reference gates');

      const overrides = { ...s.overrides };
      // Or they would sit keyed to a gate that no longer exists and be silently
      // adopted by the next gate issued the same id — the same reason
      // `removeGate` clears them.
      for (const id of removed) delete overrides[id];

      set({
        shared,
        divergent,
        overrides,
        // A removed gate must not stay selected: Escape and the delete key both
        // act on `selectedGateId`, and the tree would show nothing highlighted.
        ...selectionKeeping(s, (id) => alive.has(id)),
      });
      return removed.size;
    },

    removeGates(ids) {
      if (ids.size === 0) return 0;
      const s = get();

      // Identity back when nothing here matches, so the early return below is
      // exactly "this workspace held none of them".
      const shared = withoutGates(s.shared, ids);
      const divergent: Record<string, Gate[]> = {};
      let forkChanged = false;
      for (const [id, fork] of Object.entries(s.divergent)) {
        divergent[id] = withoutGates(fork, ids);
        if (divergent[id] !== fork) forkChanged = true;
      }
      if (shared === s.shared && !forkChanged) return 0;

      /*
         What actually went, by difference rather than from `ids`.

         `ids` is what the caller asked for; this is what the store had. The
         override cleanup below then reaches the gates this call removed and no
         others, and the count returned is about the state rather than about the
         request — a caller passing an id twice, or one that was already gone,
         gets the truth.
      */
      const alive = new Set(shared.map((g) => g.id));
      for (const fork of Object.values(divergent)) for (const g of fork) alive.add(g.id);
      const removed = new Set<string>();
      for (const g of s.shared) if (!alive.has(g.id)) removed.add(g.id);
      for (const fork of Object.values(s.divergent)) {
        for (const g of fork) if (!alive.has(g.id)) removed.add(g.id);
      }

      record('Remove gates');

      const overrides = { ...s.overrides };
      // Or they sit keyed to a gate that no longer exists and are silently
      // adopted by the next gate issued the same id — the same reason
      // `removeGate` and `pruneReferenceGates` both clear them.
      for (const id of removed) delete overrides[id];

      set({
        shared,
        divergent,
        overrides,
        ...selectionKeeping(s, (id) => alive.has(id)),
      });
      return removed.size;
    },

    selectGate(id) {
      set({
        selectedGateId: id,
        selectedGateIds: id ? [id] : [],
        gateSelectionAnchor: id,
      });
    },

    toggleGateInSelection(id) {
      set((s) => {
        const inIt = s.selectedGateIds.includes(id);
        const next = inIt ? s.selectedGateIds.filter((x) => x !== id) : [...s.selectedGateIds, id];
        return {
          selectedGateIds: next,
          /*
             The primary follows the set rather than sitting outside it. Dropping
             the primary hands the role to whatever is left, because a plot
             marking a gate that is no longer selected is the state this whole
             file exists to prevent; adding takes it, so the row just clicked is
             the one the inspector talks about.
          */
          selectedGateId: inIt ? next[next.length - 1] ?? null : id,
          // A Ctrl-click is a plain click's sibling and moves the anchor with it.
          gateSelectionAnchor: id,
        };
      });
    },

    extendGateSelectionTo(id, ordered) {
      set((s) => {
        /*
           No anchor, or an anchor the caller's order does not carry, reads as a
           plain click — the same reading `blockBetween` gives a row that has been
           filtered off the screen, and the same one `extendSelectionTo` gives.
           The anchor does **not** move, so the next Shift-click re-measures from
           here and the range can be shrunk again.
        */
        const from = s.gateSelectionAnchor;
        const a = from === null ? -1 : ordered.indexOf(from);
        const b = ordered.indexOf(id);
        if (b < 0) return s;
        if (a < 0) return { selectedGateId: id, selectedGateIds: [id], gateSelectionAnchor: id };
        const block = a <= b ? ordered.slice(a, b + 1) : ordered.slice(b, a + 1);
        return { selectedGateId: from, selectedGateIds: block, gateSelectionAnchor: from };
      });
    },
    setTool(t) { set({ tool: t, pendingPolygon: null }); },
    setPendingPolygon(v) { set({ pendingPolygon: v }); },

    unlinkSample(sampleId) {
      if (get().isDivergent(sampleId)) return;
      record('Unlink gating');
      // Forked from what the sample is showing right now, with fresh ids: two
      // hierarchies sharing gate ids would make "which one did I just edit?"
      // depend on the write path rather than on the data.
      //
      // `gatesFor` rather than `shared`, which is what the sentence above always
      // claimed and what only became a distinction once a gate could belong to
      // one sample: forking off `shared` would hand this sample every *other*
      // control's brackets, which `resolveGates` would then filter back out —
      // leaving a fork whose contents depend on which list it was taken from.
      const own = get().gatesFor(sampleId);
      set((s) => ({
        divergent: { ...s.divergent, [sampleId]: cloneStrategy(own, () => nextGateId()) },
      }));
    },

    relinkSample(sampleId) {
      if (!get().isDivergent(sampleId)) return;
      record('Relink gating');
      set((s) => {
        const next = { ...s.divergent };
        delete next[sampleId];
        return { divergent: next, ...NO_SELECTION };
      });
    },

    applyToAllSamples(sampleId) {
      const source = get().gatesFor(sampleId);
      record('Apply gating to all samples');
      // Every fork goes, this one included: "apply to all" means all, and leaving
      // the source forked would make the sample it came from the only one not
      // using it.
      set({ shared: cloneStrategy(source, () => nextGateId()), divergent: {}, ...NO_SELECTION });
    },

    copyStrategy(fromSampleId, toSampleIds) {
      const source = get().gatesFor(fromSampleId);
      if (source.length === 0) return;
      record('Copy gating strategy');
      set((s) => {
        const next = { ...s.divergent };
        for (const id of toSampleIds) {
          if (id === fromSampleId) continue;
          next[id] = cloneStrategy(source, () => nextGateId());
        }
        return { divergent: next };
      });
    },

    clearGates(sampleId) {
      record('Clear gates');
      writeFor(sampleId, () => []);
      set(NO_SELECTION);
    },

    resetGating() {
      set({
        shared: [],
        divergent: {},
        overrides: {},
        ...NO_SELECTION,
        // A tool left armed would draw on the first plot of the next
        // experiment, on a press meant to select it.
        tool: 'none',
        pendingPolygon: null,
      });
    },
  };
});

/*
   Every gate goes when every sample does.

   Not `clearGates`, which is per sample, records an undo step and leaves the
   forks and the per-gate overrides of the *other* samples in place. Nothing is
   recorded here for the reason nothing is recorded for a sample removal: a
   snapshot cannot put a removed sample's event data back, so there is no state
   to return to and an entry on the stack would offer one. See
   `state/workspaceCleared.ts`.
*/
onWorkspaceCleared(() => useGates.getState().resetGating());

/*
   A derived parameter was added or removed, so every index past it now names a
   different parameter. Every copy of a gate follows its own — the shared
   strategy, each forked sample's, each per-sample override — and a gate on the
   removed parameter itself goes, through `removeGates`, which is the one path
   that reaches all three copies and lifts the children to its parent. See
   `state/parameterShift.ts` for the report this answers.

   Runs inside `derivedStore`'s step, so the remap is part of the same undo.
*/
onParameterShift((shift) => {
  const orphaned = new Set<string>();
  const move = (g: Gate): Gate => {
    const x = shiftIndex(g.xParam, shift);
    const y = 'yParam' in g && typeof g.yParam === 'number' ? shiftIndex(g.yParam, shift) : undefined;
    if (x === null || y === null) orphaned.add(g.id);
    const next = { ...g, xParam: x ?? g.xParam };
    if (y !== undefined && y !== null) (next as { yParam: number }).yParam = y;
    return next;
  };
  const s = useGates.getState();
  useGates.setState({
    shared: s.shared.map(move),
    divergent: Object.fromEntries(Object.entries(s.divergent).map(([id, fork]) => [id, fork.map(move)])),
    overrides: Object.fromEntries(Object.entries(s.overrides).map(([gateId, per]) => [
      gateId,
      Object.fromEntries(Object.entries(per).map(([sampleId, g]) => [sampleId, move(g)])),
    ])),
  });
  if (orphaned.size > 0) useGates.getState().removeGates(orphaned);
});

/**
 * Which gates read a parameter index — the question asked before removing a
 * derived parameter, so the confirmation can name what goes with it.
 */
export function gatesUsingParameter(index: number): Gate[] {
  const s = useGates.getState();
  const seen = new Map<string, Gate>();
  const all = [...s.shared, ...Object.values(s.divergent).flat()];
  for (const g of all) {
    const y = 'yParam' in g && typeof g.yParam === 'number' ? g.yParam : null;
    if (g.xParam === index || y === index) seen.set(g.id, g);
  }
  return [...seen.values()];
}

/* -------------------------------------------------------------------------
   Display-column cache
   ------------------------------------------------------------------------- */

/**
 * Gates are stored in display space, so evaluating them needs the same
 * transformed columns the plot draws. Those are cached per
 * (sample, parameter, transform) — a 14-gate hierarchy spanning six parameters
 * would otherwise re-transform the same column repeatedly on every edit.
 */
const columnCache = new WeakMap<ParsedFcs, Map<string, Float32Array>>();

export function displayColumn(
  parsed: ParsedFcs,
  parameterIndex: number,
  spec: TransformSpec,
): Float32Array {
  // Keyed on what the index resolves to, never on the number alone — see
  // `parameterKey` for the two ways the number changes meaning under a file.
  const defs = useDerived.getState().defs;
  const key = `${parameterKey(parsed, parameterIndex, defs)}:${specKey(spec)}`;
  let per = columnCache.get(parsed);
  if (!per) { per = new Map(); columnCache.set(parsed, per); }
  const hit = per.get(key);
  if (hit) return hit;

  // Through `sampleColumn`, so a gate can be drawn on a derived parameter and
  // evaluated exactly like one on a detector.
  const raw = sampleColumn(parsed, parameterIndex, defs);
  const out = transformColumn(raw, createTransform(spec));

  // Bound the cache: a workspace can touch many parameters, and each column is
  // 4 bytes × events.
  if (per.size > 24) per.clear();
  per.set(key, out);
  return out;
}

/**
 * Identity of a transform spec, for cache keys.
 *
 * Names **every** field. `min` was left out originally on the grounds that only
 * `LinearTransform.displayDomain` reads it and the forward map ignores it — true
 * today, and a cache key that is right by coincidence about the implementation
 * of one transform is a trap for whoever writes the next one.
 */
export function specKey(spec: TransformSpec): string {
  return `${spec.kind}|${spec.range}|${spec.min ?? ''}|${spec.decades ?? ''}|${spec.width ?? ''}|${spec.negativeDecades ?? ''}|${spec.cofactor ?? ''}`;
}

/* -------------------------------------------------------------------------
   Evaluation cache
   ------------------------------------------------------------------------- */

const evalCache = new Map<string, { key: string; result: EvaluatedTree }>();

function gatesKey(gates: Gate[]): string {
  // Structural, not identity-based: an edited gate must invalidate, a re-render
  // with the same values must not.
  return JSON.stringify(gates);
}

/**
 * The display space one of a gate's axes is expressed in.
 *
 * The gate's own record when it has one, the parameter's default otherwise. The
 * fallback is what makes a gate drawn before 2026-08-03 keep behaving exactly as
 * it did — it was evaluated against `defaultSpecFor` then, and it still is.
 */
export function gateAxisSpec(
  gate: Gate,
  axis: 'x' | 'y',
  fallback: (parameterIndex: number) => TransformSpec,
): TransformSpec {
  const own = axis === 'x' ? gate.xSpec : gate.ySpec;
  if (own) return own;
  return fallback(gateAxisParam(gate, axis));
}

/** The parameter index behind one of a gate's axes. */
export function gateAxisParam(gate: Gate, axis: 'x' | 'y'): number {
  return axis === 'x' || gate.kind === 'range' ? gate.xParam : gate.yParam;
}

/**
 * Evaluate a sample's gating tree, reusing the previous result when nothing
 * relevant changed.
 *
 * `axisSpecFor` is now only a **fallback**, consulted for a gate that predates
 * `xSpec`/`ySpec`. Every caller used to pass a different one — the panel passed
 * its own axis specs, everything else passed `defaultSpecFor` — and that is what
 * made one gate report two sizes depending on who asked. See the note on
 * `GateBase`.
 */
export function evaluateFor(
  sampleId: string,
  parsed: ParsedFcs,
  gates: Gate[],
  axisSpecFor: (parameterIndex: number) => TransformSpec,
): EvaluatedTree {
  /*
     The cache key has to name every spec the evaluation will actually use. A
     gate's own specs are inside `gatesKey`, since they are fields on the gate;
     what still has to be spelled out is the *fallback* for each axis that has
     none, because two callers passing different fallbacks must not share a slot.
  */
  const fallbacks = new Map<number, TransformSpec>();
  // And what each index resolves to: a gate's own fields say *which number*,
  // and the number changes meaning under it (`parameterKey`).
  const defs = useDerived.getState().defs;
  const meanings = new Map<number, string>();
  for (const g of gates) {
    for (const axis of ['x', 'y'] as const) {
      if (axis === 'y' && g.kind === 'range') continue;
      const p = gateAxisParam(g, axis);
      if (!meanings.has(p)) meanings.set(p, parameterKey(parsed, p, defs));
      if (axis === 'x' ? g.xSpec : g.ySpec) continue;
      if (!fallbacks.has(p)) fallbacks.set(p, axisSpecFor(p));
    }
  }

  const key = [
    sampleId,
    gatesKey(gates),
    [...fallbacks.entries()].map(([p, s]) => `${p}=${specKey(s)}`).join(','),
    [...meanings.entries()].map(([p, m]) => `${p}~${m}`).join(','),
  ].join('|');

  const cached = evalCache.get(sampleId);
  if (cached?.key === key) return cached.result;

  const ctx: GateContext = {
    eventCount: parsed.metadata.eventCount,
    columnFor: (gate, axis) => displayColumn(
      parsed,
      gateAxisParam(gate, axis),
      gateAxisSpec(gate, axis, (p) => fallbacks.get(p) ?? axisSpecFor(p)),
    ),
  };

  const result = evaluateGates(gates, ctx);
  evalCache.set(sampleId, { key, result });
  return result;
}

/**
 * Default transform spec for a parameter, matching what the plot would pick.
 *
 * It has to match. A gate is stored in display space, so evaluating it against a
 * column transformed differently from the one it was drawn on selects different
 * events. `defaultTransformKind` is the single source of that choice — this used
 * to restate it, and a restated constant is a constant that eventually differs.
 */
export function defaultSpecFor(parsed: ParsedFcs, parameterIndex: number): TransformSpec {
  const defs = useDerived.getState().defs;
  const p = parametersFor(parsed, defs)[parameterIndex];
  const raw = sampleColumn(parsed, parameterIndex, defs);
  const spec = autoSpec(defaultTransformKind(p?.type ?? 'Other'), p?.range ?? 1, raw);
  const min = axisMinFor(parsed, parameterIndex, defs);
  return min < 0 ? { ...spec, min } : spec;
}
