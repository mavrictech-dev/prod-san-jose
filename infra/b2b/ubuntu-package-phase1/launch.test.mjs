import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {launch} from './launch.mjs';

test('disabled and malformed configuration fail before importing application', async () => {
  let loads = 0;
  const load = async () => { loads++; throw Error('must not load'); };
  for (const env of [{}, {B2B_API_ENABLED:'false'}, {B2B_API_ENABLED:'true'},
    {B2B_API_ENABLED:'true', B2B_API_CONFIG_ROOT:'relative'},
    {B2B_API_ENABLED:'true', B2B_API_CONFIG_ROOT:'/'},
    {B2B_API_ENABLED:'true', B2B_API_CONFIG_ROOT:'/run/../etc'}]) {
    await assert.rejects(launch(env, load));
  }
  assert.equal(loads, 0);
});
test('enabled launcher passes the exact environment and requires a started runtime', async () => {
  const env = {B2B_API_ENABLED:'true', B2B_API_CONFIG_ROOT:'/run/factuez'};
  const runtime = {};
  assert.equal(await launch(env, async () => ({bootstrapB2bApi: async e => { assert.equal(e, env); return runtime; }})), runtime);
  await assert.rejects(launch(env, async () => ({})), /BOOTSTRAP_MISSING/);
  await assert.rejects(launch(env, async () => ({bootstrapB2bApi: async () => null})), /RUNTIME_NOT_STARTED/);
});
test('real entrypoint exits blocked with no opt-in, even without compiled application', () => {
  const entry = fileURLToPath(new URL('./launch.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry], {env: {}, encoding:'utf8'});
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'B2B_API_PACKAGE_STARTUP_BLOCKED\n');
});
