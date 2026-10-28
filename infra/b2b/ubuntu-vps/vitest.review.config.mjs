// Isolated source-only tests. No application/database/Redis setup or cache.
export default {
  test:{include:['tests/b2b-ubuntu-vps*.spec.ts'],environment:'node',maxWorkers:2,cache:false},
};
