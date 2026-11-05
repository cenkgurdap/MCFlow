import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultPanelWidth, hasPanelWidthMemory, notePanelWidth, resetPanelWidthMemory,
} from './panelSize';
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from './geometry';
import { makePanel, usePlot } from '@/state/plotStore';

/* ==========================================================================
   A new panel opens at the size the user last chose.

   Reported as: resize one plot, drag a gate out of it, and the plot that
   appears is the original small default — so a worksheet ends up with one large
   panel and everything created after it small. The fix is one resolution
   function that every creation path already goes through, which is what these
   tests are really pinning: not the memory itself, but that nothing bypasses it.
   ========================================================================== */

describe('panelSize', () => {
  beforeEach(() => resetPanelWidthMemory());

  it('falls back to the project default before anything is resized', () => {
    expect(hasPanelWidthMemory()).toBe(false);
    expect(defaultPanelWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('remembers a width the user chose', () => {
    notePanelWidth(430);
    expect(defaultPanelWidth()).toBe(430);
  });

  it('clamps on the way in, so it can never hold an impossible width', () => {
    notePanelWidth(9000);
    expect(defaultPanelWidth()).toBe(PANEL_MAX_WIDTH);
    notePanelWidth(10);
    expect(defaultPanelWidth()).toBe(PANEL_MIN_WIDTH);
  });

  it('ignores nonsense rather than poisoning every future panel', () => {
    notePanelWidth(360);
    notePanelWidth(Number.NaN);
    notePanelWidth(0);
    expect(defaultPanelWidth()).toBe(360);
  });
});

describe('every creation path opens at the remembered size', () => {
  beforeEach(() => {
    resetPanelWidthMemory();
    usePlot.setState({ panels: [], activePanelId: '', selectedPanelId: null });
  });

  it('gives a fresh panel the default when nothing has been resized', () => {
    expect(makePanel().w).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('routes a manual resize into the memory', () => {
    const id = usePlot.getState().addPanel();
    usePlot.getState().resizePanel(id, 420);
    expect(defaultPanelWidth()).toBe(420);
  });

  it('opens the next panel at the resized width, whichever route created it', () => {
    const first = usePlot.getState().addPanel();
    usePlot.getState().resizePanel(first, 400);

    // `addPanel` — the toolbar button.
    const added = usePlot.getState().addPanel();
    expect(usePlot.getState().panel(added)!.w).toBe(400);

    // `openPanel` — every drop and context-menu route, via `panelForRequest`.
    const opened = usePlot.getState().openPanel({
      sampleId: null, populationId: null, xParam: 0, yParam: 1,
    });
    expect(usePlot.getState().panel(opened)!.w).toBe(400);
  });

  it('lets an explicit width win, so a workspace restores its own sizes', () => {
    notePanelWidth(400);
    // What a load or a sibling window's snapshot does: the saved panel carries
    // its width, and the session memory must not overwrite it.
    expect(makePanel({ w: 250 }).w).toBe(250);
  });

  it('keeps Duplicate meaning "another one of these", size included', () => {
    const first = usePlot.getState().addPanel();
    usePlot.getState().resizePanel(first, 460);
    // A second panel at the remembered width, then resized away from it.
    const second = usePlot.getState().addPanel();
    usePlot.getState().updatePanel(second, { w: 300 });

    const copy = usePlot.getState().addPanel(second);
    expect(usePlot.getState().panel(copy)!.w).toBe(300);
  });
});
