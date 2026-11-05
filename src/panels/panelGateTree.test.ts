import { describe, expect, it } from 'vitest';
import { mergeControlTrees, type ControlEvaluation } from './panelGateTree';
import { ROOT_ID, type Gate, type PopulationStats } from '@/core/gating/types';

function range(id: string, name: string, owner?: string): Gate {
  return {
    id,
    name,
    parentId: 'cells',
    colorIndex: 1,
    kind: 'range',
    xParam: 40,
    min: 1,
    max: Number.POSITIVE_INFINITY,
    ...(owner ? { ownerSampleId: owner } : {}),
  } as Gate;
}

const cells: Gate = {
  id: 'cells',
  name: 'Cells',
  parentId: null,
  colorIndex: 0,
  kind: 'rectangle',
  xParam: 36,
  yParam: 18,
  xMin: 0, xMax: 1, yMin: 0, yMax: 1,
} as Gate;

function stat(count: number): PopulationStats {
  return { count, percentOfParent: 50, percentOfTotal: 25 } as PopulationStats;
}

/** One control's evaluation: the shared gate plus its own, with its own numbers. */
function control(sampleId: string, own: Gate, counts: Record<string, number>): ControlEvaluation {
  return {
    sampleId,
    gates: [cells, own],
    stats: new Map(Object.entries(counts).map(([id, n]) => [id, stat(n)])),
    errors: new Map(),
  };
}

describe('mergeControlTrees', () => {
  const a = control('cd3', range('g-cd3', 'CD3 RY703 +', 'cd3'), { [ROOT_ID]: 68224, cells: 55000, 'g-cd3': 11000 });
  const b = control('cd4', range('g-cd4', 'CD4 RB744 +', 'cd4'), { [ROOT_ID]: 68698, cells: 54243, 'g-cd4': 10848 });
  const c = control('cd8', range('g-cd8', 'CD8 PerCP +', 'cd8'), { [ROOT_ID]: 64561, cells: 51000, 'g-cd8': 9000 });

  it('lists every control gate, not just the leading one', () => {
    const merged = mergeControlTrees([a, b, c]);
    expect(merged.gates.map((g) => g.id)).toEqual(['cells', 'g-cd3', 'g-cd4', 'g-cd8']);
  });

  it('keeps each control gate in the order the controls were given', () => {
    const merged = mergeControlTrees([c, a, b]);
    expect(merged.gates.map((g) => g.id)).toEqual(['cells', 'g-cd8', 'g-cd3', 'g-cd4']);
  });

  it('lists a shared gate once, however many controls carry it', () => {
    const merged = mergeControlTrees([a, b, c]);
    expect(merged.gates.filter((g) => g.id === 'cells')).toHaveLength(1);
  });

  it('reports each owned gate against its own file', () => {
    const merged = mergeControlTrees([a, b, c]);
    expect(merged.stats.get('g-cd3')?.count).toBe(11000);
    expect(merged.stats.get('g-cd4')?.count).toBe(10848);
    expect(merged.stats.get('g-cd8')?.count).toBe(9000);
  });

  it('reports shared rows against the control that leads — the one on screen', () => {
    expect(mergeControlTrees([a, b, c]).stats.get('cells')?.count).toBe(55000);
    expect(mergeControlTrees([b, a, c]).stats.get('cells')?.count).toBe(54243);
    // And the root with it, so "All events" is the file the worksheet is about.
    expect(mergeControlTrees([b, a, c]).stats.get(ROOT_ID)?.count).toBe(68698);
  });

  it('never adopts a gate belonging to a different sample', () => {
    // A malformed evaluation: `resolveGates` would have filtered this out, so if
    // one ever arrives it is a bug upstream and must not become a tree row that
    // counts another file's events under this control's name.
    const stray: ControlEvaluation = {
      sampleId: 'cd3',
      gates: [cells, range('g-other', 'CD8 PerCP +', 'cd8')],
      stats: new Map([['g-other', stat(1)]]),
      errors: new Map(),
    };
    expect(mergeControlTrees([stray]).gates.map((g) => g.id)).toEqual(['cells']);
  });

  it('is empty for no controls', () => {
    expect(mergeControlTrees([]).gates).toEqual([]);
  });
});
