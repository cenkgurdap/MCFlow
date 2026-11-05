import { beforeEach, describe, expect, it } from 'vitest';
import { capture, HISTORY_LIMIT, restore, sameState, useHistory } from './historyStore';
import { isRecording } from './historyBus';
import { useGates, nextGateId } from './gateStore';
import { makePanel, usePlot } from './plotStore';
import type { Gate } from '@/core/gating/types';

/* -------------------------------------------------------------------------
   Undo/redo.

   This shipped as two Electron menu roles that only ever reached a focused text
   field, so the analysis had no undo at all while the menu said it did. Tests
   here are deliberately about the *stack* rather than about any one feature —
   "looks implemented, does nothing" is a property of the wiring, and only a test
   that drives the wiring can catch it.
   ------------------------------------------------------------------------- */

function rect(id: string, name: string): Gate {
  return {
    id, name, parentId: null, colorIndex: 0,
    kind: 'rectangle', xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
  };
}

beforeEach(() => {
  useHistory.getState().reset();
  useGates.setState({ shared: [], divergent: {}, selectedGateId: null, lastAddedIds: [], lastAddedAt: 0 });
  const first = makePanel();
  usePlot.setState({ panels: [first], activePanelId: first.id, otherLayouts: {} });
});

describe('the recorder is actually connected', () => {
  it('installs itself on import, without an init call', () => {
    // The failure this whole item exists to prevent: a history stack that has to
    // be switched on is one that ships switched off. Importing `historyStore`
    // is the only thing that should be required.
    expect(isRecording()).toBe(true);
  });

  it('a store action reaches the stack without the caller doing anything', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    expect(useHistory.getState().canUndo()).toBe(true);
    expect(useHistory.getState().undoLabel()).toBe('Add gate');
  });
});

describe('snapshot and restore', () => {
  it('round-trips gates', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    const snap = capture();
    useGates.getState().addGate('s1', rect('g2', 'P2'));
    expect(useGates.getState().gatesFor('s1')).toHaveLength(2);
    restore(snap);
    expect(useGates.getState().gatesFor('s1').map((g) => g.id)).toEqual(['g1']);
  });

  it('holds references, not copies — a snapshot costs nothing', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    const snap = capture();
    expect(snap.gates.shared).toBe(useGates.getState().shared);
    expect(snap.gates.divergent).toBe(useGates.getState().divergent);
  });

  it('sameState is reference equality across the captured slices', () => {
    const a = capture();
    expect(sameState(a, capture())).toBe(true);
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    expect(sameState(a, capture())).toBe(false);
  });
});

describe('undo and redo', () => {
  it('undoes a gate creation', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    expect(useHistory.getState().undo()).toBe('Add gate');
    expect(useGates.getState().gatesFor('s1')).toHaveLength(0);
  });

  it('redoes it again', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useHistory.getState().undo();
    expect(useHistory.getState().redo()).toBe('Add gate');
    expect(useGates.getState().gatesFor('s1')).toHaveLength(1);
  });

  it('undoes a deletion, restoring the gate', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useGates.getState().removeGate('s1', 'g1');
    expect(useGates.getState().gatesFor('s1')).toHaveLength(0);
    expect(useHistory.getState().undo()).toBe('Delete gate');
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['P1']);
  });

  it('undoes a rename with the specific label, not the generic one', () => {
    // `renameGate` delegates to `updateGate`, which records too. The inner call
    // must not overwrite the outer label — nor add a second, empty step.
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useGates.getState().renameGate('s1', 'g1', 'Lymphocytes');
    expect(useHistory.getState().undoLabel()).toBe('Rename gate');
    useHistory.getState().undo();
    expect(useGates.getState().gatesFor('s1')[0]!.name).toBe('P1');
  });

  it('a nested record does not create a second undo step', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    const before = useHistory.getState().past.length;
    useGates.getState().renameGate('s1', 'g1', 'Lymphocytes');
    expect(useHistory.getState().past.length).toBe(before + 1);
  });

  it('returns null and changes nothing at the bottom of the stack', () => {
    expect(useHistory.getState().undo()).toBeNull();
    expect(useHistory.getState().canUndo()).toBe(false);
  });

  it('returns null with nothing to redo', () => {
    expect(useHistory.getState().redo()).toBeNull();
  });

  it('walks several steps back in order', () => {
    // `lastAddedAt` is reset between adds so each reads as a separate gesture.
    // Without it all three land inside the 250 ms window that makes a quadrant's
    // four gates one step — which is right for a quadrant and wrong for three
    // gates a person drew, but a person cannot draw three in a quarter second.
    for (const [id, name] of [['g1', 'A'], ['g2', 'B'], ['g3', 'C']] as const) {
      useGates.setState({ lastAddedAt: 0 });
      useGates.getState().addGate('s1', rect(id, name));
    }
    expect(useGates.getState().gatesFor('s1')).toHaveLength(3);
    useHistory.getState().undo();
    useHistory.getState().undo();
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['A']);
    useHistory.getState().redo();
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['A', 'B']);
  });

  it('a new action abandons the redo branch', () => {
    useGates.getState().addGate('s1', rect('g1', 'A'));
    useGates.setState({ lastAddedAt: 0 });
    useGates.getState().addGate('s1', rect('g2', 'B'));
    useHistory.getState().undo();
    expect(useHistory.getState().canRedo()).toBe(true);
    useGates.setState({ lastAddedAt: 0 });
    useGates.getState().addGate('s1', rect('g3', 'C'));
    expect(useHistory.getState().canRedo()).toBe(false);
  });

  it('does not record its own undo', () => {
    // Otherwise Ctrl+Z toggles between two states forever instead of walking
    // back through them.
    useGates.getState().addGate('s1', rect('g1', 'A'));
    useGates.setState({ lastAddedAt: 0 });
    useGates.getState().addGate('s1', rect('g2', 'B'));
    const depth = useHistory.getState().past.length;
    useHistory.getState().undo();
    expect(useHistory.getState().past.length).toBe(depth - 1);
  });
});

describe('coverage — every kind of edit the user would expect back', () => {
  it('panel creation', () => {
    usePlot.getState().addPanel();
    expect(usePlot.getState().panels).toHaveLength(2);
    expect(useHistory.getState().undo()).toBe('Add plot');
    expect(usePlot.getState().panels).toHaveLength(1);
  });

  it('panel deletion — the Escape case', () => {
    const id = usePlot.getState().addPanel();
    useHistory.getState().reset();
    usePlot.getState().removePanel(id);
    expect(usePlot.getState().panels).toHaveLength(1);
    expect(useHistory.getState().undo()).toBe('Remove plot');
    expect(usePlot.getState().panels.map((p) => p.id)).toContain(id);
  });

  it('moving a plot on the worksheet', () => {
    const id = usePlot.getState().activePanelId;
    const before = usePlot.getState().panel(id)!;
    usePlot.getState().movePanel(id, 400, 240);
    expect(usePlot.getState().panel(id)!.x).toBe(400);
    expect(useHistory.getState().undo()).toBe('Move plot');
    expect(usePlot.getState().panel(id)!.x).toBe(before.x);
    expect(usePlot.getState().panel(id)!.y).toBe(before.y);
  });

  it('axis change', () => {
    const id = usePlot.getState().activePanelId;
    usePlot.getState().setAxis(id, 'x', 7);
    expect(useHistory.getState().undo()).toBe('Change axis');
    expect(usePlot.getState().panel(id)!.xParam).toBe(0);
  });

  it('transform change', () => {
    const id = usePlot.getState().activePanelId;
    usePlot.getState().setTransform(id, 'y', 'logicle');
    expect(useHistory.getState().undo()).toBe('Change transform');
    expect(usePlot.getState().panel(id)!.yTransform).toBe('linear');
  });

});

describe('coalescing — a gesture is one step, not sixty', () => {
  it('folds a continuous gate drag into a single entry', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useHistory.getState().reset();
    for (let i = 0; i < 40; i++) {
      useGates.getState().updateGate('s1', 'g1', { xMin: i / 100 } as Partial<Gate>);
    }
    expect(useHistory.getState().past).toHaveLength(1);
  });

  it('undoing that drag returns to where it started, not to the last frame', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useHistory.getState().reset();
    for (let i = 1; i <= 20; i++) {
      useGates.getState().updateGate('s1', 'g1', { xMin: i } as Partial<Gate>);
    }
    useHistory.getState().undo();
    expect((useGates.getState().gatesFor('s1')[0] as { xMin: number }).xMin).toBe(0);
  });

  it('dragging a different gate is a separate step', () => {
    useGates.getState().addGate('s1', rect('g1', 'A'));
    useGates.setState({ lastAddedAt: 0 });
    useGates.getState().addGate('s1', rect('g2', 'B'));
    useHistory.getState().reset();
    useGates.getState().updateGate('s1', 'g1', { xMin: 5 } as Partial<Gate>);
    useGates.getState().updateGate('s1', 'g2', { xMin: 5 } as Partial<Gate>);
    expect(useHistory.getState().past).toHaveLength(2);
  });

  it('a quadrant\'s four gates are one undo step', () => {
    // One click, four populations. Four presses of Ctrl+Z to reverse one click
    // would be wrong, and this is the reason `addGate` carries a gesture token.
    const stem = { parentId: null, colorIndex: 0, kind: 'quadrant' as const, xParam: 0, yParam: 1, xSplit: 0, ySplit: 0 };
    ([0, 1, 2, 3] as const).forEach((q) => {
      useGates.getState().addGate('s1', { ...stem, id: nextGateId(), name: `Q${q}`, quadrant: q });
    });
    expect(useGates.getState().gatesFor('s1')).toHaveLength(4);
    expect(useHistory.getState().past).toHaveLength(1);
    useHistory.getState().undo();
    expect(useGates.getState().gatesFor('s1')).toHaveLength(0);
  });

  it('coalescing does not span an undo', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useGates.getState().updateGate('s1', 'g1', { xMin: 1 } as Partial<Gate>);
    useHistory.getState().undo();
    useGates.getState().updateGate('s1', 'g1', { xMin: 2 } as Partial<Gate>);
    // The edit after the undo is a new action, not a continuation of the one
    // that was just reversed.
    expect(useHistory.getState().canUndo()).toBe(true);
  });
});

describe('no-op protection', () => {
  it('an action that changes nothing does not cost an undo step', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    const depth = useHistory.getState().past.length;
    // `reparentGate` to a parent that would cycle returns without mutating.
    useGates.getState().reparentGate('s1', 'g1', 'g1');
    expect(useHistory.getState().past.length).toBe(depth);
  });
});

describe('bounds', () => {
  it('caps the stack and drops the oldest entries', () => {
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) {
      useGates.getState().addGate('s1', rect(`g${i}`, `P${i}`));
      // A distinct gesture each time, so nothing coalesces.
      useGates.setState({ lastAddedAt: 0 });
    }
    expect(useHistory.getState().past).toHaveLength(HISTORY_LIMIT);
  });

  it('reset clears both directions', () => {
    useGates.getState().addGate('s1', rect('g1', 'P1'));
    useHistory.getState().undo();
    useHistory.getState().reset();
    expect(useHistory.getState().canUndo()).toBe(false);
    expect(useHistory.getState().canRedo()).toBe(false);
  });
});
