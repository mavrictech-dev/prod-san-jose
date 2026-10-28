import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const local=(s:string)=>fileURLToPath(new URL(s,import.meta.url));
export default defineConfig({
 resolve:{alias:[
 {find:'@factuez/contracts/production-batches',replacement:local('../packages/contracts/src/production-batches.ts')},
 {find:'@factuez/sunat-core/dist/production-batches-proof',replacement:local('../packages/sunat-core/src/production-batches-proof.ts')},
 {find:'@factuez/sunat-core/dist/production-batches',replacement:local('../packages/sunat-core/src/production-batches.ts')},
 ]},
 test:{include:['tests/production-batches*.spec.ts'],environment:'node',maxWorkers:2},
});
