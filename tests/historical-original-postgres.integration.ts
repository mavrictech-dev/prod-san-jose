import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../services/sunat-service/src/infrastructure/artifact-store';
import { createHistoricalSignedArtifactReader } from '../services/sunat-service/src/application/historical-signed-artifact-reader';
import { verifyHistoricalOriginal } from '../services/sunat-service/src/application/historical-original-verifier';
import { batchMemberEvidenceFixture,batchMemberTestPki } from './helpers/batch-member-evidence.fixture';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
import { supplementCommandFixture, supplementUuid as id } from './helpers/fiscal-supplement.fixture';
import { makeHistoricalOriginal } from '../services/sunat-service/src/application/historical-original-contract';
import { PostgresHistoricalOriginalStore } from '../services/sunat-service/src/application/historical-original-postgres-candidate';
const require = createRequire(import.meta.url);
const {newRecoveryCluster, ROOT} = require('./helpers/b2b-recovery-cluster.cjs');
function fixture(type: '01'|'03', handle: string, version = 1) {
 const snapshot = supplementCommandFixture(type === '01' ? 'NOTE' : 'RC').doc;
 if (type === '03') snapshot.documentId = id(92);
 return makeHistoricalOriginal({handle, member:{documentId:snapshot.documentId,version,snapshotSha256:fiscalSnapshotSha256(snapshot)},
  binding:{environment:'BETA',issuerRuc:snapshot.issuer.identityNumber,companyId:snapshot.companyId,branchId:snapshot.branchId,pointId:id(90),seriesId:id(91),series:snapshot.series,documentType:type},
  snapshot, signerFingerprint:'a'.repeat(64),digestValue:'A'.repeat(43)+'=',
  signedXml:{id:id(10),storageKey:'synthetic.xml',sha256:'b'.repeat(64),sizeBytes:100},
  documentZip:{id:id(11),storageKey:'synthetic-individual.zip',sha256:'c'.repeat(64),sizeBytes:200}});
}
describe('PostgreSQL historical candidate, isolated synthetic cluster',()=>{
 it.each(['01','03'] as const)('verifies %s from physical signed artifacts and exact PostgreSQL record',async(type)=>{
  const cluster=await newRecoveryCluster(randomUUID(),'source'),root=await mkdtemp(join(tmpdir(),'factuez-historical-db-'));
  try{
   cluster.sql('BILLING',readFileSync(resolve(ROOT,'services/sunat-service/historical-original.candidate.sql'),'utf8'));
   const db=new PostgresHistoricalOriginalStore(cluster.pool('BILLING')),files=new ArtifactStore(root),pki=batchMemberTestPki();
   const f=await batchMemberEvidenceFixture(pki,type,{unreported:true}),r=f.record,doc=r.snapshot,stem=`${r.binding.issuerRuc}-${type}-${doc.fullNumber}`;
   const save=async(a:typeof r.signedXml,name:string)=>({id:a.id,...await files.put(doc.documentId,name,f.blobs.get(a.id)!)});
   const signedXml=await save(r.signedXml,`${stem}.xml`),documentZip=await save(r.requestZip,`${stem}.zip`);
   const record=makeHistoricalOriginal({handle:'source-physical',member:r.member,binding:r.binding as any,snapshot:doc as any,
    signerFingerprint:r.signerFingerprint,digestValue:r.digestValue,signedXml,documentZip});
   await db.insert(record);
   const ports={store:db,artifacts:createHistoricalSignedArtifactReader(root),signatures:f.signatures};
   const proof=await verifyHistoricalOriginal(record.handle,f.asOf,ports);
   expect(proof.member).toEqual(record.member);expect(proof.acceptance).toBe('NOT_VERIFIED');
   await writeFile(join(root,signedXml.storageKey),Buffer.alloc(signedXml.sizeBytes,65));
   await expect(verifyHistoricalOriginal(record.handle,f.asOf,ports)).rejects.toThrow('HISTORICAL_ORIGINAL_VERIFICATION_FAILED');
  }finally{await cluster.close();await rm(root,{recursive:true,force:true});}
 },120000);

 it('preserves exact records, rejects conflicts and mutation, including concurrent inserts',async()=>{
  const cluster=await newRecoveryCluster(randomUUID(),'source');
  try {
   cluster.sql('BILLING',readFileSync(resolve(ROOT,'services/sunat-service/historical-original.candidate.sql'),'utf8'));
   const pool=cluster.pool('BILLING'),store=new PostgresHistoricalOriginalStore(pool);
   const a=fixture('01','one'), b=fixture('01','two',2), boleta=fixture('03','boleta');
   await Promise.all(Array.from({length:8},()=>store.insert(a)));
   await store.insert(b); await store.insert(boleta);
   expect(await store.loadExact('one')).toEqual(a);
   expect(await store.loadExact('two')).toEqual(b);
   expect((await store.loadExact('boleta'))?.documentZip.storageKey).toBe('synthetic-individual.zip');
   expect(await store.loadExact('missing')).toBeNull();
   await expect(store.loadExact("one' OR true --")).rejects.toThrow('HISTORICAL_ORIGINAL_INVALID');
   await expect(store.insert(fixture('01','alias'))).rejects.toThrow('HISTORICAL_ORIGINAL_CONFLICT');
   await expect(store.insert(fixture('01','one',3))).rejects.toThrow('HISTORICAL_ORIGINAL_CONFLICT');
   await expect(store.insert({...a,recordSha256:'0'.repeat(64)})).rejects.toThrow('HISTORICAL_ORIGINAL_INVALID');
   const contenders=[fixture('01','race-a',4),fixture('01','race-b',4)];
   const race=await Promise.allSettled(contenders.map(x=>store.insert(x)));
   expect(race.filter(x=>x.status==='fulfilled')).toHaveLength(1);
   expect(race.filter(x=>x.status==='rejected')).toHaveLength(1);
   for(const sql of ['UPDATE public.b2b_historical_original_candidate SET handle=handle', 'DELETE FROM public.b2b_historical_original_candidate', 'TRUNCATE public.b2b_historical_original_candidate'])
    await expect(pool.query(sql)).rejects.toThrow('HISTORICAL_ORIGINAL_IMMUTABLE');
   expect((await pool.query('SELECT count(*)::int AS n FROM public.b2b_historical_original_candidate')).rows[0].n).toBe(4);
   const corrupted=new PostgresHistoricalOriginalStore({query:async()=>({rows:[{handle:'one',document_id:a.member.documentId,version:1,record_sha256:'0'.repeat(64),record:a}]})});
   await expect(corrupted.loadExact('one')).rejects.toThrow('HISTORICAL_ORIGINAL_INVALID');
  } finally { await cluster.close(); }
 });
});

