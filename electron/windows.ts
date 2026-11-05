import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { resolve } from 'node:path';
import { bundlePath, resourcePath } from './appPaths';
import { acquire, watchForKnocks } from './workspaceLock';

/* ==========================================================================
   Windows, workspaces and the lock between them.

   Two things live here because they are the same question asked twice: which
   windows belong to which workspace?

   1. **Windows are grouped by workspace file.** Two windows that hold the same
      `.mcflow` are two views of one analysis and stay in step: any window's
      snapshot is rebroadcast to its siblings, and only its siblings. Two
      windows holding *different* workspaces — or no workspace at all — share
      nothing.

   2. **The instance lock.** The original lock was global — a second launch of
      MCFlow focused the running window and quit. The intent was right (two
      processes must not write the same workspace file) but the scope was too
      broad: it also blocked the entirely safe case of two unrelated workspaces
      open at once, which is what anyone comparing two experiments wants.

      So the lock is keyed by resolved workspace path. Different workspace, or no
      workspace at all — start normally. Same workspace — focus the window that
      already has it. Same protection, applied where the conflict actually is.

   ## What File ▸ New Window does, and what it used to do   (2026-08-03, Item 7)

   It opens an **independent, blank window**: no samples, no gates, no panels,
   and no sync relationship with the window it was launched from. That is a
   reversal. It used to open an additional *view* of the launching window's
   workspace — `isLayoutWindow`, a `?layout=1` query, and an immediate
   `sync:apply` of the sibling's snapshot — on the reading that someone wants a
   gating layout on one screen and a statistics layout on the other.

   The actual request is the other one: **two experiments open side by side.**
   That is not a second view of anything, and every mechanism that made the two
   windows agree was working against it. The multi-instance architecture already
   supports it — two processes, or here two windows, are safe as long as they do
   not hold the same workspace file — so a new window simply starts as though the
   application had just been launched.

   The in-workspace **New Layout** is untouched and is where the original idea
   lives: a second blank worksheet over the same samples and gates, in the same
   window.

   One thing had to change to make this real, and it was a bug on its own:
   **windows with no workspace open used to share the key `''`**, so two blank
   windows broadcast to each other and a brand-new window would fill with the
   launching window's state the moment either changed anything. An untitled
   window is now keyed to *itself* (`untitled:w3`), so it syncs with nothing
   until it opens or saves a real file and re-keys onto that.
   ========================================================================== */

/*
   `const __dirname = dirname(fileURLToPath(import.meta.url))` used to be here,
   and it is now `appPaths.ts` (2026-08-14).

   It was correct — the bundle is ESM, where `__dirname` does not exist — and it
   was correct *privately*, which turned out to be the problem. This file worked,
   so it looked like a file that needed no special handling, and the next one to
   want a path wrote `join(__dirname, ...)` against the ambient global
   `@types/node` says is there. That was `menu.ts`, and every click of *About
   MCFlow* threw a `ReferenceError`. Answering the question in one module is what
   stops a third file answering it wrong by omission.
*/
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/** The key used when a window has no workspace file open yet. */
export const UNTITLED = '';

interface WindowRecord {
  win: BrowserWindow;
  /** Resolved, case-normalised workspace path, or an untitled key of its own. */
  workspaceKey: string;
  /** Stable id the renderer uses to recognise its own broadcasts. */
  id: string;
  /** The renderer has changes it has not written to a file. Pushed, not polled. */
  dirty: boolean;
  /** The close prompt has been answered; the next `close` goes through. */
  closeApproved: boolean;
  /** Not yet taken by the renderer. See `LaunchRequest`. */
  launch: LaunchRequest | null;
}

const records = new Map<number, WindowRecord>();

/**
 * Last snapshot seen per workspace.
 *
 * Held so a window opened second can be brought up to date immediately rather
 * than waiting for the first window to next change something — otherwise a new
 * layout window would sit empty until someone happened to draw a gate.
 */
const lastSnapshot = new Map<string, unknown>();

let idSeq = 0;

/**
 * Normalise a workspace path into a comparison key.
 *
 * Case-folded because Windows paths are case-insensitive, and the whole point
 * of the key is that `D:\Work\panel.fcws.json` and `d:\work\PANEL.FCWS.JSON`
 * must collide — they are one file, and letting them differ would reintroduce
 * exactly the concurrent-write risk this replaces.
 */
export function workspaceKey(path: string | null | undefined): string {
  if (!path) return UNTITLED;
  const abs = resolve(path);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * The sync key for a window that holds no workspace file.
 *
 * Per window, not shared. Every untitled window used to key to `UNTITLED`, which
 * put them all in one broadcast group — so opening a second window filled it
 * with the first one's samples and gates as soon as either changed anything,
 * which is the opposite of what a new window is for. A window that owns no file
 * has nothing to share; it re-keys onto a real path the moment it opens or saves
 * one.
 */
export function untitledKey(windowId: string): string {
  return `untitled:${windowId}`;
}

export function windowsFor(key: string): BrowserWindow[] {
  return [...records.values()]
    .filter((r) => r.workspaceKey === key && !r.win.isDestroyed())
    .map((r) => r.win);
}

/** The window holding a workspace, if any instance in this process has it. */
export function findWindowForWorkspace(key: string): BrowserWindow | null {
  if (key === UNTITLED) return null;
  return windowsFor(key)[0] ?? null;
}

export function recordFor(win: BrowserWindow): WindowRecord | undefined {
  return records.get(win.id);
}

export function allWindows(): BrowserWindow[] {
  return [...records.values()].filter((r) => !r.win.isDestroyed()).map((r) => r.win);
}

/** Re-key a window when it opens or saves a different workspace. */
export function setWorkspaceForWindow(win: BrowserWindow, path: string | null): void {
  const rec = records.get(win.id);
  if (!rec) return;
  // Back to its own untitled key when the path is cleared, never to the shared
  // one — see `untitledKey`.
  rec.workspaceKey = path ? workspaceKey(path) : untitledKey(rec.id);
}

/* -------------------------------------------------------------------------
   Creating windows
   ------------------------------------------------------------------------- */

export interface CreateOptions {
  /**
   * Workspace this window is bound to, for the lock and for sync grouping.
   *
   * Omitted or null means untitled, and an untitled window is keyed to itself —
   * it shares state with nothing. `isLayoutWindow` used to sit beside this and
   * meant "adopt the sibling's workspace"; it is gone with the shared-view
   * architecture. See the header note.
   */
  workspacePath?: string | null;
  /** Offset from the parent so a second window does not land exactly on top. */
  offsetFrom?: BrowserWindow | null;
  /** What this window was opened *for* — handed over once the renderer asks. */
  launch?: LaunchRequest | null;
}

/**
 * A file the window was launched to open: a workspace, or `.fcs` files.
 *
 * ## Pulled, not pushed (2026-10-28)
 *
 * The path used to be sent on `did-finish-load`. The preload buffers nothing,
 * and the renderer subscribes from a React effect that can run after that
 * event — so a message that arrived first was dropped, and a double-clicked
 * workspace opened an empty window. Now the window holds the request and the
 * renderer takes it (`window:takeLaunchRequest`) once its handlers exist, which
 * cannot be too early because the renderer is the one asking.
 */
export type LaunchRequest = { workspacePath: string } | { fcs: string[] };

export function createWindow(opts: CreateOptions = {}): BrowserWindow {
  const bounds = opts.offsetFrom && !opts.offsetFrom.isDestroyed()
    ? opts.offsetFrom.getBounds()
    : null;

  const win = new BrowserWindow({
    width: bounds?.width ?? 1560,
    height: bounds?.height ?? 980,
    // Cascade rather than stack: a new layout window landing pixel-perfect on
    // the old one looks like nothing happened.
    ...(bounds ? { x: bounds.x + 36, y: bounds.y + 36 } : {}),
    minWidth: 1040,
    minHeight: 640,
    /*
       `--surface-base` on the light theme, which is what the app opens in.

       **This tracks the application, not the splash** (2026-08-29), and the two
       now differ deliberately: the splash paints its own near-black field. That
       is safe because of `show: false` and the `ready-to-show` handler below —
       the window is never on screen without a rendered frame, so this colour is
       not what fills it at launch. What it does fill is the region a resize
       exposes before the compositor has painted it, which is long after the
       splash has gone; matching it to the splash would put a dark band along
       the edge of every window drag to buy a frame nobody sees.
    */
    backgroundColor: '#f4f5f7',
    /*
       The window icon, stated rather than inherited (2026-08-04, Item 2).

       Packaged, Windows takes the title-bar and taskbar icon from the icon
       electron-builder embeds in `MCFlow.exe`, so this changed nothing there —
       but nothing was setting it for an *unpackaged* run, which is `npm run
       electron`, `release/win-unpacked/MCFlow.exe` and every launch-test this
       project does, and all of those showed Electron's own default mark. An app
       whose icon is right only after it is installed is an app whose icon
       nobody checks.

       `icon.png` rather than `icon.ico`: it is the 1024 px master and Electron
       accepts a PNG on all three platforms. Resolved relative to this file, so
       it works from `dist-electron/` both in the repo and inside the asar.
    */
    icon: resourcePath('build', 'icon.png'),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: bundlePath('preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const id = `w${++idSeq}`;
  const key = opts.workspacePath ? workspaceKey(opts.workspacePath) : untitledKey(id);
  records.set(win.id, { win, workspaceKey: key, id, dirty: false, closeApproved: false, launch: opts.launch ?? null });

  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    const rec = records.get(win.id);
    if (!rec || rec.closeApproved || !rec.dirty) return;
    e.preventDefault();
    askBeforeClosing(win, rec);
  });

  /*
     `?splash=hold` asks the renderer to keep the splash up for a minimum of five
     seconds — see `MIN_SPLASH_MS` in `src/main.tsx`.

     It is set here and nowhere else, which is the point. End-to-end tests
     build their own `BrowserWindow` and `loadFile` the same
     `dist/index.html`; they drive the real app through real pointer input, and
     an opaque overlay across the window for five seconds would have every one of
     them clicking the splash. Asking for the floor here means "the application
     launched this window" is what turns it on, which is the condition it is
     actually about.
  */
  if (DEV_URL) void win.loadURL(`${DEV_URL}${DEV_URL.includes('?') ? '&' : '?'}splash=hold`);
  else void win.loadFile(resourcePath('dist', 'index.html'), { query: { splash: 'hold' } });

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('sync:window-id', id);
    /*
       A window that holds a workspace file gets whatever its siblings already
       have. A window that holds nothing gets nothing.

       That one condition is the whole of Item 7. It used to be
       `if (opts.isLayoutWindow)`, which meant "the window this was opened from",
       and is what made File ▸ New Window a copy of the window it was launched
       from. Keying on the *path* instead keeps the case that was always
       well-founded — open the same workspace in two windows and the second is up
       to date immediately rather than waiting for the first to change something
       — and drops the case that was not. An untitled window has a key of its
       own, so this map has nothing under it and nothing is sent.
    */
    // Nothing else is pushed here. The hand-off a window gets when it opens onto
    // a workspace a sibling already holds is **pulled**, through
    // `window:requestSync`, because this event fires before React has mounted
    // and a message sent now can land on no listener at all. See
    // `startWindowSync`.
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links go to the user's browser, never inside the app frame.
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { records.delete(win.id); });

  return win;
}

/* -------------------------------------------------------------------------
   Closing with unsaved changes
   ------------------------------------------------------------------------- */

/**
 * Save / Don't Save / Cancel, the way every desktop application does it.
 *
 * Modal and synchronous on purpose: the window is already mid-close and the
 * answer decides whether that close continues, so there is nothing useful to do
 * while it is open. `showMessageBoxSync` blocks the main process for as long as
 * the prompt is on screen, which is the same thing every other application does
 * here and is why the prompt is the only work happening.
 *
 * **Save is asynchronous and can be abandoned.** It opens a file dialog, and a
 * user who cancels that dialog has not saved and has not asked to lose anything
 * — so the window must stay open. That is why Save does not close anything
 * itself: it hands the job to the renderer, which calls back through
 * `window:confirmClose` only if a file was actually written.
 */
function askBeforeClosing(win: BrowserWindow, rec: WindowRecord): void {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    // Escape and the title-bar X both answer Cancel, which is the safe one.
    cancelId: 2,
    noLink: true,
    title: 'Unsaved changes',
    message: 'Save changes to this workspace before closing?',
    detail: 'Gates, plots, parameters and axis settings changed since the last save will be lost.',
  });

  if (choice === 2) return;
  if (choice === 1) {
    rec.closeApproved = true;
    win.destroy();
    return;
  }
  win.webContents.send('window:save-and-close');
}

/* -------------------------------------------------------------------------
   Broadcast
   ------------------------------------------------------------------------- */

/**
 * Guard against a second registration.
 *
 * `ipcMain.handle` throws when a channel already has a handler, and this is now
 * called from `registerIpc` as well as directly by end-to-end tests.
 * Registering the window IPC is a property of the process, not of the caller.
 */
let syncRegistered = false;

export function registerSyncIpc(): void {
  if (syncRegistered) return;
  syncRegistered = true;

  ipcMain.on('sync:broadcast', (event, payload: unknown) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (!sender) return;
    const rec = records.get(sender.id);
    if (!rec) return;

    lastSnapshot.set(rec.workspaceKey, payload);

    // Siblings only. A window on a different workspace must never see this —
    // that is the whole reason the records carry a key.
    for (const other of windowsFor(rec.workspaceKey)) {
      if (other.id === sender.id) continue;
      other.webContents.send('sync:apply', payload);
    }
  });

  ipcMain.handle('window:setWorkspace', (event, path: string | null) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    if (sender) setWorkspaceForWindow(sender, path);
    return true;
  });

  // File ▸ New Window. Independent and empty: no workspace path, so it takes an
  // untitled key of its own and syncs with nothing, including the window it was
  // launched from. `offsetFrom` is only a cascade so it does not land exactly on
  // top of its parent.
  ipcMain.handle('window:new', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    createWindow({ workspacePath: null, offsetFrom: sender });
    return true;
  });

  /**
   * The newest snapshot from this window's workspace, or null.
   *
   * Pulled by a window that has just loaded onto a workspace some other window
   * already holds, so it opens showing the current analysis rather than sitting
   * empty until somebody happens to change something. Its own broadcasts are
   * excluded by construction: a window that has broadcast anything is past the
   * point of asking.
   */
  ipcMain.handle('window:requestSync', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const rec = sender ? records.get(sender.id) : undefined;
    if (!rec) return null;
    return lastSnapshot.get(rec.workspaceKey) ?? null;
  });

  ipcMain.handle('window:setDirty', (event, dirty: boolean) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const rec = sender ? records.get(sender.id) : undefined;
    if (rec) rec.dirty = Boolean(dirty);
    return true;
  });

  // The renderer's answer to the Save button on the close prompt: a file was
  // written, so the close it interrupted may now go ahead.
  ipcMain.handle('window:confirmClose', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const rec = sender ? records.get(sender.id) : undefined;
    if (!rec || !sender) return false;
    rec.closeApproved = true;
    sender.destroy();
    return true;
  });

  // Once: a reload must not reopen the file over whatever the user has done
  // since — the same reason a launch is not a setting.
  ipcMain.handle('window:takeLaunchRequest', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const rec = sender ? records.get(sender.id) : undefined;
    if (!rec) return null;
    const launch = rec.launch;
    rec.launch = null;
    return launch;
  });

  ipcMain.handle('workspace:claim', (event, path: string) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const ok = claimWorkspace(path, sender);
    if (ok && sender) setWorkspaceForWindow(sender, path);
    return ok;
  });

  ipcMain.handle('window:count', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const rec = sender ? records.get(sender.id) : undefined;
    return {
      total: allWindows().length,
      onThisWorkspace: rec ? windowsFor(rec.workspaceKey).length : 0,
      windowId: rec?.id ?? null,
    };
  });
}

/** Focus an existing window and tell the user why nothing new opened. */
export function focusExisting(win: BrowserWindow, workspacePath: string): void {
  if (win.isMinimized()) win.restore();
  win.focus();
  win.webContents.send('workspace:already-open', workspacePath);
}

/**
 * Take the cross-process lock on a workspace opened or saved after launch.
 *
 * The launch argument is only one of the ways a process comes to own a
 * workspace file; the common one is the user picking it from a dialog. Refusing
 * *before* the write is the point — discovering the conflict afterwards would
 * be no protection at all.
 */
export function claimWorkspace(path: string, win: BrowserWindow | null): boolean {
  const got = acquire(path);
  if (got.ok) {
    watchForKnocks(path, () => {
      const target = findWindowForWorkspace(workspaceKey(path)) ?? win;
      if (target && !target.isDestroyed()) focusExisting(target, path);
    });
    return true;
  }
  if (win && !win.isDestroyed()) {
    void dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Workspace already open',
      message: 'This workspace is already open in another window.',
      detail: `${path}\n\nIt is open in another MCFlow instance (process ${got.heldBy?.pid}). Editing it in two places at once would let one overwrite the other's changes.`,
      buttons: ['OK'],
    });
  }
  return false;
}
