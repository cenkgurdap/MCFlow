import { describe, expect, it } from 'vitest';
import {
  beginGateDrag, onPointerMove, onPointerUp, withinRect, type GateDragState,
} from './gateDragMachine';

/* -------------------------------------------------------------------------
   The boundary between "move this gate" and "open a plot of it".

   These two behaviours shipped fighting each other: the in-plot move handler
   consumed every pointer move, so the out-of-bounds case was unreachable and
   dragging a gate out of its plot did nothing at all. The regression worth
   guarding is not any single transition — it is that the machine has exactly one
   place where the decision is made, and that a round trip out and back leaves
   the gesture as a plain move.
   ------------------------------------------------------------------------- */

/** Replay a sequence of inside/outside samples, collecting the effects. */
function replay(inside: boolean[]): {
  state: GateDragState;
  moves: number;
  restores: number;
  crossings: number;
} {
  let state = beginGateDrag('g1');
  let moves = 0;
  let restores = 0;
  let crossings = 0;
  for (const i of inside) {
    const r = onPointerMove(state, i);
    state = r.state;
    if (r.effect.move) moves++;
    if (r.effect.restore) restores++;
    if (r.effect.crossed) crossings++;
  }
  return { state, moves, restores, crossings };
}

describe('gate drag — starting state', () => {
  it('always begins as a move', () => {
    // The pointer had to be on the shape to grab it, so "began outside" is not a
    // reachable state and nothing should have to handle it.
    expect(beginGateDrag('g1')).toEqual({ gateId: 'g1', phase: 'moving' });
  });

  it('keeps the gate id it was given', () => {
    expect(beginGateDrag('lymphocytes').gateId).toBe('lymphocytes');
  });
});

describe('gate drag — inside the source plot', () => {
  it('moves the shape on every sample', () => {
    const r = replay([true, true, true, true]);
    expect(r.moves).toBe(4);
    expect(r.state.phase).toBe('moving');
  });

  it('never restores while it stays inside', () => {
    expect(replay([true, true, true]).restores).toBe(0);
  });

  it('reports no crossing when nothing changes', () => {
    // Sixty samples a second all reporting "crossed" would make the visual cue
    // flicker and would write the same gate to the store on every frame.
    expect(replay([true, true, true]).crossings).toBe(0);
  });

  it('releases as a move', () => {
    expect(onPointerUp(replay([true, true]).state)).toBe('commit-move');
  });
});

describe('gate drag — crossing out', () => {
  it('switches to leaving and stops moving the shape', () => {
    const r = replay([true, true, false]);
    expect(r.state.phase).toBe('leaving');
    expect(r.moves).toBe(2);
  });

  it('restores the original geometry exactly once, on the crossing', () => {
    // The gate has been dragged partway to the edge by the time the pointer
    // leaves. Leaving it there would be an edit nobody asked for — but writing
    // the restore on every subsequent outside sample would be sixty identical
    // store writes per second.
    const r = replay([true, false, false, false, false]);
    expect(r.restores).toBe(1);
  });

  it('reports the crossing so the cue can change', () => {
    const first = onPointerMove(beginGateDrag('g1'), false);
    expect(first.effect.crossed).toBe(true);
    const second = onPointerMove(first.state, false);
    expect(second.effect.crossed).toBe(false);
  });

  it('releases as a request for a new panel', () => {
    expect(onPointerUp(replay([true, false]).state)).toBe('open-panel');
  });

  it('releasing immediately on the crossing still opens a panel', () => {
    // No settling samples between the crossing and the release: a fast flick out
    // of the plot is a normal gesture, and Chromium coalesces pointer moves.
    expect(onPointerUp(replay([false]).state)).toBe('open-panel');
  });
});

describe('gate drag — coming back in', () => {
  it('reverts to a plain move when the pointer re-enters before release', () => {
    const r = replay([true, false, false, true]);
    expect(r.state.phase).toBe('moving');
    expect(onPointerUp(r.state)).toBe('commit-move');
  });

  it('counts one crossing each way', () => {
    expect(replay([true, false, false, true, true]).crossings).toBe(2);
  });

  it('restores once per exit, not once per gesture', () => {
    // Out, back, out again: two exits, so two restores. The second exit starts
    // from wherever the second pass of moving left the shape.
    expect(replay([true, false, true, false]).restores).toBe(2);
  });

  it('resumes moving the shape after re-entry', () => {
    const r = replay([true, false, true, true]);
    expect(r.moves).toBe(3);
  });

  it('a full round trip ending inside is indistinguishable from never leaving', () => {
    const roundTrip = replay([true, false, true]);
    expect(onPointerUp(roundTrip.state)).toBe(onPointerUp(replay([true, true, true]).state));
  });
});

describe('withinRect', () => {
  const r = { left: 100, right: 300, top: 50, bottom: 250 };

  it('accepts a point inside', () => {
    expect(withinRect({ clientX: 200, clientY: 150 }, r)).toBe(true);
  });

  it('accepts the edges — a gate dragged onto its own axis label has not left', () => {
    expect(withinRect({ clientX: 100, clientY: 50 }, r)).toBe(true);
    expect(withinRect({ clientX: 300, clientY: 250 }, r)).toBe(true);
  });

  it('rejects a point past each edge', () => {
    expect(withinRect({ clientX: 99, clientY: 150 }, r)).toBe(false);
    expect(withinRect({ clientX: 301, clientY: 150 }, r)).toBe(false);
    expect(withinRect({ clientX: 200, clientY: 49 }, r)).toBe(false);
    expect(withinRect({ clientX: 200, clientY: 251 }, r)).toBe(false);
  });
});
