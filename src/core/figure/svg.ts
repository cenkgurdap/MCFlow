/**
 * Writing SVG as text — the one representation every figure is composed in.
 *
 * ## Why strings, and why not the live DOM (2026-10-22)
 *
 * The exporter used to clone the panel's live SVG and copy every computed style
 * onto the clone, so a figure was whatever the screen happened to be: its
 * pixel size, its theme's colours, its fonts — a Segoe UI and Arial mix, since
 * the print window holds neither of the application's faces — and its
 * interaction chrome, down to transparent hit rectangles. A composer here
 * writes the document directly, in user units at 96 to the inch, with every
 * size and colour stated as a literal from the `FigureStyle`. Nothing in a file
 * refers to a stylesheet, a custom property or a theme, so the file is the same
 * on every machine and in every viewer, and it is small.
 *
 * Pure: no DOM. The composers are tested in node.
 */
import { splitDecadeLabel } from '@/core/transform/ticks';
import { pxToMm } from './style';

export type AttrValue = string | number | null | undefined | false;

/** A number as an attribute: three decimals, no trailing zeros, never `-0`. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) || r === 0 ? '0' : String(r);
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe for an attribute or an element body. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}

/** One element. Attributes that are `null`, `undefined` or `false` are left out. */
export function el(tag: string, attrs: Record<string, AttrValue>, ...children: string[]): string {
  let a = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    a += ` ${k}="${typeof v === 'number' ? fmt(v) : esc(v)}"`;
  }
  return children.length > 0 ? `<${tag}${a}>${children.join('')}</${tag}>` : `<${tag}${a}/>`;
}

/** A polyline or polygon's `d`, from points in user units. */
export function pathD(points: ReadonlyArray<readonly [number, number]>, close = false): string {
  if (points.length === 0) return '';
  let d = `M${fmt(points[0]![0])},${fmt(points[0]![1])}`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i]![0])},${fmt(points[i]![1])}`;
  return close ? `${d}Z` : d;
}

/**
 * A minus sign where a hyphen stands for one. Typesetting a negative number
 * with a hyphen is the one mistake in a figure that every copy editor marks.
 */
export function minusSigns(text: string): string {
  return text.replace(/(^|[\s(=<>])-(?=[\d.])/g, '$1−');
}

/**
 * The body of a tick label, with a decade's exponent as a raised tspan at a
 * size chosen here rather than as a Unicode superscript — which is 58% of the
 * digit height and hairline-thin, and is the only part of `10⁴` that tells it
 * apart from `10⁵`.
 */
export function tickLabelBody(label: string, sizePx: number): string {
  const { base, exponent } = splitDecadeLabel(label);
  const b = esc(minusSigns(base));
  if (!exponent) return b;
  return `${b}<tspan font-size="${fmt(sizePx * 0.72)}" dy="${fmt(-sizePx * 0.38)}">${esc(minusSigns(exponent))}</tspan>`;
}

/** What a composer hands back: the document, its size, and the notes that travel with it. */
export interface ComposedFigure {
  svg: string;
  /** In user units, 96 to the inch. */
  width: number;
  height: number;
  /** The caption-ready notes — what the figure shows and how it was made. */
  notes: string;
}

/**
 * A complete standalone document.
 *
 * `width` and `height` are written in millimetres and the `viewBox` in user
 * units, so a viewer — Inkscape, Illustrator, a browser, the PDF printer — opens
 * it at its printed size with every coordinate inside it unchanged. The notes
 * go into `<title>` and `<desc>`, so a file that has lost its sidecar still
 * carries them.
 */
export function svgDocument({
  width, height, body, fontFamily, background, title, notes,
}: {
  width: number;
  height: number;
  body: string;
  fontFamily: string;
  background: string | null;
  title: string;
  notes: string;
}): string {
  const bg = background
    ? el('rect', { x: 0, y: 0, width, height, fill: background, 'data-fig-layer': 'background' })
    : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
    + el('svg', {
      xmlns: 'http://www.w3.org/2000/svg',
      'xmlns:xlink': 'http://www.w3.org/1999/xlink',
      width: `${fmt(pxToMm(width))}mm`,
      height: `${fmt(pxToMm(height))}mm`,
      viewBox: `0 0 ${fmt(width)} ${fmt(height)}`,
      'font-family': fontFamily,
    },
    el('title', {}, esc(title)),
    el('desc', {}, esc(notes)),
    bg,
    body);
}
