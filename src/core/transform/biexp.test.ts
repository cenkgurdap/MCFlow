import { describe, expect, it } from 'vitest';
import {
  autoSpec, createTransform, estimateWidth, IMPLEMENTED_TRANSFORMS,
  solveD, widthBasisToW,
} from './index';
import { initLogicle, logicleForward, logicleInverse } from './logicle';
import { hyperlogForward, hyperlogInverse, initHyperlog } from './hyperlog';

const T = 262144;
const M = 4.5;

/* ==========================================================================
   Logicle — checked against the reference algorithm's defining properties
   ========================================================================== */

describe('solveD (the logicle condition)', () => {
  it('returns b when w is zero, where the scale degenerates', () => {
    const b = 4.5 * Math.LN10;
    expect(solveD(b, 0)).toBe(b);
  });

  it('satisfies 2·(ln d − ln b) + w·(b + d) = 0', () => {
    const b = 4.5 * Math.LN10;
    for (const w of [0.01, 0.05, 0.1, 0.2, 0.3, 0.45]) {
      const d = solveD(b, w);
      const residual = 2 * (Math.log(d) - Math.log(b)) + w * (b + d);
      expect(Math.abs(residual)).toBeLessThan(1e-9);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(b);
    }
  });
});

describe('logicle', () => {
  const p = initLogicle(T, 0.5, M, 0);

  it('maps data zero to x1 and full scale to 1', () => {
    expect(logicleForward(p, 0)).toBeCloseTo(p.x1, 12);
    expect(logicleForward(p, T)).toBeCloseTo(1, 9);
    expect(logicleInverse(p, 1)).toBeCloseTo(T, 3);
    expect(logicleInverse(p, p.x1)).toBeCloseTo(0, 9);
  });

  it('round-trips across positives, zero and negatives', () => {
    const values = [
      -50_000, -10_000, -1000, -612.2, -100, -10, -1, -0.1,
      0, 0.1, 1, 10, 100, 1000, 10_000, 100_000, 262_143,
    ];
    for (const v of values) {
      const back = logicleInverse(p, logicleForward(p, v));
      // Relative tolerance for large magnitudes, absolute near zero.
      const tol = Math.max(1e-6, Math.abs(v) * 1e-6);
      expect(Math.abs(back - v)).toBeLessThan(tol);
    }
  });

  it('is strictly monotonic increasing, so gates cannot reorder events', () => {
    let prev = -Infinity;
    for (let v = -60_000; v <= 262_144; v += 331) {
      const d = logicleForward(p, v);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('is symmetric about data zero', () => {
    for (const v of [1, 37, 1000, 25_000]) {
      const up = logicleForward(p, v) - p.x1;
      const down = p.x1 - logicleForward(p, -v);
      expect(up).toBeCloseTo(down, 10);
    }
  });

  it('stays finite and converged across the whole legal parameter band', () => {
    for (const W of [0, 0.25, 0.5, 1, 1.5, 2.25]) {
      for (const A of [0, 0.5, 1]) {
        const q = initLogicle(T, W, M, Math.min(A, M - 2 * W));
        for (const v of [-100_000, -1, 0, 1, 100_000, T]) {
          const d = logicleForward(q, v);
          expect(Number.isFinite(d)).toBe(true);
          expect(Number.isFinite(logicleInverse(q, d))).toBe(true);
        }
      }
    }
  });

  it('widens the linear region as W grows', () => {
    // A larger width basis should push a given small negative further from the
    // bottom of the axis — that is the whole point of the parameter.
    const narrow = initLogicle(T, 0.25, M, 0);
    const wide = initLogicle(T, 1.5, M, 0);
    expect(logicleForward(wide, -100)).toBeGreaterThan(logicleForward(narrow, -100));
  });
});

/* ==========================================================================
   Hyperlog
   ========================================================================== */

describe('hyperlog', () => {
  const p = initHyperlog(T, 0.5, M, 0);

  it('maps data zero to x1 and full scale to 1', () => {
    expect(hyperlogInverse(p, p.x1)).toBeCloseTo(0, 8);
    expect(hyperlogForward(p, 0)).toBeCloseTo(p.x1, 10);
    expect(hyperlogInverse(p, 1)).toBeCloseTo(T, 3);
  });

  it('round-trips across positives, zero and negatives', () => {
    for (const v of [-20_000, -1000, -612.2, -10, 0, 10, 1000, 100_000, 262_143]) {
      const back = hyperlogInverse(p, hyperlogForward(p, v));
      expect(Math.abs(back - v)).toBeLessThan(Math.max(1e-5, Math.abs(v) * 1e-6));
    }
  });

  it('is strictly monotonic increasing', () => {
    let prev = -Infinity;
    for (let v = -40_000; v <= 262_144; v += 419) {
      const d = hyperlogForward(p, v);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('converges for values beyond full scale rather than hanging', () => {
    for (const v of [T * 2, T * 100, -T * 10]) {
      const d = hyperlogForward(p, v);
      expect(Number.isFinite(d)).toBe(true);
    }
  });
});

/* ==========================================================================
   Arcsinh
   ========================================================================== */

describe('arcsinh', () => {
  const t = createTransform({ kind: 'asinh', range: T, cofactor: 1000 });

  it('is exactly asinh(v / cofactor)', () => {
    for (const v of [-5000, -1, 0, 1, 5000]) {
      expect(t.forward(v)).toBeCloseTo(Math.asinh(v / 1000), 12);
    }
  });

  it('round-trips exactly and is odd about zero', () => {
    for (const v of [-100_000, -1234.5, 0, 1234.5, 100_000]) {
      expect(t.inverse(t.forward(v))).toBeCloseTo(v, 6);
      expect(t.forward(-v)).toBeCloseTo(-t.forward(v), 12);
    }
  });

  it('expands the region near zero as the cofactor falls', () => {
    const wide = createTransform({ kind: 'asinh', range: T, cofactor: 10_000 });
    const tight = createTransform({ kind: 'asinh', range: T, cofactor: 10 });
    expect(Math.abs(tight.forward(100))).toBeGreaterThan(Math.abs(wide.forward(100)));
  });
});

/* ==========================================================================
   Shared contract — every transform must satisfy these
   ========================================================================== */

describe.each(IMPLEMENTED_TRANSFORMS)('contract: %s', (kind) => {
  const t = createTransform(autoSpec(kind, T));

  it('round-trips within tolerance over its own display domain', () => {
    const [lo, hi] = t.displayDomain;
    for (let i = 0; i <= 20; i++) {
      const d = lo + ((hi - lo) * i) / 20;
      const v = t.inverse(d);
      if (!Number.isFinite(v)) continue;
      const back = t.forward(v);
      expect(Math.abs(back - d)).toBeLessThan((hi - lo) * 1e-4);
    }
  });

  it('is monotonic non-decreasing over its display domain', () => {
    const [lo, hi] = t.displayDomain;
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = t.inverse(lo + ((hi - lo) * i) / 200);
      const d = t.forward(v);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
  });

  it('produces at least one labelled tick and no NaN positions', () => {
    const ticks = t.ticks(6);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.some((k) => k.label !== '')).toBe(true);
    for (const k of ticks) {
      expect(Number.isFinite(k.display)).toBe(true);
      expect(Number.isFinite(k.value)).toBe(true);
    }
  });

  it('emits ticks in ascending display order', () => {
    const ticks = t.ticks(6);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.display).toBeGreaterThanOrEqual(ticks[i - 1]!.display);
    }
  });

  it('never thins away the zero label on a signed axis', () => {
    if (kind === 'linear' || kind === 'log') return; // no signed zero to protect
    const zero = t.ticks(6).find((k) => k.value === 0);
    expect(zero).toBeDefined();
    expect(zero!.label).toBe('0');
    expect(zero!.minor).toBeFalsy();
  });

  it('keeps labelled ticks at least a label-width apart', () => {
    if (kind === 'linear' || kind === 'log') return;
    const [lo, hi] = t.displayDomain;
    const labelled = t.ticks(6).filter((k) => k.label && !k.minor);
    for (let i = 1; i < labelled.length; i++) {
      const gap = labelled[i]!.display - labelled[i - 1]!.display;
      expect(gap).toBeGreaterThanOrEqual((hi - lo) * 0.05);
    }
  });
});

/* ==========================================================================
   Parameter estimation
   ========================================================================== */

describe('widthBasisToW', () => {
  it('matches the flowCore conversion', () => {
    // W = (M − log10(T / |r|)) / 2
    expect(widthBasisToW(-10, 262144, 4.5)).toBeCloseTo((4.5 - Math.log10(26214.4)) / 2, 10);
    expect(widthBasisToW(-1000, 262144, 4.5)).toBeCloseTo((4.5 - Math.log10(262.144)) / 2, 10);
  });

  it('clamps into the legal band instead of producing a broken scale', () => {
    // A basis larger than T would give a negative W.
    expect(widthBasisToW(-1e9, 262144, 4.5)).toBeLessThanOrEqual(4.5 / 2);
    expect(widthBasisToW(-0.0001, 262144, 4.5)).toBeGreaterThanOrEqual(0);
    expect(widthBasisToW(0, 262144, 4.5)).toBe(0.5);
  });
});

describe('estimateWidth', () => {
  it('falls back to a narrow default when there are no negatives', () => {
    const v = Float32Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(estimateWidth(v, T, M)).toBe(0.5);
  });

  it('returns a legal W for a realistically negative channel', () => {
    const v = new Float32Array(5000);
    for (let i = 0; i < v.length; i++) v[i] = i < 1000 ? -600 + i * 0.5 : i;
    const W = estimateWidth(v, T, M);
    expect(W).toBeGreaterThan(0);
    expect(W).toBeLessThanOrEqual(M / 2);
  });
});
