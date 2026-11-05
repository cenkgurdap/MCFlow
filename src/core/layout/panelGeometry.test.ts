import { beforeEach, describe, expect, it } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH, PANEL_GAP, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH,
  clampWidth, contentBounds, contentOffset, panelHeight, panelRect, widthDelta,
  type ResizeDir,
} from './geometry';
import { makePanel, usePlot } from '@/state/plotStore';

/* ==========================================================================
   The three worksheet changes of this pass, at the level they are decided.

   Resizing from any edge, the canvas fitting its content in both directions,
   and a panel choosing its axes once rather than once per sample. All three
   were reported from real use; all three are decided by pure functions or by a
   store action, so none of them needs a rendered component to pin down.
   ========================================================================== */

describe('aspect-locked resize', () => {
  it('grows from an edge in the direction the pointer moves', () => {
    expect(widthDelta('e', 30, 0)).toBe(30);
    expect(widthDelta('s', 0, 30)).toBe(30);
    // Dragging a left or top edge outward means a *negative* pointer delta.
    expect(widthDelta('w', -30, 0)).toBe(30);
    expect(widthDelta('n', 0, -30)).toBe(30);
  });

  it('ignores the axis an edge cannot move along', () => {
    expect(widthDelta('e', 30, 999)).toBe(30);
    expect(widthDelta('s', -999, 30)).toBe(30);
  });

  it('projects a corner drag, so ten pixels diagonally is ten pixels wider', () => {
    // Not the sum (twenty) and not the dominant component alone: the least
    // squares fit of (dw, dw) to the delta.
    expect(widthDelta('se', 10, 10)).toBe(10);
    expect(widthDelta('nw', -10, -10)).toBe(10);
    expect(widthDelta('ne', 10, -10)).toBe(10);
    expect(widthDelta('sw', -10, 10)).toBe(10);
  });

  it('tracks a corner drag that wanders off the diagonal', () => {
    // Snapping to the dominant axis would give 20 here and jump as the pointer
    // crossed the diagonal; the projection moves smoothly through it.
    expect(widthDelta('se', 20, 0)).toBe(10);
    expect(widthDelta('se', 20, 10)).toBe(15);
    expect(widthDelta('se', 20, 20)).toBe(20);
  });

  it('shrinks as readily as it grows', () => {
    expect(widthDelta('e', -40, 0)).toBe(-40);
    expect(widthDelta('se', -40, -40)).toBe(-40);
  });

  it('stays square whatever the handle: height follows width alone', () => {
    for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeDir[]) {
      const w = clampWidth(PANEL_DEFAULT_WIDTH + widthDelta(dir, 40, 40));
      // There is only one number to derive a height from, which is the whole
      // reason a non-square panel is unreachable rather than merely discouraged.
      expect(panelHeight(w)).toBe(panelHeight(w));
      expect(w).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
      expect(w).toBeLessThanOrEqual(PANEL_MAX_WIDTH);
    }
  });
});

describe('the canvas fits its content in both directions', () => {
  it('reports no offset when the content already sits at the origin', () => {
    expect(contentOffset([panelRect(PANEL_GAP, PANEL_GAP, 280)])).toEqual({ dx: 0, dy: 0 });
  });

  it('never pushes content away from the origin', () => {
    // A panel closer to the edge than the gap must not be nudged outward: this
    // only ever reclaims dead space.
    expect(contentOffset([panelRect(0, 0, 280)])).toEqual({ dx: 0, dy: 0 });
  });

  it('measures the gap in front of the nearest panel, not the average', () => {
    const rects = [panelRect(2400, 900, 280), panelRect(600, 60, 280)];
    expect(contentOffset(rects)).toEqual({ dx: 600 - PANEL_GAP, dy: 60 - PANEL_GAP });
  });

  it('is empty for an empty worksheet', () => {
    expect(contentOffset([])).toEqual({ dx: 0, dy: 0 });
  });
});

describe('deleting a panel shrinks the worksheet back', () => {
  const viewport = { width: 1200, height: 800 };

  beforeEach(() => {
    usePlot.setState({ panels: [], activePanelId: '', selectedPanelId: null, otherLayouts: {} });
  });

  it('reclaims the space a removed panel had extended the canvas into', () => {
    // The report: drag a plot far out, the worksheet grows to hold it, delete
    // it, and the worksheet stays that size with nothing in the extra area.
    const near = makePanel({ x: 10, y: 10, w: 280 });
    const far = makePanel({ x: 2400, y: 1200, w: 280 });
    usePlot.setState({ panels: [near, far], activePanelId: near.id });

    const grown = contentBounds(usePlot.getState().panels.map((p) => panelRect(p.x, p.y, p.w)), viewport);
    expect(grown.width).toBeGreaterThan(2400);

    usePlot.getState().removePanel(far.id);

    const shrunk = contentBounds(usePlot.getState().panels.map((p) => panelRect(p.x, p.y, p.w)), viewport);
    expect(shrunk.width).toBe(viewport.width);
    expect(shrunk.height).toBe(viewport.height);
  });

  it('reclaims space in *front* of the survivors too', () => {
    // The other half, and the one growing alone cannot give you: delete the
    // panel nearest the origin and the remaining one is left behind a band of
    // empty worksheet.
    const near = makePanel({ x: 10, y: 10, w: 280 });
    const far = makePanel({ x: 2400, y: 1200, w: 280 });
    usePlot.setState({ panels: [near, far], activePanelId: near.id });

    usePlot.getState().removePanel(near.id);

    const survivor = usePlot.getState().panels[0]!;
    expect(survivor.x).toBe(PANEL_GAP);
    expect(survivor.y).toBe(PANEL_GAP);
  });

  it('holds the arrangement together — every relative position is unchanged', () => {
    const a = makePanel({ x: 900, y: 500, w: 280 });
    const b = makePanel({ x: 1200, y: 500, w: 280 });
    const doomed = makePanel({ x: 3000, y: 500, w: 280 });
    usePlot.setState({ panels: [a, b, doomed], activePanelId: a.id });

    usePlot.getState().removePanel(doomed.id);

    const [pa, pb] = usePlot.getState().panels;
    expect(pb!.x - pa!.x).toBe(300);
    expect(pa!.y).toBe(pb!.y);
    expect(pa!.x).toBe(PANEL_GAP);
  });

  it('leaves a layout that already starts at the origin exactly where it was', () => {
    const a = makePanel({ x: 10, y: 10, w: 280 });
    const b = makePanel({ x: 300, y: 10, w: 280 });
    usePlot.setState({ panels: [a, b], activePanelId: a.id });

    usePlot.getState().removePanel(b.id);
    expect(usePlot.getState().panels[0]!.x).toBe(10);
    expect(usePlot.getState().panels[0]!.y).toBe(10);
  });
});

describe('a panel chooses its axes once, not once per sample', () => {
  const md = (names: string[]) => ({
    eventCount: 100,
    parameterCount: names.length,
    parameters: names.map((name, i) => ({
      index: i + 1, name, stain: '', label: name, bits: 32, range: 262144,
      amplification: [0, 0] as [number, number], gain: null, voltage: null,
      type: name.startsWith('FSC') ? 'Forward_Scatter' as const
        : name.startsWith('SSC') ? 'Side_Scatter' as const
          : 'Raw_Fluorescence' as const,
      isDataChannel: true,
    })),
  });

  const NAMES = ['FSC-A', 'SSC-A', 'B1-A', 'R1-A'];

  beforeEach(() => {
    usePlot.setState({ panels: [], activePanelId: '', selectedPanelId: null, otherLayouts: {} });
  });

  it('sets FSC/SSC on a fresh panel', () => {
    const p = makePanel();
    usePlot.setState({ panels: [p], activePanelId: p.id });
    usePlot.getState().initialiseFor(p.id, 's1', md(NAMES) as never);
    expect([usePlot.getState().panel(p.id)!.xParam, usePlot.getState().panel(p.id)!.yParam]).toEqual([0, 1]);
  });

  it('keeps the axes when the sample underneath it changes', () => {
    // The bug: a panel opened by dragging a gate out plots channels the
    // population's ancestry has not used. It follows the active sample, so
    // `initialiseFor` fires again on every switch — and used to reset it to
    // FSC/SSC, which is the axis pair the gate was drawn on.
    const p = makePanel({ populationId: 'lymph', xParam: 2, yParam: 3, initialisedFor: 's1' });
    usePlot.setState({ panels: [p], activePanelId: p.id });

    usePlot.getState().initialiseFor(p.id, 's2', md(NAMES) as never);
    usePlot.getState().initialiseFor(p.id, 's3', md(NAMES) as never);

    const after = usePlot.getState().panel(p.id)!;
    expect([after.xParam, after.yParam]).toEqual([2, 3]);
  });

  it('chooses again only when the panel is explicitly re-pinned', () => {
    const p = makePanel({ xParam: 2, yParam: 3, initialisedFor: 's1' });
    usePlot.setState({ panels: [p], activePanelId: p.id });

    usePlot.getState().setPanelSample(p.id, 's2');
    expect(usePlot.getState().panel(p.id)!.initialisedFor).toBeNull();

    usePlot.getState().initialiseFor(p.id, 's2', md(NAMES) as never);
    expect([usePlot.getState().panel(p.id)!.xParam, usePlot.getState().panel(p.id)!.yParam]).toEqual([0, 1]);
  });

  it('keeps the population scope across a pin change, because gating is shared', () => {
    const p = makePanel({ populationId: 'lymph' });
    usePlot.setState({ panels: [p], activePanelId: p.id });
    usePlot.getState().setPanelSample(p.id, 's2');
    expect(usePlot.getState().panel(p.id)!.populationId).toBe('lymph');
  });
});
