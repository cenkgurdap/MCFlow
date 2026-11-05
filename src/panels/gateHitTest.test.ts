import { describe, expect, it } from 'vitest';
import {
  HANDLE_HIT_R, handlePointsFor, handleTargets, isOverGateHandle, type HitContext,
} from './gateHitTest';
import type { Gate } from '@/core/gating/types';

/* ==========================================================================
   Gate handles outrank the per-event hover tooltip.

   The bug this pins down was reported as "hovering blocks gate editing": a drag
   on a resize handle or a polygon vertex showed event circles instead of
   changing the gate. Two hit tests were competing over the same pixels and the
   handle — the smaller, more deliberate target — was losing. So the handle wins
   by rule, and the rule is a function rather than a happy accident of z-order.
   ========================================================================== */

/** Identity mapping, so a "data" coordinate below is also a pixel. */
const ctx: HitContext = {
  toPixelX: (v) => v,
  toPixelY: (v) => v,
  xParam: 0,
  yParam: 1,
  plotW: 300,
  plotH: 200,
};

const base = { parentId: null, colorIndex: 0 };

const rect: Gate = {
  ...base, id: 'r', name: 'R', kind: 'rectangle',
  xParam: 0, yParam: 1, xMin: 20, xMax: 120, yMin: 30, yMax: 130,
};

const poly: Gate = {
  ...base, id: 'p', name: 'P', kind: 'polygon',
  xParam: 0, yParam: 1,
  vertices: [{ x: 10, y: 10 }, { x: 90, y: 20 }, { x: 50, y: 95 }],
};

const ellipse: Gate = {
  ...base, id: 'e', name: 'E', kind: 'ellipse',
  xParam: 0, yParam: 1, cx: 100, cy: 100, rx: 40, ry: 25, angle: 0,
};

const quad: Gate = {
  ...base, id: 'q', name: 'Q', kind: 'quadrant',
  xParam: 0, yParam: 1, xSplit: 70, ySplit: 80, quadrant: 0,
};

const range: Gate = {
  ...base, id: 'g', name: 'G', kind: 'range', xParam: 0, min: 40, max: 160,
};

describe('handlePointsFor', () => {
  it('gives a rectangle its four corners', () => {
    const pts = handlePointsFor(rect, ctx);
    expect(pts.map((h) => h.handle).sort()).toEqual(['ne', 'nw', 'se', 'sw']);
    // y is inverted by the real mapping; with identity, yMax is the "top".
    expect(pts.find((h) => h.handle === 'nw')).toMatchObject({ x: 20, y: 30 });
    expect(pts.find((h) => h.handle === 'se')).toMatchObject({ x: 120, y: 130 });
  });

  it('gives a polygon one handle per vertex, named as the drag dispatches on', () => {
    // `applyGateDrag` slices the index out of `v<i>`, so the names are not
    // cosmetic — a mismatch here would move the wrong vertex.
    expect(handlePointsFor(poly, ctx).map((h) => h.handle)).toEqual(['v0', 'v1', 'v2']);
  });

  it('gives an ellipse its two radius handles', () => {
    const pts = handlePointsFor(ellipse, ctx);
    expect(pts.map((h) => h.handle)).toEqual(['rx', 'ry']);
    expect(pts[0]).toMatchObject({ x: 140, y: 100 });
    expect(pts[1]).toMatchObject({ x: 100, y: 75 });
  });

  it('gives a quadrant its origin, and only for the first of the four', () => {
    expect(handlePointsFor(quad, ctx)).toHaveLength(1);
    expect(handlePointsFor({ ...quad, quadrant: 2 } as Gate, ctx)).toHaveLength(0);
  });

  it('gives a range gate both boundaries', () => {
    const pts = handlePointsFor(range, ctx);
    expect(pts.map((h) => h.handle)).toEqual(['min', 'max']);
    // A vertical band: the boundaries vary along x and span the full height.
    expect(pts.map((h) => [h.axis, h.x, h.y])).toEqual([['x', 40, 100], ['x', 160, 100]]);
  });

  /*
     A range gate cuts one parameter. Which axis a given plot happens to carry
     that parameter on is a question about the plot, so the same gate is a
     vertical band on one and a horizontal band on another — and it has to be
     grabbable on both. It was drawable on x alone until 2026-08-20, which is how
     the Live/Dead split came to be missing from a plot whose numbers it set.
  */
  it('gives a range gate boundaries on y when its parameter is the y axis', () => {
    const onY = { ...range, xParam: 1 } as Gate;
    const pts = handlePointsFor(onY, ctx);
    expect(pts.map((h) => [h.axis, h.x, h.y])).toEqual([['y', 150, 40], ['y', 150, 160]]);
  });

  it('draws a range gate against x when both axes are the same parameter', () => {
    const both = { ...ctx, yParam: 0 };
    expect(handlePointsFor(range, both).every((h) => h.axis === 'x')).toBe(true);
  });

  it('has no handles for a gate drawn on other axes', () => {
    expect(handlePointsFor({ ...rect, xParam: 7 } as Gate, ctx)).toHaveLength(0);
    expect(handlePointsFor({ ...range, xParam: 7 } as Gate, ctx)).toHaveLength(0);
  });

  it('keeps a range gate off a histogram y axis, which is count and not a parameter', () => {
    const onY = { ...range, xParam: 1 } as Gate;
    expect(handlePointsFor(onY, { ...ctx, oneDimensional: true })).toHaveLength(0);
  });

  it('hides two-dimensional handles on a histogram but keeps range boundaries', () => {
    const hist = { ...ctx, oneDimensional: true };
    expect(handlePointsFor(rect, hist)).toHaveLength(0);
    expect(handlePointsFor(poly, hist)).toHaveLength(0);
    expect(handlePointsFor(range, hist)).toHaveLength(2);
  });

  it('has nothing to offer when no gate is selected', () => {
    expect(handlePointsFor(null, ctx)).toHaveLength(0);
  });
});

describe('handleTargets', () => {
  it('takes handles from the selected gate', () => {
    expect(handleTargets([rect, poly], rect.id, ctx)).toHaveLength(4);
    expect(handleTargets([rect, poly], poly.id, ctx)).toHaveLength(3);
  });

  it('gives an unselected rectangle or polygon nothing — its body is the target', () => {
    expect(handleTargets([rect, poly], null, ctx)).toHaveLength(0);
  });

  it('keeps a quadrant origin and a range boundary whether selected or not', () => {
    // These two draw their targets always, because they *are* the gate's whole
    // geometry. Passing only the selected gate left a quadrant's crosshair
    // unprotected whenever a sibling quadrant of the same set was selected —
    // which is the state immediately after drawing one, since a quadrant is four
    // gates and the last of them ends up selected.
    expect(handleTargets([quad], null, ctx)).toHaveLength(1);
    expect(handleTargets([range], null, ctx)).toHaveLength(2);
    const set = [quad, { ...quad, id: 'q3', quadrant: 3 } as Gate];
    expect(handleTargets(set, 'q3', ctx)).toHaveLength(1);
  });
});

describe('isOverGateHandle', () => {
  it('claims the pointer inside a rectangle corner', () => {
    expect(isOverGateHandle([rect], rect.id, { x: 20, y: 30 }, ctx)).toBe(true);
    expect(isOverGateHandle([rect], rect.id, { x: 20 + HANDLE_HIT_R - 1, y: 30 }, ctx)).toBe(true);
  });

  it('releases it beyond the target, where the tooltip is the right answer', () => {
    // The point of the rule is that it is bounded: a hover over ordinary plot
    // area a little way from a handle must still read out an event.
    expect(isOverGateHandle([rect], rect.id, { x: 20 + HANDLE_HIT_R + 2, y: 30 }, ctx)).toBe(false);
    expect(isOverGateHandle([rect], rect.id, { x: 70, y: 80 }, ctx)).toBe(false);
  });

  it('is wider than the hover search radius, which is the whole fix', () => {
    // The per-event hover uses a 10 px radius. A handle target narrower than that
    // is a target the tooltip wins more often than not, which is exactly what
    // "hovering blocks gate editing" was.
    expect(HANDLE_HIT_R).toBeGreaterThan(10 / 2);
  });

  it('claims a polygon vertex', () => {
    expect(isOverGateHandle([poly], poly.id, { x: 91, y: 22 }, ctx)).toBe(true);
    expect(isOverGateHandle([poly], poly.id, { x: 60, y: 60 }, ctx)).toBe(false);
  });

  it('claims an ellipse radius handle', () => {
    expect(isOverGateHandle([ellipse], ellipse.id, { x: 140, y: 103 }, ctx)).toBe(true);
    expect(isOverGateHandle([ellipse], ellipse.id, { x: 100, y: 76 }, ctx)).toBe(true);
  });

  it('claims a quadrant origin even when a sibling quadrant is the selected one', () => {
    const set = [quad, { ...quad, id: 'q3', quadrant: 3 } as Gate];
    expect(isOverGateHandle(set, 'q3', { x: 72, y: 78 }, ctx)).toBe(true);
  });

  it('claims a range boundary at any height, because the boundary is a full-height line', () => {
    // Testing a range against a point would make its boundary grabbable only
    // near the middle of the plot, which is not where anyone aims.
    for (const y of [1, 100, 199]) {
      expect(isOverGateHandle([range], null, { x: 42, y }, ctx)).toBe(true);
    }
    expect(isOverGateHandle([range], null, { x: 100, y: 100 }, ctx)).toBe(false);
  });

  it('claims a range boundary at any width when the band is horizontal', () => {
    const onY = { ...range, xParam: 1 } as Gate;
    for (const x of [1, 150, 299]) {
      expect(isOverGateHandle([onY], null, { x, y: 42 }, ctx)).toBe(true);
    }
    expect(isOverGateHandle([onY], null, { x: 150, y: 100 }, ctx)).toBe(false);
  });

  it('claims nothing on a bare plot', () => {
    expect(isOverGateHandle([], null, { x: 20, y: 30 }, ctx)).toBe(false);
    expect(isOverGateHandle([rect], null, { x: 20, y: 30 }, ctx)).toBe(false);
  });
});
