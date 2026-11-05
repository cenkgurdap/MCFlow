/**
 * A polygon traced around the dense part of a 2D distribution.
 *
 * What seeds the coarse scatter gate at the top of every reference control's
 * worksheet. It replaces a percentile **box**, and the difference is not
 * cosmetic: a box around the 2nd-to-92nd percentile of each axis independently
 * is a rectangle around the *bounding* extent of the population, so on real
 * scatter data it takes in the debris below the lymphocyte cloud and the
 * saturated rim above it — everything the general gate exists to exclude. Every
 * cytometry package draws this gate as an irregular polygon following the
 * cloud's own outline, and so does this.
 *
 * ## Why radial rather than marching squares
 *
 * A contour follower on a binary mask has to answer questions this problem does
 * not have: holes, saddle cells, disconnected islands, and whether the result is
 * a simple polygon at all. A **star-shaped trace about the centroid** has none
 * of them — N rays, one vertex each, in angle order, so the result is a simple
 * closed polygon by construction and can never self-intersect, which matters
 * because what comes out is handed straight to the ordinary polygon gate and
 * dragged by its vertices.
 *
 * The cost is that a population which is not star-shaped about its own centroid
 * — a crescent, a doughnut — is approximated rather than traced. Scatter
 * populations are blobs; the reference software's own gate is a concave but
 * star-shaped outline. When the shape is genuinely wrong, the answer is that the
 * user drags it, which is why this is a *seed* and why the result is a plain
 * editable gate rather than anything special.
 *
 * Everything here is pure and works in grid coordinates. Converting to a
 * parameter's display space is the caller's business.
 */

export interface Point {
  x: number;
  y: number;
}

/** The shape `bin2d` returns, structurally — no dependency on the render layer. */
export interface DensityGrid {
  bins: Uint32Array | Float32Array | number[];
  width: number;
  height: number;
}

export interface ContourOptions {
  /**
   * Fraction of binned events the polygon should enclose.
   *
   * 0.80 by default: enough to take in the whole visible cloud including its
   * shoulders, and tight enough to leave the debris corner and the scattered
   * periphery outside. A coarse gate that looks finished is worse than one that
   * obviously is not, so this errs generous.
   */
  coverage?: number;
  /** How many rays, and therefore how many vertices. */
  rays?: number;
  /**
   * Cells of blur applied before thresholding.
   *
   * A binned scatter plot at this resolution is noisy at the population's edge,
   * and an unsmoothed threshold produces a ragged outline with single-cell
   * spikes. Applied to a copy; the caller's grid is not touched.
   */
  smooth?: number;
}

const DEFAULTS = { coverage: 0.8, rays: 28, smooth: 1.5 } as const;

/**
 * The density at which the cells at or above it hold `coverage` of the events.
 *
 * Ranked rather than absolute, so it means the same thing on a 15 000-event file
 * and a 170 000-event one, and under any monotonic rescaling of the counts.
 */
export function densityThreshold(grid: DensityGrid, coverage: number): number {
  const values: number[] = [];
  let total = 0;
  for (let i = 0; i < grid.width * grid.height; i++) {
    const v = grid.bins[i]!;
    if (v > 0) { values.push(v); total += v; }
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => b - a);
  const want = total * Math.max(0, Math.min(1, coverage));
  let acc = 0;
  for (const v of values) {
    acc += v;
    if (acc >= want) return v;
  }
  return values[values.length - 1]!;
}

/**
 * Default share of the heaviest region a component must carry to be kept.
 *
 * Not zero and not one, and both bounds are mistakes this was written against.
 *
 * **One** — keeping only the heaviest region — throws away real populations. A
 * general scatter gate on PBMCs has to hold lymphocytes, monocytes and
 * granulocytes; they are three separate clouds, none is debris, and a rule that
 * kept the biggest would gate one of the three and call it "Cells".
 *
 * **Zero** — keeping everything above the threshold — lets one dense speckle in
 * a far corner stretch the polygon across the whole plot, because the trace is
 * radial and a distant vertex takes the boundary with it.
 *
 * 0.15 sits between: a secondary population carrying a seventh of the signal of
 * the main one survives, and a fleck does not.
 */
const MIN_COMPONENT_SHARE = 0.15;

/**
 * The 4-connected regions at or above `threshold` that carry real signal.
 *
 * Weighed by summed density rather than by cell count: a broad sparse smear can
 * cover more cells than the population and would win a cell-count contest while
 * holding a fraction of the events.
 */
export function denseComponents(
  grid: DensityGrid,
  threshold: number,
  minShare: number = MIN_COMPONENT_SHARE,
): Uint8Array {
  const { width: w, height: h } = grid;
  const label = new Int32Array(w * h).fill(-1);
  const mask = new Uint8Array(w * h);
  const stack: number[] = [];
  const weights: number[] = [];
  let next = 0;

  for (let seed = 0; seed < w * h; seed++) {
    if (label[seed] !== -1 || grid.bins[seed]! < threshold || grid.bins[seed]! <= 0) continue;
    const id = next++;
    let weight = 0;
    stack.push(seed);
    label[seed] = id;
    while (stack.length) {
      const i = stack.pop()!;
      weight += grid.bins[i]!;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    weights.push(weight);

    function push(j: number) {
      if (label[j] !== -1) return;
      if (grid.bins[j]! < threshold || grid.bins[j]! <= 0) return;
      label[j] = id;
      stack.push(j);
    }
  }

  if (weights.length === 0) return mask;
  const heaviest = Math.max(...weights);
  const floor = heaviest * minShare;
  for (let i = 0; i < w * h; i++) {
    const id = label[i]!;
    if (id >= 0 && weights[id]! >= floor) mask[i] = 1;
  }
  return mask;
}

/** Density-weighted centre of the mask, in cell coordinates. */
export function maskCentroid(grid: DensityGrid, mask: Uint8Array): Point {
  const { width: w } = grid;
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const v = grid.bins[i]!;
    const x = i % w;
    sx += (x + 0.5) * v;
    sy += ((i - x) / w + 0.5) * v;
    sw += v;
  }
  if (sw === 0) return { x: w / 2, y: grid.height / 2 };
  return { x: sx / sw, y: sy / sw };
}

/**
 * A closed polygon around `mask`, in cell coordinates.
 *
 * One vertex per ray, at the furthest cell of the mask along that ray. Radii are
 * then smoothed circularly, which is what turns a stepped outline traced across
 * a lattice into something that reads as drawn — and what stops a single stray
 * cell producing a spike three times the local radius.
 */
export function radialOutline(
  grid: DensityGrid,
  mask: Uint8Array,
  centre: Point,
  rays: number,
): Point[] {
  const { width: w, height: h } = grid;
  const inside = (x: number, y: number) => {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) return false;
    return mask[cy * w + cx] === 1;
  };

  // Long enough to leave the grid from anywhere inside it, stepped at half a
  // cell so a one-cell-wide arm is never stepped over.
  const reach = Math.hypot(w, h);
  const radii: number[] = [];
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let last = 0;
    for (let r = 0; r <= reach; r += 0.5) {
      if (inside(centre.x + dx * r, centre.y + dy * r)) last = r;
    }
    radii.push(last);
  }

  // Circular 3-tap mean. Deliberately mild: the point is to take the corners off
  // the lattice, not to round the population into a circle.
  const smoothed = radii.map((_, k) => {
    const a = radii[(k - 1 + rays) % rays]!;
    const b = radii[k]!;
    const c = radii[(k + 1) % rays]!;
    return (a + 2 * b + c) / 4;
  });

  return smoothed.map((r, k) => {
    const a = (k / rays) * Math.PI * 2;
    // Half a cell of margin so the boundary sits outside the outermost occupied
    // cell rather than through its middle, where it would clip its own events.
    const rr = r + 0.5;
    return {
      x: clamp(centre.x + Math.cos(a) * rr, 0, w),
      y: clamp(centre.y + Math.sin(a) * rr, 0, h),
    };
  });
}

/**
 * Blur a grid with a separable box pass, returning a copy.
 *
 * A plain box rather than the renderer's solved-variance kernel: this feeds a
 * *threshold*, where what matters is that a single noisy cell cannot make or
 * break the boundary, and not that two smoothing settings differ by equal
 * amounts of perceived blur.
 */
export function blurGrid(grid: DensityGrid, radius: number): DensityGrid {
  const r = Math.max(0, radius);
  if (r === 0) return grid;
  const { width: w, height: h } = grid;
  const src = Float32Array.from(grid.bins as ArrayLike<number>);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const k = Math.ceil(r);
  const weight = (d: number) => (d <= r - 1 ? 1 : Math.max(0, r - d + 1));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -k; d <= k; d++) {
        const xx = x + d;
        if (xx < 0 || xx >= w) continue;
        const g = weight(Math.abs(d));
        s += src[y * w + xx]! * g;
        n += g;
      }
      tmp[y * w + x] = n > 0 ? s / n : 0;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -k; d <= k; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= h) continue;
        const g = weight(Math.abs(d));
        s += tmp[yy * w + x]! * g;
        n += g;
      }
      out[y * w + x] = n > 0 ? s / n : 0;
    }
  }
  return { bins: out, width: w, height: h };
}

/**
 * The whole pipeline: grid in, polygon out, in **cell coordinates**.
 *
 * Returns an empty array when the grid holds nothing, which the caller has to
 * handle — an empty polygon is not a gate, and falling back to a box that
 * selects everything would be worse than not seeding one.
 */
export function densityContour(grid: DensityGrid, opts: ContourOptions = {}): Point[] {
  const coverage = opts.coverage ?? DEFAULTS.coverage;
  const rays = Math.max(6, opts.rays ?? DEFAULTS.rays);
  const smooth = opts.smooth ?? DEFAULTS.smooth;

  const blurred = blurGrid(grid, smooth);
  const threshold = densityThreshold(blurred, coverage);
  if (threshold <= 0) return [];
  const mask = denseComponents(blurred, threshold);
  if (!mask.some((v) => v === 1)) return [];
  const centre = maskCentroid(blurred, mask);
  return radialOutline(blurred, mask, centre, rays);
}

/**
 * Map a polygon from cell coordinates onto the range the grid was binned over.
 *
 * Separate from `densityContour` so the geometry can be tested without any
 * reference to axes, and because the caller is the only thing that knows which
 * display space the bounds are expressed in.
 */
export function contourToData(
  polygon: readonly Point[],
  grid: { width: number; height: number },
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
): Point[] {
  const sx = (bounds.xMax - bounds.xMin) / (grid.width || 1);
  const sy = (bounds.yMax - bounds.yMin) / (grid.height || 1);
  return polygon.map((p) => ({
    x: bounds.xMin + p.x * sx,
    y: bounds.yMin + p.y * sy,
  }));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------
   One dimension
   ------------------------------------------------------------------------- */

export interface Interval {
  min: number;
  max: number;
  /** Fraction of the binned events the interval encloses. */
  coverage: number;
}

/**
 * The interval around a distribution's mode that holds `coverage` of its events.
 *
 * This is what seeds the gate on an **unstained or autofluorescence** worksheet
 * (2026-08-09), and it is deliberately a different rule from the one that seeds
 * a single stain's. A stain gets a *threshold*: `autoGateBound` finds where the
 * positive population begins, and the gate is everything above it, because a
 * stain has a positive population by definition. A baseline control does not —
 * nothing on that tube is stained — so bracketing it into positive and negative
 * would draw a boundary through one distribution and label the halves as if they
 * meant something. What somebody actually wants there is a clean population: the
 * main body of the distribution with the sparse tails and any small contaminant
 * left outside, so the autofluorescence signature is measured over cells rather
 * than over cells plus debris.
 *
 * ## Grown from the mode, by density
 *
 * Start at the modal bin and repeatedly take whichever *adjacent* bin — left or
 * right — holds more events, until the accumulated coverage is reached. Three
 * properties follow from that, and each is why the obvious alternative was not
 * used:
 *
 *   - **A plain percentile interval** (1st to 99th) cuts a fixed 1% off each
 *     end whatever is there. On a distribution whose contaminant is all on one
 *     side, that trims the good side and keeps most of the bad one.
 *   - **A fixed density floor** — keep every bin above k× the mode — stops at
 *     the first trough, so a genuinely bimodal baseline loses its second
 *     population entirely.
 *   - Growing greedily by density does neither: a real secondary mode is denser
 *     than the tails, so it is taken in *before* them, and what ends up outside
 *     is the sparsest `1 − coverage` of the distribution wherever it happens to
 *     lie.
 *
 * It is the same argument `densityContour` makes in two dimensions, which is why
 * it lives beside it. The coverage is higher here — 0.98 against 0.80 — because
 * a scatter plot's periphery really is debris to be excluded, whereas a
 * baseline's is the tail of the population being measured.
 *
 * `null` when there is nothing to bin, which is a real state: a control with no
 * finite values in the channel has no clean population and inventing an interval
 * for it would be worse than saying so.
 */
export function densityInterval(
  values: Float32Array,
  opts: { min: number; max: number; bins?: number; coverage?: number; subset?: Uint32Array | null } = {
    min: 0, max: 1,
  },
): Interval | null {
  const binCount = Math.max(8, opts.bins ?? 256);
  const coverage = Math.max(0, Math.min(1, opts.coverage ?? 0.98));
  const { min, max } = opts;
  const span = max - min;
  if (!(span > 0)) return null;

  const hist = new Float64Array(binCount);
  let total = 0;
  const scale = binCount / span;
  const add = (v: number) => {
    if (!Number.isFinite(v)) return;
    const b = Math.floor((v - min) * scale);
    if (b < 0 || b >= binCount) return;
    hist[b]!++;
    total++;
  };
  if (opts.subset) for (let i = 0; i < opts.subset.length; i++) add(values[opts.subset[i]!]!);
  else for (let i = 0; i < values.length; i++) add(values[i]!);
  if (total === 0) return null;

  // Lightly smoothed before the mode is chosen, or a single noisy spike in a
  // sparse tail can be the modal bin and the interval grows from the wrong place.
  const smoothed = new Float64Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const a = hist[Math.max(0, i - 1)]!;
    const b = hist[i]!;
    const c = hist[Math.min(binCount - 1, i + 1)]!;
    smoothed[i] = (a + 2 * b + c) / 4;
  }

  let mode = 0;
  for (let i = 1; i < binCount; i++) if (smoothed[i]! > smoothed[mode]!) mode = i;

  let lo = mode;
  let hi = mode;
  let acc = hist[mode]!;
  const want = total * coverage;
  while (acc < want && (lo > 0 || hi < binCount - 1)) {
    const left = lo > 0 ? smoothed[lo - 1]! : -1;
    const right = hi < binCount - 1 ? smoothed[hi + 1]! : -1;
    // Ties go right, arbitrarily but consistently, so the result is stable.
    if (right >= left) { hi++; acc += hist[hi]!; } else { lo--; acc += hist[lo]!; }
  }

  return {
    min: min + (lo * span) / binCount,
    max: min + ((hi + 1) * span) / binCount,
    coverage: acc / total,
  };
}
