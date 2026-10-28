import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import type {AddressInfo} from 'node:net';
import {NestFactory} from '../services/billing-service/node_modules/@nestjs/core';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {B2bCorrectionAuthorityModule} from '../services/identity-service/src/b2b/correction-http';
import {B2bCorrectionCatalogueModule} from '../services/billing-service/src/b2b/correction-catalogue-http';
import {B2bCorrectionCatalogue} from '../services/billing-service/src/b2b/correction-catalogue';
import {B2bContextFilter} from '../services/billing-service/src/b2b/http';
import {BillingB2bCorrectionAuthorization} from '../services/billing-service/src/b2b/correction-authorization';
import {B2bCorrectionCatalogueHttp,B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {correctionFixture,pair} from './b2b-correction-authority.fixture';
import {ctx,id} from './b2b-identity.fixture';
describe('B2B-06 isolated paired-series HTTPS/mTLS chain',()=>{
  let f:Awaited<ReturnType<typeof correctionFixture>>,identity:any,billing:any,port:number,billingPort:number,tls:ReturnType<typeof b2bCertificates>,rpc:B2bPrivateHttp;
  beforeAll(async()=>{
    f=await correctionFixture();tls=b2bCertificates();
    const catalogue=new B2bCorrectionCatalogue({valid:async binding=>JSON.stringify(binding)===JSON.stringify(pair())});
    billing=await NestFactory.create(B2bCorrectionCatalogueModule.isolated(catalogue,[fingerprint(tls.edge)]),{logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
    billing.useGlobalFilters(new B2bContextFilter());await billing.listen(0,'127.0.0.1');billingPort=(billing.getHttpServer().address()as AddressInfo).port;
    const catalogueRpc=new B2bCorrectionCatalogueHttp(new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`,{ca:tls.ca,cert:tls.edge,key:tls.key}));
    f.catalogue.validate.mockImplementation(values=>catalogueRpc.validate(values));
    identity=await createB2bIdentityApplication(f.identity,{token:[fingerprint(tls.edge)],admin:[fingerprint(tls.edge)],resource:[fingerprint(tls.resource)]},
      {ca:tls.ca,cert:tls.server,key:tls.key},B2bCorrectionAuthorityModule.isolated(f.core,{admin:[fingerprint(tls.edge)],owner:[fingerprint(tls.resource)]}));
    await identity.listen(0,'127.0.0.1');port=(identity.getHttpServer().address()as AddressInfo).port;
    rpc=new B2bPrivateHttp(`https://127.0.0.1:${port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
  },30000);
  afterAll(async()=>{await identity?.close();await billing?.close();});
  async function send(path:string,body:unknown,peer:'edge'|'resource'|'other'|null='resource',token=f.token,target=port,method='POST',trust=true){
    const bytes=body===undefined?undefined:JSON.stringify(body);
    return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:target,path,method,rejectUnauthorized:true,timeout:5000,
        ...(trust?{ca:tls.ca}:{}),...(peer?{cert:tls[peer],key:tls.key}:{}),headers:{Authorization:'Bearer '+token,'X-User-Role':'ADMIN',
          ...(bytes?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}:{})}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,headers:res.headers,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null});}catch(e){reject(e);}});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('synthetic timeout')));req.end(bytes);
    });
  }
  const body=()=>({kind:'SERVICE',binding:pair()});
  const enrollment=()=>({expectedClientRevision:1,expectedGrantRevision:0,bindings:[pair()]});
  it('requires client TLS and trusted server CA without forwarded-header bypass',async()=>{
    await expect(send('/internal/b2b/authorize-correction',body(),null)).rejects.toThrow();
    await expect(send('/internal/b2b/authorize-correction',body(),'resource',f.token,port,'POST',false)).rejects.toThrow();
    expect((await send('/internal/b2b/authorize-correction',body(),'other')).status).toBe(403);
  });
  it('owner peer cannot enroll grants, and admin peer alone is insufficient',async()=>{
    const path=`/internal/b2b/clients/${f.made.client.id}/correction-grants`;
    expect((await send(path,enrollment(),'resource','human-step-up')).status).toBe(403);
    expect((await send(path,enrollment(),'edge',f.token)).status).toBe(403);
  });
  it('denies token-only access until a human enrolls the explicit pair through Billing',async()=>{
    expect((await send('/internal/b2b/authorize-correction',body())).status).toBe(404);
    const r=await send(`/internal/b2b/clients/${f.made.client.id}/correction-grants`,enrollment(),'edge','human-step-up');
    expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');expect(r.body).toMatchObject({revision:1,fiscalExecutionEnabled:false});
  });
  it('authorizes with actual short-lived SERVICE JWT and never grants fiscal execution',async()=>{
    const r:any=await rpc.post('/internal/b2b/authorize-correction',body(),f.token);
    expect(r.actor).toMatchObject({userId:null,b2b:{kind:'SERVICE',subjectId:null,clientId:f.made.client.id}});
    expect(r).toMatchObject({transmissionAuthorized:false,fiscalExecutionEnabled:false});
    expect(JSON.stringify(r)).not.toContain(f.token);
  });
  it('Billing consumes the private authority and rechecks the principal on every invocation',async()=>{
    const owner=new BillingB2bCorrectionAuthorization({authenticate:(token,scopes,kind)=>f.identity.authenticate(token,scopes,ctx(),kind)},rpc);
    const first=await owner.current(f.token,'SERVICE',pair());expect(first.actor.scope.kind).toBe('ASSIGNED');expect(first.fiscalExecutionEnabled).toBe(false);
    const before=f.memory.audits.length;await owner.current(f.token,'SERVICE',pair());expect(f.memory.audits.length).toBeGreaterThan(before);
  });
  it('rejects forged actor and production context at the private boundary',async()=>{
    expect((await send('/internal/b2b/authorize-correction',{...body(),actor:{role:'ADMIN'}})).status).toBe(400);
    expect((await send('/internal/b2b/authorize-correction',{kind:'SERVICE',binding:{...pair(),reference:{...pair().reference,environment:'PRODUCTION'}}})).status).toBe(400);
    expect((await send('/internal/b2b/authorize-correction',body(),'resource','fake.jwt.token')).status).toBe(401);
  });
  it('catalogue requires its distinct registrar peer and validates the complete pair',async()=>{
    const path='/internal/b2b/validate-correction-bindings';
    expect((await send(path,{bindings:[pair()]},'resource',f.token,billingPort)).status).toBe(403);
    expect((await send(path,{bindings:[{...pair(),noteSeriesId:id(99)}]},'edge',f.token,billingPort)).status).toBe(400);
  });
  it('metadata read is privileged and stale-revision editing is rejected',async()=>{
    const path=`/internal/b2b/clients/${f.made.client.id}/correction-grants`;
    expect((await send(path,undefined,'resource',f.token,port,'GET')).status).toBe(403);
    const r=await send(path,undefined,'edge','human-step-up',port,'GET');expect(r.status).toBe(200);expect(r.body).toMatchObject({current:true,revision:1});
    expect((await send(path,enrollment(),'edge','human-step-up')).status).toBe(409);
  });
  it('current Billing master validation fails closed without changing the explicit pair',async()=>{
    f.catalogue.validate.mockRejectedValueOnce(new Error('synthetic owner outage'));
    const r=await send('/internal/b2b/authorize-correction',body());expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain('synthetic owner outage');
    expect((await send('/internal/b2b/authorize-correction',body())).status).toBe(200);
  });
  it('a revision change revokes authorization immediately, not when the JWT expires',async()=>{
    await f.identity.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());
    expect((await send('/internal/b2b/authorize-correction',body())).status).toBe(401);
  });
  it('does not publish production, credit-note issuance or PWA login routes',async()=>{
    for(const path of ['/b2b/v1/credit-notes','/b2b/v1/debit-notes','/api/v1/auth/login'])expect((await send(path,{},'resource')).status).toBe(404);
  });
});
