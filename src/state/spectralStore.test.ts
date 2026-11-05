import { beforeEach, describe, expect, it } from 'vitest';
import type { Gate, RangeGate } from '@/core/gating/types';
import type { ParsedFcs } from '@/core/fcs/types';
import { PANEL_GAP } from '@/core/layout/geometry';
import { defaultSpecFor, resolveGates, useGates, nextGateId } from './gateStore';
import { axisMinFor, parametersFor, sampleColumn, useDerived } from './derivedStore';
import { createTransform } from '@/core/transform';
import { DEFAULT_LAYOUT_ID, usePlot } from './plotStore';
import { gatedEventsFor, useSpectral } from './spectralStore';
import { useWorkspace, type Sample } from './workspaceStore';

/* ==========================================================================
   The five-step unmixing setup, at the store level.

   `spectral.test.ts` covers the maths — that a gated median differs from a
   percentile one, and by how much. `core/unmixing/wizard.test.ts` covers the
   step rules over plain data. What neither can cover is what the store actually
   *does*: that Step 1 starts empty and stays empty, that Step 2's roles survive
   a trip back and forth, that Step 3 really builds one layout per control with a
   shared general gate on all of them, and that a self-referencing bead control
   has its own negative population subtracted out of its endmember.
   ========================================================================== */

const D = 6;

/**
 * A control with a bright and a dim population, separable on detector `peak`.
 *
 * `spill` gives the dye a genuine presence in other detectors, as a fraction of
 * its peak. Off by default, because most of these tests want a signature with
 * one channel in it — but a dye that emits in exactly one detector cannot tell a
 * correct background subtraction from one performed at two hundred times the
 * right amplitude, since both leave a single spike standing. See
 * *subtracts the negative population in channel units*.
 */
function makeSample(id: string, name: string, peak: number, n = 400, spill: Record<number, number> = {}): Sample {
  const params = Array.from({ length: D + 2 }, (_, i) => ({
    index: i + 1,
    name: i < 2 ? (i === 0 ? 'FSC-A' : 'SSC-A') : `B${i - 1}-A`,
    stain: '',
    label: i < 2 ? (i === 0 ? 'FSC-A' : 'SSC-A') : `B${i - 1}-A`,
    bits: 32,
    range: 262144,
    amplification: [0, 0] as [number, number],
    gain: null,
    voltage: null,
    type: i < 2 ? ('Forward_Scatter' as const) : ('Raw_Fluorescence' as const),
    isDataChannel: true,
  }));

  const data = new Float32Array((D + 2) * n);
  for (let e = 0; e < n; e++) {
    /*
       Three quarters "cells" in a tight cloud, one quarter debris in a wide
       smear — so a general gate on scatter has something real to exclude.

       The proportions matter more than they look. When this fixture put half the
       events in each and gave the debris the *narrower* spread, the debris was
       the denser of the two clouds, and a contour gate — correctly — traced that
       one. Real scatter is not like that: debris is a smear and the cells are a
       cloud, which is exactly what makes a density contour the right instrument.
    */
    const isCell = e % 4 !== 3;
    // Two decorrelated hashes rather than `e % k` on both axes: the latter makes
    // FSC and SSC perfectly correlated, so the "cloud" is a diagonal line of
    // isolated points rather than a filled region — which a density contour
    // reads, correctly, as a dozen disconnected specks.
    const hx = ((e * 1103515245 + 12345) >>> 8) % 1000;
    const hy = ((e * 1664525 + 1013904223) >>> 8) % 1000;
    data[0 * n + e] = isCell ? 4200 + hx * 0.8 : 200 + hx * 1.5;
    data[1 * n + e] = isCell ? 3200 + hy * 0.8 : 150 + hy * 1.2;
    // Of the cells, one in eight is positive on this control's peak detector.
    const isPositive = isCell && e % 8 === 0;
    for (let d = 0; d < D; d++) {
      const base = 100 + d;
      data[(d + 2) * n + e] = isPositive
        ? (d === peak ? 9000 : base + (spill[d] ?? 0) * 9000)
        : base;
    }
  }

  const parsed: ParsedFcs = {
    metadata: {
      version: 'FCS3.1', keywords: {}, parameters: params,
      eventCount: n, parameterCount: D + 2,
      cytometer: 'Aurora', cytometerSerial: 'SN0001', instrument: null, operator: null,
      project: null, originalFilename: null, software: 'SpectroFlo 3.3.0',
      acquiredAt: null, beginTime: null, endTime: null, timestep: null, volume: null,
      spillover: null, compensationApplied: false,
      dataType: 'F', byteOrder: 'little', mode: 'L', nextData: 0,
    },
    data,
    warnings: [],
  };

  return {
    id, name, fileName: `${name}.fcs`, filePath: `D:/fake/${name}.fcs`, fileSize: 1,
    groupId: 'g', parsed,
    detection: { type: 'spectral', confidence: 'high', reason: 'test' } as never,
    acquisitionOverride: null,
    identity: { label: name, marker: null, fluorophore: null, isUnstained: /unstain/i.test(name), confidence: 'high' } as never,
    colorIndex: 0,
  };
}

/** A cells gate on FSC-A × SSC-A — the shape a general gate really takes. */
function cellsGate(): Gate {
  return {
    id: nextGateId(), name: 'Cells', parentId: null, colorIndex: 0,
    kind: 'rectangle', xParam: 0, yParam: 1,
    xMin: 1000, xMax: 1e9, yMin: 1000, yMax: 1e9,
  };
}

/**
 * A positive gate on a detector, with its bound in **display** space.
 *
 * Gates are stored in the coordinates the user drew in, and a fluorescence
 * parameter defaults to logicle — so a raw bound of 5000 would be compared
 * against a scale running roughly 0…1 and select nothing. The bound is
 * therefore converted through the same spec `gatedEventsFor` evaluates with.
 */
function positiveGate(sample: Sample, parentId: string | null, peakParam: number, name: string, rawMin = 5000): Gate {
  const min = createTransform(defaultSpecFor(sample.parsed, peakParam)).forward(rawMin);
  return {
    id: nextGateId(), name, parentId, colorIndex: 1,
    kind: 'range', xParam: peakParam, min, max: Number.POSITIVE_INFINITY,
  };
}

const reset = () => {
  useGates.setState({ shared: [], divergent: {}, overrides: {}, selectedGateId: null });
  usePlot.setState({
    panels: [], activePanelId: '', otherLayouts: {},
    activeLayoutId: DEFAULT_LAYOUT_ID, activeLayoutName: 'Layout 1',
  });
  useSpectral.setState({
    spectra: [], controls: [], selectedIds: [], step: 1, walkIndex: 0,
    generalGateId: null, computedAt: null, assignWidths: {},
    loadedFrom: null, weights: null, previewIds: [], unmixed: {}, failures: [],
  });
};

/** Select these samples and give them roles — Steps 1 and 2, in one line. */
function setUp(samples: Sample[], roles: Record<string, 'stain' | 'unstained' | 'autofluorescence'>, refs: Record<string, 'unstained' | 'self'> = {}) {
  const s = useSpectral.getState();
  s.setSelected(samples.map((x) => x.id));
  s.syncControls(samples);
  for (const sample of samples) {
    s.setControlRole(sample.id, roles[sample.id] ?? 'stain');
    if (refs[sample.id]) s.setControlReference(sample.id, refs[sample.id]!);
  }
}

/* ========================================================================== */

describe('Step 1 — explicit selection', () => {
  beforeEach(reset);

  it('starts with nothing selected, whatever the files are called', () => {
    /*
       The whole of the redesign, in one assertion.

       The panel this replaced ran `classifyControl` over every loaded sample and
       pre-assigned whatever "looked like" a control — so a filename containing
       "bead" or a marker/fluorophore pair became a reference control without
       anybody saying so, and an unstained file became the autofluorescence
       endmember on the strength of the word "unstained". Both names are in this
       fixture on purpose.
    */
    const a = makeSample('s1', '20250101-Beads-CD3 PerCP-Cy5.5', 0);
    const b = makeSample('s2', '20250101-Beads-Unstained', 1);
    useSpectral.getState().syncControls([a, b]);
    expect(useSpectral.getState().selectedIds).toEqual([]);
    expect(useSpectral.getState().controls).toEqual([]);
  });

  it('toggles a sample in and out', () => {
    const s = useSpectral.getState();
    s.toggleSelected('s1');
    expect(useSpectral.getState().selectedIds).toEqual(['s1']);
    s.toggleSelected('s1');
    expect(useSpectral.getState().selectedIds).toEqual([]);
  });

  it('cannot leave Step 1 with an empty selection', () => {
    expect(useSpectral.getState().stepCheck().ok).toBe(false);
    useSpectral.getState().toggleSelected('s1');
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
  });
});

/* ========================================================================== */

describe('Step 2 — roles, labels and reference modes', () => {
  beforeEach(reset);
  const a = makeSample('s1', 'CD3 file', 0);
  const b = makeSample('s2', 'Unstained file', 1);

  it('creates one row per selected sample, filled in and marked as suggested', () => {
    useSpectral.getState().setSelected(['s1', 's2']);
    useSpectral.getState().syncControls([a, b]);
    const controls = useSpectral.getState().controls;
    // Peak-detector order, baselines first — `s2` is the unstained file. The
    // rows used to arrive in sample-list order here and in detector order in
    // Step 3, which is the two-orders-for-one-list defect Item 1 names.
    expect(controls.map((c) => c.sampleId)).toEqual(['s2', 's1']);
    // Suggested from the filename, and every one of them says so — which is the
    // difference between this and the `classifyControl` that was deleted.
    expect(controls.map((c) => c.role)).toEqual(['unstained', 'stain']);
    expect(controls.every((c) => c.roleSource === 'suggested')).toBe(true);
    expect(controls.every((c) => c.labelSource === 'suggested')).toBe(true);
    expect(controls.map((c) => c.label)).toEqual(['Unstained file', 'CD3 file']);
  });

  it('defaults every stain to the unstained control when the panel has one', () => {
    useSpectral.getState().setSelected(['s1', 's2']);
    useSpectral.getState().syncControls([a, b]);
    expect(useSpectral.getState().controls[0]!.reference).toBe('unstained');
  });

  it('defaults every stain to Self when the panel has no unstained control', () => {
    // A panel with no unstained tube is almost always beads, and each bead tube
    // carries its own negative population.
    useSpectral.getState().setSelected(['s1']);
    useSpectral.getState().syncControls([a]);
    expect(useSpectral.getState().controls[0]!.reference).toBe('self');
  });

  it('re-derives the default when the Unstained role is assigned after the fact', () => {
    /*
       The stale-assumption case. Both rows arrive suggested as stains — nothing
       in "CD3 file" or "s2" says otherwise once the suggestion is only about the
       filename — so both default to Self. Naming one Unstained has to move the
       other, or the panel keeps the answer to a question that has changed.
    */
    const c = makeSample('s2', 'second stain', 1);
    useSpectral.getState().setSelected(['s1', 's2']);
    useSpectral.getState().syncControls([a, c]);
    expect(useSpectral.getState().controls.map((x) => x.reference)).toEqual(['self', 'self']);

    useSpectral.getState().setControlRole('s2', 'unstained');
    expect(useSpectral.getState().controls[0]!.reference).toBe('unstained');
  });

  it('leaves a reference mode the user set where they set it', () => {
    const c = makeSample('s2', 'second stain', 1);
    useSpectral.getState().setSelected(['s1', 's2']);
    useSpectral.getState().syncControls([a, c]);
    useSpectral.getState().setControlReference('s1', 'self');
    useSpectral.getState().setControlRole('s2', 'unstained');
    // s1 was set by hand; the re-derivation moves suggestions only. Found by
    // id rather than by position, because naming s2 Unstained moves it to the
    // front of the peak-detector order.
    const s1 = useSpectral.getState().controls.find((x) => x.sampleId === 's1')!;
    expect(s1.reference).toBe('self');
    expect(s1.referenceSource).toBe('user');
  });

  it('orders rows by peak detector, not by the order they were clicked', () => {
    useSpectral.getState().setSelected(['s2', 's1']);
    useSpectral.getState().syncControls([a, b]);
    // The unstained file first, then the stain: baselines lead the order
    // because a stain that takes its negative from one has to be walked after
    // it. Clicking order never enters into it.
    expect(useSpectral.getState().controls.map((c) => c.sampleId)).toEqual(['s2', 's1']);
  });

  it('keeps an assignment already made when the selection is re-synced', () => {
    // Going back to Step 1 to add a control must not clear the eight roles the
    // user has already chosen.
    setUp([a, b], { s1: 'stain', s2: 'unstained' });
    useSpectral.getState().relabelControl('s1', 'CD3 FITC');
    useSpectral.getState().syncControls([a, b]);
    const c = useSpectral.getState().controls.find((x) => x.sampleId === 's1')!;
    expect(c.role).toBe('stain');
    expect(c.label).toBe('CD3 FITC');
  });

  it('drops a row that has been de-selected', () => {
    setUp([a, b], { s1: 'stain', s2: 'unstained' });
    useSpectral.getState().toggleSelected('s2');
    useSpectral.getState().syncControls([a, b]);
    expect(useSpectral.getState().controls.map((c) => c.sampleId)).toEqual(['s1']);
  });

  it('blocks Step 2 until every row has a role', () => {
    useSpectral.getState().setSelected(['s1', 's2']);
    useSpectral.getState().syncControls([a, b]);
    useSpectral.setState({ step: 2 });
    // A suggestion is a role, so the step opens satisfied — clearing one is what
    // the block is for, and a row can still be cleared.
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
    useSpectral.getState().setControlRole('s1', null);
    expect(useSpectral.getState().stepCheck().ok).toBe(false);
    useSpectral.getState().setControlRole('s1', 'stain');
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
  });

  it('discards a negative gate when a control stops self-referencing', () => {
    // The negative gate belongs to a self-referencing control's own file.
    // Leaving it behind would let Step 3 report the control as complete on the
    // strength of a gate nothing reads.
    setUp([a], { s1: 'stain' }, { s1: 'self' });
    useSpectral.setState({
      controls: useSpectral.getState().controls.map((c) => ({ ...c, negativeGateId: 'g-neg' })),
    });
    useSpectral.getState().setControlReference('s1', 'unstained');
    expect(useSpectral.getState().controls[0]!.negativeGateId).toBeNull();
  });
});

/* ========================================================================== */

describe('Step 3 — one layout per control, on one shared general gate', () => {
  beforeEach(reset);
  const cd3 = makeSample('s1', 'CD3', 0);
  const cd8 = makeSample('s2', 'CD8', 3);
  const un = makeSample('s3', 'Unstained', 1);

  it('builds a layout per control, named after the typed identity', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().relabelControl('s1', 'CD3 FITC');
    useSpectral.getState().relabelControl('s2', 'CD8 APC');
    const r = useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    expect(r.built).toBe(3);
    const names = usePlot.getState().allLayouts().map((l) => l.name);
    expect(names).toContain('CD3 FITC');
    expect(names).toContain('CD8 APC');
    expect(useSpectral.getState().controls.every((c) => c.layoutId)).toBe(true);
  });

  it('measures each stain’s peak channel from its own data', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const byId = new Map(useSpectral.getState().controls.map((c) => [c.sampleId, c]));
    // Detector 0 and detector 3 are where the fixtures put their bright events;
    // parameter index is that plus the two scatter channels.
    expect(byId.get('s1')!.peak!.detector).toBe(0);
    expect(byId.get('s1')!.peak!.parameterIndex).toBe(2);
    expect(byId.get('s2')!.peak!.detector).toBe(3);
    expect(byId.get('s2')!.peak!.parameterIndex).toBe(5);
    // Baselines are measured too. They do not gate on a peak, but the column is
    // offered on every row and a blank on three rows of fourteen reads as a
    // failure rather than as an irrelevance.
    expect(byId.get('s3')!.peak).not.toBeNull();
  });

  it('honours a peak detector chosen by hand over the measurement', () => {
    setUp([cd3], { s1: 'stain' });
    // Detector 4 rather than the measured 0. Parameter index 6 — two scatter
    // channels in front of it.
    useSpectral.getState().setControlPeak(cd3, 6);
    useSpectral.getState().buildGatingLayouts([cd3]);
    const c = useSpectral.getState().controls[0]!;
    expect(c.peakSource).toBe('user');
    expect(c.peak!.parameterIndex).toBe(6);
    expect(c.peak!.detector).toBe(4);
  });

  it('drops the brackets when the peak detector moves', () => {
    // A bracket is a threshold on a detector. Left in place while the channel
    // changes it would keep counting events on the old one and keep satisfying
    // Step 3, while every plot in the layout showed the new one.
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    expect(useSpectral.getState().controls[0]!.positiveGateId).toBeTruthy();
    useSpectral.getState().setControlPeak(cd3, 6);
    expect(useSpectral.getState().controls[0]!.positiveGateId).toBeNull();
  });

  it('holds the controls in peak-detector order, baselines first', () => {
    /*
       The order is a property of `controls` rather than something each reader
       sorts for itself. That is Item 1: the Assign table, the worksheet tab
       strip, the layout dropdown and the walk are four listings of the same
       files, and three of them used to be in import order while the fourth was
       in detector order. Asserting it on the array is what makes the claim
       about all four at once.
    */
    setUp([cd8, cd3, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    expect(useSpectral.getState().controls.map((c) => c.sampleId)).toEqual(['s3', 's1', 's2']);
  });

  it('creates exactly one general gate and puts it on every control', () => {
    /*
       The mechanism, asserted rather than assumed.

       Gating in this app is shared across samples, so one gate in the shared
       hierarchy *is* the universal general gate — there is no replication step.
       What this replaced copied one control's whole strategy onto the others
       with `copyStrategy`, which produced eight independent gates with eight
       different ids, so "adjust the general gate" meant adjusting eight of them.
    */
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    const id = useSpectral.getState().generalGateId!;
    expect(id).toBeTruthy();
    for (const sampleId of ['s1', 's2', 's3']) {
      const gates = useGates.getState().gatesFor(sampleId);
      expect(gates.filter((g) => g.id === id)).toHaveLength(1);
    }
    // And exactly one gate exists in total, not one per control.
    expect(useGates.getState().shared.filter((g) => g.parentId === null)).toHaveLength(1);
  });

  it('unlinking the general gate moves one control’s boundary and no other’s', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const id = useSpectral.getState().generalGateId!;

    useSpectral.getState().unlinkGeneralGate('s1');
    useGates.getState().updateGate('s1', id, { xMin: 12345 } as never);

    const on = (sampleId: string) => {
      const { shared, divergent, overrides } = useGates.getState();
      return resolveGates(shared, divergent, overrides, sampleId).find((g) => g.id === id)!;
    };
    expect((on('s1') as { xMin: number }).xMin).toBe(12345);
    expect((on('s2') as { xMin: number }).xMin).not.toBe(12345);
    expect((on('s3') as { xMin: number }).xMin).not.toBe(12345);
    // The name and the parentage stay with the one hierarchy, which is what
    // keeps the population path comparable across controls.
    expect(on('s1').name).toBe(on('s2').name);
  });

  it('re-linking puts the control back on the shared boundary', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const id = useSpectral.getState().generalGateId!;
    useSpectral.getState().unlinkGeneralGate('s1');
    useGates.getState().updateGate('s1', id, { xMin: 999 } as never);
    useSpectral.getState().relinkGeneralGate('s1');

    const { shared, divergent, overrides } = useGates.getState();
    const g = resolveGates(shared, divergent, overrides, 's1').find((x) => x.id === id)!;
    expect((g as { xMin: number }).xMin).not.toBe(999);
    expect(g.linked).not.toBe(false);
  });

  it('re-running the build reuses each control’s existing layout', () => {
    // Adding a tenth control must not orphan the nine layouts the user has been
    // working in.
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const before = useSpectral.getState().controls.map((c) => c.layoutId).sort();
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    expect(useSpectral.getState().controls.map((c) => c.layoutId).sort()).toEqual(before);
  });

  /* ======================================================================
     Item 8 (2026-08-12) — toggling a control must not accumulate worksheets.

     Reported as the app "duplicating a layout" after going back and forth in
     the wizard a few times: remove the Autofluorescence control, re-add it,
     remove it again, and reference worksheets pile up. Every one of these
     drives the reported gesture rather than calling a cleanup directly, because
     what was wrong was that nothing reconciled the set — not that a reconciler
     was buggy.
     ====================================================================== */

  it('drops the worksheet of a control that has been taken out of the panel', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    expect(usePlot.getState().allLayouts().filter((l) => l.kind === 'reference')).toHaveLength(3);

    // Untick CD8 at Step 1 and come forward again.
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    const refs = usePlot.getState().allLayouts().filter((l) => l.kind === 'reference');
    expect(refs).toHaveLength(2);
    expect(refs.map((l) => l.name).sort()).toEqual(['CD3', 'Unstained']);
  });

  it('does not accumulate on repeated add/remove cycles of one control', () => {
    // The reported sequence, three times over. Before the fix this left six
    // reference worksheets, two of them named CD8 and inert.
    for (let i = 0; i < 3; i++) {
      setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
      useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
      setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
      useSpectral.getState().buildGatingLayouts([cd3, un]);
    }
    const refs = usePlot.getState().allLayouts().filter((l) => l.kind === 'reference');
    expect(refs).toHaveLength(2);
    // And no two of them share a name, which is how the duplicate was seen.
    expect(new Set(refs.map((l) => l.name)).size).toBe(refs.length);
  });

  it('re-adding a control gives it exactly one worksheet, not a second', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    const refs = usePlot.getState().allLayouts().filter((l) => l.kind === 'reference');
    expect(refs.filter((l) => l.name === 'CD8')).toHaveLength(1);
    expect(refs).toHaveLength(3);
    // Every control points at a worksheet that still exists.
    const ids = new Set(refs.map((l) => l.id));
    for (const c of useSpectral.getState().controls) expect(ids.has(c.layoutId!)).toBe(true);
  });

  /* ======================================================================
     2026-08-13 — the same thing one level down: toggling a control must not
     accumulate *gates*.

     Reported after the worksheets stopped duplicating. Three brackets called
     "Autofluorescence clean" stacked on one histogram at three
     percentages; two "CD4 PE-Fire 744 +" labels drawn over each other with two
     entries in the tree. Every one of these drives the reported gesture —
     untick at Step 1, come forward, go back, re-tick — rather than calling the
     reconciliation directly, because what was wrong is that nothing reconciled
     the set.
     ====================================================================== */

  /** The wizard's own gates on one control's file, which is what the plot draws. */
  const refGatesOn = (sampleId: string) =>
    useGates.getState().gatesFor(sampleId).filter((g) => g.reference);

  it('re-adding a stain gives it exactly one bracket, not a second', () => {
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    // One bracket on CD8's own file — the general gate is shared and unowned,
    // so it is counted separately below.
    const own = refGatesOn('s2').filter((g) => g.ownerSampleId === 's2');
    expect(own).toHaveLength(1);
    // And it is the one the assignment names, not a survivor of the first pass.
    const control = useSpectral.getState().controls.find((c) => c.sampleId === 's2')!;
    expect(own[0]!.id).toBe(control.positiveGateId);
  });

  it('re-adding a baseline gives it exactly one clean gate', () => {
    // The Autofluorescence control in the report. A baseline is seeded by the
    // build rather than by `ensureGated`, so it duplicated by a different route
    // and had to be pinned separately.
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    const own = refGatesOn('s3').filter((g) => g.ownerSampleId === 's3');
    expect(own).toHaveLength(1);
    expect(own[0]!.name).toContain('clean');
    expect(own[0]!.id).toBe(useSpectral.getState().controls.find((c) => c.sampleId === 's3')!.positiveGateId);
  });

  it('does not accumulate gates over repeated add/remove cycles', () => {
    // The reported sequence, three times over, on a stain and a baseline at
    // once. Before the fix this left three brackets on each and two labels
    // drawn over each other on every histogram.
    for (let i = 0; i < 3; i++) {
      setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
      useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
      setUp([cd3], { s1: 'stain' });
      useSpectral.getState().buildGatingLayouts([cd3]);
    }
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    for (const id of ['s1', 's2', 's3']) {
      expect(refGatesOn(id).filter((g) => g.ownerSampleId === id)).toHaveLength(1);
    }
    // One general gate, still, and every control still under it.
    const cells = useGates.getState().shared.filter((g) => g.reference && !g.ownerSampleId);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.id).toBe(useSpectral.getState().generalGateId);
  });

  it('leaves no wizard gate behind for a control that is gone for good', () => {
    // The tree in the report listed a control's bracket on a worksheet that was
    // not its own, because the "shared across all samples" view is unfiltered.
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    expect(useGates.getState().shared.some((g) => g.ownerSampleId === 's2')).toBe(false);
  });

  it('every gate the setup names still exists after a rebuild', () => {
    // The other half of the same property: a reconciliation that removed too
    // much would leave a control pointing at nothing and Step 4 refusing it.
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' }, { s2: 'self' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' }, { s2: 'self' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);

    for (const c of useSpectral.getState().controls) {
      const gates = useGates.getState().gatesFor(c.sampleId);
      for (const id of [c.positiveGateId, c.negativeGateId]) {
        if (id) expect(gates.some((g) => g.id === id)).toBe(true);
      }
    }
    // A self-referencing control has both, and both survived.
    const beads = useSpectral.getState().controls.find((c) => c.sampleId === 's2')!;
    expect(beads.negativeGateId).toBeTruthy();
  });

  it('does not put a baseline gate back after the operator cleared it', () => {
    /*
       The second route to two "Autofluorescence clean" gates, and the one that
       needed no removed control at all. "Cells (whole gated sample)" is a
       legitimate answer for a baseline — `ensureGated` has always respected it
       — but the *build* seeded unconditionally, and the build runs again every
       time Step 2 is left. So stepping back to fix a label put the gate
       straight back on top of the decision, and left the cleared one beside it.
    */
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    useSpectral.getState().setControlGate('s3', null);

    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    expect(useSpectral.getState().controls.find((c) => c.sampleId === 's3')!.positiveGateId).toBeNull();
    // And the cleared one is not left lying in the tree either.
    expect(refGatesOn('s3').filter((g) => g.ownerSampleId === 's3')).toHaveLength(0);
  });

  it('leaves a gate the operator drew on a reference worksheet alone', () => {
    // Nothing anybody draws carries `reference`, so the reconciliation has
    // nothing to say about it — including one drawn under a bracket that goes.
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const bracket = useSpectral.getState().controls.find((c) => c.sampleId === 's2')!.positiveGateId!;
    const mine = positiveGate(cd8, bracket, 4, 'Bright subset');
    useGates.getState().addGate('s2', mine);

    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    const kept = useGates.getState().shared.find((g) => g.id === mine.id);
    expect(kept).toBeTruthy();
    // Lifted to where the removed bracket hung rather than deleted with it.
    expect(kept!.parentId).toBe(useSpectral.getState().generalGateId);
  });

  it('never removes a general layout, whatever it is called', () => {
    // A general layout is somebody's own work. The rule is scoped to `kind`,
    // not to the name, so one a user happened to call "CD8" is untouched.
    setUp([cd3, cd8, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, cd8, un]);
    const mine = usePlot.getState().addLayout('CD8');

    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    expect(usePlot.getState().allLayouts().some((l) => l.id === mine)).toBe(true);
  });

  it('gives every control scatter, histogram and spectrum', () => {
    /*
       Three plots on a baseline too, as of 2026-08-08. A baseline has no
       positive population to find and that is not what the histogram is for:
       it is where a distribution is looked at, and an unstained tube is exactly
       the file whose dead cells somebody may want out of the autofluorescence
       signature.
    */
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    const byName = new Map(usePlot.getState().allLayouts().map((l) => [l.name, l]));
    expect(byName.get('CD3')!.panels.map((p) => p.plotType)).toEqual(['density', 'histogram', 'spectrum']);
    expect(byName.get('Unstained')!.panels.map((p) => p.plotType)).toEqual(['density', 'histogram', 'spectrum']);
  });

  it('seeds a baseline with one clean-population gate, not a positive/negative pair', () => {
    /*
       Reverses the 2026-08-08 behaviour asserted above, which left a baseline's
       histogram empty on the grounds that the refinement is offered rather than
       demanded. Offered is right; *absent* was the mistake, because it left the
       operator drawing from scratch on the one tube whose debris ends up in the
       matrix. What it gets is a single interval around the main distribution —
       **not** the threshold-and-everything-above a stain gets, since nothing on
       this tube is stained and there is no positive population for a bracket to
       separate.
    */
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);

    const baseline = useSpectral.getState().controls.find((c) => c.sampleId === 's3')!;
    expect(baseline.positiveGateId).not.toBeNull();
    // One gate, not two: a baseline never gets a negative.
    expect(baseline.negativeGateId).toBeNull();

    const gate = useGates.getState().gatesFor('s3').find((g) => g.id === baseline.positiveGateId)!;
    expect(gate.kind).toBe('range');
    expect(gate.name).toContain('clean');
    // Bounded at both ends, which is the whole distinction from a stain's seed —
    // that one is `max: +Infinity`.
    const range = gate as Extract<typeof gate, { kind: 'range' }>;
    expect(Number.isFinite(range.min)).toBe(true);
    expect(Number.isFinite(range.max)).toBe(true);
    expect(range.max).toBeGreaterThan(range.min);
    // And it belongs to this file alone, like every other seeded gate.
    expect(gate.ownerSampleId).toBe('s3');
    expect(useGates.getState().gatesFor('s1').some((g) => g.id === gate.id)).toBe(false);
  });

  it('does not re-seed a baseline gate the user has cleared', () => {
    // `ensureGated` tops up single stains on every move of the walk, because a
    // stain must not be left ungated. A baseline's gate is a refinement and
    // "the whole gated sample" is a legitimate answer, so putting it back would
    // overwrite a choice rather than make one.
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    useSpectral.getState().setControlGate('s3', null);
    useSpectral.getState().ensureGated([cd3, un]);
    expect(useSpectral.getState().controls.find((c) => c.sampleId === 's3')!.positiveGateId).toBeNull();
  });

  it('stacks the panels in one column, with the two spectra side by side', () => {
    /*
       The order is the instruction — scatter, then the peak channel, then the
       spectrum of what those brackets selected — so the coordinates are stated
       rather than flowed by the worksheet's automatic placement.

       The third row is two plots wide on a self-referencing control: the
       negative population's spectrum on the left and the positive one's on the
       right, in the order the two gates sit in on the histogram above them.
    */
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    const panels = usePlot.getState().allLayouts().find((l) => l.name === 'CD3')!.panels;
    expect(panels.map((p) => p.plotType)).toEqual(['density', 'histogram', 'spectrum', 'spectrum']);
    expect(panels.map((p) => p.x)).toEqual([0, 0, 0, panels[2]!.w + PANEL_GAP]);
    expect(panels[0]!.y).toBeLessThan(panels[1]!.y);
    expect(panels[1]!.y).toBeLessThan(panels[2]!.y);
    // Same row, so they read as a pair rather than as a fourth step.
    expect(panels[3]!.y).toBe(panels[2]!.y);
  });

  it('pins every panel in a control’s layout to that control', () => {
    // There is no separate negative-reference panel any more. A self-referencing
    // control's negative is a second bracket on this same histogram, and a
    // control referencing a separate unstained tube reads that tube on its own
    // layout, one step earlier in the same walk.
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    const layout = usePlot.getState().allLayouts().find((l) => l.name === 'CD3')!;
    expect(layout.panels.every((p) => p.sampleId === 's1')).toBe(true);
  });

  it('scopes the two spectra to the negative and the positive population', () => {
    // Neither is scoped to the general gate: a spectrum of the whole control is
    // the same picture on every stain's worksheet, which is exactly the plot
    // that cannot answer the question these are here to answer.
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    const panels = usePlot.getState().allLayouts().find((l) => l.name === 'CD3')!.panels;
    const spectra = panels.filter((p) => p.plotType === 'spectrum');
    const control = useSpectral.getState().controls[0]!;
    expect(spectra.map((p) => p.populationId))
      .toEqual([control.negativeGateId, control.positiveGateId]);
    expect(spectra.some((p) => p.populationId === useSpectral.getState().generalGateId)).toBe(false);
  });

  it('leaves a control with no negative population one spectrum', () => {
    // The pair is the self-referencing case. A stain that reads its negative off
    // a separate unstained tube has nothing on *this* file to plot, and an empty
    // second panel would claim otherwise.
    setUp([cd3, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().setControlReference('s1', 'unstained');
    useSpectral.getState().buildGatingLayouts([cd3, un]);
    const panels = usePlot.getState().allLayouts().find((l) => l.name === 'CD3')!.panels;
    expect(panels.filter((p) => p.plotType === 'spectrum')).toHaveLength(1);
  });

  it('seeds the negative and positive brackets with a gap between them', () => {
    /*
       The two used to meet at one threshold, which put the dim half of the
       positive population inside the negative reference. Each gate now takes the
       outer half of its own population — see `bracketOn` — so there is a stretch
       of the axis in neither, which is where a misplaced threshold does its
       damage.
    */
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    const control = useSpectral.getState().controls[0]!;
    const gates = useGates.getState().gatesFor('s1');
    const positive = gates.find((g) => g.id === control.positiveGateId) as RangeGate;
    const negative = gates.find((g) => g.id === control.negativeGateId) as RangeGate;
    expect(negative.max).toBeLessThan(positive.min);
  });

  it('seeds the general gate as an editable polygon around the cloud', () => {
    /*
       Item 5. The box this replaced took the 2nd-to-92nd percentile of each axis
       independently, which is a rectangle around the population's *bounding*
       extent — on real scatter it enclosed the debris corner, because a debris
       corner moves the low percentile on both axes at once.
    */
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    const id = useSpectral.getState().generalGateId!;
    const gate = useGates.getState().gatesFor('s1').find((g) => g.id === id)!;
    expect(gate.kind).toBe('polygon');
    expect((gate as { vertices: unknown[] }).vertices.length).toBeGreaterThan(6);
    // Nothing about it is special: no flag, no lock, no separate kind.
    expect(gate.linked).not.toBe(false);
  });

  it('gates the cell cloud and leaves the debris smear outside', () => {
    /*
       Asserted on the *events*, not on the count. A gate holding 300 of 400
       events could be the right 300 or a boundary that happens to catch 300 of
       the wrong ones, and only one of those is the claim being made — that a
       traced contour excludes the debris a bounding box could not.
    */
    setUp([cd3], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([cd3]);
    const inside = gatedEventsFor(cd3, useSpectral.getState().generalGateId)!;
    const n = cd3.parsed.metadata.eventCount;
    const fsc = (e: number) => cd3.parsed.data[0 * n + e]!;

    expect(inside.length).toBeGreaterThan(0);
    // Every gated event is from the cloud, which starts at 4000.
    expect([...inside].every((e) => fsc(e) >= 4000)).toBe(true);
    // And most of the cloud is in it.
    const cells = Array.from({ length: n }, (_, e) => e).filter((e) => fsc(e) >= 4000);
    expect(inside.length / cells.length).toBeGreaterThan(0.6);
  });
});

/* ========================================================================== */

describe('bracket gates — placed on arrival, never re-placed', () => {
  beforeEach(reset);

  it('the build itself seeds a range gate on the peak detector', () => {
    // Item 7: there is no button. Reaching Step 3 is what gates the controls.
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);

    const control = useSpectral.getState().controls[0]!;
    expect(control.positiveGateId).toBeTruthy();
    expect(control.gateOrigin).toBe('auto');
    const gate = useGates.getState().gatesFor('s1').find((g) => g.id === control.positiveGateId)!;
    expect(gate.kind).toBe('range');
    expect(gate.xParam).toBe(4);
  });

  it('parents the seeded gate under the general gate', () => {
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);
    const { generalGateId, controls } = useSpectral.getState();
    const gate = useGates.getState().gatesFor('s1').find((g) => g.id === controls[0]!.positiveGateId)!;
    expect(gate.parentId).toBe(generalGateId);
  });

  it('refuses to gate a baseline control', () => {
    const s = makeSample('s1', 'Unstained', 0);
    setUp([s], { s1: 'unstained' });
    expect(useSpectral.getState().autoGateControl(s)).toBeNull();
  });

  it('seeds a negative bracket too, but only for a self-referencing control', () => {
    const beads = makeSample('s1', 'Beads', 2);
    setUp([beads], { s1: 'stain' }, { s1: 'self' });
    useSpectral.getState().buildGatingLayouts([beads]);

    const c = useSpectral.getState().controls[0]!;
    expect(c.negativeGateId).toBeTruthy();
    const neg = useGates.getState().gatesFor('s1').find((g) => g.id === c.negativeGateId)!;
    const pos = useGates.getState().gatesFor('s1').find((g) => g.id === c.positiveGateId)!;
    /*
       The pair leaves a gap rather than meeting (2026-08-15).

       They used to share one number, so every event was in one bracket or the
       other — which put the dim half of the positive population inside the
       negative reference. Each now takes the outer half of its own population
       and the events between are in neither. See `bracketOn`.
    */
    expect((neg as { max: number }).max).toBeLessThan((pos as { min: number }).min);
    // Both on the same histogram, which is the point — two populations in one
    // distribution, with the gap between them visible.
    expect(neg.xParam).toBe(pos.xParam);
  });

  it('does not seed a negative bracket for a control that references an unstained sample', () => {
    const s = makeSample('s1', 'CD3', 2);
    const un = makeSample('s2', 'Unstained', 1);
    setUp([s, un], { s1: 'stain', s2: 'unstained' });
    useSpectral.getState().buildGatingLayouts([s, un]);
    expect(useSpectral.getState().controls.find((c) => c.sampleId === 's1')!.negativeGateId).toBeNull();
  });

  it('seeds its bound in display space, so the gate actually selects events', () => {
    /*
       The bug this exists to prevent, kept from the previous test suite because
       it is the one that mattered: `autoGateBound` returns a threshold in **raw**
       channel units and gates are stored in display space. Writing the raw value
       straight in compared 29 687 against a logicle scale running 0…1 on a real
       Aurora control, so every seeded gate selected zero events and the matrix
       could never be computed.
    */
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);
    const events = gatedEventsFor(s, useSpectral.getState().controls[0]!.positiveGateId);
    expect(events).not.toBeNull();
    expect(events!.length).toBeGreaterThan(0);
  });

  it('ensureGated does nothing when the build has already gated everything', () => {
    const a = makeSample('s1', 'CD3', 0);
    const b = makeSample('s2', 'CD8', 3);
    const un = makeSample('s3', 'Unstained', 1);
    setUp([a, b, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([a, b, un]);
    expect(useSpectral.getState().ensureGated([a, b, un])).toBe(0);
  });

  it('ensureGated seeds a control whose brackets were dropped', () => {
    const a = makeSample('s1', 'CD3', 0);
    const b = makeSample('s2', 'CD8', 3);
    setUp([a, b], { s1: 'stain', s2: 'stain' });
    useSpectral.getState().buildGatingLayouts([a, b]);
    // Which is what changing a peak detector does.
    useSpectral.getState().setControlPeak(a, 6);
    expect(useSpectral.getState().ensureGated([a, b])).toBe(1);
    expect(useSpectral.getState().controls.find((c) => c.sampleId === 's1')!.positiveGateId).toBeTruthy();
  });

  it('re-seeds a stain whose bracket was deleted from the tree', () => {
    /*
       2026-08-13, the other direction of the duplicate-gate investigation. The
       build reconciles gates against the assignments; nothing reconciled an
       assignment against the gates, so deleting a bracket from the tree — which
       is exactly what somebody reaches for on seeing two of them — left the id
       behind. `controlIsGated` reads that id and reported the control as done,
       and Step 4 then refused it over a gate that was not there.
    */
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);
    const seeded = useSpectral.getState().controls[0]!.positiveGateId!;
    useGates.getState().removeGate('s1', seeded);

    expect(useSpectral.getState().ensureGated([s])).toBe(1);
    const now = useSpectral.getState().controls[0]!.positiveGateId!;
    expect(now).not.toBe(seeded);
    expect(useGates.getState().gatesFor('s1').some((g) => g.id === now)).toBe(true);
  });

  it('clears a baseline\'s deleted gate without putting one back', () => {
    // Same check, opposite answer: a baseline's gate is offered rather than
    // required, so deleting it *is* "measure the whole gated population".
    const s = makeSample('s1', 'CD3', 2);
    const un = makeSample('s3', 'Unstained', 1);
    setUp([s, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([s, un]);
    const clean = useSpectral.getState().controls.find((c) => c.sampleId === 's3')!.positiveGateId!;
    useGates.getState().removeGate('s3', clean);

    useSpectral.getState().ensureGated([s, un]);
    const baseline = useSpectral.getState().controls.find((c) => c.sampleId === 's3')!;
    expect(baseline.positiveGateId).toBeNull();
    expect(baseline.gateOrigin).toBeNull();
  });

  it('leaves a control whose gates are all present untouched', () => {
    // The check must cost nothing in the ordinary case — this runs on arrival
    // at Step 3 and on every move of the walk.
    const a = makeSample('s1', 'CD3', 0);
    const un = makeSample('s3', 'Unstained', 1);
    setUp([a, un], { s1: 'stain', s3: 'unstained' });
    useSpectral.getState().buildGatingLayouts([a, un]);
    const before = useSpectral.getState().controls;
    expect(useSpectral.getState().ensureGated([a, un])).toBe(0);
    expect(useSpectral.getState().controls).toBe(before);
  });

  it('never re-places a bracket that already exists', () => {
    // The whole safety property of gating with no button: a bracket somebody has
    // dragged is the answer to the question the step exists to ask.
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);
    const id = useSpectral.getState().controls[0]!.positiveGateId;
    useGates.getState().updateGate('s1', id!, { min: 0.9 } as never);

    useSpectral.getState().ensureGated([s]);
    expect(useSpectral.getState().controls[0]!.positiveGateId).toBe(id);
    const gate = useGates.getState().gatesFor('s1').find((g) => g.id === id)!;
    expect((gate as { min: number }).min).toBe(0.9);
  });

  it('a seeded gate is an ordinary gate the user can replace', () => {
    const s = makeSample('s1', 'CD3', 2);
    setUp([s], { s1: 'stain' });
    useSpectral.getState().buildGatingLayouts([s]);
    const seeded = useSpectral.getState().controls[0]!.positiveGateId!;

    const own = positiveGate(s, useSpectral.getState().generalGateId, 4, 'CD3 + (mine)');
    useGates.getState().addGate('s1', own);
    useSpectral.getState().setControlGate('s1', own.id);

    expect(useSpectral.getState().controls[0]!.positiveGateId).toBe(own.id);
    expect(useSpectral.getState().controls[0]!.gateOrigin).toBe('user');
    // The seeded gate is still in the tree — replacing the *assignment* is not
    // the same as deleting a gate, and silently removing one would be worse.
    expect(useGates.getState().gatesFor('s1').some((g) => g.id === seeded)).toBe(true);
  });
});

/* ========================================================================== */

describe('Step 4 — computeMatrix', () => {
  beforeEach(reset);
  const a = makeSample('s1', 'CD3', 0);
  const b = makeSample('s2', 'CD8', 3);
  const un = makeSample('s3', 'Unstained', 1);

  /** Steps 1–3 with hand-drawn gates, so the compute step is what is under test. */
  function gateAll(refs: Record<string, 'unstained' | 'self'> = {}) {
    setUp([a, b, un], { s1: 'stain', s2: 'stain', s3: 'unstained' }, refs);
    const general = cellsGate();
    useGates.getState().addGate('s1', general);
    useSpectral.setState({ generalGateId: general.id });
    for (const [sample, peakParam] of [[a, 2], [b, 5]] as const) {
      const g = positiveGate(sample, general.id, peakParam, `${sample.name} +`);
      useGates.getState().addGate(sample.id, g);
      useSpectral.getState().setControlGate(sample.id, g.id);
    }
    return general;
  }

  it('refuses while any fluorophore is ungated, and names it', () => {
    setUp([a, b, un], { s1: 'stain', s2: 'stain', s3: 'unstained' });
    useSpectral.getState().relabelControl('s2', 'CD8 APC');
    const r = useSpectral.getState().computeMatrix([a, b, un]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('CD8 APC');
  });

  it('refuses with no stains assigned at all', () => {
    setUp([un], { s3: 'unstained' });
    const r = useSpectral.getState().computeMatrix([un]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/single-stain/i);
  });

  it('builds one endmember per control from the gated events', () => {
    gateAll();
    expect(useSpectral.getState().computeMatrix([a, b, un]).ok).toBe(true);
    const spectra = useSpectral.getState().spectra;
    expect(spectra).toHaveLength(3);
    expect(spectra.filter((s) => s.isAutofluorescence)).toHaveLength(1);
    // Autofluorescence last, so the unmixed parameter order stays stable.
    expect(spectra[spectra.length - 1]!.isAutofluorescence).toBe(true);
    expect(spectra.filter((s) => !s.isAutofluorescence).every((s) => s.source === 'gated')).toBe(true);
  });

  it('each stain’s signature peaks on its own detector', () => {
    gateAll();
    useSpectral.getState().computeMatrix([a, b, un]);
    const peakOf = (label: string) => {
      const values = useSpectral.getState().spectra.find((s) => s.label === label)!.values;
      let best = 0;
      for (let i = 1; i < values.length; i++) if (values[i]! > values[best]!) best = i;
      return best;
    };
    expect(peakOf('CD3')).toBe(0);
    expect(peakOf('CD8')).toBe(3);
  });

  it('subtracts a self-referencing control’s own negative population', () => {
    /*
       What `reference: 'self'` means at the maths.

       A bead control's positive population sits on top of the same background
       its negative population is made of, so the raw positive median describes
       the dye *plus* the bead. This fixture puts a flat 100+d background under
       every detector, so subtracting the negative should flatten every
       off-peak channel to zero while leaving the peak standing.
    */
    const general = gateAll({ s1: 'self' });
    const neg: Gate = {
      id: nextGateId(), name: 'CD3 −', parentId: general.id, colorIndex: 2,
      kind: 'range', xParam: 2,
      min: Number.NEGATIVE_INFINITY,
      max: createTransform(defaultSpecFor(a.parsed, 2)).forward(5000),
    };
    useGates.getState().addGate('s1', neg);
    useSpectral.setState({
      controls: useSpectral.getState().controls.map((c) => (c.sampleId === 's1' ? { ...c, negativeGateId: neg.id } : c)),
    });

    expect(useSpectral.getState().computeMatrix([a, b, un]).ok).toBe(true);
    const cd3 = useSpectral.getState().spectra.find((s) => s.label === 'CD3')!;
    expect(cd3.values[0]).toBeCloseTo(1, 6);
    for (let d = 1; d < D; d++) expect(cd3.values[d]).toBeCloseTo(0, 6);

    // And the control that still references the unstained sample keeps its
    // background, which is what makes the two modes distinguishable at all.
    const cd8 = useSpectral.getState().spectra.find((s) => s.label === 'CD8')!;
    expect(cd8.values.some((v, i) => i !== 3 && v > 0)).toBe(true);
  });

  it('subtracts the negative population in channel units, so real spillover survives', () => {
    /*
       The regression for 2026-08-16.

       `extractGatedSignature` returns a peak-normalised spectrum, and the
       subtraction above used to take one from the other in that form. A bead's
       negative population is two orders of magnitude dimmer than its positive
       one, so normalising it first raised its background to the same height as
       the dye's peak — and the clamp at zero then deleted every detector where
       the dye was dimmer than that inflated background — most of the detectors
       per stain — and the residual error moved one dye's signal into another's
       abundance.

       The fixture below is the smallest thing that can tell the two apart: a dye
       that peaks on detector 0 and genuinely emits at 40% of that on detector 3,
       over a flat background. Subtracting in channel units leaves 0.40 standing;
       subtracting normalised spectra deletes it and leaves a single spike, which
       is indistinguishable from a correct answer for a dye with no spillover.
    */
    const spilled = makeSample('s1', 'CD3', 0, 400, { 3: 0.4 });
    setUp([spilled, un], { s1: 'stain', s3: 'unstained' }, { s1: 'self' });
    const general = cellsGate();
    useGates.getState().addGate('s1', general);
    useSpectral.setState({ generalGateId: general.id });

    const pos = positiveGate(spilled, general.id, 2, 'CD3 +');
    useGates.getState().addGate('s1', pos);
    useSpectral.getState().setControlGate('s1', pos.id);

    const neg: Gate = {
      id: nextGateId(), name: 'CD3 −', parentId: general.id, colorIndex: 2,
      kind: 'range', xParam: 2,
      min: Number.NEGATIVE_INFINITY,
      max: createTransform(defaultSpecFor(spilled.parsed, 2)).forward(5000),
    };
    useGates.getState().addGate('s1', neg);
    useSpectral.setState({
      controls: useSpectral.getState().controls.map((c) => (c.sampleId === 's1' ? { ...c, negativeGateId: neg.id } : c)),
    });

    expect(useSpectral.getState().computeMatrix([spilled, un]).ok).toBe(true);
    const cd3 = useSpectral.getState().spectra.find((s) => s.label === 'CD3')!;
    // Peak 9000 over a background of 100; spill 3600 over a background of 103.
    expect(cd3.values[0]).toBeCloseTo(1, 6);
    expect(cd3.values[3]).toBeCloseTo(3600 / 8900, 4);
    // The background itself is gone, which is what the subtraction is for.
    expect(cd3.values[1]).toBeCloseTo(0, 6);
    expect(cd3.values[4]).toBeCloseTo(0, 6);
  });

  it('puts one background signature in the matrix however many background tubes there are', () => {
    /*
       Two tubes measuring the same thing are not two fluorophores.

       A panel with both an *Unstained* and an *Autofluorescence* file used to
       contribute two rows whose cosine similarity is essentially 1, which
       made the matrix ill-conditioned and produced background abundances orders
       of magnitude larger than any real signal. The explicit `autofluorescence` role wins; the other tube keeps
       its other two jobs.
    */
    const af = makeSample('s4', 'Autofluorescence', 1);
    setUp([a, un, af], { s1: 'stain', s3: 'unstained', s4: 'autofluorescence' });
    const general = cellsGate();
    useGates.getState().addGate('s1', general);
    useSpectral.setState({ generalGateId: general.id });
    const g = positiveGate(a, general.id, 2, 'CD3 +');
    useGates.getState().addGate('s1', g);
    useSpectral.getState().setControlGate('s1', g.id);

    expect(useSpectral.getState().computeMatrix([a, un, af]).ok).toBe(true);
    const spectra = useSpectral.getState().spectra;
    expect(spectra.filter((s) => s.isAutofluorescence)).toHaveLength(1);
    expect(spectra.find((s) => s.isAutofluorescence)!.label).toBe('Autofluorescence');
    expect(spectra).toHaveLength(2);
    // The unstained tube still measured the per-detector noise.
    expect(useSpectral.getState().weights).not.toBeNull();
  });

  it('refuses a self-referencing control with no negative gate', () => {
    gateAll({ s1: 'self' });
    const r = useSpectral.getState().computeMatrix([a, b, un]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('CD3');
  });

  it('records when it computed, and that the panel is local rather than loaded', () => {
    gateAll();
    useSpectral.setState({ loadedFrom: { path: null, name: 'old.fcunmix.json', savedAt: '2026-01-01' } });
    useSpectral.getState().computeMatrix([a, b, un]);
    expect(useSpectral.getState().computedAt).toBeTruthy();
    expect(useSpectral.getState().loadedFrom).toBeNull();
  });

  it('refuses a stain whose gate captures no events', () => {
    setUp([a, un], { s1: 'stain', s3: 'unstained' });
    const general = cellsGate();
    useGates.getState().addGate('s1', general);
    useSpectral.setState({ generalGateId: general.id });
    // A bound far above anything in the file.
    const empty = positiveGate(a, general.id, 2, 'CD3 +', 1e9);
    useGates.getState().addGate('s1', empty);
    useSpectral.getState().setControlGate('s1', empty.id);

    const r = useSpectral.getState().computeMatrix([a, un]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no events/i);
  });

  it('marks the panel stale when a control changes underneath it', () => {
    gateAll();
    useSpectral.getState().computeMatrix([a, b, un]);
    expect(useSpectral.getState().computedAt).toBeTruthy();
    useSpectral.getState().setControlRole('s2', 'unstained');
    expect(useSpectral.getState().computedAt).toBeNull();
  });
});

/* ========================================================================== */

describe('the wizard as a whole', () => {
  beforeEach(reset);
  const a = makeSample('s1', 'CD3', 0);
  const un = makeSample('s2', 'Unstained', 1);

  it('walks Steps 1 to 4 with nothing decided for the user', () => {
    const s = useSpectral.getState();
    // Step 1 — still empty, still nothing pre-ticked.
    expect(useSpectral.getState().selectedIds).toEqual([]);
    s.toggleSelected('s1');
    s.toggleSelected('s2');
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
    s.next([a, un]);
    expect(useSpectral.getState().step).toBe(2);

    // Step 2 — arrives suggested, and every suggestion is marked.
    expect(useSpectral.getState().controls.every((c) => c.roleSource === 'suggested')).toBe(true);
    useSpectral.getState().setControlRole('s1', 'stain');
    useSpectral.getState().setControlRole('s2', 'unstained');
    useSpectral.getState().relabelControl('s1', 'CD3 FITC');
    useSpectral.getState().next([a, un]);
    expect(useSpectral.getState().step).toBe(3);
    expect(useSpectral.getState().controls.every((c) => c.layoutId)).toBe(true);

    // Step 3 — gated on arrival, with no button pressed.
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
    useSpectral.getState().next([a, un]);
    expect(useSpectral.getState().step).toBe(4);

    // Step 4 — the last one. There is nothing to advance to and nothing to
    // refuse; applying the matrix is the Load unmixing tab's job now.
    expect(useSpectral.getState().stepCheck().ok).toBe(true);
    expect(useSpectral.getState().computeMatrix([a, un]).ok).toBe(true);
    useSpectral.getState().next([a, un]);
    expect(useSpectral.getState().step).toBe(4);
    expect(useSpectral.getState().spectra).toHaveLength(2);
  });

  it('refuses to advance past a step that is not satisfied', () => {
    useSpectral.getState().next([a, un]);
    expect(useSpectral.getState().step).toBe(1);
  });

  it('Start over clears the setup and leaves the gates alone', () => {
    setUp([a, un], { s1: 'stain', s2: 'unstained' });
    useSpectral.getState().buildGatingLayouts([a, un]);
    const gatesBefore = useGates.getState().shared.length;

    useSpectral.getState().resetWizard();
    expect(useSpectral.getState().step).toBe(1);
    expect(useSpectral.getState().selectedIds).toEqual([]);
    expect(useSpectral.getState().controls).toEqual([]);
    // Somebody drew those. A wizard that deleted a morning's gating because the
    // user wanted to re-pick a control would be unforgivable.
    expect(useGates.getState().shared).toHaveLength(gatesBefore);
  });
});

/* ==========================================================================
   Applying a matrix — do the unmixed parameters actually arrive?

   The regression guard for the 2026-08-09 bug, and the shape of it is the whole
   point. `runUnmixing` was always correct: it produced a full `UnmixResult` per
   sample with the right labels and the right abundances, and wrote it into
   `useSpectral().unmixed`. Every existing test asserted on that record and every
   one of them passed. Nothing outside the Unmixing panel read it, so the axis
   picker went on offering the same raw detectors and the feature the whole
   wizard exists to enable could not be started.

   So these assertions deliberately do **not** look at the store. They ask
   `parametersFor` and `sampleColumn` — the two functions that resolve a
   parameter index to data, and the two the axis picker, the plot, the gate and
   the statistics table all go through. An assertion on `unmixed` would have
   passed against the reported bug, which is this project's recurring trap:
   measure what the reader reads.
   ========================================================================== */

describe('Applying a matrix', () => {
  beforeEach(() => {
    reset();
    useDerived.setState({ defs: [] });
  });

  /** A normalised signature peaking in one detector. */
  function signature(id: string, label: string, peak: number) {
    const values = new Float64Array(D);
    for (let d = 0; d < D; d++) values[d] = d === peak ? 1 : 0.05;
    return { id, label, values, isAutofluorescence: false, sourceSampleId: id, eventCount: 100 };
  }

  /** A multicolour sample, unmixed against a two-signature matrix. */
  async function unmixOne(labels: [string, string] = ['CD3 RY703', 'CD4 RB744']) {
    const mc = makeSample('mc', 'Cells-Samples-MC', 0);
    useWorkspace.setState({ samples: [mc] } as never);
    useSpectral.setState({
      spectra: [signature('a', labels[0], 0), signature('b', labels[1], 3)] as never,
    });
    await useSpectral.getState().runUnmixing([mc]);
    return mc;
  }

  const rawNames = ['FSC-A', 'SSC-A', 'B1-A', 'B2-A', 'B3-A', 'B4-A', 'B5-A', 'B6-A'];

  it('puts the matrix’s identities on the parameter list the picker reads', async () => {
    const mc = await unmixOne();
    const params = parametersFor(mc.parsed, useDerived.getState().defs);

    // The raw detectors are *retained*, in place, which is the other half of the
    // claim the panel makes: "switch between the two on any plot axis".
    expect(params.slice(0, rawNames.length).map((p) => p.name)).toEqual(rawNames);
    // And the fluorophores are there, named after the matrix rather than after
    // whichever detector they happen to peak in.
    expect(params.slice(rawNames.length).map((p) => p.name)).toEqual(['CD3 RY703', 'CD4 RB744']);
    expect(params).toHaveLength(rawNames.length + 2);
  });

  it('tags them so the picker can tell them apart from the detectors', async () => {
    const mc = await unmixOne();
    const params = parametersFor(mc.parsed, useDerived.getState().defs);
    // `ParameterPicker` renders its Raw/Unmixed/Calc tag straight off `type`.
    expect(params[2]!.type).toBe('Raw_Fluorescence');
    expect(params[8]!.type).toBe('Unmixed_Fluorescence');
    expect(params[9]!.type).toBe('Unmixed_Fluorescence');
    // Selectable on an axis: the picker filters on this.
    expect(params[8]!.isDataChannel).toBe(true);
    // The label *is* the name, so the picker draws no duplicate subtitle.
    expect(params[8]!.label).toBe('CD3 RY703');
    expect(params[8]!.stain).toBe('');
  });

  it('resolves an unmixed index to that fluorophore’s own abundances', async () => {
    const mc = await unmixOne();
    const defs = useDerived.getState().defs;
    const n = mc.parsed.metadata.eventCount;
    const result = useSpectral.getState().unmixed.mc!;

    const first = sampleColumn(mc.parsed, rawNames.length, defs);
    expect(first).toHaveLength(n);
    expect(Array.from(first.slice(0, 8))).toEqual(Array.from(result.data.slice(0, 8)));

    const second = sampleColumn(mc.parsed, rawNames.length + 1, defs);
    expect(Array.from(second.slice(0, 8))).toEqual(Array.from(result.data.slice(n, n + 8)));

    // A raw detector still resolves to the file's own values, untouched.
    const raw = sampleColumn(mc.parsed, 2, defs);
    expect(Array.from(raw.slice(0, 4))).toEqual(Array.from(mc.parsed.data.slice(2 * n, 2 * n + 4)));
  });

  it('gives an unmixed parameter an axis that follows its own values', async () => {
    const mc = await unmixOne();
    const defs = useDerived.getState().defs;
    /*
       A least-squares abundance for a dye an event does not carry scatters about
       zero, so the negative half of the axis is where a whole population lives.
       A real detector is floored at 0 and an unmixed parameter must not be, or
       the negatives pile into the first pixel column and no threshold can be
       drawn against them.

       It is not floored at 0 in the *other* direction either (2026-08-18): this
       fixture's abundances are wholly positive, and an axis starting at zero
       spends its lower decades on values the column does not contain. So the
       claim is that the floor tracks the data — below it, and not by more than a
       decade — rather than that it is a particular number.

       The assertion used to be "close to `Math.min(0, lowest)`", which on this
       fixture reduced to "close to 0" and was therefore a check on a property the
       data does not have. `unmixedAxis.test.ts` covers the negative case against
       a column built to have one.
    */
    const col = sampleColumn(mc.parsed, rawNames.length, defs);
    let lowest = Infinity;
    for (let i = 0; i < col.length; i++) if (col[i]! < lowest) lowest = col[i]!;
    expect(lowest).toBeGreaterThan(0);
    const floor = axisMinFor(mc.parsed, rawNames.length, defs);
    expect(floor).toBeLessThanOrEqual(lowest);
    expect(floor).toBeGreaterThan(lowest / 20);
    // A detector is still floored at zero, which is the behaviour this must not
    // have changed.
    expect(axisMinFor(mc.parsed, 2, defs)).toBe(0);
    // And the axis is biexponential, as an abundance wants — not the linear one
    // a derived parameter gets.
    expect(defaultSpecFor(mc.parsed, rawNames.length).kind).toBe('biexponential');
  });

  it('keeps derived indices where they were, and puts the fluorophores after them', async () => {
    /*
       The ordering rule, asserted rather than commented. A derived parameter's
       index has to mean the same thing on every sample — a panel following the
       active sample would otherwise plot a different expression on each — and
       derived definitions belong to the workspace while unmixed abundances
       belong to a file. Putting the unmixed block first would make index 8 the
       first derived parameter on a raw sample and the first fluorophore on an
       unmixed one.
    */
    useDerived.setState({ defs: [{ id: 'd1', name: 'Ratio', expression: 'B1-A / B2-A' }] });
    const mc = await unmixOne();
    const params = parametersFor(mc.parsed, useDerived.getState().defs);
    expect(params.map((p) => p.name)).toEqual([...rawNames, 'Ratio', 'CD3 RY703', 'CD4 RB744']);
    expect(params[rawNames.length]!.type).toBe('Derived');
  });

  it('takes them off again when the results are cleared', async () => {
    const mc = await unmixOne();
    expect(parametersFor(mc.parsed, useDerived.getState().defs)).toHaveLength(rawNames.length + 2);
    useSpectral.getState().clearUnmixed();
    expect(parametersFor(mc.parsed, useDerived.getState().defs)).toHaveLength(rawNames.length);
  });

  it('replaces them wholesale when a different matrix is applied', async () => {
    const mc = await unmixOne();
    useSpectral.getState().clearUnmixed();
    useSpectral.setState({ spectra: [signature('c', 'CD8 PerCP-eFluor 710', 2)] as never });
    await useSpectral.getState().runUnmixing([mc]);
    const params = parametersFor(mc.parsed, useDerived.getState().defs);
    expect(params.map((p) => p.name)).toEqual([...rawNames, 'CD8 PerCP-eFluor 710']);
  });

  it('leaves a sample that was not unmixed with its detectors alone', async () => {
    const mc = await unmixOne();
    const other = makeSample('other', 'Cells-Samples-Second', 1);
    expect(parametersFor(other.parsed, useDerived.getState().defs).map((p) => p.name)).toEqual(rawNames);
    expect(parametersFor(mc.parsed, useDerived.getState().defs)).toHaveLength(rawNames.length + 2);
  });
});
