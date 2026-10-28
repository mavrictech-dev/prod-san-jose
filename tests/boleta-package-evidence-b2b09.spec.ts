import {beforeAll,describe,expect,it} from 'vitest';
import {verifyBoletaPackage,type BoletaPackageRecord} from '../services/sunat-service/src/application/boleta-package-evidence-b2b09';
import {batchMemberEvidenceFixture,batchMemberTestPki,hash} from './helpers/batch-member-evidence.fixture';

let pki:ReturnType<typeof batchMemberTestPki>;
beforeAll(()=>{pki=batchMemberTestPki();});
async function setup(){
 const f=await batchMemberEvidenceFixture(pki,'03');
 const summary=[...f.summaries.values()][0];
 const record:BoletaPackageRecord={document:structuredClone(f.record.snapshot),memberXml:structuredClone(f.record.signedXml),
   memberFingerprint:f.record.signerFingerprint,memberDigest:f.record.digestValue,
   transport:{kind:'RC',zip:structuredClone(summary.requestZip),batch:structuredClone(summary.batch),
     signedXml:structuredClone(summary.signedXml),fingerprint:summary.signerFingerprint,digest:summary.digestValue}};
 const ports={load:async()=>structuredClone(record),read:f.artifacts.read,signatures:f.signatures};
 return {f,summary,record,ports,run:()=>verifyBoletaPackage(ports,f.asOf)};
}
describe('03 signed transport evidence, synthetic only',()=>{
 it('proves membership in a signed RC without claiming acceptance',async()=>{
  const x=await setup(),result=await x.run();
  expect(result).toEqual({kind:'RC',memberXmlSha256:x.record.memberXml.sha256,requestZipSha256:x.summary.requestZip.sha256,
   rcXmlSha256:x.summary.signedXml.sha256,rcIdentifier:x.summary.batch.identifier,lineNumber:1});
  expect(result).not.toHaveProperty('acceptance');
 });
 it('also verifies a separate individual ZIP',async()=>{
  const x=await setup();x.record.transport={kind:'INDIVIDUAL',zip:x.f.record.requestZip};
  expect(await x.run()).toMatchObject({kind:'INDIVIDUAL',rcIdentifier:null,lineNumber:null});
 });
 it('rejects a mismatched package, altered bytes and bad metadata',async()=>{
  const x=await setup();if(x.record.transport.kind!=='RC')throw Error();
  x.record.transport.zip=structuredClone(x.f.record.requestZip);await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
  x.record.transport.zip=structuredClone(x.summary.requestZip);x.f.blobs.set(x.summary.requestZip.id,Buffer.from('tampered'));
  await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
 });
 it('rejects absent, modified and duplicated members',async()=>{
  for(const mode of ['absent','changed','duplicate']){
   const x=await setup();if(x.record.transport.kind!=='RC')throw Error();
   const entries=x.record.transport.batch.input.entries;
   if(mode==='absent')entries.length=0;
   if(mode==='changed')entries[0].document.snapshot.fullNumber='B001-999';
   if(mode==='duplicate')entries.push(structuredClone(entries[0]));
   await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
  }
 });
 it('rejects wrong digest, issuer, signer and signature tampering',async()=>{
  for(const mode of ['digest','issuer','fingerprint','signature']){
   const x=await setup();if(x.record.transport.kind!=='RC')throw Error();
   if(mode==='digest')x.record.transport.digest='A'.repeat(43)+'=';
   if(mode==='issuer')x.record.transport.batch.issuer.identityNumber='99999999999';
   if(mode==='fingerprint')x.record.transport.fingerprint='a'.repeat(64);
   if(mode==='signature'){
    const b=Buffer.from(x.f.blobs.get(x.summary.signedXml.id)!);b[b.length-20]^=1;
    const a=x.record.transport.signedXml;a.sha256=hash(b);a.sizeBytes=b.length;x.f.blobs.set(a.id,b);
   }
   await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
  }
 });
 it('rejects owner changes and rejects 07/08 before using their paths',async()=>{
  const x=await setup();let n=0;const original=x.ports.load;
  x.ports.load=async()=>{const v=await original();if(++n>1)v.memberDigest='A'.repeat(43)+'=';return v;};
  await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
  for(const type of ['07','08']){const y=await setup();(y.record.document as any).documentTypeCode=type;await expect(y.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');}
 });
 it('rejects an RC changed and repackaged with matching hashes',async()=>{
  const x=await setup();if(x.record.transport.kind!=='RC')throw Error();
  const t=x.record.transport, xml=Buffer.from(x.f.blobs.get(t.signedXml.id)!);
  const changed=Buffer.from(xml.toString('utf8').replace('SummaryDocuments','SummaryDocumentx'));
  expect(changed.equals(xml)).toBe(false);
  t.signedXml.sha256=hash(changed);t.signedXml.sizeBytes=changed.length;x.f.blobs.set(t.signedXml.id,changed);
  const name=`${x.record.document.issuer.identityNumber}-${t.batch.identifier}.xml`,zip=x.f.pack(name,changed);
  t.zip.sha256=hash(zip);t.zip.sizeBytes=zip.length;x.f.blobs.set(t.zip.id,zip);
  await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
 });
 it('rejects artifact changes during verification',async()=>{
  const x=await setup();let calls=0;const original=x.ports.read;
  x.ports.read=async(id,a)=>{const bytes=await original(id,a);if(++calls>3)return Buffer.from('changed');return bytes;};
  await expect(x.run()).rejects.toThrow('BOLETA_PACKAGE_INVALID');
 });
});