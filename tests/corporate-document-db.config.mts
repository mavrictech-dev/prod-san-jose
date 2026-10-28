import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/corporate-document.integration.ts'],maxWorkers:1,testTimeout:60000,hookTimeout:30000}});
