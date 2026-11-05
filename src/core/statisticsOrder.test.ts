import { describe, expect, it } from 'vitest';
import { moveCategory, moveCategoryTo, orderCategories, orderRows } from './statisticsOrder';

/** A row reduced to the two fields ordering is decided from. */
const row = (sampleId: string, path: string) => ({ sampleId, path });

/**
 * Twelve rows the way the table computes them: every population of one sample,
 * then every population of the next. `Cells` before `Cells/CD4` before
 * `Cells/CD8` is tree order, and it is not alphabetical order — which is the
 * distinction the population grouping has to preserve.
 */
const sampleMajor = [
  row('s1', 'Cells'), row('s1', 'Cells/CD8'), row('s1', 'Cells/CD4'),
  row('s2', 'Cells'), row('s2', 'Cells/CD8'), row('s2', 'Cells/CD4'),
];

describe('orderRows', () => {
  it('leaves sample-major rows exactly as computed', () => {
    expect(orderRows(sampleMajor, 'sample')).toEqual(sampleMajor);
  });

  it('gathers every sample of a population into one block', () => {
    // The whole point: all the CD4+ rows adjacent, ready to be copied out.
    expect(orderRows(sampleMajor, 'population').map((r) => `${r.sampleId} ${r.path}`)).toEqual([
      's1 Cells', 's2 Cells',
      's1 Cells/CD8', 's2 Cells/CD8',
      's1 Cells/CD4', 's2 Cells/CD4',
    ]);
  });

  it('keeps populations in tree order rather than sorting them', () => {
    // `Cells/CD8` was computed before `Cells/CD4`, so it stays there. Sorting by
    // path would put a child above its parent's other child on spelling, which
    // is not an order anybody drew.
    const paths = orderRows(sampleMajor, 'population').map((r) => r.path);
    expect(paths.indexOf('Cells/CD8')).toBeLessThan(paths.indexOf('Cells/CD4'));
  });

  it('keeps the workspace sample order inside each block', () => {
    const reordered = [row('s2', 'Cells'), row('s1', 'Cells')];
    expect(orderRows(reordered, 'population').map((r) => r.sampleId)).toEqual(['s2', 's1']);
  });

  it('never mutates the input', () => {
    const input = [...sampleMajor];
    orderRows(input, 'population');
    expect(input).toEqual(sampleMajor);
  });

  it('survives a sample that is missing a population the others have', () => {
    const ragged = [row('s1', 'Cells'), row('s1', 'Cells/CD4'), row('s2', 'Cells')];
    expect(orderRows(ragged, 'population').map((r) => `${r.sampleId} ${r.path}`))
      .toEqual(['s1 Cells', 's2 Cells', 's1 Cells/CD4']);
  });
});

describe('orderCategories', () => {
  const natural = ['ctrl', 'TreatA', 'TreatB', 'TreatC'];

  it('is the natural order when nothing has been arranged', () => {
    expect(orderCategories(natural, [])).toEqual(natural);
  });

  it('follows a stored arrangement', () => {
    expect(orderCategories(natural, ['TreatC', 'TreatB', 'TreatA', 'ctrl']))
      .toEqual(['TreatC', 'TreatB', 'TreatA', 'ctrl']);
  });

  it('drops a category that no longer exists rather than leaving a gap', () => {
    // A group renamed, or its last file removed.
    expect(orderCategories(natural, ['TreatC', 'TreatD', 'ctrl']))
      .toEqual(['TreatC', 'ctrl', 'TreatA', 'TreatB']);
  });

  it('appends a new category at the end, never into the middle of an arrangement', () => {
    expect(orderCategories([...natural, 'TreatD'], ['TreatC', 'TreatB', 'TreatA', 'ctrl']))
      .toEqual(['TreatC', 'TreatB', 'TreatA', 'ctrl', 'TreatD']);
  });
});

describe('moveCategory', () => {
  const order = ['ctrl', 'TreatA', 'TreatB', 'TreatC'];

  it('moves one place up and one place down', () => {
    expect(moveCategory(order, 'TreatB', -1)).toEqual(['ctrl', 'TreatB', 'TreatA', 'TreatC']);
    expect(moveCategory(order, 'TreatB', 1)).toEqual(['ctrl', 'TreatA', 'TreatC', 'TreatB']);
  });

  it('is a no-op at either end rather than a wrap', () => {
    // A wrap would send the top category to the bottom on a mis-click, at exactly
    // the moment somebody is being careful about order.
    expect(moveCategory(order, 'ctrl', -1)).toEqual(order);
    expect(moveCategory(order, 'TreatC', 1)).toEqual(order);
  });

  it('ignores a key that is not in the order', () => {
    expect(moveCategory(order, 'TreatD', 1)).toEqual(order);
  });
});

describe('moveCategoryTo', () => {
  const order = ['ctrl', 'TreatA', 'TreatB', 'TreatC'];

  it('puts the dragged category where the target was, in either direction', () => {
    expect(moveCategoryTo(order, 'TreatC', 'ctrl')).toEqual(['TreatC', 'ctrl', 'TreatA', 'TreatB']);
    expect(moveCategoryTo(order, 'ctrl', 'TreatC')).toEqual(['TreatA', 'TreatB', 'TreatC', 'ctrl']);
  });

  it('composes with the arrows — a drop one row along is the same as one press', () => {
    // The property `core/reorder.ts` is built around, asserted here because a
    // drag and an arrow disagreeing is the defect it exists to prevent.
    expect(moveCategoryTo(order, 'TreatA', 'TreatB')).toEqual(moveCategory(order, 'TreatA', 1));
    expect(moveCategoryTo(order, 'TreatB', 'TreatA')).toEqual(moveCategory(order, 'TreatB', -1));
  });

  it('is a no-op onto itself or onto an unknown row', () => {
    expect(moveCategoryTo(order, 'TreatB', 'TreatB')).toEqual(order);
    expect(moveCategoryTo(order, 'TreatB', 'TreatD')).toEqual(order);
  });
});
