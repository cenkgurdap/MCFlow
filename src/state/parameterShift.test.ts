import { beforeEach, describe, expect, it } from 'vitest';
import { attachUnmixed, detachUnmixed } from '@/core/unmixedColumns';
import type { ParsedFcs } from '@/core/fcs/types';
import type { Gate } from '@/core/gating/types';
import type { TransformSpec } from '@/core/transform/types';
import { parametersFor, useDerived } from './derivedStore';
import { evaluateFor, useGates } from './gateStore';
import { makePanel, usePlot } from './plotStore';
import { useHistory } from './historyStore';
import { useStatisticsPrefs } from './statisticsPrefs';
import { useWorkspace, type Sample } from './workspaceStore';

/* ==========================================================================
   2026-10-28 — a derived parameter added after gating moved every gate.

   The report: *"I gated a sample, then added MT potential through an equation,
   and the Live/Dead plot's axis became MT potential and every gate moved."* The
   parameter list is real → derived → unmixed, so adding a definition moves every
   abundance's index up one; nothing followed them. And a column cache keyed on
   the index alone kept answering with what the index had meant before, which
   is the same mechanism that left every abundance gate empty after a workspace
   was reopened.

   The sample is synthetic and small on purpose — three detectors, three
   abundances with values that make each gate's count obvious — because every
   claim below is about which parameter an index names, not about the data.
   ========================================================================== */

const REAL = 3;
const N = 100;
const LINEAR: TransformSpec = { kind: 'linear', range: 1000 };

function fakeParsed(): ParsedFcs {
  return {
    metadata: {
      parameters: Array.from({ length: REAL }, (_, i) => ({
        index: i + 1, name: `D${i + 1}`, stain: '', label: `D${i + 1}`, bits: 32, range: 1000,
        amplification: [0, 0] as [number, number], gain: null, voltage: null,
        type: 'Raw_Fluorescence', isDataChannel: true,
      })),
      eventCount: N,
      keywords: {},
    },
    // Every detector reads i, so a derived expression over them is defined.
    data: Float32Array.from({ length: REAL * N }, (_, k) => k % N),
  } as unknown as ParsedFcs;
}

/** Live/Dead reads 0..99, CD3 reads 99..0, CD4 reads 0..9 repeating. */
function attach(parsed: ParsedFcs): void {
  const data = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) {
    data[i] = i;
    data[N + i] = N - 1 - i;
    data[2 * N + i] = i % 10;
  }
  attachUnmixed(parsed, { data, eventCount: N, labels: ['LiveDead', 'CD3', 'CD4'], columns: [0, 1, 2] });
}

const LIVE = REAL;       // the first abundance, with no derived parameter
const CD3 = REAL + 1;
const CD4 = REAL + 2;

let parsed: ParsedFcs;

function labelOf(index: number): string {
  const p = parametersFor(parsed, useDerived.getState().defs)[index];
  return p ? (p.label || p.name) : `missing #${index}`;
}

/** What the reader sees: each gate's parameters by name, and its count. */
function picture() {
  const gates = useGates.getState().gatesFor('s1');
  const ev = evaluateFor('s1', parsed, gates, () => LINEAR);
  return {
    gates: gates.map((g) => ({
      name: g.name,
      on: g.kind === 'range' ? labelOf(g.xParam) : `${labelOf(g.xParam)} x ${labelOf(g.yParam)}`,
      count: ev.stats.get(g.id)!.count,
    })),
    panels: usePlot.getState().panels.map((p) => `${labelOf(p.xParam)} x ${labelOf(p.yParam)}`),
    statistic: labelOf(useStatisticsPrefs.getState().statParam),
  };
}

beforeEach(() => {
  parsed = fakeParsed();
  attach(parsed);
  useWorkspace.setState({ samples: [{ id: 's1', name: 's1', parsed } as unknown as Sample] });
  useDerived.setState({ defs: [] });
  const live: Gate = { id: 'live', name: 'Live', parentId: null, colorIndex: 0, kind: 'range',
    xParam: LIVE, xSpec: LINEAR, min: 0, max: 39.5 };
  const pos: Gate = { id: 'pos', name: 'CD3+CD4+', parentId: 'live', colorIndex: 1, kind: 'rectangle',
    xParam: CD3, yParam: CD4, xSpec: LINEAR, ySpec: LINEAR, xMin: 70, xMax: 100, yMin: 4.5, yMax: 10 };
  useGates.setState({ shared: [live, pos], divergent: {}, overrides: {} });
  usePlot.getState().setLayouts([{
    id: 'main', name: 'Main', columns: 1, activePanelId: 'p1',
    panels: [makePanel({ id: 'p1', xParam: LIVE, yParam: 0, initialisedFor: 's1' })],
  }], 'main');
  useStatisticsPrefs.setState({ statParam: CD4 });
  useHistory.getState().reset();
});

describe('adding a derived parameter after gating', () => {
  it('leaves every gate, plot and the statistic on the parameter it was on', () => {
    const before = picture();
    expect(before.gates.map((g) => g.on)).toEqual(['LiveDead', 'CD3 x CD4']);
    // 40 events in 0..39, of which those with i in 0..29 have CD3 = 99 - i >= 70,
    // and of those the CD4 = i % 10 >= 5 half: 15.
    expect(before.gates.map((g) => g.count)).toEqual([40, 15]);

    useDerived.getState().addDef('MT potential', '(D1 - D2)/(D1 + D2)');

    expect(picture()).toEqual(before);
  });

  it('comes back on one undo, the definition and the remap together', () => {
    const before = picture();
    const gatesBefore = useGates.getState().shared;
    useDerived.getState().addDef('MT potential', '(D1 - D2)/(D1 + D2)');
    useHistory.getState().undo();
    expect(useDerived.getState().defs).toEqual([]);
    expect(useGates.getState().shared).toEqual(gatesBefore);
    expect(picture()).toEqual(before);
  });
});

describe('removing a derived parameter', () => {
  it('moves everything past it back down, unchanged on screen', () => {
    useDerived.getState().addDef('First', 'D1 + D2');
    useDerived.getState().addDef('Second', 'D1 - D2');
    const before = picture();
    useDerived.getState().removeDef(useDerived.getState().defs[0]!.id);
    expect(picture()).toEqual(before);
  });

  it('deletes the gates on it and hands its plots back to their default axes', () => {
    const id = useDerived.getState().addDef('MT potential', 'D1 + D2');
    const mt = REAL;  // its own index, in front of the shifted abundances
    useGates.getState().addGate('s1', { id: 'mt', name: 'MT high', parentId: 'live', colorIndex: 2,
      kind: 'range', xParam: mt, xSpec: LINEAR, min: 50, max: 1000 });
    usePlot.getState().updatePanel('p1', { xParam: mt });

    useDerived.getState().removeDef(id);

    expect(useGates.getState().shared.map((g) => g.id)).toEqual(['live', 'pos']);
    expect(usePlot.getState().panels[0]!.initialisedFor).toBeNull();
    expect(picture().gates.map((g) => g.on)).toEqual(['LiveDead', 'CD3 x CD4']);
  });
});

describe('a column cached before the abundances arrived', () => {
  it('is not served once they have — the reopened-workspace case', () => {
    const fresh = fakeParsed();
    useWorkspace.setState({ samples: [{ id: 's1', name: 's1', parsed: fresh } as unknown as Sample] });
    const gates = useGates.getState().gatesFor('s1');
    // Asked while the index names nothing: NaN, so the gates are empty.
    expect(evaluateFor('s1', fresh, gates, () => LINEAR).stats.get('live')!.count).toBe(0);
    attach(fresh);
    expect(evaluateFor('s1', fresh, gates, () => LINEAR).stats.get('live')!.count).toBe(40);
    detachUnmixed(fresh);
  });
});
