import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptStatisticsPrefs, captureStatisticsPrefs, isAdjusted, livePaths, livePopulation, liveStatParam,
  useStatisticsPrefs,
} from './statisticsPrefs';

describe('useStatisticsPrefs', () => {
  beforeEach(() => useStatisticsPrefs.getState().reset());

  it('survives the component that set it being torn down', () => {
    /*
       The whole of Item 4, stated as directly as it can be without a DOM.

       `StatisticsView` is unmounted every time the user looks at Export, so the
       only thing that makes its setup survive is that the setup does not live in
       the component. Reading it back from the store after nothing at all has
       happened in between is what "navigate away and come back" reduces to.
    */
    const s = useStatisticsPrefs.getState();
    s.setStatParam(41);
    s.setStatKind('geoMean');
    s.setSelection(new Set(['Cells', 'Cells/Singlets']));
    s.setMode('chart');
    s.setMeasure('count');
    s.setPopulation('Cells/Singlets');
    s.setColumnWidths({ sample: 340, population: 120 });
    s.setSort({ key: 'count', dir: 'asc' });

    const after = useStatisticsPrefs.getState();
    expect(after.statParam).toBe(41);
    expect(after.statKind).toBe('geoMean');
    expect([...after.selection!]).toEqual(['Cells', 'Cells/Singlets']);
    expect(after.mode).toBe('chart');
    expect(after.measure).toBe('count');
    expect(after.population).toBe('Cells/Singlets');
    expect(after.columnWidths).toEqual({ sample: 340, population: 120 });
    expect(after.sort).toEqual({ key: 'count', dir: 'asc' });
  });

  it('reset puts every field back', () => {
    const s = useStatisticsPrefs.getState();
    s.setStatParam(7);
    s.setSelection(new Set(['Cells']));
    s.setShowPicker(true);
    s.setShowGrouping(true);
    s.setColumnWidths({ sample: 400 });
    s.setSort({ key: 'sample', dir: 'desc' });
    s.reset();

    const after = useStatisticsPrefs.getState();
    expect(after.statParam).toBe(-1);
    expect(after.statKind).toBe('median');
    expect(after.selection).toBeNull();
    expect(after.showPicker).toBe(false);
    expect(after.showGrouping).toBe(false);
    expect(after.mode).toBe('table');
    expect(after.columnWidths).toEqual({});
    expect(after.sort).toBeNull();
    expect(after.measure).toBe('percentTotal');
    expect(after.population).toBe('');
  });

  it('hands out a fresh selection and width map on every reset', () => {
    // A shared `Set` or `Record` in the defaults would be mutated into the
    // defaults themselves by the next edit, and the panel would reset to
    // whatever it was last set to.
    const s = useStatisticsPrefs.getState();
    s.setColumnWidths({ sample: 400 });
    s.reset();
    const first = useStatisticsPrefs.getState().columnWidths;
    s.setColumnWidths({ sample: 200 });
    s.reset();
    expect(useStatisticsPrefs.getState().columnWidths).toEqual({});
    expect(first).toEqual({});
  });
});

describe('isAdjusted', () => {
  beforeEach(() => useStatisticsPrefs.getState().reset());

  it('is false when the panel is as it opens', () => {
    expect(isAdjusted(useStatisticsPrefs.getState())).toBe(false);
  });

  it('notices each adjustment on its own', () => {
    const changes: Array<() => void> = [
      () => useStatisticsPrefs.getState().setStatParam(3),
      () => useStatisticsPrefs.getState().setStatKind('mean'),
      () => useStatisticsPrefs.getState().setSelection(new Set()),
      () => useStatisticsPrefs.getState().setShowPicker(true),
      () => useStatisticsPrefs.getState().setMode('chart'),
      () => useStatisticsPrefs.getState().setColumnWidths({ sample: 300 }),
      () => useStatisticsPrefs.getState().setSort({ key: 'count', dir: 'desc' }),
      () => useStatisticsPrefs.getState().setMeasure('count'),
      () => useStatisticsPrefs.getState().setPopulation('Cells'),
      () => useStatisticsPrefs.getState().setShowGrouping(true),
    ];
    for (const change of changes) {
      useStatisticsPrefs.getState().reset();
      change();
      expect(isAdjusted(useStatisticsPrefs.getState())).toBe(true);
    }
  });

  it('goes back to false when a change is changed back', () => {
    // Compared field by field rather than latched by a dirty flag, which would
    // leave the Reset button offering to undo nothing.
    useStatisticsPrefs.getState().setMeasure('count');
    useStatisticsPrefs.getState().setMeasure('percentTotal');
    expect(isAdjusted(useStatisticsPrefs.getState())).toBe(false);
  });

  it('treats an empty selection as an adjustment, not as the default', () => {
    // "No populations" and "all populations" are different answers, and only the
    // second is what the panel opens with. `null` is all; an empty set is none.
    useStatisticsPrefs.getState().setSelection(new Set());
    expect(isAdjusted(useStatisticsPrefs.getState())).toBe(true);
  });
});

describe('livePaths', () => {
  it('expands null to everything available, so later gates are included', () => {
    expect([...livePaths(null, ['Cells', 'Cells/Singlets'])]).toEqual(['Cells', 'Cells/Singlets']);
  });

  it('drops a stored path whose population has been deleted', () => {
    // The invalidation the brief asks for, done on read. A gate deleted while
    // the panel was on another screen must stop being counted.
    const stored = new Set(['Cells', 'Cells/Singlets', 'Cells/Debris']);
    expect([...livePaths(stored, ['Cells', 'Cells/Singlets'])]).toEqual(['Cells', 'Cells/Singlets']);
  });

  it('keeps an empty selection empty rather than treating it as all', () => {
    expect(livePaths(new Set(), ['Cells']).size).toBe(0);
  });

  it('restores a selection when the population comes back', () => {
    // Because the stored set is filtered rather than pruned, undoing a gate
    // deletion brings the selection back with it.
    const stored = new Set(['Cells', 'Cells/Debris']);
    expect(livePaths(stored, ['Cells']).size).toBe(1);
    expect(livePaths(stored, ['Cells', 'Cells/Debris']).size).toBe(2);
  });
});

describe('liveStatParam', () => {
  it('keeps an index the data still has', () => {
    expect(liveStatParam(41, 71)).toBe(41);
    expect(liveStatParam(0, 1)).toBe(0);
  });

  it('falls back to none when the parameter is gone', () => {
    // A 71-parameter Aurora file removed, a 6-parameter file left: index 41
    // would read past the end of the buffer and render a column of NaN under a
    // heading naming a detector that is not in the file.
    expect(liveStatParam(41, 6)).toBe(-1);
    expect(liveStatParam(0, 0)).toBe(-1);
  });

  it('passes "none" through unchanged', () => {
    expect(liveStatParam(-1, 71)).toBe(-1);
  });
});

describe('livePopulation', () => {
  it('keeps a stored population that still exists', () => {
    expect(livePopulation('Cells/Singlets', ['Cells', 'Cells/Singlets'])).toBe('Cells/Singlets');
  });

  it('falls back to the first when the stored one has been deleted', () => {
    // The bug `population || populations[0]` had: a deleted path is still a
    // non-empty string, so it won the `||` and the chart drew nothing.
    expect(livePopulation('Cells/Debris', ['Cells', 'Cells/Singlets'])).toBe('Cells');
  });

  it('falls back to the first when nothing is stored', () => {
    expect(livePopulation('', ['Cells'])).toBe('Cells');
  });

  it('returns empty when there is nothing to plot', () => {
    expect(livePopulation('Cells', [])).toBe('');
    expect(livePopulation('', [])).toBe('');
  });
});

describe('samples left out of Statistics and Export', () => {
  beforeEach(() => useStatisticsPrefs.getState().reset());

  it('start empty, so every sample is in', () => {
    expect(useStatisticsPrefs.getState().excludedSamples).toEqual([]);
    expect(isAdjusted(useStatisticsPrefs.getState())).toBe(false);
  });

  it('count as an adjustment, and Reset puts every sample back', () => {
    useStatisticsPrefs.getState().setExcludedSamples(['b']);
    expect(isAdjusted(useStatisticsPrefs.getState())).toBe(true);
    useStatisticsPrefs.getState().reset();
    expect(useStatisticsPrefs.getState().excludedSamples).toEqual([]);
  });

  it('are saved with the workspace and read back', () => {
    useStatisticsPrefs.getState().setExcludedSamples(['b', 'd']);
    const saved = JSON.parse(JSON.stringify(captureStatisticsPrefs()));
    useStatisticsPrefs.getState().reset();
    adoptStatisticsPrefs(saved);
    expect(useStatisticsPrefs.getState().excludedSamples).toEqual(['b', 'd']);
  });

  it('ignore a saved value that is not a list of ids', () => {
    adoptStatisticsPrefs({ excludedSamples: [1, 2] });
    expect(useStatisticsPrefs.getState().excludedSamples).toEqual([]);
    adoptStatisticsPrefs({ excludedSamples: 'b' });
    expect(useStatisticsPrefs.getState().excludedSamples).toEqual([]);
  });
});
