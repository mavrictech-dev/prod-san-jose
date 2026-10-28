import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {createBatchMemberEvidenceProducer,PostgresBatchMemberEvidenceRepository} from '../services/sunat-service/src/application/batch-member-evidence.repository';
import {PersistentBatchMemberEvidence} from '../services/sunat-service/src/b2b/batch-member-evidence-assembly';
import {batchMemberEvidenceFixture,batchMemberTestPki} from './helpers/batch-member-evidence.fixture';
const {withCorrectionDatabase}=createRequire(import.meta.url)('./helpers/correction-reservation-db.cjs');
if(process.env.FACTUEZ_EVIDENCE_CAPTURE_DB!=='NEW_NETWORK_NONE_TMPFS_ONLY')throw Error('EXPLICIT_NEW_DATABASE_RUNNER_REQUIRED');

/** PostgreSQL is real and disposable; owners and public trust policy are
 * synthetic. XML signing and cryptographic verification are genuine. */
describe('signed original capture in NEW isolated PostgreSQL',()=>{
 it.each(['01','03'] as const)('persists %s evidence once, replays the handle and rejects changed ownership',async(type)=>{
  await withCorrectionDatabase(async({pool}:any)=>{
   await pool.query(readFileSync(new URL('../services/sunat-service/src/b2b/batch-member-evidence-schema.candidate.sql',import.meta.url),'utf8'));
   const pki=batchMemberTestPki(),f=await batchMemberEvidenceFixture(pki,type,{unreported:true}),record=f.record;
   const db={fiscalDocument:{findFirst:vi.fn(async()=>({immutablePayload:record.snapshot,documentId:record.member.documentId,
    documentType:record.binding.documentType,series:record.binding.series,number:record.snapshot.number,digestValue:record.digestValue,
    artifacts:[{...record.signedXml,kind:'SIGNED_XML'},{...record.requestZip,kind:'SUBMISSION_ZIP'}]}))}};
   const producer=createBatchMemberEvidenceProducer({artifacts:f.artifacts,certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier,owner:f.owner,pool,db:db as any});
   const [first,second]=await Promise.all([producer.capture('synthetic-capture-1',f.asOf),producer.capture('synthetic-capture-1',f.asOf)]);
   expect(await producer.capture('synthetic-capture-1',f.asOf)).toEqual(first);
   expect(second).toEqual(first);
   const repository=new PostgresBatchMemberEvidenceRepository(pool);
   expect((await repository.load(first.ownerHandle)).record.member).toEqual(record.member);
   const ledger=new PersistentBatchMemberEvidence(repository,{artifacts:f.artifacts,certificates:f.certificates,trust:f.trust,cdr:pki.cdrVerifier});
   expect(await ledger.resolveHandle(first.member)).toBe(first.ownerHandle);
   expect(await ledger.verifyExactVersion(first.member,f.asOf)).toBeTruthy();
   await expect(ledger.verifyExactVersion({...first.member,version:first.member.version+1},f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
   await expect(ledger.verifyExactVersion({...first.member,snapshotSha256:'0'.repeat(64)},f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_VERSION_MISSING'});
   expect((await pool.query('SELECT count(*)::int AS n FROM b2b_sunat_batch_member_evidence_version')).rows[0].n).toBe(1);
   for(const sql of ['UPDATE b2b_sunat_batch_member_evidence_version SET version=2','DELETE FROM b2b_sunat_batch_member_evidence_version','TRUNCATE b2b_sunat_batch_member_evidence_version'])
    await expect(pool.query(sql)).rejects.toThrow('BATCH_EVIDENCE_IMMUTABLE');
   for(const payload of [{},{source:'OWNED'},{source:'OWNED',record:{member:{}}}])
    await expect(pool.query('INSERT INTO b2b_sunat_batch_member_evidence_version(owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256) VALUES($1,$2,1,$3,$4::jsonb,$3)',
     ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','a'.repeat(64),JSON.stringify(payload)])).rejects.toMatchObject({code:'23514'});
   record.ownerVersion='e'.repeat(64);
   await expect(producer.capture('synthetic-capture-1',f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_CHANGED'});
   expect((await pool.query('SELECT count(*)::int AS n FROM b2b_sunat_batch_member_evidence_version')).rows[0].n).toBe(1);
  });
 },120000);
});
