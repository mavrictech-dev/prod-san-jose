import {defineConfig} from 'vitest/config';import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-recovery.integration.ts'],maxWorkers:1,fileParallelism:false,testTimeout:240000,hookTimeout:240000,watch:false}});
