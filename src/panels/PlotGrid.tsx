import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Columns2, Copy, LayoutGrid, Maximize, Plus, Replace, X } from 'lucide-react';
import { PlotCanvas } from './PlotCanvas';
import { SpectrumPanel } from './SpectrumPanel';
import { noteViewportWidth, usePlot } from '@/state/plotStore';
import { useGates } from '@/state/gateStore';
import { openFromPayloadAt, retargetPanel } from '@/state/layoutActions';
import { clearSelection, selectPanelOnly } from '@/state/selection';
import { isInternalDrag, readDragPayload, useDragState, type DragPayload } from './dragPayload';
import { selectedSample, useWorkspace } from '@/state/workspaceStore';
import {
  clampWidth, contentBounds, fitScale, isCompactWidth, panelHeight, panelRect, widthDelta,
  type Rect, type ResizeDir,
} from '@/core/layout/geometry';
import { Button, IconButton } from '@/ui/Button';
import { EmptyState } from '@/ui/Feedback';
import { Tooltip } from '@/ui/Tooltip';
import { VDivider } from '@/ui/Panel';
import { FlaskConical } from 'lucide-react';
import { cn } from '@/ui/cn';

/**
 * Pointer travel, in CSS pixels, before a press on a panel becomes a move.
 *
 * Only needed because the drag region is now the whole panel background: every
 * click that selects a plot arrives at the same handler, and without a threshold
 * the landing snap would move a panel by up to half a lattice step on a click
 * that was never a drag.
 */
const MOVE_THRESHOLD = 4;

/**
 * The plot worksheet — a positioned canvas, not a grid.
 *
 * Panels carry explicit coordinates and are dragged around **by their
 * background** — any corner, any edge, the toolbar's empty space, the plot area
 * itself with no tool armed — with no tool to select first. A worksheet is a
 * figure being assembled, and the arrangement carries meaning that a grid filled
 * in insertion order cannot express. Snapping is light (8 px) so two panels
 * dragged to "about the same place" line up.
 *
 * The canvas **fits its content**, in both directions. It grows to contain
 * whatever is on it — drop a fourth plot to the right of three and the worksheet
 * gets wider — and it shrinks back when the plot that needed the room is
 * removed, which growing alone does not give you. See `contentOffset`.
 *
 * Every panel's plot area is square, and every edge and corner resizes it while
 * keeping it so.
 *
 * It is also a drop target. Dragging a sample or a population here builds the
 * layout by direct manipulation — drop a gate, draw the next one on the plot
 * that appears, drop that, and a hierarchy comes out the other end. A drop lands
 * where it was released, and "empty space" now means any position that overlaps
 * no existing panel rather than an unused grid cell.
 */
export function PlotGrid() {
  const panels = usePlot((s) => s.panels);
  const activePanelId = usePlot((s) => s.activePanelId);
  const { addPanel, removePanel } = usePlot();

  const samples = useWorkspace((s) => s.samples);
  const selected = useWorkspace(selectedSample);

  /** The drag in flight, or null. Drives every drop affordance below. */
  const dragging = useDragState((s) => s.payload);
  /** Which region would receive a release right now: a panel id, or the canvas. */
  const [over, setOver] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 1200, height: 800 });
  /**
   * Worksheet zoom, for *fit to content*.
   *
   * A view transform and nothing else: it scales the canvas visually and every
   * coordinate underneath stays in unscaled worksheet pixels, so a panel's saved
   * position never depends on how the worksheet happened to be zoomed when it
   * was dropped. Pointer coordinates are divided back out in `toCanvas`.
   */
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      const width = Math.round(r.width);
      const height = Math.round(r.height);
      // Only on a real change. The canvas inside this container is sized *from*
      // this measurement, so an unconditional `setViewport` — which always
      // allocates a new object — can be re-triggered by the scrollbar it causes
      // to appear, and the two chase each other a frame at a time.
      setViewport((v) => (v.width === width && v.height === height ? v : { width, height }));
      // Automatic placement wraps at the edge of what the user can see, and only
      // this component knows how wide that is.
      noteViewportWidth(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rects: Rect[] = panels.map((p) => panelRect(p.x, p.y, p.w));
  const bounds = contentBounds(rects, { width: viewport.width / zoom, height: viewport.height / zoom });

  /** Pointer position in worksheet coordinates, undoing scroll and zoom. */
  const toCanvas = useCallback((e: { clientX: number; clientY: number }) => {
    const el = scrollRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: (e.clientX - r.left + el.scrollLeft) / zoom,
      y: (e.clientY - r.top + el.scrollTop) / zoom,
    };
  }, [zoom]);

  /* ---------------- Panel dragging ---------------- */

  /**
   * A panel being moved.
   *
   * `window` listeners rather than pointer capture, and the position is
   * recomputed at `pointerup` from the release coordinates as well as during the
   * move — both for the reason PROGRESS.md already records twice: Chromium
   * coalesces `pointermove` onto frames, so a quick flick can deliver almost no
   * moves and a gesture decided only by the last one lands short.
   */
  const move = useRef<
    {
      id: string; grabX: number; grabY: number; ox: number; oy: number; live: boolean;
      /**
       * The rest of the selection, as fixed offsets from the grabbed panel.
       *
       * Measured once, here, at `pointerdown` — see `movePanelGroup` for why
       * re-deriving them from live positions on every move would squash the
       * group against the origin.
       */
      others: Array<{ id: string; dx: number; dy: number }>;
    } | null
  >(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  /**
   * Every panel travelling with this drag, the grabbed one included.
   *
   * Separate from `movingId`, which stays the *grabbed* panel because that is
   * what the drag effect is keyed on and what the store's coalescing key is
   * built from. This is only for the treatment — lifted and slightly
   * transparent — and a group drag where four of the five plots stayed flat
   * would read as one plot moving and four following by accident.
   */
  const [movingIds, setMovingIds] = useState<readonly string[]>([]);

  const beginMove = (e: React.PointerEvent, id: string) => {
    // Left button only: a right-click opens a context menu.
    if (e.button !== 0) return;
    // A Ctrl+click — Cmd+click on macOS — is a selection gesture, not a drag.
    // Without this the toggle in `PlotCanvas` would be followed by this panel
    // being armed for a move, so clicking a plot out of the selection could
    // also nudge it. The two modifiers are read together here because
    // `PlotCanvas` reads them together; they are one gesture.
    if (e.ctrlKey || e.metaKey) return;
    // **A drawing tool locks the panel in place.** `PlotCanvas` already refuses to
    // call this while one is armed; the guard is repeated at the entry point
    // because this is where a panel move actually begins, and the lock is only
    // worth anything if it holds however this function is reached. Reading the
    // store rather than taking a prop keeps it true for any future caller.
    if (useGates.getState().tool !== 'none') return;
    const panel = usePlot.getState().panel(id);
    if (!panel) return;
    e.preventDefault();
    e.stopPropagation();
    const at = toCanvas(e);

    /*
       Dragging a member of a multi-selection moves all of it (Item 4).

       Only when the grabbed panel is **already** in the selection. Pressing on
       an unselected plot while others are selected means "select this one and
       drag it" — the press collapses the selection anyway, via
       `selectPanelOnly` below — and hauling three unrelated plots along
       because they were selected a gesture ago is the behaviour every file
       manager is careful not to have.
    */
    const st = usePlot.getState();
    const selected = st.selectedPanelIds;
    const group = selected.includes(id) ? selected : [id];
    const others = group
      .filter((x) => x !== id)
      .map((x) => st.panel(x))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ id: p.id, dx: p.x - panel.x, dy: p.y - panel.y }));

    move.current = {
      id, grabX: at.x - panel.x, grabY: at.y - panel.y,
      ox: e.clientX, oy: e.clientY, live: false, others,
    };
    setMovingId(id);
    setMovingIds(group);
    st.setActivePanel(id);
    // The selection is only collapsed when the press landed outside it. Doing
    // it unconditionally would throw away the very selection this drag is
    // about, one line after measuring it.
    if (others.length === 0) selectPanelOnly(id);
  };

  useLayoutEffect(() => {
    if (!movingId) return;
    const apply = (e: PointerEvent, snap: boolean) => {
      const m = move.current;
      if (!m) return;
      // **Nothing moves until the pointer has actually travelled.** Now that the
      // whole panel background is a drag region, every click that selects a panel
      // or dismisses something also arrives here — and a zero-distance "drag"
      // that still snapped would shift a panel by up to half a lattice step, so
      // clicking a plot would nudge it. Four pixels is below the threshold of a
      // deliberate drag and above the wobble of a firm click.
      if (!m.live) {
        if (Math.abs(e.clientX - m.ox) + Math.abs(e.clientY - m.oy) < MOVE_THRESHOLD) return;
        m.live = true;
      }
      const at = toCanvas(e);
      usePlot.getState().movePanelGroup(m.id, at.x - m.grabX, at.y - m.grabY, snap, m.others);
    };
    // Unsnapped while in flight so the panel tracks the pointer exactly, snapped
    // on release so it lands on the lattice. Snapping mid-drag makes the panel
    // stutter under a slow-moving pointer.
    const onMove = (e: PointerEvent) => apply(e, false);
    const onUp = (e: PointerEvent) => {
      apply(e, true);
      move.current = null;
      setMovingId(null);
      setMovingIds([]);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [movingId, toCanvas]);

  /* ---------------- Drops ---------------- */

  const drop = (e: React.DragEvent, onto: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    setOver(null);
    useDragState.getState().end();
    // Prefer the real payload; fall back to the in-flight store for the rare
    // environment that clears dataTransfer between dragstart and drop.
    const payload = readDragPayload(e.dataTransfer) ?? useDragState.getState().payload;
    if (!payload) return;
    if (onto) { retargetPanel(onto, payload); return; }
    // A drop onto the canvas lands **where it was released**, which is the whole
    // point of a positioned worksheet — the plot appears under the pointer
    // rather than at the end of a queue.
    const at = toCanvas(e);
    openFromPayloadAt(payload, { x: at.x - 40, y: at.y - 16 }, viewport.width / zoom);
  };

  const dragOver = (e: React.DragEvent, region: string) => {
    if (!isInternalDrag(e.dataTransfer) && !useDragState.getState().payload) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (over !== region) setOver(region);
  };

  if (samples.length === 0) {
    return (
      <div className="flex-1 grid place-items-center bg-[var(--surface-base)]">
        <EmptyState
          icon={<FlaskConical size={19} />}
          title="Nothing to plot yet"
          description="Import .fcs files from the sidebar, then select one to see its events on the plot canvas."
        />
      </div>
    );
  }

  /** Which sample a panel shows: its pin, or the sidebar selection. */
  const sampleFor = (pinnedId: string | null) =>
    (pinnedId ? samples.find((s) => s.id === pinnedId) : null) ?? selected;

  const zoomToFit = () => setZoom(fitScale(rects, viewport));

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 bg-[var(--surface-base)]">
      <div className="flex items-center gap-2 h-8 px-2.5 shrink-0 hairline-b">
        <span className="eyebrow">Worksheet</span>
        <span className="text-2xs text-[var(--text-tertiary)] truncate">
          {panels.length === 0
            ? 'empty'
            : `${panels.length} plot${panels.length === 1 ? '' : 's'} · drag a plot anywhere on its background to move it, an edge or corner to resize${
              // Only once there is a second plot to add to a selection. On a
              // one-plot worksheet it is advice with nothing to apply it to.
              panels.length > 1 ? ', Ctrl+click to select several' : ''}`}
        </span>
        <VDivider />
        <Tooltip content="Fit every plot into the window">
          <Button size="sm" variant="ghost" icon={<Maximize size={12} />} onClick={zoomToFit} disabled={panels.length === 0}>
            Fit
          </Button>
        </Tooltip>
        {zoom !== 1 && (
          <Tooltip content="Back to actual size">
            <button
              onClick={() => setZoom(1)}
              className="px-1.5 h-5 rounded-[var(--radius-xs)] text-[10px] font-mono bg-[var(--accent-500)]/15 text-[var(--text-accent)]"
            >
              {Math.round(zoom * 100)}%
            </button>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip content="Duplicate the active plot">
            <Button
              size="sm" variant="ghost" icon={<Copy size={12} />}
              onClick={() => addPanel(activePanelId)}
              disabled={panels.length === 0}
            >
              Duplicate
            </Button>
          </Tooltip>
          <Tooltip content="Add an empty plot">
            <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={() => addPanel()}>
              Add plot
            </Button>
          </Tooltip>
        </div>
      </div>

      <div
        ref={scrollRef}
        // Stable hook for the verification harness: the container's structure
        // depends on how many panels are on it, so it cannot be found by shape.
        data-worksheet=""
        className="flex-1 min-h-0 min-w-0 overflow-auto relative"
        onDragOver={(e) => dragOver(e, 'canvas')}
        onDrop={(e) => drop(e, null)}
        onDragLeave={(e) => {
          // Only when leaving the container itself, not on the way into a child.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
        }}
        // Clicking the worksheet itself — a gap, or past the last panel — clears
        // the selection, all of it. Without it a panel stays armed for Escape
        // long after the user has stopped thinking about it, and a gate stays
        // selected for the rest of the session.
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.canvas !== undefined) {
            clearSelection();
          }
        }}
      >
        <div
          data-canvas=""
          className="relative"
          style={{
            // The canvas is as large as its content, which is what makes a panel
            // dropped past the right-hand edge extend the worksheet instead of
            // being clipped or bounced back.
            width: bounds.width,
            height: bounds.height,
            transform: zoom === 1 ? undefined : `scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          {panels.length === 0 && <EmptyLayout active={over === 'canvas'} dragging={!!dragging} onAdd={() => addPanel()} />}

          {panels.map((p) => {
            const sample = sampleFor(p.sampleId);
            if (!sample) return null;
            const compact = isCompactWidth(p.w);
            return (
              <div
                key={p.id}
                className={cn('absolute anim-panel-in', movingIds.includes(p.id) && 'z-30 opacity-95')}
                style={{ left: p.x, top: p.y, width: p.w, height: panelHeight(p.w) }}
                onDragOver={(e) => dragOver(e, p.id)}
                onDrop={(e) => drop(e, p.id)}
              >
                {/* A spectrum panel is an ordinary panel in every respect the
                    worksheet cares about — position, size, resize handles, the
                    sample it is pinned to, the population it is scoped to — and
                    plots one population across every detector rather than the
                    panel's two parameters. That is one branch here rather than a
                    fourth case through every axis, transform and gate path in
                    `PlotCanvas`. See `SpectrumPanel`. */}
                {p.plotType === 'spectrum' ? (
                  <SpectrumPanel
                    sample={sample}
                    panel={p}
                    moving={movingIds.includes(p.id)}
                    onMovePointerDown={(e) => beginMove(e, p.id)}
                    panelActions={
                      <Tooltip content="Remove this plot">
                        <IconButton label="Remove plot" size="sm" onClick={() => removePanel(p.id)}>
                          <X size={11} />
                        </IconButton>
                      </Tooltip>
                    }
                  />
                ) : (
                <PlotCanvas
                  sample={sample}
                  panelId={p.id}
                  compact={compact}
                  moving={movingIds.includes(p.id)}
                  onMovePointerDown={(e) => beginMove(e, p.id)}
                  // The sample pin is gone. It let a panel be frozen onto one
                  // file while the rest followed the sidebar — a real
                  // distinction once, and one the panel pass largely settled the
                  // other way: gating is shared, a dropped population follows the
                  // active sample, and a panel that must hold still is pinned by
                  // dropping the sample onto it. What is left is a two-state
                  // toggle nobody was reaching for, in a toolbar with no room for
                  // it. Removing it is also what makes the delete control fit.
                  panelActions={
                    <Tooltip content="Remove this plot">
                      <IconButton label="Remove plot" size="sm" onClick={() => removePanel(p.id)}>
                        <X size={11} />
                      </IconButton>
                    </Tooltip>
                  }
                />
                )}
                {dragging && <ReplaceOverlay active={over === p.id} payload={dragging} />}
                <ResizeHandles panel={p} toCanvas={toCanvas} />
              </div>
            );
          })}

          {/* Where a release would land. Only while dragging, and only over the
              canvas rather than over a panel, so "new plot here" and "replace
              this plot" are never both shown. */}
          {dragging && over === 'canvas' && panels.length > 0 && (
            <DropHint payload={dragging} />
          )}
        </div>
      </div>
    </div>
  );

}

/* ========================================================================== */

/**
 * Every edge and every corner resizes the panel, and the panel stays square.
 *
 * The square is not negotiable — both axes of a cytometry plot are the same kind
 * of measurement, and a population that is round at 1:1 reads as a different
 * population at 2:1 — so there is only ever *one* number to change, the width,
 * and the height follows through `panelHeight`. That makes an aspect-locked drag
 * the whole of the problem: eight handles, one degree of freedom.
 *
 * Which is why the pointer delta is **projected** onto that one degree rather
 * than one axis being picked and the other thrown away — see `widthDelta`.
 *
 * The opposite edge is the anchor. Dragging the left edge moves `x` as the width
 * changes so the right edge stays under nothing in particular — which is what
 * "resize from this side" means, and why the store takes the position and the
 * width in one action: undone separately they would put the panel somewhere it
 * never was.
 *
 * **The drag is tracked on `window`, not by pointer capture.** A handle is six
 * pixels wide and the first move takes the pointer off it, so there is nothing
 * to receive the rest of the gesture — and `setPointerCapture` is not the answer
 * here for the reason this project has already recorded twice: it stops
 * delivering the moment the pointer is over another element, and it throws
 * outright on a pointer id the browser does not consider active, which for a
 * synthesised event takes the *next* statement with it. That is what made this
 * silently do nothing: capture threw, and the line that stored the drag's origin
 * never ran. Panel moves listen on `window` for exactly this reason; so does
 * this.
 *
 * A top-level component, not a closure inside `PlotGrid`: a component declared
 * inside another is a new type on every render, so React unmounts and remounts
 * it — taking its refs with it — the moment anything in the worksheet changes,
 * which is every pointer move of the drag it is meant to be tracking.
 */
/** Where each handle sits, and what the pointer looks like over it. */
const HANDLE_STYLE: Record<ResizeDir, { className: string; cursor: string }> = {
  n: { className: 'left-3 right-3 top-0 h-1.5', cursor: 'ns-resize' },
  s: { className: 'left-3 right-3 bottom-0 h-1.5', cursor: 'ns-resize' },
  e: { className: 'top-3 bottom-3 right-0 w-1.5', cursor: 'ew-resize' },
  w: { className: 'top-3 bottom-3 left-0 w-1.5', cursor: 'ew-resize' },
  ne: { className: 'top-0 right-0 w-3 h-3', cursor: 'nesw-resize' },
  nw: { className: 'top-0 left-0 w-3 h-3', cursor: 'nwse-resize' },
  se: { className: 'bottom-0 right-0 w-3 h-3', cursor: 'nwse-resize' },
  sw: { className: 'bottom-0 left-0 w-3 h-3', cursor: 'nesw-resize' },
};

const RESIZE_DIRS = Object.keys(HANDLE_STYLE) as ResizeDir[];

function ResizeHandles({
  panel, toCanvas,
}: {
  panel: { id: string; x: number; y: number; w: number };
  toCanvas: (e: { clientX: number; clientY: number }) => { x: number; y: number };
}) {
  const start = useRef<
    { dir: ResizeDir; px: number; py: number; x0: number; y0: number; w0: number; h0: number } | null
  >(null);
  /** Arms the window listeners below. State, because an effect keys off it. */
  const [dragging, setDragging] = useState(false);

  /**
   * The current `toCanvas`, for the window listener.
   *
   * The listener is attached once per drag; `toCanvas` closes over the worksheet
   * zoom and is rebuilt whenever that changes. Reading it through a ref keeps the
   * drag on current geometry without re-attaching mid-gesture, which would drop
   * events.
   */
  const toCanvasRef = useRef(toCanvas);
  toCanvasRef.current = toCanvas;

  useLayoutEffect(() => {
    if (!dragging) return;
    const apply = (e: PointerEvent) => {
      const s0 = start.current;
      if (!s0) return;
      const at = toCanvasRef.current(e);
      // Clamped before the anchor is worked out, or a panel held against its
      // minimum would keep sliding while the width stopped changing.
      const w = clampWidth(s0.w0 + widthDelta(s0.dir, at.x - s0.px, at.y - s0.py));
      const h = panelHeight(w);
      usePlot.getState().resizePanel(panel.id, w, {
        x: s0.dir.includes('w') ? s0.x0 + s0.w0 - w : s0.x0,
        y: s0.dir.includes('n') ? s0.y0 + s0.h0 - h : s0.y0,
      });
    };
    // Re-applied at `pointerup` from the release coordinates as well as during
    // the move: Chromium coalesces `pointermove` onto frames, so a quick flick
    // can deliver almost none and a gesture decided only by the last one lands
    // short. Third feature in this project to need it.
    const onUp = (e: PointerEvent) => {
      apply(e);
      start.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', apply);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', apply);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, panel.id]);

  return (
    <>
      {RESIZE_DIRS.map((dir) => (
        <div
          key={dir}
          data-resize-handle={panel.id}
          data-resize-dir={dir}
          title="Drag to resize — the plot stays square"
          className={cn('absolute z-20', HANDLE_STYLE[dir].className)}
          style={{ cursor: HANDLE_STYLE[dir].cursor }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const at = toCanvas(e);
            start.current = {
              dir, px: at.x, py: at.y,
              x0: panel.x, y0: panel.y, w0: panel.w, h0: panelHeight(panel.w),
            };
            setDragging(true);
          }}
        />
      ))}
    </>
  );
}

/* ========================================================================== */

/** What a payload will produce, said in the user's terms rather than the model's. */
function describe(payload: DragPayload): string {
  return payload.kind === 'sample'
    ? payload.sampleIds.length > 1 ? `${payload.sampleIds.length} new plots` : 'a new plot'
    : `a plot of ${payload.gateName}`;
}

/**
 * "Release here and a plot appears here."
 *
 * Pinned to the top of the canvas rather than following the pointer: a hint that
 * chases the cursor across a scrolling region is harder to read than one that
 * stays put, and the position of the drop is already obvious from the pointer.
 */
function DropHint({ payload }: { payload: DragPayload }) {
  return (
    <div
      className={cn(
        'absolute left-1/2 -translate-x-1/2 top-3 z-40 pointer-events-none anim-fade',
        'flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-sm)]',
        'border border-[var(--accent-500)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]',
      )}
    >
      <LayoutGrid size={13} className="text-[var(--text-accent)]" />
      <p className="text-xs text-[var(--text-primary)]">Release for {describe(payload)}</p>
    </div>
  );
}

/**
 * The "this panel would be replaced" affordance.
 *
 * Non-interactive: the drag handlers live on the wrapper and drag events bubble,
 * so this only has to say what will happen.
 */
function ReplaceOverlay({ active, payload }: { active: boolean; payload: DragPayload }) {
  return (
    <div
      className={cn(
        'absolute inset-0 z-20 grid place-items-center rounded-[var(--radius-md)] pointer-events-none',
        'transition-opacity duration-[var(--dur-fast)]',
        active ? 'opacity-100 bg-[var(--surface-base)]/70 ring-2 ring-[var(--accent-500)]' : 'opacity-0',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)]">
        <Replace size={13} className="text-[var(--text-accent)]" />
        <span className="text-xs text-[var(--text-primary)]">
          Replace with {payload.kind === 'sample' ? 'this sample' : payload.gateName}
        </span>
      </div>
    </div>
  );
}

/**
 * The worksheet with nothing on it.
 *
 * Reachable by removing every plot, and the natural starting point for building
 * a layout by dragging. A blank canvas here would read as a bug, so it states
 * the gesture and offers the button for anyone who would rather click.
 */
function EmptyLayout({ active, dragging, onAdd }: { active: boolean; dragging: boolean; onAdd: () => void }) {
  return (
    <div
      className={cn(
        'absolute inset-3 grid place-items-center rounded-[var(--radius-lg)] border-2 border-dashed',
        'transition-colors duration-[var(--dur-fast)]',
        active
          ? 'border-[var(--accent-500)] bg-[var(--accent-500)]/8'
          : dragging
            ? 'border-[var(--accent-500)]/50'
            : 'border-[var(--border-default)]',
      )}
    >
      <EmptyState
        icon={<LayoutGrid size={19} />}
        title="Empty worksheet"
        description="Drag a sample or a population anywhere on this canvas to create a plot there. Dropping a population opens a plot of just those events, and the next gate you draw becomes its child."
        action={
          <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={onAdd}>
            Add an empty plot
          </Button>
        }
      />
    </div>
  );
}

/** Toolbar action for the top bar, so a second plot is discoverable at one panel. */
export function AddPlotButton() {
  const addPanel = usePlot((s) => s.addPanel);
  const panels = usePlot((s) => s.panels);
  return (
    <Tooltip content={panels.length <= 1 ? 'Split into a multi-plot layout' : 'Add another plot'}>
      <IconButton label="Add plot" onClick={() => addPanel()}>
        <Columns2 size={15} />
      </IconButton>
    </Tooltip>
  );
}
