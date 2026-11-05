import { describe, expect, it } from 'vitest';
import {
  applyReferenceDefaults, checkAssign, checkGate, checkSelect, checkStep, controlIsGated,
  defaultReferenceMode, detectorChoices, negativeReferenceFor, peakForParameter, suggestLabel,
  suggestRole, uniqueLayoutNames, controlIndexForLayout, orderControls, wizardInProgress,
  type ControlAssignment,
} from './wizard';
import type { FcsMetadata } from '@/core/fcs/types';

/** A control with everything defaulted, so each test states only what it is about. */
function control(over: Partial<ControlAssignment> & { sampleId: string }): ControlAssignment {
  return {
    label: over.sampleId,
    labelSource: 'suggested',
    role: null,
    roleSource: 'suggested',
    reference: 'unstained',
    referenceSource: 'suggested',
    peak: null,
    peakSource: 'suggested',
    positiveGateId: null,
    negativeGateId: null,
    gateOrigin: null,
    layoutId: null,
    ...over,
  };
}

const peak = (detector: number) => ({ detector, parameterIndex: detector + 7, name: `D${detector}` });

/**
 * The real panel in `an earlier dataset`, after `displayNameFromFile` has taken the
 * extension and the acquisition date off.
 *
 * Used verbatim rather than paraphrased, because the whole claim `suggestLabel`
 * makes is about what happens to *these* names — a shared "Cells" stem, a
 * "Reference Group" stem on eleven of the fourteen and "Samples" on the other
 * three, hyphens inside half the fluorophore names, and a "(Cells)" annotation.
 */
const PANEL = [
  'Cells-Reference Group-CCR7 APC-Fire 810 (Cells)',
  'Cells-Reference Group-CD3 RY703 (Cells)',
  'Cells-Reference Group-CD8 PerCP-eFluor 710 (Cells)',
  'Cells-Reference Group-LiveDead Live or Dye 750-777 (Cells)',
  'Cells-Samples-Autofluorescence',
  'Cells-Samples-Unstainedd',
];

describe('suggestLabel', () => {
  it('strips the stems shared with the other selected controls', () => {
    expect(suggestLabel(PANEL[0]!, PANEL)).toBe('CCR7 APC-Fire 810');
    expect(suggestLabel(PANEL[1]!, PANEL)).toBe('CD3 RY703');
    expect(suggestLabel(PANEL[4]!, PANEL)).toBe('Autofluorescence');
    expect(suggestLabel(PANEL[5]!, PANEL)).toBe('Unstainedd');
  });

  it('keeps a hyphenated fluorophore intact', () => {
    /*
       The reason the walk stops at the first *unique* segment rather than
       splitting on every hyphen. "CCR7 APC" is unique, so the walk halts there
       and the hyphen inside "APC-Fire 810" is never reached — and the same for
       "PerCP-eFluor 710" and the "750-777" in a Live/Dead name.
    */
    expect(suggestLabel(PANEL[2]!, PANEL)).toBe('CD8 PerCP-eFluor 710');
    expect(suggestLabel(PANEL[3]!, PANEL)).toBe('LiveDead Live or Dye 750-777');
  });

  it('drops a trailing annotation whoever else is selected', () => {
    // It annotates the acquisition rather than the control, so it goes
    // independently of the prefix walk — including when nothing is shared.
    expect(suggestLabel('CD3 FITC (Cells)', ['CD3 FITC (Cells)'])).toBe('CD3 FITC');
  });

  it('strips nothing when a name shares nothing', () => {
    expect(suggestLabel('Alpha-One', ['Alpha-One', 'Beta-Two'])).toBe('Alpha-One');
  });

  it('keeps the whole name rather than leaving a cryptic fragment', () => {
    // "1" is less use than the repetition it avoids. Same floor as
    // `stripGroupPrefix`.
    const names = ['Run-Plate-1', 'Run-Plate-2'];
    expect(suggestLabel(names[0]!, names)).toBe('Run-Plate-1');
  });

  it('never strips the last segment, however shared it is', () => {
    const names = ['A-Same', 'B-Same'];
    expect(suggestLabel(names[0]!, names)).toBe('A-Same');
  });
});

describe('suggestRole', () => {
  it('finds the unstained and autofluorescence controls by name', () => {
    expect(suggestRole('Cells-Samples-Unstainedd')).toBe('unstained');
    expect(suggestRole('20250101-Beads-Unstainedd')).toBe('unstained');
    expect(suggestRole('Cells-Samples-Autofluorescence')).toBe('autofluorescence');
    expect(suggestRole('sample AF control')).toBe('stain');
  });

  it('does not mistake a fluorophore for an autofluorescence control', () => {
    /*
       "AF647", "AF700" and "Alexa Fluor 700" are dyes. A rule matching a bare
       "AF" would call half a real panel autofluorescence and put those controls
       in as extra baseline endmembers, which does not fail — it produces a
       matrix missing three fluorophores.
    */
    expect(suggestRole('Cells-Reference Group-CD19 AF647 (Cells)')).toBe('stain');
    expect(suggestRole('Cells-Reference Group-CD28 Alexa Fluor 700 (Cells)')).toBe('stain');
    expect(suggestRole('CD4 AF488')).toBe('stain');
  });

  it('falls back to Single Stain', () => {
    // The question at this point is not "is this a control" — Step 1 answered
    // that — but "which of three kinds", where one kind is the vast majority.
    expect(suggestRole('Cells-Reference Group-CD3 RY703 (Cells)')).toBe('stain');
    expect(suggestRole('anything at all')).toBe('stain');
  });
});

describe('defaultReferenceMode', () => {
  it('is Unstained when the panel carries an unstained control', () => {
    expect(defaultReferenceMode([
      control({ sampleId: 'a', role: 'stain' }),
      control({ sampleId: 'u', role: 'unstained' }),
    ])).toBe('unstained');
  });

  it('is Self when it does not — the panel is beads', () => {
    expect(defaultReferenceMode([control({ sampleId: 'a', role: 'stain' })])).toBe('self');
  });

  it('does not count an autofluorescence control as an unstained one', () => {
    // They are separate roles precisely because a panel may carry both, and a
    // single stain's negative baseline is the unstained tube's job.
    expect(defaultReferenceMode([
      control({ sampleId: 'a', role: 'stain' }),
      control({ sampleId: 'af', role: 'autofluorescence' }),
    ])).toBe('self');
  });
});

describe('applyReferenceDefaults', () => {
  it('moves every row still holding a suggestion', () => {
    const out = applyReferenceDefaults([
      control({ sampleId: 'a', role: 'stain', reference: 'self' }),
      control({ sampleId: 'b', role: 'stain', reference: 'self' }),
      control({ sampleId: 'u', role: 'unstained' }),
    ]);
    expect(out.slice(0, 2).map((c) => c.reference)).toEqual(['unstained', 'unstained']);
  });

  it('leaves a row the user set alone', () => {
    const out = applyReferenceDefaults([
      control({ sampleId: 'a', role: 'stain', reference: 'self', referenceSource: 'user' }),
      control({ sampleId: 'u', role: 'unstained' }),
    ]);
    expect(out[0]!.reference).toBe('self');
  });

  it('drops the negative gate when a row stops self-referencing', () => {
    const out = applyReferenceDefaults([
      control({ sampleId: 'a', role: 'stain', reference: 'self', negativeGateId: 'g' }),
      control({ sampleId: 'u', role: 'unstained' }),
    ]);
    expect(out[0]!.negativeGateId).toBeNull();
  });

  it('is idempotent', () => {
    const once = applyReferenceDefaults([
      control({ sampleId: 'a', role: 'stain' }),
      control({ sampleId: 'u', role: 'unstained' }),
    ]);
    expect(applyReferenceDefaults(once)).toEqual(once);
  });
});

describe('detectorChoices and peakForParameter', () => {
  const md = {
    parameters: [
      { name: 'Time' }, { name: 'FSC-A' }, { name: 'SSC-A' },
      { name: 'UV1-A' }, { name: 'B1-A' }, { name: 'R1-A' },
    ],
  } as unknown as FcsMetadata;
  const detectors = [3, 4, 5];

  it('numbers the detectors by position in the detector array', () => {
    // Not by position in the file: the walk sorts by detector, and a parameter
    // index would order it by where a channel happens to sit past Time and
    // scatter.
    expect(detectorChoices(md, detectors)).toEqual([
      { detector: 0, parameterIndex: 3, name: 'UV1-A' },
      { detector: 1, parameterIndex: 4, name: 'B1-A' },
      { detector: 2, parameterIndex: 5, name: 'R1-A' },
    ]);
  });

  it('builds both indices together from one parameter', () => {
    expect(peakForParameter(md, detectors, 4)).toEqual({ detector: 1, parameterIndex: 4, name: 'B1-A' });
  });

  it('refuses a parameter that is not a detector', () => {
    // A matrix is only meaningful over detectors; SSC-A is not one.
    expect(peakForParameter(md, detectors, 2)).toBeNull();
  });
});

describe('orderControls', () => {
  it('puts the baseline controls before the stains', () => {
    /*
       Not cosmetic ordering. A stain that references a separate unstained
       control draws that control's distribution as its negative histogram, so
       walking the stain first would show a baseline that is about to change
       under it once the unstained control is gated.
    */
    const out = orderControls([
      control({ sampleId: 'a', role: 'stain', peak: peak(3) }),
      control({ sampleId: 'u', role: 'unstained' }),
      control({ sampleId: 'b', role: 'stain', peak: peak(1) }),
      control({ sampleId: 'af', role: 'autofluorescence' }),
    ]);
    expect(out.slice(0, 2).map((c) => c.sampleId).sort()).toEqual(['af', 'u']);
    expect(out.slice(2).map((c) => c.sampleId)).toEqual(['b', 'a']);
  });

  it('orders stains by their peak detector, not by their parameter index', () => {
    // Ascending detector position is the order a spectral cytometer lists a
    // reference panel in, and it groups controls by laser.
    const out = orderControls([
      control({ sampleId: 'c', role: 'stain', peak: peak(40) }),
      control({ sampleId: 'a', role: 'stain', peak: peak(2) }),
      control({ sampleId: 'b', role: 'stain', peak: peak(17) }),
    ]);
    expect(out.map((c) => c.sampleId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a stain with no measured peak last, not first', () => {
    // It is the one control that cannot be gated yet; opening the walk on it
    // would start the user on the only screen they cannot finish.
    const out = orderControls([
      control({ sampleId: 'none', role: 'stain', peak: null }),
      control({ sampleId: 'a', role: 'stain', peak: peak(5) }),
    ]);
    expect(out.map((c) => c.sampleId)).toEqual(['a', 'none']);
  });

  it('breaks a tie by label so two tandems on one detector hold their order', () => {
    /*
       Numeric collation, and that is what makes the tie-break read correctly to
       a cytometrist: CD8 comes before CD14 because 8 is less than 14, not after
       it because "1" is less than "8". A plain string compare would interleave a
       marker panel — CD11c, CD14, CD19, CD3, CD4, CD56, CD8 — which is an order
       nobody names their controls in.
    */
    const same = [
      control({ sampleId: 'x', label: 'CD14 APC', role: 'stain', peak: peak(9) }),
      control({ sampleId: 'y', label: 'CD8 APC-Fire 810', role: 'stain', peak: peak(9) }),
    ];
    expect(orderControls(same).map((c) => c.label)).toEqual(['CD8 APC-Fire 810', 'CD14 APC']);
    // And the answer does not depend on which order they arrived in.
    expect(orderControls([...same].reverse()).map((c) => c.label)).toEqual(['CD8 APC-Fire 810', 'CD14 APC']);
  });

  it('never mutates its input', () => {
    const list = [
      control({ sampleId: 'b', role: 'stain', peak: peak(9) }),
      control({ sampleId: 'a', role: 'unstained' }),
    ];
    orderControls(list);
    expect(list.map((c) => c.sampleId)).toEqual(['b', 'a']);
  });
});

describe('controlIndexForLayout', () => {
  /*
     There are three ways to change worksheet — the walk arrows, the tab strip
     along the bottom of the worksheet, and the layout dropdown in the title bar
     — and the third of them knows nothing about this wizard. So which control
     is showing is derived from the active layout rather than stored, or the
     three surfaces keep three answers and two of them go stale the moment
     somebody uses the dropdown.
  */
  const list = [
    control({ sampleId: 'u', role: 'unstained', layoutId: 'L2' }),
    control({ sampleId: 'a', role: 'stain', peak: peak(1), layoutId: 'L3' }),
    control({ sampleId: 'b', role: 'stain', peak: peak(9), layoutId: 'L7' }),
  ];

  it('reads the position off the layout on screen', () => {
    expect(controlIndexForLayout(list, 'L2', 99)).toBe(0);
    expect(controlIndexForLayout(list, 'L7', 0)).toBe(2);
  });

  it('falls back for a layout that is not a control worksheet', () => {
    // "Main", or any worksheet somebody added themselves. The walk keeps its
    // place rather than jumping to the first control.
    expect(controlIndexForLayout(list, 'L_main', 1)).toBe(1);
    expect(controlIndexForLayout(list, null, 2)).toBe(2);
  });

  it('clamps a fallback that no longer addresses anything', () => {
    // De-selecting controls shortens the list under a stored index.
    expect(controlIndexForLayout(list, 'L_main', 40)).toBe(2);
    expect(controlIndexForLayout([], 'L_main', 3)).toBe(0);
  });

  it('ignores a fallback whenever the layout answers', () => {
    expect(controlIndexForLayout(list, 'L3', 0)).toBe(1);
  });
});

describe('negativeReferenceFor', () => {
  const unstained = control({ sampleId: 'u', role: 'unstained' });

  it('points a self-referencing stain at its own file', () => {
    // Beads: one tube holds both a negative and a positive population, so both
    // gates are drawn on the same data and no separate control is involved.
    const beads = control({ sampleId: 'beads', role: 'stain', reference: 'self' });
    expect(negativeReferenceFor(beads, [beads, unstained])).toBe('beads');
  });

  it('points a cell-based stain at the unstained control', () => {
    const cells = control({ sampleId: 'cd3', role: 'stain', reference: 'unstained' });
    expect(negativeReferenceFor(cells, [cells, unstained])).toBe('u');
  });

  it('falls back to an autofluorescence control when there is no unstained one', () => {
    const af = control({ sampleId: 'af', role: 'autofluorescence' });
    const cells = control({ sampleId: 'cd3', role: 'stain', reference: 'unstained' });
    expect(negativeReferenceFor(cells, [cells, af])).toBe('af');
  });

  it('prefers the unstained control when a panel carries both', () => {
    const af = control({ sampleId: 'af', role: 'autofluorescence' });
    const cells = control({ sampleId: 'cd3', role: 'stain', reference: 'unstained' });
    expect(negativeReferenceFor(cells, [cells, af, unstained])).toBe('u');
  });

  it('returns null when there is nothing to point at', () => {
    // A real state, not an error: Step 3 says so rather than drawing an empty plot.
    const cells = control({ sampleId: 'cd3', role: 'stain', reference: 'unstained' });
    expect(negativeReferenceFor(cells, [cells])).toBeNull();
  });

  it('has no negative reference for a control that is not a stain', () => {
    expect(negativeReferenceFor(unstained, [unstained])).toBeNull();
  });
});

describe('controlIsGated', () => {
  it('counts a baseline control as done — it has no positive population', () => {
    expect(controlIsGated(control({ sampleId: 'u', role: 'unstained' }))).toBe(true);
    expect(controlIsGated(control({ sampleId: 'af', role: 'autofluorescence' }))).toBe(true);
  });

  it('needs a positive gate on a stain', () => {
    expect(controlIsGated(control({ sampleId: 'a', role: 'stain' }))).toBe(false);
    expect(controlIsGated(control({ sampleId: 'a', role: 'stain', positiveGateId: 'g1' }))).toBe(true);
  });

  it('needs a negative gate too when the stain references itself', () => {
    const beads = control({ sampleId: 'b', role: 'stain', reference: 'self', positiveGateId: 'g1' });
    expect(controlIsGated(beads)).toBe(false);
    expect(controlIsGated({ ...beads, negativeGateId: 'g2' })).toBe(true);
  });
});

describe('checkSelect', () => {
  it('blocks an empty selection', () => {
    expect(checkSelect([]).ok).toBe(false);
  });

  it('lets one selected sample through, with advice rather than a block', () => {
    /*
       The requirement — an unstained control plus one stain per fluorophore — is
       real, and enforcing it here would stop somebody ticking their files in the
       order they think of them. It is surfaced as advice and enforced at Step 4,
       where it is load-bearing.
    */
    const r = checkSelect(['a']);
    expect(r.ok).toBe(true);
    expect(r.advice).toBeTruthy();
  });

  it('drops the advice once the selection is a plausible panel', () => {
    expect(checkSelect(['a', 'b', 'c']).advice).toBeUndefined();
  });
});

describe('checkAssign', () => {
  it('blocks while any control has no role', () => {
    const r = checkAssign([
      control({ sampleId: 'a', role: 'stain', label: 'CD3' }),
      control({ sampleId: 'b', label: 'CD4' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('CD4');
  });

  it('blocks a panel with no single stain at all', () => {
    // An endmember is measured from a stained population; a panel of baselines
    // has nothing to measure.
    const r = checkAssign([control({ sampleId: 'u', role: 'unstained' })]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Single Stain/);
  });

  it('passes a panel of self-referencing beads with no unstained control', () => {
    // An all-bead reference panel: requiring an unstained
    // sample here would refuse a perfectly valid bead panel.
    const r = checkAssign([
      control({ sampleId: 'a', role: 'stain', reference: 'self' }),
      control({ sampleId: 'b', role: 'stain', reference: 'self' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.advice).toBeUndefined();
  });

  it('advises, without blocking, when a cell-based stain has no baseline to reference', () => {
    const r = checkAssign([control({ sampleId: 'a', role: 'stain', reference: 'unstained' })]);
    expect(r.ok).toBe(true);
    expect(r.advice).toMatch(/unstained sample/i);
  });
});

describe('checkGate', () => {
  it('passes when every stain is gated', () => {
    expect(checkGate([
      control({ sampleId: 'u', role: 'unstained' }),
      control({ sampleId: 'a', role: 'stain', positiveGateId: 'g1' }),
    ]).ok).toBe(true);
  });

  it('names what is still missing', () => {
    const r = checkGate([
      control({ sampleId: 'a', role: 'stain', label: 'CD3 FITC', positiveGateId: 'g1' }),
      control({ sampleId: 'b', role: 'stain', label: 'CD8 APC' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('CD8 APC');
    expect(r.reason).not.toContain('CD3 FITC');
  });

  it('counts a self-referencing stain missing its negative gate as ungated', () => {
    const r = checkGate([
      control({ sampleId: 'b', role: 'stain', label: 'Beads', reference: 'self', positiveGateId: 'g1' }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('Beads');
  });
});

describe('checkStep', () => {
  const gated = [control({ sampleId: 'a', role: 'stain', positiveGateId: 'g1' })];

  it('routes each step to its own rule', () => {
    expect(checkStep(1, [], []).ok).toBe(false);
    expect(checkStep(2, ['a'], [control({ sampleId: 'a' })]).ok).toBe(false);
    expect(checkStep(3, ['a'], [control({ sampleId: 'a', role: 'stain' })]).ok).toBe(false);
    expect(checkStep(3, ['a'], gated).ok).toBe(true);
  });

  /*
     Step 4 is the last one and has nothing to refuse. It used to be refused
     until a matrix existed, because Step 5 applied one; there is no Step 5, so
     the only thing that check could block now is the user reading the screen
     they are already on. Whether the matrix can be computed *yet* is
     `readiness()`, stated on the Compute button.
  */
  it('never blocks the last step', () => {
    expect(checkStep(4, ['a'], gated).ok).toBe(true);
    expect(checkStep(4, [], []).ok).toBe(true);
  });
});

describe('uniqueLayoutNames', () => {
  it('uses the typed label as the layout name', () => {
    expect(uniqueLayoutNames([
      control({ sampleId: 'a', label: 'CD3 FITC' }),
      control({ sampleId: 'b', label: 'CD8 APC' }),
    ])).toEqual(['CD3 FITC', 'CD8 APC']);
  });

  it('disambiguates a duplicate rather than refusing it', () => {
    // Two rows typed the same is a mistake worth surviving — the layouts are
    // found by id — but a walk showing the same name twice is exactly the
    // ambiguity this redesign exists to remove.
    expect(uniqueLayoutNames([
      control({ sampleId: 'a', label: 'CD3' }),
      control({ sampleId: 'b', label: 'CD3' }),
      control({ sampleId: 'c', label: 'CD3' }),
    ])).toEqual(['CD3', 'CD3 (2)', 'CD3 (3)']);
  });

  it('falls back for a label left blank', () => {
    expect(uniqueLayoutNames([control({ sampleId: 'a', label: '   ' })])).toEqual(['Control']);
  });
});

describe('wizardInProgress', () => {
  /*
     The report: select the controls, press Next into Assign, click Biophysics by
     mistake, come back, and the setup has been gated by the other pipeline. What
     this predicate has to get right is the two edges — where the lock starts and
     where it stops — because being wrong at either end is worse than not having
     it. Too early and a checkbox traps you; too late and the intended next move
     needs Start over first.
  */
  it('is off on Select, whatever has been ticked', () => {
    expect(wizardInProgress('new', 1, 0, false)).toBe(false);
    expect(wizardInProgress('new', 1, 11, false)).toBe(false);
  });

  it('is on from Assign through Compute while nothing has been built', () => {
    expect(wizardInProgress('new', 2, 11, false)).toBe(true);
    expect(wizardInProgress('new', 3, 11, false)).toBe(true);
    expect(wizardInProgress('new', 4, 11, false)).toBe(true);
  });

  it('ends the moment a matrix exists', () => {
    // Unmixing is Biophysics' own step 0, so a computed matrix is the supported
    // hand-off arriving rather than a misclick.
    expect(wizardInProgress('new', 4, 11, true)).toBe(false);
    expect(wizardInProgress('new', 2, 11, true)).toBe(false);
  });

  it('is off on the Load tab', () => {
    // Applying a saved matrix is one action with no intermediate state to lose.
    expect(wizardInProgress('load', 3, 11, false)).toBe(false);
  });

  it('is off with no controls assigned', () => {
    expect(wizardInProgress('new', 3, 0, false)).toBe(false);
  });
});
