import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Point at source, not a build artifact: the shared simulation is compiled
      // by Vite along with the client, so editing it hot-reloads the game.
      '@oneshot/shared': `${sharedSrc}/index.ts`,
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    proxy: {
      // The client always talks to a same-origin `/ws`; in dev that is proxied to
      // the game server, in production the game server serves the client directly.
      '/ws': { target: 'ws://localhost:8787', ws: true },
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
