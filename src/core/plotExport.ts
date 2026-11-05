/* ==========================================================================
   Publication-quality plot export.

   Everything funnels through one representation: the plot's SVG chrome with the
   rendered event bitmap embedded as an <image>. PNG is that SVG rasterised at a
   scale factor; PDF is that SVG handed to a print pipeline. Keeping a single
   source means the three formats cannot drift apart.

   The hard part is that the app's SVG references CSS custom properties
   (`stroke="var(--plot-axis)"`). Those resolve against the app's stylesheet,
   which an exported file does not have — so every computed style is inlined onto
   the clone before serialising, or the result is a black-on-black rectangle.
   ========================================================================== */

import { PLOT_MARGIN } from './layout/geometry';

export type ImageFormat = 'png' | 'svg' | 'pdf';

/** Presentation properties that carry a plot's appearance. */
const SVG_STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dashoffset',
  'opacity', 'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'shape-rendering',
  'mix-blend-mode', 'visibility',
] as const;

/**
 * Copy resolved styles from a live tree onto a detached clone.
 *
 * Walks both trees in lockstep. `getComputedStyle` on the original returns the
 * value after `var()` substitution, so the clone ends up with literal colours
 * that survive being opened anywhere.
 */
function inlineComputedStyles(original: Element, clone: Element): void {
  const computed = window.getComputedStyle(original);
  for (const prop of SVG_STYLE_PROPS) {
    const value = computed.getPropertyValue(prop);
    // An empty string means the property does not apply to this element.
    if (value) clone.setAttribute(prop, value);
  }
  // `display: none` elements are still in the DOM (collapsed sections, hidden
  // toolbars); drop them rather than exporting invisible geometry.
  if (computed.display === 'none') {
    clone.remove();
    return;
  }

  const oKids = original.children;
  const cKids = clone.children;
  // Iterate backwards: a child removed above shifts the indices of later ones.
  for (let i = Math.min(oKids.length, cKids.length) - 1; i >= 0; i--) {
    inlineComputedStyles(oKids[i]!, cKids[i]!);
  }
}

/**
 * Where the axes are, and what they are called.
 *
 * A panel's tick marks, tick values, grid and axis rules live in its SVG and
 * export with it. Its two **axis titles** do not: on screen each is an HTML
 * control — a parameter picker, laid on its side for y — sitting in the margin
 * the SVG leaves empty for it. So a figure came out of here carrying numbers
 * along both edges with nothing anywhere saying what they measured, and the
 * caption underneath was the only clue.
 *
 * The exporter draws them back into those same margins, from the rectangle the
 * plot occupies. Not a second axis model: the geometry is the plot rect the
 * panel already reports for its event bitmap, and the text is the parameter
 * label the picker was showing.
 */
export interface AxisTitles {
  /** x-axis parameter label, e.g. `FSC-A`. */
  x: string;
  /** y-axis parameter label — `Normalised count` on a histogram, which has none. */
  y: string;
  /** The plot rectangle in SVG user units: where the axes are. */
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/* -------------------------------------------------------------------------
   The caption strip

   The caption used to be drawn at `height - 6`, inside the panel's own bottom
   margin — which is the band the x-axis name occupies, and it had no width
   budget at all: a sample name plus a population plus both parameters is wider
   than a single-column figure, so it ran off both edges and was clipped by the
   viewBox. It now has its own strip **above** the plot, where a figure's title
   goes, and it wraps to fit. `exportCanvasSize` is the single place the strip's
   height is decided, asked by `svgToString` and by the dialog that quotes the
   output size — two answers there means a page a line shorter than its
   drawing.
   ------------------------------------------------------------------------- */

/** Caption type size, in SVG user units. Matches the axis titles. */
export const CAPTION_SIZE = 11;
/** Line box for one caption line. */
export const CAPTION_LINE = 14;
/** Vertical breathing room in the strip, split above and below the lines. */
export const CAPTION_PAD = 6;
/** Side margin the caption keeps clear, so a line never touches the edge. */
const CAPTION_MARGIN = 6;

/** The separator `plotCaption` joins its parts with, and the first place to wrap. */
export const CAPTION_SEP = '  ·  ';

let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Advance width of a line of figure type, in SVG user units.
 *
 * The one measurement in the export path: the caption wrapper asks it where to
 * break, and the UMAP colour key asks it how wide an entry is. Two of them
 * would be two answers about one font.
 *
 * Measured with a 2D context where there is one, which is every real export.
 * Under a unit test there is no DOM, and the estimate below stands in: Inter's
 * average advance over the alphabet a caption is made of is close to half an
 * em, and over-estimating only wraps a line one word early.
 */
export function textWidth(text: string, fontSize: number): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return text.length * fontSize * 0.52;
  measureCtx.font = `${fontSize}px Inter, "Helvetica Neue", Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

/**
 * Break a caption into lines that fit the figure's width.
 *
 * Wrapped at the separators it was joined with first, so a line break falls
 * between "which sample" and "which parameters" rather than through a sample
 * name; only a part too wide on its own falls back to breaking on spaces.
 */
export function captionLines(text: string, width: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const max = Math.max(40, width - CAPTION_MARGIN * 2);
  if (textWidth(trimmed, CAPTION_SIZE) <= max) return [trimmed];

  const lines: string[] = [];
  /** Add `part` to the last line, or start a new one when it will not fit. */
  const place = (part: string, sep: string) => {
    const last = lines[lines.length - 1];
    if (last !== undefined && textWidth(last + sep + part, CAPTION_SIZE) <= max) {
      lines[lines.length - 1] = last + sep + part;
    } else {
      lines.push(part);
    }
  };

  for (const part of trimmed.split(CAPTION_SEP)) {
    if (textWidth(part, CAPTION_SIZE) <= max) {
      place(part, CAPTION_SEP);
      continue;
    }
    // One part wider than the figure — a long sample name. Break it on spaces.
    for (const word of part.split(' ')) place(word, ' ');
  }
  return lines;
}

/**
 * The exported canvas: the plot, plus however many lines its caption needs.
 *
 * Takes the caption text rather than a flag, because the height depends on how
 * many lines it wraps to and there is no second place allowed to work that out.
 */
export function exportCanvasSize(width: number, height: number, caption?: string | null): { width: number; height: number } {
  const lines = caption ? captionLines(caption, width) : [];
  return {
    width,
    height: height + (lines.length ? CAPTION_PAD + lines.length * CAPTION_LINE : 0),
  };
}

/**
 * The caption above an exported plot.
 *
 * `FSC-A (x-axis)` rather than a bare `FSC-A × SSC-A`, because a reader holding
 * the figure on its own has no way to tell which side of the cross is which —
 * and the convention is not universal enough to assume. The axis titles say it
 * too, on the axes themselves; this says it in words for anyone reading the
 * caption alone.
 */
export function plotCaption(p: { sample: string; population?: string | null; x: string; y: string }): string {
  const pairing = [
    p.x ? `${p.x} (x-axis)` : '',
    p.y ? `${p.y} (y-axis)` : '',
  ].filter(Boolean).join(' × ');
  return [p.sample, p.population, pairing].filter(Boolean).join('  ·  ');
}

export interface SvgExportOptions {
  width: number;
  height: number;
  /** Solid background, or transparent when omitted. */
  background?: string | null;
  /**
   * Bitmap layers to composite beneath the chrome, in draw order, each with the
   * rectangle it occupies in SVG user units.
   */
  underlays?: Array<{ dataUrl: string; x: number; y: number; width: number; height: number }>;
  /** Optional caption drawn above the plot, e.g. sample and population names. */
  title?: string | null;
  /** Axis titles to draw in the plot's own margins. See `AxisTitles`. */
  axes?: AxisTitles | null;
  /**
   * Physical size for the width/height attributes, in CSS pixels. The viewBox
   * stays at the logical `width`/`height`, so the content scales to fit.
   *
   * This is how a vector export gets a real page size: the drawing keeps its
   * own coordinate system while the document declares how big it is.
   */
  displayWidth?: number;
  displayHeight?: number;
}

/**
 * Serialise a live SVG element into a standalone document.
 *
 * The result opens correctly in Illustrator, Inkscape and a browser, with the
 * event cloud as an embedded raster and every axis, tick, gate and label as
 * editable vector geometry — which is the point of offering SVG at all.
 */
export function svgToString(source: SVGSVGElement, opts: SvgExportOptions): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  inlineComputedStyles(source, clone);

  /*
     The caption gets its own strip **above** the plot.

     Above, because that is where a figure's title goes and because the band
     below the plot is not free: it is the panel's own bottom margin, holding
     the x tick values and the x-axis name. The caption shared it, collided with
     the name and — having no width budget — ran off both edges of a
     single-column figure.

     The strip is made by extending the viewBox *upwards* rather than by
     translating the drawing down. Every coordinate in the cloned chrome, in the
     axis titles and in the underlay rectangles is then still the panel's own,
     and the caption is the only thing that has to know about negative y.
  */
  const lines = opts.title ? captionLines(opts.title, opts.width) : [];
  const canvas = exportCanvasSize(opts.width, opts.height, opts.title);
  const strip = canvas.height - opts.height;

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(opts.displayWidth ?? canvas.width));
  clone.setAttribute('height', String(opts.displayHeight ?? canvas.height));
  clone.setAttribute('viewBox', `0 ${-strip} ${canvas.width} ${canvas.height}`);

  const NS = 'http://www.w3.org/2000/svg';
  // The colour the app draws its own axis text in, so a title matches the tick
  // values beside it in either theme.
  const labelColor = getComputedStyle(source).getPropertyValue('--plot-label').trim()
    || getComputedStyle(source).color || '#888';

  if (opts.background) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '0');
    // Starts at the top of the caption strip, not at the plot — the strip is
    // part of the figure and a transparent band above a solid one reads as a
    // rendering fault rather than as a choice.
    rect.setAttribute('y', String(-strip));
    rect.setAttribute('width', String(canvas.width));
    rect.setAttribute('height', String(canvas.height));
    rect.setAttribute('fill', opts.background);
    clone.insertBefore(rect, clone.firstChild);
  }

  // Underlays go after the background but before the chrome, so axes and gates
  // stay on top of the events.
  const anchor = opts.background ? clone.firstChild!.nextSibling : clone.firstChild;
  for (const layer of opts.underlays ?? []) {
    const image = document.createElementNS(NS, 'image');
    image.setAttribute('x', String(layer.x));
    image.setAttribute('y', String(layer.y));
    image.setAttribute('width', String(layer.width));
    image.setAttribute('height', String(layer.height));
    // href is the SVG2 spec attribute; xlink:href keeps older consumers happy.
    image.setAttribute('href', layer.dataUrl);
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', layer.dataUrl);
    image.setAttribute('preserveAspectRatio', 'none');
    clone.insertBefore(image, anchor);
  }

  /** A label in the app's own axis type: Inter, tabular figures, plot-label grey. */
  const label = (content: string, size: number = CAPTION_SIZE): SVGTextElement => {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', String(size));
    text.setAttribute('font-family', 'Inter, "Helvetica Neue", Arial, sans-serif');
    text.setAttribute('fill', labelColor);
    text.textContent = content;
    return text;
  };

  /*
     Axis titles, into the margins the on-screen controls occupy.

     The offsets are measured from the plot rectangle rather than from the
     canvas, so a panel of any size puts them in the same place relative to its
     own axes — 26 px below the plot clears the x tick values, and the y title
     rides in the 26 px strip `PLOT_MARGIN.left` reserves for exactly this,
     rotated the way the panel rotates its own.
  */
  if (opts.axes) {
    const a = opts.axes;
    if (a.x) {
      const t = label(a.x);
      t.setAttribute('x', String(a.x0 + a.width / 2));
      // Below the tick values, inside the margin `PLOT_MARGIN.bottom` reserves
      // for the picker that shows this same name on screen.
      t.setAttribute('y', String(a.y0 + a.height + PLOT_MARGIN.bottom - 16));
      clone.appendChild(t);
    }
    if (a.y) {
      // Centred in the 26 px strip at the panel's left edge — the one
      // `PLOT_MARGIN.left` sets aside for the y picker laid on its side.
      const cx = Math.max(7, a.x0 - PLOT_MARGIN.left + 13);
      const cy = a.y0 + a.height / 2;
      const t = label(a.y);
      t.setAttribute('x', String(cx));
      t.setAttribute('y', String(cy));
      t.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      // The baseline runs along the rotated x axis, so it is centred by
      // dominant-baseline rather than by nudging y — which after a rotation
      // would move it along the axis instead of across it.
      t.setAttribute('dominant-baseline', 'middle');
      clone.appendChild(t);
    }
  }

  lines.forEach((line, i) => {
    const t = label(line);
    t.setAttribute('x', String(canvas.width / 2));
    // Measured down from the top of the strip, which sits at -strip. The pad is
    // split so the caption is not welded to either the top edge or the plot.
    t.setAttribute('y', String(-strip + CAPTION_PAD / 2 + CAPTION_SIZE + i * CAPTION_LINE));
    clone.appendChild(t);
  });

  const xml = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${xml}`;
}

/**
 * Rasterise an SVG string to a PNG blob at a scale factor.
 *
 * A blob URL rather than a `data:` URL: Chromium refuses to load an SVG image
 * from a data URL containing certain characters, and blob URLs have no length
 * limit — a 170 000-event plot's embedded bitmap is several megabytes of base64.
 */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2D context to rasterise the plot.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterise an SVG string to RGBA pixels at a scale factor — what the TIFF
 * writer encodes. Same route as `svgToPng`, so the two raster formats are the
 * same pixels.
 */
export async function svgToImageData(
  svg: string, width: number, height: number, scale: number,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2D context to rasterise the figure.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: pixels.data, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The plot could not be rasterised — the generated SVG was rejected by the image decoder.'));
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas produced no image data.'))), 'image/png');
  });
}

/** Blob → ArrayBuffer, for handing to the platform's file writer. */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

/* -------------------------------------------------------------------------
   Naming and sizing
   ------------------------------------------------------------------------- */

/** Filesystem-safe export filename for a plot. */
export function plotFileName(sample: string, xLabel: string, yLabel: string, format: ImageFormat): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._+-]+/g, '_').replace(/^_+|_+$/g, '');
  const stem = [clean(sample), clean(xLabel), clean(yLabel)].filter(Boolean).join('_') || 'plot';
  return `${stem}.${format}`;
}

/* -------------------------------------------------------------------------
   Resolution

   One ladder, for every image this application writes: the per-plot exporter,
   the Compare chart and the UMAP map all offer the same three numbers and read
   the same two functions.

   It used to be two systems. Plots were sized by journal column width — 85 mm
   single, 178 mm double — and charts by DPI, on the argument that a density
   plot's size is decided by the column it has to fit while a chart is a whole
   figure and the question asked of it is "how sharp". That argument is wrong
   about which one the operator can answer. A column width is a property of the
   journal, not of the plot, and it forced a second, incompatible sizing path
   through the same code: a raster width in pixels *and* a page width in
   millimetres, neither derivable from the other, with a preset table to keep
   them in step.

   So a figure is now the size of the panel it was framed in, and the only
   question asked is how many device pixels a raster gets. A vector file has no
   such question and is not asked it.
   ------------------------------------------------------------------------- */

/**
 * Export resolutions.
 *
 * 300 is the usual journal submission floor, 600 is what a journal asks for
 * line art, and 900 is for a figure that will be enlarged.
 */
export const EXPORT_DPI_OPTIONS = [300, 600, 900] as const;
export type ExportDpi = (typeof EXPORT_DPI_OPTIONS)[number];

/**
 * Resolution the event cloud is embedded at inside a vector file.
 *
 * PDF and SVG are offered no resolution control, because their geometry has no
 * resolution — but a *plot's* vector file is not entirely vector: the event
 * cloud is a raster layer inside it, and something has to decide how many
 * pixels that layer holds. It is the submission floor, fixed, rather than a
 * fourth control that would only ever be asked about one layer of the file.
 */
export const VECTOR_RASTER_DPI = 300;

/**
 * Raster scale at a given DPI.
 *
 * SVG user units here are CSS pixels, and a CSS pixel is defined at 96 dpi — so
 * the drawing is already a physical size, and the only question is how many
 * device pixels to put in it. A 640-unit-wide figure is 6.67 inches, which at
 * 300 dpi is 2000 px.
 */
export function pixelScaleFor(dpi: number): number {
  return dpi / 96;
}

/** Points per CSS pixel — CSS pixels are defined at 96 dpi, PDF points at 72. */
export const PT_PER_PX = 72 / 96;

/**
 * A figure's page size in PDF points, from its size in CSS pixels.
 *
 * The page *is* the drawing: no scaling, no fitting to a column. A panel 288
 * units wide prints 216 pt — 76 mm — which is what it was drawn as.
 */
export function pagePointSize(width: number, height: number): { widthPt: number; heightPt: number } {
  return { widthPt: width * PT_PER_PX, heightPt: height * PT_PER_PX };
}

/** Filesystem-safe name for an exported comparison chart. */
export function chartFileName(population: string, measure: string, format: 'png' | 'pdf'): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._+-]+/g, '_').replace(/^_+|_+$/g, '');
  const stem = ['compare', clean(population), clean(measure)].filter(Boolean).join('_') || 'compare';
  return `${stem}.${format}`;
}
