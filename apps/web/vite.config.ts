import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The dashboard imports @attentio/shared for real (category labels, colours,
// duration formatting, focus metadata) rather than re-declaring them, so the
// phone and the terminal can never disagree about what "deep work" is called.
// Aliasing straight at the sources removes any build-order coupling.
const shared = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [preact()],
  resolve: {
    alias: { '@attentio/shared': shared },
  },
  // Relative asset paths so the build works whether it is served at the root of
  // the daemon or opened from a subdirectory.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    // `npm run web` is for developing the UI against a running daemon.
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: process.env['ATTENTIO_ORIGIN'] ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
