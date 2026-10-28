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
describe('B2B-04 actual isolated Identity/facade/Billing draft command chain',()=>{
  const apps:any[]=[];let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof draftFixture>>,port:number,ownerPort:number,id:string,operation:string;
  beforeAll(async()=>{
    tls=b2bCertificates();f=await draftFixture();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number)=>new B2bPrivateHttp('https://127.0.0.1:'+p,{ca:tls.ca,cert:tls.resource,key:tls.key});
    const identity=new B2bIdentityHttp(http(auth.getHttpServer().address().port));f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    const owner=await NestFactory.create(B2bDraftOwnerModule.isolated(f.core,[fp(tls.resource)]),{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(owner);owner.useGlobalFilters(new B2bReadErrorFilter());await owner.listen(0,'127.0.0.1');ownerPort=owner.getHttpServer().address().port;
    const unavailable={execute:async()=>{throw new Error('Not bound in synthetic draft test');},file:async()=>{throw new Error('Not bound');}};
    const reads=new B2bReads(identity,unavailable,unavailable),commands=new B2bCommands(identity,new HttpB2bCommandOwner(http(ownerPort)));
    const edge=await createB2bDraftApplication(reads,commands,[fp(tls.edge)],options);apps.push(edge);await edge.listen(0,'127.0.0.1');port=edge.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();});
  const key='http_synthetic_command_001',query='?issuerId=1&environment=BETA';
  async function send(path:string,method='GET',body?:any,headers:Record<string,string>={},peer:'edge'|'other'='edge'){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any;headers:any}>((done,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,timeout:5000,
      headers:{Authorization:'Bearer '+f.token,...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{done({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers});}catch(e){reject(e);}});res.on('error',reject);});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('timeout')));req.end(bytes);});
  }
  it('creates/replays a draft with strong ETag and durable operation references',async()=>{
    const first=await send('/b2b/v1/document-drafts','POST',draftInput(),{'Idempotency-Key':key});expect(first.status).toBe(201);expect(first.headers.etag).toBe('"v1"');id=first.body.id;operation=first.headers['x-operation-id'];expect(operation).toBeTruthy();
    const again=await send('/b2b/v1/document-drafts','POST',draftInput(),{'Idempotency-Key':key});expect(again.status).toBe(200);expect(again.headers['x-idempotent-replay']).toBe('true');expect(again.headers['x-operation-id']).toBe(operation);expect(again.body).toEqual(first.body);
    expect(f.store.rows.size).toBe(1);
  });
  it('recovers the lost response by idempotency header, never bearer or keys in URLs',async()=>{
    const result=await send('/b2b/v1/operations/lookup'+query,'GET',undefined,{'Idempotency-Key':key});expect(result.status).toBe(200);expect(result.body.operationId).toBe(operation);expect(result.body.resourceId).toBe(id);
    expect((await send('/b2b/v1/operations/'+operation+query)).status).toBe(200);
  });
  it('validates and edits only matching revisions, then cancels without fiscal effect',async()=>{
    const validation=await send('/b2b/v1/document-drafts/'+id+'/validate'+query,'POST',{}, {'Idempotency-Key':key+'v','If-Match':'"v1"'});expect(validation.status).toBe(200);expect(validation.body).toMatchObject({valid:true,revision:'"v2"',fiscalActivation:false});
    const stale=await send('/b2b/v1/document-drafts/'+id+query,'PATCH',{issueDate:'2026-10-21'},{'Idempotency-Key':key+'p','If-Match':'"v1"'});expect(stale.status).toBe(412);
    const missing=await send('/b2b/v1/document-drafts/'+id+query,'PATCH',{issueDate:'2026-10-21'},{'Idempotency-Key':key+'p'});expect(missing.status).toBe(428);
    const cancelled=await send('/b2b/v1/document-drafts/'+id+'/cancel'+query,'POST',{}, {'Idempotency-Key':key+'c','If-Match':'"v2"'});expect(cancelled.status).toBe(200);expect(cancelled.body.state).toBe('CANCELLED');
  });
  it('denies wrong issuer, unsupported issue/admin writes and unapproved peers',async()=>{
    expect((await send('/b2b/v1/document-drafts/'+id+'?issuerId=2&environment=BETA')).status).toBe(404);
    expect((await send('/b2b/v1/document-drafts/'+id+'/issue'+query,'POST',{}, {'Idempotency-Key':key})).status).toBe(403);
    expect((await send('/b2b/v1/admin/users','POST',{})).status).toBe(400);
    expect((await send('/b2b/v1/document-drafts/'+id+query,'GET',undefined,{},'other')).status).toBe(403);
  });
  it('blocks production and rejects caller-supplied authority before persistence',async()=>{
    const result=await send('/b2b/v1/document-drafts','POST',{...draftInput(),environment:'PRODUCTION',externalReference:{namespace:'ficticio',value:'bad'}},{'Idempotency-Key':key+'bad'});expect(result.status).toBe(400);expect(f.store.rows.size).toBe(1);
    const forged=await send('/b2b/v1/document-drafts','POST',{...draftInput(),userId:'ADMIN'},{'Idempotency-Key':key+'forged'});expect(forged.status).toBe(400);
  });
  it('revocation stops reads and replay even with a previously valid command key',async()=>{
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());expect((await send('/b2b/v1/operations/'+operation+query)).status).toBe(401);
  });
});
