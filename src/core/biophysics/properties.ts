/**
 * What the Biophysics pipeline can measure, and with what.
 *
 * A registry rather than a special case, and that is the whole reason this file
 * exists as a file. There is exactly one property today — membrane order, read
 * with Pro12A — and building it as one hardcoded state would mean the second
 * property is a rewrite of the panel rather than an entry in a list. Every part
 * of the pipeline that could differ between properties is a field here: the
 * parameter it is computed from, the axis it is read on, and what the populations
 * along that axis mean.
 *
 * Adding a property is adding an object to `BIOPHYSICAL_PROPERTIES`. Adding a
 * probe for an existing property is adding one to its `probes`. Nothing in
 * `state/biophysicsStore.ts` or `panels/BiophysicsView.tsx` names membrane order
 * or Pro12A, which is the check on whether that claim is true.
 *
 * ## Why the parameter is a preset name and not an equation
 *
 * `parameterPreset` points at `core/parameterPresets.ts` — the same list the
 * Parameters panel offers — so the parameter this pipeline creates is the
 * parameter that panel would have created. Holding the expression here instead
 * would put two definitions of membrane order in the codebase, and the failure
 * mode of their drifting apart is a workspace with two parameters of the same
 * name computing different numbers, neither of which announces itself.
 */

import { presetNamed, ratioExpression, type ParameterPreset } from '@/core/parameterPresets';
import {
  intervalsFor, MAX_COMPONENTS, MAX_FIT_COMPONENTS, type MixtureFit,
} from './mixture';

/** A dye or label used to read a property off a cell. */
export interface BiophysicalProbe {
  id: string;
  label: string;
  /** One line, for the row under the name. */
  description: string;
  /**
   * The two detectors this probe is read on, in the property's preset order.
   *
   * On the probe rather than on the property, because it is a fact about the
   * *dye*: two probes for one property emit in different places, and a second
   * membrane-order probe added here would need its own pair rather than a second
   * property. The default only — `resolvedPreset` takes the user's pair when
   * there is one, which is what makes the pipeline run on an instrument whose
   * detectors are named something else entirely.
   */
  channels: readonly [string, string];
  /**
   * The same two bands, as other instruments name their detectors.
   *
   * ## Why this is not the filename inference this project deleted twice
   *
   * `channels` above is an Aurora's. A conventional instrument collects the same
   * two emission bands through filter blocks it names after a dye — a FACSCanto
   * II calls them *Pacific Blue-A* and *AmCyan-A* — so a panel acquired there
   * has every channel the probe needs and not one name in common with the
   * published pair. Until now that read as *"needs V1-A and V7-A, which are not
   * among this instrument's detectors"*, and the operator had to know which two
   * of nine channels to pick.
   *
   * What is stated here is an **equivalence between two names**, written down on
   * the probe by the person who added it, exactly as `channels` is. Nothing is
   * derived: not from the filename, not from `$PnS`, and not from a wavelength —
   * `core/detectors.ts` is not consulted, and a band this list does not carry
   * gets no suggestion rather than a guessed one. And it is a *suggestion*: it
   * only ever applies when the published pair is absent from the file, it fills
   * in the same two dropdowns the operator would have used, and *Reset to the
   * probe's bands* puts it back — which is the standing rule that a suggestion
   * stays visible and stays touchable.
   */
  alternatives?: readonly (readonly [string, string])[];
}

export interface BiophysicalProperty {
  id: string;
  label: string;
  /** One line for the selector; the panel puts it under the name. */
  description: string;
  /**
   * Name of the derived-parameter preset this property is computed from.
   *
   * Resolved through `presetNamed`. See the note at the top of the file for why
   * this is a name and not an expression.
   */
  parameterPreset: string;
  /**
   * The fixed axis the distribution is read on.
   *
   * Stated rather than measured, because it is a property of the *quantity* and
   * not of the sample: a normalised ratio of two emission bands is bounded at
   * ±1 by construction, so an axis fitted to whatever this file happened to
   * produce would make two samples' histograms incomparable — which is the one
   * thing this pipeline exists to do. Written into the histogram panel's
   * `xMin`/`xMax`, which are explicit axis limits in data units and are exactly
   * the mechanism for a range somebody states. See *An axis range is
   * configuration* in PROGRESS.md.
   */
  axis: { min: number; max: number };
  /**
   * What the populations mean, **most ordered first**.
   *
   * The list is indexed by position in the fit's own descending-mean order, so
   * `populations[0]` is the highest-valued population. `naming` picks the right
   * subset when fewer than three are found — see `populationNames`.
   */
  populations: PopulationMeaning[];
  probes: BiophysicalProbe[];
}

export interface PopulationMeaning {
  /** The gate's name. Editable afterwards like any other population's. */
  name: string;
  /** What it is, for the review list beside the fit. */
  meaning: string;
}

/**
 * How to name `k` populations when the fit found fewer than the full set.
 *
 * A separate list per count rather than "take the first k", because the shortened
 * cases are not truncations — they are different claims. Two populations in a
 * membrane-order distribution are *live* and *everything that is not live*; the
 * lower one is not "the internalised population with the dead ones missing", and
 * calling it *Internalised / pre-apoptotic* would state something the fit did not
 * find. One population is the whole sample, and the honest name for it is the
 * healthy bucket, which is what the specification asks for and what a
 * cytometrist would write on the gate by hand.
 */
export type PopulationNaming = Record<number, PopulationMeaning[]>;

const MEMBRANE_ORDER_POPULATIONS: PopulationMeaning[] = [
  { name: 'Live', meaning: 'Most ordered — intact membrane, probe not internalised.' },
  { name: 'Internalised / pre-apoptotic', meaning: 'Intermediate order — probe internalised, membrane reorganising.' },
  { name: 'Dead', meaning: 'Least ordered — membrane integrity lost.' },
];

const MEMBRANE_ORDER_NAMING: PopulationNaming = {
  1: [{ name: 'Live', meaning: 'One population: the whole gated sample reads as healthy at this resolution.' }],
  2: [
    { name: 'Live', meaning: 'The more ordered of two populations.' },
    { name: 'Internalised or dead', meaning: 'The less ordered population — internalised probe and dead cells are not resolved from each other here.' },
  ],
  3: MEMBRANE_ORDER_POPULATIONS,
};

/**
 * How many populations a distribution is read as, and what they are called.
 *
 * **`graded`** is the reading the pipeline was built on and is right for one cell
 * type: every event in the gate is the same kind of cell, so a band at
 * intermediate order is that cell in an intermediate *state* — probe
 * internalised, membrane reorganising — and resolving up to three of them is the
 * result.
 *
 * **`viability`** is the reading for a mixture of cell types, and it exists
 * because the graded one is **wrong there in a specific, misleading way**. In
 * PBMCs the intermediate band is largely monocytes: a monocyte membrane is
 * genuinely more fluid than a lymphocyte's, so a live monocyte sits where a
 * pre-apoptotic lymphocyte would and the graded scheme labels it
 * *Internalised / pre-apoptotic*. That is a false claim about a healthy cell,
 * and no amount of tuning the mixture rule fixes it, because the two really are
 * at the same membrane order — what tells them apart is their markers, which is
 * what Step 5 is for.
 *
 * So a mixed sample is read for **viability only**: the least ordered population
 * is dead, everything above it is live, and which *kind* of live cell an event is
 * comes from the cell-type gates rather than from where it sits on this axis.
 * Two populations, on every sample, with the same two names — which is also what
 * makes them one shared gate rather than one per file. See `biophysicsStore`.
 */
export type PopulationScheme = 'graded' | 'viability';

const MEMBRANE_ORDER_VIABILITY: PopulationNaming = {
  1: [{ name: 'Live', meaning: 'One population: nothing in this gate reads as dead at this resolution.' }],
  2: [
    { name: 'Live', meaning: 'The more ordered population. Spans every live cell type — a monocyte membrane is more fluid than a lymphocyte’s, so both are here.' },
    { name: 'Dead', meaning: 'Least ordered — membrane integrity lost.' },
  ],
};

const VIABILITY_NAMING: Record<string, PopulationNaming> = {
  'membrane-order': MEMBRANE_ORDER_VIABILITY,
};

/**
 * The most **components** a scheme will fit — which under `viability` is not the
 * number of populations it reports.
 *
 * ## Why four, and why that is not the thing the old rule protected (2026-08-21)
 *
 * It was two, and the reasoning was sound about the danger and wrong about the
 * remedy: a third component in a mixture is a second live cell type, not a third
 * viability state, so a scheme that turns every component into a gate would put
 * a boundary through the middle of the live cells and call the lower half
 * pre-apoptotic. Capping the *fit* at two is one way to stop that. It is also
 * the way that makes the fit describe the data badly — PBMCs hold lymphocytes,
 * monocytes and dead cells with genuinely different membrane order, and forcing
 * one Gaussian to cover the two live modes drags the live component's mean down
 * and the split that separates it from *Dead* with it.
 *
 * What actually protects the live cells is `populationIntervals`: **one
 * boundary, below the least ordered component**. Everything above it is live,
 * however many modes the fit needed to describe it. With that in place the
 * ceiling is free to be what describes the distribution, so it is —
 * `MAX_FIT_COMPONENTS`, offered as *Auto* and 1–4 on Step 4.
 *
 * `MAX_COMPONENTS` stays the ceiling for the **graded** reading, where a
 * component *is* a population and a fourth would be a fourth state to name. That
 * one is measured; see `mixture.ts`.
 */
export function maxComponentsFor(scheme: PopulationScheme): number {
  return scheme === 'viability' ? MAX_FIT_COMPONENTS : MAX_COMPONENTS;
}

/**
 * How many populations a scheme reports for a fit of `k` components.
 *
 * The graded reading names one per component. The viability reading names two —
 * live and dead — for any fit that found a split at all, and one for a fit that
 * found a single mode and so has nothing to call dead.
 */
export function populationCountFor(scheme: PopulationScheme, k: number): number {
  return scheme === 'viability' ? Math.min(k, 2) : k;
}

/**
 * The interval each **population** owns, ordered most ordered first.
 *
 * `intervalsFor` answers this per component; this answers it per population, and
 * the two differ only under `viability`, where the answer is the whole point of
 * the scheme: *Dead* is the interval below the lowest boundary and *Live* is
 * everything above it, so a four-component fit still produces exactly **two**
 * gates and exactly **one** line to drag.
 *
 * Which boundary is the lowest is not a choice — `boundaries` ascends while
 * `components` descends, so the last component is the least ordered one and its
 * upper edge is `boundaries[0]`. That is the split the whole reading is about:
 * membrane order collapses when integrity is lost, so the bottom mode is the
 * dead one and every mode above it is a live cell type.
 *
 * Derived from the component intervals rather than from `boundaries` directly,
 * so the ±Infinity outer edges come from the one function that decides them.
 */
export function populationIntervals(
  fit: MixtureFit,
  scheme: PopulationScheme,
): Array<{ min: number; max: number }> {
  const parts = intervalsFor(fit);
  if (scheme !== 'viability' || parts.length < 2) return parts;
  const dead = parts[parts.length - 1]!;
  return [{ min: dead.max, max: parts[0]!.max }, dead];
}

/**
 * Which of a fit's boundaries divide populations, as indices into `boundaries`.
 *
 * Every one of them under `graded`. Exactly one under `viability` — index 0, the
 * lowest — because the others are internal to the description of the live cells
 * and are not gates. A chart drawing a draggable handle on one of those would be
 * offering to move a line that nothing counts.
 */
export function populationBoundaries(
  boundaryCount: number,
  scheme: PopulationScheme,
): number[] {
  if (boundaryCount <= 0) return [];
  if (scheme === 'viability') return [0];
  return Array.from({ length: boundaryCount }, (_, i) => i);
}

/**
 * The population palette entry a fitted population's gate is created in, by
 * what the population *is* (2026-10-22).
 *
 * The most ordered population is live and is teal; the least ordered, when
 * there is more than one, is dead and is red; anything between is amber — the
 * intermediate band of a three-population reading. It used to be the index plus
 * one, so *Dead* was green under one reading and pink under the other, and a
 * colour said nothing about what the population was. A role colour is the
 * default a new gate takes, nothing more: every chart colours a population by
 * its gate's own colour, so a gate recoloured in the tree is recoloured
 * everywhere, and a workspace written before this keeps the colours it had.
 */
/**
 * The colour a fitted population's gate is created in (0.35): three Okabe–Ito
 * hues, distinct for every common colour-vision deficiency and from each other —
 * the 0.34 red and amber were not. Dead is reddish purple rather than dark grey
 * because grey would read as the near-black fitted sum and the neutral bars.
 * Literal values, so the same colour in both themes and on paper.
 */
export const BIO_POPULATION_COLORS = {
  live: '#009E73',
  intermediate: '#E69F00',
  dead: '#CC79A7',
} as const;

export function populationColor(population: number, count: number): string {
  if (population === 0) return BIO_POPULATION_COLORS.live;
  if (count >= 2 && population === count - 1) return BIO_POPULATION_COLORS.dead;
  return BIO_POPULATION_COLORS.intermediate;
}

export function populationColorIndex(population: number, count: number): number {
  if (population === 0) return 6; // --pop-07, teal: live
  if (count >= 2 && population === count - 1) return 7; // --pop-08, red: dead
  return 1; // --pop-02, amber: intermediate
}

/**
 * Which population a component belongs to, as an index into `populationNames`.
 *
 * Under `viability` every component except the least ordered one is *Live*, so
 * the fit's curves can be drawn in their population's colour rather than in four
 * colours that would claim four populations on a chart whose whole legend says
 * two.
 */
export function populationOfComponent(
  componentIndex: number,
  componentCount: number,
  scheme: PopulationScheme,
): number {
  if (scheme !== 'viability' || componentCount < 2) return componentIndex;
  return componentIndex === componentCount - 1 ? 1 : 0;
}

/**
 * The first component belonging to a population, or `−1`.
 *
 * The inverse of `populationOfComponent`, and it exists for one job: a
 * population's *fitted* mean, which is only ever a fallback for a record with no
 * observed mean stored. Under viability that is component 0 for *Live* and the
 * last one for *Dead*, and reading `components[populationIndex]` instead — which
 * is what both panels did — reports a live mode's mean as the dead population's
 * on any fit with more than two.
 */
export function componentForPopulation(
  populationIndex: number,
  componentCount: number,
  scheme: PopulationScheme,
): number {
  for (let i = 0; i < componentCount; i++) {
    if (populationOfComponent(i, componentCount, scheme) === populationIndex) return i;
  }
  return -1;
}

/**
 * Naming tables by property id.
 *
 * Beside the properties rather than on them, because a property with the
 * ordinary three-then-truncate behaviour should not have to carry a table at
 * all — `populationNames` falls back to slicing `populations`, which is the
 * right answer for a property whose intermediate states are genuinely
 * intermediate.
 */
const NAMING: Record<string, PopulationNaming> = {
  'membrane-order': MEMBRANE_ORDER_NAMING,
};

export const BIOPHYSICAL_PROPERTIES: BiophysicalProperty[] = [
  {
    id: 'membrane-order',
    label: 'Membrane order',
    description: 'Lipid packing in the plasma membrane, read as the generalised polarisation of a solvatochromic probe.',
    parameterPreset: 'Membrane order',
    /*
       −1 to 1, fixed.

       A normalised ratio `(a − b)/(a + b)` of two non-negative emission bands
       cannot leave that interval, so this is the quantity's own range rather
       than a framing choice — and pinning it is what makes two samples'
       histograms the same picture. Auto-ranging would fit each sample to its own
       spread; one condition's distribution living between 0.44 and 0.47 and the other's
       between 0.31 and 0.52 would then be drawn identically and look the same.
    */
    axis: { min: -1, max: 1 },
    populations: MEMBRANE_ORDER_POPULATIONS,
    probes: [
      {
        id: 'pro12a',
        label: 'Pro12A',
        description: 'Solvatochromic membrane probe. Ordered and disordered emission read on two violet-excited bands.',
        channels: ['V1-A', 'V7-A'],
        /*
           The same two violet bands on a conventional cytometer, ordered first.

           A FACSCanto II or an LSRFortessa names its violet blocks after the dye
           they were specified for — Pacific Blue at 450/50 and AmCyan at 510/50
           — and some configurations name the identical two blocks by wavelength
           instead. Both spellings are here because both are what the file says,
           and neither is computed from the numbers in them.
        */
        alternatives: [
          ['Pacific Blue-A', 'AmCyan-A'],
          ['V450-A', 'V500-A'],
        ],
      },
    ],
  },
];

export function propertyById(id: string | null | undefined): BiophysicalProperty | undefined {
  return BIOPHYSICAL_PROPERTIES.find((p) => p.id === id);
}

export function probeById(
  property: BiophysicalProperty | undefined,
  id: string | null | undefined,
): BiophysicalProbe | undefined {
  return property?.probes.find((p) => p.id === id);
}

/** The preset this property's parameter is defined by, with its published channels. */
export function presetFor(property: BiophysicalProperty): ParameterPreset | undefined {
  return presetNamed(property.parameterPreset);
}

/** The pair a probe is read on out of the box, or the preset's own if it names none. */
export function defaultChannels(
  property: BiophysicalProperty | undefined,
  probe: BiophysicalProbe | undefined,
): readonly [string, string] | undefined {
  if (probe) return probe.channels;
  return property ? presetFor(property)?.channels : undefined;
}

/**
 * The pair to offer on **this instrument**, when the probe's own is not on it.
 *
 * Pure, and it answers `undefined` far more often than not — which is the point.
 * Three things have to hold before it proposes anything: the probe's published
 * pair must be **absent** from the file (a spectral panel is untouched, always),
 * the probe must carry a written-down equivalent under `alternatives`, and every
 * name in that alternative must be present. Anything else and the operator picks
 * the two bands themselves, exactly as before.
 *
 * The returned names are the **file's own spelling**, not the list's, so the two
 * dropdowns can select them: a match is case-insensitive because instrument
 * software is inconsistent about it (*AmCyan-A*, *Amcyan-A*), and handing back
 * the registry's casing would set a `<select>` to a value it has no option for.
 *
 * There is no fuzzy matching, no prefix rule and no wavelength arithmetic here,
 * and there must not be: this is a lookup of one exact name against another, and
 * everything softer than that is the guessing this codebase deletes.
 */
export function channelsForDetectors(
  probe: BiophysicalProbe | undefined,
  available: readonly string[],
): readonly [string, string] | undefined {
  if (!probe?.alternatives?.length) return undefined;
  const byLower = new Map(available.map((n) => [n.toLowerCase(), n]));
  const has = (n: string) => byLower.get(n.toLowerCase());
  // The published pair is on this file — nothing to suggest, and proposing an
  // alternative over a detector the probe actually names would be wrong.
  if (has(probe.channels[0]) && has(probe.channels[1])) return undefined;
  for (const pair of probe.alternatives) {
    const a = has(pair[0]);
    const b = has(pair[1]);
    if (a && b && a !== b) return [a, b];
  }
  return undefined;
}

/**
 * The preset the pipeline will actually create, with the chosen detectors in it.
 *
 * ## Why an override exists at all (2026-08-24)
 *
 * Every detector name in this codebase is a Cytek Aurora's. The arithmetic is
 * not: a generalised polarisation is the normalised difference of an ordered and
 * a disordered emission band, and which detectors those are is a fact about the
 * instrument that acquired the file. Somebody running the same probe on a
 * platform that calls them something else could get as far as Step 2, read
 * *"needs V1-A and V7-A, which are not among this instrument's detectors"*, and
 * stop — with the equation they needed printed on the screen in front of them
 * and no way to point it at their own channels short of leaving for the
 * Parameters panel and typing it by hand.
 *
 * ## Why this is not a second model of the parameter
 *
 * It returns **the preset object itself** when the pair is the published one, so
 * the default path is byte-identical to what the Parameters panel's preset row
 * produces and `presetFor(p) === PARAMETER_PRESETS[0]` still holds. An override
 * changes the two channels and rebuilds the equation through `ratioExpression`
 * — the same function the presets are built with — so there is still exactly one
 * definition of what this arithmetic is. The *name* is untouched, deliberately:
 * a re-pointed membrane order is still membrane order, and a name carrying its
 * channels could not be written anyway, since `validateDefinition` rejects a
 * parameter name containing brackets or a hyphen.
 */
export function resolvedPreset(
  property: BiophysicalProperty | undefined,
  probe: BiophysicalProbe | undefined,
  override: readonly [string, string] | null | undefined,
): ParameterPreset | undefined {
  const base = property ? presetFor(property) : undefined;
  if (!base) return undefined;
  const pair = override ?? defaultChannels(property, probe) ?? base.channels;
  if (pair[0] === base.channels[0] && pair[1] === base.channels[1]) return base;
  return { ...base, channels: [pair[0], pair[1]], expression: ratioExpression(pair[0], pair[1]) };
}

/**
 * Names for the populations a fit of `k` components produced, most ordered
 * first.
 *
 * **`k` is a component count and the answer is a population count**, so it goes
 * through `populationCountFor` first — a viability fit of four components names
 * two, and asking the table for four would fall through to the graded list and
 * put *Internalised* on a gate in a mode that does not have one.
 *
 * A count above the property's own list length is clamped rather than refused,
 * so a property added later with two named populations degrades to sensible
 * strings rather than to `undefined` on a gate.
 */
export function populationNames(
  property: BiophysicalProperty,
  k: number,
  scheme: PopulationScheme = 'graded',
): PopulationMeaning[] {
  const n = populationCountFor(scheme, k);
  const table = scheme === 'viability'
    ? VIABILITY_NAMING[property.id] ?? NAMING[property.id]
    : NAMING[property.id];
  const named = table?.[n];
  if (named && named.length === n) return named;
  if (n >= property.populations.length) return property.populations;
  // The general fallback: the top `n` of the ordered list. Right for a property
  // whose intermediate states really are intermediate, which is why it is the
  // default and `NAMING` is the exception.
  return property.populations.slice(0, n);
}

/**
 * The default property and probe.
 *
 * Pre-selected, and that is **not** the filename-guessing this project deleted
 * twice. The distinction is what is being claimed: `classifyControl` decided
 * *which files were reference controls*, silently, from a string, and being
 * wrong produced a matrix built from the wrong signatures. This selects the only
 * entry in a list of one, on a screen whose entire content is that list, where
 * the alternative is an empty dropdown and a disabled *Next* button telling
 * somebody to pick the option they can already see.
 *
 * The moment there are two properties this stops being free, and the honest
 * behaviour then is to open on nothing — which is why the caller reads this
 * rather than the panel hardcoding index 0: the rule is stated here, once.
 */
export function defaultSelection(): { propertyId: string | null; probeId: string | null } {
  const only = BIOPHYSICAL_PROPERTIES.length === 1 ? BIOPHYSICAL_PROPERTIES[0]! : null;
  if (!only) return { propertyId: null, probeId: null };
  return {
    propertyId: only.id,
    probeId: only.probes.length === 1 ? only.probes[0]!.id : null,
  };
}
