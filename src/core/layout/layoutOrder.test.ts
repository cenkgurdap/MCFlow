import { describe, expect, it } from 'vitest';
import { flattenLayoutGroups, groupLayouts, type OrderedLayout } from './layoutOrder';

const L = (id: string, name: string, kind?: OrderedLayout['kind']): OrderedLayout => ({ id, name, kind });

/* A window part-way through both guided panels: two general layouts, two
   unmixing control worksheets, three Biophysics per-sample sheets and the one
   cell-type sheet. Deliberately handed over shuffled, because the order is what
   is being asserted. */
const all = [
  L('L9', 'Cell types', 'biophysics'),
  L('L3', 'CD4 BV421', 'reference'),
  L('L1', 'Layout 1'),
  L('L7', 'Sample B', 'biophysics'),
  L('L2', 'Layout 2'),
  L('L6', 'Sample A', 'biophysics'),
  L('L4', 'CD8 APC', 'reference'),
  L('L8', 'Sample C', 'biophysics'),
];

const order = {
  controls: ['L3', 'L4'],
  bioSamples: ['L6', 'L7', 'L8'],
  cellTypes: 'L9',
};

describe('groupLayouts', () => {
  it('puts each kind in its own group, general first', () => {
    const g = groupLayouts(all, order);
    expect(g.general.map((l) => l.id)).toEqual(['L1', 'L2']);
    expect(g.reference.map((l) => l.id)).toEqual(['L3', 'L4']);
    expect(g.perSample.map((l) => l.id)).toEqual(['L6', 'L7', 'L8']);
    expect(g.cellTypes.map((l) => l.id)).toEqual(['L9']);
  });

  it('orders each generated group by its own panel’s walk, not by id', () => {
    // The point of the rank lists: the wizard's peak-detector order and the
    // pipeline's sample order are what their bottom strips walk, so the two
    // views of the list have to agree with the strip.
    const g = groupLayouts(all, { ...order, bioSamples: ['L8', 'L6', 'L7'] });
    expect(g.perSample.map((l) => l.id)).toEqual(['L8', 'L6', 'L7']);
  });

  it('holds the cell-type sheet out of the per-sample group by id, not by luck', () => {
    /*
       Before this module the two copies of the comparator ranked every
       biophysics layout against `samples.map(s => s.layoutId)`. The cell-type
       sheet's id lives in `immuneLayoutId`, so it matched nothing, fell to
       MAX_SAFE_INTEGER and sorted last — right, and right for a reason nobody
       had written down. Naming it makes that a property rather than a residue:
       drop it from the rank list and it must still be its own group.
    */
    const g = groupLayouts(all, { ...order, bioSamples: ['L6', 'L7', 'L8', 'L9'] });
    expect(g.perSample.map((l) => l.id)).toEqual(['L6', 'L7', 'L8']);
    expect(g.cellTypes.map((l) => l.id)).toEqual(['L9']);
  });

  it('is empty-safe before either panel has built anything', () => {
    const g = groupLayouts([L('L1', 'Layout 1')], { controls: [], bioSamples: [], cellTypes: null });
    expect(g.general.map((l) => l.id)).toEqual(['L1']);
    expect(g.reference).toEqual([]);
    expect(g.perSample).toEqual([]);
    expect(g.cellTypes).toEqual([]);
  });

  it('sorts a worksheet its panel has forgotten after the ones it has not', () => {
    // Real, and mid-rebuild: a layout whose owner no longer names it still has
    // to land somewhere total and stable rather than moving between renders.
    const g = groupLayouts(all, { ...order, bioSamples: ['L8'] });
    expect(g.perSample.map((l) => l.id)).toEqual(['L8', 'L6', 'L7']);
  });
});

describe('flattenLayoutGroups', () => {
  it('is the tab strip’s row, in the order the dropdown groups them', () => {
    expect(flattenLayoutGroups(groupLayouts(all, order)).map((l) => l.id))
      .toEqual(['L1', 'L2', 'L3', 'L4', 'L6', 'L7', 'L8', 'L9']);
  });
});
