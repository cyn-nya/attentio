import { defineConfig, mergeConfig } from 'vite';

import base from './vite.config.ts';

// A dedicated config for the render smoke test. The app config hashes entry
// filenames (right for a deployed bundle) which would make the test's output
// path unpredictable, so this overrides just the output naming.
export default mergeConfig(
  base,
  defineConfig({
    build: {
      outDir: '.smoke',
      emptyOutDir: true,
      ssr: 'smoke/render.tsx',
      rollupOptions: {
        output: {
          entryFileNames: 'render.mjs',
          chunkFileNames: 'chunk-[name].mjs',
          assetFileNames: 'asset-[name][extname]',
        },
      },
    },
  }),
);
