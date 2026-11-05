/**
 * Platform adapter.
 *
 * The renderer is a plain web app; anything needing the filesystem goes through
 * here. Two implementations back the same interface — the Electron IPC bridge,
 * and a browser fallback built on File/showDirectoryPicker — so no feature code
 * has to know which one it is running on. This is also what lets the whole UI be
 * opened in a browser tab for design iteration.
 */

export interface FileRef {
  /** Stable identity. An absolute path under Electron, a synthetic id in-browser. */
  id: string;
  /** Basename including extension. */
  name: string;
  /** Absolute path when known; null in the browser. */
  path: string | null;
  size: number;
  read(): Promise<ArrayBuffer>;
}

export interface Platform {
  readonly kind: 'electron' | 'browser';
  /** True when the app can write export trees directly to disk. */
  readonly canWriteFiles: boolean;
  /**
   * True when the OS paints its window controls **over** the app's own top bar.
   *
   * macOS under `titleBarStyle: 'hiddenInset'` (see `electron/windows.ts`): the
   * traffic lights float in the top-left of the web contents, so the first thing
   * in the header has to start to the right of them or it is drawn underneath.
   * Windows and Linux keep a real title bar above the contents and reserve
   * nothing. A browser tab reserves nothing either, on either OS — a tab has no
   * window controls inside it, which is why this asks about the *window* and not
   * about the operating system.
   */
  readonly overlaysWindowControls: boolean;

  pickFcsFiles(): Promise<FileRef[]>;
  pickFolder(): Promise<FileRef[]>;
  /** Wrap files that arrived via drag-and-drop. */
  fromDataTransfer(items: FileList | File[]): Promise<FileRef[]>;

  /** Choose a directory to export into. Null when cancelled/unsupported. */
  chooseExportDir(): Promise<string | null>;
  saveFileDialog(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  writeFile(path: string, data: ArrayBuffer | string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;

  /** Join path segments using the platform separator. */
  joinPath(...parts: string[]): string;

  /** Subscribe to a native app event (menu action, file opened from the shell). */
  onNativeEvent?(channel: string, handler: (...args: unknown[]) => void): () => void;

  /**
   * Render an SVG to PDF. Desktop only — the browser has no print pipeline here.
   * `title` becomes the document's `/Title`.
   */
  svgToPdf?(svg: string, widthPt: number, heightPt: number, title?: string): Promise<ArrayBuffer>;

  /**
   * Set the window's zoom factor (1 = 100%). Desktop only.
   *
   * Chromium's page zoom, so every coordinate space scales together. Absent in
   * a browser tab, where `zoomStore` falls back to CSS `zoom` on the root — a
   * tab has no page-zoom API reachable from inside it, and the browser build
   * exists for design iteration rather than for use.
   */
  setZoom?(factor: number): void;

  /** Read a file by absolute path. Only available on the desktop. */
  readFile?(path: string): Promise<ArrayBuffer>;
  statFile?(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** The `.fcs` files in a folder, absolute. Desktop only. */
  listFcs?(dir: string): Promise<string[]>;
  /** Open a file and return its text, via a picker. */
  openTextFile?(filters: { name: string; extensions: string[] }[]): Promise<{ path: string; text: string } | null>;

  /* --- Multiple windows. Desktop only; a browser tab is always one view. --- */

  /** Push shared analysis state to sibling windows on this workspace. */
  broadcastState?(payload: Record<string, unknown>): void;
  /**
   * Open a second, **independent** MCFlow window — blank, sharing nothing.
   *
   * Was `newLayoutWindow`, and opened another view of *this* workspace. Renamed
   * with the behaviour on 2026-08-03: the two windows no longer have anything to
   * do with each other, and a method whose name says "layout" would be the third
   * place in this codebase describing one thing two ways.
   */
  newWindow?(): Promise<boolean>;
  /** The newest snapshot from this window's workspace — pulled at startup, never pushed. */
  requestSync?(): Promise<unknown>;
  /** Tell the shell whether this window has unsaved changes, for the close prompt. */
  setDirty?(dirty: boolean): Promise<boolean>;
  /** Answer the close prompt's Save: the file is written, the window may close. */
  confirmClose?(): Promise<boolean>;
  /** Record which workspace file this window holds, for the per-workspace lock. */
  setWorkspacePath?(path: string | null): Promise<boolean>;
  /** Take the cross-process lock. False when another instance already holds it. */
  claimWorkspace?(path: string): Promise<boolean>;
  windowInfo?(): Promise<{ total: number; onThisWorkspace: number; windowId: string | null }>;
  /**
   * What this window was launched to open, once — pulled after the renderer's
   * handlers exist, never pushed before them. See `electron/windows.ts`.
   */
  takeLaunchRequest?(): Promise<LaunchRequest | null>;
}

/** A workspace, or `.fcs` files, that a window was opened from the shell for. */
export type LaunchRequest = { workspacePath: string } | { fcs: string[] };

interface ElectronBridge {
  isElectron: true;
  openFcsDialog(): Promise<string[]>;
  openFolderDialog(): Promise<string[]>;
  openTextDialog(filters: { name: string; extensions: string[] }[]): Promise<string[]>;
  chooseExportDir(): Promise<string | null>;
  saveFileDialog(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  readFile(path: string): Promise<ArrayBuffer>;
  statFile(path: string): Promise<{ size: number; mtimeMs: number }>;
  listFcs?(dir: string): Promise<string[]>;
  writeFile(path: string, data: ArrayBuffer | string): Promise<boolean>;
  mkdirp(path: string): Promise<boolean>;
  revealInFolder(path: string): Promise<void>;
  on(channel: string, handler: (...args: unknown[]) => void): () => void;
  svgToPdf(svg: string, widthPt: number, heightPt: number, title?: string): Promise<ArrayBuffer>;
  setZoom(factor: number): void;
  broadcastState(payload: unknown): void;
  newWindow(): Promise<boolean>;
  requestSync(): Promise<unknown>;
  setDirty(dirty: boolean): Promise<boolean>;
  confirmClose(): Promise<boolean>;
  setWorkspacePath(path: string | null): Promise<boolean>;
  claimWorkspace(path: string): Promise<boolean>;
  windowInfo(): Promise<{ total: number; onThisWorkspace: number; windowId: string | null }>;
  takeLaunchRequest?(): Promise<LaunchRequest | null>;
}

declare global {
  interface Window {
    mcflow?: ElectronBridge;
  }
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/* -------------------------------------------------------------------------
   Electron
   ------------------------------------------------------------------------- */

function electronPlatform(bridge: ElectronBridge): Platform {
  const sep = navigator.userAgent.includes('Windows') ? '\\' : '/';

  const toRef = async (path: string): Promise<FileRef> => {
    let size = 0;
    try {
      size = (await bridge.statFile(path)).size;
    } catch {
      // A stat failure is not fatal — the read below will surface a real error.
    }
    return { id: path, name: basename(path), path, size, read: () => bridge.readFile(path) };
  };

  return {
    kind: 'electron',
    canWriteFiles: true,
    // The user agent rather than an IPC round trip — the same source `sep` above
    // reads. This is asked during the first layout pass, and a header that
    // reserves the strip one frame late is a header that visibly jumps.
    overlaysWindowControls: /Mac/i.test(navigator.userAgent),
    async pickFcsFiles() {
      return Promise.all((await bridge.openFcsDialog()).map(toRef));
    },
    async pickFolder() {
      return Promise.all((await bridge.openFolderDialog()).map(toRef));
    },
    async fromDataTransfer(items) {
      const files = Array.from(items);
      return Promise.all(
        files.map(async (f) => {
          // Electron exposes the real path on dropped File objects.
          const path = (f as File & { path?: string }).path ?? null;
          if (path) return toRef(path);
          return { id: `drop:${f.name}:${f.size}`, name: f.name, path: null, size: f.size, read: () => f.arrayBuffer() };
        }),
      );
    },
    chooseExportDir: () => bridge.chooseExportDir(),
    saveFileDialog: (n, f) => bridge.saveFileDialog(n, f),
    async writeFile(path, data) {
      await bridge.writeFile(path, data);
    },
    async mkdirp(path) {
      await bridge.mkdirp(path);
    },
    revealInFolder: (p) => bridge.revealInFolder(p),
    joinPath: (...parts) => parts.filter(Boolean).join(sep).replace(/[\\/]+/g, sep),
    onNativeEvent: (channel, handler) => bridge.on(channel, handler),
    svgToPdf: (svg, w, h, title) => bridge.svgToPdf(svg, w, h, title),
    // Guarded: a window opened by a build whose preload predates this method
    // would otherwise throw on the store's first `applyZoom`, which runs before
    // anything is on screen.
    setZoom: (factor) => bridge.setZoom?.(factor),
    readFile: (path) => bridge.readFile(path),
    statFile: (path) => bridge.statFile(path),
    listFcs: async (dir) => (await bridge.listFcs?.(dir)) ?? [],
    async openTextFile(filters) {
      const paths = await bridge.openTextDialog(filters);
      if (!paths.length) return null;
      const buf = await bridge.readFile(paths[0]!);
      return { path: paths[0]!, text: new TextDecoder().decode(buf) };
    },
    broadcastState: (payload) => bridge.broadcastState(payload),
    newWindow: () => bridge.newWindow(),
    requestSync: () => bridge.requestSync(),
    setDirty: (dirty) => bridge.setDirty(dirty),
    confirmClose: () => bridge.confirmClose(),
    setWorkspacePath: (path) => bridge.setWorkspacePath(path),
    claimWorkspace: (path) => bridge.claimWorkspace(path),
    windowInfo: () => bridge.windowInfo(),
    // Guarded like `setZoom`: a preload older than the method answers "nothing".
    takeLaunchRequest: async () => (await bridge.takeLaunchRequest?.()) ?? null,
  };
}

/* -------------------------------------------------------------------------
   Browser
   ------------------------------------------------------------------------- */

function browserPlatform(): Platform {
  let counter = 0;
  const wrap = (f: File): FileRef => ({
    id: `file:${++counter}:${f.name}:${f.size}`,
    name: f.name,
    path: null,
    size: f.size,
    read: () => f.arrayBuffer(),
  });

  const openInput = (opts: { directory?: boolean }): Promise<FileRef[]> =>
    new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (opts.directory) input.setAttribute('webkitdirectory', '');
      else input.accept = '.fcs';
      input.style.display = 'none';
      // A cancelled picker fires no event in some browsers; resolve on focus return.
      const done = (files: File[]) => {
        input.remove();
        resolve(files.filter((f) => f.name.toLowerCase().endsWith('.fcs')).map(wrap));
      };
      input.addEventListener('change', () => done(Array.from(input.files ?? [])));
      input.addEventListener('cancel', () => done([]));
      document.body.appendChild(input);
      input.click();
    });

  const unsupported = (what: string) => {
    throw new Error(
      `${what} requires the desktop app. Running in a browser tab, MCFlow can read files but cannot write them back to disk.`,
    );
  };

  return {
    kind: 'browser',
    canWriteFiles: false,
    // A tab has no window controls inside it, on any OS.
    overlaysWindowControls: false,
    pickFcsFiles: () => openInput({}),
    pickFolder: () => openInput({ directory: true }),
    async fromDataTransfer(items) {
      return Array.from(items)
        .filter((f) => f.name.toLowerCase().endsWith('.fcs'))
        .map(wrap);
    },
    async chooseExportDir() {
      return null;
    },
    async saveFileDialog(defaultName) {
      return defaultName;
    },
    async writeFile(path, data) {
      // Browser fallback: hand the file to the download manager.
      const blob = data instanceof ArrayBuffer ? new Blob([data]) : new Blob([data], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = basename(path);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    async mkdirp() {
      /* no directories in the browser fallback */
    },
    async revealInFolder() {
      unsupported('Reveal in folder');
    },
    joinPath: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    async openTextFile(filters) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
        input.addEventListener('change', async () => {
          const f = input.files?.[0];
          resolve(f ? { path: f.name, text: await f.text() } : null);
        });
        input.addEventListener('cancel', () => resolve(null));
        input.click();
      });
    },
  };
}

/* -------------------------------------------------------------------------
   Selection
   ------------------------------------------------------------------------- */

let cached: Platform | null = null;

export function platform(): Platform {
  if (!cached) {
    cached = typeof window !== 'undefined' && window.mcflow?.isElectron
      ? electronPlatform(window.mcflow)
      : browserPlatform();
  }
  return cached;
}
