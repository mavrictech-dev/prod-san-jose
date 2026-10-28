import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { linkGeneratedHistoricalOriginal } from '../services/sunat-service/src/application/historical-generation-link-b2b09';
import { PostgresHistoricalOriginalStore } from '../services/sunat-service/src/application/historical-original-postgres-candidate';
import { verifyHistoricalOriginal } from '../services/sunat-service/src/application/historical-original-verifier';
import { batchMemberEvidenceFixture, batchMemberTestPki } from './helpers/batch-member-evidence.fixture';
const require=createRequire(import.meta.url);
const {newRecoveryCluster,ROOT}=require('./helpers/b2b-recovery-cluster.cjs');

describe('generation link with new isolated synthetic PostgreSQL',()=>{
 it.each(['01','03'] as const)('persists and reopens exact %s record',async type=>{
  const cluster=await newRecoveryCluster(randomUUID(),'source');
  try {
   cluster.sql('BILLING',readFileSync(resolve(ROOT,'services/sunat-service/historical-original.candidate.sql'),'utf8'));
   const f=await batchMemberEvidenceFixture(batchMemberTestPki(),type,{unreported:true}),r=f.record;
   const {id:xmlId,...documentXml}=r.signedXml, {id:zipId,...individual}=r.requestZip;
   const manifest={fileName:'synthetic.zip',reference:'synthetic',revision:1,fingerprint:r.signerFingerprint,digest:r.digestValue,
    documentXml,xml:documentXml,zip:type==='03'?{storageKey:'rc.zip',sha256:'0'.repeat(64),sizeBytes:1}:individual,
    ...(type==='03'?{individualXmlZip:individual}:{}),xsdEvidence:{}};
   const input={handle:'synthetic-generated',version:r.member.version,snapshot:r.snapshot as any,binding:r.binding as any,
    snapshotSha256:r.member.snapshotSha256,signedXmlId:xmlId,documentZipId:zipId,manifest,asOf:f.asOf};
   const ports={store:new PostgresHistoricalOriginalStore(cluster.pool('BILLING')),artifacts:f.artifacts,signatures:f.signatures};
   const proof=await linkGeneratedHistoricalOriginal(input,ports);
   const reopened=new PostgresHistoricalOriginalStore(cluster.pool('BILLING'));
   expect((await reopened.loadExact(input.handle))?.recordSha256).toBe(proof.recordSha256);
   expect((await verifyHistoricalOriginal(input.handle,f.asOf,{...ports,store:reopened})).acceptance).toBe('NOT_VERIFIED');
   expect(await reopened.loadExact('missing')).toBeNull();
  } finally {await cluster.close();}
 },120000);
});
