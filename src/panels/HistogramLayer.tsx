import { useMemo, type CSSProperties } from 'react';
import { bin1d, smooth } from '@/render/binning';

const POP = (i: number) => `var(--pop-${String((i % 12) + 1).padStart(2, '0')})`;

export interface HistogramSeries {
  id: string;
  label: string;
  values: Float32Array;
  mask?: Uint8Array | null;
  colorIndex: number;
  /**
   * A **subset** of the first series rather than another sample beside it.
   *
   * The selected population, drawn over the distribution it was taken out of.
   * It is not a peer: an overlay of three samples is three comparable curves and
   * none of them may dominate, which is why an overlaid plot draws outlines —
   * but a gated slice sitting on top of its own parent is a figure and a ground,
   * and demoting the ground to an outline because something was highlighted on
   * it is the wrong way round. So a marked series does not make the plot an
   * overlay.
   */
  marked?: boolean;
}

/**
 * 1D histogram with overlay support.
 *
 * **Overlaid samples** are normalised to their own peak. That is the standard
 * overlay convention: comparing distribution *shape* between a 15 000-event and
 * a 170 000-event sample is the point, and raw counts would flatten the smaller
 * one into the axis.
 *
 * **A marked subset is normalised to its parent's peak instead**, because it is
 * not a peer — it is part of the curve underneath it, and the two have to be on
 * one vertical scale or the shading and the distribution stop describing the
 * same events. See the note on `curves`.
 *
 * **Smoothed first, normalised second** (2026-10-22). The axis beside these bars
 * says *1* at the top, and it now means the tallest bar drawn. Normalising to
 * the raw peak and smoothing afterwards left the tallest bar at 0.93–0.96 of the
 * axis — lowered by the smoothing, below a "1" nothing reached — and divided the
 * fitted curve laid over it by a noisier number than the bars it was compared
 * with. `FitOverlay` divides its model by the same smoothed peak and passes it
 * through the same window. See `core/biophysics/fitDisplay.ts`.
 *
 * Drawn through the panel's own `toPixelY`, so the bar at 1 sits on the tick
 * labelled 1. It used to leave a private 6 px of headroom the axis did not know
 * about, which put every bar below the value printed beside it.
 */
export function HistogramLayer({
  series, xMin, xMax, width, binCount, smoothing, toPixelY,
}: {
  series: HistogramSeries[];
  xMin: number;
  xMax: number;
  width: number;
  binCount: number;
  smoothing: number;
  /** The panel's own y mapping — normalised count 0…1 onto the plot. */
  toPixelY: (v: number) => number;
}) {
  /*
     ## A gated slice is drawn on its parent's scale        (2026-08-11, Item 11)

     Every series used to be normalised to **its own** peak, which is the right
     convention for two samples being compared and the wrong one for a subset
     drawn over the distribution it came out of. The consequence is the reported
     bug, and it is worth spelling out because the report described it as a
     colour problem.

     A positive gate on a histogram produces two curves over the same bins: the
     whole distribution, whose tallest bin is the negative peak, and the gated
     slice, which is zero to the left of the boundary and equal to the
     distribution to the right of it. Normalise each to its own maximum and the
     slice is multiplied by `negativePeak / positivePeak` — on a real single
     stain, a factor of five to fifty. So the shaded region rose far above the
     curve it is a part of, and the taller it was drawn the *further right* the
     boundary had been dragged, since the slice's own peak keeps falling. That is
     precisely "the shading does not line up with where the line is, and it gets
     worse as the line moves right".

     It also explains the second symptom. The marked path is drawn over the
     distribution in `screen` blend mode, so where the two overlap the colours
     add; a slice inflated to full height covers the whole plot in the sum of two
     saturated fills and reads as opaque, where a correctly scaled one tints only
     the events it actually holds. `screen` is now applied to genuine
     multi-sample overlays only — for those it is what stops the second sample's
     fill from hiding the first — and never to a marked subset, which sits under
     its parent's curve by construction and needs no help to be seen through.

     **What this gives up is the vertical auto-scaling of a sparse selection**,
     and that is deliberate. A gate dragged into a thin tail used to be
     re-inflated to fill the plot, which was recorded on 2026-08-08 as the part
     of the report to keep; the same mechanism is what made the overlay wrong. It
     is dropped by request rather than replaced — see PROGRESS.md.
  */
  const curves = useMemo(
    () => histogramRows(series, xMin, xMax, binCount, smoothing),
    [series, xMin, xMax, binCount, smoothing],
  );

  /** Whether this plot is comparing samples, as opposed to marking a subset. */
  const overlaid = series.filter((s) => !s.marked).length > 1;

  const binWidth = width / binCount;

  /**
   * The step outline — a histogram is bins, not samples, so no interpolation.
   *
   * Open along the baseline: the fill closes there, the stroke does not, or the
   * series colour is drawn over the x-axis rule for the whole width of the plot.
   */
  const outlineFor = (bins: Float64Array): string => {
    let d = `M0,${toPixelY(0).toFixed(2)}`;
    for (let i = 0; i < bins.length; i++) {
      const y = toPixelY(bins[i]!).toFixed(2);
      d += ` L${(i * binWidth).toFixed(2)},${y} L${((i + 1) * binWidth).toFixed(2)},${y}`;
    }
    return `${d} L${width.toFixed(2)},${toPixelY(0).toFixed(2)}`;
  };

  return (
    <g>
      {curves.map((c, i) => {
        const color = POP(c.colorIndex);
        // One distribution fills; overlaid *samples* are outlines, because
        // stacked fills hide whichever distribution happens to be drawn second.
        // A marked subset is not an overlay — see `HistogramSeries.marked`.
        const fillOpacity = c.marked ? 0.16 : overlaid ? 0.08 : 0.22;
        const outline = outlineFor(c.bins);
        // Blended for a genuine overlay only. See the note on `curves`: on a
        // marked subset it turned a translucent tint into an opaque slab
        // wherever the two fills coincided, which is everywhere the subset has
        // events.
        //
        // The blend itself comes from the theme, not from here. It used to be
        // `screen` in both, which lightens towards white — right on the dark
        // canvas it was written for, and on a light one it erases every overlaid
        // curve into the background. See `--histogram-overlay-blend` in
        // `tokens.css`.
        const blend: CSSProperties = {
          mixBlendMode: i > 0 && !c.marked
            ? ('var(--histogram-overlay-blend)' as CSSProperties['mixBlendMode'])
            : undefined,
        };
        return (
          <g key={c.id} style={blend}>
            <path d={`${outline} Z`} fill={color} fillOpacity={fillOpacity} stroke="none" />
            <path
              // Marked so a harness can measure the distribution rather than
              // whichever `svg path` it finds first — a panel's toolbar is full
              // of icons, and every one of them is a path. Reading `paths[0]`
              // there is the "assert on a proxy" trap this project keeps
              // recording: it compares equal across the very change being
              // tested.
              data-histogram-series={c.marked ? 'marked' : 'distribution'}
              d={outline}
              fill="none"
              stroke={color}
              strokeWidth={overlaid || c.marked ? 1.6 : 1.4}
              strokeLinejoin="round"
              shapeRendering="geometricPrecision"
            />
          </g>
        );
      })}
    </g>
  );
}

/**
 * Each series binned, smoothed and normalised the way the panel draws it — the
 * one computation behind the bars on screen and the bars in an exported figure,
 * so the two cannot be normalised differently. A marked subset is divided by its
 * parent's smoothed peak; every other series by its own.
 */
export function histogramRows<S extends HistogramSeries>(
  series: readonly S[],
  xMin: number,
  xMax: number,
  binCount: number,
  smoothing: number,
): Array<S & { bins: Float64Array; count: number }> {
  const binned = series.map((s) => bin1d(s.values, xMin, xMax, binCount, s.mask));
  const smoothed = binned.map((h) => smooth(h.bins, smoothing));
  // The distribution a marked series is a subset of: the first series that is
  // not itself marked. `PlotCanvas` always puts the panel's own population
  // first, so this is that.
  const parentAt = series.findIndex((s) => !s.marked);
  const parentPeak = parentAt >= 0 ? peakOf(smoothed[parentAt]!) : 0;
  return series.map((s, i) => {
    const divisor = s.marked && parentPeak > 0 ? parentPeak : peakOf(smoothed[i]!);
    return { ...s, bins: divideBy(smoothed[i]!, divisor), count: binned[i]!.count };
  });
}

/** The tallest value in a row of bins. */
function peakOf(values: Float64Array): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! > m) m = values[i]!;
  return m;
}

/**
 * Every value over one divisor. A divisor of zero or a non-finite one gives a
 * flat zero curve, which is the honest picture of an empty selection.
 */
function divideBy(values: Float64Array, divisor: number): Float64Array {
  const out = new Float64Array(values.length);
  if (!(divisor > 0)) return out;
  for (let i = 0; i < values.length; i++) out[i] = values[i]! / divisor;
  return out;
}

/** Legend for an overlaid histogram. */
export function HistogramLegend({ series }: { series: Array<{ id: string; label: string; colorIndex: number; count?: number }> }) {
  if (series.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
      {series.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-tertiary)]">
          <span
            aria-hidden
            className="inline-block h-[2px] w-3.5 rounded-full"
            style={{ background: POP(s.colorIndex) }}
          />
          {s.label}
          {s.count !== undefined && (
            <span className="font-mono tnum text-[var(--text-disabled)]">{s.count.toLocaleString()}</span>
          )}
        </span>
      ))}
    </div>
  );
}
