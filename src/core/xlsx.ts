/* ==========================================================================
   XLSX writer.

   An .xlsx is a ZIP of XML parts, and this writes both by hand. There is no
   spreadsheet library in this project and adding one for the two things the app
   needs — a statistics table, and a workbook of event tables — would be a
   megabyte of dependency for a format whose minimum viable form is five small
   files. The same argument produced the FCS parser, the FCS writer and the ICO
   packer in `scripts/make-icon.mjs`; this is the fourth.

   Three decisions are load-bearing:

   1. **Rows are consumed as an `Iterable`, never as an array.** A full gate
      export can be 170 000 events across 71 columns in one sheet. As cell XML
      that is roughly 350 MB, and materialising it — as an array of row strings,
      or worse as one joined string — is a renderer-crashing allocation for a
      file that compresses to a few tens of megabytes. Rows are generated, run
      through the deflate stream in blocks, and dropped.

   2. **DEFLATE comes from `CompressionStream('deflate-raw')`**, which is the
      browser's own zlib and is exactly the algorithm a ZIP entry wants. There is
      a stored (uncompressed) fallback, and it is a genuine fallback rather than
      a courtesy: a stored .xlsx is a valid .xlsx, it is just twenty times
      larger.

   3. **Strings are inline (`t="inlineStr"`), not shared.** A shared-string table
      has to be complete before any sheet referencing it can be written, which
      means holding every distinct string in memory and making two passes — the
      opposite of (1). Inline strings cost bytes in the XML and compress away to
      nearly nothing. Excel, LibreOffice, pandas (`openpyxl`) and R (`readxl`)
      all read them.

   What this deliberately does not do: formulas, merged cells, number formats,
   charts, or anything with a `styles.xml` beyond one bold font for the header
   row. It writes a table of numbers and strings, which is what an export is.
   ========================================================================== */

/** A single cell. `null`/`undefined`/non-finite numbers are written as empty. */
export type CellValue = string | number | null | undefined;

export interface SheetSpec {
  /**
   * Tab name. Sanitised and de-duplicated by `sheetName` — Excel refuses
   * `[]:*?/\`, refuses empty, refuses over 31 characters, and refuses two tabs
   * with the same name, and it refuses the *file* rather than the sheet.
   */
  name: string;
  /** Written first, in bold, and frozen so it stays put while scrolling. */
  header?: CellValue[];
  /**
   * The data rows.
   *
   * An `Iterable` rather than an array so a large sheet is generated as it is
   * compressed — see the header note. A generator function is the usual caller.
   */
  rows: Iterable<CellValue[]>;
}

/** Excel's own limits. A file that exceeds either is refused by Excel, not truncated. */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;

/* -------------------------------------------------------------------------
   XML
   ------------------------------------------------------------------------- */

/**
 * Escape text for an XML text node or attribute.
 *
 * The control-character strip is not decoration: XML 1.0 has no way to
 * represent U+0000–U+0008 and friends, not even as a character reference, so a
 * stray one in a sample name produces a file Excel reports as corrupt. Sample
 * names come from filenames and filenames come from instrument software.
 */
export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → `A`, 25 → `Z`, 26 → `AA`. Spreadsheet column letters are bijective base-26. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * A tab name Excel will accept, made unique against the ones already used.
 *
 * `taken` is mutated, which is what makes the de-duplication work across a whole
 * workbook: two populations called `CD4+` under different parents both arrive
 * here as `CD4+`, and the second has to become something else or the file will
 * not open at all.
 */
export function sheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim();
  if (!base) base = 'Sheet';
  if (base.length > 31) base = base.slice(0, 31);

  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    const suffix = `~${n++}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

/** One `<c>` element. Numbers go out bare; everything else is an inline string. */
function cellXml(ref: string, value: CellValue, style: number): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') {
    // A NaN median or an infinite ratio is *absence of a measurement*, and an
    // empty cell is how a spreadsheet says that. Writing the text "NaN" would
    // turn the column into text and break every formula below it.
    if (!Number.isFinite(value)) return '';
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  // `xml:space="preserve"` so a name with leading or trailing spaces survives.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

const SHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

/** Header row frozen in place. Without this a 170 000-row sheet loses its headings on the first scroll. */
const FREEZE_HEADER =
  '<sheetViews><sheetView workbookViewId="0">'
  + '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
  + '</sheetView></sheetViews>';

/**
 * The sheet XML, in blocks.
 *
 * A generator rather than a string: this is the part that would be hundreds of
 * megabytes for a real export. `BLOCK_ROWS` rows are joined at a time, which
 * keeps the per-yield string in the tens of kilobytes — small enough that the
 * allocator never sees a large object, large enough that the deflate stream is
 * not being woken up per row.
 *
 * Rows past `XLSX_MAX_ROWS` are dropped rather than written. Excel refuses the
 * whole file over the limit, so writing them would lose everything rather than
 * the tail; the caller is told how many were dropped so it can say so.
 */
function* sheetXml(sheet: SheetSpec, dropped: { rows: number; columns: number }): Generator<string> {
  const BLOCK_ROWS = 256;
  yield SHEET_HEAD + (sheet.header ? FREEZE_HEADER : '') + '<sheetData>';

  let r = 0;
  const row = (values: CellValue[], style: number): string => {
    r++;
    const n = Math.min(values.length, XLSX_MAX_COLUMNS);
    if (values.length > n) dropped.columns = Math.max(dropped.columns, values.length - n);
    let out = `<row r="${r}">`;
    for (let c = 0; c < n; c++) out += cellXml(`${columnLetter(c)}${r}`, values[c], style);
    return `${out}</row>`;
  };

  if (sheet.header) yield row(sheet.header, 1);

  let block: string[] = [];
  for (const values of sheet.rows) {
    if (r >= XLSX_MAX_ROWS) { dropped.rows++; continue; }
    block.push(row(values, 0));
    if (block.length >= BLOCK_ROWS) { yield block.join(''); block = []; }
  }
  if (block.length) yield block.join('');

  yield '</sheetData></worksheet>';
}

/* -------------------------------------------------------------------------
   ZIP
   ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32, resumable across chunks — pass the previous return value back in. */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (~c) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  /** Length before compression — the ZIP header carries both. */
  size: number;
  /** 8 = deflate, 0 = stored. */
  method: number;
}

const utf8 = new TextEncoder();

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Compress a stream of chunks into one ZIP entry, computing its CRC on the way
 * past.
 *
 * The CRC is over the *uncompressed* bytes and the chunks are only seen once,
 * so it has to be accumulated here rather than computed afterwards from data
 * nothing kept.
 *
 * `CompressionStream` has been in Chromium since 103 and this app ships its own
 * Chromium, so the fallback is for the browser build and for a future runtime
 * that removes it. A stored entry is a valid entry.
 */
async function deflateEntry(name: string, chunks: Iterable<string | Uint8Array>): Promise<ZipEntry> {
  const bytes = function* (): Generator<Uint8Array> {
    for (const c of chunks) yield typeof c === 'string' ? utf8.encode(c) : c;
  };

  let crc = 0;
  let size = 0;

  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (!Compression) {
    const raw: Uint8Array[] = [];
    for (const chunk of bytes()) { raw.push(chunk); crc = crc32(chunk, crc); size += chunk.length; }
    return { name, data: concat(raw, size), crc, size, method: 0 };
  }

  const cs = new Compression('deflate-raw');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  const out: Uint8Array[] = [];
  let compressed = 0;
  // Drain concurrently with writing: the stream has a bounded internal queue, so
  // a writer that never reads deadlocks on a large sheet rather than on a small
  // one, which is the worst possible way to find this out.
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
      compressed += value.length;
    }
  })();

  for (const chunk of bytes()) {
    crc = crc32(chunk, crc);
    size += chunk.length;
    // `BufferSource` is declared over `ArrayBuffer` specifically, while a
    // `Uint8Array` is generic over `ArrayBufferLike` — so a plain array is not
    // assignable even though the shared-array case it is guarding against cannot
    // arise here, since every chunk comes from `TextEncoder` or from `concat`.
    await writer.write(chunk as unknown as BufferSource);
  }
  await writer.close();
  await pump;

  return { name, data: concat(out, compressed), crc, size, method: 8 };
}

/** A part small enough to build as one string — everything except a sheet. */
const part = (name: string, xml: string) => deflateEntry(name, [xml]);

/**
 * Assemble ZIP entries into an archive.
 *
 * Local headers, then the central directory, then the end-of-central-directory
 * record. No data descriptors: every entry's size and CRC are known before it is
 * written, because `deflateEntry` has already finished with it.
 *
 * No ZIP64. The limit that reaches is a 4 GB archive, which is well past the
 * point where Excel refuses the file for having too many rows.
 */
function zip(entries: ZipEntry[]): ArrayBuffer {
  const names = entries.map((e) => utf8.encode(e.name));
  const localSize = entries.reduce((a, e, i) => a + 30 + names[i]!.length + e.data.length, 0);
  const centralSize = entries.reduce((a, _e, i) => a + 46 + names[i]!.length, 0);

  const buf = new ArrayBuffer(localSize + centralSize + 22);
  const view = new DataView(buf);
  const out = new Uint8Array(buf);
  let at = 0;

  const offsets: number[] = [];
  entries.forEach((e, i) => {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);        // local file header
    view.setUint16(at + 4, 20, true);            // version needed
    view.setUint16(at + 6, 0x0800, true);        // flags: UTF-8 names
    view.setUint16(at + 8, e.method, true);
    // A fixed DOS timestamp — 1980-01-01. A real one would make two runs over
    // the same data produce different bytes, which is the property that lets a
    // test assert an export has not changed.
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 33, true);
    view.setUint32(at + 14, e.crc, true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.size, true);
    view.setUint16(at + 26, names[i]!.length, true);
    view.setUint16(at + 28, 0, true);            // extra field length
    at += 30;
    out.set(names[i]!, at); at += names[i]!.length;
    out.set(e.data, at); at += e.data.length;
  });

  const centralStart = at;
  entries.forEach((e, i) => {
    view.setUint32(at, 0x02014b50, true);        // central directory header
    view.setUint16(at + 4, 20, true);            // version made by
    view.setUint16(at + 6, 20, true);            // version needed
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, e.method, true);
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, 33, true);
    view.setUint32(at + 16, e.crc, true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.size, true);
    view.setUint16(at + 28, names[i]!.length, true);
    view.setUint16(at + 30, 0, true);            // extra
    view.setUint16(at + 32, 0, true);            // comment
    view.setUint16(at + 34, 0, true);            // disk
    view.setUint16(at + 36, 0, true);            // internal attrs
    view.setUint32(at + 38, 0, true);            // external attrs
    view.setUint32(at + 42, offsets[i]!, true);
    at += 46;
    out.set(names[i]!, at); at += names[i]!.length;
  });

  view.setUint32(at, 0x06054b50, true);          // end of central directory
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, centralSize, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true);              // comment length

  return buf;
}

/* -------------------------------------------------------------------------
   The workbook
   ------------------------------------------------------------------------- */

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const XL = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

/**
 * Two fonts and two cell formats: normal, and bold for the header row.
 *
 * The empty `fills`, `borders` and `cellStyleXfs` blocks are not optional
 * padding — Excel reads the indices in `cellXfs` against them and reports the
 * file as corrupt if they are missing, even though nothing here uses a fill or a
 * border. `gray125` as fill 1 is the same convention every writer follows for
 * the same reason.
 */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<styleSheet xmlns="${MAIN_NS}">`
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>'
  + '</styleSheet>';

export interface XlsxResult {
  buffer: ArrayBuffer;
  /** The tab names actually written, after sanitising and de-duplication. */
  sheetNames: string[];
  /** Rows dropped for exceeding Excel's own limit, per sheet name. Usually empty. */
  truncated: Array<{ sheet: string; rows: number; columns: number }>;
}

/**
 * Build a workbook.
 *
 * Async because the compression is: `CompressionStream` is a real stream and
 * this feeds a sheet through it as the sheet is generated, which is what keeps a
 * 170 000-row export inside a sensible amount of memory.
 *
 * Refuses zero sheets rather than writing an empty workbook — Excel will not
 * open one, so producing it would only move the error somewhere less useful.
 */
export async function writeXlsx(sheets: SheetSpec[]): Promise<XlsxResult> {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.');

  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const truncated: XlsxResult['truncated'] = [];

  const entries: ZipEntry[] = [];

  entries.push(await part('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + `<Override PartName="/xl/workbook.xml" ContentType="${XL}.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="${XL}.styles+xml"/>`
    + named.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${XL}.worksheet+xml"/>`).join('')
    + '</Types>'));

  entries.push(await part('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships xmlns="${RELS_NS}">`
    + `<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/>`
    + '</Relationships>'));

  entries.push(await part('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS}"><sheets>`
    + named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    + '</sheets></workbook>'));

  entries.push(await part('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships xmlns="${RELS_NS}">`
    + named.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${named.length + 1}" Type="${DOC_RELS}/styles" Target="styles.xml"/>`
    + '</Relationships>'));

  entries.push(await part('xl/styles.xml', STYLES_XML));

  for (let i = 0; i < named.length; i++) {
    const dropped = { rows: 0, columns: 0 };
    entries.push(await deflateEntry(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(named[i]!, dropped)));
    if (dropped.rows || dropped.columns) {
      truncated.push({ sheet: named[i]!.name, rows: dropped.rows, columns: dropped.columns });
    }
  }

  return { buffer: zip(entries), sheetNames: named.map((s) => s.name), truncated };
}
