/**
 * A printed PDF's page box, made exactly the figure's size.
 *
 * ## Why (2026-10-22)
 *
 * Chromium's printer does not make the page the size it is asked for. It snaps
 * both sides onto its own device grid, and not to the nearest point: an 89 mm
 * figure, 252.28 pt wide, came back on a 252.96 pt page — 89.24 mm — and every
 * other size overshot by 0.4 to 1.1 pt the same way, on-grid requests included.
 * The drawing is right, anchored at the page's top-left; the page is a strip too
 * wide and too tall, which is the wrong size for anybody aligning figures by
 * their page box in Inkscape or Illustrator.
 *
 * So the page box is rewritten afterwards to the figure's own extent:
 * `[0, H − h, w, H]` keeps the top-left where the drawing is and trims the strip
 * at the right and bottom. The new box is usually longer than the printer's —
 * it wrote `[0 0 519.12 516]` for one — so every cross-reference offset after
 * it, and `startxref`, move by the difference; a file with a cross-reference
 * *stream* rather than a table is left as it is. If the printer ever returns a
 * page *smaller* than asked, nothing changes: cropping further could only hide
 * part of the figure.
 *
 * No imports: the main process bundles this directly.
 */

const BOX = /\/(MediaBox|CropBox)\s*\[\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\]/g;

const num = (v: number) => String(Math.round(v * 10000) / 10000);

function toText(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The PDF with its page box trimmed to `widthPt` × `heightPt` from the top-left. */
export function exactPageBox(pdf: Uint8Array, widthPt: number, heightPt: number): Uint8Array {
  const text = toText(pdf);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!sx) return pdf;
  const xrefAt = Number(sx[1]);
  if (text.slice(xrefAt, xrefAt + 4) !== 'xref') return pdf;

  const edits: Array<{ at: number; from: string; to: string }> = [];
  for (const m of text.matchAll(BOX)) {
    const at = m.index!;
    if (at >= xrefAt) continue;
    const pageW = Number(m[2]);
    const pageH = Number(m[3]);
    if (!(pageW >= widthPt - 1e-6) || !(pageH >= heightPt - 1e-6)) continue;
    edits.push({ at, from: m[0], to: `/${m[1]} [0 ${num(pageH - heightPt)} ${num(widthPt)} ${num(pageH)}]` });
  }
  if (edits.length === 0) return pdf;

  /** How far an offset in the original moves once the edits before it are made. */
  const shift = (offset: number) => edits.reduce((d, e) => (e.at < offset ? d + e.to.length - e.from.length : d), 0);

  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.at) + e.to;
    last = e.at + e.from.length;
  }
  const trailerAt = text.indexOf('trailer', xrefAt);
  if (trailerAt < 0) return pdf;
  out += text.slice(last, xrefAt);
  out += text.slice(xrefAt, trailerAt).replace(/^(\d{10}) (\d{5}) n/gm,
    (_, off: string, gen: string) => `${String(Number(off) + shift(Number(off))).padStart(10, '0')} ${gen} n`);
  out += text.slice(trailerAt).replace(/startxref(\s+)(\d+)/, (_, ws: string, n: string) => `startxref${ws}${Number(n) + shift(Number(n))}`);
  return toBytes(out);
}
