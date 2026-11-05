import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSelection, extendGateSelectionTo, selectGateOnly, selectPanelOnly,
  toggleGateSelection, togglePanelSelection,
} from './selection';
import { useGates } from './gateStore';
import { makePanel, usePlot } from './plotStore';
import type { Gate } from '@/core/gating/types';

/* ==========================================================================
   One selection at a time.

   The bug these exist for: `selectedGateId` and `selectedPanelId` were
   independent, and nothing ever cleared the first. So from the first click on a
   gate shape onward, Escape always asked about that gate and no plot could be
   selected for deletion again — for the rest of the session, in every panel.
   Both halves of the state were individually correct; the defect was that there
   was no rule relating them, so these are tests of the rule.
   ========================================================================== */

const rect = (id: string): Gate => ({
  id, name: id, parentId: null, colorIndex: 0,
  kind: 'rectangle', xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
});

beforeEach(() => {
  useGates.setState({
    shared: [rect('g1'), rect('g2'), rect('g3')], divergent: {},
    selectedGateId: null, selectedGateIds: [], gateSelectionAnchor: null,
    tool: 'none', pendingPolygon: null, lastAddedIds: [], lastAddedAt: 0,
  });
  const a = makePanel({ x: 10, y: 10 });
  const b = makePanel({ x: 300, y: 10 });
  const c = makePanel({ x: 590, y: 10 });
  usePlot.setState({
    panels: [a, b, c], activePanelId: a.id,
    selectedPanelId: null, selectedPanelIds: [], otherLayouts: {},
  });
});

const panelIds = () => usePlot.getState().panels.map((p) => p.id);

describe('exactly one of gate, panel or nothing', () => {
  it('selecting a gate clears the panel selection', () => {
    const [a] = panelIds();
    selectPanelOnly(a!);
    expect(usePlot.getState().selectedPanelId).toBe(a);

    selectGateOnly('g1', a!);
    expect(useGates.getState().selectedGateId).toBe('g1');
    // The panel is the *anchor* for the keystroke, not a second selection: the
    // panel renders as gate-selected, not as plot-selected.
    expect(usePlot.getState().selectedPanelId).toBe(a);
  });

  it('selecting a panel clears the gate selection — the whole of the bug', () => {
    const [a, b] = panelIds();
    selectGateOnly('g1', a!);
    expect(useGates.getState().selectedGateId).toBe('g1');

    // Click the background of a *different* panel.
    selectPanelOnly(b!);
    expect(useGates.getState().selectedGateId).toBeNull();
    expect(usePlot.getState().selectedPanelId).toBe(b);
  });

  it('clicking the same panel again also clears the gate', () => {
    const [a] = panelIds();
    selectGateOnly('g1', a!);
    selectPanelOnly(a!);
    expect(useGates.getState().selectedGateId).toBeNull();
    expect(usePlot.getState().selectedPanelId).toBe(a);
  });

  it('empty worksheet space clears everything', () => {
    const [a] = panelIds();
    selectGateOnly('g1', a!);
    clearSelection();
    expect(useGates.getState().selectedGateId).toBeNull();
    expect(usePlot.getState().selectedPanelId).toBeNull();
  });

  it('a gate selected from the sidebar tree has no panel anchor', () => {
    const [a] = panelIds();
    selectPanelOnly(a!);
    // The tree passes no panel: the click did not happen on one.
    selectGateOnly('g2');
    expect(useGates.getState().selectedGateId).toBe('g2');
    expect(usePlot.getState().selectedPanelId).toBeNull();
  });

  it('switching between gates never leaves two selected', () => {
    const [a, b] = panelIds();
    selectGateOnly('g1', a!);
    selectGateOnly('g2', b!);
    expect(useGates.getState().selectedGateId).toBe('g2');
    expect(usePlot.getState().selectedPanelId).toBe(b);
  });
});

describe('what Escape would act on', () => {
  /**
   * The routing `PlotCanvas` applies, restated here as data.
   *
   * A *panel* selection names its own panel. A *gate* selection is global — it
   * can be made from the tree, where no panel is involved — so the active panel
   * handles it, which is also where the outline is drawn. Stating both from one
   * condition is what stops the ring and the keystroke pointing at different
   * plots.
   */
  const target = (panelId: string) => {
    const g = useGates.getState().selectedGateId;
    const p = usePlot.getState();
    if (g) return p.activePanelId === panelId ? 'gate' : null;
    return p.selectedPanelId === panelId ? 'panel' : null;
  };

  it('deletes the plot when a plot is selected', () => {
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    expect(target(a!)).toBe('panel');
    expect(target(b!)).toBeNull();
  });

  it('asks about the gate when a gate is selected, on exactly one panel', () => {
    const [a, b] = panelIds();
    selectGateOnly('g1', a!);
    expect(target(a!)).toBe('gate');
    expect(target(b!)).toBeNull();
  });

  it('acts on nothing once the selection is cleared', () => {
    const [a] = panelIds();
    selectGateOnly('g1', a!);
    clearSelection();
    expect(target(a!)).toBeNull();
  });

  it('reaches the plot again after a gate has been selected', () => {
    // The user-visible consequence of the bug: this sequence used to leave the
    // gate selected forever, so Escape could never delete a plot again.
    const [a] = panelIds();
    selectGateOnly('g1', a!);
    selectPanelOnly(a!);
    expect(target(a!)).toBe('panel');
  });
});

/* ==========================================================================
   Several panels at once — 2026-08-12, Item 4.

   The invariant above is unchanged and these assert it still holds: a gate
   selection and a panel selection stay mutually exclusive however the panel
   side is built up. What is new is that the panel side has a cardinality, and
   the two fields that describe it must never disagree — `selectedPanelId` has
   to name a member of `selectedPanelIds` whenever there is one, because it is
   the panel a keystroke is routed through and a delete acts on the whole set.
   ========================================================================== */

describe('Ctrl+click multi-selection', () => {
  const sel = () => usePlot.getState().selectedPanelIds;
  const primary = () => usePlot.getState().selectedPanelId;

  it('a plain click selects exactly one', () => {
    const [a] = panelIds();
    selectPanelOnly(a!);
    expect(sel()).toEqual([a]);
    expect(primary()).toBe(a);
  });

  it('Ctrl+click adds to the selection rather than replacing it', () => {
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    expect(sel()).toEqual([a, b]);
  });

  it('Ctrl+click on a selected plot takes it back out', () => {
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    togglePanelSelection(b!);
    expect(sel()).toEqual([a]);
    expect(primary()).toBe(a);
  });

  it('a plain click collapses a multi-selection to one', () => {
    const [a, b, c] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    togglePanelSelection(c!);
    expect(sel()).toHaveLength(3);
    selectPanelOnly(b!);
    expect(sel()).toEqual([b]);
    expect(primary()).toBe(b);
  });

  it('starts from the single selection when the first Ctrl+click arrives', () => {
    // Not from nothing: Ctrl+clicking a second plot must give two, which is
    // what the gesture means everywhere it exists.
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    expect(sel()).toContain(a);
    expect(sel()).toContain(b);
  });

  it('Ctrl+clicking the primary out hands that role to a survivor', () => {
    // Otherwise keystrokes are routed through a plot the user just deselected,
    // and Escape would act on a selection whose primary is not in it.
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    expect(primary()).toBe(a);
    togglePanelSelection(a!);
    expect(sel()).toEqual([b]);
    expect(primary()).toBe(b);
  });

  it('leaves nothing selected once the last member is toggled off', () => {
    const [a] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(a!);
    expect(sel()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('a Ctrl+click clears a gate selection, like a plain one', () => {
    const [a, b] = panelIds();
    selectGateOnly('g1', a!);
    togglePanelSelection(b!);
    expect(useGates.getState().selectedGateId).toBeNull();
    expect(sel()).toEqual([b]);
  });

  it('a gate selection leaves no panel in the set, only an anchor', () => {
    // The whole reason `selectedPanelIds` is a second field: the anchor must
    // not render as selected, and must not be swept up by a multi-delete.
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    selectGateOnly('g1', a!);
    expect(sel()).toEqual([]);
    expect(primary()).toBe(a);
  });

  it('empty worksheet space clears the whole set', () => {
    const [a, b] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    clearSelection();
    expect(sel()).toEqual([]);
    expect(primary()).toBeNull();
  });

  it('the primary always names a member while there is one', () => {
    const [a, b, c] = panelIds();
    for (const step of [() => selectPanelOnly(a!), () => togglePanelSelection(b!),
      () => togglePanelSelection(c!), () => togglePanelSelection(a!),
      () => togglePanelSelection(b!)]) {
      step();
      const ids = sel();
      if (ids.length > 0) expect(ids).toContain(primary());
      else expect(primary()).toBeNull();
    }
  });
});

describe('acting on a multi-selection', () => {
  it('removes every selected plot in one action', () => {
    const [a, b, c] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(c!);
    usePlot.getState().removePanels(usePlot.getState().selectedPanelIds);
    expect(panelIds()).toEqual([b]);
    expect(usePlot.getState().selectedPanelIds).toEqual([]);
  });

  it('leaves the selection consistent after removing part of it', () => {
    const [a, b, c] = panelIds();
    selectPanelOnly(a!);
    togglePanelSelection(b!);
    togglePanelSelection(c!);
    usePlot.getState().removePanels([b!]);
    const st = usePlot.getState();
    expect(st.selectedPanelIds).toEqual([a, c]);
    expect(st.selectedPanelIds).toContain(st.selectedPanelId);
  });

  it('moves the whole group rigidly, keeping the offsets it started with', () => {
    const [a, b] = panelIds();
    const before = usePlot.getState();
    const pa = before.panel(a!)!;
    const pb = before.panel(b!)!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;

    usePlot.getState().movePanelGroup(a!, 400, 200, false, [{ id: b!, dx, dy }]);

    const after = usePlot.getState();
    expect(after.panel(a!)!.x).toBe(400);
    expect(after.panel(a!)!.y).toBe(200);
    // The pair is still the same shape it was before the drag.
    expect(after.panel(b!)!.x - after.panel(a!)!.x).toBe(dx);
    expect(after.panel(b!)!.y - after.panel(a!)!.y).toBe(dy);
  });

  it('does not drag unselected plots along', () => {
    const [a, b, c] = panelIds();
    const cx = usePlot.getState().panel(c!)!.x;
    usePlot.getState().movePanelGroup(a!, 500, 300, false, [{ id: b!, dx: 40, dy: 0 }]);
    expect(usePlot.getState().panel(c!)!.x).toBe(cx);
  });

  it('clamps a member at the origin rather than refusing the whole move', () => {
    // The honest behaviour: the worksheet has no negative coordinates, so a
    // member pushed past the corner stops there while the rest keep going.
    const [a, b] = panelIds();
    usePlot.getState().movePanelGroup(a!, 0, 0, false, [{ id: b!, dx: -80, dy: -80 }]);
    expect(usePlot.getState().panel(a!)!.x).toBe(0);
    expect(usePlot.getState().panel(b!)!.x).toBe(0);
  });
});

/* ==========================================================================
   Several gates, and the invariant that does not bend.

   The gate side became a set on 2026-08-22, and the thing to protect is not
   the cardinality — it is that a gate selection and a panel selection still
   cannot both be live. A set gives three new ways to break that rule and each
   of them has a test here.
   ========================================================================== */

const gateSel = () => useGates.getState().selectedGateIds;

describe('several gates at once', () => {
  it('a plain click is a selection of one, and it is the primary', () => {
    selectGateOnly('g2');
    expect(gateSel()).toEqual(['g2']);
    expect(useGates.getState().selectedGateId).toBe('g2');
    expect(useGates.getState().gateSelectionAnchor).toBe('g2');
  });

  it('Ctrl-click adds, and hands the primary to the row just clicked', () => {
    selectGateOnly('g1');
    toggleGateSelection('g3');
    expect(gateSel()).toEqual(['g1', 'g3']);
    expect(useGates.getState().selectedGateId).toBe('g3');
  });

  it('Ctrl-clicking the primary back off leaves a survivor holding the role', () => {
    // A plot marking a gate that is no longer selected is the state this file
    // exists to prevent, so the primary follows the set rather than going null.
    selectGateOnly('g1');
    toggleGateSelection('g3');
    toggleGateSelection('g3');
    expect(gateSel()).toEqual(['g1']);
    expect(useGates.getState().selectedGateId).toBe('g1');
  });

  it('Shift-click takes the block and keeps the anchor where it started', () => {
    const order = ['g1', 'g2', 'g3'];
    selectGateOnly('g1');
    extendGateSelectionTo('g3', order);
    expect(gateSel()).toEqual(order);
    // Unmoved, so the next Shift-click can shrink the range instead of
    // ratcheting it outwards.
    extendGateSelectionTo('g2', order);
    expect(gateSel()).toEqual(['g1', 'g2']);
    expect(useGates.getState().gateSelectionAnchor).toBe('g1');
  });

  it('reads in either direction, and measures from the last Ctrl-click', () => {
    const order = ['g1', 'g2', 'g3'];
    selectGateOnly('g3');
    extendGateSelectionTo('g1', order);
    expect(gateSel()).toEqual(order);

    selectGateOnly('g1');
    toggleGateSelection('g2');
    extendGateSelectionTo('g3', order);
    expect(gateSel()).toEqual(['g2', 'g3']);
  });

  it('with no anchor it is a plain click', () => {
    extendGateSelectionTo('g2', ['g1', 'g2', 'g3']);
    expect(gateSel()).toEqual(['g2']);
  });

  it('a Ctrl-click on a gate clears the panel selection, set and all', () => {
    const [a, b] = panelIds();
    usePlot.getState().setPanelSelection([a!, b!], a!);
    toggleGateSelection('g1');
    expect(usePlot.getState().selectedPanelIds).toEqual([]);
    expect(gateSel()).toEqual(['g1']);
  });

  it('and so does a Shift-click — the exclusivity holds on every route in', () => {
    const [a, b] = panelIds();
    selectGateOnly('g1');
    usePlot.getState().setPanelSelection([a!, b!], a!);
    extendGateSelectionTo('g3', ['g1', 'g2', 'g3']);
    expect(usePlot.getState().selectedPanelIds).toEqual([]);
    expect(gateSel()).toHaveLength(3);
  });

  it('selecting a panel clears the whole gate set, not just the primary', () => {
    const [a] = panelIds();
    selectGateOnly('g1');
    toggleGateSelection('g2');
    selectPanelOnly(a!);
    expect(gateSel()).toEqual([]);
    expect(useGates.getState().selectedGateId).toBeNull();
  });

  it('removing gates drops them from the set and leaves the survivors selected', () => {
    selectGateOnly('g1');
    toggleGateSelection('g2');
    toggleGateSelection('g3');
    useGates.getState().removeGates(new Set(['g2']));
    expect(gateSel()).toEqual(['g1', 'g3']);
    expect(useGates.getState().selectedGateId).toBe('g3');
  });

  it('and removing every selected gate leaves nothing selected', () => {
    selectGateOnly('g1');
    toggleGateSelection('g2');
    useGates.getState().removeGates(new Set(['g1', 'g2']));
    expect(gateSel()).toEqual([]);
    expect(useGates.getState().selectedGateId).toBeNull();
  });

  it('clearSelection empties both sides', () => {
    selectGateOnly('g1');
    toggleGateSelection('g2');
    clearSelection();
    expect(gateSel()).toEqual([]);
    expect(usePlot.getState().selectedPanelId).toBeNull();
  });
});
