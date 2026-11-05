/**
 * The one style every exported figure is drawn in.
 *
 * ## Why this file exists (2026-10-22)
 *
 * A figure used to be whatever the panel on screen happened to be. The exporter
 * cloned the live SVG at the panel's pixel size, every size inside it was a
 * literal in a component — 9.5 px ticks here, 1.25 px gate lines there, 12.5 px
 * titles in the Compare chart — and the only physical unit anywhere was the
 * Compare chart's column width. A 430 px panel became a 114 mm figure whose
 * labels shrank to 5 pt the moment it was placed in an 89 mm column.
 *
 * Every figure is now composed **at its printed size**: the width is millimetres,
 * the type is points, the lines are points, and the composers in this folder lay
 * the drawing out at that size rather than scaling a picture of something else.
 * This object is the only place those numbers live. Nothing in a composer may
 * restate a size, a font or a weight of its own.
 *
 * ## Units
 *
 * SVG user units are CSS pixels — 96 to the inch, the assumption every exporter
 * here already made — so a figure 89 mm wide is 336.4 units, a 7 pt label is
 * 9.33 units, and the PDF printer turns the same document into a page of exactly
 * those dimensions.
 *
 * Pure: no store, no DOM.
 */

/* -------------------------------------------------------------------------
   Units
   ------------------------------------------------------------------------- */

/** CSS pixels per inch — SVG user units in every file this application writes. */
export const PX_PER_IN = 96;
export const MM_PER_IN = 25.4;
export const PT_PER_IN = 72;

export const mmToPx = (mm: number): number => (mm / MM_PER_IN) * PX_PER_IN;
export const pxToMm = (px: number): number => (px / PX_PER_IN) * MM_PER_IN;
export const ptToPx = (pt: number): number => (pt / PT_PER_IN) * PX_PER_IN;
export const pxToPt = (px: number): number => (px / PX_PER_IN) * PT_PER_IN;

/* -------------------------------------------------------------------------
   Choices
   ------------------------------------------------------------------------- */

/**
 * The typefaces a figure can be set in.
 *
 * System faces only, and each stack ends in a face of the same design. The PDF
 * is printed by a bare offscreen page that holds none of the application's own
 * fonts, and a family it cannot resolve comes back as a Type3 font Acrobat
 * reports as damaged. Arial is on every Windows and macOS
 * machine; Windows maps Helvetica to it.
 */
export const FONT_FAMILIES = [
  { id: 'Arial', label: 'Arial', stack: 'Arial, Helvetica, "Liberation Sans", sans-serif' },
  { id: 'Helvetica', label: 'Helvetica', stack: 'Helvetica, Arial, "Liberation Sans", sans-serif' },
  { id: 'Times New Roman', label: 'Times New Roman', stack: '"Times New Roman", Times, "Liberation Serif", serif' },
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number]['id'];

/** The CSS font stack for a family. */
export function fontStack(family: FontFamily): string {
  return (FONT_FAMILIES.find((f) => f.id === family) ?? FONT_FAMILIES[0]).stack;
}

/**
 * Figure widths. A width, not a scale: the figure is laid out at it, so its 7 pt
 * labels are 7 pt in the column. Named by width only (0.35) — the journal
 * names were dropped at the user's request; any other width is typed in.
 */
export const WIDTH_PRESETS = [
  { mm: 85, label: '85 mm (single column)' },
  { mm: 120, label: '120 mm' },
  { mm: 180, label: '180 mm (double column)' },
] as const;

/**
 * The figure types, each with a style of its own (0.35). A setting changed on
 * one never reaches another: a density plot's line weights were showing up on
 * the Compare chart. Only the typeface and the width are shared — see
 * `state/figureStore.ts`.
 */
export const FIGURE_KINDS = ['density', 'histogram', 'compare', 'umap', 'distribution'] as const;
export type FigureKind = (typeof FIGURE_KINDS)[number];

export type AspectKey = '1:1' | '4:3' | '3:2' | '16:9' | 'golden' | 'free';

/** Width over height, for each named aspect. `free` takes the stated height. */
export const ASPECTS: Record<Exclude<AspectKey, 'free'>, number> = {
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  golden: (1 + Math.sqrt(5)) / 2,
};

export type FigureFormat = 'pdf' | 'svg' | 'png' | 'tiff';

/** Raster resolutions — the one ladder every image this application writes uses. */
export const RASTER_DPI = [300, 600, 900] as const;
export type RasterDpi = (typeof RASTER_DPI)[number];

/* -------------------------------------------------------------------------
   The style
   ------------------------------------------------------------------------- */

export interface FigureStyle {
  size: {
    /**
     * `figure`: the whole figure is `widthMm` wide and the axes take what the
     * labels leave. `axes`: the **axes box** is `axesWidthMm` × `axesHeightMm`
     * and the figure grows around it — "match panel size", so several figures
     * exported separately share identical axes.
     */
    mode: 'figure' | 'axes';
    widthMm: number;
    aspect: AspectKey;
    /** The figure's height when `aspect` is `free`. */
    heightMm: number;
    axesWidthMm: number;
    axesHeightMm: number;
  };
  font: {
    family: FontFamily;
    /** Tick values. */
    tickPt: number;
    /** Axis titles and legend entries. */
    labelPt: number;
    /** A figure title, when there is one, and the panel letter. */
    titlePt: number;
    /** Annotations drawn on the data — gate names, percentages, μ and σ. */
    notePt: number;
  };
  line: {
    /** Spines and ticks. */
    axisPt: number;
    /** Curves, histogram outlines, error bars. */
    dataPt: number;
    /** Gate outlines and region boundaries. */
    gatePt: number;
    tickLenPt: number;
    tickDir: 'out' | 'in';
  };
  frame: {
    /** `open`: left and bottom spines only. `box`: all four. */
    spines: 'open' | 'box';
    grid: boolean;
    background: 'transparent' | 'white';
  };
  text: {
    /** A title on the figure. Off by default: a paper carries titles in its legend. */
    title: boolean;
    /** The one-line description above the figure. Off by default; it goes in the notes. */
    caption: boolean;
    /** Units in axis titles — `Time (s)`, `FSC-A (a.u.)`. */
    units: boolean;
    /** A panel letter in the top-left corner, or empty for none. */
    panelLetter: string;
  };
  /** What a plot figure draws beyond its data — the switches the export panel offers for one. */
  plot: {
    /** A legend naming the data and every fitted line. */
    legend: boolean;
    /** Each fitted component's μ and σ, written beside it. */
    annotate: boolean;
    /** A strip under a fitted histogram showing data minus model. */
    residual: boolean;
    /** A density plot's colour key. */
    colourBar: boolean;
    /** Leave events piled at the detector's maximum out of the event layer, and say how many. */
    clipSaturated: boolean;
    /** R² of a fitted histogram, in the plot's top-right corner. */
    goodness: boolean;
  };
  /** The Compare chart's points and summary — read by `compareFigure` only. */
  compare: {
    points: boolean;
    /** A point's diameter, in points. */
    markerPt: number;
    opacity: number;
    edge: boolean;
    edgePt: number;
    /** The widest a category's points spread sideways, in millimetres. */
    jitterMm: number;
    summary: boolean;
    centre: 'mean' | 'median';
    spread: 'sd' | 'sem' | 'ci95';
    /** The error bar's width in points; the centre line is drawn 1.7 times as heavy. */
    summaryPt: number;
  };
  output: {
    format: FigureFormat;
    /** Pixels per inch for PNG and TIFF. */
    dpi: RasterDpi;
    /** Pixels per inch for the event layer inside a vector file. */
    layerDpi: RasterDpi;
    /** Write the caption-ready notes beside the figure as a `.txt`. */
    notes: boolean;
  };
}

export const DEFAULT_FIGURE_STYLE: FigureStyle = {
  size: { mode: 'figure', widthMm: 85, aspect: '1:1', heightMm: 85, axesWidthMm: 40, axesHeightMm: 40 },
  font: { family: 'Arial', tickPt: 7, labelPt: 8, titlePt: 9, notePt: 7 },
  line: { axisPt: 0.6, dataPt: 0.9, gatePt: 0.75, tickLenPt: 2.5, tickDir: 'out' },
  frame: { spines: 'open', grid: false, background: 'transparent' },
  text: { title: false, caption: false, units: true, panelLetter: '' },
  plot: { legend: true, annotate: false, residual: false, colourBar: false, clipSaturated: true, goodness: true },
  compare: {
    points: true, markerPt: 4.5, opacity: 0.6, edge: false, edgePt: 0.5, jitterMm: 4,
    summary: true, centre: 'mean', spread: 'sd', summaryPt: 0.9,
  },
  output: { format: 'pdf', dpi: 300, layerDpi: 300, notes: true },
};

/** A figure type's defaults. One set of values today; one place to differ. */
export function defaultStyleFor(_kind: FigureKind): FigureStyle {
  return structuredClone(DEFAULT_FIGURE_STYLE);
}

/** A named style — built in, or saved by the user. */
export interface FigurePreset {
  name: string;
  style: FigureStyle;
  builtIn?: boolean;
}

/**
 * A stored style brought up to date: every field the current version has,
 * each taken from `raw` when it is a valid value of its own kind and from the
 * default otherwise. A preset saved by an older build, or edited by hand, opens
 * as close to what was saved as it can be and never as something invalid.
 */
export function normaliseStyle(raw: unknown): FigureStyle {
  const d = DEFAULT_FIGURE_STYLE;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const num = (v: unknown, fallback: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  const s = r.size ?? {};
  const f = r.font ?? {};
  const l = r.line ?? {};
  const fr = r.frame ?? {};
  const t = r.text ?? {};
  const p = r.plot ?? {};
  const o = r.output ?? {};
  const c = r.compare ?? {};
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    size: {
      mode: pick(s.mode, ['figure', 'axes'] as const, d.size.mode),
      widthMm: num(s.widthMm, d.size.widthMm, 20, 400),
      aspect: pick(s.aspect, ['1:1', '4:3', '3:2', '16:9', 'golden', 'free'] as const, d.size.aspect),
      heightMm: num(s.heightMm, d.size.heightMm, 20, 400),
      axesWidthMm: num(s.axesWidthMm, d.size.axesWidthMm, 10, 380),
      axesHeightMm: num(s.axesHeightMm, d.size.axesHeightMm, 10, 380),
    },
    font: {
      family: pick(f.family, FONT_FAMILIES.map((x) => x.id), d.font.family),
      tickPt: num(f.tickPt, d.font.tickPt, 4, 24),
      labelPt: num(f.labelPt, d.font.labelPt, 4, 24),
      titlePt: num(f.titlePt, d.font.titlePt, 4, 32),
      notePt: num(f.notePt, d.font.notePt, 4, 24),
    },
    line: {
      axisPt: num(l.axisPt, d.line.axisPt, 0.1, 4),
      dataPt: num(l.dataPt, d.line.dataPt, 0.1, 4),
      gatePt: num(l.gatePt, d.line.gatePt, 0.1, 4),
      tickLenPt: num(l.tickLenPt, d.line.tickLenPt, 0, 10),
      tickDir: pick(l.tickDir, ['out', 'in'] as const, d.line.tickDir),
    },
    frame: {
      spines: pick(fr.spines, ['open', 'box'] as const, d.frame.spines),
      grid: typeof fr.grid === 'boolean' ? fr.grid : d.frame.grid,
      background: pick(fr.background, ['transparent', 'white'] as const, d.frame.background),
    },
    text: {
      title: typeof t.title === 'boolean' ? t.title : d.text.title,
      caption: typeof t.caption === 'boolean' ? t.caption : d.text.caption,
      units: typeof t.units === 'boolean' ? t.units : d.text.units,
      panelLetter: typeof t.panelLetter === 'string' ? t.panelLetter.slice(0, 3) : d.text.panelLetter,
    },
    plot: {
      legend: flag(p.legend, d.plot.legend),
      annotate: flag(p.annotate, d.plot.annotate),
      residual: flag(p.residual, d.plot.residual),
      colourBar: flag(p.colourBar, d.plot.colourBar),
      clipSaturated: flag(p.clipSaturated, d.plot.clipSaturated),
      goodness: flag(p.goodness, d.plot.goodness),
    },
    compare: {
      points: flag(c.points, d.compare.points),
      markerPt: num(c.markerPt, d.compare.markerPt, 0.5, 20),
      opacity: num(c.opacity, d.compare.opacity, 0.05, 1),
      edge: flag(c.edge, d.compare.edge),
      edgePt: num(c.edgePt, d.compare.edgePt, 0.1, 4),
      jitterMm: num(c.jitterMm, d.compare.jitterMm, 0, 30),
      summary: flag(c.summary, d.compare.summary),
      centre: pick(c.centre, ['mean', 'median'] as const, d.compare.centre),
      spread: pick(c.spread, ['sd', 'sem', 'ci95'] as const, d.compare.spread),
      summaryPt: num(c.summaryPt, d.compare.summaryPt, 0.1, 6),
    },
    output: {
      format: pick(o.format, ['pdf', 'svg', 'png', 'tiff'] as const, d.output.format),
      dpi: RASTER_DPI.includes(o.dpi as RasterDpi) ? (o.dpi as RasterDpi) : d.output.dpi,
      layerDpi: RASTER_DPI.includes(o.layerDpi as RasterDpi) ? (o.layerDpi as RasterDpi) : d.output.layerDpi,
      notes: typeof o.notes === 'boolean' ? o.notes : d.output.notes,
    },
  };
}

/* -------------------------------------------------------------------------
   Colour
   ------------------------------------------------------------------------- */

/**
 * The Okabe–Ito palette (Okabe & Ito, 2008): eight colours that stay distinct
 * under every common form of colour-vision deficiency, which is why journals
 * recommend it for categories.
 */
export const OKABE_ITO = {
  black: '#000000',
  orange: '#E69F00',
  skyBlue: '#56B4E9',
  bluishGreen: '#009E73',
  yellow: '#F0E442',
  blue: '#0072B2',
  vermillion: '#D55E00',
  reddishPurple: '#CC79A7',
} as const;

/**
 * Conditions are coloured in this order: the strongest pair first — blue and
 * vermillion, distinct for every reader — then green, purple, orange, sky blue,
 * yellow, and black last because it is the colour of the axes.
 */
export const CONDITION_PALETTE: readonly string[] = [
  OKABE_ITO.blue, OKABE_ITO.vermillion, OKABE_ITO.bluishGreen, OKABE_ITO.reddishPurple,
  OKABE_ITO.orange, OKABE_ITO.skyBlue, OKABE_ITO.yellow, OKABE_ITO.black,
];

/** The ink figures are drawn in — axes, text, the fitted sum. Near-black, never pure black. */
export const FIGURE_INK = '#1a1a1a';
/** Gridlines and the grey a faceted panel draws every other cell in. */
export const FIGURE_MUTED = '#bdbdbd';

/**
 * The population palette as the **light** theme defines it — the values a
 * figure is drawn in, whatever theme the application is in, because a figure
 * goes onto white paper. Restated from `tokens.css` because a stylesheet cannot
 * be asked for another theme's value while this one is active; `style.test.ts`
 * reads the stylesheet and fails if the two ever differ.
 */
export const PAPER_POPULATION: readonly string[] = [
  '#0b8bb8', '#c96a12', '#2c9350', '#c04a8c', '#6d4bd1', '#a67c00',
  '#0a8f80', '#c8443b', '#3d68c4', '#6b8f22', '#9a4bc4', '#c25555',
];

/**
 * A colour as the screen states it, as a figure must draw it: a population
 * token becomes its light-theme value, the gate ink becomes the figure ink, and
 * a literal stays itself.
 */
export function paperColor(css: string): string {
  const pop = /var\(--pop-(\d\d)\)/.exec(css);
  if (pop) return PAPER_POPULATION[(Number(pop[1]) - 1 + 12) % 12]!;
  if (css.includes('--gate-ink') || css.includes('--text-primary')) return FIGURE_INK;
  return css;
}

/** The size a figure is laid out at, in SVG user units. */
export interface FigureSize {
  width: number;
  height: number;
}

/**
 * The figure's outer size, for a figure whose height follows its aspect.
 * Not used in `axes` mode, where the composer builds outwards from the box.
 */
export function figureSize(style: FigureStyle): FigureSize {
  const width = mmToPx(style.size.widthMm);
  const height = style.size.aspect === 'free'
    ? mmToPx(style.size.heightMm)
    : width / ASPECTS[style.size.aspect];
  return { width, height };
}
