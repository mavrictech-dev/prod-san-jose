import {describe,it,expect,vi} from 'vitest';
import {inspect} from 'node:util';
import {randomUUID} from 'node:crypto';
import {hookFixture,hookEvent} from './b2b-webhooks.fixture';
import {HookVault,verifyWebhook,HOOK_VAULT_MAX_CIPHERTEXT} from '../services/webhook-service/src/crypto';
import {HookVaultRotation,hookVaultRotationIdentity,type HookVaultRotationPolicy,type HookVaultRotationBatch} from '../services/webhook-service/src/vault-rotation';
import {Webhooks} from '../services/webhook-service/src/core';
import type {HookStore} from '../services/webhook-service/src/model';

const oldKey=Buffer.alloc(32,0x11),newKey=Buffer.alloc(32,0x22);
async function setup(versioned=false,extra=false){
  const f=await hookFixture(),first=await f.verified();
  const current=await f.call('ROTATE',{id:first.id,key:'synthetic_hmac_rotation_001',ifMatch:first.revision,body:{}});
  if(extra)await f.create('synthetic_second_hook_001');
  const source=versioned?new HookVault({activeKeyVersion:'old',keys:[{version:'old',key:oldKey}]}):new HookVault(oldKey);
  await f.store.transaction(async tx=>{for(const s of await tx.subs())await tx.putSub({...s,secret:source.seal(f.vault.open(s.secret,s.id),s.id),
    previousSecret:s.previousSecret===null?null:source.seal(f.vault.open(s.previousSecret,s.id),s.id)});});
  const vault=new HookVault({activeKeyVersion:'new',keys:[{version:'old',key:oldKey},{version:'new',key:newKey}],...(!versioned?{legacyKeyVersion:'old'}:{})});
  const policy:HookVaultRotationPolicy={environment:'BETA',fromKeyVersion:versioned?'old':'legacy',toKeyVersion:'new',cutoverAt:f.now()-1000,proofSha256:'e'.repeat(64)};
  const batch=():HookVaultRotationBatch=>({policy:structuredClone(policy),subscriptions:[...f.store.subscriptions.values()].map(s=>({subscriptionId:s.id,expectedRevision:s.revision,expectedIdentitySha256:hookVaultRotationIdentity(s)}))});
  const adapter=()=>new HookVaultRotation(f.store,vault,{enabled:true,policy},f.now);
  const rotation=adapter(),core=new Webhooks(f.store,f.identity,f.authority,f.callbacks,vault,f.now,()=>0);
  const command=async()=>({...batch(),commandKey:'synthetic_vault_rewrap_001',expectedPlanSha256:(await rotation.plan(batch())).snapshotSha256});
  return {...f,first,current,source,vault,policy,batch,adapter,rotation,core,command};
}
const snapshot=(f:Awaited<ReturnType<typeof setup>>)=>structuredClone({subscriptions:f.store.subscriptions,events:f.store.events,rows:f.store.rows,history:f.store.history,commands:f.store.commands,audits:f.store.audits});
const rejected=async(p:Promise<unknown>)=>expect(p).rejects.toMatchObject({status:409,code:'VAULT_ROTATION_REJECTED'});

describe('B2B-09 private transactional custody rewrap',()=>{
  it.each([false,true])('rewraps legacy/versioned=%s without changing any functional subscription or journal field',async versioned=>{
    const f=await setup(versioned),before=snapshot(f),cmd=await f.command();await f.core.ingest(hookEvent());
    const journal=structuredClone({events:f.store.events,rows:f.store.rows,history:f.store.history});
    const result=await f.rotation.rotate(cmd);
    for(const s of f.store.subscriptions.values()){
      const original=before.subscriptions.get(s.id)!;
      expect({...s,secret:original.secret,previousSecret:original.previousSecret}).toEqual(original);
      expect(s.secret).not.toBe(original.secret);expect(s.previousSecret).not.toBe(original.previousSecret);
      expect(f.vault.open(s.secret,s.id)).toBe(f.current.signingSecret);expect(f.vault.open(s.previousSecret!,s.id)).toBe(f.first.signingSecret);
    }
    expect({events:f.store.events,rows:f.store.rows,history:f.store.history}).toEqual(journal);
    expect([...f.store.commands.values()].filter(c=>c.owner!=='vault-rotation')).toEqual([...before.commands.values()]);
    expect(result.snapshotSha256).toBe(cmd.expectedPlanSha256);expect(f.store.audits.at(-1)).toMatchObject({owner:'vault-rotation',action:'VAULT_REWRAP'});
    const durable=[...f.store.commands.values()].find(c=>c.owner==='vault-rotation')!;
    expect(durable.response).toEqual(result);expect(durable.bodyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify([result,durable])).not.toMatch(/whsec_|hookvault\./);
  });
  it('dry plan authenticates and returns only metadata without writes or plaintext/ciphertext bodies',async()=>{
    const f=await setup(),before=snapshot(f),s=[...f.store.subscriptions.values()][0],plan=await f.rotation.plan(f.batch());
    expect(snapshot(f)).toEqual(before);expect(plan.items[0]).toMatchObject({subscriptionId:s.id,expectedRevision:s.revision,secretKeyVersion:'legacy',previousSecretKeyVersion:'legacy'});
    const text=JSON.stringify(plan);for(const value of [s.secret,s.previousSecret!,f.current.signingSecret,f.first.signingSecret])expect(text).not.toContain(value);
    expect(Object.keys(f.rotation)).toEqual([]);expect(inspect(f.rotation,{showHidden:true})).not.toContain('Buffer');
    expect(f.callbacks.send).not.toHaveBeenCalled();expect(f.authority.check).not.toHaveBeenCalled();
  });
  it('actually dispatches rotated ciphertext with both unchanged HMAC secrets during overlap, then expires the old signature',async()=>{
    const f=await setup();await f.core.ingest(hookEvent());const queued=structuredClone([...f.store.rows.values()][0]);
    await f.rotation.rotate(await f.command());expect(f.store.rows.get(queued.id)).toEqual(queued);
    await f.core.dispatch();const [,bytes,headers]=f.callbacks.send.mock.calls[0];
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    for(const secret of [f.first.signingSecret,f.current.signingSecret])expect(verifyWebhook([secret],bytes,headers,f.now())).toBe(queued.id);
    const s=f.store.subscriptions.get(f.first.id)!;expect(s.revision).toBe(Number(f.current.revision.slice(2,-1)));expect(s.verifiedRevision).toBe(s.revision);
    f.advance(301000);await f.core.ingest(hookEvent());await f.core.dispatch();const [,later,h]=f.callbacks.send.mock.calls[1];
    expect(h['webhook-signature'].split(' ')).toHaveLength(1);expect(verifyWebhook([f.current.signingSecret],later,h,f.now())).toBeTruthy();
    expect(()=>verifyWebhook([f.first.signingSecret],later,h,f.now())).toThrow();
    expect(f.store.subscriptions.get(s.id)?.previousSecret).toBe(s.previousSecret);
  });
  it('keeps retry delivery IDs, exact event bytes and existing attempts across custody rotation',async()=>{
    const f=await setup();await f.core.ingest(hookEvent());f.callbacks.send.mockResolvedValueOnce({status:503});await f.core.dispatch();
    const before=snapshot(f),firstCall=f.callbacks.send.mock.calls[0];await f.rotation.rotate(await f.command());
    expect(f.store.rows).toEqual(before.rows);expect(f.store.events).toEqual(before.events);expect(f.store.history).toEqual(before.history);
    f.advance(31000);await f.core.dispatch();const again=f.callbacks.send.mock.calls[1];
    expect(again[1]).toEqual(firstCall[1]);expect(again[2]['webhook-id']).toBe(firstCall[2]['webhook-id']);
    expect(verifyWebhook([f.current.signingSecret],again[1],again[2],f.now())).toBe(firstCall[2]['webhook-id']);
    expect(f.store.history.size).toBe(2);
  });
  it('rewraps an expired previous secret and handles a null previous secret without deleting or inventing one',async()=>{
    const f=await setup(false,true);f.advance(301000);const before=snapshot(f);await f.rotation.rotate(await f.command());
    for(const s of f.store.subscriptions.values()){
      const old=before.subscriptions.get(s.id)!;expect(s.previousUntil).toBe(old.previousUntil);
      if(old.previousSecret===null)expect(s.previousSecret).toBeNull();
      else{expect(s.previousSecret).toMatch(/^hookvault\.1\.new\./);expect(f.vault.open(s.previousSecret!,s.id)).toBe(f.first.signingSecret);}
    }
  });
  it('migrates a legacy/versioned source pair only when legacy is explicitly mapped to the approved source key',async()=>{
    const f=await setup(true),s=f.store.subscriptions.get(f.first.id)!;
    s.previousSecret=new HookVault(oldKey).seal(f.first.signingSecret,s.id);f.store.subscriptions.set(s.id,s);
    await rejected(f.rotation.plan(f.batch())); // no legacy mapping in the original versioned-only fixture
    const mapped=new HookVault({activeKeyVersion:'new',keys:[{version:'old',key:oldKey},{version:'new',key:newKey}],legacyKeyVersion:'old'});
    const rotation=new HookVaultRotation(f.store,mapped,{enabled:true,policy:f.policy},f.now),batch=f.batch(),plan=await rotation.plan(batch);
    expect(plan.items[0]).toMatchObject({secretKeyVersion:'old',previousSecretKeyVersion:'legacy'});
    await rotation.rotate({...batch,commandKey:'synthetic_mixed_source_001',expectedPlanSha256:plan.snapshotSha256});
    const after=f.store.subscriptions.get(s.id)!;
    expect(mapped.open(after.secret,s.id)).toBe(f.current.signingSecret);expect(mapped.open(after.previousSecret!,s.id)).toBe(f.first.signingSecret);
    expect(after.secret).toMatch(/^hookvault\.1\.new\./);expect(after.previousSecret).toMatch(/^hookvault\.1\.new\./);
  });  it('supports a mixed old/new pair while authenticating both and only rewrapping the old field',async()=>{
    const f=await setup();const s=f.store.subscriptions.get(f.first.id)!;s.secret=f.vault.seal(f.current.signingSecret,s.id);f.store.subscriptions.set(s.id,s);
    await f.rotation.rotate(await f.command());const after=f.store.subscriptions.get(s.id)!;
    expect(after.secret).toBe(s.secret);expect(after.previousSecret).not.toBe(s.previousSecret);
  });
  it('replays the exact durable command after a new adapter instance without more writes or audit',async()=>{
    const f=await setup(),cmd=await f.command(),result=await f.rotation.rotate(cmd),before=snapshot(f);
    expect(await f.adapter().rotate(cmd)).toEqual(result);expect(snapshot(f)).toEqual(before);
    const [a,b]=await Promise.all([f.adapter().rotate(cmd),f.adapter().rotate(cmd)]);expect(a).toEqual(b);expect(snapshot(f)).toEqual(before);
  });
  it.each(['revision','actorRevision','actorOwner','userRevision','binding','ciphertext','previousUntil','verifiedRevision'])('rejects stale replay when %s changes even without a functional revision bump',async field=>{
    const f=await setup(),cmd=await f.command();await f.rotation.rotate(cmd);const s=f.store.subscriptions.get(f.first.id)!;
    if(field==='revision')s.revision++;
    if(field==='actorRevision')s.actor.revision++;
    if(field==='actorOwner')s.actor.clientId=randomUUID();
    if(field==='userRevision')s.actor.userAuthRevision=99;
    if(field==='binding')s.binding.pointId=randomUUID();
    if(field==='ciphertext')s.secret=f.vault.seal(f.current.signingSecret,s.id);
    if(field==='previousUntil')s.previousUntil!++;
    if(field==='verifiedRevision')s.verifiedRevision=null;
    f.store.subscriptions.set(s.id,s);const before=snapshot(f);await rejected(f.adapter().rotate(cmd));expect(snapshot(f)).toEqual(before);
  });
  it('replays a durable snapshot after the old key is retired, without using a decryption fallback',async()=>{
    const f=await setup(),cmd=await f.command(),result=await f.rotation.rotate(cmd),before=snapshot(f);
    const retired=new HookVault({activeKeyVersion:'new',keys:[{version:'new',key:newKey}]}),rotation=new HookVaultRotation(f.store,retired,{enabled:true,policy:f.policy},f.now);
    expect(await rotation.rotate(cmd)).toEqual(result);expect(snapshot(f)).toEqual(before);
    // A different unrotated subscription cannot be migrated without its explicit legacy key.
    const s=f.store.subscriptions.get(f.first.id)!;s.secret=f.source.seal(f.current.signingSecret,s.id);f.store.subscriptions.set(s.id,s);
    await rejected(rotation.plan(f.batch()));
  });
  it('keeps client command idempotency stable after custody rotation',async()=>{
    const f=await setup(),original=structuredClone([...f.store.commands.values()].filter(c=>c.owner!=='vault-rotation'));
    await f.rotation.rotate(await f.command());
    const replay=await f.core.call(f.token,'SERVICE','ROTATE',{issuerId:'1',id:f.first.id,key:'synthetic_hmac_rotation_001',ifMatch:f.first.revision,body:{}});
    expect(replay.id).toBe(f.first.id);expect(replay.revision).toBe(f.current.revision);expect(replay.signingSecret).toBeUndefined();
    expect([...f.store.commands.values()].filter(c=>c.owner!=='vault-rotation')).toEqual(original);
  });  it('rejects command-key reuse with another plan or a changed request',async()=>{
    const f=await setup(),cmd=await f.command();await f.rotation.rotate(cmd);const before=snapshot(f);
    await rejected(f.adapter().rotate({...cmd,expectedPlanSha256:'a'.repeat(64)}));
    await rejected(f.adapter().rotate({...cmd,subscriptions:cmd.subscriptions.map(s=>({...s,expectedRevision:s.expectedRevision+1}))}));
    expect(snapshot(f)).toEqual(before);
  });
  it.each(['revision','identity','snapshot','missing','previousTamper','oversized','swappedId','unknownVersion'])('rejects stale/invalid %s before any write',async kind=>{
    const f=await setup(false,true),cmd=await f.command(),ids=[...f.store.subscriptions.keys()],s=f.store.subscriptions.get(ids[1])!;
    if(kind==='revision')s.revision++;
    if(kind==='identity')s.actor.revision++;
    if(kind==='snapshot')s.label='Changed without functional revision';
    if(kind==='missing')f.store.subscriptions.delete(s.id);
    if(kind==='previousTamper')s.previousSecret='A'.repeat(104);
    if(kind==='oversized')s.secret='A'.repeat(HOOK_VAULT_MAX_CIPHERTEXT+1);
    if(kind==='swappedId')s.secret=f.store.subscriptions.get(ids[0])!.secret;
    if(kind==='unknownVersion')s.secret='hookvault.1.unknown.'+'A'.repeat(104);
    if(kind!=='missing')f.store.subscriptions.set(s.id,s);
    const before=snapshot(f),put=vi.fn();
    const observed:HookStore={transaction:work=>f.store.transaction(tx=>work({...tx,putSub:async row=>{put(row);await tx.putSub(row);}}))};
    const rotation=new HookVaultRotation(observed,f.vault,{enabled:true,policy:f.policy},f.now);
    await rejected(rotation.rotate(cmd));expect(put).not.toHaveBeenCalled();expect(snapshot(f)).toEqual(before);
  });
  it.each(['failAudit','failCommit','command'])('rolls back every ciphertext and journal write on %s failure',async kind=>{
    const f=await setup(false,true),cmd=await f.command(),before=snapshot(f);
    if(kind==='failAudit')f.store.failAudit=true;if(kind==='failCommit')f.store.failCommit=true;
    const store:HookStore=kind==='command'?{transaction:work=>f.store.transaction(tx=>work({...tx,command:async()=>{throw new Error('Synthetic command outage');}}))}:f.store;
    const rotation=new HookVaultRotation(store,f.vault,{enabled:true,policy:f.policy},f.now);
    await rejected(rotation.rotate(cmd));expect(snapshot(f)).toEqual(before);
    f.store.failAudit=false;f.store.failCommit=false;
    expect(await f.rotation.rotate(cmd)).toMatchObject({snapshotSha256:cmd.expectedPlanSha256});
  });
  it('requires explicit enablement, approved BETA policy, correct old/new versions, proof and elapsed cutover',async()=>{
    const f=await setup(),batch=f.batch(),cmd=await f.command(),before=snapshot(f);
    const disabled=new HookVaultRotation(f.store,f.vault);
    await expect(disabled.plan(batch)).rejects.toMatchObject({code:'VAULT_ROTATION_DISABLED'});await expect(disabled.rotate(cmd)).rejects.toMatchObject({code:'VAULT_ROTATION_DISABLED'});
    await rejected(new HookVaultRotation(f.store,f.vault,{enabled:true},f.now).plan(batch));
    for(const policy of [{...f.policy,environment:'PROD'},{...f.policy,proofSha256:'f'.repeat(64)},{...f.policy,toKeyVersion:'old'},
      {...f.policy,fromKeyVersion:'new'},{...f.policy,cutoverAt:f.now()+1000}])await rejected(f.rotation.plan({...batch,policy} as any));
    const future={...f.policy,cutoverAt:f.now()+1000},r=new HookVaultRotation(f.store,f.vault,{enabled:true,policy:future},f.now),futureBatch={...batch,policy:future};
    const plan=await r.plan(futureBatch);await rejected(r.rotate({...futureBatch,commandKey:cmd.commandKey,expectedPlanSha256:plan.snapshotSha256}));
    expect(snapshot(f)).toEqual(before);
  });
  it('bounds explicit unique selections to 1..100 and rejects unknown fields and malformed guards',async()=>{
    const f=await setup(),batch=f.batch(),s=batch.subscriptions[0],before=snapshot(f);
    const bad:any[]=[{...batch,subscriptions:[]},{...batch,subscriptions:Array.from({length:101},()=>({...s,subscriptionId:randomUUID()}))},
      {...batch,subscriptions:[s,s]},{...batch,subscriptions:[{...s,subscriptionId:'not-uuid'}]},
      {...batch,subscriptions:[{...s,expectedRevision:0}]},{...batch,subscriptions:[{...s,expectedIdentitySha256:'x'}]},
      {...batch,subscriptions:[{...s,secret:'whsec_untrusted'}]},{...batch,all:true}];
    for(const input of bad)await rejected(f.rotation.plan(input));expect(snapshot(f)).toEqual(before);
  });
  it('accepts exactly 100 explicit subscriptions and serializes concurrent identical requests',async()=>{
    const f=await setup(),template=f.store.subscriptions.get(f.first.id)!;
    for(let i=1;i<100;i++){const id=randomUUID();f.store.subscriptions.set(id,{...structuredClone(template),id,secret:f.source.seal(f.current.signingSecret,id),previousSecret:f.source.seal(f.first.signingSecret,id)});}
    const cmd=await f.command(),before=f.store.audits.length;
    const results=await Promise.all([f.rotation.rotate(cmd),f.adapter().rotate(cmd)]);expect(results[0]).toEqual(results[1]);
    expect(results[0].items).toHaveLength(100);expect(f.store.audits.length-before).toBe(100);
    expect([...f.store.commands.values()].filter(c=>c.owner==='vault-rotation')).toHaveLength(1);
  });
  it('rejects a wholly target-version selection and does not offer a generic client action',async()=>{
    const f=await setup();await f.rotation.rotate(await f.command());await rejected(f.rotation.plan(f.batch()));
    await expect(f.call('VAULT_ROTATE',{body:{}})).rejects.toMatchObject({status:400,code:'INVALID_REQUEST'});
  });
  it('does not retain references to mutable request/options while waiting for the transaction',async()=>{
    const f=await setup(),cmd=await f.command();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const queued:HookStore={transaction:async work=>{await gate;return f.store.transaction(work);}};
    const rotation=new HookVaultRotation(queued,f.vault,{enabled:true,policy:f.policy},f.now),pending=rotation.rotate(cmd);
    cmd.subscriptions[0].expectedRevision=999;cmd.policy.environment='PROD' as any;cmd.expectedPlanSha256='x';release();
    expect((await pending).policy.environment).toBe('BETA');
  });
});


