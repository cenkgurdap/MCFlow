import { VIRIDIS } from './viridis';
import { CIVIDIS } from './cividis';
import { RAINBOW, type Rgb } from './ramps';
import {
  buildLevelTable, quantum, smooth2d, smoothExtent, smoothKernel, summariseLevels,
  type ColorLevelSpec, type LevelSummary, type LevelTable,
} from './colorLevels';

/**
 * 2D and 1D binning for density plots and histograms.
 *
 * Binning is the right answer for density at flow-cytometry scale: a 1024×1024
 * grid is 1 048 576 cells regardless of whether the sample has 15 000 events or
 * 1 000 000, so render cost stops scaling with event count entirely.
 */

export interface Histogram2D {
  /**
   * Cell values. Integer counts as binned; `Float32Array` once smoothed, because
   * an average of nine counts is not a count.
   */
  bins: Uint32Array | Float32Array;
  width: number;
  height: number;
  xMin: number; xMax: number;
  yMin: number; yMax: number;
  maxCount: number;
  totalCount: number;
  /**
   * Cells holding at least one event, **as binned** — before any smoothing.
   *
   * Counted here because it is free here: the binning loop already knows when a
   * cell goes from empty to occupied. It is what `autoSmoothing` reads, and it
   * has to be the pre-smoothing figure, since a blur occupies neighbours and
   * would make the measurement depend on the answer it is being used to compute.
   */
  occupied: number;
}

export function bin2d(
  x: Float32Array,
  y: Float32Array,
  xMin: number, xMax: number,
  yMin: number, yMax: number,
  width = 256,
  height = 256,
  mask?: Uint8Array | null,
): Histogram2D {
  const bins = new Uint32Array(width * height);
  const spanX = xMax - xMin || 1;
  const spanY = yMax - yMin || 1;
  const sx = width / spanX;
  const sy = height / spanY;

  let maxCount = 0;
  let totalCount = 0;
  let occupied = 0;
  for (let i = 0; i < x.length; i++) {
    if (mask && !mask[i]) continue;
    const bx = Math.floor((x[i]! - xMin) * sx);
    const by = Math.floor((y[i]! - yMin) * sy);
    // Events outside the current viewport are simply not binned; clamping them
    // into the edge cells would produce a bright false rim.
    if (bx < 0 || bx >= width || by < 0 || by >= height) continue;
    const c = ++bins[by * width + bx]!;
    if (c === 1) occupied++;
    if (c > maxCount) maxCount = c;
    totalCount++;
  }

  return { bins, width, height, xMin, xMax, yMin, yMax, maxCount, totalCount, occupied };
}

/**
 * Colour ramps, as 256-entry lookup tables.
 *
 * **Two**, each answering a stated question. Abyss, Ember and Glacier were house
 * designs and went on 2026-07-31; Flame arrived in their place, was removed,
 * restored, and removed again on 2026-08-03 — see `ramps.ts` for the whole of
 * that argument and why it finally settled.
 *
 *   **Rainbow** (default) — a spectral ramp, in a deliberately calmer register
 *   than the saturated primaries `jet` uses. Not perceptually uniform and not
 *   monotonic in lightness; the default because it puts more distinguishable
 *   hues across the middle of the range than a uniform ramp can, which is what
 *   finding the shoulder of a population wants, and because its floor
 *   (`#101f52`) stays visible against the `#0a0c10` plot surface.
 *
 *   **Viridis** — perceptually uniform, from matplotlib's own table. The right
 *   answer when the question is quantitative: equal steps in density are equal
 *   steps in appearance.
 *
 * Duplicated as numbers here rather than read from the `--ramp-*` design tokens
 * because the render path cannot read a CSS variable per pixel. The tokens exist
 * for the same two names and are the swatch's business, not the renderer's.
 */
export const RAMPS: Record<string, Rgb[]> = {
  rainbow: RAINBOW,
  viridis: VIRIDIS,
  cividis: CIVIDIS,
};

export type RampName = keyof typeof RAMPS;

/** Sample a ramp at t in [0,1] with linear interpolation. */
export function sampleRamp(ramp: Array<[number, number, number]>, t: number): [number, number, number] {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const pos = clamped * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = ramp[i]!;
  const b = ramp[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export type DensityScale = 'linear' | 'log' | 'sqrt' | 'rank';

/** Everything that decides which level each cell lands on. */
export interface DensityLevelOptions {
  scale: DensityScale;
  /** Colour-level mapping. Omitted means plain `linear` style over the data. */
  levels?: ColorLevelSpec;
  /** Multiply a cell value by this to put it in the reference's units. 1 when omitted. */
  unit?: number;
  /**
   * The distribution the levels come from — pooled across samples, usually. The
   * grid's own when omitted, which is the *This plot* scope.
   */
  reference?: LevelSummary | null;
  /** A stated Linear-style ceiling, in the reference's units. */
  ceiling?: number | null;
  /** Cells that may not set the grid's own levels — the pile at a detector's maximum. */
  excluded?: ((index: number) => boolean) | null;
}

/** Everything that decides what colour a cell gets, and how big the picture is. */
export interface DensityColorOptions extends DensityLevelOptions {
  ramp: RampName;
  /** Cells with no events are transparent so the plot background shows through. */
  transparentZero?: boolean;
  /**
   * How many cells wide an outlier is drawn. 1, or omitted, draws it like any
   * other cell. See `dilateOutliers`.
   */
  outlierSize?: number;
}

/** The level table for a grid, under the options' reference. */
export function densityLevels(h: Histogram2D, opts: DensityLevelOptions): LevelTable {
  const spec: ColorLevelSpec = opts.levels ?? { style: 'linear', scaling: 'linear' };
  const reference = opts.reference ?? summariseLevels(h.bins, opts.unit ?? 1, opts.excluded);
  return buildLevelTable(reference, spec, opts.scale, opts.ceiling);
}

/**
 * An **outlier** is a cell holding the least signal any occupied cell holds.
 *
 * On a raw grid that is exactly a cell with one event in it; after smoothing it
 * is exactly a cell that received one event's worth from one event and nothing
 * from anywhere else. The definition is a property of the data alone — it does
 * not move when the ramp, the style or the scaling changes — which is what makes
 * it usable, and it is the third definition tried. The two rejected ones are
 * recorded in CHANGELOG: *below the bottom sixteenth of the ramp* came out empty
 * under percentile styling, and *the bottom sixteenth of the density scale*
 * swallowed most of the plot under `rank`.
 *
 * Returns `null` when there is nothing to mark — an empty grid, or one where every
 * occupied cell holds the same value, where "the sparsest" describes all of them
 * and enlarging all of them means enlarging nothing.
 */
export function outlierValue(bins: ArrayLike<number>): number | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i];
    if (v <= 0) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || min >= max) return null;
  return min;
}

/**
 * Grow every outlier cell to a square of `size` cells, in place, in the packed
 * word buffer.
 *
 * **The colour is copied from the cell being grown**, so nothing here decides
 * what an outlier looks like — the level table already did, exactly as it did for
 * every other occupied cell. That is the whole difference between this and the
 * outlier band removed on 2026-08-01, which painted those cells one flat colour
 * *instead of* consulting the table and so put 41% of a sparse plot beyond the
 * reach of the Colour scaling control.
 *
 * Why it is needed at all: at the 1024×1024 default the grid is downscaled about
 * four to one onto a ~230 px panel, and `imageSmoothingEnabled` averages sixteen
 * cells into one pixel. A single isolated cell contributes a sixteenth of one
 * pixel and effectively vanishes — so the sparse periphery, which is the part of
 * a plot you gate against, thins out as the resolution rises. Two cells wide is
 * four sixteenths and survives the resample.
 *
 * Only empty neighbours are written, so growing an outlier never overwrites a
 * denser cell and the shape of the population is untouched. Reads come from the
 * original grid rather than from the buffer being written, so one grown cell
 * cannot seed another.
 */
function dilateOutliers(
  words: Uint32Array,
  bins: ArrayLike<number>,
  width: number,
  height: number,
  value: number,
  size: number,
): void {
  const r = Math.floor(size / 2);
  const lead = size - 1 - r;
  for (let by = 0; by < height; by++) {
    const src = by * width;
    for (let bx = 0; bx < width; bx++) {
      if (bins[src + bx] !== value) continue;
      const colour = words[(height - 1 - by) * width + bx]!;
      for (let dy = -r; dy <= lead; dy++) {
        const ny = by + dy;
        if (ny < 0 || ny >= height) continue;
        const row = (height - 1 - ny) * width;
        const nsrc = ny * width;
        for (let dx = -r; dx <= lead; dx++) {
          const nx = bx + dx;
          if (nx < 0 || nx >= width) continue;
          // Never over an occupied cell: an outlier is drawn bigger, not louder.
          if (bins[nsrc + nx] > 0) continue;
          words[row + nx] = colour;
        }
      }
    }
  }
}

/**
 * Paint a grid through a level table, one pixel per cell.
 *
 * The bitmap is the grid's own size and the browser scales it onto the canvas,
 * smoothing on the way down — see `blitDensity`. Painting at the canvas's
 * resolution instead was tried in 0.37.0 and reverted in 0.37.1: every faint
 * kernel tail became an opaque pixel, and the plots read as denser and bigger
 * than the data.
 *
 * **Every occupied cell goes through the level table, and that is not negotiable.**
 * There used to be a branch that painted the minimum-value cells a flat colour —
 * the "outlier" band. On a sparse sample at the 1024×1024 default it was 41% of
 * the occupied cells and essentially all of the periphery, which is what made the
 * Colour scaling control look inert. It is gone and it stays gone: an outlier is
 * now *enlarged* (`dilateOutliers`) rather than *recoloured*.
 */
export function paintDensity(
  h: Histogram2D,
  table: LevelTable,
  opts: Pick<DensityColorOptions, 'ramp' | 'transparentZero' | 'outlierSize' | 'unit'>,
): ImageData {
  const ramp = RAMPS[opts.ramp] ?? RAMPS.viridis!;
  const transparentZero = opts.transparentZero ?? true;
  const unit = opts.unit ?? 1;
  const img = new ImageData(h.width, h.height);
  // **One 32-bit write per cell rather than four 8-bit ones.** The ramp is packed
  // into premade RGBA words and the ImageData is addressed through a `Uint32Array`
  // view of the same buffer.
  const words = new Uint32Array(img.data.buffer, img.data.byteOffset, h.width * h.height);
  const packed = packRamp(ramp);
  const last = ramp.length - 1;
  const positions = table.positions;
  for (let by = 0; by < h.height; by++) {
    // Flip vertically: bin row 0 is the lowest y value, image row 0 is the top.
    const src = by * h.width;
    const dst = (h.height - 1 - by) * h.width;
    for (let bx = 0; bx < h.width; bx++) {
      const value = h.bins[src + bx]!;
      if (value <= 0 && transparentZero) { words[dst + bx] = 0; continue; }
      words[dst + bx] = packed[Math.round(positions[quantum(value * unit)]! * last)] ?? packed[0]!;
    }
  }

  // A second pass, and deliberately a second pass: it reads the colours the first
  // one produced rather than deciding any of its own.
  const size = Math.max(1, Math.round(opts.outlierSize ?? 1));
  if (size > 1) {
    const lone = outlierValue(h.bins);
    if (lone !== null) dilateOutliers(words, h.bins, h.width, h.height, lone, size);
  }
  return img;
}

/**
 * Render a 2D histogram into RGBA pixels — levels and paint in one call.
 *
 * Two stages, and they are separate settings for a reason set out at length in
 * `colorLevels.ts`: the **density scaling** compresses a count range spanning
 * three orders of magnitude into 0…1, and the **colour levels** decide where in
 * the ramp that lands.
 */
export function renderDensity(h: Histogram2D, opts: DensityColorOptions): ImageData {
  return paintDensity(h, densityLevels(h, opts), opts);
}

/**
 * A ramp as opaque RGBA words, in this machine's byte order.
 *
 * Cached per ramp: the tables are module constants, so the pack happens once for
 * the life of the process rather than once per draw.
 *
 * The order is *detected* rather than assumed. Every platform this ships on is
 * little-endian, so the assumption would hold — but the failure mode of getting it
 * wrong is a plot with its red and blue channels swapped, which looks like a
 * deliberate ramp rather than like a bug, and detecting it costs eight bytes once.
 */
const packedRamps = new WeakMap<Rgb[], Uint32Array>();
const LITTLE_ENDIAN = (() => {
  const probe = new Uint32Array(1);
  new Uint8Array(probe.buffer)[0] = 1;
  return probe[0] === 1;
})();

function packRamp(ramp: Rgb[]): Uint32Array {
  const cached = packedRamps.get(ramp);
  if (cached) return cached;
  const out = new Uint32Array(ramp.length);
  for (let i = 0; i < ramp.length; i++) {
    const [r, g, b] = ramp[i]!;
    out[i] = LITTLE_ENDIAN
      ? (255 << 24) | (b << 16) | (g << 8) | r
      : (r << 24) | (g << 16) | (b << 8) | 255;
  }
  packedRamps.set(ramp, out);
  return out;
}

/** The positional form, for callers that pass the options as arguments. */
export function densityToImage(
  h: Histogram2D,
  rampName: RampName,
  scale: DensityScale = 'log',
  transparentZero = true,
  levels?: ColorLevelSpec,
): ImageData {
  return renderDensity(h, { ramp: rampName, scale, transparentZero, levels });
}

/**
 * Smooth a bin grid, returning a new histogram.
 *
 * `maxCount` is recomputed, because it is what every level mapping normalises
 * against and a blur lowers the peak. `totalCount` is left alone: it is the number
 * of events that were binned, which smoothing does not change.
 */
export function smoothHistogram2d(h: Histogram2D, window: number): Histogram2D {
  if (smoothExtent(window) <= 0) return h;
  const bins = smooth2d(h.bins, h.width, h.height, window);
  let maxCount = 0;
  for (let i = 0; i < bins.length; i++) if (bins[i] > maxCount) maxCount = bins[i];
  return { ...h, bins, maxCount };
}


/* ==========================================================================
   1D histogram
   ========================================================================== */

export interface Histogram1D {
  bins: Float64Array;
  count: number;
  min: number;
  max: number;
  maxBin: number;
  /** Events that fell outside [min, max]. */
  outOfRange: number;
}

export function bin1d(
  values: Float32Array,
  min: number,
  max: number,
  binCount = 256,
  mask?: Uint8Array | null,
): Histogram1D {
  const bins = new Float64Array(binCount);
  const span = max - min || 1;
  const s = binCount / span;
  let count = 0;
  let outOfRange = 0;

  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const b = Math.floor((values[i]! - min) * s);
    // `!(b >= 0)` rather than `b < 0`: a non-finite value — a 0/0 on a ratio
    // parameter — floors to NaN, which fails every comparison, so the old test
    // let it through to `count` without a bin to land in. It has no position
    // on the axis; it is counted with the events that are off it.
    if (!(b >= 0) || b >= binCount) { outOfRange++; continue; }
    bins[b]!++;
    count++;
  }

  let maxBin = 0;
  for (let i = 0; i < binCount; i++) if (bins[i]! > maxBin) maxBin = bins[i]!;
  return { bins, count, min, max, maxBin, outOfRange };
}

/** Scale a histogram so its area — not its peak — is 1. */
export function normaliseArea(h: Histogram1D): Float64Array {
  const out = new Float64Array(h.bins.length);
  if (h.count === 0) return out;
  const binWidth = (h.max - h.min) / h.bins.length;
  for (let i = 0; i < h.bins.length; i++) out[i] = h.bins[i]! / (h.count * binWidth);
  return out;
}

/** Scale a histogram so its tallest bin is 1 — the usual overlay convention. */
export function normalisePeak(h: Histogram1D): Float64Array {
  return normaliseTo(h, h.maxBin);
}

/**
 * Scale a histogram by a divisor chosen elsewhere.
 *
 * Exists so a **subset** of a distribution can be drawn against the
 * distribution's own peak rather than against its own (2026-08-11, Item 11). A
 * gated slice normalised to itself is a different vertical scale from the curve
 * it was taken out of, so the shaded region and the curve stop describing the
 * same events — see `HistogramLayer`. A divisor of zero or a non-finite one
 * gives a flat zero curve, which is the honest picture of an empty selection.
 */
export function normaliseTo(h: Histogram1D, divisor: number): Float64Array {
  const out = new Float64Array(h.bins.length);
  if (!(divisor > 0)) return out;
  for (let i = 0; i < h.bins.length; i++) out[i] = h.bins[i]! / divisor;
  return out;
}

/**
 * Moving-average smoothing.
 *
 * A raw 256-bin histogram of 15 000 events is visibly noisy; a small window
 * makes the distribution readable without inventing structure. Window sizes
 * above ~9 start merging genuinely distinct peaks.
 *
 * Kernel from the same `smoothKernel` the 2D blur uses, and for the same reason
 * it has been kept in step twice now: the first version of this line was
 * `Math.floor(window / 2)`, which gave 2 and 3 an identical kernel; the second
 * was a radius of `(w−1)/2`, which made every step distinct but not evenly sized.
 * Both bugs were reported against the density map and both were in this function
 * too. A smoothing control that behaves differently on a histogram panel than on
 * a density panel is a worse bug than either.
 */
export function smooth(values: Float64Array, window: number): Float64Array {
  const { half, tap: frac } = smoothKernel(window);
  if (half === 0 && frac <= 0) return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      sum += values[j]!;
      weight++;
    }
    if (frac > 0) {
      for (const j of [i - half - 1, i + half + 1]) {
        if (j < 0 || j >= values.length) continue;
        sum += frac * values[j]!;
        weight += frac;
      }
    }
    out[i] = weight > 0 ? sum / weight : 0;
  }
  return out;
}
