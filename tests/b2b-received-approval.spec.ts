import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {inspect} from 'node:util';
import {randomUUID} from 'node:crypto';
import {NestFactory} from '../services/identity-service/node_modules/@nestjs/core';
import {createReceivedApprovalServer} from '../services/identity-service/src/b2b/received-approval';
import {ReceivedApprovalModule} from '../services/identity-service/src/b2b/received-approval-http';
import {ReceivedApprovalAuthority} from '../services/identity-service/src/b2b/received-approval-core';
import {UserPermissionsService} from '../services/identity-service/src/application/user-permissions.service';
import {HttpsOidcIntrospection} from '../services/identity-service/src/b2b/oidc';
import {B2bPrivateHttp,B2bBindingCatalogueHttp} from '../packages/service-access/src/b2b';
import {B2bReceivedStepUpHttp} from '../services/received-documents-service/src/b2b/runtime-authority';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {binding,id} from './b2b-identity.fixture';
import {B2bAudience} from '../packages/contracts/src/b2b';
let tls:ReturnType<typeof b2bCertificates>,oidc:Server,billing:Server,oidcPort:number,billingPort:number,claims:any,billingValid=true,providerDown=false;
const token='SYNTHETIC-RECEIVED-APPROVAL-OIDC-0001',adminId=id(91),humanClient=id(92),targetClient=id(93),oidcClient='received-operator';
const scope={environment:'BETA' as const,companyId:binding.issuerId,recipientRuc:binding.issuerRuc,branchId:binding.branchId};
const apps:any[]=[];let cleanup:(()=>Promise<void>)[]=[];
beforeAll(async()=>{
 tls=b2bCertificates();const opts={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
 oidc=createServer(opts,async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));res.setHeader('Content-Type','application/json');
  if(providerDown){res.statusCode=503;res.end('{}');return;}
  const t=new URLSearchParams(Buffer.concat(chunks).toString()).get('token');res.end(JSON.stringify(t===token?claims:{active:false}));});
 billing=createServer(opts,async(req,res)=>{const chunks:Buffer[]=[];for await(const b of req)chunks.push(Buffer.from(b));const body=JSON.parse(Buffer.concat(chunks).toString());
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({valid:billingValid&&req.url==='/internal/b2b/validate-bindings'&&body.bindings.every((b:any)=>hash(b)===hash(binding))}));});
 await new Promise<void>(r=>oidc.listen(0,'127.0.0.1',r));await new Promise<void>(r=>billing.listen(0,'127.0.0.1',r));
 oidcPort=(oidc.address() as AddressInfo).port;billingPort=(billing.address() as AddressInfo).port;
},30000);
beforeEach(()=>{const now=Math.floor(Date.now()/1000);claims={active:true,token_type:'Bearer',iss:`https://127.0.0.1:${oidcPort}`,sub:'received-subject',client_id:oidcClient,aud:B2bAudience,
 iat:now-10,exp:now+280,auth_time:now-20,amr:['pwd','mfa'],acr:'urn:received:mfa',scope:'openid b2b:received:configure b2b:received:sync'};billingValid=true;providerDown=false;});
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const f of cleanup.splice(0))await f();vi.restoreAllMocks();});
afterAll(async()=>{await new Promise<void>(r=>oidc.close(()=>r()));await new Promise<void>(r=>billing.close(()=>r()));});
function database(){
 let approvals=new Map<string,any>(),audits:any[][]=[],failAudit=false,failCommit=false,linked=true;let tail=Promise.resolve();
 const user:any={id:adminId,username:'synthetic-admin',fullName:'Synthetic Admin',active:true,authVersion:3,roles:[{role:{code:'ADMIN',active:true,permissions:[{permission:{code:'SETUP_MANAGE'}}]}}],branches:[],emissionPoints:[],series:[]};
 const human:any={id:humanClient,label:'Received operator',kind:'USER',oidcClientId:oidcClient,enabled:true,revision:1,secretHash:null,scopes:['b2b:received:configure','b2b:received:sync'],bindings:[structuredClone(binding)]};
 const target:any={id:targetClient,label:'Received target',kind:'SERVICE',oidcClientId:null,enabled:true,revision:2,secretHash:'a'.repeat(64),scopes:['b2b:received:read','b2b:received:artifacts:read','b2b:received:sync'],bindings:[structuredClone(binding)]};
 const targetUser:any={id:id(95),username:'received-reader',active:true,authVersion:2,roles:[{role:{code:'CASHIER',active:true,permissions:[{permission:{code:'DOCUMENT_VIEW'}},{permission:{code:'REPORT_VIEW'}}]}}],branches:[{branchId:binding.branchId}],emissionPoints:[{emissionPointId:binding.pointId}],series:[{series:binding.seriesId}]};
 const clients=new Map([[humanClient,human],[targetClient,target]]);
 const query=async(sql:string,v:any[],rows=approvals):Promise<any[]>=>{
  if(sql.endsWith('WHERE false'))return [];
  if(sql.includes('FROM "B2bClient"'))return clients.has(v[0])?[structuredClone(clients.get(v[0]))]:[];
  if(sql.startsWith('SELECT EXISTS'))return [{ok:target.kind==='USER'&&v[0]===target.id&&v[1]===target.revision&&v[2]===targetUser.id&&v[3]===targetUser.authVersion}];
  if(sql.includes('FROM "B2bUserLink"'))return linked&&v[1]==='received-subject'&&v[2]===oidcClient?[{clientId:humanClient,clientRevision:1,userId:adminId,userAuthRevision:3,enabled:true}]:[];
  if(sql.includes('FROM "B2bReceivedApproval"')){const a=rows.get(v[0]);return a?[{approval:structuredClone(a),expiresAt:a.expiresAt}]:[];}
  throw Error('UNEXPECTED_SYNTHETIC_QUERY');
 };
 const db:any={$queryRawUnsafe:vi.fn((sql:string,...v:any[])=>query(sql,v)),$queryRaw:vi.fn(async(strings:TemplateStringsArray)=>strings.join('').includes('to_regclass')?[{ready:true}]:[]),
  user:{findUnique:vi.fn(async({where}:any)=>where.id===adminId?structuredClone(user):where.id===targetUser.id?structuredClone(targetUser):null)}};
 db.$transaction=vi.fn((work:any)=>{
  const run=tail.then(async()=>{const next=structuredClone(approvals),audit=structuredClone(audits);
   const sql={$queryRawUnsafe:async(s:string,...v:any[])=>query(s,v,next),$executeRawUnsafe:async(s:string,...v:any[])=>{
    if(s.startsWith('INSERT INTO "B2bReceivedApproval"')){if(next.has(v[0]))throw Error('Duplicate nonce');next.set(v[0],JSON.parse(v[1]));return 1;}
    if(s.startsWith('INSERT INTO "B2bAudit"')){if(failAudit)throw Error('PRIVATE_AUDIT_FAILURE');audit.push(v);return 1;}throw Error('UNEXPECTED_SYNTHETIC_WRITE');}};
   const result=await work(sql);if(failCommit)throw Error('PRIVATE_COMMIT_FAILURE');approvals=next;audits=audit;return result;
  });tail=run.then(()=>undefined,()=>undefined);return run;
 });
 return {db,user,human,target,targetUser,clients,rows:()=>approvals,audits:()=>audits,failAudit:(v=true)=>{failAudit=v;},failCommit:(v=true)=>{failCommit=v;},unlink:()=>{linked=false;}};
}
async function fixture(){
 const f=database(),transport={ca:tls.ca,cert:tls.edge,key:tls.key},provider=new HttpsOidcIntrospection(`https://127.0.0.1:${oidcPort}/introspect`,'Basic '+Buffer.from('synthetic:credential').toString('base64'),transport);
 const configuration={enabled:true,db:f.db,permissions:new UserPermissionsService(f.db),catalogue:new B2bBindingCatalogueHttp(new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`,transport)),
  provider,issuer:`https://127.0.0.1:${oidcPort}`,clientId:oidcClient,acceptedAcr:['urn:received:mfa'],peers:{prepare:[fingerprint(tls.edge)],verify:[fingerprint(tls.resource)]}};
 const server=createReceivedApprovalServer(configuration)!;
 await server.store.ready();const app=await NestFactory.create(server.module,{logger:false,bodyParser:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
 app.useBodyParser('json',{limit:'32kb'});await app.listen(0,'127.0.0.1');apps.push(app);const port=(app.getHttpServer().address() as AddressInfo).port;
 const client=new B2bReceivedStepUpHttp({endpoint:`https://127.0.0.1:${port}/internal/b2b/received-stepup/verify`,serverFingerprintSha256:fingerprint(tls.server)},{ca:tls.ca,cert:tls.resource,key:tls.key});
 return {...f,...server,port,client,configuration};
}
function post(port:number,path:string,body:unknown,peer:'edge'|'resource'|'other'|null,authorization?:string){const bytes=Buffer.from(JSON.stringify(body));return new Promise<{status:number;body:any}>((resolve,reject)=>{
 const req=request({hostname:'127.0.0.1',port,path,method:'POST',ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),rejectUnauthorized:true,agent:false,
  headers:{'Content-Type':'application/json','Content-Length':bytes.length,...(authorization?{Authorization:authorization}:{})}},res=>{const b:Buffer[]=[];res.on('data',v=>b.push(v));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(b).toString())});}catch(e){reject(e);}});});req.on('error',reject);req.end(bytes);
 });}
const grant=()=>({schemaVersion:'factuez.b2b.received-approval-prepare.v1',purpose:'GRANT',policy:{scope,subject:{kind:'SERVICE',clientId:targetClient,subjectId:null},permission:'READ',clientRevision:2,userAuthRevision:null,active:true},expectedRevision:0});
const automation=()=>({schemaVersion:'factuez.b2b.received-approval-prepare.v1',purpose:'AUTOMATION',action:'CONFIG_READ',scope,requestSha256:'b'.repeat(64)});
const prepare=(f:Awaited<ReturnType<typeof fixture>>,body:unknown)=>post(f.port,'/internal/b2b/received-stepup/prepare',body,'edge','Bearer '+token);
const verifyBody=(p:any)=>({schemaVersion:'factuez.b2b.received-stepup-request.v1',purpose:p.purpose,handle:p.handle,requestSha256:p.requestSha256});

describe('durable received approvals: actual private Nest/mTLS server interoperates with existing ReceivedStepUpHttp',()=>{
 it('is disabled by default and installs no private route until explicitly enabled',()=>{
  expect(createReceivedApprovalServer()).toBeNull();expect(createReceivedApprovalServer({enabled:false} as any)).toBeNull();
  expect(ReceivedApprovalModule.isolated({} as any).controllers).toBeUndefined();
  const core=new ReceivedApprovalAuthority({acceptedAcr:[]} as any);expect(core.prepare(token,grant(),{} as any)).rejects.toMatchObject({status:503});
 });
 it('prepares a contextual GRANT, persists only hashes/metadata and interoperates repeatedly without consuming the handle',async()=>{
  const f=await fixture(),g=grant(),r=await prepare(f,g);expect(r.status).toBe(200);expect(r.body.requestSha256).toBe(hash({policy:g.policy,expectedRevision:0}));
  expect(f.rows().size).toBe(1);expect(f.audits()).toHaveLength(1);
  for(let i=0;i<3;i++)expect(await f.client.grantAdministrator.authorize(r.body.handle,r.body.requestSha256)).toEqual({adminId,authRevision:3,policySha256:r.body.requestSha256});
  expect(f.audits()).toHaveLength(4);expect(new Set(f.audits().map(a=>a[1]))).toEqual(new Set([[...f.rows().values()][0].approvalId]));const persisted=JSON.stringify([...f.rows().values(),f.audits()]);
  expect(persisted).not.toContain(token);expect(persisted).not.toContain(r.body.handle);const nonce=JSON.parse(Buffer.from(r.body.handle,'base64url').toString()).nonce;expect(persisted).not.toContain(nonce);
  expect(inspect(f.core,{showHidden:true})).not.toContain(token);expect(inspect(f.core)).toContain('PRIVATE');
 });

 it('verifies an existing durable approval with a fresh server instance and no in-memory nonce cache',async()=>{
  const f=await fixture(),p=(await prepare(f,grant())).body;
  const fresh=createReceivedApprovalServer(f.configuration)!;await fresh.store.ready();
  const result=await fresh.core.verify(verifyBody(p),{requestId:randomUUID(),peer:fingerprint(tls.resource)});
  expect(result.requestSha256).toBe(p.requestSha256);expect(f.audits()).toHaveLength(2);
 });
 it('checks an enrolled USER target and its current userAuthRevision, not just the administrator',async()=>{
  const f=await fixture();f.target.kind='USER';f.target.oidcClientId='received-reader';
  const g=grant(),p=(await prepare(f,{...g,policy:{...g.policy,subject:{kind:'USER',clientId:targetClient,subjectId:f.targetUser.id},userAuthRevision:2}})).body;
  expect(await f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).toMatchObject({adminId});
  f.targetUser.authVersion++;await expect(f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).rejects.toThrow();
 });
 it('bounds handle size before the first durable write and rejects unapproved context fields',async()=>{
  const f=await fixture();await expect(f.core.prepare('x'.repeat(6200),grant(),{requestId:randomUUID(),peer:'synthetic'})).rejects.toThrow();
  expect(f.db.$transaction).not.toHaveBeenCalled();
  expect((await prepare(f,{...grant(),policy:{...grant().policy,credentials:{password:'SYNTHETIC-CANARY'}}})).status).toBe(403);expect(f.rows().size).toBe(0);
 });
 it('returns the exact requestBindingSha256 hash(body) and a proof no longer than the original 30-second approval',async()=>{
  const f=await fixture(),p=(await prepare(f,grant())).body,body=verifyBody(p),r=await post(f.port,'/internal/b2b/received-stepup/verify',body,'resource');
  expect(r.status).toBe(200);expect(r.body).toMatchObject({schemaVersion:'factuez.b2b.received-stepup-proof.v1',authority:'GLOBAL_ADMIN',permission:'setup.manage',requestBindingSha256:hash(body)});
  expect(Date.parse(r.body.expiresAt)).toBeLessThanOrEqual(Date.parse(p.expiresAt));expect(Date.parse(r.body.expiresAt)).toBeLessThanOrEqual(Date.now()+30000);
 });
 it('binds automation to the exact human client/revision, action and received tuple through the existing client',async()=>{
  const f=await fixture(),p=(await prepare(f,automation())).body,principal:any={kind:'USER',clientId:humanClient,subjectId:adminId,userAuthRevision:3};
  expect(await f.client.userAdministrator.authorize(principal,scope,'CONFIG_READ',p.handle,p.requestSha256)).toMatchObject({adminId,authRevision:3,scope,requestSha256:p.requestSha256,authority:'GLOBAL_ADMIN'});
  for(const [actor,s,a] of [[{...principal,userAuthRevision:4},scope,'CONFIG_READ'],[{...principal,clientId:targetClient},scope,'CONFIG_READ'],[principal,{...scope,branchId:id(94)},'CONFIG_READ'],[principal,scope,'CONFIG_SAVE']])
   await expect(f.client.userAdministrator.authorize(actor as any,s as any,a as any,p.handle,p.requestSha256)).rejects.toThrow();
 });
 it('rejects an arbitrary GRANT hash, missing policy, changed policy revision and purpose substitution',async()=>{
  const f=await fixture();expect((await prepare(f,{schemaVersion:grant().schemaVersion,purpose:'GRANT',scope,requestSha256:'a'.repeat(64)})).status).toBe(403);
  const p=(await prepare(f,grant())).body;await expect(f.client.grantAdministrator.authorize(p.handle,'a'.repeat(64))).rejects.toThrow();
  const b=verifyBody(p);expect((await post(f.port,'/internal/b2b/received-stepup/verify',{...b,purpose:'AUTOMATION',actor:{clientId:humanClient,subjectId:adminId,authRevision:3},scope,action:'CONFIG_READ'},'resource')).status).toBe(403);
  await expect(f.client.grantAdministrator.authorize(p.handle,hash({policy:grant().policy,expectedRevision:1}))).rejects.toThrow();
 });
 it.each(['mfa','role','permission','user-revision','human-revision','target-revision','target-disabled','target-scope','binding','link','idp','audience'])('revalidates %s after preparation with no proof or new audit',async defect=>{
  const f=await fixture(),p=(await prepare(f,grant())).body,before=f.audits().length;
  if(defect==='mfa')claims.amr=['pwd'];if(defect==='role')f.user.roles=[];if(defect==='permission')f.user.roles[0].role.permissions=[];
  if(defect==='user-revision')f.user.authVersion++;if(defect==='human-revision')f.human.revision++;if(defect==='target-revision')f.target.revision++;
  if(defect==='target-disabled')f.target.enabled=false;if(defect==='target-scope')f.target.scopes=[];if(defect==='binding')billingValid=false;if(defect==='link')f.unlink();if(defect==='idp')providerDown=true;if(defect==='audience')claims.aud='wrong';
  await expect(f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).rejects.toThrow();expect(f.audits()).toHaveLength(before);
 });

 it.each(['prepare','verify'])('detects user revocation during the final IdP round trip of %s',async phase=>{
  const f=await fixture(),p=phase==='verify'?(await prepare(f,grant())).body:null,before=f.audits().length;
  const actual=f.configuration.provider.introspect.bind(f.configuration.provider);let calls=0;
  vi.spyOn(f.configuration.provider,'introspect').mockImplementation(async t=>{const r=await actual(t);if(++calls===2)f.user.active=false;return r;});
  if(phase==='prepare'){expect((await prepare(f,grant())).status).toBe(403);expect(f.rows().size).toBe(0);}
  else await expect(f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).rejects.toThrow();
  expect(f.audits()).toHaveLength(before);
 });
 it('rejects unbound company/RUC/branch and target contexts before persisting preparation',async()=>{
  const f=await fixture();for(const s of [{...scope,companyId:2},{...scope,recipientRuc:'00000000002'},{...scope,branchId:id(94)}])expect((await prepare(f,{...grant(),policy:{...grant().policy,scope:s}})).status).toBe(403);
  expect(f.rows().size).toBe(0);expect(f.audits()).toHaveLength(0);
 });
 it('allows contextual automation-grant enrollment, without passing a hash-only GRANT',async()=>{
  const f=await fixture(),g=grant(),{permission,...policy}=g.policy,p=(await prepare(f,{...g,policy:{...policy,action:'SYNC_CREATE'}})).body;
  expect(await f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).toMatchObject({adminId,policySha256:p.requestSha256});
 });
 it.each(['audit','commit'])('rolls back preparation and refuses proof on %s failure',async failure=>{
  const f=await fixture();if(failure==='audit')f.failAudit();else f.failCommit();const failed=await prepare(f,grant());expect(failed.status).toBe(503);expect(f.rows().size).toBe(0);expect(f.audits()).toHaveLength(0);
  f.failAudit(false);f.failCommit(false);const p=(await prepare(f,grant())).body,before=f.audits().length;if(failure==='audit')f.failAudit();else f.failCommit();
  await expect(f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).rejects.toThrow();expect(f.audits()).toHaveLength(before);expect(f.rows().size).toBe(1);
 });
 it('rejects expiry, forged nonce, replaced OIDC token, unknown fields and oversized handles',async()=>{
  const f=await fixture(),p=(await prepare(f,grant())).body,b=verifyBody(p),h=JSON.parse(Buffer.from(p.handle,'base64url').toString());
  for(const v of [{...b,handle:Buffer.from(JSON.stringify({...h,nonce:'A'.repeat(43)})).toString('base64url')},{...b,handle:Buffer.from(JSON.stringify({...h,tokenOIDC:'synthetic-replaced-token-0001'})).toString('base64url')},{...b,approved:true},{...b,handle:'A'.repeat(8193)}])expect((await post(f.port,'/internal/b2b/received-stepup/verify',v,'resource')).status).toBe(403);
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+31000);await expect(f.client.grantAdministrator.authorize(p.handle,p.requestSha256)).rejects.toThrow();
 });
 it('requires separate approved mTLS peers and bearer only for preparation',async()=>{
  const f=await fixture();await expect(post(f.port,'/internal/b2b/received-stepup/prepare',grant(),null,'Bearer '+token)).rejects.toThrow();
  expect((await post(f.port,'/internal/b2b/received-stepup/prepare',grant(),'resource','Bearer '+token)).status).toBe(403);
  expect((await post(f.port,'/internal/b2b/received-stepup/prepare',grant(),'edge')).status).toBe(403);
  const p=(await prepare(f,grant())).body;expect((await post(f.port,'/internal/b2b/received-stepup/verify',verifyBody(p),'edge')).status).toBe(403);
  expect((await post(f.port,'/internal/b2b/received-stepup/verify',verifyBody(p),'resource','Bearer '+token)).status).toBe(403);
 });
});
