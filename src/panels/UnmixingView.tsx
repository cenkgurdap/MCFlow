import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Calculator, Check, ChevronLeft, ChevronRight, Crosshair,
  FolderOpen, Grid3x3, Link2, Link2Off, Play, RotateCcw, Save, Trash2, Waves, X,
} from 'lucide-react';
import { blockBetween, withBlock } from '@/core/rangeSelect';
import { detectorIndices, similarityMatrix, worstPair } from '@/core/spectral';
import { matrixFromFile, worstSpillover } from '@/core/compensation';
import type { AcquisitionType } from '@/core/fcs/types';
import type { MatrixModel } from '@/core/unmixingFile';
import {
  ROLE_LABELS, WIZARD_STEPS, controlIndexForLayout, controlIsGated, detectorChoices,
  negativeReferenceFor,
  type ControlAssignment, type ControlRole, type WizardStep,
} from '@/core/unmixing/wizard';
import { useSpectral } from '@/state/spectralStore';
// `recentMatrices`, `forgetMatrix` and `loadUnmixingMatrixByPath` are no longer
// imported here: the *Recently used* list that used them is removed. They stay
// in `unmixingIO` — a workspace records a path to the matrix it was saved with
// and re-loads it through the last of them.
import { loadUnmixingMatrixFromFile, saveUnmixingMatrixToFile } from '@/state/unmixingIO';
import { useGates } from '@/state/gateStore';
import { usePlot } from '@/state/plotStore';
import { useUI } from '@/state/uiStore';
import { acquisitionTypeOf, useWorkspace, type Sample } from '@/state/workspaceStore';
import { CAPTION_SEP } from '@/core/plotExport';
import { PipelineDone } from './PipelineDone';
import { PlotImageExport, type PlotSnapshot } from './PlotImageExport';
import { Button, IconButton, Spinner } from '@/ui/Button';
import { CheckboxGlyph, Field, Select, TextInput } from '@/ui/Field';
import { Badge, Callout, ColorChip, EmptyState, ProgressBar, StatTile } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { SegmentedControl, Tabs } from '@/ui/SegmentedControl';
import { DataTable, type Column } from '@/ui/Table';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { useListKeys } from '@/ui/useListKeys';
import { cn } from '@/ui/cn';

/**
 * Unmixing — two tabs, and a four-step wizard behind the first of them.
 *
 * ## Why there are two tabs (2026-08-08)
 *
 * There used to be five steps, the fifth of which was *Apply*. That said
 * something untrue about the workflow: that unmixing a multicolour sample is the
 * last leg of building a reference panel. It is not. A panel is built once and
 * applied every week, usually to files that did not exist when it was built,
 * frequently on a different machine by somebody who was not there — which is the
 * entire reason the matrix is a portable file of its own. Anybody arriving to do
 * that had to walk past four steps about controls they were never going to
 * select, or know to jump the tracker.
 *
 *   - **New unmixing** — Select → Assign → Gate → Compute. Build a panel from
 *     reference controls in this workspace, and save it.
 *   - **Load unmixing** — open a saved `.unmixing` and apply it to a
 *     sample that is already open, in the window you are already in.
 *
 * ## And why the wizard was a rebuild rather than a tidy-up (2026-08-06)
 *
 * The panel that stood here put everything on one screen: four stat tiles, a
 * callout, a method picker, an unmix button, and four tabs, one of which held a
 * checklist of controls the app had **guessed** by pattern-matching filenames.
 * Two problems, and the second is the one that made the first serious.
 *
 * It was ambiguous — nothing on the screen said what to do first, and the
 * controls tab, the compute button and the matrix tab were three stages of one
 * process presented as three peers. And it *inferred the experiment*:
 * `classifyControl` read a filename and decided whether a sample was a reference
 * control and whether it was unstained. Both decisions were silent, both were
 * wrong often enough to matter, and a wrong one produces a matrix built from the
 * wrong signatures — which does not fail, it just gives you different numbers.
 *
 * ## One panel, two entrances (2026-08-27)
 *
 * *Compensation* is this component with `platform="conventional"`, and that is
 * not a saving — it is the claim. Selecting the reference controls, naming
 * them, measuring which detector each is brightest in and gating its positive
 * population are the same four steps on either instrument; what differs is the
 * arithmetic at the end, and `computeMatrix` decides that from the controls
 * themselves rather than from anything set here. Two components would be two
 * models of one workflow, which is the line this project draws for guided
 * panels: *if Statistics needs a special case for it, the line has been
 * crossed.*
 *
 * What the prop actually chooses is which samples the panel is about, what the
 * screen calls the thing being built, and whether the third tab exists.
 */
export interface SpilloverPanelCopy {
  title: string;
  /** Plural noun for a row of the matrix — what the header counts. */
  rows: string;
  newTab: string;
  loadTab: string;
  emptyTitle: string;
  emptyBody: string;
  /** The operation, in the grammatical forms the panel needs it in. */
  noun: string;
  verb: string;
  /** Imperative, for a button: *Unmix 8 samples* / *Compensate 8 samples*. */
  verbTitle: string;
  verbing: string;
  verbPast: string;
  /** The tag a picker prints beside a parameter this panel produced. */
  tag: string;
  /** What kind of file this panel is about, for "no X sample is loaded". */
  sampleKind: string;
  /**
   * The saved artefact, in the two forms the save and load screens need it.
   *
   * One format, two names (2026-08-29) — see `COMP_FILE_EXTENSION`. The panel
   * that wrote a file is the panel whose word for it a reader will recognise in
   * a folder six months later, so *Load unmixing matrix* under a Compensation
   * heading was describing somebody else's experiment.
   */
  model: MatrixModel;
  matrixNoun: string;
  extension: string;
}

const COPY: Record<AcquisitionType, SpilloverPanelCopy> = {
  spectral: {
    title: 'Unmixing',
    rows: 'signatures',
    newTab: 'New unmixing',
    loadTab: 'Load unmixing',
    emptyTitle: 'No spectral samples loaded',
    emptyBody: 'Building a panel needs files acquired on a spectral cytometer. A saved matrix can be loaded and applied from the Load unmixing tab.',
    noun: 'unmixing', verb: 'unmix', verbTitle: 'Unmix',
    verbing: 'Unmixing', verbPast: 'unmixed', tag: 'Unmixed', sampleKind: 'spectral',
    model: 'unmixing', matrixNoun: 'unmixing matrix', extension: '.unmixing',
  },
  conventional: {
    title: 'Compensation',
    rows: 'detectors',
    newTab: 'New matrix',
    loadTab: 'Load matrix',
    emptyTitle: 'No conventional samples loaded',
    emptyBody: 'Building a matrix needs files acquired on a conventional cytometer. A saved matrix can be loaded and applied from the Load matrix tab.',
    noun: 'compensation', verb: 'compensate', verbTitle: 'Compensate',
    verbing: 'Compensating', verbPast: 'compensated', tag: 'Comp', sampleKind: 'conventional',
    model: 'compensation', matrixNoun: 'compensation matrix', extension: '.compensation',
  },
};

/**
 * The copy for the panel the reader is standing in.
 *
 * Read from the view rather than threaded down as a prop, and that is the
 * honest source: the two entrances render the same components five levels deep,
 * and the words on a screen should follow the screen you opened. Threading a
 * prop through `StepCompute`, `LoadUnmixingTab` and everything inside them
 * would be the same fact restated at every level, with one level free to
 * forget.
 */
function usePanelCopy(): SpilloverPanelCopy {
  const view = useUI((s) => s.view);
  return COPY[view === 'compensation' ? 'conventional' : 'spectral'];
}

export function UnmixingView({ platform = 'spectral' }: { platform?: AcquisitionType }) {
  const samples = useWorkspace((s) => s.samples);
  const {
    spectra, controls, tab, step,
    setTab, setStep, next, back, resetWizard, stepCheck, computeMatrix, clearSpectra,
    selectedIds,
  } = useSpectral();
  const copy = COPY[platform];

  /*
     The two panels share one `tab`, so the spectral side has to survive being
     handed a value only the conventional side renders.

     *From this file* reads `$SPILLOVER`, which is the identity in every file
     this spectral instrument writes — so on that side the tab is not rendered,
     and a stored `'file'` reads as *New unmixing* rather than as a screen with
     no tab selected above it.
  */
  const activeTab = tab === 'file' && platform !== 'conventional' ? 'new' : tab;

  /*
     And the conventional panel opens on it.

     Guarded on *nothing having been started* — no ticked samples, no
     assignments, no matrix — so this can never move somebody off work in
     progress, which is the failure a default applied after the fact produces.
     What it costs is that leaving the panel from an untouched Step 1 and coming
     back lands on *From this file* again, and that is the right place to be:
     Step 1 was empty, and the file already has a matrix.
  */
  useEffect(() => {
    if (platform !== 'conventional') return;
    const s = useSpectral.getState();
    if (s.tab !== 'new' || s.controls.length > 0 || s.spectra.length > 0 || s.selectedIds.length > 0) return;
    s.setTab('file');
  }, [platform]);
  const [computeError, setComputeError] = useState<string | null>(null);

  /*
     ## "Did my click register, or is it just slow?"

     Leaving Step 1 measures a peak detector for every selected control, and
     leaving Step 2 builds a worksheet per control, seeds a gate on each and
     evaluates the gating tree over every file. On a cell reference panel
     that is seconds of synchronous work on the main thread, during which the
     button stays lit, the step tracker stays put and nothing on screen moves.
     There is no way to tell that from a click that missed.

     So a step transition announces itself: the button spins, the step area is
     covered by a stated message naming the work, and both clear when it is done.
     The message is specific — *Measuring each control's brightest detector* —
     because "Please wait" tells somebody nothing they did not already know, and
     a spinner that names its task is the difference between waiting and
     wondering.

     **Two animation frames before the work starts**, and that is the load-bearing
     part rather than a flourish. React schedules the state update; the browser
     then needs a frame to lay out and a frame to paint. Calling `next()` in the
     same turn as `setBusy` runs the whole computation before the spinner has
     ever been rastered, so the indicator appears exactly when it is no longer
     needed. This is the same throttle already recorded in PROGRESS.md for
     `capturePage` and for driving a store write from outside React.
  */
  const [busy, setBusy] = useState<string | null>(null);

  const withBusy = async (message: string, work: () => void) => {
    setBusy(message);
    /*
       Two frames, **or 60 ms, whichever comes first**.

       The two frames are what gets the spinner painted before the main thread is
       taken. The timeout is what stops that from being a hang: a window that is
       minimised, backgrounded or — as in an end-to-end test — created
       with `show: false` has its `requestAnimationFrame` throttled to about 1 Hz,
       so waiting on two of them unconditionally would add two seconds to a click
       in exactly the situation where nothing is being painted to wait for. React
       has already committed the overlay by then either way; only the raster is
       outstanding, and a window nobody can see has none.
    */
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(null); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 60);
    });
    try { work(); } finally { setBusy(null); }
  };

  /*
     Which samples this panel is about, asked of `acquisitionTypeOf` rather than
     of `$PnTYPE`.

     It used to test for a `Raw_Fluorescence` parameter, which is a keyword only
     SpectroFlo writes — so every conventional file answered no, and would have
     gone on answering no to a panel built for it. `detectAcquisitionType` is
     the one place that question is decided, it runs at import, and the sample
     browser carries a per-sample override for the file it gets wrong.
  */
  const panelSamples = samples.filter((s) => acquisitionTypeOf(s) === platform);
  const check = stepCheck();

  const header = (
    <PanelHeader
      title={copy.title}
      icon={platform === 'conventional' ? <Grid3x3 size={12} /> : <Waves size={12} />}
      count={spectra.length > 0 ? `${spectra.length} ${copy.rows}` : undefined}
      actions={
        <>
          {activeTab === 'new' && (selectedIds.length > 0 || controls.length > 0) && (
            <Tooltip content="Start the setup again. Gates and worksheets are left alone.">
              <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} data-wizard-reset="" onClick={resetWizard}>
                Start over
              </Button>
            </Tooltip>
          )}
          {spectra.length > 0 && (
            <Tooltip content="Clear the reference signatures">
              <IconButton label="Clear panel" size="sm" onClick={clearSpectra}><Trash2 size={13} /></IconButton>
            </Tooltip>
          )}
        </>
      }
    />
  );

  /*
     The tabs sit directly under the section header and above the step tracker,
     which is the order they are read in: which of the two things am I doing,
     then how far through it am I. Rendered on every path including the
     no-samples one, because *Load unmixing* is exactly what somebody with an
     empty workspace has come here for.
  */
  const tabs = (
    <div data-unmixing-tabs="" className="shrink-0">
      <Tabs
        value={activeTab}
        onChange={setTab}
        className="px-1"
        tabs={[
          /*
             *From this file* is first, and only on the conventional side.

             It is first because it is what most people came for and because it
             is the better-founded answer: a FACSDiva export carries the matrix
             its own acquisition software built from these same single stains,
             at the machine, with somebody watching the plots. Building one here
             is the fallback for when that matrix is absent or wrong, not the
             headline. On a spectral panel the tab does not exist at all —
             `$SPILLOVER` is the identity in every file this instrument writes.
          */
          ...(platform === 'conventional' ? [{ value: 'file' as const, label: 'From this file' }] : []),
          { value: 'new' as const, label: copy.newTab },
          {
            value: 'load' as const,
            label: copy.loadTab,
            badge: spectra.length > 0 ? <Badge tone="accent">{spectra.length}</Badge> : undefined,
          },
        ]}
      />
    </div>
  );

  if (activeTab === 'file') {
    return (
      <Panel className="h-full">
        {header}
        {tabs}
        <div className="flex-1 overflow-auto min-h-0" data-unmixing-tab="file">
          <FileMatrixTab samples={panelSamples} onBuildInstead={() => setTab('new')} />
        </div>
      </Panel>
    );
  }

  if (panelSamples.length === 0 && activeTab === 'new') {
    // Loading a saved panel into an empty workspace is an explicitly supported
    // first action — the matrix belongs to an instrument, not to whatever files
    // happen to be open — so this cannot be a dead end.
    return (
      <Panel className="h-full">
        {header}
        {tabs}
        <EmptyState
          className="mt-10"
          icon={platform === 'conventional' ? <Grid3x3 size={19} /> : <Waves size={19} />}
          title={copy.emptyTitle}
          description={copy.emptyBody}
          action={<Button variant="secondary" onClick={() => setTab('load')}>Load a saved matrix</Button>}
        />
      </Panel>
    );
  }

  return (
    <Panel className="h-full">
      {header}
      {tabs}

      {activeTab === 'load' ? (
        <div className="flex-1 overflow-auto min-h-0" data-unmixing-tab="load">
          <LoadUnmixingTab spectralSamples={panelSamples} />
        </div>
      ) : (
        <>
          <StepTracker step={step} onPick={setStep} controls={controls} computed={spectra.length > 0} />

          {/* One step's screen. Each is a component of its own rather than a
              branch inside this one, because that is the whole claim the
              redesign makes — these are separate stages, not sections of a
              dense page. */}
          <div className="relative flex-1 overflow-auto min-h-0" data-wizard-step={step} data-unmixing-tab="new">
            {step === 1 && <StepSelect samples={panelSamples} />}
            {step === 2 && <StepAssign samples={panelSamples} />}
            {step === 3 && <StepGate samples={panelSamples} />}
            {step === 4 && (
              <StepCompute
                error={computeError}
                busy={busy}
                onCompute={() => void withBusy(
                  'Building the matrix from every gated control…',
                  () => {
                    const r = computeMatrix(samples);
                    setComputeError(r.ok ? null : r.message ?? 'Could not compute the matrix.');
                  },
                )}
                onApply={() => setTab('load')}
              />
            )}

            {/*
                Covers the step, not the whole panel: the tracker above and the
                navigation below stay legible, so the answer to "where am I"
                does not disappear while the answer to "what is it doing"
                appears. `pointer-events-auto` on an absolutely positioned layer
                is what makes it a modal barrier — pressing Next twice while the
                first press is still working would run the transition twice.
            */}
            {busy && (
              <div
                data-wizard-busy=""
                role="status"
                aria-live="polite"
                className="absolute inset-0 z-20 flex items-start justify-center pt-16 bg-[var(--surface-base)]/78 anim-fade"
              >
                <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]">
                  <Spinner size={14} className="text-[var(--text-accent)]" />
                  <span className="text-xs text-[var(--text-primary)]">{busy}</span>
                </div>
              </div>
            )}
          </div>

          {/* The navigation bar, always in the same place. `Next` states why it
              is disabled rather than merely being grey — the reason is the
              instruction. */}
          <div className="flex items-center gap-2 p-2.5 hairline-t shrink-0 bg-[var(--surface-sunken)]">
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowLeft size={12} />}
              disabled={step === 1}
              data-wizard-back=""
              onClick={back}
            >
              Back
            </Button>
            <p className={cn('flex-1 min-w-0 text-2xs leading-snug', check.ok ? 'text-[var(--text-tertiary)]' : 'text-[var(--status-warn)]')}>
              {check.ok ? (check.advice ?? '') : check.reason}
            </p>
            {step < 4 && (
              <Tooltip content={check.ok ? '' : check.reason}>
                <span>
                  <Button
                    size="sm"
                    variant="primary"
                    trailing={<ArrowRight size={12} />}
                    disabled={!check.ok || !!busy}
                    // `loading` blanks the label and spins in place, so the
                    // button the user just pressed is the first thing that says
                    // something is happening — before their eye reaches the
                    // overlay.
                    loading={!!busy}
                    data-wizard-next=""
                    onClick={() => void withBusy(
                      step === 1
                        ? 'Measuring each control’s brightest detector…'
                        : 'Building a worksheet per control and placing the first gates…',
                      () => next(samples),
                    )}
                  >
                    {step === 2 ? 'Build gating worksheets' : 'Next'}
                  </Button>
                </span>
              </Tooltip>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ========================================================================== */

/**
 * "1 Select · 2 Assign · 3 Gate · 4 Compute".
 *
 * Clickable, but only backwards and only as far as the work allows: jumping
 * forward past a step whose output the next one consumes produces a screen built
 * from nothing. A step already completed is a different matter — going back to
 * re-tick a control is an ordinary thing to want.
 */
function StepTracker({
  step, onPick, controls, computed,
}: {
  step: WizardStep;
  onPick: (s: WizardStep) => void;
  controls: ControlAssignment[];
  computed: boolean;
}) {
  // How far the work has actually got, which is what bounds the forward jumps.
  const reached: WizardStep = computed || (controls.length > 0 && controls.every(controlIsGated)) ? 4
    : controls.some((c) => c.layoutId) ? 3
      : controls.length > 0 ? 2 : 1;

  return (
    <div className="flex items-stretch gap-px px-2.5 py-2 hairline-b shrink-0" data-step-tracker="">
      {WIZARD_STEPS.map(({ step: n, label }) => {
        const state = n === step ? 'current' : n < step ? 'done' : 'todo';
        const reachable = n <= Math.max(step, reached);
        return (
          <button
            key={n}
            type="button"
            disabled={!reachable}
            data-step={n}
            data-step-state={state}
            onClick={() => reachable && onPick(n as WizardStep)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 h-7 px-2 text-2xs font-medium',
              'first:rounded-l-[var(--radius-sm)] last:rounded-r-[var(--radius-sm)]',
              'transition-colors duration-[var(--dur-fast)]',
              state === 'current' && 'bg-[var(--surface-selected)] text-[var(--text-primary)]',
              state === 'done' && 'bg-[var(--surface-active)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]',
              state === 'todo' && 'bg-[var(--surface-raised)] text-[var(--text-disabled)]',
              !reachable && 'cursor-not-allowed',
            )}
          >
            <span
              className={cn(
                'grid place-items-center w-4 h-4 rounded-full text-[9px] tnum shrink-0',
                state === 'current' ? 'bg-[var(--accent-500)] text-[var(--n-dark-950)]'
                  : state === 'done' ? 'bg-[var(--surface-overlay)] text-[var(--text-secondary)]'
                    : 'bg-[var(--surface-overlay)] text-[var(--text-disabled)]',
              )}
            >
              {state === 'done' ? <Check size={9} /> : n}
            </span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 1 — which loaded samples are reference controls.
 *
 * The same list the sidebar shows, with checkboxes, and **nothing ticked**. That
 * empty start is the entire point of the step: the previous panel opened with
 * whatever `classifyControl` had decided, so a user who never looked at the
 * controls tab could reach a computed matrix without ever having stated which
 * files it was built from.
 *
 * ## One hit target per row, and why the row is a button
 *
 * Each row used to be a `<label>` wrapping the shared `Checkbox`, which is the
 * obvious way to make a whole row clickable and is wrong here. A `<label>`
 * forwards a click to its labelable descendant, `<button>` is labelable, and
 * Chromium only suppresses that forwarding for clicks on *interactive content* —
 * which the `<svg>` check mark inside the button is not. So a press on the glyph
 * ran the button's handler and was then forwarded back to the same button:
 * toggle, toggle, nothing. Measured as a 9 px dead band across the middle of the
 * box, present only while the row was already ticked, because the mark that
 * received the click only exists when it is.
 *
 * The row is now a single `<button role="checkbox">` around a purely visual
 * `CheckboxGlyph`. One element, one handler, no forwarding.
 */
function StepSelect({ samples }: { samples: ReturnType<typeof useWorkspace.getState>['samples'] }) {
  const copy = usePanelCopy();
  const selectedIds = useSpectral((s) => s.selectedIds);
  const toggleSelected = useSpectral((s) => s.toggleSelected);
  const setSelected = useSpectral((s) => s.setSelected);
  const clearSelection = useSpectral((s) => s.clearSelection);
  const [query, setQuery] = useState('');
  /*
     Where the last plain click landed, for Shift-click.

     A ref, not state: it changes on every click and nothing on screen reads
     it. Held as a sample id, so it survives the filter changing underneath it —
     and `blockBetween` treats an id that has been filtered away as no anchor
     at all, which is the right reading when the row it would measure from is
     not on screen.
  */
  const anchor = useRef<string | null>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? samples.filter((s) => s.name.toLowerCase().includes(q)) : samples;
  }, [samples, query]);

  /**
   * Click a row, or Shift-click to take everything between.
   *
   * Ticking eleven single stains was eleven clicks. The block runs between this
   * row and the last one plainly clicked, in the order shown, and is painted
   * with the anchor's own state — the same gesture, off the same two functions,
   * as UMAP's parameter list. Shift is read whether or not Ctrl is down; Ctrl
   * alone is what a plain click already does here.
   */
  const clickRow = (e: { shiftKey: boolean }, id: string) => {
    const block = e.shiftKey ? blockBetween(shown.map((x) => x.id), anchor.current, id) : null;
    if (block) {
      setSelected(withBlock(selectedIds, block, selectedIds.includes(anchor.current!)));
      return;
    }
    anchor.current = id;
    toggleSelected(id);
  };

  // The keyboard, on that same handler.
  const keys = useListKeys({ ordered: shown.map((s) => s.id), onActivate: clickRow });

  return (
    <div className="p-2.5 space-y-2.5" data-step-select="">
      {/* Step 1's instruction, in the words somebody at the cytometer would use.
          It said "Select the reference controls", which assumes the reader
          already knows which of their files those are — and the whole reason
          filename guessing was deleted is that the application cannot know
          either. Naming the tubes is what makes the question answerable. */}
      <Callout tone="accent" title="Which of these files are your controls?">
        Tick every tube that has just one thing in it: each single-stained sample, your unstained sample, and an
        autofluorescence sample if you ran one. Leave your real experiment unticked — that is what you will
        {' '}{copy.verb} at the end. Shift-click a second row to take everything between, or use the arrow
        keys and Space.
      </Callout>

      <div className="flex items-center gap-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter samples…"
          className="h-6 text-2xs flex-1"
        />
        <Badge mono>{selectedIds.length} of {samples.length}</Badge>
        <Button size="sm" variant="ghost" onClick={() => setSelected(shown.map((s) => s.id))}>Select all</Button>
        <Button size="sm" variant="ghost" disabled={selectedIds.length === 0} onClick={clearSelection}>Clear</Button>
      </div>

      <div
        {...keys.containerProps}
        aria-label="Reference controls"
        className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-500)]"
      >
        {shown.map((s, i) => {
          const on = selectedIds.includes(s.id);
          return (
            <button
              key={s.id}
              id={keys.rowId(s.id)}
              type="button"
              role="checkbox"
              aria-checked={on}
              /* Out of the tab order: the container holds focus for the list,
                 so Tab steps past it rather than through every loaded file. */
              tabIndex={-1}
              data-control-candidate={s.name}
              data-selected={on ? '' : undefined}
              data-list-cursor={keys.cursor === s.id ? '' : undefined}
              onClick={(e) => keys.onRowClick(e, s.id)}
              className={cn(
                'flex items-center gap-2.5 w-full px-2.5 h-8 text-left',
                i > 0 && 'hairline-t',
                on ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                keys.cursor === s.id && 'ring-1 ring-inset ring-[var(--accent-500)]',
              )}
            >
              <CheckboxGlyph checked={on} />
              <span className="w-5 shrink-0 text-right font-mono tnum text-[10px] text-[var(--text-disabled)]">
                {samples.indexOf(s) + 1}
              </span>
              <span className={cn('text-xs truncate min-w-0 flex-1', on ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
                {s.name}
              </span>
              <span className="text-2xs tnum text-[var(--text-disabled)] shrink-0">
                {s.parsed.metadata.eventCount.toLocaleString('en-US').replace(/,/g, ' ')}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="px-2.5 py-3 text-center text-2xs text-[var(--text-disabled)]">No sample matches that filter.</p>
        )}
      </div>
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 2 — a role, an identity, a peak detector and a negative reference per row.
 *
 * Four things the matrix depends on. The role decides what the sample
 * contributes; the identity decides what the signature is *called* everywhere
 * downstream — the worksheet name in Step 3, the similarity matrix, the saved
 * file; the detector decides which channel Step 3 gates on; and the negative
 * reference decides where the baseline comes from.
 *
 * **Every one of them opens with a suggestion, and every suggestion says so.**
 * That is not a retreat from deleting `classifyControl`: what was deleted
 * decided *which files were controls* and did it invisibly. These four fields
 * are filled in next to the file they were derived from, on rows the user has
 * already ticked, and each is marked until it is touched. A suggestion that
 * cannot be told apart from a statement is the thing that was wrong; one that
 * announces itself costs nothing to accept and nothing to notice.
 *
 * **The rows are in peak-detector order** — UV, Violet, Blue, Yellow-Green, Red,
 * ascending within each laser, with the baselines first — which is the order the
 * worksheet tabs, the layout dropdown and the walk all use. It used to be import
 * order here and detector order there, so the same eleven files were listed two
 * ways on two screens. The order is a property of `controls` now; this table
 * renders the array as it stands and never sorts.
 *
 * The table is `DataTable`, for the columns rather than for the sorting: the
 * File and Identity columns hold 60-character names, and the resize behaviour
 * built for the statistics table in the continuity pass is the same behaviour
 * this needs. Widths live in the store because this component unmounts on every
 * step change.
 */
function StepAssign({ samples }: { samples: ReturnType<typeof useWorkspace.getState>['samples'] }) {
  const controls = useSpectral((s) => s.controls);
  const syncControls = useSpectral((s) => s.syncControls);
  const setControlRole = useSpectral((s) => s.setControlRole);
  const setControlReference = useSpectral((s) => s.setControlReference);
  const setAllReferences = useSpectral((s) => s.setAllReferences);
  const setControlPeak = useSpectral((s) => s.setControlPeak);
  const relabelControl = useSpectral((s) => s.relabelControl);
  const selectedIds = useSpectral((s) => s.selectedIds);
  const assignWidths = useSpectral((s) => s.assignWidths);
  const setAssignWidths = useSpectral((s) => s.setAssignWidths);

  // Reconcile on arrival as well as on the way out of Step 1, so jumping back to
  // this step from the tracker shows the current selection rather than the one
  // that was current when Next was last pressed.
  const synced = useRef('');
  useEffect(() => {
    const key = selectedIds.join('|');
    if (synced.current === key) return;
    synced.current = key;
    syncControls(samples);
  }, [selectedIds, samples, syncControls]);

  const byId = useMemo(() => new Map(samples.map((s) => [s.id, s])), [samples]);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;

  const columns: Column<ControlAssignment>[] = useMemo(() => [
    {
      key: 'file',
      header: 'File',
      width: 210,
      minWidth: 110,
      cell: (c) => (
        <span className="text-2xs text-[var(--text-secondary)]" title={nameOf(c.sampleId)}>
          {nameOf(c.sampleId)}
        </span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 130,
      minWidth: 96,
      cell: (c) => (
        <Select
          value={c.role ?? ''}
          data-role-for={nameOf(c.sampleId)}
          data-suggested={c.roleSource === 'suggested' ? '' : undefined}
          aria-label={`Role for ${nameOf(c.sampleId)}`}
          className={cn('h-6 text-2xs', c.role === null && 'border-[var(--status-warn)]')}
          onChange={(e) => setControlRole(c.sampleId, (e.target.value || null) as ControlRole | null)}
        >
          <option value="">Choose…</option>
          <option value="stain">{ROLE_LABELS.stain}</option>
          <option value="unstained">{ROLE_LABELS.unstained}</option>
          <option value="autofluorescence">{ROLE_LABELS.autofluorescence}</option>
        </Select>
      ),
    },
    {
      key: 'identity',
      header: 'Identity',
      width: 190,
      minWidth: 110,
      cell: (c) => (
        <TextInput
          defaultValue={c.label}
          key={`${c.sampleId}:${c.label}`}
          data-label-for={nameOf(c.sampleId)}
          data-suggested={c.labelSource === 'suggested' ? '' : undefined}
          aria-label={`Identity for ${nameOf(c.sampleId)}`}
          placeholder="e.g. CD3 FITC"
          className="h-6 text-2xs"
          // On blur rather than per keystroke: a half-typed identity would
          // rename a worksheet on every letter.
          onBlur={(e) => relabelControl(c.sampleId, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      ),
    },
    {
      key: 'detector',
      header: 'Peak detector',
      width: 120,
      minWidth: 92,
      title: 'The detector this sample is brightest in. Measured from the file; change it if the measurement picked the wrong channel. The rows are ordered by it.',
      cell: (c) => {
        const sample = byId.get(c.sampleId);
        return sample ? <PeakDetectorSelect control={c} sample={sample} onPick={setControlPeak} /> : null;
      },
    },
    {
      key: 'negative',
      header: 'Negative reference',
      width: 150,
      minWidth: 120,
      cell: (c) => (c.role === 'stain' ? (
        <SegmentedControl
          size="sm"
          value={c.reference}
          onChange={(v) => setControlReference(c.sampleId, v)}
          segments={[
            { value: 'unstained', label: 'Unstained', title: 'The negative comes from a separate unstained sample' },
            { value: 'self', label: 'Self', title: 'This tube carries both a negative and a positive population' },
          ]}
        />
      ) : (
        <span className="text-2xs text-[var(--text-disabled)]">{c.role ? 'baseline' : '—'}</span>
      )),
    },
  ], [byId, setControlRole, setControlReference, setControlPeak, relabelControl]);

  const suggested = controls.filter(
    (c) => c.roleSource === 'suggested' || c.labelSource === 'suggested' || c.peakSource === 'suggested',
  ).length;

  // Only single stains have a negative reference, so only they are counted and
  // only they decide whether a bulk button has anything left to do.
  const stainRows = controls.filter((c) => c.role === 'stain');
  const stains = stainRows.length;
  const allSelf = stains > 0 && stainRows.every((c) => c.reference === 'self');
  const allUnstained = stains > 0 && stainRows.every((c) => c.reference === 'unstained');

  return (
    <div className="p-2.5 space-y-2.5" data-step-assign="">
      {/* Step 2's instruction. It named the places the identity is used —
          "the gating worksheets, the similarity matrix and the saved matrix
          file" — which is three pieces of the application's own furniture and
          answers a question nobody asked. What somebody needs to know is what
          each column is asking of them, and that the rows have been guessed. */}
      {/* "Tell what each control is", not "Tell *the app* what each control is"
          (2026-08-11, Item 10). The application is not a party to the
          conversation — a heading on a screen is already addressed by the
          person reading it to the thing in front of them, and naming the
          software as the listener is the same register as a dialog that
          apologises. Continues the plain-language pass of 2026-08-10. */}
      <Callout tone="accent" title="Tell what each control is">
        For every tube: is it stained with one antibody, is it your unstained sample, or is it an autofluorescence
        control? Give it the name you want to see on your plots afterwards.
        {suggested > 0 && (
          <span className="block mt-1 text-[var(--text-tertiary)]">
            {suggested} row{suggested === 1 ? '' : 's'} {suggested === 1 ? 'has' : 'have'} been filled in already —
            from the filename, and from which detector the tube is brightest in. Read them and correct anything that
            is wrong; nothing here is used until you press Next.
          </span>
        )}
      </Callout>

      {/*
         Set the whole Negative reference column at once.

         A panel is one kind or the other — beads carry their own negative
         population, stained cells read one separate unstained tube — so the
         column is almost always fourteen copies of one answer, and clicking it
         row by row is fourteen clicks to state one fact. Set them all, then
         correct the one tube that differs; the per-row control is untouched and
         is still what says which is which.

         Above the table rather than in the column header: the header is a
         resizable `DataTable` column 150 px wide, and two buttons in it would be
         the first thing to be clipped.
      */}
      {stains > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-2xs text-[var(--text-tertiary)]">
            Negative reference for all {stains} single stain{stains === 1 ? '' : 's'}:
          </span>
          <Button
            size="sm"
            variant="secondary"
            data-all-reference="self"
            disabled={allSelf}
            onClick={() => setAllReferences('self')}
          >
            All self
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-all-reference="unstained"
            disabled={allUnstained}
            onClick={() => setAllReferences('unstained')}
          >
            All unstained
          </Button>
        </div>
      )}

      {controls.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-2xs text-[var(--text-disabled)]">
          Nothing selected. Go back to Step 1.
        </p>
      ) : (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
          <DataTable
            rows={controls}
            columns={columns}
            rowKey={(c) => c.sampleId}
            resizable
            widths={assignWidths}
            onWidthsChange={setAssignWidths}
            className="max-h-[420px]"
          />
        </div>
      )}

      <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
        <strong className="text-[var(--text-secondary)]">Negative reference</strong> is where the
        &ldquo;unstained&rdquo; intensity level for that antibody is read. Pick{' '}
        <strong className="text-[var(--text-secondary)]">Unstained</strong> when
        it comes from your separate unstained tube, which is normal for stained cells; pick{' '}
        <strong className="text-[var(--text-secondary)]">Self</strong> when the tube itself contains both stained and
        unstained material, which is how compensation beads work.
      </p>
    </div>
  );
}

/**
 * The peak-detector dropdown, on every row regardless of role.
 *
 * Offered for unstained and autofluorescence samples too, which have no positive
 * population to isolate. Two reasons, and the second is the stronger: a column
 * that is blank on three rows of fourteen reads as a failure rather than as an
 * irrelevance, and the measurement is still worth *seeing* on a baseline — an
 * unstained tube whose brightest channel is a bright fluorescence detector is a
 * mislabelled tube, and this is where that shows.
 */
function PeakDetectorSelect({
  control, sample, onPick,
}: {
  control: ControlAssignment;
  sample: Sample;
  onPick: (sample: Sample, parameterIndex: number) => void;
}) {
  // Per sample rather than per row: every file in a panel has the same detector
  // configuration, and rebuilding sixty-four options for each of fourteen rows
  // on every keystroke elsewhere in the table is measurable.
  const choices = useMemo(
    () => detectorChoices(sample.parsed.metadata, detectorIndices(sample.parsed.metadata)),
    [sample],
  );

  return (
    <Select
      value={control.peak?.parameterIndex ?? ''}
      data-peak-for={sample.name}
      data-suggested={control.peakSource === 'suggested' ? '' : undefined}
      aria-label={`Peak detector for ${sample.name}`}
      className={cn(
        'h-6 text-2xs font-mono',
        control.peakSource === 'user' && 'border-[var(--accent-500)]/60',
      )}
      onChange={(e) => { if (e.target.value !== '') onPick(sample, Number(e.target.value)); }}
    >
      {control.peak === null && <option value="">—</option>}
      {choices.map((d) => (
        <option key={d.parameterIndex} value={d.parameterIndex}>{d.name}</option>
      ))}
    </Select>
  );
}

/* ========================================================================== */

/**
 * Step 3 — walk the generated worksheets, one control at a time.
 *
 * This panel is deliberately **not** where the gating happens. The worksheets
 * are on the plot canvas, built by `buildGatingLayouts`, and the user draws on
 * them with the same tools they use for everything else; this is the walker that
 * says which control they are looking at, what still needs doing, and how to get
 * to the next one. A wizard that re-implemented gate drawing inside itself would
 * be a second set of gating tools to keep in step with the first.
 *
 * **Which control is showing is read off the active worksheet**, not held here.
 * There are three ways to move — these arrows, the tab strip along the bottom of
 * the worksheet, and the layout dropdown in the title bar — and the third of them
 * knows nothing about this wizard. Deriving the position from `activeLayoutId`
 * means all three are one control rather than three copies to keep level.
 */
function StepGate({ samples }: { samples: ReturnType<typeof useWorkspace.getState>['samples'] }) {
  const controls = useSpectral((s) => s.controls);
  const walkIndex = useSpectral((s) => s.walkIndex);
  const generalGateId = useSpectral((s) => s.generalGateId);
  const goToControl = useSpectral((s) => s.goToControl);
  const ensureGated = useSpectral((s) => s.ensureGated);
  const unlinkGeneralGate = useSpectral((s) => s.unlinkGeneralGate);
  const relinkGeneralGate = useSpectral((s) => s.relinkGeneralGate);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);
  const setView = useUI((s) => s.setView);

  /*
     Gating happens on arrival, with no button to press.

     `buildGatingLayouts` already seeds every control on the way out of Step 2,
     so this is the top-up for the cases that reach Step 3 by another route:
     jumping back with the tracker after changing a peak detector, adding a
     control to the selection, or an undo that took the gates with it. It only
     ever touches a control that has *no* gate — see `ensureGated`.
  */
  useEffect(() => { ensureGated(samples); }, [ensureGated, samples, walkIndex]);

  // Only the overrides: whether a control has its own general-gate boundary is a
  // question about that map alone. Subscribing to `shared` as well would
  // re-render this panel on every gate drawn anywhere.
  const overrides = useGates((s) => s.overrides);

  const index = controlIndexForLayout(controls, activeLayoutId, walkIndex);
  const current = controls[index];
  const sample = current ? samples.find((s) => s.id === current.sampleId) : undefined;

  if (!current || !sample) {
    return (
      <div className="p-2.5">
        <EmptyState
          size="sm"
          className="mt-6"
          icon={<Crosshair size={15} />}
          title="No worksheets built yet"
          description="Go back to Step 2 and press “Build gating worksheets”."
        />
      </div>
    );
  }

  /*
     Whether *this* control has a boundary of its own.

     Read from `overrides`, not from the gate's `linked` flag. `linked: false`
     lives on the one hierarchy and says "this gate may vary per sample" for
     every sample at once — so testing it reported all nine controls as specific
     the moment one was unlinked. An override entry is the per-sample fact.
  */
  const isSpecific = !!overrides[generalGateId ?? '']?.[current.sampleId];
  const specificCount = Object.keys(overrides[generalGateId ?? ''] ?? {}).length;

  const done = controls.filter(controlIsGated).length;
  const negId = negativeReferenceFor(current, controls);
  const negName = negId ? samples.find((s) => s.id === negId)?.name ?? null : null;
  const isStain = current.role === 'stain';

  return (
    <div className="p-2.5 space-y-2.5" data-step-gate="">
      {/* The walker. "Control 3 of 13", in the peak-detector order the panel
          uses everywhere, with the arrows either side of it. */}
      <div className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <IconButton
          label="Previous control"
          size="sm"
          data-walk-prev=""
          disabled={index <= 0}
          onClick={() => goToControl(index - 1)}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <div className="flex-1 min-w-0 text-center">
          <p className="text-xs font-medium text-[var(--text-primary)] truncate" data-walk-label>
            {current.label}
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] tnum">
            Control {index + 1} of {controls.length}
            {isStain && current.peak
              ? <> · peak <span className="font-mono text-[var(--text-secondary)]">{current.peak.name}</span></>
              : <> · {ROLE_LABELS[current.role ?? 'stain']}</>}
          </p>
        </div>
        <IconButton
          label="Next control"
          size="sm"
          data-walk-next=""
          disabled={index >= controls.length - 1}
          onClick={() => goToControl(index + 1)}
        >
          <ChevronRight size={14} />
        </IconButton>
      </div>

      {/*
         ## What used to be here, and why it is not

         A three-column header — **GATED 13/13**, **PEAK DETECTOR UV7-A**,
         **GENERAL GATE shared** — plus a paragraph naming the three plots on the
         worksheet, plus a *Signature population* dropdown. About 200 px of
         vertical space above the list, and every fact in it was already on
         screen: the gated count is the run of green ticks in the list below, the
         peak detector is the right-hand column of the row you are on, and
         "shared" now sits on each row that uses the shared boundary. A tile that
         repeats the row beneath it is a tile that has to be read twice to
         discover it says nothing new.

         What replaces it is one plain sentence saying what to do. The gating was
         done for you; go and look at it.
      */}
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <Crosshair size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {/* "the controls' worksheet below", not "the controls below" — the
              thing being checked is the plot each control got, not the row in
              the list, and the list below this paragraph is the way to reach it
              rather than the thing to read (2026-08-11, Item 10). */}
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            The gates have already been drawn for you. Go through the controls&rsquo; worksheet below and check each
            one looks right.
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            {isStain
              ? <>On this control, adjust the gate so it sits around the bright (stained) cells and leaves the dim ones out.</>
              : <>Nothing on this control is stained, so its gate just needs to sit around the main cloud of cells, leaving debris and dead cells out.</>}
            {' '}Drag an edge on the worksheet to move it — the percentage updates as you drag. Nothing is re-placed
            once you have touched it.
            {isStain && current.reference === 'unstained' && negName && (
              <> This control&rsquo;s &ldquo;dim&rdquo; level is read from <strong>{negName}</strong>, which has a worksheet of its own.</>
            )}
          </p>
          <Button
            size="sm"
            variant="secondary"
            icon={<Crosshair size={12} />}
            data-goto-worksheet=""
            onClick={() => setView('analysis')}
          >
            Open this control&rsquo;s worksheet
          </Button>
        </div>
      </div>

      {/*
         The *Signature population* dropdown is gone with the header block it sat
         in. It let a baseline's signature be measured over a hand-drawn gate
         instead of the seeded one, which is a real thing to want and is still
         reachable by the ordinary route: the clean-population gate placed on
         that worksheet **is** the signature population, and dragging its edges
         is how it is narrowed. What the control added was swapping to a
         *different* gate somebody had drawn — a case worth less than the
         200 px and the sentence of explanation it cost on every visit to this
         step. `setControlGate` is untouched and still the one writer of that
         field.
      */}

      {/*
         Data-specific gating.

         The same per-gate link/unlink primitive the regular gate tree has
         offered since the integrity pass — `setGateLinked` plus a per-sample
         override — and deliberately a different *presentation* of it. The tree's
         version is a small toggle on a gate, which is right where a gating
         strategy is being built by hand and every gate has one. Here there is
         exactly one gate it can apply to and a specific reason to reach for it —
         a control whose population genuinely does not sit where the rest of the
         panel's does — so it gets a stated block with the consequence spelled
         out rather than a secondary link in a row of buttons.

         **Nothing here changes the Analysis tab.** No shared component, no
         change to `setGateLinked`, no new field on `Gate`; the store actions
         this calls are scoped to the wizard's own `generalGateId`.
      */}
      <div
        className={cn(
          'rounded-[var(--radius-md)] border p-2.5 space-y-2',
          isSpecific ? 'border-[var(--accent-500)]/60 bg-[var(--accent-500)]/6' : 'border-[var(--border-subtle)]',
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn('shrink-0', isSpecific ? 'text-[var(--text-accent)]' : 'text-[var(--text-tertiary)]')}>
            {isSpecific ? <Link2Off size={13} /> : <Link2 size={13} />}
          </span>
          <span className="text-xs font-medium text-[var(--text-primary)]" data-general-gate-state={isSpecific ? 'specific' : 'shared'}>
            {isSpecific ? 'This control has its own cell gate' : 'All controls share one cell gate'}
          </span>
          {specificCount > 0 && (
            <Badge tone={isSpecific ? 'accent' : 'info'}>{specificCount} own</Badge>
          )}
        </div>
        {/*
           The rule the reference screenshot's header was gesturing at, said
           plainly and in one place.

           One cell gate is drawn automatically on the **first control in the
           list** and every other control then uses that same gate. Which control
           happens to be first makes no difference — it can be a stain, the
           unstained tube or the autofluorescence tube; the gate is a boundary
           around where the cells are on scatter, and that is the same question
           on all of them.
        */}
        <p className="text-2xs leading-snug text-[var(--text-tertiary)]">
          {isSpecific
            ? <>Moving it here changes nothing anywhere else. The other {Math.max(0, controls.length - specificCount)} controls still use the shared one.</>
            : <>
                The cell gate was drawn once, on the first control in the list, and every other control uses that
                same one — so moving it here moves it everywhere and every percentage under it follows. If this
                control&rsquo;s cells sit somewhere the rest of the panel&rsquo;s do not, give it a gate of its own first.
              </>}
        </p>
        {isSpecific ? (
          <Tooltip content="Discard this sample's own boundary and put it back on the shared gate. No other control is affected.">
            <Button
              variant="secondary"
              icon={<Link2 size={13} />}
              data-relink-general=""
              onClick={() => relinkGeneralGate(current.sampleId)}
            >
              Return to the shared gate
            </Button>
          </Tooltip>
        ) : (
          <Tooltip content="Give this sample its own copy of the boundary, starting from where the shared gate is now. Every other control keeps the shared one.">
            <Button
              variant="primary"
              icon={<Link2Off size={13} />}
              data-unlink-general=""
              onClick={() => unlinkGeneralGate(current.sampleId)}
            >
              Make this a data-specific gate
            </Button>
          </Tooltip>
        )}
      </div>

      {/* The checklist, so the walk has an overview and a way to jump.

          It also carries the shared-versus-own tag that used to be a
          standalone tile at the top of this step. Down here it is a *per row*
          fact, which is what it always was: the tile could only ever describe
          the one control you happened to be standing on, so answering "which of
          these has its own gate" meant clicking through all thirteen. The tag
          renders only on the rows that differ from the default, because a badge
          on every row is a column, and a column of one repeated word is not
          information. */}
      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">Controls</span>
          <span className="tnum">{done} of {controls.length} checked</span>
        </p>
        {controls.map((c, i) => {
          const ok = controlIsGated(c);
          const own = !!overrides[generalGateId ?? '']?.[c.sampleId];
          return (
            <button
              key={c.sampleId}
              type="button"
              data-walk-row={c.label}
              data-walk-done={ok ? '' : undefined}
              data-walk-gate={own ? 'own' : 'shared'}
              onClick={() => goToControl(i)}
              className={cn(
                'flex items-center gap-2 w-full px-2.5 h-7 text-left',
                i > 0 && 'hairline-t',
                i === index ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
              )}
            >
              <span className={cn('shrink-0', ok ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]')}>
                {ok ? <Check size={11} /> : <AlertTriangle size={11} />}
              </span>
              <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{c.label}</span>
              {own && (
                <Tooltip content="This control has its own cell gate rather than the shared one.">
                  <span className="shrink-0"><Badge tone="accent">own gate</Badge></span>
                </Tooltip>
              )}
              <span className="text-2xs font-mono text-[var(--text-disabled)] shrink-0">
                {c.role === 'stain' ? (c.peak?.name ?? '—') : ROLE_LABELS[c.role ?? 'stain']}
              </span>
            </button>
          );
        })}
      </div>

      {/*
         There is no auto-gate button here, and the absence is the change.

         Two lived here — *Re-seed this control's gate* and *Auto-gate anything
         ungated* — and neither had a state in which the operator wanted the
         other answer. Nobody wants a single stain left ungated; correcting a
         seeded gate is strictly less work than drawing one. So the seeding
         happens on arrival and on every move of the walk, for any single stain
         that has none, and a gate somebody has dragged is never touched again.
         See `ensureGated`.
      */}
      {/* Trimmed to the two facts somebody standing here needs (2026-08-11,
          Item 10): the gates were placed for you, and the two kinds of control
          get two different kinds of gate. What went was the machinery — "none of
          them is placed again once you have moved it", "the percentages follow
          as you drag" — both true, both about how the panel behaves rather than
          about what to do, and both discoverable by doing it once. */}
      <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
        Every gate on this step was placed for you. A stained control gets a gate around its bright cells; an
        unstained or autofluorescence control gets one around its main cloud, because there is nothing bright on it
        to find. Adjust anything that looks wrong and move on.
      </p>
    </div>
  );
}

/*
   `BaselinePopulation` is deleted (2026-08-10).

   It was a *Signature population* dropdown on the Gate step, offering the gates
   drawn under the general gate on an unstained or autofluorescence control, with
   a paragraph explaining what the choice meant. It was removed with the header
   block it sat inside — see the note in `StepGate` — because the case it covered
   is reachable without it: the clean-population gate the wizard seeds on that
   worksheet *is* the signature population, and dragging its edges is how it is
   narrowed. What went is the ability to swap to a *different* hand-drawn gate.

   `setControlGate` is untouched: it is still the one writer of `positiveGateId`,
   still called by `seedGates`, and still the action the tests and the harnesses
   drive that field through.
*/

/* ========================================================================== */

/** Step 4 — build the matrix, look at it, save it. */
function StepCompute({
  error, busy, onCompute, onApply,
}: {
  error: string | null;
  /** Non-null while the matrix is being built; spins the Compute button. */
  busy: string | null;
  onCompute: () => void;
  onApply: () => void;
}) {
  const copy = usePanelCopy();
  const spectra = useSpectral((s) => s.spectra);
  const controls = useSpectral((s) => s.controls);
  const computedAt = useSpectral((s) => s.computedAt);
  const readiness = useSpectral((s) => s.readiness);
  const [tab, setTab] = useState<'matrix' | 'similarity' | 'signatures'>('similarity');

  const ready = readiness();

  /*
     What the panel's *background* signature actually came from — read off the
     roles assigned in Step 2, not off the spectra (2026-08-11, Item 14).

     The reported bug: a panel built with an Unstained control and no
     Autofluorescence control at all showed "Autofluor. — yes" at the top of this
     step. Nothing was wrong with the maths and nothing was wrong with the
     spectrum. `ReferenceSpectrum.isAutofluorescence` means *this signature is
     the background one the solve puts cellular autofluorescence into*, and
     `computeMatrix` sets it for either baseline role, correctly — an unstained
     tube is exactly where that measurement comes from when there is no dedicated
     autofluorescence tube. The tile then rendered that flag under a heading
     naming one of the two roles, so a true statement about the matrix read as a
     false statement about the experiment.

     A tile summarising Step 2 has to answer with Step 2's own vocabulary, so it
     names the role that was assigned. `isAutofluorescence` is untouched — the
     similarity matrix, the export's antibody columns and the unmixed parameter
     list all depend on it meaning what it means.
  */
  const afControls = controls.filter((c) => c.role === 'autofluorescence').length;
  const unstainedControls = controls.filter((c) => c.role === 'unstained').length;
  const hasBaseline = afControls > 0 || unstainedControls > 0;
  /*
     Which tube signs, rather than how many are assigned (2026-08-16).

     The tile used to read *Both* when a panel carried an unstained file and an
     autofluorescence file, and so did the matrix: two rows measuring the same
     spectrum, cosine 0.999998 apart. `computeMatrix` now takes one of them —
     the explicitly-named autofluorescence tube — so the tile names that one and
     the hint accounts for the other rather than implying it is a second colour
     the solve resolves.
  */
  const bothBaselines = afControls > 0 && unstainedControls > 0;
  const background = afControls > 0 ? 'Autofluor.'
    : unstainedControls > 0 ? 'Unstained'
      : 'None';

  return (
    <div className="p-2.5 space-y-2.5" data-step-compute="">
      <div className="grid grid-cols-3 gap-1.5">
        <StatTile label="Gated controls" value={`${controls.filter(controlIsGated).length}/${controls.length}`} tone={ready.ready ? 'ok' : 'warn'} />
        <StatTile
          label="Signatures"
          value={spectra.length}
          tone={spectra.length > 0 ? 'accent' : 'neutral'}
          hint={computedAt ? `Computed ${new Date(computedAt).toLocaleString()}` : undefined}
        />
        <StatTile
          label="Background"
          value={background}
          tone={hasBaseline ? 'ok' : 'warn'}
          hint={bothBaselines
            ? 'The autofluorescence control is the background signature. The unstained control still measures per-detector noise for the weighted solve and is what each stain’s peak detector is judged against — but it does not enter the matrix as a second signature, because two rows of the same spectrum leave the panel unresolvable.'
            : hasBaseline
              ? 'The control the cell-background signature is measured from — whichever of the two roles you assigned in Step 2.'
              : 'No unstained or autofluorescence control is assigned, so the solve has nowhere to put cell background.'}
        />
      </div>

      {/* Step 4's instruction. "Each signature is the per-detector median of
          that sample's gated events" is an accurate sentence about an algorithm
          and tells the reader nothing about what to do or what they will get. */}
      <Callout
        tone={ready.ready ? 'ok' : 'warn'}
        title={ready.ready
          ? `Ready — ${ready.stainCount} antibod${ready.stainCount === 1 ? 'y' : 'ies'} checked`
          : 'Some controls still need checking'}
        actions={
          <Tooltip content={ready.ready ? 'Extract each signature from its gated population and build the matrix' : ''}>
            <span>
              <Button
                variant="primary"
                size="sm"
                icon={<Calculator size={12} />}
                disabled={!ready.ready || !!busy}
                loading={!!busy}
                data-compute-matrix=""
                onClick={onCompute}
              >
                {spectra.length > 0 ? 'Recompute' : `Compute ${copy.noun} matrix`}
              </Button>
            </span>
          </Tooltip>
        }
      >
        {ready.ready
          ? <>
              This reads the colour each antibody gives off, from the cells you gated on the previous step, and turns
              them into one matrix you can apply to your real samples.
              {!ready.hasUnstained && ' You have not assigned an unstained or autofluorescence control, so cell background will not be one of the colours it solves for.'}
            </>
          : <>Go back to the previous step and check {ready.ungated.join(', ')}.</>}
      </Callout>

      {error && <Callout tone="err" title="Could not compute the matrix">{error}</Callout>}

      {/* Keyed on the assigned roles for the same reason the tile is. This
          warning used to read `!spectra.some(s => s.isAutofluorescence)`, which
          is the right question about the matrix and the wrong one to put under
          a heading naming a control — and it meant the warning and the tile
          could never disagree about a panel that has an unstained tube, because
          both were reading the flag rather than the roles. */}
      {spectra.length > 0 && !hasBaseline && (
        <Callout tone="warn" title="No background signature">
          Assign an unstained or autofluorescence sample. Solving for cell background as one of the signatures
          resolves dim populations better than subtracting it.
        </Callout>
      )}

      {spectra.length > 0 && (
        <>
          {/* 2026-08-11, Item 13. "Save it so you can reuse it next week" put
              the two things a person can do here — apply it now, save it for
              later — as alternatives joined by "or", which they are not: saving
              is what makes the second one possible and applying costs nothing
              either way. The new sentence says the matrix is usable now and
              usable next time, which is the fact, and stops offering a choice
              between them.

              It became the pipeline's terminal banner on 2026-08-19 — same
              sentence, same button, the shape all four pipelines end in. */}
          <PipelineDone
            testId="data-unmixing-done"
            title={`${copy.title} complete`}
            actions={(
              <Button
                size="sm"
                variant="secondary"
                icon={<Play size={12} />}
                data-goto-apply=""
                onClick={onApply}
              >
                Apply it to a sample
              </Button>
            )}
            next={[
              { view: 'analysis', label: 'Analysis', hint: 'Plot the abundances on the worksheet' },
              { view: 'statistics', label: 'Statistics', hint: 'measure them across your samples' },
            ]}
          >
            The matrix is built from {spectra.length} signature{spectra.length === 1 ? '' : 's'}.
            Apply it to your real samples now, or save it below and use it next time without setting
            any of this up again.
          </PipelineDone>

          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'similarity', label: 'Similarity' },
              { value: 'signatures', label: 'Signatures' },
              { value: 'matrix', label: 'Save' },
            ]}
          />
          {tab === 'similarity' && <SimilarityMatrix />}
          {tab === 'signatures' && <SignatureViewerBound />}
          {tab === 'matrix' && <SaveMatrix />}
        </>
      )}
    </div>
  );
}

/** The signature viewer, wired to the store. */
function SignatureViewerBound() {
  const spectra = useSpectral((s) => s.spectra);
  const detectorNames = useSpectral((s) => s.detectorNames);
  const previewIds = useSpectral((s) => s.previewIds);
  const togglePreview = useSpectral((s) => s.togglePreview);
  const setPreviewIds = useSpectral((s) => s.setPreviewIds);
  return (
    <SignatureViewer
      detectorNames={detectorNames}
      previewIds={previewIds}
      onToggle={togglePreview}
      // One control with two states rather than two buttons: the answer to
      // "everything or nothing" is always the opposite of what is on screen, so
      // a pair would always have one member that does nothing.
      onSetAll={(on) => setPreviewIds(on ? spectra.map((s) => s.id) : [])}
    />
  );
}

/* ========================================================================== */

/**
 * The **From this file** tab — the matrix the acquisition software already
 * computed.
 *
 * ## Why this is the conventional panel's first screen (2026-08-27)
 *
 * Because for most conventional work it is the whole job, and because it is not
 * a shortcut. A FACSDiva export carries `$SPILLOVER`: a full spillover matrix
 * built from the same single-stain tubes, at the cytometer, by somebody
 * watching the plots — and it is written into every file the experiment
 * produced, so it is still there weeks later when the analysis happens. The
 * wizard beside this tab is what you use when that matrix is absent, or when
 * you disagree with it.
 *
 * It is also nearly free: the parser has read `$SPILLOVER` into
 * `metadata.spillover` since long before compensation existed, because the
 * matrix was worth showing as acquisition metadata even when nothing applied
 * it.
 *
 * The matrix is drawn rather than summarised. A spillover matrix is a picture —
 * a bright cell far from the diagonal is a pair of dyes that would be better
 * resolved on the instrument than in software — and *"13 × 13, worst 0.87"*
 * does not tell anyone which pair.
 */
function FileMatrixTab({
  samples,
  onBuildInstead,
}: {
  samples: Sample[];
  onBuildInstead: () => void;
}) {
  const { useFileMatrix, setTab, kind, spectra } = useSpectral();
  const selectedId = useWorkspace((s) => s.selectedSampleId);
  const [error, setError] = useState<string | null>(null);

  /*
     Which file to read it from, defaulting to the one already selected.

     A panel's tubes all carry the same matrix — it is a property of the
     acquisition settings, not of the tube — so this is almost always a
     formality. It is a control rather than an assumption because "almost
     always" is not always: a workspace can hold two experiments, and the
     matrix that gets applied should be one somebody chose.
  */
  const withMatrix = useMemo(
    () => samples.filter((s) => !!matrixFromFile(s.parsed.metadata)),
    [samples],
  );
  const [pickedId, setPicked] = useState<string | null>(null);
  const source = withMatrix.find((s) => s.id === pickedId)
    ?? withMatrix.find((s) => s.id === selectedId)
    ?? withMatrix[0]
    ?? null;
  const matrix = source ? matrixFromFile(source.parsed.metadata) : null;
  const worst = matrix ? worstSpillover(matrix) : null;

  if (samples.length === 0) {
    return (
      <EmptyState
        className="mt-10"
        icon={<Grid3x3 size={19} />}
        title="No conventional samples loaded"
        description="This tab reads the spillover matrix out of a file's own metadata, so it needs a file."
      />
    );
  }

  if (!matrix || !source) {
    return (
      <EmptyState
        className="mt-10"
        icon={<Grid3x3 size={19} />}
        title="No matrix in these files"
        description={
          samples.some((s) => s.parsed.metadata.spillover)
            ? 'Every loaded file carries an identity spillover matrix, which means the acquisition software had nothing to correct. Build one from single-stain controls instead.'
            : 'None of the loaded files carries a $SPILLOVER keyword. Build a matrix from single-stain controls instead.'
        }
        action={<Button variant="secondary" onClick={onBuildInstead}>Build from controls</Button>}
      />
    );
  }

  return (
    <div className="p-3 space-y-3" data-file-matrix="">
      <div className="flex items-end gap-2 flex-wrap">
        <Field label="Read the matrix from" className="min-w-[16rem]">
          <Select
            value={source.id}
            onChange={(e) => { setPicked(e.target.value); setError(null); }}
          >
            {withMatrix.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <div className="flex-1" />
        <Button
          variant="primary"
          icon={<Check size={12} />}
          data-use-file-matrix=""
          onClick={() => {
            const r = useFileMatrix(source);
            setError(r.ok ? null : r.message ?? 'Could not read the matrix.');
            // Straight on to the screen that chooses what to apply it to,
            // which is the next thing anybody wants and is already built.
            if (r.ok) setTab('load');
          }}
        >
          Use this matrix
        </Button>
      </div>

      {error && <Callout tone="warn" title="Not applied">{error}</Callout>}

      {kind === 'compensation' && spectra.length > 0 && (
        <Callout tone="ok" title="Matrix ready">
          {spectra.length} detectors. Choose which samples to compensate on the {'Load matrix'} tab.
        </Callout>
      )}

      <div className="flex gap-2 flex-wrap">
        <StatTile label="Matrix" value={`${matrix.size} × ${matrix.size}`} />
        <StatTile
          label="Largest spillover"
          value={worst ? `${(worst.value * 100).toFixed(1)}%` : '—'}
          hint={worst ? `${matrix.detectors[worst.from]} into ${matrix.detectors[worst.to]}` : undefined}
        />
        <StatTile
          label="Acquisition"
          value={source.parsed.metadata.compensationApplied ? 'APPLY COMPENSATION = TRUE' : 'not flagged'}
          hint="What the acquisition software recorded about whether this matrix should be applied."
        />
      </div>

      <SpilloverGrid matrix={matrix} />

      <p className="text-2xs text-[var(--text-tertiary)] leading-relaxed">
        Row <em>i</em>, column <em>j</em> is the fraction of the dye measured on detector <em>i</em> that
        appears in detector <em>j</em>. The diagonal is 1 by definition, so a compensated value stays in
        its own detector&rsquo;s units and a gate drawn on the raw channel still means something.
      </p>
    </div>
  );
}

/**
 * The matrix, drawn.
 *
 * Tinted by magnitude rather than plotted, because the question somebody has in
 * front of a spillover matrix is *where* rather than *how much*: the diagonal is
 * 1 everywhere and carries no information, and what matters is whether anything
 * off it is large. A number is still printed in every cell — a heat map that
 * cannot be read exactly is a decoration.
 *
 * `overflow-x` on the wrapper rather than a smaller font: thirteen columns fit
 * and sixty-four do not, and a panel that scrolls sideways is better than one
 * whose labels are unreadable.
 */
function SpilloverGrid({ matrix }: { matrix: { detectors: string[]; values: Float64Array; size: number } }) {
  const short = (s: string) => (s.length > 14 ? `${s.slice(0, 13)}…` : s);
  return (
    <div className="overflow-x-auto hairline rounded-[var(--radius-md)]" data-spillover-grid="">
      <table className="text-2xs tnum border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-[var(--surface-raised)] px-2 py-1 text-left font-medium text-[var(--text-tertiary)]">
              into &rarr;
            </th>
            {matrix.detectors.map((d) => (
              <th key={d} title={d} className="px-1.5 py-1 font-medium text-[var(--text-tertiary)] font-mono whitespace-nowrap">
                {short(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.detectors.map((row, i) => (
            <tr key={row}>
              <th
                title={row}
                className="sticky left-0 z-10 bg-[var(--surface-raised)] px-2 py-1 text-left font-medium text-[var(--text-secondary)] font-mono whitespace-nowrap"
              >
                {short(row)}
              </th>
              {matrix.detectors.map((col, j) => {
                const v = matrix.values[i * matrix.size + j] ?? 0;
                const diagonal = i === j;
                return (
                  <td
                    key={col}
                    data-spill={diagonal ? 'diagonal' : v !== 0 ? 'on' : 'off'}
                    className={cn(
                      'px-1.5 py-1 text-center whitespace-nowrap',
                      diagonal ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
                    )}
                    style={diagonal || v === 0 ? undefined : {
                      // The accent at an opacity that follows the coefficient,
                      // so the eye finds the large ones without a second legend
                      // to consult. Floored so a real but small coefficient is
                      // still visibly not zero.
                      background: `color-mix(in srgb, var(--accent-base) ${Math.min(60, 8 + Math.abs(v) * 60).toFixed(0)}%, transparent)`,
                    }}
                  >
                    {v === 0 ? '·' : diagonal ? '1' : v.toFixed(3).replace(/^0/, '')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The **Load unmixing** tab — open a saved matrix and apply it here.
 *
 * The whole of what used to be Step 5, minus the implication that it follows the
 * other four. Two things happen on this screen and they are independent: getting
 * a matrix (from a file, or from the wizard beside it) and putting it on a
 * sample in this workspace. Neither needs a new window, which is what somebody
 * already looking at their multicolour data was otherwise being asked to open.
 */
function LoadUnmixingTab({
  spectralSamples,
}: {
  spectralSamples: ReturnType<typeof useWorkspace.getState>['samples'];
}) {
  const copy = usePanelCopy();
  const {
    spectra, controls, unmixed, running, failures, computedAt, loadedFrom, weights,
    runUnmixing, clearUnmixed,
  } = useSpectral();
  const samples = useWorkspace((s) => s.samples);

  /*
     Which samples to unmix, and this is where the wizard's own bookkeeping earns
     its keep.

     A sample is a reference control because somebody ticked it in Step 1, so
     "everything that is not a control" is a fact rather than a filename guess —
     which is exactly what the old panel could not say. It had to ask
     `classifyControl` all over again here, and got a different answer whenever
     the guess and the user disagreed. A matrix loaded from a file has no local
     controls at all, so every spectral sample is a candidate, which is right.
  */
  const controlIds = new Set(controls.map((c) => c.sampleId));
  const suggested = useMemo(
    () => {
      const targets = spectralSamples.filter((s) => !controlIds.has(s.id));
      return (targets.length > 0 ? targets : spectralSamples).map((s) => s.id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spectralSamples, controls],
  );

  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? suggested;
  const toUnmix = spectralSamples.filter((s) => chosen.includes(s.id));

  return (
    <div className="p-2.5 space-y-2.5" data-step-apply="">
      <LoadMatrix />

      {/* The tab's own copy, cut to what somebody standing here needs.

          It used to explain that a matrix "belongs to an instrument
          configuration, so one saved on another machine applies here
          unchanged", and that the detector configuration is validated on load,
          and that reference controls start unticked because they are what the
          matrix was built from. All true, all reasoning about the design rather
          than instructions for the task: open a file, tick some samples, press
          the button. Anything a reader genuinely needs at the moment it matters
          — an incompatible instrument, a sample with no matrix — is reported
          then, by the thing that found it. */}
      {spectra.length === 0 ? (
        <Callout tone="warn" title="No matrix loaded yet">
          Open a saved <code>{copy.extension}</code> file above, or build one in the <strong>{copy.newTab}</strong> tab.
        </Callout>
      ) : (
        <>
          <Callout
            tone="ok"
            title={loadedFrom
              ? `“${loadedFrom.name}” — ${spectra.length} colours`
              : `${spectra.length} colours, built in this workspace`}
          >
            {loadedFrom
              ? <>Saved {new Date(loadedFrom.savedAt).toLocaleString()}.{loadedFrom.path ? <span className="block font-mono text-2xs truncate">{loadedFrom.path}</span> : null}</>
              : <>Built {computedAt ? new Date(computedAt).toLocaleString() : 'in this session'} from your controls.</>}
          </Callout>

          <div className="space-y-1.5">
            {/* The same two actions the wizard's Step 1 list has carried since it
                was written, and for the same reason: a panel of fourteen files
                is ticked or cleared wholesale far more often than one row at a
                time, and a list that offers the bulk action on one screen and
                not the other teaches that the two lists are different kinds of
                thing when they are the same kind of thing. */}
            <div className="flex items-center gap-2">
              <p className="text-2xs font-medium text-[var(--text-secondary)] flex-1 min-w-0">
                Apply to these samples
                <InfoHint content={`Your control tubes start unticked — they are what the matrix was built from — but running one through is a fair way to check it worked.`} />
              </p>
              <Badge mono>{chosen.length} of {spectralSamples.length}</Badge>
              <Button
                size="sm"
                variant="ghost"
                data-apply-select-all=""
                disabled={spectralSamples.length === 0 || chosen.length === spectralSamples.length}
                onClick={() => setPicked(spectralSamples.map((s) => s.id))}
              >
                Select all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-apply-clear-all=""
                disabled={chosen.length === 0}
                // `[]`, not `null`: null means "no choice has been made yet" and
                // falls back to the suggestion, so clearing to it would re-tick
                // every non-control sample the moment it was pressed.
                onClick={() => setPicked([])}
              >
                Clear all
              </Button>
            </div>
            {spectralSamples.length === 0 ? (
              <p className="text-2xs text-[var(--text-tertiary)]">
                No {copy.sampleKind} sample is loaded. Import a multicolour sample and it will be checked
                against this matrix&rsquo;s detector configuration first.
              </p>
            ) : (
              <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden max-h-[220px] overflow-y-auto">
                {spectralSamples.map((s, i) => {
                  const on = chosen.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      data-apply-candidate={s.name}
                      data-selected={on ? '' : undefined}
                      /*
                         The functional form, and it is not a style preference.
                         Two rows ticked inside one event-loop turn both read the
                         list their render closed over, so the second write
                         discards the first and "tick two" ticks one. Recorded in
                         PROGRESS.md under 2026-08-04, Item 9, and hit again
                         here.
                      */
                      onClick={() => setPicked((prev) => {
                        const from = prev ?? suggested;
                        return from.includes(s.id)
                          ? from.filter((x) => x !== s.id)
                          : [...from, s.id];
                      })}
                      className={cn(
                        'flex items-center gap-2.5 w-full px-2.5 h-8 text-left',
                        i > 0 && 'hairline-t',
                        on ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]',
                      )}
                    >
                      <CheckboxGlyph checked={on} />
                      <span className={cn('text-xs truncate min-w-0 flex-1', on ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
                        {s.name}
                      </span>
                      {controlIds.has(s.id) && <Badge tone="info">reference</Badge>}
                      {unmixed[s.id] && <Badge tone="accent">{copy.verbPast}</Badge>}
                      <span className="text-2xs tnum text-[var(--text-disabled)] shrink-0">
                        {s.parsed.metadata.eventCount.toLocaleString('en-US').replace(/,/g, ' ')}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="primary"
              icon={<Play size={13} />}
              loading={running.active}
              disabled={toUnmix.length === 0}
              data-apply-matrix=""
              onClick={() => void runUnmixing(toUnmix)}
            >
              {copy.verbTitle} {toUnmix.length} sample{toUnmix.length === 1 ? '' : 's'}
            </Button>
            {Object.keys(unmixed).length > 0 && (
              <Button variant="ghost" size="sm" icon={<X size={12} />} onClick={clearUnmixed}>Clear results</Button>
            )}
            {/*
                What the solve is, and the two are genuinely different claims.

                A spectral panel fits thirteen dyes across sixty-four detectors
                and weights each by its noise, so the method is worth naming and
                the absent-weights case is worth warning about. A compensation
                matrix is square: there is one solution and no residual to
                weight, so "weighted least squares" would describe nothing and
                the missing-unstained warning would be about a fit that is not
                happening. It says what it does instead.
            */}
            <span className="ml-auto text-2xs text-[var(--text-tertiary)]" data-unmix-method="">
              {copy.noun === 'compensation' ? (
                <>
                  Method: matrix inverse
                  <InfoHint content="A compensation matrix is square — one dye per detector — so the spillover is removed by inverting it exactly. There is no residual to weight and no fit to be under-determined; the compensated value is in its own detector's units." />
                </>
              ) : (
                <>
                  Method: weighted least squares
                  <InfoHint content={weights
                    ? 'Each detector is weighted by the inverse of its variance in the unstained sample, so a noisy channel contributes less to the fit than a quiet one. This is the standard treatment for photon-counting detectors, whose noise grows with the signal they carry.'
                    : 'Weighted least squares, weighting each detector by the inverse of its variance. No unstained or autofluorescence sample is assigned, so there are no weights to apply and this run is an unweighted fit.'} />
                  {!weights && <span className="text-[var(--status-warn)]"> · unweighted, no unstained sample</span>}
                </>
              )}
            </span>
          </div>

          {running.active && (
            <ProgressBar
              value={running.done}
              max={running.total}
              label={running.current ? `${copy.verbing} ${running.current}` : copy.verbing}
              detail={`${running.done} / ${running.total}`}
            />
          )}

          {failures.length > 0 && (
            <Callout tone="err" title={`${failures.length} sample(s) failed to ${copy.verb}`}>
              <ul className="space-y-1">
                {failures.slice(0, 3).map((f) => (
                  <li key={f.sampleId}>
                    <strong className="text-[var(--text-primary)]">{f.sampleName}</strong> — {f.message}
                    {f.hint && <span className="block text-[var(--text-tertiary)]">{f.hint}</span>}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {Object.keys(unmixed).length > 0 && (
            /*
               Plainer wording than the sentence that stood here, and — as of
               2026-08-09 — true. It used to say the parameters were "on every
               axis picker in this window, named with the identities the matrix
               carries", which was a correct description of a thing that was not
               happening: the abundances were written into a store record nothing
               outside this panel read, so the Analysis tab went on offering the
               same seventy-one raw detectors. See `attachUnmixed`.
            */
            <Callout tone="ok" title={`${Object.keys(unmixed).length} sample(s) ${copy.verbPast}`}>
              Pick these on any plot axis. They are named after the matrix&rsquo;s rows and tagged{' '}
              <strong>{copy.tag}</strong>; the raw detectors are still there, tagged <strong>Raw</strong>.
            </Callout>
          )}

          <SignatureViewerBound />
        </>
      )}

      {samples.length === 0 && loadedFrom && (
        <Callout tone="accent" title="Matrix ready, no samples yet">
          “{loadedFrom.name}” is loaded. Import a multicolour sample and it will be checked against this matrix&rsquo;s
          detector configuration before {copy.verbing.toLowerCase()}.
        </Callout>
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * Write the current matrix out as a standalone `.unmixing` or `.compensation`.
 *
 * The matrix belongs to an instrument configuration, not to one afternoon's
 * workspace: the same eight-colour panel gets run every week against a new
 * sample. So it is saved as its own file, self-documenting enough to be read
 * cold months later, and reloadable into any workspace including an empty one.
 *
 * **Which extension is not decided here.** `saveUnmixingMatrixToFile` reads it
 * off the matrix itself, so a square one saves as `.compensation` from whichever
 * screen pressed the button; this component only says which word to expect.
 */
function SaveMatrix() {
  const spectra = useSpectral((s) => s.spectra);
  const copy = usePanelCopy();
  const [name, setName] = useState(copy.noun === 'compensation' ? 'Compensation panel' : 'Unmixing panel');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const doSave = async () => {
    setBusy(true);
    setResult(null);
    try {
      const path = await saveUnmixingMatrixToFile(name.trim() || `${copy.title} panel`);
      if (path) setResult({ tone: 'ok', text: `Saved to ${path}` });
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-2.5 space-y-2.5">
      <p className="text-2xs text-[var(--text-tertiary)] max-w-[70ch]">
        A saved matrix is a standalone <code>{copy.extension}</code> file, separate from the workspace. It carries the
        rows, the detector configuration, the instrument, the similarity matrix and a record of which files produced
        it, and loads into any workspace including an empty one.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <Field label="Panel name" className="min-w-[220px]">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main panel"
            className="h-7 w-full px-2 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] text-xs text-[var(--text-primary)]"
          />
        </Field>
        <Tooltip content={spectra.length === 0
          ? 'Compute a matrix first — there is nothing to save yet.'
          : `Write this matrix to a portable ${copy.extension}`}>
          <span>
            <Button
              variant="primary"
              icon={<Save size={13} />}
              disabled={spectra.length === 0 || busy}
              data-save-matrix=""
              onClick={() => void doSave()}
            >
              Save {copy.matrixNoun}…
            </Button>
          </span>
        </Tooltip>
      </div>

      {result && (
        <Callout tone={result.tone} title={result.tone === 'ok' ? 'Saved' : 'Could not save'}>
          {result.text}
        </Callout>
      )}
    </div>
  );
}

/**
 * Open a saved matrix — from the file picker, or from the reuse list.
 *
 * The reuse list is what a lab running the same panel weekly actually uses; it
 * is `localStorage`, so it is a convenience index rather than data, and losing
 * it costs one trip through the picker.
 */
function LoadMatrix() {
  const copy = usePanelCopy();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'err'; text: string; detail?: string[] } | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const report = (r: { report: { applied: boolean; message: string; checks: Array<{ sampleName: string; report: { ok: boolean; message: string } }> } }) => {
    setResult({
      tone: r.report.applied ? 'ok' : 'err',
      text: r.report.message,
      // Per-sample verdicts, because a workspace can legitimately hold files
      // from two instruments and "incompatible" alone would not say which.
      detail: r.report.checks.filter((c) => !c.report.ok).map((c) => `${c.sampleName}: ${c.report.message}`),
    });
  };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="primary"
          icon={<FolderOpen size={13} />}
          disabled={busy}
          data-load-matrix=""
          onClick={() => void run(async () => {
            const r = await loadUnmixingMatrixFromFile(copy.model);
            if (r) report(r);
          })}
        >
          Load {copy.matrixNoun}…
        </Button>
        {/* This panel's own extension, which the dialog offers first.

            It is not the only one accepted, and the chip does not claim to be:
            the two are one format, and `requireMatrixExtension` takes either
            because every square matrix saved before 2026-08-29 is a `.unmixing`.
            What the chip is for is naming what a save from *here* writes.
            `.mcflow.unmixing` and `.fcunmix.json` are neither offered nor read;
            see `UNMIX_FILE_EXTENSION` for why the compatibility went with the
            rename that time. */}
        <span className="text-2xs text-[var(--text-tertiary)]">
          <code>{copy.extension}</code>
        </span>
      </div>

      {result && (
        <Callout
          tone={result.tone}
          title={result.tone === 'ok' ? 'Loaded' : 'Could not apply this matrix'}
        >
          {result.text}
          {result.detail && result.detail.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {result.detail.slice(0, 5).map((d, i) => (
                <li key={i} className="text-2xs text-[var(--text-tertiary)]">{d}</li>
              ))}
            </ul>
          )}
        </Callout>
      )}

      {/*
         *Recently used* is removed (2026-08-10).

         It was a list of every matrix saved or loaded on this machine, with a
         per-row badge pair, a cytometer tag, a date, a Load button and a Forget
         button — a second file browser, above the file dialog, listing files by
         a name that is not necessarily their filename. Three things were wrong
         with it. It was `localStorage`, so it was per machine and per browser
         profile and could not be relied on. It went stale silently: a row
         survives the file being moved or deleted and fails on press. And the
         thing it was a shortcut *to* is one button away with the real filename,
         the real folder and the OS's own search.

         `recentMatrices`, `forgetMatrix` and `loadUnmixingMatrixByPath` stay in
         `unmixingIO` — the last of those is how a workspace re-loads the matrix
         it recorded a path to.
      */}
    </div>
  );
}

/* ========================================================================== */

/**
 * Pairwise similarity heatmap.
 *
 * Standard pre-unmixing QC: a pair above ~0.98 is effectively inseparable and
 * the panel needs redesigning, so the scale is deliberately compressed into the
 * high end where the decisions actually live.
 *
 * ## Fluorophores only
 *
 * Autofluorescence and unstained are **excluded from the rows, the columns and
 * the hardest-pair callout** as of 2026-08-08, and that is a correction rather
 * than a simplification. This view answers one question — *can these dyes be
 * told apart from each other?* — and neither of those is a dye. They are in the
 * matrix to give the solve somewhere to put the background, which is what makes
 * the real signatures separate better; they are not competing with anything for
 * an event's abundance in the way two fluorophores are.
 *
 * Including them was actively misleading: an unstained tube and an
 * autofluorescence tube measure the same thing, so they come out at 1.0000 and
 * won the "hardest pair" callout on every real panel — a red warning, at the top
 * of the QC view, describing a result that is correct and expected. It hid the
 * pair that mattered.
 *
 * Nothing about the *computation* changes. Both still contribute to the matrix
 * exactly as before, and the saved file still records the full similarity matrix
 * including them.
 */
function SimilarityMatrix() {
  const all = useSpectral((s) => s.spectra);
  const spectra = useMemo(() => all.filter((s) => !s.isAutofluorescence), [all]);
  const sim = useMemo(() => similarityMatrix(spectra), [spectra]);
  const worst = useMemo(() => worstPair(spectra, sim), [spectra, sim]);
  const n = spectra.length;
  const excluded = all.length - n;

  if (n < 2) {
    return (
      <EmptyState
        size="sm"
        className="mt-8"
        icon={<Waves size={15} />}
        title="Assign at least two single stains"
        description="The similarity matrix compares fluorophore signatures against each other. Autofluorescence and unstained are not compared — they are not being told apart from anything."
      />
    );
  }

  const cellColor = (v: number) => {
    // 0.8 -> transparent, 1.0 -> full warning. Below 0.8 is never a problem.
    const t = Math.max(0, Math.min(1, (v - 0.8) / 0.2));
    return `color-mix(in srgb, var(--status-err) ${(t * 78).toFixed(1)}%, transparent)`;
  };

  return (
    <div className="p-2.5 space-y-3">
      {worst && (
        <Callout tone={worst.value > 0.98 ? 'err' : worst.value > 0.9 ? 'warn' : 'ok'}>
          Hardest pair: <strong className="text-[var(--text-primary)]">{spectra[worst.a]!.label}</strong> and{' '}
          <strong className="text-[var(--text-primary)]">{spectra[worst.b]!.label}</strong> at{' '}
          <span className="font-mono">{worst.value.toFixed(4)}</span>.{' '}
          {worst.value > 0.98
            ? 'Above 0.98 these are effectively inseparable — expect heavy spreading between them.'
            : worst.value > 0.9
              ? 'Resolvable, but expect measurable spreading error between these two.'
              : 'Well separated across the whole panel.'}
        </Callout>
      )}

      <div className="overflow-auto">
        <table className="border-collapse text-[10px] font-mono tnum" data-similarity-matrix="">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--surface-base)] px-1.5 h-6" />
              {spectra.map((s) => (
                <th key={s.id} title={s.label} className="px-1 h-6 min-w-[44px] font-normal text-[var(--text-tertiary)]">
                  {s.label.split(' ')[0]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spectra.map((row, i) => (
              <tr key={row.id}>
                <th
                  data-similarity-row={row.label}
                  className="sticky left-0 z-10 bg-[var(--surface-base)] px-1.5 h-[22px] text-left font-normal text-[var(--text-secondary)] whitespace-nowrap"
                >
                  {row.label}
                </th>
                {spectra.map((col, j) => {
                  const v = sim[i * n + j]!;
                  return (
                    <td
                      key={col.id}
                      title={`${row.label} × ${col.label} = ${v.toFixed(4)}`}
                      style={{ background: i === j ? 'var(--surface-active)' : cellColor(v) }}
                      className={cn(
                        'h-[22px] px-1 text-right',
                        i === j ? 'text-[var(--text-disabled)]' : 'text-[var(--text-primary)]',
                      )}
                    >
                      {i === j ? '—' : v.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-2xs text-[var(--text-tertiary)] flex items-center gap-2">
        <AlertTriangle size={11} className="text-[var(--status-warn)]" />
        Cosine similarity between normalised signatures — the similarity index spectral instruments report. Shading
        starts at 0.80.
        {excluded > 0 && ' Autofluorescence and unstained are left out: they are not fluorophores being told apart from each other, and they always resemble one another.'}
      </p>
    </div>
  );
}

/* ========================================================================== */

const POP_COLORS = Array.from({ length: 12 }, (_, i) => `var(--pop-${String(i + 1).padStart(2, '0')})`);

/** Height of the signature plot's drawing area, chrome excluded. */
const SIGNATURE_H = 356;
/**
 * The bottom margin carries a rotated detector name under every tick.
 *
 * 42 px until 2026-08-16, when the axis stopped saying only *Detectors*. A
 * six-character name at 8.5 px rotated 60° stands about 28 px tall, and the axis
 * title sits under that.
 */
const SIGNATURE_MARGIN = { l: 46, r: 16, t: 22, b: 62 };
/** Below this the plot scrolls sideways rather than compressing further. */
const SIGNATURE_MIN_W = 720;
/** Horizontal room one rotated detector name needs. Sets the label thinning. */
const DETECTOR_LABEL_PITCH = 11;

/**
 * The Aurora's five laser blocks, as half-open ranges over the detector axis.
 *
 * Named here rather than as four boundary indices, because the plot now labels
 * each block as well as ruling between them and two derivations of the same
 * five spans is exactly how a rule and a caption come to disagree.
 */
const LASER_BLOCKS: Array<{ name: string; from: number; to: number }> = [
  { name: 'UV', from: 0, to: 16 },
  { name: 'V', from: 16, to: 32 },
  { name: 'B', from: 32, to: 46 },
  { name: 'YG', from: 46, to: 56 },
  { name: 'R', from: 56, to: 64 },
];

/**
 * Full-spectrum signature viewer.
 *
 * The primary exploration view on a spectral platform and the one thing
 * conventional-panel software has no equivalent for: normalised median intensity
 * across every detector, overlaid so spectral shapes can be compared directly.
 *
 * Three things changed on 2026-08-08 and each answers the same complaint — that
 * the plot was hard to read:
 *
 *   - **It fills the panel.** The width was a hard-coded 900 px inside a
 *     horizontally scrolling box, so sixty-four detectors were squeezed into
 *     ~840 px however much room the window had. It is measured now.
 *   - **Every line is drawn.** `previewIds` opened with the first four
 *     signatures of thirteen. See `computeMatrix`.
 *   - **Hovering names the nearest line.** Twelve palette colours around
 *     thirteen signatures means two lines share a colour, and even where they do
 *     not, a legend twenty inches from the curve is not how anybody reads a
 *     chart. The label follows the cursor and names what is under it.
 */
function SignatureViewer({
  detectorNames, previewIds, onToggle, onSetAll,
}: {
  /** `$PnN` per matrix column. Shorter than the signature is tolerated. */
  detectorNames: string[];
  previewIds: string[];
  onToggle: (id: string) => void;
  /** Show every signature, or none of them. */
  onSetAll: (on: boolean) => void;
}) {
  const spectra = useSpectral((s) => s.spectra);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(980);
  const [hover, setHover] = useState<{ x: number; y: number; index: number; detector: number } | null>(null);

  /*
     Measured rather than assumed, and re-measured on resize.

     `ResizeObserver` is delivered on the rendering pipeline, so in a hidden
     harness window it is throttled with everything else — which is fine here
     because the fallback is a sensible fixed width and nothing about the plot's
     correctness depends on the measurement. The trap is recorded in PROGRESS.md
     for anything that *polls* for a settled layout.
  */
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.max(SIGNATURE_MIN_W, Math.round(el.clientWidth - 16));
      setWidth((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = spectra.filter((s) => previewIds.includes(s.id));
  const allShown = spectra.length > 0 && shown.length === spectra.length;
  const D = spectra[0]?.values.length ?? 0;

  if (D === 0) {
    return <EmptyState size="sm" className="mt-8" icon={<Waves size={15} />} title="No signatures to show" description="Assign at least one reference control." />;
  }

  const W = width, H = SIGNATURE_H, M = SIGNATURE_MARGIN;
  const pw = W - M.l - M.r, ph = H - M.t - M.b;
  const x = (d: number) => M.l + (D <= 1 ? 0 : (d / (D - 1)) * pw);
  const y = (v: number) => M.t + ph - v * ph;

  const path = (values: Float64Array) =>
    Array.from(values, (v, d) => `${d === 0 ? 'M' : 'L'}${x(d).toFixed(2)},${y(v).toFixed(2)}`).join(' ');

  // Laser-block boundaries on an Aurora: UV16 | V16 | B14 | YG10 | R8.
  const blocks = D === 64 ? LASER_BLOCKS : [];

  /**
   * The detector name at a column, or its position when the matrix predates the
   * store carrying names.
   */
  const detectorAt = (d: number) => detectorNames[d] ?? `#${d + 1}`;
  /** Every nth detector gets a name and a grid line; the rest get a tick. */
  const labelEvery = Math.max(1, Math.ceil(D / Math.max(1, Math.floor(pw / DETECTOR_LABEL_PITCH))));

  /**
   * The visible line closest to the cursor.
   *
   * Nearest in *y at the cursor's detector*, not nearest in two dimensions: the
   * curves are dense functions of one variable, so the meaningful question at a
   * given detector is which of them passes closest to the pointer's height. A
   * true 2D nearest-point search over sixty-four samples per curve would answer
   * the same question more slowly and would jump to a neighbouring detector's
   * value near a steep edge.
   */
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px < M.l || px > M.l + pw || py < M.t || py > M.t + ph || shown.length === 0) {
      setHover(null);
      return;
    }
    const d = Math.max(0, Math.min(D - 1, Math.round(((px - M.l) / pw) * (D - 1))));
    let best = -1;
    let bestDist = Infinity;
    for (const s of shown) {
      const dist = Math.abs(y(s.values[d] ?? 0) - py);
      if (dist < bestDist) { bestDist = dist; best = spectra.indexOf(s); }
    }
    setHover(best < 0 ? null : { x: px, y: py, index: best, detector: d });
  };

  const hovered = hover ? spectra[hover.index] : null;

  /**
   * Everything the image exporter needs.
   *
   * The same three formats, the same resolution ladder and the same two switches
   * every other figure in the application is written with — because this is a
   * figure like any other, and it is the one somebody actually publishes: a
   * panel's signatures, normalised, across every detector, which is the plot no
   * conventional-platform software has an equivalent for. It could only leave
   * here as a screenshot.
   *
   * Simpler than every other snapshot in the application, and worth saying why:
   * this figure is **pure vector**. There is no event bitmap under it, so
   * `underlays` is empty and `scale` changes nothing about what is drawn — a PNG
   * is the same geometry rasterised at more device pixels, and the PDF and SVG
   * carry the paths themselves. Nothing has to be repainted at export
   * resolution the way the spectrum heatmap does.
   *
   * `axes: null` for the reason the spectrum panel gives: both names are already
   * `<text>` inside this SVG — the axes here are a detector index and an
   * intensity, neither of which is a picker in a margin — so handing them to the
   * exporter would print each one twice in the same place.
   */
  const buildSnapshot = useCallback((): PlotSnapshot | null => {
    const svg = svgRef.current;
    if (!svg || spectra.length === 0) return null;
    return {
      svg,
      width: W,
      height: H,
      underlays: [],
      // The box's own surface, resolved here and handed over rather than painted
      // into the SVG: a rect inside the element would survive the transparency
      // switch and defeat it.
      background: getComputedStyle(svg).getPropertyValue('--surface-plot').trim() || '#ffffff',
      // What is drawn and what it is, since the chip row naming the visible
      // signatures is HTML above the plot and is in no exported file.
      caption: [
        shown.length === spectra.length
          ? `${spectra.length} signatures`
          : `${shown.length} of ${spectra.length} signatures`,
        `Normalised median fluorescence intensity across ${D} detectors`,
      ].join(CAPTION_SEP),
      axes: null,
      fileStem: { sample: 'signatures', x: `${spectra.length}`, y: '' },
    };
  }, [spectra.length, shown.length, D, W, H]);

  return (
    <div className="p-2.5 space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {spectra.map((s, i) => (
          <button
            key={s.id}
            onClick={() => onToggle(s.id)}
            data-signature-toggle={s.label}
            data-signature-shown={previewIds.includes(s.id) ? '' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 px-1.5 h-5 rounded-[var(--radius-xs)] text-2xs',
              previewIds.includes(s.id)
                ? 'text-[var(--text-primary)] bg-[var(--surface-hover)]'
                : 'text-[var(--text-disabled)] hover:text-[var(--text-secondary)]',
              hover?.index === i && 'ring-1 ring-[var(--accent-500)]',
            )}
          >
            <ColorChip color={POP_COLORS[i % 12]!} size={8} />
            {s.label}
          </button>
        ))}
      </div>

      {/*
         Show all / show none, in a toolbar row above the plot.

         Every line arrives visible, which is right — the question the plot
         answers is "do any two of these have the same shape", and that is a
         question about the whole panel. What was missing is the way *back*
         from a subset: hiding twelve of thirteen names to look at one meant
         twelve clicks, and putting them back meant twelve more. The chips
         above stay exactly as they are; this is the bulk gesture beside them.

         It sat at `absolute right-3 top-3` **inside** the plot box until
         2026-08-12, and that overlapped the data: a signature's peak is
         wherever its dye emits, so the upper right of this plot is occupied
         whenever the panel carries a red-laser dye — which is to say on every
         real panel. A control that covers the measurement it is a control for
         has to move, and there is no free corner to move it to, because all
         four are inside the plot.

         Its own row, rather than back in with the chips: both of the reasons
         it was floated in the first place still hold. It is not one of the
         chips — it acts on all of them — and the chip row wraps to two or
         three lines on a thirteen-signature panel, which would put the control
         somewhere different every time the panel changed width. A dedicated
         row is fixed against both.
      */}
      <div className="flex items-center justify-end gap-1.5 -mb-1">
        {/*
           Beside *Select all* rather than floating over the plot, for the reason
           recorded just above: every corner of this drawing is occupied on a
           real panel. `PlotImageExport` is the same component the worksheet's
           plots use, so a signature plot, a density plot and a compare chart
           dropped onto one page match without anything here restating what a
           figure is.
        */}
        <PlotImageExport snapshot={buildSnapshot} disabled={spectra.length === 0} />
        <button
          type="button"
          data-signature-select-all=""
          data-signature-state={allShown ? 'all' : 'partial'}
          onClick={() => onSetAll(!allShown)}
          title={allShown
            ? 'Hide every signature — then click a name above to bring one back'
            : 'Show every signature'}
          className={cn(
            'h-5 px-1.5 rounded-[var(--radius-xs)] text-2xs',
            'border border-[var(--border-subtle)] bg-[var(--surface-overlay)]',
            'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent-500)]',
            'transition-colors duration-[var(--dur-fast)]',
          )}
        >
          {allShown ? 'Select none' : 'Select all'}
        </button>
      </div>

      <div
        ref={boxRef}
        className="relative rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-plot)] p-2 overflow-x-auto"
      >
        <svg
          ref={svgRef}
          width={W}
          height={H}
          data-signature-plot=""
          className="block"
          shapeRendering="geometricPrecision"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={M.l} y1={y(v)} x2={M.l + pw} y2={y(v)} stroke="var(--plot-grid)" strokeWidth={1} shapeRendering="crispEdges" />
              {/* The numeral face, not the mono one. A measured number carries
                  tabular figures either way, and inside an SVG that gets
                  exported this is a correctness rule: the PDF print window holds
                  none of the application's fonts, so a mono stack falls through
                  to a face Skia writes as Type3 and Acrobat reports an error on
                  the page. Same correction the spectrum panel's detector names
                  took on 2026-08-19. */}
              <text x={M.l - 7} y={y(v) + 3} textAnchor="end" fontSize={9.5} fontFamily="var(--font-numeric)" fill="var(--plot-label)">
                {v.toFixed(2)}
              </text>
            </g>
          ))}

          {/* One vertical rule per named detector, so a peak can be read off the
              grid rather than estimated between two laser boundaries. Under the
              curves and above the horizontal grid, at the same weight. */}
          <g data-signature-grid="">
            {Array.from({ length: D }, (_, d) => d)
              .filter((d) => d % labelEvery === 0)
              .map((d) => (
                <line
                  key={`gx${d}`}
                  x1={x(d)} y1={M.t} x2={x(d)} y2={M.t + ph}
                  stroke="var(--plot-grid)" strokeWidth={1} shapeRendering="crispEdges"
                />
              ))}
          </g>

          {blocks.map((b) => (
            <line key={b.name} x1={x(b.from)} y1={M.t} x2={x(b.from)} y2={M.t + ph} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3" shapeRendering="crispEdges" />
          ))}

          {/* Which laser each stretch belongs to, above the plot. The axis title
              used to list the five in order and leave the reader to divide the
              width by eye. */}
          {blocks.map((b) => (
            <text
              key={`laser${b.name}`}
              x={(x(b.from) + x(Math.min(D - 1, b.to - 1))) / 2}
              y={M.t - 7}
              textAnchor="middle"
              fontSize={9.5}
              fontFamily="var(--font-ui)"
              fill="var(--text-tertiary)"
            >
              {b.name}
            </text>
          ))}

          <line x1={M.l} y1={M.t + ph} x2={M.l + pw} y2={M.t + ph} stroke="var(--plot-axis)" strokeWidth={1} shapeRendering="crispEdges" />
          <line x1={M.l} y1={M.t} x2={M.l} y2={M.t + ph} stroke="var(--plot-axis)" strokeWidth={1} shapeRendering="crispEdges" />

          {shown.map((s) => {
            const i = spectra.indexOf(s);
            const lit = hover?.index === i;
            return (
              <path
                key={s.id}
                d={path(s.values)}
                fill="none"
                stroke={POP_COLORS[i % 12]}
                strokeWidth={lit ? 2.6 : s.isAutofluorescence ? 1.75 : 1.4}
                strokeOpacity={hover && !lit ? 0.45 : 1}
                strokeDasharray={s.isAutofluorescence ? '4 2' : undefined}
                strokeLinejoin="round"
              />
            );
          })}

          {/* The cursor's detector, so the label names a position as well as a
              curve. Drawn under the label and above the curves. */}
          {hover && (
            <line
              x1={hover.x} y1={M.t} x2={hover.x} y2={M.t + ph}
              stroke="var(--plot-axis)" strokeWidth={1} strokeDasharray="2 3"
              shapeRendering="crispEdges" pointerEvents="none"
            />
          )}

          {/* The detector names themselves, rotated so sixty-four of them fit.
              This is what the axis was missing: "Detectors" is true of any
              spectral plot, and deciding whether a peak sits in the right
              channel means being able to read which channel it is. */}
          <g data-signature-detectors="" shapeRendering="geometricPrecision">
            {Array.from({ length: D }, (_, d) => d).map((d) => {
              const px = x(d);
              const labelled = d % labelEvery === 0;
              return (
                <g key={`d${d}`}>
                  <line
                    x1={px} y1={M.t + ph} x2={px} y2={M.t + ph + (labelled ? 3.5 : 2)}
                    stroke="var(--plot-tick)" strokeWidth={1} shapeRendering="crispEdges"
                  />
                  {labelled && (
                    <text
                      x={px}
                      y={M.t + ph + 6}
                      fontSize={8.5}
                      // Numeral face, for the reason the y-axis values give: a
                      // detector name is an identifier and would ordinarily be
                      // monospaced, but this SVG is exported and the print
                      // pipeline cannot resolve that stack.
                      fontFamily="var(--font-numeric)"
                      fill="var(--plot-label)"
                      textAnchor="end"
                      transform={`rotate(-60 ${px} ${M.t + ph + 6})`}
                    >
                      {detectorAt(d)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* Still plural — there are sixty-four of them and the title is about
              the axis, not about one tick. What it no longer needs to carry is
              the list of lasers: those are named over their own blocks now. */}
          <text x={M.l + pw / 2} y={H - 4} textAnchor="middle" fontSize={10.5} fill="var(--plot-label)" fontFamily="var(--font-ui)">
            Detectors
          </text>
          {/*
              What the y axis is, in full (2026-08-11, Item 12).

              "Normalised median" named the operation and left out the quantity,
              so the axis could equally have been a median of anything. It is the
              **median fluorescence intensity** of the gated population in each
              detector, divided by that signature's own largest detector — which
              is what puts every curve's peak at 1.00 and is the whole reason the
              shapes are comparable between a bright dye and a dim one. Checked
              against `populationSignature`/`normaliseSignature` in
              `core/spectral.ts` rather than assumed, since the axis had been
              describing the code from a distance.
          */}
          <text x={11} y={M.t + ph / 2} textAnchor="middle" transform={`rotate(-90 11 ${M.t + ph / 2})`} fontSize={10.5} fill="var(--plot-label)" fontFamily="var(--font-ui)">
            Normalised median fluorescence intensity
          </text>
        </svg>

        {/* An HTML label rather than SVG text: it needs a background, a colour
            chip and text that cannot be clipped by the plot box, all of which
            are free here and fiddly in SVG. Offset away from the cursor for the
            same reason the plot readout is. */}
        {hovered && hover && (
          <div
            data-signature-hover={hovered.label}
            className="pointer-events-none absolute z-10 flex items-center gap-1.5 px-1.5 py-0.5 rounded-[var(--radius-xs)] border border-[var(--border-subtle)] bg-[var(--surface-overlay)] text-2xs text-[var(--text-primary)] whitespace-nowrap shadow-sm"
            style={{
              left: Math.min(hover.x + 20, W - 150),
              top: Math.max(4, hover.y - 26),
            }}
          >
            <ColorChip color={POP_COLORS[hover.index % 12]!} size={8} />
            {hovered.label}
            {/* The detector and the value there, because the question this plot
                is read for is "is this dye peaking in the right channel" and
                the answer needs both halves. */}
            <span className="font-mono tnum text-[var(--text-tertiary)]">
              {detectorAt(hover.detector)} {(hovered.values[hover.detector] ?? 0).toFixed(3)}
            </span>
          </div>
        )}
      </div>

      <p className="text-2xs text-[var(--text-tertiary)]">
        Median fluorescence intensity across all {D} detectors, each curve scaled to its own peak so shapes compare
        regardless of brightness. Autofluorescence is dashed; dashed vertical rules divide the lasers, named along the
        top. Hover to name the nearest signature and read its value in that detector; click a name above to hide or show
        it, or use the button on the plot for all of them.
      </p>
    </div>
  );
}

export { UnmixingView as default };
