import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/historical-generation-link-postgres-b2b09.integration.ts'],maxWorkers:1,fileParallelism:false,testTimeout:120000,hookTimeout:120000,watch:false}});

