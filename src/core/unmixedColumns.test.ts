import { describe, expect, it } from 'vitest';
import {
  attachUnmixed, detachUnmixed, surfacedSignatures, unmixedColumn, unmixedCount, unmixedFor,
} from './unmixedColumns';
import type { ParsedFcs } from './fcs/types';

/* ==========================================================================
   2026-08-11, Item 15 — a reference is not an antibody parameter.

   The exclusion rule had two implementations before this pass (the similarity
   matrix and the export's computed columns) and was missing from the third
   surface, the axis picker, which is where it was reported. It is one function
   now, and these are its properties.
   ========================================================================== */

/** Just enough of a `ParsedFcs` to be a registry key. */
function key(): ParsedFcs {
  return {} as unknown as ParsedFcs;
}

const panel = [
  { label: 'CD3 RY703', isAutofluorescence: false },
  { label: 'CD4 RB744', isAutofluorescence: false },
  { label: 'Unstained', isAutofluorescence: true },
];

describe('surfacedSignatures', () => {
  it('keeps the antibodies and drops the reference', () => {
    const { labels, columns } = surfacedSignatures(panel);
    expect(labels).toEqual(['CD3 RY703', 'CD4 RB744']);
    expect(columns).toEqual([0, 1]);
  });

  it('records where each surviving label reads, not where it sits', () => {
    // The reference first, which is what a panel with an autofluorescence
    // control sorted to the front would produce.
    const { labels, columns } = surfacedSignatures([
      { label: 'Autofluorescence', isAutofluorescence: true },
      { label: 'CD8 BV421', isAutofluorescence: false },
    ]);
    expect(labels).toEqual(['CD8 BV421']);
    // Column 1 of the abundances, position 0 of the parameter list — the two
    // stop being the same number, which is the whole reason the map exists.
    expect(columns).toEqual([1]);
  });

  it('surfaces everything when a panel carries no reference', () => {
    const { labels, columns } = surfacedSignatures(panel.slice(0, 2));
    expect(labels).toHaveLength(2);
    expect(columns).toEqual([0, 1]);
  });

  it('surfaces nothing when every signature is a reference', () => {
    expect(surfacedSignatures([{ label: 'Unstained', isAutofluorescence: true }])).toEqual({
      labels: [], columns: [],
    });
  });
});

describe('the registry, once a reference has been left out', () => {
  const N = 4;
  /** Three signatures × four events, each block filled with its own index. */
  const data = Float32Array.from([
    10, 11, 12, 13, // CD3
    20, 21, 22, 23, // CD4
    90, 91, 92, 93, // Unstained — present in the solve, absent from the pickers
  ]);

  it('counts only the surfaced parameters', () => {
    const parsed = key();
    attachUnmixed(parsed, { data, eventCount: N, ...surfacedSignatures(panel) });
    expect(unmixedCount(parsed)).toBe(2);
    expect(unmixedFor(parsed)!.labels).toEqual(['CD3 RY703', 'CD4 RB744']);
    detachUnmixed(parsed);
  });

  it('reads each parameter’s own block through the index map', () => {
    const parsed = key();
    attachUnmixed(parsed, { data, eventCount: N, ...surfacedSignatures(panel) });
    expect(Array.from(unmixedColumn(parsed, 0)!)).toEqual([10, 11, 12, 13]);
    expect(Array.from(unmixedColumn(parsed, 1)!)).toEqual([20, 21, 22, 23]);
    // Past the surfaced set: the reference's block is in `data` and is not
    // reachable as a parameter.
    expect(unmixedColumn(parsed, 2)).toBeNull();
    detachUnmixed(parsed);
  });

  it('still reads the right block when the reference comes first', () => {
    const parsed = key();
    const reordered = Float32Array.from([90, 91, 92, 93, 10, 11, 12, 13]);
    attachUnmixed(parsed, {
      data: reordered,
      eventCount: N,
      ...surfacedSignatures([
        { label: 'Unstained', isAutofluorescence: true },
        { label: 'CD3 RY703', isAutofluorescence: false },
      ]),
    });
    // Parameter 0 is CD3, which lives in block 1. Reading block 0 would hand a
    // plot the background column under an antibody's name.
    expect(Array.from(unmixedColumn(parsed, 0)!)).toEqual([10, 11, 12, 13]);
    detachUnmixed(parsed);
  });

  it('answers nothing for a sample that was never unmixed', () => {
    const parsed = key();
    expect(unmixedFor(parsed)).toBeNull();
    expect(unmixedCount(parsed)).toBe(0);
    expect(unmixedColumn(parsed, 0)).toBeNull();
  });
});
