import { describe, expect, it } from 'vitest';
import {
  CAPTION_LINE, CAPTION_PAD, captionLines, EXPORT_DPI_OPTIONS, exportCanvasSize,
  pagePointSize, pixelScaleFor, plotCaption, plotFileName, PT_PER_PX, VECTOR_RASTER_DPI,
} from './plotExport';

describe('plotFileName', () => {
  it('builds a readable stem from sample and axes', () => {
    expect(plotFileName('Sample B Pro12A1', 'FSC-A', 'SSC-A', 'png'))
      .toBe('Sample_B_Pro12A1_FSC-A_SSC-A.png');
  });

  it('strips characters that break filesystems', () => {
    expect(plotFileName('a/b', 'CD4+', 'CD8:x', 'svg')).toBe('a_b_CD4+_CD8_x.svg');
  });

  it('carries the format through as the extension', () => {
    for (const f of ['png', 'svg', 'pdf'] as const) {
      expect(plotFileName('s', 'x', 'y', f).endsWith(`.${f}`)).toBe(true);
    }
  });

  it('never produces a bare extension', () => {
    expect(plotFileName('///', '///', '///', 'png')).toBe('plot.png');
  });

  it('does not leave leading or trailing separators', () => {
    const n = plotFileName(' lead ', 'x', 'y', 'png');
    expect(n.startsWith('_')).toBe(false);
    expect(n).toBe('lead_x_y.png');
  });
});

describe('the resolution ladder', () => {
  it('offers the three DPI settings every exporter in the app offers', () => {
    expect([...EXPORT_DPI_OPTIONS]).toEqual([300, 600, 900]);
  });

  it('scales a figure by DPI against the 96 dpi a CSS pixel is defined at', () => {
    expect(pixelScaleFor(96)).toBe(1);
    expect(pixelScaleFor(300)).toBeCloseTo(3.125, 10);
    // A 288-unit panel at 300 dpi is 900 px, which is three inches — the size
    // it was drawn as, not a size it was rescaled to.
    expect(288 * pixelScaleFor(300)).toBeCloseTo(900, 6);
    expect(900 / 300).toBeCloseTo(288 / 96, 10);
  });

  it('embeds the event cloud of a vector file at the submission floor', () => {
    expect(VECTOR_RASTER_DPI).toBe(300);
    expect(EXPORT_DPI_OPTIONS).toContain(VECTOR_RASTER_DPI);
  });
});

describe('unit conversion', () => {
  it('PT_PER_PX converts CSS pixels to PDF points', () => {
    expect(PT_PER_PX).toBeCloseTo(72 / 96, 10);
    expect(96 * PT_PER_PX).toBeCloseTo(72, 10);
  });

  it('a page is the drawing, at the size it was drawn', () => {
    // The figure's own units are CSS pixels and a CSS pixel is 1/96 inch, so a
    // 288-unit panel prints 3 inches — 216 pt, 76 mm. Nothing fits it to a
    // column, which is what removed the second sizing path through this file.
    const { widthPt, heightPt } = pagePointSize(288, 275);
    expect(widthPt).toBeCloseTo(216, 6);
    expect(heightPt).toBeCloseTo(206.25, 6);
    expect((widthPt / 72) * 25.4).toBeCloseTo(76.2, 1);
  });

  it('a raster and a page describe the same figure', () => {
    // The bug the old preset table existed to avoid, now structurally absent:
    // one shape, read as pixels or as points, cannot disagree with itself.
    const w = 288;
    const inchesFromPng = (w * pixelScaleFor(600)) / 600;
    const inchesFromPdf = pagePointSize(w, w).widthPt / 72;
    expect(inchesFromPng).toBeCloseTo(inchesFromPdf, 10);
  });
});

describe('plotCaption', () => {
  it('says which parameter is on which axis', () => {
    expect(plotCaption({ sample: 'Sample B Pro12A1', x: 'FSC-A', y: 'SSC-A' }))
      .toBe('Sample B Pro12A1  ·  FSC-A (x-axis) × SSC-A (y-axis)');
  });

  it('names the population between the sample and the pairing', () => {
    const c = plotCaption({ sample: 'S1', population: 'Cells', x: 'FSC-A', y: 'SSC-A' });
    expect(c.indexOf('Cells')).toBeGreaterThan(c.indexOf('S1'));
    expect(c.indexOf('Cells')).toBeLessThan(c.indexOf('FSC-A'));
  });

  it('drops an absent population rather than leaving its separator', () => {
    expect(plotCaption({ sample: 'S1', population: null, x: 'A', y: 'B' }))
      .toBe('S1  ·  A (x-axis) × B (y-axis)');
  });

  it('carries a histogram y axis by the name the panel gives it', () => {
    // A histogram has no y parameter; the caption used to reach for one anyway.
    expect(plotCaption({ sample: 'S1', x: 'B2-A', y: 'Normalised count' }))
      .toContain('Normalised count (y-axis)');
  });

  it('drops a side that has no label instead of writing a bare marker', () => {
    expect(plotCaption({ sample: 'S1', x: 'FSC-A', y: '' })).toBe('S1  ·  FSC-A (x-axis)');
  });
});

describe('captionLines', () => {
  it('leaves a caption that fits on one line', () => {
    expect(captionLines('S1  ·  FSC-A (x-axis)', 900)).toEqual(['S1  ·  FSC-A (x-axis)']);
  });

  it('wraps a caption too wide for the figure', () => {
    const long = plotCaption({
      sample: 'Sample B Pro12A1', population: 'Cells', x: 'FSC-A', y: 'SSC-A',
    });
    const lines = captionLines(long, 200);
    expect(lines.length).toBeGreaterThan(1);
    // Nothing is lost in the wrap — every word survives, in order. The
    // separator at a break is not carried onto the next line, which is what a
    // separator is for.
    const words = (t: string) => t.split(/\s+/).filter((w) => w && w !== '·');
    expect(words(lines.join(' '))).toEqual(words(long));
  });

  it('breaks at the separators before it breaks inside a name', () => {
    const lines = captionLines(plotCaption({ sample: 'Sample one', x: 'FSC-A', y: 'SSC-A' }), 210);
    expect(lines[0]).toBe('Sample one');
  });

  it('still returns lines when one part is wider than the whole figure', () => {
    const lines = captionLines('a very long single part with no separators at all', 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((l) => l.length > 0)).toBe(true);
  });

  it('returns nothing for an empty caption', () => {
    expect(captionLines('', 400)).toEqual([]);
    expect(captionLines('   ', 400)).toEqual([]);
  });
});

describe('exportCanvasSize', () => {
  it('adds a strip for the caption and nothing when there is none', () => {
    expect(exportCanvasSize(300, 280, null)).toEqual({ width: 300, height: 280 });
    expect(exportCanvasSize(300, 280, 'one line')).toEqual({
      width: 300, height: 280 + CAPTION_PAD + CAPTION_LINE,
    });
  });

  it('grows by a line for every line the caption wraps to', () => {
    const long = plotCaption({
      sample: 'Sample B Pro12A1', population: 'Cells', x: 'FSC-A', y: 'SSC-A',
    });
    const lines = captionLines(long, 200);
    expect(exportCanvasSize(200, 280, long).height)
      .toBe(280 + CAPTION_PAD + lines.length * CAPTION_LINE);
  });

  it('never changes the width, so the plot square is untouched', () => {
    for (const caption of ['a caption', null]) {
      expect(exportCanvasSize(512, 400, caption).width).toBe(512);
    }
  });
});
