import type {PrismaClient,Prisma} from '../generated/prisma/client';
import type {B2bHistoryRuntimeConfig} from './runtime-config';
export type HistoryRuntimeDatabase=Pick<PrismaClient,'$transaction'|'$disconnect'>;
export const b2bHistoryRuntimeSchemaChecks=Object.freeze([
 'SELECT "id","markerId","schemaVersion","environment","datasetClass" FROM "HistorySandbox" WHERE false',
 'SELECT "companyId","issuerRuc" FROM "HistoryIssuer" WHERE false',
 'SELECT "mappingId","issuerRuc","companyId","branchId","emissionPointId","seriesCounterId","documentTypeCode","series","mappingSha256" FROM "HistoryOwnerMapping" WHERE false',
 'SELECT "jobId","inputSha256","planSha256","mappingSha256","expectedRows","batchSize","completedBatches","actorId","createdAt" FROM "HistoryImportJob" WHERE false',
 'SELECT "jobId","batchIndex","recordsSha256","rowCount","insertedCount","actorId","createdAt" FROM "HistoryBatchReceipt" WHERE false',
 'SELECT "recordId","mappingId","issuerRuc","companyId","branchId","emissionPointId","seriesCounterId","documentTypeCode","series","number","originSystem","originId","issueDate","currencyCode","taxableAmount","igvAmount","payableAmount","snapshotSha256","snapshot","artifactKeys","candidateOnly","disposition","createdAt" FROM "HistoryRecord" WHERE false',
 'SELECT "jobId","batchIndex","rowOrdinal","recordId","snapshotSha256" FROM "HistoryRecordImportLink" WHERE false',
 'SELECT "actorId","revision","active","actor" FROM "B2bHistoryArchiveActor" WHERE false',
 'SELECT "enrollmentId","revision","active","environment","datasetClass","permission","clientId","actorKind","subjectId","clientRevision","userAuthRevision","binding","bindingSha256","actorId","actorRevision" FROM "B2bHistoryArchiveGrant" WHERE false',
]);
export async function historyRuntimeAttestation(tx:Prisma.TransactionClient,c:B2bHistoryRuntimeConfig){
 const current=await tx.$queryRawUnsafe<{database:string;role:string}[]>('SELECT current_database() AS database, current_user AS role');
 if(current.length!==1||current[0].database!==c.database.name||current[0].role!=='history_reader_qa')throw Error('B2B_HISTORY_QA_CONNECTION_REQUIRED');
 const marker=await tx.historySandbox.findUnique({where:{id:1}});
 if(!marker||marker.markerId!==c.markerId||marker.schemaVersion!=='factuez.history-storage.v1'||marker.environment!=='BETA'||marker.datasetClass!=='SYNTHETIC')throw Error('B2B_HISTORY_QA_MARKER_REQUIRED');
}
export async function checkB2bHistoryRuntimeSchema(db:HistoryRuntimeDatabase,c:B2bHistoryRuntimeConfig){
 try{await db.$transaction(async tx=>{
  await historyRuntimeAttestation(tx,c);
  for(const sql of b2bHistoryRuntimeSchemaChecks){const rows=await tx.$queryRawUnsafe<unknown[]>(sql);if(!Array.isArray(rows)||rows.length)throw Error();}
 },{isolationLevel:'Serializable',maxWait:2000,timeout:20000});}
 catch{throw Error('B2B_HISTORY_RUNTIME_STORAGE_NOT_READY');}
}
