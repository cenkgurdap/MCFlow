import { describe, expect, it } from 'vitest';
import type { FcsMetadata, ParsedFcs } from './fcs/types';
import { unmix } from './spectral';
import {
  CompensationError,
  compensationSetup,
  matrixFromControls,
  primaryDetectorOf,
  worstSpillover,
  type CompensationMatrix,
  type CompensationRow,
} from './compensation';

/* ==========================================================================
   Does the matrix come out in the orientation the FCS standard defines, and
   does it refuse what it cannot solve.
   ========================================================================== */

const DETS = ['D1', 'D2', 'D3'];

function row(label: string, primary: number, sig: number[]): CompensationRow {
  return { label, primary, signature: Float64Array.from(sig) };
}

describe('matrixFromControls', () => {
  it('normalises each row to its own primary detector', () => {
    const m = matrixFromControls([
      row('A', 0, [100, 20, 5]),
      row('B', 1, [8, 200, 40]),
      row('C', 2, [1, 3, 50]),
    ], DETS);

    expect(m.size).toBe(3);
    expect(m.detectors).toEqual(['D1', 'D2', 'D3']);
    // Row i, column j is the fraction of dye i seen in detector j.
    expect(Array.from(m.values.slice(0, 3))).toEqual([1, 0.2, 0.05]);
    expect(Array.from(m.values.slice(3, 6))).toEqual([0.04, 1, 0.2]);
    expect(m.values[8]).toBe(1);
  });

  it('gives a detector no dye peaks in an identity row', () => {
    // Four detectors, two dyes. A conventional panel often has a spare channel,
    // and acquisition software writes the same identity rows for it.
    const m = matrixFromControls([
      row('A', 0, [100, 10, 1, 0]),
      row('B', 2, [5, 0, 80, 2]),
    ], ['D1', 'D2', 'D3', 'D4']);
    expect(m.size).toBe(4);
    expect(m.detectors).toEqual(['D1', 'D2', 'D3', 'D4']);
    expect(Array.from(m.values.slice(0, 4))).toEqual([1, 0.1, 0.01, 0]);
    expect(Array.from(m.values.slice(4, 8))).toEqual([0, 1, 0, 0]);
    expect(Array.from(m.values.slice(8, 12))).toEqual([0.0625, 0, 1, 0.025]);
    expect(Array.from(m.values.slice(12))).toEqual([0, 0, 0, 1]);
  });

  it('and the padding leaves the real dyes` values untouched', () => {
    /*
       The claim the padding rests on: with identity rows for the unclaimed
       detectors, `S⁻¹` is block-triangular and the claimed dyes come out at
       exactly `y·A⁻¹` — the minimal square system's answer. Asserted by solving
       both and comparing, because "the algebra says so" is what the block
       structure has to actually do.
    */
    const rows = [row('A', 0, [100, 10, 1, 0]), row('B', 2, [5, 0, 80, 2])];
    const padded = matrixFromControls(rows, ['D1', 'D2', 'D3', 'D4']);
    const minimal: CompensationMatrix = {
      detectors: ['D1', 'D3'],
      values: Float64Array.from([1, 0.01, 0.0625, 1]),
      size: 2,
    };

    const md = {
      parameters: ['D1', 'D2', 'D3', 'D4'].map((name) => ({ name, isDataChannel: true, type: 'Other' })),
    } as unknown as FcsMetadata;
    const n = 3;
    const data = new Float32Array(4 * n);
    [[900, 40, 60, 7], [120, 33, 800, 12], [500, 21, 500, 9]].forEach((ev, e) => {
      ev.forEach((v, d) => { data[d * n + e] = v; });
    });
    const parsed = { metadata: { ...md, eventCount: n }, data } as unknown as ParsedFcs;

    const a = unmix(parsed, compensationSetup(md, padded), 'ols');
    const b = unmix(parsed, compensationSetup(md, minimal), 'ols');
    for (let e = 0; e < n; e++) {
      expect(a.data[0 * n + e]).toBeCloseTo(b.data[0 * n + e]!, 6);
      expect(a.data[2 * n + e]).toBeCloseTo(b.data[1 * n + e]!, 6);
    }
  });

  it('refuses two dyes on one detector rather than solving a singular system', () => {
    expect(() => matrixFromControls([
      row('A', 1, [1, 100, 1]),
      row('B', 1, [1, 80, 1]),
    ], DETS)).toThrow(CompensationError);
  });

  it('refuses a control that reads nothing on its assigned detector', () => {
    expect(() => matrixFromControls([row('A', 2, [100, 20, 0])], DETS))
      .toThrow(/reads nothing/);
    // Negative too: a positive population below the negative one is a gate
    // that has been drawn the wrong way round, not a coefficient.
    expect(() => matrixFromControls([row('A', 2, [100, 20, -3])], DETS))
      .toThrow(/reads nothing/);
  });

  it('refuses an empty panel', () => {
    expect(() => matrixFromControls([], DETS)).toThrow(CompensationError);
  });
});

describe('primaryDetectorOf', () => {
  it('is the peak of the signature, which is a difference, not a median', () => {
    expect(primaryDetectorOf(Float64Array.from([3, 91, 12]))).toBe(1);
  });
});

describe('worstSpillover', () => {
  it('ignores the diagonal', () => {
    const m = matrixFromControls([
      row('A', 0, [100, 60, 1]),
      row('B', 1, [2, 200, 4]),
      row('C', 2, [1, 3, 50]),
    ], DETS);
    expect(worstSpillover(m)).toEqual({ from: 0, to: 1, value: 0.6 });
  });
});

describe('the solve is the classical one', () => {
  /**
   * The claim `core/compensation.ts` rests on: handing a square S to the
   * spectral solver returns `y · S⁻¹`.
   *
   * Built the other way round on purpose — take known compensated values, spill
   * them through S to make the "measured" data, and check the solve gives the
   * originals back. Asserting the maths against itself would pass for any
   * consistent orientation, including the transposed one.
   */
  it('recovers the values a known matrix spilled', () => {
    const m: CompensationMatrix = {
      detectors: ['D1', 'D2'],
      values: Float64Array.from([1, 0.3, 0.05, 1]),
      size: 2,
    };
    const truth = [[1000, 0], [0, 500], [200, 700]];
    const measured = truth.map(([a, b]) => [
      a! * 1 + b! * 0.05,
      a! * 0.3 + b! * 1,
    ]);

    const md = {
      parameters: [
        { name: 'D1', isDataChannel: true, type: 'Other' },
        { name: 'D2', isDataChannel: true, type: 'Other' },
      ],
      eventCount: truth.length,
    } as unknown as FcsMetadata;
    const data = new Float32Array(2 * truth.length);
    measured.forEach(([a, b], e) => { data[e] = a!; data[truth.length + e] = b!; });
    const parsed = { metadata: md, data } as unknown as ParsedFcs;

    const setup = compensationSetup(md, m);
    const out = unmix(parsed, setup, 'ols');
    truth.forEach(([a, b], e) => {
      expect(out.data[e]).toBeCloseTo(a!, 3);
      expect(out.data[truth.length + e]).toBeCloseTo(b!, 3);
    });
  });

  it('refuses a matrix naming a detector the sample does not have', () => {
    const md = { parameters: [{ name: 'D1', isDataChannel: true, type: 'Other' }] } as unknown as FcsMetadata;
    expect(() => compensationSetup(md, {
      detectors: ['D1', 'D9'], values: new Float64Array(4), size: 2,
    })).toThrow(/no detector named/);
  });
});
