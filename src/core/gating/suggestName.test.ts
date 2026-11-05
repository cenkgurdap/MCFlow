import { describe, expect, it } from 'vitest';
import { isOneDimensional, markerOf, nameCollision, suggestGateName, unique } from './suggestName';
import type { Gate } from './types';

/* -------------------------------------------------------------------------
   The name a gate offers when it is finalised.

   The suggestion has to be good enough that pressing Enter without typing gives
   a name worth keeping — otherwise the prompt is a speed bump rather than the
   point at which populations get named.
   ------------------------------------------------------------------------- */

function rect(name: string): Gate {
  return {
    id: name, name, parentId: null, colorIndex: 0,
    kind: 'rectangle', xParam: 0, yParam: 1, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
  };
}

describe('markerOf', () => {
  it('takes the marker and drops the fluorophore', () => {
    // `$PnS` reads "<marker> <dye>". Naming a population after the dye would be
    // wrong: two panels can put CD4 on different fluorophores and it is CD4
    // either way.
    expect(markerOf('CD4 FITC')).toBe('CD4');
    expect(markerOf('CD19 AF647')).toBe('CD19');
  });

  it('handles the other separators labs use', () => {
    expect(markerOf('CD8-PerCP')).toBe('CD8');
    expect(markerOf('CD14_APC')).toBe('CD14');
    expect(markerOf('CD3/BV421')).toBe('CD3');
  });

  it('refuses a bare fluorophore — that names the detector, not the population', () => {
    expect(markerOf('FITC')).toBeNull();
    expect(markerOf('APC-Cy7')).toBeNull();
    expect(markerOf('Zombie NIR')).toBeNull();
  });

  it('returns null for the empty stain every file in this project has', () => {
    expect(markerOf('')).toBeNull();
    expect(markerOf('   ')).toBeNull();
    expect(markerOf(undefined)).toBeNull();
  });

  it('rejects a one-character token as noise', () => {
    expect(markerOf('A 488')).toBeNull();
  });
});

describe('suggestGateName — no marker information', () => {
  it('falls back to P1, the FlowJo convention', () => {
    // The path every file in this project takes: `$PnS` is empty in all sixteen.
    expect(suggestGateName({ kind: 'rectangle', existing: [] })).toBe('P1');
  });

  it('counts up past names already taken', () => {
    expect(suggestGateName({ kind: 'polygon', existing: [rect('P1'), rect('P2')] })).toBe('P3');
  });

  it('fills a gap rather than always appending', () => {
    expect(suggestGateName({ kind: 'polygon', existing: [rect('P1'), rect('P3')] })).toBe('P2');
  });

  it('ignores unrelated names', () => {
    expect(suggestGateName({ kind: 'ellipse', existing: [rect('Lymphocytes'), rect('Singlets')] })).toBe('P1');
  });
});

describe('suggestGateName — with markers', () => {
  it('a range gate on a marker channel suggests the positive population', () => {
    expect(suggestGateName({ kind: 'range', existing: [], xStain: 'CD3 FITC' })).toBe('CD3');
  });

  it('a two-axis gate needs both markers to claim anything', () => {
    // A region in two dimensions is not described by one marker: "CD3+" would
    // be a claim about only one of the two axes the user drew across.
    expect(suggestGateName({ kind: 'rectangle', existing: [], xStain: 'CD3 FITC' })).toBe('P1');
  });

  it('names a double positive when both axes carry markers', () => {
    expect(suggestGateName({
      kind: 'rectangle', existing: [], xStain: 'CD4 PE', yStain: 'CD8 APC',
    })).toBe('CD4+CD8+');
  });

  it('falls back to P-numbering when the marker name is already used', () => {
    expect(suggestGateName({
      kind: 'range', existing: [rect('CD3')], xStain: 'CD3 FITC',
    })).toBe('P1');
  });

  it('ignores markers on a quadrant, which names its own four', () => {
    expect(suggestGateName({
      kind: 'quadrant', existing: [], xStain: 'CD4 PE', yStain: 'CD8 APC',
    })).toBe('P1');
  });
});

describe('helpers', () => {
  it('knows which kinds bound a single parameter', () => {
    expect(isOneDimensional('range')).toBe(true);
    expect(isOneDimensional('rectangle')).toBe(false);
    expect(isOneDimensional('polygon')).toBe(false);
  });

  it('unique counts from 1', () => {
    expect(unique('P', new Set())).toBe('P1');
    expect(unique('Q', new Set(['Q1', 'Q2']))).toBe('Q3');
  });
});

/* -------------------------------------------------------------------------
   nameCollision — one population, one name

   The naming prompt has refused a duplicate since 2026-08-12; the gate tree's
   inline rename went straight to the store and never asked, so the same
   workspace could be talked out of the rule by using the other affordance. Both
   call this now.
   ------------------------------------------------------------------------- */

describe('nameCollision', () => {
  const gates = [
    { id: 'a', name: 'Lymphocytes' },
    { id: 'b', name: 'CD4' },
  ] as Gate[];

  it('finds the population already carrying the name', () => {
    expect(nameCollision(gates, 'CD4')?.id).toBe('b');
  });

  it('is trimmed and case-insensitive, matching the prompt', () => {
    expect(nameCollision(gates, ' cd4 ')?.id).toBe('b');
    expect(nameCollision(gates, 'LYMPHOCYTES')?.id).toBe('a');
  });

  it('answers nothing for a name nobody holds', () => {
    expect(nameCollision(gates, 'CD8')).toBeNull();
  });

  it('does not let a gate collide with itself, so an unchanged rename commits', () => {
    expect(nameCollision(gates, 'CD4', 'b')).toBeNull();
    // …but it still collides with the *other* one.
    expect(nameCollision(gates, 'Lymphocytes', 'b')?.id).toBe('a');
  });

  it('treats an empty name as no collision — the caller substitutes a default', () => {
    expect(nameCollision(gates, '   ')).toBeNull();
  });
});
