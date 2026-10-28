import 'reflect-metadata';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import type {TLSSocket} from 'node:tls';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {inspect} from 'node:util';
import {createB2bReceivedRuntime,type B2bReceivedRuntimeDependencies,type B2bReceivedOwnerRuntime} from '../services/received-documents-service/src/b2b/runtime';
import {validateB2bReceivedRuntimeConfig,type B2bReceivedRuntimeConfig} from '../services/received-documents-service/src/b2b/runtime-config';
import {checkB2bReceivedRuntimeSchema,b2bReceivedRuntimeSchemaChecks,b2bReceivedReadOnlySchemaChecks} from '../services/received-documents-service/src/b2b/runtime-schema';
import {ReceptionService} from '../services/received-documents-service/src/reception.service';
import {ReceptionAutomationService} from '../services/received-documents-service/src/automation/service';
import {createReceptionAutomationVault} from '../services/received-documents-service/src/b2b/automation';
import {defaultReceptionSettings} from '../services/received-documents-service/src/automation/policy';
import {receptionGrantKey} from '../services/received-documents-service/src/b2b/store';
import {receptionWriteGrantKey} from '../services/received-documents-service/src/b2b/write-authority';
import {receptionAutomationGrantKey} from '../services/received-documents-service/src/b2b/automation-authority';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {B2bSecurityError,type B2bPrincipal} from '../packages/contracts/src/b2b-security';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {parseReceivedXml} from '../packages/received-core/src/index';
import {receivedXml} from './received-fixture.mjs';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';

// Only protocols/persistence are fixtures. The Nest modules, owner engines,
// Postgres adapters, Identity HTTP client, vault, drain and operator RPC are real.
const id=(n:number)=>`fea80910-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:id(1)};
const serviceToken='received-runtime-service-token',userToken='received-runtime-user-token',stepUp='runtime-test-live-stepup';
const subject=(p:B2bPrincipal)=>({kind:p.kind,clientId:p.clientId,subjectId:p.subjectId});
let tls:ReturnType<typeof b2bCertificates>,identityServer:Server,identityPort:number,f:ReturnType<typeof fixture>;
const runtimes:B2bReceivedOwnerRuntime[]=[];
const allChecks=[...b2bReceivedRuntimeSchemaChecks,...b2bReceivedReadOnlySchemaChecks];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};

function fixture(){
 const service:B2bPrincipal={kind:'SERVICE',clientId:id(2),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA',
  scopes:['b2b:received:read','b2b:received:artifacts:read','b2b:received:write','b2b:received:sync'],
  bindings:[{issuerId:1,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:id(3),seriesId:id(4),documentType:'01'}]};
 const user:B2bPrincipal={...structuredClone(service),kind:'USER',clientId:id(5),subjectId:id(6),userAuthRevision:3,scopes:[...service.scopes,'b2b:received:configure']};
 const control={revoked:false,adminRevoked:false,badAdminDigest:false,missingSchema:'',failAudit:false,holdWrite:undefined as undefined|(()=>Promise<void>),identityCalls:[] as any[]};
 const xml=Buffer.from(receivedXml()),projection=parseReceivedXml(xml),row={id:id(7),...scope,supplierRuc:projection.supplier.identityNumber,supplierName:projection.supplier.legalName,
  documentType:projection.documentType,fullNumber:projection.fullNumber,issueDate:new Date(projection.issueDate),currencyCode:projection.currencyCode,payableAmount:projection.totals.payableAmount,
  projection,xmlSha256:projection.xmlSha256,receivedAt:new Date('2026-10-26T12:00:00.000Z'),registeredAt:null as Date|null,erpReference:null as string|null};
 const original={id:id(8),documentId:row.id,kind:'XML',fileName:'original.xml',bytes:xml,byteLength:xml.length,sha256:createHash('sha256').update(xml).digest('hex')};
 const reads=new Map<string,any>(),writes=new Map<string,any>(),automation=new Map<string,any>(),commands=new Map<string,any>(),autoCommands=new Map<string,any>(),audits:any[]=[];
 for(const p of [service,user]){
  for(const permission of ['READ','ARTIFACT'] as const)reads.set(receptionGrantKey(scope,subject(p),permission),{scope,subject:subject(p),permission,active:true,clientRevision:1,userAuthRevision:p.userAuthRevision,revision:1});
  const policy={scope,subject:subject(p),action:'REGISTER',active:true,clientRevision:1,userAuthRevision:p.userAuthRevision,revision:1};
  writes.set(receptionWriteGrantKey(scope,subject(p),'REGISTER'),{policyId:id(10),policy,revision:1});
  for(const action of ['CONFIG_READ','CONFIG_SAVE','LIVE_READ_ONLY','SYNC_CREATE','SYNC_READ'] as const){
   const policy={scope,subject:subject(p),action,active:true,clientRevision:1,userAuthRevision:p.userAuthRevision,revision:1};
   automation.set(receptionAutomationGrantKey(scope,subject(p),action),{policyId:id(11),policy,revision:1});
  }
 }
 let connection:any=null;
 const query=vi.fn(async(sql:string,...v:any[]):Promise<any[]>=>{
  if(allChecks.includes(sql)){if(control.missingSchema&&sql.includes('FROM "'+control.missingSchema+'"'))throw Error('PRIVATE_SQL_CANARY');return [];}
  if(sql.startsWith('SELECT 1 AS locked FROM pg_advisory_xact_lock'))return [{locked:1}];
  if(sql.includes('FROM "B2bReceivedReadGrant"'))return reads.has(v[0])?[{policy:structuredClone(reads.get(v[0]))}]:[];
  if(sql.includes('FROM "B2bReceivedWriteGrant"'))return writes.has(v[0])?[structuredClone(writes.get(v[0]))]:[];
  if(sql.includes('FROM "B2bReceivedAutomationGrant"'))return automation.has(v[0])?[structuredClone(automation.get(v[0]))]:[];
  if(sql.includes('FROM "B2bReceivedCommand"'))return commands.has(v[0])?[structuredClone(commands.get(v[0]))]:[];
  if(sql.includes('FROM "B2bReceivedAutomationCommand"'))return autoCommands.has(v[0])?[structuredClone(autoCommands.get(v[0]))]:[];
  if(sql==='SELECT * FROM "ReceptionConnection" WHERE "companyId"=$1 FOR UPDATE')return connection&&v[0]===1?[structuredClone(connection)]:[];
  if(sql.includes('FROM "ReceivedDocument"')&&!sql.includes('JOIN')){
   const byId=sql.includes('WHERE "id"=$1')||sql.includes('WHERE d."id"=$1');
   if(byId)return v[0]===row.id&&v[1]===1&&v[2]===scope.recipientRuc&&v[3]===scope.branchId?[structuredClone(row)]:[];
   return v[0]===1&&v[1]===scope.recipientRuc&&v[2]===scope.branchId?[structuredClone(row)]:[];
  }
  if(sql.includes('FROM "ReceivedArtifact"'))return sql.includes('a."bytes"')?v[0]===original.id?[{...original}]:[]:[{...original}];
  throw Error('UNEXPECTED_FIXTURE_SQL');
 });
 const execute=vi.fn(async(sql:string,...v:any[]):Promise<number>=>{
  if(sql.startsWith('UPDATE "ReceivedDocument" SET "registeredAt"')){
   await control.holdWrite?.();if(v[0]!==row.id||v[3]!==row.erpReference)return 0;row.registeredAt=v[1]?new Date(v[1]):null;row.erpReference=v[2];return 1;
  }
  if(sql.startsWith('INSERT INTO "B2bReceivedCommand"')){commands.set(v[0],{requestHash:v[1],result:JSON.parse(v[7])});return 1;}
  if(sql.startsWith('INSERT INTO "B2bReceivedAutomationCommand"')){autoCommands.set(v[0],{requestHash:v[1],result:JSON.parse(v[7])});return 1;}
  if(sql.startsWith('INSERT INTO "ReceptionConnection"')){connection={companyId:v[0],recipientRuc:v[1],revision:v[2],enabled:false,mode:v[3],settings:JSON.parse(v[4]),encryptedCredentials:v[5],configuredBy:v[6],updatedAt:v[7]};return 1;}
  if(sql.startsWith('UPDATE "ReceptionSyncRun" SET "status"='))return 0;
  if(['INSERT INTO "B2bReceivedReadAudit"','INSERT INTO "B2bReceivedAutomationAudit"','INSERT INTO "ReceptionConnectionAudit"'].some(prefix=>sql.startsWith(prefix))){if(control.failAudit)throw Error('PRIVATE_AUDIT_CANARY');audits.push({sql,values:v});return 1;}
  throw Error('UNEXPECTED_FIXTURE_WRITE');
 });
 const db:any={$queryRawUnsafe:query,$executeRawUnsafe:execute,$disconnect:vi.fn(async()=>{})};db.$transaction=vi.fn(async(work:any)=>work(db));
 const legacy={reception:new ReceptionService(db),automation:new ReceptionAutomationService(db)};
 const lifecycle=Object.fromEntries(['pauseCommands','drainCommands','stopProducers','stopWorkers','drainMutations','closeAdmission','drainAll','closeListeners'].map(k=>[k,vi.fn(async()=>{})])) as B2bReceivedRuntimeDependencies['legacyLifecycle'];
 const vault=createReceptionAutomationVault(randomBytes(32));vi.spyOn(vault,'open');vi.spyOn(vault,'seal');
 const grantAdministrator={authorize:vi.fn(async(handle:string,digest:string)=>{
  if(control.adminRevoked||handle!=='runtime-test-grant-stepup'||!/^[a-f0-9]{64}$/.test(digest))throw new B2bSecurityError(403,'STEP_UP_REQUIRED');
  return {adminId:user.subjectId!,authRevision:3,policySha256:digest};
 })};
 const userAdministrator={authorize:vi.fn(async(p:B2bPrincipal,s:typeof scope,action:string,handle:string,digest:string)=>{
  if(control.adminRevoked||handle!==stepUp||p.kind!=='USER'||p.subjectId!==user.subjectId||p.userAuthRevision!==3||hash(s)!==hash(scope)||!['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'].includes(action)||!/^[a-f0-9]{64}$/.test(digest))throw new B2bSecurityError(403,'STEP_UP_REQUIRED');
  return {adminId:p.subjectId!,authRevision:3,scope:s,requestSha256:control.badAdminDigest?'0'.repeat(64):digest,authority:'GLOBAL_ADMIN' as const};
 })};
 const deps:B2bReceivedRuntimeDependencies={database:db,legacy,identityHttp:new B2bPrivateHttp(`https://127.0.0.1:${identityPort}`,{ca:tls.ca,cert:tls.edge,key:tls.key}),grantAdministrator,userAdministrator,vault,
  credentials:{apiTls:{ca:tls.ca,cert:tls.server,key:tls.key},controlTls:{ca:tls.ca,cert:tls.server,key:tls.key}},legacyLifecycle:lifecycle};
 return {deps,db,query,execute,lifecycle,control,service,user,reads,writes,automation,row,original,commands,autoCommands,audits,connection:()=>connection};
}
function config():B2bReceivedRuntimeConfig{return {enabled:true,approvedForPrivateBeta:true,environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},peers:{resource:[fingerprint(tls.resource)],operator:[fingerprint(tls.other)]}};}
beforeAll(async()=>{
 tls=b2bCertificates();
 identityServer=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const send=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body));};
  try{
   const peer=(req.socket as TLSSocket).getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
   const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const body=JSON.parse(Buffer.concat(parts).toString());
   f.control.identityCalls.push({path:req.url,kind:body.kind,requiredScopes:body.requiredScopes});
   if(peer!==fingerprint(tls.edge)||req.url!=='/internal/b2b/introspect'||req.method!=='POST'||Object.keys(body).sort().join(',')!=='kind,requiredScopes'||!Array.isArray(body.requiredScopes))return send(400,{code:'INVALID_FIXTURE_PROTOCOL'});
   const principal=req.headers.authorization==='Bearer '+serviceToken?f.service:req.headers.authorization==='Bearer '+userToken?f.user:null;
   if(!principal||f.control.revoked||body.kind!==principal.kind||body.requiredScopes.some((s:string)=>!principal.scopes.includes(s as any)))return send(403,{code:'CURRENT_IDENTITY_DENIED'});
   send(200,structuredClone(principal));
  }catch{send(400,{code:'INVALID_FIXTURE_PROTOCOL'});}
 });
 await new Promise<void>(resolve=>identityServer.listen(0,'127.0.0.1',resolve));identityPort=(identityServer.address() as AddressInfo).port;
},30000);
beforeEach(()=>{f=fixture();});
afterEach(async()=>{for(const r of runtimes.splice(0))await r.close();});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>identityServer.close(e=>e?reject(e):resolve()));});
async function assemble(c=config()){
 const runtime=(await createB2bReceivedRuntime(c,f.deps))!;runtimes.push(runtime);const ports=await runtime.start();
 return {runtime,c,api:(ports.api as AddressInfo).port,control:(ports.control as AddressInfo).port};
}
function begin(port:number,path:string,body:unknown,options:{peer?:'resource'|'other'|'edge'|null;token?:string;method?:string;raw?:boolean;contentType?:string}={}){
 const bytes=Buffer.from(options.raw?String(body):JSON.stringify(body));let req!:ReturnType<typeof request>;
 const result=new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
  const peer=options.peer===undefined?'resource':options.peer;
  req=request({hostname:'127.0.0.1',port,path,method:options.method??'POST',ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),rejectUnauthorized:true,agent:false,timeout:5000,
   headers:{'Content-Type':options.contentType??'application/json','Content-Length':String(bytes.length),...(options.token?{Authorization:'Bearer '+options.token}:{})}},res=>{
    const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);try{resolve({status:res.statusCode!,body:String(res.headers['content-type']).includes('application/json')?JSON.parse(bytes.toString()):null,bytes,headers:res.headers});}catch(e){reject(e);}});
   });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('FIXTURE_TIMEOUT')));req.end(bytes);
 });return {req,result};
}
const send=(...args:Parameters<typeof begin>)=>begin(...args).result;
const readBody=()=>({kind:'SERVICE',action:'LIST',args:{scope,from:'2026-01-01',to:'2026-01-02',limit:10}});
const registration=()=>({kind:'SERVICE',action:'REGISTER',input:{scope,key:'runtime_register_key_001',payload:{documentId:id(7),registeredAt:'2026-10-26T14:00:00.000Z',erpReference:'SYNTHETIC-ERP',expectedErpReference:null}}});
const autoRead=()=>({kind:'USER',action:'CONFIG_READ',input:{scope,payload:{stepUpHandle:stepUp}}});

describe('Received owner runtime: opt-in, real Nest/mTLS and current Identity protocol',()=>{
 it('disabled calls do not inspect dependencies, files or credentials',async()=>{
  const poison=new Proxy({},{get(){throw Error('MUST_NOT_READ_DEPENDENCIES');}});
  expect(await createB2bReceivedRuntime()).toBeNull();expect(await createB2bReceivedRuntime({enabled:false} as any,poison as any)).toBeNull();expect(f.query).not.toHaveBeenCalled();
 });
 it('assembles all modules without listening, worker/Identity/OAuth or vault reads',async()=>{
  const r=(await createB2bReceivedRuntime(config(),f.deps))!;runtimes.push(r);
  expect(r.application.getHttpServer().address()).toBeNull();expect(f.control.identityCalls).toHaveLength(0);expect(f.deps.vault.open).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();
  expect(f.query.mock.calls.map(c=>c[0])).toEqual(b2bReceivedRuntimeSchemaChecks);expect(r.maintenance.snapshot().instance.bootId).toBe(r.status.bootId);
  expect(r.status.capabilities).toEqual(['READ','COMMANDS','AUTOMATION']);
 });
 it('exposes real status with the shared bootId and checks storage again for each probe',async()=>{
  const r=await assemble();const before=f.query.mock.calls.length,probe=await send(r.api,'/internal/b2b/runtime-status',{});
  expect(probe.status).toBe(200);expect(probe.body).toMatchObject({owner:'received',bootId:r.runtime.bootId,deploymentId:r.c.deploymentId,capabilities:['AUTOMATION','COMMANDS','READ'],state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false});
  expect(f.query.mock.calls.length-before).toBe(b2bReceivedRuntimeSchemaChecks.length);expect(f.control.identityCalls).toHaveLength(0);
  f.control.missingSchema='B2bReceivedAutomationGrant';const denied=await send(r.api,'/internal/b2b/runtime-status',{});expect(denied.status).toBe(503);expect(JSON.stringify(denied.body)).not.toContain('PRIVATE_SQL_CANARY');
 });
 it('reads actual projection/original through PostgreSQL adapters and repeated live introspection',async()=>{
  const r=await assemble(),list=await send(r.api,'/internal/b2b/received-read',readBody(),{token:serviceToken});expect(list.status).toBe(200);expect(list.body.items[0].id).toBe(f.row.id);
  const detail=await send(r.api,'/internal/b2b/received-read',{kind:'SERVICE',action:'DETAIL',args:{scope,id:f.row.id}},{token:serviceToken});expect(detail.status).toBe(200);expect(detail.body.projection).toEqual(f.row.projection);
  const xml=await send(r.api,'/internal/b2b/received-read',{kind:'SERVICE',action:'CONTENT',args:{scope,id:f.row.id,artifactId:f.original.id}},{token:serviceToken});expect(xml.status).toBe(200);expect(xml.bytes).toEqual(f.original.bytes);expect(xml.headers['x-content-sha256']).toBe(f.original.sha256);
  expect(f.control.identityCalls.length).toBeGreaterThan(3);expect(f.audits).toHaveLength(3);expect(list.headers['cache-control']).toBe('private, no-store');
 });
 it('executes real REGISTER engine and idempotent replay without a legacy user fallback',async()=>{
  const r=await assemble(),body=registration();const one=await send(r.api,'/internal/b2b/received-command',body,{token:serviceToken}),two=await send(r.api,'/internal/b2b/received-command',body,{token:serviceToken});
  expect(one.status).toBe(200);expect(one.body).toEqual({documentId:id(7),outcome:'REGISTERED',fiscalAcceptance:'NOT_VERIFIED'});expect(two.body).toEqual(one.body);expect(f.commands.size).toBe(1);expect(f.row.erpReference).toBe('SYNTHETIC-ERP');
  expect(f.execute.mock.calls.filter(c=>c[0].startsWith('UPDATE "ReceivedDocument"'))).toHaveLength(1);
 });
 it('stages connection forms using real vault/automation and never executes connectors',async()=>{
  const r=await assemble(),read=await send(r.api,'/internal/b2b/received-automation',autoRead(),{token:userToken});expect(read.status).toBe(200);expect(read.body.revision).toBe(0);
  const settings=defaultReceptionSettings();const saved=await send(r.api,'/internal/b2b/received-automation',{kind:'USER',action:'CONFIG_SAVE',input:{scope,key:'runtime_config_key_001',payload:{expectedRevision:0,settings,credentials:{mailPassword:'PRIVATE_FORM_SECRET_CANARY'},stepUpHandle:stepUp}}},{token:userToken});
  expect(saved.status).toBe(200);expect(saved.body).toMatchObject({revision:1,runtimeEnabled:false,credentialPresence:{mailPassword:true},state:'DISABLED'});expect(JSON.stringify(saved.body)).not.toMatch(/PRIVATE_FORM_SECRET_CANARY|encryptedCredentials|stepUpHandle/);
  expect(f.connection().enabled).toBe(false);expect(f.connection().encryptedCredentials).toMatch(/^v1\./);expect(await r.runtime.startReadOnlyWorker()).toBe(false);expect(f.autoCommands.size).toBe(1);
 });
 it('fails current Identity revocation, grant revocation, SERVICE configuration and changed step-up proof',async()=>{
  const r=await assemble();f.control.revoked=true;expect((await send(r.api,'/internal/b2b/received-read',readBody(),{token:serviceToken})).status).toBe(403);f.control.revoked=false;
  f.reads.get(receptionGrantKey(scope,subject(f.service),'READ')).active=false;expect((await send(r.api,'/internal/b2b/received-read',readBody(),{token:serviceToken})).status).toBe(403);
  expect((await send(r.api,'/internal/b2b/received-automation',{...autoRead(),kind:'SERVICE'},{token:serviceToken})).status).toBe(403);
  f.control.badAdminDigest=true;expect((await send(r.api,'/internal/b2b/received-automation',autoRead(),{token:userToken})).status).toBe(403);expect(f.execute).not.toHaveBeenCalled();
 });
 it('denies wrong CA peer, wrong bearer and missing client certificate',async()=>{
  const r=await assemble();expect((await send(r.api,'/internal/b2b/received-read',readBody(),{peer:'other',token:serviceToken})).status).toBe(403);expect(f.control.identityCalls).toHaveLength(0);
  expect((await send(r.api,'/internal/b2b/received-read',readBody(),{token:'invalid-token'})).status).toBe(403);
  await expect(send(r.api,'/internal/b2b/runtime-status',{}, {peer:null})).rejects.toThrow();
  expect((await send(r.api,'/internal/b2b/runtime-status',{}, {token:serviceToken})).status).toBe(400);
 });
 it.each(['query','form','malformed','oversize','unknown'])('rejects %s input without echoing secrets',async scenario=>{
  const r=await assemble();const path=scenario==='query'?'/internal/b2b/runtime-status?x=PRIVATE_INPUT_CANARY':scenario==='unknown'?'/internal/b2b/arbitrary':'/internal/b2b/runtime-status';
  const body=scenario==='malformed'?' {"PRIVATE_INPUT_CANARY":':scenario==='oversize'?{canary:'PRIVATE_INPUT_CANARY'.repeat(8000)}:{};
  const out=await send(r.api,path,body,{raw:scenario==='malformed',contentType:scenario==='form'?'application/x-www-form-urlencoded':'application/json'});
  expect([400,413]).toContain(out.status);expect(JSON.stringify(out.body)).not.toContain('PRIVATE_INPUT_CANARY');
 });
 it('does not serialize private clients, vault or TLS keys',async()=>{const r=await assemble();for(const text of [JSON.stringify(r.runtime),inspect(r.runtime)])expect(text).not.toMatch(/BEGIN .*PRIVATE KEY|identityHttp|vault|credentials|tls|PRIVATE_FORM_SECRET/);});
 it('rejects startup twice and disallows a worker start during maintenance',async()=>{const r=await assemble();await expect(r.runtime.start()).rejects.toThrow('START_REJECTED');const req={runId:randomUUID(),deploymentId:r.c.deploymentId,inventorySha256:'ab'.repeat(32),instance:r.runtime.maintenance.snapshot().instance};await r.runtime.maintenance.advance('ADMISSION',req);await expect(r.runtime.startReadOnlyWorker()).rejects.toThrow('START_REJECTED');});
 it('keeps a client-aborted SQL slot through ADMISSION and keeps Identity/status available',async()=>{
  const entered=deferred(),release=deferred();f.control.holdWrite=async()=>{entered.resolve();await release.promise;};const r=await assemble();
  const client=begin(r.api,'/internal/b2b/received-command',registration(),{token:serviceToken});const result=client.result.catch(()=>null);
  await entered.promise;client.req.destroy();await result;
  await expect.poll(()=>r.runtime.drain.snapshot().aborted).toBe(1);expect(r.runtime.drain.snapshot().commands).toBe(1);
  const operator=new HttpsB2bMaintenancePort(`https://127.0.0.1:${r.control}`,{ca:tls.ca,cert:tls.other,key:tls.key},fingerprint(tls.server));
  const req={runId:randomUUID(),deploymentId:r.c.deploymentId,inventorySha256:'ab'.repeat(32),instance:r.runtime.maintenance.snapshot().instance};let done=false;
  const phase=operator.advance('ADMISSION',req).then(v=>{done=true;return v;});
  try{
   await expect.poll(()=>r.runtime.maintenance.snapshot().state).toBe('STOPPING');expect(done).toBe(false);expect(f.db.$disconnect).not.toHaveBeenCalled();
   expect((await send(r.api,'/internal/b2b/runtime-status',{})).status).toBe(200);expect((await send(r.api,'/internal/b2b/received-command',registration(),{token:serviceToken})).status).toBe(503);
  }finally{release.resolve();}
  await phase;expect(f.row.erpReference).toBe('SYNTHETIC-ERP');expect(r.runtime.drain.snapshot().active).toBe(0);expect(f.control.identityCalls.length).toBeGreaterThan(3);
  await operator.advance('PRODUCERS',req);await operator.advance('WORKERS',req);expect(f.db.$disconnect).not.toHaveBeenCalled();
  await operator.advance('STORAGE',req);expect(f.db.$disconnect).toHaveBeenCalledTimes(1);expect(await operator.status()).toMatchObject({state:'PARKED',storageClosed:true});await expect(r.runtime.status.inspect()).rejects.toThrow('STORAGE_CLOSED');
 });
 it('does not forfeit an aborted slot to admit another request at maxConcurrent',async()=>{
  const c=config();c.maxConcurrent=1;const entered=deferred(),release=deferred();f.control.holdWrite=async()=>{entered.resolve();await release.promise;};const r=await assemble(c);
  const client=begin(r.api,'/internal/b2b/received-command',registration(),{token:serviceToken}),result=client.result.catch(()=>null);await entered.promise;client.req.destroy();await result;
  try{await expect.poll(()=>r.runtime.drain.snapshot().aborted).toBe(1);expect((await send(r.api,'/internal/b2b/runtime-status',{})).status).toBe(503);}finally{release.resolve();}
  await expect.poll(()=>r.runtime.drain.snapshot().active).toBe(0);
 });
 it('awaits supplied legacy hooks and fails closed instead of claiming a full legacy shutdown',async()=>{
  const stopped=deferred(),started=deferred();f.lifecycle.stopWorkers=async()=>{started.resolve();await stopped.promise;};const r=await assemble(),req={runId:randomUUID(),deploymentId:r.c.deploymentId,inventorySha256:'ab'.repeat(32),instance:r.runtime.maintenance.snapshot().instance};
  await r.runtime.maintenance.advance('ADMISSION',req);await r.runtime.maintenance.advance('PRODUCERS',req);const phase=r.runtime.maintenance.advance('WORKERS',req);await started.promise;
  expect(f.db.$disconnect).not.toHaveBeenCalled();await expect(r.runtime.maintenance.advance('STORAGE',req)).rejects.toThrow('IN_PROGRESS');stopped.resolve();await phase;await r.runtime.maintenance.advance('STORAGE',req);
  for(const hook of ['pauseCommands','drainCommands','stopProducers','drainMutations','closeAdmission','drainAll','closeListeners'] as const)expect(f.lifecycle[hook]).toHaveBeenCalledTimes(1);
 });
 it('missing schema prevents factory completion without disconnecting its externally owned DB',async()=>{f.control.missingSchema='ReceivedDocument';await expect(createB2bReceivedRuntime(config(),f.deps)).rejects.toThrow('STORAGE_NOT_READY');expect(f.execute).not.toHaveBeenCalled();expect(f.db.$disconnect).not.toHaveBeenCalled();});
 it.each(['database','legacy','identityHttp','grantAdministrator','userAdministrator','vault','legacyLifecycle','credentials'])('requires concrete %s dependencies',async key=>{const d:any={...f.deps};delete d[key];await expect(createB2bReceivedRuntime(config(),d)).rejects.toThrow();expect(f.query).not.toHaveBeenCalled();});
 it('requires real legacy instances rather than shape-only mock services',async()=>{const d:any={...f.deps,legacy:{reception:{list:async()=>[]},automation:{config:async()=>({})}}};await expect(createB2bReceivedRuntime(config(),d)).rejects.toThrow('DEPENDENCIES_REQUIRED');});
 it.each(['environment','approvedForPrivateBeta','api','peers','maxConcurrent'])('rejects unsafe config %s',key=>{const c:any=config();if(key==='environment')c.environment='PRODUCTION';if(key==='approvedForPrivateBeta')c[key]=false;if(key==='api')c.api.host='::';if(key==='peers')c.peers.operator=c.peers.resource;if(key==='maxConcurrent')c[key]=65;expect(()=>validateB2bReceivedRuntimeConfig(c)).toThrow('CONFIG_INVALID');});
 it('does not enable read-only execution from profile alone or an unapproved flag',()=>{const c=config();c.readOnlyExecution={enabled:true,approvedForReadOnlyBeta:false,approvalReference:'TI-unit'};expect(()=>validateB2bReceivedRuntimeConfig(c)).toThrow();});
 it('zero-row checks name only actual columns from current owner schemas and never mutate',async()=>{
  const base=readFileSync(new URL('../services/received-documents-service/prisma/schema.prisma',import.meta.url),'utf8');
  const sql=['read-schema','commands','automation','read-only'].map(n=>readFileSync(new URL('../services/received-documents-service/b2b-received-'+n+'.candidate.sql',import.meta.url),'utf8')).join('\n');
  const fields=new Map<string,Set<string>>();
  for(const match of base.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g))fields.set(match[1],new Set([...match[2].matchAll(/^\s*(\w+)\s+/gm)].map(m=>m[1])));
  for(const match of sql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g))fields.set(match[1],new Set([...match[2].matchAll(/"(\w+)"\s+(?:text|uuid|integer|bigint|jsonb|timestamptz)/g)].map(m=>m[1])));
  for(const check of allChecks){const match=/^SELECT (.+) FROM "(\w+)" WHERE false$/.exec(check)!;expect(match).toBeTruthy();expect(fields.has(match[2]),match[2]).toBe(true);for(const col of match[1].matchAll(/"(\w+)"/g))expect(fields.get(match[2])!.has(col[1]),match[2]+'.'+col[1]).toBe(true);}
  await checkB2bReceivedRuntimeSchema(f.db,true);expect(f.query).toHaveBeenCalledTimes(allChecks.length);expect(f.execute).not.toHaveBeenCalled();
 });
});
