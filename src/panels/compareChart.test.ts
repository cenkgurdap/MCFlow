import { describe, expect, it } from 'vitest';
import {
  axisTickLabel, chartPixelWidth, DEFAULT_FIGURE_MM, FIGURE_WIDTHS, frameTicks,
  layOutBrackets, layOutLegend, LEGEND_LIMIT, millimetres, niceStep,
} from './compareChart';

/* ==========================================================================
   The compare chart's arithmetic — 2026-08-11, Items 1 and 6.

   Both were reported as visual complaints and both are numeric: "the y axis
   leaves excess empty space" is a statement about where `frameTicks` puts its
   bounds, and "the graph shows three decimals where the file has four" is a
   statement about what `axisTickLabel` returns. Asserted here rather than on a
   rendered SVG for the reason the module exists: neither needs a renderer, and a
   check that needs one is a check nobody runs.
   ========================================================================== */

describe('niceStep', () => {
  it('walks the 1/2/5 ladder', () => {
    expect(niceStep(0.9)).toBeCloseTo(1);
    expect(niceStep(1.5)).toBeCloseTo(2);
    expect(niceStep(4)).toBeCloseTo(5);
    expect(niceStep(7)).toBeCloseTo(10);
    expect(niceStep(0.03)).toBeCloseTo(0.05);
    expect(niceStep(3000)).toBeCloseTo(5000);
  });

  it('answers 1 for a degenerate span rather than throwing', () => {
    expect(niceStep(0)).toBe(1);
    expect(niceStep(-4)).toBe(1);
    expect(niceStep(NaN)).toBe(1);
  });
});

describe('frameTicks', () => {
  /*
     The reported case, in numbers. A membrane-order index across six samples
     occupies 0.44…0.47; the axis it used to be given ran 0 to 0.5, so the whole
     data set lived in the top 6% of the plot.
  */
  it('frames a narrow ratio on its own range rather than on zero', () => {
    const { lo, hi } = frameTicks(0.4412, 0.4703);
    expect(lo).toBeGreaterThan(0.43);
    expect(hi).toBeLessThan(0.48);
    // The data occupies most of the plot, which is the whole request.
    expect((0.4703 - 0.4412) / (hi - lo)).toBeGreaterThan(0.8);
  });

  it('keeps every tick inside the framed range', () => {
    const { lo, hi, ticks } = frameTicks(12, 87);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(t).toBeLessThanOrEqual(hi + 1e-9);
    }
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it('lands ticks on round numbers', () => {
    const { ticks } = frameTicks(0, 100);
    const step = ticks[1]! - ticks[0]!;
    // 1, 2 or 5 × a power of ten, and every tick a multiple of it.
    expect([1, 2, 5, 10, 20, 25, 50].some((s) => Math.abs(step - s) < 1e-9)).toBe(true);
    for (const t of ticks) expect(Math.abs(t / step - Math.round(t / step))).toBeLessThan(1e-9);
  });

  it('includes zero when the data reaches it, and only then', () => {
    expect(frameTicks(0, 40).ticks).toContain(0);
    expect(frameTicks(200, 240).ticks.some((t) => t === 0)).toBe(false);
  });

  it('opens a window around a single repeated value', () => {
    // Every sample at 100% of parent — the root population, where that is the
    // correct answer and a zero-height axis is not.
    const { lo, hi, ticks } = frameTicks(100, 100);
    expect(hi).toBeGreaterThan(lo);
    expect(lo).toBeLessThan(100);
    expect(hi).toBeGreaterThan(100);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it('survives a non-finite extent', () => {
    expect(frameTicks(NaN, 5).ticks).toHaveLength(2);
    expect(frameTicks(0, Infinity).ticks).toHaveLength(2);
  });

  it('accepts a reversed pair', () => {
    const a = frameTicks(10, 2);
    expect(a.lo).toBeLessThan(a.hi);
  });
});

describe('axisTickLabel', () => {
  it('gives a parameter statistic the decimals its step needs, and no trailing zeros', () => {
    // The table and the export keep four decimals; an axis tick is a position
    // on a scale, and `0.4400` beside `0.4500` is four characters of nothing.
    const ticks = [0.44, 0.45, 0.46];
    expect(axisTickLabel(0.45, ticks, 'median')).toBe('0.45');
    expect(axisTickLabel(0.44, ticks, 'median')).toBe('0.44');
    expect(axisTickLabel(0.5, [0, 0.5, 1], 'mean')).toBe('0.5');
  });

  it('still takes a percentage axis to the precision its own step earns', () => {
    expect(axisTickLabel(20, [0, 20, 40], 'percentTotal')).toBe('20');
    // Steps come off the 1/2/5 ladder, so the decimals a step needs are exactly
    // the decimals it has. Checked against every fractional step `niceStep` can
    // return over the range a percentage occupies.
    expect(axisTickLabel(0.2, [0, 0.2, 0.4], 'percentParent')).toBe('0.2');
    expect(axisTickLabel(0.05, [0, 0.05, 0.1], 'percentParent')).toBe('0.05');
    expect(axisTickLabel(0.5, [0, 0.5, 1], 'percentTotal')).toBe('0.5');
  });

  it('keeps a count grouped and whole', () => {
    expect(axisTickLabel(15000, [0, 5000, 10000, 15000], 'count')).toBe('15 000');
  });
});

describe('layOutLegend', () => {
  const point = (name: string, i = 0) => ({
    sampleId: name, sampleName: name, colorIndex: i, value: 1,
  });

  it('is empty when there is nothing to key', () => {
    expect(layOutLegend([], 600)).toEqual({ items: [], rows: 0, overflow: 0 });
  });

  it('flows onto one row when the names fit', () => {
    const out = layOutLegend([point('A'), point('B'), point('C')], 600);
    expect(out.rows).toBe(1);
    expect(out.items.every((i) => i.row === 0)).toBe(true);
    // Left to right, no overlap.
    expect(out.items[1]!.x).toBeGreaterThan(out.items[0]!.x);
  });

  it('wraps rather than running off the plot', () => {
    const names = Array.from({ length: 8 }, (_, i) => point(`Sample name ${i}`, i));
    const out = layOutLegend(names, 300);
    expect(out.rows).toBeGreaterThan(1);
    for (const i of out.items) expect(i.x).toBeLessThan(300);
  });

  it('caps the key and reports the remainder rather than dropping it silently', () => {
    const names = Array.from({ length: LEGEND_LIMIT + 7 }, (_, i) => point(`S${i}`, i));
    const out = layOutLegend(names, 600);
    expect(out.items).toHaveLength(LEGEND_LIMIT);
    expect(out.overflow).toBe(7);
  });
});

/* ==========================================================================
   Group colouring — 2026-08-12, Item 2.

   The rule is one line to state and has two edges worth pinning: a group takes
   its *first member's* index, and an ungrouped sample is not a group of one.
   Both are what stop the chart from re-colouring things nobody changed.
   ========================================================================== */

describe('layOutBrackets', () => {
  const spec = (a: number, b: number) => ({ a, b, label: `${a}-${b}` });
  const rowOf = (r: ReturnType<typeof layOutBrackets>, key: string) =>
    r.brackets.find((x) => x.label === key)?.row;

  it('puts everything on one rung when nothing overlaps', () => {
    const r = layOutBrackets([spec(0, 1), spec(2, 3), spec(4, 5)]);
    expect(r.rows).toBe(1);
    expect(r.brackets.every((b) => b.row === 0)).toBe(true);
  });

  it('stacks the shorter span underneath the one containing it', () => {
    const r = layOutBrackets([spec(0, 2), spec(0, 1)]);
    expect(rowOf(r, '0-1')).toBe(0);
    expect(rowOf(r, '0-2')).toBe(1);
    expect(r.rows).toBe(2);
  });

  it('lifts a bracket that only shares an endpoint', () => {
    // The two vertical ticks would land on the same x, which reads as one
    // bracket with a kink in it rather than as two comparisons.
    expect(layOutBrackets([spec(0, 1), spec(1, 2)]).rows).toBe(2);
  });

  it('never lets two brackets on one rung overlap', () => {
    const all = [];
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) all.push(spec(i, j));
    const r = layOutBrackets(all);
    const byRow = new Map<number, Array<[number, number]>>();
    for (const b of r.brackets) {
      for (const [s, e] of byRow.get(b.row) ?? []) {
        expect(b.a > e || s > b.b).toBe(true);
      }
      byRow.set(b.row, [...(byRow.get(b.row) ?? []), [b.a, b.b]]);
    }
    expect(r.brackets).toHaveLength(10);
  });

  it('normalises a pair given right to left', () => {
    const r = layOutBrackets([{ a: 3, b: 1, label: 'x' }]);
    expect(r.brackets[0]!.a).toBe(1);
    expect(r.brackets[0]!.b).toBe(3);
  });

  it('has no rows when there is nothing to draw', () => {
    expect(layOutBrackets([])).toEqual({ brackets: [], rows: 0 });
  });
});

/* ==========================================================================
   Figure width — 2026-09-07.

   The chart was 680 drawing units wide and nothing said what that was. It is
   180 mm: the exporters define a unit as 1/96 inch and put no scaling on the
   path, so the number has always had paper behind it. These assert that the
   three offered widths convert the way the exporters read them, since a wrong
   conversion here is a figure that is the wrong size on a page and looks
   perfectly correct on screen.
   ========================================================================== */

describe('chartPixelWidth', () => {
  it('is the width in millimetres at 96 units per inch', () => {
    expect(chartPixelWidth(180)).toBe(680);
    expect(chartPixelWidth(85)).toBe(321);
    expect(chartPixelWidth(89)).toBe(336);
  });

  it('offers exactly the three widths, double column last and default', () => {
    expect(FIGURE_WIDTHS.map((f) => f.mm)).toEqual([85, 120, 180]);
    expect(DEFAULT_FIGURE_MM).toBe(85);
    expect(chartPixelWidth(DEFAULT_FIGURE_MM)).toBe(321);
  });

  it('falls back to the default rather than drawing an arbitrary width', () => {
    // A stored preference from a build that offered something else, or a hand
    // -edited number. Laying the chart out at it would be honouring a size no
    // journal asked for; the honest answer is the one the panel opens on.
    expect(chartPixelWidth(30)).toBe(321);
    expect(chartPixelWidth(0)).toBe(321);
  });
});

describe('millimetres', () => {
  it('inverts the conversion, to one decimal', () => {
    expect(millimetres(680)).toBeCloseTo(180, 0);
    expect(millimetres(321)).toBeCloseTo(85, 0);
  });
});
