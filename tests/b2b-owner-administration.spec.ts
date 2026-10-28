import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {B2bOwnerAdministration,ownerAdministrationPeers} from '../services/identity-service/src/b2b/owner-administration';
import {HttpB2bOwnerAdministration,HttpB2bOwnerBinding} from '../packages/service-access/src/b2b-owner-administration';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {adminDigest} from '../packages/service-access/src/b2b-phase8-admin-wire';
import {binding} from './b2b-identity.fixture';
function fixture(enabled=true){
 const peers={billing:['a'.repeat(64)],fiscal:['b'.repeat(64)],mailer:['c'.repeat(64)]};
 const human:any={sub:randomUUID(),username:'SYNTHETIC',fullName:'SYNTHETIC ONLY',authVersion:3,roles:['ADMIN'],permissions:['setup.manage','sunat.configure','document.email'],
  scope:{kind:'GLOBAL'},iss:'https://identity.synthetic.invalid',aud:'factuez-b2b-v1',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+30};
 const request={kind:'USER' as const,action:'PRINT_READ' as const,binding,payloadDigest:'d'.repeat(64)},audit=vi.fn(async()=>{});
 const deps={enabled,peers,authority:{authorize:vi.fn(async()=>({claims:structuredClone(human),policyRevision:'f'.repeat(64),stepUpVerified:true as const,expiresAt:Date.now()+29000}))},
  live:{current:vi.fn(async()=>structuredClone(human))},bindings:{revalidate:vi.fn(async()=>({binding:structuredClone(binding),revision:'owner-v1'}))},
  store:{transaction:async(work:any)=>work({audit}),rate:async()=>true}};
 return {human,request,deps,audit,core:new B2bOwnerAdministration(deps)};
}
describe('private current-human authority, no implied permissions or claims from public data',()=>{
 it('requires disjoint configured owner certificates and remains disabled unless explicitly enabled',async()=>{
  expect(()=>ownerAdministrationPeers({billing:['a'.repeat(64)],fiscal:['a'.repeat(64)],mailer:[]})).toThrow();
  const f=fixture(false);await expect(f.core.authorize('a'.repeat(64),'synthetic-token',f.request)).rejects.toMatchObject({status:503});expect(f.deps.authority.authorize).not.toHaveBeenCalled();
 });
 it('binds the result to the precise request, verifies current hierarchy/user twice and audits before returning',async()=>{
  const f=fixture(),result=await f.core.authorize('a'.repeat(64),'synthetic-token',f.request);
  expect(result).toMatchObject({requestSha256:adminDigest(f.request),claims:{sub:f.human.sub},stepUpVerified:true});expect(f.deps.bindings.revalidate).toHaveBeenCalledTimes(2);
  expect(f.audit).toHaveBeenCalledOnce();const record=f.audit.mock.calls[0][0];expect(JSON.stringify(record)).not.toContain('synthetic-token');expect(record.outcome).toBe('ALLOWED');
 });
 it.each([['a','FISCAL_SAVE'],['b','PRINT_SAVE'],['c','ISSUER_CREATE'],['b','USERS_CREATE']])('rejects cross-owner %s/%s before consulting OIDC or storage',async(peer,action)=>{
  const f=fixture();await expect(f.core.authorize(peer.repeat(64),'synthetic-token',{...f.request,action})).rejects.toMatchObject({status:403});expect(f.deps.authority.authorize).not.toHaveBeenCalled();
  expect(f.audit.mock.calls.at(-1)?.[0].outcome).toBe('DENIED');
 });
 it('does not return a successful decision if auditing is unavailable, and sanitizes backend diagnostics',async()=>{
  const f=fixture();f.audit.mockRejectedValue(Error('PRIVATE_DATABASE_CREDENTIAL_CANARY'));
  await expect(f.core.authorize('a'.repeat(64),'synthetic-token',f.request)).rejects.toMatchObject({status:503,code:'OWNER_ADMINISTRATION_DENIED'});
 });
 it.each(['role','permission','revision','scope','secret','expired','binding','stepup'])('rejects a stale/malformed %s proof or user and cannot turn it into current human claims',async defect=>{
  const f=fixture();
  if(defect==='role')f.human.roles=[];if(defect==='permission')f.human.permissions=[];if(defect==='scope')f.human.scope={kind:'ASSIGNED'};
  if(defect==='secret')f.human.passwordHash='PRIVATE_CANARY';if(defect==='expired')f.human.exp=0;
  if(defect==='revision')f.deps.live.current.mockImplementation(async()=>({...structuredClone(f.human),authVersion:4}));
  if(defect==='binding')f.deps.bindings.revalidate.mockResolvedValueOnce({binding,revision:'changed'});
  if(defect==='stepup')f.deps.authority.authorize.mockResolvedValue({...await f.deps.authority.authorize(),stepUpVerified:false} as any);
  await expect(f.core.authorize('a'.repeat(64),'synthetic-token',f.request)).rejects.toMatchObject({status:403});
 });
 it('returns null for inactive humans, rejects unknown peers and arbitrary identity fields',async()=>{
  const f=fixture();f.deps.live.current.mockResolvedValue(null);expect(await f.core.liveHuman('a'.repeat(64),{subjectId:f.human.sub})).toMatchObject({claims:null});
  await expect(f.core.liveHuman('f'.repeat(64),{subjectId:f.human.sub})).rejects.toMatchObject({status:403});
  await expect(f.core.liveHuman('a'.repeat(64),{subjectId:f.human.sub,roles:['ADMIN']})).rejects.toMatchObject({status:400});
 });
 it('hides private dependencies and TLS keys even in verbose object inspection',()=>{
  const key=Buffer.from('PRIVATE_TLS_TEST_CANARY'),http=new B2bPrivateHttp('https://identity.synthetic.invalid',{ca:Buffer.from('synthetic'),cert:Buffer.from('synthetic'),key});
  for(const text of [JSON.stringify(http),inspect(http,{showHidden:true,depth:8,customInspect:false}),inspect(fixture().core,{showHidden:true,depth:8})])expect(text).not.toContain('PRIVATE_TLS_TEST_CANARY');
  expect(Object.keys(http)).not.toContain('tls');expect(JSON.stringify(fixture().core)).not.toContain('authority');
 });
});
describe('real private owner clients validate bound responses rather than trusting a Boolean',()=>{
 it('accepts the actual protocol, rejects wrong request/owner/extra claim fields and preserves revocation/null',async()=>{
  const f=fixture(),http={post:vi.fn(async(path:string,body:any,token?:string)=>path.endsWith('/authorize')?f.core.authorize('a'.repeat(64),token!,body):path.endsWith('/status')?f.core.status('a'.repeat(64)):f.core.liveHuman('a'.repeat(64),body))};
  const client=new HttpB2bOwnerAdministration(http,'billing');expect(await client.readiness()).toMatchObject({owner:'billing'});
  expect(await client.authorize({...f.request,token:'synthetic-token'})).toMatchObject({claims:{sub:f.human.sub}});expect(await client.current(f.human.sub)).toMatchObject({authVersion:3});
  const fiscal=new HttpB2bOwnerAdministration(http,'fiscal');await expect(fiscal.readiness()).rejects.toMatchObject({status:503});
  http.post.mockResolvedValue({schemaVersion:'factuez.b2b.owner-authority.v1',claims:{...f.human,passwordHash:'PRIVATE_CANARY'}} as any);
  await expect(client.current(f.human.sub)).rejects.toMatchObject({status:503});
 });
 it('validates the full live Binding through Billing rather than creating an ownership tuple',async()=>{
  const http={post:vi.fn(async()=>({valid:true}))},port=new HttpB2bOwnerBinding(http);expect(await port.revalidate(binding)).toMatchObject({binding});
  expect(http.post).toHaveBeenCalledWith('/internal/b2b/validate-bindings',{bindings:[binding]});http.post.mockResolvedValue({valid:false});await expect(port.revalidate(binding)).rejects.toMatchObject({status:503});
 });
});
