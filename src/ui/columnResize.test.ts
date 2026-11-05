import { describe, expect, it } from 'vitest';
import {
  MIN_COLUMN_PX, minimaFor, resizeColumn, snapshotWidths, totalWidth,
} from './columnResize';

/** The statistics table's real shape: a wide Sample column and five narrower ones. */
const TABLE = [300, 160, 100, 100, 100, 140];
const MINS = TABLE.map(() => MIN_COLUMN_PX);

describe('resizeColumn', () => {
  it('keeps the total constant while there is slack, and grows by exactly the shortfall past it', () => {
    /*
       The property the whole model exists for, stated over every boundary and a
       spread of drag distances.

       While the columns to the right can absorb the drag, the table is exactly
       as wide as it was — which is what makes it impossible to push a column off
       the right edge. Past that point it grows by the part nothing could absorb
       and *only* that part, which is what makes the scrollbar's appearance
       proportional to the drag rather than a surprise.

       Both halves are asserted together deliberately. Asserting the invariant
       alone would have to stop at the boundary where it stops holding, and that
       boundary is precisely where the old behaviour started losing columns.
    */
    for (const dx of [-200, -60, -1, 0, 1, 40, 120, 260]) {
      for (let i = 0; i < TABLE.length - 1; i++) {
        const after = resizeColumn(TABLE, MINS, i, dx);
        const slackRight = TABLE.slice(i + 1).reduce((a, w) => a + (w - MIN_COLUMN_PX), 0);
        const shortfall = dx > 0 ? Math.max(0, dx - slackRight) : 0;
        expect(totalWidth(after)).toBe(totalWidth(TABLE) + shortfall);
        // And in every one of those cases, every column is still a column.
        for (const w of after) expect(w).toBeGreaterThanOrEqual(MIN_COLUMN_PX);
      }
    }
  });

  it('takes from the immediate neighbour first', () => {
    const after = resizeColumn(TABLE, MINS, 0, 40);
    expect(after[0]).toBe(340);
    expect(after[1]).toBe(120);
    // Nothing further along has moved: this is a boundary being pushed, not a
    // relayout of the table.
    expect(after.slice(2)).toEqual(TABLE.slice(2));
  });

  it('cascades past a neighbour that has reached its minimum', () => {
    /*
       160 → 56 is 104 px of slack in the immediate neighbour. The remaining 46
       comes from the column after it — which has only 44 to give before it hits
       its own floor, so the last 2 px come from the one after *that*. Three
       columns move for one drag, none of them below 56, and the total is
       untouched.
    */
    const after = resizeColumn(TABLE, MINS, 0, 150);
    expect(after).toEqual([450, 56, 56, 98, 100, 140]);
    expect(totalWidth(after)).toBe(totalWidth(TABLE));
  });

  it('never takes a column below its minimum, however far the drag goes', () => {
    const after = resizeColumn(TABLE, MINS, 0, 5000);
    for (let i = 1; i < after.length; i++) expect(after[i]).toBeGreaterThanOrEqual(MIN_COLUMN_PX);
  });

  it('lets the table exceed its container once every column is at its minimum', () => {
    /*
       The stated fallback, and the one case where the total is allowed to move.

       Slack to the right of column 0 is (160+100+100+100+140) − 5×56 = 320 px.
       Asking for 500 leaves 180 that nothing can give up, so the table grows by
       exactly that and the scroller takes over. What must *not* happen is a
       column vanishing — and every one is still present at its minimum.
    */
    const after = resizeColumn(TABLE, MINS, 0, 500);
    expect(after[0]).toBe(800);
    expect(after.slice(1)).toEqual([56, 56, 56, 56, 56]);
    expect(totalWidth(after)).toBe(totalWidth(TABLE) + 180);
    expect(after).toHaveLength(TABLE.length);
  });

  it('shrinks to its own minimum and hands the space to the neighbour', () => {
    const after = resizeColumn(TABLE, MINS, 0, -1000);
    expect(after[0]).toBe(MIN_COLUMN_PX);
    expect(after[1]).toBe(160 + (300 - MIN_COLUMN_PX));
    expect(totalWidth(after)).toBe(totalWidth(TABLE));
  });

  it('is reversible within a gesture, because it re-derives from the start', () => {
    // The reason the move handler passes the snapshot and the total dx rather
    // than the previous frame's widths: out and back must land exactly home,
    // including when the way out cascaded across three columns.
    expect(resizeColumn(TABLE, MINS, 0, 0)).toEqual(TABLE);
    const out = resizeColumn(TABLE, MINS, 0, 150);
    expect(out).not.toEqual(TABLE);
    expect(resizeColumn(TABLE, MINS, 0, 150 - 150)).toEqual(TABLE);
  });

  it('honours a per-column minimum that is not the default', () => {
    const mins = [120, 90, 56, 56, 56, 56];
    const after = resizeColumn(TABLE, mins, 0, 400);
    expect(after[1]).toBe(90);
    expect(after[0]).toBeGreaterThan(300);
    const shrunk = resizeColumn(TABLE, mins, 0, -400);
    expect(shrunk[0]).toBe(120);
  });

  it('refuses a boundary that does not exist', () => {
    // The last column has no handle, and an index off either end is a no-op
    // rather than an exception thrown out of a pointermove handler.
    expect(resizeColumn(TABLE, MINS, TABLE.length - 1, 50)).toEqual(TABLE);
    expect(resizeColumn(TABLE, MINS, -1, 50)).toEqual(TABLE);
    expect(resizeColumn(TABLE, MINS, 99, 50)).toEqual(TABLE);
  });

  it('never mutates its input and always returns every column', () => {
    const original = [...TABLE];
    const after = resizeColumn(TABLE, MINS, 2, 90);
    expect(TABLE).toEqual(original);
    expect(after).toHaveLength(TABLE.length);
  });

  it('handles a two-column table, where there is exactly one boundary', () => {
    expect(resizeColumn([200, 200], [56, 56], 0, 50)).toEqual([250, 150]);
    expect(resizeColumn([200, 200], [56, 56], 0, 500)).toEqual([700, 56]);
  });
});

describe('snapshotWidths', () => {
  it('raises a column the browser rendered below its minimum', () => {
    expect(snapshotWidths([20, 300], [56, 56])).toEqual([56, 300]);
  });

  it('reports the overflow rather than correcting it', () => {
    // Eight columns in a 300 px panel cannot all reach 56. The snapshot says so
    // — sum 448 against a 300 px container — and the table scrolls. Squeezing
    // one back under its minimum to make the arithmetic fit is the behaviour
    // being replaced.
    const rendered = Array.from({ length: 8 }, () => 37.5);
    const snap = snapshotWidths(rendered, Array.from({ length: 8 }, () => 56));
    expect(snap).toEqual(Array.from({ length: 8 }, () => 56));
    expect(totalWidth(snap)).toBe(448);
  });

  it('rounds, so a fractional rendered width cannot drift the total', () => {
    expect(snapshotWidths([100.4, 200.6], [56, 56])).toEqual([100, 201]);
  });
});

describe('minimaFor', () => {
  it('defaults every column and honours an explicit minimum', () => {
    expect(minimaFor([{}, { minWidth: 140 }, {}])).toEqual([MIN_COLUMN_PX, 140, MIN_COLUMN_PX]);
  });

  it('never yields a zero or negative minimum', () => {
    expect(minimaFor([{ minWidth: 0 }, { minWidth: -20 }])).toEqual([1, 1]);
  });
});
