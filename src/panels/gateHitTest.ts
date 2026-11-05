/**
 * Where a gate's edit handles are, in plot pixels — and therefore where the
 * per-event hover tooltip must keep out of the way.
 *
 * The reported symptom was that dragging a resize handle or a polygon vertex
 * "just showed event-hover circles" instead of editing the gate. Two causes,
 * both of which this module exists to fix, and neither of which is the tooltip
 * being wrong to exist:
 *
 *  1. **The handles were 5 px squares** and the hover hit radius is 10 px, so the
 *     area a user aims at was more than twice as likely to be answered by the
 *     tooltip's hit test than by the handle's. `GateLayer` now draws a
 *     `HANDLE_HIT`-sized transparent target over each visible handle, so the
 *     thing you can press is the size of the thing you are aiming at.
 *  2. **Nothing gave the handle priority.** A pointer inside a handle's hit
 *     radius is unambiguously aimed at that handle, so the tooltip is suppressed
 *     there outright rather than left to whichever hit test happens to answer
 *     first.
 *
 * Kept pure and store-free — it takes the two pixel mappings the plot already
 * has — so the priority rule can be asserted directly rather than inferred from
 * a rendered component, and so `PlotCanvas` and `GateLayer` share one radius
 * instead of two that drift.
 */

import { isGeometric, type Gate } from '@/core/gating/types';
import { rangeAxisOn } from './panelGates';

/**
 * Side of a handle's hit target, in CSS pixels.
 *
 * The visible handle stays 5 px — a large square drawn over a gate vertex hides
 * the shape it is meant to be adjusting — so this is a transparent target
 * centred on it. Sixteen is comfortably above the 10 px hover radius, which is
 * the point: inside it, the handle wins; outside it, there is no handle nearby
 * and the tooltip is the right answer.
 */
export const HANDLE_HIT = 16;

/** Half-side, i.e. the radius the priority rule tests against. */
export const HANDLE_HIT_R = HANDLE_HIT / 2;

export interface HandlePoint {
  gateId: string;
  /** The same handle name `applyGateDrag` dispatches on. */
  handle: string;
  x: number;
  y: number;
  /**
   * Set when the handle is a **line spanning the plot** rather than a point,
   * naming the axis the pointer's distance to it is measured on: `'x'` for a
   * vertical boundary, `'y'` for a horizontal one.
   *
   * A range gate's boundary is the only handle shaped like this, and it is what
   * `x` and `y` above cannot express — the point stored for a vertical boundary
   * is at mid-height purely so one list can describe every kind, and requiring
   * the pointer to be near that notional midpoint would make the line
   * un-grabbable everywhere except its middle. Now that a range gate draws on
   * either axis (`rangeAxisOn`), which coordinate is the meaningful one is a
   * property of the handle rather than of the gate's kind.
   */
  axis?: 'x' | 'y';
}

export interface HitContext {
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  /** Axis parameter indices currently on the plot. */
  xParam: number;
  yParam: number;
  /** Histogram: only range gates have meaning against a density y axis. */
  oneDimensional?: boolean;
  plotW: number;
  plotH: number;
}

/**
 * Every edit handle a gate is currently drawing, in plot-local pixels.
 *
 * **Two kinds of handle, and the distinction matters.** Most are drawn only
 * while the gate is selected — a rectangle's corners, a polygon's vertices, an
 * ellipse's radii — but a quadrant's crosshair origin and a range gate's two
 * boundaries are drawn *always*, because they are the whole of those gates'
 * geometry and there is nothing else to grab. So the caller cannot simply pass
 * the selected gate and be done; see `handleTargets`.
 */
export function handlePointsFor(gate: Gate | null | undefined, ctx: HitContext): HandlePoint[] {
  if (!gate) return [];
  const { toPixelX, toPixelY } = ctx;

  if (gate.kind === 'range') {
    // Whichever axis this plot carries the gate's parameter on — the same
    // decision `GateLayer` draws by, so what is grabbable is what is visible.
    const on = rangeAxisOn(gate, ctx.xParam, ctx.yParam, ctx.oneDimensional);
    if (!on) return [];
    // The coordinate the boundary does *not* vary along is the middle of the
    // plot, purely so a single list can describe every kind; `axis` is what
    // says which of the two the hit test may look at.
    return ([['min', gate.min], ['max', gate.max]] as const).map(([handle, v]) => ({
      gateId: gate.id,
      handle,
      axis: on,
      x: on === 'x' ? toPixelX(v) : ctx.plotW / 2,
      y: on === 'x' ? ctx.plotH / 2 : toPixelY(v),
    }));
  }

  if (ctx.oneDimensional || !isGeometric(gate)) return [];
  if (gate.xParam !== ctx.xParam || gate.yParam !== ctx.yParam) return [];

  switch (gate.kind) {
    case 'rectangle': {
      const x0 = toPixelX(gate.xMin), x1 = toPixelX(gate.xMax);
      const y0 = toPixelY(gate.yMax), y1 = toPixelY(gate.yMin);
      const l = Math.min(x0, x1), r = Math.max(x0, x1);
      const t = Math.min(y0, y1), b = Math.max(y0, y1);
      return [
        { gateId: gate.id, handle: 'nw', x: l, y: t },
        { gateId: gate.id, handle: 'ne', x: r, y: t },
        { gateId: gate.id, handle: 'se', x: r, y: b },
        { gateId: gate.id, handle: 'sw', x: l, y: b },
      ];
    }
    case 'polygon':
      return gate.vertices.map((v, i) => ({
        gateId: gate.id, handle: `v${i}`, x: toPixelX(v.x), y: toPixelY(v.y),
      }));
    case 'ellipse': {
      const cx = toPixelX(gate.cx), cy = toPixelY(gate.cy);
      const rx = Math.abs(toPixelX(gate.cx + gate.rx) - cx);
      const ry = Math.abs(toPixelY(gate.cy + gate.ry) - cy);
      return [
        { gateId: gate.id, handle: 'rx', x: cx + rx, y: cy },
        { gateId: gate.id, handle: 'ry', x: cx, y: cy - ry },
      ];
    }
    case 'quadrant':
      // Every quadrant of a set shares one origin, and only the first draws it.
      if (gate.quadrant !== 0) return [];
      return [{ gateId: gate.id, handle: 'move', x: toPixelX(gate.xSplit), y: toPixelY(gate.ySplit) }];
    default:
      return [];
  }
}

/**
 * Is a gate's handle drawn even when the gate is not selected?
 *
 * True for a quadrant — its origin is the only thing about it that can be
 * dragged, so it carries a permanent target — and for a range gate, whose two
 * boundaries are the gesture people actually use. Everything else shows handles
 * on selection alone.
 */
function alwaysHandled(gate: Gate): boolean {
  return gate.kind === 'range' || gate.kind === 'quadrant';
}

/**
 * Every handle target on the plot right now: the selected gate's, plus the ones
 * every gate draws regardless.
 *
 * Getting this wrong is not theoretical — passing only the selected gate left a
 * quadrant's crosshair unprotected whenever a *sibling* quadrant of the same set
 * was the selected one, which is the normal state immediately after drawing one,
 * since a quadrant is four gates and the last of them ends up selected.
 */
export function handleTargets(
  gates: readonly Gate[],
  selectedGateId: string | null,
  ctx: HitContext,
): HandlePoint[] {
  const out: HandlePoint[] = [];
  for (const g of gates) {
    if (g.id === selectedGateId || alwaysHandled(g)) out.push(...handlePointsFor(g, ctx));
  }
  return out;
}

/**
 * Is the pointer close enough to an edit handle that the handle owns it?
 *
 * The whole of the priority rule, in one predicate. `PlotCanvas` calls it before
 * running the per-event nearest-point search: inside a handle, there is no
 * tooltip and no event lookup at all.
 *
 * A **range** gate's boundaries are lines spanning the plot, so those targets are
 * tested on one coordinate only — the full-length edge is what is being aimed
 * at, and requiring the pointer to also be near some notional midpoint would
 * make the boundary un-grabbable everywhere except its middle. `h.axis` names
 * which coordinate, because the same gate is a vertical line on one plot and a
 * horizontal one on another.
 */
export function isOverGateHandle(
  gates: readonly Gate[],
  selectedGateId: string | null,
  point: { x: number; y: number },
  ctx: HitContext,
  radius = HANDLE_HIT_R,
): boolean {
  return handleTargets(gates, selectedGateId, ctx).some((h) => {
    if (h.axis === 'x') return Math.abs(point.x - h.x) <= radius;
    if (h.axis === 'y') return Math.abs(point.y - h.y) <= radius;
    return Math.abs(point.x - h.x) <= radius && Math.abs(point.y - h.y) <= radius;
  });
}
