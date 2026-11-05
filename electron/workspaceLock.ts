import { app } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ==========================================================================
   Per-workspace locking across processes.

   The app used to hold `app.requestSingleInstanceLock()`: one MCFlow, ever.
   That prevented two processes writing the same .fcws.json, which is a real
   hazard — but it also prevented two processes opening two *different*
   workspaces, which is not a hazard at all and is what anyone comparing last
   week's experiment with this week's actually wants.

   This narrows the lock to the thing being protected. A lock is a small JSON
   file named after a hash of the resolved workspace path, holding the pid that
   owns it. Acquiring means writing it; conflicting means finding one whose pid
   is still alive.

   A second instance that finds a live holder leaves a *knock* file beside the
   lock and exits. The holder watches its own lock directory and focuses when it
   sees one. That is the whole handshake — no socket, no port, no dependency,
   and it degrades safely: if the holder has died without cleaning up, its pid
   is gone and the lock is taken over rather than deadlocking the user out of
   their own file.
   ========================================================================== */

const LOCK_DIR = () => join(app.getPath('userData'), 'workspace-locks');

/** Filename-safe, collision-free key for a path of any length or alphabet. */
function keyOf(workspacePath: string): string {
  const normalised = process.platform === 'win32' ? workspacePath.toLowerCase() : workspacePath;
  return createHash('sha1').update(normalised).digest('hex').slice(0, 16);
}

const lockPath = (key: string) => join(LOCK_DIR(), `${key}.lock`);
const knockPath = (key: string) => join(LOCK_DIR(), `${key}.knock`);

interface LockRecord {
  pid: number;
  workspacePath: string;
  startedAt: string;
}

/**
 * Is this pid still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but belongs to another user —
 * still alive, so still a conflict.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(key: string): LockRecord | null {
  try {
    const raw = readFileSync(lockPath(key), 'utf8');
    const rec = JSON.parse(raw) as LockRecord;
    return typeof rec?.pid === 'number' ? rec : null;
  } catch {
    return null;
  }
}

export interface AcquireResult {
  ok: boolean;
  /** The live process already holding this workspace, when ok is false. */
  heldBy?: LockRecord;
}

/** Locks this process currently owns, so they can all be released on quit. */
const owned = new Map<string, string>(); // key -> workspacePath

/**
 * Try to take the lock for a workspace.
 *
 * Returns `ok: false` only when another *live* process holds it. A lock left by
 * a crashed process is stale by definition and is taken over — the alternative
 * is a user locked out of their own workspace until they find and delete a file
 * they were never told about.
 */
export function acquire(workspacePath: string): AcquireResult {
  const key = keyOf(workspacePath);
  if (owned.has(key)) return { ok: true };

  mkdirSync(LOCK_DIR(), { recursive: true });

  const existing = readLock(key);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    return { ok: false, heldBy: existing };
  }

  const rec: LockRecord = { pid: process.pid, workspacePath, startedAt: new Date().toISOString() };
  writeFileSync(lockPath(key), JSON.stringify(rec), 'utf8');
  owned.set(key, workspacePath);
  return { ok: true };
}

export function release(workspacePath: string): void {
  const key = keyOf(workspacePath);
  if (!owned.has(key)) return;
  owned.delete(key);
  // Only remove a lock this process still owns — between acquiring and
  // releasing, a takeover of a lock we believed stale could have handed it on.
  const rec = readLock(key);
  if (rec && rec.pid !== process.pid) return;
  try { unlinkSync(lockPath(key)); } catch { /* already gone */ }
}

export function releaseAll(): void {
  for (const path of [...owned.values()]) release(path);
}

/**
 * Ask the holding process to bring its window forward.
 *
 * Writing a file rather than signalling the pid directly: a signal cannot carry
 * the path, cannot be delivered across user accounts, and has no meaning on
 * Windows beyond terminate.
 */
export function knock(workspacePath: string): void {
  const key = keyOf(workspacePath);
  try {
    mkdirSync(LOCK_DIR(), { recursive: true });
    writeFileSync(knockPath(key), JSON.stringify({ at: Date.now(), from: process.pid }), 'utf8');
  } catch {
    /* If the knock cannot be written the second instance still exits; the user
       sees their existing window unchanged rather than a duplicate. */
  }
}

/**
 * Watch for knocks on a workspace this process holds.
 *
 * `fs.watch` on the directory rather than the file: the knock file does not
 * exist yet when the watch starts, and watching a not-yet-created path is not
 * portable.
 */
export function watchForKnocks(workspacePath: string, onKnock: () => void): () => void {
  const key = keyOf(workspacePath);
  const target = `${key}.knock`;
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    mkdirSync(LOCK_DIR(), { recursive: true });
    watcher = watch(LOCK_DIR(), (_event, filename) => {
      if (!filename || filename.toString() !== target) return;
      if (!existsSync(knockPath(key))) return;
      try { rmSync(knockPath(key), { force: true }); } catch { /* ignore */ }
      onKnock();
    });
  } catch {
    return () => {};
  }
  return () => { watcher?.close(); };
}

/** Every live lock, for diagnostics and the verification harness. */
export function activeLocks(): LockRecord[] {
  try {
    mkdirSync(LOCK_DIR(), { recursive: true });
    return readdirSync(LOCK_DIR())
      .filter((f) => f.endsWith('.lock'))
      .map((f) => {
        try { return JSON.parse(readFileSync(join(LOCK_DIR(), f), 'utf8')) as LockRecord; } catch { return null; }
      })
      .filter((r): r is LockRecord => !!r && pidAlive(r.pid));
  } catch {
    return [];
  }
}

export { keyOf as workspaceLockKey, LOCK_DIR as workspaceLockDir };
