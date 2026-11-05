import { describe, expect, it } from 'vitest';
import { headersMatch, parseCsvTable, splitCsvLine } from './csv';
import {
  allocatePoints, columnsForPreset, defaultSelection, isComputedColumn, isDetectorChannel,
  isInstrumentChannel, parameterPresetsFor, presetById, strideIndices, UMAP_PRESETS,
} from './presets';
import {
  buildMatrix, embeddingExtent, valueMapFor, UMAP_COFACTOR, type MatrixOptions,
} from './matrix';
import { LEGEND_DOT, layoutLegend, type LegendItem } from './legend';
import { DEFAULT_UMAP_SEED, randomSeed, seededRandom } from './random';

describe('splitCsvLine', () => {
  it('splits a plain row', () => {
    expect(splitCsvLine('1,2,3')).toEqual(['1', '2', '3']);
  });

  it('honours quotes around an embedded comma — which is what csvField writes', () => {
    expect(splitCsvLine('"B2-A, area",5')).toEqual(['B2-A, area', '5']);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(splitCsvLine('"say ""hi""",2')).toEqual(['say "hi"', '2']);
  });

  it('keeps empty fields rather than collapsing them', () => {
    expect(splitCsvLine('1,,3')).toEqual(['1', '', '3']);
  });
});

describe('parseCsvTable', () => {
  const csv = 'FSC-A,SSC-A,B2-A\n1,2,3\n4,5,6\n';

  it('reads headers and column-major values', () => {
    const t = parseCsvTable(csv);
    expect(t.headers).toEqual(['FSC-A', 'SSC-A', 'B2-A']);
    expect(t.count).toBe(2);
    expect(Array.from(t.columns[0]!)).toEqual([1, 4]);
    expect(Array.from(t.columns[2]!)).toEqual([3, 6]);
  });

  it('survives CRLF and a byte-order mark', () => {
    const t = parseCsvTable(`﻿A,B\r\n1,2\r\n`);
    expect(t.headers).toEqual(['A', 'B']);
    expect(Array.from(t.columns[1]!)).toEqual([2]);
  });

  /*
     A half-parsed event is worse than a missing one. Reading a text cell as
     zero would put a stripe through the middle of the projection and nothing
     on screen would say why.
  */
  it('drops a row holding something that is not a number, and counts it', () => {
    const t = parseCsvTable('A,B\n1,2\n3,not-a-number\n5,6\n');
    expect(t.count).toBe(2);
    expect(t.dropped).toBe(1);
    expect(Array.from(t.columns[0]!)).toEqual([1, 5]);
  });

  it('drops a row of the wrong width rather than guessing at it', () => {
    const t = parseCsvTable('A,B\n1,2\n3\n');
    expect(t.count).toBe(1);
    expect(t.dropped).toBe(1);
  });

  it('reads an empty file as an empty table', () => {
    expect(parseCsvTable('').count).toBe(0);
    expect(parseCsvTable('\n\n').headers).toEqual([]);
  });
});

describe('headersMatch', () => {
  it('is by name and order, never by count', () => {
    expect(headersMatch(['A', 'B'], ['A', 'B'])).toBe(true);
    expect(headersMatch(['A', 'B'], ['B', 'A'])).toBe(false);
    expect(headersMatch(['A', 'B'], ['A', 'B', 'C'])).toBe(false);
  });
});

describe('parameter presets', () => {
  const headers = ['Time', 'FSC-A', 'SSC-H', 'B2-A', 'CD4', 'R1-A'];

  it('knows an instrument channel from a measurement', () => {
    expect(isInstrumentChannel('Time')).toBe(true);
    expect(isInstrumentChannel('Time (s)')).toBe(true);
    expect(isInstrumentChannel('FSC-A')).toBe(true);
    expect(isInstrumentChannel('SSC-B-H')).toBe(true);
    expect(isInstrumentChannel('B2-A')).toBe(false);
    expect(isInstrumentChannel('CD4')).toBe(false);
  });

  it('knows a detector from a column this application computed', () => {
    // Shape, never marker knowledge: laser prefix, detector number, statistic.
    expect(isDetectorChannel('B2-A')).toBe(true);
    expect(isDetectorChannel('UV16-A')).toBe(true);
    expect(isDetectorChannel('YG10-H')).toBe(true);
    expect(isDetectorChannel('R1-W')).toBe(true);
    // Scatter and Time are instrument channels, and belong to neither set.
    expect(isDetectorChannel('FSC-A')).toBe(false);
    expect(isDetectorChannel('Time')).toBe(false);
    // An unmixed abundance and a derived parameter.
    expect(isDetectorChannel('CD4')).toBe(false);
    expect(isDetectorChannel('Membrane order')).toBe(false);
    expect(isComputedColumn('Membrane order')).toBe(true);
    expect(isComputedColumn('B2-A')).toBe(false);
    expect(isComputedColumn('Time')).toBe(false);
  });

  it('selects everything, nothing, the detectors, or the computed columns', () => {
    expect(columnsForPreset('all', headers)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(columnsForPreset('none', headers)).toEqual([]);
    expect(columnsForPreset('channels', headers)).toEqual([3, 5]);
    // This is the split. Under the old "everything but scatter and Time" rule
    // CD4 came along with the detectors, so a derived parameter entered the
    // projection beside the channels its own equation is computed from.
    expect(columnsForPreset('parameters', headers)).toEqual([4]);
  });

  it('offers Parameters only when the file has some', () => {
    expect(parameterPresetsFor(headers).map((p) => p.id))
      .toEqual(['channels', 'all', 'none', 'parameters']);
    expect(parameterPresetsFor(['Time', 'FSC-A', 'B2-A']).map((p) => p.id))
      .toEqual(['channels', 'all', 'none']);
  });

  it('opens on the detectors, and on the computed columns when there are none', () => {
    expect(defaultSelection(headers)).toEqual([3, 5]);
    expect(defaultSelection(['Time', 'CD4', 'CD8'])).toEqual([1, 2]);
    // Nothing but scatter and Time: neither rule matches, so select all rather
    // than open on an empty list with a warning under it.
    expect(defaultSelection(['Time', 'FSC-A'])).toEqual([0, 1]);
  });
});

describe('UMAP presets', () => {
  it('offers three, ordered by how long they take', () => {
    expect(UMAP_PRESETS.map((p) => p.id)).toEqual(['quick', 'balanced', 'detailed']);
    const points = UMAP_PRESETS.map((p) => p.maxPoints);
    expect(points).toEqual([...points].sort((a, b) => a - b));
    const epochs = UMAP_PRESETS.map((p) => p.nEpochs);
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b));
  });

  it('falls back to the middle one for an id it does not know', () => {
    expect(presetById('nonsense' as never).id).toBe('balanced');
  });
});

describe('allocatePoints', () => {
  it('spends the budget', () => {
    const out = allocatePoints([100000, 100000, 100000], 6000);
    expect(out.reduce((a, b) => a + b, 0)).toBe(6000);
  });

  it('never takes more from a file than it has', () => {
    const out = allocatePoints([50, 100000], 6000);
    expect(out[0]).toBe(50);
    expect(out[0]! + out[1]!).toBeLessThanOrEqual(6000);
  });

  /*
     The property the floor exists for. A strict proportion would reduce the
     small file to a handful of points and lose the group entirely.
  */
  it('keeps a small file visible beside a large one', () => {
    const out = allocatePoints([200000, 3000], 20000);
    expect(out[1]).toBeGreaterThanOrEqual(500);
  });

  it('hands unused budget back to the files that can use it', () => {
    const out = allocatePoints([10, 10, 100000], 6000);
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(10);
    expect(out[0]! + out[1]! + out[2]!).toBe(6000);
  });

  it('is empty for an empty set or no budget', () => {
    expect(allocatePoints([], 100)).toEqual([]);
    expect(allocatePoints([10], 0)).toEqual([0]);
  });
});

describe('strideIndices', () => {
  /*
     An FCS export is in acquisition order, so the first N rows are the first
     N seconds of the run. A stride samples the whole acquisition.
  */
  it('spreads across the file rather than taking the head', () => {
    const idx = strideIndices(1000, 4);
    expect(Array.from(idx)).toEqual([0, 250, 500, 750]);
  });

  it('takes everything when asked for everything or more', () => {
    expect(Array.from(strideIndices(3, 3))).toEqual([0, 1, 2]);
    expect(Array.from(strideIndices(3, 99))).toEqual([0, 1, 2]);
  });

  it('never indexes past the end', () => {
    const idx = strideIndices(7, 5);
    expect(Math.max(...Array.from(idx))).toBeLessThan(7);
  });

  it('is deterministic', () => {
    expect(Array.from(strideIndices(500, 33))).toEqual(Array.from(strideIndices(500, 33)));
  });
});

describe('buildMatrix', () => {
  const cols = (...arrays: number[][]) => arrays.map((a) => Float32Array.from(a));
  const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);
  /*
     The standardisation tests below are about centring and scaling, so they ask
     for that and nothing else. The default is `asinh` — see the scaling suite
     underneath — and a mean of a compressed column is not the mean of the
     column, which is exactly the point of it.
  */
  const NONE: MatrixOptions = { scaling: 'none', cofactor: UMAP_COFACTOR };

  it('centres and scales each column to unit deviation', () => {
    const m = buildMatrix([{ columns: cols([1, 2, 3], [10, 20, 30]), indices: all(3) }], [0, 1], NONE);
    expect(m.means).toEqual([2, 20]);
    // Both columns are the same shape at different scales, so both standardise
    // to the same numbers — which is the entire point.
    expect(m.rows[0]![0]).toBeCloseTo(m.rows[0]![1]!, 10);
    expect(m.rows[2]![0]).toBeCloseTo(m.rows[2]![1]!, 10);
  });

  /*
     A column that never varies says nothing about which cells are alike, so it
     contributes nothing — rather than dividing by zero.
  */
  it('leaves a constant column at zero instead of dividing by zero', () => {
    const m = buildMatrix([{ columns: cols([5, 5, 5]), indices: all(3) }], [0], NONE);
    expect(m.deviations[0]).toBe(0);
    expect(m.rows.map((r) => r[0])).toEqual([0, 0, 0]);
  });

  /*
     Standardising each file against its own mean would centre every group on
     the origin and delete the between-group difference being asked about.
  */
  it('pools its statistics across files rather than per file', () => {
    const m = buildMatrix([
      { columns: cols([0, 0]), indices: all(2) },
      { columns: cols([10, 10]), indices: all(2) },
    ], [0], NONE);
    expect(m.means[0]).toBe(5);
    expect(m.rows[0]![0]).toBeLessThan(0);
    expect(m.rows[3]![0]).toBeGreaterThan(0);
  });

  it('honours the subsample rather than reading every row', () => {
    const m = buildMatrix(
      [{ columns: cols([1, 99, 3]), indices: Uint32Array.from([0, 2]) }],
      [0],
      NONE,
    );
    expect(m.rows).toHaveLength(2);
    expect(m.means[0]).toBe(2);
  });

  it('is empty when nothing is selected', () => {
    expect(buildMatrix([{ columns: cols([1, 2]), indices: all(2) }], []).rows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   Value scaling

   The bug these are about: a Gate Export holds raw channel values, and this
   panel centred and scaled them and nothing else. Centring does not compress —
   a log-normal column with a four-decade tail is still a log-normal column with
   a four-decade tail after it, and UMAP measures straight-line distance — so
   the graph was built out of the brightest few events and the map carried no
   structure. `separationRatio` below is that failure written as a number.
   ------------------------------------------------------------------------- */

describe('value scaling', () => {
  const cols = (...arrays: number[][]) => arrays.map((a) => Float32Array.from(a));
  const all = (n: number) => Uint32Array.from({ length: n }, (_, i) => i);

  it('is arcsinh at the application-wide cofactor unless told otherwise', () => {
    const f = valueMapFor({ scaling: 'asinh', cofactor: UMAP_COFACTOR });
    expect(f(UMAP_COFACTOR)).toBeCloseTo(Math.asinh(1), 12);
    expect(f(0)).toBe(0);
    // Signed, not clipped: an unmixed abundance reads below zero and a scaling
    // that folded it onto the floor would merge every negative event.
    expect(f(-UMAP_COFACTOR)).toBeCloseTo(-Math.asinh(1), 12);
  });

  it('leaves values alone under none and under unit', () => {
    expect(valueMapFor({ scaling: 'none', cofactor: 1000 })(1234)).toBe(1234);
    expect(valueMapFor({ scaling: 'unit', cofactor: 1000 })(1234)).toBe(1234);
  });

  /*
     Two dim populations 900 channels apart, and one bright event four decades
     above both. Standardising alone spends the whole spread on the outlier and
     leaves the two populations on top of one another; compressing first keeps
     them apart. The ratio is what the projection sees.
  */
  it('stops one bright event owning the distance', () => {
    const source = [{ columns: cols([100, 110, 1000, 1100, 10_000_000]), indices: all(5) }];
    const separationRatio = (opts: MatrixOptions) => {
      const m = buildMatrix(source, [0], opts);
      const span = Math.max(...m.rows.map((r) => r[0]!)) - Math.min(...m.rows.map((r) => r[0]!));
      return Math.abs(m.rows[2]![0]! - m.rows[0]![0]!) / span;
    };
    const flat = separationRatio({ scaling: 'none', cofactor: UMAP_COFACTOR });
    const compressed = separationRatio({ scaling: 'asinh', cofactor: UMAP_COFACTOR });
    expect(flat).toBeLessThan(0.001);
    expect(compressed).toBeGreaterThan(100 * flat);
  });

  /*
     Per-event shape is the default: on a ratiometric-probe panel it separates
     two conditions better than arcsinh, and this application is named for that
     kind of measurement. See `UMAP_SCALINGS` for the table and the marker panel where
     the answer is the other way round.
  */
  it('is per-event shape by default', () => {
    const source = [{ columns: cols([100, 110], [1000, 1100], [50, 10_000_000]), indices: all(2) }];
    expect(buildMatrix(source, [0, 1, 2])).toEqual(
      buildMatrix(source, [0, 1, 2], { scaling: 'unit', cofactor: UMAP_COFACTOR }),
    );
  });

  /*
     Per-event: each row over its own largest magnitude, and nothing after it.
     Centring the columns afterwards would put back the intensity information
     the scaling exists to remove.
  */
  it('divides each event by its own brightest channel and does not centre', () => {
    const m = buildMatrix(
      [{ columns: cols([1, 40], [2, 10], [4, 20]), indices: all(2) }],
      [0, 1, 2],
      { scaling: 'unit', cofactor: UMAP_COFACTOR },
    );
    expect(m.rows[0]).toEqual([0.25, 0.5, 1]);
    expect(m.rows[1]).toEqual([1, 0.25, 0.5]);
    expect(m.means).toEqual([0, 0, 0]);
  });

  it('keeps the sign of a negative column and survives an all-zero event', () => {
    const m = buildMatrix(
      [{ columns: cols([-10, 0], [5, 0]), indices: all(2) }],
      [0, 1],
      { scaling: 'unit', cofactor: UMAP_COFACTOR },
    );
    expect(m.rows[0]).toEqual([-1, 0.5]);
    expect(m.rows[1]).toEqual([0, 0]);
  });
});

describe('embeddingExtent', () => {
  it('brackets the points with a margin', () => {
    const e = embeddingExtent([[0, 0], [10, 20]]);
    expect(e.xMin).toBeLessThan(0);
    expect(e.xMax).toBeGreaterThan(10);
    expect(e.yMax).toBeGreaterThan(20);
  });

  it('gives a degenerate run a span rather than a division by zero', () => {
    const e = embeddingExtent([[3, 3], [3, 3]]);
    expect(e.xMax).toBeGreaterThan(e.xMin);
    expect(e.yMax).toBeGreaterThan(e.yMin);
  });

  it('has a range for no points at all', () => {
    const e = embeddingExtent([]);
    expect(e.xMax).toBeGreaterThan(e.xMin);
  });
});

/* -------------------------------------------------------------------------
   The random state (2026-08-21)

   UMAP was the one stochastic thing in this application, and the report was
   the consequence: the same file, the same columns and the same preset gave a
   different map every press. `seededRandom` is what fixes it; these pin the two
   properties the fix depends on.
   ------------------------------------------------------------------------- */

describe('seededRandom', () => {
  const take = (rng: () => number, n: number) => Array.from({ length: n }, () => rng());

  it('gives the same stream twice from one seed', () => {
    expect(take(seededRandom(42), 8)).toEqual(take(seededRandom(42), 8));
  });

  it('gives a different stream from a different seed', () => {
    expect(take(seededRandom(42), 8)).not.toEqual(take(seededRandom(43), 8));
  });

  it('stays inside [0, 1)', () => {
    for (const seed of [0, 1, 42, 999999]) {
      for (const v of take(seededRandom(seed), 200)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('does not degenerate on a seed of zero', () => {
    // Folded to 1: mulberry32 with all-zero state has visibly poor first draws,
    // and 0 is the first thing anybody types into a seed field.
    const zero = take(seededRandom(0), 8);
    expect(new Set(zero).size).toBe(8);
    expect(zero).toEqual(take(seededRandom(1), 8));
  });

  it('spreads over the unit interval well enough to sample with', () => {
    const buckets = new Array(10).fill(0);
    const rng = seededRandom(DEFAULT_UMAP_SEED);
    for (let i = 0; i < 10000; i++) buckets[Math.floor(rng() * 10)]! += 1;
    for (const b of buckets) expect(b).toBeGreaterThan(800);
  });
});

describe('randomSeed', () => {
  it('stays inside the range the field accepts', () => {
    for (let i = 0; i < 200; i++) {
      const s = randomSeed();
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(999999);
      expect(Number.isInteger(s)).toBe(true);
    }
  });
});

describe('the colour key', () => {
  const items = (...labels: string[]): LegendItem[] =>
    labels.map((label, i) => ({ label, color: `#00000${i}` }));

  it('takes no height when there is nothing to explain', () => {
    expect(layoutLegend([], 460)).toEqual({ items: [], height: 0 });
  });

  it('places two labels on one row, centred on the figure', () => {
    const out = layoutLegend(items('Control', 'Treated'), 460);
    expect(out.items).toHaveLength(2);
    expect(out.height).toBe(23);
    // Symmetric about the middle: the gap to the left of the first swatch is
    // the gap to the right of the last label.
    const left = out.items[0]!.dotX - LEGEND_DOT;
    const right = 460 - (out.items[1]!.textX + 'Treated'.length * 11 * 0.52);
    expect(Math.abs(left - right)).toBeLessThan(1);
    expect(out.items[0]!.y).toBe(out.items[1]!.y);
  });

  it('keeps the entries in the order they were given', () => {
    const out = layoutLegend(items('Control', 'Treated'), 460);
    expect(out.items.map((i) => i.label)).toEqual(['Control', 'Treated']);
    expect(out.items[0]!.dotX).toBeLessThan(out.items[1]!.dotX);
  });

  it('wraps when the row will not fit, and grows the figure by a line each time', () => {
    const one = layoutLegend(items('A'), 460).height;
    const many = layoutLegend(items(...Array.from({ length: 12 }, (_, i) => `condition ${i}`)), 460);
    expect(many.items).toHaveLength(12);
    const rows = new Set(many.items.map((i) => i.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(many.height).toBe(one + (rows.size - 1) * 15);
  });

  it('gives an entry too wide for the figure its own row rather than dropping it', () => {
    const out = layoutLegend(items('short', 'a name far wider than the figure it belongs to'), 120);
    expect(out.items).toHaveLength(2);
    expect(out.items[0]!.y).not.toBe(out.items[1]!.y);
  });

  it('leaves room for the swatch before the label', () => {
    const out = layoutLegend(items('Control'), 460);
    expect(out.items[0]!.textX - out.items[0]!.dotX).toBeGreaterThanOrEqual(LEGEND_DOT);
  });
});
