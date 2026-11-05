import { useEffect } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import {
  applyZoom, useZoom, ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN,
} from '@/state/zoomStore';
import { IconButton } from '@/ui/Button';
import { Tooltip, Kbd } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';

/**
 * The window's zoom, in the bottom-right corner of the status bar.
 *
 * Where every desktop application puts it, and where FCS Express puts it, which
 * matters more than usual here: this is the one control in MCFlow whose position
 * a user is likely to reach for from muscle memory formed in another product.
 *
 * ## What it replaced
 *
 * *Actual Size*, *Zoom In* and *Zoom Out* in the View menu, which were
 * Electron's own `resetZoom`/`zoomIn`/`zoomOut` roles. They worked, and they
 * were unusable as a feature: nothing on screen said what the current level was,
 * so a window left at 110% by a stray accelerator stayed there with no visible
 * cause and no visible cure, and reaching a menu three times to step three
 * notches is not how anybody adjusts a zoom. A readout with a control either
 * side of it answers "what is it now" and "change it" in the same 90 px.
 *
 * ## The percentage is a button
 *
 * Clicking the number resets to 100%, which is the gesture people try first, and
 * the explicit reset button beside it stays because the number does not *look*
 * like a button and a reset nobody can find is not a reset. Both call the same
 * action.
 *
 * The reset is rendered `invisible` rather than removed at 100% — it holds its
 * 22 px so the readout and the +/− buttons do not shift sideways the moment the
 * zoom returns to default, which is exactly when the eye is on them.
 */
export function ZoomControl() {
  const zoom = useZoom((s) => s.zoom);
  const zoomBy = useZoom((s) => s.zoomBy);
  const resetZoom = useZoom((s) => s.resetZoom);

  /*
     Push the stored level at the window once, on mount.

     The store reads `localStorage` in its initialiser, which gives the *number*
     back but changes nothing about the window — `applyZoom` is a side effect and
     a zustand initialiser is not the place for one. Without this, reopening the
     app at 125% would show "125%" beside a window drawn at 100%: the readout and
     the thing it describes disagreeing, which is the failure this control exists
     to fix.
  */
  useEffect(() => { applyZoom(useZoom.getState().zoom); }, []);

  /*
     Ctrl + wheel, anywhere in the window.

     `passive: false` on `window` so `preventDefault` is honoured — without it
     Chromium scrolls the surface under the pointer as well as zooming, and the
     worksheet slides out from under the plot being looked at. On `window` rather
     than on a container because the gesture belongs to the application, not to
     whatever happens to be under the cursor.

     One notch per event regardless of `deltaY`'s magnitude: a trackpad reports
     dozens of small deltas for one two-finger gesture and a mouse reports one
     large one, so accumulating them makes the same gesture mean different things
     on different hardware. The ladder in `zoomStore` is what keeps the result on
     a number somebody chose.
  */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      useZoom.getState().zoomBy(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  const atDefault = zoom === ZOOM_DEFAULT;

  return (
    <div className="flex items-center gap-0.5 shrink-0" data-zoom-control="">
      <Tooltip content={<span className="flex items-center gap-1.5">Zoom out <Kbd>Ctrl</Kbd>+wheel</span>}>
        <span>
          <IconButton
            label="Zoom out"
            size="sm"
            data-zoom-out=""
            disabled={zoom <= ZOOM_MIN}
            onClick={() => zoomBy(-1)}
          >
            <Minus size={12} />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip content="Application zoom — click to return to 100%">
        <button
          type="button"
          data-zoom-readout=""
          onClick={resetZoom}
          className={cn(
            'min-w-[46px] px-1 h-5 rounded-[var(--radius-xs)] tnum text-2xs',
            'transition-colors duration-[var(--dur-fast)] hover:bg-[var(--surface-hover)]',
            atDefault ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-accent)] font-medium',
          )}
        >
          {zoom}%
        </button>
      </Tooltip>

      <Tooltip content={<span className="flex items-center gap-1.5">Zoom in <Kbd>Ctrl</Kbd>+wheel</span>}>
        <span>
          <IconButton
            label="Zoom in"
            size="sm"
            data-zoom-in=""
            disabled={zoom >= ZOOM_MAX}
            onClick={() => zoomBy(1)}
          >
            <Plus size={12} />
          </IconButton>
        </span>
      </Tooltip>

      <Tooltip content="Reset to 100%">
        <span className={atDefault ? 'invisible' : undefined}>
          <IconButton label="Reset zoom to 100%" size="sm" data-zoom-reset="" onClick={resetZoom}>
            <RotateCcw size={11} />
          </IconButton>
        </span>
      </Tooltip>
    </div>
  );
}
