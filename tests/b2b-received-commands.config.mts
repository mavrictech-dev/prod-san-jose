import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
import base from '../vitest.config.mts';
export default defineConfig({...base,resolve:{...base.resolve,alias:[
 {find:/^@factuez\/received-core$/,replacement:fileURLToPath(new URL('../packages/received-core/src/index.ts',import.meta.url))},
 ...(base.resolve?.alias as any[]??[]),
]},test:{...base.test,include:['tests/b2b-received-commands.spec.ts','tests/b2b-received-commands.integration.ts'],
 maxWorkers:1,fileParallelism:false,testTimeout:60000,hookTimeout:120000,watch:false}});
