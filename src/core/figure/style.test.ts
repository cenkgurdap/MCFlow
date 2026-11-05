import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIGURE_STYLE, WIDTH_PRESETS, FIGURE_INK, figureSize, fontStack, mmToPx, normaliseStyle,
  PAPER_POPULATION, paperColor, ptToPx, pxToMm, pxToPt,
} from './style';

describe('units', () => {
  it('is 96 user units to the inch, the assumption the PDF printer shares', () => {
    expect(mmToPx(25.4)).toBeCloseTo(96, 9);
    expect(ptToPx(72)).toBeCloseTo(96, 9);
    // An 89 mm column and a 7 pt label, in the units a composer lays out in.
    expect(mmToPx(89)).toBeCloseTo(336.38, 2);
    expect(ptToPx(7)).toBeCloseTo(9.333, 3);
    expect(pxToMm(mmToPx(183))).toBeCloseTo(183, 9);
    expect(pxToPt(ptToPx(8))).toBeCloseTo(8, 9);
  });
});

describe('the default style', () => {
  it('is the journal convention the export brief asks for', () => {
    const d = DEFAULT_FIGURE_STYLE;
    expect(d.font).toMatchObject({ family: 'Arial', tickPt: 7, labelPt: 8 });
    expect(d.line.tickDir).toBe('out');
    expect(d.frame).toEqual({ spines: 'open', grid: false, background: 'transparent' });
    expect(d.text.title).toBe(false);
    expect(fontStack(d.font.family)).toMatch(/^Arial, Helvetica/);
  });

  it('sizes a figure from its width and aspect', () => {
    const s = { ...DEFAULT_FIGURE_STYLE, size: { ...DEFAULT_FIGURE_STYLE.size, widthMm: 120, aspect: '3:2' as const } };
    const { width, height } = figureSize(s);
    expect(width).toBeCloseTo(mmToPx(120), 9);
    expect(width / height).toBeCloseTo(1.5, 9);
  });

  it('offers widths by width alone, 85 mm the default', () => {
    expect(WIDTH_PRESETS.map((p) => p.label)).toEqual(['85 mm (single column)', '120 mm', '180 mm (double column)']);
    expect(DEFAULT_FIGURE_STYLE.size.widthMm).toBe(85);
  });
});

describe('normaliseStyle', () => {
  it('fills every missing field from the default', () => {
    expect(normaliseStyle({})).toEqual(DEFAULT_FIGURE_STYLE);
    expect(normaliseStyle(null)).toEqual(DEFAULT_FIGURE_STYLE);
    expect(normaliseStyle({ font: { tickPt: 6 } }).font).toEqual({ ...DEFAULT_FIGURE_STYLE.font, tickPt: 6 });
  });

  it('refuses a value it could not draw, field by field', () => {
    const s = normaliseStyle({
      size: { widthMm: -5, aspect: 'wide' },
      font: { family: 'Comic Sans', labelPt: 'big' },
      output: { format: 'jpeg', dpi: 72 },
    });
    expect(s.size.widthMm).toBe(DEFAULT_FIGURE_STYLE.size.widthMm);
    expect(s.size.aspect).toBe(DEFAULT_FIGURE_STYLE.size.aspect);
    expect(s.font.family).toBe('Arial');
    expect(s.font.labelPt).toBe(DEFAULT_FIGURE_STYLE.font.labelPt);
    expect(s.output.format).toBe('pdf');
    expect(s.output.dpi).toBe(300);
  });
});

describe('paper colours', () => {
  it('are the light theme’s population palette, exactly', () => {
    const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8');
    // The light block that defines the population palette — the one whose first
    // declaration is --pop-01.
    const start = css.indexOf('--pop-01', css.indexOf("--pop-12"));
    const block = css.slice(start, css.indexOf('}', start));
    const tokens = [...block.matchAll(/--pop-(\d\d):\s*(#[0-9a-f]{6})/gi)].map((m) => m[2]!.toLowerCase());
    expect(tokens).toHaveLength(12);
    expect(PAPER_POPULATION).toEqual(tokens);
  });

  it('resolve a screen colour to what a figure draws', () => {
    expect(paperColor('var(--pop-07)')).toBe(PAPER_POPULATION[6]);
    expect(paperColor('var(--gate-ink)')).toBe(FIGURE_INK);
    expect(paperColor('#3fd9c0')).toBe('#3fd9c0');
  });
});
