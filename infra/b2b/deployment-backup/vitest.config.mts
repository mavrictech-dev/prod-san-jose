import {defineConfig} from 'vitest/config';
export default defineConfig({test: {environment: 'node', include: ['tests/b2b-deployment-backup*.spec.ts'], maxWorkers: 1}});
