import {defineConfig,mergeConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import base from '../vitest.config.mts';
const merged=mergeConfig(base,defineConfig({
 resolve:{alias:['b2b-readonly-owner','b2b-runtime-files','b2b-owner-drain'].map(name=>({
  find:new RegExp('^@factuez/service-access/dist/'+name+'$'),
  replacement:fileURLToPath(new URL('../packages/service-access/src/'+name+'.ts',import.meta.url)),
 }))},
}));
export default defineConfig({...merged,test:{...merged.test,include:['tests/b2b-onprem-admin*.spec.ts'],maxWorkers:1,hookTimeout:30000,testTimeout:20000}});
