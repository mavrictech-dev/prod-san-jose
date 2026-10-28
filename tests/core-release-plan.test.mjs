import test from 'node:test';
import assert from 'node:assert/strict';
import {releasePlan} from '../infra/deployment/core-production/build-release.mjs';
const good={repository:'registry.example.invalid/private/factuez',version:'2026.10.28-rc1',nodeBase:'node:22-bookworm-slim@sha256:'+'a'.repeat(64)};
test('exact seven native builds match approved core image layout without pushing or starting',()=>{
 const r=releasePlan(good);assert.equal(r.images.length,7);assert.equal(r.pushesImages,false);assert.equal(r.startsContainers,false);assert.equal(r.platform,'linux/amd64');
 for(const i of r.images){assert.equal(i.build.executable,'docker');assert.equal(i.build.args[0],'build');assert.ok(i.build.args.includes('linux/amd64'));assert.ok(i.build.args.includes('NODE_BASE_IMAGE='+good.nodeBase));assert.equal(i.publishAfterPrivateRegistryApproval.args[0],'push');assert.ok(i.image.startsWith(good.repository+'/'));}
 const web=r.images.find(i=>i.service==='web-pwa');assert.ok(web.build.args.includes('NEXT_PUBLIC_B2B_ADMIN_PROFILE=SSO'));assert.ok(web.build.args.includes('NEXT_PUBLIC_API_BASE_URL='));
 assert.ok(!JSON.stringify(r).includes('prepared-v'));assert.ok(!JSON.stringify(r).includes('docker compose'));
});
for(const value of ['https://registry.example/private','registry/path;shutdown','registry/../x','REGISTRY/upper','registry','registry/path\n','--privileged/x'])test('rejects unsafe registry '+JSON.stringify(value),()=>assert.throws(()=>releasePlan({...good,repository:value})));
for(const value of ['latest','2026-latest','--pull','1;exit','1\n'])test('rejects mutable/unsafe version '+JSON.stringify(value),()=>assert.throws(()=>releasePlan({...good,version:value})));
for(const value of ['node:22-bookworm-slim','node:24@sha256:'+'a'.repeat(64),'node:22-bookworm-slim@sha256:bad'])test('rejects unpinned/unsupported base '+value,()=>assert.throws(()=>releasePlan({...good,nodeBase:value})));
