import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {B2bQueuedEmailActor} from '../services/identity-service/src/b2b/email-actor';
import {HttpB2bEmailActor,queuedEmailActor,queuedEmailScopes} from '../packages/service-access/src/b2b-email-actor';
import {binding} from './b2b-identity.fixture';
function fixture(kind:'SERVICE'|'USER'='USER'){
 const actor={kind,clientId:randomUUID(),revision:2,subjectId:kind==='USER'?randomUUID():null,userAuthRevision:kind==='USER'?3:null};
 const app:any={id:actor.clientId,label:'SYNTHETIC',kind,revision:2,enabled:true,secretHash:'DO_NOT_LEAK_PRIVATE_HASH',oidcClientId:null,
  scopes:['b2b:email:send','b2b:documents:read','b2b:artifacts:read'],bindings:[binding]};
 const user:any={active:true,authVersion:3,permissions:['document.view','document.email'],scope:{kind:'GLOBAL'}};
 const audit=vi.fn(async()=>{}),get=vi.fn(async()=>structuredClone(app)),users={current:vi.fn(async()=>structuredClone(user))},catalogue={validate:vi.fn(async()=>{})};
 const deps={enabled:true,allowedScopes:['b2b:email:send','b2b:documents:read','b2b:artifacts:read'],store:{transaction:async(work:any)=>work({get,audit}),rate:async()=>true},users,catalogue};
 const core=new B2bQueuedEmailActor(deps),http={post:vi.fn(async(_path:string,body:any)=>core.check(body,'a'.repeat(64)))};
 return {actor,app,user,audit,get,users,catalogue,deps,core,http,client:new HttpB2bEmailActor(http)};
}
const scopes=['b2b:email:send','b2b:documents:read','b2b:artifacts:read'] as const;
describe('queued mail identity is a current observation, never a public token or cached authorization',()=>{
 it.each(['USER','SERVICE'] as const)('revalidates %s current ownership and returns no secrets or tokens',async kind=>{
  const f=fixture(kind),r=await f.client.freshIdentity(f.actor,scopes);
  expect(r).toMatchObject({...f.actor,environment:'BETA',bindings:[binding]});expect(f.get).toHaveBeenCalledTimes(3);expect(f.catalogue.validate).toHaveBeenCalledTimes(3);expect(f.audit).toHaveBeenCalledOnce();
  expect(f.http.post.mock.calls[0][0]).toBe('/internal/b2b/authorize-email-actor');expect(JSON.stringify([r,f.audit.mock.calls])).not.toMatch(/DO_NOT_LEAK|secretHash|token/);
  expect(f.users.current).toHaveBeenCalledTimes(kind==='USER'?3:0);
 });
 it.each(['inactive','revision','permission','user','scope','binding','link'])('fails closed on %s revocation without an authorization response',async defect=>{
  const f=fixture();if(defect==='inactive')f.app.enabled=false;if(defect==='revision')f.app.revision++;if(defect==='permission')f.user.permissions=['document.view'];
  if(defect==='user')f.user.active=false;if(defect==='scope')f.app.scopes=['b2b:documents:read'];if(defect==='binding')f.user.scope={kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]};
  if(defect==='link')f.users.current.mockResolvedValue(null);
  await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:403});expect(f.audit).not.toHaveBeenCalled();
 });
 it('rechecks after the durable audit and cannot return a grant revoked during that write',async()=>{
  const f=fixture();f.audit.mockImplementation(async()=>{f.app.enabled=false;});await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:403});expect(f.audit).toHaveBeenCalledOnce();
 });
 it('fails if the audit/canonical catalogue is unavailable and sanitizes private errors',async()=>{
  const f=fixture();f.audit.mockRejectedValue(Error('PRIVATE_DATABASE_CANARY'));await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:503,code:'EMAIL_ACTOR_UNAVAILABLE'});
  f.audit.mockResolvedValue();f.catalogue.validate.mockRejectedValue(Error('PRIVATE_CATALOGUE_CANARY'));await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:503});
 });
 it('does not accept arbitrary scopes, claimed principals or a SERVICE actor with a human subject',()=>{
  const f=fixture('SERVICE');expect(()=>queuedEmailActor({...f.actor,subjectId:randomUUID()})).toThrow();expect(()=>queuedEmailActor({...f.actor,permissions:['document.email']})).toThrow();
  for(const s of [[],['b2b:email:send'],['b2b:identity:manage','b2b:email:send','b2b:documents:read'],[...scopes,'b2b:email:send']])expect(()=>queuedEmailScopes(s as any)).toThrow();
 });
 it('does not activate a stored scope excluded by the host policy and does not expose transport errors',async()=>{
  const f=fixture(),core=new B2bQueuedEmailActor({...f.deps,allowedScopes:['b2b:email:send','b2b:documents:read']});
  await expect(core.check({schemaVersion:'factuez.b2b.email-actor.request.v1',requestId:randomUUID(),actor:f.actor,requiredScopes:scopes},'a'.repeat(64))).rejects.toMatchObject({status:403});
  expect(f.get).not.toHaveBeenCalled();f.http.post.mockRejectedValue(Error('PRIVATE_TRANSPORT_CANARY'));
  await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:503,code:'EMAIL_ACTOR_UNAVAILABLE'});
 });
 it.each(['echo','expired','extra','actor','scopes','time'])('rejects a modified %s private response instead of treating metadata as a token',async defect=>{
  const f=fixture(),original=f.http.post.getMockImplementation()!;
  f.http.post.mockImplementation(async(...args)=>{const r:any=await original(...args);if(defect==='echo')r.requestSha256='b'.repeat(64);if(defect==='expired')r.expiresAt=Date.now()-1;
   if(defect==='extra')r.token='PRIVATE_CANARY';if(defect==='actor')r.principal.revision++;if(defect==='scopes')r.principal.scopes.push('b2b:identity:manage');if(defect==='time')r.verifiedAt=Date.now()+10000;return r;});
  await expect(f.client.freshIdentity(f.actor,scopes)).rejects.toMatchObject({status:503});
 });
 it('stays disabled by default and does not read Identity storage',async()=>{
  const f=fixture(),c=new B2bQueuedEmailActor({...f.deps,enabled:false});await expect(c.check({},'a'.repeat(64))).rejects.toMatchObject({status:503});expect(f.get).not.toHaveBeenCalled();
 });
});
