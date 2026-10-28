import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import {NestFactory} from '../services/billing-service/node_modules/@nestjs/core';
import {B2bCommercialOwnerModule} from '../services/billing-service/src/b2b/commercial-http';
import {B2bReadErrorFilter} from '../services/b2b-api-service/src/http';
import {createB2bDraftApplication} from '../services/b2b-api-service/src/draft-application';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {B2bCommercialCommands,HttpB2bCommercialOwner} from '../services/b2b-api-service/src/commercial';
import {B2bPrivateHttp,B2bIdentityHttp} from '../packages/service-access/src/b2b';
import {b2bCertificates,fingerprint as fp} from './b2b-tls.fixture';
import {commercialFixture,commercialInput} from './b2b-commercial.fixture';
import {ctx} from './b2b-identity.fixture';
describe('B2B-06 HTTPS Identity → facade → commercial owner',()=>{
  const apps:any[]=[];let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof commercialFixture>>,port:number,note:string,op:string;
  const q='?issuerId=1&environment=BETA',key='http_commercial_synthetic';
  beforeAll(async()=>{
    tls=b2bCertificates();f=await commercialFixture();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number)=>new B2bPrivateHttp('https://127.0.0.1:'+p,{ca:tls.ca,cert:tls.resource,key:tls.key}),identity=new B2bIdentityHttp(http(auth.getHttpServer().address().port));
    f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    const owner=await NestFactory.create(B2bCommercialOwnerModule.isolated(f.core,[fp(tls.resource)]),{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(owner);owner.useGlobalFilters(new B2bReadErrorFilter());await owner.listen(0,'127.0.0.1');
    const unavailable={execute:async()=>{throw new Error('UNBOUND');},file:async()=>{throw new Error('UNBOUND');}};
    const facade=await createB2bDraftApplication(new B2bReads(identity,unavailable,unavailable),new B2bCommands(identity,unavailable),[fp(tls.edge)],options,undefined,undefined,
      new B2bCommercialCommands(identity,new HttpB2bCommercialOwner(http(owner.getHttpServer().address().port)),true));
    apps.push(facade);await facade.listen(0,'127.0.0.1');port=facade.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{for(const a of apps.reverse())await a.close();});
  function send(path:string,method='GET',body?:unknown,headers:Record<string,string>={},peer:'edge'|'other'='edge'){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path:'/b2b/v1'+path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,timeout:10000,headers:{Authorization:'Bearer '+f.token,...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers});}catch(e){reject(e);}});
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('SYNTHETIC_HTTP_TIMEOUT')));req.end(bytes);
    });
  }
  it('advertises commercial support but never fiscal corrections or activation',async()=>{
    const r=await send('/capabilities?environment=BETA');expect(r.status).toBe(200);expect(r.body.fiscalActivation).toBe(false);expect(r.body.features.find((x:any)=>x.id==='sales-notes').state).toBe('ENABLED');expect(r.body.features.find((x:any)=>x.id==='sales-note-conversion').state).toBe('ENABLED');expect(r.body.features.find((x:any)=>x.id==='fiscal-corrections').state).toBe('DISABLED');
  });
  it('creates and reads an NV, not an invoice; requires scoped query and idempotency',async()=>{
    expect((await send('/sales-notes','POST',commercialInput(),{'Idempotency-Key':key})).status).toBe(400);
    const r=await send('/sales-notes'+q,'POST',commercialInput(),{'Idempotency-Key':key});expect(r.status).toBe(201);note=r.body.id;expect(r.body).toMatchObject({fiscal:false,documentType:'NV',commercialNumber:'NV-00000001'});expect(r.headers.etag).toBe('"v1"');
    expect((await send('/sales-notes/'+note+q)).status).toBe(200);expect((await send('/sales-notes'+q+'&limit=1')).body.items).toHaveLength(1);expect(f.store.documents).toHaveLength(0);
  });
  it('refuses unknown fields, missing revisions, production, bad peer and DELETE',async()=>{
    expect((await send('/sales-notes/'+note+q,'PATCH',{number:1},{'Idempotency-Key':key+'p','If-Match':'"v1"'})).status).toBe(400);
    expect((await send('/sales-notes/'+note+'/complete'+q,'POST',{}, {'Idempotency-Key':key+'c'})).status).toBe(428);
    expect((await send('/sales-notes?issuerId=1&environment=PRODUCTION')).status).toBe(400);
    expect((await send('/sales-notes'+q,'GET',undefined,{},'other')).status).toBe(403);
    expect((await send('/sales-notes/'+note+q,'DELETE',{})).status).toBe(400);expect(f.store.documents).toHaveLength(0);
  });
  it('completes then converts once with 202, stable replay and operation recovery',async()=>{
    const completed=await send('/sales-notes/'+note+'/complete'+q,'POST',{}, {'Idempotency-Key':key+'c','If-Match':'"v1"'});expect(completed.status).toBe(200);
    const results=await Promise.all(Array.from({length:4},()=>send('/sales-notes/'+note+'/convert'+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})));
    expect(results.map(r=>r.status)).toEqual([202,202,202,202]);expect(new Set(results.map(r=>r.body.convertedDocumentId)).size).toBe(1);op=results[0].headers['x-operation-id'];
    const recovered=await send('/commercial-operations/'+op+q);expect(recovered.status).toBe(200);expect(recovered.body.state).toBe('COMMITTED');expect(f.store.documents).toHaveLength(1);
    expect((await send('/sales-notes/'+note+q,'PATCH',{issueDate:'2026-10-21'},{'Idempotency-Key':key+'late','If-Match':'"v3"'})).status).toBe(409);
  });
  it('registers blocked correction intent with no access to fiscal execution',async()=>{
    const b={originalDocumentId:f.original.id,kind:'VOID',reason:'Solicitud sintética',externalReference:{namespace:'synthetic',value:'http-void'}};
    const r=await send('/correction-requests'+q,'POST',b,{'Idempotency-Key':key+'r'});expect(r.status).toBe(201);expect(r.body).toMatchObject({state:'BLOCKED_FISCAL_EXECUTION',fiscalExecutionEnabled:false});
    const id=r.body.id;expect((await send('/correction-requests/'+id+q)).status).toBe(200);
    const readiness=await send('/correction-requests/'+id+'/readiness'+q);expect(readiness.status).toBe(200);expect(readiness.body).toMatchObject({readiness:'BLOCKED',evidenceAuthenticityVerified:false,declarations:{spendableBalance:false,historyCompleteness:'NOT_VERIFIED'}});
    expect((await send('/correction-requests/'+id+'/execute'+q,'POST',{}, {'Idempotency-Key':key+'execute','If-Match':'"v1"'})).status).toBe(400);
    expect((await send('/correction-requests/'+id+'/cancel'+q,'POST',{}, {'Idempotency-Key':key+'cancel','If-Match':'"v1"'})).status).toBe(200);expect(f.store.documents).toHaveLength(1);
  });
  it('revocation blocks both read and replay across all listeners',async()=>{
    await f.auth.core.change('human-step-up',f.made.client.id,{expectedRevision:1,enabled:false},ctx());expect((await send('/sales-notes/'+note+q)).status).toBe(401);
    expect((await send('/sales-notes/'+note+'/convert'+q,'POST',{}, {'Idempotency-Key':key+'i','If-Match':'"v2"'})).status).toBe(401);expect(f.store.documents).toHaveLength(1);
  });
});
