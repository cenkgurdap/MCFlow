import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Atom, Boxes, Check, ChevronLeft, ChevronRight, Circle,
  Crosshair, Grid3x3, RotateCcw, Sigma, Trash2, Upload, Waves,
} from 'lucide-react';
import {
  firstStep, isFitted, lastStep, reachedStep, sampleIndexForLayout, schemeFor, stepsFor,
  type BiophysicsMode, type BiophysicsStep,
} from '@/core/biophysics/pipeline';
import {
  BIOPHYSICAL_PROPERTIES, componentForPopulation, maxComponentsFor, populationNames,
  probeById, propertyById, type BiophysicalProbe,
} from '@/core/biophysics/properties';
import { MIN_COMPONENT_WEIGHT, MIN_SEPARATION } from '@/core/biophysics/mixture';
import { describeDetectorFull } from '@/core/detectors';
import type { ParameterPreset } from '@/core/parameterPresets';
import { pipelinePreset, useBiophysics } from '@/state/biophysicsStore';
import { useDerived } from '@/state/derivedStore';
import { useGates } from '@/state/gateStore';
import { useSpectral } from '@/state/spectralStore';
import { usePlot } from '@/state/plotStore';
import { useUI, type MainView } from '@/state/uiStore';
import { acquisitionTypeOf, useWorkspace, type Sample } from '@/state/workspaceStore';
import { Button, IconButton, Spinner } from '@/ui/Button';
import { Field, Select } from '@/ui/Field';
import { Badge, Callout, EmptyState } from '@/ui/Feedback';
import { Panel, PanelHeader } from '@/ui/Panel';
import { SegmentedControl } from '@/ui/SegmentedControl';
import { InfoHint, Tooltip } from '@/ui/Tooltip';
import { cn } from '@/ui/cn';
import { FitReview, meanOf } from './FitReview';
import { populationColors } from './populationColors';
import { PipelineDone } from './PipelineDone';

/**
 * Biophysics — a guided pipeline for the biophysical properties of cells.
 *
 * ## What this panel is, and what it deliberately is not
 *
 * It is a **front end onto the systems the rest of the application already
 * has**. The scatter plot is the Analysis panel's scatter plot; the histogram is
 * the Analysis panel's histogram; the gates it places are ordinary gates in the
 * ordinary tree, editable from Analysis and reported by Statistics and Export
 * without either of those knowing this panel exists; the value it measures is an
 * ordinary derived parameter created from the Parameters panel's own preset.
 *
 * The one genuinely new thing behind it is `core/biophysics/mixture.ts` — fitting
 * a distribution and deciding how many populations are in it. Nothing else here
 * is new machinery, and the reason that matters is recorded in
 * `state/biophysicsStore.ts`: the last several passes of this project were spent
 * removing duplicate state that a guided panel had built beside the general
 * model rather than on top of it.
 *
 * So the panel's job ends at its last step. There is no biophysics statistics
 * screen and no biophysics export, because the gates and the parameter are
 * already the things those panels read.
 *
 * ## Two modes, one pipeline
 *
 * *Single cell type* is the original four steps. *Multiple cell types* brackets
 * them with a step before — unmixing, which this panel **routes to rather than
 * models** — and a step after, which builds one worksheet of three plots to gate
 * cell types on: the cells, the singlets, and the property against acquisition
 * time. That last step builds plots, not populations: the gating is done with
 * the ordinary tools and produces ordinary gates, so a cell type reads as
 * `Cells/Singlets/Live/CD4` in Statistics with nothing here knowing it exists. There is
 * no list of known immune phenotypes and no automatic marker assignment, because
 * the panel is never told which channel carries which antibody and will not
 * guess — which is also why it stopped offering to pick markers for you.
 *
 * ## Shaped like the unmixing wizard on purpose
 *
 * Same step tracker, same *Next* button that states why it is disabled rather
 * than merely being grey, same per-worksheet walk with a tab strip at the bottom
 * of the canvas, same "the gating happens on the worksheet, not in here". Two
 * guided workflows that behave differently in the small are two workflows to
 * learn.
 */
export function BiophysicsView() {
  const samples = useWorkspace((s) => s.samples);
  const step = useBiophysics((s) => s.step);
  const setStep = useBiophysics((s) => s.setStep);
  const next = useBiophysics((s) => s.next);
  const back = useBiophysics((s) => s.back);
  const reset = useBiophysics((s) => s.reset);
  const discardSetup = useBiophysics((s) => s.discardSetup);
  const parameterId = useBiophysics((s) => s.parameterId);
  const singletGateId = useBiophysics((s) => s.singletGateId);
  const derivedDefs = useDerived((s) => s.defs);
  const stepCheck = useBiophysics((s) => s.stepCheck);
  /*
     The three values Step 2's answer is made of, subscribed to here even though
     this component draws none of them.

     `stepCheck` is an accessor: one stable function reference, so subscribing to
     it subscribes to nothing. It reads the current state when it is called, and
     it is called during render — which is correct only if something else has
     caused the render. Everything else it reads was already subscribed above, so
     the gap was exactly the Step 2 fields: picking the two detectors on an
     instrument that names them differently made the pipeline computable and left
     *Next* disabled, because nothing told this component to ask again. Leaving
     the panel and coming back remounted it and the button was there — which is
     the shape of every "it works after I navigate away" report, and is why the
     rule is to depend on values and never on the store's accessors.
  */
  const propertyId = useBiophysics((s) => s.propertyId);
  const probeId = useBiophysics((s) => s.probeId);
  const channels = useBiophysics((s) => s.channels);
  const records = useBiophysics((s) => s.samples);
  const liveGateId = useBiophysics((s) => s.liveGateId);
  const mode = useBiophysics((s) => s.mode);
  const setMode = useBiophysics((s) => s.setMode);
  const pipelineSamples = useBiophysics((s) => s.pipelineSamples);
  // `unmixed` in the deps because the WeakMap behind the unmixed columns has no
  // subscribers, and which samples carry abundances is exactly what it answers.
  const unmixedResults = useSpectral((s) => s.unmixed);

  /*
     The samples this pipeline is about, which in multi mode is not every sample
     in the workspace — see `pipelineSampleIds`. Step 0 is the exception and takes
     the full list, because its whole subject is which of them are unmixed.
  */
  const scoped = useMemo(
    () => pipelineSamples(samples),
    [pipelineSamples, samples, mode, unmixedResults],
  );

  /*
     Whether this pipeline is running on a conventional instrument, which
     decides what step 0 is called and how it is described. Asked of the
     samples the pipeline is about rather than of the workspace: in multi mode
     that is the multicolour files, not the controls beside them. A mixed set
     reads as spectral, which is the same rule `computeMatrix` uses to decide
     which model to build.
  */
  const conventional = scoped.length > 0 && scoped.every((s) => acquisitionTypeOf(s) === 'conventional');

  /*
     "Did my click register, or is it just slow?"

     Leaving Step 1 traces a scatter contour per sample; leaving Step 3 bins and
     fits every sample's distribution. On six 12 000-event files that is fast, on
     a plate of 300 000-event files it is seconds of synchronous work on the main
     thread with nothing on screen moving. The overlay, the two-frame wait and
     the 60 ms fallback are the same mechanism the unmixing wizard uses, and the
     reasoning for each is recorded there — including why the wait has a timeout,
     which is that a hidden harness window throttles `requestAnimationFrame` to
     about 1 Hz.
  */
  const [busy, setBusy] = useState<string | null>(null);
  const withBusy = async (message: string, work: () => void) => {
    setBusy(message);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(null); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 60);
    });
    try { work(); } finally { setBusy(null); }
  };

  /*
     Recomputed from the values it is made of, never from the accessor alone.
     See the subscriptions at the top of this component for what that fixed.
  */
  const check = useMemo(
    () => stepCheck(),
    [stepCheck, step, samples, records, liveGateId, propertyId, probeId, channels, unmixedResults],
  );

  /*
     What *Discard setup* is about to destroy, counted from what the store
     tracks rather than described in general terms.

     A destructive action that says "removes the biophysics setup" is asking for
     consent to something nobody can picture. These are the same three sources
     `discardSetup` reads, so the sentence and the action cannot come apart.
  */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const started = !!liveGateId || records.length > 0;
  const worksheetCount = records.filter((r) => r.layoutId).length
    + (records.some((r) => r.immuneLayoutId) ? 1 : 0);
  const gateCount = (liveGateId ? 1 : 0) + (singletGateId ? 1 : 0)
    + records.reduce((n, r) => n + r.populationGateIds.length, 0);
  const parameterName = derivedDefs.find((d) => d.id === parameterId)?.name ?? null;

  const header = (
    <PanelHeader
      title="Biophysics"
      icon={<Atom size={12} />}
      count={records.length > 0 ? `${records.length} samples` : undefined}
      actions={
        started ? (
          <>
            <Tooltip content="Start the pipeline again. Gates, worksheets and the parameter are left alone.">
              <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} data-bio-reset="" onClick={reset}>
                Start over
              </Button>
            </Tooltip>
            <Tooltip content="Remove the gates, worksheets and parameter this pipeline made.">
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={12} />}
                data-bio-discard=""
                onClick={() => setConfirmDiscard(true)}
              >
                Discard setup
              </Button>
            </Tooltip>
          </>
        ) : undefined
      }
    />
  );

  /*
     Armed rather than immediate, and a `Callout` rather than a `Popover`: a
     Popover anchors over the thing being configured and dismisses on an outside
     click, which is the wrong shape for a question you want somebody to read.
     It sits under the header, above the step tracker, so it is the first thing
     on the panel and nothing it is about scrolls away underneath it.
  */
  const discardConfirm = confirmDiscard ? (
    <div className="px-2.5 pt-2.5" data-bio-discard-confirm="">
      <Callout tone="warn" title="Discard the biophysics setup?">
        <p className="leading-snug">
          Removes {worksheetCount} worksheet{worksheetCount === 1 ? '' : 's'} and{' '}
          {gateCount} gate{gateCount === 1 ? '' : 's'}
          {parameterName ? <>, and the <strong>{parameterName}</strong> parameter</> : null}.
          {' '}Anything you drew under those gates moves up to <em>All events</em> rather than going with
          them. One undo brings all of it back.
        </p>
        <div className="flex items-center gap-1.5 pt-1.5">
          <Button
            size="sm"
            variant="danger"
            data-bio-discard-confirm-yes=""
            onClick={() => { discardSetup(); setConfirmDiscard(false); }}
          >
            Discard
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Cancel</Button>
        </div>
      </Callout>
    </div>
  ) : null;

  if (samples.length === 0) {
    return (
      <Panel className="h-full">
        {header}
        <EmptyState
          className="mt-10"
          icon={<Atom size={19} />}
          title="No samples loaded"
          description="This pipeline measures a biophysical property on cells — import the .fcs files for the experiment and it will gate, compute and fit each one."
        />
      </Panel>
    );
  }

  return (
    <Panel className="h-full">
      {header}
      {discardConfirm}
      <ModeChooser mode={mode} onPick={setMode} />
      <StepTracker mode={mode} step={step} onPick={setStep} conventional={conventional} />

      <div className="relative flex-1 overflow-auto min-h-0" data-bio-step={step}>
        {step === 0 && <StepUnmixing samples={samples} conventional={conventional} />}
        {step === 1 && <StepCells samples={scoped} busy={!!busy} onWork={withBusy} />}
        {step === 2 && <StepProperty samples={scoped} />}
        {step === 3 && <StepDistribution />}
        {step === 4 && <StepPopulations samples={scoped} onWork={withBusy} />}
        {step === 5 && <StepImmune samples={scoped} onWork={withBusy} />}

        {busy && (
          <div
            data-bio-busy=""
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

      {/* The navigation bar, always in the same place. `Next` states why it is
          disabled rather than merely being grey — the reason is the instruction. */}
      <div className="flex items-center gap-2 p-2.5 hairline-t shrink-0 bg-[var(--surface-sunken)]">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowLeft size={12} />}
          disabled={step === firstStep(mode)}
          data-bio-back=""
          onClick={back}
        >
          Back
        </Button>
        <p className={cn('flex-1 min-w-0 text-2xs leading-snug', check.ok ? 'text-[var(--text-tertiary)]' : 'text-[var(--status-warn)]')}>
          {check.ok ? (check.advice ?? '') : check.reason}
        </p>
        {step < lastStep(mode) && (
          <Tooltip content={check.ok ? '' : check.reason}>
            <span>
              <Button
                size="sm"
                variant="primary"
                trailing={<ArrowRight size={12} />}
                disabled={!check.ok || !!busy}
                loading={!!busy}
                data-bio-next=""
                onClick={() => void withBusy(
                  step === 2 ? 'Building each sample’s distribution…'
                    : step === 3 ? 'Fitting each sample’s populations…'
                      : 'Working…',
                  () => next(scoped),
                )}
              >
                {step === 3 ? 'Find the populations' : 'Next'}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </Panel>
  );
}

/* ========================================================================== */

/**
 * "1 Cells · 2 Property · 3 Distribution · 4 Populations".
 *
 * Clickable backwards and as far forward as the work allows, on the same rule
 * the unmixing wizard's tracker uses: jumping forward past a step whose output
 * the next one consumes produces a screen built from nothing, while going back
 * to re-place a gate is an ordinary thing to want.
 */
function StepTracker({
  mode, step, onPick, conventional,
}: {
  mode: BiophysicsMode;
  step: BiophysicsStep;
  onPick: (s: BiophysicsStep) => void;
  /** Renames step 0, which is the same prerequisite under two names. */
  conventional: boolean;
}) {
  const liveGateId = useBiophysics((s) => s.liveGateId);
  const parameterId = useBiophysics((s) => s.parameterId);
  const records = useBiophysics((s) => s.samples);

  // How far the work has actually got, which is what bounds the forward jumps.
  // Step 5 is reached once its worksheets exist; before that it is the step the
  // user walks to with Next, like every other.
  const reached: BiophysicsStep = reachedStep(mode, records, liveGateId, parameterId);

  return (
    <div className="flex items-stretch gap-px px-2.5 py-2 hairline-b shrink-0" data-bio-tracker="">
      {stepsFor(mode).map(({ step: n, label: base }) => {
        /*
           Step 0 is *Unmixing* or *Compensation* — the same prerequisite, named
           for the instrument that produced the files. The label is overridden
           here rather than in `stepsFor` because which one applies is a question
           about the loaded samples, and `core/` is store-free: `UNMIXING_STEP`
           carries the spectral name because that is the one that reads right
           with no data loaded.
        */
        const label = n === 0 && conventional ? 'Compensation' : base;
        const state = n === step ? 'current' : n < step ? 'done' : 'todo';
        const reachable = n <= Math.max(step, reached);
        return (
          <button
            key={n}
            type="button"
            disabled={!reachable}
            data-bio-step-n={n}
            data-bio-step-state={state}
            onClick={() => reachable && onPick(n as BiophysicsStep)}
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
                  : 'bg-[var(--surface-overlay)] ' + (state === 'done' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-disabled)]'),
              )}
            >
              {state === 'done' ? <Check size={9} /> : n === 0 ? <Waves size={9} /> : n}
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
 * One cell type, or many — the choice the whole panel hangs off.
 *
 * At the top, above the tracker, because it decides what the tracker lists. Two
 * cards rather than a dropdown: the difference between the two is a paragraph,
 * not a word, and a dropdown would make somebody pick before reading it.
 *
 * It stays switchable after work has started. Changing mode clamps the step and
 * touches nothing else — the gates, the parameter and the fits are all shared
 * between the two, and a user who realises on Step 3 that they are looking at
 * PBMCs should not have to start again.
 */
function ModeChooser({ mode, onPick }: { mode: BiophysicsMode; onPick: (m: BiophysicsMode) => void }) {
  const options: Array<{ id: BiophysicsMode; label: string; detail: string; icon: React.ReactNode }> = [
    {
      id: 'single',
      label: 'Single cell type',
      detail: 'A cell line or a sorted population. Every gated event is the same kind of cell.',
      icon: <Circle size={13} />,
    },
    {
      id: 'multi',
      label: 'Multiple cell types',
      detail: 'PBMCs and the like. Unmix first, then biophysical analysis.',
      icon: <Boxes size={13} />,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 px-2.5 py-2.5 hairline-b shrink-0" data-bio-mode-chooser="">
      {options.map((o) => {
        const active = o.id === mode;
        return (
          <button
            key={o.id}
            type="button"
            data-bio-mode={o.id}
            data-bio-mode-active={active ? '' : undefined}
            aria-pressed={active}
            onClick={() => onPick(o.id)}
            className={cn(
              'flex flex-col items-start gap-1 p-2.5 text-left rounded-[var(--radius-md)] border',
              'transition-colors duration-[var(--dur-fast)]',
              active
                ? 'border-[var(--accent-500)] bg-[var(--surface-selected)]'
                : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]',
            )}
          >
            <span className={cn(
              'flex items-center gap-1.5 text-xs font-medium',
              active ? 'text-[var(--text-accent)]' : 'text-[var(--text-primary)]',
            )}
            >
              {o.icon}
              {o.label}
            </span>
            <span className="text-2xs text-[var(--text-tertiary)] leading-snug">{o.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ========================================================================== */

/** A button that takes the user to the worksheet the step is talking about. */
function OpenWorksheet({ label = 'Open the worksheet' }: { label?: string }) {
  const setView = useUI((s) => s.setView);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<Crosshair size={12} />}
      data-bio-open-worksheet=""
      onClick={() => setView('analysis')}
    >
      {label}
    </Button>
  );
}

/* ========================================================================== */

/**
 * Step 0 (multi mode) — get the markers in place before anything else.
 *
 * The step **routes rather than models**. Unmixing is the Unmixing panel's job
 * and it is a substantial guided workflow of its own; a copy of it here would be
 * a second representation of the matrix, which is the one thing a guided panel
 * must never build. So this screen says what the last step will need, reports
 * whether the workspace already has it, and hands over.
 *
 * It never blocks — see `checkUnmixing`. Files unmixed on the instrument arrive
 * with their markers as ordinary parameters, and nothing here can tell the
 * difference without guessing, which is the rule this project keeps.
 */
function StepUnmixing({ samples, conventional }: { samples: Sample[]; conventional: boolean }) {
  const setView = useUI((s) => s.setView);
  const setTab = useSpectral((s) => s.setTab);
  const unmixed = useSpectral((s) => s.unmixed);
  const applied = samples.filter((s) => !!unmixed[s.id]).length;

  /*
     Which panel this hands over to is a question about **these** samples
     (2026-08-27).

     The step routes rather than models, and there are now two panels it can
     route to: spectral unmixing solves every dye across the whole detector
     array, conventional compensation inverts a spillover matrix over the
     detectors each dye peaks in. Both end in the same place as far as this
     pipeline is concerned — the markers arrive as ordinary parameters — which
     is exactly why there is still one Biophysics panel and not two.

     `conventional` is decided by the panel and passed down rather than computed
     here, so the step tracker's name for step 0 and this screen's description of
     it cannot disagree — they are the same answer about the same samples.
  */
  const target: MainView = conventional ? 'compensation' : 'unmixing';
  const go = (tab: 'new' | 'load') => { setTab(tab); setView(target); };

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-unmixing="">
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        {conventional
          ? <Grid3x3 size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
          : <Waves size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            To read a property per cell type, the files need markers to identify those cell types with.
            That means {conventional ? 'compensation' : 'unmixing'}.
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            Build a matrix from your single-stain controls, or load one you saved earlier and apply it to
            these samples. Either way you come back here and carry on — the pipeline uses whatever
            parameters the files end up with.
          </p>
          <div className="flex flex-wrap gap-2 pt-0.5">
            <Button
              size="sm"
              variant="secondary"
              icon={conventional ? <Grid3x3 size={12} /> : <Waves size={12} />}
              data-bio-goto-unmixing=""
              onClick={() => go('new')}
            >
              {conventional ? 'Compensate from controls' : 'Unmix from controls'}
            </Button>
            <Button size="sm" variant="ghost" icon={<Upload size={12} />} data-bio-load-matrix="" onClick={() => go('load')}>
              Load a saved matrix
            </Button>
          </div>
        </div>
      </div>

      {/* Named, not just counted. "6 of 19" is the wrong six as easily as the
          right six, and the operator is the only one who can tell — this panel
          will not guess which files are the multicolour samples, so the list is
          how they check. It is also the set every later step runs on: see
          `pipelineSampleIds`. */}
      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">Samples carrying {conventional ? 'compensated' : 'unmixed'} markers</span>
          <Badge tone={applied === 0 ? 'warn' : applied === samples.length ? 'ok' : 'accent'} data-bio-unmixed-count="">
            {applied} of {samples.length}
          </Badge>
        </p>
        <div className="max-h-52 overflow-y-auto">
          {samples.map((s, i) => {
            const on = !!unmixed[s.id];
            return (
              <div
                key={s.id}
                data-bio-unmixed-row={s.name}
                data-bio-unmixed-on={on ? '' : undefined}
                className={cn('flex items-center gap-2 px-2.5 h-7', i > 0 && 'hairline-t', !on && 'opacity-55')}
              >
                <span className={cn('shrink-0', on ? 'text-[var(--status-ok)]' : 'text-[var(--text-disabled)]')}>
                  {on ? <Check size={11} /> : <Circle size={9} />}
                </span>
                <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{s.name}</span>
                {on && <span className="text-2xs text-[var(--text-disabled)] shrink-0">in the pipeline</span>}
              </div>
            );
          })}
        </div>
      </div>

      {applied > 0 && applied < samples.length && (
        <Callout tone="info">
          The remaining {samples.length - applied} {samples.length - applied === 1 ? 'file' : 'files'} —
          single-stain controls, most likely — are left out of every step from here on. Apply the matrix to
          them too if they belong in the analysis.
        </Callout>
      )}

      {applied === 0 && (
        <Callout tone="info">
          <span className="font-medium">Already {conventional ? 'compensated' : 'unmixed'} elsewhere?</span>{' '}
          If these files came off the instrument with the spillover already resolved, their markers are
          ordinary parameters and there is nothing to do here — carry on to the next step.
        </Callout>
      )}
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 1 — where the cells are.
 *
 * The gate is placed on arrival with no button to press, which is the rule the
 * unmixing wizard arrived at on 2026-08-07 and for the same reason: there is no
 * state in which the operator wants their cells left ungated, and correcting a
 * traced polygon is strictly less work than drawing one. A boundary somebody has
 * dragged is never re-traced — see `buildLiveGates`.
 *
 * There is **one `Cells` gate, and each sample is either counted by its shape or
 * carries its own**. That is the point worth stating on screen, because it is the
 * thing that would otherwise surprise somebody: the population is called *Cells*
 * on every file, so Statistics compares like with like, whichever way a row is
 * set.
 *
 * The scope control is offered in **both** modes (2026-08-23). It was multi-only,
 * on the reasoning that a single cell type is tubes of one preparation whose
 * debris corner genuinely moves — which is a good *default* and was a bad rule:
 * six replicates acquired in one sitting are one shape, and the mode that could
 * not say so was the mode with no control. The defaults are unchanged —
 * `setMode` still seeds multi shared and single per-sample — so what this adds is
 * the ability to say otherwise.
 */
function StepCells({
  samples, busy, onWork,
}: {
  samples: Sample[];
  busy: boolean;
  onWork: (message: string, work: () => void) => Promise<void>;
}) {
  const buildLiveGates = useBiophysics((s) => s.buildLiveGates);
  const liveGateId = useBiophysics((s) => s.liveGateId);
  const records = useBiophysics((s) => s.samples);
  const overrides = useGates((s) => s.overrides);
  const mode = useBiophysics((s) => s.mode);
  const setCellGateShared = useBiophysics((s) => s.setCellGateShared);
  const setSampleGateShared = useBiophysics((s) => s.setSampleGateShared);
  // The default a build will use, and the only thing the start screen's
  // shared/unique choice can write before there is a gate to apply it to.
  const cellGateShared = useBiophysics((s) => s.cellGateShared);
  // A mixture's cell gate is traced looser and means something different — see
  // `cellCoverageFor`. The instruction has to match what was drawn.
  const mixed = schemeFor(mode) === 'viability';
  const [message, setMessage] = useState<string | null>(null);

  /**
   * Top up a pipeline that is already running. **Never start one.**
   *
   * ## The report this answers (2026-08-28)
   *
   * *"Import samples, work in Analysis, click Biophysics to see what it is,
   * click back — and you are stuck with all the layouts and the cells gating.
   * I have to remove every sample and re-import to get back to normal."*
   *
   * Exactly what happened, and none of it was a misclick. This effect had two
   * jobs and only one of them was ever asked for. Merely opening the panel ran
   * `buildLiveGates`, which places a *Cells* gate at the root of the tree — an
   * ordinary gate, so it counts in Statistics and Export — traces a polygon per
   * sample, opens a worksheet each, switches the active worksheet to one of
   * them, and marks the workspace unsaved. Someone looking at a panel paid for
   * a decision they had not made, and the bill only arrived on the way out.
   *
   * `liveGateId` is the whole of the distinction, and it needs no new state: it
   * is null until the pipeline is started, it is saved with the workspace, and
   * it is captured by undo. Non-null means somebody pressed *Find the cells*,
   * and from then on this does what it was written for — arriving here after
   * importing a seventh file gates the seventh, and arriving with everything
   * gated re-traces nothing.
   *
   * This is the rule the unmixing wizard already states for itself: *ticking
   * files builds nothing, so leaving costs nothing — the lock starts where the
   * first artefact does.*
   *
   * `ran` stops the effect re-entering within one visit: `buildLiveGates` writes
   * the store, which re-renders this, which would otherwise run again next tick.
   */
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !liveGateId) return;
    const complete = samples.every((s) => records.some((r) => r.sampleId === s.id && r.layoutId));
    if (complete || samples.length === 0) return;
    ran.current = true;
    void onWork('Gating the samples that have arrived since…', () => {
      const r = buildLiveGates(samples);
      setMessage(r.message ?? null);
    });
  }, [buildLiveGates, liveGateId, onWork, records, samples]);

  /** Start it: the press that used to be a mount effect. */
  const start = () => {
    void onWork('Finding the cells on each sample…', () => {
      const r = buildLiveGates(samples);
      setMessage(r.message ?? null);
    });
  };

  /*
     Whether this sample is *gated*, and it is now one question in both modes.

     It used to ask *Single cell type* for an override and *Multiple cell types*
     for the gate, because only the second could be shared. Both can be now, and
     asking a shared sample for an override reports it as ungated forever — the
     assertion-over-an-empty-set shape, arriving as a permanent warning triangle
     on every row of a panel that is correctly gated. A sample is gated when the
     gate exists: shared or unique, it is counted by it.
  */

  /*
     Whether the bulk buttons have anything left to do. Read from the overrides
     rather than from `cellGateShared`, because the flag is the *default* a new
     sample takes and the overrides are what each sample is actually on — the
     two agree until a row is corrected, which is exactly when the question
     matters.
  */
  const ownCount = samples.filter((s) => !!overrides[liveGateId ?? '']?.[s.id]).length;
  const allShared = !!liveGateId && ownCount === 0;
  const allOwn = !!liveGateId && samples.length > 0 && ownCount === samples.length;

  /*
     Before anything is placed: say what will happen, and let the two choices
     that govern it be made first.

     The screen below this one is written in the past tense — *"One gate around
     the cells has been drawn…"* — because it described a mount effect that had
     already run. This is its future-tense counterpart, and the difference is
     not only grammatical: the mode and the shared/unique choice both decide how
     the gates are traced, and until now both could only be answered *after*
     they had been traced the other way. That is the trap this project already
     recorded once as *"a default changed after the thing it configures has
     already been built configures nothing"*.

     `setCellGateShared` writes the flag alone when there is no gate yet, which
     is exactly what is wanted here — `buildLiveGates` reads it on the way in.
     The mode picker is not repeated: it sits above the step tracker and is
     already on screen.
  */
  if (!liveGateId) {
    return (
      <div className="p-2.5 space-y-2.5" data-bio-step-cells="" data-bio-start="">
        <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
          <Crosshair size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs text-[var(--text-primary)] leading-snug">
              This traces a gate around the cells on FSC-A × SSC-A for{' '}
              {samples.length === 1 ? 'the sample below' : `each of the ${samples.length} samples below`}, and
              opens a worksheet for each so you can check and reshape it.
            </p>
            <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
              {mixed
                ? <>The gate should hold <em>every</em> cell — both scatter clouds if you have lymphocytes and
                  monocytes, and the dead cells too, which the fit separates later. Only the debris at the
                  bottom left is left out.</>
                : <>The gate should hold the main cell density, leaving out debris at the bottom left and dead
                  cells on the left.</>}
              {' '}<strong>Nothing in your workspace changes until you start.</strong>
            </p>
          </div>
        </div>

        {message && <Callout tone="warn">{message}</Callout>}

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs text-[var(--text-tertiary)]">
            Cell gate for all {samples.length} sample{samples.length === 1 ? '' : 's'}:
          </span>
          <Button
            size="sm"
            variant="secondary"
            data-bio-start-scope="shared"
            disabled={cellGateShared}
            onClick={() => setCellGateShared(true, samples)}
          >
            One for all
          </Button>
          <Button
            size="sm"
            variant="secondary"
            data-bio-start-scope="own"
            disabled={!cellGateShared}
            onClick={() => setCellGateShared(false, samples)}
          >
            One per sample
          </Button>
        </div>

        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
          <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
            <span className="flex-1 min-w-0">Samples this will gate</span>
            <span className="tnum">{samples.length}</span>
          </p>
          {samples.map((s) => (
            <div
              key={s.id}
              data-bio-start-row={s.name}
              className="flex items-center gap-2 px-2.5 h-7 text-2xs text-[var(--text-secondary)] hairline-b last:border-b-0"
            >
              <span className="flex-1 min-w-0 truncate">{s.name}</span>
            </div>
          ))}
        </div>

        <Button
          variant="primary"
          icon={<Crosshair size={12} />}
          disabled={busy || samples.length === 0}
          loading={busy}
          data-bio-start-build=""
          onClick={start}
        >
          Find the cells
        </Button>
      </div>
    );
  }

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-cells="">
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <Crosshair size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            {ownCount === 0
              ? <>One gate around the cells has been drawn from the first sample&rsquo;s FSC-A × SSC-A scatter and
                applies to every sample. Open the worksheets and check it holds on each one.</>
              : ownCount === samples.length
                ? <>A gate around the cells has been drawn on every sample, from its own FSC-A × SSC-A scatter.
                  Open the worksheets and check each one.</>
                : <>One gate around the cells applies to every sample except the {ownCount} marked{' '}
                  <em>Unique</em> below, which carry their own. Open the worksheets and check each one.</>}
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            {mixed
              ? <>It should hold <em>every</em> cell — both scatter clouds if you have lymphocytes and monocytes,
                and the dead cells too, which the fit separates later. Leave out only the debris at the bottom
                left. Drag the gate to reshape it by clicking <em>Open the worksheet</em>.</>
              : <>It should hold the main cell density, leaving out debris at the bottom left and dead cells on
                the left. Drag the gate to reshape it by clicking <em>Open the worksheet</em>.</>}
          </p>
          <OpenWorksheet />
        </div>
      </div>

      {message && <Callout tone="warn">{message}</Callout>}

      {/*
         One shape, or one per file — asked on the rows it is about.

         It was a segmented control in a card of its own, above a list of
         samples that then said nothing about it (2026-08-18). Two sections for
         one question, and the wrong shape for it: the scope of a gate is a
         property of each sample, not a setting on the panel, and an experiment
         where seven files share a shape and the eighth needs its own could not
         be expressed at all.

         Shaped on the unmixing wizard's negative-reference column, which is the
         same problem — a column that is almost always N copies of one answer
         with one row that differs. Bulk buttons state the usual answer, the
         per-row control corrects the exception, and the row is where the answer
         is read.

         Offered in **both** modes, one control with one set of words. It was
         multi-only until 2026-08-23; the mode difference is which answer is
         seeded, not which answers can be given, and it stays in `setMode` where
         a default belongs. The store side never needed a change — every action
         behind this control already reads `pipelineSamples`, `cellCoverageFor`
         and a `singletGateId` that is null in single mode.
      */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-2xs text-[var(--text-tertiary)]">
          Cell gate for all {samples.length} sample{samples.length === 1 ? '' : 's'}:
        </span>
        <Button
          size="sm"
          variant="secondary"
          data-bio-cell-scope-all="shared"
          disabled={allShared}
          onClick={() => setCellGateShared(true, samples)}
        >
          One for all
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-bio-cell-scope-all="own"
          disabled={allOwn}
          onClick={() => setCellGateShared(false, samples)}
        >
          One per sample
        </Button>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">Samples</span>
          <span className="shrink-0 w-[128px]">Gate</span>
          <span className="tnum">{records.filter((r) => r.layoutId).length} of {samples.length} gated</span>
        </p>
        {samples.map((s, i) => {
          const rec = records.find((r) => r.sampleId === s.id);
          const gated = !!rec?.layoutId && !!liveGateId;
          const hasOwn = !!overrides[liveGateId ?? '']?.[s.id];
          return (
            <div
              key={s.id}
              data-bio-cell-row={s.name}
              data-bio-cell-gated={gated ? '' : undefined}
              data-bio-cell-own={hasOwn ? '' : undefined}
              className={cn('flex items-center gap-2 w-full px-2.5 py-1 text-left', i > 0 && 'hairline-t')}
            >
              <span className={cn('shrink-0', gated ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]')}>
                {gated ? <Check size={11} /> : busy ? <Spinner size={11} /> : <AlertTriangle size={11} />}
              </span>
              <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{s.name}</span>
              {/* `'own'` is kept as the value and in `data-bio-cell-scope-all`:
                  it is the identity `overrides` and `linked` are about, and the
                  word on screen is a label. Renaming the wire with the label is
                  how a data attribute stops meaning what the store means. */}
              <div className="shrink-0 w-[128px]">
                <SegmentedControl
                  size="sm"
                  fullWidth
                  value={hasOwn ? 'own' : 'shared'}
                  onChange={(v: string) => setSampleGateShared(s, v === 'shared')}
                  segments={[
                    {
                      value: 'shared',
                      label: 'Shared',
                      title: 'This sample is counted by the one shape every other sample uses.',
                    },
                    {
                      value: 'own',
                      label: 'Unique',
                      title: 'Trace this sample its own polygon, dragged without moving anybody else’s.',
                    },
                  ]}
                  /*
                     `name`, not a `data-bio-cell-scope` attribute. This control
                     carried one until 2026-08-23 and it never reached the DOM:
                     `SegmentedControl` spreads nothing, and TypeScript does not
                     check a hyphenated JSX attribute against a component's
                     props, so the dead attribute typechecked for as long as it
                     existed. `name` is the component's own answer to the same
                     question and comes out as `data-segmented`.
                  */
                  name={`cell-scope:${s.name}`}
                />
              </div>
              <span className="text-2xs font-mono text-[var(--text-disabled)] shrink-0">
                {s.parsed.metadata.eventCount.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
        Every sample sits in the one <span className="font-mono">Cells</span> population whichever it is set to —
        same name, same path in Statistics. <em>Shared</em> means it is counted by the one shape, so dragging that
        shape anywhere moves it everywhere; <em>Unique</em> traces this file&rsquo;s own scatter and lets it be
        dragged alone.
      </p>
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 2 — which property, and which probe measured it.
 *
 * Two real selectors over `BIOPHYSICAL_PROPERTIES`, not a hardcoded state
 * wearing a dropdown's clothes. There is one property and one probe today and
 * both are pre-selected, which is not the filename-guessing this project deleted
 * twice: the claim being made is *"the one entry in a list of one"*, on a screen
 * whose entire content is that list. `defaultSelection` states the rule, and it
 * stops pre-selecting the moment there is a second property.
 *
 * The parameter is created here rather than left to the user, and what it
 * creates is the **Parameters panel's own preset** — see `presetFor`. So the
 * definition that lands in the workspace is the one that panel's preset row
 * would have produced, and it is editable and deletable there like any other.
 */
function StepProperty({ samples }: { samples: Sample[] }) {
  const propertyId = useBiophysics((s) => s.propertyId);
  const probeId = useBiophysics((s) => s.probeId);
  const channels = useBiophysics((s) => s.channels);
  const setProperty = useBiophysics((s) => s.setProperty);
  const setProbe = useBiophysics((s) => s.setProbe);
  const missingChannels = useBiophysics((s) => s.missingChannels);
  const suggestedChannels = useBiophysics((s) => s.suggestedChannels);
  const suggestChannels = useBiophysics((s) => s.suggestChannels);
  const defs = useDerived((s) => s.defs);
  const setView = useUI((s) => s.setView);

  const property = propertyById(propertyId);
  const probe = probeById(property, probeId);
  const first = samples[0];

  /*
     ## The instrument's own names for the probe's two bands (2026-09-07)

     A conventional panel — a FACSCanto II, nine parameters — carries both bands
     this probe is read on and calls them *Pacific Blue-A* and *AmCyan-A*. The
     step opened on *"needs V1-A and V7-A, which are not among this instrument's
     detectors"*, with a disabled *Next* and two dropdowns the operator had to
     resolve out of nine channels by knowing what the Aurora names meant.

     So the equivalence written on the probe is applied, in the two dropdowns
     underneath, where it can be read and changed. It is a **suggestion in the
     sense this project uses the word**: it fires only when the published pair is
     absent, only while nobody has chosen, and the card says the pair was matched
     rather than published. It is not the filename inference deleted twice —
     nothing here reads a name off a file to decide what a file *is*; a written
     equivalence between two detector names is looked up, and a band the probe
     does not carry an equivalent for gets no suggestion at all.

     `suggestChannels` holds the "only while nobody has chosen" rule, so this
     effect may fire as often as React likes.
  */
  useEffect(() => { suggestChannels(first); }, [suggestChannels, first, propertyId, probeId]);
  const suggested = suggestedChannels(first);
  const matched = !!suggested && !!channels
    && channels[0] === suggested[0] && channels[1] === suggested[1];
  // Over the three values, never over the store's accessor — and memoised
  // rather than selected, because an overridden pair is a fresh object. See
  // `pipelinePreset`.
  const preset = useMemo(
    () => pipelinePreset({ propertyId, probeId, channels }),
    [propertyId, probeId, channels],
  );
  const missing = missingChannels(first);
  const existing = preset ? defs.find((d) => d.name === preset.name && d.expression === preset.expression) : undefined;

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-property="">
      <div className="grid grid-cols-2 gap-2.5">
        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Biophysical property
              <InfoHint content="What is being measured about the cell. Each property is read from a ratio of two detectors and has its own fixed axis." />
            </span>
          }
          hint={property?.description}
        >
          <Select
            value={propertyId ?? ''}
            data-bio-property=""
            onChange={(e) => setProperty(e.target.value)}
          >
            <option value="" disabled>Choose a property…</option>
            {BIOPHYSICAL_PROPERTIES.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>

        <Field
          label={
            <span className="inline-flex items-center gap-1.5">
              Probe
              <InfoHint content="The dye the property was measured with. It decides which detectors the value is computed from." />
            </span>
          }
          hint={probe?.description}
        >
          <Select
            value={probeId ?? ''}
            data-bio-probe=""
            disabled={!property}
            onChange={(e) => setProbe(e.target.value)}
          >
            <option value="" disabled>Choose a probe…</option>
            {(property?.probes ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </Select>
        </Field>
      </div>

      {preset && (
        <div className="p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)] space-y-2">
          <div className="flex items-center gap-2">
            <Sigma size={13} className="shrink-0 text-[var(--text-accent)]" />
            <span className="text-xs font-medium text-[var(--text-primary)]">{preset.name}</span>
            {existing
              ? <Badge tone="ok">already defined</Badge>
              : <Badge tone="accent">will be added</Badge>}
          </div>
          <p className="font-mono text-2xs text-[var(--text-secondary)]" data-bio-equation="">
            {preset.expression}
          </p>

          <DetectorPair samples={samples} preset={preset} probe={probe} matched={matched} />

          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            {preset.hint}{' '}
            {existing
              ? <>This workspace already has it, so nothing new is created — the pipeline uses the definition you can see in Parameters.</>
              : <>It is added to <button type="button" className="underline underline-offset-2 hover:text-[var(--text-secondary)]" onClick={() => setView('parameters')}>Parameters</button> when you continue, as an ordinary derived parameter you can edit or delete there.</>}
          </p>
        </div>
      )}

      {missing.length > 0 && (
        <Callout tone="warn">
          <span className="font-medium">This property cannot be computed from the loaded files.</span>{' '}
          It needs{' '}
          {missing.map((m, i) => (
            <span key={m}>
              {i > 0 && (i === missing.length - 1 ? ' and ' : ', ')}
              <span className="font-mono">{m}</span>
            </span>
          ))}
          , which {missing.length === 1 ? 'is' : 'are'} not among this instrument&rsquo;s detectors. Either these files
          were not acquired with the probe named above, or this instrument names its detectors differently — in which
          case pick the two bands it collects them on, under the equation.
        </Callout>
      )}
    </div>
  );
}

/**
 * The two detectors the property is read on, and what each one collects.
 *
 * ## Why this is here and not only in the Parameters panel
 *
 * Every detector name this project ships is a Cytek Aurora's, and the equation
 * above is arithmetic over two of them. The arithmetic travels; the names do
 * not. Somebody running the same probe on a platform that calls its bands
 * something else could previously get exactly this far, read *"needs V1-A and
 * V7-A"*, and have nowhere to go but the Parameters panel to retype an equation
 * that was already on the screen in front of them.
 *
 * ## Why the wavelengths are shown, and why only as a caption
 *
 * A detector name is not self-describing — nothing in the file says what V1
 * collects, since `$PnS`, `$PnF` and `$PnL` are all absent — so choosing the
 * equivalent band on another instrument means knowing that V1 is 428 nm and V7
 * is 542 nm. That is the caption's whole job. It annotates a name the user
 * picked and never picks one: no default comes from the table, no channel is
 * matched to a wavelength, and a name the table does not carry simply gets no
 * caption. Inferring the pair from the numbers would be the filename-guessing
 * this project has deleted twice, in nanometres.
 */
function DetectorPair({ samples, preset, probe, matched }: {
  samples: Sample[];
  preset: ParameterPreset;
  probe: BiophysicalProbe | undefined;
  /** The pair standing here is this instrument's name for the probe's bands. */
  matched: boolean;
}) {
  const channels = useBiophysics((s) => s.channels);
  const setChannels = useBiophysics((s) => s.setChannels);
  const resetChannels = useBiophysics((s) => s.resetChannels);

  // Fluorescence first and separately: a ratio of two emission bands is what
  // every one of these properties is, so scatter and the derived columns are
  // reachable but are not what the list opens on.
  const options = useMemo(() => {
    const fluorescence: string[] = [];
    const other: string[] = [];
    for (const p of samples[0]?.parsed.metadata.parameters ?? []) {
      if (/^time$/i.test(p.name)) continue;
      (p.type === 'Raw_Fluorescence' ? fluorescence : other).push(p.name);
    }
    return { fluorescence, other };
  }, [samples]);

  const pick = (index: 0 | 1) => (value: string) => (
    index === 0 ? setChannels(value, preset.channels[1]) : setChannels(preset.channels[0], value)
  );

  return (
    <div className="space-y-1.5 pt-0.5" data-bio-channels="">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-[var(--text-tertiary)]">Detectors</span>
        <InfoHint content="The two bands the ratio is computed from, in the order the equation reads them: the first rises with the property, the second falls. Change them if this instrument names its detectors differently — the equation is rebuilt around whatever you pick. Wavelengths are the Cytek Aurora configuration and are shown for reference only." />
        {/* Said on the card, not silently: the pair below was filled in from the
            probe's own list of what other instruments call these two bands,
            because this file has neither of the published ones. It is a
            suggestion until it is touched, and the reset link beside it is how
            it is untouched. */}
        {matched && (
          <span data-bio-channels-matched="">
            <Badge tone="accent">matched to this instrument</Badge>
          </span>
        )}
        <span className="flex-1" />
        {channels && (
          <button
            type="button"
            data-bio-channel-reset=""
            onClick={resetChannels}
            className="text-2xs text-[var(--text-tertiary)] underline underline-offset-2 hover:text-[var(--text-secondary)]"
          >
            Reset to {probe?.label ?? 'the probe'}&rsquo;s bands
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {([0, 1] as const).map((i) => {
          const value = preset.channels[i];
          const present = options.fluorescence.includes(value) || options.other.includes(value);
          const band = describeDetectorFull(value);
          return (
            <div key={i} className="space-y-1">
              <Select
                value={value}
                data-bio-channel={i}
                aria-label={i === 0 ? 'First detector' : 'Second detector'}
                onChange={(e) => pick(i)(e.target.value)}
              >
                {/* A channel the loaded file does not have stays selectable and
                    stays visible — dropping it would silently rewrite the
                    analysis to some other detector, and the warning below the
                    card is what explains the state. */}
                {!present && <option value={value}>{value} — not on this file</option>}
                {options.fluorescence.length > 0 && (
                  <optgroup label="Fluorescence detectors">
                    {options.fluorescence.map((n) => <option key={n} value={n}>{n}</option>)}
                  </optgroup>
                )}
                {options.other.length > 0 && (
                  <optgroup label="Other channels">
                    {options.other.map((n) => <option key={n} value={n}>{n}</option>)}
                  </optgroup>
                )}
              </Select>
              <p className="text-[10px] text-[var(--text-tertiary)] leading-snug whitespace-pre-line" data-bio-band={i}>
                {band ?? 'No band is published for this name.'}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ========================================================================== */

/** Step 3 — the histogram, on the fixed axis, inside the cell gate. */
function StepDistribution() {
  const propertyId = useBiophysics((s) => s.propertyId);
  const records = useBiophysics((s) => s.samples);
  const property = propertyById(propertyId);

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-distribution="">
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <Waves size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            Every sample&rsquo;s worksheet now carries a histogram of {property?.label.toLowerCase() ?? 'the property'},
            counted over the cells you gated in Step 1.
          </p>
          <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
            Check the distributions by clicking <em>Open the distributions</em>.
          </p>
          <OpenWorksheet label="Open the distributions" />
        </div>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">Worksheets</span>
          <span className="tnum">{records.filter((r) => r.layoutId).length}</span>
        </p>
        <SampleList />
      </div>
    </div>
  );
}

/** The pipeline's samples, in walk order, as a clickable list. */
function SampleList({ onPick, activeIndex }: { onPick?: (i: number) => void; activeIndex?: number } = {}) {
  const records = useBiophysics((s) => s.samples);
  const samples = useWorkspace((s) => s.samples);
  const nameOf = (id: string) => samples.find((s) => s.id === id)?.name ?? id;

  return (
    <>
      {records.map((r, i) => {
        const done = isFitted(r);
        const Row = onPick ? 'button' : 'div';
        return (
          <Row
            key={r.sampleId}
            {...(onPick ? { type: 'button' as const, onClick: () => onPick(i) } : {})}
            data-bio-sample-row={nameOf(r.sampleId)}
            data-bio-sample-fitted={done ? '' : undefined}
            className={cn(
              'flex items-center gap-2 w-full px-2.5 h-7 text-left',
              i > 0 && 'hairline-t',
              activeIndex === i ? 'bg-[var(--surface-selected)]' : onPick && 'hover:bg-[var(--surface-hover)]',
            )}
          >
            <span className={cn('shrink-0', done ? 'text-[var(--status-ok)]' : 'text-[var(--status-warn)]')}>
              {done ? <Check size={11} /> : <AlertTriangle size={11} />}
            </span>
            <span className="text-2xs truncate min-w-0 flex-1 text-[var(--text-secondary)]">{nameOf(r.sampleId)}</span>
            {r.countSource === 'user' && (
              <Tooltip content="The number of populations on this sample was set by hand, so a re-fit leaves it alone.">
                <span className="shrink-0"><Badge tone="accent">set by hand</Badge></span>
              </Tooltip>
            )}
            <span className="text-2xs font-mono text-[var(--text-disabled)] shrink-0 tnum">
              {r.fit ? `${r.fit.components.length} pop${r.fit.components.length === 1 ? '' : 's'}` : '—'}
            </span>
          </Row>
        );
      })}
    </>
  );
}

/* ========================================================================== */

/**
 * Step 4 — the populations, per sample, reviewed and corrected.
 *
 * The fit is a **first draft**, and everything on this screen exists so it can be
 * treated as one. Three ways to correct it, in increasing order of how often they
 * are needed:
 *
 *   1. **Drag a boundary** on the review chart, which moves the two gates it
 *      divides together so the populations stay abutting. The same gates are
 *      also ordinary draggable range gates on the worksheet, where dragging one
 *      moves that population's edge alone — both gestures are real and they mean
 *      slightly different things.
 *   2. **Override the count** — *Auto*, 1, 2 or 3 — which re-fits with the number
 *      stated. A sample whose count was set by hand is then left alone by *Re-fit
 *      all*, because re-running the automatic choice over a decision somebody
 *      made is the application overwriting an answer rather than offering one.
 *   3. **Rename a population**, in the gate tree, like any other gate.
 */
function StepPopulations({
  samples, onWork,
}: {
  samples: Sample[];
  onWork: (message: string, work: () => void) => Promise<void>;
}) {
  const records = useBiophysics((s) => s.samples);
  const walkIndex = useBiophysics((s) => s.walkIndex);
  const goToSample = useBiophysics((s) => s.goToSample);
  const fitSample = useBiophysics((s) => s.fitSample);
  const propertyId = useBiophysics((s) => s.propertyId);
  const mode = useBiophysics((s) => s.mode);
  const activeLayoutId = usePlot((s) => s.activeLayoutId);

  const scheme = schemeFor(mode);
  /**
   * How many components this scheme will fit, which is what the override offers.
   *
   * Both schemes ask since 2026-08-21, and the viability one asks for more:
   * describing a mixture's live cells takes as many modes as it takes, and the
   * *populations* stay two however many that is — see `populationIntervals`.
   */
  const maxCount = maxComponentsFor(scheme);
  const viability = scheme === 'viability';

  const index = sampleIndexForLayout(records, activeLayoutId, walkIndex);
  const current = records[index];
  const sample = current ? samples.find((s) => s.id === current.sampleId) : undefined;
  const property = propertyById(propertyId);

  const gateNames = useGates((s) => s.shared);
  // Subscribed so a gate recoloured as an override redraws the legend swatches.
  useGates((s) => s.overrides);
  const names = useMemo(() => {
    if (!current) return [];
    return current.populationGateIds.map((id) => gateNames.find((g) => g.id === id)?.name ?? '');
  }, [current, gateNames]);

  if (!current || !sample || !property) {
    return (
      <div className="p-2.5">
        <EmptyState
          size="sm"
          className="mt-6"
          icon={<Atom size={15} />}
          title="Nothing fitted yet"
          description="Go back to Step 3 and press “Find the populations”."
        />
      </div>
    );
  }

  const fit = current.fit;
  const meanings = fit ? populationNames(property, fit.components.length, scheme) : [];
  // Each population in its gate's colour — the swatch beside its name matches
  // the band on the worksheet and the curve on the chart. See `populationColors`.
  const legendColors = populationColors(current, useGates.getState().gatesFor(sample.id), meanings.length);
  const fittedCount = records.filter(isFitted).length;

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-populations="">
      {/* Step 4 is the last step in single-cell-type mode and the middle of the
          pipeline in the other, so the terminal banner is conditional on the
          mode as well as on the work — see `PipelineDone`. Multi mode says it on
          Step 5 instead. */}
      {mode === 'single' && fittedCount > 0 && fittedCount === records.length && (
        <PipelineDone
          testId="data-bio-done"
          title="Pipeline complete"
          next={[
            { view: 'statistics', label: 'Statistics', hint: 'Compare the populations across your samples' },
            { view: 'export', label: 'Export', hint: 'write the per-cell values out' },
          ]}
        >
          {property.label} is fitted on all {records.length} sample{records.length === 1 ? '' : 's'},
          and each population is an ordinary gate. Check the splits below before you read the
          numbers — a boundary you move is counted again straight away.
        </PipelineDone>
      )}

      {/* The walker. "Sample 3 of 6", with the arrows either side of it. */}
      <div className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <IconButton label="Previous sample" size="sm" data-bio-walk-prev="" disabled={index <= 0} onClick={() => goToSample(index - 1)}>
          <ChevronLeft size={14} />
        </IconButton>
        <div className="flex-1 min-w-0 text-center">
          <p className="text-xs font-medium text-[var(--text-primary)] truncate" data-bio-walk-label="">{sample.name}</p>
          <p className="text-2xs text-[var(--text-tertiary)] tnum">
            Sample {index + 1} of {records.length}
            {fit && <> · {fit.components.length} population{fit.components.length === 1 ? '' : 's'}</>}
          </p>
        </div>
        <IconButton label="Next sample" size="sm" data-bio-walk-next="" disabled={index >= records.length - 1} onClick={() => goToSample(index + 1)}>
          <ChevronRight size={14} />
        </IconButton>
      </div>

      {/* The fit itself: the distribution, the curves over it, the boundaries
          and what each population holds. */}
      <FitReview sample={sample} record={current} property={property} names={names} scheme={scheme} />

      {/* The override. `Auto` is a real option rather than the absence of one,
          because "go back to what the fit chose" has to be reachable after a
          count has been stated.

          Offered under both schemes, and what it counts differs between them:
          populations under the graded reading, **components** under viability,
          where the reading is always live-and-dead and the count decides only
          how well the live cells are described. See `maxComponentsFor`. */}
      <div className="p-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-[var(--text-primary)]">
            {viability ? 'Modes fitted on this sample' : 'Populations on this sample'}
          </span>
          {viability && <Badge tone="info">live and dead</Badge>}
          {current.countSource === 'user' && <Badge tone="accent">set by hand</Badge>}
          {current.countSource === 'fitted' && current.overruledBic && (
            <Tooltip content={`A fit with more components scored better on BIC, but its populations were closer than ${MIN_SEPARATION} pooled SDs or one of them held under ${Math.round(MIN_COMPONENT_WEIGHT * 100)}% of events.`}>
              <span><Badge tone="info">refined</Badge></span>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={current.countSource === 'fitted' ? 'primary' : 'secondary'}
            data-bio-count="auto"
            onClick={() => void onWork('Re-fitting…', () => { fitSample(sample, null); })}
          >
            Auto
          </Button>
          {Array.from({ length: maxCount }, (_, i) => i + 1).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={current.countSource === 'user' && fit?.components.length === k ? 'primary' : 'secondary'}
              data-bio-count={k}
              onClick={() => void onWork(
                viability ? `Fitting ${k} mode${k === 1 ? '' : 's'}…` : `Fitting ${k} population${k === 1 ? '' : 's'}…`,
                () => { fitSample(sample, k); },
              )}
            >
              {k}
            </Button>
          ))}
        </div>
        <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
          {viability
            ? <>A mixture is read for viability only, and there is <em>one</em> split: the least ordered mode is dead
              and everything above it is live. The count above is how many modes describe the distribution — a
              monocyte membrane is more fluid than a lymphocyte&rsquo;s, so a mixture often needs three, and all of
              them are <em>Live</em>. Telling those cell types apart is the next step&rsquo;s job. Drag the boundary
              above if it sits wrong on this sample.</>
            : current.countSource === 'user'
              ? <>You set this count, so it is left alone by the automatic fit. <em>Auto</em> hands it back.</>
              : <>The fit chose this count from the shape of the distribution. If it is visibly wrong for this sample,
                please number it yourself for better fit.</>}
        </p>
      </div>


      {/* What each population means, so the names on the gates are accounted
          for rather than merely appearing. */}
      {fit && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
          <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
            <span className="flex-1 min-w-0">What these populations are</span>
            <span>least ordered first</span>
          </p>
          {/* Dead → Internalised → Live: left to right along the axis (0.35). */}
          {meanings.map((m, i) => ({ m, i })).reverse().map(({ m, i }, row) => (
            <div key={m.name} className={cn('flex items-start gap-2 px-2.5 py-1.5', row > 0 && 'hairline-t')}>
              <span
                aria-hidden
                className="mt-1 h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: legendColors[i] }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-2xs text-[var(--text-secondary)]">
                  {names[i] || m.name}
                  {names[i] && names[i] !== m.name && (
                    <span className="text-[var(--text-disabled)]"> · renamed from {m.name}</span>
                  )}
                </p>
                <p className="text-2xs text-[var(--text-tertiary)] leading-snug">{m.meaning}</p>
              </div>
              {/* What the *gate* holds — its share of the gated events and the
                  property's mean over them — not the component's own weight and
                  mean. Two overlapping populations always disagree about both,
                  and the gate is what Statistics will count, so showing the
                  model's numbers beside a gate reporting something else is one
                  fact described two ways. Both move as a boundary is dragged.
                  See `populationStats`. */}
              <span className="shrink-0 text-right text-2xs font-mono tnum text-[var(--text-disabled)]">
                <span className="block">{((current.shares[i] ?? 0) * 100).toFixed(1)}%</span>
                {/* The fitted mean is a fallback only, and it is the mean of the
                    first component in *this population* — not of the component
                    at the same index, which under viability is a live mode
                    wherever the fit found more than two. See `meanOf`. */}
                {fit.components[componentForPopulation(i, fit.components.length, scheme)] && (
                  <span className="block">
                    {meanOf(current, i, fit.components[componentForPopulation(i, fit.components.length, scheme)]!.mean)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">Samples</span>
          <span className="tnum">{fittedCount} of {records.length} fitted</span>
        </p>
        <SampleList onPick={goToSample} activeIndex={index} />
      </div>
    </div>
  );
}

/* ========================================================================== */

/**
 * Step 5 (multi mode) — identify the cell types.
 *
 * The step that makes a multi-cell readout mean anything: the property has been
 * measured over every gated cell, and this is where those cells are told apart.
 *
 * It builds **plots, not populations**. The gating is done with the ordinary
 * gate tools and produces ordinary gates, so Statistics and Export read a cell
 * type as `Cells/Singlets/Live/CD4` with no further step — the doublet cut and the
 * viability split are both above it, because Step 1 traced one and Step 3 read
 * the property inside it. There is no cell-type model, no
 * list of known immune phenotypes and no automatic CD4 gate, because every one
 * of those would be this panel claiming to know something about the experiment
 * it was never told.
 *
 * ## The marker picker is gone (2026-08-17)
 *
 * It used to ask which parameters to gate on, tick by tick, and pair them two at
 * a time into density plots. Both halves were wrong. The pairing was arbitrary —
 * CD3 against CD4 because those were clicked first — and so was the selection:
 * *Unmixed markers* ticked every abundance in the panel at once, which on a
 * typical panel is many parameters and plots of combinations nobody had a
 * question about. A step whose job is to hand somebody a place to start gating
 * was instead producing a wall of plots to delete.
 *
 * What it builds now is the three plots the pipeline itself already justifies —
 * the cells, the singlets, and the property against acquisition time over the
 * live population. See `immunePanelsForSample`. Everything else is drawn by the
 * person who knows what they are looking for, on the same worksheet, and it
 * survives the walk because `showImmuneSample` re-points panels rather than
 * rebuilding them.
 *
 * ## One worksheet, walked across the samples
 *
 * It built a worksheet **per sample** until 2026-08-15, and that was the defect:
 * a cell-type gating strategy is a strategy — CD3, then CD4, then CD45RA, the
 * same plots and the same gates on every file — so eight worksheets meant
 * drawing it eight times with nothing making the eighth agree with the first.
 *
 * There is one worksheet. The arrows re-point its panels at the next sample and
 * the gates on it are ordinary **shared** gates, so the strategy is drawn once
 * and every sample is measured by it. What differs per sample is what should —
 * and, since the *Cells* gate is shared by default in this mode, that is now the
 * *Live* boundary alone unless Step 1 was told otherwise.
 */
function StepImmune({
  samples, onWork,
}: {
  samples: Sample[];
  onWork: (message: string, work: () => void) => Promise<void>;
}) {
  const build = useBiophysics((s) => s.buildImmuneWorksheets);
  const showSample = useBiophysics((s) => s.showImmuneSample);
  const walkIndex = useBiophysics((s) => s.walkIndex);
  const immuneLayoutId = useBiophysics((s) => s.immuneLayoutId);
  // Subscribed although nothing below reads it directly: `immuneLayoutId()` is a
  // store accessor, so this is what re-renders the panel once the worksheet has
  // been built and the records carry its id.
  const records = useBiophysics((s) => s.samples);
  const propertyId = useBiophysics((s) => s.propertyId);

  const property = propertyById(propertyId);
  const built = records.length > 0 && !!immuneLayoutId();
  const index = Math.min(Math.max(0, walkIndex), Math.max(0, samples.length - 1));
  const showing = samples[index];

  /*
     The three, named where the operator can check them against the worksheet.

     One short sentence each (2026-08-19). These read as a paragraph before, and
     a paragraph is the wrong shape for a caption on a plot the reader is looking
     at: it argues for the plot rather than naming it. Anything that needed
     arguing is in `immunePanelsForSample`, where it belongs.
  */
  const plots = [
    {
      title: 'Cells',
      detail: 'FSC-A × SSC-A, with the gate from Step 1 on it.',
    },
    {
      title: 'Singlets',
      detail: 'FSC-A × FSC-H, inside Cells. The doublet cut is traced for you — drag it.',
    },
    {
      title: `${property?.label ?? 'The property'} over time`,
      detail: `${property?.label ?? 'The property'} × Time, inside Singlets. Live and Dead are the two populations. A slope means the run drifted (e.g., internalisation).`,
    },
  ];

  return (
    <div className="p-2.5 space-y-2.5" data-bio-step-immune="">
      <div className="flex items-start gap-2.5 p-2.5 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
        <Boxes size={13} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs text-[var(--text-primary)] leading-snug">
            One worksheet for the whole experiment, with three plots on it. Gate your cell types once — the
            gates are shared, so every sample is measured by the same ones.
          </p>
        </div>
      </div>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] overflow-hidden">
        <p className="flex items-center gap-2 px-2.5 h-7 hairline-b bg-[var(--surface-raised)] text-2xs text-[var(--text-tertiary)]">
          <span className="flex-1 min-w-0">What is on the worksheet</span>
          <span className="tnum">3 plots</span>
        </p>
        {plots.map((p, i) => (
          <div
            key={p.title}
            data-bio-immune-plot={p.title}
            className={cn('flex items-start gap-2 px-2.5 py-1.5', i > 0 && 'hairline-t')}
          >
            <span className="mt-px shrink-0 text-2xs font-mono tnum text-[var(--text-disabled)]">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-2xs text-[var(--text-secondary)]">{p.title}</p>
              <p className="text-2xs text-[var(--text-tertiary)] leading-snug">{p.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={<Crosshair size={12} />}
          data-bio-build-immune=""
          onClick={() => { void onWork('Building the cell-type worksheet…', () => { build(samples); }); }}
        >
          {built ? 'Rebuild the worksheet' : 'Build the worksheet'}
        </Button>
        {built && <OpenWorksheet label="Open the worksheet" />}
      </div>

      {built && (
        <p className="text-2xs text-[var(--text-tertiary)] leading-snug">
          <em>Rebuild</em> replaces the three plots with fresh ones — including any you added yourself. Use it
          when something earlier in the pipeline has changed, not to refresh the view.
        </p>
      )}

      {/* Which sample the one worksheet is pointed at. Here as well as on the
          worksheet's own strip and in the sample browser, because this panel and
          the plots are on different views: whichever one you are looking at has
          to be able to move the walk. All three write the same state. */}
      {built && showing && (
        <div className="flex items-center gap-2 p-2 rounded-[var(--radius-md)] bg-[var(--surface-raised)] border border-[var(--border-subtle)]">
          <IconButton
            size="sm"
            label="Previous sample"
            data-bio-immune-prev=""
            disabled={index <= 0}
            onClick={() => showSample(samples, index - 1)}
          >
            <ChevronLeft size={14} />
          </IconButton>
          <div className="flex-1 min-w-0 text-center">
            <p className="text-xs font-medium text-[var(--text-primary)] truncate" data-bio-immune-label="">
              {showing.name}
            </p>
            <p className="text-2xs text-[var(--text-tertiary)] tnum">
              Sample {index + 1} of {samples.length} · same gates on every one
            </p>
          </div>
          <IconButton
            size="sm"
            label="Next sample"
            data-bio-immune-next=""
            disabled={index >= samples.length - 1}
            onClick={() => showSample(samples, index + 1)}
          >
            <ChevronRight size={14} />
          </IconButton>
        </div>
      )}

      {built && (
        <PipelineDone
          testId="data-bio-done"
          next={[
            { view: 'statistics', label: 'Statistics', hint: 'Counts and percentages for every population' },
            { view: 'export', label: 'Export', hint: 'per-cell values as CSV or Excel' },
          ]}
        >
          The worksheet is up on all {samples.length} sample{samples.length === 1 ? '' : 's'}, with{' '}
          {property?.label ?? 'the property'} measured on the same cells. Gating the cell types is the one
          thing left, and it is yours — draw them on the worksheet and they appear in Statistics as you go.
        </PipelineDone>
      )}
    </div>
  );
}
