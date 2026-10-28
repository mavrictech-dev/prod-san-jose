import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {request} from 'node:https';
import {B2bOperationalControl,type B2bOperationalOptions} from '../services/b2b-api-service/src/operational-control';
import {createB2bPhase9Application} from '../services/b2b-api-service/src/phase9-application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {B2bReceivedReads} from '../services/b2b-api-service/src/received';
import {B2bPhase8Reports} from '../services/b2b-api-service/src/phase8-reports';
import {reportsSourcesFixture} from './b2b-phase8-reports-sources.fixture';
import {FactuEzB2bClient} from '../packages/b2b-sdk/src';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
let tls:ReturnType<typeof b2bCertificates>;
beforeAll(()=>{tls=b2bCertificates();},30000);
const filters={issuerId:1,environment:'BETA' as const,from:'2026-01-01',to:'2026-01-02',types:['07','08','NV'] as ('07'|'08'|'NV')[]};
const settle=()=>new Promise<void>(r=>setImmediate(r));
async function start(f:ReturnType<typeof reportsSourcesFixture>,options:B2bOperationalOptions={enabled:true},before?:(action:string)=>Promise<void>){
 const control=new B2bOperationalControl({current:async()=>({environment:'BETA',revision:1,mode:'OPEN',expiresAt:new Date(Date.now()+60000).toISOString()})},options);
 const actual=f.core(),unused={execute:vi.fn(async()=>{throw new Error('UNBOUND_SYNTHETIC_OWNER');}),file:vi.fn(async()=>{throw new Error('UNBOUND_SYNTHETIC_OWNER');}),content:vi.fn(async()=>{throw new Error('UNBOUND_SYNTHETIC_OWNER');})};
 const reports=new B2bPhase8Reports(f.identity,{execute:async(a,action,input)=>{await before?.(action);return actual.execute(a,action,input);},content:(a,input)=>actual.execute(a,'CONTENT',input) as any});
 const app=await createB2bPhase9Application({read:new B2bReads(f.identity,unused,unused),commands:new B2bCommands(f.identity,unused),
  peers:[fingerprint(tls.edge)],tls:{ca:tls.ca,cert:tls.server,key:tls.key},operations:control,
  phase8:{received:new B2bReceivedReads(f.identity,unused),reports}} as any);
 await app.listen(0,'127.0.0.1');const port=app.getHttpServer().address().port;
 const sdk=new FactuEzB2bClient({origin:'https://127.0.0.1:'+port,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer:async()=>({actorKind:'SERVICE',token:'synthetic-report-token'})});
 async function raw(path:string,cert:Buffer|null=tls.edge,headers:Record<string,string>={}){
  return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
   const req=request({host:'127.0.0.1',port,path,ca:tls.ca,cert:cert??undefined,key:cert?tls.key:undefined,rejectUnauthorized:true,agent:false,
    headers:{Authorization:'Bearer synthetic-report-token','X-FactuEz-Actor-Kind':'SERVICE',...headers}},res=>{
    const bytes:Buffer[]=[];res.on('data',b=>bytes.push(b));res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(bytes).toString()),headers:res.headers});}catch(e){reject(e);}});res.on('error',reject);
   });req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('SYNTHETIC_HTTP_TIMEOUT')));req.end();
  });
 }
 return {app,control,sdk,raw,port,unused};
}
describe('B2B-09 real private HTTPS listener + SDK + owner report engine; synthetic storage',()=>{
 it('runs reports/CSV through operational composition, then pauses without exposing an HTTP control endpoint',async()=>{
  const f=reportsSourcesFixture(),x=await start(f);
  try{
   const job=await x.sdk.createReport(filters,'CSV',{idempotencyKey:'operational_sdk_report_0001'});
   expect(job.data.state).toBe('READY');
   const download=await x.sdk.downloadReport(job.data.id);expect(download.bytes.toString()).toContain('signedPayableAmount');
   expect(x.control.snapshot().metrics.some(m=>m.family==='reports'&&m.statusClass==='2xx')).toBe(true);
   expect((await x.raw('/internal/metrics')).status).toBe(404);expect((await x.raw('/b2b/v1/operations/pause')).status).not.toBe(200);
   x.control.pause();await expect(x.sdk.dashboard(filters)).rejects.toMatchObject({code:'REMOTE_REQUEST_FAILED',status:503});
   const response=await x.raw('/b2b/v1/dashboard?environment=BETA',tls.edge,{'X-Request-Id':'PRIVATE_CALLER_ID'});
   expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);expect(response.body.code).toBe('OWNER_UNAVAILABLE');
   expect(JSON.stringify(x.control.snapshot())).not.toContain('PRIVATE_CALLER_ID');expect(f.store.jobs.size).toBe(1);
  }finally{await x.control.drain(1000);await x.app.close();}
 });
 it('TLS and current owner grants still reject access while operational policy is OPEN',async()=>{
  const f=reportsSourcesFixture(),x=await start(f);
  try{
   await expect(x.raw('/b2b/v1/dashboard',null)).rejects.toThrow();
   expect((await x.raw('/b2b/v1/dashboard',tls.other)).status).toBe(403);
   f.control.revoked=true;await expect(x.sdk.dashboard(filters)).rejects.toMatchObject({status:403});
   expect(f.store.jobs.size).toBe(0);
  }finally{await x.control.drain(1000);await x.app.close();}
 });
 it('aggregate overload is 429 without additional owner queries or grant changes',async()=>{
  const f=reportsSourcesFixture(),x=await start(f,{enabled:true,requestsPerMinute:1});
  try{await x.sdk.dashboard(filters);const captures=f.sourceStore.capture.mock.calls.length;
   await expect(x.sdk.dashboard(filters)).rejects.toMatchObject({status:429});expect(f.sourceStore.capture.mock.calls.length).toBe(captures);
   expect(x.control.snapshot().metrics.some(m=>m.outcome==='THROTTLED')).toBe(true);
  }finally{await x.control.drain(1000);await x.app.close();}
 });
 it('disconnected mutation remains in-flight until actual commit; retry after reconstruction replays the same job',async()=>{
  const f=reportsSourcesFixture();let release!:()=>void,entered!:()=>void;
  const barrier=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const x=await start(f,{enabled:true,maxConcurrent:1},async action=>{if(action==='CREATE'){entered();await barrier;}});
  const key='operational_lost_response_001',body=Buffer.from(JSON.stringify({filters:{...filters,issuerId:'1',types:filters.types.join(',')},format:'CSV'}));let req:ReturnType<typeof request>|undefined;
  try{
   req=request({host:'127.0.0.1',port:x.port,path:'/b2b/v1/report-jobs?environment=BETA',method:'POST',ca:tls.ca,cert:tls.edge,key:tls.key,agent:false,
    headers:{Authorization:'Bearer synthetic-report-token','X-FactuEz-Actor-Kind':'SERVICE','Idempotency-Key':key,'Content-Type':'application/json','Content-Length':String(body.length)}},res=>res.resume());
   req.on('error',()=>{});req.end(body);await started;req.destroy();await settle();
   expect(x.control.snapshot().active).toBe(1);await expect(x.sdk.dashboard(filters)).rejects.toMatchObject({status:429});
   expect(await x.control.drain(0)).toEqual({state:'DRAINING',pending:1});release();
   expect(await x.control.drain(3000)).toEqual({state:'DRAINED',pending:0});expect(f.store.jobs.size).toBe(1);
   const id=[...f.store.jobs.keys()][0];await x.app.close();
   const restored=await start(f);
   try{const replay=await restored.sdk.createReport(filters,'CSV',{idempotencyKey:key});expect(replay.replayed).toBe(true);expect(replay.data.id).toBe(id);expect(f.store.jobs.size).toBe(1);}
   finally{await restored.control.drain(1000);await restored.app.close();}
  }finally{release();req?.destroy();await x.control.drain(3000);await x.app.close();}
 });
 it('disabled composition calls neither Identity nor owners and adds no route or public enable switch',async()=>{
  const f=reportsSourcesFixture(),x=await start(f,{});
  try{await expect(x.sdk.dashboard(filters)).rejects.toMatchObject({status:503});expect(f.identity.authenticate).not.toHaveBeenCalled();expect(x.unused.execute).not.toHaveBeenCalled();expect(x.control.snapshot().state).toBe('DISABLED');}
  finally{await x.app.close();}
 });
});
