import { describe, expect, it } from 'vitest';
import {
  AUTO_SMOOTHING_EVENTS, AUTO_SMOOTHING_SPAN, autoSmoothing, buildLevelTable, LEVEL_QUANTA, logWarp, quantum,
  smooth2d, SMOOTHING_MAX, SMOOTHING_MIN, smoothKernel, smoothSigma, summariseLevels,
  type ColorLevelSpec,
} from './colorLevels';
import { bin2d, renderDensity, smooth, smoothHistogram2d } from './binning';

// ImageData is a DOM type; vitest runs in node, so provide a minimal stand-in.
if (typeof globalThis.ImageData === 'undefined') {
  class ImageDataPolyfill {
    data: Uint8ClampedArray;
    constructor(public width: number, public height: number) {
      this.data = new Uint8ClampedArray(width * height * 4);
    }
  }
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataPolyfill;
}

const PERCENTILE: ColorLevelSpec = { style: 'percentile', scaling: 'linear' };
const LINEAR: ColorLevelSpec = { style: 'linear', scaling: 'linear' };

/** Position along the ramp for a cell value, through a built table. */
const posOf = (t: ReturnType<typeof buildLevelTable>, v: number) =>
  t.positions[quantum(v)]!;

/**
 * A histogram shaped like a real density plot: a small dense core and a large
 * sparse halo. This is the distribution every claim below is about, because it is
 * the one flow cytometry actually produces — and the one a linear ramp fails on.
 */
function coreAndHalo() {
  const xs: number[] = [];
  const ys: number[] = [];
  // 400 halo cells, one event each.
  for (let i = 0; i < 400; i++) { xs.push(20 + (i % 20)); ys.push(20 + Math.floor(i / 20)); }
  // One core cell with 600 events — over half the sample in a single cell.
  for (let i = 0; i < 600; i++) { xs.push(50); ys.push(50); }
  return bin2d(Float32Array.from(xs), Float32Array.from(ys), 0, 100, 0, 100, 100, 100);
}

describe('percentile levels', () => {
  const h = coreAndHalo();

  it('puts the sparse halo at the dark end and the core at the top', () => {
    const t = buildLevelTable(summariseLevels(h.bins), PERCENTILE, 'linear');
    // The 400 one-event cells hold 400 of 1000 events, so they sit at 0.4 — and the
    // core, holding the other 600, reaches the very top.
    expect(posOf(t, 1)).toBeCloseTo(0.4, 2);
    expect(posOf(t, 600)).toBeCloseTo(1, 5);
  });

  it('always reaches the top of the ramp, whatever the counts are', () => {
    // The property percentile styling exists to deliver. A linear mapping only
    // reaches the top when the densest cell happens to be at the maximum, which is
    // trivially true — but the *rest* of the ramp then goes unused, which is the
    // half that matters and is checked in the next case.
    for (const peak of [3, 40, 4000]) {
      const xs = [1, 2, 3, ...new Array(peak).fill(50)];
      const ys = [1, 2, 3, ...new Array(peak).fill(50)];
      const hh = bin2d(Float32Array.from(xs), Float32Array.from(ys), 0, 100, 0, 100, 100, 100);
      const t = buildLevelTable(summariseLevels(hh.bins), PERCENTILE, 'linear');
      expect(posOf(t, peak), `peak ${peak}`).toBeCloseTo(1, 5);
    }
  });

  it('uses the middle of the ramp where a linear mapping abandons it', () => {
    // This is the concrete failure percentile fixes. Under a linear mapping the
    // halo — four hundred cells, 40% of the sample — is at 1/600 of the ramp, i.e.
    // indistinguishable from empty. Under percentile it is at 0.4.
    const lin = buildLevelTable(summariseLevels(h.bins), LINEAR, 'linear');
    const pct = buildLevelTable(summariseLevels(h.bins), PERCENTILE, 'linear');
    expect(posOf(lin, 1)).toBeLessThan(0.01);
    expect(posOf(pct, 1)).toBeGreaterThan(0.3);
  });

  it('is invariant to the density scaling, which is the point of it', () => {
    // Stated in `colorLevels.ts` and worth pinning down, because it is the one
    // surprising consequence of the design: any monotonic rescaling of the counts
    // relabels the value axis without moving an event from one cell to another, so
    // the cumulative event fraction at a given cell cannot change. `rank` remains
    // the default *scaling* and takes effect the moment Style is Linear.
    const scales = ['linear', 'log', 'sqrt', 'rank'] as const;
    const at1 = scales.map((s) => posOf(buildLevelTable(summariseLevels(h.bins), PERCENTILE, s), 1));
    for (const p of at1) expect(p).toBeCloseTo(at1[0]!, 6);

    // And under Linear style it very much is not invariant.
    const linAt1 = scales.map((s) => posOf(buildLevelTable(summariseLevels(h.bins), LINEAR, s), 1));
    expect(new Set(linAt1.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
  });

  it('is monotonic in the cell value', () => {
    // Whatever else it does, a denser cell must never come out lower on the ramp
    // than a sparser one.
    const t = buildLevelTable(summariseLevels(h.bins), PERCENTILE, 'rank');
    let prev = -1;
    for (let k = 0; k < LEVEL_QUANTA; k++) {
      expect(t.positions[k]!).toBeGreaterThanOrEqual(prev);
      prev = t.positions[k]!;
    }
  });

  it('survives a histogram with nothing in it', () => {
    const empty = bin2d(new Float32Array(0), new Float32Array(0), 0, 1, 0, 1, 4, 4);
    const t = buildLevelTable(summariseLevels(empty.bins), PERCENTILE, 'rank');
    for (let k = 0; k < LEVEL_QUANTA; k++) expect(Number.isFinite(t.positions[k]!)).toBe(true);
  });
});

describe('logWarp', () => {
  it('holds both ends and lifts the low end', () => {
    expect(logWarp(0)).toBe(0);
    expect(logWarp(1)).toBeCloseTo(1, 10);
    // A tenth of the range gets nearly a third of the ramp.
    expect(logWarp(0.1)).toBeCloseTo(0.2788, 3);
  });

  it('never lowers a position and never leaves 0…1', () => {
    for (let i = 0; i <= 20; i++) {
      const u = i / 20;
      expect(logWarp(u)).toBeGreaterThanOrEqual(u - 1e-9);
      expect(logWarp(u)).toBeLessThanOrEqual(1);
    }
  });

  it('is applied on top of the style, not instead of it', () => {
    const h = coreAndHalo();
    const plain = buildLevelTable(summariseLevels(h.bins), PERCENTILE, 'linear');
    const logged = buildLevelTable(summariseLevels(h.bins), { ...PERCENTILE, scaling: 'log' }, 'linear');
    expect(posOf(logged, 1)).toBeGreaterThan(posOf(plain, 1));
    // Both still top out, so log scaling redistributes the ramp rather than
    // truncating it.
    expect(posOf(logged, 600)).toBeCloseTo(1, 5);
  });
});

describe('every occupied cell reaches the ramp', () => {
  const h = coreAndHalo();

  /** Distinct opaque colours in a rendered bitmap. */
  function colours(img: ImageData): Set<string> {
    const seen = new Set<string>();
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3]! === 0) continue;
      seen.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
    }
    return seen;
  }

  it('paints one cell per occupied bin and nothing else', () => {
    let occupied = 0;
    for (let i = 0; i < h.bins.length; i++) if (h.bins[i]! > 0) occupied++;
    const img = renderDensity(h, { ramp: 'rainbow', scale: 'linear', levels: PERCENTILE });
    let opaque = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) opaque++;
    expect(opaque).toBe(occupied);
  });

  it('gives the sparsest cells a colour, not the flat band that used to be there', () => {
    // The removed "outlier" branch painted every minimum-value cell one fixed
    // colour, bypassing the level table. On a sparse plot that was most of the
    // occupied area, which is why the colour-scaling control appeared to do
    // nothing. Now the halo is coloured by the same mapping as everything else.
    const img = renderDensity(h, { ramp: 'rainbow', scale: 'linear', levels: PERCENTILE });
    const haloColour = (() => {
      for (let i = 0; i < h.bins.length; i++) {
        if (h.bins[i] !== 1) continue;
        const bx = i % h.width;
        const by = (i - bx) / h.width;
        const o = ((h.height - 1 - by) * h.width + bx) * 4;
        return `${img.data[o]},${img.data[o + 1]},${img.data[o + 2]}`;
      }
      return null;
    })();
    // A one-event cell is 40% of the way up the ramp under percentile styling, so
    // it is emphatically not the ramp's zero.
    expect(haloColour).not.toBe('16,31,82');
    expect(colours(img).size).toBeGreaterThan(1);
  });

  it('colour scaling changes the colour of *every* occupied cell', () => {
    // Item 4, as a property rather than a screenshot. Under the old outlier band
    // this held for the core and failed for the periphery.
    const lin = renderDensity(h, { ramp: 'rainbow', scale: 'rank', levels: PERCENTILE });
    const log = renderDensity(h, {
      ramp: 'rainbow', scale: 'rank', levels: { ...PERCENTILE, scaling: 'log' },
    });
    let occupied = 0;
    let changed = 0;
    for (let i = 0; i < lin.data.length; i += 4) {
      if (lin.data[i + 3]! === 0) continue;
      occupied++;
      // The densest cell is at 1.0 under both, by construction — a log warp holds
      // both ends. Everything below it must move.
      if (lin.data[i] !== log.data[i] || lin.data[i + 1] !== log.data[i + 1]
        || lin.data[i + 2] !== log.data[i + 2]) changed++;
    }
    expect(occupied).toBeGreaterThan(100);
    expect(changed).toBe(occupied - 1);
  });

  it('quantises an occupied cell to at least index 1, so it is never the background', () => {
    // `quantum` ceils rather than rounds. With rounding, a cell below half a
    // quantum — a single event smoothed across a wide kernel — collapsed into the
    // same slot as an empty cell and was painted at the ramp's absolute zero.
    expect(quantum(1e-6)).toBeGreaterThanOrEqual(1);
    expect(quantum(1e-30)).toBe(1);
    expect(quantum(0)).toBe(0);
  });
});

describe('smooth2d', () => {
  it('is a copy for a window of 1', () => {
    const src = Uint32Array.from([0, 5, 0, 0]);
    expect(Array.from(smooth2d(src, 2, 2, 1))).toEqual([0, 5, 0, 0]);
  });

  it('spreads one event over its neighbours and lowers the peak', () => {
    // What makes a 1024×1024 grid a density estimate rather than a scatter plot.
    const grid = new Uint32Array(25);
    grid[12] = 9; // centre of a 5×5
    const s = smooth2d(grid, 5, 5, 3);
    expect(s[12]!).toBeLessThan(9);
    expect(s[7]!).toBeGreaterThan(0);
    expect(s[11]!).toBeGreaterThan(0);
    // Nothing two cells away — a 3-window reaches exactly one cell.
    expect(s[2]!).toBe(0);
  });

  it('changes on every single step, not every other one', () => {
    // The 2026-08-01 bug, as a property, and kept because it is a weaker claim
    // than the proportionality block below rather than the same one: a kernel
    // could scale evenly on average and still repeat itself at one pair of
    // values. `Math.floor(window / 2)` gave 2 and 3 the same radius, and 4 and 5,
    // so half the stepper's positions were dead.
    const grid = new Float32Array(21 * 21);
    grid[10 * 21 + 10] = 100;
    let prev: Float32Array | null = null;
    for (let w = 1; w <= 8; w++) {
      const s = smooth2d(grid, 21, 21, w);
      if (prev) {
        let differing = 0;
        for (let i = 0; i < s.length; i++) if (Math.abs(s[i]! - prev[i]!) > 1e-9) differing++;
        expect(differing, `window ${w} vs ${w - 1}`).toBeGreaterThan(0);
      }
      prev = s;
    }
  });

  it('is symmetric at even windows, which an integer box blur cannot be', () => {
    const grid = new Float32Array(9 * 9);
    grid[4 * 9 + 4] = 81;
    const s = smooth2d(grid, 9, 9, 4);
    // The fractional end taps sit at the same distance on both sides.
    expect(s[4 * 9 + 2]!).toBeCloseTo(s[4 * 9 + 6]!, 10);
    expect(s[2 * 9 + 4]!).toBeCloseTo(s[6 * 9 + 4]!, 10);
  });

  it('leaves a flat field flat, at every window', () => {
    // Whatever the kernel is, it is normalised, so smoothing a constant field
    // cannot change it. The cheapest possible check that a kernel change did not
    // introduce a gain error.
    const flat = new Float32Array(25).fill(7);
    for (let w = 1; w <= 21; w++) {
      for (const v of smooth2d(flat, 5, 5, w)) expect(v, `window ${w}`).toBeCloseTo(7, 6);
    }
  });

  /* ------------------------------------------------------------------------
     Item 8 — the blur scales *proportionally* with the value, not merely
     monotonically.

     The 2026-08-01 fix made every step distinct, which was the bug reported then
     and is not the bug reported now. Distinct is not proportional: the kernel it
     produced had sigma 0, 0.707, 0.816, 1.225, 1.414, 1.780, 2.000 — so 3→4
     changed nearly four times as much as 2→3, and the control moved in a limp.
     These are the assertions that would have caught it.
     ------------------------------------------------------------------------ */
  describe('the smoothing scale', () => {
    /** The variance the returned kernel actually has, from its own weights. */
    const varianceOf = (window: number) => {
      const { half, tap } = smoothKernel(window);
      let num = 0;
      let den = 0;
      for (let i = -half; i <= half; i++) { num += i * i; den += 1; }
      num += 2 * tap * (half + 1) * (half + 1);
      den += 2 * tap;
      return den > 0 ? num / den : 0;
    };

    it('promises a blur that is exactly linear in the stepper value', () => {
      // The specification, stated as arithmetic rather than as a shape.
      expect(smoothSigma(1)).toBe(0);
      for (let w = 2; w <= 21; w++) {
        expect(smoothSigma(w) - smoothSigma(w - 1), `step ${w - 1}→${w}`)
          .toBeCloseTo(1 / Math.sqrt(6), 12);
      }
    });

    it('builds a kernel that delivers exactly that blur, at all 21 values', () => {
      // The half-width and the tap weight are solved from the target variance, so
      // this is the assertion that the solution is right rather than approximately
      // right. Any drift here is a visible sawtooth in the control.
      for (let w = 1; w <= 21; w++) {
        expect(Math.sqrt(varianceOf(w)), `window ${w}`).toBeCloseTo(smoothSigma(w), 9);
      }
    });

    it('keeps the tap inside [0, 1), so the kernel is never end-heavy', () => {
      // A tap above 1 would put more weight on the outermost cell than on the
      // centre — a ring rather than a blur. The choice of `half` is what bounds
      // it, and this is where that reasoning is checked rather than asserted.
      for (let w = 1; w <= 21; w++) {
        const { half, tap } = smoothKernel(w);
        expect(half, `window ${w}`).toBeGreaterThanOrEqual(0);
        expect(tap, `window ${w}`).toBeGreaterThanOrEqual(0);
        expect(tap, `window ${w}`).toBeLessThan(1);
      }
    });

    it('leaves the default, smoothing 3, byte-identical to the plain 3-cell box', () => {
      // Why the constant is √6 and not something rounder. The default plot has
      // been smoothed at 3 since 1024×1024 shipped; a fix to how the *steps* are
      // sized should not silently restyle every density plot in every saved
      // workspace.
      expect(smoothKernel(3)).toEqual({ half: 1, tap: 0 });
    });

    it('grows the blurred footprint by an even amount at every step', () => {
      // The user-facing claim, measured on the picture rather than on the kernel:
      // spread one event on a wide grid, and the second moment of what comes out
      // has to climb in even steps. This is the same quantity the eye reads as
      // "how blurred", which is why the old kernel felt wrong even though every
      // step changed *something*.
      const N = 81;
      const spread = (w: number) => {
        const grid = new Float32Array(N * N);
        grid[40 * N + 40] = 1000;
        const s = smooth2d(grid, N, N, w);
        let total = 0;
        let moment = 0;
        for (let y = 0; y < N; y++) {
          for (let x = 0; x < N; x++) {
            const v = s[y * N + x]!;
            if (v <= 0) continue;
            total += v;
            moment += v * ((x - 40) ** 2 + (y - 40) ** 2);
          }
        }
        // Root-mean-square distance from the centre, over both axes.
        return total > 0 ? Math.sqrt(moment / total) : 0;
      };

      const steps: number[] = [];
      let prev = spread(1);
      for (let w = 2; w <= 8; w++) {
        const now = spread(w);
        expect(now, `window ${w} must blur more than ${w - 1}`).toBeGreaterThan(prev);
        steps.push(now - prev);
        prev = now;
      }
      // Every step within 6% of the mean step. Under the old kernel the same
      // measurement produced steps differing by a factor of nearly four, so the
      // tolerance is wide enough to be about proportionality rather than about
      // floating point, and narrow enough that the old kernel fails it outright.
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      for (const [i, s] of steps.entries()) {
        expect(Math.abs(s - mean) / mean, `step ${i + 2}`).toBeLessThan(0.06);
      }
    });

    it('scales the histogram path by the same rule', () => {
      // `smooth()` has now been fixed twice for the same class of bug, both times
      // because the density map was what got reported. One control, one kernel.
      const line = new Float64Array(101);
      line[50] = 1000;
      const spread = (w: number) => {
        const s = smooth(line, w);
        let total = 0;
        let moment = 0;
        for (let i = 0; i < s.length; i++) {
          if (s[i]! <= 0) continue;
          total += s[i]!;
          moment += s[i]! * (i - 50) ** 2;
        }
        return total > 0 ? Math.sqrt(moment / total) : 0;
      };
      const steps: number[] = [];
      let prev = spread(1);
      for (let w = 2; w <= 8; w++) { const now = spread(w); steps.push(now - prev); prev = now; }
      const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
      for (const [i, s] of steps.entries()) {
        expect(Math.abs(s - mean) / mean, `step ${i + 2}`).toBeLessThan(0.06);
      }
    });
  });

  it('does not darken the edges, because gating pushes populations against axes', () => {
    // Normalising by the window's nominal size rather than by the cells actually
    // read would make a population sitting on an axis dimmer than the same
    // population in the middle of the plot, which is a lie about the data at
    // exactly the place a gate is being drawn.
    const flat = new Uint32Array(25).fill(4);
    const s = smooth2d(flat, 5, 5, 3);
    for (let i = 0; i < 25; i++) expect(s[i]!).toBeCloseTo(4, 5);
  });

  it('conserves the total signal in the interior, at every window', () => {
    // A 21×21 grid, so even the widest window here keeps every recipient cell's
    // own kernel fully inside the grid. Conservation is an interior property: at
    // the border the pass normalises by the cells it could actually read, which is
    // the edge-brightness behaviour asserted above and is deliberately not
    // signal-conserving.
    for (const w of [3, 4, 5, 6, 7]) {
      const grid = new Uint32Array(21 * 21);
      grid[10 * 21 + 10] = 8;
      const s = smooth2d(grid, 21, 21, w);
      let sum = 0;
      for (let i = 0; i < s.length; i++) sum += s[i]!;
      expect(sum, `window ${w}`).toBeCloseTo(8, 4);
    }
  });

  it('lowers maxCount on the histogram it smooths, so the levels renormalise', () => {
    const h = coreAndHalo();
    const s = smoothHistogram2d(h, 3);
    expect(s.maxCount).toBeLessThan(h.maxCount);
    // The events that were binned are still the events that were binned.
    expect(s.totalCount).toBe(h.totalCount);
    expect(s.bins).toBeInstanceOf(Float32Array);
  });
});

describe('rank scaling, after the rewrite', () => {
  it('still puts the sparsest occupied level at 0 and the densest at 1', () => {
    // The Map-over-distinct-counts implementation could not survive a million
    // fractional cells; this is the quantised table that replaced it, and it has to
    // agree with the old one at the two ends that were observable.
    const h = coreAndHalo();
    const t = buildLevelTable(summariseLevels(h.bins), LINEAR, 'rank');
    const rank = (v: number) => posOf(t, v);
    expect(rank(1)).toBeCloseTo(0, 6);
    expect(rank(h.maxCount)).toBeCloseTo(1, 6);
    expect(rank(0)).toBe(0);
  });

  it('gives a lone dense cell as much range as a thousand sparse ones', () => {
    // What distinguishes `rank` from percentile: it equalises over *distinct
    // values*, so three occupied levels split the range into thirds regardless of
    // how many cells or events sit at each.
    const xs = [...new Array(300).fill(10), 20, 20, 30, 30, 30];
    const ys = [...new Array(300).fill(10), 20, 20, 30, 30, 30];
    // 300 events in one cell, 2 in another, 3 in a third.
    const h = bin2d(Float32Array.from(xs), Float32Array.from(ys), 0, 100, 0, 100, 100, 100);
    const t = buildLevelTable(summariseLevels(h.bins), LINEAR, 'rank');
    const rank = (v: number) => posOf(t, v);
    expect(rank(2)).toBeCloseTo(0, 6);
    expect(rank(3)).toBeCloseTo(0.5, 2);
    expect(rank(300)).toBeCloseTo(1, 6);
  });
});

/* ==========================================================================
   Auto smoothing — a bandwidth in data units, σ ∝ n^(−1/6)      (2026-10-29)

   0.36 read the grid (events per occupied cell) and rounded, and two replicate
   tubes landed either side of a rounding step in different colours. 0.37.1 fixed
   one width for every plot, and a 300 000-event tube read as thick under a
   kernel set on 15 000-event ones. Now: Scott's rule on the event count,
   continuous and unrounded.
   ========================================================================== */

describe('autoSmoothing', () => {
  const sigmaShare = (bins: number, n: number) => smoothSigma(autoSmoothing(bins, n)) / bins;

  it('is σ = 0.1% of the axis at the reference count, whatever the resolution', () => {
    for (const bins of [64, 128, 256, 512, 1024]) {
      expect(sigmaShare(bins, AUTO_SMOOTHING_EVENTS), String(bins)).toBeCloseTo(AUTO_SMOOTHING_SPAN, 9);
    }
  });

  it('narrows as the sixth root of the event count', () => {
    const ratio = sigmaShare(1024, 20 * AUTO_SMOOTHING_EVENTS) / sigmaShare(1024, AUTO_SMOOTHING_EVENTS);
    expect(ratio).toBeCloseTo(Math.pow(20, -1 / 6), 9);
  });

  it('gives the windows the files were measured at, on a 1024×1024 grid', () => {
    // A 15 000-event tube is unchanged from 0.37.1; the large tubes land within
    // a tenth of what 0.36 gave them before it rounded.
    expect(autoSmoothing(1024, 15_000)).toBeCloseTo(3.51, 2);
    expect(autoSmoothing(1024, 100_000)).toBeCloseTo(2.83, 2);
    expect(autoSmoothing(1024, 300_000)).toBeCloseTo(2.52, 2);
    expect(autoSmoothing(256, 15_000)).toBeCloseTo(1.63, 2);
  });

  it('has no step for two replicates to fall either side of', () => {
    // The 0.36 failure was 3.5002 and 3.4992 rounding to 4 and 3.
    let last = autoSmoothing(1024, 1_000);
    for (let n = 1_010; n <= 500_000; n += 10) {
      const w = autoSmoothing(1024, n);
      expect(w).toBeLessThanOrEqual(last);
      expect(last - w).toBeLessThan(0.01);
      last = w;
    }
    expect(Math.abs(autoSmoothing(1024, 15_072) - autoSmoothing(1024, 15_575))).toBeLessThan(0.05);
  });

  it('stays inside the stepper’s own range', () => {
    expect(autoSmoothing(0, 15_000)).toBe(SMOOTHING_MIN);
    expect(autoSmoothing(-1, 15_000)).toBe(SMOOTHING_MIN);
    expect(autoSmoothing(1024, 0)).toBe(SMOOTHING_MIN);
    expect(autoSmoothing(16, 15_000)).toBeGreaterThanOrEqual(SMOOTHING_MIN);
    expect(autoSmoothing(100_000, 15_000)).toBe(SMOOTHING_MAX);
    // One event: 15 000^(1/6) ≈ 5× the reference blur, still inside the stepper.
    expect(autoSmoothing(1024, 1)).toBeCloseTo(13.47, 1);
    expect(autoSmoothing(4096, 1)).toBe(SMOOTHING_MAX);
  });
});
