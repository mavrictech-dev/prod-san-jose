import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({ ...base, test: { include: ['tests/b2b-batch-operations-db.integration.ts'], maxWorkers: 1,
  testTimeout: 120000, hookTimeout: 120000, watch: false } });
