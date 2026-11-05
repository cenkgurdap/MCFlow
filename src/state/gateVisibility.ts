/**
 * Which gates a surface is allowed to see.
 *
 * Two stores have to be consulted to answer that — `gateStore` for the strategy
 * and `plotStore` for what kind of worksheet this window is showing — and
 * neither should import the other for it. This module is the join, and it is the
 * only place the rule is written down:
 *
 * > A gate the unmixing wizard created is visible and evaluated on the wizard's
 * > own reference worksheets, and nowhere else.
 *
 * The rule itself is `withoutReferenceGates`, pure and separately tested. What
 * lives here is the *when*.
 */

import { useMemo } from 'react';
import type { Gate } from '@/core/gating/types';
import { withoutReferenceGates, withoutReferenceSamples } from '@/core/gating/referenceGates';
import { gatesOfSample, useGates } from './gateStore';
import { usePlot } from './plotStore';
import { useSpectral } from './spectralStore';

/**
 * The gates the worksheet and the sidebar tree should show for a sample.
 *
 * On a `kind: 'reference'` layout — one the wizard generated and owns — the
 * strategy comes through untouched, because that is the one place the control
 * brackets and the shared cell gate are the subject. Everywhere else the
 * wizard's gates are removed and anything the user built under them is lifted.
 *
 * Keyed on the **layout** rather than on the panel or the selected sample,
 * because the leak was about where you were standing: the same sample and the
 * same gate are legitimate on the CD3 worksheet and noise on "main".
 */
export function useVisibleGates(sampleId: string | null | undefined): Gate[] {
  const gates = useGates(gatesOfSample(sampleId));
  const onReferenceWorksheet = usePlot((s) => s.activeLayoutKind === 'reference');
  return useMemo(
    () => (onReferenceWorksheet ? gates : withoutReferenceGates(gates)),
    [gates, onReferenceWorksheet],
  );
}

/**
 * The samples Statistics and Export are about.
 *
 * The reference controls are dropped, and unlike the gate rule above this one
 * has **no reference-worksheet exemption** — there is no such thing as a
 * reference worksheet in the statistics table. Those two panels report on the
 * experiment, and a single-stain tube is setup: it is in the workspace so a
 * matrix can be built from it, and its own median CD3 signal is not a result.
 *
 * A sample is a control because it was ticked in Step 1 — never because of what
 * its file is called. Filename guessing was deleted on 2026-08-06.
 *
 * The rule's own limit — every loaded file being a control — is in
 * `withoutReferenceSamples`, beside the rule rather than here.
 */
export function useExperimentSamples<T extends { id: string }>(samples: readonly T[]): T[] {
  const controls = useSpectral((s) => s.controls);
  return useMemo(
    () => withoutReferenceSamples(samples, controls.map((c) => c.sampleId)),
    [samples, controls],
  );
}
