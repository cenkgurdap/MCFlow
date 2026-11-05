import { beforeEach, describe, expect, it } from 'vitest';
import { DENSITY_RESOLUTION, PANEL_VIEW_DEFAULTS, resolutionName } from './panelDefaults';
import { panelForRequest } from './openPanel';
import { COLOR_LEVEL_KEYS, makePanel, usePlot } from '@/state/plotStore';
import type { FcsMetadata, FcsParameter, ParameterType } from '@/core/fcs/types';

/* -------------------------------------------------------------------------
   "A new plot" has to mean the same thing however it was asked for.

   Four routes exist — the Add plot button, Duplicate, dropping a sample and
   dropping a population — and they had drifted: the button inherited whatever
   the active panel was set to, and a drop inherited from the most recently
   touched panel, so the same gesture produced different plots depending on
   history the user was not thinking about.
   ------------------------------------------------------------------------- */

function param(name: string, type: ParameterType): FcsParameter {
  return {
    index: 1, name, stain: '', label: name, bits: 32, range: 262144,
    amplification: [0, 0], gain: null, voltage: null, type, isDataChannel: type !== 'Time',
  };
}

const META: FcsMetadata = {
  parameters: [
    param('FSC-A', 'Forward_Scatter'),
    param('SSC-A', 'Side_Scatter'),
    param('B1-A', 'Raw_Fluorescence'),
    param('B2-A', 'Raw_Fluorescence'),
  ],
} as unknown as FcsMetadata;

/**
 * The settings that define "how a plot draws itself", read off any panel-shaped
 * object.
 *
 * Grown from three to six with the colour-level rework, and deliberately: the
 * claim the whole file exists to make is that every creation path produces the
 * *same* plot, and a claim checked over three of a panel's settings while eight
 * more drift is not the claim.
 */
const view = (p: {
  plotType: string; densityScale: string; binCount: number;
  ramp: string; colorStyle: string; smoothing: number;
}) => ({
  plotType: p.plotType, densityScale: p.densityScale, binCount: p.binCount,
  ramp: p.ramp, colorStyle: p.colorStyle, smoothing: p.smoothing,
});

const EXPECTED = {
  plotType: 'density',
  densityScale: 'rank',
  // 256 -> 1024. The bump only works alongside the smoothing and the filtered
  // downscale that shipped with it; see `panelDefaults.ts`.
  binCount: DENSITY_RESOLUTION.ultra,
  // viridis -> flame -> rainbow -> flame -> rainbow -> viridis -> **rainbow**.
  // Viridis was the default for one release (0.34) and went back at the user's
  // request; it stays one choice away. See `ramps.ts` and the CHANGELOG.
  ramp: 'rainbow',
  colorStyle: 'percentile',
  smoothing: 3,
};

beforeEach(() => {
  const first = makePanel();
  usePlot.setState({ panels: [first], activePanelId: first.id, otherLayouts: {} });
});

describe('the constant itself', () => {
  it('is density, rank, ultra, rainbow and percentile', () => {
    expect(view(PANEL_VIEW_DEFAULTS)).toEqual(EXPECTED);
  });

  it('names its resolutions so "ultra" is a checkable thing', () => {
    expect(resolutionName(DENSITY_RESOLUTION.ultra)).toBe('ultra');
    expect(resolutionName(DENSITY_RESOLUTION.medium)).toBe('medium');
    expect(resolutionName(DENSITY_RESOLUTION.coarse)).toBe('coarse');
    expect(resolutionName(DENSITY_RESOLUTION.fine)).toBe('fine');
    expect(resolutionName(200)).toBeNull();
  });

  it('carries the whole colour-level block, so a plot has one set of defaults', () => {
    // Every field the Colour Levels panel can change has to have an answer here,
    // or "restore to default" has nothing to restore to and a workspace saved
    // before the field existed restores it as undefined. Eleven fields, then five,
    // then six, now seven: `outlierSize` is back as a *size* — the display mode
    // and the dot colour are not, and neither is the auto-levels checkbox — and
    // `smoothingAuto` joins it, which is the mode the stepper beside it overrides.
    // (0.37.0 added a *Levels from* scope; 0.37.1 removed it.)
    expect(PANEL_VIEW_DEFAULTS.colorScaling).toBe('linear');
    for (const k of COLOR_LEVEL_KEYS) {
      expect(PANEL_VIEW_DEFAULTS[k], k).toBeDefined();
    }
    expect([...COLOR_LEVEL_KEYS].sort()).toEqual(
      ['binCount', 'colorScaling', 'colorStyle', 'outlierSize', 'ramp', 'smoothing', 'smoothingAuto'],
    );
    // Auto by default, with 3 as the value the stepper lands on when it is
    // switched off — which is what the plot has drawn since 1024×1024 shipped.
    expect(PANEL_VIEW_DEFAULTS.smoothingAuto).toBe(true);
    expect(PANEL_VIEW_DEFAULTS.smoothing).toBe(3);
    expect(makePanel().smoothingAuto).toBe(true);
    // An explicit `false` in a saved panel survives — `??` on a boolean would
    // have been fine, but a spread default would not: see the object-spread trap.
    expect(makePanel({ smoothingAuto: false }).smoothingAuto).toBe(false);
    // The one that came back, at the size the request named.
    expect(PANEL_VIEW_DEFAULTS.outlierSize).toBe(2);
    expect(makePanel().outlierSize).toBe(2);
    // Levels are *always* computed from the data and there is no field for it —
    // the checkbox went because unchecking it silently disabled Style. This is the
    // assertion that would fail if it were ever reintroduced.
    for (const gone of ['autoLevels', 'levelMax', 'outlierMode', 'outlierColor', 'overlayColor']) {
      expect(PANEL_VIEW_DEFAULTS, gone).not.toHaveProperty(gone);
      expect(makePanel(), gone).not.toHaveProperty(gone);
    }
  });

  it('carries the dot-plot appearance defaults too', () => {
    // Item 1. Both are down, and both are here rather than spelled out in
    // `makePanel`, so "what a new plot opens as" stays one constant.
    expect(PANEL_VIEW_DEFAULTS.pointSize).toBe(1.5);
    expect(PANEL_VIEW_DEFAULTS.alpha).toBe(0.5);
    // A stated opacity rather than the count-derived one, so what a dot plot looks
    // like no longer depends on how many events happen to be in the sample.
    expect(makePanel().alpha).toBe(0.5);
    expect(makePanel().pointSize).toBe(1.5);
  });
});

describe('a panel restored from outside this build', () => {
  it('drops a ramp name that no longer exists', () => {
    // Every workspace saved before this pass names Abyss, Ember or Glacier, and
    // `RAMPS['abyss']` is now `undefined` — which reaches the render loop as a ramp
    // with no entries and draws nothing. `makePanel` is the single gate every
    // restored panel comes through, so the check belongs there rather than at each
    // of the render sites, and the fallback is the default because it is the only
    // answer that draws a plot.
    // `flame` rejoined this list on 2026-08-03 and stays on it. It came off for
    // one release, which is why a workspace saved on 2026-08-02 names it and
    // reopens on the default — a silent change to a stated choice, recorded
    // under *Known issues*.
    for (const gone of ['abyss', 'ember', 'glacier', 'flame']) {
      const p = makePanel({ ramp: gone as never });
      expect(p.ramp, gone).toBe(PANEL_VIEW_DEFAULTS.ramp);
    }
    // A name that *is* still valid survives, or restoring a workspace would reset
    // every deliberate choice in it.
    expect(makePanel({ ramp: 'viridis' }).ramp).toBe('viridis');
    expect(makePanel({ ramp: 'cividis' }).ramp).toBe('cividis');
    expect(makePanel({ ramp: 'rainbow' }).ramp).toBe('rainbow');
  });

  it('clamps the numeric colour-level fields instead of trusting them', () => {
    // These are typed into steppers as well as clicked, and a workspace file can be
    // hand-edited. A resolution of 0 divides by zero in the binner; a smoothing of
    // 400 over a 1024 grid is a four-second draw.
    const wild = makePanel({ binCount: 0, smoothing: 400, outlierSize: 99 });
    expect(wild.binCount).toBe(16);
    expect(wild.smoothing).toBe(21);
    expect(wild.outlierSize).toBe(8);
    expect(makePanel({ smoothing: Number.NaN }).smoothing).toBe(PANEL_VIEW_DEFAULTS.smoothing);
    expect(makePanel({ outlierSize: Number.NaN }).outlierSize).toBe(PANEL_VIEW_DEFAULTS.outlierSize);
  });

  it('fills in every colour-level field a pre-pass workspace has never heard of', () => {
    // A v5 workspace saved yesterday has none of these keys. `undefined` reaching
    // the renderer would be a ramp position of NaN.
    const old = makePanel({ ramp: 'viridis' } as never);
    for (const k of ['colorStyle', 'colorScaling', 'smoothing', 'binCount', 'outlierSize'] as const) {
      expect(old[k], k).toBe(PANEL_VIEW_DEFAULTS[k]);
    }
  });

  it('treats an explicit undefined as absent, which object spread does not', () => {
    // `{ a: 1, ...{ a: undefined } }` is `{ a: undefined }` — spread does not skip
    // an explicit undefined, it assigns it. Every path that builds a patch by
    // spreading a panel through a shape that names a field the source lacks
    // therefore *erased* the default rather than falling back to it, and
    // `colorStyle: undefined` reaches the render loop as a ramp position of NaN. The
    // harness caught this restoring a pre-pass workspace.
    const wiped = makePanel({ colorStyle: undefined, ramp: undefined, smoothing: undefined } as never);
    expect(wiped.colorStyle).toBe(PANEL_VIEW_DEFAULTS.colorStyle);
    expect(wiped.ramp).toBe(PANEL_VIEW_DEFAULTS.ramp);
    expect(wiped.smoothing).toBe(PANEL_VIEW_DEFAULTS.smoothing);
    // And it is not specific to the colour-level fields — every field is covered.
    expect(makePanel({ xTransform: undefined } as never).xTransform).toBe('linear');
  });
});

describe('every creation path agrees', () => {
  it('makePanel, with nothing supplied', () => {
    expect(view(makePanel())).toEqual(EXPECTED);
  });

  it('Add plot', () => {
    const id = usePlot.getState().addPanel();
    expect(view(usePlot.getState().panel(id)!)).toEqual(EXPECTED);
  });

  it('Add plot, when the active panel has been changed to something else', () => {
    // The divergence itself. Adding a plot inherits the *axes* of the active
    // panel — a continuation of what the user is doing — but not how it draws.
    const active = usePlot.getState().activePanelId;
    usePlot.getState().updatePanel(active, {
      plotType: 'scatter', densityScale: 'linear', binCount: 64, xParam: 2, yParam: 3,
      ramp: 'viridis', colorStyle: 'linear', smoothing: 9,
    });
    const id = usePlot.getState().addPanel();
    const made = usePlot.getState().panel(id)!;
    expect(view(made)).toEqual(EXPECTED);
    expect([made.xParam, made.yParam]).toEqual([2, 3]);
  });

  it('Duplicate still copies everything, because that is what it means', () => {
    const active = usePlot.getState().activePanelId;
    usePlot.getState().updatePanel(active, {
      plotType: 'scatter', densityScale: 'linear', binCount: 64,
      ramp: 'viridis', colorStyle: 'linear', smoothing: 9,
    });
    const id = usePlot.getState().addPanel(active);
    expect(view(usePlot.getState().panel(id)!)).toEqual({
      plotType: 'scatter', densityScale: 'linear', binCount: 64,
      ramp: 'viridis', colorStyle: 'linear', smoothing: 9,
    });
  });

  it('dropping a sample', () => {
    const d = panelForRequest({ sampleId: 's1', populationId: null }, { metadata: META, gates: [] });
    expect(view({ ...makePanel(), ...d })).toEqual(EXPECTED);
  });

  it('dropping a population', () => {
    const gates = [{
      id: 'g1', name: 'Lymphocytes', parentId: null, colorIndex: 0,
      kind: 'rectangle' as const, xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    }];
    const d = panelForRequest({ sampleId: 's1', populationId: 'g1' }, { metadata: META, gates });
    expect(view({ ...makePanel(), ...d })).toEqual(EXPECTED);
  });

  it('openPanel, the action both drops go through', () => {
    const d = panelForRequest({ sampleId: 's1', populationId: null }, { metadata: META, gates: [] });
    const id = usePlot.getState().openPanel(d);
    expect(view(usePlot.getState().panel(id)!)).toEqual(EXPECTED);
  });

  it('all four paths produce byte-identical view settings', () => {
    const drop = panelForRequest({ sampleId: 's1', populationId: null }, { metadata: META, gates: [] });
    const paths = [
      view(makePanel()),
      view(usePlot.getState().panel(usePlot.getState().addPanel())!),
      view({ ...makePanel(), ...drop }),
      view(usePlot.getState().panel(usePlot.getState().openPanel(drop))!),
    ];
    for (const p of paths) expect(p).toEqual(paths[0]);
  });
});
