/**
 * Where this build's files are, in a module system that has no `__dirname`.
 *
 * ## The bug this exists to stop happening again (2026-08-14)
 *
 * `electron/menu.ts` reached for `__dirname` to find `build/icon.png` for the
 * About box, and **`__dirname` does not exist here**. `scripts/build-electron.mjs`
 * emits `format: 'esm'`; the identifier is a CommonJS wrapper argument, so in an
 * ES module it is a free variable and reading it is a `ReferenceError`. Clicking
 * *Help ▸ About MCFlow* threw:
 *
 *     ReferenceError: __dirname is not defined
 *         at click (dist-electron/chunk-MDZLN5BQ.js:130:58)
 *
 * which Electron surfaces as a native error dialog with a stack trace in it —
 * which is what the report described as "a Java error". Nothing about it was
 * Java and nothing about it was the dialog's own code.
 *
 * ## Why it was not caught
 *
 * **`tsc --noEmit` passes.** `@types/node` declares `__dirname` as an ambient
 * global, because it is one in CommonJS, and TypeScript has no way to know which
 * module format esbuild is about to emit. So the one check that would obviously
 * have caught a missing identifier is exactly the check that cannot.
 *
 * `electron/windows.ts` had already met this and solved it privately, with its
 * own `const __dirname = dirname(fileURLToPath(import.meta.url))` at the top of
 * the file. That is the correct fix and the wrong place for it: it made the
 * working file look like it needed no special handling, so the next file to want
 * a path — this one — was written against the global that appeared to exist.
 *
 * ## The rule
 *
 * > No file in `electron/` refers to `__dirname`. Anything that needs a path
 * > asks this module.
 *
 * One module, so the ESM/CJS question is answered once and a new file cannot
 * answer it wrong by omission. `resourcePath` resolves against the emitted
 * bundle's own directory — `dist-electron/`, for the entry points and for every
 * shared chunk — which is what `windows.ts` was already doing and what the
 * packaged app's layout expects.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The directory this bundle was emitted into: `dist-electron/`. */
export const bundleDir = dirname(fileURLToPath(import.meta.url));

/**
 * A path relative to the application root — the folder holding `dist-electron`,
 * `dist` and `build`.
 *
 * Written as a function rather than a constant so a call site reads as what it
 * is asking for (`resourcePath('build/icon.png')`) rather than as string
 * arithmetic over a directory it has to know the shape of.
 */
export function resourcePath(...parts: string[]): string {
  return join(bundleDir, '..', ...parts);
}

/** A path inside the emitted bundle itself — `preload.cjs` and nothing else so far. */
export function bundlePath(...parts: string[]): string {
  return join(bundleDir, ...parts);
}
