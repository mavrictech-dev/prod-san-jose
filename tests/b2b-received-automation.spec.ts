import {describe,it,expect} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createReceptionAutomationVault} from '../services/received-documents-service/src/b2b/automation';
import {parseAutomationSave,emptyCounters} from '../services/received-documents-service/src/automation/policy';
import {fixture,scope,access,stepUpHandle,localSettings} from './helpers/b2b-received-automation.fixture';
const context={companyId:1,ruc:scope.recipientRuc,revision:1};
const input={scope,key:'synthetic_automation_01',payload:{stepUpHandle,expectedRevision:0,settings:localSettings()}};
const neverDb=()=>({$transaction:async()=>{throw new Error('SYNTHETIC_PRIVATE_DATABASE');}});
describe('automation explicit vault and concrete admission policies',()=>{
 it('encrypts with an explicit master, randomized GCM and revision-bound AAD',async()=>{
  const vault=createReceptionAutomationVault(randomBytes(32)),secret={mailPassword:'FAKE-PASSWORD'},a=await vault.seal(secret,context),b=await vault.seal(secret,context);
  expect(a).not.toBe(b);expect(a).not.toContain(secret.mailPassword);expect(await vault.open(a,context)).toEqual(secret);
  for(const c of [{...context,revision:2},{...context,companyId:2},{...context,ruc:'00000000202'}])expect(()=>vault.open(a,c)).toThrow('RECEIVED_VAULT_UNAVAILABLE');
  expect(()=>createReceptionAutomationVault(randomBytes(31))).toThrow('RECEIVED_VAULT_UNAVAILABLE');
 });
 it('keys request fingerprints separately and detects payload and master changes',async()=>{
  const a=createReceptionAutomationVault(randomBytes(32)),b=createReceptionAutomationVault(randomBytes(32));
  expect(await a.fingerprint!('x')).toBe(await a.fingerprint!('x'));expect(await a.fingerprint!('x')).not.toBe(await a.fingerprint!('y'));expect(await a.fingerprint!('x')).not.toBe(await b.fingerprint!('x'));
 });
 it('reuses actual automation rules and independent zero counters',()=>{
  expect(parseAutomationSave({expectedRevision:0,settings:localSettings()},scope.recipientRuc)).toBeDefined();const v=emptyCounters();v.detected++;expect(emptyCounters().detected).toBe(0);
  expect(()=>parseAutomationSave({expectedRevision:0,settings:localSettings()},'99999999999')).toThrow();
 });
 it.each([null,{},[],{...input,extra:true}])('rejects malformed envelope %#',async v=>{
  await expect(fixture(neverDb()).owner.execute(access,'CONFIG_SAVE',v)).rejects.toMatchObject({status:400});
 });
 it('does not invoke request getters',async()=>{
  let invoked=false;const v={scope,key:input.key,get payload(){invoked=true;return input.payload;}};
  await expect(fixture(neverDb()).owner.execute(access,'CONFIG_SAVE',v)).rejects.toMatchObject({status:400});expect(invoked).toBe(false);
 });
 it.each(['CONFIG_READ','CONFIG_SAVE'] as const)('SERVICE cannot %s and cannot impersonate configuredBy',async action=>{
  const f=fixture(neverDb());f.principal.kind='SERVICE';f.principal.subjectId=null;f.principal.userAuthRevision=null;
  await expect(f.owner.execute({...access,kind:'SERVICE'},action,action==='CONFIG_READ'?{scope,payload:{stepUpHandle}}:input)).rejects.toMatchObject({status:403,code:'RECEIVED_GLOBAL_ADMIN_REQUIRED'});expect(f.control.identityCalls).toBe(0);
 });
 it('uses finite database failure codes',async()=>{
  const error=await fixture(neverDb()).owner.execute(access,'CONFIG_READ',{scope,payload:{stepUpHandle}}).catch(e=>e);
  expect(error).toMatchObject({status:503});expect(String(error)).not.toContain('PRIVATE_DATABASE');
 });
});


