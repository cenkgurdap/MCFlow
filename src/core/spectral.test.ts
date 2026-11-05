import { describe, expect, it } from 'vitest';
import type { ParsedFcs } from './fcs/types';
import {
  autoGateBound, buildUnmixOperator, cosineSimilarity, DEFAULT_POSITIVE_FRACTION,
  detectorBrightness, extractAutofluorescence, extractGatedSignature,
  extractSignature, normaliseSignature,
  similarityMatrix, unmix, UnmixError, worstPair,
  type ReferenceSpectrum, type UnmixingSetup,
} from './spectral';

/* ==========================================================================
   Synthetic ground truth — the only way to prove unmixing recovers what it
   should, since no real file comes with known abundances.
   ========================================================================== */

function gaussianSpectrum(D: number, centre: number, width: number): Float64Array {
  const v = new Float64Array(D);
  for (let d = 0; d < D; d++) v[d] = Math.exp(-((d - centre) ** 2) / (2 * width * width));
  return normaliseSignature(v);
}

function spectrum(id: string, values: Float64Array, isAuto = false): ReferenceSpectrum {
  return { id, label: id, values, isAutofluorescence: isAuto, sourceSampleId: null, eventCount: 1000 };
}

/** Build a fake ParsedFcs holding a mixture of known abundances. */
function syntheticMixture(spectra: ReferenceSpectrum[], truth: number[][], D: number): ParsedFcs {
  const N = truth.length;
  const data = new Float32Array(D * N);
  for (let e = 0; e < N; e++) {
    for (let d = 0; d < D; d++) {
      let y = 0;
      for (let f = 0; f < spectra.length; f++) y += truth[e]![f]! * spectra[f]!.values[d]!;
      data[d * N + e] = y;
    }
  }
  return {
    metadata: {
      eventCount: N, parameterCount: D,
      parameters: Array.from({ length: D }, (_, i) => ({
        index: i + 1, name: `D${i + 1}-A`, stain: '', label: `D${i + 1}-A`,
        bits: 32, range: 262144, amplification: [0, 0] as [number, number],
        gain: null, voltage: null, type: 'Raw_Fluorescence' as const, isDataChannel: true,
      })),
    } as never,
    data,
    warnings: [],
  };
}

describe('unmixing recovers known abundances', () => {
  const D = 32;
  const spectra = [
    spectrum('FluorA', gaussianSpectrum(D, 6, 3)),
    spectrum('FluorB', gaussianSpectrum(D, 14, 3)),
    spectrum('FluorC', gaussianSpectrum(D, 22, 3)),
    spectrum('AF', gaussianSpectrum(D, 12, 9), true),
  ];
  const setup: UnmixingSetup = {
    detectorIndices: Array.from({ length: D }, (_, i) => i),
    detectorNames: Array.from({ length: D }, (_, i) => `D${i + 1}-A`),
    spectra,
  };

  const truth = [
    [1000, 0, 0, 50],
    [0, 2000, 0, 50],
    [0, 0, 1500, 50],
    [500, 700, 300, 120],
    [0, 0, 0, 200],
  ];

  it('returns the exact abundances for a noise-free mixture', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    const r = unmix(parsed, setup, 'ols');
    expect(r.labels).toEqual(['FluorA', 'FluorB', 'FluorC', 'AF']);
    truth.forEach((row, e) => {
      row.forEach((expected, f) => {
        expect(r.data[f * truth.length + e]).toBeCloseTo(expected, 1);
      });
    });
  });

  it('separates a single-positive event with no bleed into the others', () => {
    const parsed = syntheticMixture(spectra, [[1000, 0, 0, 0]], D);
    const r = unmix(parsed, setup, 'ols');
    expect(r.data[0]).toBeCloseTo(1000, 2);
    expect(Math.abs(r.data[1]!)).toBeLessThan(1);
    expect(Math.abs(r.data[2]!)).toBeLessThan(1);
  });

  it('extracts autofluorescence as its own abundance rather than smearing it', () => {
    // An unstained event is pure autofluorescence: every dye must come back ~0.
    const parsed = syntheticMixture(spectra, [[0, 0, 0, 300]], D);
    const r = unmix(parsed, setup, 'ols');
    expect(r.data[3]).toBeCloseTo(300, 2);
    for (let f = 0; f < 3; f++) expect(Math.abs(r.data[f]!)).toBeLessThan(1);
  });

  it('stays close to the truth with measurement noise added', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    for (let i = 0; i < parsed.data.length; i++) parsed.data[i]! += rnd() * 20;

    const r = unmix(parsed, setup, 'ols');
    truth.forEach((row, e) => {
      row.forEach((expected, f) => {
        // Noise propagates, but the answer must stay recognisable.
        expect(Math.abs(r.data[f * truth.length + e]! - expected)).toBeLessThan(60);
      });
    });
  });

  it('weighted least squares also recovers the abundances', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    const weights = new Float64Array(D).fill(1);
    const r = unmix(parsed, setup, 'wls', weights);
    truth.forEach((row, e) => {
      row.forEach((expected, f) => {
        expect(r.data[f * truth.length + e]).toBeCloseTo(expected, 1);
      });
    });
  });

  /*
     The two checks below exist because the one above passes for the wrong
     reason if the weighting is ever quietly dropped.

     `weights` filled with 1 makes WLS *identical* to OLS by construction — W is
     the identity, so `x = y W Sᵀ (S W Sᵀ)⁻¹` collapses to the ordinary normal
     equations — so a build in which the weights never reached the operator
     would satisfy it. That is exactly the failure Item 13 asked to rule out,
     and ruling it out needs a weight vector that is not flat.
  */
  it('weighted least squares is not ordinary least squares', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    // A detector block that is an order of magnitude noisier than the rest, in
    // the shape a real unstained control produces: one laser's worth of high
    // autofluorescence variance.
    const weights = new Float64Array(D).fill(1);
    for (let d = 0; d < 8; d++) weights[d] = 0.02;

    const ols = unmix(parsed, setup, 'ols');
    const wls = unmix(parsed, setup, 'wls', weights);

    let maxDelta = 0;
    for (let i = 0; i < ols.data.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(ols.data[i]! - wls.data[i]!));
    }
    // Noise-free input, so both are near-exact and the difference is small in
    // absolute terms — the claim is only that the weights reach the arithmetic.
    expect(maxDelta).toBeGreaterThan(1e-6);
  });

  it('weighting a noisy detector block down beats weighting it equally', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    // Noise on the first eight detectors alone, 40x what the rest carry. This
    // is the situation the weighting exists for: a channel whose variance is
    // not the channel's signal.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
    const N = truth.length;
    for (let d = 0; d < D; d++) {
      const scale = d < 8 ? 200 : 5;
      for (let e = 0; e < N; e++) parsed.data[d * N + e]! += rnd() * scale;
    }

    // Inverse variance, which is what `detectorWeights` measures from the
    // unstained control: (1/200²) against (1/5²), normalised to a mean of 1.
    const weights = new Float64Array(D);
    for (let d = 0; d < D; d++) weights[d] = d < 8 ? 1 / 200 ** 2 : 1 / 5 ** 2;
    let mean = 0;
    for (let d = 0; d < D; d++) mean += weights[d]!;
    mean /= D;
    for (let d = 0; d < D; d++) weights[d]! /= mean;

    const err = (r: { data: Float32Array }) => {
      let sum = 0;
      truth.forEach((row, e) => row.forEach((expected, f) => {
        sum += (r.data[f * N + e]! - expected) ** 2;
      }));
      return Math.sqrt(sum / (N * spectra.length));
    };

    const olsErr = err(unmix(parsed, setup, 'ols'));
    const wlsErr = err(unmix(parsed, setup, 'wls', weights));
    expect(wlsErr).toBeLessThan(olsErr);
  });

  it('reports a low condition number for a well-separated panel', () => {
    const { conditionNumber } = buildUnmixOperator(spectra);
    expect(conditionNumber).toBeGreaterThan(0);
    expect(conditionNumber).toBeLessThan(100);
  });

  it('reports a high condition number when two spectra nearly coincide', () => {
    const bad = [
      spectrum('A', gaussianSpectrum(D, 10, 3)),
      spectrum('B', gaussianSpectrum(D, 10.05, 3)),
    ];
    const { conditionNumber } = buildUnmixOperator(bad);
    expect(conditionNumber).toBeGreaterThan(100);
  });

  it('rejects an empty panel with an actionable message', () => {
    expect(() => buildUnmixOperator([])).toThrow(UnmixError);
  });

  it('rejects spectra whose detector count does not match the sample', () => {
    const parsed = syntheticMixture(spectra, truth, D);
    const mismatched: UnmixingSetup = {
      ...setup,
      spectra: [spectrum('Short', new Float64Array(8))],
    };
    expect(() => unmix(parsed, mismatched, 'ols')).toThrow(/detectors/);
  });
});

/* ==========================================================================
   Similarity
   ========================================================================== */

describe('similarity', () => {
  const D = 32;

  it('scores identical spectra as 1 and orthogonal ones as 0', () => {
    const a = gaussianSpectrum(D, 5, 2);
    const far = gaussianSpectrum(D, 28, 1);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10);
    expect(cosineSimilarity(a, far)).toBeLessThan(0.05);
  });

  it('rises as two spectra converge', () => {
    const base = gaussianSpectrum(D, 10, 3);
    const near = gaussianSpectrum(D, 11, 3);
    const mid = gaussianSpectrum(D, 14, 3);
    expect(cosineSimilarity(base, near)).toBeGreaterThan(cosineSimilarity(base, mid));
  });

  it('produces a symmetric matrix with a unit diagonal', () => {
    const spectra = [
      spectrum('A', gaussianSpectrum(D, 5, 3)),
      spectrum('B', gaussianSpectrum(D, 12, 3)),
      spectrum('C', gaussianSpectrum(D, 20, 3)),
    ];
    const n = spectra.length;
    const sim = similarityMatrix(spectra);
    for (let i = 0; i < n; i++) {
      expect(sim[i * n + i]).toBeCloseTo(1, 10);
      for (let j = 0; j < n; j++) expect(sim[i * n + j]).toBeCloseTo(sim[j * n + i]!, 12);
    }
  });

  it('finds the hardest pair', () => {
    const spectra = [
      spectrum('A', gaussianSpectrum(D, 5, 3)),
      spectrum('B', gaussianSpectrum(D, 20, 3)),
      spectrum('C', gaussianSpectrum(D, 20.5, 3)),
    ];
    const w = worstPair(spectra, similarityMatrix(spectra))!;
    expect(new Set([w.a, w.b])).toEqual(new Set([1, 2]));
    expect(w.value).toBeGreaterThan(0.95);
  });

  it('returns null for a single spectrum', () => {
    expect(worstPair([spectrum('A', gaussianSpectrum(D, 5, 3))], Float64Array.from([1]))).toBeNull();
  });
});

/* ==========================================================================
   Signature extraction
   ========================================================================== */

describe('extractSignature', () => {
  it('finds the peak detector and normalises to it', () => {
    const D = 8;
    const N = 1000;
    const data = new Float32Array(D * N);
    // Half the events are negative beads, half positive with a peak at d=5.
    for (let e = 0; e < N; e++) {
      const positive = e >= N / 2;
      for (let d = 0; d < D; d++) {
        data[d * N + e] = positive ? (d === 5 ? 1000 : d === 4 ? 400 : 10) : 5;
      }
    }
    const r = extractSignature(data, N, [0, 1, 2, 3, 4, 5, 6, 7], { positiveFraction: 0.4 });
    const norm = normaliseSignature(r.values);
    expect(r.peakDetector).toBe(5);
    expect(norm[5]).toBeCloseTo(1, 6);
    expect(norm[4]).toBeCloseTo(0.4, 2);
    expect(r.eventsUsed).toBeGreaterThan(0);
  });

  it('is not dragged off by a few very bright aggregates', () => {
    const D = 4;
    const N = 500;
    const data = new Float32Array(D * N);
    for (let e = 0; e < N; e++) {
      for (let d = 0; d < D; d++) data[d * N + e] = d === 1 ? 100 : 10;
    }
    // Five extreme outliers on a different detector.
    for (let e = 0; e < 5; e++) data[3 * N + e] = 1e6;
    const r = extractSignature(data, N, [0, 1, 2, 3], { positiveFraction: 0.5 });
    expect(r.peakDetector).toBe(1);
  });

  it('handles an empty sample without throwing', () => {
    const r = extractSignature(new Float32Array(0), 0, [0, 1]);
    expect(r.eventsUsed).toBe(0);
  });
});

/* ==========================================================================
   Gated extraction — the workflow every spectral vendor package uses. Both
   paths stay tested, because both now exist: the operator gates, or the
   percentile guesses and the operator adjusts.
   ========================================================================== */

/**
 * A single-stain control: `negatives` unstained events, then `positives`
 * stained ones peaking on `peak`. Positives last, so a subset of the tail is
 * exactly the positive population.
 */
function stainControl(D: number, negatives: number, positives: number, peak: number) {
  const N = negatives + positives;
  const data = new Float32Array(D * N);
  for (let e = 0; e < N; e++) {
    const stained = e >= negatives;
    for (let d = 0; d < D; d++) {
      const bright = d === peak ? 1000 : d === peak - 1 ? 300 : 20;
      data[d * N + e] = stained ? bright : 20;
    }
  }
  return { data, N, detectors: Array.from({ length: D }, (_, i) => i) };
}

describe('extractGatedSignature', () => {
  it('takes the median of exactly the gated events', () => {
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const gated = Uint32Array.from({ length: 200 }, (_, i) => 800 + i);

    const r = extractGatedSignature(data, N, detectors, gated);
    expect(r.eventsUsed).toBe(200);
    expect(r.peakDetector).toBe(4);
    expect(r.values[4]).toBeCloseTo(1, 6);
    expect(r.values[3]).toBeCloseTo(0.3, 6);
  });

  it('does not re-apply a percentile inside the gate', () => {
    // The whole difference from the automatic path. The operator already chose
    // the positives; selecting a bright fraction *within* them would bias the
    // signature toward the top of the population.
    const D = 4;
    const negatives = 500;
    const positives = 500;
    const N = negatives + positives;
    const data = new Float32Array(D * N);
    for (let e = 0; e < N; e++) {
      const stained = e >= negatives;
      // Positives span a 10x brightness range on the peak detector, so a
      // median and a top-20% median are far apart.
      const scale = stained ? 100 + ((e - negatives) / positives) * 900 : 1;
      for (let d = 0; d < D; d++) data[d * N + e] = d === 2 ? scale : scale * 0.1;
    }
    const gated = Uint32Array.from({ length: positives }, (_, i) => negatives + i);

    const gatedResult = extractGatedSignature(data, N, [0, 1, 2, 3], gated);
    const percentileResult = extractSignature(data, N, [0, 1, 2, 3], {
      positiveFraction: 0.2, eventSubset: gated,
    });

    // Shapes agree — the ratio between detectors is scale-free — but the
    // event counts do not, which is the observable difference.
    expect(gatedResult.eventsUsed).toBe(500);
    expect(percentileResult.eventsUsed).toBeLessThan(150);
    expect(gatedResult.values[2]).toBeCloseTo(1, 6);
  });

  it('agrees with the percentile path on a clean two-population control', () => {
    // When the gate captures exactly what the percentile would have, the two
    // must produce the same endmember — otherwise switching workflow would
    // silently change the matrix.
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const gated = Uint32Array.from({ length: 200 }, (_, i) => 800 + i);

    const g = extractGatedSignature(data, N, detectors, gated);
    const p = extractSignature(data, N, detectors, { positiveFraction: 0.2 });
    const pn = normaliseSignature(p.values);
    for (let d = 0; d < 6; d++) expect(g.values[d]).toBeCloseTo(pn[d]!, 6);
  });

  it('returns zeros for an empty gate rather than throwing', () => {
    const { data, N, detectors } = stainControl(4, 100, 100, 2);
    const r = extractGatedSignature(data, N, detectors, new Uint32Array(0));
    expect(r.eventsUsed).toBe(0);
    expect(Array.from(r.values)).toEqual([0, 0, 0, 0]);
  });
});

describe('autoGateBound — the quick-start seed', () => {
  it('finds the peak detector and a threshold above the negatives', () => {
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const b = autoGateBound(data, N, detectors)!;
    expect(b.peakDetector).toBe(4);
    expect(b.parameterIndex).toBe(4);
    expect(b.threshold).toBeGreaterThan(20);
    expect(b.threshold).toBeLessThanOrEqual(1000);
  });

  it('captures the same events the automatic path would have used', () => {
    // The reason the seed is worth having: it starts where the old silent
    // default was, so nothing changes until the user corrects it.
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const b = autoGateBound(data, N, detectors)!;
    expect(b.eventsAbove).toBeCloseTo(N * DEFAULT_POSITIVE_FRACTION, -1);
  });

  it('respects a general gate, seeding within it', () => {
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    // Only the first 400 events — all negatives — are "in the general gate".
    const within = Uint32Array.from({ length: 400 }, (_, i) => i);
    const b = autoGateBound(data, N, detectors, { eventSubset: within })!;
    expect(b.eventsAbove).toBeLessThanOrEqual(400);
  });

  it('returns null when there is nothing to gate', () => {
    expect(autoGateBound(new Float32Array(0), 0, [0, 1])).toBeNull();
    expect(autoGateBound(new Float32Array(4), 4, [])).toBeNull();
  });

  /*
     The baseline, and the defect it fixes.

     The absolute rule asks which detector is brightest, which is right for a
     bead and wrong for a stained cell: a PBMC is autofluorescent across the UV
     block far more brightly than a far-red dye is in its own channel. Measured
     on the real panel, the absolute rule put CCR7 APC-Fire 810, CD28 Alexa
     Fluor 700, LiveDead and NKG2A PerCP-Fire 806 all on **UV7-A** — four
     different dyes, none of which emits anywhere near it.
  */
  describe('against an unstained control', () => {
    /** Detector 0 carries heavy autofluorescence; detector 3 carries the dye. */
    function cellControl(stained: boolean) {
      const D = 5;
      const N = 500;
      const detectors = [0, 1, 2, 3, 4];
      const data = new Float32Array(D * N);
      for (let e = 0; e < N; e++) {
        // Autofluorescence: bright everywhere, brightest by far on detector 0.
        data[0 * N + e] = 180000 + (e % 40) * 400;
        data[1 * N + e] = 4000 + (e % 20) * 30;
        data[2 * N + e] = 3000 + (e % 20) * 25;
        data[3 * N + e] = 300 + (e % 10) * 8;
        data[4 * N + e] = 260 + (e % 10) * 7;
        // A fifth of the events carry the dye, on detector 3 — bright against
        // its own background and nowhere near detector 0's absolute level.
        if (stained && e % 5 === 0) data[3 * N + e] = 26000 + (e % 30) * 90;
      }
      return { data, N, detectors };
    }

    it('picks the autofluorescent channel without one — the reported defect', () => {
      const s = cellControl(true);
      const b = autoGateBound(s.data, s.N, s.detectors)!;
      expect(b.peakDetector).toBe(0);
    });

    it('picks the dye’s channel with one', () => {
      const un = cellControl(false);
      const s = cellControl(true);
      const baseline = detectorBrightness(un.data, un.N, un.detectors);
      const b = autoGateBound(s.data, s.N, s.detectors, { baseline })!;
      expect(b.peakDetector).toBe(3);
    });

    it('thresholds on whichever detector it chose, not on the brightest', () => {
      const un = cellControl(false);
      const s = cellControl(true);
      const baseline = detectorBrightness(un.data, un.N, un.detectors);
      const b = autoGateBound(s.data, s.N, s.detectors, { baseline })!;
      // Detector 3's own scale, three orders of magnitude below detector 0's.
      expect(b.threshold).toBeGreaterThan(1000);
      expect(b.threshold).toBeLessThan(30000);
    });

    it('is not fooled by a quiet detector with almost no background', () => {
      /*
         What the denominator's floor is for. A channel that is dark in both
         files has a background near zero, so an unfloored fold change divides a
         few counts of noise by almost nothing and wins. The floor is a quarter
         of the *median* background across the panel — comparable to a typical
         detector's own noise, and deliberately not a fraction of the brightest,
         which is a different number by orders of magnitude and re-creates the
         absolute rule.
      */
      const un = cellControl(false);
      const s = cellControl(true);
      // Detector 4 barely moves: 260 to 900, dark in both.
      for (let e = 0; e < s.N; e++) s.data[4 * s.N + e] = 900;
      const baseline = detectorBrightness(un.data, un.N, un.detectors);
      expect(autoGateBound(s.data, s.N, s.detectors, { baseline })!.peakDetector).toBe(3);
    });

    it('ignores a baseline of the wrong length rather than mixing channels up', () => {
      const s = cellControl(true);
      const b = autoGateBound(s.data, s.N, s.detectors, { baseline: new Float64Array(3) })!;
      expect(b.peakDetector).toBe(0);
    });
  });
});

describe('detectorBrightness', () => {
  it('reports one value per detector, on the peak-choice quantile', () => {
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const p = detectorBrightness(data, N, detectors);
    expect(p).toHaveLength(detectors.length);
    // Detector 4 carries the positives, so it is the brightest at the 98th.
    let best = 0;
    for (let d = 1; d < p.length; d++) if (p[d]! > p[best]!) best = d;
    expect(best).toBe(4);
  });

  it('honours an event subset', () => {
    const { data, N, detectors } = stainControl(6, 800, 200, 4);
    const negativesOnly = Uint32Array.from({ length: 400 }, (_, i) => i);
    const all = detectorBrightness(data, N, detectors);
    const sub = detectorBrightness(data, N, detectors, negativesOnly);
    expect(sub[4]!).toBeLessThan(all[4]!);
  });

  it('is empty for no detectors and no events', () => {
    expect(detectorBrightness(new Float32Array(0), 0, [])).toHaveLength(0);
    expect(detectorBrightness(new Float32Array(8), 4, [0, 1])).toEqual(new Float64Array(2));
  });
});

describe('extractAutofluorescence with a general gate', () => {
  it('measures only the gated events', () => {
    const D = 4;
    const N = 1000;
    const data = new Float32Array(D * N);
    // First half is debris an order of magnitude dimmer; second half is cells.
    for (let e = 0; e < N; e++) {
      const cell = e >= N / 2;
      for (let d = 0; d < D; d++) data[d * N + e] = cell ? (d === 1 ? 500 : 100) : 5;
    }
    const cells = Uint32Array.from({ length: N / 2 }, (_, i) => N / 2 + i);

    const gated = extractAutofluorescence(data, N, [0, 1, 2, 3], cells);
    expect(gated.eventsUsed).toBe(500);
    expect(gated.values[1]).toBeCloseTo(1, 6);
    expect(gated.values[0]).toBeCloseTo(0.2, 6);
  });

  it('differs from the ungated estimate when debris is present', () => {
    // An autofluorescence endmember measured over debris describes the debris,
    // which is the reason the unstained control gets the general gate too.
    const D = 3;
    const N = 600;
    const data = new Float32Array(D * N);
    for (let e = 0; e < N; e++) {
      const cell = e >= 300;
      for (let d = 0; d < D; d++) data[d * N + e] = cell ? (d === 2 ? 900 : 90) : (d === 0 ? 50 : 5);
    }
    const cells = Uint32Array.from({ length: 300 }, (_, i) => 300 + i);

    const all = extractAutofluorescence(data, N, [0, 1, 2]);
    const gated = extractAutofluorescence(data, N, [0, 1, 2], cells);
    expect(gated.values[2]).toBeCloseTo(1, 6);
    expect(Array.from(all.values)).not.toEqual(Array.from(gated.values));
  });

  it('falls back to zeros for an empty gate', () => {
    const r = extractAutofluorescence(new Float32Array(12), 4, [0, 1, 2], new Uint32Array(0));
    expect(r.eventsUsed).toBe(0);
  });
});

describe('normaliseSignature', () => {
  it('scales the peak to 1', () => {
    const out = normaliseSignature(Float64Array.from([2, 8, 4]));
    expect(Array.from(out)).toEqual([0.25, 1, 0.5]);
  });

  it('returns zeros for an all-zero or all-negative input rather than NaN', () => {
    for (const src of [[0, 0], [-1, -5]]) {
      for (const v of normaliseSignature(Float64Array.from(src))) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
