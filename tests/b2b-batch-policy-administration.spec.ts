import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { BillingBatchPolicyModule } from '../services/billing-service/src/b2b/batch-policy-http';
import { createServer, request, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '../services/identity-service/node_modules/@nestjs/common';
import { NestFactory } from '../services/identity-service/node_modules/@nestjs/core';
import { AsyncResource } from 'node:async_hooks';
import { BillingBatchPolicyAdministration } from '../services/billing-service/src/b2b/batch-policy-administration';
import { PostgresBatchMemberOwner } from '../services/billing-service/src/b2b/batch-member-postgres';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { HttpB2bOwnerBinding } from '../packages/service-access/src/b2b-owner-administration';
import { BillingBatchCurrentIdentity } from '../services/billing-service/src/b2b/host-permissions-batch';
import { BillingHostPermissions } from '../services/billing-service/src/b2b/host-permissions';
import { HttpsOidcIntrospection, OidcDelegationVerifier } from '../services/identity-service/src/b2b/oidc';
import { PostgresLinkedUsers } from '../services/identity-service/src/b2b/users';
import { PostgresB2bLiveHumanIdentity, OidcB2bPrivilegedHumanAuthority, HttpB2bIdentityBindingOwner } from '../services/identity-service/src/b2b/runtime-host-authority';
import { B2bOwnerAdministration } from '../services/identity-service/src/b2b/owner-administration';
import { B2bOwnerAdministrationModule } from '../services/identity-service/src/b2b/owner-administration-http';
import { B2bIdentity } from '../services/identity-service/src/b2b/service';
import { B2bTokenCodec } from '../services/identity-service/src/b2b/token';
import { B2bErrorFilter, B2bIdentityModule } from '../services/identity-service/src/b2b/http';
import { B2bContextService } from '../services/billing-service/src/b2b/context';
import { B2bContextModule, B2bContextFilter } from '../services/billing-service/src/b2b/http';
import { B2bPrivateHttp, B2bIdentityHttp } from '../packages/service-access/src/b2b';
import { HttpB2bOwnerAdministration } from '../packages/service-access/src/b2b-owner-administration';
import { PermissionCodes } from '../packages/contracts/src';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { MemoryB2bStore, pem, others, id } from './b2b-identity.fixture';
import { establishmentFixture } from './helpers/b2b-guide-establishments.fixture';

// All listeners use loopback and ephemeral ports. Only storage/directory records and
// the authenticated OIDC provider's records are fictitious; no DB/container is started.
describe('Billing batch policy through actual OIDC/MFA + relay + mTLS loopback; explicit fictitious SQL',()=>{
  let tls:ReturnType<typeof b2bCertificates>,oidc:Server,billing:INestApplication,identity:INestApplication;
  let bindingOwner:HttpB2bOwnerBinding;
  let provider:HttpsOidcIntrospection,identityPort:B2bIdentityHttp,relay:HttpB2bOwnerAdministration;
  let store:MemoryB2bStore,actor:any,link:any,claims:any,binding:any,available=true,oidcAvailable=true,providerCalls=0,bindingCalls=0;
  let source:ReturnType<typeof establishmentFixture>;
  const issuer='https://oidc.synthetic.invalid',client='synthetic-billing-client',token='synthetic-oidc-billing-000001',subject=id(81),clientId=id(82);
  const scopes=['b2b:masters:manage','b2b:batches:read','b2b:batches:write'] as const;
  beforeAll(async()=>{
    tls=b2bCertificates();source=establishmentFixture();binding=source.binding.anchor;
    // An actual ordinary 01/03 binding from the guide anchor is the administrative boundary.
    const httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
    oidc=createServer(httpsOptions,async(req,res)=>{
      const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));providerCalls++;
      res.setHeader('Content-Type','application/json');
      if(!oidcAvailable){res.statusCode=503;res.end('{}');return;}
      const form=new URLSearchParams(Buffer.concat(chunks).toString());
      if(req.url!=='/introspect'||req.headers.authorization!=='Basic '+Buffer.from('synthetic:secret').toString('base64')){res.statusCode=401;res.end('{}');return;}
      res.end(JSON.stringify(form.get('token')===token?claims:{active:false}));
    });
    await new Promise<void>(resolve=>oidc.listen(0,'127.0.0.1',resolve));
    provider=new HttpsOidcIntrospection('https://127.0.0.1:'+(oidc.address() as AddressInfo).port+'/introspect','Basic '+Buffer.from('synthetic:secret').toString('base64'),{ca:tls.ca,cert:tls.resource,key:tls.key});
    store=new MemoryB2bStore();
    const db:any={user:{findUnique:async()=>structuredClone(actor)},$queryRawUnsafe:async()=>link?[structuredClone(link)]:[]};
    const permissions={effective:async()=>[]};
    const users=new PostgresLinkedUsers(db,permissions),live=new PostgresB2bLiveHumanIdentity(db,permissions,issuer);
    const identityCore=new B2bIdentity(store,new B2bTokenCodec(pem,issuer,()=>Math.floor(Date.now()/1000),others),randomBytes(32),
      {verify:async()=>{throw Error('unused');}},{validate:async()=>{}},new OidcDelegationVerifier(issuer,provider,users),Date.now,scopes);
    billing=await NestFactory.create(B2bContextModule.isolated(new B2bContextService({resolve:async b=>{bindingCalls++;return available&&JSON.stringify(b)===JSON.stringify(binding)?{binding:b}:null;}},
      {authenticate:async()=>{throw Error('unused');}}),{context:[fingerprint(tls.edge)],registrar:[fingerprint(tls.resource)]}),{logger:false,httpsOptions});
    billing.useGlobalFilters(new B2bContextFilter());await billing.listen(0,'127.0.0.1');
    const billingHttp=new B2bPrivateHttp('https://127.0.0.1:'+(billing.getHttpServer().address() as AddressInfo).port,{ca:tls.ca,cert:tls.resource,key:tls.key});
    bindingOwner=new HttpB2bOwnerBinding(billingHttp);
    const authority=new OidcB2bPrivilegedHumanAuthority({provider,users,live,store:store as any,issuer,clientId:client,acceptedAcr:['urn:synthetic:mfa'],policyRevision:'a'.repeat(64),
      actions:['MASTERS_READ','SERIES_UPDATE'],allowedScopes:scopes});
    const owner=new B2bOwnerAdministration({enabled:true,peers:{billing:[fingerprint(tls.other)],fiscal:[],mailer:[]},authority,live,bindings:new HttpB2bIdentityBindingOwner(billingHttp),store});
    identity=await NestFactory.create({module:class SyntheticIdentity{},imports:[B2bOwnerAdministrationModule.isolated(owner),B2bIdentityModule.isolated(identityCore,
      {token:[fingerprint(tls.edge)],admin:[fingerprint(tls.edge)],resource:[fingerprint(tls.resource)]})]},{logger:false,httpsOptions});
    identity.useGlobalFilters(new B2bErrorFilter());await identity.listen(0,'127.0.0.1');
    const origin='https://127.0.0.1:'+(identity.getHttpServer().address() as AddressInfo).port;
    identityPort=new B2bIdentityHttp(new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.resource,key:tls.key}));
    relay=new HttpB2bOwnerAdministration(new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.other,key:tls.key}),'billing');
  },30000);
  beforeEach(()=>{
    source=establishmentFixture();available=true;oidcAvailable=true;providerCalls=0;bindingCalls=0;
    const now=Math.floor(Date.now()/1000);
    claims={active:true,iss:issuer,aud:'factuez-b2b-v1',token_type:'Bearer',sub:'synthetic-external-subject',client_id:client,iat:now,exp:now+240,
      scope:scopes.join(' '),auth_time:now-2,amr:['pwd','mfa'],acr:'urn:synthetic:mfa'};
    actor={id:subject,username:'SYNTHETIC',fullName:'SYNTHETIC ONLY',active:true,authVersion:4,
      roles:[{role:{code:'ADMIN',active:true,permissions:['SETUP_MANAGE','SERIES_MANAGE','DOCUMENT_VIEW','DOCUMENT_ISSUE'].map(code=>({permission:{code}}))}}],branches:[],emissionPoints:[],series:[]};
    link={clientId,clientRevision:1,userId:subject,userAuthRevision:4,enabled:true};
    store.clients.clear();store.audits=[];store.failAudit=false;store.down=false;
    store.clients.set(clientId,{id:clientId,label:'SYNTHETIC',enabled:true,revision:1,kind:'USER',secretHash:null,oidcClientId:client,scopes:[...scopes],bindings:[binding]});
  });
  afterAll(async()=>{
    await identity?.close();await billing?.close();if(oidc)await new Promise<void>((r,j)=>oidc.close(e=>e?j(e):r()));
  });
  const member=()=>({environment:'BETA' as const,companyId:binding.issuerId,issuerRuc:binding.issuerRuc,branchId:binding.branchId,
    pointId:binding.pointId,seriesId:binding.seriesId,documentType:binding.documentType,series:'F001'});
  const policy=(active=true,expectedRevision=0)=>({subject:{kind:'SERVICE' as const,clientId:id(93),subjectId:null},binding:member(),kind:'RC' as const,
    permission:'WRITE' as const,clientRevision:1,userAuthRevision:null,active,expectedRevision});
  function administration(){return new BillingBatchPolicyAdministration({enabled:true,identity:identityPort,authority:relay,liveIdentity:relay,
    bindingOwner:bindingOwner!},[{anchor:binding,member:member()}]);}
  function owner(admin:BillingBatchPolicyAdministration,onWrite=()=>{}){
    let committed:any=null,staged:any=null;const statements:string[]=[];
    const sql={query:async(text:string,args:any[]=[])=>{
      statements.push(text);
      if(text.startsWith('BEGIN'))staged=structuredClone(committed);
      if(text.startsWith('SELECT revision'))return {rows:staged?[{revision:staged.revision}]:[],rowCount:staged?1:0};
      if(text.startsWith('INSERT INTO b2b_batch_member_grant')||text.startsWith('UPDATE b2b_batch_member_grant')){staged={policy:JSON.parse(args[1]),revision:args[2]};onWrite();}
      if(text==='COMMIT')committed=structuredClone(staged);
      if(text==='ROLLBACK')staged=null;
      return {rows:[],rowCount:1};
    },release:()=>{}};
    const deny=async():Promise<never>=>{throw Error('UNUSED_SYNTHETIC_PORT');};
    const core=new PostgresBatchMemberOwner({connect:async()=>sql},{verifySignedVersion:deny},{current:deny},admin.policyAdmin);
    return {core,statements,get committed(){return committed;}};
  }
  it('persists a local grant and active=false revoke through real OIDC/MFA relay and exact digest CAS',async()=>{
    const admin=administration(),o=owner(admin);
    expect(await admin.withPolicy(token,policy(),(h,p)=>o.core.setLocalGrant(h,p))).toBe(1);
    expect(o.committed.policy.active).toBe(true);expect(o.committed.revision).toBe(1);
    expect(await admin.withPolicy(token,policy(false,1),(h,p)=>o.core.setLocalGrant(h,p))).toBe(2);
    expect(o.committed.policy.active).toBe(false);expect(providerCalls).toBeGreaterThan(20);expect(bindingCalls).toBeGreaterThan(10);
    expect(store.audits.some(a=>a.action==='OWNER_ADMIN_BILLING_MASTERS_READ')).toBe(true);
    expect(store.audits.some(a=>a.action==='OWNER_ADMIN_BILLING_SERIES_UPDATE')).toBe(true);
    expect(JSON.stringify(o.committed)+JSON.stringify(store.audits)).not.toContain(token);
  });
  it.each(['mfa','acr','staleMfa','expired','audience','issuer','client','link','revision','role','permission','inactiveRole','binding','disabledClient','oidc','audit'])('rejects %s with no grant write',async defect=>{
    if(defect==='mfa')claims.amr=['pwd'];if(defect==='acr')claims.acr='wrong';if(defect==='staleMfa')claims.auth_time-=301;
    if(defect==='expired')claims.exp=1;if(defect==='audience')claims.aud='other';if(defect==='issuer')claims.iss='https://wrong.invalid';if(defect==='client')claims.client_id='wrong';
    if(defect==='link')link=null;if(defect==='revision')actor.authVersion++;if(defect==='role')actor.roles[0].role.code='CASHIER';
    if(defect==='permission')actor.roles[0].role.permissions=[{permission:{code:'SETUP_MANAGE'}}];if(defect==='inactiveRole')actor.roles[0].role.active=false;
    if(defect==='binding')available=false;if(defect==='disabledClient')store.clients.get(clientId)!.enabled=false;
    if(defect==='oidc')oidcAvailable=false;if(defect==='audit')store.failAudit=true;
    const admin=administration(),o=owner(admin);
    await expect(admin.withPolicy(token,policy(),(h,p)=>o.core.setLocalGrant(h,p))).rejects.toBeDefined();
    expect(o.committed).toBe(null);expect(o.statements).toHaveLength(0);
  });
  it('rolls back when live permission is revoked after the staged write',async()=>{
    const admin=administration(),o=owner(admin,()=>{actor.roles[0].role.permissions=[];});
    await expect(admin.withPolicy(token,policy(),(h,p)=>o.core.setLocalGrant(h,p))).rejects.toBeDefined();
    expect(o.committed).toBe(null);expect(o.statements).toContain('ROLLBACK');expect(o.statements).not.toContain('COMMIT');
  });
  it('denies digest/subject/revision substitution, arbitrary handles, unconfigured scope and stale checkedAt',async()=>{
    const admin=administration(),p=policy(),digest=hash(p);
    await expect(admin.policyAdmin.authorizeStepUp(token,digest,new Date().toISOString())).rejects.toMatchObject({status:403});
    for(const change of [{active:false},{expectedRevision:1},{subject:{...p.subject,clientId:id(99)}}]){
      const o=owner(admin);await expect(admin.withPolicy(token,p,h=>o.core.setLocalGrant(h,{...p,...change}))).rejects.toBeDefined();expect(o.committed).toBeNull();
    }
    await expect(admin.withPolicy(token,{...p,binding:{...p.binding,branchId:id(99)}},async()=>null)).rejects.toMatchObject({status:403});
    await expect(admin.withPolicy(token,p,h=>admin.policyAdmin.authorizeStepUp(h,digest,new Date(Date.now()-31000).toISOString()))).rejects.toMatchObject({status:403});
  });
  it('revokes handles on return/throw, rejects reentry and closes the authority',async()=>{
    const admin=administration(),p=policy();let escaped:()=>Promise<any>=async()=>null;
    await admin.withPolicy(token,p,async h=>{
      escaped=AsyncResource.bind(()=>admin.policyAdmin.authorizeStepUp(h,hash(p),new Date().toISOString()));
      await expect(admin.withPolicy(token,p,async()=>null)).rejects.toMatchObject({status:403});
    });
    await expect(escaped()).rejects.toMatchObject({status:401});
    await expect(admin.withPolicy(token,p,async h=>{escaped=AsyncResource.bind(()=>admin.policyAdmin.authorizeStepUp(h,hash(p),new Date().toISOString()));throw Error('FICTITIOUS_ABORT');})).rejects.toThrow('FICTITIOUS_ABORT');
    await expect(escaped()).rejects.toMatchObject({status:401});
    admin.close();await expect(admin.withPolicy(token,p,async()=>null)).rejects.toMatchObject({status:503});
  });
  it('rejects policy CAS conflicts without replacing the committed grant',async()=>{
    const admin=administration(),o=owner(admin);await admin.withPolicy(token,policy(),(h,p)=>o.core.setLocalGrant(h,p));
    await expect(admin.withPolicy(token,policy(false,0),(h,p)=>o.core.setLocalGrant(h,p))).rejects.toBeDefined();
    expect(o.committed.revision).toBe(1);expect(o.committed.policy.active).toBe(true);
  });
  it('executes only the fixed private policy RPC with the designated mTLS peer and live bearer',async()=>{
    const admin=administration(),o=owner(admin),app=await NestFactory.create(BillingBatchPolicyModule.isolated(admin,o.core,[fingerprint(tls.edge)]),
      {logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
    await app.listen(0,'127.0.0.1');
    const post=(body:any,options:{path?:string;cert?:Buffer;authorization?:string}={})=>new Promise<{status:number;body:any}>((resolve,reject)=>{
      const data=Buffer.from(JSON.stringify(body));const req=request({hostname:'127.0.0.1',port:(app.getHttpServer().address() as AddressInfo).port,path:options.path??'/internal/b2b/batch-policy',method:'POST',
        ca:tls.ca,cert:options.cert??tls.edge,key:tls.key,agent:false,headers:{'Content-Type':'application/json','Content-Length':data.length,Authorization:options.authorization??'Bearer '+token}},res=>{
          const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
        });req.on('error',reject);req.end(data);
    });
    try{
      const r=await post({policy:policy()});expect(r.status).toBe(200);expect(r.body).toMatchObject({revision:1,environment:'BETA',fiscalExecutionEnabled:false});
      expect(o.committed.policy.active).toBe(true);
      expect((await post({policy:policy(false,1)},{cert:tls.resource})).status).toBe(403);
      expect((await post({policy:policy(false,1)},{path:'/internal/b2b/batch-policy?approve=true'})).status).toBe(400);
      expect((await post({policy:policy(false,1),stepUpVerified:true})).status).toBe(400);
      expect((await post({policy:{...policy(false,1),stepUpVerified:true}})).status).not.toBe(200);
      expect((await post({policy:policy(false,1)},{authorization:'Bearer service-token-not-oidc'})).status).not.toBe(200);
      expect(o.committed.revision).toBe(1);
    }finally{admin.close();await app.close();}
  });

});
