import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {from,lastValueFrom} from '../services/b2b-api-service/node_modules/rxjs';
import {B2bOwnerDrain} from '../packages/service-access/src/b2b-owner-drain';
const deferred=()=>{let resolve!:(v?:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {promise,resolve};};
function fixture(){
 let middleware!:Function,interceptor:any;const gate=new B2bOwnerDrain({enabled:true}),app={use:(f:Function)=>{middleware=f;},useGlobalInterceptors:(i:any)=>{interceptor=i;}};gate.install(app as any);
 const admit=(method='POST',url='/api/v1/documents')=>{
  const req:any={method,url},res:any=new EventEmitter();res.writableFinished=false;res.setHeader=()=>{};res.status=(s:number)=>{res.statusCode=s;return res;};res.json=(v:any)=>{res.body=v;return res;};let admitted=false;middleware(req,res,()=>{admitted=true;});
  const execute=(work:Promise<unknown>)=>lastValueFrom(interceptor.intercept({switchToHttp:()=>({getRequest:()=>req})},{handle:()=>from(work)}));
  return {req,res,admitted,execute,finish:()=>{res.writableFinished=true;res.emit('finish');},abort:()=>{res.emit('close');}};
 };return {gate,admit};
}
describe('owner admission and complete controller lifetime across disconnects',()=>{
 it('blocks new commands while preserving private identity reads until all admission closes',async()=>{
  const f=fixture();f.gate.pauseCommands();expect(f.admit().res.statusCode).toBe(503);const read=f.admit('POST','/internal/b2b/introspect');expect(read.admitted).toBe(true);read.finish();
  const event=f.admit('POST','/internal/b2b/webhook-events');expect(event.admitted).toBe(true);event.finish();
  expect(await f.gate.drain('MUTATIONS',0)).toEqual({state:'DRAINED',pending:0});f.gate.closeAdmission();expect(f.admit('GET','/health').res.statusCode).toBe(503);
 });
 it('does not free a disconnected controller until its actual promise and journal finish',async()=>{
  const f=fixture(),request=f.admit(),work=deferred(),result=request.execute(work.promise);request.abort();f.gate.pauseCommands();
  expect(await f.gate.drain('COMMANDS',1)).toEqual({state:'DRAINING',pending:1});work.resolve('persisted');expect(await result).toBe('persisted');
  expect(await f.gate.drain('COMMANDS',0)).toEqual({state:'DRAINED',pending:0});
 });
 it('keeps evidence authorization and owner read RPCs available for in-flight workers, without admitting writes',()=>{
  const f=fixture();f.gate.pauseCommands();
  for(const path of ['/internal/b2b/read','/internal/b2b/correction-evidence-authorize','/internal/b2b/owner-authority/authorize',
    '/internal/b2b/owner-authority/live-human','/internal/b2b/owner-authority/status','/internal/b2b/received-stepup/verify','/internal/b2b/carrier-reference-validation','/internal/b2b/authorize-email-actor']){
   const read=f.admit('POST',path);expect(read.admitted).toBe(true);read.finish();
   expect(f.admit('POST',path+'/write').res.statusCode).toBe(503);
  }
  f.gate.closeAdmission();expect(f.admit('POST','/internal/b2b/read').res.statusCode).toBe(503);
 });
 it('cannot close storage on an early HTTP response while the controller is still writing',async()=>{
  const f=fixture(),request=f.admit(),work=deferred(),run=request.execute(work.promise);request.finish();f.gate.closeAdmission();expect((await f.gate.drain('ALL',1)).pending).toBe(1);
  work.resolve('done');await run;expect((await f.gate.drain('ALL',0)).pending).toBe(0);
 });
 it('holds an uncertain disconnected async guard instead of assuming rollback',async()=>{
  const f=fixture(),request=f.admit();request.abort();f.gate.closeAdmission();expect(f.gate.snapshot().uncertainGuards).toBe(1);expect((await f.gate.drain('ALL',1)).state).toBe('DRAINING');
  const actual=request.execute(Promise.resolve('guard eventually completed'));await actual;expect((await f.gate.drain('ALL',0)).state).toBe('DRAINED');
 });
 it('normal denied/404 pipelines release their ticket and errors stay observable',async()=>{
  const f=fixture(),absent=f.admit('GET','/absent');absent.finish();expect(f.gate.snapshot().active).toBe(0);
  const request=f.admit(),run=request.execute(Promise.reject(Error('SYNTHETIC_WRITE_FAILED')));await expect(run).rejects.toThrow('WRITE_FAILED');request.finish();expect(f.gate.snapshot().active).toBe(0);
 });
 it('enforces bounded concurrency, validates drain requests and has detached metadata',async()=>{
  let middleware!:Function;const gate=new B2bOwnerDrain({enabled:true,maxConcurrent:1});gate.install({use:f=>{middleware=f;},useGlobalInterceptors:()=>{}});
  const response=()=>Object.assign(new EventEmitter(),{setHeader:()=>{},status:function(n:number){(this as any).statusCode=n;return this;},json:()=>{}});
  middleware({method:'GET',url:'/'},response(),()=>{});const denied:any=response();middleware({method:'POST',url:'/'},denied,()=>{});expect(denied.statusCode).toBe(503);
  await expect(gate.drain('ALL',0)).rejects.toThrow('STILL_OPEN');gate.closeAdmission();await expect(gate.drain('ALL',60001)).rejects.toThrow('INVALID');
  const view=gate.snapshot();view.active=999;expect(gate.snapshot().active).toBe(1);expect(()=>new B2bOwnerDrain({maxConcurrent:65})).toThrow();expect(()=>new B2bOwnerDrain().install({} as any)).toThrow();
 });
});
