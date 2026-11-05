import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Waves } from 'lucide-react';
import { detectorIndices, populationSignature } from '@/core/spectral';
import { populationPath } from '@/core/gating/tree';
import { createTransform } from '@/core/transform';
import { PLOT_MARGIN, plotSurfaceHeight } from '@/core/layout/geometry';
import { CAPTION_SEP } from '@/core/plotExport';
import { defaultSpecFor, useGates } from '@/state/gateStore';
import { gatedEventsFor } from '@/state/spectralStore';
import { selectPanelOnly } from '@/state/selection';
import { usePlot, type PanelConfig } from '@/state/plotStore';
import { RAMPS, sampleRamp } from '@/render/binning';
import type { Sample } from '@/state/workspaceStore';
import { cn } from '@/ui/cn';
import { PlotImageExport, type PlotSnapshot } from './PlotImageExport';

/**
 * A population's full spectrum, as a panel on the worksheet.
 *
 * The third plot in every reference control's gating layout, and the one that
 * answers the question the two above it cannot: *did that gate select the
 * population it was meant to?* A positive gate is drawn on one detector, so a
 * gate placed on the shoulder of the wrong peak, or on a dim tail, looks
 * perfectly reasonable on its own histogram. It looks wrong here immediately —
 * the signature peaks in the wrong laser block, or has no peak at all — and
 * without this panel that is not visible until the matrix has been computed and
 * the similarity matrix is being read.
 *
 * ## Why it is a distribution and not only a line
 *
 * The signature viewer in the Unmixing panel draws the per-detector **median**,
 * which is what a reference signature is and is the right thing to compare *between*
 * controls. It is the wrong thing to judge *one* control by: a median says
 * nothing about whether the gated events agree with each other, and a gate
 * that has caught two populations produces a perfectly smooth median line
 * through the middle of a gap. So the panel draws the whole distribution per
 * detector as a heatmap and lays the median over it. A bimodal detector is then
 * two bands rather than one line.
 *
 * ## Why this is not a `PlotCanvas` plot type
 *
 * `scatter`, `density` and `histogram` all plot the panel's two parameters and
 * differ only in how the events are marked, which is what makes them
 * interchangeable from the toolbar. This plots one population across sixty-four
 * parameters: no y parameter, no transform pair, nothing to gate on, and no
 * meaningful axis controls. Putting it behind the same component would have made
 * every one of those branches conditional. `PlotGrid` picks between the two
 * renderers on `panel.plotType`; everything else about the panel — position,
 * size, the sample it is pinned to, the population it is scoped to, saving,
 * undo — is the ordinary panel machinery, unchanged.
 */
export function SpectrumPanel({
  sample,
  panel,
  moving,
  onMovePointerDown,
  panelActions,
}: {
  sample: Sample;
  panel: PanelConfig;
  moving?: boolean;
  onMovePointerDown?: (e: React.PointerEvent) => void;
  panelActions?: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  const gates = useGates((s) => s.gatesFor(sample.id));
  const isActive = usePlot((s) => s.activePanelId === panel.id);

  /*
     The drawing is laid out in the surface's own width, never in `panel.w`.

     `panel.w` is the panel *including* its one-pixel border, so the box the plot
     is drawn in is two pixels narrower — which is the number `PlotCanvas` has
     always worked in, because it measures its content box instead of reading the
     stored width. Laying this one out at `panel.w` made its plot square two
     pixels wider than the density plot stacked directly above it on a control's
     worksheet, and an exported spectrum two pixels wider than a figure of the
     same panel in any other plot type — measured by `test-plot-image`, which
     checks every figure against the panel it was framed in. Measuring makes all
     three agree, on screen and in the file.
  */
  useLayoutEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    // Guarded, for the reason `PlotCanvas`'s own observer states at length: an
    // unconditional set is a fresh object per delivered frame, and this element
    // is sized from its own measurement.
    const ro = new ResizeObserver(([entry]) => {
      const width = Math.round(entry!.contentRect.width);
      setMeasured((prev) => (prev === width ? prev : width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = measured || panel.w;
  const surfaceH = plotSurfaceHeight(w);
  const plotW = Math.max(40, w - PLOT_MARGIN.left - PLOT_MARGIN.right);
  const plotH = Math.max(40, surfaceH - PLOT_MARGIN.top - PLOT_MARGIN.bottom);

  const scopeName = panel.populationId
    ? populationPath(gates, panel.populationId) || 'All events'
    : 'All events';

  const spectrum = useMemo(
    () => buildSpectrum(sample, panel.populationId),
    [sample, panel.populationId, gates],
  );

  /* The heatmap, drawn on a canvas rather than as three thousand rects. */
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !spectrum) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    paintSpectrum(cv, spectrum, plotW * dpr, plotH * dpr);
  }, [spectrum, plotW, plotH]);

  /* Laser-block rules on an Aurora: UV16 | V16 | B14 | YG10 | R8. */
  const blocks = spectrum && spectrum.detectors === 64 ? [16, 32, 46, 56] : [];
  const tickEvery = spectrum ? Math.max(1, Math.round(spectrum.detectors / (plotW / 34))) : 1;

  /**
   * Everything the image exporter needs, with the heatmap redrawn at the
   * requested scale.
   *
   * The same three formats, the same resolution ladder and the same two
   * switches every other figure here is written with — because this is a figure
   * like any other, and it was the one plot on a control's worksheet that could
   * only leave the application as a screenshot. Nothing about the export path
   * is new: `PlotImageExport` is the same component the worksheet's plots use,
   * so a spectrum, a density plot and a compare chart dropped onto one page
   * match without anything here restating what a figure is.
   *
   * The heatmap is repainted into an offscreen canvas by the same function that
   * paints the on-screen one, at a larger size rather than upscaled — so a
   * 900 dpi figure resolves single detectors that are a smear at 300. Nothing
   * on screen is touched, so there is no resolution to restore afterwards.
   *
   * Two things differ from a `PlotCanvas` snapshot, and both follow from what
   * this panel is rather than from the exporter:
   *
   *  - **No axis titles are handed over.** They are the one piece of a
   *    worksheet plot's chrome that is *not* in its SVG, because each is an
   *    HTML picker sitting in the margin. Here there is nothing to pick — the
   *    axes are a detector index and an intensity, fixed — so both names are
   *    drawn in the SVG already and handing them over again would print each
   *    one twice, in the same place.
   *  - **The caption carries the event count.** On screen it is in the toolbar
   *    above the drawing, and a toolbar is not in the SVG either. A gated
   *    distribution published without its n is the one thing this figure must
   *    not become.
   */
  const buildSnapshot = useCallback((scale: number): PlotSnapshot | null => {
    const svg = svgRef.current;
    if (!svg || !spectrum) return null;

    const off = document.createElement('canvas');
    paintSpectrum(off, spectrum, plotW * scale, plotH * scale);

    return {
      svg,
      width: w,
      height: surfaceH,
      underlays: [{
        dataUrl: off.toDataURL('image/png'),
        x: PLOT_MARGIN.left, y: PLOT_MARGIN.top, width: plotW, height: plotH,
      }],
      // The panel's own surface, which is `--surface-base` and not
      // `--surface-plot`: this plot has no painted plot rectangle under it, so
      // an opaque export is the colour the drawing sits on now. Resolved here
      // and handed over, never painted into the SVG — a rect inside the element
      // would survive the transparency switch and defeat it.
      background: getComputedStyle(svg).getPropertyValue('--surface-base').trim() || '#ffffff',
      caption: [sample.name, scopeName, `${eventLabel(spectrum.eventCount)} events`].join(CAPTION_SEP),
      axes: null,
      fileStem: { sample: sample.name, x: 'spectrum', y: '' },
    };
  }, [spectrum, plotW, plotH, w, surfaceH, sample.name, scopeName]);

  return (
    <div
      data-panel-id={panel.id}
      data-plot-type="spectrum"
      className={cn(
        'relative flex flex-col min-h-0 min-w-0 bg-[var(--surface-base)]',
        'rounded-[var(--radius-md)] border',
        isActive ? 'border-[var(--accent-500)]/60' : 'border-[var(--border-subtle)]',
        onMovePointerDown && (moving ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      onPointerDownCapture={() => selectPanelOnly(panel.id)}
      onPointerDown={onMovePointerDown}
    >
      {/* ---------------- Toolbar ---------------- */}
      <div className="flex items-center gap-2 h-8 px-2 shrink-0 hairline-b overflow-hidden">
        <span
          className="flex items-baseline gap-1 min-w-0 truncate"
          title={`${sample.name} › ${scopeName}`}
        >
          <span className="text-2xs font-medium text-[var(--text-secondary)] truncate">{sample.name}</span>
          <span className="text-2xs text-[var(--text-disabled)]">›</span>
          <span className="text-2xs text-[var(--text-primary)] truncate">{scopeName}</span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="inline-flex items-center gap-1 text-2xs text-[var(--text-tertiary)]">
            <Waves size={11} />
            {spectrum ? `${eventLabel(spectrum.eventCount)} events` : 'no events'}
          </span>
          <PlotImageExport snapshot={buildSnapshot} disabled={!spectrum} />
          {panelActions}
        </span>
      </div>

      {/* ---------------- Plot surface ---------------- */}
      <div ref={surfaceRef} className="relative flex-1 min-h-0" style={{ height: surfaceH }}>
        {!spectrum ? (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-2xs text-[var(--text-disabled)] px-4 text-center">
              No events in this population yet. Adjust the gate above.
            </p>
          </div>
        ) : (
          <>
            <canvas
              ref={canvasRef}
              width={plotW}
              height={plotH}
              className="absolute"
              style={{ left: PLOT_MARGIN.left, top: PLOT_MARGIN.top, width: plotW, height: plotH }}
            />
            <svg
              ref={svgRef}
              className="absolute inset-0 pointer-events-none"
              width={w}
              height={surfaceH}
              shapeRendering="geometricPrecision"
            >
              {/* Laser boundaries */}
              {blocks.map((b) => {
                const x = PLOT_MARGIN.left + (b / spectrum.detectors) * plotW;
                return (
                  <line
                    key={b}
                    x1={x} y1={PLOT_MARGIN.top} x2={x} y2={PLOT_MARGIN.top + plotH}
                    stroke="var(--plot-grid)" strokeWidth={1} strokeDasharray="3 3"
                    shapeRendering="crispEdges"
                  />
                );
              })}

              {/* The median signature, over the distribution it summarises. */}
              <path
                d={spectrum.median
                  .map((v, d) => {
                    const x = PLOT_MARGIN.left + ((d + 0.5) / spectrum.detectors) * plotW;
                    const y = PLOT_MARGIN.top + plotH - v * plotH;
                    return `${d === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(' ')}
                fill="none"
                stroke="var(--gate-ink)"
                strokeWidth={1.4}
                strokeLinejoin="round"
                opacity={0.9}
              />

              {/* Axes */}
              <line
                x1={PLOT_MARGIN.left} y1={PLOT_MARGIN.top + plotH}
                x2={PLOT_MARGIN.left + plotW} y2={PLOT_MARGIN.top + plotH}
                stroke="var(--plot-axis)" strokeWidth={1} shapeRendering="crispEdges"
              />
              <line
                x1={PLOT_MARGIN.left} y1={PLOT_MARGIN.top}
                x2={PLOT_MARGIN.left} y2={PLOT_MARGIN.top + plotH}
                stroke="var(--plot-axis)" strokeWidth={1} shapeRendering="crispEdges"
              />

              {/* Detector names along the bottom, thinned to whatever fits. */}
              {spectrum.names.map((name, d) => {
                if (d % tickEvery !== 0) return null;
                const x = PLOT_MARGIN.left + ((d + 0.5) / spectrum.detectors) * plotW;
                return (
                  <text
                    key={name + d}
                    x={x}
                    y={PLOT_MARGIN.top + plotH + 6}
                    fontSize={8.5}
                    /* Inter, not the mono face, and this is a correctness rule
                       rather than a taste one now that this panel is exported.
                       The PDF print window holds none of the application's
                       fonts, so `--font-mono` falls through its stack to a
                       variable system face Skia cannot subset and writes out as
                       Type3 glyph programs — which Acrobat opens with *an error
                       exists on this page*. Measured here: three of them in a
                       spectrum PDF with the mono stack, none with this one, the
                       same result as for the Compare chart's tick values. A detector name is an identifier and
                       would otherwise be monospaced; inside an exported SVG
                       nothing is. */
                    fontFamily="var(--font-ui)"
                    fill="var(--plot-label)"
                    textAnchor="end"
                    transform={`rotate(-64 ${x} ${PLOT_MARGIN.top + plotH + 6})`}
                  >
                    {name}
                  </text>
                );
              })}

              <text
                x={PLOT_MARGIN.left + plotW / 2}
                y={surfaceH - 3}
                textAnchor="middle"
                fontSize={9.5}
                fill="var(--plot-label)"
                fontFamily="var(--font-ui)"
              >
                Detector
              </text>
              <text
                x={11}
                y={PLOT_MARGIN.top + plotH / 2}
                textAnchor="middle"
                transform={`rotate(-90 11 ${PLOT_MARGIN.top + plotH / 2})`}
                fontSize={9.5}
                fill="var(--plot-label)"
                fontFamily="var(--font-ui)"
              >
                Intensity
              </text>
            </svg>
          </>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */

interface SpectrumData {
  /** `detectors × levels`, column-major: `grid[d * levels + l]`. */
  grid: Float32Array;
  detectors: number;
  levels: number;
  maxCell: number;
  /** Per-detector median, scaled to the same 0–1 axis as the heatmap. */
  median: number[];
  names: string[];
  eventCount: number;
}

/** `123 456` — the way a count is written here, thin-spaced rather than comma'd. */
const eventLabel = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');

/** Intensity bins per detector. */
const LEVELS = 56;
/** Events sampled for the heatmap. The median always uses every one of them. */
const HEATMAP_SAMPLE = 20000;

/**
 * Bin one population's events across every detector.
 *
 * In **display space**, on one shared axis, and both halves of that are
 * deliberate. Display space because a linear axis over a logicle channel puts
 * the entire negative population and the whole first decade into one bin; one
 * shared axis because the panel's claim is that these sixty-four numbers are
 * comparable, and per-detector autoscaling would make every detector's own
 * maximum reach the top of the plot and destroy exactly that.
 */
function buildSpectrum(sample: Sample, populationId: string | null): SpectrumData | null {
  const md = sample.parsed.metadata;
  const dets = detectorIndices(md);
  if (dets.length === 0) return null;

  const subset = gatedEventsFor(sample, populationId);
  const n = md.eventCount;
  const total = subset ? subset.length : n;
  if (total === 0) return null;

  // One spec for the whole plot — the first detector's. Every fluorescence
  // channel on a spectral instrument shares a range and a default transform, so
  // this is the axis they are all already on; taking each detector's own would
  // silently plot sixty-four different scales side by side.
  const spec = defaultSpecFor(sample.parsed, dets[0]!);
  const tf = createTransform(spec);

  const grid = new Float32Array(dets.length * LEVELS);
  const stride = Math.max(1, Math.floor(total / HEATMAP_SAMPLE));
  let maxCell = 0;

  for (let d = 0; d < dets.length; d++) {
    const base = dets[d]! * n;
    for (let k = 0; k < total; k += stride) {
      const i = subset ? subset[k]! : k;
      const v = tf.forward(sample.parsed.data[base + i]!);
      if (!Number.isFinite(v)) continue;
      // The display axis runs 0…1 for a logicle channel; clamp rather than drop,
      // so a saturated event stays in the top band instead of vanishing.
      const l = Math.min(LEVELS - 1, Math.max(0, Math.floor(v * LEVELS)));
      const c = ++grid[d * LEVELS + l]!;
      if (c > maxCell) maxCell = c;
    }
  }

  const raw = populationSignature(sample.parsed.data, n, dets, subset ?? undefined);
  const median = Array.from(raw, (v) => Math.min(1, Math.max(0, tf.forward(v))));

  return {
    grid,
    detectors: dets.length,
    levels: LEVELS,
    maxCell,
    median,
    names: dets.map((p) => md.parameters[p]?.name ?? `P${p + 1}`),
    eventCount: total,
  };
}

/**
 * Paint one spectrum's distribution into a canvas of a given pixel size.
 *
 * One function, two callers: the panel's own canvas at device resolution, and
 * an offscreen canvas at export resolution. The rule the plot exporter already
 * follows — **the bitmap under an exported figure is redrawn by the code that
 * drew the one on screen, never by a lookalike assembled in the exporter** —
 * and the reason for it is that the two drifted once elsewhere: a density
 * export rebuilt its settings by hand, left one field out, and wrote a figure
 * in different colours from the plot it was taken from.
 *
 * Size is passed in device pixels rather than read off the element, because the
 * two callers scale for different reasons: one for the display's pixel ratio,
 * one for the resolution a journal asked for.
 */
function paintSpectrum(cv: HTMLCanvasElement, spectrum: SpectrumData, w: number, h: number): void {
  cv.width = Math.max(1, Math.round(w));
  cv.height = Math.max(1, Math.round(h));
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);

  const { grid, detectors, levels, maxCell } = spectrum;
  if (maxCell <= 0) return;
  const cw = cv.width / detectors;
  const ch = cv.height / levels;
  const ramp = RAMPS.rainbow!;
  for (let d = 0; d < detectors; d++) {
    for (let l = 0; l < levels; l++) {
      const v = grid[d * levels + l]!;
      if (v <= 0) continue;
      // Square-rooted, because a detector's own peak bin holds an order of
      // magnitude more than its shoulders and a linear ramp renders every
      // shoulder as background — which is the part that says whether the gate
      // caught one population or two.
      const t = Math.sqrt(v / maxCell);
      const [r, g, b] = sampleRamp(ramp, t);
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      // Bottom-up: level 0 is the dimmest.
      ctx.fillRect(d * cw, cv.height - (l + 1) * ch, Math.ceil(cw), Math.ceil(ch));
    }
  }
}
