import { describe, expect, it } from 'vitest';
import { groupOf, groupParameters } from './paramGroups';
import type { ParameterType } from './fcs/types';

/** Only the two fields the grouping actually consults. */
const p = (name: string, type: ParameterType = 'Raw_Fluorescence') => ({ name, type });

describe('groupOf', () => {
  it('reads the excitation line off the detector name', () => {
    expect(groupOf(p('UV1-A'))).toBe('uv');
    expect(groupOf(p('UV16-A'))).toBe('uv');
    expect(groupOf(p('V1-A'))).toBe('violet');
    expect(groupOf(p('B14-A'))).toBe('blue');
    expect(groupOf(p('YG10-A'))).toBe('yellowgreen');
    expect(groupOf(p('R8-A'))).toBe('red');
  });

  it('does not let V swallow UV, or B swallow YG', () => {
    // The whole reason the alternation is ordered longest-first. Getting this
    // wrong files all 16 UV detectors under violet, which looks plausible
    // enough on screen that nobody would question it.
    expect(groupOf(p('UV3-A'))).toBe('uv');
    expect(groupOf(p('YG4-A'))).toBe('yellowgreen');
  });

  it('takes height and width channels as well as area', () => {
    expect(groupOf(p('V1-H'))).toBe('violet');
    expect(groupOf(p('B2-W'))).toBe('blue');
  });

  it('puts every scatter channel under Scatter, including the lettered ones', () => {
    expect(groupOf(p('FSC-A', 'Forward_Scatter'))).toBe('scatter');
    expect(groupOf(p('SSC-H', 'Side_Scatter'))).toBe('scatter');
    // `SSC-B-A` is a second scatter detector, not a blue-laser fluorescence
    // channel — checked before the detector pattern for exactly this reason.
    expect(groupOf(p('SSC-B-A', 'Side_Scatter'))).toBe('scatter');
    expect(groupOf(p('SSC-B-H', 'Side_Scatter'))).toBe('scatter');
  });

  it('groups by declared type where the file states one', () => {
    expect(groupOf(p('Time', 'Time'))).toBe('time');
    expect(groupOf({ name: 'FITC/APC index', type: 'Derived' })).toBe('derived');
  });

  it('groups an unmixed abundance by its type, not by the name it carries', () => {
    // An unmixed parameter is named after a fluorophore, so it matches no
    // detector convention — and *Other*, where it used to land, is the bucket for
    // channels whose optics could not be identified. That is the wrong company
    // for the parameters an operator is about to do all their gating on.
    expect(groupOf({ name: 'CD3 RY703', type: 'Unmixed_Fluorescence' })).toBe('unmixed');
    expect(groupOf({ name: 'CCR7 APC-Fire 810', type: 'Unmixed_Fluorescence' })).toBe('unmixed');
  });

  it('and a compensated one lands in its own group, not beside the unmixed', () => {
    // Same shape, different claim about how the column was computed. The two
    // are never present at once — a workspace's controls are one instrument's
    // or the other's — so this is about the word a picker prints.
    expect(groupOf({ name: 'CD2 PerCPCy55', type: 'Compensated_Fluorescence' })).toBe('compensated');
    // Even when the name looks like a detector, which on a conventional file it
    // routinely does: the type decides, never the name.
    expect(groupOf({ name: 'r-LP685 720/30-B-A', type: 'Compensated_Fluorescence' })).toBe('compensated');
  });

  it('leaves an unrecognised name in Other rather than guessing a laser', () => {
    // A wrong group asserts something about the optics that is not in the file.
    expect(groupOf(p('FITC-A'))).toBe('other');
    expect(groupOf(p('CD3 PerCP-Cy5.5'))).toBe('other');
    expect(groupOf(p('Comp-APC-A'))).toBe('other');
  });
});

describe('groupParameters', () => {
  const spectral = [
    p('Time', 'Time'),
    p('UV1-A'), p('UV2-A'),
    p('V1-A'),
    p('FSC-A', 'Forward_Scatter'), p('SSC-A', 'Side_Scatter'),
    p('B1-A'), p('YG1-A'), p('R1-A'),
  ];

  it('returns groups in wavelength order, scatter and time last', () => {
    expect(groupParameters(spectral).map((g) => g.key)).toEqual([
      'uv', 'violet', 'blue', 'yellowgreen', 'red', 'scatter', 'time',
    ]);
  });

  it('carries indices into the array it was given, in the original order', () => {
    const groups = groupParameters(spectral);
    expect(groups.find((g) => g.key === 'uv')!.items).toEqual([1, 2]);
    expect(groups.find((g) => g.key === 'scatter')!.items).toEqual([4, 5]);
    expect(groups.find((g) => g.key === 'time')!.items).toEqual([0]);
  });

  it('accounts for every parameter exactly once', () => {
    const seen = groupParameters(spectral).flatMap((g) => g.items).sort((a, b) => a - b);
    expect(seen).toEqual(spectral.map((_, i) => i));
  });

  it('drops empty groups rather than rendering five headers reading zero', () => {
    const conventional = [p('FSC-A', 'Forward_Scatter'), p('FITC-A'), p('Time', 'Time')];
    expect(groupParameters(conventional).map((g) => g.key)).toEqual(['scatter', 'time', 'other']);
  });

  it('groups an empty list into nothing', () => {
    expect(groupParameters([])).toEqual([]);
  });

  it('labels each group for a header', () => {
    const labels = groupParameters(spectral).map((g) => g.label);
    expect(labels).toContain('UV lasers');
    expect(labels).toContain('Yellow-green lasers');
    expect(labels).toContain('Scatter');
  });
});
