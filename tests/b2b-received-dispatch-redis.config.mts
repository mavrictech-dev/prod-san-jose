import { defineConfig } from 'vitest/config';

// Standalone opt-in suite: never imported by the current QA configuration.
export default defineConfig({
  test: {
    include: ['tests/b2b-received-dispatch-redis.integration.ts'],
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 45000,
    hookTimeout: 10000,
    teardownTimeout: 5000,
  },
});
