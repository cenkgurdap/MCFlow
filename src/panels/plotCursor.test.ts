import { beforeEach, describe, expect, it } from 'vitest';
import { CLOSE_CURSOR, CLOSE_SNAP_PX, gateHandleCursor, isNearPolygonClose, plotCursor } from './plotCursor';
import { useGates } from '@/state/gateStore';
import type { Gate } from '@/core/gating/types';

/* ==========================================================================
   The cursor is the only continuous signal telling a user what a click will
   do, and gate finalisation is the click itself. Both decisions live in pure
   functions precisely so they can be pinned down here rather than only being
   verifiable by eye.
   ========================================================================== */

describe('plotCursor', () => {
  it('is a crosshair for every gate-drawing tool, not just mid-drag', () => {
    for (const gateTool of ['rectangle', 'polygon', 'ellipse', 'quadrant', 'range'] as const) {
      expect(plotCursor({ gateTool })).toBe('crosshair');
    }
  });

  it('is grab at rest, because a drag on the plot moves the panel', () => {
    // Reversed, and the history is worth keeping straight. It was `grab` while
    // there was a pan; `default` once the pan and then the zoom were removed,
    // because a cursor promising a gesture the surface does not perform is worse
    // than none. The surface performs one again — a drag on the plot background
    // with no tool armed moves the whole panel — so the promise is true and the
    // cursor makes it. What it must never be again is a promise of a *view*
    // gesture, which is why the assertion below still stands.
    expect(plotCursor({ gateTool: 'none' })).toBe('grab');
    expect(plotCursor({ gateTool: 'none', panelMoving: true })).toBe('grabbing');
  });

  it('has no view tool left to arm', () => {
    // The whole `viewTool` input is gone with zoom. This is the assertion that
    // would have to be deleted to bring it back, which is the point of it.
    expect(Object.keys(plotCursor({ gateTool: 'none' }))).not.toContain('boxzoom');
    expect(plotCursor({ gateTool: 'none' })).not.toBe('crosshair');
  });

  it('lets an armed tool win over the panel-move cursor', () => {
    // A drawing tool claims the data rectangle, so the crosshair has to survive
    // even mid-move — otherwise the cursor would say "moving" while the next
    // press draws.
    expect(plotCursor({ gateTool: 'rectangle', panelMoving: true })).toBe('crosshair');
  });

  it('uses a distinct cursor over the polygon close target', () => {
    const overClose = plotCursor({ gateTool: 'polygon', overPolygonClose: true });
    expect(overClose).toBe(CLOSE_CURSOR);
    expect(overClose).not.toBe('crosshair');
    // Must degrade to something meaningful if the SVG cursor is rejected.
    expect(overClose).toMatch(/, pointer$/);
  });

  it('only shows the close cursor for the polygon tool', () => {
    expect(plotCursor({ gateTool: 'rectangle', overPolygonClose: true })).toBe('crosshair');
    expect(plotCursor({ gateTool: 'none', overPolygonClose: true })).toBe('grab');
  });

  it('encodes the close cursor as a self-contained data URI', () => {
    expect(CLOSE_CURSOR.startsWith('url("data:image/svg+xml,')).toBe(true);
    // A raw '#' would be read as a fragment and truncate the SVG.
    expect(CLOSE_CURSOR).not.toContain('#');
  });
});

describe('isNearPolygonClose', () => {
  const first = { x: 100, y: 100 };

  it('accepts a click inside the snap radius', () => {
    expect(isNearPolygonClose({ x: 104, y: 103 }, first, 3)).toBe(true);
    expect(isNearPolygonClose(first, first, 5)).toBe(true);
  });

  it('rejects a click outside it', () => {
    expect(isNearPolygonClose({ x: 100 + CLOSE_SNAP_PX + 2, y: 100 }, first, 4)).toBe(false);
  });

  it('is inclusive exactly on the radius', () => {
    expect(isNearPolygonClose({ x: 100 + CLOSE_SNAP_PX, y: 100 }, first, 3)).toBe(true);
  });

  it('will not close a shape with fewer than three vertices', () => {
    // Otherwise a fast double-click on the opening point would commit a
    // degenerate gate that matches nothing.
    expect(isNearPolygonClose(first, first, 0)).toBe(false);
    expect(isNearPolygonClose(first, first, 1)).toBe(false);
    expect(isNearPolygonClose(first, first, 2)).toBe(false);
    expect(isNearPolygonClose(first, first, 3)).toBe(true);
  });

  it('measures in screen pixels, so the target is the same size on every plot', () => {
    // Same pixel offset must give the same answer regardless of the data
    // coordinates behind it — the caller converts before asking.
    const near = { x: 106, y: 100 };
    expect(isNearPolygonClose(near, first, 3)).toBe(true);
    expect(isNearPolygonClose({ x: 1006, y: 1000 }, { x: 1000, y: 1000 }, 3)).toBe(true);
  });

  it('honours an explicit radius', () => {
    expect(isNearPolygonClose({ x: 120, y: 100 }, first, 3, 25)).toBe(true);
    expect(isNearPolygonClose({ x: 120, y: 100 }, first, 3, 5)).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   Finalisation, at the store level
   ------------------------------------------------------------------------- */

const SAMPLE = 's1';

const polygon = (id: string): Gate => ({
  id,
  name: id,
  parentId: null,
  colorIndex: 0,
  kind: 'polygon',
  xParam: 0,
  yParam: 1,
  vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
});

describe('gate finalisation', () => {
  beforeEach(() => {
    useGates.setState({
      shared: [], divergent: {}, selectedGateId: null, tool: 'none',
      pendingPolygon: null, lastAddedIds: [], lastAddedAt: 0,
    });
  });

  it('Escape-style cancellation clears the vertices and creates no population', () => {
    useGates.getState().setTool('polygon');
    useGates.getState().setPendingPolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    expect(useGates.getState().pendingPolygon).toHaveLength(3);

    // What the Escape handler does.
    useGates.getState().setPendingPolygon(null);

    expect(useGates.getState().pendingPolygon).toBeNull();
    expect(useGates.getState().gatesFor(SAMPLE)).toHaveLength(0);
    expect(useGates.getState().selectedGateId).toBeNull();
  });

  it('closing a polygon creates the population and clears the pending state', () => {
    useGates.getState().setTool('polygon');
    useGates.getState().setPendingPolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    useGates.getState().addGate(SAMPLE, polygon('g1'));

    expect(useGates.getState().gatesFor(SAMPLE)).toHaveLength(1);
    expect(useGates.getState().pendingPolygon).toBeNull();
    // The tool disarms, so the next click is a selection rather than a stray vertex.
    expect(useGates.getState().tool).toBe('none');
    expect(useGates.getState().selectedGateId).toBe('g1');
  });

  it('flags the new population so the tree can flash it', () => {
    useGates.getState().addGate(SAMPLE, polygon('g1'));
    expect(useGates.getState().lastAddedIds).toEqual(['g1']);
  });

  it('groups a quadrant’s four populations into one flash', () => {
    for (const id of ['q0', 'q1', 'q2', 'q3']) useGates.getState().addGate(SAMPLE, polygon(id));
    expect(useGates.getState().lastAddedIds).toEqual(['q0', 'q1', 'q2', 'q3']);
  });

  it('starts a new flash group for a draw made later', () => {
    useGates.getState().addGate(SAMPLE, polygon('g1'));
    useGates.setState({ lastAddedAt: Date.now() - 5000 });
    useGates.getState().addGate(SAMPLE, polygon('g2'));

    expect(useGates.getState().lastAddedIds).toEqual(['g2']);
    expect(useGates.getState().gatesFor(SAMPLE)).toHaveLength(2);
  });

  it('switching tools abandons an in-progress polygon', () => {
    useGates.getState().setTool('polygon');
    useGates.getState().setPendingPolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
    useGates.getState().setTool('rectangle');

    expect(useGates.getState().pendingPolygon).toBeNull();
    expect(useGates.getState().gatesFor(SAMPLE)).toHaveLength(0);
  });
});

/* ==========================================================================
   Item 10 — the cursor must promise what the drag will actually do.

   Reported as: a resize works from any edge, but near or past the *left* axis
   the pointer shows a hand rather than a resize arrow, and hovering exactly on a
   polygon vertex shows a hand too. Two separate causes, and only one of them is
   in this file — the other is a hit-testing precedence bug fixed by rendering
   the axis double-click strips *before* the gate SVG rather than after it, and
   is asserted by an end-to-end test against a real rendered panel,
   because "which of two overlapping elements answers a hover" is not a claim a
   pure function can make.

   What *is* a pure function is the mapping from a handle's name to its cursor,
   and that is where the vertex half lived: every handle in the app derived its
   cursor from a literal at its own call site, and the polygon vertex's literal
   said `grab` while the eight bounding-box handles a few pixels away said
   `nwse-resize`. So the pointer changed to a hand at exactly the pixel where the
   finest available edit is, which is the wrong way round.
   ========================================================================== */
describe('gateHandleCursor', () => {
  it('gives a polygon vertex a move cursor, not a grab', () => {
    // The reported one. A vertex drag moves a point in both axes, which is what
    // the four-way arrow means; `grab` promises picking the shape up and setting
    // it down, which is what dragging the polygon's *body* does.
    for (const h of ['v0', 'v1', 'v7', 'v12']) {
      expect(gateHandleCursor(h), h).toBe('move');
    }
    expect(gateHandleCursor('move')).toBe('move');
    // Nothing anywhere in the mapping produces a hand.
    for (const h of ['move', 'v0', 'nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w',
      'bnw', 'bne', 'bse', 'bsw', 'bn', 'bs', 'be', 'bw', 'rx', 'ry', 'min', 'max']) {
      expect(gateHandleCursor(h), h).not.toMatch(/grab/);
    }
  });

  it('matches each corner to the diagonal it actually resizes along', () => {
    expect(gateHandleCursor('nw')).toBe('nwse-resize');
    expect(gateHandleCursor('se')).toBe('nwse-resize');
    expect(gateHandleCursor('ne')).toBe('nesw-resize');
    expect(gateHandleCursor('sw')).toBe('nesw-resize');
    expect(gateHandleCursor('n')).toBe('ns-resize');
    expect(gateHandleCursor('s')).toBe('ns-resize');
    expect(gateHandleCursor('e')).toBe('ew-resize');
    expect(gateHandleCursor('w')).toBe('ew-resize');
  });

  it("gives a polygon's bounding box the same cursors as a rectangle's corners", () => {
    // They resize by the same rule — scale from the opposite corner — so two
    // shapes showing the same affordance must not describe it differently. This
    // is the assertion that keeps the `b` prefix from drifting into its own
    // mapping the next time one of the two is touched.
    for (const c of ['nw', 'ne', 'se', 'sw', 'n', 's', 'e', 'w']) {
      expect(gateHandleCursor(`b${c}`), c).toBe(gateHandleCursor(c));
    }
  });

  it('gives an ellipse radius and a range boundary their single axis', () => {
    expect(gateHandleCursor('rx')).toBe('ew-resize');
    expect(gateHandleCursor('ry')).toBe('ns-resize');
    // A range gate cuts one axis, so both its boundaries slide horizontally.
    expect(gateHandleCursor('min')).toBe('ew-resize');
    expect(gateHandleCursor('max')).toBe('ew-resize');
  });

  it('falls back to move rather than to default for a name it does not know', () => {
    // Every handle that exists moves geometry. An unknown name is a bug in this
    // function, and a four-way arrow is the honest answer to "a drag here changes
    // the gate somehow" — `default` would claim a drag does nothing.
    expect(gateHandleCursor('something-new')).toBe('move');
    expect(gateHandleCursor('')).toBe('move');
  });
});
