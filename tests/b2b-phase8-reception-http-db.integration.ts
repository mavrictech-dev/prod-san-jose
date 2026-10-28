import 'reflect-metadata';
import {it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {request} from 'node:https';
import {Module} from '../services/received-documents-service/node_modules/@nestjs/common';
import {NestFactory} from '../services/received-documents-service/node_modules/@nestjs/core';
import {B2bReceptionCommandModule} from '../services/received-documents-service/src/b2b/command-http';
import {B2bReceptionReadModule} from '../services/received-documents-service/src/b2b/http';
import {B2bReceptionAutomationOwnerModule} from '../services/received-documents-service/src/b2b/automation-http';
import {B2bReceivedAutomation,HttpReceptionAutomation} from '../services/b2b-api-service/src/received-automation';
import {fixture as automationFixture,scope as automationScope,access as automationAccess,stepUpHandle,localSettings} from './helpers/b2b-received-automation.fixture';
import {B2bReceptionReads} from '../services/received-documents-service/src/b2b/read';
import {PostgresReceivedReadStore} from '../services/received-documents-service/src/b2b/store';
import {B2bReceivedReads,HttpB2bReceivedOwner} from '../services/b2b-api-service/src/received';
import {B2bReceivedCommands,HttpReceptionCommands} from '../services/b2b-api-service/src/received-commands';
import {createB2bDraftApplication} from '../services/b2b-api-service/src/draft-application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {fixture,scope,access,file} from './helpers/b2b-received-commands.fixture';
import {receivedXml} from './received-fixture.mjs';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
const require=createRequire(import.meta.url),{withReceivedCommandsDatabase}=require('./helpers/b2b-received-commands-db.cjs');
class ReceptionHttpOwners{}Module({})(ReceptionHttpOwners);
it('consumer mTLS → explicit factory → reception mTLS → NEW PostgreSQL: import, replay, detail and exact original',async()=>{
 await withReceivedCommandsDatabase(async({client:db,pool}:any)=>{
  const f=fixture(db);f.principal.scopes.push('b2b:received:read','b2b:received:artifacts:read');await f.grant('IMPORT');
  const reads=new B2bReceptionReads(new PostgresReceivedReadStore(db),f.identity,f.admin);
  for(const permission of ['READ','ARTIFACT'])await reads.setGrant('synthetic-live-step-up',{scope,subject:{kind:'SERVICE',clientId:f.principal.clientId,subjectId:null},permission,active:true,clientRevision:f.principal.revision,userAuthRevision:null},0);
  const tls=b2bCertificates(),peer=[fingerprint(tls.resource)],options={ca:tls.ca,cert:tls.server,key:tls.key};let owner:any,app:any;
  try{
   owner=await NestFactory.create({module:ReceptionHttpOwners,imports:[B2bReceptionCommandModule.isolated(f.owner,peer),B2bReceptionReadModule.isolated(reads,peer)]},{logger:false,bodyParser:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'}});
   owner.useBodyParser('json',{limit:128*1024,strict:true});await owner.listen(0,'127.0.0.1');
   const http=new B2bPrivateHttp(`https://127.0.0.1:${owner.getHttpServer().address().port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});const absent:any={execute:async()=>{throw new Error('UNCONFIGURED');},file:async()=>{throw new Error('UNCONFIGURED');}};
   app=await createB2bDraftApplication(new B2bReads(f.identity,absent,absent),new B2bCommands(f.identity,absent),[fingerprint(tls.edge)],options,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{received:new B2bReceivedReads(f.identity,new HttpB2bReceivedOwner(http)),receivedCommands:new B2bReceivedCommands(f.identity,new HttpReceptionCommands(http))});
   await app.listen(0,'127.0.0.1');const port=app.getHttpServer().address().port,q='?'+new URLSearchParams(Object.entries(scope).map(([k,v])=>[k,String(v)]));
   const send=(path:string,method='GET',body?:unknown)=>new Promise<any>((resolve,reject)=>{
    const b=body===undefined?undefined:Buffer.from(JSON.stringify(body));const r=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls.edge,key:tls.key,rejectUnauthorized:true,headers:{Authorization:'Bearer '+access.token,'X-FactuEz-Actor-Kind':'SERVICE',...(b?{'Content-Type':'application/json','Content-Length':String(b.length),'Idempotency-Key':'synthetic_http_received_00001'}:{})}},s=>{const parts:Buffer[]=[];s.on('data',c=>parts.push(c));s.on('end',()=>{const bytes=Buffer.concat(parts);try{resolve({status:s.statusCode,bytes,body:String(s.headers['content-type']).startsWith('application/json')?JSON.parse(bytes.toString()):null});}catch(e){reject(e);}});});r.on('error',reject);r.end(b);
   });
   const xml=Buffer.from(receivedXml('01')),imported=await send('/b2b/v1/received-documents'+q,'POST',file(xml));expect(imported.status).toBe(201);const id=imported.body.result.documentId;
   expect((await send('/b2b/v1/received-documents'+q,'POST',file(xml))).body.result.documentId).toBe(id);
   const detail=await send('/b2b/v1/received-documents/'+id+q);expect(detail.status).toBe(200);expect(detail.body.projection.items).toHaveLength(1);
   const a=detail.body.artifacts.find((v:any)=>v.kind==='XML'),original=await send('/b2b/v1/received-documents/'+id+'/artifacts/'+a.id+'/content'+q);expect(original.status).toBe(200);expect(original.bytes).toEqual(xml);
   expect(Number((await pool.query('SELECT count(*) AS n FROM "B2bReceivedCommand"')).rows[0].n)).toBe(1);
   expect(Number((await pool.query('SELECT count(*) AS n FROM "Document"')).rows[0].n)).toBe(0);
  }finally{await app?.close();await owner?.close();}
 });
},90000);

it('automation public API → private mTLS → NEW PostgreSQL: revision, idempotency, staged jobs and revocation',async()=>{
 const {withReceivedAutomationDatabase}=require('./helpers/b2b-received-automation-db.cjs');
 await withReceivedAutomationDatabase(async({client:db,pool}:any)=>{
  const f=automationFixture(db);for(const a of ['CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ'] as const)await f.grant(a);
  const tls=b2bCertificates(),options={ca:tls.ca,cert:tls.server,key:tls.key};let owner:any,app:any;
  try{
   owner=await NestFactory.create(B2bReceptionAutomationOwnerModule.isolated(f.owner,[fingerprint(tls.resource)]),{logger:false,bodyParser:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'}});
   owner.useBodyParser('json',{limit:128*1024,strict:true});await owner.listen(0,'127.0.0.1');
   const http=new B2bPrivateHttp('https://127.0.0.1:'+owner.getHttpServer().address().port,{ca:tls.ca,cert:tls.resource,key:tls.key});
   const absent:any={execute:async()=>{throw new Error('UNCONFIGURED');},file:async()=>{throw new Error('UNCONFIGURED');}};
   app=await createB2bDraftApplication(new B2bReads(f.identity,absent,absent),new B2bCommands(f.identity,absent),[fingerprint(tls.edge)],options,undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {received:new B2bReceivedReads(f.identity,absent),automation:new B2bReceivedAutomation(f.identity,new HttpReceptionAutomation(http))});
   await app.listen(0,'127.0.0.1');const port=app.getHttpServer().address().port,q='?'+new URLSearchParams(Object.entries(automationScope).map(([k,v])=>[k,String(v)]));
   const send=(path:string,method='GET',body?:unknown,proof:string|null=stepUpHandle,key='synthetic_automation_http_0001')=>new Promise<any>((resolve,reject)=>{
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));const r=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls.edge,key:tls.key,rejectUnauthorized:true,headers:{Authorization:'Bearer '+automationAccess.token,'X-FactuEz-Actor-Kind':'USER',...(proof?{'X-FactuEz-Step-Up':proof}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length),'Idempotency-Key':key}:{})}},s=>{
     const parts:Buffer[]=[];s.on('data',c=>parts.push(c));s.on('end',()=>{try{resolve({status:s.statusCode,body:JSON.parse(Buffer.concat(parts).toString()),headers:s.headers});}catch(e){reject(e);}});s.on('error',reject);
    });r.on('error',reject);r.end(bytes);
   });
   const path='/b2b/v1/admin/received-connectors/1'+q;
   const sdk=new FactuEzB2bClient({origin:'https://127.0.0.1:'+port,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer:async()=>({token:automationAccess.token,actorKind:'USER'})});
   const empty=await send(path);expect(empty.status).toBe(200);expect(empty.body).toMatchObject({revision:0,runtimeEnabled:false});
   const body={expectedRevision:0,settings:localSettings(),credentials:{mailPassword:'SYNTHETIC_PRIVATE_MAIL'}};
   const saved=await send(path,'PATCH',body);expect(saved.status).toBe(200);expect(saved.body).toMatchObject({revision:1,credentialPresence:{mailPassword:true},runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'});
   expect(JSON.stringify(saved.body)).not.toContain('SYNTHETIC_PRIVATE_MAIL');
   expect(await sdk.readReceptionConfiguration(automationScope,{stepUpHandle})).toMatchObject({revision:1,runtimeEnabled:false});
   expect(await sdk.saveReceptionConfiguration(automationScope,body,{stepUpHandle,idempotencyKey:'synthetic_automation_http_0001'})).toMatchObject({revision:1,credentialPresence:{mailPassword:true}});
   expect((await send(path,'PATCH',body)).body.revision).toBe(1);
   const conflict=await send(path,'PATCH',{...body,expectedRevision:0},stepUpHandle,'synthetic_automation_http_0002');expect(conflict.status).toBe(409);
   expect((await send(path,'GET',undefined,null)).status).toBe(400);
   expect((await send('/b2b/v1/admin/received-connectors/2'+q)).status).toBe(404);
   expect((await send(path,'PATCH',{...body,stepUpHandle})).status).toBe(400);
   const sync=await sdk.createReceptionSync(automationScope,{source:'ALL',expectedRevision:1},{stepUpHandle,idempotencyKey:'synthetic_automation_http_0003'});
   expect(sync.items).toHaveLength(2);expect(sync.items.every(j=>j.status==='QUEUED'&&j.dispatch==='NOT_DISPATCHED')).toBe(true);
   expect(await sdk.readReceptionSync(automationScope,sync.items[0].runId,{stepUpHandle})).toMatchObject({run:{status:'QUEUED'}});
   const read=await send('/b2b/v1/received-sync-jobs/'+sync.items[0].runId+q);expect(read.status).toBe(200);expect(read.body.run.status).toBe('QUEUED');expect(read.headers['cache-control']).toBe('private, no-store');
   expect((await pool.query('SELECT enabled FROM "ReceptionConnection"')).rows[0].enabled).toBe(false);
   f.control.revoked=true;expect((await send(path)).status).toBe(403);
  }finally{await app?.close();await owner?.close();}
 });
},90000);
