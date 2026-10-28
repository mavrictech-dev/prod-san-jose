import 'reflect-metadata';
import {afterEach,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {adminDigest} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import {createB2bMailerRuntime,checkCorporateSchema,type B2bMailerOwnerRuntime} from '../services/mailer-worker/src/b2b/runtime';
import {bootstrapB2bMailer} from '../services/mailer-worker/src/b2b/main';
import {mailerRuntimeConfig,type B2bMailerRuntimeConfig} from '../services/mailer-worker/src/b2b/runtime-config';
import {loadB2bMailerRuntimeMount,createB2bMailerPostgres} from '../services/mailer-worker/src/b2b/runtime-files';
import {checkB2bMailerRuntimeSchema} from '../services/mailer-worker/src/b2b/runtime-schema';
import {B2bMailerFileCapture} from '../services/mailer-worker/src/b2b/runtime-capture';
import {B2bMailerDispatcher} from '../services/mailer-worker/src/b2b/runtime-dispatcher';
import {emailHash} from '../services/mailer-worker/src/b2b/email-deliveries';
import type {EmailDeliveryPgPool} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import type {B2bPrincipal,EmailDeliveryJob,EmailDeliveryEvent} from '../services/mailer-worker/src/b2b/email-deliveries.types';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';

let tls:ReturnType<typeof b2bCertificates>;
const roots:string[]=[],runtimes:B2bMailerOwnerRuntime[]=[],servers:Server[]=[];
beforeAll(()=>{tls=b2bCertificates();},30000);
afterEach(async()=>{vi.restoreAllMocks();for(const runtime of runtimes.splice(0))await runtime.close();for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function config(profile:'NONE'|'LOCAL_CAPTURE'='NONE'):B2bMailerRuntimeConfig{
 const root=mkdtempSync(join(tmpdir(),'b2b-mailer-offline-'));roots.push(root);
 return {enabled:true,schemaVersion:'factuez.b2b.mailer-runtime.v1',environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),profile,
  api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},peers:{resource:[fingerprint(tls.resource)],operator:[fingerprint(tls.other)]},
  identityOrigin:'https://identity.synthetic.invalid',billingOrigin:'https://billing.synthetic.invalid',
  database:{host:'postgres.synthetic.invalid',port:5432,name:'factuez_mailer_beta',user:'mailer_owner',passwordFile:'database-password.bin'},
  dispatcher:{enabled:false,intervalMs:1000,batchSize:2},smtpAdministration:false,...(profile==='LOCAL_CAPTURE'?{captureRoot:root}:{})};
}
/** PG wire fixture only: real runtime, SQL store, core, MIME capture, files, TLS and Identity client.
 * Serialized committed copies model restart and reject every unrecognized query. No real DB. */
function pg(c:B2bMailerRuntimeConfig){
 let disk={jobs:[] as EmailDeliveryJob[],events:[] as EmailDeliveryEvent[]},tail=Promise.resolve();
 const calls:string[]=[];let finalCommit:(()=>Promise<void>)|undefined;
 let role=c.database.user,version='factuez.b2b.email-deliveries.v1',triggers=true;
 const pool:EmailDeliveryPgPool={connect:vi.fn(async()=>{
  const prior=tail,release=deferred();tail=release.promise;await prior;
  let data=structuredClone(disk),released=false;
  return {release(){if(!released){released=true;release.resolve();}},query:async<T>(sql:string,values:unknown[]=[]):Promise<{rows:T[];rowCount:number|null}>=>{
   calls.push(sql);const result=(rows:unknown[]=[],rowCount=rows.length)=>({rows:rows as T[],rowCount});
   if(sql.startsWith('BEGIN')||sql.startsWith('SET LOCAL')||sql.includes('pg_advisory_xact_lock'))return result();
   if(sql==='COMMIT'){if(data.events.at(-1)?.type==='CAPTURED_LOCAL'&&finalCommit)await finalCommit();disk=structuredClone(data);return result();}
   if(sql==='ROLLBACK')return result();
   if(sql==='SELECT current_database() AS database, current_user AS role')return result([{database:c.database.name,role}]);
   if(sql.includes('SELECT version FROM "B2bEmailDeliverySandbox"'))return result([{version}]);
   if(sql.includes('SELECT version FROM "B2bCorporateEmailDeliverySandbox"'))return result([{version:'factuez.b2b.email-deliveries.corporate.v1'}]);
   if(sql.includes('FROM pg_index'))return result([{ok:true}]);
   if(sql.includes('FROM pg_trigger')&&sql.includes('B2bCorporateEmailDeliveryJob'))return result(['b2b_corporate_email_job_immutable','b2b_corporate_email_event_immutable','b2b_corporate_email_job_audit'].map(name=>({name,enabled:true})));
   if(sql.startsWith('SELECT id FROM "B2bCorporateEmailDeliveryJob"'))return result();
   if(sql.includes('WHERE false'))return result();
   if(sql.includes('FROM pg_trigger'))return result(triggers?['b2b_email_job_immutable','b2b_email_event_immutable','b2b_email_job_audit'].map(name=>({name,enabled:true})):[]);
   if(sql.startsWith('SELECT payload FROM "B2bEmailDeliveryJob"')){
    const j=sql.includes('actor_key=')?data.jobs.find(j=>j.actorKey===values[0]&&j.keyHash===values[1]):data.jobs.find(j=>j.id===values[0]);
    return result(j?[{payload:structuredClone(j)}]:[]);
   }
   if(sql.startsWith('INSERT INTO "B2bEmailDeliveryJob"')){data.jobs.push(JSON.parse(values[5] as string));return result([],1);}
   if(sql.startsWith('UPDATE "B2bEmailDeliveryJob"')){
    const i=data.jobs.findIndex(j=>j.id===values[0]&&j.revision===values[4]);if(i<0)return result([],0);
    data.jobs[i]=JSON.parse(values[3] as string);return result([],1);
   }
   if(sql.startsWith('INSERT INTO "B2bEmailDeliveryEvent"')){data.events.push(JSON.parse(values[5] as string));return result([],1);}
   if(sql.startsWith('SELECT id FROM "B2bEmailDeliveryJob"'))return result(data.jobs.filter(j=>['QUEUED','WAITING_ARTIFACTS','DISPATCHING'].includes(j.state)&&j.profile==='LOCAL_CAPTURE'&&(!values[0]||j.id>String(values[0]))).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,Number(values[1])).map(j=>({id:j.id})));
   throw Error('UNEXPECTED_OFFLINE_SQL');
  }};
 }),end:vi.fn(async()=>{})};
 return {pool,calls,get disk(){return disk;},set role(v:string){role=v;},set version(v:string){version=v;},set triggers(v:boolean){triggers=v;},set finalCommit(v:(()=>Promise<void>)|undefined){finalCommit=v;}};
}
async function fixture(profile:'NONE'|'LOCAL_CAPTURE'='NONE'){
 const c=config(profile),db=pg(c),documentId=randomUUID(),binding={issuerId:1,issuerRuc:'20000000001',environment:'BETA' as const,branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01' as const};
 let principal:B2bPrincipal={kind:'USER',clientId:randomUUID(),revision:1,subjectId:randomUUID(),userAuthRevision:1,environment:'BETA',bindings:[binding],scopes:['b2b:email:send','b2b:email:read','b2b:documents:read']};
 const identityRequests:{path:string;authorization?:string;body:any}[]=[];
 const identity=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());
  identityRequests.push({path:req.url!,authorization:req.headers.authorization,body});
  const send=(value:unknown)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url==='/internal/b2b/introspect')return send(principal);
  if(req.url==='/internal/b2b/authorize-email-actor'){
   const p={...principal,scopes:body.requiredScopes};return send({schemaVersion:'factuez.b2b.email-actor.response.v1',principal:p,requestSha256:adminDigest(body),verifiedAt:Date.now(),expiresAt:Date.now()+10000});
  }
  res.writeHead(404);res.end('{}');
 });servers.push(identity);await new Promise<void>(r=>identity.listen(0,'127.0.0.1',r));c.identityOrigin='https://127.0.0.1:'+(identity.address() as AddressInfo).port;
 const client=new B2bPrivateHttp(c.identityOrigin,{ca:tls.ca,cert:tls.edge,key:tls.key});
 const xml=Buffer.from('<OfflineSyntheticOriginal/>'),cdr=Buffer.from('PK-offline-synthetic-cdr'),pdf=Buffer.from('%PDF-1.7 OfflineSynthetic');
 const proof={binding,documentId,sourceProofSha256:emailHash('offline-proof'),presentationRevision:'current-1',originals:[
  {id:'xml',kind:'XML' as const,fileName:'original.xml',mediaType:'application/xml' as const,sha256:emailHash(xml),byteLength:xml.length},
  {id:'cdr',kind:'CDR' as const,fileName:'original.zip',mediaType:'application/zip' as const,sha256:emailHash(cdr),byteLength:cdr.length}]};
 const emailArtifacts={authorizeDocumentCurrent:async()=>structuredClone(proof),currentPdf:async()=>({bytes:pdf,presentationRevision:'current-1'}),readOriginal:async(_proof:unknown,id:string)=>id==='xml'?xml:cdr};
 const deps={pool:db.pool,identityHttp:client,billingHttp:client,workerIdentityHttp:client,emailArtifacts,credentials:{apiTls:{ca:tls.ca,cert:tls.server,key:tls.key},controlTls:{ca:tls.ca,cert:tls.server,key:tls.key}}};
 return {c,db,deps,binding,documentId,identityRequests,get principal(){return principal;},set principal(v:B2bPrincipal){principal=v;}};
}
async function start(f:Awaited<ReturnType<typeof fixture>>){
 const runtime=(await createB2bMailerRuntime(f.c,f.deps))!;runtimes.push(runtime);const ports=await runtime.start();return {runtime,port:(ports.api as AddressInfo).port,control:(ports.control as AddressInfo).port};
}
async function rpc(port:number,path:string,body:unknown,cert=tls.resource,authorization?:string){
 const bytes=Buffer.from(JSON.stringify(body));return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path,method:'POST',ca:tls.ca,cert,key:tls.key,agent:false,rejectUnauthorized:true,
   headers:{'Content-Type':'application/json','Content-Length':bytes.length,...(authorization?{Authorization:authorization}:{})}},res=>{
   const b:Buffer[]=[];res.on('data',x=>b.push(x));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(b).toString())}));});
  req.on('error',reject);req.end(bytes);
 });
}
const createJob=(f:Awaited<ReturnType<typeof fixture>>)=>({kind:'USER',action:'CREATE',input:{binding:f.binding,documentId:f.documentId,recipient:'offline@example.invalid',format:'a4',idempotencyKey:randomUUID()}});

describe('Mailer B2B09 standalone runtime, offline boundaries only',()=>{
 it('disabled entrypoints do not touch mounted configuration, ports or legacy resources',async()=>{
  const env={B2B_MAILER_ENABLED:'false',get B2B_MAILER_CONFIG_ROOT():string{throw Error('DO_NOT_READ');}};
  expect(await bootstrapB2bMailer(env)).toBeNull();expect(await createB2bMailerRuntime()).toBeNull();
  await expect(bootstrapB2bMailer({B2B_MAILER_ENABLED:'true'})).rejects.toThrow('B2B_MAILER_CONFIG_ROOT_REQUIRED');
  const bind=vi.fn();expect(await bootstrapB2bMailer(env,bind)).toBeNull();expect(bind).not.toHaveBeenCalled();
 });
 it('requires a real artifact owner before constructing PG and never accepts a partial source',async()=>{
  await expect(bootstrapB2bMailer({B2B_MAILER_ENABLED:'true',get B2B_MAILER_CONFIG_ROOT():string{throw Error('MUST_NOT_READ');}},{} as any)).rejects.toThrow('EMAIL_ARTIFACTS_CONTRACT_REQUIRED');
  const f=await fixture();await expect(createB2bMailerRuntime(f.c,{...f.deps,emailArtifacts:{} as any})).rejects.toThrow('EMAIL_ARTIFACTS_CONTRACT_REQUIRED');
  expect(f.db.pool.connect).not.toHaveBeenCalled();
 });
 it.each(['CORPORATE','PRODUCTION','implicit-dispatch'])('rejects profile expansion %s',value=>{
  const c:any=config();if(value==='CORPORATE')c.profile=value;if(value==='PRODUCTION')c.environment=value;if(value==='implicit-dispatch')c.dispatcher.enabled=true;
  expect(()=>mailerRuntimeConfig(c)).toThrow('CONFIG_INVALID');
 });
 it('constructs no listeners or dispatcher until start; status reflects only actual capabilities',async()=>{
  const f=await fixture(),runtime=(await createB2bMailerRuntime(f.c,f.deps))!;runtimes.push(runtime);
  expect(runtime.application.getHttpServer().listening).toBe(false);expect(f.identityRequests).toHaveLength(0);
  const addresses=await runtime.start(),port=(addresses.api as AddressInfo).port;
  const status=await rpc(port,'/internal/b2b/runtime-status',{});
  expect(status).toMatchObject({status:200,body:{owner:'mailer',capabilities:['EMAIL'],state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false}});
  expect(status.body.bootId).toBe(runtime.maintenance.snapshot().instance.bootId);
  expect(await rpc(port,'/internal/b2b/runtime-status',{},tls.other)).toMatchObject({status:403});
  await expect(runtime.start()).rejects.toThrow('START_REJECTED');await runtime.close();await runtime.close();expect(f.db.pool.end).toHaveBeenCalledTimes(1);
 });
 it('keeps NONE nondispatching, persists metadata without bearer and exposes no RUN',async()=>{
  const f=await fixture(),h=await start(f),q=createJob(f);
  expect(await rpc(h.port,'/internal/b2b/email-deliveries',q,tls.resource,'Bearer offline-user-token')).toMatchObject({status:200,body:{profile:'NONE',state:'QUEUED'}});
  expect(f.db.disk.jobs).toHaveLength(1);expect(f.db.disk.events.map(e=>e.type)).toEqual(['CREATED']);
  expect(JSON.stringify(f.db.disk)).not.toContain('offline-user-token');
  expect(f.identityRequests.every(r=>r.path==='/internal/b2b/introspect')).toBe(true);
  const run=await rpc(h.port,'/internal/b2b/email-deliveries',{kind:'USER',action:'RUN',input:{id:f.db.disk.jobs[0].id}},tls.resource,'Bearer offline-user-token');
  expect(run.body.error.code).toBe('INVALID_REQUEST');expect(f.db.disk.events).toHaveLength(1);
  expect((await rpc(h.port,'/b2b/v1/email-deliveries/'+f.db.disk.jobs[0].id,{})).status).toBe(400);
 });
 it('requires dedicated worker Identity TLS and explicit SMTP resources before any storage claim',async()=>{
  const f=await fixture('LOCAL_CAPTURE');f.c.dispatcher.enabled=true;
  await expect(createB2bMailerRuntime(f.c,{...f.deps,workerIdentityHttp:undefined})).rejects.toThrow('DEPENDENCIES_REQUIRED');
  f.c.smtpAdministration=true;await expect(createB2bMailerRuntime(f.c,f.deps)).rejects.toThrow('SMTP_OWNER_RESOURCE_REQUIRED');
  expect(f.db.pool.connect).not.toHaveBeenCalled();
 });
 it('LOCAL_CAPTURE uses fresh queued actor RPC without bearer; stop waits for capture ack AND committed final journal',async()=>{
  const f=await fixture('LOCAL_CAPTURE');f.c.dispatcher.enabled=true;
  const ack=deferred(),entered=deferred(),journal=deferred(),journalEntered=deferred();
  const write=B2bMailerFileCapture.prototype.writeLocalCapture;
  vi.spyOn(B2bMailerFileCapture.prototype,'writeLocalCapture').mockImplementation(async function(this:B2bMailerFileCapture,value){await write.call(this,value);entered.resolve();await ack.promise;});
  f.db.finalCommit=async()=>{journalEntered.resolve();await journal.promise;};
  const h=await start(f);
  try{
   expect((await rpc(h.port,'/internal/b2b/email-deliveries',createJob(f),tls.resource,'Bearer offline-user-token')).status).toBe(200);
   await entered.promise;expect(f.db.disk.events.at(-1)?.type).toBe('ATTEMPT_STARTED');
   const stopping=h.runtime.close();let stopped=false;void stopping.then(()=>{stopped=true;});
   await vi.waitFor(()=>expect(h.runtime.drain.snapshot().state).toBe('COMMANDS_PAUSED'));
   expect(f.db.pool.end).not.toHaveBeenCalled();expect(stopped).toBe(false);
   ack.resolve();await journalEntered.promise;expect(stopped).toBe(false);expect(f.db.pool.end).not.toHaveBeenCalled();
   journal.resolve();await stopping;
   expect(f.db.disk.events.map(e=>e.type)).toEqual(['CREATED','ATTEMPT_STARTED','CAPTURED_LOCAL']);
   expect(f.db.disk.jobs[0].state).toBe('CAPTURED_LOCAL');
   const fresh=f.identityRequests.filter(r=>r.path==='/internal/b2b/authorize-email-actor');
   expect(fresh.length).toBeGreaterThan(2);expect(fresh.every(r=>!r.authorization)).toBe(true);
   expect(JSON.stringify(fresh)).not.toContain('offline-user-token');
   const files=readdirSync(f.c.captureRoot!);expect(files).toHaveLength(1);expect(readFileSync(join(f.c.captureRoot!,files[0]),'utf8')).toContain('LOCAL_CAPTURE');
  }finally{ack.resolve();journal.resolve();}
 },15000);
 it('a changed queued actor prevents capture without retaining/replaying a user bearer',async()=>{
  const f=await fixture('LOCAL_CAPTURE');f.c.dispatcher.enabled=true;const h=await start(f);
  await rpc(h.port,'/internal/b2b/email-deliveries',createJob(f),tls.resource,'Bearer offline-user-token');f.principal={...f.principal,userAuthRevision:2};
  await vi.waitFor(()=>expect(f.identityRequests.some(r=>r.path==='/internal/b2b/authorize-email-actor')).toBe(true),{timeout:4000});
  await h.runtime.close();expect(f.db.disk.jobs[0].state).toBe('QUEUED');expect(readdirSync(f.c.captureRoot!)).toHaveLength(0);
 });
 it('maintenance phases preserve the control listener after STORAGE and close PG once',async()=>{
  const f=await fixture(),h=await start(f),s=h.runtime.maintenance.snapshot(),q={runId:randomUUID(),deploymentId:f.c.deploymentId,inventorySha256:'a'.repeat(64),instance:s.instance};
  expect((await rpc(h.control,'/internal/maintenance/advance',{phase:'ADMISSION',request:q},tls.resource)).status).toBe(403);
  for(const phase of ['ADMISSION','PRODUCERS','WORKERS','STORAGE'] as const){
   const receipt=await rpc(h.control,'/internal/maintenance/advance',{phase,request:q},tls.other);expect(receipt).toMatchObject({status:200,body:{phase,pending:0,storageClosed:phase==='STORAGE'}});
  }
  expect(h.runtime.maintenance.snapshot().state).toBe('PARKED');expect(h.runtime.application.getHttpServer().listening).toBe(false);expect(f.db.pool.end).toHaveBeenCalledTimes(1);
  expect((await rpc(h.control,'/internal/maintenance/advance',{phase:'STORAGE',request:q},tls.other)).status).toBe(200);
  await h.runtime.close();expect(f.db.pool.end).toHaveBeenCalledTimes(1);
 });
 it.each(['role','version','triggers'])('readiness rejects bad %s using only existing candidate read SQL',async field=>{
  const c=config(),db=pg(c);if(field==='role')db.role='outside';if(field==='version')db.version='wrong';if(field==='triggers')db.triggers=false;
  await expect(checkB2bMailerRuntimeSchema(db.pool,c.database)).rejects.toThrow('STORAGE_NOT_READY');
  expect(db.calls).toContain('ROLLBACK');expect(db.calls.every(sql=>!/^CREATE|^ALTER|^GRANT|^INSERT|^UPDATE|^DELETE/.test(sql))).toBe(true);
 });
 it('mounts verified explicit PG TLS and ignores connection URL/environment overrides without connecting',async()=>{
  const c=config(),root=roots.at(-1)!,write=(name:string,value:string|Buffer)=>writeFileSync(join(root,name),value,{mode:0o600});
  write('runtime.json',JSON.stringify(c));
  for(const p of ['api','operator','identity','billing']){write(p+'-ca.pem',tls.ca);write(p+'.crt',p==='identity'||p==='billing'?tls.edge:tls.server);write(p+'.key',tls.key);}
  write('database-ca.pem',tls.ca);write('database-password.bin','OFFLINE-SYNTHETIC-PASSWORD');
  vi.stubEnv('DATABASE_URL','postgresql://invalid/outside?sslmode=disable');vi.stubEnv('PGSSLMODE','disable');vi.stubEnv('PGHOST','outside.invalid');
  const mount=loadB2bMailerRuntimeMount(root),pool=createB2bMailerPostgres(mount.database);
  try{expect((pool as any).options).toMatchObject({host:c.database.host,database:c.database.name,user:c.database.user,password:'OFFLINE-SYNTHETIC-PASSWORD',ssl:{rejectUnauthorized:true,minVersion:'TLSv1.2'},max:4,connectionTimeoutMillis:3000,options:'-c search_path=public'});
   expect((pool as any).options).not.toHaveProperty('connectionString');
  }finally{await pool.end();}
  write('database-ca.pem','INVALID_CA');expect(()=>loadB2bMailerRuntimeMount(root)).toThrow('MOUNTED_CONFIGURATION_INVALID');
 });
 it('capture is exclusive, bounded and durable; never overwrites a previous attempt',async()=>{
  const c=config('LOCAL_CAPTURE'),sink=new B2bMailerFileCapture(c.captureRoot!),eml=Buffer.from('Offline MIME'),v={jobId:randomUUID(),attemptId:randomUUID(),sha256:emailHash(eml),eml};
  await sink.writeLocalCapture(v);await expect(sink.writeLocalCapture(v)).rejects.toThrow();
  expect(readFileSync(join(c.captureRoot!,readdirSync(c.captureRoot!)[0]))).toEqual(eml);
  await expect(sink.writeLocalCapture({...v,attemptId:randomUUID(),sha256:'0'.repeat(64)})).rejects.toThrow('CAPTURE_INVALID');
 });
 it('dispatcher pages past denied/pending jobs and pauses admission while keeping an active run',async()=>{
  const ids=[randomUUID(),randomUUID(),randomUUID()].sort(),seen:string[]=[];
  const query=vi.fn(async(_sql:string,v:unknown[])=>({rows:ids.filter(id=>!v[0]||id>String(v[0])).slice(0,Number(v[1])).map(id=>({id})),rowCount:2}));
  const pool={connect:async()=>({query,release(){}}),end:async()=>{}} as EmailDeliveryPgPool;
  const core={run:async(id:string)=>{seen.push(id);throw Error('OFFLINE_DENIAL');}};
  const d=new B2bMailerDispatcher(pool,core as any,{freshIdentity:async()=>{throw Error('SHOULD_BE_OWNER_CORE');}},{batchSize:2,intervalMs:1000});
  await d.tick();await d.tick();expect(seen).toEqual(ids);await d.tick();expect(seen).toEqual([...ids,...ids.slice(0,2)]);
  d.pause();await d.drain();await expect(d.tick()).rejects.toThrow('STOPPED');
 });

 it('bootstraps the actual mounted host through an explicit source factory and owns PG cleanup',async()=>{
  const f=await fixture('LOCAL_CAPTURE'),root=mkdtempSync(join(tmpdir(),'b2b-mailer-offline-'));roots.push(root);
  const write=(name:string,value:string|Buffer)=>writeFileSync(join(root,name),value,{mode:0o600});
  write('runtime.json',JSON.stringify(f.c));
  for(const p of ['api','operator','identity','billing']){write(p+'-ca.pem',tls.ca);write(p+'.crt',['identity','billing'].includes(p)?tls.edge:tls.server);write(p+'.key',tls.key);}
  write('database-ca.pem',tls.ca);write('database-password.bin','OFFLINE-SYNTHETIC-PASSWORD');
  const driver=createRequire(resolve('services/mailer-worker/package.json'))('pg'),constructed:any[]=[];
  vi.spyOn(driver,'Pool').mockImplementation(function(options:unknown){constructed.push(options);return f.db.pool;});
  const bind=vi.fn(async(context:any)=>{expect(context.identityHttp).toBeInstanceOf(B2bPrivateHttp);expect(context).not.toHaveProperty('database');return {emailArtifacts:f.deps.emailArtifacts};});
  const host=(await bootstrapB2bMailer({B2B_MAILER_ENABLED:'true',B2B_MAILER_CONFIG_ROOT:root},bind))!;
  runtimes.push(host.runtime);
  try{
   expect(bind).toHaveBeenCalledTimes(1);expect(constructed).toHaveLength(1);expect(constructed[0].ssl).toMatchObject({rejectUnauthorized:true,minVersion:'TLSv1.2'});
   expect((await rpc((host.ports.api as AddressInfo).port,'/internal/b2b/runtime-status',{})).status).toBe(200);
   await host.close();await host.close();expect(f.db.pool.end).toHaveBeenCalledTimes(1);
  }finally{await host.close();}
 });
 it('a source factory that fails the explicit gate cannot construct PG or start a host',async()=>{
  const c=config(),root=roots.at(-1)!,write=(name:string,value:string|Buffer)=>writeFileSync(join(root,name),value,{mode:0o600});
  write('runtime.json',JSON.stringify(c));
  for(const p of ['api','operator','identity','billing']){write(p+'-ca.pem',tls.ca);write(p+'.crt',tls.server);write(p+'.key',tls.key);}
  write('database-ca.pem',tls.ca);write('database-password.bin','OFFLINE-SYNTHETIC-PASSWORD');
  const driver=createRequire(resolve('services/mailer-worker/package.json'))('pg'),construct=vi.spyOn(driver,'Pool');
  await expect(bootstrapB2bMailer({B2B_MAILER_ENABLED:'true',B2B_MAILER_CONFIG_ROOT:root},async()=>({} as any))).rejects.toThrow('EMAIL_ARTIFACTS_CONTRACT_REQUIRED');
  expect(construct).not.toHaveBeenCalled();
 });
 it('listener startup failure drains and releases the owned PG pool exactly once',async()=>{
  const f=await fixture(),occupied=createServer();servers.push(occupied);await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));f.c.api.port=(occupied.address() as AddressInfo).port;
  const runtime=(await createB2bMailerRuntime(f.c,f.deps))!;runtimes.push(runtime);
  await expect(runtime.start()).rejects.toThrow('START_BLOCKED');expect(f.db.pool.end).toHaveBeenCalledTimes(1);
  await runtime.close();expect(f.db.pool.end).toHaveBeenCalledTimes(1);expect(runtime.maintenance.snapshot().state).toBe('PARKED');
 });
});

describe('Corporate runtime opt-in sin envios ni DB real',()=>{
 function corporateConfig(){
  const c=config() as B2bMailerRuntimeConfig;c.profile='CORPORATE';
  c.corporate={realSendEnabled:true,approvedHosts:['smtp.example.com']};return c;
 }
 it('exige opt-in explicito, hosts validos y aislamiento de captura',()=>{
  const c=corporateConfig();expect(mailerRuntimeConfig(c).profile).toBe('CORPORATE');
  for(const change of [
   (v:any)=>delete v.corporate,
   (v:any)=>v.corporate.realSendEnabled=false,
   (v:any)=>v.corporate.approvedHosts=[],
   (v:any)=>v.corporate.approvedHosts=['localhost'],
   (v:any)=>v.captureRoot='capture',
   (v:any)=>v.environment='PRODUCTION',
   (v:any)=>v.corporate.extra=true,
  ]){const v=structuredClone(c);change(v);expect(()=>mailerRuntimeConfig(v)).toThrow('CONFIG_INVALID');}
  const local=config();(local as any).corporate=c.corporate;expect(()=>mailerRuntimeConfig(local)).toThrow('CONFIG_INVALID');
 });
 it('rechaza recursos corporativos incompletos antes de acceder al almacenamiento',async()=>{
  const f=await fixture(),c=corporateConfig();
  await expect(createB2bMailerRuntime(c,f.deps)).rejects.toThrow('CORPORATE_OWNER_RESOURCE_REQUIRED');
  await expect(createB2bMailerRuntime(c,{...f.deps,corporateOwner:{permission:{},configurations:{},vault:{},checkStorage:async()=>{}} as any})).rejects.toThrow('CORPORATE_OWNER_RESOURCE_REQUIRED');
  expect(f.db.pool.connect).not.toHaveBeenCalled();
 });
 it('ensambla perfil corporativo y consulta solo su cola con dependencias simuladas',async()=>{
  const f=await fixture(),c=corporateConfig();c.dispatcher.enabled=true;
  const owner={permission:{authorizeRealSendCurrent:vi.fn()},configurations:{read:vi.fn()},vault:{open:vi.fn()},checkStorage:vi.fn(async()=>{})};
  const runtime=(await createB2bMailerRuntime(c,{...f.deps,corporateOwner:owner as any}))!;runtimes.push(runtime);
  expect(owner.checkStorage).toHaveBeenCalledOnce();expect(runtime.toJSON().profile).toBe('CORPORATE');
  await runtime.start();
  await vi.waitFor(()=>expect(f.db.calls.some(sql=>sql.startsWith('SELECT id FROM "B2bCorporateEmailDeliveryJob"'))).toBe(true));
  await runtime.close();
  expect(owner.permission.authorizeRealSendCurrent).not.toHaveBeenCalled();expect(owner.configurations.read).not.toHaveBeenCalled();expect(owner.vault.open).not.toHaveBeenCalled();
  expect(f.db.calls.some(sql=>sql.startsWith('SELECT id FROM "B2bEmailDeliveryJob"'))).toBe(false);
  expect(f.db.pool.end).toHaveBeenCalledTimes(1);
 });
 it('verifica marcador, triggers e indice de intento unico sin escrituras',async()=>{
  const calls:string[]=[];let index=true,enabled=true,version='factuez.b2b.email-deliveries.corporate.v1';
  const pool={connect:async()=>({query:async(sql:string)=>{calls.push(sql);
   if(sql.includes('B2bCorporateEmailDeliverySandbox'))return {rows:[{version}],rowCount:1};
   if(sql.includes('FROM pg_trigger'))return {rows:['b2b_corporate_email_job_immutable','b2b_corporate_email_event_immutable','b2b_corporate_email_job_audit'].map(name=>({name,enabled})),rowCount:3};
   if(sql.includes('FROM pg_index'))return {rows:[{ok:index}],rowCount:1};
   return {rows:[],rowCount:0};},release:()=>{}}),end:async()=>{}} as EmailDeliveryPgPool;
  await checkCorporateSchema(pool);
  index=false;await expect(checkCorporateSchema(pool)).rejects.toThrow('CORPORATE_STORAGE_NOT_READY');
  index=true;enabled=false;await expect(checkCorporateSchema(pool)).rejects.toThrow('CORPORATE_STORAGE_NOT_READY');
  enabled=true;version='wrong';await expect(checkCorporateSchema(pool)).rejects.toThrow('CORPORATE_STORAGE_NOT_READY');
  expect(calls.every(sql=>!/^\s*(CREATE|ALTER|GRANT|INSERT|UPDATE|DELETE)/i.test(sql))).toBe(true);
  expect(calls.filter(sql=>sql==='ROLLBACK')).toHaveLength(3);
 });
});
