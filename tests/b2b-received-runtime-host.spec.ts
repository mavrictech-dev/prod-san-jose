import 'reflect-metadata';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {TLSSocket} from 'node:tls';
import type {AddressInfo} from 'node:net';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {inspect} from 'node:util';
import {bootstrapB2bReceivedOwner} from '../services/received-documents-service/src/b2b/main';
import {loadB2bReceivedRuntimeMount} from '../services/received-documents-service/src/b2b/runtime-files';
import {B2bReceivedStepUpHttp} from '../services/received-documents-service/src/b2b/runtime-authority';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const persistence=vi.hoisted(()=>({instances:[] as any[],missing:false}));
// Only the database transport is replaced; actual Reception classes, DI,
// assembled Nest app, TLS files and fixed schema checks execute unchanged.
vi.mock('../services/received-documents-service/src/prisma.service',()=>({ReceptionPrisma:class {
 constructor(readonly connection:any){persistence.instances.push(this);}
 $connect=vi.fn(async()=>{});$disconnect=vi.fn(async()=>{});
 $queryRawUnsafe=vi.fn(async(sql:string)=>{if(persistence.missing||!/^SELECT .+ FROM "\w+" WHERE false$/.test(sql))throw Error('PRIVATE_DB_CANARY');return [];});
 $executeRawUnsafe=vi.fn(async()=>{throw Error('NO_BOOTSTRAP_WRITE_ALLOWED');});
 $transaction=vi.fn(async(work:any)=>work(this));
}}));
let tls:ReturnType<typeof b2bCertificates>,authorityServer:Server,authorityPort:number;
let authorityActive=true,mode='valid',calls:any[]=[];
const roots:string[]=[],hosts:NonNullable<Awaited<ReturnType<typeof bootstrapB2bReceivedOwner>>>[]=[];
const userId='fea80911-0000-4000-8000-000000000001',clientId='fea80911-0000-4000-8000-000000000002';
const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:'fea80911-0000-4000-8000-000000000003'};
beforeAll(async()=>{
 tls=b2bCertificates();
 authorityServer=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const reply=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body));};
  try{
   const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const b=JSON.parse(Buffer.concat(parts).toString());calls.push(b);
   const peer=(req.socket as TLSSocket).getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
   const keys=b.purpose==='GRANT'?'handle,purpose,requestSha256,schemaVersion':'action,actor,handle,purpose,requestSha256,schemaVersion,scope';
   if(!authorityActive||peer!==fingerprint(tls.edge)||req.method!=='POST'||req.url!=='/verify-stepup'||Object.keys(b).sort().join(',')!==keys||b.schemaVersion!=='factuez.b2b.received-stepup-request.v1'||b.handle!=='stepup-protocol-valid'||!/^[a-f0-9]{64}$/.test(b.requestSha256))return reply(403,{code:'STEP_UP_DENIED'});
   if(b.purpose==='AUTOMATION'&&(b.actor.clientId!==clientId||b.actor.subjectId!==userId||b.actor.authRevision!==3||hash(b.scope)!==hash(scope)||!['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'].includes(b.action)))return reply(403,{code:'STEP_UP_DENIED'});
   const p:any={schemaVersion:'factuez.b2b.received-stepup-proof.v1',purpose:b.purpose,requestSha256:b.requestSha256,requestBindingSha256:hash(b),adminId:userId,authRevision:3,authority:'GLOBAL_ADMIN',permission:'setup.manage',expiresAt:new Date(Date.now()+15000).toISOString()};
   if(mode==='binding')p.requestBindingSha256='0'.repeat(64);if(mode==='expired')p.expiresAt=new Date(Date.now()-1000).toISOString();if(mode==='subject')p.adminId=randomUUID();if(mode==='revision')p.authRevision=4;if(mode==='authority')p.authority='CALLER_APPROVED';if(mode==='extra')p.secret='PRIVATE_CANARY';
   reply(200,p);
  }catch{reply(400,{code:'INVALID_STEP_UP_PROTOCOL'});}
 });await new Promise<void>(r=>authorityServer.listen(0,'127.0.0.1',r));authorityPort=(authorityServer.address() as AddressInfo).port;
},30000);
beforeEach(()=>{persistence.instances.length=0;persistence.missing=false;authorityActive=true;mode='valid';calls=[];});
afterEach(async()=>{
 for(const host of hosts.splice(0))await host.close();
 for(const root of roots.splice(0)){
  if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('factuez-received-runtime-'))throw Error('TEST_TEMP_ROOT_MISMATCH');
  rmSync(root,{recursive:true,force:true});
 }
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>authorityServer.close(e=>e?reject(e):resolve()));});
function mount(){
 const root=mkdtempSync(join(tmpdir(),'factuez-received-runtime-'));roots.push(root);
 const metadata={schemaVersion:'factuez.b2b.received-runtime.v1',runtime:{enabled:true,environment:'BETA',approvedForPrivateBeta:true,deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},peers:{resource:[fingerprint(tls.resource)],operator:[fingerprint(tls.other)]}},
  database:{host:'received-db.synthetic.invalid',port:5432,name:'received_runtime_beta',user:'received_owner',passwordFile:'database-password.bin'},
  identityOrigin:'https://identity.synthetic.invalid',stepUp:{endpoint:`https://127.0.0.1:${authorityPort}/verify-stepup`,serverFingerprintSha256:fingerprint(tls.server)}};
 const write=(name:string,content:string|Buffer)=>writeFileSync(join(root,name),content,{mode:0o600});
 write('runtime.json',JSON.stringify(metadata));
 for(const prefix of ['api','operator','identity','stepup']){write(prefix+'-ca.pem',tls.ca);write(prefix+'.crt',prefix==='api'||prefix==='operator'?tls.server:tls.edge);write(prefix+'.key',tls.key);}
 write('database-ca.pem',tls.ca);write('database-password.bin','synthetic-database-password');
 write('received-settings.bin',randomBytes(32));return {root,metadata,write};
}
function authority(pin=fingerprint(tls.server)){return new B2bReceivedStepUpHttp({endpoint:`https://127.0.0.1:${authorityPort}/verify-stepup`,serverFingerprintSha256:pin},{ca:tls.ca,cert:tls.edge,key:tls.key});}
const principal=()=>({kind:'USER',clientId,subjectId:userId,userAuthRevision:3,revision:1,environment:'BETA',scopes:['b2b:received:configure'],bindings:[]}) as any;
describe('Received concrete opt-in host and mounted private configuration',()=>{
 it('disabled host never reads a mounted root or constructs Prisma',async()=>{
  const env={B2B_RECEIVED_ENABLED:'false',get B2B_RECEIVED_CONFIG_ROOT():string{throw Error('MUST_NOT_READ_ROOT');}};
  expect(await bootstrapB2bReceivedOwner(env)).toBeNull();expect(persistence.instances).toHaveLength(0);
 });
 it('requires explicit root and valid BETA metadata before database construction',async()=>{
  await expect(bootstrapB2bReceivedOwner({B2B_RECEIVED_ENABLED:'true'})).rejects.toThrow('ROOT_REQUIRED');
  const m=mount();m.metadata.runtime.environment='PRODUCTION';m.write('runtime.json',JSON.stringify(m.metadata));
  await expect(bootstrapB2bReceivedOwner({B2B_RECEIVED_ENABLED:'true',B2B_RECEIVED_CONFIG_ROOT:m.root})).rejects.toThrow('MOUNTED_CONFIG_INVALID');expect(persistence.instances).toHaveLength(0);
 });
 it('main is executable with actual legacy services from DI and no OIDC/step-up/bootstrap writes',async()=>{
  const m=mount(),host=(await bootstrapB2bReceivedOwner({B2B_RECEIVED_ENABLED:'true',B2B_RECEIVED_CONFIG_ROOT:m.root}))!;hosts.push(host);
  expect(persistence.instances).toHaveLength(1);const db=persistence.instances[0];expect(db.$connect).toHaveBeenCalledTimes(1);expect(db.$executeRawUnsafe).not.toHaveBeenCalled();expect(calls).toHaveLength(0);
  const port=(host.ports.api as AddressInfo).port,bytes=Buffer.from('{}');
  const result=await new Promise<any>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path:'/internal/b2b/runtime-status',method:'POST',ca:tls.ca,cert:tls.resource,key:tls.key,agent:false,headers:{'Content-Type':'application/json','Content-Length':bytes.length}},res=>{const parts:Buffer[]=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts).toString())}));});req.on('error',reject);req.end(bytes);
  });expect(result).toMatchObject({status:200,body:{owner:'received',capabilities:['AUTOMATION','COMMANDS','READ'],bootId:host.runtime.maintenance.snapshot().instance.bootId}});
  expect(await host.runtime.startReadOnlyWorker()).toBe(false);expect(calls).toHaveLength(0);
  await host.close();await host.close();expect(db.$disconnect).toHaveBeenCalledTimes(1);
 });
 it('schema failure releases only the host-owned connection and never starts authority calls',async()=>{
  const m=mount();persistence.missing=true;
  await expect(bootstrapB2bReceivedOwner({B2B_RECEIVED_ENABLED:'true',B2B_RECEIVED_CONFIG_ROOT:m.root})).rejects.toThrow('STARTUP_BLOCKED');
  expect(persistence.instances[0].$disconnect).toHaveBeenCalledTimes(1);expect(calls).toHaveLength(0);
 });
 it('mounted host rejects read-only execution flags and missing private files before Prisma',async()=>{
  const m=mount();(m.metadata.runtime as any).automation={networkProfile:'LIVE_READ_ONLY',approvedImapHosts:[]};(m.metadata.runtime as any).readOnlyExecution={enabled:true,approvedForReadOnlyBeta:true,approvalReference:'TI-unit'};
  m.write('runtime.json',JSON.stringify(m.metadata));expect(()=>loadB2bReceivedRuntimeMount(m.root)).toThrow('MOUNTED_CONFIG_INVALID');
  delete (m.metadata.runtime as any).readOnlyExecution;m.write('runtime.json',JSON.stringify(m.metadata));rmSync(join(m.root,'identity.key'));
  expect(()=>loadB2bReceivedRuntimeMount(m.root)).toThrow('MOUNTED_CONFIG_INVALID');expect(persistence.instances).toHaveLength(0);
 });
 it('legacy main keeps its original default route and imports B2B host only inside opt-in',()=>{
  const source=readFileSync(new URL('../services/received-documents-service/src/main.ts',import.meta.url),'utf8');expect(source).toContain("if (process.env.B2B_RECEIVED_ENABLED === 'true')");expect(source).toContain("await import('./b2b/main')");expect(source).toContain('NestFactory.create<NestExpressApplication>(AppModule');
 });
});
describe('Actual step-up HTTPS protocol with bound proof and live denial',()=>{
 it('performs no bootstrap request and verifies grant/automation proofs independently',async()=>{
  const client=authority();expect(calls).toHaveLength(0);
  expect(await client.grantAdministrator.authorize('stepup-protocol-valid','ab'.repeat(32))).toEqual({adminId:userId,authRevision:3,policySha256:'ab'.repeat(32)});
  expect(await client.userAdministrator.authorize(principal(),scope,'CONFIG_READ','stepup-protocol-valid','cd'.repeat(32))).toEqual({adminId:userId,authRevision:3,scope,requestSha256:'cd'.repeat(32),authority:'GLOBAL_ADMIN'});
  authorityActive=false;await expect(client.grantAdministrator.authorize('stepup-protocol-valid','ab'.repeat(32))).rejects.toMatchObject({status:403});
  expect(JSON.stringify(client)+inspect(client)).not.toMatch(/PRIVATE KEY|stepup-protocol-valid/);
 });
 it.each(['binding','expired','subject','revision','authority','extra'])('rejects %s proof instead of trusting accepted booleans',async value=>{mode=value;await expect(authority().userAdministrator.authorize(principal(),scope,'CONFIG_READ','stepup-protocol-valid','ab'.repeat(32))).rejects.toMatchObject({status:403});});
 it('rejects wrong server pin, wrong handle and SERVICE actors',async()=>{
  await expect(authority('ff'.repeat(32)).grantAdministrator.authorize('stepup-protocol-valid','ab'.repeat(32))).rejects.toMatchObject({status:403});
  await expect(authority().grantAdministrator.authorize('not-authorized','ab'.repeat(32))).rejects.toMatchObject({status:403});
  await expect(authority().userAdministrator.authorize({...principal(),kind:'SERVICE'},scope,'CONFIG_READ','stepup-protocol-valid','ab'.repeat(32))).rejects.toMatchObject({status:403});
 });
});
