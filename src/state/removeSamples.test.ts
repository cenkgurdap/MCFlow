import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspace, type Sample } from './workspaceStore';

/* ==========================================================================
   Removing several samples at once — 2026-09-07.

   Reported as a gap rather than a fault: the list could be emptied a row at a
   time or all at once and there was nothing in between, so taking six tubes out
   of a plate of eight was six presses with the rows re-numbering underneath. The
   selection this panel already keeps is the answer, and `removeSamples` is the
   one action all three routes to it call — the row's own control, the context
   menu and the header button.

   What is asserted here is the part that is easy to get subtly wrong and
   invisible on screen: what the selection is left pointing at afterwards. A
   primary sample that no longer exists reads as "no sample" in every panel that
   asks, and an anchor that no longer exists makes the next Shift-click measure a
   range from nothing.
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

const ids = () => useWorkspace.getState().samples.map((s) => s.id);

beforeEach(() => {
  useWorkspace.setState({
    samples: ['a', 'b', 'c', 'd'].map(sample),
    groups: [],
    selectedSampleId: 'b',
    multiSelection: ['b', 'c'],
    selectionAnchor: 'b',
    failures: [],
  });
});

describe('removeSamples', () => {
  it('takes the whole batch out in one act', () => {
    useWorkspace.getState().removeSamples(['b', 'c']);
    expect(ids()).toEqual(['a', 'd']);
  });

  it('moves the shown sample to the first survivor when it was in the batch', () => {
    useWorkspace.getState().removeSamples(['b', 'c']);
    const w = useWorkspace.getState();
    expect(w.selectedSampleId).toBe('a');
    expect(w.multiSelection).toEqual([]);
    // A range must never measure from a row that is no longer in the list.
    expect(w.selectionAnchor).toBeNull();
  });

  it('leaves the shown sample alone when it survives', () => {
    useWorkspace.getState().removeSamples(['c', 'd']);
    const w = useWorkspace.getState();
    expect(w.selectedSampleId).toBe('b');
    expect(w.multiSelection).toEqual(['b']);
    expect(w.selectionAnchor).toBe('b');
  });

  it('renumbers the palette so the colours follow the rows that are left', () => {
    // `regroup` runs once for the batch rather than once per row, which is what
    // makes this one act and not four.
    useWorkspace.getState().removeSamples(['a', 'b']);
    expect(useWorkspace.getState().samples.map((s) => s.colorIndex)).toEqual([0, 1]);
  });

  it('is a no-op for an empty batch, or for ids that are not here', () => {
    useWorkspace.getState().removeSamples([]);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    useWorkspace.getState().removeSamples(['zz']);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(useWorkspace.getState().selectedSampleId).toBe('b');
  });

  it('removes one when handed one — `removeSample` is this with a single id', () => {
    useWorkspace.getState().removeSample('b');
    expect(ids()).toEqual(['a', 'c', 'd']);
    // The primary was the one removed, so it falls to the top of what is left.
    expect(useWorkspace.getState().selectedSampleId).toBe('a');
  });

  it('empties the list when the batch is everything', () => {
    useWorkspace.getState().removeSamples(['a', 'b', 'c', 'd']);
    const w = useWorkspace.getState();
    expect(w.samples).toEqual([]);
    expect(w.selectedSampleId).toBeNull();
    expect(w.multiSelection).toEqual([]);
    expect(w.selectionAnchor).toBeNull();
  });
});
