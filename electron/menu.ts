import { app, BrowserWindow, Menu, dialog, nativeImage, shell } from 'electron';
import { resourcePath } from './appPaths';
import { createWindow } from './windows';

/**
 * The papers behind what this application implements.
 *
 * A list rather than a single item, so adding the next one is adding a line
 * here. The label is what a reader would call the paper — the journal and the
 * subject — rather than a full citation, because a menu item is a few
 * characters wide and the URL is on the tooltip.
 *
 * Opened in the system browser; see the note at the call site.
 */
const SCIENTIFIC_PAPERS: Array<{ label: string; url: string }> = [
  {
    label: 'Spectral biophysical cytometry — Nature Nanotechnology',
    url: 'https://www.nature.com/articles/s41565-026-02236-8',
  },
  {
    label: 'Conventional biophysical cytometry — Nature Chemical Biology',
    url: 'https://www.nature.com/articles/s41589-026-02322-x',
  },
];

/**
 * File ▸ New Window: a second, independent MCFlow.
 *
 * Blank — no samples, no gates, no panels, and no sync with the window it was
 * opened from. It was *New Layout Window* and opened another view of the same
 * workspace; the real use is two experiments side by side, which needs
 * independence rather than agreement. `New Layout`, inside the window, is where
 * a second worksheet over the same samples still lives.
 */
function newWindow(from: BrowserWindow | null): void {
  createWindow({ workspacePath: null, offsetFrom: from });
}

/**
 * Native application menu.
 *
 * Packaged software is expected to have one — File/Edit/View/Help is where
 * people look for "open", "save" and "what version is this". Actions that need
 * app state are forwarded to the renderer, which already implements them for
 * the command palette; the menu is a second route to the same commands rather
 * than a parallel implementation.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string) => () => getWindow()?.webContents.send(channel);
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' as const },
            { type: 'separator' as const },
            { role: 'hide' as const },
            { role: 'hideOthers' as const },
            { type: 'separator' as const },
            { role: 'quit' as const },
          ],
        }]
      : []),
    {
      label: '&File',
      submenu: [
        { label: 'Import FCS Files…', accelerator: 'CmdOrCtrl+O', click: send('menu:import') },
        { label: 'Import Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: send('menu:import-folder') },
        { type: 'separator' },
        { label: 'Open Workspace…', click: send('menu:open-workspace') },
        { label: 'Save Workspace…', accelerator: 'CmdOrCtrl+S', click: send('menu:save-workspace') },
        { type: 'separator' },
        // A second, independent workspace — not a second view of this one. The
        // label changed with the behaviour on 2026-08-03: "New Layout Window"
        // described the shared-view thing it used to be, and leaving the name on
        // an action that now does the opposite is worse than renaming it.
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => { void newWindow(getWindow()); } },
        { type: 'separator' },
        // Named for the artefact, not for the panel. A native menu is built here
        // in the main process and cannot see which of Unmixing or Compensation
        // is open; the renderer resolves that through `spilloverPanel` when the
        // item fires. *Unmixing Matrix* in a conventional workspace was naming
        // the wrong instrument on every one of these two lines.
        { label: 'Save Matrix…', click: send('menu:save-unmixing') },
        { label: 'Load Matrix…', click: send('menu:load-unmixing') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('menu:export') },
        { type: 'separator' },
        // Close, not quit: with several windows open, File ▸ Quit taking the
        // whole app down from any one of them is the wrong default.
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        // Not `role: 'undo'`. That role only ever reaches a focused text field,
        // so the app's own analysis history — gates, panels, matrices — had no
        // route to the menu or to Ctrl+Z at all. The renderer decides which of
        // the two undos the user meant from where focus is; see useUndoRedo.ts.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        // "Search", not "Command Palette". The thing it opens is the same
        // dialog the top bar's own control opens, that control has always been
        // labelled Search, and two names for one surface is two features as far
        // as anyone reading a menu is concerned.
        { label: 'Search', accelerator: 'CmdOrCtrl+K', click: send('menu:palette') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Analysis', click: send('menu:view-analysis') },
        { label: 'Parameters', click: send('menu:view-parameters') },
        { label: 'Unmixing', click: send('menu:view-unmixing') },
        { label: 'Compensation', click: send('menu:view-compensation') },
        { label: 'Statistics', click: send('menu:view-statistics') },
        { label: 'Export', click: send('menu:view-export') },
        // After a separator, matching the gap in the window's own view switcher
        // and for the same reason: the five above are stages of one pipeline and
        // these two are analyses that run on top of it. See `MainView`.
        { type: 'separator' },
        { label: 'UMAP', click: send('menu:view-umap') },
        { label: 'Biophysics', click: send('menu:view-biophysics') },
        { type: 'separator' },
        { label: 'Switch Theme', click: send('menu:toggle-theme') },
        { label: 'Add Plot', click: send('menu:add-plot') },
        { type: 'separator' },
        /*
           No zoom items, and no developer-tools item.

           `resetZoom` / `zoomIn` / `zoomOut` were Electron's own roles, which
           drive `webContents.setZoomLevel` from the menu and from nowhere else:
           there was no readout, no way to see that the window was at 110%, and
           nothing in the window itself to press. The app has a real zoom control
           in the bottom-right corner now — a percentage with −/+ either side and
           a reset — and Ctrl+wheel anywhere in the window. Leaving the menu items
           beside it would give one setting two owners with two ideas of what the
           current level is; the renderer owns it.

           `toggleDevTools` is removed outright. It is a development affordance
           in a shipped scientific application, and a user who finds it by
           accident gets a panel of stack traces over their worksheet.
        */
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: 'About MCFlow',
          click: () => {
            const w = getWindow();
            // The app's own version, and nothing about the runtime it happens
            // to be built on. Electron's and Chromium's versions answered a
            // question nobody using this asks — they are an implementation
            // detail of the shell, not a property of the analysis software —
            // and they made a three-line box out of a one-line fact.
            const detail = [
              `Version ${app.getVersion()}`,
              '',
              'Biophysical analysis software',
            ].join('\n');
            /*
               The mark, rather than Windows' generic blue "i" (2026-08-13).

               This box is the one place in the application that exists to say
               what the program *is*, and it was showing the operating system's
               information glyph — the same picture every dialog in Windows uses
               to say "note". `icon` overrides the glyph `type` would supply, so
               the About box now shows the same artwork as the taskbar, the
               title bar and the header, from the same file. Resized here rather
               than emitted at another size by `make-icon.mjs`: a message box
               draws its icon at 32-ish device-independent pixels, and 64 is what
               is already on disk with the headroom for it.

               ## And it threw for a year of nothing, then every time (2026-08-14)

               This read `join(__dirname, '../build/icon.png')` when it was
               written, and `__dirname` does not exist in this bundle — the main
               process is emitted as ESM, where the identifier is a free
               variable. So the item that exists to say what the program *is*
               answered every click with `ReferenceError: __dirname is not
               defined` in a native error dialog. `tsc` passes on it, because
               `@types/node` declares the global unconditionally. See
               `appPaths.ts` for the rule that replaced it.

               **Wrapped, and the icon is optional either way.** A missing or
               unreadable file already degraded to the OS glyph through
               `isEmpty()`; a *throw* is different in kind, and an About box that
               crashes rather than showing a plainer icon is the wrong trade
               whatever the reason.
            */
            const icon = (() => {
              try {
                return nativeImage
                  .createFromPath(resourcePath('build', 'icon.png'))
                  .resize({ width: 64, height: 64, quality: 'best' });
              } catch {
                return nativeImage.createEmpty();
              }
            })();
            const opts: Electron.MessageBoxOptions = {
              type: 'info', title: 'About MCFlow', message: 'MCFlow', detail, buttons: ['OK'],
              ...(icon.isEmpty() ? {} : { icon }),
            };
            if (w) dialog.showMessageBox(w, opts);
            else dialog.showMessageBox(opts);
          },
        },
        // *Open Data Folder* is removed. It opened the OS Documents directory,
        // which is not where anything this app writes actually lives — samples
        // are wherever the user imported them from and an export goes to a
        // folder chosen in the dialog — so it was a menu item that reliably
        // opened the wrong folder.
        { type: 'separator' },
        /*
           Scientific papers.

           A section rather than a loose item, because it is a list that will
           grow: the methods this application implements are described somewhere,
           and the operator reading a membrane-order histogram is the person most
           likely to want the paper behind it. A submenu is what a menu bar has
           instead of a heading — the label names the group and the items are the
           papers.

           `shell.openExternal` rather than a `BrowserWindow`. A journal page in
           an Electron window is a browser this application has no business
           being: no address bar, no tabs, no password manager, no reader mode,
           and a `window.open` from it would land nowhere. The system browser is
           where a link belongs, and it is also the one that already has the
           reader's institutional session.
        */
        {
          label: 'Scientific papers',
          submenu: SCIENTIFIC_PAPERS.map((p) => ({
            label: p.label,
            toolTip: p.url,
            click: () => { void shell.openExternal(p.url); },
          })),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
