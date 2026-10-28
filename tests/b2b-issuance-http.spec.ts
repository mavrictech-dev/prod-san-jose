import 'reflect-metadata';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { request } from 'node:https';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import { B2bDraftOwnerModule } from '../services/billing-service/src/b2b/draft-http';
import { B2bReadErrorFilter } from '../services/b2b-api-service/src/http';
import { createB2bDraftApplication } from '../services/b2b-api-service/src/draft-application';
import { createB2bIdentityApplication } from '../services/identity-service/src/b2b/application';
import { B2bReads } from '../services/b2b-api-service/src/read';
import { B2bCommands,HttpB2bCommandOwner } from '../services/b2b-api-service/src/commands';
import { B2bPrivateHttp,B2bIdentityHttp } from '../packages/service-access/src/b2b';
import { b2bCertificates,fingerprint as fp } from './b2b-tls.fixture';
import { draftFixture,draftInput } from './b2b-drafts.fixture';
import { ctx } from './b2b-identity.fixture';
describe('B2B-04 mTLS Identity → facade → Billing issue/recovery',()=>{
  const apps:any[]=[];let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof draftFixture>>,port:number,draft:string,operation:string,document:string;
  const key='http_issue_synthetic_001',q='?issuerId=1&environment=BETA';
  beforeAll(async()=>{
    tls=b2bCertificates();f=await draftFixture(true);const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number)=>new B2bPrivateHttp('https://127.0.0.1:'+p,{ca:tls.ca,cert:tls.resource,key:tls.key});
    const identity=new B2bIdentityHttp(http(auth.getHttpServer().address().port));f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    const owner=await NestFactory.create(B2bDraftOwnerModule.isolated(f.core,[fp(tls.resource)]),{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(owner);owner.useGlobalFilters(new B2bReadErrorFilter());await owner.listen(0,'127.0.0.1');
    const unbound={execute:async()=>{throw new Error('Unbound read');},file:async()=>{throw new Error('Unbound file');}};
    const edge=await createB2bDraftApplication(new B2bReads(identity,unbound,unbound),new B2bCommands(identity,new HttpB2bCommandOwner(http(owner.getHttpServer().address().port)),true),[fp(tls.edge)],options);apps.push(edge);await edge.listen(0,'127.0.0.1');port=edge.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();});
  function send(path:string,method='GET',body?:unknown,headers:Record<string,string>={},peer:'edge'|'other'='edge'){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,timeout:5000,
      headers:{Authorization:'Bearer '+f.token,...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers});}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Local test timeout')));req.end(bytes);});
  }
  it('advertises a configured local profile but never fiscal activation',async()=>{
    const r=await send('/b2b/v1/capabilities?environment=BETA');expect(r.status).toBe(200);expect(r.body.fiscalActivation).toBe(false);expect(r.body.features.find((x:any)=>x.id==='issue').state).toBe('ENABLED');
  });
  it('creates then validates without numbering and requires a validated revision',async()=>{
    const r=await send('/b2b/v1/document-drafts','POST',draftInput(),{'Idempotency-Key':key});expect(r.status).toBe(201);draft=r.body.id;
    const missing=await send('/b2b/v1/document-drafts/'+draft+'/issue'+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v1"'});expect(missing.status).toBe(409);
    const v=await send('/b2b/v1/document-drafts/'+draft+'/validate'+q,'POST',{}, {'Idempotency-Key':key+'v','If-Match':'"v1"'});expect(v.status).toBe(200);expect(f.store.fiscal.documents).toHaveLength(0);
  });
  it('rejects missing revision, payload authority, production and unapproved peer before issuing',async()=>{
    const path='/b2b/v1/document-drafts/'+draft+'/issue';
    expect((await send(path+q,'POST',{}, {'Idempotency-Key':key+'i'})).status).toBe(428);
    expect((await send(path+q,'POST',{number:1}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})).status).toBe(400);
    expect((await send(path+'?issuerId=1&environment=PRODUCTION','POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})).status).toBe(400);
    expect((await send(path+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'},'other')).status).toBe(403);expect(f.store.fiscal.documents).toHaveLength(0);
  });
  it('returns 202 after commit; concurrent replay is the same operation/document/number',async()=>{
    const results=await Promise.all(Array.from({length:4},()=>send('/b2b/v1/document-drafts/'+draft+'/issue'+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})));
    for(const r of results){expect(r.status).toBe(202);expect(r.body).toMatchObject({state:'COMMITTED',number:'1',fiscalAcceptance:'NOT_ASSERTED'});expect(r.headers.etag).toBe('"v3"');}
    operation=results[0].headers['x-operation-id'];document=results[0].body.documentId;
    expect(new Set(results.map(r=>r.body.documentId)).size).toBe(1);expect(results.every(r=>r.headers['x-operation-id']===operation)).toBe(true);
    expect(f.store.fiscal.nextNumber).toBe(2);expect(f.store.fiscal.documents).toHaveLength(1);
  });
  it('recovers after lost HTTP response, and locks issued draft against edits',async()=>{
    for(const path of ['/operations/'+operation,'/operations/lookup']){const r=await send('/b2b/v1'+path+q,'GET',undefined,{'Idempotency-Key':key+'i'});expect(r.status).toBe(200);expect(r.body).toMatchObject({state:'COMMITTED',resourceId:document,operationId:operation});}
    const r=await send('/b2b/v1/document-drafts/'+draft+q,'PATCH',{issueDate:'2026-10-21'},{'Idempotency-Key':key+'p','If-Match':'"v3"'});expect(r.status).toBe(409);
  });
  it('revocation denies replay and recovery, without renumbering',async()=>{
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());
    expect((await send('/b2b/v1/operations/'+operation+q)).status).toBe(401);
    expect((await send('/b2b/v1/document-drafts/'+draft+'/issue'+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})).status).toBe(401);expect(f.store.fiscal.nextNumber).toBe(2);
  });
});
