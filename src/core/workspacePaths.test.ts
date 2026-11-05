import { describe, expect, it } from 'vitest';
import { baseName, candidatePaths, relativeFrom, resolveFrom } from './workspacePaths';

/* ==========================================================================
   2026-10-28 — a workspace that cannot find its data at the absolute path it
   recorded looks beside itself before giving up. These pin the path arithmetic,
   which has to work on a path written by the *other* operating system.
   ========================================================================== */

describe('relativeFrom', () => {
  it('is the path from the workspace folder down to the file', () => {
    expect(relativeFrom('D:\\exp\\analysis.mcflow', 'D:\\exp\\data\\a.fcs')).toBe('data/a.fcs');
    expect(relativeFrom('/Users/x/exp/analysis.mcflow', '/Users/x/exp/a.fcs')).toBe('a.fcs');
  });

  it('climbs out of the workspace folder when the data sits beside it', () => {
    expect(relativeFrom('D:\\exp\\ws\\a.mcflow', 'D:\\exp\\data\\a.fcs')).toBe('../data/a.fcs');
  });

  it('matches a Windows path without regard to case, as the file system does', () => {
    expect(relativeFrom('d:\\Exp\\a.mcflow', 'D:\\exp\\Data\\a.fcs')).toBe('Data/a.fcs');
  });

  it('is null across drives and for a path that is not absolute', () => {
    expect(relativeFrom('C:\\a.mcflow', 'D:\\a.fcs')).toBeNull();
    expect(relativeFrom('a.mcflow', 'D:\\a.fcs')).toBeNull();
  });
});

describe('resolveFrom', () => {
  it('writes the result in the separator of the platform opening it', () => {
    expect(resolveFrom('/Volumes/usb/exp/a.mcflow', '../data/x.fcs')).toBe('/Volumes/usb/data/x.fcs');
    expect(resolveFrom('E:\\exp\\a.mcflow', 'data/x.fcs')).toBe('E:\\exp\\data\\x.fcs');
    expect(resolveFrom('\\\\lab\\share\\exp\\a.mcflow', 'x.fcs')).toBe('\\\\lab\\share\\exp\\x.fcs');
  });
});

describe('candidatePaths', () => {
  it('tries the recorded path, then the relative one, then the name beside the workspace', () => {
    // Saved on Windows, opened on a Mac after the folder was copied across.
    expect(candidatePaths(
      { filePath: 'D:\\exp\\data\\a.fcs', relativePath: 'data/a.fcs', fileName: 'a.fcs' },
      '/Users/x/Desktop/exp/analysis.mcflow',
    )).toEqual([
      'D:\\exp\\data\\a.fcs',
      '/Users/x/Desktop/exp/data/a.fcs',
      '/Users/x/Desktop/exp/a.fcs',
    ]);
  });

  it('reads a workspace saved before relative paths were written', () => {
    expect(candidatePaths({ filePath: '/old/a.fcs', fileName: 'a.fcs' }, '/new/w.mcflow'))
      .toEqual(['/old/a.fcs', '/new/a.fcs']);
  });

  it('is the recorded path alone when nothing says where the workspace is', () => {
    expect(candidatePaths({ filePath: '/old/a.fcs', relativePath: 'a.fcs', fileName: 'a.fcs' }, null))
      .toEqual(['/old/a.fcs']);
  });
});

describe('baseName', () => {
  it('takes the last segment in either separator', () => {
    expect(baseName('D:\\a\\b.fcs')).toBe('b.fcs');
    expect(baseName('/a/b.fcs')).toBe('b.fcs');
  });
});
