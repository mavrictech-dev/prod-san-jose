import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
const mock=vi.hoisted(()=>({db:undefined as any,constructed:vi.fn()}));
vi.mock('../services/identity-service/src/infrastructure/prisma.service',()=>({PrismaService:class {constructor(options:unknown){mock.constructed(options);return mock.db;}}}));
import {bootstrapB2bIdentity} from '../services/identity-service/src/b2b/main';
import {startB2bIdentityHost} from '../services/identity-service/src/b2b/runtime-host';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {pem,others,binding,id} from './b2b-identity.fixture';
import {B2bAudience} from '../packages/contracts/src/b2b';
import {HttpB2bOwnerAdministration} from '../packages/service-access/src/b2b-owner-administration';
import {B2bPrivateHttp,B2bIdentityHttp} from '../packages/service-access/src/b2b';
import {HttpB2bEmailActor} from '../packages/service-access/src/b2b-email-actor';
import {BillingHostPermissions} from '../services/billing-service/src/b2b/host-permissions';
import {BillingAuthorityHttps} from '../services/billing-service/src/b2b/host-permissions-http';
import {MemoryBusinessStore,customer,product} from './helpers/b2b-phase8-business.fixture';
import {b2bIdentityHostConfig,checkB2bIdentityDatabaseEnvironment} from '../services/identity-service/src/b2b/runtime-host-config';

let tls:ReturnType<typeof b2bCertificates>,operator:ReturnType<typeof b2bCertificates>,oidc:Server,billing:Server,oidcPort:number,billingPort:number;
let claims:any,bindingAvailable=true,oidcAvailable=true;const roots:string[]=[],hosts:Awaited<ReturnType<typeof startB2bIdentityHost>>[]=[];
const subject=id(71),clientId=id(72),cashier=id(73),token='synthetic-privileged-oidc-token-00001',client='synthetic-identity-delegated';
const network=vi.fn();
beforeAll(async()=>{
 tls=b2bCertificates();operator=b2bCertificates();const options={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
 oidc=createServer(options,async(req,res)=>{
  const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const form=new URLSearchParams(Buffer.concat(chunks).toString());network('oidc',req.url);
  res.setHeader('Content-Type','application/json');if(!oidcAvailable){res.statusCode=503;res.end('{}');return;}
  if(req.headers.authorization!=='Basic '+Buffer.from('synthetic:credential').toString('base64')){res.statusCode=401;res.end('{}');return;}
  res.end(JSON.stringify(form.get('token')===token?claims:{active:false}));
 });
 billing=createServer(options,async(req,res)=>{
  const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));network('billing',req.url);
  const body=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({valid:bindingAvailable&&req.url==='/internal/b2b/validate-bindings'&&JSON.stringify(body.bindings)===JSON.stringify([binding])}));
 });
 await new Promise<void>(r=>oidc.listen(0,'127.0.0.1',r));await new Promise<void>(r=>billing.listen(0,'127.0.0.1',r));
 oidcPort=(oidc.address() as AddressInfo).port;billingPort=(billing.address() as AddressInfo).port;
},30000);
afterAll(async()=>{await new Promise<void>(r=>oidc.close(()=>r()));await new Promise<void>(r=>billing.close(()=>r()));});
beforeEach(()=>{
 const now=Math.floor(Date.now()/1000);claims={active:true,token_type:'Bearer',iss:`https://127.0.0.1:${oidcPort}`,sub:'synthetic-persisted-subject',client_id:client,aud:B2bAudience,
  iat:now-10,exp:now+280,auth_time:now-20,amr:['pwd','mfa'],acr:'urn:synthetic:mfa',scope:'openid b2b:context:read b2b:catalog:read b2b:identity:manage'};
 bindingAvailable=true;oidcAvailable=true;network.mockClear();mock.constructed.mockClear();
});
afterEach(async()=>{
 for(const h of hosts.splice(0))await h?.shutdown();
 for(const root of roots.splice(0)){
  if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-identity-host-'))throw Error('TEST_CLEANUP_OUTSIDE_OWNED_ROOT');
  rmSync(root,{recursive:true,force:true});
 }vi.unstubAllEnvs();
});
function data(){
 const actor:any={id:subject,username:'owner-synthetic',fullName:'Synthetic Owner',active:true,authVersion:3,roles:[{role:{code:'ADMIN',active:true,name:'Admin',
  permissions:['SETUP_MANAGE','USER_MANAGE','ROLE_MANAGE','DOCUMENT_VIEW'].map(code=>({permission:{code}}))}}],branches:[],emissionPoints:[],series:[],lastLoginAt:null};
 const app:any={id:clientId,label:'Synthetic user app',kind:'USER',enabled:true,revision:1,secretHash:null,oidcClientId:client,
  scopes:['b2b:context:read','b2b:catalog:read','b2b:identity:manage'],bindings:[binding]};
 let linked=true,missing=false;const created:any[]=[];
 const db:any={$connect:vi.fn(async()=>{}),$disconnect:vi.fn(async()=>{}),$executeRawUnsafe:vi.fn(async(sql:string)=>{if(!sql.startsWith('INSERT INTO "B2bAudit"'))throw Error('UNEXPECTED_SYNTHETIC_WRITE');return 1;}),
  $queryRawUnsafe:vi.fn(async(sql:string,...v:any[])=>{
   if(sql.endsWith('WHERE false')){if(missing)throw Error('PRIVATE_COLUMN_MISSING');return [];}
   if(sql.startsWith('INSERT INTO "B2bRateBucket"'))return [{count:1}];
   if(sql.startsWith('SELECT EXISTS')&&sql.includes('FROM "B2bUserLink"'))return [{ok:linked&&v[0]===app.id&&v[1]===app.revision&&v[2]===actor.id&&v[3]===actor.authVersion}];
   if(sql.includes('FROM "B2bUserLink"'))return linked&&v[1]==='synthetic-persisted-subject'&&v[2]===client?[{clientId,clientRevision:1,userId:subject,userAuthRevision:3,enabled:true}]:[];
   if(sql.includes('FROM "B2bClient"'))return v[0]===clientId?[structuredClone(app)]:[];
   if(sql.includes('FROM "Role"')&&sql.includes('FOR SHARE'))return [{id:cashier}];
   throw Error('UNEXPECTED_SYNTHETIC_QUERY');
  }),$queryRaw:vi.fn(async(strings:TemplateStringsArray)=>strings.join('').includes('to_regclass')?[{ready:true}]:[]),
  user:{findUnique:vi.fn(async({where}:any)=>where.id===subject?structuredClone(actor):null),findMany:vi.fn(async()=>[...created]),
   create:vi.fn(async({data}:any)=>{const u={id:id(74),username:data.username,fullName:data.fullName,active:true,lastLoginAt:null,roles:[{role:{code:'CASHIER',name:'Cashier'}}],
    branches:data.branches.create,emissionPoints:data.emissionPoints.create,series:data.series.create};created.push(u);return u;})},
  role:{findMany:vi.fn(async()=>[{id:cashier,code:'CASHIER',name:'Cashier',active:true}]),upsert:vi.fn()},permission:{upsert:vi.fn()},auditLog:{create:vi.fn(async()=>({}))}};
 db.$transaction=vi.fn(async(work:any)=>work(db));mock.db=db;
 return {db,actor,app,created,unlink:()=>{linked=false;},missing:()=>{missing=true;}};
}
function mount(){
 const root=mkdtempSync(join(tmpdir(),'factuez-identity-host-'));chmodSync(root,0o700);roots.push(root);
 const write=(name:string,value:Buffer|string|object)=>writeFileSync(join(root,name),Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
 const tlsRefs=(prefix:string,t:typeof tls,cert:Buffer)=>{write(prefix+'-ca.crt',t.ca);write(prefix+'-cert.crt',cert);write(prefix+'-key.key',t.key);return {ca:prefix+'-ca.crt',cert:prefix+'-cert.crt',key:prefix+'-key.key'};};
 write('b2b.key',pem);write('pepper.bin',Buffer.alloc(32,7));write('human.pem',others.human);write('integration.pem',others.integration);
 write('oidc.bin','Basic '+Buffer.from('synthetic:credential').toString('base64'));write('database.bin','synthetic-database-password');write('database-ca.pem',tls.ca);
 const resource=[fingerprint(tls.resource)],config={enabled:true,environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},
  tokenIssuer:'https://identity.synthetic.invalid/b2b',billingOrigin:`https://127.0.0.1:${billingPort}`,oidc:{issuer:`https://127.0.0.1:${oidcPort}`,introspectionEndpoint:`https://127.0.0.1:${oidcPort}/introspect`,adminClientId:'synthetic-application-admin',acceptedAcr:['urn:synthetic:mfa']},
  scopes:['b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:identity:manage'],peers:{token:resource,admin:[fingerprint(tls.edge)],resource,correctionOwner:resource,guideOwner:resource,guideIssueOwner:resource,webhook:resource,operator:[fingerprint(operator.resource)]}};
 const host={schemaVersion:'factuez.b2b.identity-host.v1',environment:'BETA',mode:'STANDALONE',workerCoordination:'GLOBAL_PHASE_BARRIER',database:{host:'synthetic-db.invalid',port:5432,user:'identity_owner',name:'identity_runtime_beta',passwordFile:'database.bin'},privileged:{clientId:client,policyRevision:'synthetic-policy-v1'}};
 const refs={signingKey:'b2b.key',pepper:'pepper.bin',humanPublicKey:'human.pem',integrationPublicKey:'integration.pem',oidcCredential:'oidc.bin',apiTls:tlsRefs('api',tls,tls.server),
  controlTls:tlsRefs('operator',operator,operator.server),billingTls:tlsRefs('billing',tls,tls.edge),oidcTls:tlsRefs('oidc',tls,tls.edge)};
 write('identity-runtime.json',{config,files:refs});write('identity-host.json',host);
 vi.stubEnv('B2B_IDENTITY_ENABLED','true');vi.stubEnv('B2B_IDENTITY_CONFIG_ROOT',root);vi.stubEnv('DATABASE_URL',undefined);
 vi.stubEnv('DB_HOST',host.database.host);vi.stubEnv('DB_PORT','5432');vi.stubEnv('DB_USER',host.database.user);vi.stubEnv('DB_NAME',host.database.name);vi.stubEnv('DB_PASSWORD_FILE',join(root,'database.bin'));
 return {root,config,host,write,refs};
}
async function start(){const f=data(),m=mount(),h=(await bootstrapB2bIdentity())!;hosts.push(h);return {...f,...m,h,port:(h.addresses.api as AddressInfo).port};}
function rpc(port:number,action:string,payload:unknown={},peer:'resource'|'edge'|'other'='resource',kind='USER'){
 const bytes=Buffer.from(JSON.stringify({kind,action,input:{binding,payload}}));
 return new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path:'/internal/b2b/owner-admin',method:'POST',ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,agent:false,
   headers:{'Content-Type':'application/json','Content-Length':bytes.length,Authorization:'Bearer '+token}},res=>{const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});});
  req.on('error',reject);req.end(bytes);
 });
}
const payload=()=>({username:'new-synthetic-cashier',fullName:'Synthetic Cashier',password:'SYNTHETIC-only-password-123',roles:['CASHIER'],branchIds:[binding.branchId],emissionPointIds:[binding.pointId],series:[binding.seriesId]});

describe('executable standalone Identity host and concrete privileged owner adapters',()=>{
 it('does nothing without the explicit flag and does not construct Prisma',async()=>{
  vi.stubEnv('B2B_IDENTITY_ENABLED',undefined);vi.stubEnv('B2B_IDENTITY_CONFIG_ROOT','MUST_NOT_READ');
  expect(await bootstrapB2bIdentity()).toBeNull();expect(await startB2bIdentityHost()).toBeNull();expect(mock.constructed).not.toHaveBeenCalled();
 });
 it('loads actual synthetic mounts, creates legitimate services and starts all six capabilities without legacy resources or seeding',async()=>{
  const f=await start();expect(mock.constructed).toHaveBeenCalledOnce();expect(f.db.$connect).toHaveBeenCalledOnce();
  expect(f.h.runtime.statusMetadata.capabilities).toHaveLength(6);expect(f.h.lifecycle.snapshot()).toEqual({mode:'STANDALONE',legacyApplication:false,producers:0,workers:0,otherOwnerListeners:0,externalWorkers:'GLOBAL_PHASE_BARRIER'});
  expect(f.h.runtime.bootId).toBe(f.h.runtime.maintenance.snapshot().instance.bootId);expect(f.db.role.upsert).not.toHaveBeenCalled();expect(f.db.permission.upsert).not.toHaveBeenCalled();
  expect(f.db.$queryRawUnsafe.mock.calls.every((c:any)=>c[0].endsWith('WHERE false'))).toBe(true);
  expect((await rpc(f.port,'USERS_LIST')).status).toBe(200);expect(network.mock.calls.some(c=>c[0]==='oidc')).toBe(true);expect(network.mock.calls.some(c=>c[0]==='billing')).toBe(true);
 });
 it('relays actual current OIDC/MFA administration to Billing with dedicated peer and explicit scope, without granting SERVICE authority',async()=>{
  const f=data(),m=mount();(m.host as any).administrationPeers={billing:[fingerprint(tls.other)],fiscal:[],mailer:[]};m.config.scopes.push('b2b:branding:manage');
  f.app.scopes.push('b2b:branding:manage');claims.scope+=' b2b:branding:manage';m.write('identity-host.json',m.host);m.write('identity-runtime.json',{config:m.config,files:m.refs});
  const h=(await bootstrapB2bIdentity())!;hosts.push(h);const port=(h.addresses.api as AddressInfo).port;
  const authority=new HttpB2bOwnerAdministration(new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.other,key:tls.key}));
  expect(await authority.readiness()).toMatchObject({owner:'billing',environment:'BETA',state:'ASSEMBLED'});
  const request={token,kind:'USER' as const,action:'PRINT_READ' as const,binding,payloadDigest:'a'.repeat(64)};
  expect(await authority.authorize(request)).toMatchObject({stepUpVerified:true,claims:{sub:subject,scope:{kind:'GLOBAL'}}});
  expect(await authority.current(subject)).toMatchObject({sub:subject,authVersion:3});
  expect(f.db.$executeRawUnsafe.mock.calls.some((c:any)=>c[0].startsWith('INSERT INTO "B2bAudit"'))).toBe(true);
  await expect(authority.authorize({...request,action:'FISCAL_READ'})).rejects.toMatchObject({status:403});
  f.app.enabled=false;await expect(authority.authorize(request)).rejects.toMatchObject({status:403});f.app.enabled=true;
  claims.amr=['pwd'];await expect(authority.authorize(request)).rejects.toMatchObject({status:403});
  const wrong=new HttpB2bOwnerAdministration(new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.resource,key:tls.key}));
  await expect(wrong.current(subject)).rejects.toMatchObject({status:403});
 });
 it('executes actual UserAdministrationService.create with current MFA, DB roles, exact Billing resources, password hashing and owner audit',async()=>{
  const f=await start(),r=await rpc(f.port,'USERS_CREATE',payload());
  expect(r.status).toBe(200);expect(r.body.data.username).toBe('new-synthetic-cashier');expect(f.db.user.create).toHaveBeenCalledOnce();expect(f.db.auditLog.create).toHaveBeenCalledOnce();
  const saved=f.db.user.create.mock.calls[0][0].data;expect(saved.passwordHash).toMatch(/^scrypt\$/);expect(saved.passwordHash).not.toContain(payload().password);expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|SYNTHETIC-only-password/);
 });
 it('revalidates queued mail actors through the private host without bearer tokens and rejects revoked permissions/links/clients',async()=>{
  const f=data(),m=mount();(m.host as any).emailWorkerPeers=[fingerprint(tls.other)];
  m.config.scopes.push('b2b:email:send','b2b:artifacts:read');f.app.scopes.push('b2b:email:send','b2b:documents:read','b2b:artifacts:read');
  f.actor.roles[0].role.permissions.push({permission:{code:'DOCUMENT_EMAIL'}});
  m.write('identity-host.json',m.host);m.write('identity-runtime.json',{config:m.config,files:m.refs});
  const h=(await bootstrapB2bIdentity())!;hosts.push(h);const port=(h.addresses.api as AddressInfo).port;
  const actor={kind:'USER' as const,clientId:f.app.id,revision:f.app.revision,subjectId:f.actor.id,userAuthRevision:f.actor.authVersion};
  const transport=new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.other,key:tls.key}),client=new HttpB2bEmailActor(transport);
  expect(await client.freshIdentity(actor,['b2b:email:send','b2b:documents:read','b2b:artifacts:read'])).toMatchObject({...actor,bindings:[binding]});
  expect(network.mock.calls.some(c=>c[0]==='oidc')).toBe(false);expect(network.mock.calls.some(c=>c[0]==='billing')).toBe(true);
  expect(f.db.$executeRawUnsafe.mock.calls.some((c:any)=>c[0].includes('INSERT INTO "B2bAudit"'))).toBe(true);
  const other=new HttpB2bEmailActor(new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.resource,key:tls.key}));
  await expect(other.freshIdentity(actor,['b2b:email:send','b2b:documents:read'])).rejects.toMatchObject({status:403});
  f.actor.roles[0].role.permissions=f.actor.roles[0].role.permissions.filter((v:any)=>v.permission.code!=='DOCUMENT_EMAIL');
  await expect(client.freshIdentity(actor,['b2b:email:send','b2b:documents:read'])).rejects.toMatchObject({status:403});
  f.actor.roles[0].role.permissions.push({permission:{code:'DOCUMENT_EMAIL'}});f.app.enabled=false;
  await expect(client.freshIdentity(actor,['b2b:email:send','b2b:documents:read'])).rejects.toMatchObject({status:403});f.app.enabled=true;
  f.unlink();await expect(client.freshIdentity(actor,['b2b:email:send','b2b:documents:read'])).rejects.toMatchObject({status:403});
 });
 it('authorizes real Billing customer/product operations through the same Identity principal and current MFA, with no default SERVICE policy',async()=>{
  const f=data(),m=mount();(m.host as any).billingPermissionPeers=[fingerprint(tls.other)];
  const extra=['b2b:customers:write','b2b:products:write'] as const;m.config.scopes.push(...extra);f.app.scopes.push(...extra);claims.scope+=' '+extra.join(' ');
  f.actor.roles[0].role.permissions.push({permission:{code:'DOCUMENT_ISSUE'}},{permission:{code:'PRODUCT_MANAGE'}});
  m.write('identity-host.json',m.host);m.write('identity-runtime.json',{config:m.config,files:m.refs});
  const h=(await bootstrapB2bIdentity())!;hosts.push(h);const origin='https://127.0.0.1:'+(h.addresses.api as AddressInfo).port;
  const identity=new B2bIdentityHttp(new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.resource,key:tls.key}));
  const permissions=new BillingHostPermissions(new BillingAuthorityHttps(origin,{ca:tls.ca,cert:tls.other,key:tls.key,serverFingerprintSha256:fingerprint(tls.server)}),{enabled:true});
  expect(await permissions.readiness()).toMatchObject({state:'ASSEMBLED'});
  const store=new MemoryBusinessStore(),core=permissions.business(store,identity,{resolve:async()=>({binding})} as any);
  const created=await core.execute({token,kind:'USER'},'CUSTOMERS_CREATE',{binding,body:customer(),idempotencyKey:randomUUID()});expect(created.data).toMatchObject({legalName:'CLIENTE SINTETICO'});expect(store.state.customers.size).toBe(1);
  expect(await core.execute({token,kind:'USER'},'PRODUCTS_CREATE',{binding,body:product(),idempotencyKey:randomUUID()})).toMatchObject({data:{sku:'SYNTHETIC-1'}});
  claims.amr=['pwd'];await expect(core.execute({token,kind:'USER'},'PRODUCTS_CREATE',{binding,body:{...product(),sku:'SYNTHETIC-2'},idempotencyKey:randomUUID()})).rejects.toBeDefined();expect(store.state.products.size).toBe(1);
  f.actor.roles[0].role.permissions=f.actor.roles[0].role.permissions.filter((p:any)=>p.permission.code!=='DOCUMENT_ISSUE');
  await expect(core.execute({token,kind:'USER'},'CUSTOMERS_CREATE',{binding,body:{...customer(),identityNumber:'00000000012'},idempotencyKey:randomUUID()})).rejects.toBeDefined();expect(store.state.customers.size).toBe(1);
  await expect(core.execute({token,kind:'SERVICE'},'CUSTOMERS_CREATE',{binding,body:customer(),idempotencyKey:randomUUID()})).rejects.toMatchObject({status:403});permissions.close();
 });
 it.each(['mfa','expired','link','role','permission','revision','client','binding','oidc','wrongClient','wrongAudience','staleMfa'])('fails closed on %s without a Users write',async defect=>{
  const f=await start();if(defect==='mfa')claims.amr=['pwd'];if(defect==='expired')claims.exp=Math.floor(Date.now()/1000)-1;if(defect==='link')f.unlink();
  if(defect==='role')f.actor.roles=[];if(defect==='permission')f.actor.roles[0].role.permissions=[];if(defect==='revision')f.actor.authVersion++;
  if(defect==='client')f.app.enabled=false;if(defect==='binding')bindingAvailable=false;if(defect==='oidc')oidcAvailable=false;
  if(defect==='wrongClient')claims.client_id='different-client';if(defect==='wrongAudience')claims.aud='factuez-b2b-admin';if(defect==='staleMfa')claims.auth_time-=301;
  const r=await rpc(f.port,'USERS_CREATE',payload());expect(r.status).not.toBe(200);expect(f.db.user.create).not.toHaveBeenCalled();
 });
 it('does not use SERVICE or a different mTLS peer as privileged human authority',async()=>{
  const f=await start();expect((await rpc(f.port,'USERS_CREATE',payload(),'resource','SERVICE')).status).toBe(403);expect((await rpc(f.port,'USERS_CREATE',payload(),'other')).status).toBe(403);
  expect(f.db.user.create).not.toHaveBeenCalled();
 });
 it('rejects resources outside the real validated binding even with a current global administrator',async()=>{
  const f=await start();expect((await rpc(f.port,'USERS_CREATE',{...payload(),branchIds:[id(85)]})).status).not.toBe(200);expect(f.db.user.create).not.toHaveBeenCalled();
 });
 it('blocks bad/missing host configuration and DB environment before any Prisma construction; no legacy fallback',async()=>{
  data();const m=mount();vi.stubEnv('DATABASE_URL','postgresql://synthetic.invalid/other');await expect(bootstrapB2bIdentity()).rejects.toThrow('STARTUP_BLOCKED');expect(mock.constructed).not.toHaveBeenCalled();
  vi.stubEnv('DATABASE_URL',undefined);m.write('identity-host.json',{...m.host,environment:'PRODUCTION'});await expect(bootstrapB2bIdentity()).rejects.toThrow('STARTUP_BLOCKED');expect(mock.constructed).not.toHaveBeenCalled();
 });
 it('disconnects a failed schema startup without seeding or opening the legacy owner',async()=>{
  const f=data();mount();f.missing();await expect(bootstrapB2bIdentity()).rejects.toThrow('STARTUP_BLOCKED');expect(f.db.$disconnect).toHaveBeenCalledOnce();expect(f.db.role.upsert).not.toHaveBeenCalled();
 });
 it('stops through actual ordered maintenance phases, keeps boot identity and closes owned storage once',async()=>{
  const f=await start();await f.h.shutdown();expect(f.h.runtime.maintenance.snapshot()).toMatchObject({state:'PARKED',storageClosed:true});expect(f.db.$disconnect).toHaveBeenCalledOnce();await f.h.shutdown();expect(f.db.$disconnect).toHaveBeenCalledOnce();
 });
 it('validates standalone/global-barrier mode and approved BETA database mount names',()=>{
  const m=mount();for(const change of [{...m.host,mode:'WITH_LEGACY'},{...m.host,workerCoordination:'LOCAL_ONLY'},{...m.host,database:{...m.host.database,name:'identity_prod'}},{...m.host,database:{...m.host.database,passwordFile:'../db.bin'}}])expect(()=>b2bIdentityHostConfig(change)).toThrow();
  expect(()=>checkB2bIdentityDatabaseEnvironment(b2bIdentityHostConfig(m.host),m.root,{DB_HOST:'other'})).toThrow();
 });
});
