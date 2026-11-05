import { describe, expect, it } from 'vitest';
import { dataCeiling, type FcsParameter, type ParsedFcs } from '@/core/fcs/types';
import { axisDomainFor } from './derivedStore';

/* ==========================================================================
   2026-08-27 — a scatter axis is the instrument's range, not this tube's events.

   The report: *"the first plot's axes move from sample to sample, and the dense
   region with them — on beads, which are all the same size and must land in the
   same place."*

   The mechanism is at the **bottom** of the axis. A tube typically reaches
   `$PnR` on FSC-A and SSC-A, so the top never moves; the minimum is a single
   event, and on small tubes it can sit anywhere — a large fraction of full
   scale of axis floor, decided by one stray event per file. A cell tube's
   minimum is steadier only because many events and an acquisition threshold
   pin it there.

   These tests are about the rule: which parameters declare a domain, and what
   the declared ceiling is once `$PnE` and `$PnG` have had their say — which is
   what makes **every tube from one instrument frame the same**.
   ========================================================================== */

function param(over: Partial<FcsParameter>): FcsParameter {
  return {
    index: 1,
    name: 'FSC-A',
    stain: '',
    label: 'FSC-A',
    bits: 32,
    range: 262144,
    amplification: [0, 0],
    gain: null,
    voltage: null,
    type: 'Forward_Scatter',
    isDataChannel: true,
    ...over,
  };
}

/** Just enough of a `ParsedFcs` to carry a parameter list. */
function sampleOf(parameters: FcsParameter[]): ParsedFcs {
  return {
    metadata: { parameters, eventCount: 0, keywords: {} },
    data: new Float32Array(0),
  } as unknown as ParsedFcs;
}

describe('dataCeiling', () => {
  it('is $PnR for the ordinary linear channel', () => {
    expect(dataCeiling(param({}))).toBe(262144);
  });

  it('follows $PnE, because the parser rewrites the values onto that scale', () => {
    // 4 decades from a value of 1 at channel 0 tops out at 10^4, and `$PnR` is
    // not a number that appears anywhere in the parsed column.
    expect(dataCeiling(param({ amplification: [4, 0] }))).toBe(10000);
    expect(dataCeiling(param({ amplification: [4, 0.1] }))).toBeCloseTo(1000, 6);
  });

  it('follows $PnG, which divides the ceiling with everything else', () => {
    expect(dataCeiling(param({ gain: 2 }))).toBe(131072);
    // A gain of 1 is not a division, and neither is a gain of 0.
    expect(dataCeiling(param({ gain: 1 }))).toBe(262144);
    expect(dataCeiling(param({ gain: 0 }))).toBe(262144);
  });

  it('answers 0 when the file declares no range', () => {
    expect(dataCeiling(param({ range: 0 }))).toBe(0);
  });
});

describe('axisDomainFor — which parameters declare a domain', () => {
  const parsed = sampleOf([
    param({ name: 'FSC-A', type: 'Forward_Scatter' }),
    param({ name: 'SSC-A', type: 'Side_Scatter' }),
    param({ name: 'B2-A', type: 'Raw_Fluorescence' }),
    param({ name: 'Time', type: 'Time' }),
    param({ name: 'FSC-A', type: 'Forward_Scatter', range: 0 }),
  ]);

  it('frames both scatter kinds on [0, ceiling]', () => {
    expect(axisDomainFor(parsed, 0, [])).toEqual({ min: 0, max: 262144 });
    expect(axisDomainFor(parsed, 1, [])).toEqual({ min: 0, max: 262144 });
  });

  it('leaves a fluorescence detector framed on what it measures', () => {
    // It reads below zero and the file declares no floor for it, so [0, $PnR]
    // would cut the negative population off.
    expect(axisDomainFor(parsed, 2, [])).toBeNull();
  });

  it('leaves Time alone — elapsed time genuinely differs between tubes', () => {
    expect(axisDomainFor(parsed, 3, [])).toBeNull();
  });

  it('falls back to the measured extent when no range is declared', () => {
    expect(axisDomainFor(parsed, 4, [])).toBeNull();
  });

  it('answers null past the end of the real parameters', () => {
    expect(axisDomainFor(parsed, 99, [])).toBeNull();
  });
});
