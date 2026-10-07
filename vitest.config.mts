// Vitest config. Main-process tests run in plain node with `electron` aliased
// to a stub; renderer tests opt into jsdom with a
// `// @vitest-environment jsdom` docblock at the top of the file.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // Covers ESM/vite-processed imports; test/setup.cjs covers plain require().
    setupFiles: ['./test/setup.cjs'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Renderer tests mutate a global DOM plus a stubbed `ccx` bridge; keep files
    // serial so one file's document cannot leak into another's.
    fileParallelism: false,
    pool: 'forks',
    env: {
      // Never bind the real proxy port during tests.
      CCE_PROXY_PORT: '0',
      // Keep the SDK out of localmodels/proxy tests that spawn fake servers.
      NODE_ENV: 'test',
    },
  },
});