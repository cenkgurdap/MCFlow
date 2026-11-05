/**
 * The notes that travel with a figure — what it shows and how it was made.
 *
 * ## Why every figure carries them (2026-10-22)
 *
 * A figure that leaves the application loses everything the panel beside it
 * said: which population, how many events, which transform, which test, what
 * the error bars are, whether the replicates were biological. That is what a
 * legend and a methods section need, and it used to be retyped from the screen
 * by hand. Each composer now returns its facts as lines, and the export writes
 * them three ways: a `.txt` beside the file, the SVG's `<desc>`, and the PNG's
 * and TIFF's own description fields — so a file that has lost its sidecar still
 * says what it is.
 *
 * Pure.
 */
import { pxToMm, type FigureStyle } from './style';

declare const __MCFLOW_VERSION__: string;

/** The application's version, or a placeholder where no build injected one. */
export function appVersion(): string {
  return typeof __MCFLOW_VERSION__ === 'string' ? __MCFLOW_VERSION__ : 'dev';
}

const FORMAT_NAME: Record<FigureStyle['output']['format'], string> = {
  pdf: 'vector PDF',
  svg: 'vector SVG',
  png: 'PNG',
  tiff: 'TIFF (LZW)',
};

/**
 * The full notes for an exported file: a header naming the figure's physical
 * form — size, type, lines, format — then the composer's own lines.
 */
export function figureNotes({
  kind, style, width, height, lines, hasLayer,
}: {
  /** What kind of figure — `Density plot`, `Compare chart`, `UMAP projection`. */
  kind: string;
  style: FigureStyle;
  /** The figure's size in user units. */
  width: number;
  height: number;
  /** The composer's facts. */
  lines: readonly string[];
  /** Whether the figure embeds a raster event layer inside its vector drawing. */
  hasLayer: boolean;
}): string {
  const f = style.font;
  const l = style.line;
  const format = style.output.format;
  const raster = format === 'png' || format === 'tiff';
  const resolution = raster
    ? `, ${style.output.dpi} dpi`
    : hasLayer ? `; the event layer is embedded as a ${style.output.layerDpi} dpi image` : '';
  return [
    `${kind} — exported by MCFlow ${appVersion()}`,
    `Size: ${pxToMm(width).toFixed(1)} × ${pxToMm(height).toFixed(1)} mm, ${FORMAT_NAME[format]}${resolution}.`,
    `Type: ${f.family}, ticks ${f.tickPt} pt, labels ${f.labelPt} pt, annotations ${f.notePt} pt. Lines: axes ${l.axisPt} pt, data ${l.dataPt} pt, gates ${l.gatePt} pt.`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Text a field restricted to ASCII can carry — TIFF's ImageDescription — with
 * the few non-ASCII characters the notes use spelled out rather than dropped.
 */
export function asciiNotes(text: string): string {
  const map: Record<string, string> = {
    '−': '-', '–': '-', '—': '-', '·': '-', '×': 'x', '±': '+/-',
    'μ': 'mu', 'µ': 'mu', 'σ': 'sigma', 'ξ': 'xi', 'ω': 'omega', 'α': 'alpha',
    '²': '^2', '³': '^3', '≥': '>=', '≤': '<=', 'é': 'e', 'β': 'beta',
  };
  return Array.from(text, (c) => (c.charCodeAt(0) < 128 ? c : map[c] ?? '?')).join('');
}
