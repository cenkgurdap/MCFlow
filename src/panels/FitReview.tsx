import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyCheck, RotateCcw, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import type { BiophysicsSample } from '@/core/biophysics/pipeline';
import type { BiophysicalProperty } from '@/core/biophysics/properties';
import {
  componentForPopulation, populationBoundaries, populationIntervals, populationNames,
  type PopulationScheme,
} from '@/core/biophysics/properties';
import { DEFAULT_BINS, histogram } from '@/core/biophysics/mixture';
import {
  componentPopulations, curveSamples, describeDistribution, describeModel, expectedCounts, populationMoments, populationRows,
  fitIsStale, goodnessOfFit,
} from '@/core/biophysics/fitDisplay';
import { maskToIndices } from '@/core/gating/tree';
import { formatTick, linearTicks } from '@/core/transform';
import { defaultSpecFor, evaluateFor, useGates } from '@/state/gateStore';
import { sampleColumn, useDerived } from '@/state/derivedStore';
import { fitPopulationId, liveBoundaryIndex, useBiophysics } from '@/state/biophysicsStore';
import { useWorkspace, type Sample } from '@/state/workspaceStore';
import { Button, IconButton } from '@/ui/Button';
import { Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { populationColors } from './populationColors';
import { FigureExport, type FigureSource } from './FigureExport';
import { composePlotFigure, type FigureGate } from '@/core/figure/plotFigure';
import { paperColor } from '@/core/figure/style';

/**
 * The fit, drawn over the distribution it was fitted to, with the boundaries as
 * handles.
 *
 * ## Why there is a chart in the panel at all
 *
 * The worksheet already shows this: a real histogram panel with real range gates
 * on it, each labelled with its population and its percentage. That is the
 * authoritative picture and it is not being duplicated here — what this adds is
 * the **fit**, which the worksheet cannot show, and a gesture for the thing
 * somebody standing on this step actually wants to do, which is nudge a split.
 *
 * A boundary drag here moves the two gates it divides **together**, so the
 * populations stay abutting. Dragging one of those gates on the worksheet moves
 * that population's edge alone. Both are real gestures and they mean slightly
 * different things — this one edits the split, that one edits the gate — which
 * is why neither replaces the other.
 *
 * ## What the curve is
 *
 * The **description** — the mixture BIC prefers — in events per bin, on the
 * bars' own scale, so a bad fit *looks* bad. Not the population fit the gates
 * were cut from: on a sharp peak with a long tail that is one Gaussian whose
 * spread is the tail's, and it was drawn at 0.58 of the bars (2026-10-22). The
 * header says what is drawn and what is counted, and how well the one describes
 * the other. See `core/biophysics/fitDisplay.ts`.
 *
 * ## One colour per population, and nothing else is coloured
 *
 * Rewritten on 2026-08-15, because the chart had four colour systems on top of
 * each other and none of them agreed: band tints, curves and swatches in one hue
 * at three opacities, and an accent-coloured mixture on top. The rule stands —
 * **colour means population, and nothing else is coloured** — and since
 * 2026-10-22 the curves follow the figure convention the worksheet overlay and
 * every exported histogram use:
 *
 *   - The histogram is neutral. It is the data, it belongs to no population, and
 *     it is what everything else is drawn over.
 *   - Each component is a **dashed** line in its population's colour. A
 *     component is not the data and does not trace it; it was drawn solid with a
 *     wash beneath it, which made it the most prominent mark on the chart, and
 *     the components were read as the fit.
 *   - The sum — the model's claim about the whole distribution — is a **solid**
 *     dark line. It is what is compared with the bars, so it is the one curve
 *     drawn at full weight, and it belongs to no population so it carries no hue.
 *   - Which population owns which stretch of the axis is a solid bar along the
 *     bottom edge, outside the plot, at full saturation.
 *
 * ## Everything is in data units until the last moment
 *
 * The x scale is the property's own fixed axis — the same `−1 … 1` the histogram
 * panel is pinned to — so the chart here and the plot on the worksheet frame the
 * same range and a boundary is in the same place on both. Only `toPx` knows
 * about pixels.
 */
/**
 * The property's mean inside population `i`, to three places.
 *
 * `record.means` is the observed mean of the gated events and moves with the
 * boundary; `fitted` is the Gaussian component's own parameter and does not.
 * The fallback covers a workspace written before the observed means were stored
 * and a population that a drag has emptied, where there is no mean to report.
 * Exported so `BiophysicsView` reports the identical number — two formatters of
 * one quantity is how the panel and the chart come to disagree by a digit.
 */
export function meanOf(record: BiophysicsSample, i: number, fitted: number): string {
  const observed = record.means?.[i];
  const value = observed !== undefined && Number.isFinite(observed) ? observed : fitted;
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

export function FitReview({
  sample, record, property, names, scheme = 'graded',
}: {
  sample: Sample;
  record: BiophysicsSample;
  property: BiophysicalProperty;
  /** The gates' current names, which may have been edited in the tree. */
  names: string[];
  /** How the distribution is being read — see `PopulationScheme`. */
  scheme?: PopulationScheme;
}) {
  const parameterId = useBiophysics((s) => s.parameterId);
  // The population the fit is read inside — see `fitPopulationId`. The chart is
  // this distribution or it is not the one the fit was judged against.
  const liveGateId = useBiophysics(fitPopulationId);
  const moveBoundary = useBiophysics((s) => s.moveBoundary);
  const applyLiveBoundary = useBiophysics((s) => s.applyLiveBoundary);
  const resetBoundaries = useBiophysics((s) => s.resetBoundaries);
  const resetAllBoundaries = useBiophysics((s) => s.resetAllBoundaries);
  const records = useBiophysics((s) => s.samples);
  const workspaceSamples = useWorkspace((s) => s.samples);
  const defs = useDerived((s) => s.defs);
  // Subscribed rather than read once: dragging a gate on the worksheet has to
  // redraw the shading here, and the gate list is what changes when it does.
  const shared = useGates((s) => s.shared);
  const overrides = useGates((s) => s.overrides);

  const [dragging, setDragging] = useState<number | null>(null);
  /**
   * The rubber band, in data units, while one is being drawn. `null` otherwise.
   *
   * `from` is where the pointer went down and `to` is where it is now, in that
   * order and **not** sorted — a band drawn right-to-left is the same band, and
   * sorting on every move would make the reading of it depend on which way the
   * hand moved.
   */
  const [band, setBand] = useState<{ from: number; to: number } | null>(null);
  /**
   * The same band, in a ref, and that is the one the gesture reads.
   *
   * Chromium coalesces `pointermove` onto frames, so a fast drag can deliver
   * `down`, `move` and `up` before React has re-rendered once — and every
   * handler then sees the `band` its own render captured, which is `null`. The
   * state copy exists only so the rectangle can be drawn. Both traps this
   * project has recorded about pointer drags are here at once: commit from a
   * ref, and decide anything position-dependent at `pointerup` from the release
   * coordinates.
   */
  const bandRef = useRef<{ from: number; to: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  /*
     The binned distribution, recomputed when the gate moves.

     The same call `fitSample` makes — same parameter, same range, same bin
     count, same gated subset — because a chart binned differently from the fit
     drawn over it is a chart that cannot be used to judge the fit. `shared` and
     `overrides` are in the dependency list so reshaping the live-cell gate on
     the worksheet redraws this; the fit itself deliberately does *not* re-run,
     because re-fitting on every pointer move of a polygon drag would be both
     slow and a moving target.
  */
  const h = useMemo(() => {
    const at = defs.findIndex((d) => d.id === parameterId);
    if (at < 0) return null;
    const index = sample.parsed.metadata.parameters.length + at;
    const values = sampleColumn(sample.parsed, index, defs);
    let subset: Uint32Array | null = null;
    if (liveGateId) {
      const gates = useGates.getState().gatesFor(sample.id);
      if (gates.some((g) => g.id === liveGateId)) {
        const ev = evaluateFor(sample.id, sample.parsed, gates, (p) => defaultSpecFor(sample.parsed, p));
        const mask = ev.masks.get(liveGateId);
        if (mask) subset = maskToIndices(mask);
      }
    }
    return histogram(values, {
      min: property.axis.min, max: property.axis.max, bins: DEFAULT_BINS, subset,
    });
    // `shared` and `overrides` are the gate-shape signal; see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, defs, parameterId, liveGateId, property.axis.min, property.axis.max, shared, overrides]);

  const fit = record.fit;

  /*
     What is drawn — the description of the bars on screen, recomputed with
     them — and how well it describes them. The populations, boundaries and
     shares below are still the population fit's.
  */
  const description = useMemo(() => (h ? describeDistribution(h) : null), [h]);
  const goodness = useMemo(
    () => (h && description ? goodnessOfFit(h.counts, expectedCounts(description, h).total) : null),
    [h, description],
  );

  const W = 100;
  const H = 46;
  const PAD_T = 3;
  /** The population bar under the plot: its top edge, and the viewBox's height. */
  const STRIP_Y = H + 1.5;
  const STRIP_H = 3;
  const TOTAL_H = STRIP_Y + STRIP_H;

  /*
     What stretch of the axis the chart is showing.

     `null` is the property's whole fixed range and is the default — the same
     `−1 … 1` the histogram panel on the worksheet is pinned to, so the chart
     here and the plot there frame the same picture and a boundary is in the same
     place on both.

     Zoom is **local to this review chart and is not a plot viewport**. The
     invariant it might look like it breaks — *a plot's data view is fixed, no
     pan, no zoom* — is about `PanelConfig`: two worksheet panels of the same
     parameters must frame identically or they cannot be compared, and a gesture
     that changes framing invisibly is what removed box zoom. None of that
     applies here. This is not a panel, it holds no `PanelConfig`, it is not
     saved, synced or undoable, it is thrown away when the step is left, and the
     worksheet's own histogram is untouched. What it is for is the one thing the
     fixed range makes hard: two populations 0.06 apart on a 2.0 axis are 3% of
     the width, and the operator has to put a boundary between them.

     Reset whenever the sample changes, so stepping through the walk never shows
     one sample's zoom over another's distribution.
  */
  const [zoom, setZoom] = useState<{ min: number; max: number } | null>(null);
  useEffect(() => { setZoom(null); setBand(null); bandRef.current = null; }, [sample.id]);

  const view = zoom ?? property.axis;
  const span = view.max - view.min;

  const toData = useCallback(
    (fraction: number) => view.min + fraction * span,
    [view.min, span],
  );
  const toPx = useCallback(
    (v: number) => ((v - view.min) / span) * W,
    [view.min, span],
  );
  /** Where a value sits across the chart, 0…1, for an HTML label over the SVG. */
  const toFraction = useCallback((v: number) => (v - view.min) / span, [view.min, span]);

  /**
   * Zoom about the middle of what is shown, by a factor.
   *
   * Clamped to the property's own range at both ends and to a floor of 1% of it,
   * so no number of presses can invert the axis or leave a view narrower than
   * the bin width the distribution is drawn at.
   */
  const zoomBy = useCallback((factor: number) => {
    setZoom((current) => {
      const from = current ?? property.axis;
      const full = property.axis.max - property.axis.min;
      const width = Math.min(full, Math.max(full * 0.01, (from.max - from.min) * factor));
      const centre = (from.min + from.max) / 2;
      let min = centre - width / 2;
      let max = centre + width / 2;
      if (min < property.axis.min) { max += property.axis.min - min; min = property.axis.min; }
      if (max > property.axis.max) { min -= max - property.axis.max; max = property.axis.max; }
      min = Math.max(property.axis.min, min);
      // A view that has grown back to the whole range *is* the default, and
      // saying so rather than storing an equal copy keeps Reset honest about
      // whether there is anything to reset.
      if (max - min >= full - 1e-9) return null;
      return { min, max };
    });
  }, [property.axis]);

  /**
   * The smallest band worth reading as a zoom rather than as a click.
   *
   * A press with no movement is how somebody dismisses a menu or puts focus in
   * the chart, and turning it into a zoom to a zero-width slice would be the
   * gesture doing something nobody asked for. 1% of the property's range is
   * about two pixels of a 140 px chart.
   */
  const MIN_BAND = (property.axis.max - property.axis.min) * 0.01;

  /**
   * Zoom to a band the pointer drew, clamped into the property's own range.
   *
   * The floor is the same 1% of the full range the buttons use, so no gesture
   * can leave a view narrower than the distribution is binned at.
   */
  const zoomToBand = useCallback((a: number, b: number) => {
    const full = property.axis.max - property.axis.min;
    let min = Math.max(property.axis.min, Math.min(a, b));
    let max = Math.min(property.axis.max, Math.max(a, b));
    if (max - min < full * 0.01) {
      const centre = (min + max) / 2;
      min = Math.max(property.axis.min, centre - full * 0.005);
      max = Math.min(property.axis.max, centre + full * 0.005);
    }
    // A band covering everything *is* the default; saying so keeps Reset honest
    // about whether there is anything to reset.
    setZoom(max - min >= full - 1e-9 ? null : { min, max });
  }, [property.axis]);

  /** Ticks over the range being shown, not over the parameter's own. */
  const ticks = useMemo(() => linearTicks(view.min, view.max, 10), [view.min, view.max]);
  const tickStep = ticks.length > 1 ? ticks[1]! - ticks[0]! : span;

  /** Peak of whichever is taller — the bars or the curve — so neither clips. */
  const peak = useMemo(() => {
    if (!h) return 1;
    let m = 0;
    for (let i = 0; i < h.counts.length; i++) if (h.counts[i]! > m) m = h.counts[i]!;
    if (description) {
      const whole = curveSamples(description, property.axis.min, property.axis.max, h.width, h.total);
      for (let i = 0; i < whole.total.length; i++) if (whole.total[i]! > m) m = whole.total[i]!;
    }
    return m > 0 ? m : 1;
  }, [h, description, property.axis.min, property.axis.max]);

  const toY = useCallback((count: number) => H - (count / peak) * (H - PAD_T), [peak]);

  /*
     The bars, placed through `toPx` rather than by dividing the width by the bin
     count. The two agree exactly while the whole range is shown — which is why
     the arithmetic version survived until zoom existed — and disagree completely
     the moment it is not: a bin index is a position in the *distribution*, and
     the chart is drawing a position on the *axis*.
  */
  const barsPath = useMemo(() => {
    if (!h) return '';
    const half = h.width / 2;
    let d = `M${toPx(h.centres[0]! - half).toFixed(3)},${H}`;
    for (let i = 0; i < h.counts.length; i++) {
      const x0 = toPx(h.centres[i]! - half);
      const x1 = toPx(h.centres[i]! + half);
      const y = toY(h.counts[i]!);
      d += ` L${x0.toFixed(3)},${y.toFixed(3)} L${x1.toFixed(3)},${y.toFixed(3)}`;
    }
    return `${d} L${toPx(h.centres[h.counts.length - 1]! + half).toFixed(3)},${H} Z`;
  }, [h, toY, toPx]);

  /**
   * The description, and each component under it, as curves.
   *
   * Sampled across **what is shown** — four samples per bin and at every
   * component's mode, from `curveSamples` — so a zoomed view is as finely drawn
   * as a whole one, and a sharp peak is drawn at its height rather than between
   * two samples straddling it. The 240 fixed samples this replaced were one
   * every 0.0083 of membrane order, coarser than the bins.
   */
  const curves = useMemo(() => {
    if (!h || !description) return null;
    // One line per population: the description's components summed by the
    // population interval their means fall in — see `populationRows`.
    const iv = fit ? populationIntervals(fit, scheme) : [];
    const c = populationRows(
      curveSamples(description, view.min, view.max, h.width, h.total),
      componentPopulations(description, iv), iv.length,
    );
    const xs = curveSamples(description, view.min, view.max, h.width, h.total).x;
    const line = (row: Float64Array) => {
      let d = '';
      for (let i = 0; i < row.length; i++) {
        d += `${i === 0 ? 'M' : 'L'}${toPx(xs[i]!).toFixed(3)},${toY(row[i]!).toFixed(3)}`;
      }
      return d;
    };
    return { total: line(c.total), parts: iv.length > 1 ? c.parts.map(line) : [] };
  }, [h, description, fit, scheme, view.min, view.max, toPx, toY]);

  const meanings = fit ? populationNames(property, fit.components.length, scheme) : [];

  /*
     Components and populations are two different lists, and this chart draws
     both (2026-08-21).

     A curve is per **component** of the description — what the model needed to
     describe the bars, which on a live control is often three modes under one
     gate. A boundary, a strip segment and a row of numbers are per
     **population**, from the population fit. Conflating them is what would put
     three draggable handles on a reading that has one gate to move, and the
     colours are the other half of the same statement — a component is stroked
     in the colour of the population whose interval holds its mean.
  */
  const popIntervals = fit ? populationIntervals(fit, scheme) : [];
  const splits = fit ? populationBoundaries(fit.boundaries.length, scheme) : [];
  // Each population in its gate's colour — see `populationColors`. `shared` and
  // `overrides` are what change when a gate is recoloured in the tree.
  const colors = useMemo(
    () => populationColors(record, useGates.getState().gatesFor(sample.id), popIntervals.length),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, sample.id, popIntervals.length, shared, overrides],
  );
  const popColor = (i: number) => colors[i] ?? colors[0] ?? 'var(--pop-07)';
  const stale = !!h && !!fit && fitIsStale(fit.total, h.total);

  /**
   * The chart as a figure (0.35) — the "population distribution" type, with
   * settings of its own. The bars, the sum and one line per population, from
   * the same functions the chart above draws with, composed by the histogram
   * composer every worksheet histogram uses.
   */
  const distributionSource = (): FigureSource | null => {
    if (!h || !description || !fit) return null;
    const iv = populationIntervals(fit, scheme);
    const of = componentPopulations(description, iv);
    const rows = populationRows(expectedCounts(description, h), of, iv.length);
    let peak = 0;
    for (let i = 0; i < h.counts.length; i++) peak = Math.max(peak, h.counts[i]!, rows.total[i]!);
    if (peak <= 0) return null;
    const norm = (r: ArrayLike<number>) => Float64Array.from(r as ArrayLike<number>, (v) => v / peak);
    const lo = property.axis.min;
    const hi = property.axis.max;
    const ink = (i: number) => paperColor(popColor(i));
    const name = (i: number) => names[i] || meanings[i]?.name || `Population ${i + 1}`;
    const regions: FigureGate[] = iv.map((v, i) => ({
      kind: 'range', id: `pop${i}`, name: name(i), percent: (record.shares[i] ?? 0) * 100, color: ink(i),
      axis: 'x', min: Math.max(lo, v.min), max: Math.min(hi, v.max),
    }));
    const tick = (v: number) => ({ display: v, value: v, label: String(Number(v.toFixed(3))).replace('-', '−') });
    const moments = populationMoments(description, of, iv.length);
    return {
      type: 'distribution',
      kind: 'Population distribution',
      fileStem: `distribution-${sample.name}`.replace(/[^\w.-]+/g, '_'),
      hasLayer: false,
      shape: 'free',
      lines: ['data', 'gate'],
      options: ['legend', 'goodness', 'annotate', 'residual'],
      compose: (style) => composePlotFigure({
        kind: 'histogram',
        view: { xMin: lo, xMax: hi, yMin: 0, yMax: 1 },
        xTicks: linearTicks(lo, hi, 8).map(tick),
        yTicks: [0, 0.25, 0.5, 0.75, 1].map(tick),
        xTitle: property.label, xUnit: null, yTitle: 'Normalised count', yUnit: null,
        panelPlotSize: 300,
        gates: regions,
        histogram: { xMin: lo, xMax: hi, series: [{ label: sample.name, color: '#8c8c8c', bins: norm(h.counts), marked: false, overlaid: false, count: h.total }] },
        fit: {
          x: Float64Array.from({ length: h.counts.length }, (_, i) => h.min + (i + 0.5) * h.width),
          total: norm(rows.total),
          parts: iv.length > 1 ? rows.parts.map(norm) : [],
          partColors: iv.map((_, i) => ink(i)),
          model: describeModel(iv.length),
          goodness: goodness ?? { r2: Number.NaN, rms: Number.NaN, bins: 0 },
          populations: moments.map((m, i) => ({ ...m, name: name(i), color: ink(i) })),
          residual: Float64Array.from(h.counts, (c, i) => (c - rows.total[i]!) / peak),
        },
        title: sample.name,
        caption: `${sample.name} · ${property.label}`,
        notes: [`Sample: ${sample.name}.`, `Events: ${h.total.toLocaleString('en-US')}.`],
      }, style, 1),
    };
  };
  /*
     A population's fitted mean, for the one case `record.means` cannot answer.

     The first component belonging to it — which is the population itself under
     the graded scheme, and the most ordered of the live modes under viability.
     A fallback only: the observed mean is what is shown whenever there is one,
     because that is the number the gate reports. See `meanOf`.
  */
  const fallbackMean = (pop: number) => {
    const at = componentForPopulation(pop, fit?.components.length ?? 0, scheme);
    return at >= 0 ? fit!.components[at]!.mean : Number.NaN;
  };

  /*
     The drag.

     Pointer capture on the SVG, the same mechanism `GateLayer` uses for a gate
     handle and for the same reason: every intermediate position matters and the
     gesture never leaves this element. The value is computed from the pointer's
     position within the SVG's own bounding box rather than from a movement
     delta, so a drag that outruns the pointer events — Chromium coalesces them,
     which this project has recorded three times — still lands where the pointer
     is rather than where the sum of the deltas got to.
  */
  const valueAt = (clientX: number): number => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return view.min;
    return toData(Math.min(1, Math.max(0, (clientX - box.left) / box.width)));
  };

  /**
   * The split between *Live* and everything below it, and how many other samples
   * could be given the same one.
   *
   * Which boundary that is depends on the scheme — see `liveBoundaryIndex`. It
   * is the only split that means the same thing whatever a sample's fit found,
   * which is why it is the only one offered for copying: on a three-population
   * graded sample the lower split divides *Dead* from *Internalised /
   * pre-apoptotic*, and there is no sample fitting two for which that is the
   * same question. Under viability it is the only split there is.
   */
  const liveIndex = fit ? liveBoundaryIndex(fit.boundaries.length, scheme) : -1;
  const liveValue = liveIndex >= 0 ? fit!.boundaries[liveIndex]! : null;
  const copyTargets = records.filter((r) =>
    r.sampleId !== sample.id
    && r.fit
    && liveBoundaryIndex(r.fit.boundaries.length, scheme) >= 0
    && workspaceSamples.some((s) => s.id === r.sampleId)).length;

  /**
   * Whether a sample's splits are anywhere other than where its fit put them.
   *
   * The record's `fittedBoundaries` is absent on a workspace saved before it
   * existed, and there the honest answer is *no* — there is nothing to put back,
   * and a button offering to would do nothing. Asked of this sample for the
   * per-sample reset and of every sample for *Reset all*.
   */
  const hasMoved = (r: BiophysicsSample) =>
    !!r.fit && !!r.fittedBoundaries
    && r.fittedBoundaries.length === r.fit.boundaries.length
    && r.fittedBoundaries.some((v, i) => v !== r.fit!.boundaries[i]);
  const movedHere = hasMoved(record);
  const movedAnywhere = records.filter(
    (r) => hasMoved(r) && workspaceSamples.some((s) => s.id === r.sampleId),
  ).length;

  /**
   * Take or release the pointer, without letting it stop the gesture.
   *
   * `setPointerCapture` throws on a pointer id the browser does not consider
   * active — a synthetic event, a pointer already released — and an exception
   * out of a `pointerdown` handler abandons everything after it. Recorded twice
   * twice before; wrapped once here for both drags on this chart.
   */
  const capture = (e: React.PointerEvent, take: boolean) => {
    const el = e.currentTarget as Element;
    try {
      if (take) el.setPointerCapture?.(e.pointerId);
      else el.releasePointerCapture?.(e.pointerId);
    } catch { /* not an active pointer; the drag works without capture */ }
  };

  /** The split being dragged, in a ref, for the reason `bandRef` gives. */
  const draggingRef = useRef<number | null>(null);

  const onDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    // Stops the zoom surface from also starting a band. The two gestures are
    // the same drag on the same chart, so the priority is stated rather than
    // left to whichever listener fires — see the surface's own note.
    e.stopPropagation();
    draggingRef.current = i;
    setDragging(i);
    capture(e, true);
    moveBoundary(sample, i, valueAt(e.clientX));
  };
  const onMove = (i: number) => (e: React.PointerEvent) => {
    if (draggingRef.current !== i) return;
    moveBoundary(sample, i, valueAt(e.clientX));
  };
  const onUp = (e: React.PointerEvent) => {
    capture(e, false);
    draggingRef.current = null;
    setDragging(null);
  };

  /*
     The zoom band.

     Same mechanism as the boundary drag — pointer capture, and the value read
     from the pointer's position in the SVG's box rather than from a movement
     delta, because Chromium coalesces `pointermove` and a fast drag can deliver
     one of them. Committed from the release coordinates, which is the rule this
     project records for anything position-dependent.
  */
  const onBandDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const at = valueAt(e.clientX);
    // State first, capture second, and the capture wrapped: `setPointerCapture`
    // *throws* on a pointer id the browser does not consider active, which
    // leaves an element with a cursor, an affordance and no behaviour. Recorded.
    bandRef.current = { from: at, to: at };
    setBand(bandRef.current);
    capture(e, true);
  };
  const onBandMove = (e: React.PointerEvent) => {
    const open = bandRef.current;
    if (!open) return;
    const next = { from: open.from, to: valueAt(e.clientX) };
    bandRef.current = next;
    setBand(next);
  };
  const onBandUp = (e: React.PointerEvent) => {
    capture(e, false);
    const open = bandRef.current;
    bandRef.current = null;
    setBand(null);
    if (!open) return;
    const to = valueAt(e.clientX);
    // A press that did not travel is a click, not a zoom to a slice of nothing.
    if (Math.abs(to - open.from) >= MIN_BAND) zoomToBand(open.from, to);
  };
  const onBandCancel = () => { bandRef.current = null; setBand(null); };

  if (!h || !fit) {
    return (
      <div
        data-bio-fit-review="empty"
        className="p-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-2xs text-[var(--text-tertiary)]"
      >
        This sample has no distribution to fit — the live-cell gate holds no events, or the property&rsquo;s
        parameter cannot be computed on this file.
      </div>
    );
  }

  return (
    <div
      data-bio-fit-review=""
      data-bio-fit-k={fit.components.length}
      // The drawn description's component count, beside the population fit's:
      // the two differ by design, and a harness asserting on the curves has to
      // know which list it is counting.
      data-bio-fit-drawn-k={description?.components.length ?? 0}
      className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden"
    >
      <div className="flex items-center gap-1 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
        <span className="flex-1 min-w-0 truncate">
          {property.label} · <span className="tnum">{h.total.toLocaleString()}</span> cells
        </span>
        {/*
            Zoom, on the review chart only.

            **Drag across the chart to choose where** — the gesture somebody
            reaches for, and the one the buttons could only approximate: they
            zoom about the middle of what is shown, so reaching a pair of
            populations sitting off to one side took a press, a look, and a
            press. The two gestures on this element are separated by where they
            start rather than by a modifier; the rule is on the surface rect.

            The buttons stay. They are the keyboard-reachable half of the
            control and the only way to zoom *out* by a stated factor, and three
            presses is still a factor of eight.
        */}
        <Tooltip content="Zoom out">
          <IconButton
            label="Zoom out"
            size="sm"
            data-bio-zoom-out=""
            disabled={zoom === null}
            onClick={() => zoomBy(2)}
          >
            <ZoomOut size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip content="Zoom in around the middle of what is shown. Or drag across the chart to zoom to exactly that stretch.">
          <IconButton label="Zoom in" size="sm" data-bio-zoom-in="" onClick={() => zoomBy(0.5)}>
            <ZoomIn size={12} />
          </IconButton>
        </Tooltip>
        <Tooltip content={`Show the whole ${property.axis.min} to ${property.axis.max} range again`}>
          <IconButton
            label="Reset the zoom"
            size="sm"
            data-bio-zoom-reset=""
            disabled={zoom === null}
            onClick={() => setZoom(null)}
          >
            <RotateCcw size={12} />
          </IconButton>
        </Tooltip>
      </div>

      {/*
          What is drawn, what is counted, and how well the one describes the
          other — the line a reader shown three curves and one gate is owed.
          The description is chosen by BIC and the populations by the
          admissibility rules, so the two counts differ by design; R² and the
          RMS residual are over the bins that carry signal. The stale note
          appears when the gate has been reshaped since the fit: the curve
          follows the gate, the populations do not until a re-fit.
      */}
      {description && goodness && (
        <div
          data-bio-fit-model=""
          data-bio-fit-r2={goodness.r2.toFixed(4)}
          className="flex flex-wrap items-baseline gap-x-2 px-2.5 pt-1.5 text-2xs text-[var(--text-tertiary)]"
        >
          <span>{describeModel(popIntervals.length)}</span>
          <span className="ml-auto"><FigureExport source={distributionSource} label="Export distribution figure" /></span>
          <span className="tnum text-[var(--text-secondary)]">
            R² {goodness.r2.toFixed(3)} · RMS {(goodness.rms * 100).toFixed(1)} %
          </span>
          {stale && (
            <span data-bio-fit-stale="" className="text-[var(--status-warn)]">
              Fitted on {fit.total.toLocaleString()} events; the gate now holds {h.total.toLocaleString()} — re-fit to update the populations.
            </span>
          )}
        </div>
      )}

      <div className="p-2.5 pb-1.5">
        {/*
            Where each split sits, over the line that marks it.

            HTML rather than SVG text: the chart's viewBox is 100 units wide and
            drawn with `preserveAspectRatio="none"`, so anything typographic
            inside it is stretched by whatever the panel's width happens to be.
            The boundary the pipeline acts on is named; the others carry their
            number and say what they are. One number per split that is a gate —
            the same list the handles are drawn from.
        */}
        <div className="relative h-3.5 mb-0.5">
          {splits.map((i) => {
            const b = fit.boundaries[i]!;
            const f = toFraction(b);
            if (f < -0.02 || f > 1.02) return null;
            return (
              <span
                key={`bl${i}`}
                data-bio-boundary-value={i}
                className={cn(
                  'absolute top-0 -translate-x-1/2 whitespace-nowrap text-[9px] tnum leading-none',
                  i === liveIndex ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-disabled)]',
                )}
                style={{ left: `${Math.min(100, Math.max(0, f * 100))}%` }}
              >
                {b.toFixed(3)}
              </span>
            );
          })}
        </div>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${TOTAL_H}`}
          preserveAspectRatio="none"
          className="w-full h-[140px] select-none touch-none"
          style={{ cursor: dragging !== null ? 'ew-resize' : undefined }}
        >
          {/*
              The grid.

              Painted before the data, so it sits under everything. It is the
              other half of the numbered axis below: a chart whose only labels
              were its two ends and its middle could say a population's mean was
              0.42 without letting anybody see *where* 0.42 was, which is the
              one thing somebody placing a boundary by eye needs.
          */}
          {ticks.map((t) => (
            <line
              key={`g${t}`}
              data-bio-grid={t}
              x1={toPx(t)} y1={0} x2={toPx(t)} y2={H}
              stroke="var(--border-subtle)"
              strokeWidth={t === 0 ? 1 : 0.6}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* The distribution. Neutral, and painted first: it is the data, it
              belongs to no population, and everything else is drawn over it. */}
          <path
            d={barsPath}
            data-bio-fit-distribution=""
            fill="var(--text-tertiary)"
            fillOpacity={0.16}
            stroke="var(--text-tertiary)"
            strokeOpacity={0.5}
            strokeWidth={0.25}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* One line per population, in its gate's colour, and none when there
              is a single population — its line is the sum. */}
          {curves?.parts.map((d, i) => (
            <path
              key={`part${i}`}
              d={d}
              data-bio-fit-population={i}
              fill="none"
              stroke={popColor(i)}
              strokeWidth={1.1}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* Their sum — the model's claim about the whole distribution, and the
              curve that is compared with the bars. Solid and dark; it is not a
              population, so it carries no hue. */}
          {curves && (
            <path
              d={curves.total}
              data-bio-fit-curve=""
              fill="none"
              stroke="var(--text-primary)"
              strokeWidth={1.4}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Which population owns which stretch of the axis, at full
              saturation, below the plot. This is what the tinted vertical bands
              were for, said in three pixels instead of across the whole chart. */}
          {popIntervals.map((iv, i) => {
            // Clamped to the chart rather than to the property's range: a
            // population whose stretch runs off the left of a zoomed view still
            // owns everything visible to the left of its upper boundary. The
            // outermost edges are ±Infinity, which is the chart's own edge.
            const lo = Number.isFinite(iv.min) ? Math.max(0, toPx(iv.min)) : 0;
            const hi = Number.isFinite(iv.max) ? Math.min(W, toPx(iv.max)) : W;
            return (
              <rect
                key={`strip${i}`}
                data-bio-fit-span={i}
                x={lo} y={STRIP_Y} width={Math.max(0, hi - lo)} height={STRIP_H}
                fill={popColor(i)}
              />
            );
          })}

          {/*
              The surface a zoom is drawn on, and the rule between the two
              gestures on this chart.

              **The handles win where they are; the background zooms
              everywhere else.** Two correct behaviours competing for the same
              pixels with no stated priority is a shape this project has recorded
              three times, so the priority is stated twice over: this rect is
              painted *before* the boundary handles, so they are what the pointer
              hits within 3 units of a split, and their own `pointerdown` calls
              `stopPropagation` so a grab that starts on a handle can never also
              start a band.

              It is painted after everything decorative for the opposite reason —
              a filled `path` captures pointer events, so a surface underneath
              the histogram and the component washes would only be reachable
              where the chart is empty.
          */}
          <rect
            data-bio-zoom-surface=""
            x={0} y={0} width={W} height={H}
            fill="transparent"
            style={{ cursor: dragging !== null ? 'ew-resize' : 'crosshair' }}
            onPointerDown={onBandDown}
            onPointerMove={onBandMove}
            onPointerUp={onBandUp}
            onPointerCancel={onBandCancel}
          />

          {/* What is about to be zoomed to, while the pointer is down. Drawn in
              the accent rather than in a population colour: it is a statement
              about the view, and colour means population on this chart. */}
          {band && (
            <rect
              data-bio-zoom-band=""
              x={Math.min(toPx(band.from), toPx(band.to))}
              y={0}
              width={Math.abs(toPx(band.to) - toPx(band.from))}
              height={TOTAL_H}
              fill="var(--accent-500)"
              fillOpacity={0.18}
              stroke="var(--accent-500)"
              strokeWidth={0.8}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )}

          {/* The boundaries. A visible 1 px line with a 6-unit invisible grab
              target either side of it — the same asymmetry `GateLayer` uses for a
              gate handle: a line thick enough to be reliably grabbable would hide
              the split it is marking. It runs through the strip too, which is
              what makes the strip read as divided rather than as a gradient.

              A boundary the zoom has left off-screen is not drawn: its handle
              would sit against the edge of the chart claiming to be a split that
              is somewhere else entirely.

              **Only the splits that are gates.** Under the viability scheme a
              four-component fit has three boundaries and one population split;
              the other two are internal to the description of the live cells,
              and a draggable handle on one would offer to move a line that
              nothing counts. See `populationBoundaries`. */}
          {splits.map((i) => {
            const b = fit.boundaries[i]!;
            if (toFraction(b) < -0.02 || toFraction(b) > 1.02) return null;
            return (
              <g key={`b${i}`}>
                <line
                  x1={toPx(b)} y1={0} x2={toPx(b)} y2={TOTAL_H}
                  stroke="var(--text-primary)"
                  strokeWidth={dragging === i ? 2 : 1.2}
                  vectorEffect="non-scaling-stroke"
                />
                <rect
                  data-bio-boundary={i}
                  x={toPx(b) - 3} y={0} width={6} height={TOTAL_H}
                  fill="transparent"
                  style={{ cursor: 'ew-resize' }}
                  onPointerDown={onDown(i)}
                  onPointerMove={onMove(i)}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                />
              </g>
            );
          })}
        </svg>

        {/*
            The axis, on the same ticks as the grid above it.

            It used to be three labels — the two ends and the middle — on the
            argument that a stated, fixed range is not something anybody has to
            look up. That was answering the wrong question. Nobody looks up what
            the range is; what they need is *where 0.4 is*, because the number
            beside a population and the position of the line they are dragging
            are the same quantity and the chart was the only place the two could
            be put side by side. Generated over the range being shown rather than
            over the property's own, so a zoomed view is labelled where it is —
            the trap `Transform.ticks` already records.
        */}
        <div className="relative h-3 text-[9px] tnum text-[var(--text-disabled)]" data-bio-axis-ticks="">
          {ticks.map((t) => (
            <span
              key={`t${t}`}
              data-bio-tick={t}
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${Math.min(100, Math.max(0, toFraction(t) * 100))}%` }}
            >
              {formatTick(t, tickStep)}
            </span>
          ))}
        </div>
      </div>

      {/*
          The live boundary, named and copyable.

          It is the number the whole step is about — where this sample stops
          being live — and until now it existed only as a line somebody had
          dragged. Two things follow from writing it down: it can be read, and it
          can be given to the other samples.

          Copying is deliberately one boundary rather than the whole fit. Every
          sample keeps its own populations, its own counts and its own means; all
          that moves is where the live/dead split sits, which is exactly the
          judgement an operator wants to hold constant across a plate after
          deciding it once on the tube they trust. The other splits keep the
          positions their own fits gave them — see `applyLiveBoundary`.
      */}
      {liveValue !== null && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 hairline-t" data-bio-live-boundary={liveValue.toFixed(4)}>
          <span className="text-2xs text-[var(--text-tertiary)] min-w-0 flex-1">
            <span className="text-[var(--text-secondary)]">{names[0] || meanings[0]?.name || 'Live'}</span>
            {' '}starts at{' '}
            <span className="font-medium tnum text-[var(--text-primary)]">{liveValue.toFixed(3)}</span>
          </span>
          {/*
              Put it back — the counterpart of every drag, and of the button
              beside it.

              Both gestures write the splits and neither had a way back short of
              a re-fit, which is not the same thing: a re-fit also re-runs the
              choice of how many populations there are, so on a sample whose
              count somebody stated it discards that too. This reads the
              positions the fit produced from the record and writes them again —
              see `BiophysicsSample.fittedBoundaries`. Disabled, not hidden, when
              the splits are already where the fit put them: the button is how
              you find out that they are.
          */}
          <Tooltip
            content={movedHere
              ? 'Put this sample’s splits back where the fit put them.'
              : 'The splits on this sample are where the fit put them.'}
          >
            <span>
              <IconButton
                label="Reset this sample’s splits"
                size="sm"
                data-bio-reset-boundaries=""
                disabled={!movedHere}
                onClick={() => resetBoundaries(sample)}
              >
                <RotateCcw size={12} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip
            content={copyTargets > 0
              ? `Move the same split to the other ${copyTargets} fitted sample${copyTargets === 1 ? '' : 's'}. Their other boundaries are left where their own fits put them.`
              : 'No other sample has a boundary to move.'}
          >
            <span>
              <Button
                size="sm"
                variant="secondary"
                icon={<CopyCheck size={12} />}
                disabled={copyTargets === 0}
                data-bio-apply-live-boundary=""
                onClick={() => applyLiveBoundary(workspaceSamples, sample.id)}
              >
                Use on every sample
              </Button>
            </span>
          </Tooltip>
          {/* And the way back from *that*. One press moved every sample; one
              press has to move them all back, or the button is a one-way door
              on eight files at once. */}
          <Tooltip
            content={movedAnywhere > 0
              ? `Put the splits back where each sample’s own fit put them — ${movedAnywhere} ${movedAnywhere === 1 ? 'sample has' : 'samples have'} been moved since.`
              : 'Every sample’s splits are where its own fit put them.'}
          >
            <span>
              <Button
                size="sm"
                variant="ghost"
                icon={<Undo2 size={12} />}
                disabled={movedAnywhere === 0}
                data-bio-reset-all-boundaries=""
                onClick={() => resetAllBoundaries(workspaceSamples)}
              >
                Reset all
              </Button>
            </span>
          </Tooltip>
        </div>
      )}

      {/* The populations, with what each holds. Both numbers are the *gate's* —
          the share and the mean of the events now inside it — so they match what
          Statistics will report and they move as a boundary is dragged. The
          fitted component's own mean does not move when a split does, which is
          why it is only the fallback for a record written before this. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-2.5 pb-2">
        {/* Least ordered first — the order they sit in along the axis. */}
        {[...popIntervals.keys()].reverse().map((i) => (
          <span
            key={i}
            data-bio-population={names[i] || meanings[i]?.name || `Population ${i + 1}`}
            className="inline-flex items-baseline gap-1.5 text-2xs text-[var(--text-tertiary)]"
          >
            {/* A bar, not a square — the same shape as this population's stretch
                of the strip under the chart, so the two read as one thing. */}
            <span
              aria-hidden
              className="inline-block h-1.5 w-3 self-center rounded-[1px]"
              style={{ background: popColor(i) }}
            />
            <span className="text-[var(--text-secondary)]">{names[i] || meanings[i]?.name}</span>
            <span className={cn('font-mono tnum', 'text-[var(--text-primary)]')}>
              {((record.shares[i] ?? 0) * 100).toFixed(1)}%
            </span>
            <span className="font-mono tnum text-[var(--text-disabled)]">
              {property.label.toLowerCase()} {meanOf(record, i, fallbackMean(i))}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
