import { describe, expect, it } from 'vitest';
import { canMoveBlock, moveBlock, moveBlockBy, moveItem } from './reorder';

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];

  it('moves an item down to the target’s original position', () => {
    // 'a' onto where 'd' was: 'd' ends up above it.
    expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a', 'e']);
  });

  it('moves an item up to the target’s original position', () => {
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c', 'e']);
  });

  it('swaps a neighbouring pair in either direction', () => {
    // What the up/down arrows do, and the reason the convention is "the target's
    // index": one step has to be reversible by one step the other way.
    const down = moveItem(list, 1, 2);
    expect(down).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(moveItem(down, 2, 1)).toEqual(list);
  });

  it('is a no-op when the item is already there', () => {
    expect(moveItem(list, 2, 2)).toEqual(list);
  });

  it('clamps a target past either end rather than dropping the item', () => {
    expect(moveItem(list, 0, -5)).toEqual(list);
    expect(moveItem(list, 0, 99)).toEqual(['b', 'c', 'd', 'e', 'a']);
  });

  it('leaves the list alone when the source does not exist', () => {
    expect(moveItem(list, -1, 2)).toEqual(list);
    expect(moveItem(list, 9, 2)).toEqual(list);
  });

  it('never mutates its input', () => {
    const original = [...list];
    moveItem(list, 0, 4);
    expect(list).toEqual(original);
  });

  it('handles a one-item and an empty list', () => {
    expect(moveItem(['only'], 0, 3)).toEqual(['only']);
    expect(moveItem([], 0, 0)).toEqual([]);
  });
});

describe('moveBlock', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];

  /*
     The equivalence that keeps one convention rather than two.

     A drag and an arrow key both reach these functions, and until this pass
     `moveItem` was the only one either could reach. If a one-row block did not
     land exactly where `moveItem` puts it, the app would move a row differently
     depending on whether anything else happened to be selected — over the whole
     from/to space, which is not something anybody would find by trying it.
  */
  it('is exactly moveItem when one position is moving', () => {
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to < list.length; to++) {
        expect(moveBlock(list, [from], to)).toEqual(moveItem(list, from, to));
      }
    }
  });

  it('moves a contiguous pair down onto the target’s position', () => {
    // 'a','b' onto where 'd' was: 'c' and 'd' rise past them, the pair stays a pair.
    expect(moveBlock(list, [0, 1], 3)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('moves a contiguous pair up onto the target’s position', () => {
    expect(moveBlock(list, [3, 4], 1)).toEqual(['a', 'd', 'e', 'b', 'c']);
  });

  it('gathers a non-contiguous selection at the destination', () => {
    // 'a' and 'd' arrive adjacent. There is no reading of "move these two" that
    // keeps the two rows between them where they were.
    expect(moveBlock(list, [0, 3], 4)).toEqual(['b', 'c', 'e', 'a', 'd']);
  });

  it('keeps list order within the block, not the order positions were given', () => {
    // Ctrl-clicking 'd' then 'a' must not reverse them on the way.
    expect(moveBlock(list, [3, 0], 4)).toEqual(moveBlock(list, [0, 3], 4));
  });

  it('is a no-op when the target is part of the block', () => {
    expect(moveBlock(list, [1, 2], 2)).toEqual(list);
    expect(moveBlock(list, [0, 3], 3)).toEqual(list);
  });

  it('clamps a target past either end rather than dropping the block', () => {
    expect(moveBlock(list, [0, 1], 99)).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(moveBlock(list, [3, 4], -9)).toEqual(['d', 'e', 'a', 'b', 'c']);
  });

  it('ignores positions that do not exist, and does nothing given none', () => {
    expect(moveBlock(list, [0, 99, -3], 2)).toEqual(moveItem(list, 0, 2));
    expect(moveBlock(list, [], 2)).toEqual(list);
  });

  it('never mutates its input', () => {
    const original = [...list];
    moveBlock(list, [0, 2], 4);
    expect(list).toEqual(original);
  });

  it('keeps every item exactly once, for any selection and any target', () => {
    const subsets = [[0], [1, 2], [0, 4], [1, 3, 4], [0, 1, 2, 3, 4]];
    for (const from of subsets) {
      for (let to = 0; to < list.length; to++) {
        expect([...moveBlock(list, from, to)].sort()).toEqual([...list].sort());
      }
    }
  });
});

describe('moveBlockBy', () => {
  const list = ['a', 'b', 'c', 'd', 'e'];

  it('is exactly moveItem when one position is moving', () => {
    for (let from = 0; from < list.length; from++) {
      for (const delta of [-1, 1]) {
        expect(moveBlockBy(list, [from], delta)).toEqual(moveItem(list, from, from + delta));
      }
    }
  });

  it('moves a contiguous block one place in either direction', () => {
    expect(moveBlockBy(list, [1, 2], 1)).toEqual(['a', 'd', 'b', 'c', 'e']);
    expect(moveBlockBy(list, [1, 2], -1)).toEqual(['b', 'c', 'a', 'd', 'e']);
  });

  it('is reversible one step at a time', () => {
    const down = moveBlockBy(list, [0, 1], 1);
    expect(down).toEqual(['c', 'a', 'b', 'd', 'e']);
    expect(moveBlockBy(down, [1, 2], -1)).toEqual(list);
  });

  it('moves a non-contiguous selection past one survivor, not one index', () => {
    /*
       'a' and 'c' down by one.

       The index reading would be "each row +1", putting 'a' at 1 and 'c' at 3 —
       which moves 'c' past 'd' while 'a' moves past 'b', two rows of travel for
       one keystroke, and leaves 'b' between them. One place means one *survivor*:
       the block leaves, and re-enters after 'b'.
    */
    expect(moveBlockBy(list, [0, 2], 1)).toEqual(['b', 'a', 'c', 'd', 'e']);
  });

  it('stops at the ends instead of wrapping or dropping rows', () => {
    expect(moveBlockBy(list, [0, 1], -1)).toEqual(list);
    expect(moveBlockBy(list, [3, 4], 1)).toEqual(list);
    // A non-contiguous block is at the top when nothing unselected is above it.
    expect(moveBlockBy(list, [0, 2], -1)).toEqual(list);
  });

  it('does nothing when everything is selected', () => {
    expect(moveBlockBy(list, [0, 1, 2, 3, 4], 1)).toEqual(list);
    expect(moveBlockBy(list, [0, 1, 2, 3, 4], -1)).toEqual(list);
  });
});

describe('canMoveBlock', () => {
  it('answers for the block, not for one row of it', () => {
    // 'b','c' selected: the block can go both ways even though 'c' is not last
    // and 'b' is not first — and this is the case the row-by-row check got wrong,
    // disabling Up on a selection whose top row was merely not row 0.
    expect(canMoveBlock(5, [1, 2], -1)).toBe(true);
    expect(canMoveBlock(5, [1, 2], 1)).toBe(true);
  });

  it('refuses at the ends', () => {
    expect(canMoveBlock(5, [0, 1], -1)).toBe(false);
    expect(canMoveBlock(5, [3, 4], 1)).toBe(false);
    // Nothing unselected is above 'a', so there is nowhere up to go — even
    // though gathering 'a' and 'c' would still change the list. An arrow that
    // says "move up" and reorders without moving the block up is worse than one
    // that does nothing.
    expect(canMoveBlock(5, [0, 2], -1)).toBe(false);
  });

  it('allows a non-contiguous block to gather downward past a survivor', () => {
    // 'c' and 'e' with 'd' between them. The block is not at the bottom: 'd' is
    // a survivor below part of it, so Down is a real move — [a,b,d,c,e]. Only a
    // selection whose members are already adjacent *and* last is at the end.
    expect(canMoveBlock(5, [2, 4], 1)).toBe(true);
    expect(moveBlockBy(['a', 'b', 'c', 'd', 'e'], [2, 4], 1)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });

  it('refuses when there is nothing to move past', () => {
    expect(canMoveBlock(3, [0, 1, 2], 1)).toBe(false);
    expect(canMoveBlock(5, [], 1)).toBe(false);
    expect(canMoveBlock(1, [0], 1)).toBe(false);
  });

  it('agrees with moveBlockBy on every selection of a five-item list', () => {
    // The disabled state and the action must never disagree: a button that is
    // enabled and does nothing is the defect this pair exists to rule out.
    const list = ['a', 'b', 'c', 'd', 'e'];
    const subsets = [[0], [4], [1, 2], [0, 4], [1, 3, 4], [0, 2, 4], [0, 1, 2, 3, 4]];
    for (const from of subsets) {
      for (const delta of [-1, 1]) {
        const moved = moveBlockBy(list, from, delta);
        expect(canMoveBlock(list.length, from, delta)).toBe(!moved.every((v, i) => v === list[i]));
      }
    }
  });
});
