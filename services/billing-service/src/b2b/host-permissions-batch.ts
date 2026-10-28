import { AsyncLocalStorage } from 'node:async_hooks';
import type { B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { validB2bPrincipal, type B2bIdentityScope } from '@factuez/contracts/b2b-security';
import type { BillingBatchOperations } from './batch-member-http';
import type { BatchMemberIdentityPort } from './batch-member-postgres.types';
import { billingDigest, billingPermissionFailure, billingSnapshot } from './host-permissions-wire';

type BatchAccess={token:string;kind:'USER'|'SERVICE'};
type BatchContext={current:BatchMemberIdentityPort['current'];close():void};
type BatchCore=Pick<BillingBatchOperations,'execute'|'artifactOwner'|'artifactOwnerById'>;
/** Reuses Identity's existing authenticated /internal/b2b/introspect over B2bIdentityHttp.
 * No new endpoint, subject-only approval, token persistence or inferred member grant. */
export class BillingBatchCurrentIdentity {
  #context=new AsyncLocalStorage<BatchContext>();#identity:B2bIdentityPort;#enabled:boolean;#closed=false;
  constructor(identity:B2bIdentityPort,options:{enabled?:boolean}={}){this.#identity=identity;this.#enabled=options.enabled===true;}
  #open(){if(!this.#enabled||this.#closed)return billingPermissionFailure();}
  readonly memberIdentity:BatchMemberIdentityPort={current:async(subject,asOf)=>{
    this.#open();const context=this.#context.getStore();if(!context)return billingPermissionFailure(403);
    return context.current(billingSnapshot(subject),asOf);
  }};
  async #run<T>(access:BatchAccess,scope:B2bIdentityScope,work:(access:BatchAccess)=>Promise<T>):Promise<T>{
    this.#open();if(this.#context.getStore())return billingPermissionFailure(403);
    const a=billingSnapshot(access);
    if(!a||Object.keys(a).sort().join(',')!=='kind,token'||!['USER','SERVICE'].includes(a.kind)||typeof a.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(a.token))return billingPermissionFailure(401);
    let token:string|null=a.token,stamp:string|null=null;const deadline=Date.now()+30000;
    const context:BatchContext={close:()=>{token=null;},current:async(subject,asOf)=>{
      this.#open();if(token===null||Date.now()>=deadline)return billingPermissionFailure(401);
      if(typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf))||Math.abs(Date.now()-Date.parse(asOf))>30000)return billingPermissionFailure(400);
      let value:unknown;try{value=await this.#identity.authenticate(token,[scope],a.kind);}catch{return billingPermissionFailure();}
      const p=billingSnapshot(value);
      if(!validB2bPrincipal(p)||p.kind!==a.kind||!p.scopes.includes(scope)||!subject||Object.keys(subject).sort().join(',')!=='clientId,kind,subjectId'||
          subject.kind!==p.kind||subject.clientId!==p.clientId||subject.subjectId!==p.subjectId)return billingPermissionFailure(403);
      const revision=billingDigest(p);if(stamp!==null&&stamp!==revision)return billingPermissionFailure(401);stamp=revision;
      this.#open();if(token===null||Date.now()>=deadline||Math.abs(Date.now()-Date.parse(asOf))>30000)return billingPermissionFailure(401);
      return {subject:billingSnapshot(subject),clientRevision:p.revision,userAuthRevision:p.userAuthRevision,checkedAt:new Date().toISOString()};
    }};
    try{return await this.#context.run(context,()=>work(a));}finally{context.close();}
  }
  /** Core MUST use memberIdentity above; every HTTP/signer entry must use this wrapper. */
  wrap(core:BatchCore):BatchCore {
    return {
      execute:async(token,kind,action,value)=>{
        if(!['PREPARE','RECOVER'].includes(action))return billingPermissionFailure(400);
        const v=billingSnapshot(value);return this.#run({token,kind},action==='PREPARE'?'b2b:batches:write':'b2b:batches:read',a=>core.execute(a.token,a.kind,action,v));
      },
      artifactOwner:async(token,kind,value,permission)=>{
        if(!['READ','WRITE'].includes(permission))return billingPermissionFailure(400);
        const v=billingSnapshot(value);return this.#run({token,kind},permission==='WRITE'?'b2b:batches:write':'b2b:batches:read',a=>core.artifactOwner(a.token,a.kind,v,permission));
      },
      artifactOwnerById:async(token,kind,value,permission)=>{
        if(!['READ','WRITE'].includes(permission))return billingPermissionFailure(400);
        const v=billingSnapshot(value);return this.#run({token,kind},permission==='WRITE'?'b2b:batches:write':'b2b:batches:read',a=>core.artifactOwnerById(a.token,a.kind,v,permission));
      },
    };
  }
  close(){this.#closed=true;}
  toJSON(){return {service:'BillingBatchCurrentIdentity',contents:'PRIVATE'};}
}

