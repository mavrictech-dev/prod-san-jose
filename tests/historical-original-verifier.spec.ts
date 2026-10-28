import {describe,it,expect} from 'vitest';
import {makeHistoricalOriginal} from '../services/sunat-service/src/application/historical-original-contract';
import {verifyHistoricalOriginal} from '../services/sunat-service/src/application/historical-original-verifier';
import {batchMemberEvidenceFixture,batchMemberTestPki} from './helpers/batch-member-evidence.fixture';
async function setup(type:'01'|'03'){
 const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,type,{unreported:true}),r=f.record;
 let value=makeHistoricalOriginal({handle:'owned-test',member:r.member,binding:r.binding as any,snapshot:r.snapshot as any,
  signerFingerprint:r.signerFingerprint,digestValue:r.digestValue,signedXml:r.signedXml,documentZip:r.requestZip});
 const store={loadExact:async()=>value};
 const ports={store,artifacts:f.artifacts,signatures:f.signatures};
 return {f,ports,run:()=>verifyHistoricalOriginal('owned-test',f.asOf,ports),replace:(v:typeof value)=>{value=v;}};
}
describe('verificación histórica exacta sin aceptación',()=>{
 it.each(['01','03'] as const)('valida XML y ZIP %s y no afirma CDR',async type=>{
  const f=await setup(type),result=await f.run();expect(result.acceptance).toBe('NOT_VERIFIED');expect(result.member).toEqual(f.f.record.member);
 });
 it('rechaza bytes alterados respecto de los metadatos',async()=>{
  const f=await setup('01');f.f.blobs.set(f.f.record.signedXml.id,Buffer.from('alterado'));
  await expect(f.run()).rejects.toThrow('HISTORICAL_ORIGINAL_VERIFICATION_FAILED');
 });
 it('rechaza cambios del propietario durante la verificación',async()=>{
  const f=await setup('03'),original=f.ports.store.loadExact;let calls=0;
  f.ports.store.loadExact=async()=>{const r=await original();if(++calls===2)return {...r,recordSha256:'0'.repeat(64)};return r;};
  await expect(f.run()).rejects.toThrow('HISTORICAL_ORIGINAL_VERIFICATION_FAILED');
 });
});

