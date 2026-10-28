import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createServer,request,type Server} from 'node:https';
import {describe,it,expect,vi} from 'vitest';
import {B2bEmailDeliveries,emailHash} from '../services/mailer-worker/src/b2b/email-deliveries';
import {PostgresEmailDeliveryStore} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import {B2bSecurityError} from '../services/mailer-worker/src/b2b/email-deliveries.security';
import {createB2bEmailDeliveriesHandler,HttpB2bEmailDeliveries,B2B_EMAIL_DELIVERIES_RPC} from '../services/mailer-worker/src/b2b/email-deliveries.http';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {B2bEmailDeliveryOperations,HttpEmailDeliveryOwner} from '../services/b2b-api-service/src/email-deliveries';
import {createB2bDraftApplication} from '../services/b2b-api-service/src/draft-application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {B2bReceivedReads} from '../services/b2b-api-service/src/received';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
import type {B2bPrincipal,B2bBinding,EmailDeliveryDocument} from '../services/mailer-worker/src/b2b/email-deliveries.types';
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return 'https://127.0.0.1:'+(server.address() as {port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
describe('email HTTP/mTLS isolated current owner',()=>{
 it('uses fixed RPC shared HTTP, rawBody and public paths with actual PostgreSQL worker; rejects adversarial calls',async()=>{
 const pki=b2bCertificates(),{withEmailDatabase}=createRequire(import.meta.url)('./b2b-email-deliveries-db.runner.cjs');
 await withEmailDatabase(async({pool}:any)=>{
 const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
 const docId=randomUUID(),proof=emailHash('synthetic-source-proof');
 let p:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,
 scopes:['b2b:email:send','b2b:email:read','b2b:documents:read'],bindings:[binding],environment:'BETA'};
 const identity={authenticate:vi.fn(async()=>structuredClone(p))};
 const d:EmailDeliveryDocument={binding,documentId:docId,sourceProofSha256:proof,presentationRevision:'p1',attachments:[
 ['PDF','application/pdf','pdf','CURRENT_GENERATED'],['XML','application/xml','xml','IMMUTABLE_ORIGINAL'],['CDR','application/zip','zip','IMMUTABLE_ORIGINAL']
 ].map(([kind,mediaType,ext,representation])=>{const bytes=Buffer.from('SYNTHETIC-'+kind);return {kind,mediaType,fileName:'synthetic.'+ext,representation,bytes,sha256:emailHash(bytes),binding,documentId:docId,sourceProofSha256:proof};}) as any};
 const source={authorizeDocumentCurrent:vi.fn(async()=>structuredClone(d))};
 const capture={profile:'LOCAL_CAPTURE' as const,capture:vi.fn(async()=>({state:'CAPTURED_LOCAL' as const}))};
 const store=new PostgresEmailDeliveryStore(pool,{enabled:true}),engine=new B2bEmailDeliveries(store,identity,source,capture,{enabled:true,profile:'LOCAL_CAPTURE'});
 const peers=[fingerprint(pki.edge)],ownerHandler=createB2bEmailDeliveriesHandler(engine,peers,'OWNER_RPC');
 const options={ca:pki.ca,cert:pki.server,key:pki.key,requestCert:true,rejectUnauthorized:true};
 const owner=createServer(options,async(req,res)=>{
  // Simulate a contextual app's raw-body parser, with an explicit bound. No req.body shortcut.
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>16384){res.statusCode=413;res.end();return;}chunks.push(Buffer.from(chunk));}
  (req as any).rawBody=Buffer.concat(chunks);
  if(!await ownerHandler(req,res)){res.statusCode=404;res.end();}
 });
 const ownerOrigin=await listen(owner),tls={ca:pki.ca,cert:pki.edge,key:pki.key};
 const shared=new B2bPrivateHttp(ownerOrigin,tls),direct=new HttpB2bEmailDeliveries(ownerOrigin,tls);
 const facade={execute:async(a:any,action:any,input:any)=>{
  const v:any=await shared.post(B2B_EMAIL_DELIVERIES_RPC,{kind:a.kind,action,input},a.token);
  if(v?.error)throw new B2bSecurityError(v.error.status,v.error.code);return v;
 }};
 const publicHandler=createB2bEmailDeliveriesHandler(facade,peers,'PUBLIC');
 const gateway=createServer(options,async(req,res)=>{if(!await publicHandler(req,res)){res.statusCode=404;res.end();}});
 const publicOrigin=await listen(gateway);
 async function call(origin:string,path:string,method:string,value?:unknown,headers:Record<string,string>|string[]={},cert:Buffer|null=pki.edge){
  const bytes=value===undefined?Buffer.alloc(0):Buffer.from(typeof value==='string'?value:JSON.stringify(value));
  const base:Record<string,string>={Host:new URL(origin).host,Authorization:'Bearer synthetic-email-token','X-FactuEz-Actor-Kind':'SERVICE','Content-Type':'application/json',...(bytes.length?{'Content-Length':String(bytes.length)}:{})};
  return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
   const req=request(origin+path,{method,agent:false,ca:pki.ca,...(cert?{cert,key:pki.key}:{}),rejectUnauthorized:true,
    headers:Array.isArray(headers)?[...Object.entries(base).flat(),...headers]:{...base,...headers}},res=>{
    const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{
     const text=Buffer.concat(chunks).toString();let body:any=null;try{body=text?JSON.parse(text):null;}catch{body=text;}
     resolve({status:res.statusCode!,body,headers:res.headers});
    });res.on('error',reject);
   });req.on('error',reject);req.end(bytes);
  });
 }
 let mainApp:any;
 try{
  expect((await call(publicOrigin,'//[','GET')).status).toBe(400);
  const idem=randomUUID(),payload={binding,recipient:'synthetic@example.invalid',format:'ticket'};
  const created=await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST',payload,{'Idempotency-Key':idem});
  expect(created.status).toBe(202);expect(created.body).toMatchObject({state:'QUEUED',format:'ticket',profile:'LOCAL_CAPTURE',fiscalAuthority:false,deliveredToClient:false});
  expect(created.headers['cache-control']).toBe('private, no-store');expect(JSON.stringify(created.body)).not.toContain(payload.recipient);
  const jobId=created.body.id;
  expect((await call(publicOrigin,'/b2b/v1/documents/'+docId+'/email-deliveries?environment=BETA','POST',payload,{'Idempotency-Key':idem})).body).toMatchObject({id:jobId,replayed:true});
  expect(await direct.execute({kind:'SERVICE',token:'synthetic-email-token'},'READ',{id:jobId})).toMatchObject({id:jobId});
  expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET')).body).toMatchObject({id:jobId});
  expect(capture.capture).not.toHaveBeenCalled();
  expect(await engine.run(jobId,{freshIdentity:async()=>structuredClone(p)})).toMatchObject({state:'CAPTURED_LOCAL'});
  expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET')).body).toMatchObject({state:'CAPTURED_LOCAL'});
  expect(capture.capture).toHaveBeenCalledTimes(1);
  const absent:any={execute:async()=>{throw new Error('UNCONFIGURED');},file:async()=>{throw new Error('UNCONFIGURED');}};
  mainApp=await createB2bDraftApplication(new B2bReads(identity,absent,absent),new B2bCommands(identity,absent),peers,{ca:pki.ca,cert:pki.server,key:pki.key},undefined,undefined,undefined,undefined,undefined,undefined,undefined,
    {received:new B2bReceivedReads(identity,absent),email:new B2bEmailDeliveryOperations(identity,new HttpEmailDeliveryOwner(shared))});
  await mainApp.listen(0,'127.0.0.1');const mainOrigin='https://127.0.0.1:'+mainApp.getHttpServer().address().port;
  const throughMain=await call(mainOrigin,'/b2b/v1/documents/'+docId+'/email-deliveries','POST',payload,{'Idempotency-Key':idem});
  expect(throughMain.status).toBe(202);expect(throughMain.body).toMatchObject({id:jobId,replayed:true,state:'CAPTURED_LOCAL',deliveredToClient:false});
  expect((await call(mainOrigin,'/b2b/v1/email-deliveries/'+jobId,'GET')).body).toMatchObject({id:jobId,state:'CAPTURED_LOCAL'});
  const sdk=new FactuEzB2bClient({origin:mainOrigin,tls:{ca:pki.ca,cert:pki.edge,key:pki.key,serverCertificateSha256:fingerprint(pki.server)},bearer:async()=>({token:'synthetic-email-token',actorKind:'SERVICE'})});
  expect(await sdk.requestDocumentEmail(binding,docId,{recipient:payload.recipient,format:'ticket'},{idempotencyKey:idem})).toMatchObject({id:jobId,replayed:true,state:'CAPTURED_LOCAL',deliveredToClient:false});
  expect(await sdk.readEmailDelivery(jobId)).toMatchObject({id:jobId,state:'CAPTURED_LOCAL'});
  const conflicted=await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST',{...payload,recipient:'other@example.invalid'},{'Idempotency-Key':idem});
  expect(conflicted).toMatchObject({status:409,body:{error:{code:'IDEMPOTENCY_CONFLICT'}}});
  const denied=await shared.post(B2B_EMAIL_DELIVERIES_RPC,{kind:'SERVICE',action:'RUN',input:{id:jobId}},'synthetic-email-token');
  expect(denied).toEqual({error:{status:400,code:'INVALID_REQUEST'}});
  await expect(direct.execute({kind:'SERVICE',token:'synthetic-email-token'},'READ',{id:randomUUID()})).rejects.toMatchObject({status:404,code:'RESOURCE_NOT_FOUND'});
  expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET',undefined,{},pki.other)).status).toBe(403);
  await expect(call(publicOrigin,'/email-deliveries/'+jobId,'GET',undefined,{},null)).rejects.toThrow();
  expect((await call(publicOrigin,'/email-deliveries/'+jobId+'?environment=BETA&environment=BETA','GET')).status).toBe(400);
  expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET',undefined,['X-Duplicate','1','x-duplicate','2'])).status).toBe(401);
  expect((await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST',{...payload,transport:'SMTP'},{'Idempotency-Key':randomUUID()})).status).toBe(400);
  expect((await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST',payload,{'Idempotency-Key':randomUUID(),'Content-Type':'text/plain'})).status).toBe(400);
  expect((await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST','{invalid',{'Idempotency-Key':randomUUID()})).status).toBe(400);
  expect((await call(publicOrigin,'/documents/'+docId+'/email-deliveries','POST',{...payload,recipient:'a'.repeat(17000)},{'Idempotency-Key':randomUUID()})).status).toBe(400);
  expect((await call(publicOrigin,'/internal/b2b/email-deliveries','POST',{action:'RUN'})).status).toBe(404);
  expect((await call(ownerOrigin,B2B_EMAIL_DELIVERIES_RPC+'?environment=BETA','POST',{kind:'SERVICE',action:'READ',input:{id:jobId}})).body).toEqual({error:{status:400,code:'INVALID_REQUEST'}});
  p={...p,clientId:randomUUID()};expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET')).status).toBe(404);
  expect((await call(mainOrigin,'/b2b/v1/email-deliveries/'+jobId,'GET')).status).toBe(404);
  p.scopes=['b2b:documents:read'];expect((await call(publicOrigin,'/email-deliveries/'+jobId,'GET')).status).toBe(401);
  expect((await pool.query('SELECT count(*)::int AS count FROM "B2bEmailDeliveryJob"')).rows[0].count).toBe(1);
 }finally{await mainApp?.close();await close(gateway);await close(owner);await store.close();}
 });
 },60000);
 it('rejects unsafe client origins and empty peer allowlists before network',()=>{
 for(const origin of ['http://localhost','https://user:pass@localhost','https://localhost/x','https://localhost/?x=1']){
 expect(()=>new HttpB2bEmailDeliveries(origin,{ca:Buffer.alloc(0),cert:Buffer.alloc(0),key:Buffer.alloc(0)})).toThrow('INVALID_REQUEST');}
 expect(()=>createB2bEmailDeliveriesHandler({execute:vi.fn()},[],'OWNER_RPC')).toThrow('INVALID_REQUEST');
 });
});

