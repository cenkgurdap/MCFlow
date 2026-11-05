import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Image as ImageIcon, RotateCcw, Save, Trash2 } from 'lucide-react';
import { asciiNotes, appVersion, figureNotes } from '@/core/figure/notes';
import { withPngMetadata } from '@/core/figure/png';
import {
  ASPECTS, FONT_FAMILIES, pxToMm, RASTER_DPI, WIDTH_PRESETS,
  type AspectKey, type FigureFormat, type FigureKind, type FigureStyle, type FontFamily, type RasterDpi,
} from '@/core/figure/style';
import { esc, type ComposedFigure } from '@/core/figure/svg';
import { encodeTiff } from '@/core/figure/tiff';
import { svgToImageData, svgToPng } from '@/core/plotExport';
import { platform } from '@/platform';
import { useFigure } from '@/state/figureStore';
import { Button, IconButton } from '@/ui/Button';
import { Checkbox, Select, TextInput } from '@/ui/Field';
import { Callout } from '@/ui/Feedback';
import { FloatingPanel } from '@/ui/FloatingPanel';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint, Tooltip } from '@/ui/Tooltip';

/**
 * Export a figure — one panel for every figure type in the application.
 *
 * ## Why one panel (2026-10-22)
 *
 * The plot exporter, the Compare chart's and UMAP's were three popovers with
 * the same state written out three times — format, a resolution, transparent,
 * caption — and none of them could size a figure: a figure was the panel it was
 * framed in, in pixels, and a column width was something done to it afterwards
 * in Inkscape, shrinking its labels with it. Now every figure is composed at its
 * printed size by the composer for its kind (`core/figure/`), every composer
 * reads one `FigureStyle`, and this is the one place that style is edited.
 *
 * **A `FloatingPanel`, not a popover**, which is the rule for a settings
 * panel: it opens beside its subject and stays open
 * while the subject is touched. The preview is the exact document the file will
 * be — the same string, rendered as an image — so what is checked is what is
 * written.
 *
 * The style persists per machine and **per figure type** (`state/figureStore.ts`,
 * 0.35): the source names its type, the panel edits that type's settings and
 * only the controls that type draws are shown. Typeface and width are shared.
 */

/** What a figure-bearing panel hands the exporter. */
export interface FigureSource {
  /** Which figure type's settings it is drawn with — each type has its own. */
  type: FigureKind;
  /** What the notes call it — `Density plot`, `Compare chart`. */
  kind: string;
  /** A file name without its extension. */
  fileStem: string;
  /** Whether a raster event layer sits inside the vector drawing. */
  hasLayer: boolean;
  /** A 2D plot keeps a square axes box; a histogram, chart or map takes an aspect. */
  shape: 'square' | 'free';
  /** The per-type switches that apply to this figure. */
  options: ReadonlyArray<keyof FigureStyle['plot']>;
  /** Compose at a style, with the event layer at `layerScale` device pixels per unit. */
  compose(style: FigureStyle, layerScale: number): ComposedFigure | null;
  /** Which line weights this figure draws, so only those are offered. */
  lines?: ReadonlyArray<'data' | 'gate'>;
  /** Categories whose colour the panel can set (the Compare chart). */
  categories?: ReadonlyArray<{ name: string; color: string }>;
  /** What an option is called on this figure, where the generic name would mislead. */
  optionLabels?: Partial<Record<keyof FigureStyle['plot'], { label: string; hint: string }>>;
}

const FORMATS: Array<{ value: FigureFormat; label: string; title: string }> = [
  { value: 'pdf', label: 'PDF', title: 'Vector, text kept as text, fonts embedded' },
  { value: 'svg', label: 'SVG', title: 'Vector, editable in Inkscape or Illustrator' },
  { value: 'png', label: 'PNG', title: 'Raster at the chosen resolution, which the file states' },
  { value: 'tiff', label: 'TIFF', title: 'Raster at the chosen resolution, LZW-compressed' },
];

const ASPECT_SEGMENTS: Array<{ value: AspectKey; label: string; title: string }> = [
  { value: '1:1', label: '1:1', title: 'Square plot area' }, { value: '4:3', label: '4:3', title: 'Plot area 4 wide : 3 high' },
  { value: '3:2', label: '3:2', title: 'Plot area 3 wide : 2 high' }, { value: '16:9', label: '16:9', title: 'Plot area 16 wide : 9 high' },
  { value: 'golden', label: 'φ', title: 'Golden ratio, 1.618 : 1' }, { value: 'free', label: 'Free', title: 'Type the height' },
];

/** What each figure type is called in the panel's title and its reset. */
const KIND_LABELS: Record<FigureKind, string> = {
  density: 'Density / 2D plot', histogram: 'Histogram', compare: 'Compare chart', umap: 'UMAP', distribution: 'Population distribution',
};

/** What each figure switch does, in the words the panel shows. */
const OPTION_LABELS: Record<keyof FigureStyle['plot'], { label: string; hint: string }> = {
  legend: { label: 'Legend', hint: 'A key naming the data and every fitted line.' },
  annotate: { label: 'μ and σ labels', hint: 'Writes each population line’s mean and SD beside its peak.' },
  residual: { label: 'Residual strip', hint: 'A strip under the histogram showing data minus model, on the bars’ scale.' },
  colourBar: { label: 'Colour key', hint: 'A low-to-high density key beside the plot.' },
  clipSaturated: { label: 'Hide events at detector maximum', hint: 'Events piled at the top of a scatter channel are not drawn; the notes say how many. Every gate and statistic still counts them.' },
  goodness: { label: 'R² annotation', hint: 'The fit’s R², written small in the plot’s top-right corner.' },
};

/** A tiny glyph of a tick on an axis: inside or outside it. */
function TickGlyph({ dir }: { dir: 'in' | 'out' }) {
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden className="inline-block mr-1 -mt-px">
      <line x1="1" y1="5" x2="13" y2="5" stroke="currentColor" strokeWidth="1.2" />
      <line x1="7" y1="5" x2="7" y2={dir === 'in' ? 1 : 9} stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** A millimetre or point field that can hold a half-typed number. */
function NumberField({
  value, onCommit, min, max, suffix, label,
}: { value: number; onCommit: (n: number) => void; min: number; max: number; suffix: string; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= min && n <= max) onCommit(Math.round(n * 100) / 100);
    else setDraft(String(value));
  };
  return (
    <TextInput
      aria-label={label}
      value={draft}
      inputMode="decimal"
      suffix={suffix}
      className="text-right tnum"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
    />
  );
}

/** A section heading inside the panel. */
function Heading({ children }: { children: React.ReactNode }) {
  return <p className="text-2xs font-medium uppercase tracking-wide text-[var(--text-tertiary)] pt-2">{children}</p>;
}

/** One labelled control, with its one-line explanation behind a "?". */
function Row({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1 w-[132px] shrink-0 text-2xs text-[var(--text-secondary)]">
        {label}<InfoHint content={hint} />
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/** A switch with its explanation. */
function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <Checkbox
      checked={checked}
      onChange={onChange}
      label={<span className="inline-flex items-center gap-1.5">{label}<InfoHint content={hint} /></span>}
    />
  );
}

export function FigureExport({
  source, disabled, label = 'Export figure',
}: {
  /** Asked when the panel opens and again at export, so the figure is the panel as it is now. */
  source: () => FigureSource | null;
  disabled?: boolean;
  /** The button's accessible name. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const button = useRef<HTMLButtonElement>(null);

  // The source, captured when the panel opens — and again when a category's
  // colour changes, since that is part of the figure. Asked again at export.
  const [snapshot, setSnapshot] = useState<FigureSource | null>(null);
  const conditionColors = useFigure((s) => s.conditionColors);
  useEffect(() => {
    if (open) { setSnapshot(source()); setError(null); setSaved(null); }
    // `source` is a fresh closure every render; opening is what asks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conditionColors]);

  const kind: FigureKind = snapshot?.type ?? 'density';
  const style = useFigure((s) => s.styles[kind]);
  const presets = useFigure((s) => s.presets);
  const store = useFigure.getState;
  const update = <K extends keyof FigureStyle>(section: K, patch: Partial<FigureStyle[K]>) => store().updateStyle(kind, section, patch);

  /*
     The preview: the exact document, at a modest layer resolution so a style
     change redraws promptly. Deferred, so typing in a field is never blocked on
     composing a figure.
  */
  const deferred = useDeferredValue(style);
  const preview = useMemo(() => {
    if (!open || !snapshot) return null;
    try {
      return snapshot.compose(deferred, 1.5);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [open, snapshot, deferred]);
  const previewUrl = useMemo(() => {
    if (!preview || 'error' in preview) return null;
    return URL.createObjectURL(new Blob([preview.svg], { type: 'image/svg+xml;charset=utf-8' }));
  }, [preview]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const currentPreset = useMemo(() => {
    const json = JSON.stringify(style);
    return presets.find((p) => JSON.stringify(p.style) === json)?.name ?? '';
  }, [style, presets]);
  const raster = style.output.format === 'png' || style.output.format === 'tiff';
  const canPdf = !!platform().svgToPdf;

  const run = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const src = source();
      if (!src) throw new Error('The figure is not ready to export.');
      const s = useFigure.getState().styles[src.type];
      const format = s.output.format;
      const isRaster = format === 'png' || format === 'tiff';
      const fig = src.compose(s, (isRaster ? s.output.dpi : s.output.layerDpi) / 96);
      if (!fig) throw new Error('The figure is not ready to export.');
      const notes = figureNotes({
        kind: src.kind, style: s, width: fig.width, height: fig.height, lines: fig.notes.split('\n'), hasLayer: src.hasLayer,
      });
      // The composer wrote its own lines into <desc>; the file carries the full notes.
      const svg = fig.svg.replace(/<desc>[\s\S]*?<\/desc>/, `<desc>${esc(notes)}</desc>`);
      const ext = format === 'tiff' ? 'tif' : format;
      const p = platform();
      const target = await p.saveFileDialog(`${src.fileStem}.${ext}`, [{ name: format.toUpperCase(), extensions: [ext] }]);
      if (!target) return;

      const title = src.fileStem.replace(/_/g, ' ');
      const bytes = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
      if (format === 'svg') {
        await p.writeFile(target, svg);
      } else if (format === 'pdf') {
        if (!p.svgToPdf) throw new Error('PDF export requires the desktop app.');
        await p.writeFile(target, await p.svgToPdf(svg, fig.width * 0.75, fig.height * 0.75, title));
      } else if (format === 'png') {
        const blob = await svgToPng(svg, fig.width, fig.height, s.output.dpi / 96);
        const png = withPngMetadata(new Uint8Array(await blob.arrayBuffer()), {
          dpi: s.output.dpi,
          text: { Title: title, Description: notes, Software: `MCFlow ${appVersion()}` },
        });
        await p.writeFile(target, bytes(png));
      } else {
        const px = await svgToImageData(svg, fig.width, fig.height, s.output.dpi / 96);
        const tif = encodeTiff({
          width: px.width, height: px.height, rgba: px.data, dpi: s.output.dpi,
          alpha: s.frame.background === 'transparent', description: asciiNotes(notes), software: `MCFlow ${appVersion()}`,
        });
        await p.writeFile(target, bytes(tif));
      }
      if (s.output.notes) await p.writeFile(target.replace(/\.[^.\\/]+$/, '') + '.txt', notes);
      setSaved(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const size = style.size;
  const square = snapshot?.shape === 'square';
  const lines = snapshot?.lines ?? [];
  const isCompare = kind === 'compare';
  const isPlot = kind === 'density' || kind === 'histogram' || kind === 'distribution';
  const c = style.compare;

  return (
    <>
      <Tooltip content="Export this figure at its printed size">
        <IconButton
          ref={button}
          label={label}
          size="sm"
          active={open}
          disabled={disabled}
          data-figure-export=""
          onClick={() => setOpen((o) => !o)}
        >
          <ImageIcon size={13} />
        </IconButton>
      </Tooltip>

      <FloatingPanel open={open} onClose={() => setOpen(false)} beside={button.current} title={`Export figure — ${KIND_LABELS[kind]}`} width={680} bodyScroll={false}>
        {/*
            Two panes (0.35): the preview stays in view while the settings beside
            it scroll on their own. On a narrow window they stack, the preview
            pinned above. One scroll region — the settings — and no other.
        */}
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row" data-figure-export-panel="">
          <div className="shrink-0 p-2.5 sm:w-[46%] max-h-[35vh] sm:max-h-none hairline-b sm:border-b-0">
            <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-white p-1.5">
              {previewUrl && preview && !('error' in preview) ? (
                <>
                  <img src={previewUrl} alt="Preview of the exported figure" className="block mx-auto max-h-[30vh] sm:max-h-[60vh] w-auto max-w-full" data-figure-preview="" />
                  <p className="pt-1 text-center text-2xs tnum text-[#666]" data-figure-size="">
                    {pxToMm(preview.width).toFixed(1)} × {pxToMm(preview.height).toFixed(1)} mm
                  </p>
                </>
              ) : (
                <p className="p-3 text-2xs text-[#666]">
                  {preview && 'error' in preview ? preview.error : 'Nothing to export yet.'}
                </p>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2.5 space-y-1.5" data-figure-settings="">
            <div className="flex items-center gap-1.5">
              <Select
                data-figure-preset=""
                aria-label="Preset"
                value={currentPreset}
                onChange={(e) => { if (e.target.value) store().applyPreset(kind, e.target.value); }}
              >
                <option value="">{currentPreset || 'Saved presets…'}</option>
                {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </Select>
              <Tooltip content={`Every ${KIND_LABELS[kind].toLowerCase()} setting back to its default; the typeface and width are kept`}>
                <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} data-figure-reset="" onClick={() => store().resetStyle(kind)}>
                  Reset to defaults
                </Button>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1.5">
              <TextInput aria-label="Preset name" placeholder="Save these settings as…" value={presetName} onChange={(e) => setPresetName(e.target.value)} />
              <IconButton label="Save preset" size="sm" disabled={!presetName.trim()} onClick={() => { store().savePreset(kind, presetName); setPresetName(''); }}>
                <Save size={13} />
              </IconButton>
              <IconButton label="Delete this saved preset" size="sm" disabled={!currentPreset} onClick={() => store().deletePreset(currentPreset)}>
                <Trash2 size={13} />
              </IconButton>
            </div>

            <Heading>Size &amp; aspect</Heading>
            <Row label="Sizing" hint="Figure width: the whole figure is this wide. Axes box: the plot area is exactly this size, so separate figures match.">
              <SegmentedControl name="figure-size-mode" size="sm" fullWidth value={size.mode} onChange={(mode) => update('size', { mode })}
                segments={[{ value: 'figure', label: 'Figure width' }, { value: 'axes', label: 'Axes box' }]} />
            </Row>
            {size.mode === 'figure' ? (
              <Row label="Width" hint="The printed width. Shared by every figure type.">
                <div className="grid grid-cols-[1fr_84px] gap-1.5">
                  <Select aria-label="Width preset" value={WIDTH_PRESETS.some((w) => w.mm === size.widthMm) ? String(size.widthMm) : ''}
                    onChange={(e) => { if (e.target.value) update('size', { widthMm: Number(e.target.value) }); }}>
                    <option value="">Custom</option>
                    {WIDTH_PRESETS.map((w) => <option key={w.mm} value={w.mm}>{w.label}</option>)}
                  </Select>
                  <NumberField label="Width" value={size.widthMm} min={20} max={400} suffix="mm" onCommit={(widthMm) => update('size', { widthMm })} />
                </div>
              </Row>
            ) : (
              <Row label="Axes box" hint="Width and height of the plot area itself.">
                <div className="grid grid-cols-2 gap-1.5">
                  <NumberField label="Axes width" value={size.axesWidthMm} min={10} max={380} suffix="mm" onCommit={(axesWidthMm) => update('size', { axesWidthMm })} />
                  <NumberField label="Axes height" value={square ? size.axesWidthMm : size.axesHeightMm} min={10} max={380} suffix="mm" onCommit={(axesHeightMm) => update('size', { axesHeightMm })} />
                </div>
              </Row>
            )}
            {!square && size.mode === 'figure' && (
              <Row label="Aspect" hint="Plot-area width to height. Free: type the figure height.">
                <Select aria-label="Aspect" data-figure-aspect="" value={size.aspect} onChange={(e) => update('size', { aspect: e.target.value as AspectKey })}>
                  {ASPECT_SEGMENTS.map((a) => <option key={a.value} value={a.value}>{a.label === 'φ' ? 'Golden (1.618 : 1)' : a.value === 'free' ? 'Free — type the height' : a.label}</option>)}
                </Select>
              </Row>
            )}
            {!square && size.mode === 'figure' && size.aspect === 'free' && (
              <Row label="Height" hint="The printed height of the whole figure.">
                <NumberField label="Height" value={size.heightMm} min={20} max={400} suffix="mm" onCommit={(heightMm) => update('size', { heightMm })} />
              </Row>
            )}
            {square && <p className="text-2xs text-[var(--text-tertiary)]">A 2D plot keeps a square plot area — a population&rsquo;s shape is read off the aspect ratio.</p>}

            <Heading>Text sizes</Heading>
            <Row label="Typeface" hint="Shared by every figure type.">
              <Select aria-label="Typeface" value={style.font.family} onChange={(e) => update('font', { family: e.target.value as FontFamily })}>
                {FONT_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </Select>
            </Row>
            <Row label="Axis title" hint="The axis names, e.g. “Membrane order”, and legend entries.">
              <NumberField label="Axis title size" value={style.font.labelPt} min={4} max={24} suffix="pt" onCommit={(labelPt) => update('font', { labelPt })} />
            </Row>
            <Row label="Tick labels" hint="The numbers along each axis (and the category names on a Compare chart).">
              <NumberField label="Tick label size" value={style.font.tickPt} min={4} max={24} suffix="pt" onCommit={(tickPt) => update('font', { tickPt })} />
            </Row>
            <Row label="Plot title" hint="The title above the figure and the panel letter, when shown.">
              <NumberField label="Plot title size" value={style.font.titlePt} min={4} max={32} suffix="pt" onCommit={(titlePt) => update('font', { titlePt })} />
            </Row>
            <Row label="Notes / annotation" hint="Text drawn on the data: gate names and %, n under categories, P values, R², μ and σ.">
              <NumberField label="Annotation size" value={style.font.notePt} min={4} max={24} suffix="pt" onCommit={(notePt) => update('font', { notePt })} />
            </Row>

            <Heading>Visibility</Heading>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <Toggle checked={style.text.title} onChange={(title) => update('text', { title })} label="Plot title" hint="A title above the figure. Off by default: a paper titles figures in the legend." />
              {isPlot && <Toggle checked={style.text.caption} onChange={(caption) => update('text', { caption })} label="Caption" hint="A one-line description (sample, population, events) above the plot." />}
              {isPlot && <Toggle checked={style.text.units} onChange={(units) => update('text', { units })} label="Units in axis title" hint="Adds the unit to an axis title, e.g. “Time (s)”." />}
              {(snapshot?.options ?? []).map((k) => {
                const o = snapshot?.optionLabels?.[k] ?? OPTION_LABELS[k];
                return <Toggle key={k} checked={style.plot[k]} onChange={(v) => update('plot', { [k]: v })} label={o.label} hint={o.hint} />;
              })}
              {isCompare && <Toggle checked={c.points} onChange={(points) => update('compare', { points })} label="Data points" hint="One point per sample." />}
              {isCompare && <Toggle checked={c.summary} onChange={(summary) => update('compare', { summary })} label="Summary lines" hint="The centre line and error bar, drawn over the points." />}
            </div>
            <Row label="Panel letter" hint="A bold letter in the top-left corner, e.g. “a”. Empty for none.">
              <TextInput aria-label="Panel letter" value={style.text.panelLetter} maxLength={3} placeholder="none" className="w-16" onChange={(e) => update('text', { panelLetter: e.target.value })} />
            </Row>

            {isCompare && (
              <>
                <Heading>Data points</Heading>
                <Row label="Marker size" hint="Each point’s diameter.">
                  <NumberField label="Marker size" value={c.markerPt} min={0.5} max={20} suffix="pt" onCommit={(markerPt) => update('compare', { markerPt })} />
                </Row>
                <Row label="Opacity" hint="0.05 (nearly clear) to 1 (solid). Overlapping points show through.">
                  <NumberField label="Point opacity" value={c.opacity} min={0.05} max={1} suffix="" onCommit={(opacity) => update('compare', { opacity })} />
                </Row>
                <Row label="Jitter width" hint="The widest a category’s points spread sideways so they do not overlap.">
                  <NumberField label="Jitter width" value={c.jitterMm} min={0} max={30} suffix="mm" onCommit={(jitterMm) => update('compare', { jitterMm })} />
                </Row>
                <Row label="Edge" hint="An outline around each point, in its own colour. Off by default.">
                  <div className="flex items-center gap-2">
                    <Checkbox checked={c.edge} onChange={(edge) => update('compare', { edge })} label="Show" />
                    {c.edge && <NumberField label="Edge width" value={c.edgePt} min={0.1} max={4} suffix="pt" onCommit={(edgePt) => update('compare', { edgePt })} />}
                  </div>
                </Row>
                <Heading>Summary</Heading>
                <Row label="Centre" hint="The horizontal line: the mean or the median of the samples.">
                  <SegmentedControl name="figure-centre" size="sm" fullWidth value={c.centre} onChange={(centre) => update('compare', { centre })}
                    segments={[{ value: 'mean', label: 'Mean' }, { value: 'median', label: 'Median' }]} />
                </Row>
                <Row label="Error bar" hint="SD: spread of the samples. SEM: precision of the mean. 95% CI: the interval for the mean. With Median it is the interquartile range.">
                  <SegmentedControl name="figure-spread" size="sm" fullWidth value={c.spread} onChange={(spread) => update('compare', { spread })}
                    segments={[{ value: 'sd', label: 'SD' }, { value: 'sem', label: 'SEM' }, { value: 'ci95', label: '95% CI' }]} />
                </Row>
                <Row label="Line width" hint="The error bar’s weight; the centre line is drawn 1.7 times as heavy.">
                  <NumberField label="Summary line width" value={c.summaryPt} min={0.1} max={6} suffix="pt" onCommit={(summaryPt) => update('compare', { summaryPt })} />
                </Row>
              </>
            )}

            <Heading>Axes &amp; ticks</Heading>
            <Row label="Axis line width" hint="The weight of the axis lines (spines) and tick marks.">
              <NumberField label="Axis line width" value={style.line.axisPt} min={0.1} max={4} suffix="pt" onCommit={(axisPt) => update('line', { axisPt })} />
            </Row>
            {kind !== 'umap' && (
              <>
                <Row label="Tick marks" hint="The length of the small marks at each tick value. 0 hides them.">
                  <NumberField label="Tick mark length" value={style.line.tickLenPt} min={0} max={10} suffix="pt" onCommit={(tickLenPt) => update('line', { tickLenPt })} />
                </Row>
                <Row label="Tick direction" hint="Whether tick marks point into the plot or away from it.">
                  <SegmentedControl name="figure-ticks" size="sm" fullWidth value={style.line.tickDir} onChange={(tickDir) => update('line', { tickDir })}
                    segments={[
                      { value: 'out', label: <><TickGlyph dir="out" />Outside axis</>, title: 'Tick marks point away from the plot' },
                      { value: 'in', label: <><TickGlyph dir="in" />Inside axis</>, title: 'Tick marks point into the plot' },
                    ]} />
                </Row>
                <Row label="Frame" hint="Open: left and bottom axis lines only. Box: all four sides.">
                  <SegmentedControl name="figure-spines" size="sm" fullWidth value={style.frame.spines} onChange={(spines) => update('frame', { spines })}
                    segments={[{ value: 'open', label: 'Open (L)' }, { value: 'box', label: 'Box' }]} />
                </Row>
                <Toggle checked={style.frame.grid} onChange={(grid) => update('frame', { grid })} label="Gridlines" hint="Light lines across the plot at each tick." />
              </>
            )}
            {lines.includes('data') && (
              <Row label="Data lines" hint="Curves, histogram outlines and contour lines.">
                <NumberField label="Data line width" value={style.line.dataPt} min={0.1} max={4} suffix="pt" onCommit={(dataPt) => update('line', { dataPt })} />
              </Row>
            )}
            {lines.includes('gate') && (
              <Row label="Gate lines" hint="Gate outlines and region boundaries.">
                <NumberField label="Gate line width" value={style.line.gatePt} min={0.1} max={4} suffix="pt" onCommit={(gatePt) => update('line', { gatePt })} />
              </Row>
            )}

            <Heading>Colours</Heading>
            <Row label="Background" hint="Clear: transparent, for placing on a coloured page. White: an opaque white page.">
              <SegmentedControl name="figure-background" size="sm" fullWidth value={style.frame.background} onChange={(background) => update('frame', { background })}
                segments={[{ value: 'transparent', label: 'Clear' }, { value: 'white', label: 'White' }]} />
            </Row>
            {(snapshot?.categories ?? []).map((cat) => (
              <Row key={cat.name} label={cat.name} hint="This group’s colour, on screen and in every figure. Reset returns it to its position’s colour.">
                <div className="flex items-center gap-1.5">
                  <input type="color" aria-label={`Colour of ${cat.name}`} data-figure-category-color={cat.name} value={cat.color}
                    onChange={(e) => store().setConditionColor(cat.name, e.target.value)} className="h-6 w-10 cursor-pointer rounded border border-[var(--border-subtle)] bg-transparent" />
                  {conditionColors[cat.name] && (
                    <Button size="sm" variant="ghost" onClick={() => store().setConditionColor(cat.name, null)}>Reset</Button>
                  )}
                </div>
              </Row>
            ))}

            <Heading>File</Heading>
            <SegmentedControl name="figure-format" size="sm" fullWidth value={style.output.format} onChange={(format) => update('output', { format })}
              segments={FORMATS.map((f) => ({ ...f, disabled: f.value === 'pdf' && !canPdf }))} />
            {(raster || snapshot?.hasLayer) && (
              <Row label={raster ? 'Resolution' : 'Event layer'} hint={raster ? 'Pixels per inch of the image; the file states it.' : 'Pixels per inch of the event image inside the vector file.'}>
                <SegmentedControl name="figure-dpi" size="sm" fullWidth value={String(raster ? style.output.dpi : style.output.layerDpi)}
                  onChange={(v) => update('output', raster ? { dpi: Number(v) as RasterDpi } : { layerDpi: Number(v) as RasterDpi })}
                  segments={RASTER_DPI.map((d) => ({ value: String(d), label: `${d} dpi` }))} />
              </Row>
            )}
            <Toggle checked={style.output.notes} onChange={(notes) => update('output', { notes })} label="Notes beside the file (.txt)"
              hint="What the figure shows and how it was made — sample, population, events, transforms, fit, test, error bars — ready for a legend or methods section." />

            {error && <Callout tone="err">{error}</Callout>}
            {saved && <Callout tone="ok">Saved {saved.split(/[\\/]/).pop()}</Callout>}
            <Button variant="primary" fullWidth icon={<Download size={13} />} loading={busy} onClick={run} data-figure-export-run="">
              Export {style.output.format.toUpperCase()}
            </Button>
          </div>
        </div>
      </FloatingPanel>
    </>
  );
}

/** The aspect a free-shaped figure's axes take, for a composer that needs it. */
export function aspectOf(style: FigureStyle): number | null {
  return style.size.aspect === 'free' ? null : ASPECTS[style.size.aspect];
}
