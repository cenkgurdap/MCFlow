import { useEffect, useMemo, useRef } from 'react';
import {
  bin2d, densityLevels, paintDensity, smoothHistogram2d,
  type DensityScale, type Histogram2D, type RampName,
} from '@/render/binning';
import {
  autoSmoothing, smoothExtent, summariseLevels,
  type ColorLevelSpec, type LevelSummary, type LevelTable,
} from '@/render/colorLevels';

export interface DensityDrawArgs {
  x: Float32Array;
  y: Float32Array;
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number };
  bins: number;
  scale: DensityScale;
  ramp: RampName;
  mask?: Uint8Array | null;
  /** Colour-level mapping — style and colour scaling. */
  levels?: ColorLevelSpec;
  /** Box-blur window over the bin grid, in cells. 1 is off. */
  smoothing?: number;
  /** Ignore `smoothing` and use the fixed data-unit bandwidth — see `autoSmoothing`. */
  smoothingAuto?: boolean;
  /** How wide an outlier cell is drawn, in cells. 1 is off. */
  outlierSize?: number;
  /** Where each axis's detector saturates, in display units; null where nothing does. */
  ceilings?: { x: number | null; y: number | null } | null;
}

/**
 * The first grid column and row at a detector's saturation — where the pile
 * lands — or null for an axis with none inside the viewport.
 */
export function pileEdges(
  viewport: DensityDrawArgs['viewport'],
  bins: number,
  ceilings: DensityDrawArgs['ceilings'],
): { col: number | null; row: number | null } | null {
  const edge = (top: number | null | undefined, lo: number, hi: number) => {
    if (top === null || top === undefined || !Number.isFinite(top)) return null;
    const b = Math.floor(((top - lo) * bins) / (hi - lo || 1));
    return b > 0 && b < bins ? b : null;
  };
  const col = edge(ceilings?.x, viewport.xMin, viewport.xMax);
  const row = edge(ceilings?.y, viewport.yMin, viewport.yMax);
  return col === null && row === null ? null : { col, row };
}

/**
 * The cells that may not set the levels: the pile, **and as far below it as the
 * kernel reaches**. Smoothing spills a pile's events into the rows beneath it,
 * and left in, that spill was still denser than the core and still set the
 * ceiling. They are drawn like any other cell.
 */
function pileCells(edges: ReturnType<typeof pileEdges>, width: number, reach: number): ((index: number) => boolean) | null {
  if (!edges) return null;
  const col = edges.col === null ? null : edges.col - reach;
  const row = edges.row === null ? null : edges.row - reach;
  return (i) => (col !== null && i % width >= col) || (row !== null && Math.floor(i / width) >= row);
}

/** A binned sample, and where its pile is. */
export interface DensityGrid {
  raw: Histogram2D;
  pile: ReturnType<typeof pileEdges>;
}

export function binDensity(a: Pick<DensityDrawArgs, 'x' | 'y' | 'viewport' | 'bins' | 'mask' | 'ceilings'>): DensityGrid {
  const raw = bin2d(
    a.x, a.y, a.viewport.xMin, a.viewport.xMax, a.viewport.yMin, a.viewport.yMax,
    a.bins, a.bins, a.mask,
  );
  return { raw, pile: pileEdges(a.viewport, a.bins, a.ceilings) };
}

/**
 * A grid smoothed and put in **× uniform**: a cell's share of the plot's events
 * times the number of cells, so 1 is events spread evenly and the number does
 * not depend on how many events the file holds. Twice the events, or the same
 * events twice, give the same colours.
 */
export function smoothDensity(grid: DensityGrid, window: number): { h: Histogram2D; unit: number; summary: LevelSummary } {
  const h = smoothHistogram2d(grid.raw, window);
  const unit = grid.raw.totalCount > 0 ? (h.width * h.height) / grid.raw.totalCount : 0;
  const excluded = pileCells(grid.pile, h.width, smoothExtent(window));
  return { h, unit, summary: summariseLevels(h.bins, unit, excluded) };
}

/**
 * The smoothing window a draw uses: Auto's bandwidth for this many events, or
 * the stated one. Auto reads the event count and nothing else, continuously and
 * unrounded, so two replicates are smoothed all but alike — two of them once fell
 * either side of a rounding step in the 0.36 rule and came out navy and cyan.
 */
export function densityWindow(a: Pick<DensityDrawArgs, 'bins' | 'smoothing' | 'smoothingAuto'>, events: number): number {
  return a.smoothingAuto ? autoSmoothing(a.bins, events) : a.smoothing ?? 1;
}

/** Bin, smooth and level: everything a draw decides from the data. No DOM. */
export interface DensityLevels {
  h: Histogram2D;
  table: LevelTable;
  /** Multiplies a cell value into the table's units. */
  unit: number;
  /** The window this draw actually used — Auto's, or the stated one. */
  smoothing: number;
}

export function buildDensityLevels(a: DensityDrawArgs): DensityLevels {
  const grid = binDensity(a);
  const smoothing = densityWindow(a, grid.raw.totalCount);
  const { h, unit, summary } = smoothDensity(grid, smoothing);
  const table = densityLevels(h, { scale: a.scale, levels: a.levels, unit, reference: summary });
  return { h, table, unit, smoothing };
}

/**
 * The bin-resolution picture, and everything derived from the data.
 *
 * Held apart from the blit because **none of it depends on the canvas size**, and
 * that turned out to matter a great deal. Binning, smoothing and colouring a
 * 1024×1024 grid is ~40 ms; scaling the result onto the canvas is under a
 * millisecond. A resize drag changes the canvas size on every pointer move and
 * nothing else — so recomputing the grid per frame was doing the expensive work to
 * produce a byte-identical answer, and it took the measured resize frame time from
 * 16.7 ms to 65 ms when the default resolution went to 1024.
 */
export interface DensityBitmap {
  /** Offscreen canvas at bin resolution. */
  source: HTMLCanvasElement;
  h: Histogram2D;
  /** The window this draw actually used. */
  smoothing: number;
}

/**
 * Bin, smooth and colour — the whole data-dependent half of a density draw.
 *
 * Shared by the on-screen layer and the image exporter, so an exported figure is
 * produced by exactly the code that drew the plot rather than a lookalike.
 */
export function buildDensityBitmap(a: DensityDrawArgs): DensityBitmap {
  const { h, table, unit, smoothing } = buildDensityLevels(a);
  const image = paintDensity(h, table, { ramp: a.ramp, unit, outlierSize: a.outlierSize });

  // The bin grid goes through an offscreen canvas so the blit can scale it.
  // Writing ImageData directly cannot scale, and drawing a million rects is far
  // slower.
  const source = document.createElement('canvas');
  source.width = h.width;
  source.height = h.height;
  source.getContext('2d')!.putImageData(image, 0, 0);
  return { source, h, smoothing };
}

/**
 * Scale a prepared bitmap onto a canvas.
 *
 * **Smoothing on the way down, off on the way up**, and the asymmetry is the
 * point. Upscaling with interpolation invents structure between bins. But the
 * default resolution is 1024×1024 against a plot around 230 px wide, so the grid
 * is *down*sampled roughly 4:1 — and nearest-neighbour downsampling point-samples
 * one cell in sixteen and throws the rest of the data on the floor.
 *
 * 0.37.0 coloured at the canvas's own resolution instead, from averaged values,
 * so a faint kernel tail became an opaque pixel; the plots read as dense and
 * bloated, and 0.37.1 put this back.
 */
export function blitDensity(
  canvas: HTMLCanvasElement,
  bitmap: DensityBitmap,
): Histogram2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const { source: off, h } = bitmap;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const downscaling = h.width > canvas.width;
  ctx.imageSmoothingEnabled = downscaling;
  if (downscaling) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  return h;
}

/**
 * Bin and blit in one call.
 *
 * The façade every caller that draws once uses — the image exporter, and the
 * harnesses. `DensityLayer` splits the two halves so a resize only pays for the
 * second.
 */
export function drawDensity(canvas: HTMLCanvasElement, a: DensityDrawArgs): Histogram2D | null {
  if (!canvas.getContext('2d')) return null;
  return blitDensity(canvas, buildDensityBitmap(a));
}

/**
 * 2D density plot, drawn to a Canvas2D layer.
 *
 * No colour bar on screen. It occupied 46 px on the right of every density panel
 * — a seventh of the plot at the default size — to say that darker means fewer
 * events, which the picture says on its own. An exported figure can carry one.
 *
 * Binning decouples cost from event count — a 1024×1024 grid is 1 048 576 cells
 * whether the sample has 15 000 events or a million — so this path stays fast
 * exactly where an alpha-blended dot plot starts to saturate into a solid blob.
 */
export function DensityLayer({
  x, y, viewport, width, height, bins, scale, ramp, mask, style, levels,
  smoothing, smoothingAuto, outlierSize, ceilings, onSmoothing,
}: {
  x: Float32Array;
  y: Float32Array;
  viewport: { xMin: number; xMax: number; yMin: number; yMax: number };
  width: number;
  height: number;
  bins: number;
  scale: DensityScale;
  ramp: RampName;
  mask?: Uint8Array | null;
  style?: React.CSSProperties;
  levels?: ColorLevelSpec;
  smoothing?: number;
  smoothingAuto?: boolean;
  outlierSize?: number;
  ceilings?: DensityDrawArgs['ceilings'];
  /**
   * The window this draw used, reported back so the settings panel can show it.
   *
   * Under Auto the number follows from the resolution; reported from the draw
   * so the settings panel shows exactly the window that was used.
   */
  onSmoothing?: (window: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * The expensive half, memoised on **everything except the canvas size**.
   *
   * `width` and `height` are deliberately absent from the dependencies. A resize
   * drag changes nothing else, and re-binning per frame to produce a
   * byte-identical grid was the difference between a 16 ms frame and a 65 ms one.
   */
  const bitmap = useMemo(
    () => buildDensityBitmap({
      x, y, viewport, bins, scale, ramp, mask, levels, smoothing, smoothingAuto, outlierSize, ceilings,
    }),
    [x, y, viewport, bins, scale, ramp, mask, levels, smoothing, smoothingAuto, outlierSize, ceilings],
  );

  // Reported from an effect rather than during the memo: a parent `setState`
  // called while this component is rendering is a React warning at best and a
  // loop at worst, and the value is wanted for display rather than for the draw.
  useEffect(() => { onSmoothing?.(bitmap.smoothing); }, [bitmap.smoothing, onSmoothing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    blitDensity(canvas, bitmap);
  }, [bitmap, width, height]);

  return <canvas ref={canvasRef} data-density-layer="" className="absolute pointer-events-none" style={{ width, height, ...style }} />;
}
