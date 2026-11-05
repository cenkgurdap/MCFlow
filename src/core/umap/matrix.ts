/**
 * Turning loaded CSV columns into the matrix UMAP consumes.
 *
 * Three jobs, and the middle one decides whether the picture means anything.
 *
 * **Gathering.** `umap-js` wants `number[][]` — one array per point. That is the
 * one place in this panel where the column-major layout has to be given up, and
 * it is done once, at the last moment, over the subsampled indices only.
 *
 * **Scaling.** A Gate Export holds **raw channel values**, deliberately —
 * `ExportView` pins `valueMode` to `'raw'` because a transformed number is
 * actively wrong to anything downstream that does arithmetic on it. Raw
 * fluorescence is log-normal over four or five decades with a long upper tail,
 * and UMAP measures Euclidean distance. Handed those, the distance between two
 * cells is very nearly the distance between their two brightest events, the
 * k-nearest-neighbour graph is built out of that, and the map that comes back
 * looks like noise however long it is optimised for. `UMAP_SCALINGS` carries
 * the three answers, which of them is the default and the measurement that
 * decided it.
 *
 * **Standardising.** Even after compression the columns do not share a spread:
 * a scatter channel, a detector and an unmixed abundance are three different
 * sizes of number. Every column is centred and scaled to unit standard
 * deviation so each contributes on equal terms.
 *
 * A constant column has zero standard deviation. It is left at zero rather than
 * divided by zero — a column that never varies carries no information about
 * which cells are alike, so contributing nothing is the correct contribution.
 */

import { createTransform, DEFAULT_COFACTOR } from '../transform';

/**
 * What is done to a value before the distance between two events is measured.
 *
 * - `unit` — divide each event by its own largest selected value, and do **not**
 *   standardise the columns afterwards. That turns an event into the *shape* of
 *   its spectrum and throws away how bright it was. The default; see the
 *   measurement below.
 * - `asinh` — `asinh(v / cofactor)`, then centre and scale each column. The
 *   app's own arcsinh transform, so the projection is computed on the same
 *   scale the plots draw it on.
 * - `none` — centre and scale only. Correct for a table whose columns are
 *   already on a comparable scale, and wrong for a raw export; it is what this
 *   panel did before 2026-08-19 and is kept so an old projection can be
 *   reproduced.
 *
 * ## Which scaling suits which panel
 *
 * Compared with everything but the scaling held fixed, by the distance between
 * two conditions' centroids over a condition's own mean radius — scale-free,
 * because a UMAP's output has no units — a ratiometric-probe panel separates
 * best under `unit` and an immunophenotyping panel under `asinh`. The two
 * disagree, and they disagree in the direction the physics says they should. A solvatochromic probe *is* a ratio between bands — how bright the
 * cell is says how much dye it took up, not what its membrane is doing — so
 * dividing the brightness out is the measurement. An
 * immunophenotyping panel is the opposite: which markers a cell carries and how
 * brightly is the whole of what separates one cell from another, and
 * normalising that away is the worst of the three.
 *
 * So there is no single right answer and this is a control rather than a
 * constant. It opens on `unit` because that is the case this application is
 * named for; anyone projecting a marker panel should move it to `asinh`, which
 * the panel's own hint says.
 */
export type UmapScaling = 'asinh' | 'unit' | 'none';

export const UMAP_SCALINGS: Array<{ id: UmapScaling; label: string; hint: string }> = [
  {
    id: 'unit',
    label: 'Per-event shape',
    hint: 'Each event over its own brightest selected channel. Compares emission profiles and discards how bright a cell was — what a ratiometric probe measures.',
  },
  {
    id: 'asinh',
    label: 'Arcsinh',
    hint: 'Compress the decades, then give every column equal weight. The one for a marker panel, where how bright a cell is *is* the signal.',
  },
  {
    id: 'none',
    label: 'None',
    hint: 'Equal weight per column and nothing else. For a table that is already on a sensible scale.',
  },
];

/** The arcsinh cofactor a projection uses unless one is typed. The app's own. */
export const UMAP_COFACTOR = DEFAULT_COFACTOR;

export interface MatrixOptions {
  scaling: UmapScaling;
  /** Arcsinh cofactor. Read by `asinh` and ignored by the other two. */
  cofactor: number;
}

export interface StandardisedMatrix {
  /** One row per point, one entry per selected column. */
  rows: number[][];
  /** Per selected column, the mean that was subtracted. Zero when none was. */
  means: number[];
  /** Per selected column, the deviation that was divided out. Zero if constant. */
  deviations: number[];
}

/**
 * The per-value part of a scaling, as a plain function.
 *
 * `asinh` goes through `createTransform` rather than calling `Math.asinh` here,
 * because the application already owns exactly one definition of that curve and
 * a second one is how a projection and the axis it is read against come to
 * disagree about what a value is. `range` only sets the transform's display
 * domain, which nothing here reads.
 */
export function valueMapFor(opts: MatrixOptions): (v: number) => number {
  if (opts.scaling !== 'asinh') return (v) => v;
  const cofactor = opts.cofactor > 0 ? opts.cofactor : UMAP_COFACTOR;
  const t = createTransform({ kind: 'asinh', range: 262144, cofactor });
  return (v) => t.forward(v);
}

/**
 * Build the matrix from several files at once.
 *
 * The statistics are pooled across every file, deliberately. Standardising each
 * file against its own mean would centre every group on the origin and remove
 * exactly the between-group difference the projection is being asked about —
 * the groups would separate by shape alone and a real shift in a marker would
 * vanish. One set of statistics over everything keeps the comparison honest.
 *
 * `sources` is one entry per file: its columns and the row indices to take.
 */
export function buildMatrix(
  sources: ReadonlyArray<{ columns: readonly Float32Array[]; indices: Uint32Array }>,
  selected: readonly number[],
  opts: MatrixOptions = { scaling: 'unit', cofactor: UMAP_COFACTOR },
): StandardisedMatrix {
  const width = selected.length;
  const total = sources.reduce((a, s) => a + s.indices.length, 0);

  const means = new Array<number>(width).fill(0);
  const deviations = new Array<number>(width).fill(0);
  if (width === 0 || total === 0) return { rows: [], means, deviations };

  /*
     Gather first, scaled per value.

     The column statistics used to be computed by streaming `sources` twice and
     the rows built afterwards. They are computed over `rows` now because the
     scaling has to happen before them — a mean and a deviation of raw values
     describe a distribution the projection never sees — and the row array is
     allocated either way, so nothing is spent on holding it.
  */
  const value = valueMapFor(opts);
  const rows: number[][] = new Array(total);
  let at = 0;
  for (const s of sources) {
    for (let i = 0; i < s.indices.length; i++) {
      const r = s.indices[i]!;
      const row = new Array<number>(width);
      for (let c = 0; c < width; c++) {
        const col = s.columns[selected[c]!];
        row[c] = col ? value(col[r]!) : 0;
      }
      rows[at++] = row;
    }
  }

  /*
     Per-event normalisation ends the pipeline, and that is the point of it.

     Dividing a row by its own maximum has already put every column on one
     scale — they are all fractions of the same event's brightest channel — and
     centring them afterwards would re-weight the dim channels back up to the
     bright ones, which is the intensity information this scaling exists to
     discard. The magnitude is the absolute value, so a column that reads
     negative keeps its sign.
  */
  if (opts.scaling === 'unit') {
    for (const row of rows) {
      let max = 0;
      for (let c = 0; c < width; c++) {
        const a = Math.abs(row[c]!);
        if (a > max) max = a;
      }
      if (max > 0) for (let c = 0; c < width; c++) row[c] = row[c]! / max;
    }
    // Nothing was subtracted and nothing column-wide was divided out, which is
    // what the two report — a one, not a zero, because zero means "constant".
    deviations.fill(1);
    return { rows, means, deviations };
  }

  for (let c = 0; c < width; c++) {
    let sum = 0;
    for (const row of rows) sum += row[c]!;
    const mean = sum / total;

    let sq = 0;
    for (const row of rows) { const d = row[c]! - mean; sq += d * d; }
    means[c] = mean;
    deviations[c] = Math.sqrt(sq / total);
  }

  for (const row of rows) {
    for (let c = 0; c < width; c++) {
      const sd = deviations[c]!;
      row[c] = sd > 0 ? (row[c]! - means[c]!) / sd : 0;
    }
  }

  return { rows, means, deviations };
}

/**
 * The extent of a projection, with a margin.
 *
 * The plot is drawn to whatever the embedding turned out to be — UMAP's output
 * has no natural units and no fixed range, so there is nothing to pin it to the
 * way the biophysics axis is pinned. A degenerate run (every point identical)
 * would give a zero-width extent and divide by zero downstream, so a minimum
 * span is enforced.
 */
export function embeddingExtent(points: ReadonlyArray<readonly number[]>): {
  xMin: number; xMax: number; yMin: number; yMax: number;
} {
  if (points.length === 0) return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };

  let xMin = Infinity; let xMax = -Infinity;
  let yMin = Infinity; let yMax = -Infinity;
  for (const p of points) {
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }

  const padX = Math.max((xMax - xMin) * 0.04, 1e-3);
  const padY = Math.max((yMax - yMin) * 0.04, 1e-3);
  return { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY };
}
