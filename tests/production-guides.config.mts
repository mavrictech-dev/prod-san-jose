import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({resolve:{alias:[
 {find:/^@factuez\/sunat-core\/dist\/production-guides-private$/,replacement:fileURLToPath(new URL('../packages/sunat-core/src/production-guides-private.ts',import.meta.url))},
 {find:/^@factuez\/sunat-core\/dist\/production-guides$/,replacement:fileURLToPath(new URL('../packages/sunat-core/src/production-guides.ts',import.meta.url))}
]},test:{include:['tests/production-guides*.spec.ts'],maxWorkers:1,testTimeout:60000,hookTimeout:60000}});
