import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RotateCcw } from 'lucide-react';
import {
  createTransform, IMPLEMENTED_TRANSFORMS, TRANSFORM_LABELS, type TransformKind,
} from '@/core/transform';
import { parametersFor, sampleColumn, useDerived } from '@/state/derivedStore';
import { useSpectral } from '@/state/spectralStore';
import { usePlot, type TransformOverrides } from '@/state/plotStore';
import { useAxisRanges } from '@/state/axisRangeStore';
import { useTransformPrefs, transformFor } from '@/state/transformPrefs';
import { useUI } from '@/state/uiStore';
import { selectedSample, useWorkspace } from '@/state/workspaceStore';
import { IconButton } from '@/ui/Button';
import { Field, NumberInput, Select } from '@/ui/Field';
import { Callout } from '@/ui/Feedback';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { ParameterPicker } from './ParameterPicker';
import { resolveSpec, transformDescription, TransformParameters } from './TransformControl';

/* ==========================================================================
   Axis settings — parameter, scale, range — for the active plot.

   The quick picker on the axis label answers "which parameter", which is the
   question asked forty times an hour, and it should stay a one-click popover on
   the plot. It cannot reasonably answer the other two: a transform's parameters
   want sliders next to a description, and a range wants two number fields and
   somewhere to say what the automatic range currently is.

   So this is a panel, not a bigger popover. A panel can be left open while three
   plots are compared and adjusted in turn, and — with zoom and pan gone —
   numeric min/max here is now the *only* way to show a sub-range of an axis
   deliberately. That is a thing worth a persistent home rather than a gesture
   nobody can see afterwards.

   It follows the active panel, the same rule the population selector already
   uses, so "which plot am I editing" has one answer everywhere in the app.
   ========================================================================== */

export function AxisSettings() {
  const panel = usePlot((s) => s.panels.find((p) => p.id === s.activePanelId) ?? s.panels[0]);
  const {
    setAxis, setTransform, setOverride, clearOverrides, setAxisLimit, resetAxisLimits, panAxis,
  } = usePlot();
  const selected = useWorkspace(selectedSample);
  const samples = useWorkspace((s) => s.samples);
  const derivedDefs = useDerived((d) => d.defs);
  const axisFocus = useUI((s) => s.axisFocus);

  // A panel showing a pinned sample is configured against *that* sample's
  // parameters, not the sidebar's selection — otherwise the picker would offer
  // channels the plot cannot draw.
  const sample = useMemo(
    () => (panel?.sampleId ? samples.find((s) => s.id === panel.sampleId) ?? selected : selected),
    [panel?.sampleId, samples, selected],
  );

  // `unmixed` is the signal that a matrix has been applied — see `PlotCanvas`.
  const unmixedResults = useSpectral((s) => s.unmixed);
  const params = useMemo(
    () => (sample ? parametersFor(sample.parsed, derivedDefs) : []),
    [sample, derivedDefs, unmixedResults],
  );

  const fitted = useAxisRanges((s) => (panel ? s.fitted[panel.id] : undefined));

  // Clamped the same way `PlotCanvas` clamps them, so a panel pointing past the
  // end of a shorter sample's parameter list configures the axis it is drawing.
  const xi = Math.min(panel?.xParam ?? 0, params.length - 1);
  const yi = Math.min(panel?.yParam ?? 0, params.length - 1);

  // The transform's own parameters are estimated from the channel's negative
  // tail, so the fields need the column. Memoised because that estimate runs on
  // every render otherwise, on 52 000 events, twice.
  const xColumn = useMemo(
    () => (sample && xi >= 0 ? sampleColumn(sample.parsed, xi, derivedDefs) : undefined),
    [sample, xi, derivedDefs, unmixedResults],
  );
  const yColumn = useMemo(
    () => (sample && yi >= 0 ? sampleColumn(sample.parsed, yi, derivedDefs) : undefined),
    [sample, yi, derivedDefs, unmixedResults],
  );

  if (!panel || !sample) {
    return (
      <Callout tone="info">
        No plot is active. Select a plot on the worksheet — or double-click either of its axes — to configure
        its parameters, scale and range here.
      </Callout>
    );
  }

  return (
    <div className="space-y-3">
      <AxisBlock
        axis="x"
        label="X axis"
        panelId={panel.id}
        parameters={params}
        value={xi}
        transform={panel.xTransform}
        overrides={panel.xOverrides}
        column={xColumn}
        range={params[xi]?.range ?? 1}
        min={panel.xMin}
        max={panel.xMax}
        autoMin={fitted?.xMin}
        autoMax={fitted?.xMax}
        focused={axisFocus?.panelId === panel.id && axisFocus.axis === 'x'}
        onParam={(i) => setAxis(panel.id, 'x', i, transformFor(params[i]))}
        onTransform={(k) => {
          useTransformPrefs.getState().remember(params[xi]?.name ?? '', k);
          setTransform(panel.id, 'x', k);
        }}
        onOverride={(key, v) => setOverride(panel.id, 'x', key, v)}
        onResetTransform={() => clearOverrides(panel.id, 'x')}
        onLimit={(bound, v) => setAxisLimit(panel.id, 'x', bound, v)}
        onResetRange={() => resetAxisLimits(panel.id, 'x')}
        onPan={(lo, hi) => panAxis(panel.id, 'x', lo, hi)}
      />

      {/* A histogram has no y parameter, so it gets a sentence rather than three
          disabled controls.

          Only the *range* used to be disabled here, which left a live parameter
          picker and a live transform selector on an axis that plots the height
          of a bin. Picking a channel there changed the tick labels — the axis
          itself is pinned to 0 – 1 in `PlotCanvas` — so the plot appeared to be
          showing a second parameter it was not showing. There is nothing on
          this axis to configure. */}
      {panel.plotType === 'histogram' ? (
        <Callout tone="info">
          <strong>Y axis: normalised count.</strong> A histogram plots the number of events in each
          bin of the x parameter, scaled so the tallest bin is 1. It has no second parameter, scale
          or range to set. Switch this plot to Dot or Density to put a parameter back on this axis.
        </Callout>
      ) : (
        <AxisBlock
          axis="y"
          label="Y axis"
          panelId={panel.id}
          parameters={params}
          value={yi}
          transform={panel.yTransform}
          overrides={panel.yOverrides}
          column={yColumn}
          range={params[yi]?.range ?? 1}
          min={panel.yMin}
          max={panel.yMax}
          autoMin={fitted?.yMin}
          autoMax={fitted?.yMax}
          focused={axisFocus?.panelId === panel.id && axisFocus.axis === 'y'}
          onParam={(i) => setAxis(panel.id, 'y', i, transformFor(params[i]))}
          onTransform={(k) => {
            useTransformPrefs.getState().remember(params[yi]?.name ?? '', k);
            setTransform(panel.id, 'y', k);
          }}
          onOverride={(key, v) => setOverride(panel.id, 'y', key, v)}
          onResetTransform={() => clearOverrides(panel.id, 'y')}
          onLimit={(bound, v) => setAxisLimit(panel.id, 'y', bound, v)}
          onResetRange={() => resetAxisLimits(panel.id, 'y')}
          onPan={(lo, hi) => panAxis(panel.id, 'y', lo, hi)}
        />
      )}
    </div>
  );
}

/* ========================================================================== */

function AxisBlock({
  axis, label, panelId, parameters, value, transform, overrides, column, range,
  min, max, autoMin, autoMax, focused,
  onParam, onTransform, onOverride, onResetTransform, onLimit, onResetRange, onPan,
}: {
  axis: 'x' | 'y';
  label: string;
  panelId: string;
  parameters: ReturnType<typeof parametersFor>;
  value: number;
  transform: TransformKind;
  overrides: TransformOverrides;
  column: Float32Array | undefined;
  range: number;
  min: number | null;
  max: number | null;
  autoMin: number | undefined;
  autoMax: number | undefined;
  focused: boolean;
  onParam: (i: number) => void;
  onTransform: (k: TransformKind) => void;
  onOverride: (key: keyof TransformOverrides, v: number | undefined) => void;
  onResetTransform: () => void;
  onLimit: (bound: 'min' | 'max', v: number | null) => void;
  onResetRange: () => void;
  /** Both ends at once, in data units. See `panAxis`. */
  onPan: (min: number, max: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const resolved = useMemo(
    () => resolveSpec(transform, range, column, overrides),
    [transform, range, column, overrides],
  );
  const dirtyTransform = Object.keys(overrides).length > 0;
  const limited = min !== null || max !== null;

  /*
     Shift the window without changing its width.

     ## Why a button and not a drag (2026-08-19)

     Because it is **configuration**, and this application's plots do not move
     under a gesture — a panel frames itself on the whole sample so a child plot
     can be laid beside its parent and read as the same picture with a region
     marked, and a view somebody nudged with the mouse leaves no record of what
     they nudged it to. A press here writes the same two numbers the fields above
     hold, so the result is visible, typed back into the plot beside it, saved
     with the workspace, and undone in one step.

     It exists because an automatic range is a rule and a rule has residuals. The
     rule is measured and it is right far more often than any alternative, but
     when it is not right on one sample the reader needs to be able to look just
     past the edge and confirm nothing is hiding there — and the honest way to
     offer that is a control that says where it moved to, not a scroll wheel.

     **A tenth of the visible span, in display units.** Data units would be
     useless on a biexponential axis: a tenth of the range is most of the square
     up near the top and invisible near zero. The window's own width comes from
     the fields when they are set and from the fitted extent when they are not,
     so the first press starts exactly where the automatic range was — which is
     what makes the reset below mean "back to the rule".
  */
  const viewWindow = useMemo(() => {
    const lo = min ?? autoMin;
    const hi = max ?? autoMax;
    if (lo === undefined || hi === undefined || !(hi > lo)) return null;
    return { lo, hi };
  }, [min, max, autoMin, autoMax]);

  const pan = (direction: -1 | 1) => {
    if (!viewWindow) return;
    const t = createTransform(resolved);
    const dLo = t.forward(viewWindow.lo);
    const dHi = t.forward(viewWindow.hi);
    const shift = (dHi - dLo) * PAN_STEP * direction;
    onPan(t.inverse(dLo + shift), t.inverse(dHi + shift));
  };

  const back = axis === 'x' ? 'left' : 'down';
  const forward = axis === 'x' ? 'right' : 'up';

  // Bring the double-clicked axis into view. The inspector scrolls, both blocks
  // rarely fit at once, and a shortcut that opens the right panel at the wrong
  // scroll position is a shortcut that still needs hunting.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [focused, panelId]);

  return (
    <section
      ref={ref}
      data-axis-block={axis}
      className={cn(
        'rounded-[var(--radius-sm)] border p-2 space-y-2 transition-colors duration-[var(--dur-normal)]',
        focused
          ? 'border-[var(--accent-500)]/60 bg-[var(--surface-raised)]'
          : 'border-[var(--border-subtle)]',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        {limited && (
          <span
            className="text-[9px] font-mono text-[var(--text-accent)]"
            title="This axis is showing a stated range rather than all of its data"
          >
            ranged
          </span>
        )}
        <span className="ml-auto shrink-0">
          <ParameterPicker parameters={parameters} value={value} onChange={onParam} />
        </span>
      </div>

      <Field label="Scale" hint={transformDescription(transform)}>
        <Select value={transform} onChange={(e) => onTransform(e.target.value as TransformKind)}>
          {IMPLEMENTED_TRANSFORMS.map((k) => (
            <option key={k} value={k}>{TRANSFORM_LABELS[k]}</option>
          ))}
        </Select>
      </Field>

      <div className="space-y-2.5">
        <TransformParameters transform={transform} resolved={resolved} onOverride={onOverride} />
      </div>

      {dirtyTransform && (
        <button
          onClick={onResetTransform}
          className="inline-flex items-center gap-1.5 text-2xs text-[var(--text-accent)] hover:underline"
        >
          <RotateCcw size={10} />
          Reset scale to auto-estimated
        </button>
      )}

      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            Range
            <InfoHint content="The span of this axis, in the parameter's own units. Leave a field empty for the data's own extent. Typing the same two numbers into two plots is what makes them comparable — which is why this is a number rather than a zoom gesture." />
          </span>
        }
        hint={autoMin !== undefined && autoMax !== undefined
          ? `Data extent ${fmt(autoMin)} – ${fmt(autoMax)}`
          : undefined}
      >
        <div className="flex items-center gap-1.5">
          <LimitInput
            aria-label={`${label} minimum`}
            data-axis-min={axis}
            value={min}
            placeholder={autoMin !== undefined ? fmt(autoMin) : 'auto'}
            onCommit={(v) => onLimit('min', v)}
          />
          <span className="text-2xs text-[var(--text-disabled)] shrink-0">to</span>
          <LimitInput
            aria-label={`${label} maximum`}
            data-axis-max={axis}
            value={max}
            placeholder={autoMax !== undefined ? fmt(autoMax) : 'auto'}
            onCommit={(v) => onLimit('max', v)}
          />
        </div>
      </Field>

      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-[var(--text-tertiary)] shrink-0">Shift view</span>
        <Tooltip content={`Shift the view ${back} by a tenth`}>
          <span>
            <IconButton
              size="sm"
              label={`Shift the view ${back}`}
              data-axis-pan={`${axis}-${back}`}
              disabled={!viewWindow}
              onClick={() => pan(-1)}
            >
              {axis === 'x' ? <ChevronLeft size={13} /> : <ChevronDown size={13} />}
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip content={`Shift the view ${forward} by a tenth`}>
          <span>
            <IconButton
              size="sm"
              label={`Shift the view ${forward}`}
              data-axis-pan={`${axis}-${forward}`}
              disabled={!viewWindow}
              onClick={() => pan(1)}
            >
              {axis === 'x' ? <ChevronRight size={13} /> : <ChevronUp size={13} />}
            </IconButton>
          </span>
        </Tooltip>
        <span className="flex-1" />
        {/* Always rendered, disabled when there is nothing to reset, so the way
            back is in the same place before and after a shift rather than
            appearing beneath the buttons that made it necessary. */}
        <button
          type="button"
          data-axis-reset-range={axis}
          disabled={!limited}
          onClick={onResetRange}
          className={cn(
            'inline-flex items-center gap-1.5 text-2xs',
            limited
              ? 'text-[var(--text-accent)] hover:underline'
              : 'text-[var(--text-disabled)] cursor-default',
          )}
        >
          <RotateCcw size={10} />
          Reset to auto
        </button>
      </div>
    </section>
  );
}

/**
 * How far one press of the shift buttons moves the view — a tenth of what is on
 * screen.
 *
 * Small enough that a press is a look rather than a jump, large enough that the
 * picture visibly changed. Ten presses walk the window past itself, which is the
 * furthest anybody needs to go before typing a number instead.
 */
const PAN_STEP = 0.1;

/**
 * One end of an axis range.
 *
 * It keeps a **draft string** rather than being driven straight off the stored
 * number, and that is the whole of why `-1` can be typed. The field was
 * controlled on `value={min ?? ''}` and parsed on every keystroke: with the
 * previous value cleared, `-` parses to nothing, the store is set to `null`, and
 * React writes `''` back over the character that was just typed. Every
 * intermediate state of a real number has the same problem — `-`, `1.`, `1e` —
 * so a field that only accepts complete numbers accepts almost nothing.
 *
 * The draft is what is displayed while the field has focus; the store is
 * updated whenever the draft happens to parse, so the plot still follows the
 * typing live. On blur the draft is re-seeded from the store, which is what
 * discards `1e` and shows what was actually applied.
 *
 * An **emptied** field means auto, not zero — `Number('')` is 0, which would pin
 * an axis to the origin the moment somebody cleared a box intending to release
 * it.
 */
function LimitInput({
  value, onCommit, ...rest
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
} & Omit<React.ComponentProps<typeof NumberInput>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));

  return (
    <NumberInput
      {...rest}
      value={shown}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const s = raw.trim();
        if (!s) { onCommit(null); return; }
        const n = Number(s);
        // An unparseable intermediate is held in the draft and not committed, so
        // the axis keeps whatever it had until the number is finished.
        if (Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(3);
}
