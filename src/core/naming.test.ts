import { describe, expect, it } from 'vitest';
import { displayNameFromFile, parseControlIdentity, stripDatePrefix, stripGroupPrefix } from './naming';
import { groupIdFor } from '@/state/workspaceStore';

describe('displayNameFromFile', () => {
  it.each([
    ['20250101-Sample B Pro12A1.fcs', 'Sample B Pro12A1'],
    ['20250101-Beads-CD3 PerCP-Cy5.5.fcs', 'Beads-CD3 PerCP-Cy5.5'],
    ['20250101-Experiment-1.fcs', 'Experiment-1'],
    ['2025-07-28_Sample A.fcs', 'Sample A'],
    ['NoDatePrefix.fcs', 'NoDatePrefix'],
  ])('%s -> %s', (input, expected) => {
    expect(displayNameFromFile(input)).toBe(expected);
  });

  it('leaves a name that is only a date alone rather than emptying it', () => {
    expect(stripDatePrefix('20250101')).toBe('20250101');
  });
});

/*
   `suggestGroups` and its four tests are deleted (2026-08-03, Item 10). The
   assertions above were the *reason* it had to go rather than evidence that it
   worked: "clusters the replicates into their two conditions" was true, and the same
   rule applied to `…-Probe-Control` and `…-Probe-TreatmentA` merged a treated sample
   with its own control into one comparison category of n=2. A filename is not a
   statement about which samples are replicates of each other, and nothing in the
   file distinguishes "these three are the same condition" from "these two are
   the conditions being compared".

   Grouping is explicit now — a sample has one because somebody assigned it — so
   what is left to test here is the id format, which is the only place a group
   name is stored.
*/
describe('group ids', () => {
  it('carries the name in the id, because there is nowhere else to keep it', () => {
    expect(groupIdFor('TreatmentA')).toBe('manual:TreatmentA');
    expect(groupIdFor('  TreatmentA  ')).toBe('manual:TreatmentA');
  });

  it('treats an empty name as no group at all', () => {
    // Which is the default, and what makes a sample its own category in the
    // comparison chart.
    expect(groupIdFor('')).toBe('');
    expect(groupIdFor('   ')).toBe('');
  });
});

describe('parseControlIdentity', () => {
  it.each([
    ['20250101-Beads-CD3 PerCP-Cy5.5.fcs', 'CD3', 'PerCP-Cy5.5'],
    ['20250101-Beads-CD4 PE-Fire 744.fcs', 'CD4', 'PE-Fire 744'],
    ['20250101-Beads-CD8 APC-Fire 810.fcs', 'CD8', 'APC-Fire 810'],
    ['20250101-Beads-CD11c APC-R700.fcs', 'CD11c', 'APC-R700'],
    ['20250101-Beads-CD14 APC.fcs', 'CD14', 'APC'],
    ['20250101-Beads-CD19 AF647.fcs', 'CD19', 'AF647'],
    ['20250101-Beads-CD56 PerCP-eFluor 710.fcs', 'CD56', 'PerCP-eFluor 710'],
  ])('%s -> %s / %s', (file, marker, fluor) => {
    const id = parseControlIdentity(file);
    expect(id.isUnstained).toBe(false);
    expect(id.marker).toBe(marker);
    expect(id.fluorophore).toBe(fluor);
    expect(id.confidence).toBe('high');
  });

  it('recognises the unstained control despite the filename typo', () => {
    const id = parseControlIdentity('20250101-Beads-Unstainedd.fcs');
    expect(id.isUnstained).toBe(true);
    expect(id.label).toBe('Unstained');
  });

  it.each(['Unstained.fcs', 'un-stained.fcs', 'UNSTAINED control.fcs', 'blank.fcs'])(
    'recognises %s as unstained',
    (f) => {
      expect(parseControlIdentity(f).isUnstained).toBe(true);
    },
  );

  it('reports low confidence when no fluorophore is recognisable', () => {
    const id = parseControlIdentity('20250101-Beads-Pro12A.fcs');
    expect(id.isUnstained).toBe(false);
    expect(id.fluorophore).toBeNull();
    expect(id.marker).toBe('Pro12A');
    expect(id.confidence).toBe('low');
  });

  it('prefers the longest matching fluorophore name', () => {
    expect(parseControlIdentity('x-CD3 PerCP-Cy5.5.fcs').fluorophore).toBe('PerCP-Cy5.5');
    expect(parseControlIdentity('x-CD3 PerCP.fcs').fluorophore).toBe('PerCP');
    expect(parseControlIdentity('x-CD8 APC-Fire 810.fcs').fluorophore).toBe('APC-Fire 810');
    expect(parseControlIdentity('x-CD14 APC.fcs').fluorophore).toBe('APC');
  });

  it('never returns an empty label', () => {
    for (const f of ['.fcs', 'a.fcs', '20250101-.fcs']) {
      expect(parseControlIdentity(f).label.length).toBeGreaterThan(0);
    }
  });
});

describe('stripGroupPrefix', () => {
  it('removes the redundant group stem from a row label', () => {
    expect(stripGroupPrefix('Beads-CD3 PerCP-Cy5.5', 'Beads')).toBe('CD3 PerCP-Cy5.5');
    expect(stripGroupPrefix('Beads-Unstainedd', 'Beads')).toBe('Unstainedd');
  });

  it('keeps the full name when stripping would leave too little to read', () => {
    expect(stripGroupPrefix('Sample B Pro12A1', 'Sample B Pro12A')).toBe('Sample B Pro12A1');
  });

  it('leaves the name alone when it does not start with the group', () => {
    expect(stripGroupPrefix('Experiment-1', 'Beads')).toBe('Experiment-1');
    expect(stripGroupPrefix('Sample A', 'Ungrouped')).toBe('Sample A');
    expect(stripGroupPrefix('Sample A', '')).toBe('Sample A');
  });

  it('never produces an empty label', () => {
    expect(stripGroupPrefix('Beads', 'Beads')).toBe('Beads');
    expect(stripGroupPrefix('Beads-', 'Beads')).toBe('Beads-');
  });
});
