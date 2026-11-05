/**
 * Compiles the Electron main process and preload.
 *
 * Kept as a standalone esbuild call rather than a Vite plugin: the main process
 * has no HMR story worth the coupling, and a 30ms build keeps `npm run shoot`
 * fast. Output goes to dist-electron/.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const external = ['electron'];

// ipc.ts, menu.ts, windows.ts and workspaceLock.ts are emitted separately (not
// just inlined into main) so the harnesses in scripts/ can drive the very same
// code the app runs, rather than a re-implementation of it.
//
// `splitting` is what makes that safe. main.ts and menu.ts both import
// windows.ts, which owns the window registry as module state — without shared
// chunks each bundle would get its own copy, and File ▸ New Layout Window would
// register the new window in a map the broadcast hub never reads. With
// splitting, every entry point resolves to one windows module.
await build({
  entryPoints: [
    join(ROOT, 'electron/main.ts'),
    join(ROOT, 'electron/ipc.ts'),
    join(ROOT, 'electron/menu.ts'),
    join(ROOT, 'electron/windows.ts'),
    join(ROOT, 'electron/workspaceLock.ts'),
  ],
  outdir: join(ROOT, 'dist-electron'),
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  sourcemap: true,
});

// The preload must be CommonJS: Electron loads it in a sandboxed context that
// does not support ESM import.
await build({
  entryPoints: [join(ROOT, 'electron/preload.cts')],
  outfile: join(ROOT, 'dist-electron/preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external,
  sourcemap: true,
});

console.log('electron: built dist-electron/{main.js,preload.cjs}');
