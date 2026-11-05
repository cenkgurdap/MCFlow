/**
 * Dragging a gate shape: one gesture, two possible outcomes.
 *
 * Moving a gate inside its plot and dragging it out to open a new plot were
 * built as separate behaviours, and they fought. The move handler ran on every
 * pointer move unconditionally, so the shape simply followed the pointer off
 * the plot and the out-of-bounds case was never evaluated — which is why
 * dragging a gate out "did nothing". They are not two behaviours. They are two
 * phases of one gesture, separated by a single boundary test, so that test lives
 * here as a pure transition function rather than as conditionals scattered
 * through a pointer handler.
 *
 * The tree-node drag is a different thing entirely and stays where it is:
 * native HTML5 drag-and-drop in `dragPayload.ts`, because dragging a row
 * between panes is a transfer. This is pointer capture on a canvas, where every
 * intermediate coordinate matters. Two mechanisms, deliberately.
 */

export type GateDragPhase =
  /** Pointer is over the source plot: the drag moves the shape. */
  | 'moving'
  /** Pointer has left it: releasing opens a plot of this population. */
  | 'leaving';

export interface GateDragState {
  gateId: string;
  phase: GateDragPhase;
}

/** What the caller must do as a result of a transition. */
export interface GateDragEffect {
  /** Apply the move for this pointer position. */
  move: boolean;
  /**
   * Put the shape back where the drag started.
   *
   * Fired on the crossing out, once. A gate left halfway to the edge after a
   * drag that produced a new panel would be an edit the user never asked for
   * and would not connect to what they did.
   */
  restore: boolean;
  /** The boundary was just crossed, in either direction — update the cue. */
  crossed: boolean;
}

/**
 * Advance the machine for a pointer position.
 *
 * `inside` is the only input that matters: whether the pointer is still within
 * the panel that owns the gate. Measured against the whole panel including its
 * chrome, because a gate dragged over its own axis label has not left the plot
 * in any sense the user would recognise.
 */
export function onPointerMove(state: GateDragState, inside: boolean): {
  state: GateDragState;
  effect: GateDragEffect;
} {
  const next: GateDragPhase = inside ? 'moving' : 'leaving';
  const crossed = next !== state.phase;
  return {
    state: crossed ? { ...state, phase: next } : state,
    effect: {
      move: next === 'moving',
      // Only on the way out, and only once: re-restoring on every move outside
      // would fight nothing, but it would also write an identical gate to the
      // store sixty times a second.
      restore: crossed && next === 'leaving',
      crossed,
    },
  };
}

/** What releasing the pointer means. */
export function onPointerUp(state: GateDragState): 'commit-move' | 'open-panel' {
  // Re-entering the source plot before release reverts to a plain move — the
  // shape is already where the last in-bounds move put it, so there is nothing
  // further to do.
  return state.phase === 'leaving' ? 'open-panel' : 'commit-move';
}

export function beginGateDrag(gateId: string): GateDragState {
  // Always starts as a move. A gesture that began outside the plot is not
  // possible: the pointer had to be on the shape to grab it.
  return { gateId, phase: 'moving' };
}

/** Is a point inside this rectangle? Extracted so the test needs no DOM. */
export function withinRect(
  p: { clientX: number; clientY: number },
  r: { left: number; right: number; top: number; bottom: number },
): boolean {
  return p.clientX >= r.left && p.clientX <= r.right && p.clientY >= r.top && p.clientY <= r.bottom;
}
