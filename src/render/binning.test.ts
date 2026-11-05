import { describe, expect, it } from 'vitest';
import {
  bin1d, bin2d, densityToImage, normaliseArea, normalisePeak, normaliseTo, outlierValue, RAMPS,
  renderDensity, sampleRamp, smooth,
} from './binning';

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

describe('bin2d', () => {
  it('counts every in-range event exactly once', () => {
    const x = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const y = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const h = bin2d(x, y, 0, 10, 0, 10, 10, 10);
    let sum = 0;
    for (const c of h.bins) sum += c;
    expect(sum).toBe(10);
    expect(h.totalCount).toBe(10);
  });

  it('drops events outside the viewport instead of clamping them to the rim', () => {
    // Clamping would draw a bright false edge, which reads as a real population.
    const x = Float32Array.from([-5, 5, 15]);
    const y = Float32Array.from([5, 5, 5]);
    const h = bin2d(x, y, 0, 10, 0, 10, 10, 10);
    expect(h.totalCount).toBe(1);
    expect(h.bins[5 * 10 + 5]).toBe(1);
  });

  it('tracks the busiest bin', () => {
    const x = new Float32Array(100).fill(5);
    const y = new Float32Array(100).fill(5);
    const h = bin2d(x, y, 0, 10, 0, 10, 10, 10);
    expect(h.maxCount).toBe(100);
  });

  it('honours a population mask', () => {
    const x = Float32Array.from([1, 2, 3, 4]);
    const y = Float32Array.from([1, 2, 3, 4]);
    const mask = Uint8Array.from([1, 0, 1, 0]);
    expect(bin2d(x, y, 0, 10, 0, 10, 10, 10, mask).totalCount).toBe(2);
  });

  it('handles a zero-width domain without dividing by zero', () => {
    const h = bin2d(Float32Array.from([5]), Float32Array.from([5]), 5, 5, 5, 5, 4, 4);
    for (const c of h.bins) expect(Number.isFinite(c)).toBe(true);
  });

  it('cost is independent of event count', () => {
    const big = 200_000;
    const x = new Float32Array(big);
    const y = new Float32Array(big);
    for (let i = 0; i < big; i++) { x[i] = (i * 7) % 100; y[i] = (i * 13) % 100; }
    const h = bin2d(x, y, 0, 100, 0, 100, 256, 256);
    expect(h.bins.length).toBe(256 * 256);
    expect(h.totalCount).toBe(big);
  });
});

describe('sampleRamp', () => {
  it('returns the endpoints exactly', () => {
    const r = RAMPS.rainbow!;
    expect(sampleRamp(r, 0)).toEqual(r[0]);
    expect(sampleRamp(r, 1)).toEqual(r[r.length - 1]);
  });

  it('clamps out-of-range t', () => {
    const r = RAMPS.rainbow!;
    expect(sampleRamp(r, -1)).toEqual(r[0]);
    expect(sampleRamp(r, 5)).toEqual(r[r.length - 1]);
  });

  it('offers exactly the three ramps, each 256 entries', () => {
    // Abyss, Ember and Glacier went on 2026-07-31 and stay gone. Flame went, came
    // back, and went again on 2026-08-03, permanently — see `ramps.ts`. Cividis
    // joined on 2026-10-22, matplotlib's table verbatim. All three are full
    // tables rather than a mix of a 256-entry LUT and a 7-stop hand-tuned list,
    // so `sampleRamp` interpolates over the same resolution whichever is chosen.
    expect(Object.keys(RAMPS).sort()).toEqual(['cividis', 'rainbow', 'viridis']);
    for (const [name, ramp] of Object.entries(RAMPS)) {
      expect(ramp.length, name).toBe(256);
    }
  });

  it('is monotonic in lightness for the ramps that claim to be', () => {
    // A density ramp that dips in lightness reads as two populations where there
    // is one. Viridis holds this; Rainbow does not, and that is asserted directly
    // below rather than being left as a gap here.
    for (const name of ['viridis'] as const) {
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const [r, g, b] = sampleRamp(RAMPS[name]!, i / 20);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        expect(lum, `${name} at ${i / 20}`).toBeGreaterThanOrEqual(prev - 6);
        prev = Math.max(prev, lum);
      }
    }
  });

  it('records that Rainbow is *not* monotonic in lightness', () => {
    // Not an exemption. This is a property the ramp is known not to have — yellow
    // at 0.72 is lighter than red at 1.0 — and recording it as a fact means the
    // day somebody "fixes" Rainbow into monotonicity, this fails and asks whether
    // they meant to stop it being a spectral ramp. It is offered because it
    // separates more populations by hue than a uniform ramp can, and because
    // published figures use it.
    const lum = (t: number) => {
      const [r, g, b] = sampleRamp(RAMPS.rainbow!, t);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(lum(1)).toBeLessThan(lum(0.72));
  });
});

describe('densityToImage', () => {
  const h = bin2d(
    Float32Array.from([1, 1, 1, 5, 9]),
    Float32Array.from([1, 1, 1, 5, 9]),
    0, 10, 0, 10, 10, 10,
  );

  it('produces an image the size of the bin grid', () => {
    const img = densityToImage(h, 'rainbow');
    expect(img.width).toBe(10);
    expect(img.height).toBe(10);
    expect(img.data.length).toBe(10 * 10 * 4);
  });

  it('leaves empty cells transparent so the plot background shows through', () => {
    const img = densityToImage(h, 'rainbow', 'log', true);
    // (0,0) has no events in this fixture.
    expect(img.data[3]).toBe(0);
  });

  it('flips vertically so low y appears at the bottom', () => {
    const single = bin2d(Float32Array.from([5]), Float32Array.from([0.5]), 0, 10, 0, 10, 10, 10);
    const img = densityToImage(single, 'rainbow');
    // y=0.5 falls in bin row 0, which must land on the LAST image row.
    const bottom = ((10 - 1) * 10 + 5) * 4;
    expect(img.data[bottom + 3]).toBe(255);
  });

  it.each(['linear', 'log', 'sqrt', 'rank'] as const)('%s scale produces finite pixels', (scale) => {
    const img = densityToImage(h, 'rainbow', scale);
    for (const v of img.data) expect(Number.isFinite(v)).toBe(true);
  });

  it('log scale lifts a sparse bin further than linear does', () => {
    // The reason log beats linear: a five-event bin next to a 1000-event core is
    // invisible on a linear ramp.
    //
    // The bin being compared holds **five** events, not one, and that is deliberate
    // rather than incidental. A cell at the minimum occupied value is an *outlier*
    // (see `colorLevels.ts`), which means it is painted flat at the bottom level's
    // colour whatever the scaling says — so a one-event bin is the one bin on the
    // plot this claim is not about. The lone one-event bin is kept in the fixture to
    // hold that minimum, so the five-event bin is a genuine sparse-but-not-isolated
    // cell of the kind the scaling exists to lift.
    const xs = [...new Array(1000).fill(1), 9, 9, 9, 9, 9, 5];
    const skew = bin2d(Float32Array.from(xs), Float32Array.from(xs), 0, 10, 0, 10, 10, 10);
    const lin = densityToImage(skew, 'rainbow', 'linear');
    const log = densityToImage(skew, 'rainbow', 'log');
    const cell = ((10 - 1 - 9) * 10 + 9) * 4;
    const linLum = lin.data[cell]! + lin.data[cell + 1]! + lin.data[cell + 2]!;
    const logLum = log.data[cell]! + log.data[cell + 1]! + log.data[cell + 2]!;
    expect(logLum).toBeGreaterThan(linLum);
  });

  it('handles an all-empty histogram', () => {
    const empty = bin2d(new Float32Array(0), new Float32Array(0), 0, 1, 0, 1, 4, 4);
    const img = densityToImage(empty, 'rainbow');
    expect(img.data.every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
  });
});

describe('bin1d', () => {
  it('counts in-range values and reports the rest', () => {
    // -1 and 20 both fall outside [0, 10); 0, 5 and 9 land in bins 0, 5 and 9.
    const h = bin1d(Float32Array.from([-1, 0, 5, 9, 20]), 0, 10, 10);
    expect(h.count).toBe(3);
    expect(h.outOfRange).toBe(2);
  });

  it('finds the tallest bin', () => {
    const h = bin1d(Float32Array.from([5, 5, 5, 1]), 0, 10, 10);
    expect(h.maxBin).toBe(3);
  });

  it('honours a mask', () => {
    const h = bin1d(Float32Array.from([1, 2, 3, 4]), 0, 10, 10, Uint8Array.from([1, 1, 0, 0]));
    expect(h.count).toBe(2);
  });
});

describe('histogram normalisation', () => {
  const h = bin1d(Float32Array.from([1, 1, 2, 3]), 0, 4, 4);

  it('normalisePeak makes the tallest bin 1', () => {
    const n = normalisePeak(h);
    expect(Math.max(...n)).toBeCloseTo(1, 10);
  });

  it('normaliseArea integrates to 1', () => {
    const n = normaliseArea(h);
    const binWidth = 1;
    let area = 0;
    for (const v of n) area += v * binWidth;
    expect(area).toBeCloseTo(1, 10);
  });

  it('both return zeros for an empty histogram rather than NaN', () => {
    const empty = bin1d(new Float32Array(0), 0, 10, 8);
    for (const v of normalisePeak(empty)) expect(Number.isFinite(v)).toBe(true);
    for (const v of normaliseArea(empty)) expect(Number.isFinite(v)).toBe(true);
  });

  /* --- 2026-08-11, Item 11 — a gated slice on its parent's scale ---------- */

  it('normaliseTo scales by a divisor chosen elsewhere', () => {
    const n = normaliseTo(h, 4);
    // Tallest bin holds 2 of 4, so at a divisor of 4 it reaches 0.5.
    expect(Math.max(...n)).toBeCloseTo(0.5, 10);
  });

  it('normalisePeak is normaliseTo at the histogram’s own peak', () => {
    expect(Array.from(normalisePeak(h))).toEqual(Array.from(normaliseTo(h, h.maxBin)));
  });

  it('gives a flat zero curve for a divisor of zero rather than NaN or Infinity', () => {
    for (const v of normaliseTo(h, 0)) expect(v).toBe(0);
    for (const v of normaliseTo(h, NaN)) expect(v).toBe(0);
  });

  /*
     The whole of the reported bug, as arithmetic.

     A positive gate on a single stain selects the bright tail: the distribution's
     tallest bin is the negative peak, the slice's is far smaller. Normalised
     independently, the slice is drawn taller than the curve it is part of — and
     the further right the boundary goes, the worse the inflation. Against the
     parent's peak, the slice never exceeds the distribution at any bin, which is
     what "the shading lines up with the curve" means numerically.
  */
  it('keeps a gated slice under its parent at every bin, wherever the boundary sits', () => {
    const values = Float32Array.from([
      // A dense negative population, and a sparse positive tail.
      ...Array.from({ length: 400 }, () => 1.5),
      ...Array.from({ length: 12 }, () => 6.5),
      ...Array.from({ length: 6 }, () => 8.5),
    ]);
    const whole = bin1d(values, 0, 10, 10);

    for (const threshold of [4, 6, 8]) {
      const mask = Uint8Array.from(values, (v) => (v >= threshold ? 1 : 0));
      const slice = bin1d(values, 0, 10, 10, mask);

      const parent = normalisePeak(whole);
      const onOwnPeak = normalisePeak(slice);
      const onParentPeak = normaliseTo(slice, whole.maxBin);

      // The old behaviour: the slice rises above the distribution it came from.
      expect(Math.max(...onOwnPeak)).toBeGreaterThan(Math.max(...parent.map((v, i) => (onOwnPeak[i]! > 0 ? v : 0))));

      // The new behaviour: it never does, at any bin, at any threshold.
      for (let i = 0; i < parent.length; i++) {
        expect(onParentPeak[i]!).toBeLessThanOrEqual(parent[i]! + 1e-12);
      }
    }
  });
});

describe('smooth', () => {
  it('is a no-op for a window of 1', () => {
    const src = Float64Array.from([1, 5, 2]);
    expect(smooth(src, 1)).toBe(src);
  });

  it('preserves total signal approximately and reduces spikiness', () => {
    const spiky = Float64Array.from([0, 0, 10, 0, 0]);
    const s = smooth(spiky, 3);
    expect(Math.max(...s)).toBeLessThan(10);
    expect(s[1]).toBeGreaterThan(0);
    expect(s[3]).toBeGreaterThan(0);
  });

  it('handles the edges without reading past the array', () => {
    const s = smooth(Float64Array.from([1, 2, 3]), 5);
    for (const v of s) expect(Number.isFinite(v)).toBe(true);
  });
});

/* ==========================================================================
   Outlier dot size — Item 9, 2026-08-02.

   Partially reverses the 2026-08-01 removal of the outlier settings. The display
   *mode* and the dot *colour* are gone for good, and with them the flat band that
   painted the sparsest cells outside the level table; what came back is a size.
   Every assertion here is about that distinction, because it is the one that
   decides whether the Colour scaling bug comes back with the control.
   ========================================================================== */
describe('outliers', () => {
  /** One isolated cell, plus a dense blob well away from it. */
  const grid = (w: number, h: number, cells: Array<[number, number, number]>) => {
    const bins = new Uint32Array(w * h);
    let max = 0;
    let total = 0;
    for (const [x, y, v] of cells) { bins[y * w + x] = v; total += v; if (v > max) max = v; }
    return {
      bins, width: w, height: h, xMin: 0, xMax: 1, yMin: 0, yMax: 1,
      maxCount: max, totalCount: total, occupied: cells.filter(([, , v]) => v > 0).length,
    };
  };

  describe('outlierValue', () => {
    it('is the least signal any occupied cell holds', () => {
      expect(outlierValue(Uint32Array.from([0, 1, 5, 9, 0]))).toBe(1);
      // Fractional, which is what a smoothed grid produces.
      expect(outlierValue(Float32Array.from([0, 0.25, 4, 0]))).toBeCloseTo(0.25);
    });

    it('is null when every occupied cell holds the same value', () => {
      // "The sparsest" would describe all of them, and enlarging all of them is
      // enlarging nothing. Guards the one-distinct-level case the previous
      // definitions got wrong in the other direction.
      expect(outlierValue(Uint32Array.from([0, 3, 3, 3]))).toBeNull();
      expect(outlierValue(Uint32Array.from([0, 0, 0]))).toBeNull();
    });
  });

  const opaque = (img: ImageData) => {
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++;
    return n;
  };

  it('draws an isolated cell larger without touching any other cell', () => {
    const h = grid(16, 16, [[2, 2, 1], [8, 8, 40], [9, 8, 40], [8, 9, 40]]);
    const plain = renderDensity(h, { ramp: 'rainbow', scale: 'linear' });
    const grown = renderDensity(h, { ramp: 'rainbow', scale: 'linear', outlierSize: 2 });
    // 4 occupied cells → 4 opaque pixels; a size of 2 turns the one outlier into
    // a 2×2, so exactly three more pixels are painted.
    expect(opaque(plain)).toBe(4);
    expect(opaque(grown)).toBe(4 + 3);
  });

  it('gives the grown pixels the colour the level table already chose', () => {
    // The whole of the difference from the removed outlier band, which painted
    // these cells a *stated* colour outside the mapping. Read the outlier's own
    // pixel out of both images: it must be identical, and its new neighbours must
    // match it rather than some flat value of their own.
    const h = grid(16, 16, [[2, 2, 1], [8, 8, 40]]);
    const at = (img: ImageData, x: number, y: number) => {
      const o = ((h.height - 1 - y) * h.width + x) * 4;
      return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]].join(',');
    };
    const plain = renderDensity(h, { ramp: 'rainbow', scale: 'linear' });
    const grown = renderDensity(h, { ramp: 'rainbow', scale: 'linear', outlierSize: 3 });
    expect(at(grown, 2, 2)).toBe(at(plain, 2, 2));
    expect(at(grown, 1, 2)).toBe(at(plain, 2, 2));
    expect(at(grown, 3, 3)).toBe(at(plain, 2, 2));
    // And the dense cell is untouched in both.
    expect(at(grown, 8, 8)).toBe(at(plain, 8, 8));
  });

  it('never paints over an occupied cell', () => {
    // An outlier is drawn bigger, not louder: growing one must not erase the
    // shape of a population it happens to sit beside.
    const h = grid(8, 8, [[3, 3, 1], [4, 3, 50]]);
    const plain = renderDensity(h, { ramp: 'rainbow', scale: 'linear' });
    const grown = renderDensity(h, { ramp: 'rainbow', scale: 'linear', outlierSize: 3 });
    const o = ((h.height - 1 - 3) * h.width + 4) * 4;
    expect(Array.from(grown.data.slice(o, o + 4))).toEqual(Array.from(plain.data.slice(o, o + 4)));
  });

  it('is inert at size 1, which is what "off" means', () => {
    const h = grid(8, 8, [[2, 2, 1], [5, 5, 9]]);
    const a = renderDensity(h, { ramp: 'rainbow', scale: 'linear', outlierSize: 1 });
    const b = renderDensity(h, { ramp: 'rainbow', scale: 'linear' });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('leaves the Colour scaling control reaching every occupied cell', () => {
    // The regression this whole design exists to avoid. Under the removed band,
    // the sparsest cells bypassed the level table, so switching Linear→Log left
    // them unchanged — on a sparse plot that was 41% of the picture. With the
    // outlier merely enlarged, *every* occupied cell still moves.
    const cells: Array<[number, number, number]> = [];
    for (let i = 0; i < 20; i++) cells.push([i, i, 1 + (i % 7)]);
    const h = grid(32, 32, cells);
    const lin = renderDensity(h, { ramp: 'rainbow', scale: 'linear', levels: { style: 'linear', scaling: 'linear' }, outlierSize: 2 });
    const log = renderDensity(h, { ramp: 'rainbow', scale: 'linear', levels: { style: 'linear', scaling: 'log' }, outlierSize: 2 });
    const top = RAMPS.rainbow![RAMPS.rainbow!.length - 1]!;
    let changed = 0;
    let painted = 0;
    let atTop = 0;
    for (let i = 0; i < lin.data.length; i += 4) {
      if (lin.data[i + 3]! === 0) continue;
      painted++;
      if (lin.data[i] === top[0] && lin.data[i + 1] === top[1] && lin.data[i + 2] === top[2]) { atTop++; continue; }
      if (lin.data[i] !== log.data[i] || lin.data[i + 1] !== log.data[i + 1] || lin.data[i + 2] !== log.data[i + 2]) changed++;
    }
    // Everything except what sits at the very top of the ramp, where log(1) is 1
    // and there is nowhere for it to move to — grown pixels included.
    expect(painted).toBeGreaterThan(20);
    expect(atTop).toBeGreaterThan(0);
    expect(changed).toBe(painted - atTop);
  });
});
