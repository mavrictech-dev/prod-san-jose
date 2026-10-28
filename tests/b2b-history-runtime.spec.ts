import 'reflect-metadata';
import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {TLSSocket} from 'node:tls';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,renameSync,symlinkSync,linkSync} from 'node:fs';
import {join} from 'node:path';
import {inspect} from 'node:util';
import {createB2bHistoryRuntime,type B2bHistoryOwnerRuntime} from '../services/history-service/src/b2b/runtime';
import {historyRuntimeConfig,type B2bHistoryRuntimeConfig} from '../services/history-service/src/b2b/runtime-config';
import {PostgresB2bHistoryArchivePermission,historyRuntimeEnrollmentQuery,b2bHistoryEnrollmentCandidateSql} from '../services/history-service/src/b2b/runtime-enrollment';
import {b2bHistoryRuntimeSchemaChecks} from '../services/history-service/src/b2b/runtime-schema';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {historicalSha256} from '../packages/history-core/src';
import {historyFixture} from './b2b-phase8-reports-history.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
// Only DB/Identity protocols are fixtures. Archive repository, artifact bytes,
// grants adapter, readers, Nest/TLS, drain and maintenance protocol are real.
let tls:ReturnType<typeof b2bCertificates>,identity:Server,identityPort:number,s:ReturnType<typeof fixture>;
const owned:B2bHistoryOwnerRuntime[]=[],fixtures:ReturnType<typeof fixture>[]=[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 const f=historyFixture();
 const storage={sourceRoot:(f.artifacts as any).sourceRoot as string,archiveRoot:(f.artifacts as any).archiveRoot as string};
 const control={database:'factuez_history_qa_aabbccddee',role:'history_reader_qa',revoked:false,missingSchema:'',enrolled:true,identityCalls:0};
 const grant:any={enrollmentId:randomUUID(),revision:1n,active:true,environment:'BETA',datasetClass:'SYNTHETIC',permission:'history.view',
  clientId:f.p.clientId,actorKind:f.p.kind,subjectId:f.p.subjectId,clientRevision:f.p.revision,userAuthRevision:f.p.userAuthRevision,
  binding:structuredClone(f.binding),bindingSha256:historicalSha256(f.binding),actorId:f.decision.actor.userId,actorRevision:1n,currentActorRevision:1n,actorActive:true,actor:structuredClone(f.decision.actor)};
 const query=vi.fn(async(sql:string,...v:any[]):Promise<any[]>=>{
  if(sql==='SELECT current_database() AS database, current_user AS role')return [{database:control.database,role:control.role}];
  if(b2bHistoryRuntimeSchemaChecks.includes(sql)){if(control.missingSchema&&sql.includes('FROM "'+control.missingSchema+'"'))throw Error('PRIVATE_SCHEMA_CANARY');return [];}
  if(sql===historyRuntimeEnrollmentQuery)return control.enrolled&&v[0]===grant.clientId&&v[1]===grant.actorKind&&v[2]===grant.subjectId&&v[3]===grant.bindingSha256?[structuredClone(grant)]:[];
  throw Error('UNEXPECTED_HISTORY_SQL');
 });
 f.tx.$queryRawUnsafe=query;f.tx.$queryRaw.mockImplementation(async()=>[{database:control.database,role:control.role}]);
 const db:any={...f.prisma,$disconnect:vi.fn(async()=>{}),$executeRawUnsafe:vi.fn(async()=>{throw Error('READONLY_HISTORY_WRITE');})};
 return {...f,storage,control,grant,query,db};
}
function config():B2bHistoryRuntimeConfig{return {enabled:true,schemaVersion:'factuez.b2b.history-runtime.v1',environment:'BETA',datasetClass:'SYNTHETIC',approvedForSyntheticQa:true,
 deploymentId:randomUUID(),instanceId:randomUUID(),markerId:s.markerId,api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},peers:{resource:[fingerprint(tls.resource)],operator:[fingerprint(tls.other)]},
 identityOrigin:`https://127.0.0.1:${identityPort}`,database:{host:'pg.synthetic.invalid',port:5432,name:s.control.database,user:'history_reader_qa',passwordFile:'database-password.bin'},storage:{...s.storage}};}
const deps=()=>({database:s.db,identityHttp:new B2bPrivateHttp(`https://127.0.0.1:${identityPort}`,{ca:tls.ca,cert:tls.edge,key:tls.key}),credentials:{apiTls:{ca:tls.ca,cert:tls.server,key:tls.key},controlTls:{ca:tls.ca,cert:tls.server,key:tls.key}}});
beforeAll(async()=>{
 tls=b2bCertificates();identity=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const send=(status:number,body:unknown)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(body));
  try{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const b=JSON.parse(Buffer.concat(chunks).toString());s.control.identityCalls++;
   const peer=(req.socket as TLSSocket).getPeerCertificate().fingerprint256?.replace(/:/g,'').toLowerCase();
   if(peer!==fingerprint(tls.edge)||req.method!=='POST'||req.url!=='/internal/b2b/introspect'||Object.keys(b).sort().join(',')!=='kind,requiredScopes'||!Array.isArray(b.requiredScopes))return send(400,{code:'INVALID_IDENTITY_PROTOCOL'});
   if(req.headers.authorization!=='Bearer '+s.auth.token||s.control.revoked||b.kind!==s.p.kind||b.requiredScopes.some((v:any)=>!s.p.scopes.includes(v)))return send(403,{code:'CURRENT_IDENTITY_DENIED'});
   send(200,structuredClone(s.p));
  }catch{send(400,{code:'INVALID_IDENTITY_PROTOCOL'});}
 });await new Promise<void>(r=>identity.listen(0,'127.0.0.1',r));identityPort=(identity.address() as AddressInfo).port;
},30000);
beforeEach(()=>{s=fixture();fixtures.push(s);});
afterEach(async()=>{for(const r of owned.splice(0))await r.close();for(const f of fixtures.splice(0))f.close();vi.restoreAllMocks();});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>identity.close(e=>e?reject(e):resolve()));});
async function assembled(c=config()){const runtime=(await createB2bHistoryRuntime(c,deps()))!;owned.push(runtime);const ports=await runtime.start();return {runtime,c,api:(ports.api as AddressInfo).port,control:(ports.control as AddressInfo).port};}
function begin(port:number,path:string,body:unknown,options:{token?:string;peer?:'resource'|'edge'|'other'|null;raw?:boolean;method?:string}={}){
 const bytes=Buffer.from(options.raw?String(body):JSON.stringify(body));let req!:ReturnType<typeof request>;
 const result=new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
  const peer=options.peer===undefined?'resource':options.peer;
  req=request({hostname:'127.0.0.1',port,path,method:options.method??'POST',ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),agent:false,rejectUnauthorized:true,timeout:5000,
   headers:{'Content-Type':'application/json','Content-Length':bytes.length,...(options.token?{Authorization:'Bearer '+options.token}:{})}},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{const bytes=Buffer.concat(chunks);try{resolve({status:res.statusCode!,bytes,body:String(res.headers['content-type']).includes('application/json')?JSON.parse(bytes.toString()):null,headers:res.headers});}catch(e){reject(e);}});});
  req.on('error',reject);req.on('timeout',()=>req.destroy(Error('SYNTHETIC_TIMEOUT')));req.end(bytes);
 });return {req,result};
}
const send=(...a:Parameters<typeof begin>)=>begin(...a).result;
const rpc=(action='DETAIL')=>({kind:s.p.kind,action,input:action==='LIST'?{binding:s.binding,take:10}:{binding:s.binding,recordId:s.recordId,...(action==='CONTENT'?{artifactKind:'CDR_XML'}:{})}});
describe('History concrete runtime: original QA guards, persistent independent grants and real Nest/mTLS',()=>{
 it('disabled factory performs no IO or dependency inspection',async()=>{const poison=new Proxy({},{get(){throw Error('DISABLED_DEPENDENCY_ACCESS');}});expect(await createB2bHistoryRuntime()).toBeNull();expect(await createB2bHistoryRuntime({enabled:false} as any,poison as any)).toBeNull();expect(s.query).not.toHaveBeenCalled();});
 it('assembles original READ_ONLY repository + actual store without sockets, grants, actors or Identity at bootstrap',async()=>{
  const runtime=(await createB2bHistoryRuntime(config(),deps()))!;owned.push(runtime);expect(runtime.application.getHttpServer().address()).toBeNull();expect(s.control.identityCalls).toBe(0);expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();
  expect(s.query.mock.calls.map(c=>c[0])).toEqual(['SELECT current_database() AS database, current_user AS role',...b2bHistoryRuntimeSchemaChecks]);expect(runtime.bootId).toBe(runtime.maintenance.snapshot().instance.bootId);expect(runtime.status.capabilities).toEqual(['READ']);
 });
 it('reports only READ with shared bootId; status rechecks schema and markers every time',async()=>{
  const r=await assembled(),before=s.query.mock.calls.length,probe=await send(r.api,'/internal/b2b/runtime-status',{});
  expect(probe).toMatchObject({status:200,body:{owner:'history',capabilities:['READ'],bootId:r.runtime.bootId,fiscalActivation:false}});expect(s.query.mock.calls.length-before).toBe(b2bHistoryRuntimeSchemaChecks.length+1);
  s.control.missingSchema='B2bHistoryArchiveGrant';const unavailable=await send(r.api,'/internal/b2b/runtime-status',{});expect(unavailable.status).toBe(503);expect(JSON.stringify(unavailable.body)).not.toContain('PRIVATE_SCHEMA_CANARY');
 });
 it('serves LIST, DETAIL and exact stored CDR bytes through the actual archive service',async()=>{
  const r=await assembled(),list=await send(r.api,'/internal/b2b/history-read',rpc('LIST'),{token:s.auth.token}),detail=await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token}),content=await send(r.api,'/internal/b2b/history-read',rpc('CONTENT'),{token:s.auth.token});
  expect(list).toMatchObject({status:200,body:{environment:'BETA',datasetClass:'SYNTHETIC',candidateOnly:true,readOnly:true,fiscalAuthority:false}});expect(list.body.data.items[0].recordId).toBe(s.recordId);
  expect(detail.status).toBe(200);expect(detail.body.data.snapshot).toEqual(s.plan.records[0].snapshot);expect(detail.body.data).not.toHaveProperty('artifactKeys');expect(content.status).toBe(200);
  const a=s.row.snapshot.artifacts.find((a:any)=>a.kind==='CDR_XML');expect(content.headers['x-content-sha256']).toBe(a.sha256);expect(content.bytes.length).toBe(a.sizeBytes);expect(content.headers['cache-control']).toBe('private, no-store');
  expect(s.control.identityCalls).toBeGreaterThan(10);expect(s.grant.actorId).not.toBe(s.p.clientId);expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();
 });
 it('empty optional enrollment tables never grant automatically',async()=>{const r=await assembled();s.control.enrolled=false;expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(403);expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();});
 it.each(['active','actorActive','clientRevision','userAuthRevision','actorRevision','binding','bindingSha256','permission','environment','datasetClass','actorId','GLOBAL','extra-permission','scope'])('denies stale or unsafe independent grant %s',async field=>{
  const r=await assembled();const g=s.grant;
  if(['active','actorActive'].includes(field))g[field]=false;
  if(field==='clientRevision')g.clientRevision=2;if(field==='userAuthRevision')g.userAuthRevision=9;if(field==='actorRevision')g.currentActorRevision=2n;
  if(field==='binding')g.binding={...g.binding,pointId:randomUUID()};if(field==='bindingSha256')g.bindingSha256='0'.repeat(64);
  if(field==='permission')g.permission='history.import';if(field==='environment')g.environment='PRODUCTION';if(field==='datasetClass')g.datasetClass='AUTHORIZED_COPY';if(field==='actorId')g.actorId=randomUUID();
  if(field==='GLOBAL'){g.actor.scope={kind:'GLOBAL'};g.actor.roles=['ADMIN'];}if(field==='extra-permission')g.actor.permissions.push('history.import');if(field==='scope')g.actor.scope.branchIds=[randomUUID()];
  expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(403);
 });
 it('USER principal must match a separately stored actor and current auth revision',async()=>{
  s.p.kind='USER';s.p.subjectId=s.grant.actorId;s.p.userAuthRevision=4;s.grant.actorKind='USER';s.grant.subjectId=s.p.subjectId;s.grant.userAuthRevision=4;
  const r=await assembled();expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(200);s.grant.actor.userId=randomUUID();expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(403);
 });
 it('revalidates grant/actor revisions after archive IO before releasing data',async()=>{
  const r=await assembled();s.tx.historyRecord.findFirst.mockImplementationOnce(async()=>{s.grant.revision=2n;return s.row;});const out=await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token});expect(out.status).toBe(401);expect(out.body).not.toHaveProperty('data');
 });
 it('current Identity denial and scope loss stay authoritative',async()=>{
  const r=await assembled();s.control.revoked=true;expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(403);s.control.revoked=false;s.p.scopes=['b2b:history:read'];expect((await send(r.api,'/internal/b2b/history-read',rpc('CONTENT'),{token:s.auth.token})).status).toBe(403);
 });
 it('rejects non-synthetic RUC before any enrollment query',async()=>{
  const r=await assembled();const binding={...s.binding,issuerRuc:'99999999999'};s.p.bindings=[binding];const out=await send(r.api,'/internal/b2b/history-read',{kind:s.p.kind,action:'LIST',input:{binding}},{token:s.auth.token});expect(out.status).toBe(422);expect(s.query.mock.calls.filter(c=>c[0]===historyRuntimeEnrollmentQuery)).toHaveLength(0);
 });
 it.each(['database','role','marker'])('keeps the original %s guard on every request',async field=>{
  const r=await assembled();if(field==='database')s.control.database='other';if(field==='role')s.control.role='history_import_qa';if(field==='marker')s.tx.historySandbox.findUnique.mockResolvedValue({markerId:randomUUID(),environment:'BETA',datasetClass:'SYNTHETIC',schemaVersion:'factuez.history-storage.v1'});
  expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(503);
 });
 it('enforces mTLS resource pins and rejects missing certificates or unexpected bearers',async()=>{
  const r=await assembled();expect((await send(r.api,'/internal/b2b/history-read',rpc(),{peer:'other',token:s.auth.token})).status).toBe(403);expect(s.control.identityCalls).toBe(0);await expect(send(r.api,'/internal/b2b/runtime-status',{}, {peer:null})).rejects.toThrow();expect((await send(r.api,'/internal/b2b/runtime-status',{}, {token:s.auth.token})).status).toBe(400);
 });
 it.each(['malformed','query','oversize','import'])('rejects %s without echoing private payloads',async type=>{
  const r=await assembled(),out=await send(r.api,type==='query'?'/internal/b2b/history-read?PRIVATE_CANARY=1':type==='import'?'/internal/b2b/history-import':'/internal/b2b/history-read',type==='malformed'?' {"PRIVATE_CANARY":':type==='oversize'?{value:'PRIVATE_CANARY'.repeat(2000)}:rpc(),{token:s.auth.token,raw:type==='malformed'});
  expect([400,413]).toContain(out.status);expect(JSON.stringify(out.body)).not.toContain('PRIVATE_CANARY');
 });
 it('aborted client retains SQL slot; ADMISSION waits and operator/storage phases remain ordered',async()=>{
  const entered=deferred(),release=deferred();s.tx.historyRecord.findFirst.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return s.row;});const r=await assembled();
  const client=begin(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token}),outcome=client.result.catch(()=>null);await entered.promise;client.req.destroy();await outcome;await expect.poll(()=>r.runtime.drain.snapshot().aborted).toBe(1);
  const operator=new HttpsB2bMaintenancePort(`https://127.0.0.1:${r.control}`,{ca:tls.ca,cert:tls.other,key:tls.key},fingerprint(tls.server));
  const request={runId:randomUUID(),deploymentId:r.c.deploymentId,inventorySha256:'ab'.repeat(32),instance:r.runtime.maintenance.snapshot().instance};let completed=false;const phase=operator.advance('ADMISSION',request).then(v=>{completed=true;return v;});
  try{await expect.poll(()=>r.runtime.maintenance.snapshot().state).toBe('STOPPING');expect(completed).toBe(false);expect(s.db.$disconnect).not.toHaveBeenCalled();expect((await send(r.api,'/internal/b2b/runtime-status',{})).status).toBe(200);expect((await send(r.api,'/internal/b2b/history-read',rpc(),{token:s.auth.token})).status).toBe(503);}finally{release.resolve();}
  await phase;await operator.advance('PRODUCERS',request);await operator.advance('WORKERS',request);expect(s.db.$disconnect).not.toHaveBeenCalled();await operator.advance('STORAGE',request);expect(s.db.$disconnect).toHaveBeenCalledTimes(1);expect(await operator.status()).toMatchObject({state:'PARKED',storageClosed:true});await expect(r.runtime.status.inspect()).rejects.toThrow('STORAGE_CLOSED');
 });
 it('does not expose keys, actor records, archive roots or DB credentials through runtime inspection',async()=>{const r=await assembled();expect(JSON.stringify(r.runtime)+inspect(r.runtime)).not.toMatch(/PRIVATE KEY|sourceRoot|archiveRoot|database|password|actorId/);});
 it.each(['environment','datasetClass','user','name','markerId'])('configuration cannot relax %s',field=>{const c:any=config();if(field==='environment')c.environment='PRODUCTION';if(field==='datasetClass')c.datasetClass='AUTHORIZED_COPY';if(field==='user')c.database.user='history_import_qa';if(field==='name')c.database.name='b2b_history_beta';if(field==='markerId')c.markerId='not-a-uuid';expect(()=>historyRuntimeConfig(c)).toThrow('CONFIG_INVALID');});
 it('missing enrollment schema blocks assembly with no DDL or pool ownership takeover',async()=>{s.control.missingSchema='B2bHistoryArchiveActor';await expect(createB2bHistoryRuntime(config(),deps())).rejects.toThrow('STORAGE_NOT_READY');expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();expect(s.db.$disconnect).not.toHaveBeenCalled();});
 it.each(['marker','junction','hardlink'])('original QA physical storage %s guard remains mandatory',async kind=>{
  const path=join(s.storage.archiveRoot,'.history-qa-marker.json');
  if(kind==='marker')writeFileSync(path,JSON.stringify({profile:'factuez-history-storage-qa-v1',markerId:randomUUID()}));
  if(kind==='junction'){const moved=join(s.storage.archiveRoot,'..','moved');renameSync(s.storage.archiveRoot,moved);symlinkSync(moved,s.storage.archiveRoot,'junction');}
  if(kind==='hardlink')linkSync(path,join(s.storage.archiveRoot,'..','marker-copy.json'));
  await expect(createB2bHistoryRuntime(config(),deps())).rejects.toThrow('QA_STORAGE_NOT_READY');expect(s.query).not.toHaveBeenCalled();
 });
 it('candidate only contains inactive actor/grant DDL; boot executes none of it',async()=>{
  expect(b2bHistoryEnrollmentCandidateSql).toContain('DEFAULT false');expect(b2bHistoryEnrollmentCandidateSql).not.toMatch(/CREATE ROLE|INSERT INTO|history_import_qa/);expect(b2bHistoryEnrollmentCandidateSql).toContain('GRANT SELECT');
  const c=config(),permission=new PostgresB2bHistoryArchivePermission(s.db,c);expect(await permission.authorizeCurrent({principal:s.p,binding:s.binding})).toMatchObject({actor:{scope:{kind:'ASSIGNED'},permissions:['history.view']},revision:'1:1'});expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();
 });
 it('fixed readiness projections refer to actual Prisma and candidate columns only',()=>{
  const schema=readFileSync(new URL('../services/history-service/prisma/schema.prisma',import.meta.url),'utf8');const fields=new Map<string,Set<string>>();
  for(const m of schema.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g))fields.set(m[1],new Set([...m[2].matchAll(/^\s*(\w+)\s+/gm)].map(x=>x[1])));
  for(const m of b2bHistoryEnrollmentCandidateSql.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g))fields.set(m[1],new Set([...m[2].matchAll(/"(\w+)"\s+(?:text|uuid|integer|bigint|jsonb|boolean)/g)].map(x=>x[1])));
  for(const sql of b2bHistoryRuntimeSchemaChecks){const m=/^SELECT (.+) FROM "(\w+)" WHERE false$/.exec(sql)!;expect(m).toBeTruthy();for(const col of m[1].matchAll(/"(\w+)"/g))expect(fields.get(m[2])?.has(col[1]),m[2]+'.'+col[1]).toBe(true);}
 });
});
