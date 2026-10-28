import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{include:['tests/b2b-batch-evidence-capture-db.integration.ts'],maxWorkers:1,testTimeout:120000,hookTimeout:60000,watch:false}});
