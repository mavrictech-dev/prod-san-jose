import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Run only an explicitly supplied local image. No pull, network, mounts or ports.
const image = process.env.FACTUEZ_PHASE1_TEST_IMAGE;
if (!image || !/^sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error('FACTUEZ_PHASE1_TEST_IMAGE must be a local sha256 image ID');
}
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120000 });
  if (result.error) throw result.error;
  return result;
}
function run(options = [], command = []) {
  return docker('run', '--rm', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
    '--memory=512m', ...options, image, ...command);
}
test('local image is amd64 and runs as non-root', () => {
  const result = docker('image', 'inspect', image, '--format', '{{.Architecture}} {{.Config.User}}');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'amd64 node');
});
test('container blocks startup with opt-in absent', () => {
  const result = run();
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'B2B_API_PACKAGE_STARTUP_BLOCKED');
});
test('container blocks enabled startup when configuration is absent', () => {
  const result = run(['-e', 'B2B_API_ENABLED=true', '-e', 'B2B_API_CONFIG_ROOT=/missing-factuez-config']);
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'B2B_API_PACKAGE_STARTUP_BLOCKED');
});
test('compiled real bootstrap exists and stays inactive without opt-in', () => {
  const script = "const m=require('/workspace/services/b2b-api-service/dist/main.js'); if(typeof m.bootstrapB2bApi!=='function') process.exit(2); m.bootstrapB2bApi({}).then(v=>{if(v!==null)process.exit(3);process.stdout.write('disabled');}).catch(()=>process.exit(4))";
  const result = run(['--entrypoint', 'node'], ['-e', script]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'disabled');
});