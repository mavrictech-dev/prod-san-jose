import type { PrismaService } from '../infrastructure/prisma.service';
import type { ReportsPgPool } from './phase8-reports/types';
import type { BusinessPgPool } from './phase8-business/postgres-store';
import type { BatchSqlPool } from './batch-member-postgres.types';

/** Closed, source-owned metadata probes. No caller text, table names, DDL, migrations or data rows. */
export const billingRuntimeStorageSql = Object.freeze({
  prisma: Object.freeze([
    'SELECT * FROM "DocumentItem" WHERE false',
    'SELECT * FROM "DocumentTax" WHERE false',
    'SELECT * FROM "DocumentReference" WHERE false',
    'SELECT * FROM "DailySummary" WHERE false',
    'SELECT * FROM "DailySummaryItem" WHERE false',
    'SELECT * FROM "IdempotencyRecord" WHERE false',
    'SELECT * FROM "ConfigurationAudit" WHERE false',
    'SELECT * FROM "FinancialLedgerCommit" WHERE false',
    'SELECT * FROM "FinancialLedgerStream" WHERE false',
    'SELECT * FROM "FinancialLedgerVersion" WHERE false',
    'SELECT * FROM "FinancialLedgerEntry" WHERE false',
    'SELECT "issuerRuc","environment","epoch","head","floor" FROM "IntegrationChangeState" WHERE false',
    'SELECT "id","sequence","ownerId","eventKind" FROM "IntegrationChangeEvent" WHERE false',
    'SELECT "referenceId","companyId","branchId","revision" FROM "CarrierReference09Access" WHERE false',
    'SELECT "companyId","revision" FROM "B2bGuideEstablishmentAudit" WHERE false',
    'SELECT "keyHash","window","counter" FROM "B2bGuideEstablishmentRate" WHERE false',
    'SELECT "companyId","revision" FROM "B2bGuideGoodsAudit" WHERE false',
    'SELECT "keyHash","window","counter" FROM "B2bGuideGoodsRate" WHERE false',
    'SELECT "id","ruc","environment","configVersion" FROM "CompanySettings" WHERE false',
    'SELECT "id","companyId","masterRevision" FROM "Branch" WHERE false',
    'SELECT "id","companyId","branchId" FROM "EmissionPoint" WHERE false',
    'SELECT "id","companyId","emissionPointId","documentType","nextNumber" FROM "SeriesCounter" WHERE false',
    'SELECT "id","companyId","immutableSnapshot" FROM "Document" WHERE false',
    'SELECT "id","payload" FROM "OutboxEvent" WHERE false',
    'SELECT "id","binding","validatedRevision" FROM "B2bDocumentDraft" WHERE false',
    'SELECT "id","payload" FROM "B2bDraftOperation" WHERE false',
    'SELECT "id","payload" FROM "B2bCommitEvent" WHERE false',
    'SELECT "id","body","binding","convertedDocumentId" FROM "B2bCommercialResource" WHERE false',
    'SELECT "id","payload" FROM "B2bCommercialOperation" WHERE false',
    'SELECT "issuerId","pointId","nextNumber" FROM "B2bSalesNoteCounter" WHERE false',
    'SELECT "originalDocumentId","revision","headSha256" FROM "B2bCorrectionJournalHead" WHERE false',
    'SELECT "originalDocumentId","revision","event" FROM "B2bCorrectionJournalEvent" WHERE false',
    'SELECT "keySha256","binding","operationId" FROM "B2bCorrectionRequestReceipt" WHERE false',
    'SELECT "id","binding","body" FROM "B2bGuideDraft" WHERE false',
    'SELECT "id","payload" FROM "B2bGuideDraftOperation" WHERE false',
    'SELECT "id","companyId","purpose","revision" FROM "B2bGuideDraftSeries" WHERE false',
    'SELECT "companyId","revision" FROM "B2bGuideEstablishmentHead" WHERE false',
    'SELECT "companyId","revision","payload" FROM "B2bGuideEstablishmentVersion" WHERE false',
    'SELECT "companyId","revision" FROM "B2bGuideGoodsHead" WHERE false',
    'SELECT "companyId","revision","payload" FROM "B2bGuideGoodsVersion" WHERE false',
    'SELECT "draftSeriesId","fiscalSeriesId","revision" FROM "B2bGuideIssueSeries" WHERE false',
    'SELECT "id" FROM "B2bGuideIssueDocument" WHERE false',
    'SELECT "documentId","payload" FROM "B2bGuideIssueReceipt" WHERE false',
    'SELECT "documentId","position","payload" FROM "B2bGuideIssueItem" WHERE false',
    'SELECT "documentId","operationId","payload" FROM "B2bGuideIssueLocalOutbox" WHERE false',
    'SELECT "draftSeriesId","fiscalSeriesId","revision" FROM "CarrierGuideSeries" WHERE false',
    'SELECT "companyId","revision" FROM "CarrierGuideRegistryHead" WHERE false',
    'SELECT "payload" FROM "CarrierGuideRegistryVersion" WHERE false',
    'SELECT "id","payload" FROM "CarrierGuideDraft" WHERE false',
    'SELECT "documentId" FROM "CarrierGuideDocument" WHERE false',
    'SELECT "documentId","payload" FROM "CarrierGuideReceipt" WHERE false',
    'SELECT "documentId","position","payload" FROM "CarrierGuideItem" WHERE false',
    'SELECT "documentId","operationId","payload" FROM "CarrierGuideLocalOutbox" WHERE false',
    'SELECT "documentId","revision" FROM "CarrierReference09Head" WHERE false',
    'SELECT "documentId","revision" FROM "CarrierReference09Version" WHERE false',
    'SELECT "documentId" FROM "CarrierGuideReferenceBinding" WHERE false',
  ]),
  business: Object.freeze([
    'SELECT id,payload,revision FROM "B2bP8Customer" WHERE false',
    'SELECT product_id,revision,source_sha256 FROM "B2bP8ProductRevision" WHERE false',
    'SELECT id,payload,revision FROM "B2bP8Shift" WHERE false',
    'SELECT id,shift_id,payload FROM "B2bP8Movement" WHERE false',
    'SELECT id,actor_key,key_hash,payload FROM "B2bP8Operation" WHERE false',
    'SELECT id,sku,description,"unitCode","sunatProductCode" FROM "FuelProduct" WHERE false',
  ]),
  reports: Object.freeze([
    'SELECT id,owner_key,key_hash,payload,content_bytes,content_purged_at FROM "B2bP8ReportJob" WHERE false',
  ]),
  batches: Object.freeze([
    'SELECT id FROM b2b_batch_member_mutex WHERE false',
    'SELECT document_id,binding,current_version FROM b2b_batch_member_document WHERE false',
    'SELECT document_id,version,record,provenance FROM b2b_batch_member_version WHERE false',
    'SELECT original_id,revision FROM b2b_batch_member_history WHERE false',
    'SELECT grant_key,policy,revision FROM b2b_batch_member_grant WHERE false',
    'SELECT journal_key,record FROM b2b_batch_member_journal WHERE false',
    'SELECT batch_id,command,ubl,subject,request FROM b2b_batch_member_command WHERE false',
    'SELECT counter_key,last_number FROM b2b_batch_member_counter WHERE false',
    'SELECT journal_key,batch_id FROM b2b_batch_member_reservation WHERE false',
    'SELECT document_id,journal_key FROM b2b_batch_member_claim WHERE false',
    'SELECT event_id,batch_id,payload FROM b2b_batch_member_local_outbox WHERE false',
  ]),
});
async function poolMetadata(pool: ReportsPgPool | BusinessPgPool | BatchSqlPool, statements: readonly string[]) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN READ ONLY');
    await connection.query("SET LOCAL statement_timeout = '3s'");
    for (const sql of statements) await connection.query(sql);
  } finally {
    try { await connection.query('ROLLBACK'); } finally { connection.release(); }
  }
}
export async function checkBillingRuntimeStorage(prisma: PrismaService, pools: {
  business: BusinessPgPool; reports: ReportsPgPool; batches: BatchSqlPool;
}) {
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '3s'");
      for (const sql of billingRuntimeStorageSql.prisma) await tx.$queryRawUnsafe(sql);
    }, { timeout: 15000, maxWait: 3000 });
    await poolMetadata(pools.business, billingRuntimeStorageSql.business);
    await poolMetadata(pools.reports, [...billingRuntimeStorageSql.reports, ...billingRuntimeStorageSql.prisma]);
    await poolMetadata(pools.batches, billingRuntimeStorageSql.batches);
  } catch { throw Error('BILLING_RUNTIME_STORAGE_NOT_READY'); }
}
