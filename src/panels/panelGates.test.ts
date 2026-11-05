import { describe, expect, it } from 'vitest';
import { gatesOnPanel } from './panelGates';
import type { Gate } from '@/core/gating/types';

/**
 * The hierarchy from the bug report, in the shape that produced it.
 *
 * Cells → CD3 → { CD4, CD8 }, with CD4 carrying two children of its own. Every
 * gate below CD3 is drawn on the **same parameter pair** (45 × 60), which is not
 * contrived: two panels dragged out of sibling populations are given identical
 * axes by construction. That held under the ancestry inference this was written
 * against, and holds more directly since 2026-08-12 — a dragged population now
 * opens on the axes of the plot it came off, and CD4 and CD8 come off the same
 * CD3 plot.
 */
function gate(id: string, parentId: string | null, xParam = 45, yParam = 60): Gate {
  return {
    id,
    name: id,
    parentId,
    colorIndex: 0,
    kind: 'rectangle',
    xParam,
    yParam,
    xMin: 0, xMax: 1, yMin: 0, yMax: 1,
  } as Gate;
}

const cells = gate('Cells', null, 36, 18);
const cd3 = gate('CD3', 'Cells');
const cd4 = gate('CD4', 'CD3');
const cd8 = gate('CD8', 'CD3');
const naiveCd4 = gate('Naive CD4', 'CD4');
const temraCd4 = gate('TEMRA CD4', 'CD4');
const naiveCd8 = gate('Naive CD8', 'CD8');

const all = [cells, cd3, cd4, cd8, naiveCd4, temraCd4, naiveCd8];

describe('gatesOnPanel', () => {
  it('is the reported bug: a CD8 plot does not draw CD4’s gates', () => {
    const shown = gatesOnPanel(all, 'CD8').map((g) => g.id);
    expect(shown).toEqual(['Naive CD8']);
    expect(shown).not.toContain('Naive CD4');
    expect(shown).not.toContain('TEMRA CD4');
  });

  it('and the CD4 plot keeps its own, which is the half that must not regress', () => {
    expect(gatesOnPanel(all, 'CD4').map((g) => g.id)).toEqual(['Naive CD4', 'TEMRA CD4']);
  });

  it('shows a population’s children rather than its whole subtree', () => {
    // CD3's panel gets CD4 and CD8 and stops there. A grandchild's boundary is a
    // subset of a population this plot is not drawing, and its percentage is a
    // fraction of that population rather than of what is on screen.
    expect(gatesOnPanel(all, 'CD3').map((g) => g.id)).toEqual(['CD4', 'CD8']);
  });

  it('does not draw the panel’s own scope gate', () => {
    // Re-plotting a population against the pair that defined it draws a box
    // filled corner to corner — the panel is already inside it. `CD4`'s parent
    // is CD3, so it is not among CD4's own panel's gates.
    expect(gatesOnPanel(all, 'CD4').map((g) => g.id)).not.toContain('CD4');
  });

  it('leaves an unscoped panel exactly as it was, by identity', () => {
    // Not merely equal: the same array. An unscoped panel is the pre-drag
    // workflow and the common case, and a fresh array here would re-run every
    // downstream `useMemo` on every render.
    expect(gatesOnPanel(all, null)).toBe(all);
  });

  it('is empty for a population with no children, rather than falling back', () => {
    // A plot of a terminal population has no gates to draw. Falling back to
    // "everything on these axes" is precisely the behaviour being removed.
    expect(gatesOnPanel(all, 'Naive CD8')).toEqual([]);
  });

  it('keeps the unmixing worksheet’s histogram working', () => {
    // The generated histogram panel is scoped to the general gate and its seeded
    // positive/negative range gates are children of it, so the wizard's own
    // worksheets satisfy this rule already — which is why it could be applied
    // without touching them.
    const general = gate('general', null, 36, 18);
    const positive = { ...gate('CD4 RB744 +', 'general', 40), kind: 'range', min: 1, max: Infinity } as unknown as Gate;
    expect(gatesOnPanel([general, positive], 'general').map((g) => g.id)).toEqual(['CD4 RB744 +']);
  });
});
