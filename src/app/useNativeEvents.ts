import { useEffect } from 'react';
import { platform } from '@/platform';
import { usePlot } from '@/state/plotStore';
import { useUI, type MainView } from '@/state/uiStore';
import { spilloverPanel, viewLockReason } from '@/state/viewLock';
import { useWorkspace } from '@/state/workspaceStore';
import { openWorkspaceAt, openWorkspaceFile, reportRestore, saveWorkspaceToFile } from '@/state/workspaceIO';
import { loadUnmixingMatrixFromFile, saveUnmixingMatrixToFile } from '@/state/unmixingIO';
import { startWindowSync } from '@/state/windowSync';
import { startDirtyTracking } from '@/state/dirtyStore';
import { baseName } from '@/core/workspacePaths';

/**
 * Bridges the native menu and shell file-opens into the app.
 *
 * The menu is a second route to commands the palette already implements, not a
 * parallel implementation — each handler here calls the same store actions.
 * In a browser tab `onNativeEvent` is absent and this hook does nothing.
 */
export function useNativeEvents(): void {
  useEffect(() => {
    const p = platform();
    if (!p.onNativeEvent) return;

    const ui = useUI.getState();
    /*
       A menu item is the third route to a view, and it asks the same lock the
       switcher and the palette do. A menu entry cannot be disabled from here, so
       a locked one posts the reason rather than doing nothing — a menu item that
       silently declines is indistinguishable from one that is broken.
    */
    const goto = (v: MainView) => () => {
      const locked = viewLockReason(v);
      if (locked) { useUI.getState().setNotice({ tone: 'warn', text: locked }); return; }
      useUI.getState().setView(v);
    };

    const handlers: Record<string, (...args: unknown[]) => void> = {
      'menu:import': async () => {
        useWorkspace.getState().importFiles(await p.pickFcsFiles());
      },
      'menu:import-folder': async () => {
        useWorkspace.getState().importFiles(await p.pickFolder());
      },
      'menu:save-workspace': () => { void saveWorkspaceToFile('MCFlow workspace'); },
      'menu:open-workspace': () => { void openWorkspaceFile(); },

      /*
         The Save button on the close prompt.

         The window is already mid-close and waiting on this. `confirmClose` is
         called only when a path came back, because `saveWorkspaceToFile`
         returns null both when the user cancels the file dialog and when the
         per-workspace lock refuses — and in neither case has anything been
         written, so closing would discard exactly what the prompt was asking
         about. Doing nothing leaves the window open, which is the safe answer.
      */
      'window:save-and-close': () => {
        void saveWorkspaceToFile('MCFlow workspace')
          .then((path) => { if (path) void p.confirmClose?.(); })
          .catch((e) => {
            useUI.getState().setNotice({
              tone: 'err',
              text: `Could not save: ${e instanceof Error ? e.message : String(e)}`,
            });
          });
      },
      'menu:export': goto('export'),
      'menu:palette': () => useUI.getState().setCommandPaletteOpen(true),

      /*
         The matrix is reachable from the menu as well as the two spillover
         panels, because loading one into a brand-new workspace is a first
         action, taken before there is any reference panel to load it from.

         **Which panel that is, is asked rather than assumed** (2026-08-29).
         Both handlers used to route to Unmixing unconditionally, so on a
         conventional workspace the menu moved the user off Compensation to save
         a file it then wrote as `.compensation`. The menu's own labels are
         `Save Matrix…` / `Load Matrix…` — a native menu is built in the main
         process and cannot know which panel is open, so it names the thing
         rather than the panel, and `spilloverPanel` resolves it here.
      */
      'menu:save-unmixing': () => {
        const panel = spilloverPanel(useUI.getState().view);
        useUI.getState().setView(panel);
        void saveUnmixingMatrixToFile(panel === 'compensation' ? 'Compensation panel' : 'Unmixing panel').catch((e) => {
          useUI.getState().setNotice({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
        });
      },
      'menu:load-unmixing': () => {
        const panel = spilloverPanel(useUI.getState().view);
        useUI.getState().setView(panel);
        void loadUnmixingMatrixFromFile(panel)
          .then((r) => {
            if (!r) return;
            useUI.getState().setNotice({ tone: r.report.applied ? 'ok' : 'err', text: r.report.message });
          })
          .catch((e) => {
            useUI.getState().setNotice({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
          });
      },

      // A second process wanted the workspace this window holds. It knocked and
      // exited; this window was focused. Say so, or the user sees their existing
      // window come forward with no explanation for why the launch "did nothing".
      'workspace:already-open': (...args) => {
        useUI.getState().setNotice({
          tone: 'warn',
          text: `This workspace is already open in this window. ${String(args[0] ?? '')}`,
        });
      },
      'menu:view-analysis': goto('analysis'),
      'menu:view-parameters': goto('parameters'),
      'menu:view-unmixing': goto('unmixing'),
      'menu:view-compensation': goto('compensation'),
      'menu:view-statistics': goto('statistics'),
      'menu:view-export': goto('export'),
      'menu:view-umap': goto('umap'),
      'menu:view-biophysics': goto('biophysics'),
      'menu:toggle-theme': () => useUI.getState().toggleTheme(),
      'menu:add-plot': () => {
        useUI.getState().setView('analysis');
        usePlot.getState().addPanel();
      },
      'menu:new-layout': () => { void platform().newWindow?.(); },

      /*
         A workspace double-clicked in the shell, or named on the command line.

         Sent by the main process once this window has loaded, which is the whole
         of what makes the `.mcflow` file association worth having: registering
         the type tells Windows to launch MCFlow, and nothing until now told
         MCFlow to *open the file it was launched for*. The lock was already
         taken against it at startup, so `restoreWorkspace` is called directly —
         `openWorkspaceFile` would put a picker in front of a path the user has
         already chosen by double-clicking it.
      */
      'open-workspace-path': (...args) => { void openWorkspacePath(args[0] as string | undefined); },

      // Files double-clicked in the shell, or passed on the command line.
      'open-files': (...args) => { void openFcsPaths((args[0] as string[] | undefined) ?? []); },
    };

    void ui;
    const unsubscribes = Object.entries(handlers).map(([channel, fn]) => p.onNativeEvent!(channel, fn));
    /*
       And then ask what this window was launched for — after the handlers
       exist, which is the whole point. See `LaunchRequest` in
       `electron/windows.ts` for the dropped message this replaced.
    */
    void p.takeLaunchRequest?.().then((launch) => {
      if (!launch) return;
      if ('workspacePath' in launch) void openWorkspacePath(launch.workspacePath);
      else void openFcsPaths(launch.fcs);
    });
    // Sibling-window sync lives on the same lifecycle as the native bridge:
    // both exist only on the desktop and both belong to this window.
    const stopSync = startWindowSync();
    // And so does the unsaved-changes flag — it exists to answer a question the
    // shell asks, so it is attached where the shell is.
    const stopDirty = startDirtyTracking();
    return () => {
      stopDirty();
      stopSync();
      for (const off of unsubscribes) off();
    };
  }, []);
}

/**
 * Open a workspace by path — one double-clicked in the shell, named on the
 * command line, or handed to this window as its launch request.
 *
 * The lock was already taken by the main process, so this goes straight to
 * `openWorkspaceAt`; `openWorkspaceFile` would put a picker in front of a path
 * the user has already chosen. It finds moved files, asks about any it cannot,
 * and reports through `reportRestore` exactly as File ▸ Open does.
 */
async function openWorkspacePath(path: string | undefined): Promise<void> {
  const p = platform();
  if (!path || !p.readFile) return;
  try {
    const text = new TextDecoder().decode(await p.readFile(path));
    const result = await openWorkspaceAt(path, text);
    reportRestore(path, result);
    if (result) await p.setWorkspacePath?.(path);
  } catch (e) {
    reportRestore(path, e instanceof Error ? e : new Error(String(e)));
  }
}

/** `.fcs` files double-clicked in the shell, passed on the command line, or a launch request. */
async function openFcsPaths(paths: string[]): Promise<void> {
  const p = platform();
  if (!paths.length || !p.readFile || !p.statFile) return;
  const refs = await Promise.all(paths.map(async (path) => ({
    id: path,
    // `baseName` takes both separators. This route once split on the forward
    // slash alone, and a double-clicked Windows file was listed as its whole path.
    name: baseName(path),
    path,
    size: (await p.statFile!(path)).size,
    read: () => p.readFile!(path),
  })));
  await useWorkspace.getState().importFiles(refs);
  useUI.getState().setView('analysis');
}
