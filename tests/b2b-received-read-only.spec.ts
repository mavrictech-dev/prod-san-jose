import {describe,it,expect,vi} from 'vitest';import {inspect} from 'node:util';
import {FixedReceptionReadOnlyAdmission,ServiceReceptionDispatchAuthority} from '../services/received-documents-service/src/b2b/automation-read-only.authority';
import {B2bReceptionReadOnlyDispatch} from '../services/received-documents-service/src/b2b/automation-read-only';
import {createB2bReceptionReadOnlyRuntime} from '../services/received-documents-service/src/b2b/automation-read-only.runtime';
import {correctionEvidenceHash as hash} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {scope,id,fixture} from './helpers/b2b-received-automation.fixture';
const context={runId:id(20),scope,source:'MAIL' as const,revision:1,actor:{kind:'SERVICE' as const,clientId:id(2),subjectId:null,clientRevision:1,userAuthRevision:null}};
const binding=()=>({scope,connectionRevision:1,configurationSha256:'a'.repeat(64),approvalId:id(21),approvalRevision:1,sources:['MAIL','SIRE'] as const,approvedImapHosts:['imap.example.com']});
describe('explicit READ_ONLY admission and original SERVICE workload authority',()=>{
 it('has no implicit approval and does not run from a settings save or import',async()=>{
  const unused={$transaction:vi.fn()},identity={authenticate:vi.fn()},authority={authorize:vi.fn()},source={read:vi.fn()};
  const worker=new B2bReceptionReadOnlyDispatch(unused as any,identity,authority,authority,source);
  expect(await worker.pending(0)).toEqual([]);expect(await worker.run(context.runId)).toMatchObject({status:'DISABLED'});
  const runtime=await createB2bReceptionReadOnlyRuntime(undefined as never);expect(runtime.enabled).toBe(false);await runtime.close();
  expect(unused.$transaction).not.toHaveBeenCalled();expect(identity.authenticate).not.toHaveBeenCalled();expect(source.read).not.toHaveBeenCalled();
 });
 it.each(['scope','revision','configuration','source'] as const)('cannot widen approved %s by supplying another context',async change=>{
  const b=binding();if(change==='source')b.sources=['SIRE'] as any;
  const authority=new FixedReceptionReadOnlyAdmission([b]);let c=structuredClone(context),sha=b.configurationSha256;
  if(change==='scope')c.scope={...scope,branchId:id(99)};if(change==='revision')c.revision=2;if(change==='configuration')sha='b'.repeat(64);
  await expect(authority.authorize(c,sha)).rejects.toMatchObject({status:403});
 });
 it('detaches deployment approval and does not serialize confidential network bindings',async()=>{
  const b=binding(),authority=new FixedReceptionReadOnlyAdmission([b]);b.approvedImapHosts[0]='changed.example.com';
  const a=await authority.authorize(context,'a'.repeat(64));expect(a).toMatchObject({profile:'READ_ONLY',contextSha256:hash(context),approvedImapHosts:['imap.example.com']});
  expect(JSON.stringify(authority)).not.toContain('imap.example.com');expect(inspect(authority)).not.toContain(scope.recipientRuc);
 });
 it.each([[],[{...binding(),approvedImapHosts:['127.0.0.1']}],[binding(),binding()],[{...binding(),sources:['ALL']}]])('rejects absent, conflicting or broad infrastructure grants',value=>{
  expect(()=>new FixedReceptionReadOnlyAdmission(value as any)).toThrow();
 });
 it('obtains fresh credentials but keeps a run-bound short proof; checks current identity on every use',async()=>{
  const f=fixture({});f.principal.kind='SERVICE';f.principal.subjectId=null;f.principal.userAuthRevision=null;f.principal.scopes.push('b2b:received:write');
  let calls=0;const provider=vi.fn(async()=>({kind:'SERVICE' as const,token:`synthetic-secret-${++calls}`}));
  const authority=new ServiceReceptionDispatchAuthority(f.identity,provider),a=await authority.authorize(context),b=await authority.authorize(context);
  expect(provider).toHaveBeenCalledTimes(2);expect(a.access.token).not.toBe(b.access.token);expect(a.executionId).toBe(b.executionId);expect(a.expiresAt).toBe(b.expiresAt);expect(a.administrator).toBeNull();
  expect(JSON.stringify(authority)).not.toContain('synthetic-secret');expect(inspect(authority)).not.toContain('synthetic-secret');
  f.control.revoked=true;await expect(authority.authorize(context)).rejects.toMatchObject({status:403});
 });
 it('never converts USER into SERVICE or mints a token for another application',async()=>{
  const f=fixture({}),provider=vi.fn(async()=>({kind:'SERVICE' as const,token:'synthetic-secret'})),authority=new ServiceReceptionDispatchAuthority(f.identity,provider);
  await expect(authority.authorize({...context,actor:{...context.actor,kind:'USER',subjectId:id(3),userAuthRevision:1}})).rejects.toMatchObject({status:403});expect(provider).not.toHaveBeenCalled();
  f.principal.kind='SERVICE';f.principal.subjectId=null;f.principal.userAuthRevision=null;f.principal.scopes.push('b2b:received:write');
  await expect(authority.authorize({...context,actor:{...context.actor,clientId:id(90)}})).rejects.toMatchObject({status:403});
 });
});
