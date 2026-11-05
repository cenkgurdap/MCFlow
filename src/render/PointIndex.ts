/**
 * Uniform-grid spatial index over display-space coordinates.
 *
 * Hover inspection needs the nearest event to the cursor. Scanning 170 000
 * points on every pointermove is wasteful at 60 Hz, so points are bucketed once
 * per (x, y, transform) combination and the query walks outward from the
 * cursor's cell.
 *
 * Storage is CSR-style — one prefix-sum offset array plus one index array —
 * rather than an array of arrays, which would allocate ~65 000 small arrays.
 */
export class PointIndex {
  private readonly cellStart: Uint32Array;
  private readonly cellItems: Uint32Array;
  private readonly invCellW: number;
  private readonly invCellH: number;

  constructor(
    private readonly x: Float32Array,
    private readonly y: Float32Array,
    private readonly xMin: number,
    xMax: number,
    private readonly yMin: number,
    yMax: number,
    private readonly grid = 192,
  ) {
    const n = x.length;
    const cells = grid * grid;
    const spanX = xMax - xMin || 1;
    const spanY = yMax - yMin || 1;
    this.invCellW = grid / spanX;
    this.invCellH = grid / spanY;

    // Pass 1: count per cell.
    const counts = new Uint32Array(cells + 1);
    const cellOf = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(x[i]!, y[i]!);
      cellOf[i] = c;
      counts[c + 1]!++;
    }
    // Pass 2: prefix sum.
    for (let c = 0; c < cells; c++) counts[c + 1]! += counts[c]!;
    this.cellStart = counts;

    // Pass 3: scatter indices into their buckets.
    const cursor = counts.slice(0, cells);
    const items = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      items[cursor[cellOf[i]!]!++] = i;
    }
    this.cellItems = items;
  }

  private cellIndex(px: number, py: number): number {
    const g = this.grid;
    let cx = Math.floor((px - this.xMin) * this.invCellW);
    let cy = Math.floor((py - this.yMin) * this.invCellH);
    // Out-of-range values (and NaN, which fails both comparisons) clamp into the
    // border cells so every point is indexed exactly once.
    cx = cx < 0 || !Number.isFinite(cx) ? 0 : cx >= g ? g - 1 : cx;
    cy = cy < 0 || !Number.isFinite(cy) ? 0 : cy >= g ? g - 1 : cy;
    return cy * g + cx;
  }

  /**
   * Nearest point to (px, py) within `radius`, in display units.
   * Returns the event index, or -1 when nothing is close enough.
   */
  nearest(px: number, py: number, radiusX: number, radiusY: number): number {
    const g = this.grid;
    const cx = Math.min(g - 1, Math.max(0, Math.floor((px - this.xMin) * this.invCellW)));
    const cy = Math.min(g - 1, Math.max(0, Math.floor((py - this.yMin) * this.invCellH)));

    let best = -1;
    let bestD2 = Infinity;
    // Normalise distances by the radii so an elliptical (pixel-square) region in
    // display space is treated as circular.
    const nx = 1 / (radiusX || 1);
    const ny = 1 / (radiusY || 1);

    // Smallest normalised distance a cell one ring further out can possibly
    // hold. Used as the termination bound: stopping after a fixed number of
    // rings is unsound, because a point in the query's own cell can sit further
    // away than one in a cell two rings out.
    const minCellNorm = Math.min((1 / this.invCellW) * nx, (1 / this.invCellH) * ny);

    for (let ring = 0; ring <= g; ring++) {
      const ringMin = (ring - 1) * minCellNorm;
      if (ring > 0) {
        // Nothing beyond the search radius can qualify.
        if (ringMin > 1) break;
        // Nothing further out can beat what we already have.
        if (best >= 0 && ringMin * ringMin > bestD2) break;
      }
      const x0 = cx - ring, x1 = cx + ring;
      const y0 = cy - ring, y1 = cy + ring;
      // The whole ring has walked off the grid.
      if (x1 < 0 && y1 < 0) break;
      if (x0 >= g && y0 >= g) break;
      for (let gy = y0; gy <= y1; gy++) {
        if (gy < 0 || gy >= g) continue;
        for (let gx = x0; gx <= x1; gx++) {
          if (gx < 0 || gx >= g) continue;
          // Only the perimeter is new on rings after the first.
          if (ring > 0 && gx !== x0 && gx !== x1 && gy !== y0 && gy !== y1) continue;
          const c = gy * g + gx;
          const start = this.cellStart[c]!;
          const end = this.cellStart[c + 1]!;
          for (let k = start; k < end; k++) {
            const i = this.cellItems[k]!;
            const dx = (this.x[i]! - px) * nx;
            const dy = (this.y[i]! - py) * ny;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = i;
            }
          }
        }
      }
    }
    return bestD2 <= 1 ? best : -1;
  }

  /** Number of indexed points. */
  get size(): number {
    return this.x.length;
  }
}
