import 'reflect-metadata';
import {describe,expect,it,vi} from 'vitest';
import {bootstrapB2bSunatHost,createB2bSunatRuntimeFromFiles,requireCompleteSunatCapabilities} from '../services/sunat-service/src/b2b/main';
import {b2bOwnerRuntimeCapabilities} from '../packages/service-access/src/b2b-runtime-status';

describe('SUNAT complete mounted host: no missing authority or legacy fallback',()=>{
 it('disabled calls do not inspect mounts, DI or lifecycle ports',async()=>{
  const inaccessible=new Proxy({},{get(){throw Error('DISABLED_HOST_TOUCHED_DEPENDENCIES');}});
  expect(await bootstrapB2bSunatHost({enabled:false},inaccessible as any,inaccessible as any)).toBeNull();
  expect(await createB2bSunatRuntimeFromFiles(inaccessible as any,inaccessible as any,inaccessible as any)).toBeNull();
 });
 it('standalone requires explicit mounts; an incomplete embedded DI still fails before inspecting it',async()=>{
  await expect(bootstrapB2bSunatHost({enabled:true})).rejects.toThrow('PRIVATE_CONFIG_ROOT_REQUIRED');
  await expect(bootstrapB2bSunatHost({enabled:true,configRoot:'Z:/not-opened-real-config'})).rejects.toThrow('STANDALONE_START_FAILED');
  const get=vi.fn(()=>{throw Error('DI_NOT_ALLOWED');});
  await expect(bootstrapB2bSunatHost({enabled:true,configRoot:'Z:/not-opened-real-config'},{get} as any,{} as any)).rejects.toThrow('COMPLETE_HOST_BINDINGS_REQUIRED');
  expect(get).not.toHaveBeenCalled();
 });
 it.each(['drain','lifecycle','guideKeys','batchKeys','privileged'])('requires the concrete host group %s before even reading metadata',async missing=>{
  const metadata=vi.fn(()=>{throw Error('FILES_NOT_ALLOWED');}),get=vi.fn();
  const ports:any={drain:{install(){},pauseCommands(){},closeAdmission(){},drain(){},snapshot(){}},lifecycle:{stopProducers(){},stopWorkers(){},closeOtherOwnerListeners(){}},
   guideKeys:{withKey(){}},batchKeys:{acquire(){}},privileged:{authority:{authorize(){}},liveIdentity:{current(){}},bindingOwner:{revalidate(){}}}};
  // These sentinels never run and never constitute an authority/approval; one mandatory group is always absent.
  delete ports[missing];await expect(createB2bSunatRuntimeFromFiles({metadata} as any,{get} as any,ports,{enabled:true})).rejects.toThrow('COMPLETE_HOST_BINDINGS_REQUIRED');
  expect(metadata).not.toHaveBeenCalled();expect(get).not.toHaveBeenCalled();
 });
 it('requires all five exact fiscal capabilities, not READ-only, duplicate or invented profiles',()=>{
  const expected=[...b2bOwnerRuntimeCapabilities.fiscal];expect(()=>requireCompleteSunatCapabilities(expected)).not.toThrow();
  for(const invalid of [expected.slice(1),['READ'],[...expected,'TRANSMIT'],expected.map((x,i)=>i?x:'READ_APPROVED'),expected.map((x,i)=>i===1?'READ':x)])
   expect(()=>requireCompleteSunatCapabilities(invalid)).toThrow('COMPLETE_CAPABILITIES_REQUIRED');
 });
});
