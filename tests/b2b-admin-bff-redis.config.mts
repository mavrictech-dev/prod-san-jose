import {defineConfig} from 'vitest/config';
import base from '../vitest.config.mts';
export default defineConfig({...base,test:{...base.test,include:['tests/b2b-admin-bff-redis.integration.ts'],maxWorkers:1,testTimeout:120000,hookTimeout:30000}});
