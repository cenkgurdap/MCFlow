import { beforeEach, describe, expect, it } from 'vitest';
import type { ParsedFcs } from '@/core/fcs/types';
import { useGates } from './gateStore';
import { useDerived } from './derivedStore';
import { useSpectral } from './spectralStore';
import { useWorkspace, type Sample } from './workspaceStore';

/* ==========================================================================
   `computeMatrix` on conventional controls.

   `core/compensation.test.ts` proves the arithmetic and checks a matrix against
   FACSDiva's. What it does not touch is the path between the two: the store
   function that turns *this wizard's* controls — a role, a peak, a positive
   gate — into the rows that arithmetic takes. That is `compensationFrom`, and
   the three things it can get wrong are all invisible to a maths test.

   1. **The negative.** A square system has no autofluorescence row, so every
      signature has to have one subtracted. A spectral control with
      `reference: 'unstained'` has nothing subtracted here, by design, because
      the solve carries the background as a row of its own — so the same code
      path with no subtraction added would produce a matrix whose coefficients
      are all inflated by the panel's background, and every one of them would
      still look like a plausible number.
   2. **Which detector normalises the row**, which comes from Step 2's measured
      peak rather than from the signature's argmax.
   3. **Which model gets built at all**, which is asked of the controls.

   The fixture injects a known spillover and the test asks for it back, which is
   the only way to tell a correct matrix from a self-consistent one.
   ========================================================================== */

/** Six detectors, two scatter channels. */
const D = 6;
const N = 800;

/**
 * A conventional single stain with a bright and a dim population.
 *
 * `spill` gives the dye a real presence in other detectors, as a fraction of
 * its own peak — which is the whole point here: a dye that emits in exactly one
 * detector produces an identity matrix, and an identity matrix cannot tell a
 * correct normalisation from a transposed one.
 *
 * **Every event carries a background**, and it is not the same in every
 * detector. That is what makes the subtraction testable: without it, a matrix
 * built with no negative subtracted comes out identical to one built correctly.
 */
function control(
  id: string,
  name: string,
  peak: number | null,
  spill: Record<number, number> = {},
): Sample {
  const params = Array.from({ length: D + 2 }, (_, i) => ({
    index: i + 1,
    name: i < 2 ? (i === 0 ? 'FSC-A' : 'SSC-A') : `FL${i - 1}-A`,
    stain: '',
    label: i < 2 ? (i === 0 ? 'FSC-A' : 'SSC-A') : `FL${i - 1}-A`,
    bits: 32,
    range: 262144,
    amplification: [0, 0] as [number, number],
    gain: null,
    voltage: null,
    // No `$PnTYPE` on a conventional file, so every fluorescence channel parses
    // as `Other` — which is exactly the case `detectorIndices`' third rule was
    // added for, and the reason this fixture does not tag them.
    type: i < 2 ? (i === 0 ? ('Forward_Scatter' as const) : ('Side_Scatter' as const)) : ('Other' as const),
    isDataChannel: true,
  }));

  const data = new Float32Array((D + 2) * N);
  for (let e = 0; e < N; e++) {
    const isCell = e % 4 !== 3;
    const hx = ((e * 1103515245 + 12345) >>> 8) % 1000;
    const hy = ((e * 1664525 + 1013904223) >>> 8) % 1000;
    data[0 * N + e] = isCell ? 4200 + hx * 0.8 : 200 + hx * 1.5;
    data[1 * N + e] = isCell ? 3200 + hy * 0.8 : 150 + hy * 1.2;

    const isPositive = peak !== null && isCell && e % 4 === 0;
    for (let d = 0; d < D; d++) {
      // A background that differs per detector, so failing to subtract it is
      // visible in the coefficients rather than cancelling out.
      const background = 200 + d * 130;
      data[(d + 2) * N + e] = isPositive
        ? background + (d === peak ? 9000 : (spill[d] ?? 0) * 9000)
        : background;
    }
  }

  const parsed: ParsedFcs = {
    metadata: {
      version: 'FCS3.0', keywords: {}, parameters: params,
      eventCount: N, parameterCount: D + 2,
      cytometer: 'LSRFortessa', cytometerSerial: null, instrument: null, operator: null,
      project: null, originalFilename: null, software: 'BD FACSDiva',
      acquiredAt: null, beginTime: null, endTime: null, timestep: null, volume: null,
      spillover: null, compensationApplied: false,
      dataType: 'F', byteOrder: 'big', mode: 'L', nextData: 0,
    },
    data,
    warnings: [],
  };

  return {
    id, name, fileName: `${name}.fcs`, filePath: `D:/fake/${name}.fcs`, fileSize: 1,
    groupId: 'g', parsed,
    detection: { type: 'conventional', fluorescenceChannels: D, reason: 'test' } as never,
    acquisitionOverride: null,
    identity: { label: name, marker: null, fluorophore: null, isUnstained: /unstain/i.test(name), confidence: 'high' } as never,
    colorIndex: 0,
  };
}

/** The spillover injected into the fixture, as a fraction of each dye's peak. */
const SPILL_A = { 3: 0.25, 4: 0.06 };
const SPILL_B = { 2: 0.11 };

const SAMPLES = [
  control('u', 'Unstained', null),
  control('a', 'Dye A', 2, SPILL_A),
  control('b', 'Dye B', 3, SPILL_B),
];

function reset() {
  useWorkspace.setState({ samples: SAMPLES, selectedSampleId: 'a' });
  useDerived.setState({ defs: [] });
  useGates.setState({ gates: {} } as never);
  useSpectral.getState().resetWizard();
  useSpectral.getState().clearSpectra();
}

/** Walk the wizard the way the panel does, up to Compute. */
function walkToCompute() {
  const sp = useSpectral.getState();
  sp.setSelected(SAMPLES.map((s) => s.id));
  sp.syncControls(SAMPLES);
  for (const s of SAMPLES) {
    useSpectral.getState().setControlRole(s.id, s.name === 'Unstained' ? 'unstained' : 'stain');
  }
  useSpectral.getState().buildGatingLayouts(SAMPLES);
  useSpectral.getState().ensureGated(SAMPLES);
}

describe('computeMatrix on conventional controls', () => {
  beforeEach(reset);

  it('builds a compensation matrix, not a spectral one', () => {
    walkToCompute();
    const r = useSpectral.getState().computeMatrix(SAMPLES);
    expect(r.ok, r.message).toBe(true);
    expect(useSpectral.getState().kind).toBe('compensation');
  });

  it('spans every fluorescence detector, one row each', () => {
    walkToCompute();
    useSpectral.getState().computeMatrix(SAMPLES);
    const { spectra, detectorNames } = useSpectral.getState();
    expect(detectorNames).toHaveLength(D);
    expect(spectra).toHaveLength(D);
    // Square: every row is as long as the detector list, which is what makes
    // the pseudo-inverse an inverse.
    for (const s of spectra) expect(s.values).toHaveLength(D);
    // And no background row. A square system has no room for one.
    expect(spectra.some((s) => s.isAutofluorescence)).toBe(false);
  });

  it('recovers the spillover that was injected', () => {
    walkToCompute();
    useSpectral.getState().computeMatrix(SAMPLES);
    const { spectra } = useSpectral.getState();

    // Row `d` is the dye measured on detector `d`. Dye A peaks on detector 2.
    const rowA = spectra[2]!.values;
    expect(rowA[2]).toBeCloseTo(1, 6);
    expect(rowA[3]).toBeCloseTo(SPILL_A[3], 2);
    expect(rowA[4]).toBeCloseTo(SPILL_A[4], 2);
    // Nothing was put in detector 5, and the background subtraction is what
    // stops the panel's own baseline appearing there as a coefficient.
    expect(Math.abs(rowA[5]!)).toBeLessThan(0.02);

    const rowB = spectra[3]!.values;
    expect(rowB[3]).toBeCloseTo(1, 6);
    expect(rowB[2]).toBeCloseTo(SPILL_B[2], 2);
  });

  it('gives a detector no dye peaks in an identity row', () => {
    walkToCompute();
    useSpectral.getState().computeMatrix(SAMPLES);
    const { spectra } = useSpectral.getState();
    // Detectors 0, 1, 4 and 5 carry no dye in this panel.
    for (const d of [0, 1, 4, 5]) {
      const row = spectra[d]!.values;
      expect(row[d]).toBe(1);
      for (let j = 0; j < D; j++) if (j !== d) expect(row[j]).toBe(0);
    }
  });

  it('names each row from the control that claimed it, and the detector otherwise', () => {
    walkToCompute();
    useSpectral.getState().computeMatrix(SAMPLES);
    const labels = useSpectral.getState().spectra.map((s) => s.label);
    expect(labels[2]).toBe('Dye A');
    expect(labels[3]).toBe('Dye B');
    expect(labels[0]).toBe('FL1-A');
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * With no unstained tube, where the negative comes from is the control's own
   * choice — and both answers are real workflows.
   *
   * `self` is compensation beads: one tube carries a negative and a positive
   * population, both gated on its own data, and no separate unstained sample is
   * involved. `unstained` says the negative lives in another file — so if that
   * file is not in the panel there is nothing to subtract, and a square system
   * has no background row to absorb it. The first must build; the second must
   * refuse rather than return coefficients inflated by the panel's own baseline.
   */
  function stainsOnly(reference: 'self' | 'unstained') {
    const stains = SAMPLES.filter((s) => s.name !== 'Unstained');
    useWorkspace.setState({ samples: stains });
    const sp = useSpectral.getState();
    sp.setSelected(stains.map((s) => s.id));
    sp.syncControls(stains);
    for (const s of stains) {
      useSpectral.getState().setControlRole(s.id, 'stain');
      useSpectral.getState().setControlReference(s.id, reference);
    }
    useSpectral.getState().buildGatingLayouts(stains);
    useSpectral.getState().ensureGated(stains);
    return stains;
  }

  it('builds from self-referencing controls with no unstained tube at all', () => {
    const stains = stainsOnly('self');
    const r = useSpectral.getState().computeMatrix(stains);
    expect(r.ok, r.message).toBe(true);
    expect(useSpectral.getState().kind).toBe('compensation');
    expect(useSpectral.getState().spectra[2]!.values[3]).toBeCloseTo(SPILL_A[3], 2);
  });

  it('but refuses when the negative is meant to be in a file the panel does not have', () => {
    const stains = stainsOnly('unstained');
    const r = useSpectral.getState().computeMatrix(stains);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/negative/i);
  });

  it('builds a spectral matrix when the same controls are spectral', () => {
    // The switch is the *controls*, not a mode — so overriding the acquisition
    // type on the samples is the whole of what changes the model built.
    const spectral = SAMPLES.map((s) => ({ ...s, acquisitionOverride: 'spectral' as const }));
    useWorkspace.setState({ samples: spectral });
    const sp = useSpectral.getState();
    sp.setSelected(spectral.map((s) => s.id));
    sp.syncControls(spectral);
    for (const s of spectral) {
      useSpectral.getState().setControlRole(s.id, s.name === 'Unstained' ? 'unstained' : 'stain');
    }
    useSpectral.getState().buildGatingLayouts(spectral);
    useSpectral.getState().ensureGated(spectral);

    const r = useSpectral.getState().computeMatrix(spectral);
    expect(r.ok, r.message).toBe(true);
    expect(useSpectral.getState().kind).toBe('unmixing');
    // Two stains and one background row, not one row per detector.
    expect(useSpectral.getState().spectra).toHaveLength(3);
    expect(useSpectral.getState().spectra.some((s) => s.isAutofluorescence)).toBe(true);
  });
});
