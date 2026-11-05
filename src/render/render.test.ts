import { describe, expect, it } from 'vitest';
import { PointIndex } from './PointIndex';
import { alphaForCount, gather, parseColor, subsampleIndices, MAX_RENDERED_POINTS } from './ScatterRenderer';
import { bin2d, densityToImage, RAMPS, sampleRamp } from './binning';
import { expandRamp, type Rgb } from './ramps';
import { relativeLuminance, VIRIDIS } from './viridis';
import { CIVIDIS } from './cividis';

describe('alphaForCount', () => {
  it('fades as the event count grows so dense plots stay readable', () => {
    expect(alphaForCount(100)).toBeGreaterThan(alphaForCount(10_000));
    expect(alphaForCount(10_000)).toBeGreaterThan(alphaForCount(1_000_000));
  });

  it('stays within a usable band', () => {
    for (const n of [1, 100, 15_333, 170_264, 5_000_000]) {
      const a = alphaForCount(n);
      expect(a).toBeGreaterThanOrEqual(0.12);
      expect(a).toBeLessThanOrEqual(0.85);
    }
  });

  it('keeps a large sample within reach of a small one', () => {
    // The two real test-file sizes must not differ so much that one plot looks
    // solid and the other looks empty.
    const small = alphaForCount(15_333);
    const large = alphaForCount(170_264);
    expect(large / small).toBeGreaterThan(0.5);
    expect(large).toBeGreaterThan(0.2);
  });

  it('handles a degenerate count', () => {
    expect(alphaForCount(0)).toBe(1);
  });
});

describe('subsampleIndices', () => {
  it('returns null when everything fits — the common case', () => {
    expect(subsampleIndices(170_264)).toBeNull();
    expect(subsampleIndices(MAX_RENDERED_POINTS)).toBeNull();
  });

  it('caps the point count when the sample is too large', () => {
    const idx = subsampleIndices(5_000_000, 1000);
    expect(idx).not.toBeNull();
    expect(idx!.length).toBe(1000);
  });

  it('keeps every index inside the source range', () => {
    const total = 3_000_000;
    const idx = subsampleIndices(total, 5000)!;
    for (const i of idx) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(total);
    }
  });

  it('spreads across the whole acquisition rather than taking a contiguous block', () => {
    const total = 1_000_000;
    const idx = subsampleIndices(total, 10_000)!;
    let min = Infinity, max = -Infinity;
    for (const i of idx) { if (i < min) min = i; if (i > max) max = i; }
    expect(min).toBeLessThan(total * 0.01);
    expect(max).toBeGreaterThan(total * 0.99);

    // Sampling must not collapse onto a few repeated indices.
    expect(new Set(idx).size).toBeGreaterThan(9000);
  });
});

describe('gather', () => {
  it('picks the requested indices', () => {
    const src = Float32Array.from([10, 20, 30, 40, 50]);
    const out = gather(src, Uint32Array.from([4, 0, 2]));
    expect(Array.from(out)).toEqual([50, 10, 30]);
  });
});

describe('parseColor', () => {
  it.each([
    ['#ffffff', [1, 1, 1]],
    ['#000000', [0, 0, 0]],
    ['#4cc9f0', [76 / 255, 201 / 255, 240 / 255]],
    ['#fff', [1, 1, 1]],
    ['rgb(255, 0, 128)', [1, 0, 128 / 255]],
  ])('parses %s', (css, expected) => {
    const got = parseColor(css);
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(expected[i]!, 5);
  });

  it('falls back to white on unparseable input rather than throwing', () => {
    expect(parseColor('not a colour')).toEqual([1, 1, 1]);
  });
});

describe('PointIndex', () => {
  /** Deterministic pseudo-random cloud. */
  function cloud(n: number): { x: Float32Array; y: Float32Array } {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) { x[i] = rnd() * 100; y[i] = rnd() * 100; }
    return { x, y };
  }

  /** Ground truth by exhaustive search, using the same normalised metric. */
  function bruteNearest(x: Float32Array, y: Float32Array, px: number, py: number, rx: number, ry: number): number {
    let best = -1, bestD2 = Infinity;
    for (let i = 0; i < x.length; i++) {
      const dx = (x[i]! - px) / rx;
      const dy = (y[i]! - py) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return bestD2 <= 1 ? best : -1;
  }

  it('finds the same nearest point as exhaustive search', () => {
    const { x, y } = cloud(20_000);
    const idx = new PointIndex(x, y, 0, 100, 0, 100);
    for (let t = 0; t < 40; t++) {
      const px = (t * 7.3) % 100;
      const py = (t * 11.9) % 100;
      const got = idx.nearest(px, py, 3, 3);
      const want = bruteNearest(x, y, px, py, 3, 3);
      if (want === -1) {
        expect(got).toBe(-1);
      } else {
        // Ties are possible; require the returned point to be equally close.
        const d = (i: number) => ((x[i]! - px) / 3) ** 2 + ((y[i]! - py) / 3) ** 2;
        expect(got).toBeGreaterThanOrEqual(0);
        expect(d(got)).toBeCloseTo(d(want), 5);
      }
    }
  });

  it('returns -1 when nothing is within the radius', () => {
    const x = Float32Array.from([0, 1, 2]);
    const y = Float32Array.from([0, 1, 2]);
    const idx = new PointIndex(x, y, 0, 100, 0, 100);
    expect(idx.nearest(90, 90, 1, 1)).toBe(-1);
  });

  it('indexes every point, including values outside the stated bounds', () => {
    const x = Float32Array.from([-50, 0, 50, 150]);
    const y = Float32Array.from([-50, 0, 50, 150]);
    const idx = new PointIndex(x, y, 0, 100, 0, 100);
    expect(idx.size).toBe(4);
    // The out-of-range point clamps into a border cell and is still findable.
    expect(idx.nearest(0, 0, 1, 1)).toBe(1);
  });

  it('survives NaN coordinates without corrupting the buckets', () => {
    const x = Float32Array.from([NaN, 10, 20]);
    const y = Float32Array.from([NaN, 10, 20]);
    const idx = new PointIndex(x, y, 0, 100, 0, 100);
    expect(idx.size).toBe(3);
    expect(idx.nearest(10, 10, 2, 2)).toBe(1);
  });

  it('handles an empty dataset', () => {
    const idx = new PointIndex(new Float32Array(0), new Float32Array(0), 0, 1, 0, 1);
    expect(idx.size).toBe(0);
    expect(idx.nearest(0.5, 0.5, 1, 1)).toBe(-1);
  });

  it('builds over a realistic event count quickly', () => {
    const { x, y } = cloud(170_264);
    const t0 = performance.now();
    const idx = new PointIndex(x, y, 0, 100, 0, 100);
    const build = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < 500; i++) idx.nearest((i * 3.1) % 100, (i * 5.7) % 100, 1, 1);
    const queries = performance.now() - t1;

    expect(idx.size).toBe(170_264);
    // Generous bounds — this is a regression guard, not a benchmark.
    expect(build).toBeLessThan(1500);
    expect(queries).toBeLessThan(1000);
  });
});

/* ==========================================================================
   Density colour ramps.

   A ramp that dips in lightness partway along reads as two populations where
   the data holds one, so monotonicity is a correctness property rather than a
   matter of taste — and it is the reason viridis is the default.
   ========================================================================== */

/** CIELAB L*, the axis viridis was actually designed to be uniform in. */
const lstar = (rgb: [number, number, number]): number => {
  const y = relativeLuminance(rgb);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

describe('viridis LUT', () => {
  it('holds the full 256 entries', () => {
    expect(VIRIDIS).toHaveLength(256);
    expect(RAMPS.viridis).toBe(VIRIDIS);
  });

  it('matches the canonical anchor colours', () => {
    // The three colours anyone can check against a published viridis swatch.
    expect(VIRIDIS[0]).toEqual([68, 1, 84]);      // #440154
    expect(VIRIDIS[128]).toEqual([33, 145, 140]); // #21918c
    expect(VIRIDIS[255]).toEqual([253, 231, 37]); // #fde725
  });

  it('stays inside the 8-bit channel range', () => {
    for (const [r, g, b] of VIRIDIS) {
      for (const c of [r, g, b]) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });

  it('never falls in lightness beyond 8-bit rounding', () => {
    // Two entries dip by ~3e-4 in relative luminance. That is the float LUT
    // quantised to sRGB bytes, not a real reversal, so the assertion is
    // non-decreasing within a tolerance rather than strictly increasing.
    let worstDrop = 0;
    for (let i = 0; i < VIRIDIS.length - 1; i++) {
      const drop = relativeLuminance(VIRIDIS[i]!) - relativeLuminance(VIRIDIS[i + 1]!);
      if (drop > worstDrop) worstDrop = drop;
    }
    expect(worstDrop).toBeLessThan(1e-3);
  });

  it('rises over every span wide enough to be visible', () => {
    // A genuine dip would persist across neighbours; quantisation noise cannot.
    for (let i = 0; i + 4 < VIRIDIS.length; i++) {
      expect(relativeLuminance(VIRIDIS[i + 4]!)).toBeGreaterThan(relativeLuminance(VIRIDIS[i]!));
    }
  });

  it('rises through the full lightness range', () => {
    expect(relativeLuminance(VIRIDIS[0]!)).toBeLessThan(0.05);
    expect(relativeLuminance(VIRIDIS[255]!)).toBeGreaterThan(0.7);
  });

  it('takes even steps in L*, which is what perceptual uniformity means', () => {
    const steps: number[] = [];
    for (let i = 0; i < VIRIDIS.length - 1; i++) steps.push(lstar(VIRIDIS[i + 1]!) - lstar(VIRIDIS[i]!));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    // No single step is more than ~2.2x the mean; over 255 steps that is flat.
    expect(Math.max(...steps)).toBeLessThan(mean * 2.5);
    expect(Math.min(...steps)).toBeGreaterThan(-0.05);
  });

  it('is measurably more uniform than the reference ramp beside it', () => {
    // Not a value judgement on Rainbow — it is *why both exist*. Viridis is the
    // ramp to reach for when the question is quantitative, because equal steps in
    // density are equal steps in appearance; rainbow is the one to reach for when
    // the question is "is that one population or two", where hue separation beats
    // uniformity.
    //
    // Both ramps are resampled to the same number of points before comparing.
    // Measuring viridis's own 255 steps against a ramp's few anchors would compare
    // 8-bit rounding noise on a 0.3 L* step against real structure on a 14 L* one.
    expect(stepSpread(VIRIDIS, 9)).toBeLessThan(stepSpread(RAMPS.rainbow!, 9));
    // Absolute, not only relative: ~0.22 against ~11 for Rainbow, which reverses.
    // The residual on viridis is 8-bit rounding on a ~9 L* step, not a real
    // deviation from uniformity. Cividis, the other reference ramp, measures
    // ~0.21 — as uniform, by design — so both are held to the same bound.
    expect(stepSpread(VIRIDIS, 9)).toBeLessThan(0.25);
    expect(stepSpread(RAMPS.cividis!, 9)).toBeLessThan(0.25);
  });
});

/** Relative spread of L* steps after resampling a ramp to `n` even points. */
function stepSpread(ramp: Array<[number, number, number]>, n: number): number {
  const points = Array.from({ length: n }, (_, i) => sampleRamp(ramp, i / (n - 1)));
  const steps: number[] = [];
  for (let i = 0; i < n - 1; i++) steps.push(lstar(points[i + 1]!) - lstar(points[i]!));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  return (Math.max(...steps) - Math.min(...steps)) / mean;
}

describe('RAMPS', () => {
  it('offers Viridis, Cividis and Rainbow, and nothing else', () => {
    // Abyss, Ember and Glacier were house designs and were removed on 2026-07-31;
    // they stay removed, and are listed here so a workspace carrying one is known
    // to fall back rather than render nothing.
    //
    // **Flame is removed, for the second time and permanently** (2026-08-03). It
    // was the default twice, on the strength of being what FCS Express opens
    // with, and it goes for the reason it went the first time: its bottom third
    // sits within a few units of this app's `#0a0c10` plot surface, which is
    // where the sparse periphery lands and where gating is done. Matching another
    // product's screen is worth something; seeing the events you are gating on is
    // worth more, and is the one of the two nothing else recovers.
    expect(Object.keys(RAMPS).sort()).toEqual(['cividis', 'rainbow', 'viridis']);
    for (const name of ['abyss', 'ember', 'glacier', 'flame']) {
      expect(RAMPS[name], name).toBeUndefined();
    }
  });

  it('keeps Rainbow’s floor clear of the plot surface', () => {
    // The measurement that decided the ramp. `--surface-plot` is #0a0c10;
    // rainbow's zero is #101f52 and flame's was #000000, so an isolated event in
    // the sparse periphery is a visible dark blue mark rather than background.
    const [r, g, b] = RAMPS.rainbow![0]!;
    const dist = Math.hypot(r - 0x0a, g - 0x0c, b - 0x10) / 255;
    expect(dist).toBeGreaterThan(0.12);
    // Flame's floor, for the comparison the removal rests on.
    expect(Math.hypot(0 - 0x0a, 0 - 0x0c, 0 - 0x10) / 255).toBeLessThan(0.1);
  });

  it('keeps Rainbow calmer than the saturated primaries it replaced', () => {
    // Item 8. The ramp still runs blue → cyan → green → yellow → red; what changed
    // is that no anchor sits on a gamut corner any more. The saturated form
    // (#0000ff … #ffff00 … #ff0000) left a dark gate outline and a cursor readout
    // nothing to sit against on a dense core.
    //
    // Stated against what it replaced rather than against a round number, because
    // "calmer" is a comparison and a threshold would be an arbitrary stand-in for
    // one. `SATURATED` is the ramp that shipped last pass, verbatim.
    const SATURATED = expandRamp([
      { at: 0.00, rgb: [0, 0, 128] },
      { at: 0.10, rgb: [0, 0, 255] },
      { at: 0.32, rgb: [0, 255, 255] },
      { at: 0.52, rgb: [0, 255, 0] },
      { at: 0.72, rgb: [255, 255, 0] },
      { at: 0.88, rgb: [255, 128, 0] },
      { at: 1.00, rgb: [255, 0, 0] },
    ]);
    // Chroma, as the crudest useful measure: how far a colour is from grey.
    const chroma = ([r, g, b]: Rgb) => Math.max(r, g, b) - Math.min(r, g, b);
    const rainbow = RAMPS.rainbow!;
    for (const [i, entry] of rainbow.entries()) {
      expect(chroma(entry), `entry ${i}`).toBeLessThan(chroma(SATURATED[i]!));
    }
    // Nothing reaches the top of any channel, so a dark line always has somewhere
    // to be dark against.
    for (const [i, [r, g, b]] of rainbow.entries()) {
      expect(Math.max(r, g, b), `entry ${i}`).toBeLessThan(240);
    }
  });

  it('keeps Rainbow recognisably a rainbow', () => {
    // The calmer anchors must not have turned it into something else. The hue
    // sequence is the ramp's identity, so it is asserted directly: blue-dominant
    // at the bottom, green-dominant through the middle, red-dominant at the top.
    const dominant = (t: number) => {
      const [r, g, b] = sampleRamp(RAMPS.rainbow!, t);
      return b >= r && b >= g ? 'b' : g >= r ? 'g' : 'r';
    };
    expect(dominant(0)).toBe('b');
    expect(dominant(0.2)).toBe('b');
    expect(dominant(0.5)).toBe('g');
    expect(dominant(0.75)).toBe('r');
    expect(dominant(1)).toBe('r');
  });

  it('records where Rainbow reverses, rather than exempting it', () => {
    // Rainbow is a spectral ramp and is **not** monotonic in lightness: yellow at
    // 0.72 is the lightest colour on it and red at 1.0 is much darker, so the top
    // of the ramp descends. That is the standard criticism of every rainbow
    // colormap and the whole reason viridis exists.
    //
    // Asserted as a fact about the ramp rather than skipped. It is offered —
    // though no longer the default — because hue separation through the middle of
    // the range is what finding the edge of a population needs, and because an
    // analyst reproducing a published figure has to be able to. This test is where
    // a future "fix" to it has to come and argue.
    const rainbow = RAMPS.rainbow!;
    let drops = 0;
    for (let i = 0; i < rainbow.length - 1; i++) {
      if (relativeLuminance(rainbow[i + 1]!) < relativeLuminance(rainbow[i]!)) drops++;
    }
    expect(drops).toBeGreaterThan(20);
    // And the reversal is in the top third, where yellow gives way to red.
    expect(relativeLuminance(rainbow[255]!)).toBeLessThan(relativeLuminance(rainbow[184]!));
    // Toning the ramp down did not accidentally fix this: it is the hue sequence
    // that causes it, not the saturation.
  });

  it('starts every ramp dark enough to read a sparse cell against the plot', () => {
    // The bottom of the ramp is where the sparsest events land, and a bottom that
    // is already bright leaves nowhere for a dense core to go.
    for (const [name, ramp] of Object.entries(RAMPS)) {
      expect(relativeLuminance(ramp[0]!), name).toBeLessThan(0.06);
    }
  });

  it('falls back to viridis for an unknown ramp name', () => {
    // densityToImage builds an ImageData, which node has no notion of. The
    // shim is enough for a shape the renderer only ever writes bytes into.
    const g = globalThis as { ImageData?: unknown };
    const had = g.ImageData;
    if (!had) {
      g.ImageData = class {
        data: Uint8ClampedArray;
        constructor(readonly width: number, readonly height: number) {
          this.data = new Uint8ClampedArray(width * height * 4);
        }
      };
    }
    try {
      const h = bin2d(Float32Array.of(0.5), Float32Array.of(0.5), 0, 1, 0, 1, 2, 2);
      expect(Array.from(densityToImage(h, 'nonexistent', 'linear').data))
        .toEqual(Array.from(densityToImage(h, 'viridis', 'linear').data));
    } finally {
      if (!had) delete g.ImageData;
    }
  });

  it('samples the ramp endpoints exactly', () => {
    expect(sampleRamp(VIRIDIS, 0)).toEqual([68, 1, 84]);
    expect(sampleRamp(VIRIDIS, 1)).toEqual([253, 231, 37]);
    // Out-of-range input clamps rather than extrapolating off the ramp.
    expect(sampleRamp(VIRIDIS, -3)).toEqual([68, 1, 84]);
    expect(sampleRamp(VIRIDIS, 9)).toEqual([253, 231, 37]);
  });
});


describe('cividis LUT', () => {
  it('holds matplotlib’s 256 entries, anchors included', () => {
    expect(CIVIDIS).toHaveLength(256);
    expect(RAMPS.cividis).toBe(CIVIDIS);
    expect(CIVIDIS[0]).toEqual([0, 34, 78]);       // #00224e
    expect(CIVIDIS[128]).toEqual([125, 124, 120]); // #7d7c78
    expect(CIVIDIS[255]).toEqual([254, 232, 56]);  // #fee838
  });

  it('rises in lightness from end to end', () => {
    let worstDrop = 0;
    for (let i = 0; i < CIVIDIS.length - 1; i++) {
      worstDrop = Math.max(worstDrop, relativeLuminance(CIVIDIS[i]!) - relativeLuminance(CIVIDIS[i + 1]!));
    }
    expect(worstDrop).toBeLessThan(1e-3);
  });
});
