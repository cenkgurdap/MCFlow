import { describe, expect, it } from 'vitest';
import { groupLabels, orderedGroups } from './groups';

const f = (name: string, group = '') => ({ name, group });

describe('groupLabels', () => {
  it('is one label per group, in the order they first appear', () => {
    expect(groupLabels([f('a.csv', 'Control'), f('b.csv', 'Treated'), f('c.csv', 'Control')]))
      .toEqual(['Control', 'Treated']);
  });

  it('names an ungrouped file after itself rather than pooling it', () => {
    expect(groupLabels([f('a.csv'), f('b.csv', 'Control')])).toEqual(['a.csv', 'Control']);
  });

  it('ignores whitespace typed into a group field', () => {
    expect(groupLabels([f('a.csv', '  '), f('b.csv', ' Control ')])).toEqual(['a.csv', 'Control']);
  });
});

describe('orderedGroups', () => {
  const files = [f('a.csv', 'Control'), f('b.csv', 'Treated')];

  it('is the natural order until somebody arranges it', () => {
    expect(orderedGroups(files, [])).toEqual(['Control', 'Treated']);
  });

  it('follows the arrangement, which is what decides the colours', () => {
    expect(orderedGroups(files, ['Treated', 'Control'])).toEqual(['Treated', 'Control']);
  });

  it('drops an arranged group that no longer exists', () => {
    expect(orderedGroups(files, ['Gone', 'Treated'])).toEqual(['Treated', 'Control']);
  });

  it('puts a newly loaded group at the end rather than into the arrangement', () => {
    expect(orderedGroups([...files, f('c.csv', 'Rescue')], ['Treated', 'Control']))
      .toEqual(['Treated', 'Control', 'Rescue']);
  });
});
