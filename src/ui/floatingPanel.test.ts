import { describe, expect, it } from 'vitest';
import { placeBeside, type Rect } from './FloatingPanel';

/**
 * Where the colour-levels panel opens.
 *
 * Worth unit-testing rather than eyeballing, because the reported bug — "opens
 * directly centered over the plot, completely blocking the view" — is a claim
 * about arithmetic, and the fix is only a fix if it holds for a plot at the right
 * edge of the worksheet as well as one in the middle.
 */
const rect = (left: number, top: number, width = 240, height = 300): Rect => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

const SIZE = { width: 280, height: 320 };
const SCREEN = { width: 1440, height: 900 };

/** Do these two rectangles share any area? */
function overlaps(a: Rect, b: { left: number; top: number }, size: { width: number; height: number }): boolean {
  const right = b.left + size.width;
  const bottom = b.top + size.height;
  return a.left < right && b.left < a.right && a.top < bottom && b.top < a.bottom;
}

describe('placeBeside', () => {
  it('opens to the right of the plot, clear of it', () => {
    const plot = rect(300, 200);
    const at = placeBeside(plot, SIZE, SCREEN);
    expect(at.left).toBeGreaterThanOrEqual(plot.right);
    expect(overlaps(plot, at, SIZE)).toBe(false);
  });

  it('falls back to the left when the right has no room', () => {
    // A plot near the right edge — the case the popover handled by sliding back
    // over the plot.
    const plot = rect(SCREEN.width - 260, 200);
    const at = placeBeside(plot, SIZE, SCREEN);
    expect(at.left + SIZE.width).toBeLessThanOrEqual(plot.left);
    expect(overlaps(plot, at, SIZE)).toBe(false);
  });

  it('never covers the plot when either side has room', () => {
    // The whole requirement, swept across the worksheet rather than asserted at
    // two convenient positions.
    for (let left = 0; left + 240 <= SCREEN.width; left += 20) {
      const plot = rect(left, 150);
      const at = placeBeside(plot, SIZE, SCREEN);
      const roomRight = plot.right + 8 + SIZE.width + 8 <= SCREEN.width;
      const roomLeft = plot.left - 8 - SIZE.width >= 8;
      if (roomRight || roomLeft) {
        expect(overlaps(plot, at, SIZE), `plot at ${left}`).toBe(false);
      }
    }
  });

  it('pins to a window edge when neither side fits, rather than centring', () => {
    // A very wide plot on a narrow window leaves no clear side. The old popover
    // centred on its anchor, which is the reported failure; pinning to an edge
    // still leaves most of the plot visible.
    const narrow = { width: 700, height: 900 };
    const plot = rect(20, 100, 640, 600);
    const at = placeBeside(plot, SIZE, narrow);
    expect(at.left + SIZE.width).toBeLessThanOrEqual(narrow.width);
    expect(at.left).toBeGreaterThanOrEqual(0);
    // It goes to the side that leaves more of the plot showing — here the plot is
    // left of centre, so the panel takes the right edge.
    expect(at.left).toBeGreaterThan(narrow.width / 2 - SIZE.width);
  });

  it('stays on screen vertically for a plot near the bottom', () => {
    const plot = rect(200, SCREEN.height - 120, 240, 300);
    const at = placeBeside(plot, SIZE, SCREEN);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.top + SIZE.height).toBeLessThanOrEqual(SCREEN.height);
  });

  it('aligns to the plot’s top when there is room, so the two read as a pair', () => {
    const plot = rect(300, 220);
    expect(placeBeside(plot, SIZE, SCREEN).top).toBe(220);
  });
});
