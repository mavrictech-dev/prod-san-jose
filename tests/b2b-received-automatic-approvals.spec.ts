import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {createServer,request,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {inspect} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
import {NestFactory} from '../services/identity-service/node_modules/@nestjs/core';
import {createReceivedApprovalServer} from '../services/identity-service/src/b2b/received-approval';
import {UserPermissionsService} from '../services/identity-service/src/application/user-permissions.service';
import {HttpsOidcIntrospection} from '../services/identity-service/src/b2b/oidc';
import {B2bPrivateHttp,B2bBindingCatalogueHttp} from '../packages/service-access/src/b2b';
import {B2bReceivedStepUpHttp} from '../services/received-documents-service/src/b2b/runtime-authority';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {binding,id,pem,others} from './b2b-identity.fixture';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {B2bIdentity} from '../services/identity-service/src/b2b/service';
import {B2bTokenCodec} from '../services/identity-service/src/b2b/token';
import {PostgresB2bStore} from '../services/identity-service/src/b2b/postgres-store';
import {PostgresLinkedUsers} from '../services/identity-service/src/b2b/users';
import {OidcB2bAdministrator,PostgresOidcAdminDirectory} from '../services/identity-service/src/b2b/oidc-admin';
import {OidcDelegationVerifier} from '../services/identity-service/src/b2b/oidc';
import {B2bIdentityHttp} from '../packages/service-access/src/b2b';
import {B2bReceptionAutomation,createReceptionAutomationVault} from '../services/received-documents-service/src/b2b/automation';
import {PostgresReceptionAutomationAuthority} from '../services/received-documents-service/src/b2b/automation-authority';
import {B2bReceptionAutomationOwnerModule} from '../services/received-documents-service/src/b2b/automation-http';
import {B2bReceivedAutomation,B2bReceivedAutomationModule,HttpReceptionAutomation} from '../services/b2b-api-service/src/received-automation';
import {b2bApiRuntimeConfig} from '../services/b2b-api-service/src/runtime-config';
import {b2bRuntimeOwners} from '../services/b2b-api-service/src/runtime-assembly';
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
afterEach(async()=>{for(const app of apps.splice(0).reverse())await app.close();for(const f of cleanup.splice(0))await f();vi.restoreAllMocks();});
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
  if(sql.startsWith('INSERT INTO \"B2bRateBucket\"'))return [{count:1}];
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

async function fixture(automatic=true){
 const realNow=Date.now.bind(Date);let offset=0;vi.spyOn(Date,'now').mockImplementation(()=>realNow()+offset);
 const f=database(),transport={ca:tls.ca,cert:tls.edge,key:tls.key},issuer=`https://127.0.0.1:${oidcPort}`;
 const provider=new HttpsOidcIntrospection(issuer+'/introspect','Basic '+Buffer.from('synthetic:credential').toString('base64'),transport);
 const permissions=new UserPermissionsService(f.db),catalogue=new B2bBindingCatalogueHttp(new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`,transport));
 const server=createReceivedApprovalServer({enabled:true,db:f.db,permissions,catalogue,provider,issuer,clientId:oidcClient,acceptedAcr:['urn:received:mfa'],peers:{prepare:[fingerprint(tls.edge)],verify:[fingerprint(tls.resource)]}})!;
 const core=new B2bIdentity(new PostgresB2bStore(f.db),new B2bTokenCodec(pem,'https://identity.synthetic.invalid',()=>Math.floor(Date.now()/1000),others),randomBytes(32),
  new OidcB2bAdministrator({enabled:true,issuer,clientId:'application-admin',acceptedAcr:['urn:received:mfa'],provider,directory:new PostgresOidcAdminDirectory(f.db,permissions)}),
  catalogue,new OidcDelegationVerifier(issuer,provider,new PostgresLinkedUsers(f.db,permissions)),Date.now,f.human.scopes);
 const identity=await createB2bIdentityApplication(core,{token:[fingerprint(tls.edge)],admin:[fingerprint(tls.other)],resource:[fingerprint(tls.resource)]},{ca:tls.ca,cert:tls.server,key:tls.key},server.module);
 const counts={prepare:0,verify:0};identity.use((req:any,_res:any,next:any)=>{if(req.url.endsWith('/prepare'))counts.prepare++;if(req.url.endsWith('/verify'))counts.verify++;next();});
 await identity.listen(0,'127.0.0.1');apps.push(identity);const identityPort=(identity.getHttpServer().address() as AddressInfo).port;
 const endpoints={endpoint:`https://127.0.0.1:${identityPort}/internal/b2b/received-stepup/verify`,serverFingerprintSha256:fingerprint(tls.server),prepareEndpoint:`https://127.0.0.1:${identityPort}/internal/b2b/received-stepup/prepare`};
 const client=new B2bReceivedStepUpHttp(endpoints,{ca:tls.ca,cert:tls.resource,key:tls.key},transport);cleanup.push(async()=>client.dispose());
 const identityHttp=new B2bIdentityHttp(new B2bPrivateHttp(`https://127.0.0.1:${identityPort}`,{ca:tls.ca,cert:tls.resource,key:tls.key}));
 const principal:any={kind:'USER',clientId:humanClient,subjectId:adminId,userAuthRevision:3,revision:1,environment:'BETA',scopes:f.human.scopes,bindings:[binding]};
 const policy={scope,subject:{kind:'USER',clientId:humanClient,subjectId:adminId},action:'CONFIG_READ',clientRevision:1,userAuthRevision:3,active:true,revision:1};
 let afterAudit=()=>{};const ownerAudits:any[][]=[];
 // Only PG is replaced. All authorization, transaction callbacks, vault, HTTP and user policies are real.
 const receivedDb:any={$transaction:async(work:any)=>{const pending:any[][]=[];
  const tx={$queryRawUnsafe:async(sql:string)=>{if(sql.includes('pg_advisory_xact_lock'))return [{locked:1}];if(sql.includes('FROM "B2bReceivedAutomationGrant"'))return [{policyId:id(96),policy:structuredClone(policy),revision:1}];if(sql.includes('FROM "ReceptionConnection"'))return [];throw Error('UNEXPECTED_RECEIVED_QUERY');},
   $executeRawUnsafe:async(sql:string,...v:any[])=>{if(!sql.startsWith('INSERT INTO "B2bReceivedAutomationAudit"'))throw Error('UNEXPECTED_RECEIVED_WRITE');pending.push(v);afterAudit();return 1;}};
  const result=await work(tx);ownerAudits.push(...pending);return result;}};
 const vault=createReceptionAutomationVault(randomBytes(32));
 const owner=new B2bReceptionAutomation(receivedDb,identityHttp,new PostgresReceptionAutomationAuthority(receivedDb),{networkProfile:'LOCAL_ONLY',vault,userAdministrator:client.userAdministrator});
 const httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
 const ownerApp=await NestFactory.create(B2bReceptionAutomationOwnerModule.isolated(owner,[fingerprint(tls.resource)]),{logger:false,httpsOptions});await ownerApp.listen(0,'127.0.0.1');apps.push(ownerApp);
 const facade=new B2bReceivedAutomation(identityHttp,new HttpReceptionAutomation(new B2bPrivateHttp(`https://127.0.0.1:${(ownerApp.getHttpServer().address() as AddressInfo).port}`,{ca:tls.ca,cert:tls.resource,key:tls.key})),{automaticReceivedApprovals:automatic});
 const facadeApp=await NestFactory.create(B2bReceivedAutomationModule.isolated(facade,[fingerprint(tls.other)]),{logger:false,httpsOptions});await facadeApp.listen(0,'127.0.0.1');apps.push(facadeApp);
 return {...f,...server,provider,principal,vault,facade,client,endpoints,counts,identityPort,port:(facadeApp.getHttpServer().address() as AddressInfo).port,ownerAudits,afterAudit:(fn:()=>void)=>{afterAudit=fn;},advance:(ms:number)=>{offset+=ms;}};
}
function send(port:number,path:string,body:unknown,peer:'edge'|'resource'|'other',headers:Record<string,string>={},method='POST'){
 const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));return new Promise<{status:number;body:any}>((resolve,reject)=>{
 const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,agent:false,
  headers:{...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{const b:Buffer[]=[];res.on('data',v=>b.push(v));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(b).toString())});}catch(e){reject(e);}});});req.on('error',reject);req.end(bytes);});
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const read=(f:Fixture,handle?:string)=>send(f.port,`/b2b/v1/admin/received-connectors/1?environment=BETA&companyId=1&recipientRuc=${scope.recipientRuc}&branchId=${scope.branchId}`,undefined,'other',{Authorization:'Bearer '+token,'X-Factuez-Actor-Kind':'USER',...(handle?{'X-Factuez-Step-Up':handle}:{})},'GET');
const authorize=(f:Fixture,digest='b'.repeat(64),action:any='CONFIG_READ',principal=f.principal)=>f.client.userAdministrator.authorize(principal,scope,action,'oidc-stepup.'+token,digest);
const manual=(f:Fixture,digest:string)=>send(f.identityPort,'/internal/b2b/received-stepup/prepare',{schemaVersion:'factuez.b2b.received-approval-prepare.v1',purpose:'AUTOMATION',action:'CONFIG_READ',scope,requestSha256:digest},'edge',{Authorization:'Bearer '+token});

describe('opt-in USER automatic approval: actual facade/Received/Identity mTLS with explicit fake PG',()=>{
 it('needs no client HMAC, deduplicates preparation and freshly verifies repeatedly per owner request',async()=>{
  const f=await fixture();expect(await read(f)).toMatchObject({status:200});const verified=f.counts.verify;expect(verified).toBeGreaterThanOrEqual(2);
  expect(await read(f)).toMatchObject({status:200});expect(f.counts).toEqual({prepare:1,verify:verified*2});expect(f.rows().size).toBe(1);expect(f.ownerAudits).toHaveLength(2);
  const semantic=hash({action:'CONFIG_READ',scope,payload:{}}),digest=await f.vault.fingerprint!(semantic);
  expect([...f.rows().values()][0].context.requestSha256).toBe(digest);expect(digest).not.toBe(semantic);
  const persisted=JSON.stringify([[...f.rows().values()],f.audits(),f.ownerAudits]);expect(persisted).not.toContain(token);expect(persisted).not.toContain('oidc-stepup.');
  expect(inspect(f.client,{showHidden:true})).toContain('PRIVATE');expect(inspect(f.client,{showHidden:true})+JSON.stringify(f.client)).not.toContain(token);
 });
 it('keeps default disabled, manual handles valid, and rejects caller-supplied private markers',async()=>{
  const f=await fixture(false);expect((await read(f)).status).toBe(400);expect(f.counts.prepare).toBe(0);
  const digest=await f.vault.fingerprint!(hash({action:'CONFIG_READ',scope,payload:{}})),p=await manual(f,digest);expect(p.status).toBe(200);
  expect((await read(f,p.body.handle)).status).toBe(200);expect((await read(f,'oidc-stepup.'+token)).status).toBe(403);expect(f.counts.prepare).toBe(1);
 });
 it('deduplicates pending preparation but never verification',async()=>{
  const f=await fixture();await Promise.all([authorize(f),authorize(f),authorize(f)]);expect(f.counts).toEqual({prepare:1,verify:3});
 });
 it('evicts a failed shared preparation and retries without persisting a token or failed approval',async()=>{
  const f=await fixture();f.failAudit();const results=await Promise.allSettled([authorize(f),authorize(f)]);
  expect(results.map(r=>r.status)).toEqual(['rejected','rejected']);expect(f.counts).toEqual({prepare:1,verify:0});expect(f.rows().size).toBe(0);
  f.failAudit(false);await authorize(f);expect(f.counts).toEqual({prepare:2,verify:1});expect(f.rows().size).toBe(1);expect(JSON.stringify([...f.rows().values()])).not.toContain(token);
 });
 it('separates action/digest and expires cached approvals within thirty seconds',async()=>{
  const f=await fixture();await authorize(f);await authorize(f,'c'.repeat(64));await authorize(f,'b'.repeat(64),'CONFIG_SAVE');expect(f.counts.prepare).toBe(3);
  f.advance(31000);await authorize(f);expect(f.counts.prepare).toBe(4);
 });
 it.each(['user','mfa','client','link','idp'])('denies warm-cache %s revocation and removes failed entries',async defect=>{
  const f=await fixture();await authorize(f);if(defect==='user')f.user.active=false;if(defect==='mfa')claims.amr=['pwd'];if(defect==='client')f.human.enabled=false;if(defect==='link')f.unlink();if(defect==='idp')providerDown=true;
  await expect(authorize(f)).rejects.toMatchObject({status:403});expect(f.counts.prepare).toBe(1);
  f.user.active=true;claims.amr=['pwd','mfa'];f.human.enabled=true;providerDown=false;
  if(defect!=='link'){await authorize(f);expect(f.counts.prepare).toBe(2);}
 });
 it('detects user revocation during the final IdP verification round trip',async()=>{
  const f=await fixture();await authorize(f);const actual=f.provider.introspect.bind(f.provider);let calls=0;
  vi.spyOn(f.provider,'introspect').mockImplementation(async t=>{const r=await actual(t);if(++calls===2)f.user.active=false;return r;});
  await expect(authorize(f)).rejects.toMatchObject({status:403});expect(f.counts.prepare).toBe(1);
 });
 it('rolls back owner audit when revocation happens before the final owner check',async()=>{
  const f=await fixture();f.afterAudit(()=>{f.user.active=false;});expect((await read(f)).status).toBe(401);expect(f.ownerAudits).toHaveLength(0);
 });
 it('never auto-prepares GRANT or authorizes a SERVICE as USER',async()=>{
  const f=await fixture();await expect(f.client.grantAdministrator.authorize('oidc-stepup.'+token,'b'.repeat(64))).rejects.toMatchObject({status:403});
  await expect(authorize(f,undefined,undefined,{...f.principal,kind:'SERVICE',subjectId:null,userAuthRevision:null})).rejects.toMatchObject({status:403});expect(f.counts.prepare).toBe(0);
 });
 it('bounds cache to 32 entries and denies subsequent work after dispose',async()=>{
  const f=await fixture();for(let i=0;i<32;i++)await authorize(f,i.toString(16).padStart(64,'0'));
  await expect(authorize(f,'f'.repeat(64))).rejects.toThrow();expect(f.counts.prepare).toBe(32);f.client.dispose();await expect(authorize(f)).rejects.toThrow();
 },30000);
 it('requires fixed same-origin prepare endpoint and separate explicit TLS credentials',async()=>{
  const f=await fixture(),verifyTls={ca:tls.ca,cert:tls.resource,key:tls.key},prepareTls={ca:tls.ca,cert:tls.edge,key:tls.key};
  expect(()=>new B2bReceivedStepUpHttp(f.endpoints,verifyTls)).toThrow();expect(()=>new B2bReceivedStepUpHttp(f.endpoints,verifyTls,verifyTls)).toThrow();
  for(const url of ['https://other.synthetic.invalid/internal/b2b/received-stepup/prepare',f.endpoints.prepareEndpoint+'?caller=admin',f.endpoints.prepareEndpoint.replace('https:','http:')])expect(()=>new B2bReceivedStepUpHttp({...f.endpoints,prepareEndpoint:url},verifyTls,prepareTls)).toThrow();
  const {prepareEndpoint,...manualConfig}=f.endpoints;const client=new B2bReceivedStepUpHttp(manualConfig,verifyTls);await expect(client.userAdministrator.authorize(f.principal,scope,'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64))).rejects.toThrow();client.dispose();
 });
 it('never injects a marker for SERVICE and preserves an explicit manual handle',async()=>{
  const f=await fixture(),result={scope,mode:'LOCAL_ONLY',items:[],networkProfile:'LOCAL_ONLY',runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'};
  const owner={execute:vi.fn(async(_access:any,_action:any,_input:any)=>result)},identity={authenticate:vi.fn(async()=>({...f.principal,kind:'SERVICE',subjectId:null,userAuthRevision:null,scopes:['b2b:received:sync']}))};
  const facade=new B2bReceivedAutomation(identity as any,owner,{automaticReceivedApprovals:true});await facade.execute({token,kind:'SERVICE'},'SYNC_CREATE',{scope,key:'synthetic-command-0001',payload:{source:'MAIL',expectedRevision:1}});
  expect(owner.execute.mock.calls[0][2].payload).not.toHaveProperty('stepUpHandle');
  expect((await read(f,(await manual(f,await f.vault.fingerprint!(hash({action:'CONFIG_READ',scope,payload:{}})))).body.handle)).status).toBe(200);
 });
 it('does not reuse another token, client revision, subject, auth revision or scope',async()=>{
  const f=await fixture();await authorize(f);
  await f.client.userAdministrator.authorize({...f.principal,revision:2},scope,'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64));expect(f.counts.prepare).toBe(2);
  for(const patch of [{clientId:targetClient},{subjectId:id(98)},{userAuthRevision:4}]){
   const before=f.counts.prepare;await expect(authorize(f,undefined,undefined,{...f.principal,...patch})).rejects.toThrow();expect(f.counts.prepare).toBe(before+1);
  }
  let before=f.counts.prepare;await expect(f.client.userAdministrator.authorize(f.principal,{...scope,branchId:id(99)},'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64))).rejects.toThrow();expect(f.counts.prepare).toBe(before+1);
  before=f.counts.prepare;await expect(f.client.userAdministrator.authorize(f.principal,scope,'CONFIG_READ','oidc-stepup.'+token+'different','b'.repeat(64))).rejects.toThrow();expect(f.counts.prepare).toBe(before+1);
 });
 it('checks the TLS pin before sending the original token and rejects wrong prepare/verify peers',async()=>{
  const f=await fixture(),verifyTls={ca:tls.ca,cert:tls.resource,key:tls.key},prepareTls={ca:tls.ca,cert:tls.edge,key:tls.key};
  const wrongPin=new B2bReceivedStepUpHttp({...f.endpoints,serverFingerprintSha256:'f'.repeat(64)},verifyTls,prepareTls);
  await expect(wrongPin.userAdministrator.authorize(f.principal,scope,'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64))).rejects.toThrow();expect(f.counts.prepare).toBe(0);wrongPin.dispose();
  const wrongPrepare=new B2bReceivedStepUpHttp(f.endpoints,verifyTls,{...prepareTls,cert:tls.other});
  await expect(wrongPrepare.userAdministrator.authorize(f.principal,scope,'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64))).rejects.toThrow();expect(f.rows().size).toBe(0);wrongPrepare.dispose();
  const wrongVerify=new B2bReceivedStepUpHttp(f.endpoints,{...verifyTls,cert:tls.other},prepareTls);
  await expect(wrongVerify.userAdministrator.authorize(f.principal,scope,'CONFIG_READ','oidc-stepup.'+token,'b'.repeat(64))).rejects.toThrow();expect(f.rows().size).toBe(1);wrongVerify.dispose();
 });
 it('validates the opt-in flag only for the existing private BETA config',()=>{
  const config={schemaVersion:'factuez.b2b.api-runtime.v1',environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),approvedForPrivateBeta:true,listen:{host:'127.0.0.1',port:3200,maintenancePort:3201},edgePeers:['a'.repeat(64)],operatorPeers:['b'.repeat(64)],origins:Object.fromEntries(b2bRuntimeOwners.map(o=>[o,`https://${o}.synthetic.invalid`])),localIssuanceEnabled:false,localConversionEnabled:false};
  expect(b2bApiRuntimeConfig(config).automaticReceivedApprovals).toBe(false);expect(b2bApiRuntimeConfig({...config,automaticReceivedApprovals:true}).automaticReceivedApprovals).toBe(true);
  expect(()=>b2bApiRuntimeConfig({...config,automaticReceivedApprovals:'true'})).toThrow();expect(()=>b2bApiRuntimeConfig({...config,environment:'PRODUCTION',automaticReceivedApprovals:true})).toThrow();
 });
});
