/**
 * How wide a line of figure type is — the one measurement a layout needs.
 *
 * A composer decides how much margin a y axis takes from the widest tick label
 * on it, and where a legend wraps from the width of its entries. In the
 * application the answer comes from a 2D canvas set in the figure's own face,
 * which is the face the PNG rasteriser and the PDF printer will draw it in. In a
 * unit test there is no canvas, and the Helvetica metrics below stand in — Arial
 * is metric-compatible with Helvetica by design, so for the default face the
 * estimate is the real advance, and for the others it is within a few percent,
 * which is a margin a pixel or two wider than it needs to be.
 */
import { fontStack, type FontFamily } from './style';

/** Helvetica advance widths, per 1000 units of the em, for printable ASCII. */
const ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // ' ' to '/'
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0–9
  278, 278, 584, 584, 584, 556, 1015, // : to @
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A–Z
  278, 278, 278, 469, 556, 333, // [ to `
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a–z
  334, 260, 334, 584, // { to ~
];

/** The few non-ASCII characters figures print, at their Helvetica widths. */
const EXTRA_WIDTHS: Record<string, number> = {
  '−': 584, // minus
  '·': 278, // middle dot
  '–': 556, // en dash
  '—': 1000, // em dash
  'µ': 556, 'μ': 556, // micro, mu
  'σ': 556, // sigma
  '²': 333, '³': 333, // squared, cubed
  '×': 584, // multiplication
  '±': 584, // plus-minus
  '≥': 549, '≤': 549,
};

function estimate(text: string, sizePx: number): number {
  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? ASCII_WIDTHS[code - 32]! : EXTRA_WIDTHS[ch] ?? 556;
  }
  return (units / 1000) * sizePx;
}

let ctx: CanvasRenderingContext2D | null | undefined;

/** Advance width of `text` at `sizePx` in `family`, in user units. */
export function measureText(text: string, sizePx: number, family: FontFamily, bold = false): number {
  if (ctx === undefined) {
    ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!ctx) return estimate(text, sizePx) * (bold ? 1.06 : 1);
  ctx.font = `${bold ? 'bold ' : ''}${sizePx}px ${fontStack(family)}`;
  return ctx.measureText(text).width;
}

/** Arial's cap height and descender, as fractions of the em — for placing baselines. */
export const CAP_HEIGHT = 0.716;
export const DESCENDER = 0.212;
