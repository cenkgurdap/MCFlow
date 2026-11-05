import { create } from 'zustand';
import { platform } from '@/platform';

/**
 * Application zoom — how large the whole window's chrome is drawn.
 *
 * ## What this is, and the one thing it is not
 *
 * This is the **window's** zoom, the thing every desktop application puts in the
 * bottom-right corner of its status bar: the sidebar, the worksheet, the
 * inspector, the type and the plots all get bigger together. It exists because a
 * 4K laptop panel renders a 28 px control row at about 7 mm and a projector in a
 * seminar room renders it at 3 cm, and neither is a property of the analysis.
 *
 * It is emphatically **not** a zoom on a plot's data view. That is a separate
 * decision, settled twice and still standing: a plot always shows the full range
 * of the data it is plotting, there is no pan, no zoom and no `viewport` on a
 * panel, because two panels of FSC-A × SSC-A are only comparable if they are
 * showing the *same* FSC-A × SSC-A. Nothing in this module touches a `Viewport`,
 * an axis limit or a panel field — the axes keep their numbers and the events
 * keep their positions; the pixels they are drawn at get larger. If a future
 * change makes this write anything on a `PanelConfig`, it has crossed that line.
 *
 * ## Why the platform does it rather than a CSS transform
 *
 * Under Electron this calls `webFrame.setZoomFactor`, which is Chromium's own
 * page zoom — the same mechanism Ctrl+ does in a browser. Every coordinate space
 * moves together: `clientX`, `getBoundingClientRect()`, `devicePixelRatio` and
 * layout are all consistent afterwards, so the plot's pointer arithmetic, the
 * gate hit tests and the canvas backing-store sizing keep working with no
 * changes at all.
 *
 * A `transform: scale()` on the root would have been the obvious alternative and
 * is the wrong tool: it scales what is painted without moving the layout under
 * it, so a pointer at the middle of a scaled canvas reports the coordinate of
 * the *unscaled* one and every gate would be drawn in the wrong place. CSS
 * `zoom` avoids that but leaves `offsetWidth` and `getBoundingClientRect()`
 * disagreeing, which is the same class of bug one step quieter. The browser
 * fallback below does use CSS `zoom`, because a plain tab has no page-zoom API
 * to reach and the fallback exists for design iteration rather than for use.
 *
 * ## Persistence
 *
 * `localStorage`, like the theme, and for the same reason: it is a statement
 * about this screen and this pair of eyes, not about the analysis. It is
 * deliberately absent from the workspace file, the cross-window sync snapshot
 * and the undo stack — a workspace emailed to a colleague must not resize their
 * window, and Ctrl+Z must not spend a press on it.
 */

const ZOOM_KEY = 'mcflow.zoom';

/** 100%, always available and always the reset target. */
export const ZOOM_DEFAULT = 100;

/**
 * The ladder the −/+ buttons and Ctrl+wheel step through.
 *
 * Stops rather than a continuous percentage, which is what every browser and
 * every desktop application does, and for a reason worth stating: a zoom arrived
 * at by accumulating wheel deltas lands on 113% and stays there, and 113% is a
 * number nobody chose. Coarse near the ends and fine around 100, because that is
 * where the adjustments actually are.
 */
export const ZOOM_STEPS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200] as const;

export const ZOOM_MIN = ZOOM_STEPS[0];
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/**
 * The next stop in `delta`'s direction, or the current value at the ends.
 *
 * Pure and exported so the ladder can be asserted directly: "+ from 90 is 100"
 * and "+ from 200 is 200" are the two properties that matter and neither is
 * visible in a rendered button.
 */
export function stepZoom(current: number, delta: 1 | -1): number {
  if (delta > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_MIN;
}

/** Clamp an arbitrary percentage into the supported range. */
export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent)));
}

function readStoredZoom(): number {
  if (typeof localStorage === 'undefined') return ZOOM_DEFAULT;
  const n = Number.parseFloat(localStorage.getItem(ZOOM_KEY) ?? '');
  return Number.isFinite(n) ? clampZoom(n) : ZOOM_DEFAULT;
}

/**
 * Push a percentage at the window.
 *
 * The Electron path is page zoom; the browser path is CSS `zoom` on the root
 * element, which is the closest a tab can get to it from inside.
 */
export function applyZoom(percent: number): void {
  const factor = percent / 100;
  const set = platform().setZoom;
  if (set) { set(factor); return; }
  if (typeof document !== 'undefined') {
    // `zoom` rather than `transform`, and `''` rather than `1` at the default so
    // the property is absent entirely when nobody has changed it.
    document.documentElement.style.zoom = factor === 1 ? '' : String(factor);
  }
}

interface ZoomState {
  /** Percent, e.g. 125. Never a factor — the readout is the source of truth. */
  zoom: number;
  setZoom(percent: number): void;
  /** One stop up or down the ladder. */
  zoomBy(delta: 1 | -1): void;
  resetZoom(): void;
}

export const useZoom = create<ZoomState>((set, get) => ({
  zoom: readStoredZoom(),
  setZoom(percent) {
    const next = clampZoom(percent);
    if (next === get().zoom) return;
    applyZoom(next);
    try { localStorage.setItem(ZOOM_KEY, String(next)); } catch { /* private mode */ }
    set({ zoom: next });
  },
  zoomBy(delta) { get().setZoom(stepZoom(get().zoom, delta)); },
  resetZoom() { get().setZoom(ZOOM_DEFAULT); },
}));
