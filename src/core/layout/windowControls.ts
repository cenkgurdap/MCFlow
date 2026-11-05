/**
 * How much of the top bar belongs to the operating system.
 *
 * On macOS the window is created with `titleBarStyle: 'hiddenInset'` — there is
 * no native title bar, the web contents run to the top of the window, and the
 * close / minimise / zoom traffic lights are painted *over* the top-left of them.
 * So the header in `AppShell` starts at x = 0 like any other element and the
 * MCFlow mark was drawn underneath the three buttons, with the wordmark crowding
 * them from the right. Windows and Linux keep a real title bar above the
 * contents, reserve nothing, and must stay exactly as they are.
 *
 * The arithmetic lives here rather than as a constant at the call site because of
 * the zoom, which is the part that is not obvious. `zoomStore` uses Chromium's
 * page zoom, so a CSS pixel is `zoom / 100` device pixels — but the traffic
 * lights are drawn by AppKit and do not scale with it. A fixed reservation is
 * therefore the right width only at 100%: at the ladder's bottom stop, 50%, it is
 * half of it in device pixels, and the overlap the fix was about comes straight
 * back. Dividing by the factor keeps the *device* width constant, which is the
 * width the OS is actually using.
 */

/**
 * Device pixels of spacer, at 100% zoom.
 *
 * `hiddenInset` places the three buttons at x = 20 on a 20 px pitch, so the
 * rightmost edge lands around 74. The spacer does not start at the window edge —
 * the header's own `px-2` is in front of it — so 72 covers the window from 8 to
 * 80, clearing the buttons with six pixels to spare, and the header's `gap-2`
 * plus the wordmark's `pl-1` put the MCFlow mark at **92**. That is inside the
 * 80–96 a stock macOS toolbar starts its first item at, and it is why the number
 * is 72 rather than the 84 the buttons themselves suggest.
 *
 * Taken from the layout AppKit documents rather than from a screenshot, because
 * nobody on this project has a Mac to screenshot. The three constants around
 * it — 8 before the strip, 12 after — are pinned by an end-to-end test, so a
 * padding change in `AppShell` cannot move the mark under the buttons unnoticed.
 */
export const WINDOW_CONTROLS_WIDTH = 72;

/**
 * Left inset for the app's top bar, in **CSS** pixels at the given zoom.
 *
 * Zero everywhere the OS reserves nothing, which is Windows, Linux and every
 * browser tab — the caller can apply the result unconditionally and the
 * non-macOS layout is byte-for-byte what it was.
 */
export function windowControlsInset(overlays: boolean, zoomPercent: number): number {
  if (!overlays) return 0;
  const factor = zoomPercent / 100;
  if (!Number.isFinite(factor) || factor <= 0) return WINDOW_CONTROLS_WIDTH;
  return Math.round(WINDOW_CONTROLS_WIDTH / factor);
}
