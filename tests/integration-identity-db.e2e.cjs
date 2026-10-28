'use strict';
// Fresh disposable database + runner on an internal network, ZERO published ports.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
if (process.argv.length !== 3 || process.argv[2] !== '--isolated-synthetic-only') throw new Error('Only --isolated-synthetic-only is supported');
const repo = resolve(__dirname, '..'), runId = randomUUID(), name = 'factuez-i3-test-' + runId;
const runner = name + '-runner', label = 'factuez.integration.test=' + runId;
let created = false, network = false, stage = 'image-preflight';
function docker(args) {
 const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
 if (result.status !== 0) throw new Error('Isolated Docker operation failed: ' + args[0]);
 return result.stdout.trim();
}
function owned(kind, target) {
 assert.ok([name, runner].includes(target));
 const metadata = JSON.parse(docker([kind, 'inspect', target]))[0];
 assert.equal((kind === 'network' ? metadata.Labels : metadata.Config.Labels)['factuez.integration.test'], runId);
}
function mount(source, target) { return ['--mount', 'type=bind,source=' + resolve(repo, source) + ',target=' + target + ',readonly']; }
try {
 docker(['image','inspect','postgres:17-alpine']);
 docker(['image','inspect','factuez-stage2-qa/identity-service:local']); // Software image only, never QA env/container/volumes.
 stage = 'create-isolated-network';
 docker(['network','create','--internal','--label',label,name]); network = true;
 const password = randomBytes(32).toString('base64url');
 stage = 'create-empty-database';
 docker(['create','--name',name,'--label',label,'--network',name,'--memory','256m','--cpus','1',
 '--mount','type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=134217728',
 '--env','POSTGRES_USER=integration_fixture','--env','POSTGRES_DB=integration_fixture','--env','POSTGRES_PASSWORD=' + password,
 'postgres:17-alpine']); created = true;
 docker(['start',name]);
 assert.equal(docker(['inspect','--format','{{json .HostConfig.PortBindings}}',name]), '{}');
 stage = 'isolated-test-runner';
 const result = spawnSync('docker', ['run','--name',runner,'--label',label,'--network',name,
 '--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--memory','256m','--cpus','1','--entrypoint','node',
 '--env','FIXTURE_DATABASE_HOST=' + name,'--env','FIXTURE_DATABASE_PASSWORD=' + password,'--env','FIXTURE_RUN_ID=' + runId,
 ...mount('services/identity-service/dist/integration','/workspace/services/identity-service/dist/integration'),
 ...mount('packages/contracts/dist','/workspace/packages/contracts/dist'),
 ...mount('packages/contracts/package.json','/workspace/packages/contracts/package.json'),
 ...mount('services/identity-service/prisma/integration-identity.sql','/fixture/schema.sql'),
 ...mount('tests/integration-identity-db.runner.cjs','/fixture/run.cjs'),
 'factuez-stage2-qa/identity-service:local','/fixture/run.cjs'],
 { encoding: 'utf8', timeout: 30000, windowsHide: true });
 for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
  const summary = JSON.parse(line); assert.ok(['PASS','FAIL'].includes(summary.result)); console.log(JSON.stringify(summary));
 }
 if (result.status !== 0 || !result.stdout.includes('"result":"PASS"')) throw new Error('Isolated runner failed');
} catch {
 console.error(JSON.stringify({ result: 'FAIL', stage, realData: false })); process.exitCode = 1;
} finally {
 const exists = target => spawnSync('docker',['container','inspect',target], { encoding: 'utf8', windowsHide: true }).status === 0;
 if (exists(runner)) { owned('container',runner); docker(['rm','--force',runner]); }
 if (created) { owned('container',name); docker(['rm','--force',name]); }
 if (network) { owned('network',name); docker(['network','rm',name]); }
 console.log('Disposed only labelled fictitious test resources; no fiscal history was removed.');
}
