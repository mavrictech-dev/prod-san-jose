import type {ReceivedDatabase} from './store';
/** Literal zero-row projections: column/SELECT readiness only, never DDL or grants. */
export const b2bReceivedRuntimeSchemaChecks=Object.freeze([
 'SELECT "id","companyId","recipientRuc","branchId","supplierRuc","supplierName","documentType","fullNumber","series","number","issueDate","currencyCode","payableAmount","projection","xmlSha256","receivedAt","registeredAt","erpReference" FROM "ReceivedDocument" WHERE false',
 'SELECT "id","documentId","ordinal","supplierCode","sunatCode","description","quantity","unitCode","unitValue","unitPrice","amount","detail" FROM "ReceivedItemRecord" WHERE false',
 'SELECT "id","documentId","kind","fileName","sha256","byteLength","bytes","createdAt" FROM "ReceivedArtifact" WHERE false',
 'SELECT "id","documentId","actorId","action","detail","createdAt" FROM "ReceivedAudit" WHERE false',
 'SELECT "companyId","recipientRuc","revision","enabled","mode","settings","encryptedCredentials","configuredBy","updatedAt" FROM "ReceptionConnection" WHERE false',
 'SELECT "id","companyId","actorId","action","revision","detail","createdAt" FROM "ReceptionConnectionAudit" WHERE false',
 'SELECT "id","companyId","recipientRuc","revision","source","status","activeKey","startedAt","finishedAt","counters","errorCode","createdAt" FROM "ReceptionSyncRun" WHERE false',
 'SELECT "companyId","fingerprint","uidValidity","lastUid","updatedAt" FROM "ReceptionMailboxCheckpoint" WHERE false',
 'SELECT "id","companyId","fingerprint","uidValidity","uid","status","counts","createdAt" FROM "ReceptionMessageReceipt" WHERE false',
 'SELECT "id","companyId","recipientRuc","period","supplierRuc","supplierName","documentType","series","number","fullNumber","issueDate","currencyCode","amount","rawRecord","xmlStatus","documentId","observedAt","observedRunId" FROM "ReceptionSirePurchase" WHERE false',
 'SELECT "id","companyId","recipientRuc","period","ordinal","code","recordHash","rawRecord","active","observedAt","observedRunId" FROM "ReceptionSireIncident" WHERE false',
 'SELECT "grantKey","policy","revision" FROM "B2bReceivedReadGrant" WHERE false',
 'SELECT "id","grantKey","revision","adminId","policySha256","createdAt" FROM "B2bReceivedPolicyAudit" WHERE false',
 'SELECT "id","clientId","subjectId","actorKind","scope","action","documentId","artifactId","clientRevision","userAuthRevision","createdAt" FROM "B2bReceivedReadAudit" WHERE false',
 'SELECT "grantKey","policyId","policy","revision" FROM "B2bReceivedWriteGrant" WHERE false',
 'SELECT "id","policyId","revision","adminId","authRevision","policySha256","requestSha256","createdAt" FROM "B2bReceivedWritePolicyAudit" WHERE false',
 'SELECT "key","requestHash","clientId","subjectId","actorKind","scope","action","clientRevision","userAuthRevision","authority","result","createdAt" FROM "B2bReceivedCommand" WHERE false',
 'SELECT "grantKey","policyId","policy","revision" FROM "B2bReceivedAutomationGrant" WHERE false',
 'SELECT "id","policyId","revision","adminId","authRevision","policySha256","requestSha256","createdAt" FROM "B2bReceivedAutomationPolicyAudit" WHERE false',
 'SELECT "id","clientId","subjectId","actorKind","scope","action","clientRevision","userAuthRevision","authority","adminStamp","resourceId","createdAt" FROM "B2bReceivedAutomationAudit" WHERE false',
 'SELECT "key","requestHash","clientId","subjectId","actorKind","scope","action","result","createdAt" FROM "B2bReceivedAutomationCommand" WHERE false',
 'SELECT "runId","clientId","subjectId","actorKind","scope","revision","networkProfile","clientRevision","userAuthRevision","createAuthority","liveAuthority","dispatchVersion","createdAt" FROM "B2bReceivedAutomationRun" WHERE false',
]);
export const b2bReceivedReadOnlySchemaChecks=Object.freeze([
 'SELECT "runId","attempt","status","errorCode","counters","authority","authoritySha256","createdAt" FROM "B2bReceivedReadOnlyAttempt" WHERE false',
 'SELECT "runId","ordinal","scope","recordKey","record","recordSha256","documentId","comparison" FROM "B2bReceivedReadOnlyObservation" WHERE false',
 'SELECT "runId","ordinal","scope","code","sourceSha256" FROM "B2bReceivedReadOnlyIncident" WHERE false',
 'SELECT "scopeHash","scope","revision","configurationSha256","fingerprint","uidValidity","lastUid","runId","updatedAt" FROM "B2bReceivedReadOnlyCursor" WHERE false',
]);
export async function checkB2bReceivedRuntimeSchema(db:ReceivedDatabase,readOnly=false){
 try{
  await db.$transaction(async tx=>{
   for(const sql of [...b2bReceivedRuntimeSchemaChecks,...(readOnly?b2bReceivedReadOnlySchemaChecks:[])]){
    const rows=await tx.$queryRawUnsafe<unknown[]>(sql);if(!Array.isArray(rows)||rows.length)throw Error();
   }
  },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});
 }catch{throw Error('B2B_RECEIVED_RUNTIME_STORAGE_NOT_READY');}
}
