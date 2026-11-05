import { describe, expect, it } from 'vitest';
import { liveBoundaryIndex } from '@/state/biophysicsStore';
import {
  asBiophysicsMode, BIOPHYSICS_STEPS, biophysicsWalk, checkBiophysicsStep, checkCells,
  checkDistribution, checkImmune, checkProperty, checkUnmixing, clampStep, emptySample,
  firstStep, isFitted,
  isWalkingSamples, LAST_BIOPHYSICS_STEP, lastStep, nextStep, pipelineSampleIds, prevStep,
  crossWalkIndex, sampleIndexForLayout, schemeFor, stepsFor, uniqueWorksheetNames, walkFamilies,
  type BiophysicsSample,
} from './pipeline';
import {
  BIOPHYSICAL_PROPERTIES, componentForPopulation, defaultChannels, defaultSelection,
  maxComponentsFor, populationBoundaries, populationCountFor, populationIntervals,
  populationNames, populationOfComponent, presetFor, probeById, propertyById, resolvedPreset,
} from './properties';
import { intervalsFor, MAX_COMPONENTS, type MixtureFit } from './mixture';
import { PARAMETER_PRESETS, presetNamed, ratioExpression } from '../parameterPresets';

const fitted = (id: string, k: number): BiophysicsSample => ({
  ...emptySample(id),
  layoutId: `L_${id}`,
  populationGateIds: Array.from({ length: k }, (_, i) => `g${i}`),
  fit: {
    components: Array.from({ length: k }, (_, i) => ({ weight: 1 / k, mean: 0.5 - i * 0.3, sd: 0.05 })),
    k, logLikelihood: 0, bic: 0, boundaries: [], converged: true, iterations: 1, total: 100,
  },
  shares: Array.from({ length: k }, () => 1 / k),
});

describe('the steps', () => {
  it('are four, numbered from one, ending at the stated last', () => {
    expect(BIOPHYSICS_STEPS.map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect(LAST_BIOPHYSICS_STEP).toBe(4);
  });

  it('name what each one is for, because the tracker renders the labels', () => {
    expect(BIOPHYSICS_STEPS.map((s) => s.label))
      .toEqual(['Cells', 'Property', 'Distribution', 'Populations']);
  });
});

describe('the two modes', () => {
  it('reads anything that is not multi as single', () => {
    expect(asBiophysicsMode('multi')).toBe('multi');
    expect(asBiophysicsMode('single')).toBe('single');
    expect(asBiophysicsMode(undefined)).toBe('single');
    expect(asBiophysicsMode('immunophenotyping')).toBe('single');
  });

  it('walks four steps for one cell type and six for many', () => {
    expect(stepsFor('single').map((s) => s.step)).toEqual([1, 2, 3, 4]);
    expect(stepsFor('multi').map((s) => s.step)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  /*
     The property this whole numbering exists to protect. Multi mode brackets
     the shared four rather than renumbering them, so a step number means one
     thing regardless of mode — and a `step` read out of a workspace written
     before modes existed still names the step it named.
  */
  it('gives steps 1 to 4 the same meaning in both modes', () => {
    const single = stepsFor('single');
    for (const def of stepsFor('multi').filter((s) => s.step >= 1 && s.step <= 4)) {
      expect(single.find((s) => s.step === def.step)).toEqual(def);
    }
  });

  it('starts and ends where the mode says', () => {
    expect([firstStep('single'), lastStep('single')]).toEqual([1, 4]);
    expect([firstStep('multi'), lastStep('multi')]).toEqual([0, 5]);
    expect(LAST_BIOPHYSICS_STEP).toBe(4);
  });

  it('steps through a mode without leaving it', () => {
    expect(nextStep('single', 4)).toBe(4);
    expect(prevStep('single', 1)).toBe(1);
    expect(nextStep('multi', 0)).toBe(1);
    expect(prevStep('multi', 1)).toBe(0);
    expect(nextStep('multi', 4)).toBe(5);
    expect(nextStep('multi', 5)).toBe(5);
  });

  /*
     Switching multi to single while standing on 0 or 5 would otherwise leave
     the panel on a step its own tracker does not list — a blank body with no
     way back.
  */
  it('sends the start of one pipeline to the start of the other', () => {
    // The behaviour `setMode` builds on: someone at the beginning of single
    // mode who switches to multi must land on the unmixing prerequisite, not
    // on Cells, or they never see the instruction the mode exists for.
    expect(clampStep('multi', firstStep('single'))).toBe(1);
    expect(firstStep('multi')).toBe(0);
  });

  it('clamps a step the mode does not have', () => {
    expect(clampStep('single', 0)).toBe(1);
    expect(clampStep('single', 5)).toBe(4);
    expect(clampStep('multi', 0)).toBe(0);
    expect(clampStep('multi', 5)).toBe(5);
    expect(clampStep('single', 3)).toBe(3);
  });
});

describe('checkUnmixing', () => {
  it('needs samples before anything else', () => {
    expect(checkUnmixing(0, 0).ok).toBe(false);
  });

  /*
     Advice, not a refusal. Files unmixed on the instrument arrive with markers
     as ordinary parameters and this pipeline cannot tell — and must not guess,
     which is the same rule that stops anything here reading a filename.
  */
  it('lets an unmixed-elsewhere workspace through, with a word about it', () => {
    const c = checkUnmixing(0, 8);
    expect(c.ok).toBe(true);
    expect(c.advice).toMatch(/already unmixed/i);
  });

  it('says so when only some samples carry markers', () => {
    expect(checkUnmixing(3, 8).advice).toMatch(/3 of 8/);
  });

  it('is quiet when every sample is unmixed', () => {
    const c = checkUnmixing(8, 8);
    expect(c.ok).toBe(true);
    expect(c.advice).toBeUndefined();
  });
});

describe('checkImmune', () => {
  it('never blocks — it is the last step', () => {
    expect(checkImmune(0).ok).toBe(true);
    expect(checkImmune(1).ok).toBe(true);
  });

  // The marker count went with the marker picker (2026-08-17): the worksheet is
  // the same three plots whatever the panel holds, so the one state left worth
  // reporting is that it has not been built.
  it('asks for the worksheet, and says nothing once it is there', () => {
    expect(checkImmune(0).advice).toMatch(/build the worksheet/i);
    expect(checkImmune(1).advice).toBeUndefined();
  });
});

describe('checkCells', () => {
  it('refuses an empty workspace and says what is missing', () => {
    const c = checkCells(0, false);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/load at least one sample/i);
  });

  it('refuses until the gate has been placed', () => {
    expect(checkCells(3, false).ok).toBe(false);
    expect(checkCells(3, true).ok).toBe(true);
  });
});

describe('checkProperty', () => {
  it('refuses until a property and a probe are chosen, one at a time', () => {
    expect(checkProperty(null, null, true, []).reason).toMatch(/property/i);
    expect(checkProperty('membrane-order', null, true, []).reason).toMatch(/probe/i);
    expect(checkProperty('membrane-order', 'pro12a', true, []).ok).toBe(true);
  });

  it('names the channels the loaded files do not have', () => {
    // The step is refused here rather than three steps later with an empty
    // histogram, which is the whole argument for checking on the way out.
    const c = checkProperty('membrane-order', 'pro12a', false, ['V1-A', 'V7-A']);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain('V1-A');
    expect(c.reason).toContain('V7-A');
  });

  it('still refuses when it cannot name them', () => {
    expect(checkProperty('membrane-order', 'pro12a', false, []).ok).toBe(false);
  });
});

describe('checkDistribution', () => {
  it('refuses with nothing built', () => {
    expect(checkDistribution(0).ok).toBe(false);
    expect(checkDistribution(2).ok).toBe(true);
  });
});

describe('checkBiophysicsStep', () => {
  const ctx = {
    sampleCount: 3, gated: true,
    propertyId: 'membrane-order', probeId: 'pro12a',
    parameterResolves: true, missing: [], built: 3,
  };

  it('dispatches to the right check for each step', () => {
    expect(checkBiophysicsStep(1, { ...ctx, gated: false }).ok).toBe(false);
    expect(checkBiophysicsStep(2, { ...ctx, probeId: null }).ok).toBe(false);
    expect(checkBiophysicsStep(3, { ...ctx, built: 0 }).ok).toBe(false);
  });

  it('never refuses the last step, which has no Next to refuse', () => {
    expect(checkBiophysicsStep(4, { ...ctx, sampleCount: 0, built: 0 }).ok).toBe(true);
  });
});

describe('sampleIndexForLayout', () => {
  const samples = [fitted('a', 2), fitted('b', 3), fitted('c', 1)];

  it('reads the position off the active worksheet, not off a held index', () => {
    // Three surfaces change worksheet and the layout dropdown knows nothing
    // about this pipeline. Deriving from `activeLayoutId` is what makes them one
    // control rather than three copies to keep level.
    expect(sampleIndexForLayout(samples, 'L_b', 0)).toBe(1);
    expect(sampleIndexForLayout(samples, 'L_c', 0)).toBe(2);
  });

  it('falls back for a layout that is not one of theirs', () => {
    expect(sampleIndexForLayout(samples, 'L_main', 2)).toBe(2);
    expect(sampleIndexForLayout(samples, null, 1)).toBe(1);
  });

  it('clamps the fallback into range rather than returning it', () => {
    expect(sampleIndexForLayout(samples, null, 99)).toBe(2);
    expect(sampleIndexForLayout(samples, null, -4)).toBe(0);
    expect(sampleIndexForLayout([], null, 3)).toBe(0);
  });
});

describe('biophysicsWalk', () => {
  /*
     2026-08-18 — it asks what is on screen, not which step the panel is on.

     The predicate this replaces was `step === 4 && something is built`, so the
     strip was absent on Steps 1-3, which build and rewrite those very
     worksheets, and absent on Step 5, whose one sheet cannot be walked any other
     way. It is the same shape `core/layout/bottomBar.ts` was written to fix,
     one level down.
  */
  const built = [fitted('a', 2)];

  it('names the per-sample walk when a distribution worksheet is on screen', () => {
    expect(biophysicsWalk(built, built[0]!.layoutId)).toBe('samples');
    expect(isWalkingSamples(built, built[0]!.layoutId)).toBe(true);
  });

  it('names the cell-type walk when the one cell-type worksheet is on screen', () => {
    const withImmune = [{ ...fitted('a', 2), immuneLayoutId: 'L1' }];
    expect(biophysicsWalk(withImmune, 'L1')).toBe('cell-types');
  });

  it('is null for a general worksheet, which hands the bottom back to LayoutBar', () => {
    expect(biophysicsWalk(built, 'somebody-elses-layout')).toBeNull();
    expect(biophysicsWalk(built, null)).toBeNull();
    expect(biophysicsWalk([emptySample('a')], null)).toBeNull();
    expect(biophysicsWalk([], 'L1')).toBeNull();
  });
});

describe('walkFamilies', () => {
  /*
     What the bottom strip's worksheet switch is built from.

     The report it answers: after a pipeline over eight samples the strip listed
     eight sample names on both kinds of worksheet, so nothing said which kind was
     on screen or what a click would do.
  */
  it('names neither before Step 1 has built anything', () => {
    expect(walkFamilies([])).toEqual([]);
    expect(walkFamilies([emptySample('a')])).toEqual([]);
  });

  it('names the per-sample walk alone until the cell-type sheet exists', () => {
    // Which is what stops the switch appearing — and therefore stops it being
    // an affordance that could build the second worksheet.
    expect(walkFamilies([fitted('a', 2), fitted('b', 1)])).toEqual(['samples']);
  });

  it('names both once Step 5 has built the one cell-type worksheet', () => {
    const withImmune = [
      { ...fitted('a', 2), immuneLayoutId: 'L_immune' },
      { ...fitted('b', 1), immuneLayoutId: 'L_immune' },
    ];
    expect(walkFamilies(withImmune)).toEqual(['samples', 'cell-types']);
  });
});

describe('crossWalkIndex', () => {
  /*
     Crossing between the two walks carries the sample by id, never by position.

     `goToSample` indexes the pipeline's own records; `showImmuneSample` indexes
     `pipelineSamples(...)`, the workspace list filtered to the unmixed files.
     They agree right up until they do not — a file imported after Step 1 is in
     the second before Step 1's top-up puts it in the first — and carrying the
     index across would move the operator to a neighbouring sample silently.
  */
  const ids = ['a', 'b', 'c'];

  it('finds the same sample in the other list whatever its position there', () => {
    expect(crossWalkIndex(ids, 'c', 0)).toBe(2);
    expect(crossWalkIndex(['c', 'b', 'a'], 'c', 0)).toBe(0);
  });

  it('does not carry the position when the two lists have drifted', () => {
    // 'd' arrived in the walk being left and is not in the walk being entered.
    // Position 3 would be out of range; the fallback is clamped, not returned.
    expect(crossWalkIndex(ids, 'd', 3)).toBe(2);
    expect(crossWalkIndex(ids, 'd', 1)).toBe(1);
  });

  it('clamps a fallback and survives an empty target list', () => {
    expect(crossWalkIndex(ids, null, -2)).toBe(0);
    expect(crossWalkIndex(ids, null, 99)).toBe(2);
    expect(crossWalkIndex([], 'a', 4)).toBe(0);
  });
});

describe('schemeFor', () => {
  it('reads one cell type as graded and a mixture for viability only', () => {
    // A claim about the biology, not a preference: in PBMCs the intermediate
    // band is monocytes, whose membranes are genuinely more fluid — so calling
    // it pre-apoptotic would label a healthy cell as dying.
    expect(schemeFor('single')).toBe('graded');
    expect(schemeFor('multi')).toBe('viability');
  });
});

describe('pipelineSampleIds', () => {
  const ids = ['ctrl1', 'ctrl2', 'mc1', 'mc2'];
  const unmixed = new Set(['mc1', 'mc2']);

  it('takes every sample in single mode', () => {
    expect(pipelineSampleIds('single', ids, unmixed)).toEqual(ids);
    expect(pipelineSampleIds('single', ids, new Set())).toEqual(ids);
  });

  it('takes only the unmixed samples in multi mode', () => {
    // The case: unmix a panel and walk into Biophysics in the same window,
    // where the workspace also holds the single-stain controls. Which samples
    // carry a matrix is recorded, not guessed — no filename is read.
    expect(pipelineSampleIds('multi', ids, unmixed)).toEqual(['mc1', 'mc2']);
  });

  it('falls back to every sample when no matrix has been applied', () => {
    // Files unmixed on the instrument arrive with their markers as ordinary
    // parameters, and nothing can tell them apart without guessing.
    expect(pipelineSampleIds('multi', ids, new Set())).toEqual(ids);
  });
});

describe('isFitted', () => {
  it('needs both a fit and the gates it produced', () => {
    expect(isFitted(emptySample('a'))).toBe(false);
    expect(isFitted(fitted('a', 3))).toBe(true);
    expect(isFitted({ ...fitted('a', 3), populationGateIds: [] })).toBe(false);
    expect(isFitted({ ...fitted('a', 3), fit: null })).toBe(false);
  });
});

describe('uniqueWorksheetNames', () => {
  it('leaves distinct names alone', () => {
    expect(uniqueWorksheetNames(['Control 1', 'Treated 1'])).toEqual(['Control 1', 'Treated 1']);
  });

  it('numbers duplicates rather than refusing them', () => {
    // Two samples with one name breaks nothing — worksheets are found by id —
    // but a walk showing the same label twice is exactly the ambiguity a tab
    // strip exists to remove.
    expect(uniqueWorksheetNames(['A', 'A', 'A'])).toEqual(['A', 'A (2)', 'A (3)']);
  });

  it('gives an empty name something to be', () => {
    expect(uniqueWorksheetNames(['', '  '])).toEqual(['Sample', 'Sample (2)']);
  });
});

/* ========================================================================== */

describe('the property registry', () => {
  it('offers membrane order with Pro12A', () => {
    const p = propertyById('membrane-order')!;
    expect(p.label).toBe('Membrane order');
    expect(probeById(p, 'pro12a')!.label).toBe('Pro12A');
  });

  it('is a list, so a second property is an entry rather than a rewrite', () => {
    expect(Array.isArray(BIOPHYSICAL_PROPERTIES)).toBe(true);
    for (const p of BIOPHYSICAL_PROPERTIES) {
      expect(p.probes.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.axis.max).toBeGreaterThan(p.axis.min);
    }
  });

  it('reads its parameter off the Parameters panel’s own preset, not a copy', () => {
    // The claim that makes "the same parameter object the Parameters panel would
    // create" true by construction rather than by inspection.
    const p = propertyById('membrane-order')!;
    const preset = presetFor(p)!;
    expect(preset).toBe(presetNamed('Membrane order'));
    expect(PARAMETER_PRESETS).toContain(preset);
    expect(preset.expression).toBe('(V1-A - V7-A)/(V1-A + V7-A)');
  });

  it('pins membrane order to −1…1, which is the quantity’s own range', () => {
    expect(propertyById('membrane-order')!.axis).toEqual({ min: -1, max: 1 });
  });

  it('is undefined for a property or probe that does not exist', () => {
    expect(propertyById('nothing')).toBeUndefined();
    expect(propertyById(null)).toBeUndefined();
    expect(probeById(propertyById('membrane-order'), 'nope')).toBeUndefined();
  });
});

describe('resolvedPreset', () => {
  const property = propertyById('membrane-order')!;
  const probe = probeById(property, 'pro12a')!;

  it('is the shared preset object when the detectors are the probe’s own', () => {
    // The property that keeps "one definition of membrane order" true: the
    // default path must be the same object, not an equal copy.
    expect(resolvedPreset(property, probe, null)).toBe(presetNamed('Membrane order'));
    expect(resolvedPreset(property, probe, ['V1-A', 'V7-A'])).toBe(presetNamed('Membrane order'));
  });

  it('rebuilds the equation around a re-pointed pair', () => {
    const re = resolvedPreset(property, probe, ['B2-A', 'B9-A'])!;
    expect(re.expression).toBe('(B2-A - B9-A)/(B2-A + B9-A)');
    expect(re.channels).toEqual(['B2-A', 'B9-A']);
    // Built through the same function the presets are, so a re-pointed equation
    // and a hand-typed one cannot differ by a bracket or a space.
    expect(re.expression).toBe(ratioExpression('B2-A', 'B9-A'));
  });

  it('keeps the name, which is what the workspace and Statistics match on', () => {
    expect(resolvedPreset(property, probe, ['Green-1', 'Green-4'])!.name).toBe('Membrane order');
  });

  it('leaves the published preset untouched', () => {
    resolvedPreset(property, probe, ['B2-A', 'B9-A']);
    expect(presetNamed('Membrane order')!.expression).toBe('(V1-A - V7-A)/(V1-A + V7-A)');
    expect(presetNamed('Membrane order')!.channels).toEqual(['V1-A', 'V7-A']);
  });

  it('is undefined without a property', () => {
    expect(resolvedPreset(undefined, probe, null)).toBeUndefined();
  });

  it('agrees with the probe about which bands are the default', () => {
    expect(defaultChannels(property, probe)).toEqual(presetNamed('Membrane order')!.channels);
  });
});

describe('populationNames', () => {
  const membrane = propertyById('membrane-order')!;

  it('reads highest membrane order to lowest', () => {
    expect(populationNames(membrane, 3).map((p) => p.name))
      .toEqual(['Live', 'Internalised / pre-apoptotic', 'Dead']);
  });

  it('calls two populations live and not-live, rather than dropping the third name', () => {
    // Not a truncation. The lower of two is not "the internalised population
    // with the dead ones missing" — the fit did not resolve them from each
    // other, and a name claiming it did would state something it did not find.
    expect(populationNames(membrane, 2).map((p) => p.name))
      .toEqual(['Live', 'Internalised or dead']);
  });

  it('puts one population in the healthy bucket', () => {
    expect(populationNames(membrane, 1).map((p) => p.name)).toEqual(['Live']);
  });

  it('explains what each one means, because the review list shows it', () => {
    for (const k of [1, 2, 3]) {
      for (const p of populationNames(membrane, k)) {
        expect(p.meaning.length).toBeGreaterThan(10);
      }
    }
  });

  it('never returns more names than were asked for', () => {
    for (const property of BIOPHYSICAL_PROPERTIES) {
      for (const k of [1, 2, 3]) expect(populationNames(property, k)).toHaveLength(k);
    }
  });

  it('names two populations under viability however many components were fitted', () => {
    // The whole of the 2026-08-21 change in one assertion: the count it is given
    // is a *component* count, and a mixture described by four modes still has
    // two populations. Asking the graded table for four names is what would put
    // *Internalised* on a gate in a mode that does not have one.
    for (const k of [2, 3, 4]) {
      expect(populationNames(membrane, k, 'viability').map((p) => p.name))
        .toEqual(['Live', 'Dead']);
    }
    expect(populationNames(membrane, 1, 'viability').map((p) => p.name)).toEqual(['Live']);
  });
});

/* -------------------------------------------------------------------------
   Components are not populations (2026-08-21)

   The viability reading fits as many modes as the distribution needs and gates
   **two**: everything above the lowest boundary is live. These four functions
   are the whole of that rule, and every panel and the store read them rather
   than deciding it again.
   ------------------------------------------------------------------------- */

describe('populations under the viability scheme', () => {
  /** A fit of `k` components, descending, with ascending boundaries between. */
  const fitOf = (means: number[]): MixtureFit => ({
    k: means.length,
    components: means.map((mean) => ({ mean, sd: 0.05, weight: 1 / means.length })),
    boundaries: means.slice(1).map((m, i) => (m + means[i]!) / 2).reverse(),
    logLikelihood: 0,
    bic: 0,
    converged: true,
    iterations: 1,
    total: 1000,
  });

  it('gates two populations at one boundary, whatever the fit found', () => {
    for (const k of [2, 3, 4]) {
      const means = Array.from({ length: k }, (_, i) => 0.6 - i * 0.2);
      const iv = populationIntervals(fitOf(means), 'viability');
      expect(iv).toHaveLength(2);
      // Live above the lowest split, Dead below it, and they abut exactly.
      expect(iv[0]!.max).toBe(Number.POSITIVE_INFINITY);
      expect(iv[1]!.min).toBe(Number.NEGATIVE_INFINITY);
      expect(iv[0]!.min).toBe(iv[1]!.max);
      // And that split is the *lowest* boundary — the one above the least
      // ordered component, not the one under the most ordered.
      expect(iv[0]!.min).toBeCloseTo(fitOf(means).boundaries[0]!, 12);
    }
  });

  it('leaves the graded reading one population per component', () => {
    const iv = populationIntervals(fitOf([0.6, 0.4, 0.2]), 'graded');
    expect(iv).toEqual(intervalsFor(fitOf([0.6, 0.4, 0.2])));
  });

  it('offers one draggable split under viability and all of them under graded', () => {
    expect(populationBoundaries(3, 'viability')).toEqual([0]);
    expect(populationBoundaries(3, 'graded')).toEqual([0, 1, 2]);
    expect(populationBoundaries(0, 'viability')).toEqual([]);
  });

  it('puts every component except the least ordered one in Live', () => {
    expect([0, 1, 2, 3].map((i) => populationOfComponent(i, 4, 'viability'))).toEqual([0, 0, 0, 1]);
    expect([0, 1, 2].map((i) => populationOfComponent(i, 3, 'graded'))).toEqual([0, 1, 2]);
    // One component is one population and is live: there is nothing to call dead.
    expect(populationOfComponent(0, 1, 'viability')).toBe(0);
  });

  it('finds the first component of a population, for its fitted mean', () => {
    // Live's is the most ordered mode; Dead's is the last one, not the one at
    // index 1 — which on a four-component fit is a live cell type.
    expect(componentForPopulation(0, 4, 'viability')).toBe(0);
    expect(componentForPopulation(1, 4, 'viability')).toBe(3);
    expect(componentForPopulation(2, 3, 'graded')).toBe(2);
    expect(componentForPopulation(2, 4, 'viability')).toBe(-1);
  });

  it('raises the component ceiling without moving the graded one', () => {
    expect(maxComponentsFor('viability')).toBe(4);
    expect(maxComponentsFor('graded')).toBe(MAX_COMPONENTS);
    expect(populationCountFor('viability', 4)).toBe(2);
    expect(populationCountFor('graded', 3)).toBe(3);
  });
});

describe('defaultSelection', () => {
  it('pre-selects the only property and the only probe', () => {
    // Not the filename guessing this project deleted twice: the claim is "the
    // one entry in a list of one", on a screen whose whole content is that list.
    const d = defaultSelection();
    expect(d.propertyId).toBe(BIOPHYSICAL_PROPERTIES.length === 1 ? 'membrane-order' : null);
    if (d.propertyId) expect(d.probeId).toBe('pro12a');
  });
});

/* -------------------------------------------------------------------------
   Which boundary is the live one (2026-08-17)

   `liveBoundaryIndex` lives in `biophysicsStore` beside the action that uses it,
   but the arithmetic is the pipeline's: `boundaries` ascends while `components`
   descends, so component 0 — the most ordered, and therefore *Live* under either
   scheme — has its lower edge at the last boundary. Three places ask, and this
   pins the relationship they all depend on.
   ------------------------------------------------------------------------- */

describe('liveBoundaryIndex', () => {
  it('is the last boundary under the graded reading', () => {
    // Two populations: one boundary, and it is the live/dead split.
    expect(liveBoundaryIndex(1)).toBe(0);
    // Three: the upper split is Live's lower edge; the lower one divides the
    // two below it and is not the same question on a two-population sample.
    expect(liveBoundaryIndex(2)).toBe(1);
  });

  it('is the first under viability, where only the lowest split is a gate', () => {
    // They coincide at one boundary, which is every viability fit until the
    // component ceiling was raised — and is why this took no scheme before.
    expect(liveBoundaryIndex(1, 'viability')).toBe(0);
    expect(liveBoundaryIndex(3, 'viability')).toBe(0);
    expect(liveBoundaryIndex(3, 'graded')).toBe(2);
  });

  it('is −1 for a sample that fitted one population', () => {
    expect(liveBoundaryIndex(0)).toBe(-1);
    expect(liveBoundaryIndex(0, 'viability')).toBe(-1);
  });
});
