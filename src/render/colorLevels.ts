/* ==========================================================================
   Colour levels — how a bin's count becomes a position along the ramp.

   This is a second stage, sitting *after* the density scaling and *before* the
   ramp lookup, and keeping the two apart is the whole reason it is its own
   module. They answer different questions and were previously conflated:

     - **Density scaling** (`linear`/`log`/`sqrt`/`rank`, in `binning.ts`) is the
       binning algorithm's answer to "how do I compress a count range that spans
       three orders of magnitude into 0…1". `rank` remains the default and is
       untouched by anything here.
     - **Colour levels** are the answer to "where along the ramp does that 0…1
       land". FCS Express calls this Style, offers Percentile as its default, and
       the distinction matters because a percentile mapping makes the ramp use its
       whole range on every plot regardless of what the counts happen to be.

   ## Percentile, precisely

   A cell's colour position is the **fraction of events that lie in cells no
   denser than this one**. So:

     - the sparse periphery — thousands of cells holding one event each, and
       collectively a few per cent of the sample — sits at the dark end;
     - the core, which is where the events actually are, gets most of the ramp to
       spread itself over;
     - the densest cell is always at the top of the ramp, on every plot.

   Event-weighted rather than cell-weighted, because "percentile" in a cytometry
   colour scale means a percentile *of the data*, and because cell-weighting gives
   most of the ramp to empty-ish periphery — of which there is always far more
   than there is population.

   That is a different equalisation from `rank` scaling, which spreads the ramp
   over the *distinct count values* — one cell with 500 events gets as much ramp
   as the ten thousand cells with one. Both are useful and both remain
   selectable, and the relationship between them has to be stated because it is
   not the obvious one: **percentile styling is invariant to the density
   scaling.** Any monotonic rescaling of the counts relabels the value axis
   without moving any event from one cell to another, so the cumulative event
   fraction at a given cell is unchanged by it. `rank` remains the default
   scaling, and it takes effect the moment Style is set to Linear; while Style is
   Percentile it is inert, which is the sense in which percentile styling is the
   answer to "I do not want to have to choose a scaling". The control says so
   rather than leaving the user to notice that a dropdown has stopped doing
   anything.

   ## Levels always come from the plot's own data

   A level table is built from the plot's own distribution of cell values, held
   as a histogram over a **fixed logarithmic value axis**. Values arrive in
   *× uniform* — a cell's share of the plot's events times the number of cells,
   so 1 is events spread evenly and a tight core is several hundred — which is
   what makes a file with twice the events, or the same events twice, give the
   same colours.

   There was a *Calculate all levels based on data* checkbox here once, whose
   "off" pinned the top of the ramp to a count; it went because turning it off
   also turned Style off. 0.37.0 pooled the levels across every sample instead
   (*Levels from*), and 0.37.1 removed that: two replicates already colour alike
   once they are smoothed alike, and `autoSmoothing` is a continuous function of
   the event count with no step for two of them to fall either side of.

   ## The ceiling ignores the pile

   Linear style divides by a ceiling, and the ceiling is the value below which
   99.5% of the reference's events sit (`CEILING_FRACTION`) — never the densest
   cell. On an Aurora tube the densest cell is the row of events piled at the
   detector's maximum, five times the real core, and dividing by it put the core
   at 0.44 of the ramp. Those cells are left out of the reference altogether (see
   `summariseLevels`); they still draw, at the top of the ramp.

   ## Everything is a table

   At the default 1024×1024 resolution a density plot has 1 048 576 cells, so the
   per-cell work has to be one lookup. Every mapping decision is baked into a
   single `Float32Array` of `LEVEL_QUANTA` entries once per draw, indexed by
   `quantum(value)`.
   ========================================================================== */

import type { DensityScale } from './binning';

/** How finely the value axis is quantised before any mapping is applied. */
export const LEVEL_QUANTA = 4096;

/**
 * The value axis, in decades of *× uniform*: 10⁻⁴ is one event smoothed over a
 * 21-cell window in a million-event file, 10⁶ is every event in one cell of a
 * 1024×1024 grid. Ten decades over 4094 quanta is 0.56% per step — finer than the
 * 256 colours a value ends up in.
 */
const LOG_MIN = -4;
const LOG_MAX = 6;
const STEP = (LOG_MAX - LOG_MIN) / (LEVEL_QUANTA - 2);

/** The share of the reference's events the Linear-style ceiling sits above. */
export const CEILING_FRACTION = 0.995;

/** Decades below the ceiling that the `log` density scale spans. */
export const LOG_DECADES = 3;

export type ColorStyle = 'percentile' | 'linear';
export type ColorScaling = 'linear' | 'log';


/** Everything about turning a cell value into a position along the ramp. */
export interface ColorLevelSpec {
  style: ColorStyle;
  scaling: ColorScaling;
}

export interface LevelTable {
  /** Ramp position per quantum, 0…1, indexed by `quantum(value)`. */
  positions: Float32Array;
}

/**
 * A distribution of cell values: how much of the events sit in each quantum.
 *
 * `mass[k]` is the summed value of the cells in quantum `k` — events, in the
 * value's own units — which is what makes a percentile over it event-weighted.
 */
export interface LevelSummary {
  mass: Float64Array;
}

/**
 * Index into a level table for a cell value.
 *
 * **Any occupied cell lands at index 1 or higher** and index 0 means empty and
 * nothing else — a single event smoothed across a wide kernel must never be
 * painted as the background.
 */
export function quantum(value: number): number {
  if (!(value > 0)) return 0;
  const k = 1 + Math.floor((Math.log10(value) - LOG_MIN) / STEP);
  return k < 1 ? 1 : k >= LEVEL_QUANTA ? LEVEL_QUANTA - 1 : k;
}

/** The value a quantum stands for — the geometric middle of its interval. */
export function quantumValue(k: number): number {
  return k <= 0 ? 0 : Math.pow(10, LOG_MIN + (k - 0.5) * STEP);
}

/**
 * One grid's distribution, in the reference's units.
 *
 * `unit` converts a cell value into them (× uniform, for a plot). `excluded`
 * names the cells that must not set the levels — the pile at a detector's
 * maximum — and they are left out entirely, so neither the percentile nor the
 * ceiling can be moved by a few hundred events stacked on the top of the axis.
 */
export function summariseLevels(
  bins: ArrayLike<number>,
  unit = 1,
  excluded?: ((index: number) => boolean) | null,
): LevelSummary {
  const mass = new Float64Array(LEVEL_QUANTA);
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i]! * unit;
    if (!(v > 0) || (excluded && excluded(i))) continue;
    mass[quantum(v)] += v;
  }
  return { mass };
}

/**
 * The value below which `fraction` of the reference's events sit.
 *
 * Event-weighted rather than cell-weighted: a percentile of *cells* is the
 * extreme cell on a sparse grid, and a few stacked events are a small share of
 * events however many cells they fill. 0 for an empty reference.
 */
export function robustCeiling(reference: LevelSummary, fraction = CEILING_FRACTION): number {
  let total = 0;
  for (let k = 0; k < LEVEL_QUANTA; k++) total += reference.mass[k]!;
  if (!(total > 0)) return 0;
  let cumulative = 0;
  for (let k = 1; k < LEVEL_QUANTA; k++) {
    cumulative += reference.mass[k]!;
    if (cumulative >= fraction * total) return quantumValue(k);
  }
  return quantumValue(LEVEL_QUANTA - 1);
}

/**
 * Build the value → ramp-position table.
 *
 *   percentile — the reference's cumulative event fraction, and **nothing
 *     else**: invariant to the density scaling, which is what percentile styling
 *     is *for*. "At or below", so the densest occupied quantum reaches 1.
 *   linear     — the density scaling over `[0, ceiling]`: the reference's robust
 *     ceiling, or a stated one. Values above it take the top of the ramp.
 *
 * The colour scaling is applied last, over whatever the style produced.
 */
export function buildLevelTable(
  reference: LevelSummary,
  spec: ColorLevelSpec,
  scale: DensityScale,
  ceiling?: number | null,
): LevelTable {
  const positions = new Float32Array(LEVEL_QUANTA);
  const mass = reference.mass;
  let total = 0;
  for (let k = 0; k < LEVEL_QUANTA; k++) total += mass[k]!;
  const top = ceiling && ceiling > 0 ? ceiling : robustCeiling(reference);
  const scaled = spec.style === 'linear' ? scaler(reference, scale, top) : null;

  let cumulative = 0;
  for (let k = 1; k < LEVEL_QUANTA; k++) {
    cumulative += mass[k]!;
    let u = scaled ? scaled(k) : total > 0 ? cumulative / total : 0;
    if (spec.scaling === 'log') u = logWarp(u);
    positions[k] = clamp01(u);
  }
  return { positions };
}

/** The density scaling, as a function of a quantum, against a ceiling value. */
function scaler(reference: LevelSummary, scale: DensityScale, top: number): (k: number) => number {
  if (!(top > 0)) return () => 0;
  if (scale === 'linear') return (k) => quantumValue(k) / top;
  if (scale === 'sqrt') return (k) => Math.sqrt(quantumValue(k) / top);
  if (scale === 'log') return (k) => 1 + Math.log10(quantumValue(k) / top) / LOG_DECADES;
  // Rank over the *distinct* occupied levels up to the ceiling, so a lone dense
  // cell gets as much of the range as the ten thousand cells holding one event.
  const topQ = quantum(top);
  const rank = new Float32Array(LEVEL_QUANTA);
  let distinct = 0;
  for (let k = 1; k < LEVEL_QUANTA; k++) {
    if (k <= topQ && reference.mass[k]! > 0) distinct++;
    rank[k] = distinct;
  }
  return (k) => (k > topQ || distinct <= 1 ? 1 : (rank[k]! - 1) / (distinct - 1));
}

/**
 * Compress a level position towards the low end, one decade at a time.
 *
 * `log10(1 + 9u)`: 0 stays 0, 1 stays 1, and 0.1 becomes 0.28 — so the bottom
 * tenth of the range gets nearly a third of the ramp. This is the colour
 * intensity's own scaling, not the density scaling: it applies *after* whatever
 * `log`, `sqrt` or `rank` already did, and it is how a percentile mapping is made
 * to spend more of its palette on the faint end without changing which cell is
 * denser than which.
 */
export function logWarp(u: number): number {
  return Math.log10(1 + 9 * clamp01(u));
}

function clamp01(v: number): number {
  return !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
}

/* --------------------------------------------------------------------------
   Smoothing
   -------------------------------------------------------------------------- */

/**
 * How much blur a stated smoothing value produces, as a standard deviation in
 * cells.
 *
 * **`(window - 1) / √6`, exactly linear in the value**, so every step of the
 * stepper adds the same 0.408 cells of blur: 0, 0.408, 0.816, 1.225, 1.633 … up
 * to 8.165 at the maximum of 21. That is the whole of Item 8, and it is a
 * different claim from the one the previous fix made.
 *
 * ## Two bugs, one control
 *
 * The first, fixed 2026-08-01, was that `Math.floor(window / 2)` gave 2 and 3 an
 * identical kernel, so half the steps did *nothing at all*. That fix — a
 * fractional radius of `(w−1)/2`, with the end taps weighted by the fraction —
 * made every step distinct and was reported as still wrong, correctly. Distinct
 * is not the same as proportional. Measuring the kernel it produced:
 *
 * ```
 * w      1      2      3      4      5      6      7
 * sigma  0    0.707  0.816  1.225  1.414  1.780  2.000
 * step        0.707  0.109  0.408  0.190  0.365  0.220
 * ```
 *
 * Going 3→4 changed nearly **four times** as much as 3 had changed from 2, and
 * 4→5 changed half as much again. The control moved in a limp: a big step onto
 * every even value and a small one onto every odd.
 *
 * The cause is that variance, not radius, is what the eye reads as "how blurred",
 * and lumping the fractional end weight at the *centre of a whole cell* one place
 * beyond the core overstates it. A discrete box of odd width `w` has variance
 * `(w²−1)/12`; the same construction at even width lands 0.25 above that curve,
 * every time, which is exactly the sawtooth above.
 *
 * ## The fix: state the variance, then solve for the kernel
 *
 * So the radius stops being the primary quantity. `smoothSigma` states the blur
 * the control promises, and `smoothKernel` finds the discrete kernel that
 * *delivers* it rather than the other way round. `√6` is not arbitrary: it is the
 * constant that makes `w = 3` come out at `√(2/3)`, the variance of the plain
 * three-cell box — so **the default plot, at smoothing 3, is byte-identical to
 * what it was**, and the fix changes the steps around it rather than the picture
 * anybody has been looking at.
 */
export function smoothSigma(window: number): number {
  return Math.max(0, (window - 1) / Math.sqrt(6));
}

/* -------------------------------------------------------------------------
   Auto smoothing
   ------------------------------------------------------------------------- */

/** The smallest and largest windows the stepper and the auto rule will produce. */
export const SMOOTHING_MIN = 1;
export const SMOOTHING_MAX = 21;

/**
 * The Auto kernel's standard deviation, as a fraction of the axis span, for a
 * plot of `AUTO_SMOOTHING_EVENTS` events.
 *
 * 0.1% — a window of 3.5 at 1024×1024, which is what the old per-file rule gave
 * a 15 000-event scatter pair and the picture people had been reading. 0.3% was
 * tried in 0.37.0 and read as dense and bloated: it smoothed below the screen's
 * resolution and spread every event over a disc three times as wide.
 */
export const AUTO_SMOOTHING_SPAN = 0.001;

/** The event count at which Auto's bandwidth is exactly `AUTO_SMOOTHING_SPAN`. */
export const AUTO_SMOOTHING_EVENTS = 15_000;

/**
 * The Auto smoothing window: a bandwidth **in data units** that narrows as the
 * plot holds more events, `σ ∝ n^(−1/6)`.
 *
 * **Two rules before it.** 0.36 read the grid — `√(14 · occupied / n)`, rounded.
 * Two replicate tubes scored 3.5002 and 3.4992, rounded to 4 and 3, and since a
 * window of 3 is a pure box that put every lone event at one identical level a
 * third of the way up the ramp: one tube's periphery cyan, the other's navy.
 * 0.37.1 answered that with one fixed width for every plot, which was right for
 * the 15–24k-event tubes it was set on and 2.5× the blur 0.36 had given a
 * 300 000-event tube — and those plots read as thick.
 *
 * **The rule.** Scott's bandwidth for a two-dimensional density estimate,
 * anchored where the plots already looked right: σ is `AUTO_SMOOTHING_SPAN` of
 * the axis at `AUTO_SMOOTHING_EVENTS` and shrinks as the sixth root of the event
 * count. More events need less smoothing to be read as a density, and the sixth
 * root is how much less. At 1024×1024: 5k → 4.0, 15k → 3.5, 100k → 2.8,
 * 300k → 2.5 — within a tenth of what 0.36 gave those files before rounding.
 *
 * **What it reads is the event count and nothing else** — not `occupied`, which
 * depends on how the events lie, and not the canvas. And it is **never rounded**,
 * because `smoothKernel` realises any real window exactly: two replicates of
 * 15 072 and 15 575 events get 3.52 and 3.49, not a step. `n` is the events the
 * plot binned, so a small gate drawn from a large tube is smoothed as the small
 * population it is.
 *
 * Clamped to the stepper's own range so Auto and manual cannot disagree about
 * what a legal value is.
 */
export function autoSmoothing(binCount: number, events: number): number {
  if (!(binCount > 0) || !(events > 0)) return SMOOTHING_MIN;
  const span = AUTO_SMOOTHING_SPAN * Math.pow(events / AUTO_SMOOTHING_EVENTS, -1 / 6);
  const w = 1 + Math.sqrt(6) * span * binCount;
  return Math.min(SMOOTHING_MAX, Math.max(SMOOTHING_MIN, w));
}

/**
 * The discrete kernel that realises `smoothSigma(window)` exactly.
 *
 * A uniform core over `|i| ≤ half`, plus one tap of weight `tap` at `±(half+1)`.
 * That shape is not a compromise — it is the widest family that a running sum can
 * still evaluate in O(1) per cell, which is what keeps a 1024×1024 redraw inside
 * its frame budget — and within it there is exactly one free parameter, so the
 * variance can be hit on the nose:
 *
 * ```
 *   V = [2·Σi² + 2·tap·(half+1)²] / [(2·half+1) + 2·tap]
 *   ⇒  tap = [V·(2·half+1) − 2·Σi²] / [2·((half+1)² − V)]
 * ```
 *
 * `half` is taken from the *equivalent uniform box*, `√(12V+1)`, which is what
 * bounds `tap` into `[0, 1)` at every value rather than leaving it to be checked:
 * a box of width `2·half+1` has variance at most `V` by construction, which
 * forces `tap ≥ 0`, and one of width `2·half+3` has variance strictly more than
 * `V`, which forces `tap < 1`. So the kernel never inverts into an end-heavy
 * shape and never needs clamping. `colorLevels.test.ts` walks all 21 values and
 * asserts both bounds along with the variance itself.
 *
 * Returns `half: 0, tap: 0` for a window of 1, which is the identity.
 */
export function smoothKernel(window: number): { half: number; tap: number } {
  const sigma = smoothSigma(window);
  const v = sigma * sigma;
  if (v <= 0) return { half: 0, tap: 0 };
  const equivalent = Math.sqrt(12 * v + 1);
  // `EPS` on the floor, because `12·v + 1` is an exact perfect square at every odd
  // window and `Math.sqrt` lands a bit either side of it. Half a unit-in-the-last-
  // place decides `half`, and while the solve below compensates for either choice
  // — a `half` one too small comes back with `tap` of 1, which is the same kernel
  // written differently — the two forms are not *identical*, and "smoothing 3 is
  // the plain three-cell box" is an equality this file asserts.
  const half = Math.max(0, Math.floor((equivalent - 1) / 2 + EPS));
  // Σ i² for i in 1..half.
  const core = (half * (half + 1) * (2 * half + 1)) / 6;
  const denominator = 2 * ((half + 1) * (half + 1) - v);
  // Defensive only: the choice of `half` above makes the denominator positive and
  // the result land in [0, 1) for every window this app can produce. A degenerate
  // answer here would be a kernel wider than its own core, so it is clamped
  // rather than trusted.
  const raw = denominator > 0 ? (v * (2 * half + 1) - 2 * core) / denominator : 0;
  const tap = Math.min(1, Math.max(0, raw));
  // A tap of ~1e-17 is arithmetic residue, not a kernel: it adds a weight of one
  // part in a quadrillion to a cell that should be untouched, which is invisible
  // and is also the difference between "smoothing 3 renders what it always did"
  // and "smoothing 3 renders something within float noise of what it always did".
  // The second is not a claim a test can make cleanly.
  return { half, tap: tap < EPS ? 0 : tap };
}

/** Below this, a tap weight is float residue rather than signal. */
const EPS = 1e-9;

/**
 * The kernel's outer extent, in whole cells — `half + 1` when there is a
 * fractional tap, `half` when there is not.
 *
 * Kept as the "is there anything to do" predicate the two blur implementations
 * share. It is **not** the old `smoothRadius`: that returned `(w−1)/2` and was
 * both the shape of the kernel and the promise about it, which is precisely the
 * conflation Item 8 was about.
 */
export function smoothExtent(window: number): number {
  const { half, tap } = smoothKernel(window);
  return tap > 0 ? half + 1 : half;
}

/**
 * Box-blur a bin grid, separably, with a window of `window` cells.
 *
 * Density smoothing is what makes a high-resolution grid readable rather than
 * merely finer. At 1024×1024 a 170 000-event sample averages 0.17 events per
 * cell, so the raw grid *is* a scatter plot — which is the honest picture and not
 * the useful one. A three-cell window spreads each event over nine cells and
 * turns it back into a density estimate, which is why FCS Express ships 1024 and
 * a smoothing of 3 together rather than either alone.
 *
 * **Separable, and a running sum within each pass.** Both matter at the default
 * resolution. Separable makes the cost 2·w rather than w² per cell; a running sum
 * makes it independent of w altogether — two adds, two fractional end taps and a
 * divide per cell, whatever the window — which is what keeps a *resize* drag
 * smooth, since a resize re-renders the whole grid on every delivered pointer
 * move. The naive form of this measured 19.7 ms of a 34 ms draw at 1024×1024,
 * more than the binning and the colouring put together.
 *
 * The core and the tap weight come from `smoothKernel`, which solves them from
 * the blur the control promises rather than reading them off the window directly.
 * Nothing in this function changed for Item 8 except where those two numbers come
 * from — which is the point: the arithmetic here was never wrong, it was being
 * handed a radius that did not scale with the value on the stepper.
 *
 * Normalised by the weight actually read, so the edges are averages of what is
 * there rather than being darkened by the window hanging off the grid. That keeps
 * a population sitting against an axis the same brightness as one in the middle,
 * which matters because gating pushes populations against axes.
 */
export function smooth2d(
  bins: ArrayLike<number>,
  width: number,
  height: number,
  window: number,
): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  // The integer core the running sum covers, and the weight of the one cell
  // beyond it on each side.
  const { half, tap: frac } = smoothKernel(window);
  if (half === 0 && frac <= 0) {
    for (let i = 0; i < n; i++) out[i] = bins[i];
    return out;
  }

  const row = new Float32Array(n);

  // Horizontal pass. `sum` is a JS number, so the accumulator is float64 even
  // though the arrays are float32 — over a thousand add/subtract pairs per row
  // that is the difference between rounding noise and visible banding.
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    const seed = Math.min(half, width - 1);
    for (let k = 0; k <= seed; k++) sum += bins[base + k];
    for (let x = 0; x < width; x++) {
      const from = x - half < 0 ? 0 : x - half;
      const to = x + half > width - 1 ? width - 1 : x + half;
      let acc = sum;
      let weight = to - from + 1;
      if (frac > 0) {
        const lo = x - half - 1;
        const hi = x + half + 1;
        if (lo >= 0) { acc += frac * bins[base + lo]; weight += frac; }
        if (hi < width) { acc += frac * bins[base + hi]; weight += frac; }
      }
      row[base + x] = acc / weight;
      const add = x + half + 1;
      if (add < width) sum += bins[base + add];
      const drop = x - half;
      if (drop >= 0) sum -= bins[base + drop];
    }
  }

  // Vertical pass. **Row-major, with one running sum per column held at once**,
  // rather than the obvious loop over columns. Walking a column means every access
  // is `width` floats from the last — 4 KB apart at 1024 wide, so every single read
  // is a cache miss and the pass costs several times what its arithmetic should.
  // Sweeping rows in order touches everything sequentially and the column sums live
  // in a 4 KB array that stays resident. The two fractional taps are whole rows,
  // read in the same sequential way.
  const colSum = new Float64Array(width);
  const seedRows = Math.min(half, height - 1);
  for (let k = 0; k <= seedRows; k++) {
    const base = k * width;
    for (let x = 0; x < width; x++) colSum[x] += row[base + x];
  }
  for (let y = 0; y < height; y++) {
    const from = y - half < 0 ? 0 : y - half;
    const to = y + half > height - 1 ? height - 1 : y + half;
    const obase = y * width;
    const lo = y - half - 1;
    const hi = y + half + 1;
    const loBase = lo >= 0 ? lo * width : -1;
    const hiBase = hi < height ? hi * width : -1;
    let weight = to - from + 1;
    if (frac > 0) {
      if (loBase >= 0) weight += frac;
      if (hiBase >= 0) weight += frac;
    }
    const inv = 1 / weight;
    if (frac > 0 && (loBase >= 0 || hiBase >= 0)) {
      for (let x = 0; x < width; x++) {
        let acc = colSum[x];
        if (loBase >= 0) acc += frac * row[loBase + x];
        if (hiBase >= 0) acc += frac * row[hiBase + x];
        out[obase + x] = acc * inv;
      }
    } else {
      for (let x = 0; x < width; x++) out[obase + x] = colSum[x] * inv;
    }
    const add = y + half + 1;
    if (add < height) {
      const base = add * width;
      for (let x = 0; x < width; x++) colSum[x] += row[base + x];
    }
    const drop = y - half;
    if (drop >= 0) {
      const base = drop * width;
      for (let x = 0; x < width; x++) colSum[x] -= row[base + x];
    }
  }
  return out;
}
