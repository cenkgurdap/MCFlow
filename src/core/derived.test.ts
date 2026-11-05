import { describe, expect, it } from 'vitest';
import {
  derivedOrder, evaluateExpression, parseExpression, validateDefinition,
  type DerivedParameterDef,
} from './derived';

/* ==========================================================================
   Derived parameters — FCS Express-style parameter math.

   The tests that matter are lexical rather than arithmetic. Detector names
   contain the minus sign, so `FITC-A - APC-A` has two equally valid readings
   and only one of them is right; everything else here is ordinary precedence.
   ========================================================================== */

const AURORA = ['Time', 'FSC-A', 'SSC-A', 'FITC-A', 'APC-A', 'B1-A', 'B14-A', 'SSC-B-A', 'PerCP-Cy5.5-A'];

function refs(src: string, names = AURORA): string[] {
  const r = parseExpression(src, names);
  if (!r.ok) throw new Error(`expected a parse, got: ${r.error}`);
  return r.references;
}

function evaluate(src: string, columns: Record<string, number[]>, names = AURORA): number[] {
  const r = parseExpression(src, names);
  if (!r.ok) throw new Error(r.error);
  const n = Object.values(columns)[0]!.length;
  const map = new Map(Object.entries(columns).map(([k, v]) => [k, Float32Array.from(v)]));
  return Array.from(evaluateExpression(r.ast, map, n));
}

describe('tokenising names that contain the operator', () => {
  it('reads FITC-A - APC-A as two parameters and one subtraction', () => {
    // The whole reason the tokeniser is not context-free. Splitting on `-` gives
    // FITC, A, APC, A — four "parameters", none of which exist.
    expect(refs('FITC-A - APC-A')).toEqual(['FITC-A', 'APC-A']);
    expect(evaluate('FITC-A - APC-A', { 'FITC-A': [10, 4], 'APC-A': [3, 9] })).toEqual([7, -5]);
  });

  it('prefers the longest matching name', () => {
    // `SSC-B-A` must not be read as `SSC-A`-ish fragments, and `PerCP-Cy5.5-A`
    // must not lose its tail. Longest-first ordering is what decides it.
    expect(refs('SSC-B-A + 1')).toEqual(['SSC-B-A']);
    expect(refs('PerCP-Cy5.5-A * 2')).toEqual(['PerCP-Cy5.5-A']);
  });

  it('reads a name with no spaces around the operator', () => {
    expect(refs('FITC-A-APC-A')).toEqual(['FITC-A', 'APC-A']);
  });

  it('accepts an explicit bracketed reference', () => {
    expect(refs('[FITC-A] / [APC-A]')).toEqual(['FITC-A', 'APC-A']);
  });

  it('reports an unclosed bracket rather than guessing', () => {
    const r = parseExpression('[FITC-A / APC-A', AURORA);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Unclosed/);
  });

  it('matches case-insensitively but canonicalises to the declared spelling', () => {
    expect(refs('fitc-a + apc-a')).toEqual(['FITC-A', 'APC-A']);
  });
});

describe('arithmetic', () => {
  it('honours precedence and brackets', () => {
    expect(evaluate('FITC-A + APC-A * 2', { 'FITC-A': [1], 'APC-A': [3] })).toEqual([7]);
    expect(evaluate('(FITC-A + APC-A) * 2', { 'FITC-A': [1], 'APC-A': [3] })).toEqual([8]);
  });

  it('is left-associative, so a - b - c is (a - b) - c', () => {
    expect(evaluate('FITC-A - APC-A - B1-A', { 'FITC-A': [10], 'APC-A': [3], 'B1-A': [2] })).toEqual([5]);
  });

  it('computes the ratio parameter from the brief', () => {
    const out = evaluate('(FITC-A - APC-A) / (FITC-A + APC-A)', {
      'FITC-A': [100, 0, 50],
      'APC-A': [0, 100, 50],
    });
    expect(out).toEqual([1, -1, 0]);
  });

  it('applies unary minus', () => {
    expect(evaluate('-FITC-A + 5', { 'FITC-A': [3] })).toEqual([2]);
  });

  it('leaves a zero denominator non-finite rather than substituting a value', () => {
    // A ratio whose denominator is zero for some events is a real property of
    // the data. Writing 0 there would drop those events into the middle of the
    // distribution and quietly inside whatever gate sits at the origin.
    const out = evaluate('FITC-A / APC-A', { 'FITC-A': [1, 1], 'APC-A': [2, 0] });
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(Number.isFinite(out[1]!)).toBe(false);
  });
});

describe('validation', () => {
  it('names an unknown parameter instead of failing silently', () => {
    const r = parseExpression('FITX-A + APC-A', AURORA);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('FITX-A');
  });

  it('counts unbalanced brackets in both directions', () => {
    const open = parseExpression('(FITC-A + APC-A', AURORA);
    const close = parseExpression('FITC-A + APC-A)', AURORA);
    expect(!open.ok && open.error).toMatch(/unclosed/i);
    expect(!close.ok && close.error).toMatch(/unmatched/i);
  });

  it('refuses division by a literal zero', () => {
    const r = parseExpression('FITC-A / 0', AURORA);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/divides by zero/i);
  });

  it('refuses an expression that references nothing', () => {
    const r = parseExpression('2 + 2', AURORA);
    expect(r.ok).toBe(false);
  });

  it('refuses a trailing operator', () => {
    expect(parseExpression('FITC-A +', AURORA).ok).toBe(false);
  });
});

describe('validateDefinition', () => {
  const def = (id: string, name: string, expression: string): DerivedParameterDef => ({ id, name, expression });

  it('accepts a well-formed definition and reports what it reads', () => {
    const v = validateDefinition(def('d1', 'Ratio', '(FITC-A - APC-A) / (FITC-A + APC-A)'), AURORA, []);
    expect(v.ok).toBe(true);
    expect(v.references).toEqual(['FITC-A', 'APC-A']);
  });

  it('refuses a name that collides with a real detector', () => {
    const v = validateDefinition(def('d1', 'FITC-A', 'APC-A * 2'), AURORA, []);
    expect(v.ok).toBe(false);
    expect(v.error).toContain('already a detector');
  });

  it('refuses a name that collides with another derived parameter', () => {
    const existing = def('d1', 'Ratio', 'FITC-A / APC-A');
    const v = validateDefinition(def('d2', 'ratio', 'APC-A / FITC-A'), AURORA, [existing]);
    expect(v.ok).toBe(false);
  });

  it('refuses a name containing an operator, which would be unreadable', () => {
    const v = validateDefinition(def('d1', 'A-B ratio (x)', 'FITC-A * 2'), AURORA, []);
    expect(v.ok).toBe(false);
  });

  it('lets a derived parameter reference another one', () => {
    const first = def('d1', 'Sum', 'FITC-A + APC-A');
    const v = validateDefinition(def('d2', 'Half', 'Sum / 2'), AURORA, [first]);
    expect(v.ok).toBe(true);
    expect(v.references).toEqual(['Sum']);
  });

  it('catches a cycle between derived parameters', () => {
    // Only possible because a derived parameter may reference another, so it is
    // checked here rather than discovered as a stack overflow at evaluation.
    const a = def('d1', 'A', 'B + 1');
    const v = validateDefinition(def('d2', 'B', 'A + 1'), AURORA, [a]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/referencing itself/);
  });

  it('catches a definition that references itself directly', () => {
    const v = validateDefinition(def('d1', 'Loop', 'Loop + 1'), AURORA, []);
    expect(v.ok).toBe(false);
  });
});

describe('derivedOrder', () => {
  it('puts a dependency before the parameter that reads it', () => {
    const defs: DerivedParameterDef[] = [
      { id: 'd2', name: 'Half', expression: 'Sum / 2' },
      { id: 'd1', name: 'Sum', expression: 'FITC-A + APC-A' },
    ];
    expect(derivedOrder(defs, AURORA).map((d) => d.name)).toEqual(['Sum', 'Half']);
  });

  it('drops a definition in a cycle rather than looping', () => {
    const defs: DerivedParameterDef[] = [
      { id: 'a', name: 'A', expression: 'B + 1' },
      { id: 'b', name: 'B', expression: 'A + 1' },
    ];
    expect(derivedOrder(defs, AURORA)).toHaveLength(0);
  });

  it('drops a definition that does not parse', () => {
    const defs: DerivedParameterDef[] = [
      { id: 'a', name: 'Good', expression: 'FITC-A * 2' },
      { id: 'b', name: 'Bad', expression: 'NOPE-A * 2' },
    ];
    expect(derivedOrder(defs, AURORA).map((d) => d.name)).toEqual(['Good']);
  });
});
