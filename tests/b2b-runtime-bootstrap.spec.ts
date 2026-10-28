import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve,sep,basename} from 'node:path';import {randomUUID} from 'node:crypto';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {B2bRuntimeFiles} from '../packages/service-access/src/b2b-runtime-files';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule,b2bOwnerRuntimeCapabilities} from '../packages/service-access/src/b2b-runtime-status';
import {b2bApiRuntimeConfig} from '../services/b2b-api-service/src/runtime-config';
import {bootstrapB2bApi,verifyB2bOwnerGraph} from '../services/b2b-api-service/src/main';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const config=()=>({schemaVersion:'factuez.b2b.api-runtime.v1',environment:'BETA',approvedForPrivateBeta:true,deploymentId:randomUUID(),instanceId:randomUUID(),
 listen:{host:'127.0.0.1',port:8444,maintenancePort:8450},edgePeers:['a'.repeat(64)],operatorPeers:['b'.repeat(64)],
 origins:Object.fromEntries(Object.keys(b2bOwnerRuntimeCapabilities).map(k=>[k,'https://'+k+'.factuez.internal:8444'])),localIssuanceEnabled:false,localConversionEnabled:false});
describe('explicit real B2B bootstrap, no deployment or implicit permissions',()=>{
 it('does no filesystem/network/listen work without the explicit feature flag',async()=>{
  expect(await bootstrapB2bApi({})).toBeNull();expect(await bootstrapB2bApi({B2B_API_ENABLED:'false',B2B_API_CONFIG_ROOT:'Z:/not-readable'})).toBeNull();
 });
 it('validates all fixed HTTPS owners, BETA, approval and separate operator peers',()=>{
  expect(b2bApiRuntimeConfig(config())).toMatchObject({environment:'BETA',localIssuanceEnabled:false});
  for(const bad of [{environment:'PRODUCTION'},{approvedForPrivateBeta:false},{operatorPeers:['a'.repeat(64)]},{origins:{}},
   {listen:{host:'0.0.0.0',port:8444,maintenancePort:8444}},{listen:{host:'*',port:8444,maintenancePort:8450}},{extra:true}])
   expect(()=>b2bApiRuntimeConfig({...config(),...bad})).toThrow();
  for(const url of ['http://billing.internal','https://user:pass@billing.internal','https://billing.internal/?x=1','https://billing.internal/path']){
   const c=config();c.origins.billing=url;expect(()=>b2bApiRuntimeConfig(c)).toThrow();
  }
 });
 it('reads only named mounted files with bounded metadata, rejects links/traversal and never serializes secrets',()=>{
  const root=mkdtempSync(join(tmpdir(),'factuez-b2b-runtime-'));
  try{
   writeFileSync(join(root,'runtime.json'),JSON.stringify(config()),{mode:0o600});writeFileSync(join(root,'server.key'),'SYNTHETIC_ONLY',{mode:0o600});
   const files=new B2bRuntimeFiles(root);expect(files.metadata().environment).toBe('BETA');expect(files.privatePem('server.key').toString()).toBe('SYNTHETIC_ONLY');
   expect(JSON.stringify(files)).not.toContain('SYNTHETIC_ONLY');for(const name of ['../server.key','C:/server.key','x/y.key'])expect(()=>files.privatePem(name)).toThrow();
   writeFileSync(join(root,'too-large.json'),'a'.repeat(65537));expect(()=>files.metadata('too-large.json')).toThrow();
   writeFileSync(join(root,'bad.json'),'null');expect(()=>files.metadata('bad.json')).toThrow();
   const binary=Buffer.alloc(512*1024,7);writeFileSync(join(root,'certificate.bin'),binary,{mode:0o600});
   const read=files.privateBinary('certificate.bin');expect(read.equals(binary)).toBe(true);read.fill(0);
   expect(files.privateBinary('certificate.bin').equals(binary)).toBe(true);
   expect(()=>files.secretBytes('certificate.bin')).toThrow();
   writeFileSync(join(root,'oversized.bin'),Buffer.alloc(512*1024+1),{mode:0o600});expect(()=>files.privateBinary('oversized.bin')).toThrow();
   linkSync(join(root,'certificate.bin'),join(root,'linked.bin'));expect(()=>files.privateBinary('linked.bin')).toThrow();
   linkSync(join(root,'server.key'),join(root,'linked.key'));expect(()=>files.privatePem('linked.key')).toThrow();
  }finally{if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-b2b-runtime-'))throw Error('TEST_CLEANUP_OUTSIDE_OWNED_ROOT');rmSync(root,{recursive:true,force:true});}
 });
 it('requires complete owner capabilities, matching deployment and fresh distinct boots before binding the API',async()=>{
  const deploymentId=randomUUID(),proofs=Object.fromEntries(Object.entries(b2bOwnerRuntimeCapabilities).map(([owner,caps])=>[owner,{schemaVersion:'factuez.b2b.owner-runtime.v1',environment:'BETA',deploymentId,bootId:randomUUID(),owner,capabilities:[...caps],state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false}]));
  const resources=Object.fromEntries(Object.keys(proofs).map(owner=>[owner,{post:vi.fn(async()=>structuredClone(proofs[owner]))}]));
  await verifyB2bOwnerGraph(resources as any,deploymentId);
  for(const change of [(v:any)=>{v.environment='PRODUCTION';},(v:any)=>{v.capabilities.pop();},(v:any)=>{v.deploymentId=randomUUID();},(v:any)=>{v.fiscalActivation=true;},(v:any)=>{v.secret='not-allowed';}]){
   const snapshot=structuredClone(proofs.billing);change(proofs.billing);await expect(verifyB2bOwnerGraph(resources as any,deploymentId)).rejects.toThrow('GRAPH_NOT_READY');proofs.billing=snapshot;
  }
 });
});

describe('owner readiness metadata through actual private mTLS, schema callback only',()=>{
 let tls:ReturnType<typeof b2bCertificates>;beforeAll(()=>{tls=b2bCertificates();},30000);
 it('probes an installed runtime and fails if storage readiness fails without migrating or granting',async()=>{
  const check=vi.fn(async()=>{}),core=new B2bOwnerRuntimeStatus('billing',randomUUID(),b2bOwnerRuntimeCapabilities.billing,check);
  const app=await NestFactory.create(B2bOwnerRuntimeStatusModule.isolated(core,[fingerprint(tls.resource)]),{logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
  try{
   await app.listen(0,'127.0.0.1');const origin='https://127.0.0.1:'+app.getHttpServer().address().port;
   const http=new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.resource,key:tls.key});expect(await http.post('/internal/b2b/runtime-status',{})).toMatchObject({owner:'billing',fiscalActivation:false});
   check.mockRejectedValueOnce(Error('PRIVATE_DB_CONFIG'));await expect(http.post('/internal/b2b/runtime-status',{})).rejects.toMatchObject({status:503});
   await expect(http.post('/internal/b2b/runtime-status',{},'synthetic-client')).rejects.toMatchObject({status:400});
   const other=new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.edge,key:tls.key});await expect(other.post('/internal/b2b/runtime-status',{})).rejects.toMatchObject({status:403});
  }finally{await app.close();}
 });
});
