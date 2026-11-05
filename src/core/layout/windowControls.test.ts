import { describe, expect, it } from 'vitest';
import { WINDOW_CONTROLS_WIDTH, windowControlsInset } from './windowControls';

/**
 * `zoomStore.ZOOM_STEPS`, spelled out rather than imported: `core/` is store-free
 * and a colocated test is still `core/`. The property below holds at any zoom, so
 * the copy is a sample of the ladder and not a second definition of it.
 */
const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

describe('windowControlsInset', () => {
  it('reserves nothing where the OS reserves nothing', () => {
    // Windows, Linux and every browser tab. The assertion that matters is that
    // the fix cannot move the Windows title bar by a pixel at any zoom.
    for (const zoom of ZOOM_STEPS) expect(windowControlsInset(false, zoom)).toBe(0);
  });

  it('reserves the traffic lights at 100%', () => {
    expect(windowControlsInset(true, 100)).toBe(WINDOW_CONTROLS_WIDTH);
  });

  it('keeps the reserved strip the same width in device pixels at every zoom', () => {
    // The point of the division. The buttons are AppKit's and do not scale with
    // Chromium's page zoom, so what must stay constant is CSS px × factor.
    for (const zoom of ZOOM_STEPS) {
      const device = windowControlsInset(true, zoom) * (zoom / 100);
      expect(device).toBeGreaterThanOrEqual(WINDOW_CONTROLS_WIDTH - 1);
      expect(device).toBeLessThanOrEqual(WINDOW_CONTROLS_WIDTH + 1);
    }
  });

  it('still clears the buttons at the bottom of the zoom ladder', () => {
    // 50% was the case a fixed constant got wrong: 72 CSS px is 36 device px,
    // against traffic lights that end at 74.
    expect(windowControlsInset(true, 50)).toBe(WINDOW_CONTROLS_WIDTH * 2);
  });

  it('falls back to the unscaled width on a nonsense zoom', () => {
    expect(windowControlsInset(true, 0)).toBe(WINDOW_CONTROLS_WIDTH);
    expect(windowControlsInset(true, Number.NaN)).toBe(WINDOW_CONTROLS_WIDTH);
  });
});
