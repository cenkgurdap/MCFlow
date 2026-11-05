import { useMemo } from 'react';
import {
  componentPopulations, describeDistribution, describeModel, expectedCounts, goodnessOfFit, populationMoments, populationRows, smoothedModel, type PopulationLine,
  type Goodness,
} from '@/core/biophysics/fitDisplay';
import { DEFAULT_BINS, histogram, type MixtureFit } from '@/core/biophysics/mixture';
import { populationIntervals, propertyById } from '@/core/biophysics/properties';
import { schemeFor } from '@/core/biophysics/pipeline';
import { maskToIndices } from '@/core/gating/tree';
import type { Gate } from '@/core/gating/types';
import { smooth } from '@/render/binning';
import { fitPopulationId, useBiophysics } from '@/state/biophysicsStore';
import { sampleColumn, useDerived } from '@/state/derivedStore';
import { defaultSpecFor, evaluateFor, useGates } from '@/state/gateStore';
import type { Sample } from '@/state/workspaceStore';
import { populationColors } from './populationColors';

/**
 * The fitted mixture, drawn over a real histogram panel.
 *
 * ## Why it is here rather than only in the Biophysics panel
 *
 * The gates on that worksheet are what the fit *produced*, and the curve is the
 * only thing on screen that says whether those boundaries were placed by
 * something that describes the data. Without it a biophysics worksheet is three
 * brackets on a histogram with no account of where they came from — which is
 * exactly the situation the unmixing wizard's spectrum plot exists to avoid, and
 * for the same reason: a result that cannot be questioned by looking at it is a
 * number rather than a measurement.
 *
 * It also means the overlay is on the **Analysis** tab, not only inside the
 * guided panel, which follows from the same architectural claim everything else
 * here does: the gates are ordinary gates and the worksheet is an ordinary
 * worksheet, so anything true of them is true wherever they are looked at.
 *
 * ## Why it costs nothing on every other plot
 *
 * `useFitOverlayRows` returns `null` unless this panel is a histogram of the
 * property's parameter on a sample the pipeline has fitted. Cheap checks, none
 * of which touch event data, and the common case — a workspace that has never
 * opened this panel — fails the first of them because `samples` is empty.
 *
 * ## What is drawn, and on what scale (2026-10-22)
 *
 * The **description** — the mixture BIC prefers — not the population fit the
 * gates were cut from. The population fit is held to the admissibility rules,
 * and on a sharp peak with a long tail that is one Gaussian whose spread is the
 * tail's: it was drawn at 0.59 of the bars. See `core/biophysics/fitDisplay.ts`.
 *
 * The model is the expected count in each of **this panel's** bins, passed
 * through the same smoothing window `HistogramLayer` gives its bars and divided
 * by the same number — the tallest smoothed bar — so a curve and a bar at one
 * height describe one count. The rows are computed once, by the hook, and drawn
 * twice: here, and in an exported figure, which reads the very same arrays.
 */

/** The fit as rows on the panel's bins, in the bars' normalised units. */
export interface FitOverlayRows {
  /** The panel's bin centres, in data units — which for this linear parameter are display units. */
  x: Float64Array;
  total: Float64Array;
  parts: Float64Array[];
  /** Each population line's colour on screen: its gate's hue. */
  colors: string[];
  /** Each population's gate, for colours that do not follow a theme. */
  gates: Array<Gate | undefined>;
  description: MixtureFit;
  /** Each population's share, mean and SD as drawn, most ordered first. */
  populations: PopulationLine[];
  /** Against the fit's own 256 bins — the number the Step 4 chart prints. */
  goodness: Goodness;
  /** `Gaussian mixture · 2 populations`. */
  model: string;
  /** Smoothed bars minus smoothed model, on the bars' scale. */
  residual: Float64Array;
  /** The population the fit was read inside; drawn only on a panel scoped to it. */
  populationId: string | null;
}

export function useFitOverlayRows({
  sample, xParam, binCount, smoothing,
}: {
  sample: Sample | undefined;
  xParam: number;
  /** The panel's own bin count, so the two are binned the same way. */
  binCount: number;
  /** The panel's own smoothing window — the one its bars went through. */
  smoothing: number;
}): FitOverlayRows | null {
  const records = useBiophysics((s) => s.samples);
  const propertyId = useBiophysics((s) => s.propertyId);
  const parameterId = useBiophysics((s) => s.parameterId);
  // The population the fit was read inside — the doublet cut in multi mode, the
  // cells in single. See `fitPopulationId`.
  const liveGateId = useBiophysics(fitPopulationId);
  const scheme = schemeFor(useBiophysics((s) => s.mode));
  const defs = useDerived((s) => s.defs);
  const shared = useGates((s) => s.shared);
  const overrides = useGates((s) => s.overrides);

  const record = sample ? records.find((r) => r.sampleId === sample.id) : undefined;
  const property = propertyById(propertyId);

  /** Is this panel plotting the property's own parameter? */
  const isPropertyAxis = useMemo(() => {
    if (!sample || !parameterId) return false;
    const at = defs.findIndex((d) => d.id === parameterId);
    return at >= 0 && xParam === sample.parsed.metadata.parameters.length + at;
  }, [sample, parameterId, defs, xParam]);

  /*
     The description is fitted at the fit's own resolution — the 256 bins every
     fit in the pipeline is computed over, which is also what the Step 4 chart
     describes — and then evaluated on this panel's bins, so the two charts draw
     the same model and each draws it at its own binning.

     The subset is the population the fit was run over — the doublet cut in
     multi mode, the cells in single. On a panel scoped to that gate it is also
     what the panel is drawing, so the two agree; on a panel scoped to something
     else the curve is honestly the fit of a different population and is not
     drawn at all — see `FitOverlay`.
  */
  return useMemo(() => {
    if (!record?.fit || !property || !sample || !isPropertyAxis) return null;
    const at = defs.findIndex((d) => d.id === parameterId);
    if (at < 0) return null;
    const index = sample.parsed.metadata.parameters.length + at;
    const values = sampleColumn(sample.parsed, index, defs);

    const gates = useGates.getState().gatesFor(sample.id);
    let subset: Uint32Array | null = null;
    if (liveGateId && gates.some((g) => g.id === liveGateId)) {
      const ev = evaluateFor(sample.id, sample.parsed, gates, (p) => defaultSpecFor(sample.parsed, p));
      const mask = ev.masks.get(liveGateId);
      if (mask) subset = maskToIndices(mask);
    }

    const range = { min: property.axis.min, max: property.axis.max, subset };
    const fitBins = histogram(values, { ...range, bins: DEFAULT_BINS });
    const panelBins = histogram(values, { ...range, bins: Math.max(8, Math.min(1024, binCount || DEFAULT_BINS)) });
    if (!fitBins || !panelBins) return null;

    const description = describeDistribution(fitBins);
    const intervals = populationIntervals(record.fit, scheme);
    const populationOf = componentPopulations(description, intervals);
    const model = populationRows(smoothedModel(expectedCounts(description, panelBins), smoothing), populationOf, intervals.length);
    // The divisor `HistogramLayer` gives its bars: the tallest bar after the
    // same smoothing window.
    const bars = smooth(panelBins.counts, smoothing);
    let peak = 0;
    for (let i = 0; i < bars.length; i++) if (bars[i]! > peak) peak = bars[i]!;
    if (peak <= 0) return null;
    const scale = (row: Float64Array) => Float64Array.from(row, (v) => v / peak);

    const byPopulation = record.populationGateIds.slice(0, intervals.length)
      .map((id) => gates.find((g) => g.id === id));
    const colors = populationColors(record, gates, intervals.length);

    return {
      x: Float64Array.from({ length: panelBins.counts.length }, (_, i) => property.axis.min + (i + 0.5) * panelBins.width),
      total: scale(model.total),
      // One line per population, and none when there is one: its line is the sum.
      parts: intervals.length > 1 ? model.parts.map(scale) : [],
      colors,
      gates: byPopulation,
      description,
      populations: populationMoments(description, populationOf, intervals.length),
      goodness: goodnessOfFit(fitBins.counts, expectedCounts(description, fitBins).total),
      model: describeModel(intervals.length),
      residual: Float64Array.from(bars, (b, i) => (b - model.total[i]!) / peak),
      populationId: liveGateId,
    };
    // `shared`/`overrides` are the gate-shape signal: reshaping the live-cell
    // gate changes the population the curve is drawn against.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record, property, sample, isPropertyAxis, defs, parameterId, liveGateId, binCount, smoothing, scheme,
      shared, overrides]);
}

/** The rows, drawn — on a panel scoped to the population the fit was read inside, and nowhere else. */
export function FitOverlay({
  rows, populationId, plotW, plotH, toPixelX, toPixelY,
}: {
  rows: FitOverlayRows | null;
  /** The population the panel is scoped to; the fit was computed over the gated cells. */
  populationId: string | null;
  plotW: number;
  plotH: number;
  toPixelX: (v: number) => number;
  /** The panel's own y mapping, so the curve sits on the axis the bars are read against. */
  toPixelY: (v: number) => number;
}) {
  const paths = useMemo(() => {
    if (!rows) return null;
    const line = (row: Float64Array) => {
      let d = '';
      for (let i = 0; i < row.length; i++) {
        d += `${i === 0 ? 'M' : 'L'}${toPixelX(rows.x[i]!).toFixed(2)},${toPixelY(Math.min(1.4, row[i]!)).toFixed(2)}`;
      }
      return d;
    };
    return { total: line(rows.total), parts: rows.parts.map(line) };
  }, [rows, toPixelX, toPixelY]);

  /*
     Drawn only on a panel scoped to the population the fit was run over.

     A histogram of the same parameter over *all* events, or over some other
     gate, is a different distribution — and a fitted curve laid over it would be
     a claim about events that are not the ones on screen. That is the same rule
     `panelGates.ts` applies to gates and for the same reason.
  */
  if (!rows || !paths || populationId !== rows.populationId || plotW <= 0 || plotH <= 0) return null;

  return (
    <g data-fit-overlay="" pointerEvents="none">
      {/* One line per population, in its gate's colour — the sum of the
          description's components under that gate. See `populationRows`. */}
      {paths.parts.map((d, i) => (
        <path
          key={i}
          d={d}
          data-fit-overlay-population={i}
          fill="none"
          stroke={rows.colors[i]}
          strokeWidth={1.1}
          strokeDasharray="3 2"
          opacity={0.9}
        />
      ))}
      {/* The sum — the model's claim about the whole distribution — solid, in
          the ink the axes are drawn in, so it is never mistaken for a bar. */}
      {/* How well the sum describes the bars — small, in the corner (0.35). */}
      {Number.isFinite(rows.goodness.r2) && (
        <text data-fit-overlay-r2="" x={plotW - 4} y={11} textAnchor="end" fontSize={9} fill="var(--text-tertiary)" className="tnum">
          R² {rows.goodness.r2.toFixed(3)}
        </text>
      )}
      <path
        d={paths.total}
        data-fit-overlay-curve=""
        fill="none"
        stroke="var(--gate-ink)"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </g>
  );
}
