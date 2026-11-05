import { beforeEach, describe, expect, it } from 'vitest';
import {
  gateParentFor, panelForRequest, type OpenPanelContext,
} from './openPanel';
import { PANEL_VIEW_DEFAULTS } from './panelDefaults';
import { overlaps, panelRect } from '@/core/layout/geometry';
import { makePanel, usePlot } from '@/state/plotStore';
import { useGates } from '@/state/gateStore';
import type { FcsMetadata, FcsParameter, ParameterType } from '@/core/fcs/types';
import type { Gate } from '@/core/gating/types';
import { childrenOf } from '@/core/gating/tree';

/* -------------------------------------------------------------------------
   Fixtures — a miniature Aurora-shaped panel: Time, two scatter, four
   fluorescence. Small enough to reason about, same *shape* as an Aurora file.
   ------------------------------------------------------------------------- */

function param(index: number, name: string, type: ParameterType): FcsParameter {
  return {
    index, name, stain: '', label: name, bits: 32, range: 4_194_304,
    amplification: [0, 0], gain: null, voltage: null, type,
    isDataChannel: type !== 'Time',
  };
}

const PARAMS: FcsParameter[] = [
  param(1, 'Time', 'Time'),
  param(2, 'FSC-A', 'Forward_Scatter'),
  param(3, 'SSC-A', 'Side_Scatter'),
  param(4, 'B1-A', 'Raw_Fluorescence'),
  param(5, 'B2-A', 'Raw_Fluorescence'),
  param(6, 'R1-A', 'Raw_Fluorescence'),
  param(7, 'R2-A', 'Raw_Fluorescence'),
];

const METADATA = { parameters: PARAMS, eventCount: 1000, parameterCount: PARAMS.length } as FcsMetadata;

/** Index of each channel, 0-based, as `column()` and `setAxis()` take them. */
const I = { time: 0, fsc: 1, ssc: 2, b1: 3, b2: 4, r1: 5, r2: 6 };

function rect(id: string, parentId: string | null, xParam: number, yParam: number): Gate {
  return { id, name: id, parentId, colorIndex: 0, kind: 'rectangle', xParam, yParam, xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
}

function ctx(
  gates: Gate[] = [],
  recent: OpenPanelContext['recent'] = null,
  source: OpenPanelContext['source'] = null,
): OpenPanelContext {
  return { metadata: METADATA, gates, recent, source };
}

/* ========================================================================== */

/* ==========================================================================
   `axesUsedByAncestry` and `nextAxesFor` were deleted on 2026-08-12 (Item 10),
   and the twelve checks that covered them went with the functions rather than
   being rewritten.

   They asserted the old rule correctly — that a population dragged out opens on
   the first two fluorescence channels its ancestry had not already used, so
   re-plotting it never showed a box filled corner to corner. That rule is
   reversed, and the reason it existed was itself removed two days earlier: a
   scoped panel has not drawn its own scope gate since the workbench pass, so
   there is no box to avoid. See the block comment in `openPanel.ts`.

   What replaces them is the `source`/`recent` chain, asserted below.
   ========================================================================== */

describe('panelForRequest — sample drop', () => {
  it('pins the sample and opens at the root population', () => {
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx());
    expect(d.sampleId).toBe('s1');
    expect(d.populationId).toBeNull();
  });

  it('opens on FSC-A × SSC-A when there is nothing to copy', () => {
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx());
    expect([d.xParam, d.yParam]).toEqual([I.fsc, I.ssc]);
  });

  it('continues the series: inherits the most recent panel\'s axes', () => {
    const recent = makePanel({ xParam: I.b1, yParam: I.r2 });
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx([], recent));
    expect([d.xParam, d.yParam]).toEqual([I.b1, I.r2]);
  });

  it('does NOT inherit how the recent panel is drawn — only what it plots', () => {
    // The distinction this pass introduced. Which parameters to show continues
    // what the user is doing; plot type, scaling, ramp and resolution are
    // settings, and a setting that follows the last panel touched means a
    // dropped sample opens differently depending on history nobody is thinking
    // about. All four come from `PANEL_VIEW_DEFAULTS`, whatever `recent` says.
    const recent = makePanel({
      xParam: I.b1, yParam: I.r2,
      plotType: 'scatter', densityScale: 'linear', ramp: 'viridis', binCount: 64,
      // The colour-level block is settings too, by the same argument.
      colorStyle: 'linear', colorScaling: 'log', smoothing: 9,
      // And the dot-plot appearance, which joined the constant this pass.
      pointSize: 8, alpha: 1,
    });
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx([], recent));
    expect(d.plotType).toBe(PANEL_VIEW_DEFAULTS.plotType);
    expect(d.densityScale).toBe(PANEL_VIEW_DEFAULTS.densityScale);
    expect(d.ramp).toBe(PANEL_VIEW_DEFAULTS.ramp);
    expect(d.binCount).toBe(PANEL_VIEW_DEFAULTS.binCount);
    expect(d.colorStyle).toBe(PANEL_VIEW_DEFAULTS.colorStyle);
    expect(d.colorScaling).toBe(PANEL_VIEW_DEFAULTS.colorScaling);
    expect(d.smoothing).toBe(PANEL_VIEW_DEFAULTS.smoothing);
    expect(d.pointSize).toBe(PANEL_VIEW_DEFAULTS.pointSize);
    expect(d.alpha).toBe(PANEL_VIEW_DEFAULTS.alpha);
  });

  it('picks the transform from the parameter, not from the source panel', () => {
    // A width basis estimated on a fluorescence channel is meaningless on
    // scatter, so transforms must follow the axes.
    const recent = makePanel({ xParam: I.b1, yParam: I.b2, xTransform: 'logicle', yTransform: 'logicle' });
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx([], recent));
    expect(d.xTransform).toBe('biexponential');

    const scatter = panelForRequest({ sampleId: 's1', populationId: null }, ctx());
    expect(scatter.xTransform).toBe('linear');
    expect(scatter.yTransform).toBe('linear');
  });

  it('pre-sets initialisedFor so the mount effect cannot overwrite the axes', () => {
    // The `initialiseFor` trap: a fresh panel resets to FSC/SSC on mount unless
    // it already claims to be initialised for this sample.
    const recent = makePanel({ xParam: I.b1, yParam: I.r2 });
    const d = panelForRequest({ sampleId: 's1', populationId: null }, ctx([], recent));
    expect(d.initialisedFor).toBe('s1');
  });
});

describe('panelForRequest — population drop', () => {
  const gates = [rect('lymph', null, I.fsc, I.ssc)];

  it('scopes the panel to the dragged population, and leaves it following', () => {
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates));
    expect(d.populationId).toBe('lymph');
    // A population is a definition every loaded sample shares, so the panel
    // shows it against whichever sample is active rather than freezing on the
    // one that happened to be on screen during the drag.
    expect(d.sampleId).toBeNull();
  });

  it('opens on the axes of the plot the gate was dragged off — Item 10', () => {
    // The reported case, in miniature: Lymphocytes gated on FSC × SSC, dragged
    // out. This used to assert the opposite — that inference wins, because
    // repeating the axes that defined the gate was "the one thing the new plot
    // must not do". It opens on the pair the user was looking at now, so
    // continuing the strategy means changing one axis rather than both.
    const source = makePanel({ xParam: I.fsc, yParam: I.ssc });
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates, null, source));
    expect([d.xParam, d.yParam]).toEqual([I.fsc, I.ssc]);
  });

  it('lets the source plot beat the merely-active one', () => {
    // They differ whenever a gate is dragged off a plot that is not the active
    // one, which is every drag that begins by reaching across the worksheet.
    const source = makePanel({ xParam: I.b1, yParam: I.b2 });
    const recent = makePanel({ xParam: I.r1, yParam: I.r2 });
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates, recent, source));
    expect([d.xParam, d.yParam]).toEqual([I.b1, I.b2]);
  });

  it('falls back to the active plot for a drag out of the sidebar tree', () => {
    // A tree row names a population and no plot, so there is no source to
    // inherit from and the plot in front of the user is the next best answer.
    const recent = makePanel({ xParam: I.b2, yParam: I.r1 });
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates, recent));
    expect([d.xParam, d.yParam]).toEqual([I.b2, I.r1]);
  });

  it('opens on FSC × SSC when there is no plot to inherit from at all', () => {
    // A drop onto an empty worksheet. The universal opening plot, and a better
    // answer than the two ultraviolet detectors the inference used to give.
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates));
    expect([d.xParam, d.yParam]).toEqual([I.fsc, I.ssc]);
  });

  it('never inherits from a spectrum panel, which has no real y axis', () => {
    // A reference worksheet is full of them; its `yParam` is whatever it was
    // left with rather than an axis anybody chose.
    const source = makePanel({ plotType: 'spectrum', xParam: I.r1, yParam: I.r2 });
    const recent = makePanel({ xParam: I.b1, yParam: I.b2 });
    const d = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates, recent, source));
    expect([d.xParam, d.yParam]).toEqual([I.b1, I.b2]);

    // And with nothing else to fall back to, the sample's opening pair.
    const only = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx(gates, source, source));
    expect([only.xParam, only.yParam]).toEqual([I.fsc, I.ssc]);
  });

  it('clamps axes into range for a sample with fewer parameters', () => {
    const tiny = { parameters: PARAMS.slice(0, 2), eventCount: 10, parameterCount: 2 } as FcsMetadata;
    const recent = makePanel({ xParam: 40, yParam: 63 });
    const d = panelForRequest({ sampleId: 's1', populationId: null }, { metadata: tiny, gates: [], recent });
    expect(d.xParam).toBeLessThanOrEqual(1);
    expect(d.yParam).toBeLessThanOrEqual(1);
  });
});

describe('gateParentFor', () => {
  it('nests under the panel\'s population when the panel is scoped', () => {
    expect(gateParentFor({ populationId: 'lymph' }, null)).toBe('lymph');
  });

  it('lets the panel scope beat the tree selection', () => {
    // Otherwise a stale selection elsewhere in the tree would silently reparent
    // gates drawn on a plot that is showing something else entirely.
    expect(gateParentFor({ populationId: 'lymph' }, 'unrelated')).toBe('lymph');
  });

  it('falls back to the tree selection on an unscoped panel', () => {
    expect(gateParentFor({ populationId: null }, 'cd3')).toBe('cd3');
  });

  it('is the root when nothing is scoped or selected', () => {
    expect(gateParentFor({ populationId: null }, null)).toBeNull();
    expect(gateParentFor(undefined, null)).toBeNull();
  });
});

/* ==========================================================================
   The acceptance criterion, end to end through the real stores:
   drag a gate out -> the panel opens scoped to it -> draw on that panel ->
   the new population is that gate's child.
   ========================================================================== */

describe('drag a gate out, draw on the new panel', () => {
  beforeEach(() => {
    usePlot.setState({ panels: [makePanel()], activePanelId: usePlot.getState().panels[0]!.id });
    useGates.setState({ shared: [], divergent: {}, selectedGateId: null, lastAddedIds: [], lastAddedAt: 0 });
  });

  it('parents a gate drawn on the dropped panel under the dragged population', () => {
    const SAMPLE = 's1';
    useGates.getState().addGate(SAMPLE, rect('lymph', null, I.fsc, I.ssc));

    // The drop: a panel scoped to Lymphocytes.
    const gates = useGates.getState().gatesFor(SAMPLE);
    const panelId = usePlot.getState().openPanel(
      panelForRequest({ sampleId: SAMPLE, populationId: 'lymph' }, ctx(gates)),
    );
    const panel = usePlot.getState().panel(panelId)!;
    expect(panel.populationId).toBe('lymph');
    // Following, not pinned: a population is a definition every sample shares.
    expect(panel.sampleId).toBeNull();

    // Something else is selected in the tree — the panel scope must still win,
    // or the new gate lands in the wrong branch.
    useGates.getState().selectGate(null);

    // The draw, using exactly the rule PlotCanvas applies.
    const parentId = gateParentFor(usePlot.getState().panel(panelId), useGates.getState().selectedGateId);
    useGates.getState().addGate(SAMPLE, rect('cd3', parentId, panel.xParam, panel.yParam));

    const after = useGates.getState().gatesFor(SAMPLE);
    expect(after.find((g) => g.id === 'cd3')!.parentId).toBe('lymph');
    expect(childrenOf(after, 'lymph').map((g) => g.id)).toEqual(['cd3']);
  });

  it('builds a three-level hierarchy by repeating the gesture', () => {
    const SAMPLE = 's1';
    useGates.getState().addGate(SAMPLE, rect('lymph', null, I.fsc, I.ssc));

    let parentPop = 'lymph';
    for (const name of ['single', 'cd3']) {
      const gates = useGates.getState().gatesFor(SAMPLE);
      const panelId = usePlot.getState().openPanel(
        panelForRequest({ sampleId: SAMPLE, populationId: parentPop }, ctx(gates)),
      );
      const panel = usePlot.getState().panel(panelId)!;
      const parentId = gateParentFor(panel, useGates.getState().selectedGateId);
      useGates.getState().addGate(SAMPLE, rect(name, parentId, panel.xParam, panel.yParam));
      parentPop = name;
    }

    const gates = useGates.getState().gatesFor(SAMPLE);
    expect(gates.find((g) => g.id === 'single')!.parentId).toBe('lymph');
    expect(gates.find((g) => g.id === 'cd3')!.parentId).toBe('single');
    /*
       This used to assert that each level plots a *fresh* pair rather than
       repeating its parent's axes. Item 10 reverses that: the panels here are
       opened with no source and no recent, so every level opens on the
       sample's own FSC × SSC and it is the user who changes an axis between
       steps. What the hierarchy test is actually about — that repeating the
       gesture nests three levels correctly — is the two assertions above, and
       they are untouched.
    */
    expect(usePlot.getState().panels.at(-1)!.xParam).toBe(I.fsc);
  });

  it('leaves an unscoped panel following the tree selection, as before', () => {
    const SAMPLE = 's1';
    useGates.getState().addGate(SAMPLE, rect('lymph', null, I.fsc, I.ssc));
    useGates.getState().selectGate('lymph');

    const panelId = usePlot.getState().openPanel(
      panelForRequest({ sampleId: SAMPLE, populationId: null }, ctx(useGates.getState().gatesFor(SAMPLE))),
    );
    const parentId = gateParentFor(usePlot.getState().panel(panelId), useGates.getState().selectedGateId);
    expect(parentId).toBe('lymph');
  });
});

describe('plot store — worksheet growth', () => {
  beforeEach(() => {
    const first = makePanel({ x: 10, y: 10 });
    usePlot.setState({ panels: [first], activePanelId: first.id });
  });

  it('places a dropped panel somewhere free rather than on top of another', () => {
    usePlot.getState().openPanel(panelForRequest({ sampleId: 's1', populationId: null }, ctx()));
    const [a, b] = usePlot.getState().panels;
    expect(usePlot.getState().panels).toHaveLength(2);
    expect(b!.x >= 0 && b!.y >= 0).toBe(true);
    expect(overlaps(panelRect(a!.x, a!.y, a!.w), panelRect(b!.x, b!.y, b!.w))).toBe(false);
  });

  it('never refuses a drop — the canvas grows instead', () => {
    for (let i = 0; i < 11; i++) {
      usePlot.getState().openPanel(panelForRequest({ sampleId: `s${i}`, populationId: null }, ctx()));
    }
    const panels = usePlot.getState().panels;
    expect(panels).toHaveLength(12);
    // Every pair disjoint: automatic placement scans for a free rectangle, and
    // running out of visible width extends downward rather than stacking.
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        const a = panels[i]!;
        const b = panels[j]!;
        expect(overlaps(panelRect(a.x, a.y, a.w), panelRect(b.x, b.y, b.w))).toBe(false);
      }
    }
  });

  it('makes the newly dropped panel active', () => {
    const id = usePlot.getState().openPanel(panelForRequest({ sampleId: 's1', populationId: null }, ctx()));
    expect(usePlot.getState().activePanelId).toBe(id);
  });

  it('never re-pins an existing panel', () => {
    const before = usePlot.getState().panels[0]!;
    expect(before.sampleId).toBeNull();
    usePlot.getState().openPanel(panelForRequest({ sampleId: 's1', populationId: null }, ctx()));
    expect(usePlot.getState().panels[0]!.sampleId).toBeNull();
  });

  it('lets the layout empty out — the worksheet drop state is real', () => {
    const id = usePlot.getState().panels[0]!.id;
    usePlot.getState().removePanel(id);
    expect(usePlot.getState().panels).toHaveLength(0);
    expect(usePlot.getState().activePanel()).toBeUndefined();
  });

  it('keeps the population scope when a panel changes sample', () => {
    // Gating is shared, so a gate id means the same population in every
    // sample's tree. Dropping the scope on a pin change used to be right when
    // hierarchies were per-sample; keeping it is what makes pinning a panel to
    // each replicate in turn a comparison of the same population.
    const id = usePlot.getState().openPanel(
      panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx([rect('lymph', null, 1, 2)])),
    );
    usePlot.getState().setPanelSample(id, 's2');
    expect(usePlot.getState().panel(id)!.populationId).toBe('lymph');
    expect(usePlot.getState().panel(id)!.sampleId).toBe('s2');
  });

  it('opens a dropped population on follow, not pinned to the sample it was dragged from', () => {
    // The bug this replaces: a panel created by dragging a gate out stayed on
    // whichever sample was active at the moment of the drag, so switching
    // sample updated every other panel and left this one frozen.
    const draft = panelForRequest({ sampleId: 's1', populationId: 'lymph' }, ctx([rect('lymph', null, 1, 2)]));
    expect(draft.sampleId).toBeNull();
    expect(draft.populationId).toBe('lymph');
  });

  it('pins a dropped sample, because dragging a file names that file', () => {
    const draft = panelForRequest({ sampleId: 's1', populationId: null }, ctx([]));
    expect(draft.sampleId).toBe('s1');
  });

  it('restores an older workspace without a populationId field', () => {
    // v2 files predate the field; they must come back as root-scoped rather
    // than as `undefined`, which reads as a scope pointing at nothing.
    const legacy = { ...makePanel(), id: 'legacy' } as Record<string, unknown>;
    delete legacy.populationId;
    usePlot.getState().setPanels([legacy as never]);
    expect(usePlot.getState().panels[0]!.populationId).toBeNull();
  });
});
