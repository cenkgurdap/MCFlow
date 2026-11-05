/**
 * Panel creation from a drag or a menu.
 *
 * Dragging a sample or a population onto the worksheet is the fast way to build
 * a layout — draw a gate, drag it out, draw the next one — so the panel it
 * produces has to be immediately useful without anyone opening a dropdown. That
 * means guessing well, which is what this module does.
 *
 * Kept pure and free of stores so the guesses can be tested directly, and so the
 * drop handler and the context menu are provably the same code path rather than
 * two implementations that drift.
 */

import type { FcsMetadata, FcsParameter } from '@/core/fcs/types';
import type { Gate } from '@/core/gating/types';
import { defaultTransformKind } from '@/core/transform';
import { PANEL_VIEW_DEFAULTS } from './panelDefaults';
// Type-only, deliberately: `plotStore` imports this module back for its
// `openPanel` action, and a value import either way would close the cycle at
// runtime. Types are erased, so this edge does not exist once compiled.
import type { PanelConfig } from '@/state/plotStore';

/** What the user dropped. */
export interface OpenPanelRequest {
  sampleId: string;
  /** Population the new panel is scoped to; null is the root, all events. */
  populationId: string | null;
}

/**
 * Everything the guess needs that lives outside this module.
 *
 * `recent` is the layout's most-recently-touched panel. Someone building a
 * series of related plots wants the next one to look like the last, so its axes
 * and plot type are a better default than the project's cold-start choice.
 */
export interface OpenPanelContext {
  metadata: FcsMetadata;
  /** The target sample's gates, so a drop naming a deleted one can be caught. */
  gates: Gate[];
  recent?: PanelConfig | null;
  /**
   * The plot this drag came **off**, when it came off one.
   *
   * Set when a gate is dragged out of a panel, which is where a sequential
   * gating strategy is actually built. `null` from the sidebar's gate tree and
   * from the context menus, which name a population without naming a plot — and
   * `recent` answers for those.
   */
  source?: PanelConfig | null;
}

/* -------------------------------------------------------------------------
   Axis choice
   ------------------------------------------------------------------------- */

/** Channels a user would plot: real data, and not the clock. */
function plottable(params: FcsParameter[]): number[] {
  return params
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.isDataChannel && p.type !== 'Time')
    .map(({ i }) => i);
}

/*
   ## The axes a dropped population opens on (2026-08-12, Item 10)
   ## — a deliberate reversal, and the reason for it has already been removed

   Until now this module inferred them: `nextAxesFor` took the parameters the
   dragged population's **ancestry** had already discriminated on and picked the
   first two fluorescence channels that were not among them. The argument was
   that re-plotting a population against the very pair that defined it "shows a
   box filled corner to corner", which tells the reader nothing they did not
   just draw.

   That argument was about a **box being drawn**, and no box is drawn any more.
   The workbench pass (2026-08-10, Item 16) established that *a scoped panel
   draws the gates whose parent is the population it is plotting, and nothing
   else* — which means a panel scoped to Cells does not render the Cells gate,
   on any axes, including the ones Cells was drawn on. The corner-to-corner box
   this rule was avoiding stopped existing two days before the rule was
   questioned. What was left was the cost with none of the benefit: on the
   71-parameter Aurora layout the first two unused fluorescence channels are
   **UV1-A and UV2-A**, so every population dragged out of an FSC × SSC plot
   opened on a pair of ultraviolet detectors nobody had asked about.

   And it is backwards for the gesture it exists to serve. Sequential gating
   changes **one** axis per step — Cells on FSC × SSC, then CD3 against SSC,
   then CD4 against CD8 — so the plot you want next is the plot you were just
   looking at, with one parameter swapped. Inferring both meant resetting both.

   So the chain is now: **the plot it was dragged off**, then the active plot,
   then the sample's opening pair. Each step is something the user was looking
   at rather than something derived; `defaultAxes` is FSC-A × SSC-A, which is
   the right answer for a drop onto an empty worksheet and a better one than
   UV1 × UV2 was.

   `nextAxesFor` and `axesUsedByAncestry` are deleted with this, rather than
   left exported and unused. Two comments elsewhere cite `nextAxesFor` for why
   two sibling populations end up on identical axes — that premise is
   **strengthened**, not lost: two gates dragged off the same plot now inherit
   its axes by construction rather than by both being handed the same
   inference, so Item 16's isolation rule matters at least as much as it did.
*/

/* -------------------------------------------------------------------------
   Panel assembly
   ------------------------------------------------------------------------- */

/**
 * The decisions this module makes, as overrides for `makePanel`.
 *
 * A draft rather than a finished `PanelConfig` so nothing here has to reach into
 * the store for an id generator or the field defaults — and so a test asserts on
 * exactly what was decided, with no defaults to read past.
 */
export type PanelDraft = Partial<PanelConfig> & {
  /** null means "follow the sidebar selection" — see `panelForRequest`. */
  sampleId: string | null;
  populationId: string | null;
  xParam: number;
  yParam: number;
};

/**
 * Build the panel for one drop.
 *
 * **What the user dragged decides whether the panel is pinned.**
 *
 * Dragging a *sample* names a file: that panel is pinned to it, or dropping
 * three replicates side by side would produce three views of whichever one the
 * sidebar happens to be on, and the gesture would mean nothing.
 *
 * Dragging a *population* names no file at all. Gating is shared across every
 * loaded sample, so "Lymphocytes" is a definition that exists on all of them,
 * and a panel showing it should follow the active sample exactly as the first
 * panel in a fresh workspace does — that is what makes clicking down the sidebar
 * a comparison. Pinning it to whichever sample was on screen at the moment of
 * the drag is what made these panels sit frozen while every other one updated.
 *
 * Nothing here mutates the existing layout — pinning a new panel never re-pins
 * an old one.
 */
export function panelForRequest(req: OpenPanelRequest, ctx: OpenPanelContext): PanelDraft {
  const params = ctx.metadata.parameters;

  /*
     Axis fallback chain, most specific first. See the block comment above for
     why the ancestry inference that used to lead it is gone.

     A **spectrum** panel is skipped at both steps: it plots one population
     across every detector and has no y parameter to speak of, so its `yParam`
     is whatever it was left with rather than an axis anybody chose. Inheriting
     from one would be inheriting a number that means nothing — and a reference
     worksheet is full of them, which is exactly where somebody dragging a
     population out of the wizard's own plots would land.
  */
  const usable = (p: PanelConfig | null | undefined) =>
    (p && p.plotType !== 'spectrum' ? p : null);
  const from = usable(ctx.source) ?? usable(ctx.recent);
  const axes = (from ? { x: from.xParam, y: from.yParam } : null)
    ?? defaultAxes(ctx.metadata);

  const last = Math.max(0, params.length - 1);
  const x = Math.min(Math.max(0, axes.x), last);
  const y = Math.min(Math.max(0, axes.y), last);

  // Transforms follow the parameters, not the source panel: carrying a logicle
  // width basis estimated on one channel over to another is meaningless, which
  // is the same reason `setAxis` clears overrides.
  //
  // `initialisedFor` is pre-set so the panel's mount effect does not
  // immediately overwrite these axes with FSC/SSC — the `initialiseFor` trap
  // PROGRESS.md already records.
  return {
    sampleId: req.populationId === null ? req.sampleId : null,
    populationId: req.populationId,
    xParam: x,
    yParam: y,
    xTransform: defaultTransformKind(params[x]?.type ?? 'Other'),
    yTransform: defaultTransformKind(params[y]?.type ?? 'Other'),
    // Fixed, not inherited from `ctx.recent`. The axes above *are* inherited,
    // and the distinction is the point: which parameters to plot continues what
    // the user is doing, but how the plot is drawn is a setting, and a setting
    // that silently follows the last panel touched means a dropped population
    // opens differently depending on history the user is not thinking about.
    ...PANEL_VIEW_DEFAULTS,
    // Non-null so the panel's mount effect does not overwrite the axes chosen
    // above with FSC/SSC — the `initialiseFor` trap PROGRESS.md records. It is
    // read as "has this panel chosen its axes yet", not as "which sample", so a
    // following panel keeps them when the active sample changes underneath it.
    initialisedFor: req.sampleId,
  };
}

/* -------------------------------------------------------------------------
   Gate parentage
   ------------------------------------------------------------------------- */

/**
 * Parent for a gate drawn on a panel.
 *
 * The rule the whole drag workflow rests on, extracted from `PlotCanvas` so it
 * can be asserted directly rather than inferred from a rendered component.
 *
 * A **scoped** panel wins outright: it is plotting one population's events and
 * nothing else, so a shape drawn on it can only mean a subset of that
 * population. That is what makes "drag a gate out, draw the next one" build a
 * hierarchy without anyone choosing a parent.
 *
 * An **unscoped** panel keeps the original behaviour and nests under whatever is
 * selected in the tree, which is how a strategy is built without dragging.
 */
export function gateParentFor(
  panel: { populationId: string | null } | undefined,
  selectedGateId: string | null,
): string | null {
  return panel?.populationId ?? selectedGateId;
}

/**
 * FSC-A × SSC-A, the universal opening plot.
 *
 * Duplicated from `plotStore.pickDefaultAxes` rather than exported from it,
 * because importing a store's internals into pure layout logic is the wrong
 * direction of dependency — and this needs to run in tests with no store.
 */
function defaultAxes(md: FcsMetadata): { x: number; y: number } {
  const byName = (name: string) => md.parameters.findIndex((p) => p.name.toUpperCase() === name);
  const byType = (type: string) => md.parameters.findIndex((p) => p.type === type);

  const x = byName('FSC-A') >= 0 ? byName('FSC-A') : byType('Forward_Scatter');
  const y = byName('SSC-A') >= 0 ? byName('SSC-A') : byType('Side_Scatter');
  const data = plottable(md.parameters);

  return {
    x: x >= 0 ? x : (data[0] ?? 0),
    y: y >= 0 ? y : (data[1] ?? data[0] ?? 0),
  };
}
