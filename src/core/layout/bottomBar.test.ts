import { describe, expect, it } from 'vitest';
import { bottomBarOwner, type BottomBar } from './bottomBar';

/** The four inputs, with the quiet case as the baseline. */
const base = {
  walkingControls: false,
  walkingSamples: false,
  activeLayoutKind: undefined as 'reference' | 'biophysics' | undefined,
  layoutCount: 3,
};

const owner = (over: Partial<typeof base>): BottomBar => bottomBarOwner({ ...base, ...over });

describe('bottomBarOwner', () => {
  it('gives the bottom to a guided strip only on that panel’s own worksheet', () => {
    expect(owner({ walkingControls: true, activeLayoutKind: 'reference' })).toBe('reference');
    expect(owner({ walkingSamples: true, activeLayoutKind: 'biophysics' })).toBe('biophysics');
  });

  /*
     The bug this module was written for. Creating a worksheet during a walk
     switches to it, and the strip that was at the bottom listed samples — so
     the worksheet the user was standing in had no tab anywhere on the strip
     claiming to be the list of worksheets.
  */
  it('hands the bottom back to the layout strip on a general worksheet mid-walk', () => {
    expect(owner({ walkingSamples: true, activeLayoutKind: undefined })).toBe('layouts');
    expect(owner({ walkingControls: true, activeLayoutKind: undefined })).toBe('layouts');
  });

  it('does not let one panel’s walk claim the other panel’s worksheet', () => {
    expect(owner({ walkingSamples: true, activeLayoutKind: 'reference' })).toBe('layouts');
    expect(owner({ walkingControls: true, activeLayoutKind: 'biophysics' })).toBe('layouts');
  });

  it('never returns two owners — the walks cannot both hold the same worksheet', () => {
    const both = { walkingControls: true, walkingSamples: true };
    expect(owner({ ...both, activeLayoutKind: 'reference' })).toBe('reference');
    expect(owner({ ...both, activeLayoutKind: 'biophysics' })).toBe('biophysics');
  });

  it('draws nothing when there is only one worksheet to be in', () => {
    expect(owner({ layoutCount: 1 })).toBe('none');
    expect(owner({ layoutCount: 0 })).toBe('none');
    expect(owner({ layoutCount: 2 })).toBe('layouts');
  });

  /*
     A walked worksheet still gets its strip when it is the only one, because
     the strip is the walk's navigation rather than a list of alternatives.
  */
  it('keeps a walk strip even on a single worksheet', () => {
    expect(owner({ walkingSamples: true, activeLayoutKind: 'biophysics', layoutCount: 1 }))
      .toBe('biophysics');
  });
});
