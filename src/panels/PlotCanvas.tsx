import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, BarChart3, ChevronDown, Grid3x3, Layers, LayoutGrid, Minus, Palette, Plus,
  ScatterChart, SlidersHorizontal, Spline, Waves, X,
} from 'lucide-react';
import { CONTOUR_BINS, contourLines } from '@/render/contours';
import { saturationCeiling, type FcsParameter } from '@/core/fcs/types';
import { createTransform, splitDecadeLabel, transformColumn, type AxisTick, type Transform, type TransformKind, type TransformSpec } from '@/core/transform';
import { PointIndex } from '@/render/PointIndex';
import {
  alphaForCount, gather, parseColor, ScatterRenderer, subsampleIndices, MAX_RENDERED_POINTS,
} from '@/render/ScatterRenderer';
import {
  makePanel, RAMP_NAMES, usePlot,
  type ColorLevelSettings, type DensityScale, type RampName, type TransformOverrides, type Viewport,
} from '@/state/plotStore';
import { RAMPS, sampleRamp } from '@/render/binning';
import type { ColorScaling, ColorStyle } from '@/render/colorLevels';
import { DENSITY_RESOLUTION, PANEL_VIEW_DEFAULTS } from '@/core/layout/panelDefaults';
import { useAxisRanges } from '@/state/axisRangeStore';
import { applyAxisLimits } from './axisRange';
import { PLOT_MARGIN } from '@/core/layout/geometry';
import { axisDomainFor, isUnmixedIndex, parametersFor, sampleColumn, useDerived } from '@/state/derivedStore';
import { useSpectral } from '@/state/spectralStore';
import { useTransformPrefs, transformFor } from '@/state/transformPrefs';
import { GATE_HINT_LIMIT, useUI } from '@/state/uiStore';
import { useWorkspace, type Sample } from '@/state/workspaceStore';
import { Button, IconButton } from '@/ui/Button';
import { Checkbox, Field, Slider, Switch, TextInput } from '@/ui/Field';
import { Badge, ColorChip } from '@/ui/Feedback';
import { FloatingPanel } from '@/ui/FloatingPanel';
import { Popover } from '@/ui/Popover';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { VDivider } from '@/ui/Panel';
import { cn } from '@/ui/cn';
import { ParameterPicker } from './ParameterPicker';
import { resolveSpec, TransformControl } from './TransformControl';
import {
  GateLayer, GATE_CASING, GATE_INK, gateInk, PendingPolygon,
  PENDING_CASING, PENDING_FILL, PENDING_FILL_OPACITY, PENDING_STROKE,
} from './GateLayer';
import { DensityLayer, drawDensity } from './DensityLayer';
import { HistogramLayer, histogramRows, type HistogramSeries } from './HistogramLayer';
import { FitOverlay, useFitOverlayRows } from './FitOverlay';
import { plotCaption, plotFileName } from '@/core/plotExport';
import { FigureExport, type FigureSource } from './FigureExport';
import { composePlotFigure, type FigureFit, type FigureGate, type FigureHistogram, type PlotFigureModel } from '@/core/figure/plotFigure';
import { FIGURE_INK, PAPER_POPULATION, paperColor, type FigureStyle } from '@/core/figure/style';
import { transformLabel, unitOf } from '@/core/figure/units';
import { useFigure } from '@/state/figureStore';
import { conditionColor } from './groupColors';
import { gateHue } from './populationColors';
import { boundsOf, ellipseFromDrag, normaliseRect, reprojectGate, scalePolygon, simplifyPolygon, translateGate } from '@/core/gating/geometry';
import { QUADRANT_LABELS } from '@/core/gating/geometry';
import { isGeometric, usesAxes, type Gate } from '@/core/gating/types';
import { childrenOf, maskToIndices, populationPath } from '@/core/gating/tree';
import { gateParentFor } from '@/core/layout/openPanel';
import { suggestGateName } from '@/core/gating/suggestName';
import { openPanelForPopulation } from '@/state/layoutActions';
import { selectGateOnly, selectPanelOnly, togglePanelSelection } from '@/state/selection';
import { defaultGateName, defaultSpecFor, evaluateFor, nextGateId, useGates } from '@/state/gateStore';
import { useVisibleGates } from '@/state/gateVisibility';
import { CLOSE_SNAP_PX, isNearPolygonClose, plotCursor } from './plotCursor';
import { isOverGateHandle } from './gateHitTest';
import { gatesOnPanel, rangeAxisOn } from './panelGates';
import { NO_DRAG_SELECTOR, PLOT_CONTROL_SELECTOR, shouldMovePanel } from './panelDragTarget';
import {
  beginGateDrag, onPointerMove as machineMove, onPointerUp as machineUp, type GateDragState,
} from './gateDragMachine';

// Shared with the worksheet, which has to know how tall a panel of a given width
// will be before it renders one. See `core/layout/geometry.ts`.
const MARGIN = PLOT_MARGIN;

/** What each tool expects, in the words of the gesture rather than the model. */
const GATE_HINTS: Record<string, string> = {
  rectangle: 'Drag a box. Release to finish.',
  ellipse: 'Drag to size the ellipse. Release to finish.',
  polygon: 'Click to add points. Click the first point again to finish.',
  quadrant: 'Click once to place the four-way split.',
  range: 'Drag across the axis. Release to finish.',
};
/**
 * Fraction of the display span left blank at each edge when auto-fitting.
 *
 * ## Why it is 6% and not 3% (2026-08-19)
 *
 * Reported as *"the CD8 population sits close enough to the right edge that it
 * is genuinely unclear whether events are being cut off"* — and the reader was
 * right to be unsure, because at 3% the outermost event drew 2.9% of the square
 * from the frame, which at a normal panel width is eleven pixels. A margin that
 * small does not read as a margin; it reads as a population that has been
 * sliced. The number a person needs here is not "enough space to draw the
 * event", it is **enough space to see that there is space**.
 *
 * This is the padding for an axis framed on its own measured extent, where the
 * outermost event is by construction exactly this far in. `DECLARED_PAD` is the
 * other case and is larger, for a reason stated there.
 */
const FIT_PAD = 0.06;

/**
 * The same, for an axis that declares its own domain.
 *
 * Two parameters answer `axisDomainFor` and they arrive here for opposite
 * reasons. An **unmixed abundance** declares nothing, so a domain is computed
 * for it; a **scatter channel** declares one, and framing on its events instead
 * is what let a stray minimum move the axis between tubes. The paragraphs below
 * are about the first — they are what set the number — and the second is
 * covered by it comfortably: `$PnR` contains every event by construction, so
 * the only thing this margin has to do there is keep the saturation pile off
 * the frame line, which 10% of full scale does several times over. One
 * constant, because two would be a difference nobody could state.
 *
 * Larger than `FIT_PAD`, because the two cases put different things at the
 * frame. A measured
 * extent ends at the last event, so `FIT_PAD` is measured from the last event. A
 * declared domain ends at the **99th percentile**, widened and then snapped to a
 * round number in *data* units — and a fixed proportion of a data value is not a
 * fixed proportion of a biexponential axis. Across multicolour samples and
 * their abundances the snap contributed anywhere from a fraction of a percent
 * of the square to a fifth of it, so the margin beyond the population ranged
 * widely with no rule to it. The tight end is the reported defect and
 * the loose end is why it was not obvious.
 *
 * Setting the floor here rather than in the domain is deliberate: the domain is
 * in data units and is what the axis is labelled in, what gets typed into the
 * range fields, and what two samples of one panel have to agree on for their
 * plots to be comparable — the rounding is what buys that agreement. The margin
 * is a question about the picture, so it is answered in the picture's units.
 *
 * At 10% the worst case over that measurement becomes 8.3% of the square and the
 * typical case 12–25%, against a raw detector's 14–17%. The middle 98% still
 * occupies 65–80% of the axis, where a raw detector's occupies 27–57%.
 */
const DECLARED_PAD = 0.10;

/**
 * Why a shape cannot be drawn on a histogram (2026-08-11, Item 16).
 *
 * A histogram's y axis is **normalised event density**, not a measurement — the
 * curve's height is a property of the binning and of every other event in the
 * distribution, so a rectangle, an ellipse, a polygon or a quadrant drawn on it
 * would enclose a region whose vertical extent means nothing about any single
 * cell. `GateLayer` has known this since it was written and refuses to *render*
 * a geometric gate here (`oneDimensional`), so a shape drawn on a histogram
 * became a population that was in the tree, in the statistics table and in the
 * export while being invisible on the plot that produced it.
 *
 * Stated as a sentence rather than by disabling the toolbar. The tool control is
 * in the sidebar and applies to every panel at once, so greying it out would
 * make a worksheet holding one histogram and three scatter plots unable to gate
 * any of them; and a control that goes grey for a reason two panels away is a
 * question rather than an answer. The refusal happens where the gesture does,
 * and says what to do instead.
 */
/**
 * The y axis of every histogram, fixed.
 *
 * Density runs 0 to 1 by construction — `bin1d` divides by the modal bin — so
 * the grid is the same on every panel and never depends on the data. Built once
 * at module scope rather than per render, which also keeps the `useMemo` in
 * `yTicks` referentially stable while a user drags a gate across the plot.
 */
const DENSITY_TICKS: AxisTick[] = [0, 0.25, 0.5, 0.75, 1].map((v) => ({
  display: v,
  value: v,
  // No trailing zeros — 0.5, not 0.50 — on the axis and in every figure of it.
  label: String(v),
}));

/** The y axis label a histogram shows in place of a parameter picker. */
const DENSITY_AXIS_LABEL = 'Normalised count';

const HISTOGRAM_GATE_REFUSAL =
  'Only line gates are supported on histogram plots — the vertical axis is event density, not a parameter. '
  + 'Pick the line tool, or switch this plot to Dot or Density.';

/**
 * The same refusal at length, on the notice's own tooltip.
 *
 * A panel opens at 290 px and the message is drawn inside its plot rectangle, so
 * the sentence on screen has to be four lines rather than twelve — at twelve it
 * covered the histogram it was talking about, which is a poor way to explain
 * that the histogram is the problem. The reasoning is a hover away for anyone
 * who wants it.
 */
const HISTOGRAM_GATE_REFUSAL_WHY =
  'A histogram plots one parameter; its height is the number of events in each bin, which is a property of the '
  + 'binning and of every other event in the distribution. A rectangle, an ellipse, a polygon or a quadrant drawn '
  + 'here would enclose a region whose vertical extent means nothing about any one cell — so the gate would be '
  + 'counted in the tree, the statistics table and the export while being invisible on the plot that produced it.';

export function PlotCanvas({
  sample, panelId, compact, panelActions, onMovePointerDown, moving,
}: {
  sample: Sample;
  panelId: string;
  compact?: boolean;
  /** Remove control and the like, rendered in the toolbar so nothing overlaps it. */
  panelActions?: React.ReactNode;
  /**
   * Start moving the whole panel around the worksheet.
   *
   * Called from the panel's **background** — every part of it. The rail on the
   * left edge that used to be the only way in is gone: it was one small thing to
   * aim at before any arrangement could be made, on a worksheet that is arranged
   * constantly. What must not move a panel is a control, a resize handle or a
   * gate, and `panelDragTarget.ts` says so directly instead of by only offering
   * twelve safe pixels.
   */
  onMovePointerDown?: (e: React.PointerEvent) => void;
  /** This panel is mid-move, for the `grabbing` cursor. */
  moving?: boolean;
}) {
  const panel = usePlot((s) => s.panels.find((x) => x.id === panelId));
  const isActive = usePlot((s) => s.activePanelId === panelId);
  const {
    setAxis, setTransform, toggleGrid, initialiseFor,
    setPointSize, setAlpha, setOverride, clearOverrides, setPlotType,
    setDensityScale, setBinCount, setSmoothing, setActivePanel,
    setColorLevels, restoreColorLevels, setLabelOffset,
  } = usePlot();
  const allSamples = useWorkspace((s) => s.samples);

  // A panel can be removed while its canvas is still mounted for one frame. The
  // stand-in comes from `makePanel` rather than being spelled out again: there are
  // eleven colour-level fields now, and a second literal listing them is a second
  // place for the defaults to drift out of step with `panelDefaults.ts`.
  const fallbackPanel = useMemo(() => makePanel(), []);
  const {
    xParam, yParam, xTransform, yTransform, xOverrides, yOverrides,
    pointSize, alpha, showGrid, populationId,
    plotType, densityScale, ramp, binCount, smoothing, smoothingAuto, outlierSize, overlayIds,
    colorStyle, colorScaling,
    xMin: xMinLimit, xMax: xMaxLimit, yMin: yMinLimit, yMax: yMaxLimit,
  } = panel ?? fallbackPanel;

  /**
   * A histogram's y axis is normalised count, not a parameter.
   *
   * Named once because the gate layer, the handle hit test, the reprojection and
   * the drag all ask, and a panel keeps whatever `yParam` it last had when the
   * plot type changes — so "is `yi` a real axis?" cannot be answered from `yi`.
   */
  const oneDimensional = plotType === 'histogram';

  /**
   * The colour-level mapping, in the shape the renderer takes.
   *
   * Memoised because `DensityLayer` redraws on any change of identity, and a fresh
   * object on every render would re-bin a million cells whenever anything else in
   * the app re-rendered this canvas.
   */
  const levels = useMemo(
    () => ({ style: colorStyle, scaling: colorScaling }),
    [colorStyle, colorScaling],
  );


  // Re-draw when the theme flips: point colour and alpha are theme-dependent.
  const theme = useUI((s) => s.theme);
  // Double-clicking an axis points the inspector's axis settings at it. The
  // settings are a panel rather than a popover so they can be left open while
  // several plots are compared; this is the shortcut into them, not the only way.
  const focusAxis = useUI((s) => s.focusAxis);
  /** The whole panel, chrome included — the boundary a gate drag is tested against. */
  const rootRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const rendererRef = useRef<ScatterRenderer | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [glFailed, setGlFailed] = useState(false);
  /**
   * The smoothing window the density draw actually used.
   *
   * Only interesting under Auto, where it is a property of the binned grid; the
   * settings panel shows it so "Auto" is a number the user can read rather than
   * a word they have to trust.
   */
  const [resolvedSmoothing, setResolvedSmoothing] = useState(smoothing);
  /**
   * A gate label being renamed in place, and where its editor sits.
   *
   * An HTML input rather than anything inside the SVG: a `foreignObject` is the
   * only way to put one there and it brings its own focus and sizing problems on
   * a surface that is already carefully layered. The editor is positioned over
   * the plot at the label's own coordinates, so it appears exactly where the
   * text was.
   */
  const [renamingLabel, setRenamingLabel] = useState<{ gateId: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; index: number } | null>(null);

  const md = sample.parsed.metadata;

  useEffect(() => { initialiseFor(panelId, sample.id, md); }, [sample.id, md, initialiseFor]);

  /* ---------------- Data pipeline ---------------- */

  // Pipeline order is raw -> transformed -> display. There is no compensation
  // stage: conventional spillover correction is gone, and spectral unmixing
  // produces its own parameters rather than rewriting these.

  // Derived parameters continue the index space past the end of the file's own,
  // so `xParam`/`yParam` stay plain numbers and everything downstream — the
  // picker, the transform, the gate — is unaware there are two kinds. Unmixed
  // abundances continue it once more, past the derived block.
  const derivedDefs = useDerived((s) => s.defs);
  /*
     The signal, not the data.

     `parametersFor` and `sampleColumn` read the abundances out of the registry
     keyed by this sample's `ParsedFcs`, which is a WeakMap and therefore has no
     subscribers. This is what re-runs the memos when a matrix is applied: the
     record is replaced wholesale by `runUnmixing` and by `clearUnmixed`, so its
     identity changing is exactly "the set of unmixed parameters has moved".
  */
  const unmixedResults = useSpectral((s) => s.unmixed);
  const params = useMemo(
    () => parametersFor(sample.parsed, derivedDefs),
    [sample.parsed, derivedDefs, unmixedResults],
  );

  // Clamp axis indices when switching to a sample with fewer parameters, or when
  // a derived parameter the panel was showing has since been deleted.
  const xi = Math.min(xParam, params.length - 1);
  /*
     The Biophysics fit as rows on this panel's bins — computed once and drawn
     twice: by `FitOverlay` on screen, and into an exported figure, which reads
     the same arrays. A panel that is not a histogram asks nothing.
  */
  const fitRows = useFitOverlayRows({
    sample: plotType === 'histogram' ? sample : undefined, xParam: xi, binCount, smoothing,
  });
  const yi = Math.min(yParam, params.length - 1);
  const px = params[xi];
  const py = params[yi];

  const rawX = useMemo(
    () => sampleColumn(sample.parsed, xi, derivedDefs),
    [sample.parsed, xi, derivedDefs, unmixedResults],
  );
  const rawY = useMemo(
    () => sampleColumn(sample.parsed, yi, derivedDefs),
    [sample.parsed, yi, derivedDefs, unmixedResults],
  );

  // Specs are derived from the data — logicle's width basis is estimated from
  // the channel's own negative tail — then user overrides are layered on top.
  // A derived parameter can run negative, so its linear axis needs a floor
  // below zero or the whole lower half of the plot gets no tick and no gridline.
  const specX = useMemo(
    () => withFloor(resolveSpec(xTransform, px?.range ?? 1, rawX, xOverrides), px, rawX),
    [xTransform, px, rawX, xOverrides],
  );
  const specY = useMemo(
    () => withFloor(resolveSpec(yTransform, py?.range ?? 1, rawY, yOverrides), py, rawY),
    [yTransform, py, rawY, yOverrides],
  );

  /**
   * The axes of this plot that are unmixed abundances rather than detectors.
   *
   * Named rather than counted, because the badge's hint has to say *which* — a
   * plot with `CD4 RB744` against `SSC-A` is half unmixed and that is the common
   * case. `unmixedResults` is in the deps for the reason recorded above: the
   * registry is a `WeakMap` and has no subscribers, so the store record changing
   * identity is the signal that the set of unmixed parameters has moved.
   */
  const unmixedAxes = useMemo(() => {
    const out: string[] = [];
    if (isUnmixedIndex(sample.parsed, xi, derivedDefs)) out.push(px?.label ?? 'x');
    if (yi !== xi && isUnmixedIndex(sample.parsed, yi, derivedDefs)) out.push(py?.label ?? 'y');
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample.parsed, xi, yi, px, py, derivedDefs, unmixedResults]);

  const tx = useMemo(() => createTransform(specX), [specX]);
  const ty = useMemo(() => createTransform(specY), [specY]);

  /**
   * Display-space columns. Transforms run on the CPU once per
   * (sample × parameter × transform) so the shader only ever does a linear map.
   */
  const displayX = useMemo(() => transformColumn(rawX, tx), [rawX, tx]);
  const displayY = useMemo(() => transformColumn(rawY, ty), [rawY, ty]);

  /* ---------------- Gating ---------------- */

  // Ahead of the view geometry on purpose: a panel scoped to a population takes
  // its bounds, its subsample and its hit-test index from that population's
  // events alone, and the scope falls out of the evaluated tree.

  const gateTool = useGates((s) => s.tool);
  const selectedGateId = useGates((s) => s.selectedGateId);
  const pendingPolygon = useGates((s) => s.pendingPolygon);
  const { addGate, updateGate, setPendingPolygon, setTool: setGateTool } = useGates();

  // The shared strategy, unless this sample has been forked off it — and
  // without the unmixing wizard's gates unless this is one of its worksheets
  // (2026-08-12, Item 11). One hook, so a panel re-renders when whichever list
  // applies to it changes and when the layout kind does.
  const gates = useVisibleGates(sample.id);

  // Gates on the displayed axes evaluate against exactly the columns already
  // computed for the plot; gates on other parameters fall back to the shared
  // display-column cache.
  //
  // Always over the *whole* sample, never the scoped subset: a population is its
  // own geometry intersected with its parent's, so the tree only makes sense
  // evaluated top-down over every event. Scoping is applied to what gets drawn,
  // afterwards.
  /*
     **The fallback is `defaultSpecFor`, exactly as it is everywhere else.**

     This used to pass the panel's own `specX`/`specY` for whichever parameters
     were on its axes, on the reasoning that a gate is stored in display space
     and the panel is the display. The reasoning was right and the consequence
     was Item 17: a gate carried no record of which display space it meant, so
     the panel evaluated it in one and the gate tree, the statistics table and
     the export evaluated it in another. One gate, two sizes — nearly a factor
     of two apart with one transform switched.

     A gate now names its own space (`xSpec`/`ySpec`) and `evaluateFor` reads it,
     so this argument is only a fallback for gates drawn before that field
     existed. Every caller passing the same fallback is what makes "how big is
     this population?" have one answer.
  */
  const evaluated = useMemo(() => {
    if (gates.length === 0) return null;
    return evaluateFor(sample.id, sample.parsed, gates, (p) => defaultSpecFor(sample.parsed, p));
  }, [gates, sample.id, sample.parsed]);

  /**
   * The population this panel is **actually** plotting.
   *
   * Not simply `populationId`: a scope pointing at a gate that has since been
   * deleted falls back to every event, which is what `scope` below does, and the
   * two have to agree. A panel drawing all events while claiming a population
   * that no longer exists would, under the rule in `panelGates.ts`, show no
   * gates at all — a plot that looks broken rather than one that has recovered.
   */
  const scopeId = useMemo(
    () => (populationId && evaluated?.masks.has(populationId) ? populationId : null),
    [populationId, evaluated],
  );

  /**
   * The gates this panel is entitled to draw.
   *
   * **A scoped panel draws its own population's children and nothing else.** The
   * whole argument is in `panels/panelGates.ts`; the short version is that a
   * gate's boundary and its percentage are both statements about its *parent's*
   * events, so drawing one over a different population produces a caption that
   * reads like a result and is not one. Two panels dragged out of sibling
   * populations get the same axes by construction, which is how a CD8 plot came
   * to be showing CD4's gates.
   *
   * Applied here, above `viewGates`, so that **one** list feeds the layer, the
   * handle hit test and the drag. A gate that cannot be seen on this panel must
   * also not be grabbable on it, and deriving those three from three different
   * filters is the missing-priority shape PROGRESS.md already records.
   *
   * `gates` — unfiltered — stays the list for anything reading a gate's
   * *identity*: the evaluated tree, the breadcrumb's scope gate and the
   * population path all need the whole hierarchy.
   */
  const panelGates = useMemo(() => gatesOnPanel(gates, scopeId), [gates, scopeId]);

  /**
   * The gates as **this panel** draws them.
   *
   * A gate is evaluated in the space it was drawn in, whatever this panel is
   * currently showing that parameter under — so if the two differ, the stored
   * coordinates have to be moved into this panel's space or the shape lands
   * somewhere other than the events it selects. `reprojectGate` returns the gate
   * unchanged when the spaces match, which is every gate on a panel nobody has
   * retransformed, so the common case allocates nothing.
   *
   * Everything that reads geometry off a gate for the screen — the layer, the
   * handle hit test, the drag — reads this list. Everything that reads a gate's
   * *identity* reads the real one.
   */
  const viewGates = useMemo(
    () => panelGates.map((g) => reprojectGate(
      g,
      // A range gate's bounds live on `xSpec` whichever axis this panel draws
      // it against, so the space to move them *into* is this panel's spec for
      // that axis — `specY` when the parameter it cuts is the one on y.
      rangeAxisOn(g, xi, yi, oneDimensional) === 'y' ? specY
        : g.xParam === xi ? specX : undefined,
      g.kind !== 'range' && g.yParam === yi ? specY : undefined,
    )),
    [panelGates, xi, yi, specX, specY, oneDimensional],
  );

  /**
   * Stamped onto every geometry write this panel makes.
   *
   * A drag happens in the space on screen, so the gate it produces is expressed
   * in that space and says so. Writing the coordinates without the specs is what
   * created the ambiguity in the first place, so the two always travel together.
   *
   * A range gate has one spec, `xSpec`, naming the space its two bounds are in —
   * and on a plot that draws it against **y** that space is the panel's y spec.
   * Stamping `specX` there would say the bounds are in a space they are not,
   * which is the Item 17 ambiguity arriving by a new route: the numbers would be
   * read back under the wrong transform on any plot that showed them differently.
   */
  const panelSpace = useCallback(
    (kind: Gate['kind'], rangeAxis: 'x' | 'y' = 'x') => (kind === 'range'
      ? { xSpec: rangeAxis === 'y' ? specY : specX }
      : { xSpec: specX, ySpec: specY }),
    [specX, specY],
  );

  /* ---------------- Population scope ---------------- */

  /**
   * Event indices this panel is showing, or null for all of them.
   *
   * A panel dragged out of the gate tree is scoped to that population: it plots
   * only those events, so the next gate is drawn against the subset rather than
   * against a full cloud with one region highlighted.
   */
  const scope = useMemo<Uint32Array | null>(() => {
    // `scopeId`, not `populationId`: it is the same question with the
    // deleted-gate fallback already applied, and the gate list above is keyed by
    // it. Two readings of "which population is this panel showing" is exactly
    // the divergence this file has been bitten by before.
    if (!scopeId || !evaluated) return null;
    const mask = evaluated.masks.get(scopeId);
    // A scope pointing at a deleted gate falls back to everything, which is
    // recoverable; showing nothing would look like a broken plot.
    return mask ? maskToIndices(mask) : null;
  }, [scopeId, evaluated]);

  const viewX = useMemo(() => (scope ? gather(displayX, scope) : displayX), [displayX, scope]);
  const viewY = useMemo(() => (scope ? gather(displayY, scope) : displayY), [displayY, scope]);

  /** The gate this panel is scoped to, for the header breadcrumb. */
  const scopeGate = useMemo(
    () => (populationId ? gates.find((g) => g.id === populationId) ?? null : null),
    [populationId, gates],
  );
  const scopePath = useMemo(
    () => (scopeGate ? populationPath(gates, scopeGate.id).split('/') : []),
    [scopeGate, gates],
  );

  // Rendering may subsample; statistics never do.
  const sub = useMemo(() => subsampleIndices(viewX.length), [viewX.length]);
  const renderX = useMemo(() => (sub ? gather(viewX, sub) : viewX), [viewX, sub]);
  const renderY = useMemo(() => (sub ? gather(viewY, sub) : viewY), [viewY, sub]);

  /**
   * The extent the axes are framed on: **the whole sample, not this panel's
   * population** (2026-08-16).
   *
   * `displayX`/`displayY` are every event in the file on these two parameters;
   * `viewX`/`viewY` are the subset this panel is scoped to. Fitting to the
   * subset is what made a gated plot re-zoom: drag *Live* out of the tree onto
   * FSC-A × SSC-A and the axes closed in around the live cells, so the child
   * plot could not be laid beside its parent and read as the same picture with
   * a region marked. Every downstream gate then inherited the reframing, and by
   * the fourth level the scatter axes bore no relation to the ones the operator
   * drew the first gate on.
   *
   * It is also the rule the rest of the panel already follows. *A plot's data
   * view is fixed* — no pan, no zoom, and axis limits are configuration typed in
   * data units, never a consequence of a gesture. Drawing a gate is a gesture,
   * and letting it move the axes underneath is the same defect that removed box
   * zoom, arriving by a different route.
   *
   * A population that occupies a tenth of the axis therefore draws in a tenth of
   * the axis, which is the honest picture: that is how much of the parent it is.
   * Somebody who wants it filling the square types the range into the axis
   * fields, where the choice is visible and copyable to the panel beside it.
   */
  /**
   * …**except on an axis that declares its own domain** (2026-08-17).
   *
   * `axisDomainFor` answers `null` for a fluorescence detector, so everything
   * above is unchanged for every plot the paragraph was written about. It
   * answers a range for two parameters where the data extent is the wrong thing
   * to frame on, and **a scatter channel** is one of them (2026-08-27): its
   * ceiling is `$PnR` on every tube and its floor is a single stray event, which
   * moved the first plot's axes — and the population with them — from sample to
   * sample. `scatterDomain` has the measurement.
   *
   * The other is an **unmixed abundance**, and there the data extent is wrong
   * to frame on: an abundance is a least-squares solve with a residual tail at
   * both ends, so its extremes are two events rather than a measurement. An
   * abundance can run two orders of magnitude past its first percentile, and
   * framing on it put a third of the plot below the first percentile — the population squeezed into a band, which is exactly
   * what a detector plot does not do. See `unmixedBounds`.
   *
   * Still no gesture, and still not a zoom: the domain is a property of that
   * parameter on that file, computed once, identical on every panel showing it,
   * and the typed axis limits fold on top of it exactly as before.
   */
  const declaredX = useMemo(
    () => axisDomainFor(sample.parsed, xi, derivedDefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample.parsed, xi, derivedDefs, unmixedResults],
  );
  const declaredY = useMemo(
    () => axisDomainFor(sample.parsed, yi, derivedDefs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sample.parsed, yi, derivedDefs, unmixedResults],
  );

  const dataBounds = useMemo(() => {
    const measured = extent(displayX, displayY);
    return {
      xMin: declaredX ? tx.forward(declaredX.min) : measured.xMin,
      xMax: declaredX ? tx.forward(declaredX.max) : measured.xMax,
      yMin: declaredY ? ty.forward(declaredY.min) : measured.yMin,
      yMax: declaredY ? ty.forward(declaredY.max) : measured.yMax,
    };
  }, [displayX, displayY, declaredX, declaredY, tx, ty]);

  const fitted = useMemo<Viewport>(() => {
    // Per axis, because the two axes can be different kinds of parameter — an
    // abundance against a detector is the ordinary case on this dataset.
    const padX = (dataBounds.xMax - dataBounds.xMin) * (declaredX ? DECLARED_PAD : FIT_PAD) || 0.5;
    const padY = (dataBounds.yMax - dataBounds.yMin) * (declaredY ? DECLARED_PAD : FIT_PAD) || 0.5;
    return {
      xMin: dataBounds.xMin - padX,
      xMax: dataBounds.xMax + padX,
      yMin: dataBounds.yMin - padY,
      yMax: dataBounds.yMax + padY,
    };
  }, [dataBounds, declaredX, declaredY]);

  /**
   * Where the plot is looking: the whole of its data, unless a limit says
   * otherwise.
   *
   * Still no pan and no zoom — nothing here comes from a gesture. What can move
   * it is a number typed into the axis settings, which is a stated part of the
   * panel's configuration rather than a side effect of a drag, and is saved,
   * shown and copyable to the panel beside it. See `axisRange.ts`.
   *
   * The limits are in **data units**, because that is what the axis is labelled
   * in and what anyone would type; the viewport is in display units, after the
   * transform. So they are pushed through `forward` here rather than the user
   * being asked to think in logicle space.
   *
   * A histogram's y axis is normalised density rather than a data parameter, so
   * it is always [0,1] regardless of what the y parameter would have framed.
   */
  const view = useMemo<Viewport>(
    () => applyAxisLimits(
      fitted,
      {
        xMin: xMinLimit === null ? null : tx.forward(xMinLimit),
        xMax: xMaxLimit === null ? null : tx.forward(xMaxLimit),
        yMin: yMinLimit === null ? null : ty.forward(yMinLimit),
        yMax: yMaxLimit === null ? null : ty.forward(yMaxLimit),
      },
      plotType === 'histogram',
    ),
    [fitted, plotType, tx, ty, xMinLimit, xMaxLimit, yMinLimit, yMaxLimit],
  );

  /**
   * Where each axis's detector saturates, in display units — or null.
   *
   * Events off scale pile up exactly there, and on an Aurora tube that row is the
   * densest cell of the plot. The density levels leave it out and the figure
   * export can leave it out of the picture; both ask `saturationCeiling`, so
   * there is one answer to "where is the pile".
   */
  const densityCeilings = useMemo(() => {
    const at = (p: FcsParameter | undefined, t: Transform) => {
      const top = saturationCeiling(p);
      return top === null ? null : t.forward(top * (1 - 1e-7));
    };
    return { x: at(px, tx), y: oneDimensional ? null : at(py, ty) };
  }, [px, py, tx, ty, oneDimensional]);

  /**
   * Every density setting, in one object, spread into both draws.
   *
   * The on-screen layer and the image exporter each call the same binning code,
   * and the only thing that may differ between them is the size of the canvas it
   * lands on. Listing the settings twice is how that stopped being true:
   * `smoothingAuto` was passed to the layer and forgotten by the exporter, and
   * because smoothing runs **before** the colour mapping normalises against the
   * peak, an exported figure of a 15 000-event tube came out as a green speckle
   * where the plot on screen was a smooth blue-to-red field. Same events, same
   * ramp, different picture. One object, spread twice, cannot drift.
   *
   *  - `mask: null` — never the selection mask. `bin2d` *skips* unmasked events
   *    rather than dimming them, so passing the highlight here did not
   *    de-emphasise the events outside the selected gate, it deleted them from
   *    the histogram, and every density panel silently collapsed onto whichever
   *    gate was last drawn. A panel plots its own population; what is selected in
   *    the tree is not part of that question.
   *  - `levels` — everything the colour-levels panel decides. Percentile styling
   *    by default, so the ramp spreads over this plot's own event distribution
   *    rather than over a count range it has no way to know.
   *  - `smoothing` / `smoothingAuto` — under Auto a bandwidth in data units
   *    that narrows with the events the plot holds; see `autoSmoothing`.
   *  - `ceilings` — where each detector saturates. The pile there is drawn and
   *    never sets the levels: it is the densest cell on an Aurora tube.
   *  - `outlierSize` — enlarges an isolated cell so it survives the downscale
   *    onto the panel. It does **not** recolour one; that was the removed outlier
   *    band, and the difference is why the Colour scaling control works.
   */
  const densitySpec = useMemo(
    () => ({
      bins: binCount, scale: densityScale, ramp, mask: null,
      levels, smoothing, smoothingAuto, outlierSize, ceilings: densityCeilings,
    }),
    [binCount, densityScale, ramp, levels, smoothing, smoothingAuto, outlierSize, densityCeilings],
  );

  /**
   * Publish the auto extent so the inspector's range fields have something to
   * show. In data units, for the same reason the limits are read in them.
   */
  const noteRange = useAxisRanges((s) => s.note);
  useEffect(() => {
    noteRange(panelId, {
      xMin: tx.inverse(fitted.xMin), xMax: tx.inverse(fitted.xMax),
      yMin: ty.inverse(fitted.yMin), yMax: ty.inverse(fitted.yMax),
    });
  }, [noteRange, panelId, fitted, tx, ty]);

  const index = useMemo(
    () => new PointIndex(viewX, viewY, dataBounds.xMin, dataBounds.xMax, dataBounds.yMin, dataBounds.yMax),
    [viewX, viewY, dataBounds],
  );

  /**
   * Which rendered points belong to the selected population.
   *
   * Used to **mark** them in the population's own colour, not to fade everything
   * else. Dimming the rest was the previous convention and it read as the plot
   * losing its data the moment a gate was clicked — which also made back-gating,
   * the thing dimming was meant to serve, harder rather than easier.
   */
  const highlightMask = useMemo(() => {
    if (!evaluated || !selectedGateId) return null;
    const full = evaluated.masks.get(selectedGateId);
    if (!full) return null;
    // Two gathers, in pipeline order: full events → this panel's population →
    // the render subsample. Skipping the first would index a scoped plot with a
    // full-length mask and mark the wrong points.
    const inScope = scope ? gatherMask(full, scope) : full;
    return sub ? gatherMask(inScope, sub) : inScope;
  }, [evaluated, selectedGateId, scope, sub]);

  /** The selected population's palette colour, for the highlight. */
  const highlightColorIndex = useMemo(
    () => gates.find((g) => g.id === selectedGateId)?.colorIndex ?? null,
    [gates, selectedGateId],
  );

  /** Its name, for the histogram legend that now carries the marked series. */
  const selectedGateName = useMemo(
    () => gates.find((g) => g.id === selectedGateId)?.name ?? null,
    [gates, selectedGateId],
  );

  useEffect(() => {
    rendererRef.current?.setMask(highlightMask);
  }, [highlightMask, renderX]);

  /* ---------------- Geometry ---------------- */

  // One margin for every plot type. A density plot used to surrender 46 px on
  // the right to its colour bar, which made its square meaningfully smaller than
  // a dot plot's at the same panel width — the bar cost more of the graph than
  // it explained, and the density scaling is already named in the toolbar.
  const plotW = Math.max(0, size.w - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, size.h - MARGIN.top - MARGIN.bottom);

  /**
   * Height that makes the **plot area** square, chrome excluded.
   *
   * A cytometry plot is two measurements of the same kind against each other,
   * and the shape of a cloud is read off the aspect ratio — a population that is
   * round at 1:1 becomes an ellipse at 2:1 and looks like a different
   * population. So the square is imposed on the data rectangle and the axis
   * margins are added back on top rather than eaten out of it.
   *
   * Independent of `plotType` now that nothing claims a strip on the right, so
   * dot, density and histogram all draw the same square at the same panel width
   * and switching between them never reshapes anything.
   *
   * There is no feedback loop: the observer measures width from the grid
   * column, and only the height is written back.
   */
  const squareHeight = size.w > 0
    ? Math.max(120, size.w - MARGIN.left - MARGIN.right + MARGIN.top + MARGIN.bottom)
    : undefined;

  const toPixelX = useCallback((v: number) => ((v - view.xMin) / (view.xMax - view.xMin)) * plotW, [view, plotW]);
  const toPixelY = useCallback((v: number) => plotH - ((v - view.yMin) / (view.yMax - view.yMin)) * plotH, [view, plotH]);
  const toDataX = useCallback((p: number) => view.xMin + (p / plotW) * (view.xMax - view.xMin), [view, plotW]);
  const toDataY = useCallback((p: number) => view.yMin + ((plotH - p) / plotH) * (view.yMax - view.yMin), [view, plotH]);

  /*
     Ticks are asked for over the range the axis is **showing**.

     They used to be asked for over the parameter's own declared domain and then
     filtered to the view, which is right for a decade axis and wrong for a
     linear one: `linearTicks` picks a nice step for the span it is given, so an
     axis explicitly ranged −1 to 1 over a parameter whose data runs −0.6 to 0.8
     got the step for 1.4 and labels that stopped at 0.8. The plot really was
     drawing −1 to 1 — the points were mapped through `view` — but nothing on the
     axis said so, which is indistinguishable from the range not being applied.
     The filter stays: a decade transform still answers with its own grid.
  */
  /*
     Nothing here knows about Time, and that is the point.

     A Time axis used to read `0 1M 2M 3M` — acquisition ticks abbreviated like a
     fluorescence channel, where `3M` is five minutes. The conversion is applied
     in `parametersFor`/`sampleColumn` (see `core/timeUnits.ts`), so by the time
     the column and its declared range reach this component they are in seconds,
     the linear transform picks nice steps over a span of tens rather than
     hundreds of thousands, and `formatTick` emits no magnitude suffix because
     there is no magnitude to suffix.
  */
  const xTicks = useMemo(
    () => visibleTicks(tx.ticks(6, [view.xMin, view.xMax]), view.xMin, view.xMax),
    [tx, view.xMin, view.xMax],
  );
  /*
     A histogram's y axis is normalised event density, and its ticks come from
     nowhere near the y parameter.

     The viewport has always been pinned to [0,1] here (see `view`), but the
     labels used to be asked of `ty` — the *y parameter's* transform — which
     answers for its own domain. A logicle transform asked to tick the span 0 to
     1 replies with channel values from the bottom of a fluorescence decade, so
     the axis read as a second parameter plotted against the first, and changing
     the y parameter changed the numbers. Density is a fraction of the modal
     bin; it gets a plain linear grid and no parameter at all.
  */
  const yTicks = useMemo(
    () => (plotType === 'histogram'
      ? DENSITY_TICKS
      : visibleTicks(ty.ticks(6, [view.yMin, view.yMax]), view.yMin, view.yMax)),
    [plotType, ty, view.yMin, view.yMax],
  );

  /* ---------------- Gate handle priority ---------------- */

  /**
   * The pixel mapping the handle targets are placed by.
   *
   * Held here rather than rebuilt inside the move handler so the plot and the hit
   * test are provably reading the *same* transform — a priority rule computed
   * from a stale one would put the exclusion zone somewhere the handles are not.
   */
  const hitContext = useMemo(
    () => ({
      toPixelX, toPixelY, xParam: xi, yParam: yi,
      oneDimensional, plotW, plotH,
    }),
    [toPixelX, toPixelY, xi, yi, oneDimensional, plotW, plotH],
  );

  /* ---------------- Renderer lifecycle ---------------- */

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      /*
         Only on a real change (2026-08-14).

         This wrote `setSize({ w, h })` unconditionally, which is a fresh object
         every callback, so React re-rendered on every delivery whether or not
         the panel had actually changed size. `PlotGrid`'s own observer has
         carried the identical guard — and a comment describing this exact
         hazard — since the worksheet was built: *"the canvas inside this
         container is sized from this measurement, so an unconditional set can
         be re-triggered by the scrollbar it causes to appear, and the two chase
         each other a frame at a time."* This component is the same shape and
         never got it.

         It matters more here than there. This panel writes `squareHeight` back
         onto its own wrapper — the plot area is square, so the height is
         computed from the measured width — so the element being observed is
         sized from the observation. That is a closed loop by construction, and
         the only thing keeping it quiet is that the numbers usually settle;
         with the state object replaced on every delivery, nothing *makes* them.

         A guarded write is also the difference between a resize costing one
         render and costing one per delivered frame for as long as the pointer
         is down.
      */
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new ScatterRenderer(canvasRef.current);
    rendererRef.current = r;
    setGlFailed(r.unavailable);
    return () => { r.dispose(); rendererRef.current = null; };
  }, []);

  useEffect(() => {
    rendererRef.current?.setData(renderX, renderY);
  }, [renderX, renderY]);

  /**
   * The point-cloud draw, stated once and scaled.
   *
   * The exporter re-renders into a larger backing store, and the *only* things
   * that may differ between that draw and this one are the size of the buffer
   * and the radius of a point — everything else is what the plot looks like.
   * Two literal option objects is how that stopped being true: the export forgot
   * `highlightColor`, so selecting a population coloured it on screen and left
   * every dot in the base colour in the saved figure. `scale` is the parameter,
   * and there is nothing else to get wrong.
   */
  const pointCloudDraw = useCallback((scale: number) => {
    const styles = getComputedStyle(document.documentElement);
    // A translucent mark loses more contrast against white than against near
    // black, so the same alpha reads noticeably fainter in the light theme.
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      width: plotW * scale,
      height: plotH * scale,
      color: parseColor(styles.getPropertyValue('--pop-01') || '#4cc9f0'),
      // The selected population is marked in its **own** palette colour, the one
      // the gate tree shows beside its name, so the plot and the tree agree
      // about which population is which.
      highlightColor: highlightColorIndex === null
        ? undefined
        : parseColor(styles.getPropertyValue(popVar(highlightColorIndex)) || '#f6bd60'),
      // Scaled too, or a 3x export would show pinprick dots in a plot three
      // times the size.
      pointSize: pointSize * scale,
      alpha: alpha ?? Math.min(0.9, alphaForCount(renderX.length) * (light ? 1.4 : 1)),
      background: [0, 0, 0, 0] as [number, number, number, number],
    };
    // `theme` is not read directly — it is what makes the computed styles above
    // change, so it has to be a dependency for them to be re-read.
  }, [plotW, plotH, pointSize, alpha, renderX.length, highlightColorIndex, theme]);

  useEffect(() => {
    const r = rendererRef.current;
    if (!r || plotW <= 0 || plotH <= 0) return;
    // Density and histogram modes draw their own layers; clear the point cloud
    // rather than leaving a stale frame beneath them.
    if (plotType !== 'scatter') {
      r.draw({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 }, {
        width: plotW, height: plotH, color: [0, 0, 0], pointSize: 0,
        alpha: 0, background: [0, 0, 0, 0],
      });
      return;
    }
    r.draw(view, pointCloudDraw(1));
  }, [view, plotW, plotH, plotType, pointCloudDraw, renderX, renderY]);

  /* ---------------- Overlay series for histograms ---------------- */

  /*
     Probability contours, when this is a contour plot: lines enclosing 10, 30,
     50, 70 and 90% of the events on screen, from the same events and view the
     map would draw. Computed once and drawn twice — here and into a figure. See
     `render/contours.ts`.
  */
  const contours = useMemo(
    () => (plotType === 'contour' && viewX.length > 0 ? contourLines(viewX, viewY, view) : null),
    [plotType, viewX, viewY, view],
  );

  const histogramSeries = useMemo<HistogramSeries[]>(() => {
    if (plotType !== 'histogram') return [];
    /*
       The whole distribution, always — and the selected population **beside**
       it rather than instead of it.

       This used to pass `highlightMask` as the one series' mask, and `bin1d`
       *skips* masked-out events rather than dimming them (the trap is recorded
       twice in PROGRESS.md, for `bin2d`). Selecting a gate therefore deleted
       every event outside it from the histogram, and selecting a gate is what
       grabbing its boundary does — so for the whole of a drag the negative
       population the gate is being positioned against was not on screen. The
       one thing you need to see while placing a threshold is where the two
       populations meet.

       Two series instead of a mask keeps what was good about it: the full
       distribution stays underneath the selection throughout the drag.

       **The two share a vertical scale as of 2026-08-11 (Item 11).** They were
       normalised independently, each to its own peak, so that a gate dragged
       into a sparse tail still filled the plot — and that is exactly what made
       the shaded region stop lining up with the curve and with the boundary
       line. The auto-scaling is gone with it, by request. The whole of the
       reasoning is on `HistogramLayer.curves`, where the fix is.
    */
    const own: HistogramSeries = {
      id: sample.id,
      label: sample.name,
      values: viewX,
      mask: null,
      colorIndex: 0,
    };
    const extras: HistogramSeries[] = [];
    if (highlightMask && !sub && highlightColorIndex !== null) {
      extras.push({
        id: `${sample.id}:selected`,
        label: selectedGateName ?? 'Selected',
        values: viewX,
        mask: highlightMask,
        colorIndex: highlightColorIndex,
        marked: true,
      });
    }
    overlayIds
      .filter((id) => id !== sample.id)
      .forEach((id, i) => {
        const s = allSamples.find((x) => x.id === id);
        if (!s || s.parsed.metadata.eventCount === 0) return;
        // Overlaid samples are transformed with the *active* spec so the axes
        // are directly comparable; using each sample's own auto-estimate would
        // silently shift the curves relative to one another. Through
        // `sampleColumn`, so a derived parameter overlays like any other.
        const col = sampleColumn(s.parsed, xi, derivedDefs);
        extras.push({
          id: s.id,
          label: s.name,
          values: transformColumn(col, tx),
          mask: null,
          colorIndex: i + 1,
        });
      });
    return [own, ...extras];
  }, [
    plotType, sample, viewX, highlightMask, highlightColorIndex, selectedGateName,
    sub, overlayIds, allSamples, xi, tx, derivedDefs,
  ]);

  /* ---------------- Interaction ---------------- */

  /**
   * Live drag state.
   *
   * `cx`/`cy` track the pointer here rather than only in `drawBox` React state, because pointerup can arrive in the same frame as the last
   * pointermove — Chromium coalesces moves, and a quick flick produces exactly
   * one. The handler React has attached then still closes over the pre-move
   * state, so committing from it drew a zero-size box and silently produced no
   * gate. The rendered rectangle stays in state; what gets committed comes from
   * the ref, which is always current.
   */
  const drag = useRef<
    { sx: number; sy: number; cx: number; cy: number } | null
  >(null);

  /**
   * A gate being dragged on the canvas — and where the pointer is relative to
   * this plot.
   *
   * One state machine, not two listeners, because the two outcomes are two
   * phases of the same gesture. `outside` flips when the pointer crosses this
   * panel's own boundary: inside, the drag moves the shape; outside, it becomes
   * "drop a new plot of this population here". Previously the move handler ran
   * unconditionally, so the out-of-bounds case was never reachable — the gate
   * simply followed the pointer off the plot and nothing was created.
   */
  const gateDrag = useRef<
    { handle: string; sx: number; sy: number; original: Gate; machine: GateDragState } | null
  >(null);
  /** Mirrors the machine's phase for rendering; refs do not re-render. */
  const [dragOutside, setDragOutside] = useState<{ x: number; y: number; name: string } | null>(null);
  /** Arms the window-level listeners below. State, because an effect keys off it. */
  const [gateDragging, setGateDragging] = useState(false);

  const [drawBox, setDrawBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /**
   * Pointer position in display units, tracked whenever a tool is armed.
   *
   * Two consumers: the polygon's rubber band, and the axis-value readout that
   * stands in for the per-event tooltip while drawing.
   */
  const [cursorData, setCursorData] = useState<{ x: number; y: number } | null>(null);
  /** Pointer is over the polygon's closable first vertex — drives cursor and target size. */
  const [overClose, setOverClose] = useState(false);

  /**
   * A gesture this plot has refused, and why.
   *
   * Set when a non-line tool is used on a histogram; cleared when the tool or the
   * plot type changes, since either of those is the user acting on the advice.
   * State rather than a toast because it belongs to *this panel* — a worksheet
   * can hold eight, and the one that refused the press is the one that has to
   * say so.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * When the per-event hover tooltip must not appear at all.
   *
   * Four states, and the first is the one this pass adds: **any armed drawing
   * tool**, for as long as it is armed rather than only while the button is down.
   * A tooltip is a 190 px card anchored a dozen pixels from the cursor, so on a
   * 227 px plot it covers a meaningful fraction of the events around the point
   * being clicked — which is fine when hovering *is* the gesture and actively
   * harmful when the gesture is "put a vertex exactly here". Switching the tool
   * back to none restores it immediately; nothing about the tooltip itself
   * changed.
   *
   * The other three were already true and are stated here rather than repeated at
   * each render site: a box being drawn, a gate being dragged, and the panel being
   * moved are all gestures whose meaning is already settled.
   */
  const tooltipSuppressed = gateTool !== 'none' || !!drawBox || gateDragging || !!moving;

  /**
   * Arming a tool clears the tooltip without waiting for a mouse move.
   *
   * The render conditions above already refuse to draw it, so this is state
   * hygiene rather than the mechanism — but a `hover` left set from before the
   * tool was armed would come back the instant the tool was disarmed, pointing at
   * an event the pointer has long since left. Disarming clears the readout for
   * the mirror-image reason.
   */
  useEffect(() => {
    if (gateTool !== 'none') setHover(null);
    else { setCursorData(null); setOverClose(false); }
    // Changing the tool answers the refusal, whichever way it was answered.
    setRefusal(null);
  }, [gateTool]);

  // So does changing what kind of plot this is, which is the other thing the
  // message suggests.
  useEffect(() => { setRefusal(null); }, [plotType]);

  /**
   * Whether an armed tool can draw on this plot at all.
   *
   * A histogram takes line gates and nothing else — see
   * `HISTOGRAM_GATE_REFUSAL`. Everything else takes everything.
   */
  const toolRefusedHere = plotType === 'histogram' && gateTool !== 'none' && gateTool !== 'range';

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - MARGIN.left, y: e.clientY - r.top - MARGIN.top };
  };

  /** Is a point inside the plot's data rectangle, margins excluded? */
  const inDataRect = (p: { x: number; y: number }) =>
    p.x >= 0 && p.y >= 0 && p.x <= plotW && p.y <= plotH;

  /**
   * The same point, pulled onto the nearest edge of the data rectangle.
   *
   * Used by every drawing gesture, and it is the second half of the panel-move
   * lock. A gate is routinely started **just outside** the cloud — at or a pixel
   * past an axis — so that the events on the edge are inside it rather than
   * clipped by it, and the axis margin is only a few pixels wide. Discarding
   * those presses (which is what the surface used to do) meant the gesture went
   * to whatever was underneath, which was the panel move; clamping means the
   * user gets the gate they aimed at, anchored exactly on the axis.
   */
  const clampToPlot = (p: { x: number; y: number }) => ({
    x: clamp(p.x, 0, plotW),
    y: clamp(p.y, 0, plotH),
  });

  /**
   * Is the pointer still over this panel?
   *
   * Measured against the whole panel element, not the plot rectangle: the
   * toolbar and axis labels are part of "this plot" as far as the user is
   * concerned, and a gate dragged over its own axis label has not left.
   */
  const withinPanel = useCallback((e: { clientX: number; clientY: number }): boolean => {
    const el = rootRef.current;
    if (!el) return true;
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  }, []);

  /*
     The rule lives in `openPanel.ts` so it can be tested without rendering.

     `scopeId`, not `populationId`, so a panel whose scope gate has been deleted
     parents a new gate to the root rather than to something that no longer
     exists — which is what it is *drawing*, since the scope fell back to every
     event. It is also what keeps parentage and visibility the same answer: a
     gate drawn here is, by construction, one this panel will show.
  */
  const drawParentId = gateParentFor({ populationId: scopeId }, selectedGateId);

  const newGateBase = (kind: Gate['kind']) => ({
    id: nextGateId(),
    name: defaultGateName(kind, gates),
    parentId: drawParentId,
    colorIndex: gates.length,
    // The space this shape is being drawn in, recorded at the moment it is drawn.
    ...panelSpace(kind),
  });

  /* ---------------- Naming a finished gate ---------------- */

  /**
   * A finished shape waiting for its name.
   *
   * Nothing reaches the gate tree until this resolves, which is the point: a
   * population created as "Rectangle 3" and renamed later is two steps and a
   * trip to the sidebar, and in practice the rename never happens — a strategy
   * ends up full of generic names that have to be decoded from the axes. Naming
   * at the moment of the gesture is what FCS Express and FlowJo both do.
   *
   * `gates` is a list rather than one gate because a quadrant is a single
   * gesture producing four populations, and asking for four names would be
   * worse than asking for none. One stem names all four.
   */
  const [naming, setNaming] = useState<
    { gates: Gate[]; suggestion: string; at: { x: number; y: number }; quadrant: boolean } | null
  >(null);
  /**
   * What is currently typed in the prompt.
   *
   * A ref rather than state, and it lives out here rather than in the prompt,
   * because the window-level Enter handler needs the current text without the
   * prompt having to lift every keystroke into a re-render of the whole canvas.
   */
  const namingValueRef = useRef<string | null>(null);

  /**
   * Hand a finished shape to the naming prompt.
   *
   * Every finalise path ends here — rectangle, ellipse and range on mouse-up,
   * quadrant on its single click, polygon on close — so there is one place a
   * gate can be created from and no way to add one that skipped being named.
   */
  const proposeGates = useCallback(
    (made: Gate[], at: { x: number; y: number }, opts?: { quadrant?: boolean }) => {
      if (made.length === 0) return;
      const first = made[0]!;
      // Every remaining gate kind has axes, so this is constant — kept because
      // it is the one place a future kind without them would be handled.
      const axes = usesAxes(first) ? first : null;
      const suggestion = opts?.quadrant
        ? defaultGateName('quadrant', gates)
        : suggestGateName({
            kind: first.kind,
            existing: gates,
            xStain: axes ? params[axes.xParam]?.stain : undefined,
            yStain: axes && axes.kind !== 'range' ? params[axes.yParam]?.stain : undefined,
          });
      namingValueRef.current = suggestion;
      setNaming({
        gates: made,
        suggestion,
        // Clamped into the plot so a gate drawn against an edge does not open
        // its prompt off-screen.
        at: { x: clamp(at.x, 8, Math.max(8, plotW - 8)), y: clamp(at.y, 8, Math.max(8, plotH - 8)) },
        quadrant: !!opts?.quadrant,
      });
    },
    [gates, params, yi, plotW, plotH],
  );

  /** Enter, or a click on Add: the gate enters the tree under the given name. */
  const confirmNaming = useCallback((name: string) => {
    const pending = naming;
    if (!pending) return;
    const clean = name.trim() || pending.suggestion;
    namingValueRef.current = null;
    setNaming(null);
    if (pending.quadrant) {
      // One stem, four populations, suffixed by corner — the same shape the
      // quadrant tool produced before, now with a stem the user chose.
      pending.gates.forEach((g, k) => {
        addGate(sample.id, { ...g, name: `${clean} ${QUADRANT_LABELS[k as 0 | 1 | 2 | 3].slice(0, 2)}` });
      });
      return;
    }
    for (const g of pending.gates) addGate(sample.id, { ...g, name: clean });
  }, [naming, addGate, sample.id]);

  /**
   * Redefine an existing population with the shape that was just drawn.
   *
   * The other answer to the naming prompt (2026-08-12, Item 9), reached either
   * by typing a name that is already taken or by picking one from its list. The
   * new shape never enters the tree as a gate of its own — `replaceGate` writes
   * it into the existing one — which is what makes this a redefinition rather
   * than an add followed by a delete somebody has to remember to do.
   *
   * The first drawn gate only: the browse control and the collision check are
   * both suppressed for a quadrant, so `pending.gates` here is always one.
   */
  const replaceWithPending = useCallback((gateId: string, name: string) => {
    const pending = naming;
    const shape = pending?.gates[0];
    if (!pending || !shape) return;
    namingValueRef.current = null;
    setNaming(null);
    useGates.getState().replaceGate(sample.id, gateId, shape, name);
  }, [naming, sample.id]);

  /**
   * Escape at the naming step abandons the whole gate, not just the name.
   *
   * Consistent with what Escape already does mid-draw. The alternative —
   * keeping an unnamed gate — would mean Escape sometimes cancels and sometimes
   * commits, which is the one thing a cancel key must never do.
   */
  const cancelNaming = useCallback(() => { namingValueRef.current = null; setNaming(null); }, []);

  /** Close the in-progress polygon into a real gate. */
  const closePolygon = useCallback(() => {
    const pending = useGates.getState().pendingPolygon;
    if (!pending || pending.length < 3) return;
    // Freehand and rapid clicking both produce near-duplicate vertices, each of
    // which costs a crossing test per event for the life of the gate.
    const spanX = Math.abs(view.xMax - view.xMin);
    const vertices = simplifyPolygon(pending, spanX * 0.004);
    const centroid = vertices.reduce(
      (a, v) => ({ x: a.x + v.x / vertices.length, y: a.y + v.y / vertices.length }),
      { x: 0, y: 0 },
    );
    proposeGates(
      [{
        id: nextGateId(),
        name: defaultGateName('polygon', gates),
        parentId: drawParentId,
        colorIndex: gates.length,
        kind: 'polygon',
        xParam: xi,
        yParam: yi,
        ...panelSpace('polygon'),
        vertices,
      }],
      { x: toPixelX(centroid.x), y: toPixelY(centroid.y) },
    );
    setPendingPolygon(null);
    setCursorData(null);
    setOverClose(false);
  }, [view, gates, drawParentId, xi, yi, setPendingPolygon, proposeGates, toPixelX, toPixelY]);

  /** Screen-space position of the pending polygon's first vertex. */
  const firstVertexPx = useMemo(() => {
    const v = pendingPolygon?.[0];
    return v ? { x: toPixelX(v.x), y: toPixelY(v.y) } : null;
  }, [pendingPolygon, toPixelX, toPixelY]);

  /** Commit a drag-drawn rectangle, ellipse or range — into the naming prompt. */
  const commitDrawnBox = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const x0 = toDataX(Math.min(b.x0, b.x1));
    const x1 = toDataX(Math.max(b.x0, b.x1));
    const mid = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };

    // A range gate is one-dimensional, so only the horizontal drag has to clear
    // the click threshold — requiring vertical extent would make it undrawable
    // on a histogram, where the natural gesture is a flat sweep.
    if (gateTool === 'range') {
      if (Math.abs(b.x1 - b.x0) < 5) return;
      proposeGates([{ ...newGateBase('range'), kind: 'range', xParam: xi, min: x0, max: x1 }], mid);
      return;
    }

    if (Math.abs(b.x1 - b.x0) < 5 || Math.abs(b.y1 - b.y0) < 5) return;
    const y0 = toDataY(Math.max(b.y0, b.y1));
    const y1 = toDataY(Math.min(b.y0, b.y1));

    if (gateTool === 'rectangle') {
      proposeGates([{
        ...newGateBase('rectangle'), kind: 'rectangle',
        xParam: xi, yParam: yi, xMin: x0, xMax: x1, yMin: y0, yMax: y1,
      }], mid);
    } else if (gateTool === 'ellipse') {
      proposeGates([ellipseFromDrag(
        { ...newGateBase('ellipse'), kind: 'ellipse', xParam: xi, yParam: yi },
        x0, y0, x1, y1,
      )], mid);
    }
  };

  /**
   * A polygon vertex click that would close the shape, deferred to pointer-up.
   *
   * This is the whole of the polygon naming bug, and it is a focus race rather
   * than anything to do with gates. Closing on **pointerdown** meant the naming
   * prompt was created, mounted and focused *inside* the pointerdown dispatch —
   * and the browser's own default action for that same event then runs and moves
   * focus to the nearest focusable ancestor of what was clicked, which is not the
   * prompt. The prompt's `onBlur` commits, so the gate went straight into the
   * tree under its suggested name and the field was gone before it could be
   * typed into. Every other shape finalises on **pointerup**, whose default
   * action does not touch focus, which is exactly why polygons were the only
   * kind that skipped being named.
   *
   * So the close is armed here and fired on release, like every other shape.
   */
  const closeOnUp = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    // A gate waiting to be named owns the plot until it is accepted or
    // discarded. Without this, the second click of a double-click starts a
    // fresh polygon *behind* the open prompt and blurs it into committing.
    if (naming) return;
    // No tool armed: this press is not about drawing, so nothing is claimed here
    // and it bubbles on to the panel root, where a background drag moves the
    // whole plot. Capturing the pointer regardless — which is what this did —
    // would be claiming a gesture in order to do nothing with it.
    if (gateTool === 'none') return;
    // A control inside the plot surface — the axis parameter pickers and the
    // transform popovers sit in the margins — owns its own press. Needed now that
    // a press in the margin *draws* rather than being discarded: without it,
    // opening the y-axis picker with a tool armed would place a gate vertex.
    //
    // `PLOT_CONTROL_SELECTOR`, **not** `NO_DRAG_SELECTOR`: the latter excludes
    // gates, and drawing a gate on top of an existing one is how every child
    // population is made. See the note on it.
    if ((e.target as Element | null)?.closest?.(PLOT_CONTROL_SELECTOR)) return;
    /*
       A shape on a histogram is refused here, before anything is armed.

       At this point rather than at commit, because a polygon is committed four
       clicks after it is started and a rectangle after a whole drag — telling
       somebody at the end of the gesture that the gesture was never going to
       work is the same as failing silently, only later. Nothing is armed, so
       nothing has to be unwound.
    */
    if (toolRefusedHere) {
      setRefusal(HISTOGRAM_GATE_REFUSAL);
      // A polygon half-placed before the plot type was switched to histogram
      // would otherwise sit there un-closable.
      if (pendingPolygon) setPendingPolygon(null);
      return;
    }
    // Margins included, clamped onto the axis. See `clampToPlot`.
    const p = clampToPlot(localPoint(e));
    setHover(null);

    // --- Gate drawing ---
    if (gateTool === 'rectangle' || gateTool === 'ellipse' || gateTool === 'range') {
      // State first, capture second, and the capture wrapped. `setPointerCapture`
      // throws on a pointer id the browser does not consider active — which for a
      // synthesised event it often does not — and it takes the following
      // statement with it. That is the exact shape of the bug that made the
      // panel resize handle silently arm nothing, recorded under *Traps*.
      drag.current = { sx: p.x, sy: p.y, cx: p.x, cy: p.y };
      setDrawBox({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      capture(e);
      return;
    }
    if (gateTool === 'polygon') {
      const pending = pendingPolygon ?? [];
      // Clicking back on the first vertex closes and finalises the gate — the
      // gesture every other cytometry package uses. Double-click still closes as
      // a fallback rather than as the only way out.
      if (firstVertexPx && isNearPolygonClose(p, firstVertexPx, pending.length)) {
        closeOnUp.current = true;
        return;
      }
      setPendingPolygon([...pending, { x: toDataX(p.x), y: toDataY(p.y) }]);
      return;
    }
    if (gateTool === 'quadrant') {
      const xSplit = toDataX(p.x);
      const ySplit = toDataY(p.y);
      // One click defines all four populations, which is how a quadrant gate is
      // understood everywhere else. All four are proposed together and take one
      // stem from the prompt.
      proposeGates(
        ([0, 1, 2, 3] as const).map((q, k) => ({
          id: nextGateId(),
          name: `Q${k}`,
          parentId: drawParentId,
          colorIndex: gates.length + k,
          kind: 'quadrant' as const, xParam: xi, yParam: yi,
          ...panelSpace('quadrant'), xSplit, ySplit, quadrant: q,
        })),
        p,
        { quadrant: true },
      );
      setGateTool('none');
      return;
    }
  };

  /**
   * Begin dragging a gate body or one of its handles.
   *
   * **Nothing captures the pointer here, and the drag state is armed before
   * anything that can throw.** This is the other half of the "the tooltip is
   * eating my resize" report, and it is the trap PROGRESS.md already records
   * twice: `setPointerCapture` throws on a pointer id the browser does not
   * consider active and takes the *next* statement with it — which was the line
   * that stored `gateDrag.current`. The handler then armed nothing, and because
   * it had already called `stopPropagation` the plot surface did not see the
   * press either, so the pointer moved on with no drag in flight and the hover
   * search ran: event circles, and a gate that would not resize.
   *
   * Capture is not wanted here regardless. The gesture has to keep working after
   * the pointer leaves the panel — that is the whole drag-a-gate-out half of it —
   * and capture stops delivering the moment the pointer is over another element.
   * The `window` listeners below are what a drag that can leave its own element
   * needs.
   */
  const onGatePointerDown = (e: React.PointerEvent, gateId: string, handle: string) => {
    // A gate waiting to be named holds the plot; so does an armed draw tool,
    // which means the click is placing a shape rather than grabbing one.
    if (gateTool !== 'none' || naming) return;
    // The reprojected gate: the drag is about to be computed in screen
    // coordinates, so its origin has to be the shape actually on screen.
    const g = viewGates.find((x) => x.id === gateId);
    if (!g) return;
    // Claimed before anything else: this press belongs to the gate, so neither
    // the plot surface's draw handler nor the panel root's move handler may also
    // act on it. A gate is edited, not drawn on and not dragged around.
    e.stopPropagation();
    const p = localPoint(e);
    gateDrag.current = { handle, sx: p.x, sy: p.y, original: g, machine: beginGateDrag(gateId) };
    setGateDragging(true);
    // The tooltip is suppressed for the whole drag from here: during a press-and-
    // move the user's intent is unambiguous, whatever the pointer passes over.
    setHover(null);
    // Selects the gate and *clears* the panel selection the capture handler on
    // the root just made. One selection at a time; this is the bubble-phase half
    // of that rule.
    selectGateOnly(gateId, panelId);
  };

  /**
   * Latest `applyGateDrag`, for the window listener above.
   *
   * The listener is attached once per drag; `applyGateDrag` closes over the
   * current transform and viewport and is rebuilt every render. Reading it
   * through a ref keeps the drag on the current geometry without re-attaching
   * the listener mid-gesture, which would drop events.
   */
  const applyGateDragRef = useRef<(p: { x: number; y: number }) => void>(() => {});

  /**
   * Apply a gate edit for the current pointer position.
   *
   * Every write goes through `edit`, which stamps the panel's own display space
   * onto the patch. A drag is performed against what is on screen, so the
   * coordinates it produces are in this panel's space by construction — and
   * `d.original` is the *reprojected* gate for exactly that reason. Saying so on
   * the gate is what stops the boundary and the space it is read in drifting
   * apart, which is the whole of Item 17.
   */
  const applyGateDrag = (p: { x: number; y: number }) => {
    const d = gateDrag.current;
    if (!d) return;
    const g = d.original;
    const dx = toDataX(p.x) - toDataX(d.sx);
    const dy = toDataY(p.y) - toDataY(d.sy);
    /*
       A range gate is dragged along whichever axis this plot draws it on.

       `rangeAxis` picks the drag delta, the pixel-to-data function *and* the
       spec stamped on the write, and all three have to be the same choice or
       the boundary lands somewhere other than where the pointer let go. The
       gate's own model is untouched: it is still one interval on `xParam`, and
       `evaluateFor` never learns which way it was drawn.
    */
    const rangeAxis = rangeAxisOn(g, xi, yi, oneDimensional) ?? 'x';
    const alongY = rangeAxis === 'y';
    const dAlong = alongY ? dy : dx;
    const toDataAlong = alongY ? toDataY : toDataX;
    const edit = (patch: object) =>
      updateGate(sample.id, g.id, { ...patch, ...panelSpace(g.kind, rangeAxis) } as Partial<Gate>);

    if (d.handle === 'move') {
      if (isGeometric(g)) edit(translateGate(g, dx, dy));
      // A range gate has no extent across its axis, so it slides along it only.
      else if (g.kind === 'range') edit({ min: g.min + dAlong, max: g.max + dAlong });
      return;
    }

    if (g.kind === 'range') {
      /*
         An open boundary becomes a real one where the drag started
         (2026-08-11, Item 18).

         `Infinity + dx` is `Infinity`, so a one-sided gate could only ever be
         adjusted from its finite end — which is the whole of the reported
         problem: a seeded positive gate runs from its threshold to `+Infinity`,
         so noise sitting to the *right* of the real population had nothing to
         grab. The open end's handle is drawn at the plot edge (see
         `RangeShape`), so the edge is where its value is: `toDataX(0)` and
         `toDataX(plotW)` are this panel's visible extent in the same display
         space the gate is stored in.

         The value it takes is **where the pointer is**, not the plot edge plus
         the drag: `toDataX(d.sx) + dx` is `toDataX(p.x)` exactly, since display
         space is linear in pixels. A finite boundary keeps its relative rule so
         the grab offset is preserved, which is what makes a nudge a nudge; an
         open one has no offset to preserve, and following the pointer is both
         the obvious reading of "drag the edge in" and the only rule under which
         pressing 8 px inside the edge does not throw the boundary 8 px past the
         cursor.

         Only the end being dragged is materialised. Moving the left boundary of
         a one-sided gate leaves it one-sided, which is right — nothing about
         that gesture says the user has decided where the top of the population
         is.
      */
      const from = (bound: number) => (
        Number.isFinite(bound) ? bound : toDataAlong(alongY ? d.sy : d.sx)
      );
      const min = d.handle === 'min' ? from(g.min) + dAlong : g.min;
      const max = d.handle === 'max' ? from(g.max) + dAlong : g.max;
      // Boundaries are stored ordered so a handle dragged past its partner
      // flips the interval rather than inverting it into an empty population.
      edit({ min: Math.min(min, max), max: Math.max(min, max) });
      return;
    }

    if (g.kind === 'rectangle') {
      const patch = { ...g };
      if (d.handle.includes('w')) patch.xMin = g.xMin + dx;
      if (d.handle.includes('e')) patch.xMax = g.xMax + dx;
      if (d.handle.includes('n')) patch.yMax = g.yMax + dy;
      if (d.handle.includes('s')) patch.yMin = g.yMin + dy;
      edit(normaliseRect(patch));
    } else if (g.kind === 'polygon' && d.handle.startsWith('v')) {
      const vi = Number(d.handle.slice(1));
      const vertices = g.vertices.map((v, i) => (i === vi ? { x: v.x + dx, y: v.y + dy } : v));
      edit({ vertices });
    } else if (g.kind === 'polygon' && d.handle.startsWith('b')) {
      edit({ vertices: scalePolygon(g.vertices, d.handle.slice(1), dx, dy) });
    } else if (g.kind === 'ellipse') {
      if (d.handle === 'rx') edit({ rx: Math.max(1e-9, g.rx + dx) });
      if (d.handle === 'ry') edit({ ry: Math.max(1e-9, g.ry + dy) });
    }
  };
  applyGateDragRef.current = applyGateDrag;

  /**
   * A gate drag, driven from the window rather than from the plot element.
   *
   * The gesture has to keep working after the pointer leaves the panel — that
   * is the entire out-of-bounds half of it — and `setPointerCapture` did not
   * deliver that: the moves simply stopped arriving once the pointer was over
   * another element, so the boundary was never seen to be crossed and the drag
   * read as "moves the gate, and does nothing if you drag it out". Listening on
   * the window is what a drag that can leave its own element needs.
   */
  useEffect(() => {
    if (!gateDragging) return;

    const move = (e: PointerEvent) => {
      const d = gateDrag.current;
      if (!d) return;
      const { state, effect } = machineMove(d.machine, withinPanel(e));
      d.machine = state;

      if (effect.restore) {
        updateGate(sample.id, d.original.id, d.original as Partial<Gate>);
      }
      if (effect.move) {
        if (effect.crossed) setDragOutside(null);
        applyGateDragRef.current(localPoint(e));
        return;
      }
      setDragOutside({ x: e.clientX, y: e.clientY, name: d.original.name });
    };

    const up = (e: PointerEvent) => {
      const d = gateDrag.current;
      gateDrag.current = null;
      setGateDragging(false);
      setDragOutside(null);
      if (!d) return;

      // Where the pointer was **released** settles it, not the last move that
      // happened to be delivered. Chromium coalesces `pointermove` onto frames,
      // so a fast flick out of the plot can deliver no move at all past the
      // boundary — the same coalescing that once made rectangle gates look like
      // they needed two clicks. Re-running the transition here means the
      // gesture is decided by where it ended, which is what the user aimed at.
      const { state, effect } = machineMove(d.machine, withinPanel(e));
      d.machine = state;
      if (effect.restore) updateGate(sample.id, d.original.id, d.original as Partial<Gate>);
      // Released past this panel's own boundary: the gesture was a request for a
      // plot of this population, not a nudge of the shape. The gate is already
      // back where it started — the machine's `restore` fired on the crossing —
      // so nothing here has to be undone.
      // `panelId` is the plot the gate was dragged off, and the new one opens
      // on its axes — see Item 10 in `openPanel.ts`.
      if (machineUp(d.machine) === 'open-panel') openPanelForPopulation(sample.id, d.machine.gateId, panelId);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [gateDragging, withinPanel, updateGate, sample.id]);

  const onPointerMove = (e: React.PointerEvent) => {
    const p = localPoint(e);
    const d = drag.current;

    // A gate drag is driven from the window, not from here — see the effect
    // below. Bailing out keeps this handler from applying the same move twice
    // while the pointer happens to be over the plot, and keeps the hover search
    // from running during a drag whose meaning is already settled.
    if (gateDrag.current) return;

    // While a tool is armed the pointer position is reported as **axis values**
    // rather than as a per-event tooltip — see `tooltipSuppressed`. Tracked for
    // every tool, not only polygon: the readout is the readout whatever is being
    // drawn, and the polygon's rubber band happens to need the same number.
    if (gateTool !== 'none') {
      const c = clampToPlot(p);
      setCursorData({ x: toDataX(c.x), y: toDataY(c.y) });
      setOverClose(
        gateTool === 'polygon' && !!pendingPolygon && !!firstVertexPx
        && isNearPolygonClose(p, firstVertexPx, pendingPolygon.length),
      );
    } else {
      if (cursorData) setCursorData(null);
      if (overClose) setOverClose(false);
    }

    if (d) {
      d.cx = clamp(p.x, 0, plotW);
      d.cy = clamp(p.y, 0, plotH);
      setDrawBox({ x0: d.sx, y0: d.sy, x1: d.cx, y1: d.cy });
      return;
    }

    // **No per-event lookup at all while a tool is armed.** This is the whole of
    // the second tooltip report and it is a different case from the first: the
    // previous pass suppressed the readout for the duration of a *drag*, which
    // covers editing an existing gate's handles and does nothing for the moment
    // that matters most when drawing a new one — the pointer resting on the exact
    // pixel about to be clicked, with a 190 px card drawn over it. A gate is
    // placed by looking at where the crosshair is, so anything covering the
    // crosshair is covering the gesture. The lightweight axis readout below takes
    // its place, offset down and to the right so the pixel under the cursor and
    // everything above-left of it stay visible.
    if (tooltipSuppressed) {
      if (hover) setHover(null);
      return;
    }

    if (!inDataRect(p)) {
      setHover(null);
      return;
    }

    // **Gate handles outrank the per-event tooltip.** A pointer inside a handle's
    // target is aimed at that handle — the handle is the smaller thing and the
    // deliberate one — so no event lookup happens there at all. Without this the
    // two hit tests competed at the same pixels and the tooltip, being drawn on
    // top, is what the user saw when they meant to drag a vertex.
    if (isOverGateHandle(viewGates, selectedGateId, p, hitContext)) {
      if (hover) setHover(null);
      return;
    }

    // Hover radius is a fixed pixel distance converted into display units.
    const rx = (10 / plotW) * (view.xMax - view.xMin);
    const ry = (10 / plotH) * (view.yMax - view.yMin);
    const found = index.nearest(toDataX(p.x), toDataY(p.y), rx, ry);
    setHover(found >= 0 ? { x: p.x, y: p.y, index: found } : null);
  };

  const onPointerUp = () => {
    if (gateDrag.current) return;

    // The deferred polygon close — see `closeOnUp`. Finalising here rather than
    // on pointerdown is what lets the naming prompt keep focus.
    if (closeOnUp.current) {
      closeOnUp.current = false;
      closePolygon();
      return;
    }

    const d = drag.current;
    drag.current = null;

    // Committed from the ref, never from the rendered state — see `drag`.
    if (d) {
      commitDrawnBox({ x0: d.sx, y0: d.sy, x1: d.cx, y1: d.cy });
      setDrawBox(null);
    }
  };

  /* ---------------- Hover readout ---------------- */

  const hoverValues = useMemo(() => {
    if (!hover) return null;
    return { rawX: rawX[hover.index]!, rawY: rawY[hover.index]!, eventIndex: hover.index };
  }, [hover, rawX, rawY]);

  /**
   * The armed-tool cursor readout: two axis values, and where to put them.
   *
   * Values go back through `inverse()` because `cursorData` is in display units
   * and the axes are labelled in data units — the same conversion the tick labels
   * make, so the number under the cursor and the number on the axis agree.
   *
   * The offset flips near the right and bottom edges so the readout stays inside
   * the plot; it never flips *up* past the cursor, because above-left of the
   * crosshair is the quadrant a right-handed user is looking at.
   */
  const cursorReadout = useMemo(() => {
    if (gateTool === 'none' || !cursorData || plotW <= 0 || plotH <= 0) return null;
    const px0 = toPixelX(cursorData.x);
    const py0 = toPixelY(cursorData.y);
    if (px0 < -1 || py0 < -1 || px0 > plotW + 1 || py0 > plotH + 1) return null;
    const text = plotType === 'histogram'
      ? fmt(tx.inverse(cursorData.x))
      : `${fmt(tx.inverse(cursorData.x))} · ${fmt(ty.inverse(cursorData.y))}`;
    // ~6.1 px per mono glyph at 9.5 px, plus the padding.
    const w = text.length * 6.1 + 8;
    const right = px0 + 13 + w > plotW;
    const below = py0 + 15 > plotH;
    return {
      text,
      left: MARGIN.left + (right ? Math.max(0, px0 - 13 - w) : px0 + 13),
      top: MARGIN.top + (below ? Math.max(0, py0 - 16) : py0 + 9),
    };
  }, [gateTool, cursorData, plotW, plotH, plotType, toPixelX, toPixelY, tx, ty]);

  /**
   * The figure this panel exports, composed at its printed size (2026-10-22).
   *
   * **What is plotted is the panel's own**: its view and tick lists, the gates
   * it hands `GateLayer` (already in its display space) with their statistics
   * and label nudges, the rows `histogramRows` gives `HistogramLayer`, the fit
   * rows `FitOverlay` draws, and an event layer redrawn by this panel's own
   * `densitySpec` / `pointCloudDraw` at whatever pixel size the figure asks
   * for. **How it is drawn is the `FigureStyle`'s** — see `composePlotFigure`.
   * The exporter used to clone this panel's live SVG instead, which made a
   * figure the panel's pixel size in the screen's fonts and theme.
   *
   * The caption names the population the panel is **scoped** to, not the gate
   * that happens to be selected — the click that opens the exporter clears the
   * selection, so the old caption rarely named any population at all.
   */
  const figureSource = useCallback((): FigureSource | null => {
    if (plotW <= 0 || plotH <= 0 || !px) return null;
    const isHist = plotType === 'histogram';
    const stats = evaluated?.stats;
    const hue = (g: Gate) => paperColor(gateHue(g));
    const ink = (g: Gate) => paperColor(gateInk(g));

    /* ---- gates, as the figure draws them ---- */
    const figGates: FigureGate[] = [];
    const quads = new Map<string, Extract<FigureGate, { kind: 'quadrant' }>>();
    for (const g of viewGates) {
      const percent = stats?.get(g.id)?.percentOfParent ?? null;
      if (g.kind === 'range') {
        const axis = rangeAxisOn(g, xi, yi, oneDimensional);
        if (axis) figGates.push({ kind: 'range', id: g.id, name: g.name, percent, color: hue(g), axis, min: g.min, max: g.max });
        continue;
      }
      if (oneDimensional || !isGeometric(g) || g.xParam !== xi || g.yParam !== yi) continue;
      if (g.kind === 'quadrant') {
        // Four gates share one crosshair; the figure draws it once and labels
        // every quadrant in its corner.
        const key = `${g.xSplit},${g.ySplit}`;
        const q = quads.get(key) ?? { kind: 'quadrant' as const, id: g.id, color: ink(g), x: g.xSplit, y: g.ySplit, labels: [] };
        q.labels.push({ quadrant: g.quadrant, name: g.name, percent, color: ink(g) });
        quads.set(key, q);
        continue;
      }
      const b = boundsOf(g);
      const anchor: [number, number] = [(b.xMin + b.xMax) / 2, b.yMax];
      const offset = panel?.labelOffsets?.[g.id];
      const nudge: [number, number] = [offset?.dx ?? 0, offset?.dy ?? 0];
      if (g.kind === 'ellipse') {
        figGates.push({ kind: 'ellipse', id: g.id, name: g.name, percent, color: ink(g), cx: g.cx, cy: g.cy, rx: g.rx, ry: g.ry, angle: g.angle, anchor, nudge });
      } else {
        const points: Array<[number, number]> = g.kind === 'rectangle'
          ? [[g.xMin, g.yMin], [g.xMax, g.yMin], [g.xMax, g.yMax], [g.xMin, g.yMax]]
          : g.vertices.map((v) => [v.x, v.y] as [number, number]);
        figGates.push({ kind: 'path', id: g.id, name: g.name, percent, color: ink(g), points, anchor, nudge });
      }
    }
    figGates.push(...quads.values());

    /* ---- the histogram and its fit: the panel's own rows ---- */
    let histogram: FigureHistogram | null = null;
    if (isHist) {
      // The selected slice is an interaction, not content: a figure does not
      // depend on what happened to be clicked.
      const rows = histogramRows(histogramSeries, view.xMin, view.xMax, binCount, smoothing).filter((r) => !r.marked);
      const overrides = useFigure.getState().conditionColors;
      histogram = {
        xMin: view.xMin, xMax: view.xMax,
        series: rows.map((r, i) => ({
          label: r.label, color: overrides[r.label] ?? conditionColor(i), bins: r.bins,
          marked: false, overlaid: rows.length > 1, count: r.count,
        })),
      };
    }
    const fit: FigureFit | null = isHist && fitRows && (panel?.populationId ?? null) === fitRows.populationId
      ? {
        x: fitRows.x, total: fitRows.total, parts: fitRows.parts,
        partColors: fitRows.gates.map((g) => (g ? hue(g) : PAPER_POPULATION[6]!)),
        model: fitRows.model, goodness: fitRows.goodness,
        populations: fitRows.populations.map((p, i) => ({ ...p, name: fitRows.gates[i]?.name ?? `Population ${i + 1}`, color: fitRows.gates[i] ? hue(fitRows.gates[i]!) : FIGURE_INK })),
        residual: fitRows.residual,
      }
      : null;

    /* ---- events piled at the detector's maximum ---- */
    let saturated = 0;
    let keep: Uint8Array | null = null;
    if (!isHist) {
      const thrX = densityCeilings.x ?? Infinity;
      const thrY = densityCeilings.y ?? Infinity;
      if (Number.isFinite(thrX) || Number.isFinite(thrY)) {
        keep = new Uint8Array(viewX.length);
        for (let i = 0; i < viewX.length; i++) {
          const off = viewX[i]! >= thrX || viewY[i]! >= thrY;
          keep[i] = off ? 0 : 1;
          if (off) saturated++;
        }
      }
    }

    const unitFor = (p: typeof px) => (p
      ? unitOf(p.type, p.type === 'Derived' ? derivedDefs.find((d) => d.name === p.name)?.expression : null)
      : null);
    const yTitle = isHist ? DENSITY_AXIS_LABEL : (py?.label ?? '');
    const lut = RAMPS[ramp] ?? RAMPS.rainbow!;
    const stops = Array.from({ length: 12 }, (_, i) => {
      const [r, g, b] = sampleRamp(lut, i / 11);
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    });
    const count = viewX.length;
    const describeGate = (g: FigureGate) => (g.kind === 'quadrant'
      ? g.labels.map((l) => `${l.name}${l.percent === null ? '' : ` ${l.percent.toFixed(1)}%`}`).join(', ')
      : `${g.name}${g.percent === null ? '' : ` ${g.percent.toFixed(1)}% of parent`}`);
    const notes = [
      `Sample: ${sample.name}`,
      `Population: ${scopePath.length > 0 ? scopePath.join(' / ') : 'All events'} — ${count.toLocaleString('en-US')} events`,
      isHist
        ? `x: ${px.label}, ${transformLabel(specX)}; y: normalised count`
        : `x: ${px.label}, ${transformLabel(specX)}; y: ${py?.label ?? ''}, ${transformLabel(specY)}`,
      plotType === 'density'
        ? `Density: ${binCount} × ${binCount} bins, ${ramp} colour map, ${colorStyle} levels, smoothing ${smoothingAuto ? resolvedSmoothing : smoothing}.`
        : plotType === 'contour'
          ? `Contours: probability contours enclosing 10, 30, 50, 70 and 90% of the events, from a ${CONTOUR_BINS} × ${CONTOUR_BINS} grid smoothed with a window of ${contours?.smoothing ?? '?'} (a kernel density bandwidth by Scott's rule).`
        : plotType === 'scatter'
          ? `Dot plot: every event of the population, point size ${pointSize}.`
          : `Histogram: ${binCount} bins across the axis, smoothing window ${smoothing}; each distribution normalised to its tallest smoothed bar.`,
      ...(figGates.length > 0 ? [`Gates: ${figGates.map(describeGate).join('; ')}.`] : []),
    ];

    const rasterFor = (style: FigureStyle) => {
      if (plotType === 'density') {
        const mask = style.plot.clipSaturated && saturated > 0 ? keep : null;
        return (w: number, h: number) => {
          /*
             The field at the resolution this window draws it — the plot square
             in device pixels — then scaled smoothly to the figure's pixels. A
             density map is the panel's grid averaged into the pixels of the plot
             square; drawn straight at a 300 dpi figure's ~900 px instead, each
             pixel was about one grid cell, and a field that is smooth on screen
             came out as a speckle of isolated cells. So the figure shows the
             field the panel shows, and the panel's own smoothing and resolution
             controls shape both. The panel's own settings object — see
             `densitySpec`; the one thing that may differ is which events are
             drawn, and only when the figure is asked to leave out the pile at
             the detector's maximum.
          */
          const dpr = Math.max(1, window.devicePixelRatio || 1);
          const field = document.createElement('canvas');
          field.width = Math.max(1, Math.min(w, Math.round(plotW * dpr)));
          field.height = Math.max(1, Math.min(h, Math.round(plotH * dpr)));
          drawDensity(field, { x: viewX, y: viewY, viewport: view, ...densitySpec, ...(mask ? { mask } : {}) });
          if (field.width === w && field.height === h) return field.toDataURL('image/png');
          const out = document.createElement('canvas');
          out.width = w;
          out.height = h;
          const ctx = out.getContext('2d');
          if (!ctx) return field.toDataURL('image/png');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(field, 0, 0, w, h);
          return out.toDataURL('image/png');
        };
      }
      if (plotType === 'scatter') {
        return (w: number) => {
          const r = rendererRef.current;
          if (!r || r.unavailable) return null;
          r.draw(view, pointCloudDraw(w / plotW));
          const url = r.toDataURL();
          // Restore the on-screen resolution.
          r.draw(view, pointCloudDraw(1));
          return url;
        };
      }
      return null;
    };

    const model = (style: FigureStyle): PlotFigureModel => ({
      kind: isHist ? 'histogram' : plotType === 'scatter' ? 'scatter' : plotType === 'contour' ? 'contour' : 'density',
      view, xTicks, yTicks,
      xTitle: px.label, xUnit: unitFor(px),
      yTitle, yUnit: isHist ? null : unitFor(py),
      panelPlotSize: plotW,
      raster: rasterFor(style),
      contours: contours ? { paths: contours.sets.flatMap((s) => s.lines), color: FIGURE_INK } : null,
      gates: figGates,
      histogram, fit,
      colourBar: plotType === 'density' ? { stops, label: 'Relative density' } : null,
      saturated: !isHist && saturated > 0 ? { count: saturated, total: count } : null,
      title: scopeGate?.name ?? sample.name,
      caption: plotCaption({ sample: sample.name, population: scopeGate?.name ?? null, x: px.label, y: yTitle }),
      notes,
    });

    return {
      type: isHist ? 'histogram' : 'density',
      lines: isHist || plotType === 'contour' ? ['data', 'gate'] : ['gate'],
      kind: isHist ? 'Histogram' : plotType === 'scatter' ? 'Dot plot' : plotType === 'contour' ? 'Contour plot' : 'Density plot',
      fileStem: plotFileName(sample.name, px.name, isHist ? 'hist' : (py?.name ?? 'y'), 'pdf').replace(/\.pdf$/, ''),
      hasLayer: plotType === 'density' || plotType === 'scatter',
      shape: isHist ? 'free' : 'square',
      options: isHist ? (fit ? ['legend', 'goodness', 'annotate', 'residual'] : ['legend']) : plotType === 'density' ? ['colourBar', 'clipSaturated'] : [],
      compose: (style, layerScale) => composePlotFigure(model(style), style, layerScale),
    };
  }, [plotW, plotH, px, py, plotType, evaluated, viewGates, xi, yi, oneDimensional, panel, histogramSeries, view,
      binCount, smoothing, fitRows, tx, ty, viewX, viewY, derivedDefs, ramp, sample.name, scopePath, specX, specY, contours,
      colorStyle, smoothingAuto, resolvedSmoothing, pointSize, densitySpec, pointCloudDraw, xTicks, yTicks, scopeGate]);


  /* ---------------- First-use gating hint ---------------- */

  const gateHintsShown = useUI((s) => s.gateHintsShown);
  const noteGateHintShown = useUI((s) => s.noteGateHintShown);
  const dismissGateHint = useUI((s) => s.dismissGateHint);
  // Only the active panel shows it, or a three-panel grid would show three.
  const showGateHint = gateTool !== 'none' && gateHintsShown < GATE_HINT_LIMIT && isActive;

  useEffect(() => {
    // Counted once per arming of a tool, not once per render.
    if (gateTool !== 'none' && isActive && useUI.getState().gateHintsShown < GATE_HINT_LIMIT) {
      noteGateHintShown();
    }
  }, [gateTool, isActive, noteGateHintShown]);

  useEffect(() => {
    /** True while the user is typing, where every key belongs to the field. */
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };

    /**
     * Ask about deleting **the gate selection**, which may be more than one.
     *
     * Read from the store at the moment of the keystroke rather than from this
     * effect's closure: the selection is global — the sidebar tree can build it
     * with no panel involved at all — and a stale copy is how a canvas comes to
     * delete what was selected two clicks ago. The batch goes across whole, so
     * `removeGates` resolves the survivors against all of it at once and one
     * Ctrl+Z puts every one of them back.
     */
    const askDeleteSelectedGates = () => {
      const g = useGates.getState();
      const ids = g.selectedGateIds.filter((id) => gates.some((x) => x.id === id));
      if (ids.length === 0) return;
      const name = ids.length === 1
        ? gates.find((x) => x.id === ids[0])?.name ?? ''
        : `${ids.length} populations`;
      useUI.getState().askDeleteGate(sample.id, ids, name);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && naming && !typing(e.target)) {
        // Enter confirms the name even when focus has drifted off the field —
        // the user pressing it means "yes, that name", wherever the caret is.
        e.preventDefault();
        confirmNaming(namingValueRef.current ?? naming.suggestion);
      } else if (e.key === 'Enter' && pendingPolygon && pendingPolygon.length >= 3) {
        e.preventDefault();
        closePolygon();
      } else if (e.key === 'Escape') {
        // One priority order, stated once, because every one of these is
        // reachable at the same moment and "what does Escape do here" has to
        // have a single answer:
        //
        //   1. abandon a shape being drawn,
        //   2. abandon a shape waiting to be named,
        //   3. disarm the gate tool,
        //   4. act on the selection.
        //
        // Destructive last, so a mistimed Escape during a gesture cancels the
        // gesture rather than deleting something.
        if (pendingPolygon) { setPendingPolygon(null); setCursorData(null); setOverClose(false); }
        else if (drawBox) { drag.current = null; setDrawBox(null); }
        else if (naming) cancelNaming();
        else if (gateTool !== 'none') setGateTool('none');
        else if (!typing(e.target)) {
          // Exactly one thing is selected — a gate, a panel, or nothing — so
          // Escape has one target. What varies is which mounted canvas should
          // act, and that is what these guards decide: a *panel* selection names
          // its own panel, while a *gate* selection is global (it can be made
          // from the sidebar tree, where no panel is involved at all) so the
          // active panel handles it. Without a guard every mounted canvas would
          // race to run the same deletion.
          //
          // A gate gets a confirmation and a plot does not: deleting a gate
          // throws away analysis and can re-parent a subtree, deleting a plot
          // throws away an arrangement of four settings that Ctrl+Z restores.
          if (selectedGateId) {
            if (usePlot.getState().activePanelId !== panelId) return;
            e.preventDefault();
            askDeleteSelectedGates();
          } else {
            // The guard is still the *primary*, so exactly one of several
            // mounted canvases runs this — but what it deletes is the whole
            // selection, which since Item 4 may be more than the panel the
            // keystroke was routed through. One action, so one Ctrl+Z puts
            // every one of them back.
            const p = usePlot.getState();
            if (p.selectedPanelId !== panelId) return;
            e.preventDefault();
            p.removePanels(p.selectedPanelIds.length > 0 ? p.selectedPanelIds : [panelId]);
          }
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedGateId) {
        if (typing(e.target)) return;
        if (usePlot.getState().activePanelId !== panelId) return;
        e.preventDefault();
        askDeleteSelectedGates();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingPolygon, closePolygon, gateTool, setGateTool, setPendingPolygon,
      selectedGateId, gates, sample.id, naming, cancelNaming, confirmNaming, drawBox, panelId]);

  /* ---------------- Moving the whole panel ---------------- */

  /**
   * A press on the panel's background, anywhere on it.
   *
   * The DOM probe is here and the *rule* is in `panelDragTarget.ts`, deliberately:
   * "what counts as background" is the part that has now been got wrong twice —
   * once as the toolbar, which swallowed its own controls, and once as a 12 px
   * rail, which swallowed nothing and reached nothing either — so it is worth
   * being able to assert directly rather than through a rendered component.
   *
   * Note what is *not* consulted: whether the pointer is over an event. There is
   * no click-to-inspect gesture, the hover tooltip is passive and does not
   * consume a press, so a drag beginning over the densest part of a cloud is as
   * plain a "move this panel" as one beginning over empty plot.
   *
   * **And an armed tool ends the handler on its first line.** Stated twice on
   * purpose — here as an early return and again inside `shouldMovePanel` — because
   * the version of this that consulted `inDataRect` looked correct and was the
   * bug: it left the few pixels of axis margin as drag-to-move, which is exactly
   * where a rectangle gets started when the reason for starting there is to keep
   * the edge events inside it. A guard at the top of the handler cannot have that
   * kind of exception.
   */
  const onPanelPointerDown = (e: React.PointerEvent) => {
    if (!onMovePointerDown) return;
    // The hard lock. No position test, no hit test, no density heuristic: while a
    // drawing tool is armed this panel does not move, anywhere on it.
    if (gateTool !== 'none') return;
    const target = e.target as Element | null;
    const ok = shouldMovePanel({
      primaryButton: e.button === 0,
      onOwnGesture: !!target?.closest?.(NO_DRAG_SELECTOR),
      toolArmed: gateTool !== 'none',
      naming: !!naming,
    });
    if (!ok) return;
    // A move begins, so nothing is hovering any more: the plot is about to slide
    // out from under the pointer.
    setHover(null);
    onMovePointerDown(e);
  };

  // Membership of the selection, not identity with its primary: with Item 4
  // there can be several, and every one of them draws as selected.
  const isSelected = usePlot((s) => s.selectedPanelIds.includes(panelId));
  /**
   * Nothing anchors the selection to a panel — a gate picked from the sidebar
   * tree, where there was no panel involved.
   *
   * That gate is still selected and Escape still acts on it, so the treatment
   * has to appear somewhere: the active panel shows it, which is the same panel
   * the keystroke is routed to. Stating the two rules from one condition is what
   * stops the outline and the keystroke pointing at different plots.
   */
  const noPanelAnchor = usePlot((s) => s.selectedPanelId === null);
  const gateSelected = !!selectedGateId && (isSelected || (noPanelAnchor && isActive));

  return (
    <div
      ref={rootRef}
      data-panel={panelId}
      // What this panel is drawing, as a fact on the element rather than
      // something a harness infers from which layers happen to be present.
      // `SpectrumPanel` has carried the same attribute since it was written.
      data-plot-type={plotType}
      // Exposed so a harness can assert the drag phase directly rather than
      // inferring it from a cursor string, which is easy to read off the wrong
      // element.
      data-gate-leaving={dragOutside ? 'true' : undefined}
      data-selected={isSelected && !selectedGateId ? 'plot' : gateSelected ? 'gate' : undefined}
      className={cn(
        // `min-h-0` but no `flex-1`: the panel is as tall as its square plot
        // plus its chrome, and the worksheet sizes around that rather than the
        // other way around.
        'relative flex flex-col min-h-0 min-w-0 bg-[var(--surface-base)]',
        'rounded-[var(--radius-md)] border',
        isActive ? 'border-[var(--accent-500)]/60' : 'border-[var(--border-subtle)]',
        // The same interaction quality the rail carried, applied to the whole
        // draggable background rather than to twelve pixels of it. Controls,
        // resize handles and gate shapes all set their own cursor, which wins
        // over this one, so the pointer says "move" exactly where a press would
        // move something.
        onMovePointerDown && (moving ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      // Selection reads as an outline and says nothing in words. It used to
      // carry a badge — "Plot selected · Esc deletes" — which was accurate and
      // was also a label pinned to the corner of every selected plot, on a
      // worksheet where the plots are the point. Two states, told apart by
      // treatment alone:
      //
      //   plot  — solid, in a colour used for nothing else in the app;
      //   gate  — dashed, in that gate's own population colour, the one the tree
      //           shows beside its name.
      //
      // Solid versus dashed carries the distinction even where the two colours
      // land close together, which the population palette makes possible.
      style={{
        ...(isSelected && !selectedGateId
          ? { outline: '2px solid var(--select-panel)', outlineOffset: '2px' }
          : gateSelected && highlightColorIndex !== null
            ? { outline: `2px dashed var(${popVar(highlightColorIndex)})`, outlineOffset: '2px' }
            : null),
      }}
      // Capture, so selecting happens on the way down regardless of what the
      // click lands on — and before any handler that stops propagation. A gate's
      // own handler runs afterwards, in the bubble phase, and replaces this with
      // a gate selection; that ordering is what makes the two mutually exclusive
      // without either handler knowing about the other.
      //
      // **Except when the press is on a gate**, and this exception is the root of
      // the reported "hovering blocks gate editing". Clearing the gate selection
      // here *unmounts the selected gate's handles*, because they render only
      // while it is selected — and React skips a bubble-phase listener whose
      // element has gone during the same discrete dispatch, since a discrete
      // event flushes synchronously. So `onGatePointerDown` never ran, no drag
      // was ever armed, the pointer moved on with nothing in flight, and the
      // hover search answered instead: event circles, and a handle that did
      // nothing. Every gate kind whose handles are always drawn — a quadrant
      // origin, a range boundary — worked, which is what made this look like a
      // hit-testing problem rather than a lifecycle one.
      //
      // A gate's own handler sets both halves of the selection anyway, so
      // stepping aside here loses nothing.
      onPointerDownCapture={(e) => {
        if ((e.target as Element | null)?.closest?.('[data-gate]')) return;
        /*
           Ctrl+click toggles this plot in or out of the selection; a plain
           click collapses it to this one (2026-08-12, Item 4).

           **`metaKey` too, since the app builds for macOS** (2026-08-22). It
           read `ctrlKey` alone on the grounds that this was a Windows
           application; it is not one any more, and on a Mac Ctrl+click is the
           system's secondary-click gesture, so leaving it as the only modifier
           would make multi-select fire a context menu. Every other multi-select
           in this app — the sample list, the palette, undo — already accepts
           either, so this was the one place that did not.

           Shift is deliberately **not** a range here, which is the one place
           this parts company with the sidebar. A range needs an order to
           measure along and a worksheet is two-dimensional: the panels are at
           `x`/`y` coordinates somebody arranged, so "everything between these
           two" has no answer that is not invented. Ctrl or Cmd each one.
        */
        if (e.ctrlKey || e.metaKey) { togglePanelSelection(panelId); return; }
        selectPanelOnly(panelId);
      }}
      // **The whole panel background moves it.** Bubble phase, so anything that
      // owns its own gesture has already had the chance to claim the press:
      // a gate calls `stopPropagation`, and everything else is named in
      // `NO_DRAG_SELECTOR`. The old 12 px rail is gone with this — see
      // `panelDragTarget.ts` for why the exception list replaced it rather than
      // the restriction simply being lifted.
      onPointerDown={onPanelPointerDown}
    >
      {/* ---------------- Toolbar ---------------- */}
      {/* `gap-1` and icon-only controls below the compact threshold, because the
          delete control is the last item in the row and the row clips: at 280 px
          the labelled plot-type switch alone pushed the "×" past the right edge,
          which is how a panel ends up with no visible way to close it. Removing
          the sample pin and the rail bought some of it back; dropping the three
          text labels is what actually made it fit. */}
      <div className={cn('flex items-center h-8 shrink-0 hairline-b overflow-hidden', compact ? 'px-1.5 gap-1' : 'px-2 gap-2')}>
        {/* Sample › population breadcrumb. Once panels can be conjured by
            dragging a gate out of the tree, "which subset am I looking at" stops
            being answerable by cross-referencing the sidebar. Every panel shows
            it, including ones built before any of this existed — an unscoped
            panel simply reads "All events". */}
        <PopulationBreadcrumb
          panelId={panelId}
          sampleName={sample.name}
          gates={gates}
          populationId={populationId}
          scopePath={scopePath}
          compact={!!compact}
        />
        {/*
            "This plot is showing unmixed data."

            After a matrix is applied, an unmixed abundance is a parameter like
            any other — that is the whole design, and it is what made the feature
            usable — but it is also what made this indistinguishable from raw
            detector data at a glance. The only way to tell a plot of `CD4 RB744`
            from a plot of `B10-A` was to recognise the axis label as a
            fluorophore identity somebody typed in Step 2, on a screen that may
            hold eight plots and was built by somebody else.

            The distinction is not cosmetic. A raw detector reading and an
            unmixed abundance are different measurements of different things —
            one is what a detector saw, the other is what the solve attributed to
            a dye across every detector — and a gate drawn on the wrong one is a
            population defined on the wrong quantity.

            On the breadcrumb rather than beside the axis label: it is a fact
            about *this plot*, one badge answers both axes, and the toolbar row
            clips from the right, so a per-axis marker would be the first thing
            lost at 290 px. The hint names the parameters, because "which of
            these two axes" is the immediate next question.
        */}
        {unmixedAxes.length > 0 && (
          <Badge tone="accent">
            <span className="inline-flex items-center gap-1 shrink-0" data-unmixed-badge="">
              <Waves size={9} />
              {compact ? 'unmix' : 'Unmixed'}
              <InfoHint
                content={
                  `${unmixedAxes.join(' and ')} ${unmixedAxes.length > 1 ? 'are' : 'is'} an unmixed `
                  + 'abundance from the applied matrix, not a raw detector. '
                  + 'The file’s own detector channels are untouched and still on the axis picker.'
                }
              />
            </span>
          </Badge>
        )}
        {/* No event count here. It was the widest thing in the row — "1 234 567
            events" is 110 px — it was the first thing to be dropped at compact
            width so it was not even reliably present, and the same number is
            reported per population in the statistics table, where it can be read
            against the populations either side of it. A count that only appears
            on wide panels is not somewhere anybody looks for a count. */}
        {/* Compact drops the words and keeps the hint: the badge is the warning,
            and at 290 px "Display subsampled" is 100 px that the toolbar does not
            have. Above the threshold it reads normally. */}
        {sub && (
          <Badge tone="warn">
            <span className="inline-flex items-center gap-1 shrink-0">
              {compact ? 'sub' : 'Display subsampled'}
              <InfoHint
                content={`Showing ${sub.length.toLocaleString()} of ${viewX.length.toLocaleString()} events for rendering speed. Statistics and gate percentages always use every event — only the picture is thinned.`}
              />
            </span>
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <SegmentedControl
            size="sm"
            iconOnly={compact}
            value={plotType}
            onChange={(t) => setPlotType(panelId, t)}
            segments={[
              { value: 'scatter', label: 'Dot', icon: <ScatterChart size={11} />, title: 'Dot plot — every event as a point' },
              { value: 'density', label: 'Density', icon: <Grid3x3 size={11} />, title: 'Binned density — stays fast at any event count' },
              { value: 'contour', label: 'Contour', icon: <Spline size={11} />, title: 'Probability contours — lines enclosing 10, 30, 50, 70 and 90% of the events' },
              { value: 'histogram', label: 'Hist', icon: <BarChart3 size={11} />, title: '1D histogram of the x parameter' },
            ]}
          />
          {plotType === 'density' && (
            <ColorLevelsControl
              scale={densityScale}
              settings={{
                ramp, colorStyle, colorScaling, binCount, smoothing, smoothingAuto, outlierSize,
              }}
              resolved={smoothingAuto ? resolvedSmoothing : smoothing}
              // The whole panel, so the settings open beside the plot rather than
              // over it. Anchoring to the toolbar icon — which is what a popover
              // does — puts a 280 px panel across the middle of a 227 px graph.
              panelRef={rootRef}
              onScale={(v) => setDensityScale(panelId, v)}
              onChange={(patch) => setColorLevels(panelId, patch)}
              onRestore={() => restoreColorLevels(panelId)}
            />
          )}
          {plotType === 'histogram' && (
            <HistogramControl
              panelId={panelId}
              bins={binCount} smoothing={smoothing} overlayIds={overlayIds}
              samples={allSamples} currentId={sample.id}
              onBins={(v) => setBinCount(panelId, v)} onSmoothing={(v) => setSmoothing(panelId, v)}
            />
          )}
          {/* A rule between two controls and a rule between two controls and
              nothing are different things. Compact has neither the appearance
              popover nor the gridline toggle, so the divider would be separating
              the plot-type switch from the export button and costing the
              breadcrumb a dozen pixels to do it. */}
          {!compact && <VDivider />}
          {plotType === 'scatter' && !compact && (
            <AppearanceControl
              pointSize={pointSize}
              alpha={alpha}
              autoAlpha={alphaForCount(renderX.length)}
              onPointSize={(v) => setPointSize(panelId, v)}
              onAlpha={(v) => setAlpha(panelId, v)}
            />
          )}
          {!compact && (
            <Tooltip content={showGrid ? 'Hide gridlines' : 'Show gridlines'}>
              <IconButton label="Toggle gridlines" size="sm" active={showGrid} onClick={() => toggleGrid(panelId)}>
                <Grid3x3 size={13} />
              </IconButton>
            </Tooltip>
          )}
          <FigureExport source={figureSource} disabled={glFailed} label="Export plot image" />
          {panelActions}
        </div>
      </div>

      {/* ---------------- Plot ---------------- */}
      <div
        ref={wrapRef}
        // Height set, not stretched: `flex-1` here is what let the worksheet
        // decide the plot's aspect ratio, so a single panel on a wide screen
        // came out wide and short.
        data-plot-surface=""
        className="relative shrink-0 min-w-0 bg-[var(--surface-plot)] select-none"
        style={{
          height: squareHeight,
          // Until the observer has measured this panel, `squareHeight` is
          // undefined and the box would collapse to nothing — every child is
          // absolutely positioned, so there is no content to hold it open. One
          // frame of a zero-height plot is a visible flicker when a panel is
          // added, and it makes the panel briefly unhittable.
          minHeight: 160,
          // Cursor comes from one mapping rather than utility classes, so an
          // armed gate tool always reads as "this click draws" — see
          // plotCursor.ts.
          cursor: plotCursor({
            gateTool, overPolygonClose: overClose,
            gateLeavingPlot: !!dragOutside,
            panelMoving: !!moving,
          }),
        }}
        onPointerDownCapture={() => { if (!isActive) setActivePanel(panelId); }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // The axis readout goes with the pointer. Leaving it behind would put a
        // stale coordinate on a plot the cursor is no longer over, and the polygon
        // rubber band would keep reaching for a point that is not there.
        onPointerLeave={() => { setHover(null); setCursorData(null); setOverClose(false); }}
        onDoubleClick={() => {
          // Closes a polygon and does nothing else. It used to reset the view as
          // well, which is one of the two undiscoverable gestures this pass
          // removed along with the view transform itself.
          if (naming) return;
          if (pendingPolygon && pendingPolygon.length >= 3) closePolygon();
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute pointer-events-none"
          style={{ left: MARGIN.left, top: MARGIN.top, width: plotW, height: plotH }}
        />

        {plotType === 'density' && plotW > 0 && plotH > 0 && (
          <DensityLayer
            x={viewX}
            y={viewY}
            viewport={view}
            width={plotW}
            height={plotH}
            // Every setting, from the one object the exporter also spreads —
            // see `densitySpec`. Nothing density-related belongs here as a
            // literal, because a setting stated here and nowhere else is a
            // setting the exported figure will not have.
            {...densitySpec}
            // What the plot settled on under Auto comes back through here,
            // purely so the panel can show the number. An export has nobody to
            // report to, which is why this is the one prop that is not shared.
            onSmoothing={setResolvedSmoothing}
            // No overlay pass. Marking the selected population over the map was a
            // white stamp at 0.9 alpha, which on any gate holding real events was
            // a solid slab over the gate's own interior — you selected a gate and
            // could no longer see what was in it. The outline says which gate is
            // selected; that is what an outline is for.
            style={{ left: MARGIN.left, top: MARGIN.top }}
          />
        )}

        {/* ---------------- Axis double-click targets ----------------
            "Double-click the axis" has to mean the axis as drawn — the rule and
            its numbers — not just the little parameter button underneath it.
            Those are painted into the `pointer-events: none` SVG, so the target
            is a transparent strip over the same band. Single clicks fall through
            to the panel drag exactly as the rest of the margin does; only the
            second click of a double means anything here.

            **These are rendered before the SVG, and that ordering is Item 10's
            first half.** They used to come after it. The SVG is
            `pointer-events: none` and only its gate shapes and 16 px handle
            targets opt back in — but with no z-index anywhere, DOM order decides
            what is on top, so these two divs sat over the whole gate layer. The y
            strip is `MARGIN.left` px wide and the full height of the plot, so a
            gate boundary at or just past the left axis has half or all of its
            handle target underneath it; the x strip does the same along the
            bottom. The strips inherit the plot surface's own `grab` cursor, which
            is exactly the reported symptom — a hand where a resize arrow belongs,
            "near/at the left side, especially close to or past the left axis".

            The reason it looked like a cursor-only bug is that the *drag* mostly
            still worked: a press that did reach the handle armed `gateDrag`
            normally, so the behaviour was right wherever the pointer happened to
            land on an uncovered pixel of the target, and only the feedback was
            wrong everywhere.

            Reordering rather than adding a z-index, because a z-index would also
            raise the SVG above the axis parameter buttons and let a gate outline
            paint over them. This way the paint order is unchanged and only the
            hit-test precedence moves — and it moves the right way: a 16 px handle
            target is a deliberate aim, a full-height strip is a fallback. A
            double-click in the margin still reaches the strip, because the SVG
            passes through everything it does not claim. */}
        <div
          className="absolute"
          style={{ left: MARGIN.left, right: MARGIN.right, top: MARGIN.top + plotH, height: 16 }}
          onDoubleClick={() => focusAxis(panelId, 'x')}
          title="Double-click for axis settings — parameter, scale and range"
        />
        <div
          className="absolute"
          style={{ left: 0, top: MARGIN.top, width: MARGIN.left, height: plotH }}
          onDoubleClick={() => focusAxis(panelId, 'y')}
          title="Double-click for axis settings — parameter, scale and range"
        />

        {size.w > 0 && (
          <svg
            ref={svgRef}
            width={size.w}
            height={size.h}
            className="absolute inset-0 pointer-events-none"
            shapeRendering="crispEdges"
          >
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {showGrid && (
                <g>
                  {xTicks.filter((t) => !t.minor).map((t) => (
                    <line key={`gx${t.display}`} x1={toPixelX(t.display)} y1={0} x2={toPixelX(t.display)} y2={plotH} stroke="var(--plot-grid)" strokeWidth={1} />
                  ))}
                  {yTicks.filter((t) => !t.minor).map((t) => (
                    <line key={`gy${t.display}`} x1={0} y1={toPixelY(t.display)} x2={plotW} y2={toPixelY(t.display)} stroke="var(--plot-grid)" strokeWidth={1} />
                  ))}
                </g>
              )}

              {/* Axis rules */}
              <line x1={0} y1={plotH} x2={plotW} y2={plotH} stroke="var(--plot-axis)" strokeWidth={1} />
              <line x1={0} y1={0} x2={0} y2={plotH} stroke="var(--plot-axis)" strokeWidth={1} />

              {/* Ticks — geometricPrecision on the labels so text stays smooth.
                  `--font-numeric`, not `--font-mono`: a tick is a measurement,
                  and every monospace face draws a dotted or slashed zero that
                  reads as an 8 at 9.5 px. See the token. */}
              <g shapeRendering="geometricPrecision" fontFamily="var(--font-numeric)" fontSize={9.5} fill="var(--plot-label)">
                {xTicks.map((t) => {
                  const x = toPixelX(t.display);
                  return (
                    <g key={`x${t.display}`}>
                      <line x1={x} y1={plotH} x2={x} y2={plotH + (t.minor ? 2 : 3.5)} stroke="var(--plot-tick)" strokeWidth={1} shapeRendering="crispEdges" />
                      {!t.minor && <text x={x} y={plotH + 12} textAnchor="middle" aria-label={t.label}><TickLabel label={t.label} /></text>}
                    </g>
                  );
                })}
                {/* Tagged so a harness can read the labels this axis actually
                    rendered, rather than the state that was meant to produce
                    them — the histogram y-axis bug was invisible in the store
                    and visible only here. */}
                <g data-axis-ticks="y">
                  {yTicks.map((t) => {
                    const y = toPixelY(t.display);
                    return (
                      <g key={`y${t.display}`}>
                        <line x1={-(t.minor ? 2 : 3.5)} y1={y} x2={0} y2={y} stroke="var(--plot-tick)" strokeWidth={1} shapeRendering="crispEdges" />
                        {!t.minor && <text x={-4.5} y={y + 3.2} textAnchor="end" aria-label={t.label}><TickLabel label={t.label} /></text>}
                      </g>
                    );
                  })}
                </g>
              </g>

              {plotType === 'contour' && contours && (
                <g data-contour-layer="" fill="none" stroke="var(--text-primary)" strokeWidth={1} strokeLinejoin="round" pointerEvents="none">
                  {contours.sets.flatMap((set) => set.lines.map((line, i) => (
                    <path
                      key={`${set.fraction}-${i}`}
                      data-contour={set.fraction}
                      d={line.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${toPixelX(x).toFixed(2)},${toPixelY(y).toFixed(2)}`).join('')}
                    />
                  )))}
                </g>
              )}

              {plotType === 'histogram' && (
                <HistogramLayer
                  series={histogramSeries}
                  xMin={view.xMin}
                  xMax={view.xMax}
                  width={plotW}
                  binCount={binCount}
                  smoothing={smoothing}
                  toPixelY={toPixelY}
                />
              )}

              {/*
                 The Biophysics fit, when this panel is showing one.

                 One line here and no coupling anywhere else: `FitOverlay` asks
                 its own three questions — is this a histogram of the property's
                 parameter, on a sample the pipeline has fitted, scoped to the
                 population it was fitted over — and returns null otherwise. A
                 workspace that has never opened that panel fails the first check
                 against an empty list.

                 Under the gates rather than over them, because a gate is the
                 analysis and the curve is the account of where it came from.
              */}
              {plotType === 'histogram' && (
                <FitOverlay
                  rows={fitRows}
                  populationId={panel?.populationId ?? null}
                  plotW={plotW}
                  plotH={plotH}
                  toPixelX={toPixelX}
                  toPixelY={toPixelY}
                />
              )}

              {/* Gates. A histogram still shows range gates — they are the only
                  kind whose geometry means anything against a density y axis —
                  and a scatter plot shows one against whichever of its two axes
                  carries the parameter it cuts. */}
              {evaluated && (
                <GateLayer
                  gates={viewGates}
                  // Where the user has nudged each label out of the data, and
                  // the two gestures that put it there. Both go through the same
                  // store actions the sidebar uses, so a name has one source and
                  // an offset one home.
                  labelOffsets={panel?.labelOffsets}
                  onLabelMove={(gateId, dx, dy) => setLabelOffset(panelId, gateId, dx, dy)}
                  onLabelRename={(gateId, at) => setRenamingLabel({ gateId, ...at })}
                  stats={evaluated.stats}
                  selectedGateId={selectedGateId}
                  xParam={xi}
                  yParam={yi}
                  oneDimensional={oneDimensional}
                  toPixelX={toPixelX}
                  toPixelY={toPixelY}
                  plotW={plotW}
                  plotH={plotH}
                  activeHandle={null}
                  onGatePointerDown={onGatePointerDown}
                />
              )}

              {pendingPolygon && pendingPolygon.length > 0 && (
                <PendingPolygon
                  vertices={pendingPolygon}
                  cursor={cursorData}
                  closable={pendingPolygon.length >= 3}
                  overClose={overClose}
                  snapRadius={CLOSE_SNAP_PX}
                  toPixelX={toPixelX}
                  toPixelY={toPixelY}
                />
              )}

              {/* Gate being drawn.
                  **Gate ink over gate casing, at the finished widths** — the same
                  two constants `GateLayer` uses, imported rather than repeated.
                  These were `--accent-400` over an `--accent-500` wash, so a gate
                  was blue for the whole drag and near-black the instant the button
                  came up. Nothing changes about a shape at that moment except that
                  it becomes real, so nothing about how it is drawn should change
                  either; the colour transition was reporting an event that has no
                  visual consequence. Each is drawn twice, casing first, because
                  half of any gate's outline crosses empty plot and a black line on
                  `#0a0c10` is not an outline. */}
              {drawBox && gateTool === 'rectangle' && (
                <PendingOutline plotH={plotH}>
                  {(stroke, ink) => (
                    <rect
                      x={Math.min(drawBox.x0, drawBox.x1)}
                      y={Math.min(drawBox.y0, drawBox.y1)}
                      width={Math.abs(drawBox.x1 - drawBox.x0)}
                      height={Math.abs(drawBox.y1 - drawBox.y0)}
                      fill={ink ? PENDING_FILL : 'none'}
                      fillOpacity={ink ? PENDING_FILL_OPACITY : undefined}
                      {...stroke}
                    />
                  )}
                </PendingOutline>
              )}
              {drawBox && gateTool === 'ellipse' && (
                <PendingOutline plotH={plotH}>
                  {(stroke, ink) => (
                    <ellipse
                      cx={(drawBox.x0 + drawBox.x1) / 2}
                      cy={(drawBox.y0 + drawBox.y1) / 2}
                      rx={Math.abs(drawBox.x1 - drawBox.x0) / 2}
                      ry={Math.abs(drawBox.y1 - drawBox.y0) / 2}
                      fill={ink ? PENDING_FILL : 'none'}
                      fillOpacity={ink ? PENDING_FILL_OPACITY : undefined}
                      {...stroke}
                    />
                  )}
                </PendingOutline>
              )}
              {/* A range gate spans the full height whatever the vertical drag was. */}
              {drawBox && gateTool === 'range' && (
                <PendingOutline plotH={plotH}>
                  {(stroke, ink) => (
                    <rect
                      x={Math.min(drawBox.x0, drawBox.x1)}
                      y={0}
                      width={Math.abs(drawBox.x1 - drawBox.x0)}
                      height={plotH}
                      fill={ink ? PENDING_FILL : 'none'}
                      fillOpacity={ink ? PENDING_FILL_OPACITY : undefined}
                      {...stroke}
                    />
                  )}
                </PendingOutline>
              )}

              {/* Hover crosshair. Never while a tool is armed, a gate is being
                  edited or the panel is being moved — see `tooltipSuppressed`. */}
              {hover && !tooltipSuppressed && (
                <g shapeRendering="geometricPrecision">
                  <circle cx={hover.x} cy={hover.y} r={4.5} fill="none" stroke="var(--pop-06)" strokeWidth={1.25} />
                  <line x1={hover.x} y1={0} x2={hover.x} y2={plotH} stroke="var(--pop-06)" strokeOpacity={0.28} strokeWidth={1} strokeDasharray="2 3" />
                  <line x1={0} y1={hover.y} x2={plotW} y2={hover.y} stroke="var(--pop-06)" strokeOpacity={0.28} strokeWidth={1} strokeDasharray="2 3" />
                </g>
              )}
            </g>
          </svg>
        )}

        {/* Name the population that was just drawn, where it was drawn. */}
        {naming && (
          <GateNamePrompt
            suggestion={naming.suggestion}
            quadrant={naming.quadrant}
            onType={(v) => { namingValueRef.current = v; }}
            left={MARGIN.left + naming.at.x}
            top={MARGIN.top + naming.at.y}
            maxLeft={size.w}
            // The populations this panel can see, which on a reference
            // worksheet includes the wizard's own and everywhere else does not
            // — the same list the tree and the plot are drawing from, so the
            // prompt never offers to replace a gate the user cannot see.
            existing={gates}
            onConfirm={confirmNaming}
            onReplace={replaceWithPending}
            onCancel={cancelNaming}
          />
        )}

        {/* Renaming a gate by double-clicking its label on the plot.

            A second entry point, not a second implementation: it calls
            `renameGate`, which is the same action the sidebar tree's three
            rename routes call, so the name has one home and every view that
            shows it reads that one. Positioned at the label's own coordinates so
            the editor opens exactly where the text was rather than somewhere the
            user has to look for. */}
        {renamingLabel && (
          <GateLabelRename
            key={renamingLabel.gateId}
            initial={gates.find((g) => g.id === renamingLabel.gateId)?.name ?? ''}
            left={MARGIN.left + renamingLabel.x}
            top={MARGIN.top + renamingLabel.y}
            onCommit={(name) => {
              useGates.getState().renameGate(sample.id, renamingLabel.gateId, name);
              setRenamingLabel(null);
            }}
            onCancel={() => setRenamingLabel(null)}
          />
        )}

        {/* Axis parameter pickers, on the plot rather than in a dialog.

            The container is `pointer-events-none` with the control itself
            claiming events, matching the y axis below. It was `pointer-events-auto`
            across the full width of the bottom margin, which made a strip of empty
            space beside a centred button into a pointer target for no reason —
            the same class of problem as the axis strips above, in a band a gate's
            bottom handles come within a few pixels of. The `onDoubleClick` still
            fires: an event originating in the child bubbles through a
            `pointer-events: none` parent normally. */}
        <div
          className="absolute pointer-events-none"
          style={{ left: MARGIN.left, right: MARGIN.right, bottom: 3, display: 'flex', justifyContent: 'center' }}
          onDoubleClick={() => focusAxis(panelId, 'x')}
        >
          <span className="pointer-events-auto">
          <AxisControl
            parameters={params}
            value={xi}
            transform={xTransform}
            overrides={xOverrides}
            resolved={specX}
            // The transform comes with the parameter. Without this, selecting a
            // fluorescence channel on an axis that had been showing FSC-A left
            // the axis linear, which plots a fluorescence distribution as a
            // spike on the floor and nothing else.
            onParam={(i) => setAxis(panelId, 'x', i, transformFor(params[i]))}
            onTransform={(k) => {
              useTransformPrefs.getState().remember(px?.name ?? '', k);
              setTransform(panelId, 'x', k);
            }}
            onOverride={(key, v) => setOverride(panelId, 'x', key, v)}
            onReset={() => clearOverrides(panelId, 'x')}
          />
          </span>
        </div>
        {/* The y control is laid out horizontally and then rotated as a whole.
            CSS writing-mode would keep it upright but breaks text truncation and
            collapses the button's inline size, which silently hid the label. */}
        <div
          className="absolute pointer-events-none"
          style={{ left: 0, top: MARGIN.top, width: 26, height: plotH }}
          onDoubleClick={() => focusAxis(panelId, 'y')}
        >
          <div
            data-axis-label="y"
            className="absolute left-1/2 top-1/2 whitespace-nowrap pointer-events-auto"
            style={{ transform: 'translate(-50%, -50%) rotate(-90deg)' }}
          >
            {/* A histogram has no y parameter to pick. The control used to be
                rendered here anyway, so the axis offered a choice that changed
                the tick labels and nothing else — see `DENSITY_TICKS`. A label
                states what the axis is instead of a picker that cannot act. */}
            {plotType === 'histogram' ? (
              <span className="text-[11px] text-[var(--text-secondary)] select-none">
                {DENSITY_AXIS_LABEL}
              </span>
            ) : (
              <AxisControl
                parameters={params}
                value={yi}
                transform={yTransform}
                overrides={yOverrides}
                resolved={specY}
                onParam={(i) => setAxis(panelId, 'y', i, transformFor(params[i]))}
                onTransform={(k) => {
                  useTransformPrefs.getState().remember(py?.name ?? '', k);
                  setTransform(panelId, 'y', k);
                }}
                onOverride={(key, v) => setOverride(panelId, 'y', key, v)}
                onReset={() => clearOverrides(panelId, 'y')}
              />
            )}
          </div>
        </div>

        {/* Hover readout — suppressed for the same four reasons as the crosshair
            above, the armed tool included. See `tooltipSuppressed`. */}
        {hoverValues && hover && !tooltipSuppressed && (
          <div
            className={cn(
              'absolute z-10 pointer-events-none anim-fade',
              'rounded-[var(--radius-sm)] border border-[var(--border-default)]',
              'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)] px-2 py-1.5',
            )}
            style={{
              left: Math.min(MARGIN.left + hover.x + 12, size.w - 190),
              top: Math.max(4, MARGIN.top + hover.y - 44),
            }}
          >
            <p className="text-[10px] text-[var(--text-disabled)] mb-0.5">
              Event {(hoverValues.eventIndex + 1).toLocaleString()}
            </p>
            <div className="space-y-0.5">
              <ReadoutRow name={px?.label ?? 'x'} value={hoverValues.rawX} />
              {/* Only one parameter is on screen in a histogram; reading out a
                  second one names a channel the plot is not showing. */}
              {plotType !== 'histogram' && (
                <ReadoutRow name={py?.label ?? 'y'} value={hoverValues.rawY} />
              )}
            </div>
          </div>
        )}

        {/* What replaces it while drawing: the two axis values under the
            crosshair, and nothing else.

            One line of mono digits rather than a card, and placed **below and to
            the right** of the cursor. Both are the point. The tooltip it stands in
            for is a bordered box a dozen pixels away that covers the events
            immediately around the pixel being clicked, and the whole gesture is
            aiming at one of those pixels; a single line offset away from the
            aiming quadrant answers "where am I on these axes" without hiding the
            answer to "what is here". No parameter names — the axes are labelled a
            few pixels away and the pair is ordered x then y. */}
        {cursorReadout && (
          <div
            data-cursor-readout=""
            className={cn(
              'absolute z-10 pointer-events-none select-none',
              'font-mono tnum text-[9.5px] leading-none tracking-tight',
              'px-1 py-[3px] rounded-[var(--radius-xs)]',
              'bg-[var(--surface-overlay)]/85 text-[var(--text-secondary)]',
            )}
            style={{ left: cursorReadout.left, top: cursorReadout.top }}
          >
            {cursorReadout.text}
          </div>
        )}

        {/* First-use hint. The click-to-close gesture is not discoverable from
            the toolbar, and a user who does not find it concludes the tool is
            broken rather than that they missed a step. */}
        {showGateHint && (
          <div
            className={cn(
              'absolute z-10 anim-rise flex items-center gap-2',
              'rounded-[var(--radius-sm)] border border-[var(--border-default)]',
              'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)] pl-2.5 pr-1.5 py-1.5',
            )}
            style={{ left: MARGIN.left + 10, top: MARGIN.top + 10, maxWidth: Math.max(160, plotW - 20) }}
          >
            <span className="text-2xs text-[var(--text-secondary)] leading-snug">{GATE_HINTS[gateTool]}</span>
            <IconButton label="Dismiss hint" size="sm" onClick={dismissGateHint}>
              <X size={12} />
            </IconButton>
          </div>
        )}

        {/* The refused gesture, said out loud (2026-08-11, Item 16).

            Below the first-use hint's slot rather than in it: a user who has
            just armed the polygon tool on a histogram sees both, and they answer
            different questions — one says what the tool does, this one says why
            it did not do it here. Dismissible, and it also clears itself the
            moment the tool or the plot type changes, which is what following the
            advice looks like. */}
        {refusal && (
          <div
            data-gate-refusal=""
            role="status"
            className={cn(
              'absolute z-20 anim-rise flex items-start gap-2',
              'rounded-[var(--radius-sm)] border border-[var(--status-warn)]/45',
              'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)] pl-2.5 pr-1.5 py-1.5',
            )}
            style={{
              left: MARGIN.left + 10,
              top: MARGIN.top + (showGateHint ? 48 : 10),
              maxWidth: Math.max(180, plotW - 20),
            }}
          >
            <AlertTriangle size={12} className="shrink-0 mt-px text-[var(--status-warn)]" />
            <span
              className="text-2xs text-[var(--text-secondary)] leading-snug"
              title={HISTOGRAM_GATE_REFUSAL_WHY}
            >
              {refusal}
            </span>
            <IconButton label="Dismiss" size="sm" onClick={() => setRefusal(null)}>
              <X size={12} />
            </IconButton>
          </div>
        )}

        {/* An empty population is a real analytical result — a marker nobody
            expressed — not a broken plot. Say which population and how it got
            there, so the axes below read as an empty plot rather than a failure
            to draw one. */}
        {scope && scope.length === 0 && !glFailed && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none anim-fade">
            <div className="max-w-[34ch] text-center space-y-1 px-6">
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                0 events in {scopeGate?.name ?? 'this population'}
              </p>
              <p className="text-2xs text-[var(--text-tertiary)]">
                Its parent gate excludes every event. Adjust the gate upstream, or delete it.
              </p>
            </div>
          </div>
        )}

        {glFailed && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="max-w-[42ch] text-center space-y-1.5 px-6">
              <p className="text-base font-medium text-[var(--status-err)]">WebGL2 is unavailable</p>
              <p className="text-xs text-[var(--text-tertiary)]">
                The plot renderer needs a WebGL2 context. This usually means hardware acceleration is disabled or the
                GPU driver is blocklisted. Metadata and parameters still work in the inspector.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* The gate has left this plot: releasing now opens a plot of it. Fixed,
          so it tracks the pointer across the whole worksheet rather than being
          clipped at the panel that owns the drag. */}
      {dragOutside && (
        <div
          data-drag-hint=""
          className={cn(
            'fixed z-50 pointer-events-none flex items-center gap-2 px-2.5 py-1.5',
            'rounded-[var(--radius-sm)] border border-[var(--accent-500)]',
            'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)] text-xs anim-fade',
          )}
          style={{ left: dragOutside.x + 14, top: dragOutside.y + 10 }}
        >
          <LayoutGrid size={12} className="text-[var(--text-accent)]" />
          <span className="text-[var(--text-primary)]">
            Release for a plot of <strong className="font-medium">{dragOutside.name}</strong>
          </span>
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * Name the population that was just drawn.
 *
 * Inline and next to the shape, not a modal: the gesture is not finished, and a
 * dialog that takes over the window to ask one question makes drawing five
 * gates feel like filling in a form five times. The field is pre-filled and
 * pre-selected, so Enter alone is a complete answer and typing replaces the
 * suggestion without anyone having to clear it first.
 */
function GateNamePrompt({
  suggestion, quadrant, left, top, maxLeft, existing, onConfirm, onReplace, onCancel, onType,
}: {
  suggestion: string;
  quadrant: boolean;
  left: number;
  top: number;
  maxLeft: number;
  /** Populations already on this plot's sample, offered to redefine. */
  existing: Gate[];
  onConfirm: (name: string) => void;
  onReplace: (gateId: string, name: string) => void;
  onCancel: () => void;
  /** Keeps the canvas's window-level Enter handler in step with the field. */
  onType: (v: string) => void;
}) {
  const [value, setValue] = useState(suggestion);
  /** Showing the list of existing populations to take over. */
  const [browsing, setBrowsing] = useState(false);
  /**
   * The gate this name would collide with, once the user has tried to commit.
   *
   * Held rather than derived from `value`, because a warning that appears while
   * somebody is still typing fires on every prefix of every existing name —
   * "C", "CD", "CD4" — and a prompt that flickers a red panel at you mid-word is
   * worse than the collision it is reporting. The check happens on **commit**,
   * which is the moment there is something to decide.
   */
  const [collision, setCollision] = useState<Gate | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  /** Trimmed, case-insensitive: "CD4" and "cd4 " are one population, not two. */
  const match = (name: string) =>
    existing.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null;

  /**
   * Enter, or a click on the confirm control.
   *
   * A name already in use stops here instead of going through, which is the
   * whole of the first half of Item 9: before this, two populations could carry
   * one name, and from then on every surface that identifies a population *by*
   * name — the export's path column, the compare chart's population picker, the
   * statistics table's grouping — had two answers and no way to say so.
   */
  const commit = (name: string) => {
    const clean = name.trim() || suggestion;
    // A quadrant produces four names from one stem, so there is no single gate
    // for it to take over. Collisions are still refused — see the callout below
    // — but the answer there is a different stem rather than a replacement.
    if (quadrant) { onConfirm(clean); return; }
    const hit = match(clean);
    if (hit) { setCollision(hit); return; }
    onConfirm(clean);
  };

  /** Back to editing, with the field focused and the text selected. */
  const reopen = () => {
    setCollision(null);
    setBrowsing(false);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select(); });
  };

  useLayoutEffect(() => {
    setValue(suggestion);
    setCollision(null);
    setBrowsing(false);
    // Synchronously, before paint. Deliberately **not** inside
    // `requestAnimationFrame`: Chromium throttles rAF to about 1 Hz in a
    // background or hidden window, so the field would sit unfocused for up to a
    // second and the user's first keystroke would go to the window instead of
    // into the name. The window-level Enter handler covers that case anyway,
    // but a prompt that is not ready when it appears is a prompt that eats
    // input.
    ref.current?.focus();
    ref.current?.select();
  }, [suggestion]);

  const WIDTH = 228;
  return (
    <div
      className={cn(
        'absolute z-30 pointer-events-auto anim-fade',
        'rounded-[var(--radius-sm)] border border-[var(--accent-500)]',
        'bg-[var(--surface-overlay)] shadow-[var(--shadow-overlay)] p-1.5',
      )}
      data-gate-name-prompt=""
      style={{ left: Math.min(left, Math.max(0, maxLeft - WIDTH - 8)), top, width: WIDTH }}
      // The prompt sits over the canvas, whose pointer handlers would otherwise
      // read a click in the text field as the start of a new gesture.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label className="block text-[10px] text-[var(--text-tertiary)] mb-1 px-0.5">
        {quadrant ? 'Name these four populations' : 'Name this population'}
      </label>
      <input
        ref={ref}
        data-gate-name-input=""
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onType(e.target.value);
          // Typing is how you answer a collision warning, so answering it clears
          // the warning. Otherwise the panel stays up over a name that no longer
          // collides with anything.
          if (collision) setCollision(null);
        }}
        onKeyDown={(e) => {
          // Handled here and stopped, so the canvas's window-level Escape
          // handler does not also fire and race this one.
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(value); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        // Clicking elsewhere accepts, matching how an inline rename behaves
        // everywhere else in the app. Escape is the way to discard.
        //
        // Except when the blur hands focus to *nothing*. That is not a user
        // clicking away — it is the browser's default mousedown handling
        // resetting focus to the body after this field was focused from inside
        // the same event dispatch, which is what made a polygon commit under its
        // suggested name the instant the prompt appeared. A real click-away
        // lands on some element; a focus reset lands on `body`.
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null;
          if (!next || next === document.body) { ref.current?.focus(); return; }
          // A click onto this prompt's own controls is not a click away: the
          // browse list and the replace buttons live inside the popover, and
          // committing on the way to pressing one of them would add the gate a
          // moment before the user said what to do with it.
          if (next.closest?.('[data-gate-name-prompt]')) return;
          commit(value);
        }}
        className={cn(
          'w-full h-6 px-1.5 rounded-[var(--radius-xs)] text-xs',
          'bg-[var(--surface-sunken)] border border-[var(--border-default)]',
          'text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]',
          collision && 'border-[var(--status-warn)]',
        )}
      />

      {/*
         The name is already taken (2026-08-12, Item 9).

         A confirmation rather than a refusal, which is the option the report
         called the more useful of the two — and it is, because the reason
         somebody types a name that exists is almost always that they mean *that
         population*. Replacing keeps the existing gate's id, so its children
         come with it; see `replaceGate`.

         A quadrant gets the refusal instead. One drawn shape cannot stand in
         for four populations, so there is nothing to offer.
      */}
      {collision && (
        <div data-gate-name-collision="" className="mt-1.5 px-0.5">
          <p className="text-[10px] text-[var(--text-secondary)] leading-snug">
            A population called <strong className="font-medium">{collision.name}</strong> already exists.
          </p>
          <div className="flex items-center gap-1 mt-1.5">
            <Button
              size="sm"
              variant="primary"
              data-gate-name-replace=""
              onClick={() => onReplace(collision.id, value)}
            >
              Replace it
            </Button>
            <Button size="sm" variant="ghost" data-gate-name-rename="" onClick={reopen}>
              Use another name
            </Button>
          </div>
          <p className="text-[9.5px] text-[var(--text-disabled)] mt-1">
            Replacing keeps its place in the tree and everything gated inside it.
          </p>
        </div>
      )}

      {/*
         Browse the populations that already exist, and take one over.

         The second half of Item 9. Picking one here is the same gesture as
         typing its name — it lands in the field and raises the same
         confirmation — rather than a separate path that replaces immediately:
         one destructive action, asked about once, however it was reached.

         Hidden for a quadrant, and when there is nothing to list.
      */}
      {!collision && !quadrant && existing.length > 0 && (
        browsing ? (
          <div data-gate-name-browser="" className="mt-1.5">
            <p className="text-[9.5px] text-[var(--text-tertiary)] px-0.5 mb-1">
              Redefine an existing population with this shape
            </p>
            <div className="max-h-[132px] overflow-y-auto rounded-[var(--radius-xs)] border border-[var(--border-subtle)]">
              {existing.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  data-gate-name-option={g.name}
                  onClick={() => {
                    setValue(g.name);
                    onType(g.name);
                    setBrowsing(false);
                    setCollision(g);
                  }}
                  className={cn(
                    'w-full flex items-center gap-1.5 px-1.5 h-6 text-left text-[10.5px]',
                    'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
                  )}
                >
                  <ColorChip color={`var(${popVar(g.colorIndex)})`} size={7} />
                  <span className="truncate">{g.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-gate-name-browse=""
            onClick={() => setBrowsing(true)}
            className="mt-1 px-0.5 text-[9.5px] text-[var(--text-tertiary)] hover:text-[var(--text-accent)]"
          >
            Or replace an existing population…
          </button>
        )
      )}

      {!collision && (
        <p className="text-[9.5px] text-[var(--text-disabled)] mt-1 px-0.5">
          Enter to add · Esc to discard
        </p>
      )}
    </div>
  );
}

/**
 * Sample › population breadcrumb, and the control that changes it.
 *
 * The breadcrumb already answered "what am I looking at" — this makes it answer
 * "show me something else" as well, which is the same move the axis labels
 * already make. A population reachable only by finding it in the sidebar and
 * dragging it is a population most people will not go and get.
 *
 * There is no pin beside it any more. The pin existed because clicking a node in
 * the sidebar gate tree used to retarget every unpinned panel, so each panel had
 * to declare whether it was following along. That behaviour is gone: a tree
 * click selects a population and does nothing else, and a panel changes what it
 * shows only through this control or through a drop. With one rule there is
 * nothing left to indicate.
 */
function PopulationBreadcrumb({
  panelId, sampleName, gates, populationId, scopePath, compact,
}: {
  panelId: string;
  sampleName: string;
  gates: Gate[];
  populationId: string | null;
  scopePath: string[];
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  /** The tree flattened depth-first, so indentation matches the sidebar. */
  const rows = useMemo(() => {
    const out: { gate: Gate; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const g of childrenOf(gates, parentId)) {
        out.push({ gate: g, depth });
        walk(g.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [gates]);

  const leaf = scopePath.length ? scopePath[scopePath.length - 1]! : 'All events';

  return (
    // `min-w-0` and a max, and deliberately **not** `flex-1`: the breadcrumb takes
    // what it needs up to its cap and gives all of it back under pressure rather
    // than pushing the delete control off the end of the row. Not growing to fill
    // matters for the other half of this pass — whatever the controls leave over
    // stays bare toolbar row, which is drag-to-move background.
    //
    // It truncates with an ellipsis and the full sample › gate › gate path is on
    // the `title` below, which is the answer to "the breadcrumb is unreadable at
    // this size": shorten it honestly and keep the whole of it one hover away.
    <span className={cn('flex items-center gap-1 min-w-0', compact ? 'max-w-[190px]' : 'max-w-[360px]')}>
      <button
        ref={ref}
        onClick={() => setOpen((o) => !o)}
        title={[sampleName, ...(scopePath.length ? scopePath : ['All events'])].join(' › ')}
        className={cn(
          'flex items-baseline gap-1 min-w-0 truncate px-1 h-5 rounded-[var(--radius-xs)]',
          'hover:bg-[var(--surface-hover)] transition-colors duration-[var(--dur-fast)]',
        )}
      >
        <span className="text-2xs font-medium text-[var(--text-secondary)] truncate">{sampleName}</span>
        {/* Only the leaf is named in a compact grid; the full path is in the
            tooltip, and three levels of breadcrumb would eat the toolbar before
            the plot-type control got any room. */}
        {!compact && scopePath.slice(0, -1).map((name, i) => (
          <span key={i} className="text-2xs text-[var(--text-disabled)] truncate shrink-0">&rsaquo; {name}</span>
        ))}
        <span className={cn(
          'text-2xs truncate shrink-0',
          scopePath.length ? 'text-[var(--text-accent)]' : 'text-[var(--text-disabled)]',
        )}>
          &rsaquo; {leaf}
        </span>
        <ChevronDown size={9} className="shrink-0 text-[var(--text-disabled)]" />
      </button>

      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={224} align="start">
        <div className="p-1 max-h-[280px] overflow-y-auto">
          <PopulationRow
            label="All events"
            depth={0}
            selected={populationId === null}
            onClick={() => { usePlot.getState().setPanelPopulation(panelId, null); setOpen(false); }}
          />
          {rows.map(({ gate, depth }) => (
            <PopulationRow
              key={gate.id}
              label={gate.name}
              depth={depth + 1}
              selected={populationId === gate.id}
              onClick={() => { usePlot.getState().setPanelPopulation(panelId, gate.id); setOpen(false); }}
            />
          ))}
          {rows.length === 0 && (
            <p className="px-2 py-2 text-2xs text-[var(--text-disabled)]">
              No gates on this sample yet. Draw one and it appears here.
            </p>
          )}
        </div>
      </Popover>
    </span>
  );
}

function PopulationRow({
  label, depth, selected, onClick,
}: { label: string; depth: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center w-full h-6 pr-2 rounded-[var(--radius-xs)] text-2xs text-left truncate',
        selected
          ? 'bg-[var(--surface-selected)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
      )}
      style={{ paddingLeft: 8 + depth * 11 }}
    >
      {label}
    </button>
  );
}

function AxisControl({
  parameters, value, transform, overrides, resolved, onParam, onTransform, onOverride, onReset,
}: {
  parameters: FcsParameter[];
  value: number;
  transform: TransformKind;
  overrides: TransformOverrides;
  resolved: TransformSpec;
  onParam: (i: number) => void;
  onTransform: (k: TransformKind) => void;
  onOverride: (key: keyof TransformOverrides, v: number | undefined) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <ParameterPicker parameters={parameters} value={value} onChange={onParam} />
      <TransformControl
        transform={transform}
        overrides={overrides}
        resolved={resolved}
        onTransform={onTransform}
        onOverride={onOverride}
        onReset={onReset}
      />
    </div>
  );
}

/** Point size and opacity. Opacity defaults to a count-derived value the user can override. */
function AppearanceControl({
  pointSize, alpha, autoAlpha, onPointSize, onAlpha,
}: {
  pointSize: number;
  alpha: number | null;
  autoAlpha: number;
  onPointSize: (n: number) => void;
  onAlpha: (a: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Tooltip content="Point size and opacity">
        <IconButton ref={ref} label="Plot appearance" size="sm" active={open} onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal size={13} />
        </IconButton>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={214} align="end">
        <div className="p-2.5 space-y-3">
          <Field label={`Point size — ${pointSize.toFixed(1)} px`}>
            <Slider value={pointSize} min={0.5} max={8} step={0.5} onChange={onPointSize} />
          </Field>
          <Field
            label={`Opacity — ${((alpha ?? autoAlpha) * 100).toFixed(0)}%`}
            hint={alpha === null ? 'Auto, from the event count.' : undefined}
          >
            <Slider value={alpha ?? autoAlpha} min={0.02} max={1} step={0.01} onChange={onAlpha} />
          </Field>
          {alpha !== null && (
            <button
              onClick={() => onAlpha(null)}
              className="text-2xs text-[var(--text-accent)] hover:underline"
            >
              Reset to automatic
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

/**
 * Inline editor for a gate name, opened by double-clicking its on-plot label.
 *
 * Deliberately the same shape as the tree's inline rename: seeded with the
 * current name, selected on focus, Enter and blur commit, Escape discards. Two
 * surfaces that rename the same thing should not disagree about what Escape
 * means — this project has already had one gate-naming bug that was a focus race
 * and nothing else.
 *
 * `stopPropagation` on the keydown is load-bearing: the plot listens on `window`
 * for Escape and would read it as "delete the selected gate".
 */
function GateLabelRename({
  initial, left, top, onCommit, onCancel,
}: {
  initial: string;
  left: number;
  top: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <div
      className="absolute z-30"
      // Centred on the label, and lifted so the field covers the text it
      // replaces rather than sitting under it.
      style={{ left, top: top - 18, transform: 'translateX(-50%)', width: 150 }}
    >
      <TextInput
        autoFocus
        data-gate-label-rename=""
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') onCommit(draft);
          if (e.key === 'Escape') onCancel();
        }}
        className="h-6 text-xs"
      />
    </div>
  );
}

/**
 * The casing/ink pair for a shape that is still being dragged out.
 *
 * The mirror of `GateLayer`'s `Outlined`, and deliberately a copy of its
 * *structure* rather than of its values: the widths and the two colours come from
 * the exported constants, so tuning a finished gate's outline tunes the
 * in-progress one in the same edit. What differs is that nothing here takes a
 * pointer target — a shape being drawn cannot be grabbed, the drag that is
 * placing it already owns the pointer.
 */
function PendingOutline({
  children,
}: {
  plotH: number;
  children: (
    stroke: { stroke: string; strokeWidth: number; 'data-gate-outline': string },
    ink: boolean,
  ) => React.ReactNode;
}) {
  return (
    <g className="pointer-events-none" data-gate-pending="">
      {children({ stroke: GATE_CASING, strokeWidth: PENDING_CASING, 'data-gate-outline': 'casing' }, false)}
      {children({ stroke: GATE_INK, strokeWidth: PENDING_STROKE, 'data-gate-outline': 'ink' }, true)}
    </g>
  );
}

/**
 * A CSS gradient for a ramp, built from the ramp itself.
 *
 * Not from the `--ramp-*` tokens, which is what the swatch used to read. The
 * tokens are seven hand-written stops per ramp and the renderer uses a 256-entry
 * table, so the two were two descriptions of one thing and only one of them was
 * the one being drawn. Sampling the real table means the swatch cannot be wrong
 * about the ramp it is offering.
 */
function rampGradient(name: RampName): string {
  const ramp = RAMPS[name] ?? RAMPS.viridis!;
  const stops = Array.from({ length: 9 }, (_, i) => {
    const [r, g, b] = sampleRamp(ramp, i / 8);
    return `rgb(${r} ${g} ${b})`;
  });
  return `linear-gradient(to right, ${stops.join(',')})`;
}

const RAMP_LABELS: Record<RampName, string> = {
  viridis: 'Viridis',
  cividis: 'Cividis',
  rainbow: 'Rainbow',
};

/**
 * Colour Levels — everything that decides what colour a density cell gets.
 *
 * Six settings behind the palette icon: the ramp, then the two that decide where
 * along it a count lands, then the grid the counts come from, then how large an
 * isolated cell is drawn. It was eleven, then five. What went, and why, is worth
 * recording because the cuts were not uniform, and so is the one that came back —
 *
 *   - *Calculate all levels based on data* was a checkbox that, when unchecked,
 *     silently disabled the Style control above it. **Levels are always the
 *     plot's own, and there is deliberately no control for it**; a percentile is
 *     a property of a distribution, and a checkbox that turns off the distribution
 *     cannot leave the control above it meaning anything.
 *   - *Overlay colour* configured a highlight pass that painted a near-solid white
 *     slab over the interior of the selected gate. The pass is gone.
 *   - *Outlier display* and *outlier dot colour* configured a flat band at the
 *     bottom of the map that on a sparse sample was 41% of the occupied cells —
 *     and, being flat, was the part of the plot no colour setting could reach.
 *     Both stay gone.
 *   - ***Outlier dot size* is back**, and it is worth being exact about what it
 *     now means, because the name is the same and the mechanism is not. It no
 *     longer selects a colour or a mode: an outlier cell is coloured by the same
 *     level table as every other cell and is merely *drawn larger*, so nothing
 *     bypasses the mapping and the Colour scaling control still reaches the whole
 *     plot. See `outlierMask` in `binning.ts`.
 *
 * It opens in a `FloatingPanel` rather than a `Popover`, **beside** the plot and
 * movable, because the point of these controls is to watch what they do.
 *
 * These are **per plot**, defaulted from `PANEL_VIEW_DEFAULTS` — the same constant
 * every creation path reads — so "the workspace default" and "what a new plot
 * opens as" are one value rather than two that agree for a while. *Restore to
 * default* puts one panel back to it, and every field here is saved with the
 * panel and comes back on reload.
 */
function ColorLevelsControl({
  scale, settings, resolved, panelRef, onScale, onChange, onRestore,
}: {
  scale: DensityScale;
  settings: ColorLevelSettings;
  /**
   * The smoothing window the plot actually drew with.
   *
   * Equal to `settings.smoothing` unless Auto is on, in which case it is the
   * answer `autoSmoothing` gave for this grid — which nothing outside the draw
   * can know, so it is passed in rather than recomputed.
   */
  resolved: number;
  /** The plot panel this configures — the settings panel opens beside it. */
  panelRef: React.RefObject<HTMLElement | null>;
  onScale: (s: DensityScale) => void;
  onChange: (patch: Partial<ColorLevelSettings>) => void;
  onRestore: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { ramp, colorStyle, colorScaling, binCount, smoothing, smoothingAuto, outlierSize } = settings;
  const shownSmoothing = Math.round(resolved * 10) / 10;
  const isDefault = COLOR_LEVEL_FIELDS.every((k) => settings[k] === PANEL_VIEW_DEFAULTS[k]);

  return (
    <>
      <Tooltip content="Colour levels — ramp, percentile style, resolution and smoothing">
        <IconButton label="Colour levels" size="sm" active={open} onClick={() => setOpen((o) => !o)}>
          <Palette size={13} />
        </IconButton>
      </Tooltip>
      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        beside={panelRef.current}
        title="Colour levels"
        width={280}
      >
        <div data-color-levels="" className="p-2.5 space-y-3">
          {/* ---- The ramp ---- */}
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                Colour level
                <InfoHint content="Rainbow is the default: it puts more distinguishable hues across the middle of the range, which is what finding the shoulder of a population wants, at the cost of not being monotonic in lightness. Viridis is perceptually uniform — equal steps in density are equal steps in appearance — which is what a quantitative reading of a sparse plot needs. Both keep their darkest colour clear of the plot background, so an isolated event on the periphery is still visible." />
              </span>
            }
          >
            <div className="space-y-1">
              {RAMP_NAMES.map((r) => (
                <button
                  key={r}
                  data-ramp={r}
                  onClick={() => onChange({ ramp: r })}
                  className={cn(
                    'flex items-center gap-2 w-full px-1.5 h-6 rounded-[var(--radius-xs)] text-2xs',
                    r === ramp ? 'bg-[var(--surface-selected)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]',
                  )}
                >
                  <span
                    className="h-3 flex-1 rounded-[2px] border border-[var(--border-subtle)]"
                    style={{ background: rampGradient(r) }}
                  />
                  <span className="w-12 text-left">{RAMP_LABELS[r]}</span>
                </button>
              ))}
            </div>
          </Field>

          {/* ---- How a count becomes a level ---- */}
          <div className="hairline-t pt-2.5 space-y-2.5">
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Style
                  <InfoHint content="Percentile spreads the ramp over the event distribution: a cell's colour is the fraction of events lying in cells no denser than it, so the sparse periphery sits at the dark end, the core gets most of the palette, and every plot uses its whole ramp whatever its counts happen to be. It is also invariant to the density scaling below — that is the point of it, and the scaling only takes effect under Linear." />
                </span>
              }
              inline
            >
              <SegmentedControl
                size="sm" value={colorStyle} onChange={(v: ColorStyle) => onChange({ colorStyle: v })}
                segments={[
                  { value: 'percentile', label: 'Percentile' },
                  { value: 'linear', label: 'Linear' },
                ]}
              />
            </Field>

            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Colour scaling
                  <InfoHint content="How colour intensity maps within the chosen ramp, applied after the style. Log gives the bottom tenth of the range nearly a third of the palette, which brings out faint structure without changing which cell is denser than which. This is not the density scaling — that is the control below." />
                </span>
              }
              inline
            >
              <SegmentedControl
                size="sm" value={colorScaling} onChange={(v: ColorScaling) => onChange({ colorScaling: v })}
                segments={[
                  { value: 'linear', label: 'Linear' },
                  { value: 'log', label: 'Log' },
                ]}
              />
            </Field>

            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  Density scale
                  <InfoHint content="The binning algorithm's own compression of a count range spanning orders of magnitude. Rank is the default: it equalises over the distinct counts and reveals the faintest structure. It has no effect while Style is Percentile — a percentile mapping is invariant to any monotonic rescaling of the counts." />
                </span>
              }
              hint={colorStyle === 'percentile' ? 'Inert under Percentile style.' : undefined}
            >
              <SegmentedControl
                fullWidth size="sm" value={scale} onChange={onScale}
                segments={[
                  { value: 'log', label: 'Log' },
                  { value: 'sqrt', label: 'Sqrt' },
                  { value: 'linear', label: 'Linear' },
                  { value: 'rank', label: 'Rank' },
                ]}
              />
            </Field>

            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  {`Resolution — ${binCount}×${binCount}`}
                  <InfoHint content="Bins per axis. 1024×1024 is the default and needs the smoothing below to go with it: at that resolution a 170 000-event sample averages 0.17 events per cell, so the raw grid is a scatter plot until it is smoothed back into a density estimate." />
                </span>
              }
            >
              <SegmentedControl
                fullWidth size="sm"
                value={String(binCount)}
                onChange={(v) => onChange({ binCount: Number(v) })}
                segments={Object.entries(DENSITY_RESOLUTION).map(([, n]) => ({
                  value: String(n), label: String(n),
                }))}
              />
            </Field>

            {/* Smoothing: Auto by default, with the stepper as the override.

                The label states the number either way, because "Auto" on its own
                is a claim the user cannot check — and the whole reason Auto
                exists is that the right number is different on two plots of the
                same sample. Under Auto that number comes back from the layer,
                which is the only thing that knows how the events actually
                landed in the grid.

                **This row is the one that is not `inline`, and it has to not
                be** (2026-08-04, Item 4). Its label is the longest in the panel —
                "Smoothing — auto, 4 bins" plus the hint is about 170 px — and it
                carries two controls rather than one, a switch with its own text
                label and a three-part stepper, which come to ~133 px and cannot
                shrink. In a 280 px panel that is 55 px more than the row has, so
                an inline row put the switch and the stepper back on top of the
                label: the reported collision of "Auto" with the −/value/+ glyphs.
                Given the label a row of its own, both controls sit on the next
                one with the whole width to spread across, `justify-between`
                keeping the switch left and the stepper right. */}
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  {smoothingAuto
                    ? `Smoothing — auto, ${shownSmoothing === 1 ? 'off' : `${shownSmoothing} bins`}`
                    : `Smoothing — ${smoothing === 1 ? 'off' : `${smoothing} bins`}`}
                  <InfoHint content="How many cells of the bin grid are averaged together. Auto is a width in data units that narrows as the plot holds more events — a tenth of a percent of the axis at 15 000 events, two-thirds of that at 300 000 — so a large file is not blurred into a blob and two replicates of similar size come out in the same colours. Switch it off for a stated value: every step counts, since the window is a fractional radius, so 3 is genuinely wider than 2 rather than rounding down onto it." />
                </span>
              }
            >
              <div data-smoothing-row="" className="flex items-center justify-between gap-3">
                <Switch
                  size="sm"
                  checked={smoothingAuto}
                  onChange={(v: boolean) => onChange({ smoothingAuto: v })}
                  label="Auto"
                />
                <Stepper
                  value={smoothingAuto ? shownSmoothing : smoothing}
                  min={1}
                  max={21}
                  disabled={smoothingAuto}
                  onChange={(v) => onChange({ smoothing: v })}
                />
              </div>
            </Field>

            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  {`Outlier dot size — ${outlierSize === 1 ? 'off' : `${outlierSize} px`}`}
                  <InfoHint content="How large a cell holding the least signal any occupied cell holds is drawn — one isolated event, in other words. At 1024×1024 the grid is downscaled about four to one onto the panel, so a single cell can be lost in the resampling; drawing it a couple of pixels wide keeps the sparse periphery visible, which is the part of a plot you gate against. It is a size and nothing else: an outlier gets its colour from the same level table as every other cell, so the colour controls above still reach the whole plot." />
                </span>
              }
              inline
            >
              <Stepper value={outlierSize} min={1} max={8} onChange={(v) => onChange({ outlierSize: v })} />
            </Field>
          </div>

          <button
            onClick={onRestore}
            disabled={isDefault}
            className={cn(
              'text-2xs hairline-t pt-2.5 w-full text-left',
              isDefault ? 'text-[var(--text-disabled)] cursor-default' : 'text-[var(--text-accent)] hover:underline',
            )}
          >
            {isDefault ? 'These are the default colour levels' : 'Restore to default'}
          </button>
        </div>
      </FloatingPanel>
    </>
  );
}

/** The fields *Restore to default* resets, for the "already default" check. */
const COLOR_LEVEL_FIELDS = [
  'ramp', 'colorStyle', 'colorScaling', 'binCount', 'smoothing', 'smoothingAuto', 'outlierSize',
] as const;

/**
 * A numeric stepper — a value between two nudge buttons.
 *
 * Not a slider. The three settings that use it are small integers where the exact
 * number matters and the useful range is under a dozen steps, which is precisely
 * where a slider is worse than two buttons: a 227 px panel gives a 1-to-21 slider
 * about 8 px per value.
 */
function Stepper({
  value, min, max, onChange, disabled,
}: {
  value: number; min: number; max: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)));
  return (
    <span className={cn('inline-flex items-center gap-0.5', disabled && 'opacity-40 pointer-events-none')}>
      <IconButton label="Decrease" size="sm" disabled={disabled || value <= min} onClick={() => step(-1)}>
        <Minus size={11} />
      </IconButton>
      <span className="w-6 text-center font-mono tnum text-2xs text-[var(--text-primary)]">{value}</span>
      <IconButton label="Increase" size="sm" disabled={disabled || value >= max} onClick={() => step(1)}>
        <Plus size={11} />
      </IconButton>
    </span>
  );
}

function HistogramControl({
  panelId, bins, smoothing, overlayIds, samples, currentId, onBins, onSmoothing,
}: {
  panelId: string;
  bins: number; smoothing: number; overlayIds: string[];
  samples: Sample[]; currentId: string;
  onBins: (n: number) => void; onSmoothing: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const toggleOverlay = usePlot((s) => s.toggleOverlay);
  const clearOverlays = usePlot((s) => s.clearOverlays);

  return (
    <>
      <Tooltip content="Histogram bins, smoothing and sample overlays">
        <IconButton ref={ref} label="Histogram options" size="sm" active={open} onClick={() => setOpen((o) => !o)}>
          <Layers size={13} />
        </IconButton>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref.current} width={252} align="end">
        <div className="p-2.5 space-y-3">
          <Field label={`Bins — ${bins}`}>
            <Slider value={bins} min={32} max={512} step={16} onChange={onBins} />
          </Field>
          <Field
            label={`Smoothing — ${smoothing === 1 ? 'off' : `${smoothing} bins`}`}
            hint={smoothing > 9 ? 'Wide windows start merging genuinely distinct peaks.' : undefined}
          >
            <Slider value={smoothing} min={1} max={21} step={2} onChange={onSmoothing} />
          </Field>
          <Field
            label={
              <span className="inline-flex items-center gap-1.5">
                Overlay samples
                <InfoHint content="Each series is normalised to its own peak, so distributions from samples with very different event counts stay directly comparable." />
              </span>
            }
          >
            <div className="max-h-[168px] overflow-y-auto space-y-px -mx-0.5">
              {samples.filter((s) => s.id !== currentId).map((s) => (
                <Checkbox
                  key={s.id}
                  checked={overlayIds.includes(s.id)}
                  onChange={() => toggleOverlay(panelId, s.id)}
                  label={<span className="truncate max-w-[178px] inline-block align-middle">{s.name}</span>}
                  className="px-1 h-5 w-full"
                />
              ))}
            </div>
          </Field>
          {overlayIds.length > 0 && (
            <button onClick={() => clearOverlays(panelId)} className="text-2xs text-[var(--text-accent)] hover:underline">
              Clear {overlayIds.length} overlay(s)
            </button>
          )}
        </div>
      </Popover>
    </>
  );
}

function ReadoutRow({ name, value }: { name: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-2xs text-[var(--text-tertiary)] truncate max-w-[86px]">{name}</span>
      <span className="ml-auto font-mono tnum text-2xs text-[var(--text-primary)]">{fmt(value)}</span>
    </div>
  );
}

/* ========================================================================== */

function extent(x: Float32Array, y: Float32Array) {
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const a = x[i]!;
    const b = y[i]!;
    if (a < xMin) xMin = a;
    if (a > xMax) xMax = a;
    if (b < yMin) yMin = b;
    if (b > yMax) yMax = b;
  }
  // An empty or all-equal column would give a zero-width viewport.
  if (!Number.isFinite(xMin)) { xMin = 0; xMax = 1; }
  if (!Number.isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (xMin === xMax) { xMin -= 0.5; xMax += 0.5; }
  if (yMin === yMax) { yMin -= 0.5; yMax += 0.5; }
  return { xMin, xMax, yMin, yMax };
}

function visibleTicks(ticks: AxisTick[], min: number, max: number): AxisTick[] {
  return ticks.filter((t) => t.display >= min && t.display <= max);
}

/**
 * A tick label, with any decade exponent drawn at a size somebody can read.
 *
 * `10⁴` is one string and the `⁴` is a Unicode superscript, which is about 58%
 * of the digit height and drawn with thinner strokes than the mantissa beside
 * it. At the 9.5 px this axis uses, the exponent — the only part of the label
 * that distinguishes one decade from the next — was reported as illegible, and
 * it was: it renders as roughly five pixels of hairline.
 *
 * Raising a `tspan` instead puts the exponent at 7.5 px in the same weight as
 * everything else, which is 79% of the mantissa rather than 58% and is a digit
 * rather than a mark. The string is untouched — `AxisTick.label` is still what
 * it always was, and this is a drawing decision — so the harnesses that read
 * labels off the axis, and the export that serialises this same SVG, both see
 * exactly the text they saw before. See `splitDecadeLabel`.
 *
 * `dominantBaseline` is deliberately absent: `dy` alone shifts the baseline and
 * the exponent is the last thing in the element, so nothing after it inherits
 * the offset.
 *
 * The one thing this costs is the element's `textContent`, which becomes `104`
 * rather than `10⁴` — two tspans concatenate with no separator. The caller
 * carries `aria-label={t.label}`, so the accessible name is still the label the
 * axis means.
 */
function TickLabel({ label }: { label: string }) {
  const { base, exponent } = splitDecadeLabel(label);
  if (!exponent) return <>{label}</>;
  return (
    <>
      <tspan>{base}</tspan>
      <tspan fontSize={7.5} dy={-3.6}>{exponent}</tspan>
    </>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `setPointerCapture`, survivably.
 *
 * It throws `NotFoundError` on a pointer id the browser does not consider
 * active, which for a synthesised event it frequently does not — and an
 * unguarded call takes the rest of its handler with it. That has now cost this
 * project two silently-dead features (the panel resize handle, and gate handle
 * drags), so the call is wrapped and every caller arms its state first.
 */
function capture(e: React.PointerEvent): void {
  try {
    (e.target as Element).setPointerCapture(e.pointerId);
  } catch {
    // Nothing to do: the drag is tracked without it.
  }
}

/** CSS custom property holding a population's palette colour. */
export function popVar(colorIndex: number): string {
  return `--pop-${String((colorIndex % 12) + 1).padStart(2, '0')}`;
}

/**
 * Give a linear axis a floor below zero when the parameter needs one.
 *
 * A detector's values start at zero, so `[0, range]` is the whole story. A
 * derived parameter's do not — a ratio runs to −1 — and a linear domain starting
 * at zero leaves the negative half of the plot with no tick and no gridline.
 * Only the linear transform reads `min`; the log-family ones are defined against
 * decades and have their own answer for negatives.
 */
function withFloor(spec: TransformSpec, param: FcsParameter | undefined, values: Float32Array): TransformSpec {
  if (spec.kind !== 'linear' || param?.type !== 'Derived') return spec;
  let min = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isFinite(v) && v < min) min = v;
  }
  return min < 0 ? { ...spec, min } : spec;
}

/** Subsample a membership mask alongside the points it describes. */
function gatherMask(mask: Uint8Array, indices: Uint32Array): Uint8Array {
  const out = new Uint8Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = mask[indices[i]!]!;
  return out;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export { MAX_RENDERED_POINTS };
