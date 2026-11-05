import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

// The version a figure's notes name, so a methods section can cite the build
// that drew it. Read from the manifest — the only place the version lives.
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

// The renderer is a plain web app. Electron is layered on top rather than baked
// in, so the whole UI can be opened in a browser for fast visual iteration and
// screenshot-based design QA. Platform-specific capability (native file dialogs,
// writing export trees to disk) goes through the adapter in src/platform.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: { __MCFLOW_VERSION__: JSON.stringify(version) },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: { port: 5273, strictPort: false },
});
