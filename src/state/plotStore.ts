import { create } from 'zustand';
import type { TransformKind, TransformSpec } from '@/core/transform';
import type { ColorScaling, ColorStyle } from '@/render/colorLevels';
import type { FcsMetadata } from '@/core/fcs/types';
import type { PanelDraft } from '@/core/layout/openPanel';
import type { LayoutKind } from '@/core/layout/layoutKind';
import { PANEL_VIEW_DEFAULTS } from '@/core/layout/panelDefaults';
import {
  PANEL_DEFAULT_WIDTH, clampWidth, contentOffset, nextFreePosition, panelRect,
  positionsForGrid, snapTo,
} from '@/core/layout/geometry';
import { defaultPanelWidth, notePanelWidth } from '@/core/layout/panelSize';
import { record } from './historyBus';
import { transformFor } from './transformPrefs';
import { onWorkspaceCleared } from './workspaceCleared';
import { onParameterShift, shiftIndex } from './parameterShift';

/**
 * The data range a plot is drawing, in display units.
 *
 * No longer part of a panel's state — it is computed from the data every render
 * and passed down to the renderers. See the note on `PlotType` below.
 */
export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/**
 * There is no view tool, and no `Viewport`.
 *
 * Panning went first — a plot whose visible range depends on where somebody
 * happened to leave a drag cannot be compared with the one beside it. Zoom has
 * now followed it, and the reason is the same one taken to its conclusion: the
 * axes of a cytometry plot *are* the measurement. Two panels showing FSC-A ×
 * SSC-A are only comparable if they are showing the *same* FSC-A × SSC-A, and a
 * per-panel view transform is precisely the thing that makes them not be.
 *
 * So a plot always shows the full range of the data it is plotting, and the
 * panel model has one fewer concept in it: there is no view transform sitting on
 * top of the axis configuration, because nothing can change one. What a panel
 * shows is decided entirely by its parameters, its transforms and its
 * population.
 *
 * Moving and resizing a **plot** are unaffected — those are gestures on the
 * worksheet, not on the data. See `PanelConfig.x`/`y`/`w`.
 */
/**
 * `'spectrum'` is not a fourth way of drawing events, and that is why it is not
 * in the plot-type control.
 *
 * The other three plot the panel's two parameters and differ only in how the
 * events are marked, which is what makes them interchangeable from a toolbar. A
 * spectrum plots one *population* across every detector at once — it has no y
 * parameter, no transform pair and nothing to gate on — so offering it beside
 * *Density* would put a control in the toolbar that silently discards the axes
 * next to it. It is created by the unmixing wizard, which is the only thing that
 * knows a panel should be one, and `PlotGrid` renders it through a component of
 * its own rather than through `PlotCanvas`.
 */
export type PlotType = 'scatter' | 'density' | 'contour' | 'histogram' | 'spectrum';
export type DensityScale = 'linear' | 'log' | 'sqrt' | 'rank';
/**
 * The density ramps.
 *
 * Was `'viridis' | 'abyss' | 'ember' | 'glacier'`, then `'flame' | 'rainbow' |
 * 'viridis'`, then `'rainbow' | 'viridis'` with rainbow the default — see
 * `render/ramps.ts` for that argument and why flame's second removal is the one
 * that sticks — and as of 2026-10-22 **viridis the default, cividis beside it,
 * rainbow kept**: a figure is read in greyscale and by colour-blind readers,
 * and both reference ramps rise monotonically in lightness where rainbow does
 * not. A workspace saved with a name that is no
 * longer in this union restores as the default, which `makePanel` does for it:
 * the name does not exist, and falling back is the only answer that draws a
 * plot.
 */
export type RampName = 'rainbow' | 'viridis' | 'cividis';

/** User overrides on top of the data-derived defaults from `autoSpec()`. */
export type TransformOverrides = Partial<Pick<TransformSpec, 'decades' | 'width' | 'negativeDecades' | 'cofactor'>>;

/**
 * One plot in the layout.
 *
 * Every view setting lives here rather than on the store root, so a worksheet
 * of plots can show different samples, parameter pairs and plot types at once —
 * which is the point of a multi-panel layout. Anything genuinely global (whether
 * box-zoom is armed) stays on the store.
 */
export interface PanelConfig {
  id: string;
  /**
   * Which sample this panel shows. `null` means "follow the sidebar selection",
   * which is what a single-panel workspace wants; pinning a sample is what makes
   * a side-by-side comparison hold still.
   */
  sampleId: string | null;
  /**
   * Population this panel is scoped to; `null` is the root, all events.
   *
   * Two things follow from it, and they are the whole point of dragging a gate
   * onto the worksheet: the plot shows only that population's events, and a gate
   * drawn here becomes its **child** rather than a child of whatever happens to
   * be selected in the tree. That is how a hierarchy gets built by dragging
   * instead of by re-picking a parent from a dropdown at every level.
   */
  populationId: string | null;
  /**
   * Where this panel sits on the worksheet, in CSS pixels from its top-left.
   *
   * Explicit coordinates rather than a grid cell, so a panel can be dragged
   * anywhere by its header and stays where it is put. The canvas grows to
   * contain whatever these describe — see `core/layout/geometry.ts`.
   */
  x: number;
  y: number;
  /** Panel width. Height follows from it: the plot area is square. */
  w: number;
  xParam: number;
  yParam: number;
  /**
   * Explicit axis limits; `null` on a bound means "auto — the data's own".
   *
   * The one thing that survives the removal of the view transform, and it is
   * not a view transform: it is a stated number, saved with the panel and
   * legible beside the parameter it applies to, so a second panel can be given
   * the identical range and the two stay comparable. That is precisely what a
   * pan or a zoom gesture could not offer. See `panels/axisRange.ts`.
   */
  xMin: number | null;
  xMax: number | null;
  yMin: number | null;
  yMax: number | null;
  xTransform: TransformKind;
  yTransform: TransformKind;
  xOverrides: TransformOverrides;
  yOverrides: TransformOverrides;
  plotType: PlotType;
  densityScale: DensityScale;
  ramp: RampName;
  /** Bins per axis for density; also the histogram bin count. */
  binCount: number;
  /**
   * Smoothing window, in bins — a moving average for a histogram, a separable
   * box blur for a density map.
   *
   * One field for both, because a panel is one plot type at a time and
   * "smoothing" means the same thing in both: how many neighbouring bins are
   * averaged together. Density plots did not smooth at all before this pass; at
   * the new 1024×1024 default they have to.
   */
  smoothing: number;
  /**
   * Smooth with a bandwidth in data units rather than the stated window.
   *
   * The default. `smoothing` is stated in **cells**, which is a different width
   * at every resolution; Auto states it as a share of the axis that narrows as
   * the sixth root of the plot's event count (`autoSmoothing`) — continuous and
   * unrounded, which is what keeps two replicates the same colours.
   *
   * `smoothing` is kept and is what the stepper writes, so switching Auto off
   * lands on the last manual value rather than on a surprise. See
   * `autoSmoothing` for the rule and its calibration.
   */
  smoothingAuto: boolean;
  /**
   * Where each gate's on-plot label sits, relative to its default position.
   *
   * Per gate **and per panel**, in pixels, keyed by gate id. A label is pinned
   * above its shape, and above its shape is routinely where the data is — the
   * same population plotted on two axis pairs collides with something different
   * in each, so the nudge that fixes one is wrong for the other. Absent on any
   * panel nobody has moved a label on, which is nearly all of them.
   */
  labelOffsets?: Record<string, { dx: number; dy: number }>;
  /* ---- Colour levels: how a bin's count becomes a colour. ---- */
  /** `percentile` maps the ramp onto the event distribution; `linear` does not. */
  colorStyle: ColorStyle;
  /** How colour intensity itself maps within the ramp, after the style. */
  colorScaling: ColorScaling;
  /**
   * How many bin cells wide an *outlier* cell is drawn — one holding the least
   * signal any occupied cell holds, i.e. one isolated event.
   *
   * **A size, and only a size.** The outlier settings removed on 2026-08-01 were
   * a display *mode* and a *colour*, and behind them sat a flat band that painted
   * those cells one colour outside the level table — which on a sparse plot at
   * 1024×1024 was 41% of the occupied cells and the reason Colour scaling looked
   * inert. That band is not coming back. This field enlarges the cell and changes
   * nothing about how it is coloured, so every occupied cell still goes through
   * one mapping. 1 means an outlier is drawn like any other cell.
   */
  outlierSize: number;
  /** Sample ids overlaid on the histogram alongside this panel's own. */
  overlayIds: string[];
  pointSize: number;
  /**
   * Dot-plot opacity. `null` means "derive from event count".
   *
   * The default is a stated 0.5 now, so `null` only reaches here from a workspace
   * saved before that — the derived path stays for exactly that reason.
   */
  alpha: number | null;
  showGrid: boolean;
  /** Set once per sample so defaults are not re-applied over user choices. */
  initialisedFor: string | null;
}

let panelSeq = 0;
export function nextPanelId(): string {
  return `p${Date.now().toString(36)}${(panelSeq++).toString(36)}`;
}

/**
 * Colour-level settings only, for *Restore to default*.
 *
 * Seven. `autoLevels`/`levelMax` went because turning the first off silently
 * disabled Style, and they are not coming back — levels are always this plot's
 * own. 0.37.0's *Levels from* scope (`colorScope`, `colorCeiling`) went in
 * 0.37.1, and `sanitisePanel` drops both from a panel that still carries them.
 * The overlay colour went because it drove a white slab over the selected gate's
 * interior. Of the three outlier fields, the *mode* and the *colour* went with
 * the flat band they configured and stay gone; **`outlierSize` is back**, as a
 * size applied to cells that are still coloured by the level table.
 */
export const COLOR_LEVEL_KEYS = [
  'ramp', 'colorStyle', 'colorScaling', 'binCount', 'smoothing', 'smoothingAuto', 'outlierSize',
] as const;

export type ColorLevelSettings = Pick<PanelConfig, typeof COLOR_LEVEL_KEYS[number]>;

/** Re-exported so a consumer of `LayoutDef` needs one import, not two. */
export type { LayoutKind };

export function makePanel(overrides: Partial<PanelConfig> = {}): PanelConfig {
  return sanitisePanel({
    id: nextPanelId(),
    sampleId: null,
    populationId: null,
    // -1 marks "not placed yet", which is distinct from "placed at the origin".
    // `placePanels` resolves it against the layout as it stands, and a workspace
    // saved before panels had coordinates restores through the same path.
    x: -1,
    y: -1,
    // Not the constant: the width the user last resized a panel to, for the rest
    // of the session. Every creation path lands here — `addPanel`, `openPanel`
    // and both drop routes all go through `makePanel` — so there is one answer to
    // "how big does a new plot open" rather than four. See `panelSize.ts`.
    // An explicit `w` in `overrides` still wins, which is what makes a workspace
    // load and a sibling window's snapshot restore their own saved widths.
    w: defaultPanelWidth(),
    xParam: 0,
    yParam: 0,
    xMin: null,
    xMax: null,
    yMin: null,
    yMax: null,
    xTransform: 'linear',
    yTransform: 'linear',
    xOverrides: {},
    yOverrides: {},
    // Plot type, density scaling, resolution, smoothing and the whole colour-level
    // block all come from one shared constant, because a new plot has to look the
    // same however it was asked for — see `panelDefaults.ts` for why these values.
    // It is also the workspace-level default the settings panel restores to.
    ...PANEL_VIEW_DEFAULTS,
    overlayIds: [],
    showGrid: true,
    initialisedFor: null,
    ...defined(overrides),
  });
}

/**
 * The overrides, minus any key whose value is `undefined`.
 *
 * Object spread does **not** skip an explicit `undefined` — `{ a: 1, ...{ a: undefined } }`
 * is `{ a: undefined }` — so a panel arriving from an older workspace, which carries
 * every key the build that wrote it knew about and none of the ones it did not,
 * overwrote the default with nothing. That is how `colorStyle` reached the renderer
 * as `undefined` and produced a ramp position of `NaN`. `sanitisePanel` cannot fix
 * it afterwards without listing every field twice.
 *
 * A restored panel is JSON, so the keys it carries are exactly the ones with values
 * — but `restoreWorkspace` and the sibling-window merge both build patches by
 * spreading, and that is where an explicit `undefined` gets introduced.
 */
function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as Array<keyof T>) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

/**
 * Bring a restored panel's values back into range.
 *
 * `makePanel` is the single normalising gate for every panel that arrives from
 * outside this build — a workspace file, a sibling window's snapshot — and this is
 * the part of it that has to *reject* a value rather than merely default a missing
 * one. Abyss, Ember and Glacier were valid ramp names once. `RAMPS['abyss']` is
 * `undefined`, which reaches the render loop as a ramp with no entries. Falling
 * back to the default is the only answer that draws a plot; the alternative is a
 * panel that silently renders nothing, which is exactly the class of failure this
 * project keeps recording.
 *
 * `'flame'` is back on that list as of 2026-08-03, permanently. It came off it
 * for one release, which is why a workspace saved on 2026-08-02 names it and
 * reopens on the default — a silent change to a stated choice, recorded under
 * *Known issues* rather than hidden.
 */
function sanitisePanel(input: PanelConfig): PanelConfig {
  // Written by 0.37.0 only; nothing reads them.
  const { colorScope: _scope, colorCeiling: _ceiling, ...p } = input as PanelConfig & { colorScope?: unknown; colorCeiling?: unknown };
  const ramp = RAMP_NAMES.includes(p.ramp) ? p.ramp : PANEL_VIEW_DEFAULTS.ramp;
  return {
    ...p,
    ramp,
    binCount: clampInt(p.binCount, 16, 1024, PANEL_VIEW_DEFAULTS.binCount),
    smoothing: clampInt(p.smoothing, 1, 21, PANEL_VIEW_DEFAULTS.smoothing),
    // A workspace saved before 2026-08-03 has no such field, and `??` rather than
    // a spread default because an explicit `false` in a saved panel has to
    // survive — see the object-spread trap in PROGRESS.md.
    smoothingAuto: typeof p.smoothingAuto === 'boolean' ? p.smoothingAuto : PANEL_VIEW_DEFAULTS.smoothingAuto,
    outlierSize: clampInt(p.outlierSize, 1, 8, PANEL_VIEW_DEFAULTS.outlierSize),
  };
}

export const RAMP_NAMES: RampName[] = ['viridis', 'cividis', 'rainbow'];

function clampInt(v: number, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * A named worksheet: one arrangement of plots.
 *
 * A workspace holds several; a window views exactly one. That split is what
 * lets two windows show a gating layout and a statistics layout side by side
 * while both remain views onto the same analysis — the gates, samples and
 * statistics underneath are shared, only the arrangement of plots differs.
 */
export interface LayoutDef {
  id: string;
  name: string;
  panels: PanelConfig[];
  activePanelId: string;
  /**
   * What made this worksheet, and therefore what it is for.
   *
   * `'reference'` is a worksheet the unmixing wizard built for one control:
   * three generated plots, a name it chose, a position in a walk with a defined
   * order and a defined finish, and a `ControlAssignment` holding its id.
   * Anything else — the boot layout, and every worksheet somebody made with
   * *New layout* — is `undefined`, meaning a general one.
   *
   * **This field exists because the application could not previously tell them
   * apart, and that was a bug rather than an untidiness.** The two are created
   * through the same `addLayout` and land in the same `otherLayouts` record, so
   * the layout dropdown was rendering thirteen unmixing worksheets and one
   * general layout as one undifferentiated list ordered by the wizard's walk,
   * and the only thing distinguishing "Main" from "CD4 RB744" was that somebody
   * happened to recognise a fluorophore name. Stated on the layout rather than
   * inferred by asking the spectral store whether any control claims this id:
   * an inference is a second source of truth that is right until the controls
   * are cleared, at which point thirteen worksheets silently become general
   * ones.
   *
   * Optional so that every layout in every existing workspace — all of which
   * predate the field — reads as general, which is what they are.
   *
   * *Widened 2026-08-14:* `'biophysics'` joined it, for the worksheet the
   * Biophysics pipeline generates per sample. The reason is the one this field
   * was introduced under, word for word — a generated worksheet is walked in
   * order, named by the thing that made it and owned by a guided panel, and
   * listing it beside somebody's own layouts makes fourteen worksheets out of
   * two. What it must **not** become is a general-purpose tag: the value is read
   * by `gateVisibility`, by the two layout strips and by the orphan sweep in
   * `buildGatingLayouts`, and each of those is asking *which panel owns this*.
   */
  kind?: LayoutKind;
  /**
   * Legacy column count, read only when migrating.
   *
   * Panels carry coordinates now. A workspace saved before they did has only
   * insertion order and this number, which together are exactly enough to
   * reproduce the arrangement it was saved in — so a migrated layout opens
   * looking like itself rather than being re-flowed.
   */
  columns?: number;
}

/**
 * Give coordinates to any panel that has none.
 *
 * Runs on every path that can introduce a panel: a new plot, a drop, a workspace
 * load, a sibling window's snapshot. Panels that already have coordinates are
 * returned untouched, so this is idempotent and a placed layout never shifts
 * under a re-entry.
 */
export function placePanels(panels: PanelConfig[], legacyColumns?: number): PanelConfig[] {
  if (panels.every((p) => p.x >= 0 && p.y >= 0)) return panels;

  // A layout where *nothing* is placed came from before coordinates existed;
  // its old column count reproduces the arrangement exactly.
  const migrating = panels.every((p) => p.x < 0 || p.y < 0);
  if (migrating && panels.length > 0) {
    const width = clampWidth(panels[0]!.w || PANEL_DEFAULT_WIDTH);
    const spots = positionsForGrid(panels.length, legacyColumns ?? 1, width);
    return panels.map((p, i) => ({ ...p, w: width, ...spots[i]! }));
  }

  // Mixed: some placed, some not. Each unplaced panel takes the first free spot
  // against everything already down, including the ones placed just above it.
  const taken = panels.filter((p) => p.x >= 0 && p.y >= 0).map((p) => panelRect(p.x, p.y, p.w));
  return panels.map((p) => {
    if (p.x >= 0 && p.y >= 0) return p;
    const w = clampWidth(p.w || PANEL_DEFAULT_WIDTH);
    const spot = nextFreePosition(taken, w, lastViewportWidth);
    taken.push(panelRect(spot.x, spot.y, w));
    return { ...p, w, ...spot };
  });
}

/**
 * Width of the visible worksheet, as last measured.
 *
 * Automatic placement wraps at the edge of what the user can see, and only
 * `PlotGrid` knows how wide that is. A module-level value rather than store
 * state because it is a measurement of the window, not part of the analysis: it
 * must not be saved, synced, or land in the undo stack.
 */
let lastViewportWidth = 1200;

export function noteViewportWidth(px: number): void {
  if (px > 0) lastViewportWidth = px;
}

let layoutSeq = 0;
export function nextLayoutId(): string {
  return `L${Date.now().toString(36)}${(layoutSeq++).toString(36)}`;
}

export const DEFAULT_LAYOUT_ID = 'L_main';

interface PlotState {
  panels: PanelConfig[];
  activePanelId: string;
  /**
   * The panel the user has *selected*, as against the one that merely has
   * focus.
   *
   * `activePanelId` is always set — something has to receive a keystroke — so it
   * cannot answer "is a panel selected right now?", and Escape-deletes-the-
   * active-panel would mean Escape always deletes something. Selection is
   * explicit: click a panel's chrome to select it, click empty worksheet space
   * to clear it. Transient, so it is in neither the workspace file nor the
   * cross-window snapshot nor the undo stack.
   */
  selectedPanelId: string | null;

  /**
   * Every selected panel, including the primary one (2026-08-12, Item 4).
   *
   * Empty when nothing is selected. **`selectedPanelId` keeps both of its
   * existing jobs unchanged** and this is deliberately a second field rather
   * than a replacement, because those jobs are not the same as this one: it is
   * the primary of the selection *and* it is the anchor a gate selection
   * records so Escape knows which of several mounted canvases should act. A
   * gate selected from the sidebar tree sets that anchor with **no** panel
   * selected at all, and folding the two together would make such a gate light
   * up a plot as selected and put it in front of a multi-delete.
   *
   * So: `selectedPanelIds` is what renders as selected and what a delete or a
   * group move acts on; `selectedPanelId` is which one of them keystrokes are
   * routed through. `selection.ts` is where the two are written together, and
   * is the only place that should write either.
   *
   * Transient like its primary — in neither the workspace file, nor the
   * cross-window snapshot, nor the undo stack.
   */
  selectedPanelIds: string[];

  /**
   * The layout this window is currently showing.
   *
   * `panels` and `activePanelId` above *are* that layout, live.
   * Other layouts sit serialised in `otherLayouts`. Keeping the active one in
   * the existing fields rather than behind an index means every consumer —
   * `PlotCanvas`, `PlotGrid`, the drag handlers — is unchanged, and there is
   * exactly one place any given layout's state lives at any moment, so the two
   * cannot drift.
   */
  activeLayoutId: string;
  activeLayoutName: string;
  /** What the active layout is for. See `LayoutDef.kind`. */
  activeLayoutKind?: LayoutKind;
  /** Every layout except the active one, by id. */
  otherLayouts: Record<string, LayoutDef>;

  /** All layouts including the active one, in a stable order. */
  allLayouts(): LayoutDef[];
  /**
   * Create a layout and switch this window to it. Returns its id.
   *
   * `kind` is set only by a guided panel building its own worksheets —
   * `buildGatingLayouts` in the unmixing wizard and `buildWorksheets` in the
   * Biophysics pipeline. Every other caller is a user pressing *New layout*.
   */
  addLayout(name?: string, kind?: LayoutKind): string;
  /** Switch this window's view. Stashes the current layout first. */
  switchLayout(id: string): void;
  /**
   * Give this window a brand-new, empty layout of its own, discarding whatever
   * placeholder it booted with.
   *
   * For a *layout window* — a second view onto a workspace it has not been
   * handed yet. Every window boots with the same `DEFAULT_LAYOUT_ID`, which is
   * exactly the wrong thing for one about to adopt a sibling: the ids collide,
   * the sibling's snapshot is read as an update to "this window's layout", and
   * the new window fills with a copy of the plots it was opened to get away
   * from. A distinct id makes the adoption say what it means — the samples and
   * the gating are shared, the arrangement is this window's own.
   */
  adoptOwnLayout(name?: string): void;
  renameLayout(id: string, name: string): void;
  /**
   * Say what an existing layout is for.
   *
   * Needed because `buildGatingLayouts` **reuses** a worksheet a control already
   * had rather than creating a fresh one, so a workspace saved before `kind`
   * existed comes back with thirteen reference worksheets that nothing has
   * marked. Idempotent, and not recorded on the undo stack: it states a fact
   * about a layout rather than changing one.
   */
  markLayoutKind(id: string, kind: LayoutKind): void;
  removeLayout(id: string): void;
  /** Replace the whole layout set, e.g. from a workspace or a sibling window. */
  setLayouts(layouts: LayoutDef[], activeId?: string): void;
  /**
   * Back to the worksheet the application boots with — one empty plot, no other
   * layouts, nothing selected.
   *
   * Called when the last sample is removed. See `state/workspaceCleared.ts` for
   * why that has to clear the worksheets and not merely leave them showing
   * nothing.
   *
   * The layout **id** is kept and the name and kind are not. Keeping the id is
   * what stops this from re-introducing the `DEFAULT_LAYOUT_ID` collision that
   * `adoptOwnLayout` exists to avoid: a second window took an id of its own at
   * boot, and a reset that reassigned `L_main` would hand it back its sibling's.
   * The name and kind go because the layout somebody is standing on when they
   * empty the workspace may be a *reference worksheet* — generated, named after
   * a control, and about to have no control — and a blank layout called
   * "CD3 FITC" is not a blank layout.
   */
  resetLayouts(): void;
  /**
   * Move one plot out of this worksheet and into another.
   *
   * The general-layout counterpart of the unmixing walk's worksheet strip: a
   * workspace holds several arrangements and, until now, a plot could only ever
   * be created in the worksheet you were standing in. Rebuilding it somewhere
   * else means re-choosing the sample, the population, both axes, both
   * transforms and the plot type — every one of which is already correct on the
   * panel in front of you.
   *
   * The panel keeps its identity and every setting. It is **unplaced** on the
   * way in (`x`/`y` of −1) so the receiving worksheet's `placePanels` gives it
   * the first free spot rather than dropping it exactly on top of whatever
   * already occupies those coordinates over there — the two layouts have no
   * reason to agree about what is free.
   */
  movePanelToLayout(panelId: string, layoutId: string): void;

  panel(id: string): PanelConfig | undefined;
  /** Undefined only when the layout is empty, which is a real state. */
  activePanel(): PanelConfig | undefined;

  addPanel(cloneFrom?: string): string;
  removePanel(id: string): void;
  /**
   * Remove several panels in one action, and one undo step.
   *
   * Not `ids.forEach(removePanel)`: that records an undo entry per panel, so
   * putting back a five-plot deletion would take five presses of Ctrl+Z with
   * four intermediate states nobody was ever in. It also runs `shiftToOrigin`
   * per removal, which can pull the survivors in and then in again.
   */
  removePanels(ids: readonly string[]): void;
  setActivePanel(id: string): void;
  /** Select exactly this panel, or nothing. Writes both selection fields. */
  setSelectedPanel(id: string | null): void;
  /**
   * Write the selection outright — every selected panel, and which is primary.
   *
   * The one setter for `selectedPanelIds`. Called from `selection.ts` and
   * nowhere else, so the rule relating the two selection fields lives in the
   * one module named after it.
   */
  setPanelSelection(ids: readonly string[], primary: string | null): void;
  /** Ctrl+click: add the panel to the selection, or take it back out. */
  togglePanelInSelection(id: string): void;
  setPanelSample(id: string, sampleId: string | null): void;
  updatePanel(id: string, patch: Partial<PanelConfig>): void;
  /**
   * Move a panel on the worksheet. Coalesced, so one drag is one undo step.
   * `snap` quantises the landing position; pass false while previewing a drag.
   */
  movePanel(id: string, x: number, y: number, snap?: boolean): void;
  /**
   * Move a whole selection: the panel under the pointer to `(x, y)`, and every
   * other panel in `others` by the same delta.
   *
   * The offsets are computed once when the drag begins and passed in, rather
   * than being re-derived here from the live positions each move. That is what
   * makes the group rigid: re-deriving them on every move would compound the
   * clamp at zero, so dragging a selection against the top-left corner would
   * squash it as the panels piled up against the origin one by one.
   *
   * Snapping applies to the grabbed panel only, and the rest follow by exact
   * delta — snapping each one independently would shear a tidy row apart the
   * first time it was nudged.
   */
  movePanelGroup(
    primaryId: string,
    x: number,
    y: number,
    snap: boolean,
    others: ReadonlyArray<{ id: string; dx: number; dy: number }>,
  ): void;
  /**
   * Resize a panel. Height follows width, because the plot area is square.
   *
   * `at` moves the panel's top-left in the same step, which is what a drag on
   * the top or left edge means: the opposite edge stays where the user is not
   * touching it. One action, so the move and the resize cannot be undone apart
   * from each other and leave the panel somewhere it never was.
   */
  resizePanel(id: string, w: number, at?: { x: number; y: number }): void;
  /**
   * Pull the layout back against the worksheet's origin.
   *
   * Called after a removal. See `contentOffset` for why growing alone is not
   * enough.
   */
  fitToContent(): void;

  /**
   * Create a panel from a drag or a menu. One code path, two entry points.
   * Returns the new panel's id.
   */
  openPanel(draft: PanelDraft): string;
  /**
   * Re-scope an existing panel — the on-plot population selector, or a gate
   * dropped onto it.
   *
   * These two are the *only* ways a panel's population changes. Clicking a node
   * in the sidebar gate tree used to retarget every unpinned panel as well,
   * which meant selecting a population in order to rename or delete it silently
   * changed what several plots were showing. Selection in the tree is now a
   * management action and nothing else.
   */
  setPanelPopulation(id: string, populationId: string | null): void;

  setAxis(panelId: string, axis: 'x' | 'y', paramIndex: number, transform?: TransformKind): void;
  /**
   * Pin one end of an axis to a stated value, or release it back to auto with
   * `null`. The other end is untouched — "everything below 10⁴" is a real
   * request and does not imply a lower bound.
   */
  setAxisLimit(panelId: string, axis: 'x' | 'y', bound: 'min' | 'max', value: number | null): void;
  /** Release both ends of one axis back to the data's own extent. */
  resetAxisLimits(panelId: string, axis: 'x' | 'y'): void;
  /**
   * Move one axis's stated range without changing its width.
   *
   * Both ends in one write, because a pan that set them separately would leave
   * the plot momentarily framed on a window of the wrong size and would put two
   * entries on the undo stack for one press. The caller computes the new pair —
   * it is the side that knows the transform, and a shift a reader would call
   * "half a screen" is half a screen of the *display* axis, not of the data.
   */
  panAxis(panelId: string, axis: 'x' | 'y', min: number, max: number): void;
  setTransform(panelId: string, axis: 'x' | 'y', kind: TransformKind): void;
  setOverride(panelId: string, axis: 'x' | 'y', key: keyof TransformOverrides, value: number | undefined): void;
  clearOverrides(panelId: string, axis: 'x' | 'y'): void;
  setPointSize(panelId: string, n: number): void;
  setAlpha(panelId: string, a: number | null): void;
  toggleGrid(panelId: string): void;
  setPlotType(panelId: string, t: PlotType): void;
  setDensityScale(panelId: string, s: DensityScale): void;
  setRamp(panelId: string, r: RampName): void;
  setBinCount(panelId: string, n: number): void;
  setSmoothing(panelId: string, n: number): void;
  /** Move one gate's on-plot label, in pixels from where it would otherwise sit. */
  setLabelOffset(panelId: string, gateId: string, dx: number, dy: number): void;
  /**
   * Change any colour-level setting on one panel.
   *
   * One action for eleven fields rather than eleven actions, because they are one
   * settings panel and every one of them is "adjust how this plot is coloured" as
   * far as the undo stack is concerned. Coalesced per field so a stepper held down
   * or a colour picker dragged is one undo step.
   */
  setColorLevels(panelId: string, patch: Partial<ColorLevelSettings>): void;
  /** Put this panel's colour levels back to the workspace defaults. */
  restoreColorLevels(panelId: string): void;
  toggleOverlay(panelId: string, sampleId: string): void;
  clearOverlays(panelId: string): void;
  initialiseFor(panelId: string, sampleId: string, metadata: FcsMetadata): void;

  /** Replace the whole layout, e.g. when restoring a workspace. */
  setPanels(panels: PanelConfig[], activeId?: string, legacyColumns?: number): void;
}

/**
 * Choose the opening parameter pair.
 *
 * FSC-A vs SSC-A is the universal first plot in flow cytometry — it separates
 * cells from debris and is the root of essentially every gating strategy — so it
 * is what the app should show the moment a file is selected.
 */
function pickDefaultAxes(md: FcsMetadata): { x: number; y: number } {
  const byName = (name: string) => md.parameters.findIndex((p) => p.name.toUpperCase() === name);
  const byType = (type: string) => md.parameters.findIndex((p) => p.type === type);

  const x = byName('FSC-A') >= 0 ? byName('FSC-A') : byType('Forward_Scatter');
  const y = byName('SSC-A') >= 0 ? byName('SSC-A') : byType('Side_Scatter');

  const dataChannels = md.parameters
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.isDataChannel)
    .map(({ i }) => i);

  return {
    x: x >= 0 ? x : (dataChannels[0] ?? 0),
    y: y >= 0 ? y : (dataChannels[1] ?? dataChannels[0] ?? 0),
  };
}

const FIRST = makePanel();

export const usePlot = create<PlotState>((set, get) => ({
  panels: placePanels([FIRST]),
  activePanelId: FIRST.id,
  selectedPanelId: null,
  selectedPanelIds: [],

  activeLayoutId: DEFAULT_LAYOUT_ID,
  activeLayoutName: 'Main',
  otherLayouts: {},

  allLayouts() {
    const s = get();
    const others = Object.values(s.otherLayouts);
    return [stashActive(s), ...others].sort((a, b) => a.id.localeCompare(b.id));
  },

  addLayout(name, kind) {
    record('Add layout');
    const s = get();
    const id = nextLayoutId();
    /*
       Numbered against the **general** layouts, not against everything open.

       A workspace with an unmixing panel in it holds thirteen reference
       worksheets, so counting all of them made *New layout* produce "Layout 15"
       beside a single "Main" — a number that is not the number of anything the
       user can see. A generated worksheet is named after the thing it was
       generated for and takes no part in this sequence, which is why the test is
       *has no kind* rather than *is not a reference worksheet*: the biophysics
       ones would otherwise re-create the same defect with a different word.
    */
    const general = [stashActive(s), ...Object.values(s.otherLayouts)]
      .filter((l) => l.kind === undefined).length;
    // Stash the current layout, then open a fresh empty worksheet — the same
    // blank drop target an emptied layout presents, because a new worksheet is
    // something you drag onto rather than something that guesses.
    set({
      otherLayouts: { ...s.otherLayouts, [s.activeLayoutId]: stashActive(s) },
      activeLayoutId: id,
      activeLayoutName: name ?? `Layout ${general + 1}`,
      activeLayoutKind: kind,
      panels: [],
      activePanelId: '',
    });
    return id;
  },

  adoptOwnLayout(name) {
    // Not `addLayout`: there is nothing here worth stashing. The layout being
    // replaced is the boot placeholder — one empty panel nobody asked for — and
    // keeping it would leave every layout window carrying a phantom "Main" that
    // shadows its sibling's real one.
    set({
      activeLayoutId: nextLayoutId(),
      activeLayoutName: name ?? 'Layout 2',
      activeLayoutKind: undefined,
      panels: [],
      activePanelId: '',
      otherLayouts: {},
      selectedPanelId: null,
      selectedPanelIds: [],
    });
  },

  switchLayout(id) {
    const s = get();
    if (id === s.activeLayoutId) return;
    const target = s.otherLayouts[id];
    if (!target) return;
    const others = { ...s.otherLayouts };
    delete others[id];
    others[s.activeLayoutId] = stashActive(s);
    set({
      otherLayouts: others,
      activeLayoutId: target.id,
      activeLayoutName: target.name,
      activeLayoutKind: target.kind,
      panels: placePanels(target.panels, target.columns),
      activePanelId: target.activePanelId,
      /*
         The selection does not follow the user to another worksheet.

         It never should have — a selection naming panels that are no longer
         mounted is a selection nothing on screen shows — but before Item 4 the
         worst of it was one stale id that the next click replaced. A stale
         *set* is worse: Escape acts on every member, so switching worksheets
         mid-selection and pressing it would delete plots on a layout the user
         was no longer looking at.
      */
      selectedPanelId: null,
      selectedPanelIds: [],
    });
  },

  renameLayout(id, name) {
    const clean = name.trim();
    if (!clean) return;
    record('Rename layout');
    const s = get();
    if (id === s.activeLayoutId) { set({ activeLayoutName: clean }); return; }
    const target = s.otherLayouts[id];
    if (!target) return;
    set({ otherLayouts: { ...s.otherLayouts, [id]: { ...target, name: clean } } });
  },

  markLayoutKind(id, kind) {
    const s = get();
    if (id === s.activeLayoutId) {
      if (s.activeLayoutKind !== kind) set({ activeLayoutKind: kind });
      return;
    }
    const target = s.otherLayouts[id];
    if (!target || target.kind === kind) return;
    set({ otherLayouts: { ...s.otherLayouts, [id]: { ...target, kind } } });
  },

  removeLayout(id) {
    const s = get();
    // Never remove the last one: a workspace with no layout has nowhere to draw.
    if (Object.keys(s.otherLayouts).length === 0) return;
    record('Remove layout');
    if (id !== s.activeLayoutId) {
      const others = { ...s.otherLayouts };
      delete others[id];
      set({ otherLayouts: others });
      return;
    }
    /*
       Removing the layout this window is showing: fall through to another one,
       and prefer a **general** one.

       `Object.entries(...)[0]` is insertion order, which with an unmixing panel
       open is whichever reference worksheet was stashed first — so closing a
       general layout landed the user inside the wizard's walk. A general
       worksheet is the right place to end up after closing a worksheet; falling
       back to a generated one only when there is nothing else left. Tested as
       *has no kind* rather than against one value, for the reason `addLayout`
       gives.
    */
    const entries = Object.entries(s.otherLayouts);
    const [nextId, next] = entries.find(([, l]) => l.kind === undefined) ?? entries[0]!;
    const others = { ...s.otherLayouts };
    delete others[nextId];
    set({
      otherLayouts: others,
      activeLayoutId: next.id,
      activeLayoutName: next.name,
      activeLayoutKind: next.kind,
      panels: placePanels(next.panels, next.columns),
      activePanelId: next.activePanelId,
    });
  },

  setLayouts(layouts, activeId) {
    if (layouts.length === 0) return;
    const chosen = layouts.find((l) => l.id === activeId) ?? layouts[0]!;
    const others: Record<string, LayoutDef> = {};
    for (const l of layouts) {
      if (l.id === chosen.id) continue;
      others[l.id] = { ...l, panels: l.panels.map((p) => makePanel(p)) };
    }
    const panels = placePanels(chosen.panels.map((p) => makePanel(p)), chosen.columns);
    set({
      otherLayouts: others,
      activeLayoutId: chosen.id,
      activeLayoutName: chosen.name,
      activeLayoutKind: chosen.kind,
      panels,
      activePanelId: panels.some((p) => p.id === chosen.activePanelId)
        ? chosen.activePanelId
        : (panels[0]?.id ?? ''),
    });
  },

  panel: (id) => get().panels.find((p) => p.id === id),
  activePanel: () => get().panels.find((p) => p.id === get().activePanelId) ?? get().panels[0],

  addPanel(cloneFrom) {
    const source = cloneFrom ? get().panels.find((p) => p.id === cloneFrom) : get().activePanel();
    // Two different requests share this action, and they differ in exactly one
    // way. *Duplicate* names a panel and means "another one of these", so it
    // copies everything. *Add plot* names nothing and means "a new plot": it
    // inherits the sample and axes — which parameters to look at is a
    // continuation of the current task — but opens with the standard view
    // settings rather than whatever the active panel happens to be set to.
    // A new panel is unplaced (`x`/`y` of -1) whatever it inherited, so
    // `placePanels` gives it the first free spot rather than landing it exactly
    // on top of the panel it was cloned from.
    // *Duplicate* keeps the source's width, because "another one of these" means
    // the same size too. *Add plot* takes the session's remembered width like
    // every other creation path, rather than the active panel's — which is the
    // same distinction the view settings already make, and the reason the
    // resolution lives in one function instead of four.
    const inherited = source ? { ...source, id: nextPanelId(), x: -1, y: -1 } : {};
    const panel = makePanel(
      cloneFrom ? inherited : { ...inherited, ...PANEL_VIEW_DEFAULTS, w: defaultPanelWidth() },
    );
    record(cloneFrom ? 'Duplicate plot' : 'Add plot');
    set((s) => ({
      panels: placePanels([...s.panels, panel]),
      activePanelId: panel.id,
    }));
    return panel.id;
  },

  removePanel(id) {
    record('Remove plot');
    set((s) => {
      // An empty layout is a legitimate state, not a failure: it is the blank
      // worksheet you drag samples and populations onto. `PlotGrid` renders a
      // drop zone for it rather than nothing.
      //
      // The survivors keep their arrangement — closing one plot must not
      // shuffle the others — but the whole arrangement is pulled back against
      // the origin if removing this panel left dead space in front of it.
      // Without that, deleting the plot that had extended the worksheet leaves
      // a band of empty grey that nothing can reclaim.
      const panels = shiftToOrigin(s.panels.filter((p) => p.id !== id));
      return {
        panels,
        activePanelId: s.activePanelId === id ? (panels[0]?.id ?? '') : s.activePanelId,
        // A selection pointing at a panel that no longer exists would let a
        // second Escape delete a panel the user never selected.
        selectedPanelId: s.selectedPanelId === id ? null : s.selectedPanelId,
        selectedPanelIds: s.selectedPanelIds.filter((x) => x !== id),
      };
    });
  },

  removePanels(ids) {
    const doomed = new Set(ids);
    if (doomed.size === 0) return;
    record(doomed.size === 1 ? 'Remove plot' : `Remove ${doomed.size} plots`);
    set((s) => {
      const panels = shiftToOrigin(s.panels.filter((p) => !doomed.has(p.id)));
      return {
        panels,
        activePanelId: doomed.has(s.activePanelId) ? (panels[0]?.id ?? '') : s.activePanelId,
        selectedPanelId: s.selectedPanelId && doomed.has(s.selectedPanelId) ? null : s.selectedPanelId,
        selectedPanelIds: s.selectedPanelIds.filter((x) => !doomed.has(x)),
      };
    });
  },

  openPanel(draft) {
    const panel = makePanel(draft);
    record('Open plot');
    // The canvas grows to hold it rather than the drop being refused or wrapped:
    // the user asked for a plot, and `placePanels` finds it somewhere free even
    // if that is past the right-hand edge of what is currently visible.
    set((s) => ({
      panels: placePanels([...s.panels, panel]),
      activePanelId: panel.id,
    }));
    return panel.id;
  },

  setPanelPopulation(id, populationId) {
    record('Change plot population');
    get().updatePanel(id, { populationId });
  },

  // Not recorded: which panel has focus is not an edit, and putting it on the
  // stack would make Ctrl+Z spend its first few presses moving a border around.
  setActivePanel(id) { set({ activePanelId: id }); },

  /*
     Selects exactly this panel, or nothing — both fields, together.

     It wrote `selectedPanelId` alone for about an hour on 2026-08-12, while
     Item 4 was being built, and that made it a trap: a setter called
     "set selected panel" that left the panel not looking selected and not in
     front of a delete, because both of those read the set. Nothing in the
     application called it by then, so nothing broke — the harness did, which is
     the point of the harness. An action keeps the meaning its name promises.

     `setPanelSelection` is the general form, and the gate anchor is the one
     caller that needs it: a primary with an empty set.
  */
  setSelectedPanel(id) { set({ selectedPanelId: id, selectedPanelIds: id ? [id] : [] }); },

  setPanelSelection(ids, primary) {
    set({ selectedPanelIds: [...ids], selectedPanelId: primary });
  },

  togglePanelInSelection(id) {
    set((s) => {
      /*
         `selectedPanelIds` outright, with **no fallback to the primary** — and
         that is where this differs from `toggleSampleInSelection`, which does
         fall back.

         The sample version needs it because `selectedSampleId` can be set with
         an empty `multiSelection`: a restored workspace has a primary and no
         batch. No such state exists here, since `setPanelSelection` is the only
         writer and always writes both fields together — with one exception, and
         it is precisely the one that must not be read: a gate selection parks
         its **anchor** in `selectedPanelId` while leaving the set empty. Adding
         the fallback promotes that anchor into the selection, so Ctrl+clicking
         one plot after selecting a gate would select two — the plot clicked and
         whichever one the gate happened to be clicked on.
      */
      const current = s.selectedPanelIds;
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      // Ctrl+clicking the primary out of the selection hands that role to
      // whatever is left, so keystrokes are never routed through a panel the
      // user has just deselected.
      const primary = s.selectedPanelId && next.includes(s.selectedPanelId)
        ? s.selectedPanelId
        : next[next.length - 1] ?? null;
      return { selectedPanelIds: next, selectedPanelId: primary };
    });
  },

  movePanel(id, x, y, snap = true) {
    // Coalesced per panel, so a drag across the worksheet is one Ctrl+Z rather
    // than one per pointer move.
    record('Move plot', `move:${id}`);
    get().updatePanel(id, {
      // Clamped at zero, never at a right or bottom edge: the worksheet has no
      // right or bottom edge — it grows to contain whatever is on it.
      x: Math.max(0, snap ? snapTo(x) : Math.round(x)),
      y: Math.max(0, snap ? snapTo(y) : Math.round(y)),
    });
  },

  movePanelGroup(primaryId, x, y, snap = true, others) {
    // Coalesced on the grabbed panel, so a drag of five plots is still one
    // Ctrl+Z — the key names the gesture, not the panels it happened to touch.
    record(others.length === 0 ? 'Move plot' : `Move ${others.length + 1} plots`, `move:${primaryId}`);
    const px = Math.max(0, snap ? snapTo(x) : Math.round(x));
    const py = Math.max(0, snap ? snapTo(y) : Math.round(y));
    const offset = new Map(others.map((o) => [o.id, o]));
    set((s) => ({
      panels: s.panels.map((p) => {
        if (p.id === primaryId) return p.x === px && p.y === py ? p : { ...p, x: px, y: py };
        const o = offset.get(p.id);
        if (!o) return p;
        // Clamped like the primary: the worksheet has no negative coordinates.
        // A panel that hits the edge stops there while the rest keep going, and
        // that is the honest behaviour — the alternative is refusing to move
        // the whole selection because one member is against the wall.
        const nx = Math.max(0, px + o.dx);
        const ny = Math.max(0, py + o.dy);
        return p.x === nx && p.y === ny ? p : { ...p, x: nx, y: ny };
      }),
    }));
  },

  resizePanel(id, w, at) {
    // Coalesced per panel, exactly like a move: a resize drag is dozens of
    // pointer moves and one action.
    record('Resize plot', `resize:${id}`);
    // The one place a user states a panel width, so the one place the session's
    // memory of it is written. Every panel created afterwards opens at this size.
    notePanelWidth(w);
    get().updatePanel(id, {
      w: clampWidth(w),
      ...(at ? { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) } : {}),
    });
  },

  fitToContent() {
    set((s) => {
      const panels = shiftToOrigin(s.panels);
      return panels === s.panels ? {} : { panels };
    });
  },

  setPanelSample(id, sampleId) {
    record('Change plot sample');
    // Pinning or unpinning is the one gesture that genuinely re-targets a panel,
    // so it is also the one that lets `initialiseFor` choose fresh axes. The
    // population scope survives it: gating is shared across samples, so the
    // population this panel shows exists on whichever sample it lands on.
    get().updatePanel(id, { sampleId, initialisedFor: null });
  },

  updatePanel(id, patch) {
    set((s) => ({ panels: s.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  },

  setAxis(panelId, axis, paramIndex, transform) {
    record('Change axis');
    // Changing an axis invalidates the overrides: a width basis tuned for one
    // channel is meaningless on another. The explicit range goes with them, and
    // for a stronger reason — a limit of [0, 250000] carried onto a fluorescence
    // channel does not merely look wrong, it frames a plot on a range the new
    // data does not occupy and draws an empty square.
    get().updatePanel(panelId, axis === 'x'
      ? { xParam: paramIndex, xOverrides: {}, xMin: null, xMax: null, ...(transform ? { xTransform: transform } : {}) }
      : { yParam: paramIndex, yOverrides: {}, yMin: null, yMax: null, ...(transform ? { yTransform: transform } : {}) });
  },

  setAxisLimit(panelId, axis, bound, value) {
    // Coalesced per field: these are typed into a number input, and each
    // keystroke is a store write. One undo step per field, not per digit.
    record('Change axis range', `range:${panelId}:${axis}:${bound}`);
    const clean = value === null || !Number.isFinite(value) ? null : value;
    const key = `${axis}${bound === 'min' ? 'Min' : 'Max'}` as 'xMin' | 'xMax' | 'yMin' | 'yMax';
    get().updatePanel(panelId, { [key]: clean } as Partial<PanelConfig>);
  },

  resetAxisLimits(panelId, axis) {
    record('Reset axis range');
    get().updatePanel(panelId, axis === 'x' ? { xMin: null, xMax: null } : { yMin: null, yMax: null });
  },

  panAxis(panelId, axis, min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return;
    // Coalesced per axis: panning is pressing a button several times to walk the
    // view across, and getting back to where you started should be one undo
    // rather than one per press.
    record('Pan axis', `pan:${panelId}:${axis}`);
    get().updatePanel(panelId, axis === 'x'
      ? { xMin: min, xMax: max }
      : { yMin: min, yMax: max });
  },

  setTransform(panelId, axis, kind) {
    record('Change transform');
    // Overrides are per-transform — a logicle `width` is decades, a
    // biexponential `width` is a data value — so they cannot carry over.
    get().updatePanel(panelId, axis === 'x'
      ? { xTransform: kind, xOverrides: {} }
      : { yTransform: kind, yOverrides: {} });
  },

  setOverride(panelId, axis, key, value) {
    const p = get().panel(panelId);
    if (!p) return;
    // Coalesced per control: these come from sliders, and a drag across one
    // would otherwise leave forty undo steps between the user and where they
    // started.
    record('Adjust transform', `override:${panelId}:${axis}:${key}`);
    const cur = axis === 'x' ? p.xOverrides : p.yOverrides;
    const next = { ...cur };
    if (value === undefined) delete next[key];
    else next[key] = value;
    get().updatePanel(panelId, axis === 'x' ? { xOverrides: next } : { yOverrides: next });
  },

  clearOverrides(panelId, axis) {
    record('Reset transform');
    get().updatePanel(panelId, axis === 'x' ? { xOverrides: {} } : { yOverrides: {} });
  },

  setPointSize(panelId, n) {
    record('Change point size', `pointsize:${panelId}`);
    get().updatePanel(panelId, { pointSize: Math.min(8, Math.max(0.5, n)) });
  },
  setAlpha(panelId, a) {
    record('Change opacity', `alpha:${panelId}`);
    get().updatePanel(panelId, { alpha: a });
  },
  toggleGrid(panelId) {
    const p = get().panel(panelId);
    record('Toggle gridlines');
    if (p) get().updatePanel(panelId, { showGrid: !p.showGrid });
  },
  setPlotType(panelId, t) {
    record('Change plot type');
    get().updatePanel(panelId, { plotType: t });
  },

  setDensityScale(panelId, s) {
    record('Change density scale');
    get().updatePanel(panelId, { densityScale: s });
  },
  setRamp(panelId, r) {
    record('Change colour ramp');
    get().updatePanel(panelId, { ramp: r });
  },
  setBinCount(panelId, n) {
    record('Change resolution', `bins:${panelId}`);
    get().updatePanel(panelId, { binCount: Math.min(1024, Math.max(16, Math.round(n))) });
  },
  setSmoothing(panelId, n) {
    record('Change smoothing', `smoothing:${panelId}`);
    get().updatePanel(panelId, { smoothing: Math.min(21, Math.max(1, Math.round(n))) });
  },

  setLabelOffset(panelId, gateId, dx, dy) {
    // Coalesced per gate, so dragging a label across the plot is one undo step
    // however many pointer moves it took — the same rule `updateGate` uses for
    // dragging the shape itself.
    record('Move gate label', `label:${panelId}:${gateId}`);
    const p = get().panel(panelId);
    if (!p) return;
    get().updatePanel(panelId, {
      labelOffsets: { ...p.labelOffsets, [gateId]: { dx, dy } },
    });
  },

  setColorLevels(panelId, patch) {
    const p = get().panel(panelId);
    if (!p) return;
    // Keyed by the field being changed, so adjusting the smoothing stepper and
    // then the outlier size leaves two undo steps rather than one merged one, and
    // holding either down leaves one rather than twelve.
    record('Change colour levels', `levels:${panelId}:${Object.keys(patch).join(',')}`);
    // Through `makePanel` so the clamps live in exactly one place: a stepper can
    // be typed into as well as clicked, and 0 bins or a smoothing of 400 both have
    // to be refused somewhere.
    get().updatePanel(panelId, sanitisePanel({ ...p, ...patch }));
  },

  restoreColorLevels(panelId) {
    record('Restore colour levels');
    const patch: Partial<PanelConfig> = {};
    for (const k of COLOR_LEVEL_KEYS) {
      (patch as Record<string, unknown>)[k] = PANEL_VIEW_DEFAULTS[k];
    }
    get().updatePanel(panelId, patch);
  },

  toggleOverlay(panelId, sampleId) {
    const p = get().panel(panelId);
    if (!p) return;
    record('Toggle overlay');
    get().updatePanel(panelId, {
      overlayIds: p.overlayIds.includes(sampleId)
        ? p.overlayIds.filter((x) => x !== sampleId)
        : [...p.overlayIds, sampleId],
    });
  },

  clearOverlays(panelId) { get().updatePanel(panelId, { overlayIds: [] }); },

  initialiseFor(panelId, sampleId, metadata) {
    const p = get().panel(panelId);
    // **Once per panel, not once per sample.** A panel that follows the sidebar
    // selection sees this called again every time the user switches sample, and
    // re-running it there throws away whatever axes the panel was opened on —
    // which is exactly what happened to a panel created by dragging a gate out.
    // It opens on channels the population's ancestry has not used, and switching
    // sample reset it to FSC/SSC. Choosing axes is a *first* decision.
    //
    // `setPanelSample` clears `initialisedFor` explicitly, so pinning or
    // unpinning still gets a fresh choice; that is the one gesture that means
    // "this panel is now about a different file".
    if (!p || p.initialisedFor !== null) return;
    const { x, y } = pickDefaultAxes(metadata);
    get().updatePanel(panelId, {
      initialisedFor: sampleId,
      xParam: x,
      yParam: y,
      // Through `transformFor`, so a transform the user chose for a channel
      // survives being put on a fresh panel's axis.
      xTransform: transformFor(metadata.parameters[x]),
      yTransform: transformFor(metadata.parameters[y]),
      xOverrides: {},
      yOverrides: {},
    });
  },

  movePanelToLayout(panelId, layoutId) {
    const s = get();
    const target = s.otherLayouts[layoutId];
    const panel = s.panels.find((p) => p.id === panelId);
    // Only into a layout this window is *not* showing. Moving a plot into the
    // worksheet it is already on is a no-op that would otherwise re-place it,
    // i.e. it would look like the plot jumping for no reason.
    if (!target || !panel) return;
    record('Move plot to another layout');
    const survivors = shiftToOrigin(s.panels.filter((p) => p.id !== panelId));
    set({
      panels: survivors,
      activePanelId: s.activePanelId === panelId ? (survivors[0]?.id ?? '') : s.activePanelId,
      selectedPanelId: s.selectedPanelId === panelId ? null : s.selectedPanelId,
      selectedPanelIds: s.selectedPanelIds.filter((x) => x !== panelId),
      otherLayouts: {
        ...s.otherLayouts,
        [layoutId]: {
          ...target,
          panels: placePanels([...target.panels, { ...panel, x: -1, y: -1 }]),
          // The arriving plot becomes that worksheet's active one, so switching
          // to it lands on the thing that was just sent there.
          activePanelId: panel.id,
        },
      },
    });
  },

  setPanels(panels, activeId, legacyColumns) {
    // Normalise through `makePanel` so a workspace saved before a field existed
    // restores with that field's default rather than `undefined`, then place
    // anything that arrived without coordinates.
    const safe = placePanels(
      (panels.length > 0 ? panels : [makePanel()]).map((p) => makePanel(p)),
      legacyColumns,
    );
    set({ panels: safe, activePanelId: activeId ?? safe[0]!.id });
  },

  resetLayouts() {
    const fresh = makePanel();
    set((s) => ({
      panels: placePanels([fresh]),
      activePanelId: fresh.id,
      selectedPanelId: null,
      selectedPanelIds: [],
      activeLayoutId: s.activeLayoutId,
      activeLayoutName: 'Main',
      activeLayoutKind: undefined,
      otherLayouts: {},
    }));
  },
}));

/*
   Every worksheet goes when every sample does.

   Registered here rather than being called from `workspaceStore`, so the store
   that owns layouts is the store that decides what clearing them means — and so
   the dependency runs one way. See `state/workspaceCleared.ts`.
*/
onWorkspaceCleared(() => usePlot.getState().resetLayouts());

/*
   A derived parameter was added or removed — every panel on every worksheet
   keeps plotting the parameter it was plotting. See `state/parameterShift.ts`.

   A panel on the removed parameter itself has nothing left to plot. It is handed
   back to `initialiseFor` (`initialisedFor: null`), which picks its sample's
   default axes the next time it is on screen — the same first decision a new
   panel gets — rather than being left on whichever parameter slid into the gap.
*/
onParameterShift((shift) => {
  const move = (p: PanelConfig): PanelConfig => {
    const x = shiftIndex(p.xParam, shift);
    // A histogram has no y parameter, so its stored one is not a reason to reset it.
    const y = shiftIndex(p.yParam, shift) ?? (p.plotType === 'histogram' ? 0 : null);
    if (x === null || y === null) return { ...p, xParam: 0, yParam: 0, initialisedFor: null };
    return x === p.xParam && y === p.yParam ? p : { ...p, xParam: x, yParam: y };
  };
  const s = usePlot.getState();
  usePlot.setState({
    panels: s.panels.map(move),
    otherLayouts: Object.fromEntries(Object.entries(s.otherLayouts).map(([id, l]) => [
      id, { ...l, panels: l.panels.map(move) },
    ])),
  });
});

/** Which panels, on any worksheet, plot a parameter index on either axis. */
export function panelsUsingParameter(index: number): PanelConfig[] {
  return usePlot.getState().allLayouts()
    .flatMap((l) => l.panels)
    .filter((p) => p.xParam === index || p.yParam === index);
}

/**
 * The active layout as a `LayoutDef`, ready to be stashed or listed.
 *
 * One function rather than the four inline object literals it replaces, because
 * those four had to agree about which fields a layout carries and, on the day
 * `kind` was added, three of them would have silently dropped it — a reference
 * worksheet would have become a general one simply by being switched away from.
 * Every path that turns "the layout this window is showing" back into a record
 * goes through here.
 */
function stashActive(s: Pick<PlotState, 'activeLayoutId' | 'activeLayoutName' | 'activeLayoutKind' | 'panels' | 'activePanelId'>): LayoutDef {
  return {
    id: s.activeLayoutId,
    name: s.activeLayoutName,
    panels: s.panels,
    activePanelId: s.activePanelId,
    ...(s.activeLayoutKind ? { kind: s.activeLayoutKind } : {}),
  };
}

/**
 * Translate every panel so the arrangement sits against the worksheet origin.
 *
 * Returns the same array when nothing needs moving, so a caller can compare by
 * identity and skip a state write.
 */
function shiftToOrigin(panels: PanelConfig[]): PanelConfig[] {
  const { dx, dy } = contentOffset(panels.map((p) => panelRect(p.x, p.y, p.w)));
  if (dx === 0 && dy === 0) return panels;
  return panels.map((p) => ({ ...p, x: p.x - dx, y: p.y - dy }));
}
