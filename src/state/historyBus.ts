/**
 * The one function a store calls to say "the user is about to change something".
 *
 * A leaf module with no imports, and that is its whole reason for existing.
 * `historyStore` has to read every store to take a snapshot, so if the stores
 * imported it back the graph would close into a cycle and the store that
 * happened to evaluate first would see a half-initialised partner. Recording
 * goes out through this slot instead; snapshotting comes in through the direct
 * imports. One direction each.
 *
 * Until `historyStore` is loaded this is a no-op, which is correct for a test
 * that exercises a store on its own and does not want a history stack.
 */

export type Recorder = (label: string, coalesceKey?: string) => void;

const NOOP: Recorder = () => {};

let recorder: Recorder = NOOP;

/**
 * Depth of the compound action currently being recorded. See `step`.
 *
 * Declared here rather than beside `step` because `record` reads it, and a
 * module-level `let` used before its declaration is a temporal-dead-zone throw
 * rather than an `undefined`.
 */
let suppressed = 0;

/** Called by `historyStore` on import. Returns a function to detach again. */
export function setRecorder(fn: Recorder): () => void {
  recorder = fn;
  return () => { recorder = NOOP; };
}

/**
 * A second listener on the same signal, for the unsaved-changes flag.
 *
 * Separate from `setRecorder` rather than folded into it because the two answer
 * different questions and are cleared by different events: the history stack is
 * reset when a workspace loads, and the dirty flag is cleared when one is
 * *saved*. Sharing the slot would make one of them a side effect of the other.
 * Same signal, though — see `dirtyStore`.
 */
export type DirtyMarker = () => void;

const NO_MARK: DirtyMarker = () => {};

let marker: DirtyMarker = NO_MARK;

export function setDirtyMarker(fn: DirtyMarker): () => void {
  marker = fn;
  return () => { marker = NO_MARK; };
}

/**
 * Note the state before a change, under a name the user would recognise.
 *
 * Always called *before* the mutation — after it, the state worth returning to
 * no longer exists. `coalesceKey` marks a continuous gesture: consecutive calls
 * sharing a key fold into the single entry the gesture started from, which is
 * what stops a dragged gate from filling the stack with sixty identical steps.
 */
export function record(label: string, coalesceKey?: string): void {
  // Inside a `step`, the snapshot has already been taken and the writes since
  // then are part of the same action. The dirty flag is still marked: a
  // compound action changes the workspace exactly as much as a simple one.
  if (suppressed > 0) { marker(); return; }
  recorder(label, coalesceKey);
  marker();
}

/**
 * One undo step for an action that is several store writes (2026-08-14).
 *
 * ## The problem it solves
 *
 * `coalesceKey` folds *consecutive calls sharing a key* into one entry, which is
 * exactly right for a drag — sixty `updateGate` calls, one key, one step. It
 * does nothing for a compound action, because the writes inside one do not share
 * a key and were never meant to: the Biophysics pipeline's re-fit removes the
 * old population gates and adds the new ones, so the stack fills with *Fit
 * populations*, *Delete gate*, *Delete gate*, *Add gate*, *Add gate*, *Add gate*
 * — six presses of Ctrl+Z to reverse one press of a button, and the first five
 * of them leaving the panel describing gates that are no longer there.
 *
 * The measurement that found it: a re-fit from two populations to three took the
 * strategy from 10 gates to 11, and one undo left it at 8.
 *
 * ## The rule
 *
 * > Everything written between `record` and the end of the callback is one
 * > action, snapshotted from the state before the first write.
 *
 * The outer `record` takes the snapshot; the inner ones are suppressed. It is
 * **not** a transaction — nothing is rolled back if the callback throws, and the
 * writes are visible as they happen — which is why the name says *step* rather
 * than *transaction*. What it decides is where an undo boundary is, and that is
 * all it decides.
 *
 * Re-entrant, so a compound action built from another one is still one step; the
 * outermost `record` is the one that lands. Restores on the way out even if the
 * callback throws, because a suppressed recorder that stayed suppressed would
 * silently stop the undo stack for the rest of the session.
 */
export function step<T>(label: string, fn: () => T, coalesceKey?: string): T {
  if (suppressed > 0) return fn();
  record(label, coalesceKey);
  suppressed++;
  try {
    return fn();
  } finally {
    suppressed--;
  }
}

/** Whether a real history stack is listening. Asserted in tests. */
export function isRecording(): boolean {
  return recorder !== NOOP;
}
