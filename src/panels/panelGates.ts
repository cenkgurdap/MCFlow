/**
 * Which gates a plot may draw.
 *
 * ## The bug this exists to fix (2026-08-10)
 *
 * A four-panel worksheet: CD4 dragged out of the tree to make a plot, with
 * Naive CD4 / TEMRA CD4 / CM CD4 drawn on it; CD8 dragged out separately to make
 * another. **The CD8 plot was drawing CD4's gates** — the shapes, the handles,
 * the names and the percentages — over CD8's events.
 *
 * The report called it gate state leaking between plots, and the fix is not
 * where that phrasing points: nothing was cached, nothing was shared by
 * reference, and every gate in the store was correct. The visibility rule was
 * the whole of it. A panel drew every gate whose `xParam`/`yParam` matched its
 * own axes, and both of those panels have the same axes **by construction**.
 * Two sibling populations plotted on one pair of markers is not an unlucky
 * coincidence; it is the normal shape of an immunophenotyping panel.
 *
 * That was true of the axis rule this was written against — `nextAxesFor` gave
 * two siblings the same inference because they share an ancestry — and it is
 * more true of the one that replaced it on 2026-08-12: a panel now opens on the
 * axes of the plot the gate was dragged **off**, so CD4 and CD8 dragged out of
 * the same CD3 plot inherit that plot's pair directly rather than arriving at
 * it separately.
 *
 * ## The rule
 *
 * **A scoped panel draws the gates whose parent is the population it is
 * plotting, and nothing else.**
 *
 * That is not a display convention, it is what makes the numbers on the plot
 * true. A gate's geometry selects a subset of *its parent's* events and its
 * caption is `percentOfParent`. Draw it over a different population and every
 * part of it is answering a question about events that are not on screen: the
 * boundary encloses the wrong cloud and the percentage is a fraction of a
 * denominator the plot does not contain. On the reported screen, "Naive CD4
 * 41.2%" sat over CD8 events, which reads as a result rather than as a glitch.
 *
 * ## Why unscoped panels are deliberately unchanged
 *
 * An unscoped panel (`populationId === null`) plots every event in the sample,
 * so it keeps showing every gate on its axes. Three reasons, and the third is
 * the one that decides it:
 *
 *  1. It is not wrong in the way the scoped case is. The events *are* all there,
 *     so a gate drawn over them encloses the cloud it was drawn around.
 *  2. It is how a strategy is built without dragging: `gateParentFor` nests a
 *     gate drawn on an unscoped panel under whatever is selected in the tree, so
 *     a strict rule here would make a user draw a gate and watch it vanish.
 *  3. Restricting it would make what an unscoped panel shows depend on the
 *     *tree selection*, which changes on every click in the sidebar — plots
 *     gaining and losing outlines as the user browses the hierarchy. That is a
 *     worse instrument than the one being fixed.
 *
 * Kept pure and store-free so the rule can be asserted directly. A rendered
 * assertion here would be measuring the SVG, and this project has recorded three
 * times over that a check on how something is drawn passes against a bug in what
 * is drawn.
 */

import type { Gate } from '@/core/gating/types';

/**
 * The gates a panel showing `populationId` may draw.
 *
 * `populationId` is the population the panel is **actually** plotting, which is
 * not always the one on its config: a scope pointing at a deleted gate falls
 * back to every event, and `PlotCanvas` resolves that before calling here. Pass
 * the resolved value or the two will disagree about a panel whose population no
 * longer exists — it would draw nothing at all, which looks like a broken plot.
 *
 * Returns the input array unchanged when there is nothing to filter, so the
 * common case (an unscoped panel) allocates nothing and a `useMemo` downstream
 * can compare by identity.
 */
export function gatesOnPanel(gates: Gate[], populationId: string | null): Gate[] {
  if (populationId === null) return gates;
  return gates.filter((g) => g.parentId === populationId);
}

/**
 * Which axis a plot draws a range gate against — `'x'`, `'y'`, or not at all.
 *
 * ## Why this exists (2026-08-20)
 *
 * A range gate is a **one-dimensional interval on one parameter**. That is the
 * whole of its model: `xParam`, `min`, `max`, and an `xSpec` naming the display
 * space the two bounds are in. Nothing in it says *vertical* — the name `xParam`
 * is about which parameter it cuts, not about where the line is painted.
 *
 * The renderer disagreed. It drew a range gate only where `g.xParam` matched the
 * panel's **x** parameter, so the same interval was visible on one plot and
 * absent from another showing the identical population, purely because of which
 * way round the two axes were. That surfaced as a report: the *Live* / *Dead*
 * split vanished from the cell-type worksheet's third plot the day it became a
 * trace with Time on x and the property on y (see `immunePanelsForSample`). The
 * gate was there, evaluated, counted in the tree and in Statistics — with no
 * boundary on the plot the numbers came from.
 *
 * So a range gate now draws as a **vertical band when its parameter is on x and
 * a horizontal band when it is on y**, and everything that follows from being
 * drawn — the handles, the hit test, the drag, dragging the population out to
 * open a child plot — follows on either axis. Only the painting generalises:
 * `evaluateFor` still reads `xParam` and knows nothing about this.
 *
 * **x wins a tie.** A parameter plotted against itself is a diagonal line, not a
 * mistake worth an error, and one band is the readable answer.
 *
 * **A histogram's y axis is normalised count**, not a parameter, so it can only
 * ever match on x — hence `oneDimensional`, passed rather than inferred, because
 * a histogram panel still carries whatever `yParam` it had before the plot type
 * changed.
 */
export function rangeAxisOn(
  gate: Gate,
  xParam: number,
  yParam: number,
  oneDimensional?: boolean,
): 'x' | 'y' | null {
  if (gate.kind !== 'range') return null;
  if (gate.xParam === xParam) return 'x';
  if (!oneDimensional && gate.xParam === yParam) return 'y';
  return null;
}
