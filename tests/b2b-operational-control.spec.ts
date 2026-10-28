import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {from,lastValueFrom} from '../services/b2b-api-service/node_modules/rxjs';
import {B2bOperationalControl,type B2bOperationalOptions,type B2bOperationalPolicy} from '../services/b2b-api-service/src/operational-control';
const open=():B2bOperationalPolicy=>({environment:'BETA',revision:1,mode:'OPEN',expiresAt:new Date(Date.now()+60000).toISOString()});
const tick=()=>new Promise<void>(r=>setImmediate(r));
function fixture(options:B2bOperationalOptions={enabled:true},policy=vi.fn(async()=>open())){
 const control=new B2bOperationalControl({current:policy},options);let middleware:any,interceptor:any;
 const server:any={},app:any={getHttpServer:()=>server,use:(fn:any)=>{middleware=fn;},useGlobalInterceptors:(i:any)=>{interceptor=i;}};control.install(app);
 function send(url='/b2b/v1/documents?token=PRIVATE_QUERY',method='GET',handler?:()=>Promise<any>){
  const req:any={url,method,headers:{authorization:'Bearer PRIVATE',cookie:'SECRET',body:'PRIVATE_XML'}};
  const res:any=new EventEmitter();res.headers={};res.statusCode=200;res.destroyed=false;res.writableFinished=false;
  res.setHeader=(k:string,v:any)=>{res.headers[k]=v;};res.status=(s:number)=>{res.statusCode=s;return res;};
  res.json=(b:any)=>{res.body=b;res.writableFinished=true;res.emit('finish');return res;};
  const next=vi.fn(()=>{if(handler)void lastValueFrom(interceptor.intercept({switchToHttp:()=>({getRequest:()=>req})},{handle:()=>from(handler())})).then((x:any)=>{if(!res.destroyed)res.json(x);},()=>{if(!res.destroyed)res.status(503).json({code:'OWNER_UNAVAILABLE'});});});
  middleware(req,res,next);return {req,res,next,abort:()=>{res.destroyed=true;res.emit('close');}};
 }
 return {control,policy,send,server,app};
}
describe('B2B-09 operational admission; no environment, DB, network or grants',()=>{
 it('is disabled by default and never calls the policy or a controller',async()=>{
  const f=fixture({});const q=f.send();await tick();expect(q.res.statusCode).toBe(503);expect(q.next).not.toHaveBeenCalled();expect(f.policy).not.toHaveBeenCalled();expect(f.control.snapshot().state).toBe('DISABLED');
 });
 it('requires a valid live BETA policy, emits a fresh request ID and stores only finite metric labels',async()=>{
  const f=fixture(),q=f.send('/b2b/v1/documents/PRIVATE_RUC?certificate=PRIVATE');await tick();expect(q.next).toHaveBeenCalledOnce();
  q.res.json({ok:true});expect(f.control.snapshot()).toMatchObject({state:'SERVING',active:0,policyRevision:1});
  expect(q.res.headers['X-Request-Id']).toMatch(/^[a-f0-9-]{36}$/);const text=JSON.stringify(f.control);
  for(const forbidden of ['PRIVATE','Bearer','cookie','certificate','SECRET','url','headers'])expect(text).not.toContain(forbidden);
  expect(f.control.snapshot().metrics[0]).toMatchObject({family:'documents',method:'GET',statusClass:'2xx',count:1,outcome:'COMPLETED'});
  const copy=f.control.snapshot();copy.metrics[0].durationBuckets[0]=999;expect(f.control.snapshot().metrics[0].durationBuckets[0]).not.toBe(999);
 });
 it.each([
  ['production',()=>({...open(),environment:'PRODUCTION'})],['expired',()=>({...open(),expiresAt:new Date(Date.now()-1).toISOString()})],
  ['too long',()=>({...open(),expiresAt:new Date(Date.now()+600000).toISOString()})],['zero revision',()=>({...open(),revision:0})],
  ['extra secret',()=>({...open(),secret:'PRIVATE'})],['malformed time',()=>({...open(),expiresAt:'tomorrow'})],
  ['accessor',()=>Object.defineProperty(open(),'mode',{enumerable:true,get(){throw new Error('PRIVATE');}})],
 ])('fails closed on %s policy without exposing its response',async(_label,make)=>{
  const f=fixture({enabled:true},vi.fn(async()=>make() as any)),q=f.send();await tick();expect(q.res.statusCode).toBe(503);expect(q.next).not.toHaveBeenCalled();expect(JSON.stringify(q.res.body)).not.toContain('PRIVATE');expect(f.control.snapshot()).toMatchObject({active:0,state:'POLICY_BLOCKED'});
 });
 it('requires monotonically revised mode changes and recovers only from a valid newer policy',async()=>{
  let p=open();const f=fixture({enabled:true},vi.fn(async()=>p));f.send(undefined,undefined,async()=>({}));await tick();
  p={...open(),mode:'PAUSED',revision:2};const paused=f.send();await tick();expect(paused.res.statusCode).toBe(503);expect(f.control.snapshot().state).toBe('PAUSED');
  p={...open(),revision:1};const old=f.send();await tick();expect(old.res.statusCode).toBe(503);
  p={...open(),revision:2};const tampered=f.send();await tick();expect(tampered.res.statusCode).toBe(503);
  p={...open(),revision:3};const recovered=f.send(undefined,undefined,async()=>({ok:true}));await tick();expect(recovered.res.statusCode).toBe(200);expect(recovered.res.body.ok).toBe(true);
 });
 it('holds a concurrency slot after HTTP abort until the owner promise really finishes',async()=>{
  let complete!:(v:any)=>void;const work=new Promise(r=>{complete=r;}),f=fixture({enabled:true,maxConcurrent:1});
  const first=f.send(undefined,undefined,()=>work);await tick();first.abort();expect(f.control.snapshot().active).toBe(1);
  const busy=f.send();await tick();expect(busy.res.statusCode).toBe(429);expect(busy.next).not.toHaveBeenCalled();
  expect(await f.control.drain(0)).toEqual({state:'DRAINING',pending:1});complete({committed:true});await tick();expect(await f.control.drain(0)).toEqual({state:'DRAINED',pending:0});
  expect(f.control.snapshot().metrics.some(m=>m.outcome==='CLIENT_ABORTED')).toBe(true);
 });
 it('a timed-out policy holds its reservation until settling and cannot admit a late controller',async()=>{
  let finish!:(v:any)=>void;const pending=new Promise<B2bOperationalPolicy>(r=>{finish=r;}),f=fixture({enabled:true,maxConcurrent:1,policyTimeoutMs:25},vi.fn(()=>pending));
  const first=f.send();await new Promise(r=>setTimeout(r,50));expect(first.res.statusCode).toBe(503);expect(f.control.snapshot().active).toBe(1);
  const busy=f.send();await tick();expect(busy.res.statusCode).toBe(429);expect(f.policy).toHaveBeenCalledOnce();finish(open());await tick();expect(first.next).not.toHaveBeenCalled();expect(f.control.snapshot().active).toBe(0);
 });
 it('local pause overrides an OPEN response in flight and cannot be reversed by remote policy',async()=>{
  let finish!:(v:any)=>void;const f=fixture({enabled:true},vi.fn(()=>new Promise(r=>{finish=r;}))),q=f.send();await tick();f.control.pause();finish(open());await tick();
  expect(q.res.statusCode).toBe(503);expect(q.next).not.toHaveBeenCalled();const again=f.send();await tick();expect(again.next).not.toHaveBeenCalled();expect(f.policy).toHaveBeenCalledOnce();
 });
 it('drain waits for committed work, rejects new requests and returns an explicit timeout without cancelling',async()=>{
  let finish!:(v:any)=>void;const f=fixture(),q=f.send(undefined,undefined,()=>new Promise(r=>{finish=r;}));await tick();
  expect(await f.control.drain(1)).toEqual({state:'DRAINING',pending:1});const closed=f.send();await tick();expect(closed.res.statusCode).toBe(503);
  const waiting=f.control.drain(1000);finish({committed:true});expect(await waiting).toEqual({state:'DRAINED',pending:0});expect(q.res.body).toEqual({committed:true});
 });
 it('applies aggregate rate limits before policy calls, with no IP/header bypass',async()=>{
  const f=fixture({enabled:true,requestsPerMinute:1});f.send(undefined,undefined,async()=>({}));await tick();const q=f.send();await tick();expect(q.res.statusCode).toBe(429);expect(q.res.headers['Retry-After']).toBe('60');expect(f.policy).toHaveBeenCalledOnce();
 });
 it('saturation includes policy lookups and rejected/unknown routes have finite metric labels',async()=>{
  const f=fixture();for(let i=0;i<20;i++)f.send('/b2b/v1/arbitrary'+i+'/PRIVATE', 'DELETE',async()=>({}));await tick();
  expect(f.control.snapshot().metrics.every(m=>m.family==='other'&&m.method==='OTHER')).toBe(true);expect(f.control.snapshot().metrics.length).toBeLessThan(5);
 });
 it('installs only once with finite HTTP budgets and validates options/drain limits',async()=>{
  const f=fixture();expect(f.server).toMatchObject({headersTimeout:10000,requestTimeout:15000,maxConnections:64});expect(()=>f.control.install(f.app)).toThrow('SINGLE_LISTENER');
  for(const options of [{maxConcurrent:17},{requestsPerMinute:0},{policyTimeoutMs:1},{enabled:'true'},{environment:'PRODUCTION'}])expect(()=>new B2bOperationalControl({current:async()=>open()},options as any)).toThrow();
  await expect(f.control.drain(60001)).rejects.toThrow();
 });
});
