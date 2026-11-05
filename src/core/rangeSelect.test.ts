import { describe, expect, it } from 'vitest';
import { blockBetween, withBlock } from './rangeSelect';

const rows = ['a', 'b', 'c', 'd', 'e'];

describe('blockBetween', () => {
  it('takes both ends and everything between', () => {
    expect(blockBetween(rows, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('reads the same in either direction', () => {
    expect(blockBetween(rows, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('is one row when the anchor is the row clicked', () => {
    expect(blockBetween(rows, 'c', 'c')).toEqual(['c']);
  });

  it('has nothing to measure from without an anchor', () => {
    expect(blockBetween(rows, null, 'c')).toBeNull();
  });

  it('and none when the anchor has been filtered off the screen', () => {
    // The rows are what is shown, so an anchor that is not among them is the
    // same as no anchor: the click falls through to a plain one.
    expect(blockBetween(['c', 'd'], 'a', 'd')).toBeNull();
  });

  it('takes zero as an anchor rather than as absent — the first column is index 0', () => {
    expect(blockBetween([0, 1, 2, 3], 0, 2)).toEqual([0, 1, 2]);
  });
});

describe('withBlock', () => {
  it('adds the block, keeping what was already outside it', () => {
    expect(withBlock(['e'], ['b', 'c'], true)).toEqual(['e', 'b', 'c']);
  });

  it('removes the whole block when the anchor was off', () => {
    expect(withBlock(['a', 'b', 'c', 'e'], ['b', 'c'], false)).toEqual(['a', 'e']);
  });

  it('does not duplicate a member the selection already had', () => {
    expect(withBlock(['b', 'e'], ['b', 'c'], true)).toEqual(['e', 'b', 'c']);
  });

  it('leaves the selection alone when the block is already in the state asked for', () => {
    const before = ['b', 'c'];
    expect(withBlock(before, ['b', 'c'], true)).toEqual(['b', 'c']);
    expect(withBlock([], ['b', 'c'], false)).toEqual([]);
  });
});
