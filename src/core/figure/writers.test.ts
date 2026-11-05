import { describe, expect, it } from 'vitest';
import { asciiNotes } from './notes';
import { exactPageBox } from './pdfBox';
import { crc32, pngDpi, withPngMetadata } from './png';
import { encodeTiff, lzwEncode } from './tiff';

/* -------------------------------------------------------------------------
   The TIFF writer, read back by a decoder written the way libtiff's is — MSB
   first, Clear and End-of-information, and the code width growing one code
   early — so a round trip is evidence the file opens where it will be read.
   ------------------------------------------------------------------------- */

function lzwDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;
  let nbits = 9;
  const read = (): number => {
    while (bitCount < nbits) {
      bitBuf = (bitBuf << 8) | (pos < data.length ? data[pos++]! : 0);
      bitCount += 8;
    }
    bitCount -= nbits;
    const code = (bitBuf >>> bitCount) & ((1 << nbits) - 1);
    bitBuf &= (1 << bitCount) - 1;
    return code;
  };
  let dict: number[][] = [];
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push([], []); nbits = 9; };
  reset();
  let old: number[] | null = null;
  for (;;) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { reset(); old = null; continue; }
    let entry: number[];
    if (code < dict.length) entry = dict[code]!;
    else if (old && code === dict.length) entry = [...old, old[0]!];
    else throw new Error(`bad code ${code} at ${dict.length}`);
    out.push(...entry);
    if (old) dict.push([...old, entry[0]!]);
    old = entry;
    // libtiff: widen once the next free entry passes (1 << nbits) − 2.
    if (dict.length >= (1 << nbits) - 1 && nbits < 12) nbits++;
  }
  return Uint8Array.from(out);
}

function readTiff(file: Uint8Array) {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(String.fromCharCode(file[0]!, file[1]!)).toBe('II');
  expect(v.getUint16(2, true)).toBe(42);
  const ifd = v.getUint32(4, true);
  const n = v.getUint16(ifd, true);
  const tags = new Map<number, number[]>();
  const strings = new Map<number, string>();
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    const tag = v.getUint16(at, true);
    const type = v.getUint16(at + 2, true);
    const count = v.getUint32(at + 4, true);
    const size = { 2: 1, 3: 2, 4: 4, 5: 8 }[type as 2 | 3 | 4 | 5]!;
    const base = size * count > 4 ? v.getUint32(at + 8, true) : at + 8;
    if (type === 2) {
      strings.set(tag, String.fromCharCode(...file.subarray(base, base + count - 1)));
      continue;
    }
    const values: number[] = [];
    for (let k = 0; k < count; k++) {
      if (type === 3) values.push(v.getUint16(base + k * 2, true));
      else if (type === 4) values.push(v.getUint32(base + k * 4, true));
      else values.push(v.getUint32(base + k * 8, true) / v.getUint32(base + k * 8 + 4, true));
    }
    tags.set(tag, values);
  }
  return { tags, strings };
}

function decodePixels(file: Uint8Array, width: number, height: number, spp: number): Uint8Array {
  const { tags } = readTiff(file);
  const offsets = tags.get(273)!;
  const counts = tags.get(279)!;
  const rowsPerStrip = tags.get(278)![0]!;
  const out = new Uint8Array(width * height * spp);
  offsets.forEach((off, s) => {
    const strip = lzwDecode(file.subarray(off, off + counts[s]!));
    const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
    for (let r = 0; r < rows; r++) {
      const base = r * width * spp;
      for (let i = spp; i < width * spp; i++) strip[base + i] = (strip[base + i]! + strip[base + i - spp]!) & 0xff;
    }
    out.set(strip.subarray(0, rows * width * spp), s * rowsPerStrip * width * spp);
  });
  return out;
}

describe('LZW, as libtiff writes it', () => {
  it('round-trips text that grows the code table past every width', () => {
    let seed = 7;
    const noise = Uint8Array.from({ length: 60000 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 24) & 0x3f; });
    expect(Array.from(lzwDecode(lzwEncode(noise)))).toEqual(Array.from(noise));
  });

  it('round-trips the degenerate inputs', () => {
    for (const s of [new Uint8Array(0), Uint8Array.of(9), new Uint8Array(5000).fill(255)]) {
      expect(Array.from(lzwDecode(lzwEncode(s)))).toEqual(Array.from(s));
    }
  });
});

describe('encodeTiff', () => {
  const width = 211;
  const height = 97;
  const rgba = new Uint8Array(width * height * 4);
  let seed = 3;
  for (let i = 0; i < rgba.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; rgba[i] = seed >>> 24; }
  for (let p = 0; p < width * height; p++) rgba[p * 4 + 3] = p % 3 === 0 ? 0 : 255;

  it('keeps the pixels, alpha included, and states the resolution in inches', () => {
    const file = encodeTiff({ width, height, rgba, dpi: 600, alpha: true, description: 'Figure notes', software: 'MCFlow test' });
    const { tags, strings } = readTiff(file);
    expect(tags.get(256)).toEqual([width]);
    expect(tags.get(257)).toEqual([height]);
    expect(tags.get(259)).toEqual([5]);
    expect(tags.get(277)).toEqual([4]);
    expect(tags.get(338)).toEqual([2]);
    expect(tags.get(282)![0]).toBeCloseTo(600, 6);
    expect(tags.get(296)).toEqual([2]);
    expect(strings.get(270)).toBe('Figure notes');
    expect(Array.from(decodePixels(file, width, height, 4))).toEqual(Array.from(rgba));
  });

  it('composites an opaque figure onto white', () => {
    const file = encodeTiff({ width, height, rgba, dpi: 300, alpha: false });
    const px = decodePixels(file, width, height, 3);
    // A fully transparent source pixel is white; an opaque one is itself.
    expect([px[0], px[1], px[2]]).toEqual([255, 255, 255]);
    expect([px[3], px[4], px[5]]).toEqual([rgba[4], rgba[5], rgba[6]]);
    expect(readTiff(file).tags.get(277)).toEqual([3]);
  });
});

describe('withPngMetadata', () => {
  const minimal = (() => {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const chunk = (type: string, data: number[]) => {
      const body = Uint8Array.from([...type].map((c) => c.charCodeAt(0)).concat(data));
      const len = data.length;
      const crc = crc32(body);
      return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
    };
    return Uint8Array.from([...sig, ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk('IDAT', [1, 2, 3]), ...chunk('IEND', [])]);
  })();

  it('states the resolution after the header, with valid checksums', () => {
    const out = withPngMetadata(minimal, { dpi: 300, text: { Description: 'μ = 0.336, σ = 0.039, R² = 0.998' } });
    expect(pngDpi(out)).toBeCloseTo(300, 0);
    // The chunk after IHDR is pHYs.
    expect(String.fromCharCode(...out.subarray(33 + 4, 33 + 8))).toBe('pHYs');
    // Every chunk's CRC checks out.
    const v = new DataView(out.buffer);
    for (let at = 8; at < out.length;) {
      const len = v.getUint32(at);
      expect(crc32(out.subarray(at + 4, at + 8 + len))).toBe(v.getUint32(at + 8 + len));
      at += 12 + len;
    }
    expect(new TextDecoder().decode(out)).toContain('σ = 0.039');
  });

  it('replaces rather than repeats on a second pass', () => {
    const twice = withPngMetadata(withPngMetadata(minimal, { dpi: 300, text: { A: 'x' } }), { dpi: 600, text: { A: 'y' } });
    expect(pngDpi(twice)).toBeCloseTo(600, 0);
    expect(new TextDecoder().decode(twice).match(/pHYs/g)).toHaveLength(1);
  });
});

describe('asciiNotes', () => {
  it('spells out what TIFF cannot carry instead of dropping it', () => {
    expect(asciiNotes('μ = −0.3, σ = 0.04, R² = 0.99 · n = 3')).toBe('mu = -0.3, sigma = 0.04, R^2 = 0.99 - n = 3');
  });
});

describe('exactPageBox', () => {
  /** A small PDF with a real cross-reference table, so offsets can be checked. */
  function pdf(box: string): Uint8Array {
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
      `<< /Type /Page /Parent 2 0 R ${box} /Contents 4 0 R >>`,
      '<< /Length 0 >>\nstream\n\nendstream',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Uint8Array.from(Buffer.from(body, 'latin1'));
  }

  /** Every xref entry still points at the object it names, and startxref at the table. */
  function consistent(bytes: Uint8Array): boolean {
    const text = Buffer.from(bytes).toString('latin1');
    const start = Number(/startxref\s+(\d+)/.exec(text)![1]);
    if (text.slice(start, start + 4) !== 'xref') return false;
    const entries = [...text.slice(start).matchAll(/^(\d{10}) \d{5} n/gm)].map((m) => Number(m[1]));
    return entries.every((off, i) => text.startsWith(`${i + 1} 0 obj`, off));
  }

  it('trims the page to the figure from its top-left, keeping every offset true', () => {
    const before = pdf('/MediaBox [0 0 519.12 516]');
    expect(consistent(before)).toBe(true);
    const after = exactPageBox(before, 518.7402, 515.52);
    const text = Buffer.from(after).toString('latin1');
    const m = /\/MediaBox \[0 ([\d.]+) ([\d.]+) ([\d.]+)\]/.exec(text)!;
    expect(Number(m[2])).toBeCloseTo(518.7402, 4);
    expect(Number(m[3]) - Number(m[1])).toBeCloseTo(515.52, 4);
    expect(Number(m[3])).toBe(516);
    expect(consistent(after)).toBe(true);
  });

  it('never crops a page that came back smaller than asked', () => {
    const before = pdf('/MediaBox [0 0 252 292.07999]');
    expect(exactPageBox(before, 252.2835, 291.6409)).toBe(before);
  });
});
