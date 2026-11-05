/**
 * Keeping the unmixing wizard's own gates inside the unmixing wizard.
 *
 * The reference controls are **setup**. A single stain's bracket answers "where
 * does this dye's positive population start on this tube", and the scatter gate
 * under all of them answers "where are the cells on a control". Neither is a
 * statement about the experiment, and both were reaching the rest of the
 * application because gating in MCFlow is shared across samples by design.
 *
 * ## What the report showed (2026-08-12, Item 11)
 *
 * A gate tree in a general layout — a worksheet with no connection to the
 * wizard, analysing a multicolour sample with an unmixing matrix applied —
 * headed *"Shared across all 14 samples"* and listing **Cells**, then the
 * reference controls' own brackets, every one of them at **0.00%**. The
 * percentages were right: a bracket is a threshold on the CD3 control's
 * distribution and selects nothing on a different file. They were answers to
 * questions nobody had asked, on a screen where the questions somebody *had*
 * asked were mixed in with them.
 *
 * ## The rule
 *
 * > A gate the wizard created is visible and evaluated on the wizard's own
 * > reference worksheets, and nowhere else.
 *
 * Pure and store-free, so the rule can be asserted directly rather than through
 * four rendered surfaces — the same reason `panelGates.ts` is a module rather
 * than a condition inside `GateLayer`.
 */

import type { Gate } from './types';

/** Did the unmixing wizard create this gate? */
export function isReferenceGate(g: Gate): boolean {
  return g.reference === true;
}

/**
 * Drop the gates a predicate names, lifting every survivor under them.
 *
 * **Children are re-parented upward rather than dropped**, which is exactly
 * what `removeGate` does and for the same reason: losing a subtree is not
 * recoverable, and the subtree under a reference gate is not hypothetical. A
 * gate drawn on an unscoped panel nests under whatever is selected in the tree
 * (`gateParentFor`), and *Cells* sitting at the root of every general layout is
 * precisely what tended to be selected — so a user's real analysis routinely
 * ended up beneath it. That analysis is theirs; the gate above it was never
 * meant to be there, and lifting the children is what the tree would look like
 * if it never had been.
 *
 * Chains are followed, so a removed gate under a removed gate lifts its
 * survivors all the way to the first ancestor that is staying — or to the root.
 *
 * Returns the input array **by identity** when the predicate names nothing, so
 * the two callers below can both lean on that: one runs inside a selector, and
 * the other decides whether a store write is needed at all.
 */
function dropping(gates: Gate[], doomed: (g: Gate) => boolean): Gate[] {
  if (!gates.some(doomed)) return gates;

  /** Removed gate id → the parent it would hand its children to. */
  const lifted = new Map<string, string | null>();
  for (const g of gates) if (doomed(g)) lifted.set(g.id, g.parentId);

  /** The nearest ancestor that survives, or the root. */
  const survivor = (parentId: string | null): string | null => {
    let p = parentId;
    // Bounded by the number of removed gates: a cycle cannot outlast it, and a
    // malformed hierarchy must not hang a selector.
    for (let i = 0; p !== null && lifted.has(p) && i <= lifted.size; i++) {
      p = lifted.get(p) ?? null;
    }
    return p !== null && lifted.has(p) ? null : p;
  };

  return gates
    .filter((g) => !doomed(g))
    .map((g) => {
      const p = survivor(g.parentId);
      return p === g.parentId ? g : { ...g, parentId: p };
    });
}

/**
 * The strategy with a named set of gates taken out, and their children lifted.
 *
 * The same engine, pointed at ids instead of at the `reference` marker, and it
 * lives here rather than beside its caller for one reason: `dropping` is where
 * the child re-parenting is implemented, and a second implementation of that is
 * exactly what this file exists to prevent. The rule about a subtree being
 * unrecoverable is not about the unmixing wizard — it is about removing a gate
 * that something was drawn underneath, whoever placed it.
 *
 * Written for Biophysics' *Discard setup* (2026-08-28), which removes the cell
 * gate, the doublet cut and the fitted population gates **together**, in one
 * step. One call rather than one `removeGate` per gate per sample: the ids are
 * known as a set, the survivors have to be re-parented against the whole set at
 * once — a population gate under *Cells* when both are going lifts to the root,
 * not to *Cells* — and a chain resolved one removal at a time gets that wrong.
 *
 * Returns the input array **by identity** when the set names nothing here, so a
 * caller can use it to decide whether a store write is needed at all.
 */
export function withoutGates(gates: Gate[], doomed: ReadonlySet<string>): Gate[] {
  return dropping(gates, (g) => doomed.has(g.id));
}

const cache = new WeakMap<Gate[], Gate[]>();

/**
 * The strategy with the wizard's gates taken out, and their children lifted.
 *
 * Returns the input array **by identity** when there is nothing to remove,
 * which is every workspace with no unmixing panel set up and every one saved
 * before this field existed. That matters beyond the allocation: this runs
 * inside Zustand selectors, where a fresh array on every call is a fresh
 * reference on every render.
 */
export function withoutReferenceGates(gates: Gate[]): Gate[] {
  if (!gates.some(isReferenceGate)) return gates;
  const hit = cache.get(gates);
  if (hit) return hit;
  const out = dropping(gates, isReferenceGate);
  cache.set(gates, out);
  return out;
}

/**
 * The strategy with every wizard gate the current setup does not name removed.
 *
 * ## The duplicate-gate bug (2026-08-13)
 *
 * The sibling of the duplicate *worksheet* one fixed the day before, one level
 * down and reported the same way: take the Autofluorescence control out at
 * Step 1, put it back, and its worksheet now carries **two** brackets called
 * *Autofluorescence clean*, then three, then four — each an exact copy of the
 * last, stacked on the same histogram at the same percentage. The same thing on
 * a stain: two *CD4 PE-Fire 744 +* labels drawn over each other at two
 * different percentages, and two entries in the tree.
 *
 * The mechanism is the one Item 8 described and did not finish. De-selecting a
 * control clears its assignment, deliberately — that is how an assignment is
 * cleared — and the assignment is the **only** thing that knew which gates the
 * wizard had made for it. So the gates outlived the pointer to them: re-adding
 * the control produced a fresh assignment with no gate, `seedGates` seeded a new
 * one, and the previous pass's gate was still there, still flagged `reference`,
 * still owned by that sample, and therefore still drawn on that sample's
 * worksheet and counted in its tree.
 *
 * ## The rule
 *
 * > The wizard's gates are exactly the gates the wizard's **current** setup
 * > names: the shared cell gate, and each control's own positive and negative
 * > populations. Anything else it created is from a pass that no longer exists.
 *
 * Which is why `keep` is a set of ids rather than a set of samples. A gate is
 * kept because something points at it *now*, not because the file it was drawn
 * on is still in the panel — the duplicate case is two gates on one control's
 * own file, and every rule phrased over samples keeps both of them.
 *
 * **A gate the operator drew is never touched**, because drawing one does not
 * set `reference` — only the wizard's own seeding does (see `GateBase`). What
 * this can remove is a seeded bracket the current setup has stopped using, and
 * the one non-duplicate way to reach that is deliberate: assigning a control's
 * *Signature population* to a gate you drew yourself leaves the seeded one
 * unclaimed, and the next rebuild clears it away rather than leaving two
 * brackets on the histogram, one of which the operator has explicitly steered
 * off. Replacing the assignment still does not delete anything by itself —
 * that is `setControlGate`, and it is unchanged.
 */
export function pruneReferenceGates(gates: Gate[], keep: ReadonlySet<string>): Gate[] {
  return dropping(gates, (g) => isReferenceGate(g) && !keep.has(g.id));
}

/**
 * Samples that are reference controls, and so are not part of the experiment.
 *
 * Taken from the wizard's assignments rather than guessed from a filename —
 * filename guessing was deleted on 2026-08-06 and is not coming back. A sample
 * is a control because somebody ticked it in Step 1.
 *
 * **Unless they are all there is**, and that exception is not a patch on the
 * rule — it is the rule's own limit. Excluding the controls exists to keep
 * setup out of a table of results; where every loaded file is a control there
 * are no results to keep it out of, and what the exclusion produces is an empty
 * statistics table and an export offering nothing, on a workspace the user can
 * see fourteen samples in. That reads as the application being broken, which is
 * a worse answer than the noise the rule was removing. It is a real
 * configuration too: a bead panel is often loaded on its own, matrix first and
 * the experiment's files afterwards.
 */
export function withoutReferenceSamples<T extends { id: string }>(
  samples: readonly T[],
  controlSampleIds: readonly string[],
): T[] {
  if (controlSampleIds.length === 0) return [...samples];
  const control = new Set(controlSampleIds);
  const rest = samples.filter((s) => !control.has(s.id));
  return rest.length > 0 ? rest : [...samples];
}
