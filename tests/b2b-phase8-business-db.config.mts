import { defineConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-phase8-business-integration/postgres.integration.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:30000}});
