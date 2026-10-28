import type {PrismaService} from '../infrastructure/prisma.service';
import {createBatchMemberEvidence,type BatchMemberPrivateOwnerPort,type BatchEvidenceVersion} from '../application/batch-member-evidence';
import {PostgresBatchMemberEvidenceRepository,createBatchMemberEvidenceProducer,BatchEvidenceRepositoryError,
 type BatchEvidenceSqlPool,type BatchEvidenceCrypto} from '../application/batch-member-evidence.repository';

/** A new verifier per call binds all acceptance reads to the same exact private handle.
 * Stored acceptance records are re-verified against CURRENT public PKI/CRL policy;
 * stored flags/proofs never replace XMLDSig/CDR verification. */
export class PersistentBatchMemberEvidence{
 constructor(private readonly repository:PostgresBatchMemberEvidenceRepository,private readonly crypto:BatchEvidenceCrypto){}
 async resolveHandle(reference:BatchEvidenceVersion){return this.repository.resolveHandle(reference);}
 /** Verify precisely the requested immutable version; never fall back to latest. */
 async verifyExactVersion(reference:BatchEvidenceVersion,asOf:string){
  const requested={...reference};
  const handle=await this.repository.resolveHandle(requested);
  const evidence=await this.verifySignedVersion(handle,asOf);
  if(await this.repository.resolveHandle(requested)!==handle)throw new BatchEvidenceRepositoryError('BATCH_EVIDENCE_OWNER_INVALID');
  return evidence;
 }
 async readiness(){
  await this.repository.assertInfrastructure();
  // Read availability is not an assertion that the missing capture/history producer exists.
  return {schemaVersion:'factuez.b2b.batch-member-ledger-status.v1',environment:'BETA',state:'EXACT_LEDGER_READ_ONLY',
   supportedDocumentTypes:['01','03'],sourceCapture:'NOT_ASSEMBLED',noteHistory:'UNAVAILABLE'} as const;
 }
 async verifySignedVersion(ownerHandle:string,asOf:string){
  // Preserve explicit missing-history error before the legacy core sanitizes private errors.
  await this.repository.load(ownerHandle);
  const ports=this.repository.forHandle(ownerHandle);
  try{return await createBatchMemberEvidence({...this.crypto,...ports}).verifySignedVersion(ownerHandle,asOf);}
  catch(e){
   // Check exact persisted source again to retain VERSION_MISSING if deleted during verification.
   try{await this.repository.load(ownerHandle);}catch(error){if(error instanceof BatchEvidenceRepositoryError)throw error;}
   throw e;
  }
 }
}
export function createPersistentBatchMemberEvidence(options:BatchEvidenceCrypto&{
 db:PrismaService;pool:BatchEvidenceSqlPool;owner:BatchMemberPrivateOwnerPort;
}){
 const repository=new PostgresBatchMemberEvidenceRepository(options.pool);
 const crypto={artifacts:options.artifacts,certificates:options.certificates,trust:options.trust,cdr:options.cdr};
 return Object.freeze({repository,evidence:new PersistentBatchMemberEvidence(repository,crypto),
  producer:createBatchMemberEvidenceProducer({...options,...crypto})});
}


/** Read-only bridge over the EXISTING Prisma owner. It cannot run the capture
 * producer, DDL or arbitrary SQL. Never exports a raw DB connection to requests. */
export function createPrismaBatchMemberLedgerReader(db:Pick<PrismaService,'$queryRawUnsafe'>,crypto:BatchEvidenceCrypto){
 const projection='SELECT owner_handle,document_id,version,snapshot_sha256,payload,payload_sha256 FROM b2b_sunat_batch_member_evidence_version WHERE ';
 const pool:BatchEvidenceSqlPool={connect:async()=>({query:async(sql,values=[])=>{
  if(sql!==projection+'false'&&sql!==projection+'owner_handle=$1'&&sql!==projection+'document_id=$1 AND version=$2 AND snapshot_sha256=$3')throw new BatchEvidenceRepositoryError('BATCH_EVIDENCE_STORAGE_UNAVAILABLE');
  const rows=await db.$queryRawUnsafe<any[]>(sql,...values);return {rows,rowCount:rows.length};
 },release:()=>{/* Prisma retains ownership of its pool. */}})};
 return new PersistentBatchMemberEvidence(new PostgresBatchMemberEvidenceRepository(pool),crypto);
}
