import { describe, expect, it } from 'vitest';
import {
  boundsOf, contains, ellipseFromDrag, inEllipse, inPolygon, inQuadrant,
  inRange, inRectangle, normaliseRect, polygonArea, reprojectGate, sameSpace,
  scalePolygon, simplifyPolygon, translateGate,
} from './geometry';
import { createTransform, type TransformSpec } from '../transform';
import {
  ancestorsOf, childrenOf, cloneStrategy, evaluateGates, maskToIndices,
  flattenTree, populationPath, subtreeOf, topoOrder, wouldCycle, type GateContext,
} from './tree';
import { ROOT_ID, type EllipseGate, type Gate, type PolygonGate, type QuadrantGate, type RangeGate, type RectangleGate } from './types';

const base = { colorIndex: 0, parentId: null as string | null };

const rect = (id: string, x0: number, x1: number, y0: number, y1: number, parentId: string | null = null): RectangleGate =>
  ({ ...base, id, name: id, parentId, kind: 'rectangle', xParam: 0, yParam: 1, xMin: x0, xMax: x1, yMin: y0, yMax: y1 });

/* ==========================================================================
   Geometry
   ========================================================================== */

describe('inRectangle', () => {
  const g = rect('r', 0, 10, 0, 10);
  it('includes the interior and the boundary', () => {
    expect(inRectangle(g, 5, 5)).toBe(true);
    expect(inRectangle(g, 0, 0)).toBe(true);
    expect(inRectangle(g, 10, 10)).toBe(true);
  });
  it('excludes the outside', () => {
    expect(inRectangle(g, -0.001, 5)).toBe(false);
    expect(inRectangle(g, 5, 10.001)).toBe(false);
  });
});

describe('inPolygon', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('matches a rectangle for a square polygon', () => {
    for (const [x, y] of [[5, 5], [1, 9], [9, 1]] as const) expect(inPolygon(square, x, y)).toBe(true);
    for (const [x, y] of [[-1, 5], [11, 5], [5, -1], [5, 11]] as const) expect(inPolygon(square, x, y)).toBe(false);
  });

  it('handles a concave shape', () => {
    // An L: the notch must read as outside.
    const l = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }];
    expect(inPolygon(l, 2, 8)).toBe(true);
    expect(inPolygon(l, 8, 2)).toBe(true);
    expect(inPolygon(l, 8, 8)).toBe(false);
  });

  it('gives the same answer regardless of winding direction', () => {
    const cw = [...square].reverse();
    for (const [x, y] of [[5, 5], [-1, 5], [9, 9]] as const) {
      expect(inPolygon(cw, x, y)).toBe(inPolygon(square, x, y));
    }
  });

  it('counts an event on a horizontal edge exactly once', () => {
    // Events pile up on axis-aligned values in real data, so a vertex counted
    // twice would flip a whole row of them to "outside".
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }];
    expect(inPolygon(tri, 5, 0.0001)).toBe(true);
    expect(inPolygon(tri, 5, 5)).toBe(true);
  });

  it('rejects a degenerate polygon rather than throwing', () => {
    expect(inPolygon([], 0, 0)).toBe(false);
    expect(inPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.5, 0.5)).toBe(false);
  });
});

describe('inEllipse', () => {
  const g: EllipseGate = { ...base, id: 'e', name: 'e', kind: 'ellipse', xParam: 0, yParam: 1, cx: 0, cy: 0, rx: 10, ry: 5, angle: 0 };

  it('respects the semi-axes', () => {
    expect(inEllipse(g, 0, 0)).toBe(true);
    expect(inEllipse(g, 10, 0)).toBe(true);
    expect(inEllipse(g, 0, 5)).toBe(true);
    expect(inEllipse(g, 10.1, 0)).toBe(false);
    expect(inEllipse(g, 0, 5.1)).toBe(false);
    // Outside the box corner but inside the bounding rectangle.
    expect(inEllipse(g, 9, 4)).toBe(false);
  });

  it('rotates', () => {
    const rotated: EllipseGate = { ...g, angle: Math.PI / 2 };
    // After a quarter turn the long axis is vertical.
    expect(inEllipse(rotated, 0, 10)).toBe(true);
    expect(inEllipse(rotated, 10, 0)).toBe(false);
  });

  it('rejects zero radii instead of dividing by zero', () => {
    expect(inEllipse({ ...g, rx: 0 }, 0, 0)).toBe(false);
  });
});

describe('inQuadrant', () => {
  const q = (quadrant: 0 | 1 | 2 | 3): QuadrantGate =>
    ({ ...base, id: 'q', name: 'q', kind: 'quadrant', xParam: 0, yParam: 1, xSplit: 0, ySplit: 0, quadrant });

  it('partitions the plane exactly once', () => {
    const points: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0], [5, -5]];
    for (const [x, y] of points) {
      const hits = ([0, 1, 2, 3] as const).filter((k) => inQuadrant(q(k), x, y));
      expect(hits).toHaveLength(1);
    }
  });

  it('assigns the conventional corners', () => {
    expect(inQuadrant(q(0), -1, -1)).toBe(true);
    expect(inQuadrant(q(1), 1, -1)).toBe(true);
    expect(inQuadrant(q(2), 1, 1)).toBe(true);
    expect(inQuadrant(q(3), -1, 1)).toBe(true);
  });
});

describe('inRange', () => {
  const g: RangeGate = { ...base, id: 'r', name: 'r', kind: 'range', xParam: 0, min: 2, max: 8 };
  it('is inclusive of both ends', () => {
    expect(inRange(g, 2)).toBe(true);
    expect(inRange(g, 8)).toBe(true);
    expect(inRange(g, 1.99)).toBe(false);
    expect(inRange(g, 8.01)).toBe(false);
  });
});

describe('editing helpers', () => {
  it('normaliseRect fixes a drag that crossed itself', () => {
    const g = normaliseRect(rect('r', 10, 0, 8, 2));
    expect([g.xMin, g.xMax, g.yMin, g.yMax]).toEqual([0, 10, 2, 8]);
  });

  it('translateGate moves every kind consistently', () => {
    const r = translateGate(rect('r', 0, 10, 0, 10), 5, -3);
    expect([r.xMin, r.xMax, r.yMin, r.yMax]).toEqual([5, 15, -3, 7]);

    const p: PolygonGate = { ...base, id: 'p', name: 'p', kind: 'polygon', xParam: 0, yParam: 1, vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] };
    expect(translateGate(p, 2, 2).vertices[0]).toEqual({ x: 2, y: 2 });

    const e: EllipseGate = { ...base, id: 'e', name: 'e', kind: 'ellipse', xParam: 0, yParam: 1, cx: 0, cy: 0, rx: 1, ry: 1, angle: 0 };
    expect(translateGate(e, 3, 4).cx).toBe(3);
  });

  it('boundsOf covers a rotated ellipse', () => {
    const e: EllipseGate = { ...base, id: 'e', name: 'e', kind: 'ellipse', xParam: 0, yParam: 1, cx: 0, cy: 0, rx: 10, ry: 2, angle: Math.PI / 2 };
    const b = boundsOf(e);
    expect(b.xMax).toBeCloseTo(2, 6);
    expect(b.yMax).toBeCloseTo(10, 6);
  });

  it('simplifyPolygon removes near-duplicate freehand vertices', () => {
    const dense: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 100; i++) dense.push({ x: i * 0.01, y: 0 });
    dense.push({ x: 1, y: 1 }, { x: 0, y: 1 });
    const simple = simplifyPolygon(dense, 0.1);
    expect(simple.length).toBeLessThan(dense.length);
    expect(simple.length).toBeGreaterThanOrEqual(3);
  });

  it('simplifyPolygon never destroys a triangle', () => {
    const tri = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(simplifyPolygon(tri, 100)).toHaveLength(3);
  });

  it('polygonArea sign reflects winding', () => {
    const ccw = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(Math.abs(polygonArea(ccw))).toBeCloseTo(1, 10);
    expect(polygonArea([...ccw].reverse())).toBeCloseTo(-polygonArea(ccw), 10);
  });

  it('ellipseFromDrag centres on the drag box', () => {
    const e = ellipseFromDrag(
      { ...base, id: 'e', name: 'e', kind: 'ellipse', xParam: 0, yParam: 1 },
      0, 0, 10, 4,
    );
    expect([e.cx, e.cy, e.rx, e.ry]).toEqual([5, 2, 5, 2]);
  });

  it('contains dispatches every geometric kind', () => {
    expect(contains(rect('r', 0, 1, 0, 1), 0.5, 0.5)).toBe(true);
    const p: PolygonGate = { ...base, id: 'p', name: 'p', kind: 'polygon', xParam: 0, yParam: 1, vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] };
    expect(contains(p, 0.5, 0.5)).toBe(true);
  });
});

/* ==========================================================================
   Display spaces         (2026-08-03, Item 17)

   A gate's coordinates are display-space numbers, and display space is a
   function of the transform. Until this pass nothing on a gate said which
   transform, so the panel evaluated it in one space and the tree, the
   statistics table and the export evaluated it in another — one gate, two
   sizes. `xSpec`/`ySpec` name the space; `reprojectGate` moves a gate into a
   different one so a panel showing it under another transform draws it where
   its events actually are.
   ========================================================================== */

const LOG: TransformSpec = { kind: 'log', range: 262144, decades: 4.5 };
const LIN: TransformSpec = { kind: 'linear', range: 262144 };

describe('sameSpace', () => {
  it('compares the fields that decide the mapping', () => {
    expect(sameSpace(LOG, { ...LOG })).toBe(true);
    expect(sameSpace(LOG, { ...LOG, decades: 4 })).toBe(false);
    expect(sameSpace(LOG, LIN)).toBe(false);
  });
  it('treats an unknown space as matching nothing but another unknown', () => {
    expect(sameSpace(undefined, undefined)).toBe(true);
    expect(sameSpace(LOG, undefined)).toBe(false);
  });
});

describe('reprojectGate', () => {
  const log = createTransform(LOG);
  const lin = createTransform(LIN);

  it('leaves a gate alone when the spaces already match', () => {
    const g = { ...rect('r', 1, 2, 1, 2), xSpec: LOG, ySpec: LOG };
    // Identity, not merely equality: the common case must allocate nothing.
    expect(reprojectGate(g, LOG, LOG)).toBe(g);
  });

  it('leaves a gate alone when it does not say what space it is in', () => {
    // A gate drawn before this field existed is evaluated against the panel's
    // own fallback, so its coordinates are already in the space being drawn.
    const g = rect('r', 1, 2, 1, 2);
    expect(reprojectGate(g, LOG, LOG)).toBe(g);
  });

  it('moves a rectangle through raw into the target space', () => {
    const g = { ...rect('r', 1, 2, 1, 2), xSpec: LOG, ySpec: LOG };
    const out = reprojectGate(g, LIN, LIN);
    // Display 1 and 2 in the log space are these raw channel values.
    expect(out.xMin).toBeCloseTo(log.inverse(1), 6);
    expect(out.xMax).toBeCloseTo(log.inverse(2), 6);
    expect(out.yMin).toBeCloseTo(log.inverse(1), 6);
  });

  it('round-trips', () => {
    const g = { ...rect('r', 1.5, 3.25, 0.5, 4, null), xSpec: LOG, ySpec: LOG };
    const there = reprojectGate(g, LIN, LIN);
    const back = reprojectGate({ ...there, xSpec: LIN, ySpec: LIN }, LOG, LOG);
    expect(back.xMin).toBeCloseTo(g.xMin, 5);
    expect(back.xMax).toBeCloseTo(g.xMax, 5);
    expect(back.yMax).toBeCloseTo(g.yMax, 5);
  });

  it('converts one axis when only one differs', () => {
    const g = { ...rect('r', 1, 2, 1, 2), xSpec: LOG, ySpec: LIN };
    const out = reprojectGate(g, LIN, LIN);
    expect(out.xMin).toBeCloseTo(log.inverse(1), 6);
    expect(out.yMin).toBe(1);
  });

  it('handles every gate kind', () => {
    const at = (v: number) => lin.forward(log.inverse(v));

    const poly: PolygonGate = {
      ...base, id: 'p', name: 'p', kind: 'polygon', xParam: 0, yParam: 1,
      xSpec: LOG, ySpec: LOG,
      vertices: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    };
    expect(reprojectGate(poly, LIN, LIN).vertices[1]!.x).toBeCloseTo(at(2), 6);

    const quad: QuadrantGate = {
      ...base, id: 'q', name: 'q', kind: 'quadrant', xParam: 0, yParam: 1,
      xSpec: LOG, ySpec: LOG, xSplit: 2, ySplit: 3, quadrant: 2,
    };
    const q = reprojectGate(quad, LIN, LIN);
    expect(q.xSplit).toBeCloseTo(at(2), 6);
    expect(q.ySplit).toBeCloseTo(at(3), 6);

    const range: RangeGate = {
      ...base, id: 'n', name: 'n', kind: 'range', xParam: 0, xSpec: LOG, min: 1, max: 3,
    };
    const r = reprojectGate(range, LIN, LIN);
    expect(r.min).toBeCloseTo(at(1), 6);
    expect(r.max).toBeCloseTo(at(3), 6);

    // An ellipse's radii are approximated by mapping the axis-aligned extremes,
    // because a monotonic transform is not affine and a circle in one space is
    // not a circle in another. The centre must still land between them.
    const ell: EllipseGate = {
      ...base, id: 'e', name: 'e', kind: 'ellipse', xParam: 0, yParam: 1,
      xSpec: LOG, ySpec: LOG, cx: 2, cy: 2, rx: 0.5, ry: 0.5, angle: 0,
    };
    const el = reprojectGate(ell, LIN, LIN);
    expect(el.cx - el.rx).toBeCloseTo(at(1.5), 6);
    expect(el.cx + el.rx).toBeCloseTo(at(2.5), 6);
    expect(el.rx).toBeGreaterThan(0);
  });
});

/* ==========================================================================
   Tree
   ========================================================================== */

/** Events on a 10×10 integer grid, so counts are easy to reason about. */
function gridContext(): { ctx: GateContext; n: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) { xs.push(x); ys.push(y); }
  const cols = [Float32Array.from(xs), Float32Array.from(ys)];
  return {
    n: xs.length,
    ctx: {
      eventCount: xs.length,
      // Keyed by gate and axis since 2026-08-03: a gate's coordinates are in a
      // display space of its own naming, not in "the" space of its parameter.
      columnFor: (g, axis) => cols[axis === 'x' || g.kind === 'range' ? g.xParam : g.yParam]!,
    },
  };
}

describe('evaluateGates', () => {
  const { ctx, n } = gridContext();

  it('counts a simple gate and reports both percentages', () => {
    // x in [0,4], y in [0,4] -> 5×5 = 25 of 100.
    const gates: Gate[] = [rect('a', 0, 4, 0, 4)];
    const { stats } = evaluateGates(gates, ctx);
    const s = stats.get('a')!;
    expect(s.count).toBe(25);
    expect(s.totalCount).toBe(n);
    expect(s.percentOfTotal).toBeCloseTo(25, 6);
    expect(s.percentOfParent).toBeCloseTo(25, 6);
  });

  it('intersects a child with its parent', () => {
    const gates: Gate[] = [
      rect('parent', 0, 4, 0, 9),        // 5×10 = 50
      rect('child', 0, 9, 0, 4, 'parent'), // 10×5 = 50, overlap = 25
    ];
    const { stats } = evaluateGates(gates, ctx);
    expect(stats.get('parent')!.count).toBe(50);
    const c = stats.get('child')!;
    expect(c.count).toBe(25);
    expect(c.parentCount).toBe(50);
    expect(c.percentOfParent).toBeCloseTo(50, 6);
    expect(c.percentOfTotal).toBeCloseTo(25, 6);
  });

  it('evaluates a three-level hierarchy correctly', () => {
    const gates: Gate[] = [
      rect('l1', 0, 8, 0, 9),
      rect('l2', 0, 5, 0, 9, 'l1'),
      rect('l3', 0, 5, 0, 3, 'l2'),
    ];
    const { stats } = evaluateGates(gates, ctx);
    expect(stats.get('l1')!.count).toBe(9 * 10);
    expect(stats.get('l2')!.count).toBe(6 * 10);
    expect(stats.get('l3')!.count).toBe(6 * 4);
    expect(stats.get('l3')!.percentOfParent).toBeCloseTo((24 / 60) * 100, 6);
  });

  it('a child can never exceed its parent', () => {
    const gates: Gate[] = [
      rect('parent', 0, 2, 0, 2),
      rect('child', 0, 9, 0, 9, 'parent'), // geometrically everything
    ];
    const { stats } = evaluateGates(gates, ctx);
    expect(stats.get('child')!.count).toBe(stats.get('parent')!.count);
    expect(stats.get('child')!.percentOfParent).toBeCloseTo(100, 6);
  });

  it('provides a root population of every event', () => {
    const { stats, masks } = evaluateGates([], ctx);
    expect(stats.get(ROOT_ID)!.count).toBe(n);
    expect(masks.get(ROOT_ID)!.every((v) => v === 1)).toBe(true);
  });

  // Boolean AND/OR/NOT gates were removed: every population they could express
  // can be drawn directly, and they were the only gate kind with no axes, no
  // geometry and an operand list that deletion had to garbage-collect. What
  // replaces the AND case is a nested gate, which is what a hierarchy is for.
  it('expresses an intersection as nesting, which is what the tree already is', () => {
    const gates: Gate[] = [
      rect('a', 0, 4, 0, 9),          // 50
      rect('b', 0, 9, 0, 4, 'a'),     // 50 on its own; 25 inside a
    ];
    const { stats } = evaluateGates(gates, ctx);
    expect(stats.get('a')!.count).toBe(50);
    expect(stats.get('b')!.count).toBe(25);
  });

  it('has no gate kind without axes left to fail on', () => {
    // The `operands are missing` error path went with the boolean gate. Any
    // remaining kind evaluates from its own geometry and cannot depend on
    // another gate having been evaluated first.
    const gates: Gate[] = [rect('a', 0, 4, 0, 9)];
    const { errors } = evaluateGates(gates, ctx);
    expect(errors.size).toBe(0);
  });

  it('quadrants partition the parent exactly', () => {
    const gates: Gate[] = ([0, 1, 2, 3] as const).map((q) => ({
      ...base, id: `q${q}`, name: `q${q}`, kind: 'quadrant' as const,
      xParam: 0, yParam: 1, xSplit: 4.5, ySplit: 4.5, quadrant: q,
    }));
    const { stats } = evaluateGates(gates, ctx);
    const total = ([0, 1, 2, 3] as const).reduce<number>((a, q) => a + stats.get(`q${q}`)!.count, 0);
    expect(total).toBe(n);
  });

  it('handles a dangling parent by treating the gate as a root child', () => {
    const gates: Gate[] = [rect('orphan', 0, 4, 0, 4, 'missing')];
    const { stats } = evaluateGates(gates, ctx);
    expect(stats.get('orphan')!.count).toBe(25);
  });

  it('handles zero events without dividing by zero', () => {
    const empty: GateContext = { eventCount: 0, columnFor: () => new Float32Array(0) };
    const { stats } = evaluateGates([rect('a', 0, 1, 0, 1)], empty);
    expect(stats.get('a')!.count).toBe(0);
    expect(stats.get('a')!.percentOfParent).toBe(0);
    expect(Number.isNaN(stats.get('a')!.percentOfTotal)).toBe(false);
  });
});

describe('tree navigation', () => {
  const gates: Gate[] = [
    rect('lymph', 0, 9, 0, 9),
    rect('cd3', 0, 5, 0, 9, 'lymph'),
    rect('cd4', 0, 5, 0, 4, 'cd3'),
    rect('cd8', 0, 5, 5, 9, 'cd3'),
  ];

  it('childrenOf finds direct children only', () => {
    expect(childrenOf(gates, 'cd3').map((g) => g.id)).toEqual(['cd4', 'cd8']);
    expect(childrenOf(gates, null).map((g) => g.id)).toEqual(['lymph']);
  });

  it('ancestorsOf returns the root-first path', () => {
    expect(ancestorsOf(gates, 'cd4').map((g) => g.id)).toEqual(['lymph', 'cd3']);
    expect(ancestorsOf(gates, 'lymph')).toEqual([]);
  });

  it('populationPath builds the slash-separated identity used by exports', () => {
    expect(populationPath(gates, 'cd4')).toBe('lymph/cd3/cd4');
    expect(populationPath(gates, 'lymph')).toBe('lymph');
    expect(populationPath(gates, 'nope')).toBe('');
  });

  it('subtreeOf includes the gate and every descendant', () => {
    expect(subtreeOf(gates, 'cd3').map((g) => g.id).sort()).toEqual(['cd3', 'cd4', 'cd8']);
  });

  it('flattenTree returns the rows in the order the sidebar draws them', () => {
    // Depth-first through `childrenOf`, which is the recursion `GateBranch`
    // renders with — a Shift-range and an arrow key both measure over this, so
    // it has to be what the eye sees rather than what evaluation wants.
    expect(flattenTree(gates).map((g) => g.id)).toEqual(['lymph', 'cd3', 'cd4', 'cd8']);
  });

  it('flattenTree is not topoOrder — a shuffled array still draws in tree order', () => {
    // `topoOrder` walks the array and pulls ancestors forward, so its answer
    // depends on the array's order; the sidebar's does not.
    const shuffled = [gates[2]!, gates[0]!, gates[3]!, gates[1]!];
    expect(flattenTree(shuffled).map((g) => g.id)).toEqual(['lymph', 'cd3', 'cd4', 'cd8']);
  });

  it('flattenTree survives a cycle rather than overflowing the stack', () => {
    // A hand-edited workspace can hold one; `topoOrder` guards against the same
    // thing for the same reason.
    const cyclic: Gate[] = [rect('a', 0, 1, 0, 1, 'b'), rect('b', 0, 1, 0, 1, 'a')];
    expect(flattenTree(cyclic)).toEqual([]);
    const reachable: Gate[] = [rect('top', 0, 1, 0, 1), ...cyclic];
    expect(flattenTree(reachable).map((g) => g.id)).toEqual(['top']);
  });

  it('flattenTree does not restart at the root for a gate with no id', () => {
    // The shape that is not a cycle and recurses just as hard: a child of a
    // parent with no id resolves back to the root and starts the walk again.
    const broken = [
      { ...rect('a', 0, 1, 0, 1), id: undefined as unknown as string },
      rect('b', 0, 1, 0, 1),
    ];
    expect(flattenTree(broken).map((g) => g.name)).toEqual(['b']);
  });

  it('flattenTree omits a gate whose parent is missing, as the sidebar does', () => {
    // `topoOrder` lifts a dangling child to the root so evaluation never loses a
    // population. A range must not cover a row nobody can see.
    const orphaned: Gate[] = [...gates, rect('ghost', 0, 1, 0, 1, 'gone')];
    expect(flattenTree(orphaned).map((g) => g.id)).not.toContain('ghost');
    expect(topoOrder(orphaned).map((g) => g.id)).toContain('ghost');
  });

  it('topoOrder places every parent before its children', () => {
    const order = topoOrder([...gates].reverse()).map((g) => g.id);
    expect(order.indexOf('lymph')).toBeLessThan(order.indexOf('cd3'));
    expect(order.indexOf('cd3')).toBeLessThan(order.indexOf('cd4'));
  });

  it('topoOrder survives a cyclic parent link', () => {
    const cyclic: Gate[] = [rect('a', 0, 1, 0, 1, 'b'), rect('b', 0, 1, 0, 1, 'a')];
    expect(topoOrder(cyclic)).toHaveLength(2);
  });

  it('wouldCycle blocks reparenting a gate under its own descendant', () => {
    expect(wouldCycle(gates, 'cd3', 'cd4')).toBe(true);
    expect(wouldCycle(gates, 'cd3', 'cd3')).toBe(true);
    expect(wouldCycle(gates, 'cd4', 'lymph')).toBe(false);
    expect(wouldCycle(gates, 'cd4', null)).toBe(false);
  });
});

describe('maskToIndices', () => {
  it('lists the set positions', () => {
    expect(Array.from(maskToIndices(Uint8Array.from([0, 1, 1, 0, 1])))).toEqual([1, 2, 4]);
  });
  it('returns empty for an empty population', () => {
    expect(maskToIndices(Uint8Array.from([0, 0])).length).toBe(0);
  });
});

describe('cloneStrategy', () => {
  const gates: Gate[] = [
    rect('a', 0, 1, 0, 1),
    rect('b', 0, 1, 0, 1, 'a'),
    rect('c', 0, 1, 0, 1, 'b'),
  ];

  it('regenerates ids and rewrites parent links', () => {
    const copy = cloneStrategy(gates, (old) => `${old}-copy`);
    expect(copy.map((g) => g.id)).toEqual(['a-copy', 'b-copy', 'c-copy']);
    expect(copy[1]!.parentId).toBe('a-copy');
    expect(copy[2]!.parentId).toBe('b-copy');
  });

  it('leaves a clone with no reference back into the original', () => {
    const copy = cloneStrategy(gates, (old) => `${old}-copy`);
    const originalIds = new Set(gates.map((g) => g.id));
    expect(copy.some((g) => g.parentId !== null && originalIds.has(g.parentId))).toBe(false);
  });

  it('produces a hierarchy that evaluates identically', () => {
    const { ctx } = gridContext();
    const original = evaluateGates(gates, ctx);
    const copy = cloneStrategy(gates, (old) => `${old}-copy`);
    const copied = evaluateGates(copy, ctx);
    expect(copied.stats.get('b-copy')!.count).toBe(original.stats.get('b')!.count);
    expect(copied.stats.get('c-copy')!.count).toBe(original.stats.get('c')!.count);
  });
});

/* ==========================================================================
   Bounding-box resize for polygons.

   The coarse counterpart to per-vertex dragging: one gesture to grow a
   ten-vertex gate instead of ten. The convention is the rectangle's — drag a
   corner and the opposite corner stays put — because two shapes showing the same
   handles must not resize by different rules.
   ========================================================================== */

describe('scalePolygon', () => {
  /** A right triangle from (0,0) to (10,10), so every claim is checkable by eye. */
  const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];

  const bounds = (vs: Array<{ x: number; y: number }>) => ({
    xMin: Math.min(...vs.map((v) => v.x)),
    xMax: Math.max(...vs.map((v) => v.x)),
    yMin: Math.min(...vs.map((v) => v.y)),
    yMax: Math.max(...vs.map((v) => v.y)),
  });

  it('grows from the opposite corner, exactly as a rectangle gate does', () => {
    // Screen `ne` is the top-right: larger x, and larger y in data space. The
    // anchor is therefore the bottom-left, which must not move at all.
    const out = scalePolygon(tri, 'ne', 5, 5);
    const b = bounds(out);
    expect(b.xMin).toBeCloseTo(0, 9);
    expect(b.yMin).toBeCloseTo(0, 9);
    expect(b.xMax).toBeCloseTo(15, 9);
    expect(b.yMax).toBeCloseTo(15, 9);
  });

  it('anchors the far edge when the near one is dragged', () => {
    // `sw` moves xMin and yMin, so (xMax, yMax) is pinned.
    const out = scalePolygon(tri, 'sw', 4, 4);
    const b = bounds(out);
    expect(b.xMax).toBeCloseTo(10, 9);
    expect(b.yMax).toBeCloseTo(10, 9);
    expect(b.xMin).toBeCloseTo(4, 9);
    expect(b.yMin).toBeCloseTo(4, 9);
  });

  it('keeps the shape — every vertex moves together, in proportion', () => {
    // What distinguishes this from dragging a vertex. The triangle stays a
    // triangle with the same interior angles; only its extent changes.
    const out = scalePolygon(tri, 'ne', 10, 10);
    expect(out).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }]);
    // Area scales with the product of the two factors, as a similarity transform
    // must.
    expect(polygonArea(out)).toBeCloseTo(polygonArea(tri) * 4, 6);
  });

  it('moves one axis only, for an edge-midpoint handle', () => {
    const out = scalePolygon(tri, 'e', 10, 999);
    const b = bounds(out);
    expect(b.xMax).toBeCloseTo(20, 9);
    // The vertical delta is ignored: `e` is an x-only handle, and the pointer's
    // y wander during a horizontal drag must not squash the gate.
    expect(b.yMin).toBeCloseTo(0, 9);
    expect(b.yMax).toBeCloseTo(10, 9);
  });

  it('refuses to collapse or mirror when dragged past the anchor', () => {
    // Both failure modes of the naive form. A negative factor would flip the
    // shape — surprising, and not what a resize handle means — and a zero factor
    // would make every vertex identical, from which no further drag could recover
    // it because a degenerate polygon has no extent to scale.
    const out = scalePolygon(tri, 'ne', -40, -40);
    const b = bounds(out);
    expect(b.xMax).toBeGreaterThan(b.xMin);
    expect(b.yMax).toBeGreaterThan(b.yMin);
    // `polygonArea` is signed — it carries the winding — so the claim is that the
    // shape still encloses something, not that the number is positive.
    expect(Math.abs(polygonArea(out))).toBeGreaterThan(0);
    // And the winding is unchanged, which is the "no mirror" half of it.
    expect(Math.sign(polygonArea(out))).toBe(Math.sign(polygonArea(tri)));
  });

  it('is measured from the geometry passed in, so dragging back restores it', () => {
    // `applyGateDrag` always passes the gesture's *original* vertices, which is
    // what makes this true and what makes the clamp above recoverable.
    const grown = scalePolygon(tri, 'ne', 10, 10);
    expect(scalePolygon(tri, 'ne', 0, 0)).toEqual(tri);
    expect(grown).not.toEqual(tri);
  });

  it('survives a degenerate polygon rather than producing NaN', () => {
    // A zero-width polygon has no span to divide by. Every gate this can reach
    // has at least three vertices, but a vertical line of them is reachable by
    // dragging vertices onto each other first.
    const line = [{ x: 5, y: 0 }, { x: 5, y: 10 }, { x: 5, y: 5 }];
    for (const v of scalePolygon(line, 'ne', 3, 3)) {
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
    }
    expect(scalePolygon([], 'ne', 1, 1)).toEqual([]);
  });
});
