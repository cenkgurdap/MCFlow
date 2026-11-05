/**
 * The rules behind the four-step unmixing workflow.
 *
 * Pure, and separated from the store for the reason every other pure module in
 * this project is: *"can this step be left yet"* is a question about a list of
 * assignments, and a question about a list should be answerable without a
 * renderer, a store, or a file on disk. What is left in `spectralStore` is the
 * state and the side effects — creating layouts, seeding gates, calling the
 * unmixing maths.
 *
 * ## What replaced what (2026-08-06)
 *
 * The panel this supports used to guess. `classifyControl` ran a filename parse
 * over every loaded sample, decided which ones "looked like" controls, decided
 * which of those was unstained, and offered one button that assigned the lot.
 * Every one of those decisions was a claim about the experiment inferred from a
 * string, made silently, and correctable only by noticing it had been made —
 * and it is the same class of mistake as `suggestGroups`, deleted on 2026-08-03
 * for merging two opposite conditions on a shared filename prefix.
 *
 * **Nothing here infers anything from a filename.** A sample is a reference
 * control because somebody ticked it, it has a role because somebody chose one,
 * and it is called what somebody typed. What the app *does* compute is the thing
 * it can actually measure: which detector a control is brightest in.
 *
 * ## The steps
 *
 * 1. **Select** — which loaded samples are reference controls. Empty to start.
 * 2. **Assign** — a role and a typed identity for each, plus a negative
 *    reference for single stains.
 * 3. **Gate** — one generated worksheet per control, walked in peak-detector
 *    order.
 * 4. **Compute** — build the matrix from the gated populations, and save it.
 *
 * **There is no fifth step.** *Apply* used to be one, and applying a matrix to a
 * multicolour sample is not the last leg of a setup — it is a thing somebody
 * does repeatedly, weeks later, in whatever workspace they are already in. It is
 * now the *Load unmixing* tab beside this wizard rather than a step glued to the
 * end of it. See `UnmixingView`.
 */

import type { FcsMetadata } from '@/core/fcs/types';

export type ControlRole = 'stain' | 'unstained' | 'autofluorescence';

/**
 * Where a single-stain control's **negative** baseline comes from.
 *
 * The distinction is not cosmetic and it is not a preference — it is a fact
 * about how the control was prepared, and the two kinds cannot be gated the same
 * way:
 *
 *   - `unstained` — a cell-based single stain. The tube contains stained cells
 *     and nothing else, so the negative baseline has to come from a *separate*
 *     unstained control sample.
 *   - `self` — compensation/unmixing **beads**. One tube carries both a negative
 *     and a positive bead population, so both gates are drawn on this control's
 *     own data and no separate unstained sample is involved for this signature.
 *
 * `unstained` is the default because it is the more common case for the
 * cell-based panels this application was built against; the ten files in
 * `an earlier dataset` happen to be beads, which is why both paths are exercised.
 */
export type ReferenceMode = 'unstained' | 'self';

/** The detector a control is brightest in — its emission maximum. */
export interface PeakChannel {
  /**
   * Position in the **detector array**, not in the file's parameter list.
   *
   * This is what the walk order sorts by, and the distinction matters: detectors
   * are contiguous and ordered by wavelength within a laser, so ascending
   * detector position is the order a cytometer's own software lists a reference
   * panel in. A parameter index includes Time and scatter and would order the
   * walk by where a channel happens to sit in the file.
   */
  detector: number;
  /** Index into the file's parameter list — what a gate's `xParam` holds. */
  parameterIndex: number;
  /** The detector's short name (`$PnN`), for the layout name and the tooltip. */
  name: string;
}

/**
 * One reference control, as the wizard tracks it.
 *
 * `role` is nullable and starts null: Step 2 exists precisely because the app
 * cannot know, and a default role would be the guess this redesign removes.
 */
/**
 * Whether a field holds what the app worked out or what the user said.
 *
 * Every suggestion in Step 2 carries one, and it is not bookkeeping. The reason
 * `classifyControl` was deleted was never that it guessed badly — it was that
 * its guesses were **indistinguishable from statements**, so a wrong one could
 * only be found by already suspecting it. A suggestion that says on screen that
 * it is a suggestion, and that stops being one the moment it is touched, is a
 * different object: it costs nothing to accept and nothing to notice.
 *
 * It is also what makes the reference-mode default re-derivable. A row the user
 * has set is left alone forever; a row still holding a suggestion follows the
 * panel when the panel changes underneath it.
 */
export type FieldSource = 'suggested' | 'user';

export interface ControlAssignment {
  sampleId: string;
  /**
   * The identity — "CD3 FITC" — and the name used everywhere downstream: the
   * generated layout, the similarity matrix, the signature, the saved
   * `.unmixing`. Suggested from the filename by `suggestLabel`, which strips
   * only the parts shared with the other selected controls, and freely editable.
   */
  label: string;
  labelSource: FieldSource;
  role: ControlRole | null;
  roleSource: FieldSource;
  reference: ReferenceMode;
  referenceSource: FieldSource;
  /** Emission maximum — measured from the file, or chosen from the dropdown. */
  peak: PeakChannel | null;
  peakSource: FieldSource;
  /** Gate isolating this control's positive population. */
  positiveGateId: string | null;
  /** Gate isolating the negative population, for `reference: 'self'` only. */
  negativeGateId: string | null;
  gateOrigin: 'user' | 'auto' | null;
  /** The generated gating layout for this control, once Step 3 has built them. */
  layoutId: string | null;
}

/**
 * Which tab of the spillover panel is showing.
 *
 * `file` exists only on the conventional side: a FACSDiva export carries the
 * matrix its own acquisition software computed, and reading it is one press
 * rather than a four-step setup. A spectral file has no such thing — every
 * `$SPILLOVER` on this instrument is the identity — so the tab is simply not
 * rendered there rather than rendered empty.
 *
 * Only `new` is a setup in progress. `load` and `file` both *arrive* at a
 * matrix rather than building one, so neither takes ownership of gates or
 * layouts and neither locks anything.
 */
export type PanelTab = 'new' | 'load' | 'file';

export const WIZARD_STEPS = [
  { step: 1, key: 'select', label: 'Select' },
  { step: 2, key: 'assign', label: 'Assign' },
  { step: 3, key: 'gate', label: 'Gate' },
  { step: 4, key: 'compute', label: 'Compute' },
] as const;

export type WizardStep = 1 | 2 | 3 | 4;

/** The last step. Named, because three files used to spell `5` by hand. */
export const LAST_STEP: WizardStep = 4;

/**
 * Whether the wizard is mid-setup — the question "may another guided pipeline
 * start right now" is asked of.
 *
 * From **Assign** onward the wizard owns things outside its own panel: control
 * assignments that Step 3 turns into worksheets, generated layouts, and seeded
 * gates on every control. Biophysics owns the same three, and its Step 1 places a
 * *Cells* gate across every loaded sample from a mount effect — so opening it
 * mid-setup gates the eleven single-stain controls as if they were samples, and
 * coming back finds a gate tree and a layout list that no longer describe the
 * setup. Neither pipeline is wrong on its own; they are two owners of one set of
 * objects, and the second one to start wins silently.
 *
 * **Step 1 is not mid-setup.** Ticking files builds nothing, so leaving costs
 * nothing, and locking navigation the instant a checkbox is touched would be a
 * trap rather than a guard. The lock starts where the first artefact does.
 *
 * **A computed matrix ends it**, wherever the panel is standing. At that point
 * the setup has produced the thing it exists to produce, the panel says
 * *Unmixing complete*, and unmixing is precisely the prerequisite Biophysics'
 * *Multiple cell types* mode has as its own step 0 — so this is the supported
 * order arriving, not a misclick. Holding the lock past it would make the
 * intended next move reachable only by pressing *Start over*.
 *
 * The *Load unmixing* tab is never mid-setup: applying a saved matrix is one
 * action with no intermediate state to lose.
 */
export function wizardInProgress(
  tab: PanelTab,
  step: WizardStep,
  controlCount: number,
  matrixComputed: boolean,
): boolean {
  return tab === 'new' && step >= 2 && controlCount > 0 && !matrixComputed;
}

/** Whether a step can be left, and what is missing if not. */
export interface StepCheck {
  ok: boolean;
  /** Why not — shown on the disabled Next button and beside it. */
  reason: string;
  /**
   * Advice that is true but is **not** blocking.
   *
   * Step 1 is the case this exists for. Realistically a panel needs an unstained
   * control and one single stain per fluorophore, but saying so by disabling
   * Next would stop somebody selecting their files in the order they think of
   * them. The requirement is surfaced as guidance and enforced at Step 4, where
   * it is actually load-bearing.
   */
  advice?: string;
}

/** A control's role in words, for a heading or a tooltip. */
export const ROLE_LABELS: Record<ControlRole, string> = {
  stain: 'Single Stain',
  unstained: 'Unstained',
  autofluorescence: 'Autofluorescence',
};

/**
 * Sort controls into peak-detector order — the one order the whole panel uses.
 *
 * **Baselines first, then single stains by ascending detector.** Two separate
 * reasons, and both are about the user not being asked to do something out of
 * order:
 *
 *   - The unstained and autofluorescence controls come first because a
 *     `reference: 'unstained'` stain's negative histogram *is* the unstained
 *     control's distribution. Walking a stain before the sample it references
 *     has been gated would show a negative reference that is about to change.
 *   - The stains are ordered by their peak detector's position in the detector
 *     array, which on any spectral instrument is UV → Violet → Blue →
 *     Yellow-Green → Red with the detector number ascending inside each laser
 *     block. That is the order a cytometer's own reference-control list uses,
 *     and it walks across the instrument once rather than jumping back and
 *     forth between lasers.
 *
 * A control with no measured peak sorts last among the stains rather than
 * first — it is the one that cannot be gated yet, and putting it at the front
 * would open the walk on the one screen that cannot be completed.
 *
 * ## Called once, not per render
 *
 * The store keeps `controls` **already in this order** and every surface reads
 * the array as it stands: the Assign table, the worksheet tab bar, the layout
 * dropdown and the walk. Sorting at each read was how the Assign table and the
 * dropdown ended up in import order while the walk was in detector order — three
 * surfaces listing the same eleven files three ways — and it is also why a list
 * could re-shuffle underneath a click. The order is decided where the peaks are:
 * `syncControls`, `remeasurePeaks` and `setControlPeak`, which are the only
 * three places a peak detector is ever established or corrected.
 */
export function orderControls(controls: readonly ControlAssignment[]): ControlAssignment[] {
  const rank = (c: ControlAssignment) => (c.role === 'stain' ? 1 : 0);
  return [...controls].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const pa = a.peak?.detector ?? Number.MAX_SAFE_INTEGER;
    const pb = b.peak?.detector ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    // Stable tail-break so two controls peaking in the same detector — which
    // happens with tandem dyes on the same laser — keep a fixed order rather
    // than swapping places between renders.
    return a.label.localeCompare(b.label, undefined, { numeric: true });
  });
}

/**
 * Which control the worksheet currently on screen belongs to.
 *
 * The layout is the fact, and that is the point of this function. There were two
 * ways to change worksheet — the tab bar at the bottom of the worksheet and the
 * layout dropdown at the top of the window — and only the first of them told the
 * wizard, so picking a worksheet from the dropdown left the tab bar highlighting
 * a different control and the walk counter reading a different number. Deriving
 * the index from `activeLayoutId` means both surfaces are reading the same state
 * rather than two copies that have to be kept level.
 *
 * `fallback` covers the interval before the worksheets exist — Step 3 has an
 * index before it has a layout — and any layout that is not a control's.
 */
export function controlIndexForLayout(
  controls: readonly ControlAssignment[],
  activeLayoutId: string | null,
  fallback: number,
): number {
  const hit = activeLayoutId
    ? controls.findIndex((c) => c.layoutId === activeLayoutId)
    : -1;
  if (hit >= 0) return hit;
  return Math.min(Math.max(0, fallback), Math.max(0, controls.length - 1));
}

/**
 * Whether the wizard is on the gating walk, with worksheets to walk.
 *
 * Three surfaces ask this — the worksheet tab strip along the bottom, the
 * sidebar's gate tree, and anything else that needs to know a reference panel
 * is being gated rather than an ordinary sample — and they have to agree, or one
 * of them shows a reference panel's furniture while another shows an individual
 * sample's. Stated once for the same reason `controlIndexForLayout` is: two
 * copies of a condition are two conditions.
 */
export function isWalkingControls(
  tab: PanelTab,
  step: WizardStep,
  controls: readonly ControlAssignment[],
): boolean {
  return tab === 'new' && step === 3 && controls.some((c) => c.layoutId !== null);
}

/**
 * Which sample supplies a stain's negative reference distribution.
 *
 * `null` when there is nothing to point at, which is a real state and not an
 * error: a `reference: 'unstained'` stain in a panel where nobody has assigned
 * an unstained control yet has no negative histogram to draw, and Step 3 says so
 * rather than drawing an empty plot.
 */
export function negativeReferenceFor(
  control: ControlAssignment,
  controls: readonly ControlAssignment[],
): string | null {
  if (control.role !== 'stain') return null;
  if (control.reference === 'self') return control.sampleId;
  // The unstained control proper, and only then an autofluorescence one — the
  // two are separate roles precisely because a panel may carry both, and the
  // negative baseline is the unstained tube's job.
  return controls.find((c) => c.role === 'unstained')?.sampleId
    ?? controls.find((c) => c.role === 'autofluorescence')?.sampleId
    ?? null;
}

/**
 * Whether this control still needs something drawn before Step 4 can run.
 *
 * An unstained or autofluorescence control is always ready. It has a histogram
 * on its worksheet as of this pass and it can be gated there — excluding dead
 * cells or debris from the autofluorescence signature is a reasonable thing to
 * want — but that gating is a **refinement**, not a requirement: the signature
 * has a well-defined answer without it, which is the general-gated population.
 * A single stain has no such default, because "the positive population" is
 * exactly what the operator is being asked to identify.
 */
export function controlIsGated(c: ControlAssignment): boolean {
  if (c.role !== 'stain') return true;
  if (!c.positiveGateId) return false;
  // A self-referencing control carries its own negative population, so its
  // baseline is a gate like any other and has to exist before it can be read.
  return c.reference !== 'self' || c.negativeGateId !== null;
}

/* -------------------------------------------------------------------------
   Step 2 suggestions
   -------------------------------------------------------------------------

   Read this before changing anything below it, because it looks like the thing
   that was deleted and is not.

   `classifyControl` decided **which files were reference controls** and **which
   one was unstained**, silently, before anybody had looked at the screen. Those
   are claims about the experiment, they were unmarked, and being wrong about
   either produces a matrix built from the wrong signatures. It is still deleted
   and Step 1 still opens with nothing ticked.

   What is below runs only over samples somebody has already ticked, fills in
   fields that are already on screen next to the file they came from, marks every
   one of them as a suggestion, and stops suggesting the moment the field is
   touched. The difference is not a matter of degree: nothing here decides
   whether a file is a control, and nothing here is invisible.
   ------------------------------------------------------------------------- */

/** A trailing parenthesised annotation — "(Cells)", "(2)" — and nothing else. */
const TRAILING_NOTE = /\s*\([^()]*\)\s*$/;

/**
 * A readable identity for a control, given the others it was selected with.
 *
 * The rule is *"drop the leading parts of this name that are shared with
 * another selected control"*, which is the only definition of boilerplate that
 * cannot delete something identifying: a leading segment that another selected
 * file has in the same position distinguishes nothing between them, and one that
 * does not is kept. `Cells-Reference Group-CCR7 APC-Fire 810 (Cells)` alongside
 * ten siblings loses `Cells` and `Reference Group` and stops at `CCR7 APC`,
 * which is unique.
 *
 * Stopping at the first unique segment is also what keeps a hyphenated
 * fluorophore intact. Splitting on every hyphen would cut `APC-Fire 810` in two;
 * the walk never reaches that hyphen, because it halts one segment earlier.
 */
export function suggestLabel(name: string, siblings: readonly string[]): string {
  const others = siblings.filter((n) => n !== name);
  const mine = name.split('-');
  const split = others.map((n) => n.split('-'));

  let from = 0;
  while (from < mine.length - 1) {
    const seg = mine[from]!.trim().toLowerCase();
    const shared = split.some((s) => (s[from] ?? '').trim().toLowerCase() === seg);
    if (!shared) break;
    from++;
  }

  const kept = mine.slice(from).join('-').trim();
  // A trailing note is boilerplate whoever else is selected — it annotates the
  // acquisition, not the control — so it goes independently of the prefix walk.
  const trimmed = kept.replace(TRAILING_NOTE, '').trim();
  // Nothing is better than a cryptic fragment: "1" is less use than the whole
  // name it was cut from. Same floor `stripGroupPrefix` uses.
  return trimmed.length >= 3 ? trimmed : name.replace(TRAILING_NOTE, '').trim() || name;
}

/**
 * `\bAF\b` is deliberately not in here.
 *
 * "AF647", "AF700" and "Alexa Fluor 700" are fluorophores, and a rule matching
 * `AF` would call half a real panel autofluorescence. What identifies an
 * autofluorescence control is the word, so the word is what is matched.
 */
const AUTOFLUORESCENCE = /auto[\s_-]*fluor/i;
const UNSTAINED_NAME = /\bun[\s_-]?stain(ed)?d?\b|\bunstd\b|\bblank\b|\bno[\s_-]?stain\b/i;

/**
 * A role for a sample the user has already declared to be a reference control.
 *
 * Single Stain is the fallback rather than "unknown", and that is a claim worth
 * being explicit about: the question is not *"is this a control"* — that was
 * answered in Step 1 — but *"which of three kinds"*, where one kind is the
 * overwhelming majority and the other two announce themselves in the filename
 * far more reliably than a marker/fluorophore grammar ever did.
 */
export function suggestRole(name: string): ControlRole {
  if (AUTOFLUORESCENCE.test(name)) return 'autofluorescence';
  if (UNSTAINED_NAME.test(name)) return 'unstained';
  return 'stain';
}

/**
 * Where single stains should take their negative from, given the panel.
 *
 * A panel with an unstained tube in it has a separate negative for every stain;
 * a panel without one is almost always beads, where each tube carries its own.
 * Deriving it from what is *in the selection* rather than defaulting to one of
 * them means the common case needs no clicks either way, and it re-derives when
 * the unstained control is assigned or unassigned — which is the whole reason
 * `referenceSource` exists.
 */
export function defaultReferenceMode(controls: readonly ControlAssignment[]): ReferenceMode {
  return controls.some((c) => c.role === 'unstained') ? 'unstained' : 'self';
}

/**
 * Re-apply the reference default to every row still holding a suggestion.
 *
 * Called whenever a role changes. Rows the user has set keep what they were set
 * to; a switch away from `self` also drops the negative gate, for the reason
 * `setControlReference` gives.
 */
export function applyReferenceDefaults(controls: readonly ControlAssignment[]): ControlAssignment[] {
  const want = defaultReferenceMode(controls);
  return controls.map((c) => {
    if (c.referenceSource === 'user' || c.reference === want) return c;
    return { ...c, reference: want, negativeGateId: want === 'self' ? c.negativeGateId : null };
  });
}

/* -------------------------------------------------------------------------
   Step gating
   ------------------------------------------------------------------------- */

/** Step 1 — at least one sample ticked. The rest is advice. */
export function checkSelect(selectedIds: readonly string[]): StepCheck {
  if (selectedIds.length === 0) {
    return { ok: false, reason: 'Select at least one reference control.' };
  }
  return {
    ok: true,
    reason: '',
    advice: selectedIds.length < 2
      ? 'A complete panel needs one single-stained sample per fluorophore and an unstained sample.'
      : undefined,
  };
}

/** Step 2 — every selected sample has a role. */
export function checkAssign(controls: readonly ControlAssignment[]): StepCheck {
  const unassigned = controls.filter((c) => c.role === null);
  if (unassigned.length > 0) {
    return {
      ok: false,
      reason: unassigned.length === controls.length
        ? 'Choose a role for each control.'
        : `${unassigned.length} control${unassigned.length === 1 ? '' : 's'} still need a role: ${unassigned.map((c) => c.label).join(', ')}.`,
    };
  }
  const stains = controls.filter((c) => c.role === 'stain');
  if (stains.length === 0) {
    return { ok: false, reason: 'At least one row must be Single Stain. Reference signatures are measured from them.' };
  }
  // Advice, not a block: a panel of self-referencing beads needs no unstained
  // sample at all, so requiring one here would refuse a valid setup.
  const needsUnstained = stains.some((c) => c.reference === 'unstained');
  const hasBaseline = controls.some((c) => c.role === 'unstained' || c.role === 'autofluorescence');
  return {
    ok: true,
    reason: '',
    advice: needsUnstained && !hasBaseline
      ? 'Some single stains take their negative from an unstained sample and none is assigned. Add one, or set those rows to Self.'
      : undefined,
  };
}

/** Step 3 — every single stain has the gates its reference mode requires. */
export function checkGate(controls: readonly ControlAssignment[]): StepCheck {
  const missing = controls.filter((c) => !controlIsGated(c));
  if (missing.length === 0) return { ok: true, reason: '' };
  return {
    ok: false,
    reason: `${missing.length} single stain${missing.length === 1 ? '' : 's'} still need a gated positive population: ${missing.map((c) => c.label).join(', ')}.`,
  };
}

/** The check for a step, so the wizard has one place to ask. */
export function checkStep(
  step: WizardStep,
  selectedIds: readonly string[],
  controls: readonly ControlAssignment[],
): StepCheck {
  switch (step) {
    case 1: return checkSelect(selectedIds);
    case 2: return checkAssign(controls);
    case 3: return checkGate(controls);
    // Step 4 is the last one and has no Next, so there is nothing to refuse.
    // Whether the matrix can be computed *yet* is `readiness()`, stated on the
    // Compute button itself where the action is.
    default: return { ok: true, reason: '' };
  }
}

/**
 * A layout name that is unique within the set.
 *
 * Two controls typed the same name is a mistake worth surviving rather than
 * refusing: the layouts are found by id, so a duplicate name breaks nothing —
 * but a walk showing "CD3 FITC" twice with no way to tell which is which is
 * exactly the ambiguity this redesign is about. The suffix says there are two.
 */
export function uniqueLayoutNames(controls: readonly ControlAssignment[]): string[] {
  const seen = new Map<string, number>();
  return controls.map((c) => {
    const base = c.label.trim() || 'Control';
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

/** The detector's display name, or a stable fallback when the index is out of range. */
export function detectorName(md: FcsMetadata, parameterIndex: number): string {
  return md.parameters[parameterIndex]?.name ?? `P${parameterIndex + 1}`;
}

/**
 * Every detector the peak dropdown can be set to, in instrument order.
 *
 * `detector` is the position in the detector array and `parameterIndex` the
 * position in the file — the two differ by Time and the scatter channels, and
 * both are needed: the first orders the walk, the second is what a gate's
 * `xParam` holds. Building them together here is what stops a hand-written
 * override setting one and leaving the other describing a different channel.
 */
export function detectorChoices(md: FcsMetadata, detectors: readonly number[]): PeakChannel[] {
  return detectors.map((parameterIndex, detector) => ({
    detector,
    parameterIndex,
    name: detectorName(md, parameterIndex),
  }));
}

/**
 * The `PeakChannel` for a parameter the user picked from the dropdown.
 *
 * Null when the parameter is not a detector at all, which the dropdown cannot
 * offer but a restored file could carry — a matrix is only meaningful over
 * detectors, so an out-of-panel channel is refused rather than stored.
 */
export function peakForParameter(
  md: FcsMetadata,
  detectors: readonly number[],
  parameterIndex: number,
): PeakChannel | null {
  const detector = detectors.indexOf(parameterIndex);
  if (detector < 0) return null;
  return { detector, parameterIndex, name: detectorName(md, parameterIndex) };
}
