import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { applyTheme, useUI } from './state/uiStore';
import { useWorkspace } from './state/workspaceStore';
import { usePlot } from './state/plotStore';
import { currentSimilarity, gatedEventsFor, useSpectral } from './state/spectralStore';
import { useUmap } from './state/umapStore';
import { useGates, evaluateFor, defaultSpecFor, resolveGates } from './state/gateStore';
import { isReferenceGate, pruneReferenceGates, withoutReferenceGates } from '@/core/gating/referenceGates';
import { restoreWorkspace, saveWorkspaceToFile, captureWorkspace, openWorkspaceFile, openWorkspaceAt } from './state/workspaceIO';
import {
  applyUnmixingMatrix, captureUnmixingMatrix, loadUnmixingMatrixByPath,
  loadUnmixingMatrixFromFile, recentMatrices, saveUnmixingMatrixToFile,
} from './state/unmixingIO';
import { parseUnmixingMatrix, serialiseUnmixingMatrix, checkDetectorCompatibility } from './core/unmixingFile';
import { snapshot, applySnapshot, currentWindowId } from './state/windowSync';
import './styles/global.css';
import { useHistory } from '@/state/historyStore';
import { viewLockReason } from '@/state/viewLock';
import { useDirty } from '@/state/dirtyStore';
import { axisDomainFor, useDerived, sampleColumn, parametersFor } from '@/state/derivedStore';
import { unmixedColumn, unmixedCount, unmixedFor } from '@/core/unmixedColumns';
import { validateDefinition } from '@/core/derived';
import { useTransformPrefs, transformFor } from '@/state/transformPrefs';
import { useStatisticsPrefs } from '@/state/statisticsPrefs';
import { categoryColors, conditionColor } from './panels/groupColors';
import { useFigure } from './state/figureStore';
import { useZoom } from '@/state/zoomStore';
import { autoSpec, createTransform, transformColumn } from '@/core/transform';
import { openPanelsForSamples, openPanelForPopulation } from '@/state/layoutActions';
import { PANEL_COMPACT_BELOW, PANEL_DEFAULT_WIDTH, PANEL_GAP } from '@/core/layout/geometry';
import { defaultPanelWidth, notePanelWidth, resetPanelWidthMemory } from '@/core/layout/panelSize';
import { useAxisRanges } from '@/state/axisRangeStore';
import { applyAxisLimits, isAxisLimited } from '@/panels/axisRange';
import { groupOf, groupParameters } from '@/core/paramGroups';
import { clampCaret, insertToken, tokenForName, OPERATOR_BUTTONS } from '@/core/equationInsert';
import { DENSITY_RESOLUTION, PANEL_VIEW_DEFAULTS } from '@/core/layout/panelDefaults';
import {
  PARAMETER_PRESETS, describePresetChannels, presetNamed, ratioExpression,
} from '@/core/parameterPresets';
import {
  DETECTOR_BANDS, LASER_LINES, describeDetector, describeDetectorFull, detectorBand,
} from '@/core/detectors';
import { RAMPS, bin2d, densityLevels, outlierValue, paintDensity, renderDensity, smoothHistogram2d } from '@/render/binning';
import { autoSmoothing, buildLevelTable, logWarp, robustCeiling, smooth2d, smoothKernel, smoothSigma, summariseLevels } from '@/render/colorLevels';
import {
  allPaths, defaultColumns, eventsToCsv, nodeState, planFullExport, populationTree,
  subtreePaths, toggleSubtree,
} from '@/core/export';
import { fitPopulationId, liveBoundaryIndex, useBiophysics } from '@/state/biophysicsStore';
import {
  BIOPHYSICAL_PROPERTIES, maxComponentsFor, populationBoundaries, populationIntervals,
  populationNames, propertyById,
} from '@/core/biophysics/properties';
import { schemeFor } from '@/core/biophysics/pipeline';
import {
  boundaryBetween, componentDensityAt, densityAt, empiricalShares, fitFixed, fitMixture,
  histogram as buildHistogram, intervalsFor, selectMixture, separation,
  MAX_COMPONENTS, MAX_FIT_COMPONENTS, MIN_COMPONENT_WEIGHT, MIN_SEPARATION,
} from '@/core/biophysics/mixture';

applyTheme(useUI.getState().theme);

// Debug/automation handle. Exposed deliberately: it is how end-to-end tests
// drive the app, and it makes the store inspectable from devtools.
// There is nothing here the app's own renderer cannot already reach.
(window as unknown as Record<string, unknown>).__MCFLOW__ = {
  workspace: useWorkspace,
  ui: useUI,
  plot: usePlot,
  spectral: useSpectral,
  // The pairwise cosine matrix the panel draws, as the panel computes it. A
  // harness naming the hardest pair in a panel must read the same numbers that
  // are on screen rather than recompute cosines beside them — the two would
  // agree right up until normalisation moved.
  spectralSimilarity: currentSimilarity,
  umap: useUmap,
  // The events inside a gate, for the same reason as everything else here: a
  // harness asserting that a traced polygon excludes the debris smear has to
  // count the events it holds, and counting them any other way is a second
  // implementation of the thing under test.
  gatedEventsFor,
  gates: useGates,
  // Derived parameters and the per-parameter transform memory, exposed for the
  // same reason as everything else here: an end-to-end test has to compute a
  // real derived column against a loaded file rather than assert on a stand-in.
  derived: useDerived,
  derivedColumn: sampleColumn,
  // The same function under the name it has in the source. `derivedColumn` was
  // its name here when derived parameters were the only virtual index; it now
  // resolves real, derived, unmixed *and* the Time column's tick-to-seconds
  // conversion, and a harness asserting on that last one should be able to name
  // what it is calling.
  sampleColumn,
  parametersFor,
  // The axis domain a parameter declares, or null for a detector that declares
  // none. Exposed because "does an unmixed plot frame its own population" is a
  // question about this function's answer, and a harness measuring the rendered
  // viewport instead would be measuring the padding as well.
  axisDomainFor,
  validateDerived: validateDefinition,
  // The unmixed-abundance registry, exposed for the same reason: the 2026-08-09
  // regression is *"the parameters never reach the reader"*, so the harness has
  // to be able to ask the reader's own question — `parametersFor` above — and to
  // check the registry behind it independently rather than inferring it from the
  // store record that was right all along.
  unmixedColumns: { unmixedFor, unmixedCount, unmixedColumn },
  transformPrefs: useTransformPrefs,
  transformFor,
  // The statistics panel's setup, for the same reason. Item 4 (2026-08-05) is a
  // claim about state surviving a component being unmounted, so a harness has to
  // read the state from somewhere the component is not.
  statisticsPrefs: useStatisticsPrefs,
  // The figure style every exporter composes in. An end-to-end test
  // sets widths, formats and resolutions through the store the export panel
  // edits, then presses the panel's own Export button, so the file it checks
  // is the one a user gets.
  figure: useFigure,
  // End-to-end tests read the condition palette from here,
  // so a check compares against the colours the app draws rather than a restatement.
  groupColors: { conditionColor, categoryColors },
  // The window's zoom level. Exposed like every other session-scoped store here:
  // the control's readout is a rendering of this number, and a harness that read
  // the readout to check the number would be asserting on the label rather than
  // on the thing it labels.
  zoom: useZoom,
  // The transform pair itself, for the same reason: a harness that has to place
  // a gate on a fluorescence channel needs the *display* coordinates the gate
  // will be evaluated in, and computing them any other way is a second
  // implementation of the thing under test.
  transform: { createTransform, transformColumn, autoSpec },
  evaluateFor,
  defaultSpecFor,
  /*
     Which views are shut, and why — the *reader's* function, not the state
     behind it.

     Three surfaces decide whether a view can be opened and all three call this;
     a harness that instead read the disabled attribute off one segment would be
     asserting that one surface remembered to ask, which is the failure mode the
     function exists to prevent. It answers a string or null, so a check can also
     assert on *which* reason.
  */
  viewLockReason,
  /*
     Whether the workspace has unsaved changes.

     Exposed because "opening a panel costs nothing" is a claim about this as
     much as about the gates: `record()` marks the workspace dirty, so a guided
     panel that built on mount also took an untouched workspace's clean state.
     A harness cannot see that from the gate list.
  */
  dirty: useDirty,
  // How a sample's gate list is arrived at — shared, forked, and per-gate
  // overrides folded together. Exposed so an end-to-end test asks the
  // question the export asks rather than re-deriving the answer.
  resolveGates,
  // And which of those gates belong to the unmixing wizard rather than to the
  // experiment (2026-08-12, Item 11). Exposed for the same reason: the leak was
  // reported as a rendered tree, and a harness that only counted rendered rows
  // would pass against a fix that hid the gates while still evaluating them.
  // `pruneReferenceGates` joined them on 2026-08-13, when the same leak turned
  // out to have a second half: the wizard's gates outliving the setup that made
  // them. A harness counting rendered brackets would pass against a fix that
  // stopped drawing the duplicates while leaving them in the strategy.
  referenceGates: { isReferenceGate, withoutReferenceGates, pruneReferenceGates },
  restoreWorkspace,
  saveWorkspaceToFile,
  openWorkspaceFile,
  // The interactive open behind File > Open and a double-clicked workspace —
  // finds moved files and raises the missing-files prompt. A harness drives the
  // prompt through the ui store rather than a second path into the restore.
  openWorkspaceAt,
  captureWorkspace,

  // The unmixing matrix as a portable artefact, and the cross-window sync.
  // Exposed for the same reason as the stores: end-to-end tests have
  // to drive the real code path, not a re-implementation of it.
  unmixing: {
    capture: captureUnmixingMatrix,
    save: saveUnmixingMatrixToFile,
    load: loadUnmixingMatrixFromFile,
    loadByPath: loadUnmixingMatrixByPath,
    apply: applyUnmixingMatrix,
    recents: recentMatrices,
    parse: parseUnmixingMatrix,
    serialise: serialiseUnmixingMatrix,
    checkDetectors: checkDetectorCompatibility,
  },
  sync: { snapshot, applySnapshot, windowId: currentWindowId },

  // Undo/redo, workspace I/O and the panel openers. Same reason again — the
  // verification harnesses have to drive the real history stack and the real
  // stores, not a stand-in for them.
  history: useHistory,
  workspaceIO: { captureWorkspace, restoreWorkspace },
  layout: { openPanelsForSamples, openPanelForPopulation },

  // Worksheet geometry constants and the session's panel-size memory. Exposed so
  // a harness can assert against the *same* numbers the app lays out with rather
  // than restating them — a harness that hard-codes a constant fails when the
  // constant changes, for a reason that has nothing to do with the behaviour
  // under test. That trap is already recorded twice in PROGRESS.md.
  geometry: { PANEL_DEFAULT_WIDTH, PANEL_GAP, PANEL_COMPACT_BELOW },
  panelSize: { defaultPanelWidth, notePanelWidth, resetPanelWidthMemory },

  // The axis-range surfaces. `axisRanges` is what a panel publishes as its
  // auto-fitted extent, so a harness can assert that an explicit range actually
  // narrowed the view rather than merely being stored; the two pure helpers are
  // exposed so the harness tests the same functions the app renders through.
  axisRanges: useAxisRanges,
  axisRange: { applyAxisLimits, isAxisLimited },
  paramGroups: { groupOf, groupParameters },
  equation: { insertToken, tokenForName, clampCaret, OPERATOR_BUTTONS },

  // The colour-level surfaces. Exposed for the reason the geometry constants are:
  // an end-to-end test has to assert against the same defaults the app
  // opens a plot with and run the same render the plot renders, or it is testing a
  // second implementation of the feature.
  panelDefaults: { PANEL_VIEW_DEFAULTS, DENSITY_RESOLUTION },
  density: {
    RAMPS, bin2d, renderDensity, densityLevels, paintDensity, smoothHistogram2d, outlierValue,
    buildLevelTable, summariseLevels, robustCeiling, smooth2d, logWarp, smoothKernel, smoothSigma,
    // Auto smoothing, so the harness can ask the same function the draw asks
    // rather than restating the rule and testing its own arithmetic.
    autoSmoothing,
  },

  // The export selection rules, so the harness can drive the tree the dialog is
  // built from rather than clicking blind and hoping.
  exportPlan: { planFullExport, populationTree, allPaths, toggleSubtree, nodeState, subtreePaths },
  /*
     The CSV writer itself, and the default column selection.

     Exposed 2026-08-14 so a harness can check that a *computed* column reaches
     the file — the one thing about the export that a plan cannot show, since
     `extraColumns` is supplied by the caller and `core/export.ts` is deliberately
     free of store imports. Asserting on the plan alone would pass against a
     build that resolved the column and never wrote it, which is the
     "state that is set and never read" shape recorded in PROGRESS.md.
  */
  exportCsv: { eventsToCsv, defaultColumns },

  /*
     The Biophysics pipeline, and the fit behind it.

     `biophysics` is the store, driven exactly as the panel drives it. The
     `mixture` entry is the numerics on their own, and it is exposed separately
     and deliberately: the model-selection rule was settled by measuring
     candidate thresholds against real acquisitions, which needs the fit
     callable over an
     arbitrary column without a store, a gate or a panel in the way. Asserting
     on the *store's* answer alone would also repeat the mistake this project
     has recorded twice — checking the writer's state instead of the reader's
     function.
  */
  biophysics: useBiophysics,
  biophysicsProperties: {
    BIOPHYSICAL_PROPERTIES, populationNames, propertyById,
    // Which split is the live one, and what a scheme's components mean as
    // populations. Exposed because a harness asserting on a boundary has to ask
    // the same question the panel asks — reaching for the last boundary is right
    // under the graded reading and wrong under viability, which is the kind of
    // arithmetic a harness must never repeat for itself.
    liveBoundaryIndex, populationIntervals, populationBoundaries, maxComponentsFor, schemeFor,
    // Which population the fit is read inside. Never `liveGateId` directly: in
    // multi mode the distribution, the gates and the trace plot are all on the
    // doublet cut, and a harness reaching past this would assert against the
    // wrong population on exactly the mode where it matters.
    fitPopulationId,
  },
  mixture: {
    histogram: buildHistogram, fitMixture, selectMixture, fitFixed,
    boundaryBetween, separation, intervalsFor, empiricalShares, densityAt, componentDensityAt,
    MIN_COMPONENT_WEIGHT, MIN_SEPARATION, MAX_COMPONENTS, MAX_FIT_COMPONENTS,
  },

  /*
     The parameter presets and the detector table they annotate.

     `ratioExpression` is the one that matters: it is the function
     `PARAMETER_PRESETS` is built with and the one `resolvedPreset` rebuilds a
     re-pointed pair through, so a harness defining membrane order over two
     bands asks for the same string the panel would write. Spelling the ratio
     out instead is a second definition of the property, which is the thing
     `resolvedPreset` exists to prevent.

     The detector helpers come with it because they are what turns a name into
     the band it collects, and a harness asserting on a caption must read the
     same table the caption does — there being no FCS keyword to check against.
  */
  parameterPresets: { PARAMETER_PRESETS, ratioExpression, describePresetChannels, presetNamed },
  detectors: { DETECTOR_BANDS, detectorBand, describeDetector, describeDetectorFull, LASER_LINES },
};

const el = document.getElementById('root');
if (!el) throw new Error('Root element #root not found');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * How long the splash stays up, at minimum, in a window the application
 * launched.
 *
 * Start-up got fast enough that the mark was a flicker — a few hundred
 * milliseconds on a warm disk — so this holds it. It is a *floor*, not a delay:
 * if the real work takes longer than five seconds the splash simply stays until
 * that work is done and nothing is added on top, and none of the work itself
 * waits on this. `createRoot().render` has already been called by the time this
 * runs, the workspace or `.fcs` files named on the command line arrive over IPC
 * independently, and every store is live behind the overlay. What is deferred is
 * one `remove()`.
 */
const MIN_SPLASH_MS = 5000;

/**
 * Take the splash down once there is something behind it, and not before
 * `MIN_SPLASH_MS` has passed.
 *
 * After the first paint rather than after `render` returns: `createRoot().render`
 * schedules the work, it does not perform it, so removing the splash on the next
 * line would uncover an empty page for a frame or two — which is a flash of
 * nothing exactly where the splash was covering a flash of nothing. Two frames
 * is the same double-`requestAnimationFrame` wait the screenshot harness uses,
 * and for the same reason.
 *
 * **The floor is opt-in, via `?splash=hold`, and `electron/windows.ts` is the
 * only thing that asks for it.** End-to-end tests load
 * `dist/index.html` directly and drive the real app through real pointer input;
 * a five-second opaque overlay over the whole window would make every one of
 * them click the splash instead of the plot. Opt-in rather than opt-out because
 * "the application is starting" is exactly the condition the floor is about, and
 * a harness window is not that — so the harnesses need no flag, and a new one
 * cannot forget to pass it.
 *
 * The elapsed time is measured from `first-contentful-paint`, which is the frame
 * this markup actually appeared in. Navigation start would be a few hundred
 * milliseconds early, since the window is only shown on `ready-to-show`, and the
 * point of the floor is how long the mark is *on screen*.
 *
 * The fade is on the element and the removal is on `transitionend`, with a
 * timeout behind it: a window that is hidden or backgrounded throttles
 * `requestAnimationFrame` to about 1 Hz and may not fire a transition at all,
 * and a splash that never leaves is worse than one that never fades.
 */
const splash = document.getElementById('splash');
if (splash) {
  const hold = new URLSearchParams(window.location.search).get('splash') === 'hold';
  let scheduled = false;

  const dismiss = () => {
    splash.setAttribute('data-leaving', '1');
    const remove = () => splash.remove();
    splash.addEventListener('transitionend', remove, { once: true });
    setTimeout(remove, 600);
  };

  /**
   * The app is ready. Leave now, or when the floor is reached — whichever is
   * later. Called from two places, so it runs once.
   */
  const ready = () => {
    if (scheduled) return;
    scheduled = true;
    if (!hold) return dismiss();
    const painted = performance.getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint')?.startTime ?? 0;
    const remaining = MIN_SPLASH_MS - (performance.now() - painted);
    if (remaining <= 0) dismiss();
    else setTimeout(dismiss, remaining);
  };

  requestAnimationFrame(() => requestAnimationFrame(ready));
  // Belt and braces for a throttled window, where neither frame may arrive.
  setTimeout(ready, 3000);
}
