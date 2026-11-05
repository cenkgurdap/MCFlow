import { describe, expect, it } from 'vitest';
import {
  columnHeader, csvField, csvRow, defaultColumns,
  eventHeaders, eventRows, eventsToCsv, formatBytes, indicesFor,
  allPaths, nodeState, planFullExport, populationTree, safeName, statusLabel, targetPath,
  toggleSubtree, timeParameterIndex, timePrecision, timeScaleFor, workbookPath,
  type ManifestEntry, type PlanInput,
} from './export';
import { parseFcs } from './fcs/parser';
import { column } from './fcs/types';
import { buildFcs } from './fcs/fixtures';
import { evaluateGates } from './gating/tree';
import { ROOT_ID, type Gate } from './gating/types';
import type { GateContext } from './gating/tree';

const sample = parseFcs(buildFcs({
  dataType: 'F',
  params: [
    { name: 'FSC-A', bits: 32, range: 262144, type: 'Forward_Scatter' },
    { name: 'B2-A', bits: 32, range: 262144, stain: 'CD4 FITC', type: 'Raw_Fluorescence' },
    { name: 'Time', bits: 32, range: 262144, type: 'Time' },
  ],
  events: [
    [100, 1000, 1], [200, 2000, 2], [300, 3000, 3], [400, 4000, 4], [500, 5000, 5],
  ],
}));

/** The same three parameters with the Aurora's own `$TIMESTEP`. */
const timed = parseFcs(buildFcs({
  dataType: 'F',
  params: [
    { name: 'FSC-A', bits: 32, range: 262144, type: 'Forward_Scatter' },
    { name: 'B2-A', bits: 32, range: 262144, stain: 'CD4 FITC', type: 'Raw_Fluorescence' },
    { name: 'Time', bits: 32, range: 262144, type: 'Time' },
  ],
  // The tick values from the bug report, which is what the export was writing
  // verbatim: 0, 8, 16, 22, 23, 32, 60.
  events: [[100, 1000, 0], [200, 2000, 8], [300, 3000, 16], [400, 4000, 22],
    [500, 5000, 23], [600, 6000, 32], [700, 7000, 60]],
  extraKeywords: { $TIMESTEP: '0.0001' },
}));

describe('csvField', () => {
  it('leaves plain text alone', () => {
    expect(csvField('CD4')).toBe('CD4');
  });
  it('quotes and escapes commas, quotes and newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
  it('handles a name with a comma, which real sample names have', () => {
    expect(csvRow(['Sample, B', 5])).toBe('"Sample, B",5');
  });
});

describe('columnHeader', () => {
  const md = sample.metadata;
  it('uses the detector name', () => {
    expect(columnHeader(md, 0, 'name')).toBe('FSC-A');
  });
  it('uses the stain when asked, falling back to the detector name', () => {
    expect(columnHeader(md, 1, 'stain')).toBe('CD4 FITC');
    expect(columnHeader(md, 0, 'stain')).toBe('FSC-A');
  });
  it('combines both, which is the safest for a file someone else opens', () => {
    expect(columnHeader(md, 1, 'both')).toBe('B2-A (CD4 FITC)');
    expect(columnHeader(md, 0, 'both')).toBe('FSC-A');
  });
});

describe('defaultColumns', () => {
  // Was "includes data channels and excludes Time". Reversed on 2026-08-02: an
  // export carries every parameter, Time included, and there is no longer a
  // control that could ask for anything else.
  it('includes every parameter in file order, Time included', () => {
    expect(defaultColumns(sample.metadata)).toEqual([0, 1, 2]);
    const time = sample.metadata.parameters.findIndex((p) => p.type === 'Time');
    expect(defaultColumns(sample.metadata)).toContain(time);
  });
});

describe('eventsToCsv', () => {
  const all = Uint32Array.from([0, 1, 2, 3, 4]);

  it('writes a header and one row per event', () => {
    const csv = eventsToCsv(sample, all, { columns: { indices: [0, 1], naming: 'name' }, valueMode: 'raw' });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('FSC-A,B2-A');
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe('100,1000');
    expect(lines[5]).toBe('500,5000');
  });

  it('exports only the requested events, in the given order', () => {
    const csv = eventsToCsv(sample, Uint32Array.from([4, 0]), {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw',
    });
    expect(csv.split('\r\n').slice(1)).toEqual(['500', '100']);
  });

  it('emits transformed values when asked, not raw ones', () => {
    // The choice must be explicit at export time — downstream tools expect
    // different things, and a silent default is a data-integrity problem.
    const csv = eventsToCsv(sample, all, {
      columns: { indices: [0], naming: 'name' },
      valueMode: 'transformed',
      transformed: () => Float32Array.from([1, 2, 3, 4, 5]),
    });
    expect(csv.split('\r\n').slice(1)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('prepends leading columns for the combined shape', () => {
    const csv = eventsToCsv(sample, Uint32Array.from([0]), {
      columns: { indices: [0], naming: 'name' },
      valueMode: 'raw',
      leadingColumns: { headers: ['sample', 'population'], values: ['S1', 'CD4+'] },
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('sample,population,FSC-A');
    expect(lines[1]).toBe('S1,CD4+,100');
  });

  it('supports a header-only preview', () => {
    const csv = eventsToCsv(sample, all, {
      columns: { indices: [0, 1], naming: 'name' }, valueMode: 'raw', headerOnly: true,
    });
    expect(csv).toBe('FSC-A,B2-A');
  });

  it('caps rows for the live preview', () => {
    const csv = eventsToCsv(sample, all, {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw', maxRows: 2,
    });
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('writes an empty field for a non-finite value rather than "NaN"', () => {
    const withNaN = parseFcs(buildFcs({
      dataType: 'F', params: [{ name: 'A', bits: 32, range: 1024 }], events: [[1], [2]],
    }));
    withNaN.data[1] = NaN;
    const csv = eventsToCsv(withNaN, Uint32Array.from([0, 1]), {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw',
    });
    expect(csv.split('\r\n')[2]).toBe('');
  });

  it('produces an empty body for a population with no events', () => {
    const csv = eventsToCsv(sample, new Uint32Array(0), {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw',
    });
    expect(csv.split('\r\n')).toHaveLength(1);
  });
});

/* ==========================================================================
   The Excel path and the CSV path describe the same events   (2026-08-04, Item 11)

   `eventRows` is a second renderer over `eventColumns`, and the whole reason
   that function was extracted is that two exports of one population must not
   disagree. These assert the agreement directly rather than assuming it from
   the shared call — including the `$TIMESTEP` conversion, which is the one
   place this app has already shipped a four-order-of-magnitude error.
   ========================================================================== */

describe('eventRows', () => {
  const opts = { columns: { indices: [0, 1, 2], naming: 'name' as const }, valueMode: 'raw' as const };
  const all = Uint32Array.from([0, 1, 2, 3, 4]);

  it('gives the same headers as the CSV', () => {
    const csv = eventsToCsv(sample, all, opts).split('\r\n')[0]!;
    expect(eventHeaders(sample, opts).join(',')).toBe(csv);
  });

  it('gives the same values as the CSV, as numbers rather than text', () => {
    const csvBody = eventsToCsv(sample, all, opts).split('\r\n').slice(1);
    const rows = [...eventRows(sample, all, opts)];
    expect(rows).toHaveLength(csvBody.length);
    rows.forEach((row, i) => {
      expect(row.every((v) => typeof v === 'number')).toBe(true);
      expect(row.join(',')).toBe(csvBody[i]);
    });
  });

  it('converts Time to seconds, exactly as the CSV does', () => {
    const timedOpts = { columns: { indices: [2], naming: 'name' as const }, valueMode: 'raw' as const };
    const rows = [...eventRows(timed, Uint32Array.from([0, 1, 2, 3]), timedOpts)];
    // The bug report's ticks — 0, 8, 16, 22 — at $TIMESTEP 1e-4.
    expect(rows.map((r) => r[0])).toEqual([0, 0.0008, 0.0016, 0.0022]);
  });

  /* ------------------------------------------------------------------------
     Computed columns                                        (2026-08-10)

     Unmixed abundances and derived parameters have been plottable and gateable
     for some time and could not be exported, which for the unmixed ones meant
     the whole four-step wizard produced a result that could not leave the
     application — UMAP and every clustering tool take a table of cells ×
     markers.

     Asserted on **both** renderers, because the entire reason `eventColumns`
     exists is that the CSV and the workbook must not disagree, and appending a
     block to one of two parallel loops is exactly how they would.
     --------------------------------------------------------------------- */

  const extra = [
    { header: 'CD4 RB744', values: Float32Array.from([10, 20, 30, 40, 50]) },
    { header: 'Membrane order', values: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5]) },
  ];

  it('writes computed columns after the file’s own, in both renderers', () => {
    const withExtra = { ...opts, extraColumns: extra };
    const csv = eventsToCsv(sample, all, withExtra).split('\r\n');
    expect(csv[0]!.endsWith(',CD4 RB744,Membrane order')).toBe(true);
    // The file's own block is untouched and still leads, because anything
    // matching a CSV against the .fcs beside it matches on that prefix.
    expect(csv[0]!.startsWith(eventsToCsv(sample, all, opts).split('\r\n')[0]!)).toBe(true);

    const rows = [...eventRows(sample, all, withExtra)];
    expect(rows[0]!.slice(-2)).toEqual([10, 0.1]);
    expect(rows[4]!.slice(-2)).toEqual([50, 0.5]);
    rows.forEach((row, i) => expect(row.join(',')).toBe(csv[i + 1]));
  });

  it('leaves the header row alone when there are none', () => {
    // The common case — no matrix applied, no derived parameters — must be
    // byte-identical to what it was, not "the same plus a trailing comma".
    expect(eventsToCsv(sample, all, { ...opts, extraColumns: [] }))
      .toBe(eventsToCsv(sample, all, opts));
  });

  it('does not apply the Time scale to a computed column', () => {
    // `scaleOf` is positional and the Time index is a *file* index. A computed
    // column that happened to land in the same slot must not be multiplied by
    // `$TIMESTEP` — an abundance is already in the units it means.
    const rows = [...eventRows(timed, Uint32Array.from([0, 1]), {
      columns: { indices: [2], naming: 'name' },
      valueMode: 'raw',
      extraColumns: [{ header: 'CD4 RB744', values: Float32Array.from([5000, 6000, 0, 0, 0, 0, 0]) }],
    })];
    expect(rows[0]).toEqual([0, 5000]);
    expect(rows[1]).toEqual([0.0008, 6000]);
  });

  it('yields NaN for a non-finite value, which the writer turns into an empty cell', () => {
    const withNaN = parseFcs(buildFcs({
      dataType: 'F', params: [{ name: 'A', bits: 32, range: 1024 }], events: [[1], [2]],
    }));
    withNaN.data[1] = NaN;
    const rows = [...eventRows(withNaN, Uint32Array.from([0, 1]), {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw',
    })];
    expect(rows[0]![0]).toBe(1);
    expect(Number.isNaN(rows[1]![0] as number)).toBe(true);
  });

  it('is lazy — nothing is computed until a row is pulled', () => {
    // The property the streaming XLSX writer depends on. Calling the generator
    // must not walk the events; if it ever did, a 170 000-event sheet would be
    // materialised before the compressor saw its first byte.
    const gen = eventRows(sample, all, opts);
    expect(gen.next().value).toBeDefined();
    expect([...gen]).toHaveLength(4);
  });
});

/* ==========================================================================
   Time is written in seconds, not in acquisition ticks   (2026-08-03, Item 15)

   The defect: the Time column went out as the raw tick count from the
   acquisition clock, under a bare `Time` header. On a Cytek Aurora file
   `$TIMESTEP` is 0.0001, so a 24-second run ends near 240 000 and every reader
   downstream saw a column that looked like seconds and was out by four orders
   of magnitude. `$PnG` was already applied by the parser; `$TIMESTEP` was the
   one conversion nothing performed.
   ========================================================================== */

describe('the Time column', () => {
  const all = Uint32Array.from([0, 1, 2, 3, 4, 5, 6]);

  it('finds the Time parameter by $PnTYPE', () => {
    expect(timeParameterIndex(timed.metadata)).toBe(2);
    expect(timeParameterIndex(parseFcs(buildFcs({
      dataType: 'F', params: [{ name: 'A', bits: 32, range: 1024 }], events: [[1]],
    })).metadata)).toBe(-1);
  });

  it('reads $TIMESTEP as seconds per tick', () => {
    expect(timeScaleFor(timed.metadata)).toBe(0.0001);
  });

  it('refuses to invent a scale when $TIMESTEP is absent', () => {
    // `null`, not 1. A missing keyword means the unit is unknown, and asserting
    // seconds over ticks is precisely the bug.
    expect(timeScaleFor(sample.metadata)).toBeNull();
  });

  it('converts ticks to seconds, matching the values FCS Express reports', () => {
    const csv = eventsToCsv(timed, all, {
      columns: { indices: [2], naming: 'name' }, valueMode: 'raw',
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Time (s)');
    // Ticks 0, 8, 16, 22, 23, 32, 60 at $TIMESTEP 0.0001.
    expect(lines.slice(1)).toEqual(['0', '0.0008', '0.0016', '0.0022', '0.0023', '0.0032', '0.006']);
  });

  it('converts in transformed mode too, because Time transforms as the identity', () => {
    // A linear transform's forward is `v => v`, so "as displayed" is the same
    // ticks — writing them unconverted under a `(s)` header would reinstate the
    // bug for anyone who picked transformed values.
    const csv = eventsToCsv(timed, Uint32Array.from([1]), {
      columns: { indices: [2], naming: 'name' },
      valueMode: 'transformed',
      transformed: (i) => column(timed, i),
    });
    expect(csv.split('\r\n')[1]).toBe('0.0008');
  });

  it('leaves every other column alone', () => {
    const csv = eventsToCsv(timed, Uint32Array.from([1]), {
      columns: { indices: [0, 1, 2], naming: 'name' }, valueMode: 'raw',
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('FSC-A,B2-A,Time (s)');
    expect(lines[1]).toBe('200,2000,0.0008');
  });

  it('keeps the header honest when the file carries no $TIMESTEP', () => {
    // Values stay as ticks, so the header must not claim seconds.
    expect(columnHeader(sample.metadata, 2, 'name')).toBe('Time');
    const csv = eventsToCsv(sample, Uint32Array.from([1]), {
      columns: { indices: [2], naming: 'name' }, valueMode: 'raw',
    });
    expect(csv.split('\r\n')).toEqual(['Time', '2']);
  });

  it('marks the unit under every naming scheme, since $PnS is empty here', () => {
    expect(columnHeader(timed.metadata, 2, 'name')).toBe('Time (s)');
    expect(columnHeader(timed.metadata, 2, 'both')).toBe('Time (s)');
    expect(columnHeader(timed.metadata, 2, 'stain')).toBe('Time (s)');
  });

  it('carries enough decimals for the step, rather than the default four', () => {
    // At 1e-4 the default is exactly enough; at 1e-6 four decimal places would
    // round every event in a short run to zero.
    expect(timePrecision(1e-4, 4)).toBe(4);
    expect(timePrecision(1e-6, 4)).toBe(6);
    expect(timePrecision(1e-2, 4)).toBe(4);
    expect(timePrecision(1e-20, 4)).toBe(12);

    const fine = parseFcs(buildFcs({
      dataType: 'F',
      params: [{ name: 'Time', bits: 32, range: 262144, type: 'Time' }],
      events: [[1], [25]],
      extraKeywords: { $TIMESTEP: '0.000001' },
    }));
    expect(eventsToCsv(fine, Uint32Array.from([0, 1]), {
      columns: { indices: [0], naming: 'name' }, valueMode: 'raw',
    }).split('\r\n').slice(1)).toEqual(['0.000001', '0.000025']);
  });
});

/* ==========================================================================
   Full Gate Export planning
   ========================================================================== */

const rect = (id: string, name: string, parentId: string | null): Gate =>
  ({ id, name, parentId, colorIndex: 0, kind: 'rectangle', xParam: 0, yParam: 1, xMin: 0, xMax: 1e9, yMin: 0, yMax: 1e9 });

function makeInput(sampleId: string, name: string, counts: Record<string, number>, total: number, gates: Gate[]): PlanInput {
  return { sampleId, sampleName: name, gates, counts: new Map(Object.entries(counts)), totalEvents: total };
}

describe('planFullExport', () => {
  const gates = [rect('a', 'Cells', null), rect('b', 'CD3+', 'a'), rect('c', 'CD4+', 'b')];

  it('counts samples × populations including the root', () => {
    const inputs = [
      makeInput('s1', 'Sample 1', { a: 900, b: 500, c: 200 }, 1000, gates),
      makeInput('s2', 'Sample 2', { a: 800, b: 400, c: 150 }, 1000, gates),
    ];
    const plan = planFullExport(inputs, 10, 'per-population');
    // 2 samples × (root + 3 gates) = 8 files.
    expect(plan.fileCount).toBe(8);
    expect(plan.sampleCount).toBe(2);
    expect(plan.populationCount).toBe(4);
    expect(plan.totalEvents).toBe(1000 + 900 + 500 + 200 + 1000 + 800 + 400 + 150);
  });

  it('records a zero-event population as skipped rather than dropping it', () => {
    // The whole point of the results table: a silent gap in an 84-file export is
    // worse than no export.
    const inputs = [makeInput('s1', 'S1', { a: 900, b: 0, c: 0 }, 1000, gates)];
    const plan = planFullExport(inputs, 10, 'per-population');
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.every((s) => s.status === 'skipped-empty')).toBe(true);
    expect(plan.fileCount).toBe(2); // root + Cells
  });

  it('records a gate missing from a sample as skipped-missing', () => {
    const inputs = [makeInput('s1', 'S1', { a: 900 }, 1000, gates)];
    const plan = planFullExport(inputs, 10, 'per-population');
    const missing = plan.skipped.filter((s) => s.status === 'skipped-missing');
    expect(missing).toHaveLength(2);
    expect(missing[0]!.reason).toMatch(/not defined/i);
  });

  /*
     Reversed rather than deleted (2026-08-04, Item 11).

     This asserted `'combined'` collapsed a run to **one** file. That shape is
     gone; `'workbook-per-sample'` is what stands in its place and it collapses
     to **one file per sample** — every population of that sample as a tab
     inside it. The two numbers 8 → 2 and 8 → 1 are the whole difference between
     the shape that was removed and the one that replaced it, so the assertion
     states both.
  */
  it('collapses to one workbook per sample for the workbook shape', () => {
    const inputs = [
      makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates),
      makeInput('s2', 'S2', { a: 900, b: 500, c: 200 }, 1000, gates),
    ];
    expect(planFullExport(inputs, 10, 'workbook-per-sample').fileCount).toBe(2);
    expect(planFullExport(inputs, 10, 'per-population').fileCount).toBe(8);
  });

  it('counts no workbook for a sample whose every population is empty', () => {
    const inputs = [
      makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates),
      // Every gate selects nothing, and the root is excluded — so this sample
      // produces no target at all and must not be counted as a file.
      makeInput('s2', 'S2', { a: 0, b: 0, c: 0 }, 1000, gates),
    ];
    expect(planFullExport(inputs, 10, 'workbook-per-sample', false).fileCount).toBe(1);
  });

  it('can exclude the root population', () => {
    const inputs = [makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates)];
    expect(planFullExport(inputs, 10, 'per-population', false).fileCount).toBe(3);
  });

  it('estimates a size that scales with events and columns', () => {
    const inputs = [makeInput('s1', 'S1', { a: 1000 }, 1000, [rect('a', 'A', null)])];
    const small = planFullExport(inputs, 5, 'per-population');
    const big = planFullExport(inputs, 50, 'per-population');
    expect(big.estimatedBytes).toBeGreaterThan(small.estimatedBytes);
  });

  it('builds the full population path for nested gates', () => {
    const inputs = [makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates)];
    const plan = planFullExport(inputs, 10, 'per-population');
    const cd4 = plan.targets.find((t) => t.populationName === 'CD4+')!;
    expect(cd4.populationPath).toBe('Cells/CD3+/CD4+');
    expect(cd4.parentName).toBe('CD3+');
  });

  it('handles a workspace with no gates at all', () => {
    const plan = planFullExport([makeInput('s1', 'S1', {}, 1000, [])], 10, 'per-population');
    expect(plan.fileCount).toBe(1); // just the root
  });
});

/* ==========================================================================
   Choosing which populations to export
   ========================================================================== */

describe('populationTree', () => {
  const gates = [rect('a', 'Cells', null), rect('b', 'CD3+', 'a'), rect('c', 'CD4+', 'b')];

  it('reads depth-first, so indentation means containment', () => {
    const tree = populationTree([makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates)]);
    expect(tree.map((n) => n.path)).toEqual(['All events', 'Cells', 'Cells/CD3+', 'Cells/CD3+/CD4+']);
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    expect(tree[3]!.parentPath).toBe('Cells/CD3+');
  });

  it('is the union across samples, keyed by path', () => {
    // Gating is shared, so two samples normally contribute the same four paths —
    // and the tree has to be four rows rather than eight.
    const tree = populationTree([
      makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates),
      makeInput('s2', 'S2', { a: 800, b: 400, c: 150 }, 1000, gates),
    ]);
    expect(tree).toHaveLength(4);
    const cd4 = tree.find((n) => n.name === 'CD4+')!;
    expect(cd4.sampleCount).toBe(2);
    expect(cd4.eventCount).toBe(350);
  });

  it('counts a population that only some samples carry', () => {
    // The case that makes the union the right choice: a tree built from whichever
    // sample came first would silently drop CD4+ or silently offer it as if every
    // sample had it. The row says 1 of 2 instead.
    const tree = populationTree([
      makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates),
      makeInput('s2', 'S2', { a: 800 }, 1000, [rect('a', 'Cells', null)]),
    ]);
    expect(tree.find((n) => n.name === 'Cells')!.sampleCount).toBe(2);
    expect(tree.find((n) => n.name === 'CD4+')!.sampleCount).toBe(1);
  });

  it('matches a forked sample by path, not by gate id', () => {
    // An unlinked sample's fork has **fresh gate ids**, so a selection keyed by id
    // would export from one sample and skip the other for no reason the user could
    // see. The paths are identical, which is what the two hierarchies genuinely
    // have in common.
    const forked = [rect('z1', 'Cells', null), rect('z2', 'CD3+', 'z1')];
    const tree = populationTree([
      makeInput('s1', 'S1', { a: 900, b: 500, c: 200 }, 1000, gates),
      makeInput('s2', 'S2', { z1: 800, z2: 400 }, 1000, forked),
    ]);
    expect(tree.find((n) => n.path === 'Cells/CD3+')!.sampleCount).toBe(2);
  });

  it('drops the root row when the root is not wanted', () => {
    const tree = populationTree([makeInput('s1', 'S1', { a: 900 }, 1000, [rect('a', 'Cells', null)])], false);
    expect(tree.map((n) => n.path)).toEqual(['Cells']);
    expect(tree[0]!.parentPath).toBeNull();
    expect(tree[0]!.depth).toBe(0);
  });
});

describe('selecting populations', () => {
  const gates = [rect('a', 'Cells', null), rect('b', 'CD3+', 'a'), rect('c', 'CD4+', 'b'), rect('d', 'CD8+', 'b')];
  const inputs = [makeInput('s1', 'S1', { a: 900, b: 500, c: 200, d: 250 }, 1000, gates)];
  const tree = populationTree(inputs);

  it('opens on everything', () => {
    expect(allPaths(tree).size).toBe(5);
    expect(planFullExport(inputs, 10, 'per-population', true, 'csv', allPaths(tree)).fileCount).toBe(5);
  });

  it('exports exactly one gate when exactly one is checked', () => {
    // The first of the three cases the brief names.
    const one = new Set(['Cells/CD3+/CD4+']);
    const plan = planFullExport(inputs, 10, 'per-population', false, 'csv', one);
    expect(plan.fileCount).toBe(1);
    expect(plan.targets[0]!.populationName).toBe('CD4+');
    expect(plan.totalEvents).toBe(200);
  });

  it('exports a set spanning different depths and branches', () => {
    // The second case. Nothing requires the selection to be a subtree or contiguous.
    const some = new Set(['All events', 'Cells/CD3+/CD8+']);
    const plan = planFullExport(inputs, 10, 'per-population', true, 'csv', some);
    expect(plan.targets.map((t) => t.populationName).sort()).toEqual(['All events', 'CD8+']);
    expect(plan.totalEvents).toBe(1000 + 250);
  });

  it('leaves an unchecked population out of the report entirely', () => {
    // Not a skip. Nothing was attempted, so there is nothing to report — and a
    // results table full of populations the user deliberately excluded would bury
    // the entries that do mean something.
    const one = new Set(['Cells']);
    const plan = planFullExport(inputs, 10, 'per-population', false, 'csv', one);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.populationCount).toBe(1);
  });

  it('still reports an empty *selected* population as skipped', () => {
    const empty = [makeInput('s1', 'S1', { a: 900, b: 0, c: 0, d: 0 }, 1000, gates)];
    const plan = planFullExport(empty, 10, 'per-population', false, 'csv', new Set(['Cells/CD3+']));
    expect(plan.fileCount).toBe(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.status).toBe('skipped-empty');
  });

  it('makes the summary follow the selection', () => {
    // What the live pre-export summary is reading. Each of these is one number on
    // screen, and all three have to move together.
    const all = planFullExport(inputs, 10, 'per-population', true, 'csv', allPaths(tree));
    const one = planFullExport(inputs, 10, 'per-population', false, 'csv', new Set(['Cells/CD3+/CD4+']));
    expect(one.fileCount).toBeLessThan(all.fileCount);
    expect(one.totalEvents).toBeLessThan(all.totalEvents);
    expect(one.estimatedBytes).toBeLessThan(all.estimatedBytes);
  });

  it('selects nothing, and produces nothing, without erroring', () => {
    const plan = planFullExport(inputs, 10, 'per-population', false, 'csv', new Set());
    expect(plan.fileCount).toBe(0);
    expect(plan.totalEvents).toBe(0);
    expect(plan.estimatedBytes).toBe(0);
  });

  describe('toggleSubtree', () => {
    it('takes everything under a parent', () => {
      const next = toggleSubtree(tree, new Set(), 'Cells/CD3+');
      expect([...next].sort()).toEqual(['Cells/CD3+', 'Cells/CD3+/CD4+', 'Cells/CD3+/CD8+']);
    });

    it('clears the subtree when it was fully selected', () => {
      const next = toggleSubtree(tree, allPaths(tree), 'Cells/CD3+');
      expect([...next].sort()).toEqual(['All events', 'Cells']);
    });

    it('completes a partial subtree rather than clearing it', () => {
      // A half-checked parent is one click from the state the user is obviously
      // reaching for; making that click clear it instead would be maddening.
      const partial = new Set(['Cells/CD3+/CD4+']);
      const next = toggleSubtree(tree, partial, 'Cells/CD3+');
      expect(next.has('Cells/CD3+')).toBe(true);
      expect(next.has('Cells/CD3+/CD8+')).toBe(true);
    });

    it('leaves the parent alone when a child is unchecked', () => {
      // A parent population is a real population, not a folder: unchecking CD4+
      // must not stop CD3+ being exported.
      const next = toggleSubtree(tree, allPaths(tree), 'Cells/CD3+/CD4+');
      expect(next.has('Cells/CD3+')).toBe(true);
      expect(next.has('Cells/CD3+/CD4+')).toBe(false);
    });

    it('a leaf toggles only itself', () => {
      const next = toggleSubtree(tree, new Set(), 'Cells/CD3+/CD8+');
      expect([...next]).toEqual(['Cells/CD3+/CD8+']);
    });

    it('the root row toggles only itself, and it has to', () => {
      // Every gate descends from All events, so cascading from it would select the
      // whole tree — making the row a second Select all, forty pixels from the
      // first. What the row means is what the checkbox it replaced meant: *also
      // export the ungated population*.
      expect([...toggleSubtree(tree, new Set(), 'All events')]).toEqual(['All events']);
      // And unchecking it leaves the gates alone.
      const next = toggleSubtree(tree, allPaths(tree), 'All events');
      expect(next.has('All events')).toBe(false);
      expect(next.size).toBe(4);
    });
  });

  describe('nodeState', () => {
    it('is off, on and mixed in the three situations that produce them', () => {
      expect(nodeState(tree, new Set(), 'Cells/CD3+')).toBe('off');
      expect(nodeState(tree, allPaths(tree), 'Cells/CD3+')).toBe('on');
      expect(nodeState(tree, new Set(['Cells/CD3+/CD4+']), 'Cells/CD3+')).toBe('mixed');
    });

    it('is mixed when the node is checked but only some children are', () => {
      const s = new Set(['Cells/CD3+', 'Cells/CD3+/CD4+']);
      expect(nodeState(tree, s, 'Cells/CD3+')).toBe('mixed');
    });

    it('is on for a checked leaf, which has no children to be partial about', () => {
      expect(nodeState(tree, new Set(['Cells/CD3+/CD8+']), 'Cells/CD3+/CD8+')).toBe('on');
    });

    it('never reports the root row as partial, because it does not cascade', () => {
      // It would otherwise read `mixed` while being exactly as checked as the user
      // left it, which is the one state a checkbox must never claim.
      expect(nodeState(tree, new Set(['All events']), 'All events')).toBe('on');
      expect(nodeState(tree, new Set(['Cells']), 'All events')).toBe('off');
      expect(nodeState(tree, allPaths(tree), 'All events')).toBe('on');
    });
  });
});

describe('safeName and targetPath', () => {
  it('strips characters that break filesystems', () => {
    expect(safeName('CD4+/CD8-')).toBe('CD4+_CD8-');
    expect(safeName('a:b*c?')).toBe('a_b_c');
    expect(safeName('Sample B')).toBe('Sample_B');
  });

  it('never returns an empty name', () => {
    expect(safeName('///')).toBe('unnamed');
    expect(safeName('')).toBe('unnamed');
    expect(safeName('   ')).toBe('unnamed');
  });

  it('does not leave a trailing dot, which Windows rejects', () => {
    expect(safeName('population.')).toBe('population');
  });

  // Was "builds a structured per-sample path", asserting
  // `Sample_B/Sample_B_CD4+.csv`. **Reversed**, not adjusted: the directory
  // component is gone, because it repeated the first half of every filename
  // inside it and carried nothing the name did not. See `targetPath`.
  it('names a file by its sample and population, with no directory', () => {
    const path = targetPath({
      sampleId: 's', sampleName: 'Sample B', gateId: 'g', populationName: 'CD4+',
      populationPath: 'Cells/CD4+', parentName: 'Cells', eventCount: 5,
    });
    expect(path).toBe('Sample_B_CD4+.csv');
    // The claim that matters is flatness, not the exact string: a separator
    // anywhere in here is a folder, whatever it is spelled with.
    expect(path).not.toMatch(/[/\\]/);
  });

  // Was asserted with `'fcs'`, which is no longer a format — see `ExportFormat`.
  // The claim is unchanged: the extension follows the chosen format rather than
  // being hard-coded to csv.
  it('carries the format through to the extension', () => {
    expect(targetPath({
      sampleId: 's', sampleName: 'S1', gateId: 'g', populationName: 'Cells',
      populationPath: 'Cells', parentName: 'All events', eventCount: 5,
    }, 'xlsx')).toBe('S1_Cells.xlsx');
  });
});

// The `manifest` block that stood here is gone with `manifestToCsv` and
// `manifestToJson`. An export writes data files and nothing else; what those
// functions serialised is the results table `ExportView` renders when a run
// finishes, which is where it was read. `ManifestEntry` is still the shape of a
// row — see the note on it.

// The `combinedLeadingValues` block that stood here is gone with the combined
// long-format shape (2026-08-04, Item 11). Its assertion — five leading columns
// ending in the population path — was true, and it was the property that made
// the shape expensive: five identifying strings repeated on every one of a
// quarter of a million rows. `workbook-per-sample` states the same facts once,
// as a filename and a tab name.

describe('workbookPath', () => {
  it('names a workbook after the sample alone', () => {
    expect(workbookPath('20250101-Sample B Pro12A1')).toBe('20250101-Sample_B_Pro12A1.xlsx');
  });

  it('carries no directory and no population', () => {
    const path = workbookPath('Sample B');
    expect(path).toBe('Sample_B.xlsx');
    expect(path).not.toMatch(/[/\\]/);
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [5 * 1024 ** 2, '5.0 MB'],
    [3 * 1024 ** 3, '3.00 GB'],
  ])('%i -> %s', (n, expected) => {
    expect(formatBytes(n)).toBe(expected);
  });
});

describe('indicesFor', () => {
  it('reads event indices out of an evaluated mask', () => {
    const ctx: GateContext = {
      eventCount: 5,
      columnFor: () => Float32Array.from([1, 2, 3, 4, 5]),
    };
    const gates: Gate[] = [
      { id: 'g', name: 'g', parentId: null, colorIndex: 0, kind: 'rectangle', xParam: 0, yParam: 0, xMin: 2, xMax: 4, yMin: 2, yMax: 4 },
    ];
    const { masks } = evaluateGates(gates, ctx);
    expect(Array.from(indicesFor(masks, 'g'))).toEqual([1, 2, 3]);
    expect(indicesFor(masks, ROOT_ID).length).toBe(5);
    expect(indicesFor(masks, 'nope').length).toBe(0);
  });
});

describe('statusLabel — 2026-08-11, Item 4', () => {
  it('renders a completed row in sentence case', () => {
    // The reported complaint: the results table read `completed`, lowercase,
    // because that is how the field is spelled rather than how a label is
    // written.
    expect(statusLabel('written')).toBe('Completed');
  });

  it('renders every other outcome the same way', () => {
    expect(statusLabel('skipped-empty')).toBe('Empty');
    expect(statusLabel('skipped-missing')).toBe('Missing');
    expect(statusLabel('failed')).toBe('Failed');
  });

  it('starts every label with a capital, and none of them is a field value', () => {
    const statuses: Array<ManifestEntry['status']> = ['written', 'skipped-empty', 'skipped-missing', 'failed'];
    for (const s of statuses) {
      const label = statusLabel(s);
      expect(label[0]).toBe(label[0]!.toUpperCase());
      expect(label).not.toBe(s);
      expect(label).not.toContain('-');
    }
  });
});
