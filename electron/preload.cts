import { contextBridge, ipcRenderer, webFrame } from 'electron';

/**
 * The only surface the renderer sees. Mirrored by the browser fallback in
 * src/platform/ so the app runs identically in a plain browser tab for
 * development and visual QA.
 */
const api = {
  isElectron: true as const,

  openFcsDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFcs'),
  openFolderDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFolder'),
  openTextDialog: (filters: { name: string; extensions: string[] }[]): Promise<string[]> =>
    ipcRenderer.invoke('dialog:openText', filters),
  chooseExportDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseExportDir'),
  saveFileDialog: (defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> =>
    ipcRenderer.invoke('dialog:saveFile', defaultName, filters),

  readFile: (path: string): Promise<ArrayBuffer> => ipcRenderer.invoke('fs:readFile', path),
  statFile: (path: string): Promise<{ size: number; mtimeMs: number }> => ipcRenderer.invoke('fs:stat', path),
  listFcs: (dir: string): Promise<string[]> => ipcRenderer.invoke('fs:listFcs', dir),
  writeFile: (path: string, data: ArrayBuffer | string): Promise<boolean> =>
    ipcRenderer.invoke('fs:writeFile', path, data),
  mkdirp: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:mkdirp', path),
  svgToPdf: (svg: string, widthPt: number, heightPt: number, title?: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('export:pdf', svg, widthPt, heightPt, title),
  revealInFolder: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),

  /**
   * Application zoom, as Chromium's own page zoom.
   *
   * `webFrame` rather than an IPC round-trip to `webContents.setZoomFactor`:
   * this runs in the renderer process already, the call is synchronous, and it
   * is driven by a wheel gesture where a promise per notch would be visible.
   *
   * Page zoom rather than a CSS transform is the whole point — every coordinate
   * space moves together, so the plot's pointer arithmetic and canvas sizing
   * need to know nothing about it. See `state/zoomStore.ts`.
   */
  setZoom: (factor: number): void => { webFrame.setZoomFactor(factor); },

  /* --- Multiple windows on one workspace --- */

  /**
   * Push this window's analysis state to its siblings.
   *
   * `send`, not `invoke`: a broadcast has no reply worth waiting for, and this
   * fires on every debounced store change.
   */
  broadcastState: (payload: unknown): void => { ipcRenderer.send('sync:broadcast', payload); },
  /** Open another window onto the same workspace. */
  /** File ▸ New Window — an independent, blank instance. See electron/windows.ts. */
  newWindow: (): Promise<boolean> => ipcRenderer.invoke('window:new'),
  /** The newest snapshot from this window's workspace, for a window that just opened onto one. */
  requestSync: (): Promise<unknown> => ipcRenderer.invoke('window:requestSync'),
  /** Whether this window has unsaved changes, so a close can ask before discarding them. */
  setDirty: (dirty: boolean): Promise<boolean> => ipcRenderer.invoke('window:setDirty', dirty),
  /** "The save finished — you may close now." Answers the Save button on that prompt. */
  confirmClose: (): Promise<boolean> => ipcRenderer.invoke('window:confirmClose'),
  /** Tell the main process which workspace file this window now holds. */
  setWorkspacePath: (path: string | null): Promise<boolean> =>
    ipcRenderer.invoke('window:setWorkspace', path),
  /** Take the cross-process lock on a workspace. False when another instance holds it. */
  claimWorkspace: (path: string): Promise<boolean> => ipcRenderer.invoke('workspace:claim', path),
  /** What this window was opened for — a workspace or .fcs files — handed over once. */
  takeLaunchRequest: (): Promise<{ workspacePath: string } | { fcs: string[] } | null> =>
    ipcRenderer.invoke('window:takeLaunchRequest'),
  windowInfo: (): Promise<{ total: number; onThisWorkspace: number; windowId: string | null }> =>
    ipcRenderer.invoke('window:count'),

  /**
   * Subscribe to a main-process message (menu actions, files opened from the
   * shell). Returns an unsubscribe function.
   */
  on: (channel: string, handler: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: unknown, ...args: unknown[]) => handler(...args);
    ipcRenderer.on(channel, listener);
    return () => { ipcRenderer.removeListener(channel, listener); };
  },
};

contextBridge.exposeInMainWorld('mcflow', api);

export type McFlowBridge = typeof api;
