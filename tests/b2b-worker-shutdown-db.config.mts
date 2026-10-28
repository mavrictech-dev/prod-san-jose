import {defineConfig} from 'vitest/config';import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-worker-shutdown-db.integration.ts'],maxWorkers:1,fileParallelism:false,testTimeout:90000,hookTimeout:120000,watch:false}});
