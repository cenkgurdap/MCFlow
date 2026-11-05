import { describe, expect, it } from 'vitest';
import {
  NO_DRAG_SELECTOR, PLOT_CONTROL_SELECTOR, shouldMovePanel, type PanelDragProbe,
} from './panelDragTarget';

/* ==========================================================================
   What counts as "the panel's background".

   This has now been decided three times — the toolbar, then a 12 px rail, now
   the whole background with named exceptions — so it is worth being a function
   with a test rather than a shape of the DOM that has to be reasoned about.
   ========================================================================== */

const bg: PanelDragProbe = {
  primaryButton: true,
  onOwnGesture: false,
  toolArmed: false,
  naming: false,
};

describe('shouldMovePanel', () => {
  it('moves from plain background — margins, toolbar space, corners', () => {
    expect(shouldMovePanel(bg)).toBe(true);
  });

  it('moves from the plot area itself when no tool is armed', () => {
    // The refinement over the panel pass. A drag inside the plot used to mean
    // nothing at all once pan and zoom were removed, which is a large part of a
    // panel doing nothing with a gesture the user clearly meant.
    expect(shouldMovePanel(bg)).toBe(true);
  });

  it('does not move anywhere while a drawing tool is armed', () => {
    // **Reverses the previous pass's positional form of this clause.** It refused
    // a move only inside the data rectangle, leaving the axis margins as
    // drag-to-move — which is exactly where a gate gets started when the point of
    // starting there is not to clip the edge events. The lock has no position
    // qualifier now, so there is no pixel on the panel where an armed tool and a
    // panel move compete.
    expect(shouldMovePanel({ ...bg, toolArmed: true })).toBe(false);
  });

  it('leaves controls, resize handles and gates alone', () => {
    expect(shouldMovePanel({ ...bg, onOwnGesture: true })).toBe(false);
    expect(shouldMovePanel({ ...bg, onOwnGesture: true, toolArmed: true })).toBe(false);
  });

  it('ignores anything but the primary button', () => {
    expect(shouldMovePanel({ ...bg, primaryButton: false })).toBe(false);
  });

  it('yields to a gate waiting to be named', () => {
    expect(shouldMovePanel({ ...bg, naming: true })).toBe(false);
  });
});

describe('PLOT_CONTROL_SELECTOR', () => {
  it('is the chrome list without gates', () => {
    // A gate is an exception to *moving the panel* — a press on a gate is about
    // that gate. It is not an exception to *drawing*: with a tool armed the press is
    // about the new shape, and the old one is just what happens to be underneath.
    // Conflating the two made it impossible to draw a gate inside an existing one,
    // which is how every child population in a hierarchy is made.
    expect(PLOT_CONTROL_SELECTOR).toContain('button');
    expect(PLOT_CONTROL_SELECTOR).toContain('[data-resize-handle]');
    expect(PLOT_CONTROL_SELECTOR).not.toContain('[data-gate]');
    expect(NO_DRAG_SELECTOR).toContain('[data-gate]');
  });
});

describe('NO_DRAG_SELECTOR', () => {
  it('names the three exception classes the rule depends on', () => {
    // A gate's shapes and handles live under `[data-gate]`, including range
    // gates; the eight resize strips under `[data-resize-handle]`; every control
    // is a real `button` or field. If one of these ever stops being in the
    // selector, that whole class silently becomes drag-to-move.
    expect(NO_DRAG_SELECTOR).toContain('[data-gate]');
    expect(NO_DRAG_SELECTOR).toContain('[data-resize-handle]');
    expect(NO_DRAG_SELECTOR).toContain('button');
    expect(NO_DRAG_SELECTOR).toContain('input');
  });

  it('says nothing about individual event points', () => {
    // Deliberate: there is no click-to-inspect gesture, and the hover tooltip is
    // passive. A drag starting over a dense cloud is a panel move.
    expect(NO_DRAG_SELECTOR).not.toContain('event');
    expect(NO_DRAG_SELECTOR).not.toContain('canvas');
  });
});
