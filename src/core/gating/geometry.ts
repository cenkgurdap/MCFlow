import { createTransform, type TransformSpec } from '../transform';
import type { EllipseGate, Gate, GeometricGate, Point, QuadrantGate, RangeGate, RectangleGate } from './types';

/* ==========================================================================
   Point-in-shape tests.

   These run once per event per gate — 170 000 × 14 gates is 2.4M calls — so
   they are written as flat numeric functions with no allocation, and the
   polygon test precomputes nothing per call.
   ========================================================================== */

export function inRectangle(g: RectangleGate, x: number, y: number): boolean {
  return x >= g.xMin && x <= g.xMax && y >= g.yMin && y <= g.yMax;
}

/**
 * Crossing-number test.
 *
 * The `(yi > y) !== (yj > y)` form counts a vertex exactly once, so an event
 * lying precisely on a horizontal edge does not get double-counted and flip to
 * "outside" — which matters because gates are routinely drawn against an axis
 * where many events share a coordinate.
 */
export function inPolygon(vertices: Point[], x: number, y: number): boolean {
  const n = vertices.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = vertices[i]!;
    const vj = vertices[j]!;
    if ((vi.y > y) !== (vj.y > y)) {
      const t = (vj.x - vi.x) * (y - vi.y) / (vj.y - vi.y) + vi.x;
      if (x < t) inside = !inside;
    }
  }
  return inside;
}

export function inEllipse(g: EllipseGate, x: number, y: number): boolean {
  const dx = x - g.cx;
  const dy = y - g.cy;
  if (g.rx <= 0 || g.ry <= 0) return false;
  // Rotate the point into the ellipse's own frame rather than rotating the
  // ellipse — one sin/cos pair per call, no matrix.
  const cos = Math.cos(-g.angle);
  const sin = Math.sin(-g.angle);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return (rx * rx) / (g.rx * g.rx) + (ry * ry) / (g.ry * g.ry) <= 1;
}

export function inQuadrant(g: QuadrantGate, x: number, y: number): boolean {
  const right = x >= g.xSplit;
  const upper = y >= g.ySplit;
  switch (g.quadrant) {
    case 0: return !right && !upper;
    case 1: return right && !upper;
    case 2: return right && upper;
    case 3: return !right && upper;
  }
}

export function inRange(g: RangeGate, x: number): boolean {
  return x >= g.min && x <= g.max;
}

/** Dispatch for any 2D gate. */
export function contains(g: GeometricGate, x: number, y: number): boolean {
  switch (g.kind) {
    case 'rectangle': return inRectangle(g, x, y);
    case 'polygon': return inPolygon(g.vertices, x, y);
    case 'ellipse': return inEllipse(g, x, y);
    case 'quadrant': return inQuadrant(g, x, y);
  }
}

/* ==========================================================================
   Moving a gate between display spaces
   ========================================================================== */

/** True when two specs describe the same display space. */
export function sameSpace(a: TransformSpec | undefined, b: TransformSpec | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.range === b.range && a.decades === b.decades
    && a.width === b.width && a.negativeDecades === b.negativeDecades
    && a.cofactor === b.cofactor;
}

/** One coordinate from one display space into another, through raw. */
function convert(v: number, from: TransformSpec, to: TransformSpec): number {
  return createTransform(to).forward(createTransform(from).inverse(v));
}

/**
 * Express a gate's coordinates in a different display space.
 *
 * A gate's boundary is a set of *raw* channel values wearing whichever
 * transform's clothes it was drawn in. A panel showing the same parameter under
 * a different transform has to put the shape where those raw values now land, or
 * the box on screen sits somewhere other than the events it selects — which is
 * exactly the failure Item 17 was about, seen rather than counted.
 *
 * Pass `undefined` for a space to mean "unknown", in which case that axis is
 * left alone: a gate with no recorded spec is evaluated against the panel's own
 * fallback, so its coordinates are already in the space being drawn.
 *
 * **An ellipse's radii are approximated.** A transform is monotonic but not
 * affine, so a circle in one space is not a circle in another; the semi-axes are
 * converted by mapping the axis-aligned extremes and re-centring, which is exact
 * for a linear pair and a close approximation otherwise. The alternative —
 * refusing to draw it — is worse, and the case only arises when a panel is
 * showing a gate under a transform it was not drawn on.
 */
export function reprojectGate<G extends Gate>(
  gate: G,
  toX: TransformSpec | undefined,
  toY: TransformSpec | undefined,
): G {
  const fx = gate.xSpec && toX && !sameSpace(gate.xSpec, toX) ? gate.xSpec : null;
  const fy = gate.ySpec && toY && !sameSpace(gate.ySpec, toY) ? gate.ySpec : null;
  if (!fx && !fy) return gate;

  const cx = (v: number) => (fx ? convert(v, fx, toX!) : v);
  const cy = (v: number) => (fy ? convert(v, fy, toY!) : v);

  switch (gate.kind) {
    case 'range':
      return { ...gate, min: cx(gate.min), max: cx(gate.max) };
    case 'rectangle':
      return { ...gate, xMin: cx(gate.xMin), xMax: cx(gate.xMax), yMin: cy(gate.yMin), yMax: cy(gate.yMax) };
    case 'polygon':
      return { ...gate, vertices: gate.vertices.map((v) => ({ x: cx(v.x), y: cy(v.y) })) };
    case 'quadrant':
      return { ...gate, xSplit: cx(gate.xSplit), ySplit: cy(gate.ySplit) };
    case 'ellipse': {
      const x0 = cx(gate.cx - gate.rx), x1 = cx(gate.cx + gate.rx);
      const y0 = cy(gate.cy - gate.ry), y1 = cy(gate.cy + gate.ry);
      return {
        ...gate,
        cx: (x0 + x1) / 2, rx: Math.abs(x1 - x0) / 2,
        cy: (y0 + y1) / 2, ry: Math.abs(y1 - y0) / 2,
      };
    }
  }
}

/* ==========================================================================
   Editing helpers
   ========================================================================== */

/** Axis-aligned bounds, used for hit-testing and for framing a gate. */
export function boundsOf(g: GeometricGate): { xMin: number; xMax: number; yMin: number; yMax: number } {
  switch (g.kind) {
    case 'rectangle':
      return { xMin: g.xMin, xMax: g.xMax, yMin: g.yMin, yMax: g.yMax };
    case 'polygon': {
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
      for (const v of g.vertices) {
        if (v.x < xMin) xMin = v.x;
        if (v.x > xMax) xMax = v.x;
        if (v.y < yMin) yMin = v.y;
        if (v.y > yMax) yMax = v.y;
      }
      return { xMin, xMax, yMin, yMax };
    }
    case 'ellipse': {
      // Bounding box of a rotated ellipse.
      const cos = Math.cos(g.angle);
      const sin = Math.sin(g.angle);
      const ex = Math.sqrt(g.rx * g.rx * cos * cos + g.ry * g.ry * sin * sin);
      const ey = Math.sqrt(g.rx * g.rx * sin * sin + g.ry * g.ry * cos * cos);
      return { xMin: g.cx - ex, xMax: g.cx + ex, yMin: g.cy - ey, yMax: g.cy + ey };
    }
    case 'quadrant':
      return { xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity };
  }
}

/** Translate a gate by a display-space delta. */
export function translateGate<G extends GeometricGate>(g: G, dx: number, dy: number): G {
  switch (g.kind) {
    case 'rectangle':
      return { ...g, xMin: g.xMin + dx, xMax: g.xMax + dx, yMin: g.yMin + dy, yMax: g.yMax + dy };
    case 'polygon':
      return { ...g, vertices: g.vertices.map((v) => ({ x: v.x + dx, y: v.y + dy })) };
    case 'ellipse':
      return { ...g, cx: g.cx + dx, cy: g.cy + dy };
    case 'quadrant':
      return { ...g, xSplit: g.xSplit + dx, ySplit: g.ySplit + dy };
  }
}

/**
 * Scale a polygon by dragging one handle of its bounding box.
 *
 * Coarse resizing, alongside the per-vertex drag that already existed. Moving a
 * ten-vertex gate out a little used to be ten gestures; this is one.
 *
 * `handle` is a compass direction — `nw`, `ne`, `se`, `sw`, `n`, `e`, `s`, `w` —
 * naming the corner or edge being dragged, and the **opposite** corner or edge
 * stays put. That is the rectangle gate's convention (drag `nw`, `se` does not
 * move), and matching it is the point: two shapes that show the same handles
 * should not resize by different rules.
 *
 * One asymmetry is worth stating: `n` is the *screen* top, which is the **larger**
 * y in data space, because a plot's y axis runs up and a screen's runs down. The
 * flip is here rather than in the caller so there is one place it can be wrong.
 *
 * Scale factors are clamped to a small positive minimum. A drag past the anchor
 * would otherwise mirror the shape — surprising — or collapse it to a point, from
 * which the *next* frame of the same drag could not recover it, since a degenerate
 * polygon has no extent to scale. Deltas are always measured from the gesture's
 * original geometry, so dragging back restores it exactly.
 */
const MIN_SCALE = 0.02;

export function scalePolygon(
  vertices: Point[],
  handle: string,
  dx: number,
  dy: number,
): Point[] {
  if (vertices.length === 0) return vertices;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const v of vertices) {
    if (v.x < xMin) xMin = v.x;
    if (v.x > xMax) xMax = v.x;
    if (v.y < yMin) yMin = v.y;
    if (v.y > yMax) yMax = v.y;
  }
  const spanX = xMax - xMin;
  const spanY = yMax - yMin;

  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  // The anchor is the edge the drag is *not* on; when an axis is not being
  // dragged at all its scale is 1 and the anchor on that axis is irrelevant.
  const ax = west ? xMax : xMin;
  const ay = north ? yMin : yMax;

  const sx = !west && !east ? 1
    : spanX > 0 ? Math.max(MIN_SCALE, (spanX + (east ? dx : -dx)) / spanX)
      : 1;
  const sy = !north && !south ? 1
    : spanY > 0 ? Math.max(MIN_SCALE, (spanY + (north ? dy : -dy)) / spanY)
      : 1;

  return vertices.map((v) => ({
    x: ax + (v.x - ax) * sx,
    y: ay + (v.y - ay) * sy,
  }));
}

/** Normalise a rectangle so min < max after a drag that crossed itself. */
export function normaliseRect(g: RectangleGate): RectangleGate {
  return {
    ...g,
    xMin: Math.min(g.xMin, g.xMax),
    xMax: Math.max(g.xMin, g.xMax),
    yMin: Math.min(g.yMin, g.yMax),
    yMax: Math.max(g.yMin, g.yMax),
  };
}

/**
 * Drop vertices that are within `epsilon` of their neighbour.
 *
 * Freehand polygon drawing generates a vertex per pointer event, which at 60 Hz
 * is hundreds of near-duplicate points; each one costs a crossing test per
 * event forever after.
 */
export function simplifyPolygon(vertices: Point[], epsilon: number): Point[] {
  if (vertices.length <= 3) return vertices;
  const out: Point[] = [vertices[0]!];
  for (let i = 1; i < vertices.length; i++) {
    const prev = out[out.length - 1]!;
    const v = vertices[i]!;
    if (Math.hypot(v.x - prev.x, v.y - prev.y) >= epsilon) out.push(v);
  }
  // Also collapse a closing vertex that landed on the start point.
  if (out.length > 3) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(last.x - first.x, last.y - first.y) < epsilon) out.pop();
  }
  return out.length >= 3 ? out : vertices;
}

/** Signed area × 2. Negative means clockwise winding. */
export function polygonArea(vertices: Point[]): number {
  let a = 0;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    a += (vertices[j]!.x + vertices[i]!.x) * (vertices[j]!.y - vertices[i]!.y);
  }
  return a / 2;
}

/** The four gates a quadrant split defines, in display order. */
export const QUADRANT_LABELS = ['Q3 (−,−)', 'Q4 (+,−)', 'Q2 (+,+)', 'Q1 (−,+)'] as const;

/** Fit an ellipse to a drag rectangle. */
export function ellipseFromDrag(
  base: Omit<EllipseGate, 'cx' | 'cy' | 'rx' | 'ry' | 'angle'>,
  x0: number, y0: number, x1: number, y1: number,
): EllipseGate {
  return {
    ...base,
    cx: (x0 + x1) / 2,
    cy: (y0 + y1) / 2,
    rx: Math.abs(x1 - x0) / 2,
    ry: Math.abs(y1 - y0) / 2,
    angle: 0,
  };
}
