import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/b2b-worker-shutdown-redis.integration.ts'],environment:'node',maxWorkers:1,fileParallelism:false,testTimeout:45000,hookTimeout:10000,teardownTimeout:5000}});
