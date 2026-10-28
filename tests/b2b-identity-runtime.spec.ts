import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {randomUUID,X509Certificate} from 'node:crypto';
import {createB2bIdentityRuntime,type B2bIdentityRuntimeDependencies,type B2bIdentityOwnerRuntime} from '../services/identity-service/src/b2b/runtime';
import {validateB2bIdentityRuntimeConfig,type B2bIdentityRuntimeConfig} from '../services/identity-service/src/b2b/runtime-config';
import {createB2bIdentityRuntimeFromFiles} from '../services/identity-service/src/b2b/runtime-files';
import {b2bIdentityRuntimeSchemaChecks,checkB2bIdentityRuntimeSchema} from '../services/identity-service/src/b2b/runtime-schema';
import {B2bAudience} from '../packages/contracts/src/b2b';
import {HttpsB2bMaintenancePort} from '../packages/service-access/src/b2b-maintenance-node';
import {UserPermissionsService} from '../services/identity-service/src/application/user-permissions.service';
import {PasswordService} from '../services/identity-service/src/application/password.service';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {pem,others,binding,input,basic,id} from './b2b-identity.fixture';
import {B2bSecurityError} from '../packages/contracts/src/b2b-security';

let tls:ReturnType<typeof b2bCertificates>,control:ReturnType<typeof b2bCertificates>,oidc:Server,billing:Server,oidcPort:number,billingPort:number;
let claims:Record<string,any>;const token='synthetic-oidc-admin-token-0001',delegated='synthetic-oidc-user-token-00001',userId=id(97),linkId=id(98);
const oidcCalls=vi.fn(),billingCalls=vi.fn();const runtimes:B2bIdentityOwnerRuntime[]=[];
const address=(s:Server)=>(s.address() as AddressInfo).port;
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return address(server);}
async function close(server:Server){await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
beforeAll(async()=>{
 tls=b2bCertificates();control=b2bCertificates();
 const options={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
 oidc=createServer(options,async(req,res)=>{
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const form=new URLSearchParams(Buffer.concat(parts).toString());oidcCalls(req.url,req.headers,form.get('token'));
  res.setHeader('Content-Type','application/json');
  if(req.url!=='/introspect'||req.headers.authorization!=='Basic '+Buffer.from('synthetic-client:synthetic-secret').toString('base64')){res.writeHead(401);res.end('{}');return;}
  const presented=form.get('token');res.end(JSON.stringify(presented===token?claims:presented===delegated?{...claims,aud:B2bAudience,scope:'openid b2b:context:read b2b:catalog:read b2b:identity:manage',client_id:'synthetic-delegation'}:{active:false}));
 });
 billing=createServer(options,async(req,res)=>{
  const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));const value=JSON.parse(Buffer.concat(parts).toString());billingCalls(req.url,value,req.headers);
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({valid:Array.isArray(value.bindings)&&value.bindings.length>0}));
 });
 oidcPort=await listen(oidc);billingPort=await listen(billing);
},30000);
beforeEach(()=>{
 const now=Math.floor(Date.now()/1000);claims={active:true,token_type:'Bearer',iss:`https://127.0.0.1:${oidcPort}`,sub:'synthetic-subject',client_id:'synthetic-admin-bff',
  aud:'factuez-b2b-admin',scope:'openid factuez.b2b.admin',iat:now-10,exp:now+240,auth_time:now-20,amr:['pwd','mfa'],acr:'urn:synthetic:mfa'};
 oidcCalls.mockClear();billingCalls.mockClear();
});
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();});
afterAll(async()=>{await close(oidc);await close(billing);});
function config():B2bIdentityRuntimeConfig{
 const resource=[fingerprint(tls.resource)];return {enabled:true,environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},
  tokenIssuer:'https://identity.synthetic.invalid/b2b',billingOrigin:`https://127.0.0.1:${billingPort}`,oidc:{issuer:`https://127.0.0.1:${oidcPort}`,introspectionEndpoint:`https://127.0.0.1:${oidcPort}/introspect`,adminClientId:'synthetic-admin-bff',acceptedAcr:['urn:synthetic:mfa']},
  scopes:['b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:webhooks:read','b2b:webhooks:manage','b2b:identity:manage'],
  peers:{token:resource,admin:[fingerprint(tls.edge)],resource,correctionOwner:resource,guideOwner:resource,guideIssueOwner:resource,webhook:resource,operator:[fingerprint(control.resource)]}};
}
function dependencies(){
 const clients=new Map<string,any>(),audits:any[]=[];let linkEnabled=true,active=true,missingSchema:string|undefined;
 const user={id:userId,username:'synthetic-owner',fullName:'Synthetic Owner',active:true,authVersion:3,roles:[{role:{id:id(95),code:'ADMIN',name:'Admin',active:true,
  permissions:['SETUP_MANAGE','USER_MANAGE','ROLE_MANAGE','DOCUMENT_VIEW'].map(code=>({permission:{code}}))}}],branches:[],emissionPoints:[],series:[],lastLoginAt:null};
 const query=vi.fn(async(sql:string,...values:any[])=>{
  if(sql.endsWith('WHERE false')){if(missingSchema&&sql.includes('"'+missingSchema+'"'))throw Error('PRIVATE_SCHEMA_DETAIL');return [];}
  if(sql.startsWith('INSERT INTO "B2bRateBucket"'))return [{count:1}];
  if(sql.includes('FROM "B2bAdminOidcLink"'))return linkEnabled&&values[1]==='synthetic-subject'?[{id:linkId,userId,enabled:true,userAuthRevision:3,linkRevision:'1'}]:[];
  if(sql.includes('FROM "B2bClient"')&&!sql.includes('JOIN'))return clients.has(values[0])?[structuredClone(clients.get(values[0]))]:[];
  if(sql.includes('FROM "B2bUserLink"')){const c=[...clients.values()].find(c=>c.kind==='USER');return c?[{clientId:c.id,clientRevision:c.revision,userId,userAuthRevision:3,enabled:true}]:[];}
  if(/B2b(Correction|Guide)/.test(sql))return [];
  throw Error('UNEXPECTED_SYNTHETIC_QUERY');
 });
 const execute=vi.fn(async(sql:string,...v:any[])=>{
  if(sql.startsWith('INSERT INTO "B2bClient"')){clients.set(v[0],{id:v[0],label:v[1],kind:v[2],enabled:v[3],revision:v[4],secretHash:v[5],oidcClientId:v[6],scopes:JSON.parse(v[7]),bindings:JSON.parse(v[8])});return 1;}
  if(sql.startsWith('INSERT INTO "B2bAudit"')){audits.push(v);return 1;}
  throw Error('UNEXPECTED_SYNTHETIC_WRITE');
 });
 const db:any={$queryRawUnsafe:query,$executeRawUnsafe:execute,$disconnect:vi.fn(async()=>{}),$queryRaw:vi.fn(async(strings:TemplateStringsArray)=>strings.join('').includes('to_regclass')?[{ready:true}]:[]),
  user:{findUnique:vi.fn(async()=>({...structuredClone(user),active})),findMany:vi.fn(async()=>[])}};
 db.$transaction=vi.fn(async(work:any)=>work(db));
 const credentials={signingKey:pem,pepper:Buffer.alloc(32,9),humanPublicKey:others.human,integrationPublicKey:others.integration,
  oidcBasicCredential:'Basic '+Buffer.from('synthetic-client:synthetic-secret').toString('base64'),
  apiTls:{ca:tls.ca,cert:tls.server,key:tls.key},controlTls:{ca:control.ca,cert:control.server,key:control.key},
  billingTls:{ca:tls.ca,cert:tls.edge,key:tls.key},oidcTls:{ca:tls.ca,cert:tls.edge,key:tls.key}};
 const lifecycle={stopProducers:vi.fn(async()=>{}),stopWorkers:vi.fn(async()=>{}),waitForDependentWorkers:vi.fn(async()=>{}),closeOtherOwnerListeners:vi.fn(async()=>{})};
 const deps:B2bIdentityRuntimeDependencies={prisma:db,permissions:new UserPermissionsService(db),credentials,lifecycle};
 return {deps,db,query,execute,clients,audits,lifecycle,missing:(name?:string)=>{missingSchema=name;},linked:(v:boolean)=>{linkEnabled=v;},active:(v:boolean)=>{active=v;}};
}
async function assembled(privileged=false){
 const f=dependencies(),cfg=config();
 if(privileged)f.deps.privileged={passwords:new PasswordService(),authority:{authorize:vi.fn(async()=>{throw new B2bSecurityError(403,'SYNTHETIC_POLICY_DENIED');})},
  liveIdentity:{current:async()=>null},bindingOwner:{revalidate:async()=>{throw new B2bSecurityError(403,'SYNTHETIC_RESOURCE_DENIED');}}};
 const runtime=(await createB2bIdentityRuntime(cfg,f.deps))!;runtimes.push(runtime);const ports=await runtime.start();
 return {...f,config:cfg,runtime,port:(ports.api as AddressInfo).port,controlPort:(ports.control as AddressInfo).port};
}
function send(port:number,path:string,body?:unknown,peer:'edge'|'resource'|'other'|null='resource',method='POST',bearer?:string){
 const bytes=body===undefined?undefined:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
 return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),rejectUnauthorized:true,agent:false,timeout:4000,
   headers:{...(bytes?{'Content-Type':typeof body==='string'?'application/x-www-form-urlencoded':'application/json','Content-Length':String(bytes.length)}:{}),...(bearer?{Authorization:bearer}:{})}},res=>{
   const parts:Buffer[]=[];res.on('data',b=>parts.push(b));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:parts.length?JSON.parse(Buffer.concat(parts).toString()):null});}catch(e){reject(e);}});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('SYNTHETIC_TIMEOUT')));req.end(bytes);
 });
}
async function createClient(f:Awaited<ReturnType<typeof assembled>>,user=false){
 return send(f.port,'/internal/b2b/clients',user?{...input(),kind:'USER',oidcClientId:'synthetic-delegation',scopes:[...input().scopes,'b2b:identity:manage']}:input(),'edge','POST','Bearer '+token);
}

describe('Identity owner runtime: real Nest/mTLS, OIDC authority and persistent adapter assembly',()=>{
 it('defaults disabled without touching credentials, dependencies or mounted files',async()=>{
  const inaccessible=new Proxy({},{get(){throw Error('MUST_NOT_READ');}});
  expect(await createB2bIdentityRuntime()).toBeNull();expect(await createB2bIdentityRuntime({enabled:false} as any,inaccessible as any)).toBeNull();
  expect(await createB2bIdentityRuntimeFromFiles(inaccessible as any,inaccessible as any)).toBeNull();
 });
 it('checks all schema projections without row reads, DDL or writes and fails closed on any missing table/column',async()=>{
  const f=dependencies();await checkB2bIdentityRuntimeSchema(f.db);expect(f.query.mock.calls.map(c=>c[0])).toEqual([...b2bIdentityRuntimeSchemaChecks]);
  expect(f.execute).not.toHaveBeenCalled();expect(f.db.user.findUnique).not.toHaveBeenCalled();
  for(const sql of b2bIdentityRuntimeSchemaChecks){f.missing(/FROM "([^"]+)"/.exec(sql)![1]);await expect(checkB2bIdentityRuntimeSchema(f.db)).rejects.toThrow('B2B_IDENTITY_RUNTIME_STORAGE_NOT_READY');expect(sql).toMatch(/^SELECT .* WHERE false$/);}
  f.missing('B2bGuideIssueGrantRevision');await expect(createB2bIdentityRuntime(config(),f.deps)).rejects.toThrow('STORAGE_NOT_READY');
 });
 it('advertises only assembled capabilities with matching owner/deployment/boot identity; readiness rechecks storage',async()=>{
  const f=await assembled(),r=await send(f.port,'/internal/b2b/runtime-status',{});
  expect(r.status).toBe(200);expect(r.body).toMatchObject({owner:'identity',deploymentId:f.config.deploymentId,bootId:f.runtime.bootId,state:'ASSEMBLED_AND_STORAGE_CHECKED'});
  expect(r.body.capabilities).toEqual(['APPLICATION_ADMIN','CORRECTION_AUTHORITY','GUIDE_AUTHORITY','IDENTITY','WEBHOOK_AUTHORITY']);
  expect(f.runtime.maintenance.snapshot().instance).toEqual({service:'IDENTITY',instanceId:f.config.instanceId,bootId:r.body.bootId});
  expect(f.runtime.statusMetadata.bootId).toBe(r.body.bootId);expect(f.runtime.statusMetadata.capabilities).not.toContain('PRIVILEGED_ADMIN');
  f.missing('B2bAdminOidcLink');const failed=await send(f.port,'/internal/b2b/runtime-status',{});expect(failed.status).toBe(503);expect(JSON.stringify(failed)).not.toContain('PRIVATE_SCHEMA');
  f.missing();expect((await send(f.port,'/internal/b2b/runtime-status',{})).status).toBe(200);
 });
 it('requires actual mTLS peers and never accepts forwarded administrator claims',async()=>{
  const f=await assembled();await expect(send(f.port,'/internal/b2b/runtime-status',{},null)).rejects.toThrow();
  expect((await send(f.port,'/internal/b2b/runtime-status',{},'other')).status).toBe(403);
  expect((await send(f.port,'/internal/b2b/clients',input(),'resource','POST','Bearer '+token)).status).toBe(403);
  expect((await send(f.port,'/internal/b2b/runtime-status',{deploymentId:f.config.deploymentId})).status).toBe(400);
 });
 it('creates with live OIDC step-up+directory+Billing HTTP then mints and introspects via PostgresB2bStore',async()=>{
  const f=await assembled(),made=await createClient(f);expect(made.status).toBe(201);expect(made.body.client.secretHash).toBeUndefined();expect(f.clients.size).toBe(1);
  expect(oidcCalls.mock.calls.length).toBeGreaterThanOrEqual(4);expect(billingCalls.mock.calls.some(c=>c[0]==='/internal/b2b/validate-bindings')).toBe(true);
  const access=await send(f.port,'/b2b/oauth/token','grant_type=client_credentials&scope=b2b%3Acontext%3Aread+b2b%3Acatalog%3Aread','resource','POST',basic(made.body.client.id,made.body.clientSecret));
  expect(access.status).toBe(200);expect(access.body.token_type).toBe('Bearer');
  const introspected=await send(f.port,'/internal/b2b/introspect',{kind:'SERVICE',requiredScopes:['b2b:context:read']},'resource','POST','Bearer '+access.body.access_token);
  expect(introspected.status).toBe(200);expect(introspected.body.clientId).toBe(made.body.client.id);expect(f.db.$transaction).toHaveBeenCalled();
 });
 it.each(['mfa','link','inactive','passwordOnly','expired'])('denies administration with %s and never invents step-up',async defect=>{
  const f=await assembled();if(defect==='mfa')claims.amr=['pwd'];if(defect==='link')f.linked(false);if(defect==='inactive')f.active(false);if(defect==='expired')claims.exp=Math.floor(Date.now()/1000)-1;
  const response=defect==='passwordOnly'?await send(f.port,'/internal/b2b/clients',input(),'edge','POST','Bearer human-step-up'):await createClient(f);
  expect([401,403]).toContain(response.status);expect(f.clients.size).toBe(0);
 });
 it('installs independent correction/guide/issue/webhook routes, without granting by base identity membership',async()=>{
  const f=await assembled();for(const path of ['authorize-correction','authorize-guide','authorize-guide-issue']){
   const r=await send(f.port,'/internal/b2b/'+path,{},'resource','POST','Bearer invalid-synthetic-token');expect(r.status).not.toBe(404);expect([400,401,403]).toContain(r.status);
  }
  expect((await send(f.port,'/internal/b2b/authorize-webhook',{})).status).toBe(400);
  expect((await send(f.port,'/internal/b2b/owner-admin',{})).status).toBe(404);
 });
 it('installs privileged owner only with all explicit ports, keeps real owner policy denial and all six capabilities',async()=>{
  const f=await assembled(true);expect((await createClient(f,true)).status).toBe(201);const status=await send(f.port,'/internal/b2b/runtime-status',{});expect(status.body.capabilities).toContain('PRIVILEGED_ADMIN');expect(status.body.capabilities).toHaveLength(6);
  const r=await send(f.port,'/internal/b2b/owner-admin',{kind:'USER',action:'USERS_LIST',input:{binding,payload:{}}},'resource','POST','Bearer '+delegated);
  expect(r.status).not.toBe(404);expect(r.status).not.toBe(200);expect(f.db.user.findMany).not.toHaveBeenCalled();expect(f.deps.privileged!.authority.authorize).toHaveBeenCalled();
  expect((await send(f.port,'/internal/b2b/owner-admin',{kind:'SERVICE',action:'USERS_LIST',input:{binding,payload:{}}},'resource','POST','Bearer '+delegated)).status).toBe(403);
 });
});


describe('Identity runtime lifecycle, private operator TLS and configuration gates',()=>{
 it('delegates actual OIDC USER tokens through explicit persisted links and current permissions',async()=>{
  const f=await assembled();expect((await createClient(f,true)).status).toBe(201);
  const r=await send(f.port,'/internal/b2b/introspect',{kind:'USER',requiredScopes:['b2b:identity:manage']},'resource','POST','Bearer '+delegated);
  expect(r.status).toBe(200);expect(r.body).toMatchObject({kind:'USER',subjectId:userId,userAuthRevision:3});
  f.active(false);expect((await send(f.port,'/internal/b2b/introspect',{kind:'USER',requiredScopes:[]},'resource','POST','Bearer '+delegated)).status).toBe(401);
 });
 it('keeps the API introspecting through dependent worker drain, closes API/storage only at STORAGE and leaves control PARKED',async()=>{
  const f=await assembled(),made=await createClient(f),access=await send(f.port,'/b2b/oauth/token','grant_type=client_credentials&scope=b2b%3Acontext%3Aread','resource','POST',basic(made.body.client.id,made.body.clientSecret));
  expect(access.status).toBe(200);
  const port=new HttpsB2bMaintenancePort(`https://127.0.0.1:${f.controlPort}`,{ca:control.ca,cert:control.resource,key:control.key},fingerprint(control.server));
  const inventory={runId:randomUUID(),deploymentId:f.config.deploymentId,inventorySha256:'a'.repeat(64),instance:f.runtime.maintenance.snapshot().instance};
  const introspect=()=>send(f.port,'/internal/b2b/introspect',{kind:'SERVICE',requiredScopes:[]},'resource','POST','Bearer '+access.body.access_token);
  await port.advance('ADMISSION',inventory);expect((await createClient(f)).status).toBe(503);expect((await introspect()).status).toBe(200);
  await port.advance('PRODUCERS',inventory);
  let release!:()=>void,entered!:()=>void;const entering=new Promise<void>(r=>{entered=r;});
  f.lifecycle.waitForDependentWorkers.mockImplementation(()=>{entered();return new Promise<void>(r=>{release=r;});});
  const workers=port.advance('WORKERS',inventory);await entering;
  expect((await port.status()).state).toBe('STOPPING');expect((await introspect()).status).toBe(200);expect(f.db.$disconnect).not.toHaveBeenCalled();
  release();await workers;expect(f.lifecycle.stopWorkers).toHaveBeenCalledOnce();expect((await introspect()).status).toBe(200);
  await port.advance('STORAGE',inventory);expect(f.lifecycle.closeOtherOwnerListeners).toHaveBeenCalledOnce();expect(f.db.$disconnect).toHaveBeenCalledOnce();
  await expect(introspect()).rejects.toThrow();expect(await port.status()).toMatchObject({state:'PARKED',storageClosed:true,instance:inventory.instance});
  expect(await port.advance('STORAGE',inventory)).toMatchObject({phase:'STORAGE',storageClosed:true});expect(f.db.$disconnect).toHaveBeenCalledOnce();
 });
 it('does not confuse an aborted administrative HTTP socket with completed owner work',async()=>{
  const f=await assembled();let release!:()=>void,entered!:()=>void;const entering=new Promise<void>(r=>{entered=r;});
  const actual=await f.db.user.findUnique();f.db.user.findUnique.mockImplementationOnce(()=>{entered();return new Promise(r=>{release=()=>r(actual);});});
  const body=Buffer.from(JSON.stringify(input()));
  const req=request({hostname:'127.0.0.1',port:f.port,path:'/internal/b2b/clients',method:'POST',ca:tls.ca,cert:tls.edge,key:tls.key,agent:false,rejectUnauthorized:true,
   headers:{'Content-Type':'application/json','Content-Length':body.length,Authorization:'Bearer '+token}},res=>res.resume());
  req.on('error',()=>{});req.end(body);await entering;req.destroy();
  const inventory={runId:randomUUID(),deploymentId:f.config.deploymentId,inventorySha256:'a'.repeat(64),instance:f.runtime.maintenance.snapshot().instance};
  let completed=false;
  const admission=f.runtime.maintenance.advance('ADMISSION',inventory).then(()=>{completed=true;});await new Promise(r=>setTimeout(r,20));
  expect(completed).toBe(false);expect(f.runtime.maintenance.snapshot().pending).toBe(1);release();await admission;
  expect(f.clients.size).toBe(1);expect(completed).toBe(true);await f.runtime.maintenance.advance('PRODUCERS',inventory);expect(f.lifecycle.stopProducers).toHaveBeenCalledOnce();
 });

 it('STORAGE drains an introspection SQL promise after client abort before closing API or Prisma',async()=>{
  const f=await assembled(),made=await createClient(f),access=await send(f.port,'/b2b/oauth/token','grant_type=client_credentials&scope=b2b%3Acontext%3Aread','resource','POST',basic(made.body.client.id,made.body.clientSecret));
  const inventory={runId:randomUUID(),deploymentId:f.config.deploymentId,inventorySha256:'a'.repeat(64),instance:f.runtime.maintenance.snapshot().instance};
  for(const phase of ['ADMISSION','PRODUCERS','WORKERS'] as const)await f.runtime.maintenance.advance(phase,inventory);
  let release!:()=>void,entered!:()=>void;const entering=new Promise<void>(r=>{entered=r;});
  f.query.mockImplementationOnce(()=>{entered();return new Promise<any[]>(r=>{release=()=>r([{count:1}]);});});
  const body=Buffer.from(JSON.stringify({kind:'SERVICE',requiredScopes:[]}));
  const req=request({hostname:'127.0.0.1',port:f.port,path:'/internal/b2b/introspect',method:'POST',ca:tls.ca,cert:tls.resource,key:tls.key,agent:false,rejectUnauthorized:true,
   headers:{'Content-Type':'application/json','Content-Length':body.length,Authorization:'Bearer '+access.body.access_token}},res=>res.resume());
  req.on('error',()=>{});req.end(body);await entering;req.destroy();let completed=false;
  const storage=f.runtime.maintenance.advance('STORAGE',inventory).then(()=>{completed=true;});await new Promise(r=>setTimeout(r,20));
  expect(completed).toBe(false);expect(f.db.$disconnect).not.toHaveBeenCalled();expect(f.lifecycle.closeOtherOwnerListeners).not.toHaveBeenCalled();
  release();await storage;expect(f.runtime.maintenance.snapshot()).toMatchObject({state:'PARKED',storageClosed:true});expect(f.db.$disconnect).toHaveBeenCalledOnce();
 });
 it('operator TLS is separate from resource/admin peers and cannot be reached using bearer credentials',async()=>{
  const f=await assembled();
  const wrong=new HttpsB2bMaintenancePort(`https://127.0.0.1:${f.controlPort}`,{ca:control.ca,cert:control.other,key:control.key},fingerprint(control.server));
  await expect(wrong.status()).rejects.toThrow('MAINTENANCE_REQUEST_DENIED');
  expect((await send(f.port,'/internal/maintenance/status',undefined,'resource','GET')).status).toBe(404);
  const port=new HttpsB2bMaintenancePort(`https://127.0.0.1:${f.controlPort}`,{ca:control.ca,cert:control.resource,key:control.key},fingerprint(control.server));
  const inventory={runId:randomUUID(),deploymentId:f.config.deploymentId,inventorySha256:'a'.repeat(64),instance:f.runtime.maintenance.snapshot().instance};
  await expect(port.advance('ADMISSION',{...inventory,instance:{...inventory.instance,bootId:randomUUID()}})).rejects.toThrow();
  await expect(port.advance('STORAGE',inventory)).rejects.toThrow();expect((await port.status()).state).toBe('READY');
 });
 it('fails terminally on a drain/storage barrier error, without a false PARKED receipt or private error text',async()=>{
  const f=await assembled(),inventory={runId:randomUUID(),deploymentId:f.config.deploymentId,inventorySha256:'a'.repeat(64),instance:f.runtime.maintenance.snapshot().instance};
  await f.runtime.maintenance.advance('ADMISSION',inventory);await f.runtime.maintenance.advance('PRODUCERS',inventory);
  f.lifecycle.waitForDependentWorkers.mockRejectedValueOnce(Error('PRIVATE_BARRIER_DETAIL'));
  await expect(f.runtime.maintenance.advance('WORKERS',inventory)).rejects.toThrow('MAINTENANCE_HOOK_FAILED');expect(f.runtime.maintenance.snapshot()).toMatchObject({state:'FAILED',storageClosed:false});
  expect(f.db.$disconnect).not.toHaveBeenCalled();expect(JSON.stringify(f.runtime)).not.toContain('PRIVATE_BARRIER');
 });
 it('validates fixed HTTPS origins, BETA deployment IDs, listener ports and separate admin/operator peers',()=>{
  for(const mutate of [(c:any)=>c.billingOrigin='http://billing.invalid',(c:any)=>c.billingOrigin='https://billing.invalid/unsafe',
   (c:any)=>c.oidc.introspectionEndpoint='https://attacker.invalid/token',(c:any)=>c.tokenIssuer='https://x.invalid/?token=x',
   (c:any)=>c.environment='PRODUCTION',(c:any)=>c.deploymentId='caller-selected',(c:any)=>c.control.port=-1,
   (c:any)=>c.peers.admin=c.peers.resource,(c:any)=>c.peers.operator=c.peers.resource,(c:any)=>c.peers.resource=[],(c:any)=>c.extra='inbound']){
   const c=config();mutate(c);expect(()=>validateB2bIdentityRuntimeConfig(c)).toThrow('CONFIGURATION_INVALID');
  }
 });
 it('requires existing owner dependencies and valid dedicated secret/TLS buffers before creating listeners',async()=>{
  const f=dependencies();await expect(createB2bIdentityRuntime(config())).rejects.toThrow('DEPENDENCIES_REQUIRED');
  await expect(createB2bIdentityRuntime(config(),{...f.deps,lifecycle:undefined} as any)).rejects.toThrow('DEPENDENCIES_REQUIRED');
  await expect(createB2bIdentityRuntime(config(),{...f.deps,privileged:{} as any})).rejects.toThrow('DEPENDENCIES_REQUIRED');
  for(const change of [(d:any)=>d.pepper=Buffer.alloc(31),(d:any)=>d.signingKey=tls.key,(d:any)=>d.apiTls={...d.apiTls,cert:control.server},(d:any)=>d.controlTls=d.apiTls]){
   const credentials={...f.deps.credentials};change(credentials);await expect(createB2bIdentityRuntime(config(),{...f.deps,credentials})).rejects.toThrow('CONFIGURATION_INVALID');
  }
 });
 it('checks every mounted filename before reading any secret and ignores a disabled mount configuration',async()=>{
  const f=dependencies(),refs={signingKey:'../../caller.key',pepper:'pepper.bin',humanPublicKey:'human.pem',integrationPublicKey:'integration.pem',oidcCredential:'oidc.bin',
   ...Object.fromEntries(['apiTls','controlTls','billingTls','oidcTls'].map(name=>[name,{ca:'ca.crt',cert:'server.crt',key:'server.key'}]))},
   files={metadata:vi.fn(()=>({config:config(),files:refs})),privatePem:vi.fn(),publicPem:vi.fn(),secretBytes:vi.fn()};
  await expect(createB2bIdentityRuntimeFromFiles(files as any,f.deps,{enabled:true})).rejects.toThrow('MOUNTED_RUNTIME_NOT_READY');
  expect(files.privatePem).not.toHaveBeenCalled();expect(files.publicPem).not.toHaveBeenCalled();expect(files.secretBytes).not.toHaveBeenCalled();
  files.metadata.mockReturnValueOnce({config:{enabled:false},files:{}} as any);expect(await createB2bIdentityRuntimeFromFiles(files as any,f.deps,{enabled:true})).toBeNull();
 });
});
