import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-phase8-reports-db.integration.ts','tests/b2b-phase8-reports-history-db.integration.ts'],maxWorkers:1,testTimeout:120000,hookTimeout:120000}});
