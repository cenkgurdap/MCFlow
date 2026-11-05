import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspace } from './workspaceStore';
import { useGates } from './gateStore';
import { usePlot } from './plotStore';
import { useSpectral } from './spectralStore';
import { notifyWorkspaceCleared, onWorkspaceCleared } from './workspaceCleared';
import type { Gate } from '@/core/gating/types';
import type { Sample } from './workspaceStore';

/* ==========================================================================
   2026-08-11, Item 9 — removing every sample is a reset.

   Driven through the stores rather than through the sidebar, because the claim
   is about state and not about a button: gates, worksheets and the unmixing
   wizard have to be gone whether the samples were removed all at once or one at
   a time, and a workspace restored afterwards has to survive the same call.
   ========================================================================== */

/** Just enough of a `Sample` for the list to hold it. */
function sample(id: string): Sample {
  return {
    id,
    name: id,
    fileName: `${id}.fcs`,
    filePath: `D:/${id}.fcs`,
    fileSize: 1,
    groupId: '',
    parsed: { metadata: { eventCount: 0, parameters: [] }, data: new Float32Array(0) },
    detection: { type: 'conventional', reason: '', evidence: [] },
    acquisitionOverride: null,
    identity: {},
    colorIndex: 0,
  } as unknown as Sample;
}

const gate = (id: string): Gate => ({
  id,
  name: id,
  parentId: null,
  colorIndex: 0,
  kind: 'range',
  xParam: 1,
  min: 0,
  max: 1,
} as Gate);

/** A workspace with samples, gates, a second worksheet and a wizard mid-walk. */
function populate() {
  useWorkspace.setState({
    samples: [sample('a'), sample('b')],
    groups: [],
    selectedSampleId: 'a',
    multiSelection: ['a'],
    selectionAnchor: 'a',
  });
  useGates.setState({
    shared: [gate('g1')],
    divergent: { b: [gate('g2')] },
    // A per-gate, per-sample boundary — the whole gate, as `resolveGates` reads it.
    overrides: { g1: { b: gate('g1') } },
    selectedGateId: 'g1',
    tool: 'polygon',
  });
  usePlot.getState().addLayout('Second');
  usePlot.getState().addPanel();
  useSpectral.setState({
    selectedIds: ['a'],
    controls: [{ sampleId: 'a', label: 'CD3', layoutId: 'L2' }] as never,
    step: 3,
    walkIndex: 1,
    generalGateId: 'g1',
    unmixed: { a: {} as never },
  });
}

describe('clearing the workspace', () => {
  beforeEach(() => {
    useWorkspace.setState({ samples: [], groups: [], selectedSampleId: null, multiSelection: [], selectionAnchor: null });
    useGates.getState().resetGating();
    usePlot.getState().resetLayouts();
  });

  it('removeAll drops the gate hierarchy, every fork and every override', () => {
    populate();
    expect(useGates.getState().shared).toHaveLength(1);

    useWorkspace.getState().removeAll();

    const g = useGates.getState();
    expect(g.shared).toEqual([]);
    expect(g.divergent).toEqual({});
    expect(g.overrides).toEqual({});
    expect(g.selectedGateId).toBeNull();
    // A tool left armed would draw on the first plot of the next experiment.
    expect(g.tool).toBe('none');
  });

  it('removeAll returns the worksheet to a single blank plot', () => {
    populate();
    expect(usePlot.getState().allLayouts().length).toBeGreaterThan(1);

    useWorkspace.getState().removeAll();

    const p = usePlot.getState();
    expect(p.panels).toHaveLength(1);
    expect(p.otherLayouts).toEqual({});
    expect(p.selectedPanelId).toBeNull();
    // A reference worksheet's name must not survive the controls that made it.
    expect(p.activeLayoutName).toBe('Main');
    expect(p.activeLayoutKind).toBeUndefined();
  });

  it('keeps the layout id, so a second window does not take its sibling’s', () => {
    populate();
    const before = usePlot.getState().activeLayoutId;
    useWorkspace.getState().removeAll();
    expect(usePlot.getState().activeLayoutId).toBe(before);
  });

  it('resets the unmixing wizard but keeps a loaded matrix', () => {
    populate();
    useSpectral.setState({
      spectra: [{ id: 's', label: 'CD3', values: new Float64Array(4), isAutofluorescence: false, sourceSampleId: null, eventCount: 1 }],
      loadedFrom: { path: 'p', name: 'Panel', savedAt: '2026-01-01' },
    });

    useWorkspace.getState().removeAll();

    const s = useSpectral.getState();
    // Everything that names a file is gone…
    expect(s.selectedIds).toEqual([]);
    expect(s.controls).toEqual([]);
    expect(s.step).toBe(1);
    expect(s.walkIndex).toBe(0);
    expect(s.generalGateId).toBeNull();
    expect(s.unmixed).toEqual({});
    // …and the matrix, which belongs to an instrument, is not.
    expect(s.spectra).toHaveLength(1);
    expect(s.loadedFrom?.name).toBe('Panel');
  });

  it('removing the last sample one row at a time ends in the same place', () => {
    populate();
    const ws = useWorkspace.getState();
    ws.removeSample('a');
    // Still one sample: nothing has been cleared yet.
    expect(useGates.getState().shared).toHaveLength(1);

    useWorkspace.getState().removeSample('b');
    expect(useWorkspace.getState().samples).toEqual([]);
    expect(useGates.getState().shared).toEqual([]);
    expect(usePlot.getState().panels).toHaveLength(1);
  });
});

describe('the bus itself', () => {
  it('detaches cleanly', () => {
    let calls = 0;
    const off = onWorkspaceCleared(() => { calls++; });
    notifyWorkspaceCleared();
    off();
    notifyWorkspaceCleared();
    expect(calls).toBe(1);
  });

  it('survives a listener that detaches itself mid-notification', () => {
    let calls = 0;
    const off = onWorkspaceCleared(() => { calls++; off(); });
    const off2 = onWorkspaceCleared(() => { calls++; });
    expect(() => notifyWorkspaceCleared()).not.toThrow();
    expect(calls).toBe(2);
    off2();
  });
});
