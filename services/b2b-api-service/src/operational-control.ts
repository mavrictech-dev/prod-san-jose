import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {inspect,types} from 'node:util';
import {from,lastValueFrom} from 'rxjs';
import type {CallHandler,ExecutionContext,NestInterceptor} from '@nestjs/common';
import type {NestExpressApplication} from '@nestjs/platform-express';

export type B2bOperationalPolicy={environment:'BETA';revision:number;mode:'OPEN'|'PAUSED';expiresAt:string};
/** Infrastructure control only. This policy NEVER grants an application access
 * to a document, RUC, role or operation; current owner authorization still runs. */
export interface B2bOperationalPolicyPort {current():Promise<B2bOperationalPolicy>}
export type B2bOperationalOptions={enabled?:boolean;maxConcurrent?:number;requestsPerMinute?:number;policyTimeoutMs?:number};
type Reason='COMPLETED'|'CLIENT_ABORTED'|'PAUSED'|'DISABLED'|'DRAINING'|'POLICY_UNAVAILABLE'|'SATURATED'|'THROTTLED';
type Family='context'|'documents'|'drafts'|'guides'|'batches'|'received'|'reports'|'catalog'|'business'|'administration'|'webhooks'|'history'|'other';
type Metric={family:Family;method:'GET'|'POST'|'PATCH'|'OTHER';statusClass:string;outcome:Reason;count:number;durationBuckets:number[]};
type Ticket={id:string;req:any;res:any;started:number;family:Family;method:Metric['method'];reason:Reason;reserved:boolean;
 policyDone:boolean;controllerStarted:boolean;controllerDone:boolean;httpDone:boolean;done:boolean};
const SLOT=Symbol('B2b operational admission'),BUCKETS=[25,100,500,2000,10000] as const;
const increment=(n:number)=>Math.min(Number.MAX_SAFE_INTEGER,n+1);
const integer=(n:unknown,min:number,max:number)=>Number.isSafeInteger(n)&&Number(n)>=min&&Number(n)<=max;
function family(url:unknown):Family{
 if(typeof url!=='string'||url.length>8192)return 'other';
 const path=url.split('?')[0];
 if(!/^\/b2b\/v1\/[a-z-]+(?:\/|$)/.test(path))return 'other';
 const head=path.split('/')[3];
 if(['me','capabilities'].includes(head))return 'context';
 if(head==='admin')return 'administration';
 if(head==='history')return 'history';
 if(head.startsWith('received-'))return 'received';
 if(head==='dashboard'||head==='report-jobs')return 'reports';
 if(head.startsWith('webhook-'))return 'webhooks';
 if(head.includes('guide'))return 'guides';
 if(head.startsWith('batch'))return 'batches';
 if(head==='document-drafts')return 'drafts';
 if(['documents','operations','exports','changes'].includes(head))return 'documents';
 if(['issuers','branches','points','series','products'].includes(head))return 'catalog';
 if(['customers','business-products','shifts','business-summary','sales-notes','correction-requests','correction-notes'].includes(head))return 'business';
 return 'other';
}

/** Per-process, bounded admission and metrics. No public control/metrics route,
 * raw paths, request bodies, tokens, identities, fiscal values or sink logging.
 * Instantiate explicitly for a private BETA listener, never an existing stack. */
export class B2bOperationalControl{
 #enabled:boolean;#policy:B2bOperationalPolicyPort;#limit:number;#rate:number;#timeout:number;
 #active=0;#paused=false;#draining=false;#installed=false;#revision=0;#policyBlocked=true;#policyMode:'OPEN'|'PAUSED'='PAUSED';#expires=0;
 #window=performance.now();#used=0;#metrics=new Map<string,Metric>();#waiters=new Set<()=>void>();
 constructor(policy:B2bOperationalPolicyPort,options:B2bOperationalOptions={}){
  if(!policy||typeof policy.current!=='function'||!options||types.isProxy(options)||Object.getOwnPropertySymbols(options).length||Object.values(Object.getOwnPropertyDescriptors(options)).some(d=>!('value'in d))||Object.keys(options).some(k=>!['enabled','maxConcurrent','requestsPerMinute','policyTimeoutMs'].includes(k))||
   options.enabled!==undefined&&typeof options.enabled!=='boolean'||!integer(options.maxConcurrent??8,1,16)||!integer(options.requestsPerMinute??120,1,600)||!integer(options.policyTimeoutMs??1000,25,5000))throw new Error('INVALID_B2B_OPERATIONAL_CONFIGURATION');
  this.#policy=policy;this.#enabled=options.enabled===true;this.#limit=options.maxConcurrent??8;this.#rate=options.requestsPerMinute??120;this.#timeout=options.policyTimeoutMs??1000;
 }
 /** One-way local pause. Re-opening requires explicit new composition; neither
  * an HTTP caller nor a later OPEN policy can reverse a local emergency stop. */
 pause(){this.#paused=true;}
 async drain(timeoutMs=30000):Promise<{state:'DRAINED'|'DRAINING';pending:number}>{
  if(!integer(timeoutMs,0,60000))throw new Error('INVALID_B2B_DRAIN_TIMEOUT');
  this.#draining=true;
  if(this.#active&&timeoutMs)await new Promise<void>(resolve=>{
   const finish=()=>{clearTimeout(timer);this.#waiters.delete(finish);resolve();};
   const timer=setTimeout(finish,timeoutMs);this.#waiters.add(finish);
  });
  return {state:this.#active?'DRAINING':'DRAINED',pending:this.#active};
 }
 snapshot(){
  return {schemaVersion:'factuez.b2b.operational.v1',environment:'BETA' as const,fiscalActivation:false,
   state:!this.#enabled?'DISABLED':this.#draining?'DRAINING':this.#paused?'PAUSED':this.#policyBlocked||this.#expires<=Date.now()?'POLICY_BLOCKED':this.#policyMode==='PAUSED'?'PAUSED':'SERVING',
   policyRevision:this.#revision,active:this.#active,limits:{maxConcurrent:this.#limit,requestsPerMinute:this.#rate,policyTimeoutMs:this.#timeout},
   // Noncumulative latency bins: <=25, <=100, <=500, <=2000, <=10000, >10000 ms.
   latencyBoundsMs:[...BUCKETS],metrics:[...this.#metrics.values()].map(m=>({...m,durationBuckets:[...m.durationBuckets]}))};
 }
 toJSON(){return this.snapshot();}
 [inspect.custom](){return this.snapshot();}
 install(app:NestExpressApplication){
  if(this.#installed||!app||typeof app.use!=='function'||typeof app.useGlobalInterceptors!=='function')throw new Error('B2B_OPERATIONAL_SINGLE_LISTENER_REQUIRED');
  this.#installed=true;
  const server=app.getHttpServer();
  // Body/header/keepalive deadlines do not cancel a business commit or free a
  // handler slot. RPC deadlines and idempotency remain owner responsibilities.
  server.headersTimeout=10000;server.requestTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=100;server.maxConnections=64;
  app.use((req:any,res:any,next:()=>void)=>{
   const t:Ticket={id:randomUUID(),req,res,started:performance.now(),family:family(req.url),method:['GET','POST','PATCH'].includes(req.method)?req.method:'OTHER',reason:'COMPLETED',
    reserved:false,policyDone:true,controllerStarted:false,controllerDone:false,httpDone:false,done:false};
   req[SLOT]=t;res.setHeader('X-Request-Id',t.id);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
   res.once('finish',()=>{t.httpDone=true;this.#release(t);});
   res.once('close',()=>{t.httpDone=true;if(!res.writableFinished)t.reason='CLIENT_ABORTED';this.#release(t);});
   void this.#admit(t,next).catch(()=>this.#deny(t,503,'POLICY_UNAVAILABLE'));
  });
  const control=this;
  app.useGlobalInterceptors(new class implements NestInterceptor{
   intercept(context:ExecutionContext,next:CallHandler){
    const t:Ticket=context.switchToHttp().getRequest()[SLOT];
    if(!t||!t.reserved)throw new Error('B2B_OPERATIONAL_ADMISSION_REQUIRED');
    t.controllerStarted=true;
    // Own the subscription until the controller promise actually completes.
    // A disconnected HTTP client must not release a still-running owner write.
    const completion=lastValueFrom(next.handle()).finally(()=>{t.controllerDone=true;control.#release(t);});
    return from(completion);
   }
  }());
 }
 #blocked():Reason|null{return !this.#enabled?'DISABLED':this.#draining?'DRAINING':this.#paused?'PAUSED':null;}
 async #admit(t:Ticket,next:()=>void){
  const blocked=this.#blocked();if(blocked)return this.#deny(t,503,blocked);
  const now=performance.now();if(now-this.#window>=60000){this.#window=now;this.#used=0;}
  if(this.#used>=this.#rate)return this.#deny(t,429,'THROTTLED');this.#used++;
  if(this.#active>=this.#limit)return this.#deny(t,429,'SATURATED');
  t.reserved=true;t.policyDone=false;this.#active++;
  // A timed-out policy lookup retains its reservation until it really settles.
  // A hung port therefore closes admission instead of spawning unbounded work.
  const pending=Promise.resolve().then(()=>this.#policy.current());
  void pending.then(()=>{t.policyDone=true;this.#release(t);},()=>{t.policyDone=true;this.#release(t);});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const p=await Promise.race([pending,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('POLICY_TIMEOUT')),this.#timeout);})]);
   if(!p||types.isProxy(p)||Object.getPrototypeOf(p)!==Object.prototype||Reflect.ownKeys(p).length!==4||Object.keys(p).sort().join(',')!=='environment,expiresAt,mode,revision'||Object.values(Object.getOwnPropertyDescriptors(p)).some(d=>!('value'in d))||
    p.environment!=='BETA'||!integer(p.revision,1,2147483647)||p.revision<this.#revision||p.revision===this.#revision&&p.mode!==this.#policyMode||!['OPEN','PAUSED'].includes(p.mode)||typeof p.expiresAt!=='string'||!Number.isFinite(Date.parse(p.expiresAt))||
    new Date(p.expiresAt).toISOString()!==p.expiresAt||Date.parse(p.expiresAt)<=Date.now()||Date.parse(p.expiresAt)>Date.now()+300000)throw new Error('INVALID_B2B_OPERATIONAL_POLICY');
   this.#revision=p.revision;this.#policyMode=p.mode;this.#expires=Date.parse(p.expiresAt);this.#policyBlocked=false;
   const changed=this.#blocked();if(changed)return this.#deny(t,503,changed);
   if(p.mode==='PAUSED')return this.#deny(t,503,'PAUSED');
   if(!t.httpDone&&!t.res.destroyed)next();
  }catch{this.#policyBlocked=true;this.#deny(t,503,'POLICY_UNAVAILABLE');}
  finally{clearTimeout(timer);}
 }
 #deny(t:Ticket,status:number,reason:Reason){
  t.reason=reason;
  if(t.res.destroyed||t.httpDone){this.#release(t);return;}
  t.res.setHeader('Retry-After',status===429?'60':'5');
  t.res.status(status).json({schemaVersion:'factuez.b2b.v1',requestId:t.id,code:status===429?'RATE_LIMITED':'OWNER_UNAVAILABLE',message:status===429?'RATE_LIMITED':'OWNER_UNAVAILABLE',retryable:true});
 }
 #release(t:Ticket){
  if(t.done||!t.httpDone||!t.policyDone||t.controllerStarted&&!t.controllerDone)return;
  t.done=true;
  if(t.reserved){this.#active--;if(!this.#active)for(const finish of [...this.#waiters])finish();}
  const status=t.res.statusCode,className=Number.isInteger(status)&&status>=100&&status<=599?String(Math.floor(status/100))+'xx':'other';
  const key=[t.family,t.method,className,t.reason].join('/');
  let m=this.#metrics.get(key);
  if(!m){m={family:t.family,method:t.method,statusClass:className,outcome:t.reason,count:0,durationBuckets:Array(6).fill(0)};this.#metrics.set(key,m);}
  m.count=increment(m.count);const elapsed=Math.max(0,performance.now()-t.started),index=BUCKETS.findIndex(b=>elapsed<=b),bin=index<0?5:index;
  m.durationBuckets[bin]=increment(m.durationBuckets[bin]);
 }
}
