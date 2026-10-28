import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const root=new URL('../infra/deployment/core-production/',import.meta.url);
const base=JSON.parse(readFileSync(new URL('docker-compose.yml',root),'utf8')),extra=JSON.parse(readFileSync(new URL('received-read-only.override.yml',root),'utf8'));
test('opt-in reception override changes only two private connector services',()=>{
 assert.deepEqual(Object.keys(extra.services).sort(),['received-documents-service','received-sync-worker']);
 for(const [name,s]of Object.entries(extra.services)){assert.equal(s.environment.RECEIVED_LIVE_READ_ALLOWED,'true');assert.equal(s.environment.RECEIVED_LOCAL_FIXTURE_ENABLED,'false');assert.equal(s.environment.RECEIVED_QA_USE_APP_KEY,'false');assert.match(s.environment.RECEIVED_IMAP_APPROVED_HOSTS,/^\$\{CORE_IMAP_APPROVED_HOSTS:\?/);assert.deepEqual(s.networks,['private-db','core','egress']);assert.equal(s.ports,undefined);assert.equal(s.mem_limit,undefined);assert.equal(base.services[name].environment.RECEIVED_LIVE_READ_ALLOWED,'false');}
});
test('service memory/ports/database isolation is preserved',()=>{assert.equal(Object.values(base.services).reduce((n,s)=>n+s.mem_limit,0),7700000000);assert.equal(Object.values(base.services).flatMap(s=>s.ports??[]).length,1);for(const s of ['postgres','redis'])assert.deepEqual(base.services[s].networks,['private-db']);});
