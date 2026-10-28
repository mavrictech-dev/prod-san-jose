import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/production-received-workflow.integration.ts'],maxWorkers:1,testTimeout:240000,hookTimeout:120000,watch:false}});
