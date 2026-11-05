import { boundsOf } from '@/core/gating/geometry';
import { isGeometric, type Gate, type PopulationStats, type Point } from '@/core/gating/types';
import { HANDLE_HIT } from './gateHitTest';
import { LABEL_MARGIN, placeGateLabel } from './gateLabelPlacement';
import { gateHue } from './populationColors';
import { rangeAxisOn } from './panelGates';
import { gateHandleCursor } from './plotCursor';
import { cn } from '@/ui/cn';

const POP = (i: number) => `var(--pop-${String((i % 12) + 1).padStart(2, '0')})`;

/**
 * The default gate outline: near-black ink, with a light casing behind it.
 *
 * Both halves are needed, and the second is not decoration. The report was that
 * events under a gate are hard to see, partly because the outline competed with
 * them — a saturated palette colour drawn over a saturated density map is two
 * bright things arguing. A dark line settles it: over data of any colour it is the
 * one thing that is *not* bright, which is what an outline should be.
 *
 * But a gate's outline does not only cross data. Most of a rectangle around a
 * population runs over empty plot, and empty plot on the dark theme is `#0a0c10` —
 * so a pure black outline would be perfectly legible over the population and
 * invisible everywhere else. The casing is a wider, semi-transparent light stroke
 * underneath: over the map you read the dark line, over the background you read
 * the pale one. It is the standard cartographic answer to a label crossing
 * arbitrary terrain, and it is here for the same reason.
 *
 * `--gate-ink` flips with the theme — near-black on dark, and still near-black on
 * light, because the thing it has to contrast with is the *data*, not the paper.
 * The casing is what flips.
 */
export const GATE_INK = 'var(--gate-ink)';
export const GATE_CASING = 'var(--gate-casing)';

/** Stroke width of a gate outline, selected or not. */
const STROKE = (selected: boolean) => (selected ? 1.75 : 1.25);
/**
 * How much wider the casing is than the ink it sits behind.
 *
 * 1.5, which puts 0.75 px of casing either side of the ink — deliberately less
 * than the ink's own width. The first attempt used 2, and a screenshot settled it:
 * 1 px of white either side of 1.75 px of black is a line that is 53% white, and
 * it reads as a *pale grey outline*. That is the thing being replaced, not the
 * replacement. The casing has to be enough to keep the line off the background and
 * no more.
 */
const CASING_EXTRA = 1.5;

/**
 * Interior tint. Faint on purpose — the outline carries the boundary.
 *
 * 0.05/0.09 of the *population* colour, which is what keeps two overlapping gates
 * telling apart at a glance now that neither outline is coloured. It is nowhere
 * near enough to obscure a density map, which is the whole requirement: the fill
 * is a hint about which shape you are inside, not a highlight of the events.
 */
const FILL_OPACITY = (selected: boolean) => (selected ? 0.09 : 0.05);

/**
 * A range band's tint. Heavier than a 2D gate's, because a band is the one
 * place its population's hue is shown at area: at 5% a teal band over the plot
 * surface read as warm grey beside a caption that was clearly teal (2026-10-22).
 */
const RANGE_FILL_OPACITY = (selected: boolean) => (selected ? 0.18 : 0.12);

/**
 * The in-progress outline: the same ink, the same casing, the same widths.
 *
 * Exported because the shape being *drawn* lives in `PlotCanvas` rather than
 * here — a pending rectangle is not a `Gate` yet, it is two corners in a ref —
 * and until 2026-08-02 that meant it was styled independently, in
 * `var(--accent-400)` over a `var(--accent-500)` wash. So a gate was blue while
 * you dragged it out and near-black the instant you released, and a polygon was
 * blue for every vertex placed and near-black on close. That is a colour change
 * carrying no information: nothing about the shape changes at that moment except
 * that it becomes real, and the outline had already said where it was. The
 * report is right that it reads as two different things happening.
 *
 * Sharing the constants rather than copying the values is the point. Two
 * literals that happen to match today drift the first time one of them is tuned,
 * and the whole complaint was that they did not match.
 *
 * `PENDING_STROKE` is the **unselected** width. A shape being placed is not
 * selected — there is nothing to select yet — and drawing it at the heavier
 * selected width would make it visibly thin on release, which is the same class
 * of transition in a different property.
 *
 * The accent colour is not gone from the drawing gesture: the polygon's close
 * target, its rubber band and its vertex markers stay accent, and deliberately.
 * Those are *affordances* — "click here and the shape closes" — not the outline,
 * they have no counterpart on a finished gate, and they disappear on close
 * rather than changing colour.
 */
export const PENDING_STROKE = STROKE(false);
export const PENDING_CASING = STROKE(false) + CASING_EXTRA;
/**
 * Interior wash while a shape is being dragged out.
 *
 * The population colour is not available yet — a colour index is assigned when
 * the gate is created — so this is the ink at the unselected fill opacity, which
 * reads as a faint darkening rather than as a second colour, and lands on the
 * same value the finished gate's own fill will have.
 */
export const PENDING_FILL = GATE_INK;
export const PENDING_FILL_OPACITY = FILL_OPACITY(false);

export interface GateLayerProps {
  gates: Gate[];
  stats: Map<string, PopulationStats>;
  selectedGateId: string | null;
  /** Only gates drawn on these two parameters are shown. */
  xParam: number;
  yParam: number;
  /**
   * Histogram mode: the y axis is normalised density rather than a parameter,
   * so a 2D shape drawn there would be meaningless. Only range gates show.
   */
  oneDimensional?: boolean;
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  plotW: number;
  plotH: number;
  /** Handle currently being dragged, for visual feedback. */
  activeHandle: { gateId: string; handle: string } | null;
  onGatePointerDown: (e: React.PointerEvent, gateId: string, handle: string) => void;
  /**
   * Where each gate's label sits relative to its default position, in pixels.
   *
   * Per gate **and per panel**, which is why it is passed in rather than stored
   * on the gate: the same population plotted on two axis pairs has its label
   * colliding with different data in each, so "move it out of the way" is a
   * statement about one plot. Pixels rather than data units so the nudge keeps
   * its visual distance from the shape when the panel is resized.
   */
  labelOffsets?: Record<string, { dx: number; dy: number }>;
  onLabelMove?: (gateId: string, dx: number, dy: number) => void;
  /** Double-click on a label: rename it in place. `at` is the label's screen position. */
  onLabelRename?: (gateId: string, at: { x: number; y: number }) => void;
}

/**
 * A gate's ink — its own colour when it has one, the theme's otherwise.
 *
 * The default is deliberately not the population colour. An outline and a label
 * have to be legible against a density map *and* against empty plot, and a
 * saturated palette colour is neither reliably; `--gate-ink` flips with the
 * theme so it is always the opposite lightness to the surface. The population
 * colour still identifies the gate — on the tree chip, the handle squares and
 * the interior tint — which is where it does not have to be read as text.
 */
export function gateInk(g: Gate): string {
  return g.color ?? GATE_INK;
}

/**
 * SVG overlay drawing gate outlines, labels and edit handles.
 *
 * Rendered above the WebGL canvas rather than into it: gates are a handful of
 * vector shapes that must stay crisp at any zoom and export cleanly to SVG/PDF,
 * which is exactly what SVG is for. Only gates defined on the currently
 * displayed parameter pair are drawn — a gate on other axes still contributes
 * to the hierarchy, it just has no geometry to show here.
 */
export function GateLayer(props: GateLayerProps) {
  const { gates, stats, selectedGateId, xParam, yParam, oneDimensional, toPixelX, toPixelY, onGatePointerDown } = props;

  const visible = gates.filter((g) =>
    !oneDimensional && isGeometric(g) ? g.xParam === xParam && g.yParam === yParam : false,
  );
  // Range gates are one-dimensional, so they are meaningful on a histogram and
  // on a scatter plot alike — anywhere *either* axis is the parameter they cut.
  // `rangeAxisOn` is the one place that decides which; see the note there.
  const ranges = gates.flatMap((g) => {
    const axis = rangeAxisOn(g, xParam, yParam, oneDimensional);
    return axis && g.kind === 'range' ? [{ g, axis }] : [];
  });

  return (
    <g>
      {ranges.map(({ g, axis }, i) => {
        const s = stats.get(g.id);
        return (
          // Wrapped like every other kind, so `closest('[data-gate]')` answers
          // "is this pointer on a gate?" for range gates too — which is what
          // keeps a press on a histogram's range boundary from being read as a
          // drag of the whole panel.
          <g key={g.id} data-gate={g.id}>
            <RangeShape
              g={g}
              axis={axis}
              // One hue for band, boundary and caption — the gate's own. See
              // `populationColors.ts`.
              color={gateHue(g)}
              selected={g.id === selectedGateId}
              // Name and percentage separately: the caption stacks them, and
              // pre-joining them here would put the line break rule in the
              // wrong file and hide the widest line from the placement.
              name={g.name}
              percent={s ? `${s.percentOfParent.toFixed(1)}%` : null}
              // A row per gate, because a histogram routinely carries several —
              // the negative and positive gates of a self-referencing bead
              // control are two markers on one detector. Both anchor their
              // label at the middle of their own band, and on an unbounded pair
              // those middles are within a few pixels of each other, so they
              // were drawn at the same y and read as one line of interleaved
              // glyphs.
              //
              // Two *different* controls peaking in the same detector used to
              // land here as well, which was a real bug rather than a crowded
              // plot: gates belong to one sample now (`ownerSampleId`), so a
              // worksheet never draws another control's population.
              row={i}
              toPixelX={toPixelX}
              toPixelY={toPixelY}
              plotW={props.plotW}
              plotH={props.plotH}
              onDown={onGatePointerDown}
            />
          </g>
        );
      })}
      {visible.map((g) => {
        if (!isGeometric(g)) return null;
        const selected = g.id === selectedGateId;
        const color = POP(g.colorIndex);
        const s = stats.get(g.id);
        const label = s ? `${g.name}  ${s.percentOfParent.toFixed(1)}%` : g.name;

        return (
          // `data-gate` is a stable hook for the verification harnesses: a gate
          // shape has to be grabbed at real screen coordinates to test dragging
          // it, and deriving those from the store means re-implementing the
          // plot's transform in the test — which would then pass against a
          // broken transform.
          <g key={g.id} data-gate={g.id}>
            {g.kind === 'rectangle' && (
              <RectShape g={g} color={color} selected={selected} toPixelX={toPixelX} toPixelY={toPixelY} onDown={onGatePointerDown} />
            )}
            {g.kind === 'polygon' && (
              <PolyShape g={g} color={color} selected={selected} toPixelX={toPixelX} toPixelY={toPixelY} onDown={onGatePointerDown} />
            )}
            {g.kind === 'ellipse' && (
              <EllipseShape g={g} color={color} selected={selected} toPixelX={toPixelX} toPixelY={toPixelY} onDown={onGatePointerDown} />
            )}
            {g.kind === 'quadrant' && (
              <QuadShape g={g} color={color} selected={selected} toPixelX={toPixelX} toPixelY={toPixelY} plotW={props.plotW} plotH={props.plotH} onDown={onGatePointerDown} />
            )}
            <GateLabel
              g={g}
              label={label}
              // The gate's ink, not its population colour — see `GateLabel`.
              color={gateInk(g)}
              offset={props.labelOffsets?.[g.id]}
              toPixelX={toPixelX}
              toPixelY={toPixelY}
              onMove={props.onLabelMove}
              onRename={props.onLabelRename}
            />
          </g>
        );
      })}
    </g>
  );
}

/* ========================================================================== */

const HANDLE = 5;

/**
 * A gate's edit handle: 5 px of ink, `HANDLE_HIT` px of target.
 *
 * The two sizes are the fix. The visible square has to stay small — a large one
 * drawn on a polygon vertex hides the shape it is there to adjust — but a 5 px
 * square is a smaller thing to aim at than the 10 px radius the per-event hover
 * search uses, so the pointer landed *beside* the handle, the press fell through
 * to the plot surface, and the drag "showed event circles instead of resizing the
 * gate". A transparent target over the top, sized from the same constant the
 * tooltip's suppression rule reads, means what you can press is the size of what
 * you are aiming at.
 *
 * The target is drawn **after** the ink so it is above it in SVG paint order, and
 * so the cursor over the whole target is the handle's own.
 *
 * **The cursor comes from the handle's name**, through `gateHandleCursor`, rather
 * than from a prop each call site fills in. That is Item 10's second half: a
 * polygon vertex was passing `grab` while the bounding-box handles a few pixels
 * away passed `nwse-resize`, so the cursor changed to a hand at exactly the pixel
 * where the finest edit is available. Deriving it means the mapping cannot differ
 * between two call sites, and it can be asserted without rendering anything.
 */
function Handle({
  x, y, color, handle, onDown,
}: {
  x: number; y: number; color: string; handle: string; onDown: (e: React.PointerEvent) => void;
}) {
  const cursor = gateHandleCursor(handle);
  return (
    <>
      <rect
        x={x - HANDLE / 2}
        y={y - HANDLE / 2}
        width={HANDLE}
        height={HANDLE}
        fill="var(--surface-plot)"
        stroke={color}
        strokeWidth={1.25}
        className="pointer-events-none"
        shapeRendering="geometricPrecision"
      />
      <rect
        data-gate-handle=""
        x={x - HANDLE_HIT / 2}
        y={y - HANDLE_HIT / 2}
        width={HANDLE_HIT}
        height={HANDLE_HIT}
        fill="transparent"
        style={{ cursor, pointerEvents: 'all' }}
        onPointerDown={onDown}
      />
    </>
  );
}

type ShapeProps<G> = {
  g: G;
  color: string;
  selected: boolean;
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  onDown: GateLayerProps['onGatePointerDown'];
};

/**
 * The casing/ink pair, for any shape that has an outline.
 *
 * Rendered as two copies of the same geometry: the casing first, wider and
 * semi-transparent, then the ink over it. `children` is a function of the stroke
 * props rather than a fixed element so each shape keeps its own geometry
 * attributes, and only the ink copy carries the fill and the pointer target — a
 * second hit target under the first would make every press ambiguous.
 */
function Outlined({
  selected, ink = GATE_INK, children,
}: {
  selected: boolean;
  /** The gate's own colour when it has one; the theme's ink otherwise. */
  ink?: string;
  children: (
    stroke: { stroke: string; strokeWidth: number; 'data-gate-outline': string },
    ink: boolean,
  ) => React.ReactNode;
}) {
  return (
    <>
      {/* `data-gate-outline` is a stable hook for the verification harness. The
          claim "a gate outline is dark" has to be measured on the outline, and a
          gate's SVG also contains handle squares stroked in the *population*
          colour — correctly, since that is what says which gate a handle belongs
          to. Without a marker the harness measured those and reported the fix as
          not applied. */}
      {children({ stroke: GATE_CASING, strokeWidth: STROKE(selected) + CASING_EXTRA, 'data-gate-outline': 'casing' }, false)}
      {children({ stroke: ink, strokeWidth: STROKE(selected), 'data-gate-outline': 'ink' }, true)}
    </>
  );
}

function RectShape({ g, color, selected, toPixelX, toPixelY, onDown }: ShapeProps<Extract<Gate, { kind: 'rectangle' }>>) {
  const x0 = toPixelX(g.xMin), x1 = toPixelX(g.xMax);
  const y0 = toPixelY(g.yMax), y1 = toPixelY(g.yMin);
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const corners: Array<[number, number, string]> = [
    [Math.min(x0, x1), Math.min(y0, y1), 'nw'],
    [Math.max(x0, x1), Math.min(y0, y1), 'ne'],
    [Math.max(x0, x1), Math.max(y0, y1), 'se'],
    [Math.min(x0, x1), Math.max(y0, y1), 'sw'],
  ];
  return (
    <>
      <Outlined selected={selected} ink={gateInk(g)}>
        {(stroke, ink) => (
          <rect
            x={Math.min(x0, x1)} y={Math.min(y0, y1)} width={w} height={h}
            fill={ink ? color : 'none'} fillOpacity={ink ? FILL_OPACITY(selected) : undefined}
            {...stroke}
            style={ink ? { cursor: gateHandleCursor('move'), pointerEvents: 'all' } : { pointerEvents: 'none' }}
            onPointerDown={ink ? (e) => onDown(e, g.id, 'move') : undefined}
            shapeRendering="geometricPrecision"
          />
        )}
      </Outlined>
      {selected && corners.map(([cx, cy, id]) => (
        <Handle key={id} x={cx} y={cy} color={color} handle={id} onDown={(e) => onDown(e, g.id, id)} />
      ))}
    </>
  );
}

function PolyShape({ g, color, selected, toPixelX, toPixelY, onDown }: ShapeProps<Extract<Gate, { kind: 'polygon' }>>) {
  const pts = g.vertices.map((v) => `${toPixelX(v.x).toFixed(2)},${toPixelY(v.y).toFixed(2)}`).join(' ');
  return (
    <>
      <Outlined selected={selected} ink={gateInk(g)}>
        {(stroke, ink) => (
          <polygon
            points={pts}
            fill={ink ? color : 'none'} fillOpacity={ink ? FILL_OPACITY(selected) : undefined}
            {...stroke} strokeLinejoin="round"
            style={ink ? { cursor: gateHandleCursor('move'), pointerEvents: 'all' } : { pointerEvents: 'none' }}
            onPointerDown={ink ? (e) => onDown(e, g.id, 'move') : undefined}
            shapeRendering="geometricPrecision"
          />
        )}
      </Outlined>
      {/* The bounding box comes **before** the vertices, so a vertex sitting on a
          corner of it wins the press. Coarse adjustment must never take
          precedence over fine adjustment aimed at the same pixel. */}
      {selected && (
        <PolyBounds g={g} color={color} toPixelX={toPixelX} toPixelY={toPixelY} onDown={onDown} />
      )}
      {selected && g.vertices.map((v, i) => (
        <Handle
          key={i}
          x={toPixelX(v.x)}
          y={toPixelY(v.y)}
          color={color}
          handle={`v${i}`}
          onDown={(e) => onDown(e, g.id, `v${i}`)}
        />
      ))}
    </>
  );
}

/**
 * Bounding-box handles on a selected polygon: coarse resize, alongside vertices.
 *
 * Adjusting how big a polygon is meant dragging every vertex in turn, which for a
 * ten-vertex gate is ten gestures to do one thing. This is the same affordance
 * rectangles and ellipses already have — corners and edge midpoints, scaling from
 * the opposite corner or edge, which is exactly the rectangle convention (drag
 * `nw` and `se` stays put) so the two behave alike.
 *
 * Inset outward by `PAD` px. Two reasons, and both matter: the box would otherwise
 * sit on top of the outline it describes and read as a second gate, and its
 * corners would land on or near the extreme vertices whose own handles have to
 * stay hittable.
 *
 * Per-vertex dragging is untouched — a different handle prefix, a different branch
 * in `applyGateDrag`, and drawn after this so it wins any overlap.
 */
const PAD = 6;

function PolyBounds({
  g, color, toPixelX, toPixelY, onDown,
}: {
  g: Extract<Gate, { kind: 'polygon' }>;
  color: string;
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  onDown: GateLayerProps['onGatePointerDown'];
}) {
  const xs = g.vertices.map((v) => toPixelX(v.x));
  const ys = g.vertices.map((v) => toPixelY(v.y));
  if (xs.length < 3) return null;
  const left = Math.min(...xs) - PAD;
  const right = Math.max(...xs) + PAD;
  const top = Math.min(...ys) - PAD;
  const bottom = Math.max(...ys) + PAD;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;

  // Handle ids are `b` + the compass direction, matching the rectangle's own
  // `nw`/`ne`/`se`/`sw` so `applyGateDrag` can read which edges move the same way
  // for both. Screen `n` is the *top*, which is the larger y in data space — the
  // flip lives in `applyGateDrag`, once, rather than in every caller.
  const handles: Array<[number, number, string]> = [
    [left, top, 'bnw'],
    [right, top, 'bne'],
    [right, bottom, 'bse'],
    [left, bottom, 'bsw'],
    [midX, top, 'bn'],
    [midX, bottom, 'bs'],
    [left, midY, 'bw'],
    [right, midY, 'be'],
  ];

  return (
    <>
      <rect
        x={left} y={top} width={right - left} height={bottom - top}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeDasharray="3 3"
        strokeOpacity={0.55}
        className="pointer-events-none"
        shapeRendering="geometricPrecision"
      />
      {handles.map(([hx, hy, id]) => (
        <Handle key={id} x={hx} y={hy} color={color} handle={id} onDown={(e) => onDown(e, g.id, id)} />
      ))}
    </>
  );
}

function EllipseShape({ g, color, selected, toPixelX, toPixelY, onDown }: ShapeProps<Extract<Gate, { kind: 'ellipse' }>>) {
  const cx = toPixelX(g.cx), cy = toPixelY(g.cy);
  // Radii are converted through the same mapping so the ellipse tracks zoom.
  const rx = Math.abs(toPixelX(g.cx + g.rx) - cx);
  const ry = Math.abs(toPixelY(g.cy + g.ry) - cy);
  return (
    <>
      <Outlined selected={selected} ink={gateInk(g)}>
        {(stroke, ink) => (
          <ellipse
            cx={cx} cy={cy} rx={rx} ry={ry}
            transform={g.angle ? `rotate(${(-g.angle * 180) / Math.PI} ${cx} ${cy})` : undefined}
            fill={ink ? color : 'none'} fillOpacity={ink ? FILL_OPACITY(selected) : undefined}
            {...stroke}
            style={ink ? { cursor: gateHandleCursor('move'), pointerEvents: 'all' } : { pointerEvents: 'none' }}
            onPointerDown={ink ? (e) => onDown(e, g.id, 'move') : undefined}
            shapeRendering="geometricPrecision"
          />
        )}
      </Outlined>
      {selected && (
        <>
          <Handle x={cx + rx} y={cy} color={color} handle="rx" onDown={(e) => onDown(e, g.id, 'rx')} />
          <Handle x={cx} y={cy - ry} color={color} handle="ry" onDown={(e) => onDown(e, g.id, 'ry')} />
        </>
      )}
    </>
  );
}

function QuadShape({
  g, color, selected, toPixelX, toPixelY, plotW, plotH, onDown,
}: ShapeProps<Extract<Gate, { kind: 'quadrant' }>> & { plotW: number; plotH: number }) {
  const x = toPixelX(g.xSplit);
  const y = toPixelY(g.ySplit);
  // Only the first quadrant of a set draws the crosshair; the other three share
  // the same split and would overprint it four times.
  if (g.quadrant !== 0) return null;
  return (
    <>
      <Outlined selected={selected} ink={gateInk(g)}>
        {(stroke) => (
          <>
            <line x1={x} y1={0} x2={x} y2={plotH} {...stroke} shapeRendering="crispEdges" />
            <line x1={0} y1={y} x2={plotW} y2={y} {...stroke} shapeRendering="crispEdges" />
          </>
        )}
      </Outlined>
      {/* The crosshair origin is the whole of a quadrant's geometry — moving it
          is the only edit the gate has — so its target is sized like every other
          handle rather than being a slightly-generous 6 px circle. */}
      <circle
        data-gate-handle=""
        cx={x} cy={y} r={HANDLE_HIT / 2}
        fill="transparent"
        style={{ cursor: gateHandleCursor('move'), pointerEvents: 'all' }}
        onPointerDown={(e) => onDown(e, g.id, 'move')}
      />
      {selected && <Handle x={x} y={y} color={color} handle="move" onDown={(e) => onDown(e, g.id, 'move')} />}
    </>
  );
}

/**
 * A 1D interval, drawn as a full-height band with a draggable edge each side.
 *
 * The edges are lines rather than the square handles the 2D shapes use: a range
 * gate is adjusted almost entirely by nudging one boundary, and a 5 px square
 * sitting somewhere along a full-height edge is a much smaller target than the
 * edge itself.
 */
function RangeShape({
  g, axis, color, selected, name, percent, row, toPixelX, toPixelY, plotW, plotH, onDown,
}: {
  g: Extract<Gate, { kind: 'range' }>;
  /**
   * Which axis this plot carries the gate's parameter on — `rangeAxisOn`
   * decided, and everything below is written in terms of it rather than in
   * terms of x. A vertical band and a horizontal one are the same gate.
   */
  axis: 'x' | 'y';
  color: string;
  selected: boolean;
  /** The population's name — the first line of the caption. */
  name: string;
  /** Its share of its parent, already formatted, or null before it is evaluated. */
  percent: string | null;
  /** Which line of the label stack this gate's caption sits on. */
  row: number;
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  plotW: number;
  plotH: number;
  onDown: GateLayerProps['onGatePointerDown'];
}) {
  /*
     The two orientations, named once.

     `along` is the axis the interval is measured on and `across` is the one it
     spans completely — so a vertical band is `along = width` and a horizontal
     one is `along = height`, and every number below is written in those terms.
     The alternative was a second copy of this component with x and y swapped,
     which is how the band, the boundary line, the open-end dash, the handle
     target and the caption would come to disagree with each other one at a time.

     `loEdge` is where the *low* end of the interval runs off the plot. On x that
     is pixel 0; on y it is `plotH`, because a y axis increases upward while
     pixels increase downward. Getting that backwards puts an unbounded *Dead*
     band at the top of the plot, over the live cells.
  */
  const horizontal = axis === 'x';
  const toPixel = horizontal ? toPixelX : toPixelY;
  const along = horizontal ? plotW : plotH;
  const across = horizontal ? plotH : plotW;
  const loEdge = horizontal ? 0 : plotH;
  const hiEdge = horizontal ? plotW : 0;
  /*
     An infinite boundary, and the two separate things that have to be true
     about it.

     A one-sided gate is stored with an infinite end — `max: +Infinity` for
     "everything above this threshold" — which is the honest way to say it: the
     heuristic computed one bound and inventing a second would imply a precision
     it does not have. But `toPixelX(Infinity)` is `Infinity`, so the band came
     out as `width="Infinity"`, both boundary lines at `x="Infinity"`, and the
     label at the midpoint of a finite number and an infinite one, which is also
     infinite. SVG rejects all four, so the browser dropped them: an unbounded
     gate rendered as **one bare line with no fill and no label**, on every
     auto-seeded gate in the unmixing walk. That was fixed on 2026-08-07 by
     clamping both ends to 40 px *outside* the plot, on the reasoning that the
     band would then be visibly cut off by the plot rather than looking like a
     gate that happens to stop there.

     Nothing cuts it off. There is no clip anywhere on this SVG, and the panel's
     right margin is 8 px — so the shaded band ran 8 px past the axis, into the
     chrome, while the histogram's own fill stopped exactly on it. Two layers
     that describe the same interval, ending in two different places, which is
     precisely how it read: *the shading does not line up with the curve*
     (2026-08-09). On the left it was worse, since the y-axis tick labels live in
     55 px of margin an unbounded negative gate's band drew straight over.

     So the *geometry* is the intersection with the plot rectangle — the band is
     exactly the region the histogram is drawn in, and is assertable as such
     rather than depending on a clip nobody added — and the reason the overhang
     existed is kept by drawing a **boundary line only where there is a boundary
     to draw**. An infinite end has none, so the band simply reaches the edge and
     stops, with no line implying a threshold there.
  */
  const a = toPixel(g.min);
  const b = toPixel(g.max);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // Pixel start and length of the band along its own axis, clipped to the plot.
  const start = Math.max(0, Math.min(along, lo));
  const length = Math.max(0, Math.min(along, hi) - start);

  return (
    <>
      <rect
        data-gate-band=""
        x={horizontal ? start : 0}
        y={horizontal ? 0 : start}
        width={horizontal ? length : across}
        height={horizontal ? across : length}
        // A gate spanning the whole axis has no extent to mark, and its band
        // would tint the entire plot; it stays as the move target, unpainted.
        fill={color} fillOpacity={start <= 0 && length >= along ? 0 : RANGE_FILL_OPACITY(selected)}
        style={{ cursor: gateHandleCursor('move', axis), pointerEvents: 'all' }}
        onPointerDown={(e) => onDown(e, g.id, 'move')}
      />
      {([['min', g.min, a], ['max', g.max, b]] as const).map(([handle, value, px]) => {
        /*
           Both ends are draggable, including an open one (2026-08-11, Item 18).

           An auto-seeded positive gate is `{ min: threshold, max: +Infinity }` —
           a threshold and an honest refusal to invent a second one — and until
           now the open end had no handle at all, on the reasoning that there is
           no value there to drag. True about the *stored* gate and wrong about
           the *gesture*: a real single stain routinely carries a few hundred
           bright artefacts to the right of the population, and with only the
           left boundary movable the only way to exclude them was to draw a
           second gate by hand over the top of the seeded one.

           So an infinite end gets a handle pinned to the plot edge and a
           **dashed** rule there rather than the solid ink a real boundary
           carries. The distinction is the one the 2026-08-09 fix was protecting:
           a solid line asserts a threshold, and there is none — a dash at the
           edge says the band continues past it and that this is where to take
           hold of it. `applyGateDrag` materialises the value from the visible
           edge on the first move, so pulling it inward converts the open end
           into a real one.

           A *finite* boundary that is off-screen keeps the behaviour it had:
           a handle at the edge and no line, so a gate dragged out of view can
           still be brought back.
        */
        const open = !Number.isFinite(value);
        const inside = !open && px >= 0 && px <= along;
        // `min` opens towards the low end of the axis, `max` towards the high —
        // which is the left and right edges on x, and the bottom and top on y.
        const at = open
          ? (handle === 'min' ? loEdge : hiEdge)
          : Math.max(0, Math.min(along, px));
        // Half a pixel in, or a 1 px line centred on the plot's own edge is
        // drawn half outside it.
        const edge = at === 0 ? 0.5 : at - 0.5;
        return (
          <g key={handle}>
            {inside && (
              /* One thin line in the region's own hue (2026-10-22). It was a
                 casing under an ink line — 2.75 px of dark flank around a 1 px
                 core, drawn again by the neighbouring region at every shared
                 split — so a boundary read as a thick black bar beside a band
                 and a caption in some other colour. */
              <line
                data-gate-boundary={handle}
                x1={horizontal ? at : 0} y1={horizontal ? 0 : at}
                x2={horizontal ? at : across} y2={horizontal ? across : at}
                stroke={color} strokeWidth={STROKE(selected)} shapeRendering="crispEdges"
              />
            )}
            {open && (
              <line
                data-gate-open-edge={handle}
                x1={horizontal ? edge : 0} y1={horizontal ? 0 : edge}
                x2={horizontal ? edge : across} y2={horizontal ? across : edge}
                stroke={color}
                strokeWidth={1}
                strokeOpacity={0.6}
                strokeDasharray="3 4"
                shapeRendering="crispEdges"
              />
            )}
            {/* Same target width as every other kind's handle. It was 8 px, which
                is narrower than the per-event hover radius, so aiming at a
                boundary on a histogram hit the plot surface about as often as it
                hit the boundary. Kept wholly inside the plot, so an edge handle
                is a full-width target rather than half of one hanging over the
                panel chrome. */}
            <rect
              data-gate-handle=""
              {...(horizontal
                ? {
                  x: Math.max(0, Math.min(Math.max(0, along - HANDLE_HIT), at - HANDLE_HIT / 2)),
                  y: 0, width: HANDLE_HIT, height: across,
                }
                : {
                  x: 0,
                  y: Math.max(0, Math.min(Math.max(0, along - HANDLE_HIT), at - HANDLE_HIT / 2)),
                  width: across, height: HANDLE_HIT,
                })}
              fill="transparent"
              style={{ cursor: gateHandleCursor(handle, axis), pointerEvents: 'all' }}
              onPointerDown={(e) => onDown(e, g.id, handle)}
            />
          </g>
        );
      })}
      <RangeCaption
        gateId={g.id}
        axis={axis}
        name={name}
        percent={percent}
        color={color}
        center={start + length / 2}
        plotW={plotW}
        plotH={plotH}
        row={row}
      />
    </>
  );
}

/** Line height of the stacked caption, and the height of one gate's block. */
const CAPTION_LINE = 11;
const CAPTION_BLOCK = CAPTION_LINE * 2 + 4;

/**
 * A range gate's caption: the name, and the percentage under it.
 *
 * **Two lines rather than one**, which is the other half of the 2026-08-09
 * report. `CD45RA Spark NIR 685 +  20.0%` is 27 characters at 10 px — about
 * 150 px — on a 340 px plot whose gate is against the right-hand edge, so
 * whatever the horizontal placement rule does, one long line either overflows or
 * pushes the identity far from the boundary it describes. Stacked, the widest
 * line is the name alone and the number sits directly under it, which is also
 * the order they are read in: *which population*, then *how much of it*.
 *
 * Placement comes from `placeGateLabel` — a pure function with tests, because
 * "the caption is inside the plot" is arithmetic and was previously asserted by
 * nothing. Cased for the same reason the 2D label is: the band is translucent
 * and the histogram runs straight through it.
 */
function RangeCaption({
  gateId, axis, name, percent, color, center, plotW, plotH, row,
}: {
  gateId: string;
  /** Which way the band runs — the two placements are genuinely different. */
  axis: 'x' | 'y';
  name: string;
  percent: string | null;
  color: string;
  /** Middle of the band, along its own axis, in plot-local pixels. */
  center: number;
  plotW: number;
  plotH: number;
  row: number;
}) {
  const lines = percent ? [name, percent] : [name];
  /*
     A vertical band's caption is placed horizontally and stacked in rows; a
     horizontal band's is placed vertically and needs neither.

     The row stacking exists because two vertical bands on one plot can have
     their midpoints within a few pixels of each other — an unbounded negative
     and an unbounded positive gate on a histogram both centre near the middle
     of the plot — so their captions collided at the same y. Horizontal bands
     cannot do that: they are stacked in the thing the caption is offset along,
     so their centres are as far apart as the bands are. The caption sits at the
     left, inside the plot, level with the middle of its own band, and is only
     clamped so the two-line block stays on the plot.
  */
  const { x, anchor } = axis === 'x'
    ? placeGateLabel({ center, plotW, lines })
    : { x: LABEL_MARGIN, anchor: 'start' as const };
  const top = axis === 'x'
    ? 10 + row * CAPTION_BLOCK
    : Math.max(10, Math.min(plotH - CAPTION_LINE * (lines.length - 1) - 3, center - CAPTION_LINE / 2));
  return (
    <text
      data-gate-caption={gateId}
      x={x}
      y={top}
      textAnchor={anchor}
      fontSize={10}
      fontWeight={500}
      fill={color}
      stroke="var(--gate-casing)"
      strokeWidth={2.5}
      paintOrder="stroke"
      fontFamily="var(--font-ui)"
      shapeRendering="geometricPrecision"
      className="pointer-events-none select-none"
    >
      <tspan x={x}>{name}</tspan>
      {percent && <tspan x={x} dy={CAPTION_LINE}>{percent}</tspan>}
    </text>
  );
}

/**
 * A gate's name and percentage, drawn above the shape.
 *
 * Three things changed on 2026-08-03 and they answer one report — "Live 66.2%"
 * is hard to read:
 *
 *   - **It is drawn in the gate's ink, not the population colour**, so it is
 *     always the opposite lightness to the plot surface. A saturated cyan or
 *     amber over a dark plot is legible only where it crosses something dark.
 *   - **It has a casing**, painted with `paint-order: stroke` so the halo sits
 *     *behind* the glyphs rather than eating into them. This is the same
 *     cartographic trick the outline uses, and the label needs it more: the
 *     outline mostly lies over the population, the label mostly does not.
 *   - **It can be moved and renamed.** A label pinned above a shape lands on
 *     dense data often enough that the only way to read it was to move the gate.
 *     Dragging it stores a per-panel offset; double-clicking renames it, through
 *     the same store action the tree's rename uses, so there is one name.
 */
function GateLabel({
  g, label, color, offset, toPixelX, toPixelY, onMove, onRename,
}: {
  g: Gate;
  label: string;
  color: string;
  offset?: { dx: number; dy: number };
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
  onMove?: (gateId: string, dx: number, dy: number) => void;
  onRename?: (gateId: string, at: { x: number; y: number }) => void;
}) {
  if (!isGeometric(g) || g.kind === 'quadrant') return null;
  const b = boundsOf(g);
  const x = toPixelX((b.xMin + b.xMax) / 2) + (offset?.dx ?? 0);
  const y = toPixelY(b.yMax) - 5 + (offset?.dy ?? 0);

  /*
     A drag on the label, on `window` rather than with pointer capture.

     The same reasoning as the gate drag beside it: capture stops delivering the
     moment the pointer leaves the element, and a 60x12 px label is left within
     the first few pixels of any real drag. `stopPropagation` claims the press
     so neither the gate underneath nor the panel's drag-to-move also acts on it.
  */
  const beginDrag = (e: React.PointerEvent) => {
    if (!onMove) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = { dx: offset?.dx ?? 0, dy: offset?.dy ?? 0 };
    const move = (ev: PointerEvent) => {
      onMove(g.id, base.dx + (ev.clientX - startX), base.dy + (ev.clientY - startY));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <text
      x={x} y={y}
      data-gate-label={g.id}
      textAnchor="middle"
      fontSize={10}
      fontWeight={600}
      fill={color}
      stroke={GATE_CASING}
      strokeWidth={2.5}
      // Stroke behind fill. Without it the casing is painted over the glyphs and
      // a 10px label at weight 600 loses most of its counters to it.
      paintOrder="stroke"
      strokeLinejoin="round"
      fontFamily="var(--font-ui)"
      className="select-none cursor-move"
      style={{ pointerEvents: onMove || onRename ? 'auto' : 'none' }}
      onPointerDown={beginDrag}
      onDoubleClick={(e) => { e.stopPropagation(); onRename?.(g.id, { x, y }); }}
    >
      {label}
    </text>
  );
}

/* ========================================================================== */

/**
 * In-progress polygon, drawn while the user is still placing vertices.
 *
 * Once three vertices exist the first one becomes a visible close target — a
 * ring the same radius as the click-snap distance, so what the user aims at is
 * literally the area that will register. Before that it stays a plain vertex,
 * because clicking it would produce a degenerate gate.
 *
 * **The placed edges are drawn in gate ink over gate casing**, exactly as the
 * finished polygon will be, so closing the shape changes nothing about the line
 * you have been looking at. What stays accent is everything that exists only
 * while drawing: the rubber band to the cursor, the closing hint, the vertex
 * markers and the close ring. Those have no counterpart on a finished gate — they
 * vanish rather than changing colour — so they are the one place a second colour
 * carries information.
 */
export function PendingPolygon({
  vertices, cursor, closable, overClose, snapRadius, toPixelX, toPixelY,
}: {
  vertices: Point[];
  cursor: { x: number; y: number } | null;
  /** At least three vertices placed, so clicking the first would close the shape. */
  closable: boolean;
  /** Pointer is inside the snap radius right now. */
  overClose: boolean;
  snapRadius: number;
  toPixelX: (v: number) => number;
  toPixelY: (v: number) => number;
}) {
  if (vertices.length === 0) return null;
  const pts = vertices.map((v) => [toPixelX(v.x), toPixelY(v.y)] as const);
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  return (
    <g className="pointer-events-none">
      {/* Casing then ink, the same pair `Outlined` draws for a finished gate and
          with the same `data-gate-outline` hooks, so the harness can measure the
          in-progress outline by exactly the query it uses for a finalised one. */}
      <path
        d={path} fill="none" data-gate-outline="casing"
        stroke={GATE_CASING} strokeWidth={PENDING_CASING} strokeLinejoin="round"
      />
      <path
        d={path} fill="none" data-gate-outline="ink"
        stroke={GATE_INK} strokeWidth={PENDING_STROKE} strokeLinejoin="round"
      />
      {cursor && (
        <>
          {/* Rubber band from the last placed vertex to the pointer. */}
          <line x1={last[0]} y1={last[1]} x2={toPixelX(cursor.x)} y2={toPixelY(cursor.y)} stroke="var(--accent-400)" strokeWidth={1.25} strokeDasharray="3 2" />
          {pts.length >= 2 && (
            <line
              x1={toPixelX(cursor.x)} y1={toPixelY(cursor.y)} x2={first[0]} y2={first[1]}
              stroke="var(--accent-400)" strokeWidth={1} strokeDasharray="2 3" strokeOpacity={0.5}
            />
          )}
        </>
      )}
      {closable && (
        <circle
          cx={first[0]} cy={first[1]} r={snapRadius}
          fill={overClose ? 'var(--accent-400)' : 'none'}
          fillOpacity={overClose ? 0.22 : 0}
          stroke="var(--accent-400)"
          strokeWidth={overClose ? 1.75 : 1.25}
          strokeDasharray={overClose ? undefined : '2 2'}
          shapeRendering="geometricPrecision"
        />
      )}
      {pts.map(([x, y], i) => {
        // The first vertex grows once it is clickable, so the close target is
        // discoverable without hovering it first.
        const size = i === 0 && closable ? (overClose ? 8 : 7) : 5;
        return (
          <rect
            key={i}
            x={x - size / 2} y={y - size / 2} width={size} height={size}
            fill={i === 0 ? 'var(--accent-400)' : 'var(--surface-plot)'}
            stroke="var(--accent-400)" strokeWidth={1.25}
          />
        );
      })}
      <text
        x={last[0] + 8} y={last[1] - 8}
        fontSize={9.5} fill="var(--text-tertiary)" fontFamily="var(--font-ui)"
        className={cn('select-none')}
      >
        {vertices.length < 3 ? `${3 - vertices.length} more vertex minimum` : 'click the first point to close'}
      </text>
    </g>
  );
}
