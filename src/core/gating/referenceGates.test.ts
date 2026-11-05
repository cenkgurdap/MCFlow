import { describe, expect, it } from 'vitest';
import {
  isReferenceGate, pruneReferenceGates, withoutReferenceGates, withoutReferenceSamples,
} from './referenceGates';
import type { Gate } from './types';

/* ==========================================================================
   Keeping the wizard's gates inside the wizard — 2026-08-12, Item 11.

   Reported with a screenshot of a gate tree on a general layout: the shared
   *Cells* gate at the root and every reference control's bracket under it, all
   at 0.00%, above the user's own populations. Asserted here rather than against
   a rendered tree because the rule is a transformation of one list into
   another, and the surfaces that were leaking — the sidebar tree, the plot
   canvas, the statistics table and the export — are four consumers of that one
   answer.
   ========================================================================== */

const rect = (id: string, parentId: string | null, extra: Partial<Gate> = {}): Gate => ({
  id, name: id, parentId, colorIndex: 0,
  kind: 'rectangle', xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
  ...extra,
} as Gate);

/** A gate the wizard made. */
const ref = (id: string, parentId: string | null) => rect(id, parentId, { reference: true });

describe('isReferenceGate', () => {
  it('is false for every gate anybody draws', () => {
    expect(isReferenceGate(rect('a', null))).toBe(false);
  });

  it('is true only for the flag, not for having an owner', () => {
    // The two are different axes. A gate can be scoped to one sample and still
    // be the user's own — that is what a forked strategy is.
    expect(isReferenceGate(rect('a', null, { ownerSampleId: 's1' }))).toBe(false);
    expect(isReferenceGate(ref('a', null))).toBe(true);
  });
});

describe('withoutReferenceGates', () => {
  it('returns the same array by identity when there is nothing to remove', () => {
    // Not an optimisation: this runs inside Zustand selectors, where a fresh
    // array every call is a fresh reference every render.
    const gates = [rect('a', null), rect('b', 'a')];
    expect(withoutReferenceGates(gates)).toBe(gates);
  });

  it('removes the wizard\'s shared cell gate', () => {
    const gates = [ref('cells', null), rect('live', null)];
    expect(withoutReferenceGates(gates).map((g) => g.id)).toEqual(['live']);
  });

  it('removes every control bracket, which is what the report showed', () => {
    const gates = [
      ref('cells', null),
      ref('cd3+', 'cells'), ref('cd4+', 'cells'), ref('cd8+', 'cells'),
    ];
    expect(withoutReferenceGates(gates)).toEqual([]);
  });

  it('lifts the user\'s own gates rather than deleting them with their parent', () => {
    /*
       The case that makes this a lift and not a filter. A gate drawn on an
       unscoped panel nests under whatever is selected in the tree, and the
       wizard's *Cells* sat at the root of every general layout — so a real
       analysis routinely ended up beneath it. Deleting the subtree would throw
       away the work the user came to do.
    */
    const gates = [ref('cells', null), rect('live', 'cells'), rect('cd4', 'live')];
    const out = withoutReferenceGates(gates);
    expect(out.map((g) => g.id)).toEqual(['live', 'cd4']);
    // Live comes up to the root; CD4 stays under Live, where the user put it.
    expect(out.find((g) => g.id === 'live')!.parentId).toBeNull();
    expect(out.find((g) => g.id === 'cd4')!.parentId).toBe('live');
  });

  it('follows a chain of reference gates all the way to a survivor', () => {
    const gates = [rect('mine', null), ref('a', 'mine'), ref('b', 'a'), rect('leaf', 'b')];
    const out = withoutReferenceGates(gates);
    expect(out.map((g) => g.id)).toEqual(['mine', 'leaf']);
    expect(out.find((g) => g.id === 'leaf')!.parentId).toBe('mine');
  });

  it('lifts to the root when every ancestor is the wizard\'s', () => {
    const gates = [ref('cells', null), ref('sub', 'cells'), rect('leaf', 'sub')];
    expect(withoutReferenceGates(gates).find((g) => g.id === 'leaf')!.parentId).toBeNull();
  });

  it('leaves untouched gates identical, so nothing re-renders for nothing', () => {
    const keep = rect('keep', null);
    const gates = [keep, ref('cells', null)];
    expect(withoutReferenceGates(gates)[0]).toBe(keep);
  });

  it('terminates on a malformed hierarchy rather than hanging a selector', () => {
    // Two reference gates parented to each other. Not reachable through the UI;
    // a workspace file is text on disk and a selector must not spin on one.
    const gates = [ref('a', 'b'), ref('b', 'a'), rect('leaf', 'a')];
    const out = withoutReferenceGates(gates);
    expect(out.map((g) => g.id)).toEqual(['leaf']);
    expect(out[0]!.parentId).toBeNull();
  });
});

/* ==========================================================================
   Keeping the wizard's gates to the wizard's *current* setup — 2026-08-13.

   The sibling of the duplicate-worksheet bug, reported once that one was fixed:
   removing a control and re-adding it left the gates the wizard had seeded for
   it in the strategy with nothing pointing at them, and seeded a second set
   beside them. Two *Autofluorescence clean* brackets on one histogram, then
   three; two *CD4 PE-Fire 744 +* labels drawn over each other.

   The keep set is ids and not samples, which is the whole of why the rule
   works: both copies are on the same control's own file, so anything phrased
   over samples keeps both.
   ========================================================================== */

describe('pruneReferenceGates', () => {
  const all = new Set<string>();

  it('returns the same array by identity when every wizard gate is named', () => {
    const gates = [ref('cells', null), ref('cd3+', 'cells'), rect('mine', null)];
    const keep = new Set(['cells', 'cd3+']);
    expect(pruneReferenceGates(gates, keep)).toBe(gates);
  });

  it('returns the same array by identity when the wizard has made none', () => {
    const gates = [rect('a', null), rect('b', 'a')];
    expect(pruneReferenceGates(gates, all)).toBe(gates);
  });

  it('drops the copy the setup no longer names and keeps the one it does', () => {
    // The reported case, at its smallest: one control, two brackets on its own
    // file, and an assignment that points at the second.
    const gates = [ref('cells', null), ref('clean-old', 'cells'), ref('clean-new', 'cells')];
    const out = pruneReferenceGates(gates, new Set(['cells', 'clean-new']));
    expect(out.map((g) => g.id)).toEqual(['cells', 'clean-new']);
  });

  it('drops a whole removed control\'s gates, positive and negative alike', () => {
    const gates = [
      ref('cells', null),
      ref('cd3+', 'cells'), ref('cd3-', 'cells'),
      ref('cd8+', 'cells'),
    ];
    const out = pruneReferenceGates(gates, new Set(['cells', 'cd8+']));
    expect(out.map((g) => g.id)).toEqual(['cells', 'cd8+']);
  });

  it('never touches a gate the operator drew, named or not', () => {
    // Drawing one does not set `reference`, so the keep set has nothing to say
    // about it. This is what makes the rule safe to run on every build.
    const mine = rect('mine', null);
    const gates = [ref('cells', null), mine, rect('under', 'mine')];
    const out = pruneReferenceGates(gates, new Set(['cells']));
    expect(out.map((g) => g.id)).toEqual(['cells', 'mine', 'under']);
    expect(out[1]).toBe(mine);
  });

  it('lifts the operator\'s gates out from under a bracket it removes', () => {
    // Same argument as `withoutReferenceGates`: the subtree is somebody's work
    // and losing it to a reconciliation is not recoverable.
    const gates = [ref('cells', null), ref('stale', 'cells'), rect('mine', 'stale')];
    const out = pruneReferenceGates(gates, new Set(['cells']));
    expect(out.map((g) => g.id)).toEqual(['cells', 'mine']);
    expect(out.find((g) => g.id === 'mine')!.parentId).toBe('cells');
  });

  it('lifts to the root when the general gate goes too', () => {
    const gates = [ref('cells', null), ref('stale', 'cells'), rect('mine', 'stale')];
    expect(pruneReferenceGates(gates, all).map((g) => g.id)).toEqual(['mine']);
    expect(pruneReferenceGates(gates, all)[0]!.parentId).toBeNull();
  });

  it('empties the strategy of wizard gates when the setup names nothing', () => {
    // Which is a real state: every control taken out at Step 1.
    const gates = [ref('cells', null), ref('cd3+', 'cells')];
    expect(pruneReferenceGates(gates, all)).toEqual([]);
  });
});

describe('withoutReferenceSamples', () => {
  const samples = [{ id: 's1' }, { id: 's2' }, { id: 's3' }];

  it('keeps everything when no unmixing panel has been set up', () => {
    expect(withoutReferenceSamples(samples, [])).toEqual(samples);
  });

  it('drops the tubes that were ticked as controls', () => {
    expect(withoutReferenceSamples(samples, ['s1', 's3'])).toEqual([{ id: 's2' }]);
  });

  it('ignores a control id whose sample has been removed', () => {
    expect(withoutReferenceSamples(samples, ['s9'])).toEqual(samples);
  });

  it('keeps them all when every loaded file is a control', () => {
    /*
       The rule's limit. Excluding the controls exists to keep setup out of a
       table of results; with no results there is nothing to keep it out of, and
       what strict exclusion produces is an empty statistics table over a
       workspace the user can see three samples in. A bead panel loaded on its
       own — matrix first, the experiment's files afterwards — is a real way to
       reach this.
    */
    expect(withoutReferenceSamples(samples, ['s1', 's2', 's3'])).toEqual(samples);
  });

  it('still excludes them the moment one non-control arrives', () => {
    expect(withoutReferenceSamples(samples, ['s1', 's2'])).toEqual([{ id: 's3' }]);
  });
});
