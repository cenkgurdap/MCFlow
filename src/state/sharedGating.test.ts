import { beforeEach, describe, expect, it } from 'vitest';
import { migrateGating, parseWorkspace, WORKSPACE_VERSION } from '@/core/workspace';
import type { Gate, RectangleGate } from '@/core/gating/types';
import type { TransformSpec } from '@/core/transform';
import { buildFcs } from '@/core/fcs/fixtures';
import { parseFcs } from '@/core/fcs/parser';
import { evaluateFor, resolveGates, useGates } from './gateStore';
import { useHistory } from './historyStore';
import { usePlot, makePanel } from './plotStore';
import { useUI } from './uiStore';

/* ==========================================================================
   Gating is shared across samples by default.

   The old model gave every sample its own hierarchy and a `copyStrategy` button
   to replicate one across the set. That made "the same gates, all samples" —
   which is what nearly every experiment wants — a manual step repeated once per
   sample, every session. These tests pin the new default and the escape hatch
   that preserves the case the old model was actually good for.
   ========================================================================== */

function rect(id: string, name: string, parentId: string | null = null): RectangleGate {
  return {
    id, name, parentId, colorIndex: 0, kind: 'rectangle',
    xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
  };
}

beforeEach(() => {
  useGates.setState({
    shared: [], divergent: {}, overrides: {},
    selectedGateId: null, lastAddedIds: [], lastAddedAt: 0,
  });
  useHistory.getState().reset();
  useUI.setState({ pendingGateDelete: null });
});

describe('shared by default', () => {
  it('a gate drawn while viewing one sample is already on the next', () => {
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    expect(useGates.getState().gatesFor('s2').map((g) => g.name)).toEqual(['Lymphocytes']);
    expect(useGates.getState().gatesFor('s3')).toHaveLength(1);
  });

  it('applies to a sample that did not exist when the gate was drawn', () => {
    // The import-order case: gate first, load the rest of the plate afterwards.
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    expect(useGates.getState().gatesFor('imported-later')).toHaveLength(1);
  });

  it('hands out the same gate ids, so a population means one thing everywhere', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    expect(useGates.getState().gatesFor('s2')[0]!.id).toBe(useGates.getState().gatesFor('s1')[0]!.id);
  });

  it('edits, renames and deletes reach every sample too', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().renameGate('s2', 'g1', 'Live cells');
    expect(useGates.getState().gatesFor('s1')[0]!.name).toBe('Live cells');

    useGates.getState().removeGate('s3', 'g1');
    expect(useGates.getState().gatesFor('s1')).toHaveLength(0);
  });
});

describe('a gate can belong to one sample', () => {
  /*
     `ownerSampleId`, and the bug it fixes is worth stating because the shape of
     it is not obvious from the field name.

     Gating is shared across samples, which is the right default and is not
     changing. But the unmixing wizard creates populations that are only
     *meaningful* on one file — "CD8 PerCP-eFluor 710 +" is a threshold on the
     CD8 tube's own distribution — and a panel draws every range gate that sits
     on its x parameter. Two single stains sharing a peak detector is ordinary
     panel design, so CD8's worksheet drew CD27's gate as well: two labels, two
     percentages, one histogram, and one of the numbers describing a population
     nobody had asked about.
  */
  const owned = (id: string, name: string, sampleId: string): Gate =>
    ({ ...rect(id, name), ownerSampleId: sampleId });

  it('resolves on its owner and nowhere else', () => {
    useGates.getState().addGate('s1', owned('g1', 'CD8 +', 's1'));
    useGates.getState().addGate('s2', owned('g2', 'CD27 +', 's2'));

    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['CD8 +']);
    expect(useGates.getState().gatesFor('s2').map((g) => g.name)).toEqual(['CD27 +']);
    expect(useGates.getState().gatesFor('s3')).toHaveLength(0);
  });

  it('leaves an unowned gate on every sample, as before', () => {
    useGates.getState().addGate('s1', rect('shared', 'Cells'));
    useGates.getState().addGate('s1', owned('g1', 'CD8 +', 's1'));
    expect(useGates.getState().gatesFor('s2').map((g) => g.name)).toEqual(['Cells']);
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['Cells', 'CD8 +']);
  });

  it('returns the shared list by identity when nothing is owned', () => {
    /*
       Not a micro-optimisation: `gatesFor` runs inside a Zustand selector, and a
       selector that builds a fresh array every call reports a change on every
       render — React error #185, immediately. The filter has to be free and
       reference-stable in the case that is every existing workspace.
    */
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    const a = useGates.getState().gatesFor('s1');
    expect(useGates.getState().gatesFor('s2')).toBe(a);
    expect(useGates.getState().gatesFor('s1')).toBe(a);
  });

  it('is reference-stable per sample once something is owned', () => {
    useGates.getState().addGate('s1', owned('g1', 'CD8 +', 's1'));
    expect(useGates.getState().gatesFor('s2')).toBe(useGates.getState().gatesFor('s2'));
  });

  it('does not carry the owner into a copied strategy', () => {
    /*
       A copy is *for* the sample receiving it. Carrying the owner through would
       hand the target a gate owned by the source, which `resolveGates` filters
       straight back out — a strategy that silently shrinks when copied.
    */
    useGates.getState().addGate('s1', rect('shared', 'Cells'));
    useGates.getState().addGate('s1', owned('g1', 'CD8 +', 's1'));
    useGates.getState().copyStrategy('s1', ['s9']);
    expect(useGates.getState().gatesFor('s9').map((g) => g.name)).toEqual(['Cells', 'CD8 +']);
    expect(useGates.getState().gatesFor('s9').every((g) => g.ownerSampleId === undefined)).toBe(true);
  });

  it('forks only what the sample can actually see', () => {
    // `unlinkSample` used to clone `shared` wholesale, which would now hand this
    // sample every other control's gates.
    useGates.getState().addGate('s1', rect('shared', 'Cells'));
    useGates.getState().addGate('s2', owned('g2', 'CD27 +', 's2'));
    useGates.getState().unlinkSample('s1');
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['Cells']);
  });
});

describe('divergence', () => {
  it('unlinking forks the hierarchy, with fresh ids', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');

    expect(useGates.getState().isDivergent('s2')).toBe(true);
    const forked = useGates.getState().gatesFor('s2');
    expect(forked).toHaveLength(1);
    // Fresh ids: two hierarchies sharing them would make "which did I edit?"
    // depend on the write path rather than on the data.
    expect(forked[0]!.id).not.toBe('g1');
  });

  it('an edit on a forked sample does not reach the others', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');
    const forkedId = useGates.getState().gatesFor('s2')[0]!.id;

    useGates.getState().renameGate('s2', forkedId, 'Only here');
    expect(useGates.getState().gatesFor('s2')[0]!.name).toBe('Only here');
    expect(useGates.getState().gatesFor('s1')[0]!.name).toBe('Cells');
    expect(useGates.getState().gatesFor('s3')[0]!.name).toBe('Cells');
  });

  it('a gate added on a forked sample stays on it', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');
    useGates.getState().addGate('s2', rect('g2', 'Extra'));

    expect(useGates.getState().gatesFor('s2')).toHaveLength(2);
    expect(useGates.getState().gatesFor('s1')).toHaveLength(1);
  });

  it('relinking discards the fork and returns to the shared strategy', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');
    useGates.getState().addGate('s2', rect('g2', 'Extra'));

    useGates.getState().relinkSample('s2');
    expect(useGates.getState().isDivergent('s2')).toBe(false);
    expect(useGates.getState().gatesFor('s2').map((g) => g.name)).toEqual(['Cells']);
  });

  it('applyToAllSamples promotes a fork and clears every divergence', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');
    useGates.getState().addGate('s2', rect('g2', 'Extra'));
    useGates.getState().unlinkSample('s3');

    useGates.getState().applyToAllSamples('s2');
    expect(useGates.getState().divergent).toEqual({});
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['Cells', 'Extra']);
    expect(useGates.getState().gatesFor('s3').map((g) => g.name)).toEqual(['Cells', 'Extra']);
  });

  it('copyStrategy still forks the targets, for the deliberate case', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s1');
    useGates.getState().addGate('s1', rect('g2', 'Special'));

    useGates.getState().copyStrategy('s1', ['s2']);
    expect(useGates.getState().isDivergent('s2')).toBe(true);
    expect(useGates.getState().gatesFor('s2').map((g) => g.name)).toEqual(['Cells', 'Special']);
    // Untouched: `copyStrategy` names its targets, so s3 keeps tracking the
    // shared strategy — which still holds only the gate drawn before the fork.
    expect(useGates.getState().isDivergent('s3')).toBe(false);
    expect(useGates.getState().gatesFor('s3').map((g) => g.name)).toEqual(['Cells']);
  });

  it('undo reverses a fork', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().unlinkSample('s2');
    expect(useHistory.getState().undo()).toBe('Unlink gating');
    expect(useGates.getState().isDivergent('s2')).toBe(false);
  });
});

describe('migrating a v3 workspace', () => {
  const base = {
    version: 3,
    name: 'old',
    savedAt: new Date().toISOString(),
    application: 'MCFlow',
    samples: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    plot: { panels: [], columns: 2 },
  };

  it('collapses identical per-sample hierarchies into one shared strategy', () => {
    // What `copyStrategy` produced: the same hierarchy with regenerated ids.
    // Comparing on ids would call these three different strategies.
    const g = migrateGating({
      s1: [rect('a1', 'Cells'), rect('b1', 'Singlets', 'a1')],
      s2: [rect('a2', 'Cells'), rect('b2', 'Singlets', 'a2')],
      s3: [rect('a3', 'Cells'), rect('b3', 'Singlets', 'a3')],
    });
    expect(g.shared.map((x) => x.name)).toEqual(['Cells', 'Singlets']);
    expect(g.divergent).toEqual({});
  });

  it('links samples that had no gates at all', () => {
    const g = migrateGating({ s1: [rect('a1', 'Cells')], s2: [], s3: [] });
    expect(g.shared).toHaveLength(1);
    expect(g.divergent).toEqual({});
  });

  it('keeps a genuinely different hierarchy as a fork rather than merging it', () => {
    // Silently merging two different gating strategies would change someone's
    // numbers, which is the one thing a migration must not do.
    const g = migrateGating({
      s1: [rect('a1', 'Cells')],
      s2: [rect('a2', 'Cells')],
      s3: [rect('a3', 'Debris')],
    });
    expect(g.shared.map((x) => x.name)).toEqual(['Cells']);
    expect(Object.keys(g.divergent)).toEqual(['s3']);
    expect(g.divergent['s3']!.map((x) => x.name)).toEqual(['Debris']);
  });

  it('is empty for a workspace that was never gated', () => {
    expect(migrateGating({})).toEqual({ shared: [], divergent: {} });
    expect(migrateGating(undefined)).toEqual({ shared: [], divergent: {} });
  });

  it('parseWorkspace applies the migration to an old file', () => {
    const w = parseWorkspace(JSON.stringify({
      ...base,
      gatesBySample: { s1: [rect('a1', 'Cells')], s2: [rect('a2', 'Cells')] },
    }));
    expect(w.gating.shared.map((g: Gate) => g.name)).toEqual(['Cells']);
    expect(w.derivedParameters).toEqual([]);
  });

  it('reads a v4 file straight through', () => {
    const w = parseWorkspace(JSON.stringify({
      ...base,
      version: WORKSPACE_VERSION,
      gating: { shared: [rect('a', 'Cells')], divergent: { s3: [rect('b', 'Other')] } },
      derivedParameters: [{ id: 'd1', name: 'Ratio', expression: 'FITC-A / APC-A' }],
    }));
    expect(w.gating.shared).toHaveLength(1);
    expect(Object.keys(w.gating.divergent)).toEqual(['s3']);
    expect(w.derivedParameters[0]!.name).toBe('Ratio');
  });
});

describe('the sidebar tree no longer drives the worksheet', () => {
  it('has no followPopulation action left to call', () => {
    // Item 9.2 of the previous pass, reversed. Selecting a population in the
    // tree is a management action — rename, delete, read the statistics — and
    // having three plots change what they display as a side effect of it made
    // the worksheet feel unsafe to touch.
    expect('followPopulation' in usePlot.getState()).toBe(false);
    expect('setPopulationPinned' in usePlot.getState()).toBe(false);
  });

  it('a panel keeps its population when the tree selection changes', () => {
    const panel = makePanel({ sampleId: 's1', populationId: 'g1' });
    usePlot.setState({ panels: [panel], activePanelId: panel.id, otherLayouts: {} });

    useGates.getState().addGate('s1', rect('g2', 'Other'));
    useGates.getState().selectGate('g2');

    expect(usePlot.getState().panels[0]!.populationId).toBe('g1');
  });

  it('a panel with no population stays unscoped as well', () => {
    const panel = makePanel({ sampleId: 's1', populationId: null });
    usePlot.setState({ panels: [panel], activePanelId: panel.id, otherLayouts: {} });

    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useGates.getState().selectGate('g1');

    expect(usePlot.getState().panels[0]!.populationId).toBeNull();
  });
});

describe('deleting a gate asks first', () => {
  it('the confirmation is state, not a side effect — nothing is deleted by asking', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useUI.getState().askDeleteGate('s1', ['g1'], 'Cells');

    expect(useUI.getState().pendingGateDelete).toEqual({ sampleId: 's1', gateIds: ['g1'], name: 'Cells' });
    expect(useGates.getState().gatesFor('s1')).toHaveLength(1);
  });

  it('cancelling leaves the gate alone', () => {
    useGates.getState().addGate('s1', rect('g1', 'Cells'));
    useUI.getState().askDeleteGate('s1', ['g1'], 'Cells');
    useUI.getState().cancelDeleteGate();

    expect(useUI.getState().pendingGateDelete).toBeNull();
    expect(useGates.getState().gatesFor('s1')).toHaveLength(1);
  });
});

/* ==========================================================================
   One gate, one size          (2026-08-03, Item 17)

   The defect: `evaluateFor`'s `axisSpecFor` argument decided which display
   space a gate's coordinates were read in, and every caller passed a different
   one. `PlotCanvas` passed the panel's current axis specs; the gate tree, the
   statistics table and the export passed `defaultSpecFor`. Switch a transform
   on an axis a gate is defined on and the same gate reported two different
   counts, nearly a factor of two apart.

   A gate now records the space it was drawn in, and that record wins. The
   argument survives only as a fallback for gates that predate the field.
   ========================================================================== */

describe('a gate is evaluated in the space it was drawn in', () => {
  const LOG: TransformSpec = { kind: 'log', range: 1024, decades: 3 };
  const LIN: TransformSpec = { kind: 'linear', range: 1024 };

  /** Four events at raw 1, 10, 100, 1000 on one parameter. */
  const parsed = parseFcs(buildFcs({
    dataType: 'F',
    params: [{ name: 'A', bits: 32, range: 1024 }, { name: 'B', bits: 32, range: 1024 }],
    events: [[1, 1], [10, 1], [100, 1], [1000, 1]],
  }));

  /** x in [1.5, 3] of a 3-decade log axis: raw 10^-1.5·1024 upward. */
  const logGate = (): Gate => ({
    id: 'g', name: 'g', parentId: null, colorIndex: 0, kind: 'rectangle',
    xParam: 0, yParam: 1, xMin: 1.5, xMax: 3, yMin: -1e9, yMax: 1e9,
    xSpec: LOG, ySpec: LIN,
  });

  const countWith = (gate: Gate, fallback: TransformSpec) =>
    evaluateFor(`s-${Math.random()}`, parsed, [gate], () => fallback).stats.get('g')!.count;

  it('gives the same answer whatever fallback the caller supplies', () => {
    // This is the assertion the bug would have failed: the two numbers below
    // were 3 and 0 before the gate carried its own space.
    const asPanel = countWith(logGate(), LOG);
    const asDefault = countWith(logGate(), LIN);
    expect(asDefault).toBe(asPanel);
    expect(asPanel).toBeGreaterThan(0);
  });

  it('still honours the fallback for a gate that names no space', () => {
    // Backward compatibility, stated as a test rather than assumed: a gate saved
    // before 2026-08-03 must behave exactly as it did, which means following
    // whatever spec the caller passes.
    const legacy = { ...logGate(), xSpec: undefined, ySpec: undefined } as Gate;
    expect(countWith(legacy, LOG)).not.toBe(countWith(legacy, LIN));
  });

  it('keys its cache on the fallback, so two callers cannot share a stale slot', () => {
    const legacy = { ...logGate(), xSpec: undefined, ySpec: undefined } as Gate;
    const id = 'one-sample';
    const a = evaluateFor(id, parsed, [legacy], () => LOG).stats.get('g')!.count;
    const b = evaluateFor(id, parsed, [legacy], () => LIN).stats.get('g')!.count;
    const aAgain = evaluateFor(id, parsed, [legacy], () => LOG).stats.get('g')!.count;
    expect(a).not.toBe(b);
    expect(aAgain).toBe(a);
  });
});

/* ==========================================================================
   One gate unlinked, the rest shared          (2026-08-03, Item 5)

   Gating is shared by default and a whole sample can be forked off it. Between
   those two is the case that actually comes up: an initial scatter/debris gate
   that genuinely has to be tuned per file, with a marker-positive gate under it
   that must stay identical or the populations are not comparable.

   So `linked` is per gate and independent of the parent's. The claim these
   tests pin is the one the export depends on: **each sample resolves to its own
   boundary for an unlinked gate, and to the shared one for everything else.**
   ========================================================================== */

describe('per-gate link/unlink', () => {
  const box = (id: string, name: string, parentId: string | null, x: number): RectangleGate => ({
    id, name, parentId, colorIndex: 0, kind: 'rectangle',
    xParam: 0, yParam: 1, xMin: x, xMax: x + 10, yMin: 0, yMax: 100,
  });

  const resolve = (sampleId: string) => {
    const s = useGates.getState();
    return resolveGates(s.shared, s.divergent, s.overrides, sampleId);
  };

  beforeEach(() => {
    useGates.setState({ shared: [], divergent: {}, overrides: {} });
    useGates.getState().addGate('s1', box('debris', 'Debris', null, 0));
    useGates.getState().addGate('s1', box('cd4', 'CD4+', 'debris', 40));
  });

  it('starts linked, so every sample sees one boundary', () => {
    expect(resolve('s1')[0]!.linked).toBeUndefined();
    expect(resolve('s2')).toBe(resolve('s1'));
  });

  it('moves an unlinked gate on one sample only', () => {
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5, xMax: 15 } as Partial<Gate>);

    const one = resolve('s1').find((g) => g.id === 'debris') as RectangleGate;
    const two = resolve('s2').find((g) => g.id === 'debris') as RectangleGate;
    expect(one.xMin).toBe(5);
    // s2 has no override, so it keeps the shared boundary.
    expect(two.xMin).toBe(0);
  });

  it('gives two samples two genuinely different boundaries', () => {
    // The exact scenario Item 5 asks for a test of, one step below the export.
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5 } as Partial<Gate>);
    useGates.getState().updateGate('s2', 'debris', { xMin: 25 } as Partial<Gate>);

    expect((resolve('s1').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(5);
    expect((resolve('s2').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(25);
    // And a third sample, never touched, still has the shared one.
    expect((resolve('s3').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(0);
  });

  it('leaves a linked child of an unlinked parent alone', () => {
    // The independence the item names: the flag is read per gate, never
    // inherited. A marker gate under a per-sample debris gate stays universal.
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5 } as Partial<Gate>);
    useGates.getState().updateGate('s1', 'cd4', { xMin: 55 } as Partial<Gate>);

    expect((resolve('s2').find((g) => g.id === 'cd4') as RectangleGate).xMin).toBe(55);
    expect((resolve('s2').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(0);
  });

  it('lets an unlinked gate sit under a linked one', () => {
    useGates.getState().setGateLinked('s1', 'cd4', false);
    useGates.getState().updateGate('s1', 'cd4', { xMin: 55 } as Partial<Gate>);

    expect((resolve('s1').find((g) => g.id === 'cd4') as RectangleGate).xMin).toBe(55);
    expect((resolve('s2').find((g) => g.id === 'cd4') as RectangleGate).xMin).toBe(40);
    // The parent is untouched by any of it.
    expect((resolve('s2').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(0);
  });

  it('keeps the name and the parent shared, so the population path still matches', () => {
    // The whole reason only the *boundary* forks: the export and the statistics
    // table are keyed by population path, and a per-sample rename would make one
    // sample's population unmatchable against the others.
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5 } as Partial<Gate>);
    useGates.getState().renameGate('s1', 'debris', 'Not debris');

    expect(resolve('s2').find((g) => g.id === 'debris')!.name).toBe('Not debris');
    expect(resolve('s1').find((g) => g.id === 'debris')!.name).toBe('Not debris');
    // …and the boundary is still forked.
    expect((resolve('s1').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(5);
    expect((resolve('s2').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(0);
  });

  it('discards the per-sample boundaries when the gate is linked back', () => {
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5 } as Partial<Gate>);
    useGates.getState().setGateLinked('s1', 'debris', true);

    expect(useGates.getState().overrides.debris).toBeUndefined();
    expect((resolve('s1').find((g) => g.id === 'debris') as RectangleGate).xMin).toBe(0);
    expect(resolve('s2')).toBe(resolve('s1'));
  });

  it('drops a deleted gate’s overrides rather than leaving them for the next id', () => {
    useGates.getState().setGateLinked('s1', 'debris', false);
    useGates.getState().updateGate('s1', 'debris', { xMin: 5 } as Partial<Gate>);
    useGates.getState().removeGate('s1', 'debris');
    expect(useGates.getState().overrides.debris).toBeUndefined();
  });

  it('returns the shared list by identity when nothing is unlinked', () => {
    // Not an optimisation for its own sake: every memo downstream of the gate
    // list keys on this reference, and rebuilding it per sample would re-run
    // gate evaluation on every render.
    const s = useGates.getState();
    expect(resolveGates(s.shared, s.divergent, s.overrides, 's1')).toBe(s.shared);
  });
});

/* ==========================================================================
   Redefining a population with a freshly drawn shape — 2026-08-12, Item 9.

   The gesture: draw the gate you actually wanted, then say which population it
   should *be*. What made this worth an action of its own rather than
   delete-then-draw-then-rename is the identity — a population's id is what its
   children are parented to, what a scoped panel points at, and what per-gate
   label offsets are keyed by. Losing it loses all three.
   ========================================================================== */

describe('replacing a gate with a new shape', () => {
  const range = (id: string, name: string, parentId: string | null = null): Gate => ({
    id, name, parentId, colorIndex: 7, kind: 'range', xParam: 4, min: 0.2, max: 0.8,
  });

  it('keeps the identity and takes the geometry', () => {
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    useGates.getState().replaceGate('s1', 'g1', rect('fresh', 'ignored'));

    const gates = useGates.getState().gatesFor('s1');
    expect(gates).toHaveLength(1);
    expect(gates[0]!.id).toBe('g1');
    // Nothing named `fresh` ever entered the tree: this is a redefinition, not
    // an add followed by a delete.
    expect(gates.some((g) => g.id === 'fresh')).toBe(false);
  });

  it('keeps the children, which is the whole reason it is not a delete', () => {
    useGates.getState().addGate('s1', rect('parent', 'Cells'));
    useGates.getState().addGate('s1', rect('child', 'CD4', 'parent'));
    useGates.getState().addGate('s1', rect('grandchild', 'Naive', 'child'));

    useGates.getState().replaceGate('s1', 'parent', rect('fresh', 'x'));

    const gates = useGates.getState().gatesFor('s1');
    expect(gates).toHaveLength(3);
    expect(gates.find((g) => g.id === 'child')!.parentId).toBe('parent');
    expect(gates.find((g) => g.id === 'grandchild')!.parentId).toBe('child');
  });

  it('keeps its place in the tree rather than taking the new shape\'s parent', () => {
    useGates.getState().addGate('s1', rect('cells', 'Cells'));
    useGates.getState().addGate('s1', rect('cd4', 'CD4', 'cells'));
    // Drawn on a plot scoped somewhere else entirely.
    useGates.getState().replaceGate('s1', 'cd4', rect('fresh', 'x', null));
    expect(useGates.getState().gatesFor('s1').find((g) => g.id === 'cd4')!.parentId).toBe('cells');
  });

  it('keeps the population colour, so the tree does not change under the user', () => {
    useGates.getState().addGate('s1', { ...rect('g1', 'Lymphocytes'), colorIndex: 5 });
    useGates.getState().replaceGate('s1', 'g1', { ...rect('fresh', 'x'), colorIndex: 11 });
    expect(useGates.getState().gatesFor('s1')[0]!.colorIndex).toBe(5);
  });

  it('takes the new name when one is given, and keeps the old one when not', () => {
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    useGates.getState().replaceGate('s1', 'g1', rect('f', 'x'), 'Live cells');
    expect(useGates.getState().gatesFor('s1')[0]!.name).toBe('Live cells');

    useGates.getState().replaceGate('s1', 'g1', rect('f', 'x'));
    expect(useGates.getState().gatesFor('s1')[0]!.name).toBe('Live cells');
  });

  it('leaves no field of the old shape behind when the kind changes', () => {
    // A rectangle replaced by a range must not keep `yMin`, or anything reading
    // the gate structurally sees two shapes at once.
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    useGates.getState().replaceGate('s1', 'g1', range('f', 'x'));

    const g = useGates.getState().gatesFor('s1')[0]! as unknown as Record<string, unknown>;
    expect(g.kind).toBe('range');
    expect(g.min).toBe(0.2);
    expect('yMin' in g).toBe(false);
    expect('xMax' in g).toBe(false);
  });

  it('drops any per-sample boundary, which was drawn against the old shape', () => {
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    // Unlink, then move it — the override is written by the edit that follows
    // the unlink, which is what `setGateLinked` exists to permit.
    useGates.getState().setGateLinked('s1', 'g1', false);
    useGates.getState().updateGate('s1', 'g1', { xMin: 0.4 } as Partial<Gate>);
    expect(useGates.getState().overrides.g1).toBeTruthy();

    useGates.getState().replaceGate('s1', 'g1', rect('f', 'x'));
    // Otherwise the unlinked sample keeps the old population under the new
    // name while every other sample moves — one population, two answers.
    expect(useGates.getState().overrides.g1).toBeUndefined();
  });

  it('selects what it redefined, so the new boundary is the one with handles', () => {
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    useGates.getState().selectGate(null);
    useGates.getState().replaceGate('s1', 'g1', rect('f', 'x'));
    expect(useGates.getState().selectedGateId).toBe('g1');
  });

  it('is one undo step', () => {
    useHistory.getState().reset();
    useGates.getState().addGate('s1', rect('g1', 'Lymphocytes'));
    const before = useHistory.getState().past.length;
    useGates.getState().replaceGate('s1', 'g1', range('f', 'x'));
    expect(useHistory.getState().past.length).toBe(before + 1);
  });
});

/* ==========================================================================
   Reconciling the unmixing wizard's gates — 2026-08-13.

   The store half of the duplicate-gate fix. `pruneReferenceGates` in
   `core/gating/referenceGates.ts` states the rule over one list; what is
   asserted here is the part only the store can be wrong about — that the same
   rule reaches the shared strategy, every forked sample's copy of it and the
   per-gate overrides, in one write.
   ========================================================================== */

describe('pruning the wizard\'s gates', () => {
  const ref = (id: string, name: string, parentId: string | null = null): Gate => ({
    ...rect(id, name, parentId), reference: true,
  });

  beforeEach(() => {
    useGates.setState({ shared: [], divergent: {}, overrides: {}, selectedGateId: null });
    useHistory.getState().reset();
  });

  it('does nothing, and reports nothing, when every wizard gate is named', () => {
    useGates.getState().addGate('s1', ref('cells', 'Cells'));
    const before = useGates.getState().shared;
    expect(useGates.getState().pruneReferenceGates(new Set(['cells']))).toBe(0);
    // By identity: a fresh array here is a fresh reference in every selector.
    expect(useGates.getState().shared).toBe(before);
  });

  it('removes the gates nothing points at and reports how many', () => {
    useGates.getState().addGate('s1', ref('cells', 'Cells'));
    useGates.getState().addGate('s1', ref('stale', 'CD8 +', 'cells'));
    useGates.getState().addGate('s1', ref('current', 'CD8 +', 'cells'));

    expect(useGates.getState().pruneReferenceGates(new Set(['cells', 'current']))).toBe(1);
    expect(useGates.getState().shared.map((g) => g.id)).toEqual(['cells', 'current']);
  });

  it('reaches a forked sample\'s copy, which is the one a filter would miss', () => {
    // A forked sample holds its own list — `addGate` writes to it rather than to
    // `shared` — so a prune that only walked the shared strategy would leave
    // exactly that sample still duplicating. Its ids are its own, because
    // `cloneStrategy` regenerates them, which is why the keep set is built from
    // what the fork actually holds.
    useGates.getState().addGate('s1', ref('cells', 'Cells'));
    useGates.getState().addGate('s1', ref('stale', 'CD8 +', 'cells'));
    useGates.getState().unlinkSample('s2');
    // The fork regenerates ids, so name the survivors by what the fork holds.
    const forked = useGates.getState().divergent.s2!;
    const keep = new Set([forked.find((g) => g.name === 'Cells')!.id, 'cells']);

    useGates.getState().pruneReferenceGates(keep);
    expect(useGates.getState().divergent.s2!.map((g) => g.name)).toEqual(['Cells']);
    expect(useGates.getState().shared.map((g) => g.id)).toEqual(['cells']);
  });

  it('takes a removed gate\'s per-sample boundaries with it', () => {
    // Or they sit in `overrides` keyed to a gate that no longer exists, ready to
    // be adopted by the next gate issued the same id — `removeGate`'s reasoning.
    useGates.getState().addGate('s1', ref('stale', 'CD8 +'));
    useGates.getState().setGateLinked('s1', 'stale', false);
    useGates.getState().updateGate('s1', 'stale', { xMin: 0.4 } as Partial<Gate>);
    expect(useGates.getState().overrides.stale).toBeTruthy();

    useGates.getState().pruneReferenceGates(new Set());
    expect(useGates.getState().overrides.stale).toBeUndefined();
  });

  it('does not clear a selection that survived', () => {
    useGates.getState().addGate('s1', ref('cells', 'Cells'));
    useGates.getState().addGate('s1', ref('stale', 'CD8 +'));
    useGates.getState().selectGate('cells');
    useGates.getState().pruneReferenceGates(new Set(['cells']));
    expect(useGates.getState().selectedGateId).toBe('cells');
  });

  it('clears a selection that did not, so nothing acts on a gate that is gone', () => {
    useGates.getState().addGate('s1', ref('stale', 'CD8 +'));
    useGates.getState().selectGate('stale');
    useGates.getState().pruneReferenceGates(new Set());
    expect(useGates.getState().selectedGateId).toBeNull();
  });

  it('is one undo step however many gates it takes', () => {
    useGates.getState().addGate('s1', ref('a', 'a'));
    useGates.getState().addGate('s1', ref('b', 'b'));
    useGates.getState().addGate('s1', ref('c', 'c'));
    const before = useHistory.getState().past.length;
    useGates.getState().pruneReferenceGates(new Set());
    expect(useHistory.getState().past.length).toBe(before + 1);
    // And one Ctrl+Z puts all three back.
    useHistory.getState().undo();
    expect(useGates.getState().shared).toHaveLength(3);
  });

  it('never touches a gate the operator drew', () => {
    useGates.getState().addGate('s1', rect('mine', 'Lymphocytes'));
    useGates.getState().pruneReferenceGates(new Set());
    expect(useGates.getState().shared.map((g) => g.id)).toEqual(['mine']);
  });
});

/* ==========================================================================
   A rename cannot produce two populations of one name (2026-08-17).

   The naming prompt has refused a duplicate since 2026-08-12, because every
   surface that identifies a population *by* name — the export's path column,
   the compare chart's picker, Statistics' grouping — then has two answers and
   no way to say so. `renameGate` did not, so double-clicking a row in the gate
   tree and typing the name of the population beside it made two.
   ========================================================================== */

describe('renameGate refuses a name already in use', () => {
  beforeEach(() => {
    useGates.setState({ shared: [], divergent: {}, overrides: {}, selectedGateId: null });
    useGates.getState().addGate('s1', rect('a', 'Lymphocytes'));
    useGates.getState().addGate('s1', rect('b', 'Monocytes'));
  });

  it('renames to a free name and says so', () => {
    expect(useGates.getState().renameGate('s1', 'b', 'Blasts')).toBe(true);
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['Lymphocytes', 'Blasts']);
  });

  it('refuses a taken name, writes nothing, and records no undo step', () => {
    const before = useHistory.getState().past.length;
    expect(useGates.getState().renameGate('s1', 'b', 'Lymphocytes')).toBe(false);
    expect(useGates.getState().gatesFor('s1').map((g) => g.name)).toEqual(['Lymphocytes', 'Monocytes']);
    // A refused action must not cost the user a press of Ctrl+Z that does
    // nothing — the same rule `sameState` enforces for a no-op button.
    expect(useHistory.getState().past.length).toBe(before);
  });

  it('matches trimmed and case-insensitively, as the naming prompt does', () => {
    expect(useGates.getState().renameGate('s1', 'b', '  lymphocytes ')).toBe(false);
  });

  it('lets a gate keep its own name, so committing an unchanged field works', () => {
    expect(useGates.getState().renameGate('s1', 'b', 'Monocytes')).toBe(true);
  });

  it('still substitutes a default for an empty name', () => {
    expect(useGates.getState().renameGate('s1', 'b', '   ')).toBe(true);
    expect(useGates.getState().gatesFor('s1')[1]!.name).toBe('Unnamed');
  });
});
