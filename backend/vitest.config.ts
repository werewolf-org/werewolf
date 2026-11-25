import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared')
    }
  },
  test: {
    // The e2e suite starts a real server and drives real sockets, so the default 5s is too tight.
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
