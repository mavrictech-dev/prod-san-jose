import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {request} from 'node:https';
import {Module} from '../services/b2b-api-service/node_modules/@nestjs/common';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {adminFixture,input as applicationInput} from './b2b-integration-admin.fixture';
import {B2bIntegrationAdmin,HttpB2bIntegrationAdminOwner} from '../services/b2b-api-service/src/integration-admin';
import {B2bPhase8Business,HttpPhase8Business} from '../services/b2b-api-service/src/phase8-business';
import {B2bPhase8Reports,HttpPhase8Reports} from '../services/b2b-api-service/src/phase8-reports';
import {B2bPhase8History,HttpB2bHistoryOwner} from '../services/b2b-api-service/src/phase8-history';
import {B2bPhase8BusinessOwnerModule} from '../services/billing-service/src/b2b/phase8-business-http';
import {B2bPhase8ReportsOwnerModule} from '../services/billing-service/src/b2b/phase8-reports-http';
import {B2bHistoryOwnerModule} from '../services/history-service/src/b2b/http';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {createB2bPhase8Application} from '../services/b2b-api-service/src/phase8-application';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {fixture as businessFixture,customer,product} from './helpers/b2b-phase8-business.fixture';
import {reportsFixture,filters} from './b2b-phase8-reports.fixture';
import {historyFixture} from './b2b-phase8-reports-history.fixture';
import {b2bReceivedFixture} from './helpers/b2b-received.fixture';
import {B2bReceivedReads} from '../services/b2b-api-service/src/received';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {createHash,randomUUID} from 'node:crypto';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
class Phase8OwnerHarness{}
Module({})(Phase8OwnerHarness);

describe('complete candidate composition, public TLS → fixed private RPC → actual owner engines',()=>{
 let app:any,owner:any,port:number,tls:ReturnType<typeof b2bCertificates>;
 const business=businessFixture(),reports=reportsFixture(),history=historyFixture(),admin=adminFixture(),received=b2bReceivedFixture();
 const identity={authenticate:(token:string,scopes:any[],kind:any)=>token==='synthetic-token'?business.identity.authenticate(token,scopes,kind):token===reports.auth.token?reports.identity.authenticate(token,scopes,kind):token===history.auth.token?history.identity.authenticate(token,scopes,kind):received.identity.authenticate(token,scopes,kind)};
 beforeAll(async()=>{
  tls=b2bCertificates();const peer=[fingerprint(tls.resource)],options={ca:tls.ca,cert:tls.server,key:tls.key};
  const owners={module:Phase8OwnerHarness,imports:[B2bPhase8BusinessOwnerModule.isolated(business.engine,peer),B2bPhase8ReportsOwnerModule.isolated(reports.reports,peer),B2bHistoryOwnerModule.isolated(history.reader,peer)]};
  owner=await createB2bIdentityApplication(admin.core,{token:peer,admin:peer,resource:peer},options,owners);await owner.listen(0,'127.0.0.1');
  const http=new B2bPrivateHttp(`https://127.0.0.1:${owner.getHttpServer().address().port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
  const unavailable:any={execute:async()=>{throw new Error('UNCONFIGURED');},file:async()=>{throw new Error('UNCONFIGURED');}};
  const probe:any={ready:async()=>{throw new Error('NOT_THIS_TEST');},issue:async()=>{throw new Error('NOT_THIS_TEST');},read:async()=>{throw new Error('NOT_THIS_TEST');},view:async()=>{throw new Error('NOT_THIS_TEST');},content:async()=>{throw new Error('NOT_THIS_TEST');},execute:async()=>{throw new Error('NOT_THIS_TEST');}};
  app=await createB2bPhase8Application({read:new B2bReads(identity,unavailable,unavailable),commands:new B2bCommands(identity,unavailable),peers:[fingerprint(tls.edge)],tls:options,
   phase7:{guideIssuance:probe,guideArtifacts:probe,carrier:probe,batches:probe,batchArtifacts:probe},phase8:{received:new B2bReceivedReads(identity,received.facade as any),
    admin:new B2bIntegrationAdmin(new HttpB2bIntegrationAdminOwner(http)),business:new B2bPhase8Business(identity,new HttpPhase8Business(http)),reports:new B2bPhase8Reports(identity,new HttpPhase8Reports(http)),history:new B2bPhase8History(identity,new HttpB2bHistoryOwner(http))}});
  await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;
 },30000);
 afterAll(async()=>{await app?.close();await owner?.close();history.close();});
 function send(path:string,token='synthetic-token',kind='USER',method='GET',body?:unknown,key?:string){
  const b=body===undefined?undefined:Buffer.from(JSON.stringify(body));
  return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls.edge,key:tls.key,rejectUnauthorized:true,headers:{Authorization:'Bearer '+token,'X-FactuEz-Actor-Kind':kind,...(key?{'Idempotency-Key':key}:{}),...(b?{'Content-Type':'application/json','Content-Length':String(b.length)}:{})}},res=>{
    const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks);try{resolve({status:res.statusCode!,headers:res.headers,bytes,body:String(res.headers['content-type']).startsWith('application/json')?JSON.parse(bytes.toString()):null});}catch(e){reject(e);}});});req.on('error',reject);req.end(b);
  });
 }
 const query=(b:any)=>'?'+new URLSearchParams(Object.entries(b).map(([k,v])=>[k,String(v)])).toString();
 it('creates, reads, revises and idempotently replays an actual customer',async()=>{
  const q=query(business.b),key=randomUUID(),created=await send('/b2b/v1/customers'+q,undefined,undefined,'POST',customer(),key);
  expect(created.status).toBe(201);const id=created.body.data.id;
  expect((await send('/b2b/v1/customers/'+id+q)).body.data.legalName).toBe('CLIENTE SINTETICO');
  const repeated=await send('/b2b/v1/customers'+q,undefined,undefined,'POST',customer(),key);expect(repeated.body.replayed).toBe(true);expect(repeated.body.data.id).toBe(id);
  const update=await send('/b2b/v1/customers/'+id+q,undefined,undefined,'PATCH',{expectedRevision:1,body:{legalName:'NOMBRE ACTUALIZADO'}},randomUUID());expect(update.status).toBe(200);expect(update.body.data.revision).toBe(2);
 });
 it('creates shared products and reads them through the explicit business catalogue',async()=>{
  const q=query(business.b),r=await send('/b2b/v1/products'+q,undefined,undefined,'POST',product(),randomUUID());expect(r.status).toBe(201);
  const page=await send('/b2b/v1/business-products'+q);expect(page.status).toBe(200);expect(page.body.data[0].id).toBe(r.body.data.id);
 });
 it('opens, records exact cash and closes a shift; cannot add to a closed shift',async()=>{
  const q=query(business.b),open=await send('/b2b/v1/shifts'+q,undefined,undefined,'POST',{openingAmount:'0.10',currency:'PEN'},randomUUID());expect(open.status).toBe(201);const id=open.body.data.id;
  const moved=await send('/b2b/v1/shifts/'+id+'/cash-movements'+q,undefined,undefined,'POST',{expectedRevision:1,direction:'IN',amount:'0.20',reason:'PRUEBA'},randomUUID());expect(moved.body.data.balance).toBe('0.30');
  const closed=await send('/b2b/v1/shifts/'+id+'/close'+q,undefined,undefined,'POST',{expectedRevision:2,countedAmount:'0.30',reason:'CIERRE'},randomUUID());expect(closed.body.data.state).toBe('CLOSED');
  expect((await send('/b2b/v1/shifts/'+id+'/cash-movements'+q,undefined,undefined,'POST',{expectedRevision:3,direction:'IN',amount:'1.00',reason:'YA CERRADO'},randomUUID())).status).toBe(409);
 });
 it('renders an actual captured CSV report and checks bytes and metadata',async()=>{
  const create=await send('/b2b/v1/report-jobs?environment=BETA',reports.auth.token,'SERVICE','POST',{filters,format:'CSV'},randomUUID());expect(create.status).toBe(201);const id=create.body.data.id;
  expect((await send('/b2b/v1/report-jobs/'+id+'?environment=BETA',reports.auth.token,'SERVICE')).body.data.state).toBe('READY');
  const file=await send('/b2b/v1/report-jobs/'+id+'/content?environment=BETA',reports.auth.token,'SERVICE');expect(file.status).toBe(200);expect(file.bytes.toString()).toContain('issuerRuc');expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(file.headers['x-content-sha256']);
 });
 it('carries expired report 410 across both real mTLS boundaries with replay and live scope checks',async()=>{
  const key=randomUUID(),body={filters,format:'CSV'},create=await send('/b2b/v1/report-jobs?environment=BETA',reports.auth.token,'SERVICE','POST',body,key);
  expect(create.status).toBe(201);const id=create.body.data.id,captures=reports.port.execute.mock.calls.length;
  reports.store.jobs.get(id)!.contentPurgedAt=new Date().toISOString();reports.store.files.delete(id);
  for(const path of ['/b2b/v1/report-jobs/'+id,'/b2b/v1/report-jobs/'+id+'/content']){
   const response=await send(path+'?environment=BETA',reports.auth.token,'SERVICE');expect(response.status).toBe(410);expect(response.body.code).toBe('ARTIFACT_NOT_AVAILABLE');expect(response.headers['cache-control']).toContain('no-store');
  }
  const replay=await send('/b2b/v1/report-jobs?environment=BETA',reports.auth.token,'SERVICE','POST',body,key);expect(replay.status).toBe(410);expect(replay.body.code).toBe('ARTIFACT_NOT_AVAILABLE');
  const sdk=new FactuEzB2bClient({origin:'https://127.0.0.1:'+port,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer:async()=>({token:reports.auth.token,actorKind:'SERVICE'})});
  await expect(sdk.downloadReport(id)).rejects.toMatchObject({status:410});expect(reports.port.execute.mock.calls.length).toBe(captures);
  const saved=reports.p.bindings[0].branchId;reports.p.bindings[0].branchId=randomUUID();
  try{expect((await send('/b2b/v1/report-jobs/'+id+'?environment=BETA',reports.auth.token,'SERVICE')).status).toBe(404);}finally{reports.p.bindings[0].branchId=saved;}
 });
 it('reads the real guarded synthetic archive and its original without session forwarding',async()=>{
  const q=query(history.binding),list=await send('/b2b/v1/history/documents'+q,history.auth.token,'SERVICE');expect(list.status).toBe(200);expect(list.body.datasetClass).toBe('SYNTHETIC');
  const detail=await send('/b2b/v1/history/documents/'+history.recordId+q,history.auth.token,'SERVICE');expect(detail.status).toBe(200);expect(detail.body.data).not.toHaveProperty('artifactKeys');
  const artifact=history.row.snapshot.artifacts[0].kind,file=await send('/b2b/v1/history/documents/'+history.recordId+'/artifacts/'+artifact+q,history.auth.token,'SERVICE');expect(file.status).toBe(200);expect(createHash('sha256').update(file.bytes).digest('hex')).toBe(file.headers['x-content-sha256']);
 });
 it('public SDK validates actual history records and downloads exact originals through both mTLS boundaries',async()=>{
  const sdk=new FactuEzB2bClient({origin:'https://127.0.0.1:'+port,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer:async()=>({token:history.auth.token,actorKind:'SERVICE'})});
  const page=await sdk.listHistory(history.binding);expect(page.data.items.some(x=>x.recordId===history.recordId)).toBe(true);
  const detail=await sdk.readHistoricalDocument(history.binding,history.recordId);expect(detail.cdrAuthenticityVerified).toBe(false);
  const artifact=history.row.snapshot.artifacts[0],download=await sdk.downloadHistoricalArtifact(history.binding,history.recordId,artifact.kind);
  expect(createHash('sha256').update(download.bytes).digest('hex')).toBe(artifact.sha256);
 });
 it('requires the separate live human step-up for application administration',async()=>{
  const r=await send('/b2b/v1/admin/applications?environment=BETA','human-step-up','USER','POST',applicationInput(),undefined);expect(r.status).toBe(201);expect(r.body.clientSecret).toHaveLength(43);expect(r.body.application).not.toHaveProperty('secretHash');
  expect((await send('/b2b/v1/admin/applications?environment=BETA','synthetic-token')).status).toBe(403);
 });
 it('rejects incomplete and cross-scope queries, extra identities and oversized mutation intent',async()=>{
  expect((await send('/b2b/v1/customers?environment=BETA')).status).toBe(400);
  expect((await send('/b2b/v1/customers'+query({...business.b,issuerRuc:'00000000099'}))).status).toBe(404);
  expect((await send('/b2b/v1/customers'+query(business.b),undefined,undefined,'POST',{...customer(),binding:business.b},randomUUID())).status).toBe(400);
 });
});
