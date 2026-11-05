import { beforeEach, describe, expect, it } from 'vitest';
import { emptySample } from '@/core/biophysics/pipeline';
import type { Gate } from '@/core/gating/types';
import { useGates } from './gateStore';
import { useDerived } from './derivedStore';
import { usePlot } from './plotStore';
import { useHistory } from './historyStore';
import { useBiophysics } from './biophysicsStore';

/* ==========================================================================
   *Discard setup* — what it removes, and what it must not.

   The end-to-end build belongs to an end-to-end test, which drives the real
   tracer over real files. What is left for a unit test is the part that
   is about the *rule* rather than about the data: which objects the action
   claims, which it leaves, and what happens to a gate somebody drew underneath
   one of them.

   That last one is the reason this file exists. `discardSetup` removes the cell
   gate, and a gate an operator drew under it is not the pipeline's to delete —
   an unscoped gate nests under whatever is selected in the tree, and *Cells*
   sitting at the root of every worksheet is exactly what tends to be selected.
   It has to survive, re-parented to the root. Nothing about that is visible in
   a count.

   The store state is installed directly rather than built by walking the
   pipeline: tracing a scatter contour needs real event data, and none of the
   claims below are about the tracer.
   ========================================================================== */

const rect = (id: string, name: string, parentId: string | null): Gate => ({
  id,
  name,
  parentId,
  colorIndex: 0,
  kind: 'rectangle',
  xParam: 0,
  yParam: 1,
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 1,
  linked: true,
} as unknown as Gate);

/**
 * A pipeline as it stands after Step 4: a cell gate, a doublet cut inside it,
 * two fitted population gates, a worksheet per sample and a derived parameter —
 * plus **one gate the operator drew**, under *Cells*, which is the survivor.
 */
function installPipeline() {
  const gates = [
    rect('cells', 'Cells', null),
    rect('singlets', 'Singlets', 'cells'),
    rect('live', 'Live', 'singlets'),
    rect('dead', 'Dead', 'singlets'),
    rect('mine', 'CD4', 'cells'),
  ];
  useGates.setState({ shared: gates, divergent: {}, overrides: { cells: { s1: {} as never } } });

  const a = usePlot.getState().addLayout('Sample 1', 'biophysics');
  const b = usePlot.getState().addLayout('Sample 2', 'biophysics');
  const cellTypes = usePlot.getState().addLayout('Cell types', 'biophysics');

  const parameterId = useDerived.getState().addDef('Membrane order', 'FL1-A / FL2-A');

  useBiophysics.setState({
    liveGateId: 'cells',
    singletGateId: 'singlets',
    parameterId,
    step: 4,
    walkIndex: 1,
    samples: [
      { ...emptySample('s1'), layoutId: a, populationGateIds: ['live', 'dead'], immuneLayoutId: cellTypes },
      { ...emptySample('s2'), layoutId: b, populationGateIds: [] },
    ],
  });
  return { parameterId, cellTypes };
}

function reset() {
  useGates.setState({ shared: [], divergent: {}, overrides: {}, selectedGateId: null });
  useDerived.setState({ defs: [] });
  useHistory.getState().reset();
  useBiophysics.setState({
    liveGateId: null, singletGateId: null, parameterId: null, samples: [], walkIndex: 0, step: 1,
  });
}

describe('discardSetup', () => {
  beforeEach(reset);

  it('removes the gates the pipeline placed', () => {
    installPipeline();
    const out = useBiophysics.getState().discardSetup();

    const ids = useGates.getState().shared.map((g) => g.id);
    expect(ids).not.toContain('cells');
    expect(ids).not.toContain('singlets');
    expect(ids).not.toContain('live');
    expect(ids).not.toContain('dead');
    expect(out.gates).toBe(4);
  });

  it('and leaves a gate the operator drew, re-parented to the root', () => {
    installPipeline();
    useBiophysics.getState().discardSetup();

    const mine = useGates.getState().shared.find((g) => g.id === 'mine');
    expect(mine).toBeDefined();
    // Its parent was *Cells*, which has gone — and *Cells* was itself at the
    // root, so it lifts all the way rather than to a gate that is also leaving.
    expect(mine!.parentId).toBeNull();
  });

  it('removes the worksheets, including the cell-type sheet no sample owns', () => {
    const { cellTypes } = installPipeline();
    useBiophysics.getState().discardSetup();

    const layouts = usePlot.getState().allLayouts();
    expect(layouts.some((l) => l.kind === 'biophysics')).toBe(false);
    expect(layouts.some((l) => l.id === cellTypes)).toBe(false);
    // Never the last one: something has to be left to draw on.
    expect(layouts.length).toBeGreaterThan(0);
  });

  it('removes the parameter it created, and clears its own bookkeeping', () => {
    const { parameterId } = installPipeline();
    useBiophysics.getState().discardSetup();

    expect(useDerived.getState().defs.some((d) => d.id === parameterId)).toBe(false);
    const s = useBiophysics.getState();
    expect(s.liveGateId).toBeNull();
    expect(s.singletGateId).toBeNull();
    expect(s.parameterId).toBeNull();
    expect(s.samples).toHaveLength(0);
    expect(s.walkIndex).toBe(0);
    // The overrides go with the gate they were keyed to, or the next gate
    // issued the same id silently adopts them.
    expect(useGates.getState().overrides.cells).toBeUndefined();
  });

  it('is one undo step, not one per object', () => {
    installPipeline();
    useHistory.getState().reset();
    useBiophysics.getState().discardSetup();

    expect(useHistory.getState().canUndo()).toBe(true);
    expect(useHistory.getState().undoLabel()).toBe('Discard biophysics setup');
  });

  it('does nothing at all on a pipeline that was never started', () => {
    const before = usePlot.getState().allLayouts().length;
    const out = useBiophysics.getState().discardSetup();

    expect(out).toEqual({ gates: 0, worksheets: 0 });
    expect(usePlot.getState().allLayouts()).toHaveLength(before);
    // And no undo entry: opening the panel, pressing nothing and pressing
    // Discard must not put a step on the stack for a workspace it did not touch.
    expect(useHistory.getState().canUndo()).toBe(false);
  });
});
