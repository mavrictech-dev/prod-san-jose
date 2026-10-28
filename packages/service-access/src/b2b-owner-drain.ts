import type {CallHandler,ExecutionContext,NestInterceptor} from '@nestjs/common';
import {from,lastValueFrom} from 'rxjs';
import {inspect} from 'node:util';
type Kind='COMMAND'|'INTERNAL_EVENT'|'READ';
type Ticket={kind:Kind;httpDone:boolean;aborted:boolean;started:boolean;completed:boolean;released:boolean};
const slot=Symbol('Owner lifetime admission');
const authReads=new Set(['/internal/b2b/introspect','/internal/b2b/runtime-status','/internal/b2b/context','/internal/b2b/validate-bindings',
 '/internal/b2b/validate-correction-bindings','/internal/b2b/authorize-correction','/internal/b2b/validate-guide-bindings','/internal/b2b/authorize-guide',
 '/internal/b2b/validate-guide-issue-bindings','/internal/b2b/authorize-guide-issue','/internal/b2b/authorize-webhook',
 '/internal/b2b/read','/internal/b2b/correction-evidence-authorize',
 '/internal/b2b/owner-authority/authorize','/internal/b2b/owner-authority/live-human','/internal/b2b/owner-authority/status',
 '/internal/b2b/received-stepup/verify','/internal/b2b/carrier-reference-validation','/internal/b2b/authorize-email-actor','/internal/b2b/billing-authority']);
function kind(req:any):Kind {
 const path=typeof req.url==='string'?req.url.split('?')[0]:'';
 if(['GET','HEAD','OPTIONS'].includes(req.method)||req.method==='POST'&&authReads.has(path))return 'READ';
 if(req.method==='POST'&&path==='/internal/b2b/webhook-events')return 'INTERNAL_EVENT';return 'COMMAND';
}
/** Shared lifetime gate installed BEFORE app.init/listen. Does not authorize any
 * operation. Read-side Identity remains available while producers/workers drain.
 * A disconnected client does not cancel the independently owned controller. */
export class B2bOwnerDrain {
 #mode:'OPEN'|'COMMANDS_PAUSED'|'CLOSED'='OPEN';#installed=false;#tickets=new Set<Ticket>();#waiters=new Set<()=>void>();
 #completed=0;#aborted=0;#rejected=0;
 constructor(private readonly options:{enabled?:boolean;maxConcurrent?:number}={}){
  if(options.enabled!==undefined&&typeof options.enabled!=='boolean'||!Number.isInteger(options.maxConcurrent??32)||(options.maxConcurrent??32)<1||(options.maxConcurrent??32)>64)throw Error('INVALID_OWNER_DRAIN_CONFIGURATION');
 }
 pauseCommands(){this.#mode=this.#mode==='CLOSED'?'CLOSED':'COMMANDS_PAUSED';}
 closeAdmission(){this.#mode='CLOSED';}
 install(app:{use(fn:(req:any,res:any,next:()=>void)=>void):unknown;useGlobalInterceptors(...interceptors:NestInterceptor[]):unknown}){
  if(this.options.enabled!==true||this.#installed)throw Error('OWNER_DRAIN_NOT_INSTALLABLE');this.#installed=true;
  app.use((req,res,next)=>{
   const classification=kind(req);
   if(this.#mode==='CLOSED'||this.#mode==='COMMANDS_PAUSED'&&classification==='COMMAND'||this.#tickets.size>=(this.options.maxConcurrent??32)){
    this.#rejected++;res.setHeader('Cache-Control','private, no-store');res.setHeader('Retry-After','5');return res.status(503).json({code:'OWNER_MAINTENANCE',retryable:true});
   }
   const t:Ticket={kind:classification,httpDone:false,aborted:false,started:false,completed:false,released:false};req[slot]=t;this.#tickets.add(t);
   res.once('finish',()=>{t.httpDone=true;this.release(t,true);});
   res.once('close',()=>{t.httpDone=true;t.aborted=!res.writableFinished;if(t.aborted)this.#aborted++;this.release(t,false);});next();
  });
  const gate=this;
  app.useGlobalInterceptors(new class implements NestInterceptor{
   intercept(context:ExecutionContext,next:CallHandler){
    const t:Ticket=context.switchToHttp().getRequest()[slot];if(!t||t.released)throw Error('OWNER_DRAIN_ADMISSION_REQUIRED');t.started=true;
    const completion=lastValueFrom(next.handle()).finally(()=>{t.completed=true;gate.release(t,false);});return from(completion);
   }
  }());
 }
 private release(t:Ticket,pipelineFinished:boolean){
  if(t.released||!t.httpDone||t.started&&!t.completed||!t.started&&!pipelineFinished)return;
  // If a client disconnects while an async guard has not completed, keep the
  // ticket until the interceptor proves completion; never guess cancellation.
  t.released=true;this.#tickets.delete(t);this.#completed++;for(const done of [...this.#waiters])done();
 }
 private pending(which:'COMMANDS'|'MUTATIONS'|'ALL'){
  return [...this.#tickets].filter(t=>which==='ALL'||which==='COMMANDS'&&t.kind==='COMMAND'||which==='MUTATIONS'&&t.kind!=='READ').length;
 }
 async drain(which:'COMMANDS'|'MUTATIONS'|'ALL',timeoutMs=30000){
  if(this.options.enabled!==true||!['COMMANDS','MUTATIONS','ALL'].includes(which)||!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>60000)throw Error('INVALID_OWNER_DRAIN_REQUEST');
  if(which==='ALL'&&this.#mode!=='CLOSED'||which!=='ALL'&&this.#mode==='OPEN')throw Error('OWNER_ADMISSION_STILL_OPEN');
  if(this.pending(which)&&timeoutMs)await new Promise<void>(resolve=>{
   const done=()=>{if(this.pending(which))return;clearTimeout(timer);this.#waiters.delete(done);resolve();},timer=setTimeout(()=>{this.#waiters.delete(done);resolve();},timeoutMs);this.#waiters.add(done);
  });const pending=this.pending(which);return {state:pending?'DRAINING':'DRAINED',pending};
 }
 snapshot(){return {schemaVersion:'factuez.b2b.owner-drain.v1',state:this.options.enabled===true?this.#mode:'DISABLED',active:this.#tickets.size,
  commands:this.pending('COMMANDS'),mutations:this.pending('MUTATIONS'),uncertainGuards:[...this.#tickets].filter(t=>t.aborted&&!t.started).length,
  completed:this.#completed,aborted:this.#aborted,rejected:this.#rejected};}
 toJSON(){return this.snapshot();}[inspect.custom](){return this.snapshot();}
}
