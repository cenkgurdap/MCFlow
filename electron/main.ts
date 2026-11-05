import { app, BrowserWindow } from 'electron';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { claimWorkspace, createWindow, findWindowForWorkspace, focusExisting, workspaceKey, type LaunchRequest } from './windows';
import { acquire, knock, release, releaseAll, watchForKnocks } from './workspaceLock';

/* ==========================================================================
   Startup.

   Two changes from the original single-window design, both described in
   `windows.ts` and `workspaceLock.ts`:

   - Several windows can be open at once. Two that hold the *same* workspace
     file stay in step through the broadcast hub in `windows.ts`; File ▸ New
     Window opens one that holds nothing and shares nothing.
   - Several *processes* can run at once, as long as they hold different
     workspace files. The old global instance lock became a per-workspace one.

   A launch can name a workspace — `--workspace=<path>`, or a `.mcflow` file
   double-clicked in the shell now that the type is associated with the app. The
   lock is taken before the window exists, and the window holds the path as its
   `LaunchRequest` until the renderer asks for it — see that type for why it is
   no longer pushed on `did-finish-load`.

   **macOS never puts a double-clicked file on the command line** (2026-10-28).
   Finder, *Open With* and a drop on the Dock icon all arrive as `open-file`
   events — before `ready` for the file the app was launched for, and at any
   time after for one opened while it is running, which on a Mac is most of the
   time because closing the last window does not quit. None of it was handled,
   so on a Mac a double-clicked workspace opened an empty window, and one opened
   while MCFlow was running did nothing at all.
   ========================================================================== */

/**
 * The workspace a launch is asking for, if any.
 *
 * `--workspace=<path>`, or a workspace file named on the command line — which is
 * how Windows starts the app when somebody double-clicks one. `.mcflow` is what
 * a save produces since 2026-08-03; `.fcws.json` and `.fcws` stay recognised
 * because a workspace saved before that is still a workspace and double-clicking
 * it should still work once the association is pointed here.
 */
function workspaceFromArgv(argv: string[]): string | null {
  const flag = argv.find((a) => a.startsWith('--workspace='));
  if (flag) return flag.slice('--workspace='.length);
  const file = argv.slice(1).find((a) => /\.(mcflow|fcws)$/i.test(a) || /\.fcws\.json$/i.test(a));
  return file ?? null;
}

/** Files passed on the command line, e.g. by double-clicking a .fcs file. */
function fcsFromArgv(argv: string[]): string[] {
  return argv.filter((a) => a.toLowerCase().endsWith('.fcs'));
}

/** Mutable: on macOS the launch file arrives as an `open-file` event, not in argv. */
let requestedWorkspace = workspaceFromArgv(process.argv);
/** `.fcs` files the launch was asked to open, from argv or from `open-file`. */
const launchFcs: string[] = requestedWorkspace ? [] : fcsFromArgv(process.argv);
/** Whether the first window exists — before it, an `open-file` is the launch itself. */
let started = false;

function isWorkspaceFile(path: string): boolean {
  return /.(mcflow|fcws)$/i.test(path) || /.fcws.json$/i.test(path);
}

/**
 * The conflict check, and the only case the old global lock got right.
 *
 * A launch naming a workspace another live process already holds does not start
 * a rival that would race it to the same file. It knocks — the holder focuses
 * its window — and exits. A launch naming a *different* workspace, or none at
 * all, is not a conflict and starts normally, which is the whole point of the
 * change.
 */
if (requestedWorkspace) {
  const got = acquire(requestedWorkspace);
  if (!got.ok) {
    knock(requestedWorkspace);
    // Give the holder a moment to raise its window before this process vanishes,
    // so the user sees a window come forward rather than a flicker and nothing.
    setTimeout(() => app.exit(0), 700);
  }
}

/*
   Registered in `will-finish-launching`, which is the earliest Electron allows
   and early enough: the launch file's `open-file` is delivered after it and
   before `ready`.
*/
app.on('will-finish-launching', () => {
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (!started) {
      if (isWorkspaceFile(path)) {
        if (requestedWorkspace) return;
        // The same lock the argv path takes at module scope, for the same reason.
        if (acquire(path).ok) requestedWorkspace = path;
        else knock(path);
      } else if (path.toLowerCase().endsWith('.fcs')) {
        launchFcs.push(path);
      }
      return;
    }
    openFromShell(path);
  });
});

/**
 * A file opened from the shell while MCFlow is already running (macOS).
 *
 * A workspace already open in a window brings that window forward; any other
 * opens in a window of its own, exactly as a second process does on Windows. A
 * `.fcs` joins the window in front, as a drop onto it would.
 */
function openFromShell(path: string): void {
  const front = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (isWorkspaceFile(path)) {
    const existing = findWindowForWorkspace(workspaceKey(path));
    if (existing) { focusExisting(existing, path); return; }
    if (!claimWorkspace(path, front)) return;
    createWindow({ workspacePath: path, launch: { workspacePath: path }, offsetFrom: front });
    return;
  }
  if (!path.toLowerCase().endsWith('.fcs')) return;
  if (front) front.webContents.send('open-files', [path]);
  else createWindow({ launch: { fcs: [path] } });
}

function start() {
  const focused = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  // `registerIpc` also installs the window/workspace channels, so end-to-end
  // tests drive the same handlers the app does.
  registerIpc(focused);
  buildMenu(focused);

  const launch: LaunchRequest | null = requestedWorkspace
    ? { workspacePath: requestedWorkspace }
    : launchFcs.length > 0 ? { fcs: [...launchFcs] } : null;
  const win = createWindow({ workspacePath: requestedWorkspace, launch });
  started = true;

  // A second process that wanted this workspace leaves a knock file; bring the
  // window forward and tell the renderer so it can explain why nothing opened.
  const held = requestedWorkspace;
  if (held) {
    watchForKnocks(held, () => {
      const target = findWindowForWorkspace(workspaceKey(held)) ?? win;
      focusExisting(target, held);
    });
  }

  // The Dock icon with no window open: a blank window. It used to be created
  // bound to the launch workspace and never told to open it — an empty window
  // claiming to hold that file.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({});
  });
}

app.whenReady().then(start);

app.on('window-all-closed', () => {
  // Closing one layout window must not take the app with it — `window-all-closed`
  // fires only once every window is gone, which is the correct trigger.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => { releaseAll(); });
app.on('before-quit', () => { if (requestedWorkspace) release(requestedWorkspace); });
