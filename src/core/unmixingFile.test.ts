import { describe, expect, it } from 'vitest';
import type { ParsedFcs } from './fcs/types';
import {
  normaliseSignature, similarityMatrix,
  unmix, type ReferenceSpectrum,
} from './spectral';
import {
  checkDetectorCompatibility, COMP_FILE_EXTENSION, extensionFor, matrixFilters,
  parseUnmixingMatrix, serialiseUnmixingMatrix,
  summarise, toReferenceSpectra, UNMIX_FILE_EXTENSION, UNMIX_FILE_KIND,
  UNMIX_FILE_VERSION, UnmixingFileError,
  type UnmixingMatrixFile,
} from './unmixingFile';

/* ==========================================================================
   Fixtures
   ========================================================================== */

function gaussian(D: number, centre: number, width: number): Float64Array {
  const v = new Float64Array(D);
  for (let d = 0; d < D; d++) v[d] = Math.exp(-((d - centre) ** 2) / (2 * width * width));
  return normaliseSignature(v);
}

function spectrum(id: string, values: Float64Array, isAuto = false): ReferenceSpectrum {
  return {
    id, label: id, values, isAutofluorescence: isAuto,
    sourceSampleId: null, eventCount: 1000, source: 'gated',
  };
}

/** A minimal but complete file, built the way `captureUnmixingMatrix` builds one. */
function makeFile(overrides: Partial<UnmixingMatrixFile> = {}): UnmixingMatrixFile {
  const D = 8;
  const spectra = [
    spectrum('a', gaussian(D, 1, 1)),
    spectrum('b', gaussian(D, 4, 1)),
    spectrum('af', gaussian(D, 6, 2), true),
  ];
  const names = Array.from({ length: D }, (_, i) => `B${i + 1}-A`);
  const instrument = { cytometer: 'Aurora', cytometerSerial: 'SN0001', software: 'SpectroFlo 3.3.0' };
  const controls = [
    { label: 'a', fileName: 'a.fcs', role: 'stain' as const, gateName: 'a +', eventsUsed: 900 },
    { label: 'b', fileName: 'b.fcs', role: 'stain' as const, gateName: 'b +', eventsUsed: 800 },
    { label: 'Unstained', fileName: 'un.fcs', role: 'unstained' as const, gateName: null, eventsUsed: 1000 },
  ];
  const sim = similarityMatrix(spectra);

  return {
    kind: UNMIX_FILE_KIND,
    version: UNMIX_FILE_VERSION,
    application: 'MCFlow',
    name: 'Test panel',
    savedAt: '2026-07-26T10:00:00.000Z',
    summary: summarise({ name: 'Test panel', spectra, detectorCount: D, instrument, controls, computedAt: null }),
    instrument,
    detectors: { count: D, names, indices: names.map((_, i) => i + 1) },
    spectra: spectra.map((s) => ({
      id: s.id, label: s.label, values: Array.from(s.values),
      isAutofluorescence: s.isAutofluorescence, eventCount: s.eventCount, source: s.source,
    })),
    autofluorescence: {
      id: 'af', label: 'af', values: Array.from(spectra[2]!.values),
      isAutofluorescence: true, eventCount: 1000, source: 'gated',
    },
    similarity: { size: spectra.length, values: Array.from(sim) },
    method: 'ols',
    weights: null,
    controls,
    ...overrides,
  };
}

/* ==========================================================================
   Round-trip
   ========================================================================== */

/*
   2026-08-11, Item 17 — `.unmixing`, and nothing else.

   A deliberate reversal of the 2026-08-08 rename, and unlike that one it drops
   the compatibility. Asserted by name so that reintroducing a legacy extension
   fails a test rather than passing quietly — the same rule the removed
   colour-level fields are held to.
*/
describe('the file extension', () => {
  it('is `unmixing` for a spectral panel and `compensation` for a conventional one', () => {
    expect(UNMIX_FILE_EXTENSION).toBe('unmixing');
    expect(COMP_FILE_EXTENSION).toBe('compensation');
    expect(extensionFor('unmixing')).toBe('unmixing');
    expect(extensionFor('compensation')).toBe('compensation');
  });

  it('offers both in the open dialog, the caller’s own kind first', () => {
    // Ordering rather than excluding: the two are one format, so a compensation
    // panel that could not see a `.unmixing` would refuse every square matrix
    // saved before 2026-08-29 on the strength of its name.
    const named = (m: 'unmixing' | 'compensation') => matrixFilters(m).filter((f) => f.name !== 'All files');
    expect(named('unmixing').map((f) => f.extensions[0])).toEqual(['unmixing', 'compensation']);
    expect(named('compensation').map((f) => f.extensions[0])).toEqual(['compensation', 'unmixing']);
    // `json` was there so a `.fcunmix.json` stayed visible. It is gone with the
    // read support it existed for.
    expect(matrixFilters().flatMap((f) => f.extensions)).not.toContain('json');
  });

  it('identifies a file from the inside, so the format itself never moved', () => {
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile()));
    expect(back.kind).toBe(UNMIX_FILE_KIND);
  });

  it('carries which panel built it, and survives a file that does not say', () => {
    // The whole reason `model` exists: a loaded matrix has to arrive knowing
    // whether its parameters are tagged *Comp* or *Unmixed*.
    const comp = parseUnmixingMatrix(serialiseUnmixingMatrix({ ...makeFile(), model: 'compensation' }));
    expect(comp.model).toBe('compensation');

    // Absent stays absent rather than defaulting here — the caller knows the
    // path and `modelFromPath` is a better guess than this function can make.
    // `makeFile()` writes no `model`, which is a file from before the field.
    const plain = makeFile();
    expect(parseUnmixingMatrix(serialiseUnmixingMatrix(plain)).model).toBeUndefined();

    // And a junk value is not passed through as one.
    expect(parseUnmixingMatrix(JSON.stringify({ ...plain, model: 'spillover' })).model).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('survives serialise → parse unchanged', () => {
    const original = makeFile();
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(original));

    expect(back.kind).toBe(UNMIX_FILE_KIND);
    expect(back.version).toBe(UNMIX_FILE_VERSION);
    expect(back.name).toBe('Test panel');
    expect(back.savedAt).toBe(original.savedAt);
    expect(back.method).toBe('ols');
    expect(back.detectors.count).toBe(8);
    expect(back.detectors.names).toEqual(original.detectors.names);
    expect(back.spectra).toHaveLength(3);
  });

  it('preserves every endmember value to full float precision', () => {
    const original = makeFile();
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(original));
    for (let i = 0; i < original.spectra.length; i++) {
      expect(back.spectra[i]!.values).toEqual(original.spectra[i]!.values);
    }
  });

  it('carries the instrument identity, so a matrix says which cytometer produced it', () => {
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile()));
    expect(back.instrument.cytometer).toBe('Aurora');
    expect(back.instrument.cytometerSerial).toBe('SN0001');
    expect(back.instrument.software).toBe('SpectroFlo 3.3.0');
  });

  it('keeps the autofluorescence endmember addressable on its own', () => {
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile()));
    expect(back.autofluorescence).not.toBeNull();
    expect(back.autofluorescence!.isAutofluorescence).toBe(true);
    // It is a pointer into the panel, not a second copy that could drift.
    const inPanel = back.spectra.find((s) => s.isAutofluorescence);
    expect(back.autofluorescence!.values).toEqual(inPanel!.values);
  });

  it('keeps the similarity matrix, so QC needs no recomputation on load', () => {
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile()));
    expect(back.similarity.size).toBe(3);
    expect(back.similarity.values).toHaveLength(9);
    // Diagonal is 1 by construction.
    for (let i = 0; i < 3; i++) expect(back.similarity.values[i * 3 + i]).toBeCloseTo(1, 12);
  });

  it('records which files were used as controls, and how they were gated', () => {
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile()));
    expect(back.controls).toHaveLength(3);
    expect(back.controls.map((c) => c.fileName)).toEqual(['a.fcs', 'b.fcs', 'un.fcs']);
    expect(back.controls[0]!.gateName).toBe('a +');
    expect(back.controls[2]!.role).toBe('unstained');
  });

  it('writes a human-readable summary naming the panel, instrument and files', () => {
    const f = makeFile();
    expect(f.summary).toContain('Test panel');
    expect(f.summary).toContain('2 fluorophores');
    expect(f.summary).toContain('autofluorescence');
    expect(f.summary).toContain('8 detectors');
    expect(f.summary).toContain('Aurora SN0001');
    expect(f.summary).toContain('a.fcs');
  });

  it('restores spectra that unmix identically to the originals', () => {
    const original = makeFile();
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(original));
    const restored = toReferenceSpectra(back);

    // A mixture with known abundances must come back the same through the
    // reloaded matrix as through the one that produced it — the round-trip has
    // to preserve the *result*, not merely the bytes.
    const D = 8;
    const truth = [[1, 0, 0.2], [0, 1, 0.2], [0.5, 0.5, 0.1]];
    const N = truth.length;
    const data = new Float32Array(D * N);
    for (let e = 0; e < N; e++) {
      for (let d = 0; d < D; d++) {
        let y = 0;
        for (let f = 0; f < restored.length; f++) y += truth[e]![f]! * restored[f]!.values[d]!;
        data[d * N + e] = y;
      }
    }
    const parsed = {
      metadata: { eventCount: N, parameterCount: D } as never,
      data,
      warnings: [],
    } as ParsedFcs;

    const result = unmix(parsed, {
      detectorIndices: Array.from({ length: D }, (_, i) => i),
      detectorNames: back.detectors.names,
      spectra: restored,
    });

    for (let e = 0; e < N; e++) {
      for (let f = 0; f < restored.length; f++) {
        expect(result.data[f * N + e]).toBeCloseTo(truth[e]![f]!, 6);
      }
    }
  });
});

/* ==========================================================================
   Validation
   ========================================================================== */

describe('validation', () => {
  it('rejects text that is not JSON', () => {
    expect(() => parseUnmixingMatrix('not json at all')).toThrow(UnmixingFileError);
  });

  it('rejects a workspace file by name, rather than calling it corrupt', () => {
    // The realistic mistake is picking the wrong file, and a workspace is also
    // valid JSON with a `version` — so the error has to name what it found.
    const workspace = JSON.stringify({ version: 3, name: 'ws', samples: [], plot: {} });
    try {
      parseUnmixingMatrix(workspace);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnmixingFileError);
      expect((e as UnmixingFileError).hint).toContain('workspace');
    }
  });

  it('refuses a file written by a newer format version', () => {
    const future = serialiseUnmixingMatrix(makeFile({ version: UNMIX_FILE_VERSION + 1 }));
    expect(() => parseUnmixingMatrix(future)).toThrow(/newer version/i);
  });

  it('refuses a file with no spectra', () => {
    expect(() => parseUnmixingMatrix(serialiseUnmixingMatrix(makeFile({ spectra: [] }))))
      .toThrow(/no reference spectra/i);
  });

  it('refuses a file whose spectra disagree with its own detector count', () => {
    const f = makeFile();
    f.spectra[1]!.values = f.spectra[1]!.values.slice(0, 5);
    expect(() => parseUnmixingMatrix(serialiseUnmixingMatrix(f))).toThrow(/covers 5 detectors but the file records 8/);
  });

  it('drops a similarity block that does not match its declared size', () => {
    const f = makeFile({ similarity: { size: 3, values: [1, 2, 3] } });
    const back = parseUnmixingMatrix(serialiseUnmixingMatrix(f));
    // Better to have none than a wrong one — the QC view recomputes from spectra.
    expect(back.similarity.size).toBe(0);
  });
});

/* ==========================================================================
   Detector compatibility — the check that stops a wrong matrix being applied
   ========================================================================== */

describe('detector compatibility on load', () => {
  const file = makeFile();
  const names = file.detectors.names;

  it('accepts an identical detector configuration', () => {
    const r = checkDetectorCompatibility(file, [...names]);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('8 detectors match');
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('rejects a different detector count and says how many each side has', () => {
    const r = checkDetectorCompatibility(file, names.slice(0, 6));
    expect(r.ok).toBe(false);
    expect(r.fileDetectorCount).toBe(8);
    expect(r.sampleDetectorCount).toBe(6);
    expect(r.message).toContain('built for 8 detectors but the sample has 6');
  });

  it('names the detectors that differ rather than reporting a bare mismatch', () => {
    const r = checkDetectorCompatibility(file, names.slice(0, 6));
    expect(r.missing).toEqual(['B7-A', 'B8-A']);
    expect(r.message).toContain('B7-A');
    expect(r.message).toContain('B8-A');
  });

  it('rejects the same count with different detector names', () => {
    const swapped = [...names];
    swapped[3] = 'YG1-A';
    const r = checkDetectorCompatibility(file, swapped);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['B4-A']);
    expect(r.extra).toEqual(['YG1-A']);
    expect(r.message).toContain('not the same set');
  });

  it('rejects the same detectors in a different order', () => {
    // Matrix columns are positional: applying a reordered matrix would pair
    // every signature with the wrong detector and produce plausible garbage.
    const reordered = [...names];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    const r = checkDetectorCompatibility(file, reordered);
    expect(r.ok).toBe(false);
    expect(r.reordered.length).toBe(2);
    expect(r.message).toContain('different order');
    expect(r.message).toContain('position 1');
  });

  it('truncates a long list of differing detectors instead of printing all 64', () => {
    const r = checkDetectorCompatibility(
      makeFile({ detectors: { count: 20, names: Array.from({ length: 20 }, (_, i) => `X${i}`), indices: [] } }),
      [],
    );
    expect(r.message).toContain('and 14 more');
    expect(r.message.length).toBeLessThan(400);
  });
});
