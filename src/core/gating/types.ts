/**
 * Gate model.
 *
 * Gate geometry is stored in **display space** — the coordinates the user
 * actually drew in, after the axis transform. Storing raw channel values would
 * mean a gate silently changing shape when the transform changes, which is not
 * what anyone drawing on a logicle axis intends.
 *
 * ## And display space is not one space
 *
 * That is the correction of 2026-08-03, and it is the whole of Item 17. "Display
 * space" is a function of the transform spec, so a boundary at `x = 2.3` means a
 * different raw value under biexponential than under logicle — and until this
 * change nothing on a gate said which one it meant. Every reader picked its own:
 * `PlotCanvas` used the panel's current axis spec, and the gate tree, the
 * statistics table and the export all used `defaultSpecFor`. Switch a transform
 * on an axis a gate is defined on and those two answers separate silently, with
 * the plot drawing a box around one population while every number in the
 * application described another — for one gate, at one moment, the two counts
 * could differ by nearly a factor of two.
 *
 * So a gate now carries `xSpec`/`ySpec` — the spec its coordinates are
 * expressed in. They are written by whichever panel the gesture happened on, and
 * they are what evaluation reads. A panel displaying the gate under a *different*
 * spec reprojects it through raw for drawing (`reprojectGate`), so what is on
 * screen and what is counted cannot come apart again.
 *
 * Both are optional: a gate saved before this change has neither, falls back to
 * the default spec, and therefore behaves exactly as it did.
 */
import type { TransformSpec } from '../transform/types';

/**
 * Every kind of gate the app can produce.
 *
 * There is no `boolean` here any more. AND/OR/NOT combination gates were part of
 * the original brief and were built, and they turned out to be complexity nobody
 * used: every one of them describes a population that can be drawn directly, and
 * their presence forced three otherwise-unnecessary special cases — a gate with
 * no axes, a cycle that `parentId` alone cannot create, and an operand list that
 * `removeGate` had to garbage-collect. Removed rather than carried.
 */
export type GateKind = 'rectangle' | 'polygon' | 'ellipse' | 'quadrant' | 'range';

export interface Point {
  x: number;
  y: number;
}

interface GateBase {
  id: string;
  name: string;
  /** Parent population, or null for a child of "All events". */
  parentId: string | null;
  /** Index into the population palette. */
  colorIndex: number;
  kind: GateKind;
  /**
   * The display space `xParam`'s coordinates are expressed in.
   *
   * Written by the panel the gesture happened on, read by evaluation. Absent on
   * gates drawn before 2026-08-03, which fall back to the parameter's default
   * spec — the behaviour those gates were created under. See the header note.
   */
  xSpec?: TransformSpec;
  /** The same for `yParam`. Absent on a range gate, which has no y axis. */
  ySpec?: TransformSpec;
  /**
   * Whether this gate's **boundary** is the same on every sample.
   *
   * `true` or absent — the default — means one shape for the whole experiment,
   * which is what a gating strategy usually is. `false` means this gate alone
   * carries a per-sample boundary, held in `useGates.overrides`, and adjusting
   * it while viewing one sample moves it on that sample only.
   *
   * **It is a property of the gate, not of the subtree.** An initial
   * scatter/debris gate genuinely needs tuning per file — the noise floor moves
   * between runs — while a marker-positive gate drawn underneath it has to stay
   * identical or the populations are not comparable. So a linked gate can sit
   * beneath an unlinked one and the reverse, and neither reads the other's flag.
   *
   * Only the boundary is per sample. The name, the parent, the colour and this
   * flag itself are one hierarchy across the workspace, which is what keeps a
   * population *path* meaning the same thing on every sample — and paths are
   * what the export and the statistics table are keyed by.
   */
  linked?: boolean;
  /**
   * The one sample this gate exists on, when it exists on only one.
   *
   * Absent — the default, and every gate anyone draws by hand — means the gate
   * belongs to the shared strategy and is evaluated on every sample. Gating is a
   * property of the experiment (see `gateStore`), so that is the right default
   * and it is not changing.
   *
   * What it is for is the case the unmixing wizard creates and no ordinary
   * gating does: a population that is only *meaningful* on one file. "CD8
   * PerCP-eFluor 710 +" is a threshold on the CD8 control's own distribution;
   * it says nothing about the CD27 tube, and evaluating it there produces a
   * number with no referent.
   *
   * It shipped as a visible defect. Two single stains peaking in the **same
   * detector** — which is ordinary, and happens whenever two dyes share an
   * emission maximum — put two range gates on the same `xParam`, and a panel
   * draws every range gate on its x parameter. So CD8's worksheet showed CD8's
   * bracket *and* CD27's, both labelled, both with a percentage, overlapping,
   * on CD8's data. The percentages were each correct for what they measured and
   * one of them measured nothing anybody had asked for.
   *
   * The filter is in `resolveGates`, so it applies to evaluation, the tree, the
   * statistics table and the export at once rather than to whichever surface
   * remembered. A gate with no owner is returned by identity, which is every
   * gate in every workspace saved before this field existed.
   */
  ownerSampleId?: string;
  /**
   * This gate is part of the **unmixing reference-control setup**, not of the
   * experiment.
   *
   * Absent on every gate anybody draws. Set by the wizard on the two kinds of
   * gate it creates: the shared scatter gate its worksheets are built on, and
   * each control's positive/negative bracket.
   *
   * ## Why it is not covered by `ownerSampleId` (2026-08-12, Item 11)
   *
   * The brackets carry an owner and are correctly hidden on other samples. The
   * **general scatter gate is deliberately shared** — every control uses one
   * cell gate, which is the whole point of it — so it has no owner and was
   * therefore evaluated on every file in the workspace, including the
   * multicolour sample somebody is actually analysing. It appeared at the root
   * of the gate tree in a general layout, and any gate drawn while it was
   * selected in the tree became its child, so a real analysis ended up nested
   * under a setup gate and reported as a percentage of it.
   *
   * And `ownerSampleId` has a hole even for the brackets: `resolveGates`
   * applies it per sample, but the tree shown when **no** sample is selected is
   * `shared` unfiltered — which is the *"Shared across all 14 samples"* view in
   * the report, listing every control's bracket at 0.00%.
   *
   * So this is a second axis and not a duplicate of the first: `ownerSampleId`
   * says *which file a gate means something on*, and this says *which part of
   * the application a gate belongs to*. See `withoutReferenceGates`.
   */
  reference?: true;
  /**
   * An explicit outline and label colour for this gate, as a CSS colour.
   *
   * Absent — the default — means the theme's `--gate-ink`: black on the light
   * theme, near-white on the dark one, following the theme automatically. That
   * default is what makes a label legible on either surface without anybody
   * choosing anything, and it is why this is an override rather than a required
   * field. Set from the curated swatches behind a gate's colour chip in the tree.
   *
   * Separate from `colorIndex`, which is the *population* palette slot and still
   * marks the tree chip and the handle squares. A gate can be deliberately
   * recoloured without changing which population colour identifies it.
   */
  color?: string;
}

export interface RectangleGate extends GateBase {
  kind: 'rectangle';
  xParam: number;
  yParam: number;
  xMin: number; xMax: number;
  yMin: number; yMax: number;
}

export interface PolygonGate extends GateBase {
  kind: 'polygon';
  xParam: number;
  yParam: number;
  vertices: Point[];
}

export interface EllipseGate extends GateBase {
  kind: 'ellipse';
  xParam: number;
  yParam: number;
  cx: number; cy: number;
  /** Semi-axes before rotation. */
  rx: number; ry: number;
  /** Radians, counter-clockwise. */
  angle: number;
}

/**
 * A four-way split. One quadrant gate defines four populations at once, which
 * is how every cytometry package presents it; `quadrant` selects which.
 */
export interface QuadrantGate extends GateBase {
  kind: 'quadrant';
  xParam: number;
  yParam: number;
  xSplit: number;
  ySplit: number;
  /** 0=lower-left, 1=lower-right, 2=upper-right, 3=upper-left. */
  quadrant: 0 | 1 | 2 | 3;
}

/** A 1D interval, drawn on a histogram. */
export interface RangeGate extends GateBase {
  kind: 'range';
  xParam: number;
  min: number;
  max: number;
}

export type Gate =
  | RectangleGate | PolygonGate | EllipseGate | QuadrantGate | RangeGate;

/** Gates that are drawn on a 2D plot and own geometry. */
export type GeometricGate = RectangleGate | PolygonGate | EllipseGate | QuadrantGate;

export function isGeometric(g: Gate): g is GeometricGate {
  return g.kind === 'rectangle' || g.kind === 'polygon' || g.kind === 'ellipse' || g.kind === 'quadrant';
}

/**
 * Does this gate reference parameter axes?
 *
 * Every remaining kind does — a range gate has one axis, the rest have two — so
 * this is now constant. It is kept because the call sites read better for it and
 * because it is the single place a future kind without axes would have to be
 * handled, rather than four scattered `kind === …` checks.
 */
export function usesAxes(g: Gate): g is GeometricGate | RangeGate {
  return isGeometric(g) || g.kind === 'range';
}

/** Population statistics for one gate on one sample. */
export interface PopulationStats {
  gateId: string;
  count: number;
  parentCount: number;
  totalCount: number;
  /** Percent of the immediate parent population. */
  percentOfParent: number;
  /** Percent of all events in the sample. */
  percentOfTotal: number;
}

export const ROOT_ID = '__root__';
