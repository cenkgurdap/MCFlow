import { describe, expect, it } from 'vitest';
import { detectAcquisitionType, parseFcs } from './parser';
import { FcsParseError, column } from './types';
import { buildFcs, type FixtureSpec } from './fixtures';

/* ==========================================================================
   Synthetic fixtures
   ========================================================================== */

const P = (name: string, bits: number, range = 1024, extra: Partial<FixtureSpec['params'][0]> = {}) => ({
  name, bits, range, ...extra,
});

describe('integer data', () => {
  it('reads 16-bit little-endian integers', () => {
    const buf = buildFcs({
      dataType: 'I',
      params: [P('FSC-A', 16, 65536), P('SSC-A', 16, 65536)],
      events: [[100, 200], [300, 400], [65535, 0]],
    });
    const parsed = parseFcs(buf);
    expect(parsed.metadata.eventCount).toBe(3);
    expect(Array.from(column(parsed, 0))).toEqual([100, 300, 65535]);
    expect(Array.from(column(parsed, 1))).toEqual([200, 400, 0]);
  });

  it('reads big-endian integers identically', () => {
    const events = [[1, 2], [3, 4], [1000, 2000]];
    const le = parseFcs(buildFcs({ dataType: 'I', byteOrd: '1,2,3,4', params: [P('A', 16, 65536), P('B', 16, 65536)], events }));
    const be = parseFcs(buildFcs({ dataType: 'I', byteOrd: '4,3,2,1', params: [P('A', 16, 65536), P('B', 16, 65536)], events }));
    expect(be.metadata.byteOrder).toBe('big');
    expect(Array.from(be.data)).toEqual(Array.from(le.data));
  });

  it.each([8, 16, 24, 32])('reads %i-bit widths', (bits) => {
    const max = bits >= 32 ? 4_000_000_000 : 2 ** bits - 1;
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('X', bits, 2 ** Math.min(bits, 32))],
      events: [[0], [1], [max]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([0, 1, max]);
  });

  it('masks values to $PnR when the field is wider than the range', () => {
    // 16-bit field, range 1024 -> only the low 10 bits are meaningful.
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('X', 16, 1024)],
      events: [[1023], [0xfc00 | 5], [0xffff]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([1023, 5, 1023]);
  });

  it('reads bit-packed non-byte-aligned widths', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('A', 10, 1024), P('B', 6, 64)],
      events: [[1023, 63], [0, 0], [512, 32]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([1023, 0, 512]);
    expect(Array.from(column(parsed, 1))).toEqual([63, 0, 32]);
  });

  it('applies $PnE log amplification to integer data', () => {
    // 4 decades over a range of 1024, offset 1: value = 10^(4*x/1024).
    // Channel values stay below $PnR — 1024 would be masked to 0, since $PnR is
    // "one past the maximum" and only 10 bits are meaningful.
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('LOG', 16, 1024, { amp: [4, 1] } as never)],
      events: [[0], [256], [512], [768]],
    }));
    const col = column(parsed, 0);
    expect(col[0]).toBeCloseTo(1, 5);
    expect(col[1]).toBeCloseTo(10, 4);
    expect(col[2]).toBeCloseTo(100, 3);
    expect(col[3]).toBeCloseTo(1000, 2);
  });

  it('masks an out-of-range value rather than trusting undefined high bits', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('X', 16, 1024)],
      events: [[1024]],
    }));
    expect(column(parsed, 0)[0]).toBe(0);
  });

  it('divides by $PnG gain', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('X', 16, 65536, { gain: 4 } as never)],
      events: [[100], [400]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([25, 100]);
  });
});

describe('float and double data', () => {
  it('reads float32', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'F',
      params: [P('X', 32, 262144), P('Y', 32, 262144)],
      events: [[1.5, -2.25], [1e5, 0]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([1.5, 1e5]);
    expect(Array.from(column(parsed, 1))).toEqual([-2.25, 0]);
  });

  it('reads float64 and narrows to float32 storage', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'D',
      params: [P('X', 64, 262144)],
      events: [[1.5], [-1024.75]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([1.5, -1024.75]);
  });

  it('reads ASCII data', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'A',
      params: [P('X', 8, 1024), P('Y', 8, 1024)],
      events: [[12, 34], [56, 78]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([12, 56]);
    expect(Array.from(column(parsed, 1))).toEqual([34, 78]);
  });
});

describe('TEXT segment handling', () => {
  it('treats a doubled delimiter as a literal character', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      delimiter: '/',
      params: [P('X', 16, 1024)],
      events: [[1]],
      extraKeywords: { $CYT: 'Model A/B', NOTE: 'ratio 1/2' },
    }));
    expect(parsed.metadata.cytometer).toBe('Model A/B');
    expect(parsed.metadata.keywords['NOTE']).toBe('ratio 1/2');
  });

  it.each(['\f', '|', '/', '\\', '!'])('handles delimiter %j', (d) => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I', delimiter: d,
      params: [P('X', 16, 1024)], events: [[7]],
      extraKeywords: { $CYT: 'Demo' },
    }));
    expect(parsed.metadata.cytometer).toBe('Demo');
    expect(column(parsed, 0)[0]).toBe(7);
  });

  it('merges the supplemental TEXT segment', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      params: [P('X', 16, 1024)],
      events: [[1]],
      supplementalKeywords: { EXTRA_NOTE: 'from supplemental', $OP: 'Ada' },
    }));
    expect(parsed.metadata.keywords['EXTRA_NOTE']).toBe('from supplemental');
    expect(parsed.metadata.operator).toBe('Ada');
    expect(parsed.warnings.map((w) => w.code)).toContain('supplemental-text');
  });

  it('falls back to $BEGINDATA when HEADER offsets are zero (large-file case)', () => {
    const parsed = parseFcs(buildFcs({
      dataType: 'I',
      headerOffsetsZero: true,
      params: [P('X', 16, 1024), P('Y', 16, 1024)],
      events: [[11, 22], [33, 44]],
    }));
    expect(Array.from(column(parsed, 0))).toEqual([11, 33]);
    expect(Array.from(column(parsed, 1))).toEqual([22, 44]);
  });
});

describe('$NEXTDATA chaining', () => {
  const chained: FixtureSpec = {
    dataType: 'I',
    params: [P('X', 16, 1024)],
    events: [[1], [2]],
    extraKeywords: { $CYT: 'First' },
    chain: {
      dataType: 'I',
      params: [P('X', 16, 1024)],
      events: [[9], [8], [7]],
      extraKeywords: { $CYT: 'Second' },
    },
  };

  it('loads the first dataset by default and warns', () => {
    const parsed = parseFcs(buildFcs(chained));
    expect(parsed.metadata.cytometer).toBe('First');
    expect(parsed.metadata.eventCount).toBe(2);
    expect(parsed.warnings.map((w) => w.code)).toContain('multiple-datasets');
  });

  it('loads a requested later dataset', () => {
    const parsed = parseFcs(buildFcs(chained), { datasetIndex: 1 });
    expect(parsed.metadata.cytometer).toBe('Second');
    expect(Array.from(column(parsed, 0))).toEqual([9, 8, 7]);
  });
});

describe('malformed files produce specific, actionable errors', () => {
  const expectErr = (buf: ArrayBuffer, match: RegExp) => {
    expect(() => parseFcs(buf)).toThrow(FcsParseError);
    expect(() => parseFcs(buf)).toThrow(match);
  };

  it('rejects a file that is too short', () => {
    expectErr(new Uint8Array(20).buffer, /too short/i);
  });

  it('rejects a non-FCS file by version stamp', () => {
    const b = new Uint8Array(600);
    b.set(Uint8Array.from('%PDF-1.7', (c) => c.charCodeAt(0)), 0);
    expectErr(b.buffer, /Not an FCS file/i);
  });

  it('rejects histogram mode, and the hint explains why', () => {
    const buf = buildFcs({ dataType: 'I', params: [P('X', 16, 1024)], events: [[1]], extraKeywords: { $MODE: 'H' } });
    expectErr(buf, /\$MODE=H/);
    // The actionable half of the message lives on `hint` so the UI can lay the
    // two out separately; assert it explicitly rather than through toThrow.
    try {
      parseFcs(buf);
      expect.unreachable();
    } catch (e) {
      expect((e as FcsParseError).hint).toMatch(/binned counts/i);
    }
  });

  it('rejects an unknown $DATATYPE', () => {
    expectErr(
      buildFcs({ dataType: 'I', params: [P('X', 16, 1024)], events: [[1]], extraKeywords: { $DATATYPE: 'Z' } }),
      /Unknown \$DATATYPE/,
    );
  });

  it('rejects a missing $PAR', () => {
    expectErr(
      buildFcs({ dataType: 'I', params: [P('X', 16, 1024)], events: [[1]], extraKeywords: { $PAR: '' } }),
      /\$PAR/,
    );
  });

  it('rejects a parameter with no short name', () => {
    expectErr(
      buildFcs({ dataType: 'I', params: [P('X', 16, 1024)], events: [[1]], extraKeywords: { $P1N: '' } }),
      /no \$P1N/,
    );
  });

  it('strips control characters out of error text', () => {
    const b = new Uint8Array(600);
    b.set(Uint8Array.from('FCS\x001.\x07', (c) => c.charCodeAt(0)), 0);
    try {
      parseFcs(b.buffer);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/[\x00-\x1f]/);
    }
  });

  it('warns rather than throws when the data segment overruns the file', () => {
    const buf = buildFcs({ dataType: 'I', params: [P('X', 16, 1024)], events: [[1], [2]] });
    const bytes = new Uint8Array(buf);
    const truncated = bytes.slice(0, bytes.length - 2);
    const { warnings } = parseFcs(truncated.buffer as ArrayBuffer);
    expect(warnings.map((w) => w.code)).toContain('data-size-mismatch');
  });
});

describe('acquisition-type detection', () => {
  const make = (params: Array<{ name: string; type?: string }>) =>
    parseFcs(buildFcs({
      dataType: 'I',
      params: params.map((p) => ({ name: p.name, bits: 16, range: 1024, type: p.type })),
      events: [params.map(() => 1)],
    })).metadata;

  it('calls an 18-colour conventional panel conventional', () => {
    const md = make([
      { name: 'FSC-A' }, { name: 'SSC-A' },
      ...Array.from({ length: 18 }, (_, i) => ({ name: `FL${i + 1}-A` })),
    ]);
    expect(detectAcquisitionType(md).type).toBe('conventional');
  });

  it('calls a 64-detector array spectral even without $PnTYPE', () => {
    const md = make([
      { name: 'FSC-A' }, { name: 'SSC-A' },
      ...Array.from({ length: 16 }, (_, i) => ({ name: `UV${i + 1}-A` })),
      ...Array.from({ length: 16 }, (_, i) => ({ name: `V${i + 1}-A` })),
      ...Array.from({ length: 14 }, (_, i) => ({ name: `B${i + 1}-A` })),
      ...Array.from({ length: 10 }, (_, i) => ({ name: `YG${i + 1}-A` })),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `R${i + 1}-A` })),
    ]);
    const d = detectAcquisitionType(md);
    expect(d.type).toBe('spectral');
    expect(d.fluorescenceChannels).toBe(64);
  });

  it('trusts $PnTYPE over channel naming', () => {
    const md = make([
      { name: 'FSC-A', type: 'Forward_Scatter' },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `Ch${i}`, type: 'Raw_Fluorescence' })),
    ]);
    expect(detectAcquisitionType(md).type).toBe('spectral');
  });
});
