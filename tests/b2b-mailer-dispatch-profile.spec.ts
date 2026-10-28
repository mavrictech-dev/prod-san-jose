import {describe,it,expect,vi} from 'vitest';
import {B2bMailerDispatcher} from '../services/mailer-worker/src/b2b/runtime-dispatcher';
describe('dispatcher de correo aislado por perfil',()=>{
 it.each(['LOCAL_CAPTURE','CORPORATE'] as const)('elige solo tabla y trabajos de %s',async(profile)=>{
  const query=vi.fn(async()=>({rows:[{id:'11111111-1111-4111-8111-111111111111'}],rowCount:1})),release=vi.fn();
  const pool={connect:async()=>({query,release}),end:async()=>{}};const core={run:vi.fn(async()=>({}))},authority={freshIdentity:vi.fn()};
  const dispatcher=new B2bMailerDispatcher(pool as any,core as any,authority as any,{intervalMs:1000,batchSize:3,profile});
  await dispatcher.tick();expect(query.mock.calls[0][0]).toContain(profile==='CORPORATE'?'"B2bCorporateEmailDeliveryJob"':'"B2bEmailDeliveryJob"');
  expect(query.mock.calls[0][1]).toEqual([null,3,profile]);expect(core.run).toHaveBeenCalledTimes(1);expect(release).toHaveBeenCalledOnce();
  dispatcher.pause();await dispatcher.drain();
 });
 it('rechaza un perfil no permitido',()=>{
  expect(()=>new B2bMailerDispatcher({} as any,{} as any,{} as any,{intervalMs:1000,batchSize:1,profile:'unknown' as any})).toThrow('B2B_MAILER_DISPATCH_PROFILE_INVALID');
 });
});
