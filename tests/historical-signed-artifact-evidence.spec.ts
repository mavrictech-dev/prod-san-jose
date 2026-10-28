import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ArtifactStore} from '../services/sunat-service/src/infrastructure/artifact-store';
import {createHistoricalSignedArtifactReader} from '../services/sunat-service/src/application/historical-signed-artifact-reader';
import {createBatchMemberEvidence} from '../services/sunat-service/src/application/batch-member-evidence';
import {batchMemberEvidenceFixture,batchMemberTestPki} from './helpers/batch-member-evidence.fixture';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
describe('lectura física y firma XML de evidencia histórica ficticia',()=>{
 it.each(['01','03'] as const)('verifica %s y rechaza XML alterado en disco',async(type)=>{
  const root=await mkdtemp(join(tmpdir(),'factuez-signed-evidence-'));roots.push(root);
  const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,type,{unreported:true});
  const store=new ArtifactStore(root),record=f.record,stem=`${record.binding.issuerRuc}-${type}-${record.snapshot.fullNumber}`;
  const originalXml=f.blobs.get(record.signedXml.id)!,originalZip=f.blobs.get(record.requestZip.id)!;
  record.signedXml={id:record.signedXml.id,...await store.put(record.member.documentId,`${stem}.xml`,originalXml)};
  record.requestZip={id:record.requestZip.id,...await store.put(record.member.documentId,`${stem}.zip`,originalZip)};
  const reader=createHistoricalSignedArtifactReader(root);
  const verifier=createBatchMemberEvidence({owner:f.owner,artifacts:reader,certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier,
   individual:{load:vi.fn(async()=>null)},summary:{current:vi.fn(async()=>null)}});
  const result=await verifier.verifySignedVersion('opaque-member-version-1',f.asOf);
  expect(result.snapshot.documentId).toBe(record.member.documentId);expect(result.acceptance).toBeNull();
  expect(result.provenance.signedXmlSha256).toBe(record.signedXml.sha256);
  await writeFile(join(root,record.signedXml.storageKey),Buffer.alloc(originalXml.length,65));
  await expect(verifier.verifySignedVersion('opaque-member-version-1',f.asOf)).rejects.toBeDefined();
 });
 it.each(['01','07','08'] as const)('verifica XML y CDR firmados para %s ficticio en archivos físicos',async(type)=>{
  const root=await mkdtemp(join(tmpdir(),'factuez-signed-cdr-'));roots.push(root);
  const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,type);
  const store=new ArtifactStore(root),record=f.record,accepted=[...f.individuals.values()].find(x=>x.document.documentId===record.member.documentId)!;
  const save=async(doc:string,a:typeof record.signedXml,name:string)=>({id:a.id,...await store.put(doc,name,f.blobs.get(a.id)!)});
  for(const item of f.individuals.values()){
   const doc=item.document.documentId;
   item.signedXml=await save(doc,item.signedXml,'document.xml');item.requestZip=await save(doc,item.requestZip,'request.zip');item.cdrZip=await save(doc,item.cdrZip,'cdr.zip');
  }
  record.signedXml=accepted.signedXml;record.requestZip=accepted.requestZip;
  const proof=await f.resolver.verify(record.snapshot,f.asOf);record.acceptance={kind:'INDIVIDUAL',fence:structuredClone(proof.fence)};
  const verifier=createBatchMemberEvidence({owner:f.owner,artifacts:createHistoricalSignedArtifactReader(root),certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier,
   individual:{load:vi.fn(async(_ruc,_environment,id)=>{const found=[...f.individuals.values()].find(x=>x.document.documentId===id);return found?structuredClone(found):null;})},
   summary:{current:vi.fn(async()=>null)}});
  const result=await verifier.verifySignedVersion('opaque-member-version-1',f.asOf);
  expect(result.acceptance?.responseCode).toBe('0');expect(result.provenance.cdrSha256).toBe(accepted.cdrZip.sha256);
  await writeFile(join(root,accepted.cdrZip.storageKey),Buffer.alloc(accepted.cdrZip.sizeBytes,65));
  await expect(verifier.verifySignedVersion('opaque-member-version-1',f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
 });
 it.each(['03','07','08'] as const)('verifica resumen y CDR físicos de %s ficticio de boleta',async(type)=>{
  const root=await mkdtemp(join(tmpdir(),'factuez-summary-cdr-'));roots.push(root);
  const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,type,{boleta:true});
  const store=new ArtifactStore(root),record=f.record,summary=[...f.summaries.values()].find(x=>x.batch.input.entries.some(e=>e.document.snapshot.documentId===record.member.documentId))!;
  const save=async(doc:string,a:typeof record.signedXml,name:string)=>({id:a.id,...await store.put(doc,name,f.blobs.get(a.id)!)});
  record.signedXml=await save(record.member.documentId,record.signedXml,'member.xml');
  record.requestZip=await save(record.member.documentId,record.requestZip,'member.zip');
  for(const item of f.summaries.values()){
   const doc=item.batch.documentId;
   item.signedXml=await save(doc,item.signedXml,'summary.xml');item.requestZip=await save(doc,item.requestZip,'summary.zip');item.cdrZip=await save(doc,item.cdrZip,'cdr.zip');
  }
  const proof=await f.resolver.verify(record.snapshot,f.asOf);record.acceptance={kind:'SUMMARY',fence:structuredClone(proof.fence)};
  const verifier=createBatchMemberEvidence({owner:f.owner,artifacts:createHistoricalSignedArtifactReader(root),certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier,
   individual:{load:vi.fn(async()=>null)},summary:{current:vi.fn(async(document)=>{const found=[...f.summaries.values()].find(x=>x.batch.input.entries.some(e=>e.document.snapshot.documentId===document.documentId));return found?structuredClone(found):null;})}});
  const result=await verifier.verifySignedVersion('opaque-member-version-1',f.asOf);
  expect(result.acceptance?.responseCode).toBe('0');expect(result.provenance.cdrSha256).toBe(summary.cdrZip.sha256);
  await writeFile(join(root,summary.cdrZip.storageKey),Buffer.alloc(summary.cdrZip.sizeBytes,65));
  await expect(verifier.verifySignedVersion('opaque-member-version-1',f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
 });
});
