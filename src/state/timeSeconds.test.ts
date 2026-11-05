import { describe, expect, it } from 'vitest';
import { parseFcs } from '@/core/fcs/parser';
import { buildFcs } from '@/core/fcs/fixtures';
import { eventRows } from '@/core/export';
import { parametersFor, sampleColumn } from './derivedStore';

/* ==========================================================================
   The Time channel reaches a plot in seconds.

   The reported bug was a Time × SSC-A plot whose x axis read `0, 1M, 2M, 3M`:
   acquisition ticks, abbreviated with the magnitude suffixes an intensity
   channel needs, where a `3M` is five minutes. `$TIMESTEP` says what one tick is
   worth and nothing on the render path was applying it.

   The fix is in the two functions that resolve a parameter index to data, which
   is why these tests go through *those* rather than through a rendered axis: an
   assertion on a tick label would pass against a hard-coded relabelling that
   left the hover readout, the typed axis limit and any gate drawn on Time in
   ticks — which is the "one thing described two ways" failure the fix exists to
   avoid. Measure what the readers read.
   ========================================================================== */

/** Three parameters and the Aurora's own `$TIMESTEP`. Ticks from the report. */
const timed = parseFcs(buildFcs({
  dataType: 'F',
  params: [
    { name: 'FSC-A', bits: 32, range: 262144, type: 'Forward_Scatter' },
    { name: 'B2-A', bits: 32, range: 262144, type: 'Raw_Fluorescence' },
    { name: 'Time', bits: 32, range: 262144, type: 'Time' },
  ],
  events: [[100, 1000, 0], [200, 2000, 10000], [300, 3000, 1000000], [400, 4000, 3000000]],
  extraKeywords: { $TIMESTEP: '0.0001' },
}));

/** The same shape with no `$TIMESTEP`, where the unit is genuinely unknown. */
const untimed = parseFcs(buildFcs({
  dataType: 'F',
  params: [
    { name: 'FSC-A', bits: 32, range: 262144, type: 'Forward_Scatter' },
    { name: 'Time', bits: 32, range: 262144, type: 'Time' },
  ],
  events: [[100, 0], [200, 10000]],
}));

const NO_DEFS: never[] = [];

describe('the Time channel on a plot', () => {
  it('resolves to seconds, not to acquisition ticks', () => {
    const col = sampleColumn(timed, 2, NO_DEFS);
    // 3 000 000 ticks at 1e-4 is 300 s — the `3M` from the reported screenshot.
    expect(Array.from(col)).toEqual([0, 1, 100, 300]);
  });

  it('and the axis it is drawn against says so', () => {
    const p = parametersFor(timed, NO_DEFS)[2]!;
    expect(p.label).toBe('Time (s)');
    // `name` is untouched: expressions reference parameters by it, and so does
    // the export's own `$PnN` column heading.
    expect(p.name).toBe('Time');
  });

  it('scales the declared range with the values, or the axis domain is wrong', () => {
    // `$PnR` is in ticks like the data. A linear axis builds its display domain
    // from `range`, so leaving it at 262 144 would frame 26 seconds of data on
    // an axis running to a quarter of a million.
    expect(parametersFor(timed, NO_DEFS)[2]!.range).toBeCloseTo(26.2144, 6);
  });

  it('leaves every other parameter alone, by identity', () => {
    const params = parametersFor(timed, NO_DEFS);
    expect(params[0]).toBe(timed.metadata.parameters[0]);
    expect(sampleColumn(timed, 0, NO_DEFS)[0]).toBe(100);
  });

  it('does not invent a unit when $TIMESTEP is absent', () => {
    // `null` scale means the unit is unknown. Asserting seconds over ticks is
    // the same defect wearing a label, so the raw counter is shown as-is.
    expect(Array.from(sampleColumn(untimed, 1, NO_DEFS))).toEqual([0, 10000]);
    expect(parametersFor(untimed, NO_DEFS)[1]!.label).toBe('Time');
  });

  it('returns a stable array so a memo downstream is not invalidated per render', () => {
    expect(parametersFor(timed, NO_DEFS)).toBe(parametersFor(timed, NO_DEFS));
    expect(sampleColumn(timed, 2, NO_DEFS)).toBe(sampleColumn(timed, 2, NO_DEFS));
  });

  it('does not double-apply in the export, which converts on its own path', () => {
    // The export slices `parsed.data` directly and multiplies by `$TIMESTEP`
    // itself — verified against `$BTIM`/`$ETIM` since 2026-08-03. If it ever
    // starts going through `sampleColumn`, this fails rather than silently
    // writing 3e-5 seconds for a five-minute acquisition.
    const rows = [...eventRows(timed, Uint32Array.from([0, 1, 2, 3]), {
      columns: { indices: [2], naming: 'name' }, valueMode: 'raw',
    })];
    expect(rows.map((r) => r[0])).toEqual([0, 1, 100, 300]);
  });
});
