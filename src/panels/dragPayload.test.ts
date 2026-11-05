import { beforeEach, describe, expect, it } from 'vitest';
import {
  GATE_MIME, SAMPLE_MIME, isInternalDrag, readDragPayload, setDragPayload, useDragState,
  type DragPayload,
} from './dragPayload';
import { actionableSampleIds, useWorkspace, type Sample } from '@/state/workspaceStore';
import { makePanel, usePlot } from '@/state/plotStore';
import { openPanelsForSamples } from '@/state/layoutActions';
import type { FcsParameter, ParameterType } from '@/core/fcs/types';

/**
 * Minimal DataTransfer.
 *
 * vitest runs in node, where the real thing does not exist — and the browser's
 * own is deliberately crippled during `dragover` anyway, which is the behaviour
 * `isInternalDrag` exists to work around. Modelling the type list separately
 * from the data is what makes that distinction testable at all.
 */
class FakeDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = 'none';
  dropEffect = 'none';
  get types(): string[] { return [...this.store.keys()]; }
  setData(type: string, value: string) { this.store.set(type, value); }
  getData(type: string): string { return this.store.get(type) ?? ''; }
}

const dt = () => new FakeDataTransfer() as unknown as DataTransfer;

/* -------------------------------------------------------------------------
   Sample fixtures
   ------------------------------------------------------------------------- */

function param(index: number, name: string, type: ParameterType): FcsParameter {
  return {
    index, name, stain: '', label: name, bits: 32, range: 262_144,
    amplification: [0, 0], gain: null, voltage: null, type, isDataChannel: type !== 'Time',
  };
}

const PARAMS = [
  param(1, 'FSC-A', 'Forward_Scatter'),
  param(2, 'SSC-A', 'Side_Scatter'),
  param(3, 'B1-A', 'Raw_Fluorescence'),
];

function sample(id: string, name: string): Sample {
  return {
    id, name, fileName: `${name}.fcs`, filePath: null, fileSize: 1,
    parsed: {
      metadata: { parameters: PARAMS, eventCount: 100, parameterCount: 3 },
      data: new Float32Array(300),
      warnings: [],
    },
    detection: { type: 'conventional', reason: 'test', confidence: 1 },
    acquisitionOverride: null,
    identity: {},
    groupId: 'g',
    colorIndex: 0,
  } as unknown as Sample;
}

/* ========================================================================== */

describe('drag payload encoding', () => {
  it('round-trips a sample drag', () => {
    const t = dt();
    const payload: DragPayload = { kind: 'sample', sampleIds: ['a', 'b'] };
    setDragPayload(t, payload, '2 samples');
    expect(readDragPayload(t)).toEqual(payload);
  });

  it('round-trips a gate drag', () => {
    const t = dt();
    const payload: DragPayload = { kind: 'gate', sampleId: 's1', gateId: 'g1', gateName: 'Lymphocytes', colorIndex: 3 };
    setDragPayload(t, payload, 'Lymphocytes');
    expect(readDragPayload(t)).toEqual(payload);
  });

  it('uses a distinct MIME per kind, so dragover can tell them apart', () => {
    const s = dt();
    setDragPayload(s, { kind: 'sample', sampleIds: ['a'] }, 'a');
    expect(s.types).toContain(SAMPLE_MIME);
    expect(s.types).not.toContain(GATE_MIME);

    const g = dt();
    setDragPayload(g, { kind: 'gate', sampleId: 's', gateId: 'g', gateName: 'n', colorIndex: 0 }, 'n');
    expect(g.types).toContain(GATE_MIME);
    expect(g.types).not.toContain(SAMPLE_MIME);
  });

  it('also writes text/plain, so a drag out of the app carries a readable label', () => {
    const t = dt();
    setDragPayload(t, { kind: 'gate', sampleId: 's', gateId: 'g', gateName: 'CD4+', colorIndex: 1 }, 'CD4+');
    expect(t.getData('text/plain')).toBe('CD4+');
  });

  it('marks the drag as a copy — nothing is removed from the source', () => {
    const t = dt();
    setDragPayload(t, { kind: 'sample', sampleIds: ['a'] }, 'a');
    expect(t.effectAllowed).toBe('copy');
  });
});

describe('reading a foreign or broken drag', () => {
  it('returns null for a drag that is not ours', () => {
    const t = dt();
    t.setData('text/plain', 'hello');
    t.setData('Files', '');
    expect(readDragPayload(t)).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', () => {
    // A throw inside a drop handler is invisible and leaves the UI mid-drag.
    const t = dt();
    t.setData(SAMPLE_MIME, '{not json');
    expect(readDragPayload(t)).toBeNull();
  });

  it('rejects a payload of the right MIME but the wrong shape', () => {
    const t = dt();
    t.setData(SAMPLE_MIME, JSON.stringify({ kind: 'sample' }));
    expect(readDragPayload(t)).toBeNull();
  });
});

describe('isInternalDrag', () => {
  it('recognises our drags from the type list alone', () => {
    // The type list is all `dragover` exposes — getData is blank until drop.
    const s = dt();
    s.setData(SAMPLE_MIME, '{}');
    expect(isInternalDrag(s)).toBe(true);

    const g = dt();
    g.setData(GATE_MIME, '{}');
    expect(isInternalDrag(g)).toBe(true);
  });

  it('rejects an OS file drop, which must still reach the importer', () => {
    const t = dt();
    t.setData('Files', '');
    expect(isInternalDrag(t)).toBe(false);
  });

  it('tolerates a null dataTransfer', () => {
    expect(isInternalDrag(null)).toBe(false);
  });
});

describe('in-flight drag state', () => {
  beforeEach(() => useDragState.setState({ payload: null }));

  it('is empty at rest', () => {
    expect(useDragState.getState().payload).toBeNull();
  });

  it('holds the payload between dragstart and dragend', () => {
    useDragState.getState().begin({ kind: 'sample', sampleIds: ['a'] });
    expect(useDragState.getState().payload).toEqual({ kind: 'sample', sampleIds: ['a'] });
    useDragState.getState().end();
    expect(useDragState.getState().payload).toBeNull();
  });

  it('leaves nothing behind when a drag is cancelled', () => {
    // `dragend` fires for Escape and for a release over nothing, exactly as it
    // does for a completed drop — so cancelling clears through the same path.
    useDragState.getState().begin({ kind: 'gate', sampleId: 's', gateId: 'g', gateName: 'n', colorIndex: 0 });
    useDragState.getState().end();
    expect(useDragState.getState().payload).toBeNull();
  });
});

/* ==========================================================================
   Multi-select batch drop
   ========================================================================== */

describe('multi-selection', () => {
  const samples = [sample('s1', 'Control A1'), sample('s2', 'Control A2'), sample('s3', 'Control A3')];
  const order = ['s1', 's2', 's3'];

  beforeEach(() => {
    useWorkspace.setState({
      samples, groups: [], selectedSampleId: 's1', multiSelection: ['s1'], selectionAnchor: 's1',
    });
    const first = makePanel();
    usePlot.setState({ panels: [first], activePanelId: first.id });
  });

  it('a plain click collapses the selection to one', () => {
    useWorkspace.getState().toggleSampleInSelection('s2');
    useWorkspace.getState().selectSample('s3');
    // Otherwise a batch from three clicks ago silently rides along on the drag.
    expect(useWorkspace.getState().multiSelection).toEqual(['s3']);
  });

  it('ctrl-click adds and removes', () => {
    useWorkspace.getState().toggleSampleInSelection('s2');
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2']);
    useWorkspace.getState().toggleSampleInSelection('s2');
    expect(useWorkspace.getState().multiSelection).toEqual(['s1']);
  });

  it('hands the primary role on when the primary is deselected', () => {
    useWorkspace.getState().toggleSampleInSelection('s2');
    useWorkspace.getState().toggleSampleInSelection('s1');
    expect(useWorkspace.getState().selectedSampleId).toBe('s2');
  });

  it('shift-click selects the range and keeps the anchor primary', () => {
    useWorkspace.getState().extendSelectionTo('s3', ['s1', 's2', 's3']);
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2', 's3']);
    expect(useWorkspace.getState().selectedSampleId).toBe('s1');
  });

  it('extends upward as well as downward', () => {
    useWorkspace.getState().selectSample('s3');
    useWorkspace.getState().extendSelectionTo('s1', ['s1', 's2', 's3']);
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2', 's3']);
  });

  it('measures every shift-click from the same anchor, so a range can shrink', () => {
    /*
       The anchor does not move on a Shift-click, and that is what makes a range
       adjustable rather than a ratchet: Shift-clicking row 3 and then row 2
       selects 1–2. Re-anchoring on each Shift-click would select 2–3 and there
       would be no way back to a smaller range without starting over.
    */
    useWorkspace.getState().selectSample('s1');
    useWorkspace.getState().extendSelectionTo('s3', order);
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2', 's3']);
    useWorkspace.getState().extendSelectionTo('s2', order);
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2']);
    expect(useWorkspace.getState().selectionAnchor).toBe('s1');
  });

  it('takes its anchor from the last ctrl-click', () => {
    useWorkspace.getState().selectSample('s1');
    useWorkspace.getState().toggleSampleInSelection('s2');
    useWorkspace.getState().extendSelectionTo('s3', order);
    // From s2, not from s1 — which is where the last click was.
    expect(useWorkspace.getState().multiSelection).toEqual(['s2', 's3']);
  });

  it('does not follow the primary when a ctrl-click reassigns it', () => {
    /*
       The reason the anchor is a field of its own rather than `selectedSampleId`.
       Dropping the primary from the selection hands that role to whatever is
       left, which is right for the inspector — it must never show a sample
       outside the selection — and wrong for an anchor, which is a record of
       where the user last started.
    */
    useWorkspace.getState().selectSample('s3');
    useWorkspace.getState().toggleSampleInSelection('s1');
    useWorkspace.getState().toggleSampleInSelection('s3');
    expect(useWorkspace.getState().selectedSampleId).toBe('s1');
    expect(useWorkspace.getState().selectionAnchor).toBe('s3');
  });

  it('treats a shift-click with no reachable anchor as a plain click', () => {
    // A filter can hide the anchor, and a range measured from a row that is not
    // on screen is not a range anybody asked for.
    useWorkspace.setState({ selectedSampleId: null, multiSelection: [], selectionAnchor: null });
    useWorkspace.getState().extendSelectionTo('s2', order);
    expect(useWorkspace.getState().multiSelection).toEqual(['s2']);
    expect(useWorkspace.getState().selectionAnchor).toBe('s2');
  });

  it('pressing a row outside the selection makes it the selection', () => {
    useWorkspace.getState().extendSelectionTo('s3', order);
    useWorkspace.getState().pressSample('s2');
    expect(useWorkspace.getState().multiSelection).toEqual(['s1', 's2', 's3']);
    // Inside it, so the batch survives to whatever the press was for.
    useWorkspace.getState().pressSample('s2');
    expect(useWorkspace.getState().multiSelection).toHaveLength(3);
  });

  it('pressing a row inside the selection leaves the batch alone', () => {
    /*
       What closes the dead zone on the right of every row. The hover controls
       sit over the last ~70 px and consume the click, so a press there changed
       nothing at all — and the Shift-click after it measured from whatever had
       been selected before. Selecting on the press fixes that; leaving an
       in-selection press alone is what stops the reorder arrows collapsing the
       block they are about to move.
    */
    useWorkspace.setState({ multiSelection: ['s1', 's2'], selectedSampleId: 's1', selectionAnchor: 's1' });
    useWorkspace.getState().pressSample('s3');
    expect(useWorkspace.getState().multiSelection).toEqual(['s3']);
    expect(useWorkspace.getState().selectionAnchor).toBe('s3');
  });

  it('returns targets in sidebar order, not click order', () => {
    useWorkspace.getState().selectSample('s3');
    useWorkspace.getState().toggleSampleInSelection('s1');
    // Three replicates dragged out should tile in list order.
    expect(actionableSampleIds(useWorkspace.getState())).toEqual(['s1', 's3']);
  });

  it('acts on the grabbed row when it is outside the selection', () => {
    useWorkspace.getState().selectSample('s1');
    // Every file manager behaves this way: dragging an unselected row drags
    // that row, not the selection you forgot about.
    expect(actionableSampleIds(useWorkspace.getState(), 's3')).toEqual(['s3']);
  });

  it('falls back to the primary when nothing is multi-selected', () => {
    useWorkspace.setState({ multiSelection: [] });
    expect(actionableSampleIds(useWorkspace.getState())).toEqual(['s1']);
  });

  it('drops a batch as one panel per sample', () => {
    useWorkspace.getState().extendSelectionTo('s3', ['s1', 's2', 's3']);
    const ids = openPanelsForSamples(actionableSampleIds(useWorkspace.getState()));

    expect(ids).toHaveLength(3);
    const panels = usePlot.getState().panels;
    expect(panels).toHaveLength(4); // the original, plus one per dropped sample
    expect(panels.slice(1).map((p) => p.sampleId)).toEqual(['s1', 's2', 's3']);
  });

  it('pins every panel in a batch, so none of them drift with the sidebar', () => {
    openPanelsForSamples(['s1', 's2']);
    expect(usePlot.getState().panels.slice(1).every((p) => p.sampleId !== null)).toBe(true);
  });

  it('opens a batch at the root population', () => {
    openPanelsForSamples(['s1', 's2']);
    expect(usePlot.getState().panels.slice(1).every((p) => p.populationId === null)).toBe(true);
  });

  it('skips ids that are not in the workspace', () => {
    const ids = openPanelsForSamples(['s1', 'ghost']);
    expect(ids).toHaveLength(1);
  });
});
