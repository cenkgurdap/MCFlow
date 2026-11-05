/**
 * Moving one item of a list to another position.
 *
 * A pure function with its own tests because the off-by-one is real and is not
 * visible by reading: removing the item first shifts every index above it down
 * by one, so "drop it at index 4" means two different final positions depending
 * on whether it started above or below 4. Getting that wrong produces a drag
 * that moves a row *almost* where it was aimed, which reads as the list being
 * unreliable rather than as a bug.
 *
 * The convention here is **the target index in the original list**: dropping row
 * 1 onto row 4 puts it where row 4 was, and row 4 moves up. That is what a
 * pointer released over a row means, and it is what the up/down arrows compose
 * with — `to = from ± 1` swaps a pair in either direction.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.min(list.length - 1, Math.max(0, to));
  if (target === from) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/* -------------------------------------------------------------------------
   Moving several items at once
   -------------------------------------------------------------------------

   Everything below generalises `moveItem` to a *set* of positions, and it is a
   generalisation rather than a parallel implementation: handed one index, each
   of these produces exactly what `moveItem` produces, and the tests assert that
   directly over every from/to pair in a five-item list. A second reordering
   convention living beside the first is how a drag and an arrow key end up
   disagreeing about what "one place down" means.

   Two properties define what a block move is, and both come from how every file
   manager behaves:

     1. **The block gathers.** A non-contiguous selection — rows 1, 4 and 5 —
        arrives at the destination as three adjacent rows. There is no way to
        move them apart-but-shifted that means anything, and every product that
        has tried reads as a bug.

     2. **Relative order is preserved**, by list position and not by the order
        the rows were clicked. Ctrl-clicking 5 then 1 and pressing Up must not
        silently swap them; the selection is a set, and the list's own order is
        the only order it has.

   The implementation is one idea repeated: take the moving items out, leaving
   `rest`, and decide a single insertion point in `rest`. Every off-by-one lives
   in that decision rather than being spread across a splice loop, and `rest` is
   also what makes the bounds checks trivial — a block is at the top exactly when
   no unselected row is above it.
*/

/** Sorted, de-duplicated, in-range positions. The order clicks arrived in is not an order. */
function positions(from: readonly number[], length: number): number[] {
  return [...new Set(from)].filter((i) => Number.isInteger(i) && i >= 0 && i < length).sort((a, b) => a - b);
}

/** Split into the items being moved (in list order) and everything else. */
function split<T>(list: readonly T[], moving: readonly number[]): { block: T[]; rest: T[] } {
  const set = new Set(moving);
  const block: T[] = [];
  const rest: T[] = [];
  list.forEach((item, i) => (set.has(i) ? block : rest).push(item));
  return { block, rest };
}

/**
 * Move a set of positions so they sit together at `to`.
 *
 * `to` is an index into the **original** list — the same convention `moveItem`
 * uses, so dropping a selection onto a row puts the block where that row was and
 * pushes the row clear of it. Dropping a selection onto one of its own members
 * is a no-op rather than an approximation of one.
 */
export function moveBlock<T>(list: readonly T[], from: readonly number[], to: number): T[] {
  const moving = positions(from, list.length);
  if (moving.length === 0) return [...list];
  if (moving.length === 1) return moveItem(list, moving[0]!, to);

  const target = Math.min(list.length - 1, Math.max(0, to));
  const set = new Set(moving);
  // Released over a row that is itself being dragged. There is no coherent
  // destination in that, and moving the block somewhere *near* it is worse than
  // leaving the list alone.
  if (set.has(target)) return [...list];

  const { block, rest } = split(list, moving);
  // How many survivors sit above the target — which is the target's own index in
  // `rest`, since the target is not one of the moving rows.
  let before = 0;
  for (let i = 0; i < target; i++) if (!set.has(i)) before++;

  /*
     Below the target, or above it.

     Measured from the block's **first** row, which is what keeps this identical
     to `moveItem` at one index. A block dropped downward lands after the target
     — the target rises past it, exactly as a single row's does — and a block
     dropped upward lands on the target's own slot and pushes it down.
  */
  const at = target > moving[0]! ? before + 1 : before;
  const next = [...rest];
  next.splice(at, 0, ...block);
  return next;
}

/**
 * Move a set of positions one place up (−1) or down (+1), as a block.
 *
 * "One place" is one place **among the rows that are not moving**, which is the
 * only definition that survives a non-contiguous selection: rows 1 and 3 moving
 * down by one is not "each row +1" — that would leave row 2 straddling them and
 * put row 3 where row 4 is, moving one row past two. The block leaves, and
 * re-enters one survivor further along.
 */
export function moveBlockBy<T>(list: readonly T[], from: readonly number[], delta: number): T[] {
  const moving = positions(from, list.length);
  if (moving.length === 0 || delta === 0) return [...list];

  const { block, rest } = split(list, moving);
  const slot = slotOf(moving, rest.length);
  const at = Math.min(rest.length, Math.max(0, slot + delta));
  if (at === slot) return [...list];

  const next = [...rest];
  next.splice(at, 0, ...block);
  return next;
}

/**
 * Whether a block can move that way at all — what the arrow buttons disable on.
 *
 * Asked of the block rather than of a row, which is the whole point: the top row
 * of a three-row selection is not at the top of the list, and disabling Up on
 * the strength of its own index would leave a selection that cannot move while
 * showing no reason why.
 */
export function canMoveBlock(length: number, from: readonly number[], delta: number): boolean {
  const moving = positions(from, length);
  if (moving.length === 0 || delta === 0) return false;
  const rest = length - moving.length;
  const slot = slotOf(moving, rest);
  return Math.min(rest, Math.max(0, slot + delta)) !== slot;
}

/** The block's current insertion point among the rows it is not part of. */
function slotOf(moving: readonly number[], restLength: number): number {
  const first = moving[0] ?? 0;
  // Every index below the first moving row that is not itself moving — and none
  // are, since `first` is the smallest.
  return Math.min(restLength, first);
}
