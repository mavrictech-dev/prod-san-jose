import {beforeAll,describe,expect,it} from 'vitest';
import {verifyBoletaRcLinked,type BoletaRcLinkedRecord} from '../services/sunat-service/src/application/boleta-rc-linked-b2b09';
import {batchMemberEvidenceFixture,batchMemberTestPki,hash} from './helpers/batch-member-evidence.fixture';
let pki:ReturnType<typeof batchMemberTestPki>;
beforeAll(()=>{pki=batchMemberTestPki();});
async function setup(){
 const f=await batchMemberEvidenceFixture(pki,'03'),s=[...f.summaries.values()][0];
 const record:BoletaRcLinkedRecord={member:structuredClone(f.record.member),ownerVersion:f.record.ownerVersion,
  package:{document:structuredClone(f.record.snapshot),memberXml:structuredClone(f.record.signedXml),memberFingerprint:f.record.signerFingerprint,memberDigest:f.record.digestValue,
   transport:{kind:'RC',zip:structuredClone(s.requestZip),batch:structuredClone(s.batch),signedXml:structuredClone(s.signedXml),fingerprint:s.signerFingerprint,digest:s.digestValue}},
  acceptanceFence:structuredClone(f.record.acceptance!.fence)};
 const ports={loadExact:async(_handle:string)=>structuredClone(record),artifacts:f.artifacts,signatures:f.signatures,
  summary:{current:async()=>structuredClone(s)},cdr:pki.cdrVerifier};
 return {f,s,record,ports,run:()=>verifyBoletaRcLinked('synthetic-version-1',f.asOf,ports)};
}
describe('isolated boleta RC/CDR linkage, synthetic',()=>{
 it('links the individual member and the exact signed RC and CDR',async()=>{
  const x=await setup(),v=await x.run();
  expect(v.member).toEqual(x.record.member);expect(v.ownerVersion).toBe(x.record.ownerVersion);
  expect(v.memberXmlSha256).toBe(x.record.package.memberXml.sha256);
  expect(v.acceptance.fence).toEqual(x.record.acceptanceFence);
  expect(v.acceptance.evidence.source.kind).toBe('CDR_SUMMARY');
  expect(v.transmissionAuthorized).toBe(false);
 });
 it('rejects altered version, hashes, fence and non-RC packages',async()=>{
  for(const mode of ['snapshot','version','fence','individual','type']){
   const x=await setup();
   if(mode==='snapshot')x.record.member.snapshotSha256='a'.repeat(64);
   if(mode==='version')x.record.member.version=0;
   if(mode==='fence')x.record.acceptanceFence.ownerVersion='a'.repeat(64);
   if(mode==='individual')x.record.package.transport={kind:'INDIVIDUAL',zip:x.f.record.requestZip};
   if(mode==='type')(x.record.package.document as any).documentTypeCode='07';
   await expect(x.run()).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');
  }
 });
 it('rejects a different RC version and byte changes including CDR',async()=>{
  for(const mode of ['rc-version','cdr','member','zip']){
   const x=await setup();
   if(mode==='rc-version')x.s.version='e'.repeat(64);
   if(mode==='cdr')x.f.blobs.set(x.s.cdrZip.id,Buffer.from('tampered'));
   if(mode==='member')x.f.blobs.set(x.record.package.memberXml.id,Buffer.from('tampered'));
   if(mode==='zip')x.f.blobs.set(x.s.requestZip.id,Buffer.from('tampered'));
   await expect(x.run()).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');
  }
 });
 it('rejects a forged signed CDR even with a matching descriptor',async()=>{
  const x=await setup(),bad=Buffer.from('forged');x.f.blobs.set(x.s.cdrZip.id,bad);
  x.s.cdrZip.sha256=hash(bad);x.s.cdrZip.sizeBytes=bad.length;
  await expect(x.run()).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');
 });
 it('rejects owner changes and hides private errors',async()=>{
  const x=await setup();let n=0;const orig=x.ports.loadExact;
  x.ports.loadExact=async h=>{const v=await orig(h);if(++n>2)v.ownerVersion='f'.repeat(64);return v;};
  await expect(x.run()).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');
  x.ports.loadExact=async()=>{throw new Error('private secret');};
  await expect(x.run()).rejects.toThrow(/^BOLETA_RC_LINK_VERIFICATION_FAILED$/);
 });
 it('rejects unsafe handles',async()=>{const x=await setup();await expect(verifyBoletaRcLinked('../private',x.f.asOf,x.ports)).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');});
});