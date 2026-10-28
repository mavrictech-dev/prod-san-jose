import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/phase7-crypto-db.integration.ts'],maxWorkers:1,
  testTimeout:120000,hookTimeout:120000,watch:false}});
