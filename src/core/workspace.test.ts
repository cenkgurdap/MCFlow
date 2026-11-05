import { describe, expect, it } from 'vitest';
import type { RangeGate, RectangleGate } from './gating/types';
import { parseWorkspace, repairGateBounds, serialiseWorkspace, type WorkspaceFile } from './workspace';

/* ==========================================================================
   2026-10-28 — a one-sided gate's open end survives a save.

   The report: *"I ran the Biophysics pipeline, saved, reopened — Cells works,
   Live shows 0."* Live runs to +Infinity, JSON wrote it as null, and a null
   bound compares as 0. Every workspace saved before this fix carries the null,
   so the repair on read matters as much as the serialiser.
   ========================================================================== */

const live: RangeGate = {
  id: 'live', name: 'Live', parentId: null, colorIndex: 0, kind: 'range', xParam: 71, min: 0.1, max: Infinity,
};
const dead: RangeGate = { ...live, id: 'dead', name: 'Dead', min: -Infinity, max: 0.1 };
const seeded: RectangleGate = {
  id: 'pos', name: 'Positive', parentId: null, colorIndex: 1, kind: 'rectangle', xParam: 20, yParam: 18,
  xMin: 3.2, xMax: Infinity, yMin: -Infinity, yMax: 5,
};

function doc(gates: unknown[], overrides: Record<string, Record<string, unknown>> = {}): WorkspaceFile {
  return {
    version: 5, name: 't', savedAt: '', application: 'MCFlow', samples: [], groups: [],
    gating: { shared: gates as RangeGate[], divergent: {}, overrides: overrides as never },
    derivedParameters: [], spectral: { spectra: [], method: 'wls' },
    plot: { panels: [], columns: 1 },
  };
}

describe('saving a one-sided gate', () => {
  it('reads back with its infinite ends', () => {
    const back = parseWorkspace(serialiseWorkspace(doc([live, dead, seeded])));
    expect(back.gating.shared).toEqual([live, dead, seeded]);
  });

  it('keeps the per-sample boundaries infinite too', () => {
    const back = parseWorkspace(serialiseWorkspace(doc([live], { live: { s1: live } })));
    expect(back.gating.overrides!.live!.s1).toEqual(live);
  });
});

describe('a workspace written before the fix', () => {
  it('has its null bounds read as the open ends they were', () => {
    // Exactly what JSON.stringify made of these gates in every earlier build.
    const legacy = JSON.stringify(doc([live, dead, seeded], { live: { s1: live } }));
    expect(legacy).toContain('"max":null');
    const back = parseWorkspace(legacy);
    expect(back.gating.shared).toEqual([live, dead, seeded]);
    expect(back.gating.overrides!.live!.s1).toEqual(live);
  });

  it('leaves a finite gate exactly as it was', () => {
    const closed: RangeGate = { ...live, max: 0.9 };
    expect(repairGateBounds(closed)).toBe(closed);
  });
});
