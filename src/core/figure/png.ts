/**
 * A PNG that says how big it is and what it shows.
 *
 * A canvas encodes a PNG with no physical resolution, so a page-layout tool
 * opened a 300 dpi figure as a 72 dpi one four times too large, and the notes
 * had nowhere to go. This inserts a `pHYs` chunk — the resolution, in pixels per
 * metre as the format states it — and `iTXt` chunks for the title, the notes and
 * the software, UTF-8 so μ, σ and ² survive. Pure byte surgery on the encoded
 * file; the pixels are untouched.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | null = null;

/** CRC-32 as PNG defines it (ISO 3309), over `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** An international text chunk: keyword, uncompressed, no language tag. */
function itxt(keyword: string, text: string): Uint8Array {
  const k = utf8(keyword.slice(0, 79));
  const t = utf8(text);
  const data = new Uint8Array(k.length + 5 + t.length);
  data.set(k, 0);
  // keyword NUL, compression flag 0, method 0, empty language tag NUL, empty translated keyword NUL
  data.set(t, k.length + 5);
  return chunk('iTXt', data);
}

export interface PngMetadata {
  dpi: number;
  /** Keyword → text, e.g. `Title`, `Description`, `Software`. */
  text: Record<string, string>;
}

/** The same PNG, with its resolution and text chunks after the header. */
export function withPngMetadata(png: Uint8Array, meta: PngMetadata): Uint8Array {
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIGNATURE[i]) throw new Error('Not a PNG file.');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Walk the chunks, keeping all but any resolution or text chunk this
  // replaces, and noting where the header ends.
  const kept: Uint8Array[] = [];
  let at = 8;
  let headerEnd = -1;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (type !== 'pHYs' && !(type === 'iTXt' || type === 'tEXt') ) kept.push(png.subarray(at, end));
    if (type === 'IHDR') headerEnd = kept.length;
    at = end;
  }
  if (headerEnd < 0) throw new Error('PNG has no header chunk.');

  const ppm = Math.round(meta.dpi / 0.0254);
  const phys = new Uint8Array(9);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, ppm);
  pv.setUint32(4, ppm);
  phys[8] = 1; // unit: metre
  const added = [chunk('pHYs', phys), ...Object.entries(meta.text).map(([k, v]) => itxt(k, v))];

  const parts = [Uint8Array.from(SIGNATURE), ...kept.slice(0, headerEnd), ...added, ...kept.slice(headerEnd)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The resolution a PNG declares, in dots per inch, or null when it declares none. */
export function pngDpi(png: Uint8Array): number | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'pHYs' && png[at + 16] === 1) return view.getUint32(at + 8) * 0.0254;
    at += 12 + length;
  }
  return null;
}
