import {createHash,randomUUID} from 'node:crypto';
import {B2bSecurityError,b2bBindingKey,validB2bBinding} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {HookVault,HOOK_VAULT_MAX_CIPHERTEXT} from './crypto';
import type {HookStore,HookTx,Subscription} from './model';

const owner='vault-rotation',schemaVersion='factuez.hook-vault-rotation.v1';
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
const fail=()=>new B2bSecurityError(409,'VAULT_ROTATION_REJECTED');
function exact(v:unknown,keys:string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
function canonical(v:unknown):string{
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  if(v&&typeof v==='object')return '{'+Object.entries(v).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>JSON.stringify(key)+':'+canonical(value)).join(',')+'}';
  return JSON.stringify(v);
}
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
/** Includes client/user identity revisions and the complete BETA binding. No grants are inferred. */
export function hookVaultRotationIdentity(s:Pick<Subscription,'actor'|'binding'>){
  if(!validB2bBinding(s.binding))throw fail();
  return hash({actor:s.actor,binding:b2bBindingKey(s.binding)});
}
export interface HookVaultRotationPolicy {
  environment:'BETA';fromKeyVersion:string;toKeyVersion:string;
  /** Unix milliseconds; approved cutover evidence digest, supplied by private operator wiring. */
  cutoverAt:number;proofSha256:string;
}
export interface HookVaultRotationSelection {subscriptionId:string;expectedRevision:number;expectedIdentitySha256:string}
export interface HookVaultRotationBatch {policy:HookVaultRotationPolicy;subscriptions:readonly HookVaultRotationSelection[]}
export interface HookVaultRotationCommand extends HookVaultRotationBatch {commandKey:string;expectedPlanSha256:string}
export interface HookVaultRotationItem extends HookVaultRotationSelection {
  secretKeyVersion:string;previousSecretKeyVersion:string|null;beforeSha256:string;
}
export interface HookVaultRotationPlan {
  schemaVersion:string;policy:HookVaultRotationPolicy;items:HookVaultRotationItem[];snapshotSha256:string;
}
export interface HookVaultRotationResult extends HookVaultRotationPlan {afterSnapshotSha256:string}

/** Private maintenance adapter. Never wire to bearer/client endpoints or webhook manage grants. */
export class HookVaultRotation {
  #store:HookStore;
  #vault:HookVault;
  #enabled:boolean;
  #policy:HookVaultRotationPolicy|undefined;
  #now:()=>number;
  constructor(store:HookStore,vault:HookVault,options:{enabled?:boolean;policy?:HookVaultRotationPolicy}={},now=Date.now){
    this.#store=store;this.#vault=vault;this.#enabled=options.enabled===true;
    this.#policy=options.policy?structuredClone(options.policy):undefined;this.#now=now;
  }
  #batch(input:HookVaultRotationBatch,command=false):HookVaultRotationBatch {
    if(!this.#enabled)throw new B2bSecurityError(503,'VAULT_ROTATION_DISABLED');
    const keys=command?['policy','subscriptions','commandKey','expectedPlanSha256']:['policy','subscriptions'];
    if(!exact(input,keys))throw fail();
    const p=input.policy;
    if(!exact(p,['environment','fromKeyVersion','toKeyVersion','cutoverAt','proofSha256'])||p.environment!=='BETA'||!version(p.fromKeyVersion)||!version(p.toKeyVersion)||
      p.toKeyVersion==='legacy'||p.fromKeyVersion===p.toKeyVersion||!Number.isSafeInteger(p.cutoverAt)||p.cutoverAt<1||!hex(p.proofSha256)||
      !this.#policy||hash(p)!==hash(this.#policy))throw fail();
    const metadata=this.#vault.metadata();
    if(metadata.activeKeyVersion!==p.toKeyVersion)throw fail();
    if(!Array.isArray(input.subscriptions)||input.subscriptions.length<1||input.subscriptions.length>100)throw fail();
    const seen=new Set<string>();
    for(const item of input.subscriptions){
      if(!exact(item,['subscriptionId','expectedRevision','expectedIdentitySha256'])||!b2bUuid(item.subscriptionId)||seen.has(item.subscriptionId)||
        typeof item.expectedRevision!=='number'||!Number.isSafeInteger(item.expectedRevision)||item.expectedRevision<1||!hex(item.expectedIdentitySha256))throw fail();
      seen.add(item.subscriptionId);
    }
    return {policy:structuredClone(p),subscriptions:structuredClone(input.subscriptions).sort((a,b)=>a.subscriptionId.localeCompare(b.subscriptionId))};
  }
  async #read(tx:HookTx,batch:HookVaultRotationBatch){
    const rows:Subscription[]=[];
    for(const selected of batch.subscriptions){
      const s=await tx.sub(selected.subscriptionId);
      if(!s||s.id!==selected.subscriptionId||s.revision!==selected.expectedRevision||hookVaultRotationIdentity(s)!==selected.expectedIdentitySha256||
        typeof s.secret!=='string'||s.secret.length>HOOK_VAULT_MAX_CIPHERTEXT||s.previousSecret!==null&&(typeof s.previousSecret!=='string'||s.previousSecret.length>HOOK_VAULT_MAX_CIPHERTEXT))throw fail();
      rows.push(s);
    }
    return rows;
  }
  #prepare(rows:Subscription[],batch:HookVaultRotationBatch,rewrap:boolean){
    const items:HookVaultRotationItem[]=[],updated:Subscription[]=[];
    const legacyKeyVersion=this.#vault.metadata().legacyKeyVersion;
    const isSource=(v:string|null)=>v===batch.policy.fromKeyVersion||v==='legacy'&&legacyKeyVersion===batch.policy.fromKeyVersion;
    for(let i=0;i<rows.length;i++){
      const s=rows[i],current=this.#vault.ciphertextVersion(s.secret),previous=s.previousSecret===null?null:this.#vault.ciphertextVersion(s.previousSecret);
      if(![current,...(previous===null?[]:[previous])].every(v=>isSource(v)||v===batch.policy.toKeyVersion)||
        !isSource(current)&&!isSource(previous))throw fail();
      // Authenticate every present value, including expired previous secrets and target-version values.
      const secret=this.#vault.open(s.secret,s.id),old=s.previousSecret===null?null:this.#vault.open(s.previousSecret,s.id);
      items.push({...batch.subscriptions[i],secretKeyVersion:current,previousSecretKeyVersion:previous,beforeSha256:hash(s)});
      if(rewrap)updated.push({...s,secret:isSource(current)?this.#vault.seal(secret,s.id):s.secret,
        previousSecret:old===null?null:isSource(previous)?this.#vault.seal(old,s.id):s.previousSecret});
    }
    const plan:HookVaultRotationPlan={schemaVersion,policy:batch.policy,items,snapshotSha256:hash({schemaVersion,policy:batch.policy,items})};
    return {plan,updated};
  }
  /** Authenticated dry plan; returns hashes and versions only, never plaintext/ciphertext bodies. */
  async plan(input:HookVaultRotationBatch):Promise<HookVaultRotationPlan>{
    try{const batch=this.#batch(input);return await this.#store.transaction(async tx=>this.#prepare(await this.#read(tx,batch),batch,false).plan);}
    catch(e){if(e instanceof B2bSecurityError&&e.code==='VAULT_ROTATION_DISABLED')throw e;throw fail();}
  }
  async rotate(input:HookVaultRotationCommand):Promise<HookVaultRotationResult>{
    try{
      const batch=this.#batch(input,true);
      if(typeof input.commandKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/.test(input.commandKey)||!hex(input.expectedPlanSha256))throw fail();
      const now=this.#now();if(!Number.isSafeInteger(now)||now<batch.policy.cutoverAt)throw fail();
      // Copy before waiting for the store lock: callers cannot mutate a queued request.
      const expectedPlanSha256=input.expectedPlanSha256,keyHash=hash(input.commandKey),requestHash=hash({batch,expectedPlanSha256});
      return await this.#store.transaction(async tx=>{
        const prior=await tx.prior(owner,keyHash);
        if(prior&&prior.bodyHash!==requestHash)throw fail();
        const rows=await this.#read(tx,batch);
        if(prior){
          const saved=prior.response as HookVaultRotationResult;
          // Subscription revisions alone cannot detect another custody rewrap. Guard the full persisted snapshot.
          if(!saved||saved.schemaVersion!==schemaVersion||saved.snapshotSha256!==expectedPlanSha256||saved.afterSnapshotSha256!==hash(rows))throw fail();
          return structuredClone(saved);
        }
        const {plan,updated}=this.#prepare(rows,batch,true);
        if(plan.snapshotSha256!==expectedPlanSha256)throw fail();
        // All reads, identity/revision checks and GCM authentication finished before the first write.
        for(const s of updated)await tx.putSub(s);
        const result:HookVaultRotationResult={...plan,afterSnapshotSha256:hash(updated)};
        for(const s of updated)await tx.audit({id:randomUUID(),owner,action:'VAULT_REWRAP',resourceId:s.id,at:now});
        await tx.command({owner,keyHash,bodyHash:requestHash,response:structuredClone(result),at:now});
        return result;
      });
    }catch(e){if(e instanceof B2bSecurityError&&e.code==='VAULT_ROTATION_DISABLED')throw e;throw fail();}
  }
}



