import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Scenarios use real UDP sockets; each file gets its own worker process.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
