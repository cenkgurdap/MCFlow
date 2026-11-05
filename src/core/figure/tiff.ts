/**
 * A baseline TIFF, for the journals that ask for one.
 *
 * ## What is written (2026-10-22)
 *
 * 8-bit RGB, or RGBA with unassociated alpha when the figure is transparent,
 * LZW-compressed with the horizontal-differencing predictor — the combination
 * every journal's checker and every image editor reads. The resolution is
 * stated in dots per inch (`XResolution`, `YResolution`, `ResolutionUnit`), so a
 * 600 dpi figure opens at its printed size, and the notes go into
 * `ImageDescription`, which TIFF restricts to ASCII.
 *
 * ## The LZW variant
 *
 * TIFF's LZW is not GIF's. Codes are packed most-significant bit first, a code
 * table starts with 256 literals, Clear (256) and End-of-information (257), and
 * the code width grows **one code early**: the encoder widens as soon as the
 * next free entry would not fit, and after the last code it does the same
 * arithmetic the decoder is about to, so End-of-information is written at the
 * width the decoder will read it at. This follows libtiff's `LZWEncode` and
 * `LZWPostEncode` step for step, because libtiff is what reads these files; the
 * round trip is checked by a decoder written the same way in the test.
 *
 * Pure.
 */

const CLEAR = 256;
const EOI = 257;
const FIRST = 258;
const BITS_MIN = 9;
const BITS_MAX = 12;
const CODE_MAX = (1 << BITS_MAX) - 1;

/** LZW-compress one strip, as libtiff does. */
export function lzwEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  let nbits = BITS_MIN;
  let maxcode = (1 << nbits) - 1;
  let free = FIRST;
  // (prefix code << 8 | next byte) → code. A Map keeps it obvious; strips are
  // capped at 64 KB, so the table never grows past its 4094 entries anyway.
  let table = new Map<number, number>();

  const put = (code: number) => {
    buffer = (buffer << nbits) | code;
    bits += nbits;
    while (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  };

  put(CLEAR);
  if (input.length === 0) { put(EOI); if (bits > 0) out.push((buffer << (8 - bits)) & 0xff); return Uint8Array.from(out); }

  let ent = input[0]!;
  for (let i = 1; i < input.length; i++) {
    const c = input[i]!;
    const key = (ent << 8) | c;
    const hit = table.get(key);
    if (hit !== undefined) { ent = hit; continue; }
    put(ent);
    ent = c;
    table.set(key, free++);
    if (free === CODE_MAX - 1) {
      // The table is full: say so, and start again from the literals.
      put(CLEAR);
      table = new Map();
      free = FIRST;
      nbits = BITS_MIN;
      maxcode = (1 << nbits) - 1;
    } else if (free > maxcode) {
      nbits++;
      maxcode = (1 << nbits) - 1;
    }
  }

  // The last code, then the width arithmetic the decoder is about to do.
  put(ent);
  free++;
  if (free === CODE_MAX - 1) {
    put(CLEAR);
    nbits = BITS_MIN;
  } else if (free > maxcode) {
    nbits++;
  }
  put(EOI);
  if (bits > 0) out.push((buffer << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

export interface TiffImage {
  width: number;
  height: number;
  /** Row-major RGBA, 8 bits per sample, as a canvas gives it. */
  rgba: Uint8Array | Uint8ClampedArray;
  dpi: number;
  /** Keep the alpha channel — a transparent figure. Otherwise composited onto white. */
  alpha: boolean;
  /** ASCII only — see `asciiNotes`. */
  description?: string;
  software?: string;
}

/** Encode an image as a little-endian baseline TIFF. */
export function encodeTiff(img: TiffImage): Uint8Array {
  const { width, height } = img;
  const spp = img.alpha ? 4 : 3;
  const rowBytes = width * spp;

  // Pixels in the stored channel layout, opaque ones composited onto white.
  const pixels = new Uint8Array(rowBytes * height);
  for (let p = 0, q = 0; p < width * height; p++) {
    const r = img.rgba[p * 4]!;
    const g = img.rgba[p * 4 + 1]!;
    const b = img.rgba[p * 4 + 2]!;
    const a = img.rgba[p * 4 + 3]!;
    if (img.alpha) {
      pixels[q++] = r; pixels[q++] = g; pixels[q++] = b; pixels[q++] = a;
    } else {
      const k = a / 255;
      pixels[q++] = Math.round(r * k + 255 * (1 - k));
      pixels[q++] = Math.round(g * k + 255 * (1 - k));
      pixels[q++] = Math.round(b * k + 255 * (1 - k));
    }
  }

  // Strips of at most 64 KB uncompressed, each differenced along its rows and
  // then compressed on its own.
  const rowsPerStrip = Math.max(1, Math.floor(65536 / Math.max(1, rowBytes)));
  const strips: Uint8Array[] = [];
  for (let y0 = 0; y0 < height; y0 += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - y0);
    const strip = pixels.slice(y0 * rowBytes, (y0 + rows) * rowBytes);
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      for (let i = rowBytes - 1; i >= spp; i--) strip[base + i] = (strip[base + i]! - strip[base + i - spp]!) & 0xff;
    }
    strips.push(lzwEncode(strip));
  }

  const description = (img.description ?? '').replace(/[^\x20-\x7e\n\r\t]/g, '?');
  const software = (img.software ?? 'MCFlow').replace(/[^\x20-\x7e]/g, '?');
  const ascii = (s: string) => { const b = new Uint8Array(s.length + 1); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };

  // Layout: header, strip data, then the IFD and the values too big for it.
  const stripsLength = strips.reduce((n, s) => n + s.length, 0);
  type Entry = { tag: number; type: 3 | 4 | 5 | 2; count: number; value?: number; data?: Uint8Array };
  const entries: Entry[] = [];
  const short = (tag: number, value: number) => entries.push({ tag, type: 3, count: 1, value });
  const long = (tag: number, value: number) => entries.push({ tag, type: 4, count: 1, value });
  const rational = (tag: number, num: number, den: number) => {
    const d = new Uint8Array(8);
    const v = new DataView(d.buffer);
    v.setUint32(0, num, true);
    v.setUint32(4, den, true);
    entries.push({ tag, type: 5, count: 1, data: d });
  };
  const longs = (tag: number, values: number[]) => {
    if (values.length === 1) { long(tag, values[0]!); return; }
    const d = new Uint8Array(values.length * 4);
    const v = new DataView(d.buffer);
    values.forEach((x, i) => v.setUint32(i * 4, x, true));
    entries.push({ tag, type: 4, count: values.length, data: d });
  };
  const shorts = (tag: number, values: number[]) => {
    const d = new Uint8Array(values.length * 2);
    const v = new DataView(d.buffer);
    values.forEach((x, i) => v.setUint16(i * 2, x, true));
    if (values.length <= 2) {
      entries.push({ tag, type: 3, count: values.length, value: values.length === 1 ? values[0]! : (values[0]! | (values[1]! << 16)) });
    } else entries.push({ tag, type: 3, count: values.length, data: d });
  };
  const text = (tag: number, s: string) => { const d = ascii(s); entries.push({ tag, type: 2, count: d.length, data: d.length <= 4 ? undefined : d, value: d.length <= 4 ? new DataView(Uint8Array.from([...d, 0, 0, 0, 0].slice(0, 4)).buffer).getUint32(0, true) : undefined }); };

  let offset = 8;
  const stripOffsets = strips.map((s) => { const at = offset; offset += s.length; return at; });

  long(256, width);
  long(257, height);
  shorts(258, new Array(spp).fill(8));
  short(259, 5); // LZW
  short(262, 2); // RGB
  if (description) text(270, description);
  longs(273, stripOffsets);
  short(277, spp);
  long(278, rowsPerStrip);
  longs(279, strips.map((s) => s.length));
  rational(282, Math.round(img.dpi * 1000), 1000);
  rational(283, Math.round(img.dpi * 1000), 1000);
  short(284, 1); // chunky
  short(296, 2); // inch
  text(305, software);
  short(317, 2); // horizontal differencing
  if (img.alpha) short(338, 2); // unassociated alpha
  entries.sort((a, b) => a.tag - b.tag);

  const ifdOffset = 8 + stripsLength + ((8 + stripsLength) % 2);
  const ifdSize = 2 + entries.length * 12 + 4;
  let dataOffset = ifdOffset + ifdSize;
  const blocks: Array<{ at: number; data: Uint8Array }> = [];
  for (const e of entries) {
    if (!e.data) continue;
    if (dataOffset % 2) dataOffset++;
    blocks.push({ at: dataOffset, data: e.data });
    e.value = dataOffset;
    dataOffset += e.data.length;
  }

  const out = new Uint8Array(dataOffset);
  const v = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; // II — little-endian
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdOffset, true);
  let o = 8;
  for (const s of strips) { out.set(s, o); o += s.length; }
  v.setUint16(ifdOffset, entries.length, true);
  entries.forEach((e, i) => {
    const at = ifdOffset + 2 + i * 12;
    v.setUint16(at, e.tag, true);
    v.setUint16(at + 2, e.type, true);
    v.setUint32(at + 4, e.count, true);
    if (e.type === 3 && e.count === 1 && !e.data) v.setUint16(at + 8, e.value!, true);
    else v.setUint32(at + 8, e.value!, true);
  });
  v.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);
  for (const b of blocks) out.set(b.data, b.at);
  return out;
}
