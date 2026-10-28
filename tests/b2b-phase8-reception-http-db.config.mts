import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-phase8-reception-http-db.integration.ts'],maxWorkers:1,testTimeout:90000,hookTimeout:90000,watch:false}});
