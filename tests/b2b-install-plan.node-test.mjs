import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,copyFileSync,readdirSync,rmSync,linkSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {compileInstallPlan,validateDescriptor,writeInstallPlan,runCli} from '../infra/b2b/install-plan/plan.mjs';
import {example,syntheticPublicInputs} from './helpers/b2b-install-plan.fixture.mjs';
let root,f;before(()=>{root=mkdtempSync(path.join(tmpdir(),'factuez-install-plan-test-'));f=syntheticPublicInputs(root);});
after(()=>{if(!path.resolve(root).startsWith(path.resolve(tmpdir())+path.sep)||!path.basename(root).startsWith('factuez-install-plan-test-'))throw Error('OWNED_TEST_ROOT_REQUIRED');rmSync(root,{recursive:true,force:true});});
const compile=d=>compileInstallPlan(d??f.d,{baseDirectory:root});

test('usable generators were reviewed; sidecar has no runtime/network/private-key dependencies',()=>{
 const source=readFileSync(new URL('../infra/b2b/install-plan/plan.mjs',import.meta.url),'utf8');
 for(const forbidden of [/from ['"]node:(?:https?|tls|child_process|networks?)['"]/,/createPrivateKey\s*\(/,/generateKeyPair/,/process\.env/,/\.connect\s*\(/,/\.listen\s*\(/])assert.doesNotMatch(source,forbidden);
 assert.match(readFileSync(new URL('../infra/b2b/ubuntu-vps/generate-review.mjs',import.meta.url),'utf8'),/review-blocked/);
});
test('absent public inputs yield exact files/actions and disabled flags, not fake fingerprints/runtime configs',()=>{
 const d=example();d.publicFilesRoot='not-provisioned-yet';
 const r=compile(d);assert.equal(r.plan.state,'PUBLIC_INPUTS_NEED_ACTION');assert.equal(r.plan.issues.length,16);
 assert.ok(r.plan.issues.every(i=>i.code==='PUBLIC_FILE_MISSING'&&i.file&&i.action));assert.equal(r.plan.activationAllowed,false);
 assert.equal(r.files['identity/readonly-owner.json'],undefined);assert.deepEqual(r.plan.publicFingerprints,{});
 assert.match(r.files['install.disabled.env'],/B2B_ONPREM_ADMIN_ENABLED=false/);
 assert.ok(r.mounts.some(m=>m.kind==='PRIVATE_NOT_INSPECTED'&&m.target.endsWith('/signing-key.pem')));
});
test('compiles actual owner/onprem/API metadata, derived peers, same Identity DB and zero automatic approvals',()=>{
 const r=compile();assert.equal(r.plan.state,'PUBLIC_CONFIGURATION_VALIDATED');assert.deepEqual(r.plan.issues,[]);
 assert.equal(r.plan.capabilityMeaning.label,'Consulta de comprobantes y gestión de webhooks');assert.equal(r.plan.capabilityMeaning.webhookManagementMutations,true);assert.equal(r.plan.capabilityMeaning.allMutationsDisabled,false);
 assert.equal(r.plan.runtimeReady,false);assert.equal(r.plan.privateMaterialRead,false);assert.equal(r.plan.databaseUsed,false);
 const i=r.files['identity/readonly-owner.json'],b=r.files['billing/readonly-owner.json'],a=r.files['api/readonly-runtime.json'];
 assert.equal(i.database.name,f.d.nativeIdentityDatabase.name);assert.deepEqual(i.tokenPeers,[r.plan.publicFingerprints.oauth]);
 assert.ok(b.registrar.includes(r.plan.publicFingerprints.onpremResource));assert.equal(b.registrar.includes(r.plan.publicFingerprints.edge),false);
 assert.deepEqual(a.edgePeers,[r.plan.publicFingerprints.edge]);assert.equal(a.approvedForPrivateBeta,false);
 assert.equal(r.files['onprem/onprem-admin.json'].approvedForLocalSetup,false);
 assert.equal(r.files['webhooks/runtime.json'].dispatchEnabled,false);assert.deepEqual(r.files['webhooks/runtime.json'].destinations,[]);
 assert.equal(r.files['api/b2b-operations.json'].mode,'PAUSED');
 for(const m of r.mounts.filter(m=>m.kind==='PRIVATE_NOT_INSPECTED'))assert.ok(!Object.hasOwn(m,'value')&&!Object.hasOwn(m,'source'));
});
test('descriptor rejects HTTP, credentials, path/query origins, unknown fields, bad ports, escaped mounts and DB mismatch',()=>{
 for(const patch of [
  {browserOrigin:'http://client.invalid'},{tokenIssuer:'https://user:password@issuer.invalid'},{browserOrigin:'https://client.invalid/'},
  {origins:{...f.d.origins,billing:'https://billing-readonly:8443'}},{maintenancePorts:{api:9000,webhooks:9041}},
  {mountRoot:'/run/test/../private'},{environment:'PRODUCTION'},{secret:'MUST_NEVER_ECHO'},
  {nativeIdentityDatabase:{...f.d.nativeIdentityDatabase,name:'other_identity_beta'}},
  {certificateFiles:{...f.d.certificateFiles.resource,resource:'../resource.crt'}},
  {publicKeyFiles:{...f.d.publicKeyFiles,b2bSigning:'signing.key'}},
 ])assert.throws(()=>validateDescriptor({...structuredClone(f.d),...patch}));
});
test('rejects wrong issuer signature, SAN, EKU and expired certificate without generating runtime metadata',()=>{
 for(const [options,code]of [[{wrongSignature:true},'CERTIFICATE_SIGNATURE_OR_CA_MISMATCH'],[{wrongSan:true},'SERVER_SAN_MISMATCH'],
  [{wrongEku:true},'CERTIFICATE_EXTENDED_KEY_USAGE_REQUIRED'],[{expired:true},'LEAF_CERTIFICATE_INVALID_OR_EXPIRED']]){
  f.issue('billingServer',options);const r=compile();assert.ok(r.plan.issues.some(i=>i.code===code));assert.equal(r.files['api/readonly-runtime.json'],undefined);
 }
 f.issue('billingServer');assert.equal(compile().plan.issues.length,0);
});
test('rejects reused token/resource/edge/operator certificates and signing-key reuse',()=>{
 const target=path.join(f.publicRoot,f.d.certificateFiles.oauth),previous=readFileSync(target);
 copyFileSync(path.join(f.publicRoot,f.d.certificateFiles.resource),target);
 assert.ok(compile().plan.issues.some(i=>i.code==='CERTIFICATE_ROLE_REUSED'));writeFileSync(target,previous);
 const key=path.join(f.publicRoot,f.d.publicKeyFiles.b2bSigning),saved=readFileSync(key);writeFileSync(key,f.leafPublic);
 assert.ok(compile().plan.issues.some(i=>i.code==='B2B_SIGNING_KEY_NOT_SEPARATE'));writeFileSync(key,saved);
});
test('never inspects private mounts; private PEM disguised as public is rejected without leaked contents',()=>{
 const key=path.join(f.publicRoot,f.d.publicKeyFiles.human),saved=readFileSync(key),sentinel='SYNTHETIC_PRIVATE_SENTINEL_DO_NOT_ECHO';
 writeFileSync(key,'-----BEGIN PRIVATE KEY-----\n'+sentinel+'\n-----END PRIVATE KEY-----');
 const r=compile();assert.ok(r.plan.issues.some(i=>i.code==='PRIVATE_MATERIAL_REJECTED'));assert.ok(!JSON.stringify(r).includes(sentinel));writeFileSync(key,saved);
 assert.equal(r.plan.privateMaterialRead,false);
});
test('rejects hardlinked public files and leaves output existing files untouched',()=>{
 const file=path.join(f.publicRoot,f.d.certificateFiles.edge),saved=readFileSync(file),hardlink=path.join(f.publicRoot,'hardlink.crt');
 linkSync(file,hardlink);assert.ok(compile().plan.issues.some(i=>i.code==='PUBLIC_FILE_UNSAFE'));rmSync(hardlink);
 assert.ok(readFileSync(file).equals(saved));
 const out=path.join(root,'existing-safe-plan');const result=compile();writeInstallPlan(result,out);
 const before=readFileSync(path.join(out,'plan.json'));assert.throws(()=>writeInstallPlan(result,out));
 assert.ok(readFileSync(path.join(out,'plan.json')).equals(before));
});
test('CLI writes only public JSON/env/manifest under a new output directory; no PEM/key/bin/cert/secret generated',()=>{
 const out=path.join(root,'cli-rehearsal'),r=runCli(['--descriptor',f.descriptor,'--out',out]);
 assert.equal(r.exitCode,0);assert.equal(r.privateMaterialRead,false);
 const walk=dir=>readdirSync(dir).flatMap(n=>{const p=path.join(dir,n);return lstatSync(p).isDirectory()?walk(p):[p];});
 const names=walk(out);assert.ok(names.length>=10);assert.ok(names.every(n=>/\.(json|env)$/.test(n)));
 assert.ok(names.every(n=>!readFileSync(n).includes(Buffer.from('PRIVATE KEY'))));
 assert.equal(JSON.parse(readFileSync(path.join(out,'plan.json'))).activationAllowed,false);
});
