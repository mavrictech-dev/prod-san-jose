import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArtifactStore} from '../services/sunat-service/src/infrastructure/artifact-store';
import {createHistoricalSignedArtifactReader} from '../services/sunat-service/src/application/historical-signed-artifact-reader';
import {verifyBoletaPackage,type BoletaPackageRecord} from '../services/sunat-service/src/application/boleta-package-evidence-b2b09';
import {verifyBoletaRcLinked} from '../services/sunat-service/src/application/boleta-rc-linked-b2b09';
import {BetaOwnerSummaryAcceptance} from '../services/sunat-service/src/application/beta-owner-summary-acceptance';
import {batchMemberEvidenceFixture,batchMemberTestPki} from './helpers/batch-member-evidence.fixture';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe('boleta, resumen RC y CDR físicos: prueba aislada',()=>{
 it('vincula el mismo RC firmado con su CDR, sin confundir el XML individual',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factuez-rc-evidence-'));roots.push(root);
  const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,'03');
  const store=new ArtifactStore(root),reader=createHistoricalSignedArtifactReader(root),summary=[...f.summaries.values()][0],doc=f.record.snapshot;
  const save=async(owner:string,a:typeof f.record.signedXml,name:string)=>({id:a.id,...await store.put(owner,name,f.blobs.get(a.id)!)});
  const memberXml=await save(doc.documentId,f.record.signedXml,'boleta.xml');
  summary.signedXml=await save(summary.batch.documentId,summary.signedXml,'summary.xml');
  summary.requestZip=await save(summary.batch.documentId,summary.requestZip,'summary.zip');
  summary.cdrZip=await save(summary.batch.documentId,summary.cdrZip,'cdr.zip');
  const record:BoletaPackageRecord={document:structuredClone(doc),memberXml,memberFingerprint:f.record.signerFingerprint,memberDigest:f.record.digestValue,
   transport:{kind:'RC',zip:summary.requestZip,batch:summary.batch,signedXml:summary.signedXml,fingerprint:summary.signerFingerprint,digest:summary.digestValue}};
  const ports={load:async()=>structuredClone(record),read:reader.read,signatures:f.signatures};
  const packageProof=await verifyBoletaPackage(ports,f.asOf);
  const verifier=new BetaOwnerSummaryAcceptance({current:async()=>structuredClone(summary)},reader,f.signatures,pki.cdrVerifier);
  const acceptance=await verifier.verify(doc,f.asOf);
  expect(packageProof.requestZipSha256).toBe(acceptance.fence.requestZipSha256);
  expect(packageProof.rcXmlSha256).toBe(acceptance.fence.signedXmlSha256);
  expect(packageProof.rcIdentifier).toBe(acceptance.evidence.source.identifier);
  expect(acceptance.evidence.responseCode).toBe('0');
  const linked={member:f.record.member,ownerVersion:f.record.ownerVersion,package:record,acceptanceFence:acceptance.fence};
  const linkedPorts={loadExact:async()=>structuredClone(linked),artifacts:reader,signatures:f.signatures,
   summary:{current:async()=>structuredClone(summary)},cdr:pki.cdrVerifier};
  const proof=await verifyBoletaRcLinked('fixture-handle',f.asOf,linkedPorts);
  expect(proof.member.snapshotSha256).toBe(f.record.member.snapshotSha256);
  expect(proof.acceptance.fence.cdrZipSha256).toBe(summary.cdrZip.sha256);
  await writeFile(join(root,summary.cdrZip.storageKey),Buffer.alloc(summary.cdrZip.sizeBytes,65));
  await expect(verifier.verify(doc,f.asOf)).rejects.toBeDefined();
  await expect(verifyBoletaRcLinked('fixture-handle',f.asOf,linkedPorts)).rejects.toThrow('BOLETA_RC_LINK_VERIFICATION_FAILED');
  await expect(verifyBoletaPackage(ports,f.asOf)).resolves.toEqual(packageProof);
 });
});
