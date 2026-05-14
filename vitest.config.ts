import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    globals: false,
    environment: 'node',
    testTimeout: 10000,
  },
});
