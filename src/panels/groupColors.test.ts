import { describe, expect, it } from 'vitest';
import { CONDITION_PALETTE, OKABE_ITO } from '@/core/figure/style';
import { categoryColors, conditionColor, CONDITION_PALETTE_SIZE } from './groupColors';

describe('conditionColor', () => {
  it('is the Okabe–Ito palette, strongest pair first', () => {
    expect(conditionColor(0)).toBe(OKABE_ITO.blue);
    expect(conditionColor(1)).toBe(OKABE_ITO.vermillion);
    // Black is last: it is the colour of the axes.
    expect(conditionColor(CONDITION_PALETTE_SIZE - 1)).toBe(OKABE_ITO.black);
  });

  it('wraps rather than running off the end', () => {
    expect(conditionColor(CONDITION_PALETTE_SIZE)).toBe(conditionColor(0));
  });

  it('clamps a negative index instead of naming a colour that does not exist', () => {
    expect(conditionColor(-1)).toBe(CONDITION_PALETTE[0]);
  });
});

describe('categoryColors', () => {
  it('gives the first category the first colour, and so on', () => {
    const out = categoryColors(['Control', 'Treated', 'Rescue']);
    expect(out.get('Control')).toBe(conditionColor(0));
    expect(out.get('Treated')).toBe(conditionColor(1));
    expect(out.get('Rescue')).toBe(conditionColor(2));
  });

  it('follows the order, so reordering recolours', () => {
    const out = categoryColors(['Treated', 'Control']);
    expect(out.get('Treated')).toBe(conditionColor(0));
    expect(out.get('Control')).toBe(conditionColor(1));
  });

  it('is the same answer for the same order, whatever produced it', () => {
    // The property the two panels rely on: a chart and a map with the same
    // groups in the same order are coloured identically.
    expect([...categoryColors(['Control', 'Treated']).values()])
      .toEqual([...categoryColors(['Control', 'Treated']).values()]);
  });

  it('does not spend a second colour on a repeated label', () => {
    const out = categoryColors(['A', 'B', 'A', 'C']);
    expect(out.size).toBe(3);
    expect(out.get('C')).toBe(conditionColor(2));
  });

  it('lets a named category keep a colour of its own, wherever it sits', () => {
    const overrides = { Treated: '#123456' };
    expect(categoryColors(['Control', 'Treated'], overrides).get('Treated')).toBe('#123456');
    expect(categoryColors(['Treated', 'Control'], overrides).get('Treated')).toBe('#123456');
  });

  it('and the categories after it keep the colours their positions give them', () => {
    const out = categoryColors(['Control', 'Treated', 'Rescue'], { Treated: '#123456' });
    expect(out.get('Control')).toBe(conditionColor(0));
    expect(out.get('Rescue')).toBe(conditionColor(2));
  });
});
