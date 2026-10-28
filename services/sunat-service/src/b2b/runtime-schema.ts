import type {B2bSunatRuntimeDependencies} from './runtime-types';
export const sunatRuntimeSchemaChecks=Object.freeze({
 READ:[
  'SELECT "issuerRuc","environment","epoch","head","floor" FROM "IntegrationChangeState" WHERE false',
  'SELECT "id","issuerRuc","environment","epoch","sequence","ownerKind","ownerId","eventKind","occurredAt","artifactId" FROM "IntegrationChangeEvent" WHERE false',
  'SELECT "issuerRuc","ownerKind","ownerId" FROM "IntegrationChangeBinding" WHERE false',
  'SELECT "documentId","issuerRuc","environment","documentType","series","number","immutablePayload","status" FROM "FiscalDocument" WHERE false',
  'SELECT "id","summaryId","issuerRuc","environment","identifier","immutablePayload" FROM "FiscalBatch" WHERE false',
  'SELECT "id","documentId","kind","storageKey","mediaType","sizeBytes","sha256","createdAt" FROM "DocumentArtifact" WHERE false',
  'SELECT "id","batchId","kind","storageKey","mediaType","sizeBytes","sha256","createdAt" FROM "BatchArtifact" WHERE false',
  'SELECT "documentId","batchId","submissionId" FROM "CdrLog" WHERE false',
  'SELECT "id","batchId" FROM "SunatSubmission" WHERE false',
  'SELECT "id","clientId","clientRevision","actorKind","subjectId","userAuthRevision","issuerRuc","ownerId","artifactId","representation","sha256","byteLength","at" FROM "B2bArtifactAudit" WHERE false',
 ],
 GUIDE_ARTIFACTS:[
  'SELECT "operationId","documentId","issuerRuc","fullNumber","metadata","metadataSha256","unsignedXml","signedXml","zip","certificatePem" FROM "GuideLocalArtifact" WHERE false',
  'SELECT "operationId","packageSha256","evidence","zip" FROM "GuideLocalCdr" WHERE false',
 ],
 BATCH_ARTIFACTS:[
  'SELECT "batchId","eventId","commandSha256","issuerRuc","identifier","metadata","metadataSha256","unsignedXml","signedXml","zip","certificatePem" FROM "BatchLocalArtifact" WHERE false',
  'SELECT "batchId","packageSha256","evidence","zip" FROM "BatchLocalCdr" WHERE false',
 ],
 CORRECTION_EVIDENCE:[
  'SELECT "documentId","billingEventId","digestValue","acceptedAt","updatedAt" FROM "FiscalDocument" WHERE false',
  'SELECT "id","summaryId","billingEventId","status","updatedAt" FROM "FiscalBatch" WHERE false',
  'SELECT "id","documentId","batchId","channel","result","errorCode","errorMessage","idempotencyKey","requestArtifactKey","responseArtifactKey","startedAt","completedAt" FROM "SunatSubmission" WHERE false',
  'SELECT "documentId","batchId","submissionId","responseCode","cdrStorageKey","cdrSha256" FROM "CdrLog" WHERE false',
 ],
 PRIVILEGED_ADMIN:[
  'SELECT "id","issuerRuc","environment","revision","certificateCipher","certificatePasswordCipher","certificateStorageKey","certificateFingerprint","certificateExpiresAt","certificateSelfSigned","solUsernameCipher","solPasswordCipher","greClientIdCipher","greClientSecretCipher","secretsKeyVersion","updatedAt" FROM "SunatCredentials" WHERE false',
  'SELECT "id","issuerRuc","environment","actorId","fields","revision","occurredAt" FROM "FiscalConfigurationAudit" WHERE false',
 ],
} as const);
export type SunatRuntimeCapability=keyof typeof sunatRuntimeSchemaChecks;
/** Fixed projections prove names/access, not migrations, PKI readiness, row correctness or global quiescence. */
export async function checkSunatRuntimeSchema(db:Pick<B2bSunatRuntimeDependencies['prisma'],'$queryRawUnsafe'>,capabilities:readonly SunatRuntimeCapability[]){
 try{for(const capability of capabilities)for(const sql of sunatRuntimeSchemaChecks[capability]){const rows=await db.$queryRawUnsafe<unknown[]>(sql);if(!Array.isArray(rows)||rows.length)throw Error();}}
 catch{throw Error('B2B_SUNAT_RUNTIME_STORAGE_NOT_READY');}
}

