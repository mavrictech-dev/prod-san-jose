import {describe,it,expect,vi} from 'vitest';
import {B2bReceptionDispatch} from '../services/received-documents-service/src/b2b/automation-dispatch';
import {createB2bReceptionDispatchRuntime} from '../services/received-documents-service/src/b2b/automation-dispatch-runtime';
const id='00000000-0000-4000-8000-000000000001';
function disabled(){
 const database={$transaction:vi.fn(async()=>{throw new Error('DATABASE_MUST_NOT_OPEN');})};
 const identity={authenticate:vi.fn()},automation={authorize:vi.fn()},writes={authorize:vi.fn()};
 return {database,identity,automation,writes,core:new B2bReceptionDispatch(database,identity,automation,writes)};
}
describe('private reception dispatch admission',()=>{
 it('is inert without explicit activation: no DB, Identity, grants or execution',async()=>{
  const f=disabled();expect(await f.core.pending(100)).toEqual([]);expect(await f.core.run(id)).toEqual({runId:id,status:'DISABLED'});
  expect(f.database.$transaction).not.toHaveBeenCalled();expect(f.identity.authenticate).not.toHaveBeenCalled();expect(f.automation.authorize).not.toHaveBeenCalled();expect(f.writes.authorize).not.toHaveBeenCalled();
 });
 it.each([undefined,null,{}, {enabled:false}])('disabled composition never needs a provider, Redis or database: %j',async options=>{
  const runtime=await createB2bReceptionDispatchRuntime(undefined as never,options as any);expect(runtime.enabled).toBe(false);expect(await runtime.enqueue(id)).toBe(false);await runtime.poll();await runtime.close();
 });
 it('refuses enabled composition lacking an independent execution authority before connecting Redis',async()=>{
  await expect(createB2bReceptionDispatchRuntime({} as never,{enabled:true})).rejects.toThrow('B2B_RECEIVED_DISPATCH_EXPLICIT_OWNER_REQUIRED');
 });
 it.each(['bad','../file','00000000-0000-9000-8000-000000000001',null,{}, id+'?token=secret'])('rejects invalid run IDs before DB use: %j',async runId=>{
  const f=disabled(),core=new B2bReceptionDispatch(f.database,f.identity,f.automation,f.writes,{enabled:true});
  await expect(core.run(runId as any)).rejects.toMatchObject({status:400,code:'INVALID_RECEIVED_DISPATCH_REQUEST'});expect(f.database.$transaction).not.toHaveBeenCalled();
 });
 it.each([0,-1,101,1.2,NaN,Infinity,'10'])('bounds durable recovery scans before DB use: %j',async limit=>{
  const f=disabled(),core=new B2bReceptionDispatch(f.database,f.identity,f.automation,f.writes,{enabled:true});
  await expect(core.pending(limit as any)).rejects.toMatchObject({status:400,code:'INVALID_RECEIVED_DISPATCH_REQUEST'});expect(f.database.$transaction).not.toHaveBeenCalled();
 });
 it('never exposes database errors in recovery scans',async()=>{
  const f=disabled(),core=new B2bReceptionDispatch(f.database,f.identity,f.automation,f.writes,{enabled:true});
  await expect(core.pending(1)).rejects.toMatchObject({status:503,code:'RECEIVED_DISPATCH_UNAVAILABLE'});
  try{await core.pending(1);}catch(e){expect(String(e)).not.toContain('DATABASE_MUST_NOT_OPEN');}
 });
});
