import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerSyncIpc } from './windows';
import { exactPageBox } from '../src/core/figure/pdfBox';

/**
 * The native capabilities the renderer cannot provide itself: file dialogs,
 * reads, and writes into a user-chosen export root.
 *
 * Extracted from main.ts so an end-to-end test can register the
 * same handlers against its own window — otherwise the harness runs a renderer
 * whose bridge is attached but inert, and every call fails with
 * "No handler registered".
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const win = () => getWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;

  // The multi-window channels come along with the rest. Every harness already
  // calls `registerIpc`, and a renderer whose sibling-sync calls fail is a
  // renderer running a different code path from the shipped app — which is
  // exactly what registering the real handlers here is meant to prevent.
  registerSyncIpc();

  ipcMain.handle('dialog:openFcs', async () => {
    const w = win();
    const r = await (w
      ? dialog.showOpenDialog(w, OPEN_FCS)
      : dialog.showOpenDialog(OPEN_FCS));
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const w = win();
    const r = await (w
      ? dialog.showOpenDialog(w, OPEN_FOLDER)
      : dialog.showOpenDialog(OPEN_FOLDER));
    if (r.canceled || !r.filePaths[0]) return [];
    const dir = r.filePaths[0];
    const entries = await readdir(dir);
    return entries.filter((e) => e.toLowerCase().endsWith('.fcs')).map((e) => join(dir, e));
  });

  ipcMain.handle('dialog:openText', async (_e, filters: Electron.FileFilter[]) => {
    const w = win();
    const opts: Electron.OpenDialogOptions = {
      title: 'Open workspace',
      properties: ['openFile'],
      filters,
    };
    const r = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:chooseExportDir', async () => {
    const w = win();
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose export destination',
      properties: ['openDirectory', 'createDirectory'],
    };
    const r = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('dialog:saveFile', async (_e, defaultName: string, filters: Electron.FileFilter[]) => {
    const w = win();
    const opts: Electron.SaveDialogOptions = { defaultPath: defaultName, filters };
    const r = await (w ? dialog.showSaveDialog(w, opts) : dialog.showSaveDialog(opts));
    return r.canceled ? null : (r.filePath ?? null);
  });

  ipcMain.handle('fs:readFile', async (_e, path: string) => {
    const buf = await readFile(path);
    // Slice to the exact view so Node's pooled Buffer backing store is not sent.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  // The `.fcs` files in one folder, without a dialog: where a workspace looks
  // for data files that were renamed beside it.
  ipcMain.handle('fs:listFcs', async (_e, dir: string) => {
    const entries = await readdir(dir);
    return entries.filter((e) => e.toLowerCase().endsWith('.fcs')).map((e) => join(dir, e));
  });

  ipcMain.handle('fs:stat', async (_e, path: string) => {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  });

  ipcMain.handle('fs:writeFile', async (_e, path: string, data: ArrayBuffer | string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof data === 'string' ? data : Buffer.from(data));
    return true;
  });

  ipcMain.handle('fs:mkdirp', async (_e, path: string) => {
    await mkdir(path, { recursive: true });
    return true;
  });

  ipcMain.handle('shell:reveal', async (_e, path: string) => {
    shell.showItemInFolder(path);
  });

  /**
   * Render an SVG to PDF via Chromium's own print pipeline.
   *
   * Done in a hidden window rather than with a PDF library: the SVG has already
   * been laid out correctly by a browser engine, so printing it keeps text as
   * real text and vectors as vectors, with no extra dependency.
   */
  ipcMain.handle('export:pdf', async (_e, svg: string, widthPt: number, heightPt: number, title?: string) => {
    const printer = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: false },
    });
    // Written to a temp file rather than passed as a data: URL. Chromium caps
    // data-URL length, and a plot with an embedded event bitmap is several
    // megabytes of base64 — loadURL rejects it with ERR_INVALID_URL.
    const tmp = join(tmpdir(), `mcflow-print-${Date.now()}.html`);
    try {
      // The document title is what Chromium writes as the PDF's /Title, so a
      // figure says what it is in a viewer's document properties too.
      const safeTitle = (title ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      const html =
        `<!doctype html><meta charset="utf-8"><title>${safeTitle}</title>` +
        '<style>@page{margin:0}html,body{margin:0;padding:0;background:transparent}' +
        'svg{display:block}</style>' +
        svg.replace(/^<\?xml[^>]*\?>\s*/, '');
      await writeFile(tmp, html, 'utf8');
      await printer.loadFile(tmp);
      const pdf = await printer.webContents.printToPDF({
        printBackground: true,
        pageSize: { width: widthPt / 72, height: heightPt / 72 },
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: false,
      });
      // The printer snaps the page onto its own device grid, a point or so too
      // big each way; the box is trimmed back to the figure's own size.
      const exact = exactPageBox(pdf, widthPt, heightPt);
      return exact.buffer.slice(exact.byteOffset, exact.byteOffset + exact.byteLength);
    } finally {
      printer.destroy();
      await rm(tmp, { force: true }).catch(() => {});
    }
  });
}

const OPEN_FCS: Electron.OpenDialogOptions = {
  title: 'Import FCS files',
  properties: ['openFile', 'multiSelections'],
  filters: [{ name: 'Flow Cytometry Standard', extensions: ['fcs'] }],
};

const OPEN_FOLDER: Electron.OpenDialogOptions = {
  title: 'Import folder of FCS files',
  properties: ['openDirectory'],
};
