import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '../services/identity-service/node_modules/@nestjs/common';
import { NestFactory } from '../services/identity-service/node_modules/@nestjs/core';
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
describe('Billing establishment adapter through actual OIDC + owner relay + mTLS loopback',()=>{
  let tls:ReturnType<typeof b2bCertificates>,oidc:Server,billing:INestApplication,identity:INestApplication;
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
  function host(enabled=true,owner=relay){return new BillingHostPermissions({post:async()=>{throw Error('unextended endpoint is not used');}},{enabled,establishment:{authority:owner,liveIdentity:owner,identity:identityPort}});}
  it('writes the real establishment core with current OIDC, permissions, bindings and MFA before commit',async()=>{
    const h=host();const registry=h.establishments(source.store,binding);
    const result=await registry.replace(token,source.company.id,source.input(),source.context);
    expect(result.snapshot?.actorId).toBe(subject);expect(result.snapshot?.authRevision).toBe(4);
    expect(source.store.state.heads.size).toBe(1);expect(source.store.state.audits).toHaveLength(1);
    expect(providerCalls).toBeGreaterThan(8);expect(bindingCalls).toBeGreaterThan(5);
    expect(JSON.stringify(store.audits)).not.toContain(token);
    await expect(h.establishmentAdmin.verify(token)).rejects.toMatchObject({status:403});
  });
  it.each(['mfa','acr','staleMfa','expired','audience','issuer','client','link','revision','role','permission','inactiveRole','binding','disabledClient','oidc','audit'])('rejects %s without an establishment write',async defect=>{
    if(defect==='mfa')claims.amr=['pwd'];if(defect==='acr')claims.acr='wrong';if(defect==='staleMfa')claims.auth_time-=301;
    if(defect==='expired')claims.exp=1;if(defect==='audience')claims.aud='other';if(defect==='issuer')claims.iss='https://wrong.invalid';if(defect==='client')claims.client_id='wrong';
    if(defect==='link')link=null;if(defect==='revision')actor.authVersion++;if(defect==='role')actor.roles[0].role.code='CASHIER';
    if(defect==='permission')actor.roles[0].role.permissions=[{permission:{code:'SETUP_MANAGE'}}];if(defect==='inactiveRole')actor.roles[0].role.active=false;
    if(defect==='binding')available=false;if(defect==='disabledClient')store.clients.get(clientId)!.enabled=false;
    if(defect==='oidc')oidcAvailable=false;if(defect==='audit')store.failAudit=true;
    await expect(host().establishments(source.store,binding).replace(token,source.company.id,source.input(),source.context)).rejects.toBeDefined();
    expect(source.store.state.heads.size).toBe(0);expect(source.store.state.audits).toHaveLength(0);
  });
  it('rolls back a staged registry and its audit when permission is revoked after save',async()=>{
    source.store.onWrite=action=>{if(action==='save')actor.roles[0].role.permissions=[];};
    await expect(host().establishments(source.store,binding).replace(token,source.company.id,source.input(),source.context)).rejects.toBeDefined();
    expect(source.store.state.heads.size).toBe(0);expect(source.store.state.audits).toHaveLength(0);
  });
  it('checks the exact company, rejects ambient calls, remains disabled by default and honors close',async()=>{
    const h=host();await expect(h.establishments(source.store,binding).read(token,2,source.context)).rejects.toMatchObject({status:403});
    await expect(host(false).establishments(source.store,binding).read(token,1,source.context)).rejects.toMatchObject({status:503});
    h.close();await expect(h.establishments(source.store,binding).read(token,1,source.context)).rejects.toMatchObject({status:503});
    expect(providerCalls).toBe(0);
  });
  it('rejects a trusted certificate assigned to another role',async()=>{
    const origin='https://127.0.0.1:'+(identity.getHttpServer().address() as AddressInfo).port;
    const wrong=new HttpB2bOwnerAdministration(new B2bPrivateHttp(origin,{ca:tls.ca,cert:tls.resource,key:tls.key}));
    await expect(host(true,wrong).establishments(source.store,binding).read(token,1,source.context)).rejects.toBeDefined();
    expect(source.store.state.audits).toHaveLength(0);
  });
  it('currentBatch uses the original bearer over actual Identity HTTP and remains only an identity receipt',async()=>{
    const adapter=new BillingBatchCurrentIdentity(identityPort,{enabled:true});
    const actor={kind:'USER' as const,clientId,subjectId:subject};let receipt:any;
    const core:any={execute:async()=>{receipt=await adapter.memberIdentity.current(actor,new Date().toISOString());return receipt;},artifactOwner:async()=>null,artifactOwnerById:async()=>null};
    await adapter.wrap(core).execute(token,'USER','PREPARE',{});
    expect(receipt).toEqual({subject:actor,clientRevision:1,userAuthRevision:4,checkedAt:expect.any(String)});
    expect(Object.keys(receipt).sort()).toEqual(['checkedAt','clientRevision','subject','userAuthRevision']);
    expect(providerCalls).toBe(1);expect(bindingCalls).toBe(0);
    await expect(adapter.memberIdentity.current(actor,new Date().toISOString())).rejects.toMatchObject({status:403});
  });
  it('currentBatch rejects a different subject, revoked link/client and revision changes during one execution',async()=>{
    for(const defect of ['subject','link','client','revision']){
      const saved=structuredClone(link),app=store.clients.get(clientId)!;app.enabled=true;actor.authVersion=4;
      const adapter=new BillingBatchCurrentIdentity(identityPort,{enabled:true});
      const subjectInput={kind:'USER' as const,clientId,subjectId:subject};
      const core:any={execute:async()=>{
        await adapter.memberIdentity.current(subjectInput,new Date().toISOString());
        // The transaction fixture replaces its committed map; mutate the CURRENT
        // durable row, not the detached object captured before authentication.
        const latest=store.clients.get(clientId)!;
        if(defect==='subject')subjectInput.subjectId=id(99);if(defect==='link')link=null;if(defect==='client')latest.enabled=false;
        if(defect==='revision'){latest.revision++;link.clientRevision=latest.revision;}
        return adapter.memberIdentity.current(subjectInput,new Date().toISOString());
      },artifactOwner:async()=>null,artifactOwnerById:async()=>null};
      await expect(adapter.wrap(core).execute(token,'USER','RECOVER',{})).rejects.toBeDefined();
      link=saved;store.clients.get(clientId)!.revision=1;
    }
  });});


