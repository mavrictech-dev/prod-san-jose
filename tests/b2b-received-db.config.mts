import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
// Keep Main's source aliases (not a duplicate CJS B2bSecurityError class).
// This explicit integration entry is not a conditional skipped default test.
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-received-db.integration.ts'],
  maxWorkers:1,testTimeout:60000,hookTimeout:120000,watch:false}});
