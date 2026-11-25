import { defineConfig, loadEnv } from 'vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: '/',
    server: {
      port: parseInt(env.PORT || '5173'),
      // With VITE_API_URL unset the client dials its own origin, so /socket.io
      // must be forwarded to the backend. Without ws: true the upgrade fails and
      // socket.io silently lands on Vite's HMR socket instead.
      proxy: {
        '/socket.io': {
          // API_PROXY_TARGET lets the browser e2e suite point this at the port its
          // own backend was started on (see e2e/playwright.config.ts).
          target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
          ws: true,
          changeOrigin: true,
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, '../shared')
      }
    },
    build: {
      outDir: 'dist',
    },
  };
});