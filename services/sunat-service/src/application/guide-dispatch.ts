import {randomUUID} from 'node:crypto';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {appendGuideDispatch,rebuildGuideDispatch,validateGuideDispatchKey,validateGuideDispatchManifest,GuideDispatchError,
  type GuideDispatchKey,type GuideDispatchManifest,type GuideDispatchChange} from '@factuez/sunat-core/dist/guide-dispatch-journal';
import type {GuideDispatchEmulator,GuideDispatchOwner,GuideDispatchRecord,GuideDispatchStore,GuideDispatchTransaction} from './guide-dispatch-types';

function fail(code:string):never{throw new GuideDispatchError(code);}
function copy(value:unknown):any{try{return boundedSupplementJson(value);}catch{return fail('INVALID_GUIDE_DISPATCH_RESPONSE');}}
const hash=fiscalSnapshotSha256;
function ticket(value:unknown):string{
  const v=copy(value);if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).join(',')!=='ticket'||typeof v.ticket!=='string'||/^[A-Za-z0-9_-]{1,100}$/.exec(v.ticket)?.[0]!==v.ticket)fail('INVALID_GUIDE_DISPATCH_RESPONSE');return v.ticket;
}
/** Candidate coordinator with an explicit LOCAL emulator, not the official GRE
 * adapter or a fiscal producer. Intention commits BEFORE submit. Losing a reply
 * never grants another submit, even if the same queue job runs again. */
export class GuideDispatchCoordinator{
  constructor(private readonly store:GuideDispatchStore,private readonly owner:GuideDispatchOwner,private readonly emulator:GuideDispatchEmulator,
    private readonly now=()=>new Date().toISOString(),private readonly timeoutMs=10000){
    this.local();if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new Error('Bounded local emulator timeout required');
  }
  private local(){if(!this.emulator||this.emulator.mode!=='ISOLATED_LOCAL_EMULATOR'||!['submit','findTicket','poll'].every(k=>typeof (this.emulator as any)[k]==='function'))fail('LOCAL_GUIDE_EMULATOR_REQUIRED');}
  private async call<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    this.local();const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new GuideDispatchError('LOCAL_GUIDE_EMULATOR_TIMEOUT'));},this.timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  private async source(key:GuideDispatchKey){
    let raw;try{raw=await this.owner.current(copy(key));}catch{fail('GUIDE_DISPATCH_OWNER_UNAVAILABLE');}
    if(raw===null)fail('GUIDE_DISPATCH_SOURCE_NOT_FOUND');
    let m:GuideDispatchManifest;try{m=validateGuideDispatchManifest(raw);}catch{fail('INVALID_GUIDE_DISPATCH_OWNER');}
    if(hash(m.key)!==hash(key))fail('INVALID_GUIDE_DISPATCH_OWNER');return m;
  }
  private async fresh(manifest:GuideDispatchManifest){if(hash(await this.source(manifest.key))!==hash(manifest))fail('GUIDE_DISPATCH_OWNER_CHANGED');}
  private checked(record:GuideDispatchRecord|null,manifest:GuideDispatchManifest):GuideDispatchRecord{
    if(!record)fail('GUIDE_DISPATCH_NOT_FOUND');
    const r=copy(record);if(Object.keys(r).sort().join(',')!=='events,manifest'||hash(validateGuideDispatchManifest(r.manifest))!==hash(manifest))fail('GUIDE_DISPATCH_SOURCE_CHANGED');
    const p=rebuildGuideDispatch(r.manifest,r.events);if(p.revision===0)fail('GUIDE_DISPATCH_HISTORY_INCONSISTENT');return r;
  }
  private view(record:GuideDispatchRecord){
    const m=record.manifest,p=rebuildGuideDispatch(m,record.events);
    return{schemaVersion:'factuez.guide-dispatch.v1',key:copy(m.key),documentId:m.documentId,guideType:m.guideType,fullNumber:m.fullNumber,
      ...p,requiresReconciliation:['INTENT_RECORDED','UNCERTAIN'].includes(p.state)};
  }
  private async append(tx:GuideDispatchTransaction,r:GuideDispatchRecord,c:GuideDispatchChange){
    const next=appendGuideDispatch(r.manifest,r.events,c,this.now());await tx.append(next,r.events.length);r.events.push(next);return r;
  }
  private async record(manifest:GuideDispatchManifest,c:GuideDispatchChange){
    return this.store.transaction(manifest.key,async tx=>{
      await this.fresh(manifest);const r=this.checked(await tx.read(),manifest),p=rebuildGuideDispatch(manifest,r.events);
      // Replies can be late/repeated. Never overwrite a ticket/receipt or regress
      // a completed query when another worker returns an older PENDING reply.
      if(c.kind==='NO_RESPONSE'&&p.attemptId===c.data.attemptId&&['UNCERTAIN','TICKET_RECEIVED','RESULT_PENDING_VERIFICATION'].includes(p.state)){}
      else if(c.kind==='TICKET'&&p.attemptId===c.data.attemptId&&p.ticket===c.data.ticket&&['TICKET_RECEIVED','RESULT_PENDING_VERIFICATION'].includes(p.state)){}
      else if(c.kind==='POLL_PENDING'&&p.ticket===c.data.ticket&&p.state==='RESULT_PENDING_VERIFICATION'){}
      else if(c.kind==='POLL_RESULT'&&p.ticket===c.data.ticket&&p.state==='RESULT_PENDING_VERIFICATION'){
        if(p.receiptSha256!==c.data.receiptSha256)fail('GUIDE_DISPATCH_RESULT_CONFLICT');
      }else await this.append(tx,r,c);
      await this.fresh(manifest);return this.view(r);
    });
  }
  async status(keyInput:unknown){
    const key=validateGuideDispatchKey(keyInput),m=await this.source(key);
    return this.store.transaction(key,async tx=>{await this.fresh(m);const raw=await tx.read();if(raw===null){await this.fresh(m);return null;}
      const r=this.checked(raw,m);await this.fresh(m);return this.view(r);});
  }
  async dispatch(keyInput:unknown){
    this.local();
    const key=validateGuideDispatchKey(keyInput),m=await this.source(key);
    const started=await this.store.transaction(key,async tx=>{
      await this.fresh(m);let raw=await tx.read();
      if(raw===null){const first=appendGuideDispatch(m,[],{kind:'REGISTER',data:{manifestSha256:hash(m)}},this.now());await tx.register(m,first);raw={manifest:m,events:[first]};}
      const r=this.checked(raw,m),p=rebuildGuideDispatch(m,r.events);
      if(p.state!=='READY'){await this.fresh(m);return{attemptId:null,view:this.view(r)};}
      const attemptId=randomUUID();await this.append(tx,r,{kind:'ATTEMPT',data:{attemptId}});await this.fresh(m);
      return{attemptId,view:this.view(r)};
    });
    if(started.attemptId===null)return started.view;
    // If revocation occurs after the commit, keep the intent without submitting.
    // Recovery must reconcile it; never infer permission to send again.
    await this.fresh(m);let received:string;
    try{received=ticket(await this.call(signal=>this.emulator.submit(copy(m),started.attemptId!,signal)));}
    catch{return this.record(m,{kind:'NO_RESPONSE',data:{attemptId:started.attemptId}});}
    return this.record(m,{kind:'TICKET',data:{attemptId:started.attemptId,ticket:received}});
  }
  async reconcile(keyInput:unknown){
    this.local();
    const key=validateGuideDispatchKey(keyInput),m=await this.source(key);
    const current=await this.store.transaction(key,async tx=>{
      await this.fresh(m);const r=this.checked(await tx.read(),m),p=rebuildGuideDispatch(m,r.events);
      if(p.state==='INTENT_RECORDED')await this.append(tx,r,{kind:'NO_RESPONSE',data:{attemptId:p.attemptId!}});
      await this.fresh(m);return this.view(r);
    });
    if(current.state!=='UNCERTAIN')return current;
    await this.fresh(m);let found;
    try{found=await this.call(signal=>this.emulator.findTicket(copy(m),current.attemptId!,signal));}
    catch{fail('GUIDE_DISPATCH_RECONCILIATION_UNAVAILABLE');}
    if(found===null){await this.fresh(m);return (await this.status(key))!;}
    return this.record(m,{kind:'TICKET',data:{attemptId:current.attemptId!,ticket:ticket(found)}});
  }
  async poll(keyInput:unknown){
    this.local();
    const key=validateGuideDispatchKey(keyInput),m=await this.source(key);
    const current=await this.store.transaction(key,async tx=>{
      await this.fresh(m);const r=this.checked(await tx.read(),m),p=rebuildGuideDispatch(m,r.events);
      if(p.state==='RESULT_PENDING_VERIFICATION'){await this.fresh(m);return this.view(r);}
      if(p.state!=='TICKET_RECEIVED')fail('GUIDE_DISPATCH_TICKET_REQUIRED');
      if(p.revision>=128)fail('GUIDE_DISPATCH_HISTORY_LIMIT');await this.fresh(m);return this.view(r);
    });
    if(current.state==='RESULT_PENDING_VERIFICATION')return current;
    await this.fresh(m);let result;
    try{result=copy(await this.call(signal=>this.emulator.poll(copy(m),current.ticket!,signal)));}
    catch{fail('GUIDE_DISPATCH_POLL_UNAVAILABLE');}
    if(result?.state==='PENDING'&&Object.keys(result).join(',')==='state')return this.record(m,{kind:'POLL_PENDING',data:{ticket:current.ticket!}});
    if(result?.state==='RESULT'&&Object.keys(result).sort().join(',')==='receiptSha256,state'&&typeof result.receiptSha256==='string'&&/^[a-f0-9]{64}$/.exec(result.receiptSha256)?.[0]===result.receiptSha256)
      return this.record(m,{kind:'POLL_RESULT',data:{ticket:current.ticket!,receiptSha256:result.receiptSha256}});
    fail('INVALID_GUIDE_DISPATCH_RESPONSE');
  }
}
