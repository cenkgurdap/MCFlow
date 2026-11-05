import { describe, expect, it } from 'vitest';
import {
  PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, PLOT_MARGIN,
  clampWidth, contentBounds, fitScale, isFree, nearestFreePosition, nextFreePosition,
  overlaps, panelHeight, panelRect, plotSurfaceHeight, positionsForGrid, snapTo,
  PANEL_GAP,
} from './geometry';

/* ==========================================================================
   Worksheet geometry.

   The worksheet stopped being a CSS grid, so the rules that used to be implicit
   in `grid-template-columns` — how big a panel is, where the next one goes, how
   far the canvas extends — are now decisions this module makes and these tests
   pin down.
   ========================================================================== */

describe('panel size', () => {
  it('fits about four across a typical worksheet at the default width', () => {
    // The stated requirement. ~1300 px is what is left of a 1920 px window once
    // the sidebar and inspector have taken theirs.
    const across = Math.floor(1300 / (PANEL_DEFAULT_WIDTH + PANEL_GAP));
    expect(across).toBe(4);
  });

  it('is the largest default that still fits four across a 1200 px worksheet', () => {
    // The panel toolbar did not fit at the old 280 and the default was raised —
    // but "raise it until the toolbar fits" would have cost the density goal, so
    // the increase is bounded by that goal instead. Four panels and four gaps
    // land on 1200 exactly; one pixel more wraps the fourth.
    expect(4 * PANEL_DEFAULT_WIDTH + 4 * PANEL_GAP).toBeLessThanOrEqual(1200);
    expect(4 * (PANEL_DEFAULT_WIDTH + 1) + 4 * PANEL_GAP).toBeGreaterThan(1200);
  });

  it('keeps the default well under the cap that made one plot fill the screen', () => {
    expect(PANEL_DEFAULT_WIDTH).toBeLessThan(PANEL_MAX_WIDTH);
    expect(PANEL_DEFAULT_WIDTH).toBeGreaterThan(PANEL_MIN_WIDTH);
  });

  it('clamps a resize to the readable band', () => {
    expect(clampWidth(20)).toBe(PANEL_MIN_WIDTH);
    expect(clampWidth(2000)).toBe(PANEL_MAX_WIDTH);
    expect(clampWidth(311.4)).toBe(311);
  });

  it('keeps the plot area square — chrome is added outside it, not taken from it', () => {
    // The reason panels are square at all: a population that is round at 1:1 is
    // an ellipse at 2:1 and reads as a different population. The axis margins are
    // the only chrome left across the width — the 12 px drag rail went with the
    // restriction that made it the only way to move a panel — so the square is
    // the panel width less those two margins.
    for (const w of [220, 300, 420, 520]) {
      const surface = plotSurfaceHeight(w);
      const square = surface - PLOT_MARGIN.top - PLOT_MARGIN.bottom;
      expect(square).toBe(w - PLOT_MARGIN.left - PLOT_MARGIN.right);
    }
  });

  it('gives every plot type the same square, because none of them claims a legend', () => {
    // Density used to surrender 46 px on the right to a colour bar, so a density
    // panel and a dot panel of the same width had different-sized plots and
    // switching between them reshaped the graph. `plotSurfaceHeight` takes no
    // plot type at all now, which is the strongest form of that guarantee.
    expect(plotSurfaceHeight.length).toBe(1);
  });

  it('grows the panel box with its width', () => {
    expect(panelHeight(400)).toBeGreaterThan(panelHeight(300));
  });
});

describe('overlap', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };

  it('detects a real intersection', () => {
    expect(overlaps(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
  });

  it('treats touching edges as free, so snapped neighbours are not "overlapping"', () => {
    expect(overlaps(a, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
    expect(overlaps(a, { x: 0, y: 100, w: 100, h: 100 })).toBe(false);
  });

  it('isFree is the negation over a whole worksheet', () => {
    expect(isFree({ x: 200, y: 0, w: 50, h: 50 }, [a])).toBe(true);
    expect(isFree({ x: 10, y: 10, w: 50, h: 50 }, [a])).toBe(false);
  });
});

describe('automatic placement', () => {
  it('lays panels out left to right, then down', () => {
    const placed: ReturnType<typeof panelRect>[] = [];
    const positions = [];
    for (let i = 0; i < 6; i++) {
      const p = nextFreePosition(placed, PANEL_DEFAULT_WIDTH, 1300);
      positions.push(p);
      placed.push(panelRect(p.x, p.y, PANEL_DEFAULT_WIDTH));
    }
    // Four across at 1300 px, then the fifth wraps.
    expect(positions[0]!.y).toBe(positions[3]!.y);
    expect(positions[4]!.y).toBeGreaterThan(positions[0]!.y);
    expect(positions[4]!.x).toBe(positions[0]!.x);
  });

  it('never returns a position that overlaps something already placed', () => {
    const placed = [panelRect(10, 10, 300), panelRect(320, 10, 300)];
    const p = nextFreePosition(placed, 300, 1300);
    expect(isFree(panelRect(p.x, p.y, 300), placed)).toBe(true);
  });

  it('lands a drop where it was released when that space is free', () => {
    const p = nearestFreePosition({ x: 640, y: 320 }, [], 300, 1300);
    expect(p).toEqual({ x: 640, y: 320 });
  });

  it('nudges a drop that would overlap rather than refusing it', () => {
    const placed = [panelRect(600, 300, 300)];
    const p = nearestFreePosition({ x: 640, y: 320 }, placed, 300, 1300);
    expect(isFree(panelRect(p.x, p.y, 300), placed)).toBe(true);
  });

  it('snaps a landing position to the drag lattice', () => {
    expect(snapTo(103)).toBe(104);
    expect(snapTo(99)).toBe(96);
    const p = nearestFreePosition({ x: 641, y: 323 }, [], 300, 1300);
    expect(p.x % 8).toBe(0);
    expect(p.y % 8).toBe(0);
  });
});

describe('canvas bounds', () => {
  const viewport = { width: 1000, height: 600 };

  it('is at least the visible size, so an empty worksheet has no scrollbar', () => {
    expect(contentBounds([], viewport)).toEqual({ width: 1000, height: 600 });
  });

  it('grows horizontally for a panel dropped past the right-hand edge', () => {
    // The behaviour that replaces wrapping: a fourth plot to the right of three
    // extends the worksheet rather than being moved onto the next row.
    const bounds = contentBounds([panelRect(1400, 10, 300)], viewport);
    expect(bounds.width).toBeGreaterThan(1700);
    expect(bounds.height).toBe(600);
  });

  it('grows vertically the same way', () => {
    const bounds = contentBounds([panelRect(10, 900, 300)], viewport);
    expect(bounds.height).toBeGreaterThan(900 + panelHeight(300));
    expect(bounds.width).toBe(1000);
  });
});

describe('fit to content', () => {
  it('shrinks to bring everything into view', () => {
    const rects = [panelRect(0, 0, 300), panelRect(2000, 0, 300)];
    const scale = fitScale(rects, { width: 1000, height: 600 });
    expect(scale).toBeLessThan(1);
    expect(2310 * scale).toBeLessThanOrEqual(1000);
  });

  it('never magnifies — a two-plot worksheet shows them at their real size', () => {
    expect(fitScale([panelRect(0, 0, 300)], { width: 2000, height: 1200 })).toBe(1);
  });

  it('is 1 for an empty worksheet', () => {
    expect(fitScale([], { width: 1000, height: 600 })).toBe(1);
  });
});

describe('migrating a grid layout', () => {
  it('reproduces the arrangement the old column count described', () => {
    const spots = positionsForGrid(5, 2, 300);
    expect(spots[0]!.y).toBe(spots[1]!.y);
    expect(spots[2]!.y).toBeGreaterThan(spots[0]!.y);
    expect(spots[0]!.x).toBe(spots[2]!.x);
    expect(spots[4]!.x).toBe(spots[0]!.x);
  });

  it('produces non-overlapping positions', () => {
    const spots = positionsForGrid(9, 3, 300);
    const rects = spots.map((p) => panelRect(p.x, p.y, 300));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });
});
