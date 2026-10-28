import {defineConfig,mergeConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import base from '../vitest.config.mts';
const merged=mergeConfig(base,defineConfig({
 resolve:{alias:[
  ...['b2b-readonly-owner','b2b-oauth-http','b2b-runtime-status','b2b-runtime-files','b2b-owner-drain','b2b-maintenance-node'].map(name=>({
   find:new RegExp('^@factuez/service-access/dist/'+name+'$'),
   replacement:fileURLToPath(new URL('../packages/service-access/src/'+name+'.ts',import.meta.url)),
  })),
 ]},
}));
// Explicit overwrite: mergeConfig concatenates include arrays.
export default defineConfig({...merged,test:{...merged.test,
 include:['tests/b2b-readonly-imports.spec.ts','tests/b2b-readonly-publication.integration.ts','tests/b2b-readonly-publication.spec.ts'],
 hookTimeout:120000,testTimeout:30000,maxWorkers:1,
}});
