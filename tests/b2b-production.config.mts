import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({resolve:{alias:[{find:/^@factuez\/service-access\/dist\/(b2b-production-[a-z-]+)$/,replacement:fileURLToPath(new URL('../packages/service-access/src/',import.meta.url))+'$1.ts'}]},test:{include:['tests/b2b-production-*.spec.ts'],environment:'node',maxWorkers:1,testTimeout:30000,hookTimeout:60000}});
