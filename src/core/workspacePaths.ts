/**
 * Where a workspace's data files might be now, when they are not where they were.
 *
 * A workspace stores analysis, not data — paths, never events — and until
 * 2026-10-28 the path was absolute and was the only thing tried. A workspace
 * opened after its folder had been moved, copied to a colleague, synced to a
 * laptop, or opened on the other operating system (where `D:\…` cannot exist)
 * found none of its files, restored zero samples, and on the menu path said
 * nothing about it: the report was *"I saved it yesterday, and today it opens
 * empty."*
 *
 * So the save also records each file **relative to the workspace**, and the
 * restore tries, in order: the absolute path, the relative one from wherever the
 * workspace now is, and the file's name beside the workspace. All three answer
 * the commonest move — the data and the workspace travelling together — and the
 * first answers everything that was not moved at all.
 *
 * Pure, and indifferent to the platform it runs on: the renderer has no `path`
 * module, and a path written on Windows has to be read on macOS. Both
 * separators are accepted everywhere; a joined path takes the workspace path's
 * own separator, because that is the platform it is being opened on.
 *
 * This is the one filename-based lookup in the restore, and it is not inference:
 * a file is only ever matched to the sample that recorded that exact name.
 */

interface Split {
  /** `C:`, `/`, `\\server\share`, or '' for a relative path. */
  root: string;
  segments: string[];
  /** Windows-style paths compare case-insensitively, as the file system does. */
  caseless: boolean;
}

function split(path: string): Split {
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/.exec(path);
  if (unc) {
    return { root: `\\\\${unc[1]}\\${unc[2]}`, segments: parts(path.slice(unc[0].length)), caseless: true };
  }
  const drive = /^([A-Za-z]:)/.exec(path);
  if (drive) return { root: drive[1]!.toUpperCase(), segments: parts(path.slice(2)), caseless: true };
  if (/^[\\/]/.test(path)) return { root: '/', segments: parts(path), caseless: false };
  return { root: '', segments: parts(path), caseless: false };
}

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
}

function same(a: string, b: string, caseless: boolean): boolean {
  return caseless ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The separator a path is written with. A drive letter with neither reads as Windows. */
function separatorOf(path: string): '/' | '\\' {
  if (path.includes('\\')) return '\\';
  if (path.includes('/')) return '/';
  return /^[A-Za-z]:/.test(path) ? '\\' : '/';
}

function render(root: string, segments: string[], sep: '/' | '\\'): string {
  const body = segments.join(sep);
  if (root === '/') return `/${body}`;
  if (root === '') return body;
  return `${root}${sep}${body}`;
}

/**
 * `filePath` relative to the folder holding `workspacePath`, with `/`
 * separators, or null when no relative path exists — another drive, another
 * server, or either path not absolute.
 */
export function relativeFrom(workspacePath: string, filePath: string): string | null {
  const w = split(workspacePath);
  const f = split(filePath);
  if (!w.root || !f.root) return null;
  const caseless = w.caseless || f.caseless;
  if (!same(w.root, f.root, caseless)) return null;

  const dir = w.segments.slice(0, -1);
  let common = 0;
  while (common < dir.length && common < f.segments.length - 1 && same(dir[common]!, f.segments[common]!, caseless)) {
    common++;
  }
  const up = dir.length - common;
  return [...Array<string>(up).fill('..'), ...f.segments.slice(common)].join('/');
}

/** `relative` resolved against the folder holding `workspacePath`, in its separator. */
export function resolveFrom(workspacePath: string, relative: string): string {
  const w = split(workspacePath);
  const out = w.segments.slice(0, -1);
  for (const s of parts(relative)) {
    if (s === '..') out.pop();
    else out.push(s);
  }
  return render(w.root, out, separatorOf(workspacePath));
}

/**
 * Every place a sample's file might be, most authoritative first, without
 * duplicates. The caller asks the file system about each in turn.
 */
export function candidatePaths(
  sample: { filePath: string | null; relativePath?: string | null; fileName: string },
  workspacePath: string | null,
): string[] {
  const out: string[] = [];
  const add = (p: string | null | undefined) => { if (p && !out.includes(p)) out.push(p); };
  add(sample.filePath);
  if (workspacePath) {
    if (sample.relativePath) add(resolveFrom(workspacePath, sample.relativePath));
    if (sample.fileName) add(resolveFrom(workspacePath, sample.fileName));
  }
  return out;
}

/** The last segment of a path in either separator — what a sample's file is called. */
export function baseName(path: string): string {
  const s = parts(path);
  return s[s.length - 1] ?? path;
}
