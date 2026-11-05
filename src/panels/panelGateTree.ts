/**
 * One gate tree over a whole reference panel.
 *
 * ## What was wrong (2026-08-09)
 *
 * The sidebar's gate tree is scoped to one sample — `gatesOfSample(selected)` —
 * which is right for ordinary gating, where the hierarchy is shared and every
 * sample shows the same populations with its own numbers. It is wrong during the
 * unmixing walk, for a reason introduced by the fix before it: the wizard's
 * seeded gates carry `ownerSampleId`, so `resolveGates` filters each control's
 * positive gate out of every *other* control's list. The tree therefore showed
 * the general gate and, at most, whichever control's file happened to be
 * selected in the sample browser — which during a walk is usually not the
 * control on screen at all, so in practice it showed **Cells** and nothing else.
 *
 * That is not a regression in `ownerSampleId`: filtering is exactly what it is
 * for, and a worksheet must not draw another control's population. It is a
 * missing view. Gating a reference panel is a job about *the panel* — thirteen
 * populations that have to end up looking right together — and the one place the
 * app lists populations was answering about one file.
 *
 * ## The merge, and where each number comes from
 *
 * Every control is evaluated against **its own file**, which is the only
 * evaluation that means anything: `CD3 RY703 +` is a threshold on the CD3 tube's
 * distribution and evaluating it on the CD8 tube produces a number with no
 * referent. So each control contributes the gates it owns, together with the
 * statistics computed on its own events.
 *
 * The gates nobody owns — the shared general gate, and anything drawn by hand —
 * exist on all of them and would otherwise appear thirteen times with thirteen
 * different counts. **The first evaluation wins** for those, and the caller puts
 * the control whose worksheet is on screen first, so the shared rows read as the
 * plot the user is looking at reads.
 *
 * Pure and store-free, because "every control's gates appear exactly once, in
 * walk order, each with its own file's numbers" is a claim about three maps and
 * should be assertable without a renderer.
 */

import type { Gate, PopulationStats } from '@/core/gating/types';

export interface ControlEvaluation {
  sampleId: string;
  /** This sample's resolved gates — shared, forked and owned, already folded. */
  gates: Gate[];
  stats: Map<string, PopulationStats>;
  errors: Map<string, string>;
}

export interface PanelTree {
  gates: Gate[];
  stats: Map<string, PopulationStats>;
  errors: Map<string, string>;
}

export function mergeControlTrees(evaluations: readonly ControlEvaluation[]): PanelTree {
  const stats = new Map<string, PopulationStats>();
  const errors = new Map<string, string>();
  const shared: Gate[] = [];
  const owned: Gate[] = [];
  const seen = new Set<string>();

  for (const ev of evaluations) {
    for (const g of ev.gates) {
      if (seen.has(g.id)) continue;
      // An owned gate is listed under the control that owns it. An unowned one
      // is listed once, from the first evaluation — which is the one on screen —
      // because a later control's copy is the same population, and adding it
      // again would put the general gate in the tree thirteen times.
      if (g.ownerSampleId !== undefined && g.ownerSampleId !== ev.sampleId) continue;
      seen.add(g.id);
      (g.ownerSampleId === undefined ? shared : owned).push(g);
    }

    for (const [id, st] of ev.stats) {
      // First writer wins, so a shared gate reports the leading control's
      // numbers and an owned gate can only ever be reported by its owner.
      if (!stats.has(id)) stats.set(id, st);
    }
    for (const [id, e] of ev.errors) {
      if (!errors.has(id)) errors.set(id, e);
    }
  }

  // Shared gates first so the general gate is at the top of its own branch, then
  // the owned ones in the order the controls were given — which is the walk
  // order, so the tree and the tab strip read down in the same sequence.
  return { gates: [...shared, ...owned], stats, errors };
}
