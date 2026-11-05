import { useMemo, useRef, useState } from 'react';
import { Download, FileImage, Image as ImageIcon } from 'lucide-react';
import {
  EXPORT_DPI_OPTIONS, exportCanvasSize, pagePointSize, pixelScaleFor, plotFileName,
  svgToPng, svgToString, VECTOR_RASTER_DPI,
  type AxisTitles, type ExportDpi, type ImageFormat, type SvgExportOptions,
} from '@/core/plotExport';
import { platform } from '@/platform';
import { Button, IconButton } from '@/ui/Button';
import { Checkbox, Field } from '@/ui/Field';
import { Callout } from '@/ui/Feedback';
import { Popover } from '@/ui/Popover';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint, Tooltip } from '@/ui/Tooltip';

/**
 * Everything the exporter needs from the plot, gathered at click time.
 *
 * Passed as a callback rather than props so the (potentially expensive)
 * high-resolution redraw only happens when the user actually exports.
 */
export interface PlotSnapshot {
  /** The live chrome SVG — axes, ticks, gates, labels. */
  svg: SVGSVGElement;
  width: number;
  height: number;
  /** Bitmap layers under the chrome, already at export resolution. */
  underlays: NonNullable<SvgExportOptions['underlays']>;
  background: string;
  caption: string;
  /**
   * Axis titles and the rectangle they bound — see `AxisTitles`.
   *
   * `null` when the panel already draws its own names inside the SVG, which is
   * the spectrum panel: its axes are a detector index and an intensity and
   * neither is a picker, so there is nothing in the margin for the exporter to
   * put back and handing them over would print each name twice.
   */
  axes: AxisTitles | null;
  fileStem: { sample: string; x: string; y: string };
}

export function PlotImageExport({
  snapshot, disabled,
}: {
  /** Produce the snapshot at the requested pixel scale. */
  snapshot: (scale: number) => PlotSnapshot | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<ImageFormat>('png');
  const [dpi, setDpi] = useState<ExportDpi>(300);
  /*
     Transparent by default.

     A figure leaves this application to be placed in a document that already
     has a background — a manuscript, a slide, a poster — and an opaque white
     rectangle behind it is the one thing that then has to be cut out again by
     hand. The plot's own ink is unchanged either way; what goes is the fill
     behind it. All three exporters in the application default the same way, so
     a plot, a compare chart and a UMAP map dropped onto one page match.

     The theme caveat is unchanged and is why the hint below still says it: a
     dark-theme plot on transparent lands pale-on-white. The application opens
     light, which is the reason that is a note rather than a trap.
  */
  const [transparent, setTransparent] = useState(true);
  const [caption, setCaption] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  const canPdf = !!platform().svgToPdf;
  const pxScale = pixelScaleFor(dpi);

  /**
   * The figure's own size in SVG user units, measured from a scale-1 snapshot.
   *
   * **A figure is the size of the panel it was framed in.** Nothing here
   * rescales it: PNG multiplies these units by `pxScale` to decide how many
   * device pixels to spend, and a vector file declares them as CSS pixels — at
   * 96 dpi by definition — which `pagePointSize` turns into a page. One shape,
   * two readings of it, no preset table keeping a pixel width and a millimetre
   * width in step with each other.
   */
  const dims = useMemo(() => {
    if (!open) return null;
    const snap = snapshot(1);
    if (!snap) return null;
    // The caption is drawn in a strip the exporter adds above the plot, so the
    // figure is taller than the panel. Asked of the same function `svgToString`
    // asks, or the declared size and the drawing disagree and a PDF comes out
    // with the caption off the top of the page.
    return exportCanvasSize(snap.width, snap.height, caption ? snap.caption : null);
    // Re-measured whenever the panel opens or the caption is switched — which
    // is what changes the height. `dpi` does not: it scales this, it is not it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, caption]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = platform();
      // A vector file's geometry has no resolution and is offered no control
      // over one — but the event cloud inside it is a raster layer, and that
      // layer is embedded at the submission floor. See `VECTOR_RASTER_DPI`.
      const bitmapScale = format === 'png' ? pxScale : pixelScaleFor(VECTOR_RASTER_DPI);
      const snap = snapshot(bitmapScale);
      if (!snap) throw new Error('The plot is not ready to export.');

      const svg = svgToString(snap.svg, {
        width: snap.width,
        height: snap.height,
        background: transparent ? null : snap.background,
        underlays: snap.underlays,
        title: caption ? snap.caption : null,
        axes: snap.axes,
      });

      const name = plotFileName(snap.fileStem.sample, snap.fileStem.x, snap.fileStem.y, format);
      const target = await p.saveFileDialog(name, [
        { name: format.toUpperCase(), extensions: [format] },
      ]);
      if (!target) return;

      if (format === 'svg') {
        await p.writeFile(target, svg);
      } else if (format === 'png') {
        // The whole figure, not the panel: the caption strip is part of what is
        // being rasterised.
        const blob = await svgToPng(svg, dims?.width ?? snap.width, dims?.height ?? snap.height, pxScale);
        await p.writeFile(target, await blob.arrayBuffer());
      } else {
        if (!p.svgToPdf) throw new Error('PDF export requires the desktop app.');
        const { widthPt, heightPt } = pagePointSize(dims?.width ?? snap.width, dims?.height ?? snap.height);
        await p.writeFile(target, await p.svgToPdf(svg, widthPt, heightPt));
      }
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip content="Export this plot as an image">
        <IconButton
          ref={ref}
          label="Export plot image"
          size="sm"
          active={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <ImageIcon size={13} />
        </IconButton>
      </Tooltip>

      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={272} align="end">
        <div className="p-2.5 space-y-3">
          <Field label="Format">
            <SegmentedControl
              fullWidth
              size="sm"
              value={format}
              onChange={setFormat}
              segments={[
                { value: 'png', label: 'PNG', title: 'Raster image at the chosen resolution' },
                { value: 'svg', label: 'SVG', title: 'Vector — axes and gates stay editable' },
                { value: 'pdf', label: 'PDF', title: canPdf ? 'Vector, sized exactly to the figure' : 'Desktop app only', disabled: !canPdf },
              ]}
            />
          </Field>

          {/* Resolution is a question about a raster, so it is asked of one.
              PDF and SVG are drawings at a stated page size and there is no
              answer they could use — the control is not rendered rather than
              rendered disabled, which is the rule the Compare chart's exporter
              already follows. The event cloud they embed is a separate matter
              and is fixed; see `VECTOR_RASTER_DPI`. */}
          {format === 'png' && (
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Resolution
                  <InfoHint content="300 dpi is the usual journal submission floor, 600 what many ask for line art, and 900 for a figure that will be enlarged. The event cloud is re-rendered at the chosen resolution rather than upscaled, so a higher setting is genuinely sharper rather than merely bigger." />
                </span>
              }
              hint={dims ? `${Math.round(dims.width * pxScale)} × ${Math.round(dims.height * pxScale)} px` : undefined}
            >
              <SegmentedControl
                fullWidth
                size="sm"
                value={String(dpi)}
                onChange={(v) => setDpi(Number(v) as ExportDpi)}
                segments={EXPORT_DPI_OPTIONS.map((d) => ({ value: String(d), label: `${d} dpi` }))}
              />
            </Field>
          )}

          {dims && format !== 'png' && (
            <p className="text-2xs font-mono text-[var(--text-tertiary)]">
              {`${(dims.width / 96 * 25.4).toFixed(0)} × ${(dims.height / 96 * 25.4).toFixed(0)} mm  ·  vector`}
            </p>
          )}

          <div className="space-y-1.5">
            <Checkbox
              checked={transparent}
              onChange={setTransparent}
              label={
                <span className="inline-flex items-center gap-1.5">
                  Transparent background
                  <InfoHint content="Leaves the plot area unfilled so the figure sits on whatever colour the document uses. Note that a dark-theme plot drawn on white will be hard to read — switch to the light theme first." />
                </span>
              }
            />
            <Checkbox checked={caption} onChange={setCaption} label="Include caption" />
          </div>

          {format !== 'png' && (
            <Callout tone="info">
              Axes, gates and labels stay as vector geometry and have no resolution.
              The event cloud is embedded as a bitmap at {VECTOR_RASTER_DPI} dpi.
              {format === 'svg' && ' Fonts are referenced by name, so a machine without Inter will substitute.'}
            </Callout>
          )}

          {error && <Callout tone="err">{error}</Callout>}

          <Button
            variant="primary"
            fullWidth
            icon={<Download size={13} />}
            loading={busy}
            onClick={run}
          >
            Export {format.toUpperCase()}
          </Button>
        </div>
      </Popover>
    </>
  );
}

export { FileImage };
