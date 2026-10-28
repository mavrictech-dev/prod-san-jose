import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/historical-original-postgres.integration.ts'],maxWorkers:1,fileParallelism:false,testTimeout:120000,hookTimeout:120000,watch:false}});
