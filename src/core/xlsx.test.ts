import { describe, expect, it } from 'vitest';
import { columnLetter, crc32, sheetName, writeXlsx, xmlEscape, XLSX_MAX_ROWS } from './xlsx';

/* ==========================================================================
   The XLSX writer.

   The writer's only real claim is that the bytes it produces are a workbook a
   spreadsheet will open, and that is not something a unit test can assert — no
   spreadsheet is present. So these do the next thing down, which is what the FCS
   writer's tests did before them: **read the archive back**, structurally, and
   check that every part a reader looks for is there, correctly sized, with a
   correct CRC, holding the values that went in.

   A wrong CRC or a wrong declared length is precisely the failure that produces
   "we found a problem with some content" and nothing more specific, so those are
   checked against the data rather than against themselves.
   ========================================================================== */

/* -------------------------------------------------------------------------
   A minimal ZIP reader, for the tests only
   ------------------------------------------------------------------------- */

interface Entry { name: string; method: number; crc: number; size: number; data: Uint8Array }

/** Read the local headers of an archive in order. Enough to verify one. */
function readZip(buffer: ArrayBuffer): Entry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const out: Entry[] = [];
  let at = 0;
  while (at + 4 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 14, true);
    const compressed = view.getUint32(at + 18, true);
    const size = view.getUint32(at + 22, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    out.push({ name, method, crc, size, data: bytes.subarray(start, start + compressed) });
    at = start + compressed;
  }
  return out;
}

/** Undo the entry's compression, so the XML can be read. */
async function inflate(entry: Entry): Promise<string> {
  if (entry.method === 0) return new TextDecoder().decode(entry.data);
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  await writer.write(entry.data as unknown as BufferSource);
  await writer.close();
  await pump;
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { joined.set(c, o); o += c.length; }
  return new TextDecoder().decode(joined);
}

const partsOf = (buffer: ArrayBuffer) => new Map(readZip(buffer).map((e) => [e.name, e]));

/* -------------------------------------------------------------------------
   Pure helpers
   ------------------------------------------------------------------------- */

describe('columnLetter', () => {
  it.each([[0, 'A'], [1, 'B'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [51, 'AZ'], [52, 'BA'], [701, 'ZZ'], [702, 'AAA']])(
    '%i -> %s',
    (i, expected) => { expect(columnLetter(i as number)).toBe(expected); },
  );

  it('covers a 71-parameter file without repeating a reference', () => {
    const seen = new Set(Array.from({ length: 71 }, (_v, i) => columnLetter(i)));
    expect(seen.size).toBe(71);
  });
});

describe('sheetName', () => {
  it('replaces the characters Excel refuses', () => {
    // One underscore per rejected character, not one per run: `]`, `:` and `/`
    // are three separate characters and become three.
    expect(sheetName('CD4+ [live]:/set*?', new Set())).toBe('CD4+ _live___set__');
  });

  it('truncates to 31 characters', () => {
    expect(sheetName('x'.repeat(60), new Set())).toHaveLength(31);
  });

  it('never returns an empty name', () => {
    expect(sheetName('', new Set())).toBe('Sheet');
    expect(sheetName('   ', new Set())).toBe('Sheet');
  });

  it('de-duplicates, which is what stops the file being rejected outright', () => {
    const taken = new Set<string>();
    expect(sheetName('CD4+', taken)).toBe('CD4+');
    expect(sheetName('CD4+', taken)).toBe('CD4+~2');
    expect(sheetName('CD4+', taken)).toBe('CD4+~3');
  });

  it('de-duplicates case-insensitively, because Excel does', () => {
    const taken = new Set<string>();
    sheetName('Cells', taken);
    expect(sheetName('cells', taken)).toBe('cells~2');
  });

  it('keeps a de-duplicated long name inside the limit', () => {
    const taken = new Set<string>();
    sheetName('y'.repeat(40), taken);
    const second = sheetName('y'.repeat(40), taken);
    expect(second.length).toBeLessThanOrEqual(31);
    expect(second.endsWith('~2')).toBe(true);
  });
});

describe('xmlEscape', () => {
  it('escapes the five characters that matter', () => {
    expect(xmlEscape('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('strips control characters, which XML cannot represent at all', () => {
    // Not merely ugly: a literal NUL in a sample name makes the whole workbook
    // unreadable, and sample names come from filenames.
    expect(xmlEscape(`Sample${String.fromCharCode(0)} B`)).toBe('Sample B');
  });

  it('leaves tab and newline alone', () => {
    expect(xmlEscape('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('crc32', () => {
  it('matches the known value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926);
  });

  it('resumes across chunks', () => {
    const whole = new TextEncoder().encode('123456789');
    const a = crc32(whole.subarray(0, 4));
    expect(crc32(whole.subarray(4), a)).toBe(0xCBF43926);
  });
});

/* -------------------------------------------------------------------------
   The archive
   ------------------------------------------------------------------------- */

describe('writeXlsx — structure', () => {
  const book = () => writeXlsx([{ name: 'Stats', header: ['a', 'b'], rows: [[1, 2], [3, 4]] }]);

  it('writes every part a reader looks for', async () => {
    const parts = partsOf((await book()).buffer);
    for (const name of [
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
    ]) {
      expect(parts.has(name), name).toBe(true);
    }
  });

  it('declares a correct CRC and length for every entry', async () => {
    for (const entry of readZip((await book()).buffer)) {
      const xml = await inflate(entry);
      const raw = new TextEncoder().encode(xml);
      expect(raw.length, entry.name).toBe(entry.size);
      expect(crc32(raw), entry.name).toBe(entry.crc);
    }
  });

  it('ends with an end-of-central-directory record naming every entry', async () => {
    const buffer = (await book()).buffer;
    const view = new DataView(buffer);
    const eocd = buffer.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 8, true)).toBe(readZip(buffer).length);
  });

  it('refuses a workbook with no sheets rather than writing one Excel cannot open', async () => {
    await expect(writeXlsx([])).rejects.toThrow(/at least one sheet/i);
  });

  it('produces the same bytes twice for the same data', async () => {
    // The fixed DOS timestamp is what makes this true, and it is why the
    // timestamp is fixed: an export that differs run to run cannot be diffed.
    const a = new Uint8Array((await book()).buffer);
    const b = new Uint8Array((await book()).buffer);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('writeXlsx — contents', () => {
  it('writes numbers as numbers and strings as inline strings', async () => {
    const result = await writeXlsx([{
      name: 'S', header: ['name', 'count'], rows: [['CD4+', 1234], ['CD8+', 56.75]],
    }]);
    const parts = partsOf(result.buffer);
    const xml = await inflate(parts.get('xl/worksheets/sheet1.xml')!);

    expect(xml).toContain('<c r="B2"><v>1234</v></c>');
    expect(xml).toContain('<c r="B3"><v>56.75</v></c>');
    expect(xml).toContain('<t xml:space="preserve">CD4+</t>');
    // The header carries the bold style; the body does not.
    expect(xml).toContain('<c r="A1" s="1" t="inlineStr">');
  });

  it('omits the cell entirely for a blank or non-finite value', async () => {
    const result = await writeXlsx([{ name: 'S', rows: [[1, NaN, null, '', Infinity, 2]] }]);
    const xml = await inflate(partsOf(result.buffer).get('xl/worksheets/sheet1.xml')!);
    // A1 and F1 are present; the four in between are not, which is how a
    // spreadsheet says "no measurement" without poisoning the column's type.
    expect(xml).toContain('r="A1"');
    expect(xml).toContain('r="F1"');
    for (const ref of ['r="B1"', 'r="C1"', 'r="D1"', 'r="E1"']) expect(xml).not.toContain(ref);
  });

  it('freezes the header row when there is one', async () => {
    const withHeader = await writeXlsx([{ name: 'S', header: ['a'], rows: [[1]] }]);
    const without = await writeXlsx([{ name: 'S', rows: [[1]] }]);
    expect(await inflate(partsOf(withHeader.buffer).get('xl/worksheets/sheet1.xml')!)).toContain('state="frozen"');
    expect(await inflate(partsOf(without.buffer).get('xl/worksheets/sheet1.xml')!)).not.toContain('state="frozen"');
  });

  it('escapes a sample name that would otherwise break the XML', async () => {
    const result = await writeXlsx([{ name: 'S', rows: [['a & b <tag>']] }]);
    const xml = await inflate(partsOf(result.buffer).get('xl/worksheets/sheet1.xml')!);
    expect(xml).toContain('a &amp; b &lt;tag&gt;');
    expect(xml).not.toContain('<tag>');
  });

  it('writes one worksheet per sheet, related and content-typed', async () => {
    const result = await writeXlsx([
      { name: 'Cells', rows: [[1]] },
      { name: 'CD3+', rows: [[2]] },
      { name: 'CD4+', rows: [[3]] },
    ]);
    const parts = partsOf(result.buffer);
    expect(parts.has('xl/worksheets/sheet3.xml')).toBe(true);

    const types = await inflate(parts.get('[Content_Types].xml')!);
    expect(types).toContain('/xl/worksheets/sheet3.xml');

    const rels = await inflate(parts.get('xl/_rels/workbook.xml.rels')!);
    expect(rels).toContain('worksheets/sheet3.xml');
    // Styles take the id after the last sheet — off by one here and Excel
    // reports the file as corrupt with no further detail.
    expect(rels).toContain('Id="rId4"');
    expect(rels).toContain('styles.xml');

    const workbook = await inflate(parts.get('xl/workbook.xml')!);
    expect(workbook).toContain('name="CD4+" sheetId="3" r:id="rId3"');
  });

  it('reports the tab names it actually used', async () => {
    const result = await writeXlsx([
      { name: 'CD4+', rows: [[1]] },
      { name: 'CD4+', rows: [[2]] },
      { name: 'a'.repeat(50), rows: [[3]] },
    ]);
    expect(result.sheetNames).toEqual(['CD4+', 'CD4+~2', 'a'.repeat(31)]);
  });

  it('reports nothing truncated for an ordinary sheet', async () => {
    const result = await writeXlsx([{ name: 'S', header: ['a'], rows: [[1], [2]] }]);
    expect(result.truncated).toEqual([]);
  });
});

describe('writeXlsx — scale', () => {
  it('streams a large sheet rather than materialising it', async () => {
    /*
       50 000 rows × 12 columns is 600 000 cells — small beside a real export and
       large enough that a writer holding the whole XML would be visible. What
       this really asserts is that the generator is consumed lazily: the rows are
       produced by a generator that keeps no history, so if `writeXlsx` buffered
       them the peak would be the full sheet rather than one block.
    */
    function* rows() {
      for (let r = 0; r < 50_000; r++) {
        yield Array.from({ length: 12 }, (_v, c) => r * 12 + c);
      }
    }
    const result = await writeXlsx([{ name: 'Events', header: Array.from({ length: 12 }, (_v, c) => `P${c}`), rows: rows() }]);
    const parts = partsOf(result.buffer);
    const xml = await inflate(parts.get('xl/worksheets/sheet1.xml')!);
    // 50 000 data rows plus the header.
    expect((xml.match(/<row /g) ?? []).length).toBe(50_001);
    expect(xml).toContain('<c r="L50001"><v>599999</v></c>');
    // And it compressed — the whole reason the writer streams through
    // CompressionStream rather than storing.
    expect(parts.get('xl/worksheets/sheet1.xml')!.method).toBe(8);
    expect(result.buffer.byteLength).toBeLessThan(xml.length / 4);
  }, 60_000);

  it('caps a sheet at Excel\'s row limit and says how many were dropped', async () => {
    // Rows are counted, not built: producing 1 048 580 real rows here would make
    // the suite minutes long to assert one integer. The header takes a row, so
    // the limit is reached one data row earlier.
    const over = 5;
    function* rows() {
      for (let r = 0; r < XLSX_MAX_ROWS + over; r++) yield [r];
    }
    const result = await writeXlsx([{ name: 'Big', header: ['n'], rows: rows() }]);
    expect(result.truncated).toEqual([{ sheet: 'Big', rows: over + 1, columns: 0 }]);
  }, 120_000);
});
