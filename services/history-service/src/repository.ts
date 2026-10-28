import { assertHistory, HistoryError, historicalSha256, historyInteger, historyJson, historyObject, historySha, historyUuid,
  prepareHistoricalImport, validateHistoricalSnapshot, type HistoricalImportPlan, type HistoricalDocumentSnapshotV1 } from '@factuez/history-core';
import type { Prisma, PrismaClient, HistoryRecord } from './generated/prisma/client';
import { historyActor, historyListQuery, historyScopeWhere } from './access';
import { summarizeHistoricalSelection, HISTORY_FULL_LIMITS } from '@factuez/history-core';

type Tx = Prisma.TransactionClient;
export type SandboxAttestation = Readonly<{ databaseName: string; markerId: string }>;
export type StoredArtifactKeys = ReadonlyArray<{ recordId: string; snapshotSha256: string; keys: readonly { kind: string; key: string }[] }>;
const mappingFields = ['mappingId','issuerRuc','companyId','branchId','emissionPointId','seriesCounterId','documentTypeCode','series'] as const;
const policy = { candidateOnly: true as const, fiscalAuthority: false as const, cdrAuthenticityVerified: false as const,
  transmission: false as const, countersChanged: false as const, disposition: 'QUARANTINED' as const };
function sandbox(input: unknown): SandboxAttestation {
  const a = historyJson(input); historyObject(a,['databaseName','markerId']);
  assertHistory(typeof a.databaseName === 'string' && /^factuez_history_qa_[a-f0-9]{10}(?:_restore)?$/.test(a.databaseName), 'SANDBOX_NAME_REQUIRED');
  return { databaseName: a.databaseName, markerId: historyUuid(a.markerId) };
}
function keysFor(snapshot: HistoricalDocumentSnapshotV1, sha: string) {
  return snapshot.artifacts.map(a => ({ kind: a.kind, key: `${sha}/${a.kind}/${a.originalName}` }));
}
/** Own DB only. No Billing Document/Counter, SUNAT, Redis, Outbox or network SDK. */
export class HistoryArchiveRepository {
  private readonly attestation: SandboxAttestation;
  constructor(private readonly prisma: Pick<PrismaClient,'$transaction'>, attestation: SandboxAttestation,
    private readonly accessMode:'GENERAL'|'READ_ONLY'='GENERAL') {
    this.attestation = sandbox(attestation); assertHistory(['GENERAL','READ_ONLY'].includes(accessMode),'INVALID_ACCESS_MODE');
  }
  private async transaction<T>(action: (tx: Tx) => Promise<T>, importer = false): Promise<T> {
    assertHistory(this.accessMode!=='READ_ONLY'||!importer,'SANDBOX_ROLE_READONLY');
    for (let attempt = 0; ; attempt++) {
      try { return await this.prisma.$transaction(async tx => {
        const current = await tx.$queryRaw<Array<{ database: string; role: string }>>`SELECT current_database() AS database, current_user AS role`;
        assertHistory(current.length === 1 && current[0].database === this.attestation.databaseName &&
          ['history_import_qa','history_reader_qa'].includes(current[0].role), 'SANDBOX_CONNECTION_MISMATCH');
        assertHistory(!importer || current[0].role === 'history_import_qa', 'SANDBOX_ROLE_READONLY');
        assertHistory(this.accessMode!=='READ_ONLY'||current[0].role==='history_reader_qa','SANDBOX_READER_REQUIRED');
        const marker = await tx.historySandbox.findUnique({ where:{ id:1 } });
        assertHistory(marker?.markerId === this.attestation.markerId && marker.schemaVersion === 'factuez.history-storage.v1' &&
          marker.environment === 'BETA' && marker.datasetClass === 'SYNTHETIC', 'SANDBOX_MARKER_MISMATCH');
        return action(tx);
      }, { isolationLevel:'Serializable', maxWait:2_000, timeout:20_000 }); }
      catch (error) {
        if (attempt < 2 && (error as {code?:string})?.code === 'P2034') continue;
        throw error instanceof HistoryError ? error : new HistoryError('HISTORY_STORAGE_FAILED');
      }
    }
  }
  private async ownMap(tx: Tx, plan: HistoricalImportPlan) {
    for (const expected of plan.normalized.mappings) {
      const actual = await tx.historyOwnerMapping.findUnique({ where:{mappingId:expected.mappingId} });
      assertHistory(actual && mappingFields.every(k => actual[k] === expected[k]) &&
        actual.mappingSha256 === historicalSha256(expected), 'OWN_MAPPING_MISMATCH');
    }
  }
  private jobBinding(job: { inputSha256:string; planSha256:string; mappingSha256:string; expectedRows:number; batchSize:number; completedBatches:number }, plan:HistoricalImportPlan) {
    assertHistory(job.inputSha256 === plan.inputSha256 && job.planSha256 === plan.planSha256 && job.mappingSha256 === plan.mappingSha256 &&
      job.expectedRows === plan.records.length && job.batchSize === 50 && Number.isInteger(job.completedBatches) &&
      job.completedBatches >= 0 && job.completedBatches <= plan.batches.length, 'JOB_BINDING_MISMATCH');
  }
  private verifyRecord(row: HistoryRecord, expected?: HistoricalImportPlan['records'][number]) {
    const snapshot = validateHistoricalSnapshot(row.snapshot), sha = historicalSha256(snapshot), m = snapshot.ownership;
    const fiscalKey = JSON.stringify([m.issuerRuc,m.documentTypeCode,m.series,snapshot.number]);
    const originKey = JSON.stringify([m.companyId,snapshot.originSystem,snapshot.originId]);
    assertHistory(row.recordId === historicalSha256({fiscalKey,originKey}) && row.snapshotSha256 === sha &&
      (!expected || expected.recordId === row.recordId && expected.snapshotSha256 === sha) &&
      mappingFields.every(k => row[k] === m[k]) && row.number.toString() === snapshot.number &&
      row.originSystem === 'RESTOAPP' && row.originId === snapshot.originId && row.currencyCode === snapshot.currencyCode &&
      row.issueDate.toISOString() === new Date(snapshot.issueDate).toISOString() && row.taxableAmount.toFixed(2) === snapshot.amounts.taxableAmount &&
      row.igvAmount.toFixed(2) === snapshot.amounts.igvAmount && row.payableAmount.toFixed(2) === snapshot.amounts.payableAmount &&
      row.candidateOnly && row.disposition === 'QUARANTINED' && historicalSha256(row.artifactKeys) === historicalSha256(keysFor(snapshot,sha)), 'RECORD_INTEGRITY');
    return snapshot;
  }
  private async prefix(tx: Tx, plan: HistoricalImportPlan, completed: number) {
    const receipts = await tx.historyBatchReceipt.findMany({ where:{jobId:plan.jobId}, orderBy:{batchIndex:'asc'}, include:{links:{orderBy:{rowOrdinal:'asc'},include:{record:true}}} });
    assertHistory(receipts.length === completed, 'CHECKPOINT_INTEGRITY');
    receipts.forEach((receipt,index) => {
      const batch = plan.batches[index];
      assertHistory(receipt.batchIndex === index && receipt.recordsSha256 === batch.recordsSha256 && receipt.rowCount === batch.count &&
        receipt.insertedCount >= 0 && receipt.insertedCount <= batch.count && receipt.links.length === batch.count, 'CHECKPOINT_INTEGRITY');
      receipt.links.forEach((link,i) => {
        const expected = batch.records[i];
        assertHistory(link.rowOrdinal === batch.startOrdinal + i && link.recordId === expected.recordId &&
          link.snapshotSha256 === expected.snapshotSha256, 'CHECKPOINT_INTEGRITY'); this.verifyRecord(link.record,expected);
      });
    });
  }
  async preflight(input: unknown, actorInput: unknown) {
    const actor = historyActor(actorInput,'history.import'), plan = prepareHistoricalImport(input);
    await this.transaction(tx => this.ownMap(tx,plan),true); return { plan, actor };
  }
  async checkpoint(input: unknown, actorInput: unknown) {
    historyActor(actorInput,'history.import'); const plan = prepareHistoricalImport(input);
    return this.transaction(async tx => { await this.ownMap(tx,plan);
      const job = await tx.historyImportJob.findUnique({where:{jobId:plan.jobId}});
      if (job) { this.jobBinding(job,plan); await this.prefix(tx,plan,job.completedBatches); }
      return { jobId:plan.jobId, planSha256:plan.planSha256, completedBatches:job?.completedBatches ?? 0,
        totalBatches:plan.batches.length, complete:job?.completedBatches === plan.batches.length, ...policy };
    },true);
  }
  async commitBatch(input: unknown, batchIndexInput: unknown, actorInput: unknown, keyInput: unknown) {
    const actor = historyActor(actorInput,'history.import'), plan = prepareHistoricalImport(input);
    const batchIndex = historyInteger(batchIndexInput,plan.batches.length - 1,0), batch = plan.batches[batchIndex];
    const keys = historyJson(keyInput);
    assertHistory(Array.isArray(keys) && keys.length === batch.count, 'ARTIFACT_MANIFEST_MISMATCH');
    keys.forEach((k,i) => { historyObject(k,['recordId','snapshotSha256','keys']); const r = batch.records[i];
      assertHistory(k.recordId === r.recordId && k.snapshotSha256 === r.snapshotSha256 && historicalSha256(k.keys) ===
        historicalSha256(keysFor(r.snapshot,r.snapshotSha256)), 'ARTIFACT_MANIFEST_MISMATCH'); });
    return this.transaction(async tx => {
      for (const ruc of [...new Set(plan.normalized.mappings.map(m => m.issuerRuc))].sort())
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`history-archive:${ruc}`},0))`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`history-job:${plan.jobId}`},0))`;
      await this.ownMap(tx,plan);
      let job = await tx.historyImportJob.findUnique({where:{jobId:plan.jobId}});
      if (job) { this.jobBinding(job,plan); await this.prefix(tx,plan,job.completedBatches); }
      const completed = job?.completedBatches ?? 0;
      assertHistory(batchIndex <= completed, 'BATCH_OUT_OF_ORDER');
      if (batchIndex < completed) return { jobId:plan.jobId, batchIndex, rowCount:batch.count, insertedCount:0,
        completedBatches:completed, complete:completed === plan.batches.length, persisted:true, deduplicated:true, ...policy };
      if (!job) job = await tx.historyImportJob.create({data:{jobId:plan.jobId,inputSha256:plan.inputSha256,planSha256:plan.planSha256,
        mappingSha256:plan.mappingSha256,expectedRows:plan.records.length,batchSize:50,actorId:actor.userId}});
      let inserted = 0;
      for (let i=0;i<batch.records.length;i++) {
        const r = batch.records[i], d = r.snapshot, m = d.ownership;
        const fiscal = await tx.historyRecord.findUnique({where:{issuerRuc_documentTypeCode_series_number:{issuerRuc:m.issuerRuc,documentTypeCode:m.documentTypeCode,series:m.series,number:BigInt(d.number)}}});
        const origin = await tx.historyRecord.findUnique({where:{companyId_originSystem_originId:{companyId:m.companyId,originSystem:d.originSystem,originId:d.originId}}});
        if (fiscal || origin) {
          assertHistory(fiscal && origin && fiscal.recordId === origin.recordId, 'IDENTITY_CONFLICT'); this.verifyRecord(fiscal,r);
        } else {
          await tx.historyRecord.create({data:{recordId:r.recordId,...m,number:BigInt(d.number),originSystem:d.originSystem,originId:d.originId,
            issueDate:new Date(d.issueDate),currencyCode:d.currencyCode,taxableAmount:d.amounts.taxableAmount,igvAmount:d.amounts.igvAmount,payableAmount:d.amounts.payableAmount,
            snapshotSha256:r.snapshotSha256,snapshot:d as unknown as Prisma.InputJsonValue,artifactKeys:keys[i].keys,
            candidateOnly:true,disposition:'QUARANTINED'}}); inserted++;
        }
      }
      await tx.historyBatchReceipt.create({data:{jobId:plan.jobId,batchIndex,recordsSha256:batch.recordsSha256,rowCount:batch.count,insertedCount:inserted,actorId:actor.userId}});
      await tx.historyRecordImportLink.createMany({data:batch.records.map((r,i) => ({jobId:plan.jobId,batchIndex,rowOrdinal:batch.startOrdinal+i,recordId:r.recordId,snapshotSha256:r.snapshotSha256}))});
      const advanced = await tx.historyImportJob.updateMany({where:{jobId:plan.jobId,completedBatches:completed},data:{completedBatches:completed+1}});
      assertHistory(advanced.count === 1,'CHECKPOINT_CAS_FAILED');
      return { jobId:plan.jobId,batchIndex,rowCount:batch.count,insertedCount:inserted,completedBatches:completed+1,
        complete:completed+1 === plan.batches.length,persisted:true,deduplicated:false,...policy };
    },true);
  }
  async list(queryInput: unknown, actorInput: unknown) {
    const actor = historyActor(actorInput,'history.view'), query = historyListQuery(queryInput);
    return this.transaction(async tx => {
      const rows = await tx.historyRecord.findMany({where:{...historyScopeWhere(actor),
        ...(query.issuerRuc ? {issuerRuc:query.issuerRuc}:{}), ...(query.branchId?{branchId:query.branchId}:{}),
        ...(query.documentTypeCode?{documentTypeCode:query.documentTypeCode}:{}), ...(query.series?{series:query.series}:{}),
        ...(query.afterRecordId?{recordId:{gt:query.afterRecordId}}:{})},orderBy:{recordId:'asc'},take:query.take});
      return rows.map(row => { const snapshot = this.verifyRecord(row); return {recordId:row.recordId,snapshotSha256:row.snapshotSha256,
        issuerRuc:snapshot.ownership.issuerRuc,companyId:snapshot.ownership.companyId,branchId:snapshot.ownership.branchId,
        fullNumber:`${snapshot.ownership.series}-${snapshot.number}`,customer:snapshot.customer.legalName,issueDate:snapshot.issueDate,
        currencyCode:snapshot.currencyCode,payableAmount:snapshot.amounts.payableAmount,...policy}; });
    });
  }
  async detail(recordIdInput: unknown, actorInput: unknown) {
    const actor = historyActor(actorInput,'history.view'), recordId = historySha(recordIdInput);
    return this.transaction(async tx => {
      const row = await tx.historyRecord.findFirst({where:{recordId,...historyScopeWhere(actor)}});
      assertHistory(row,'HISTORY_NOT_FOUND'); const snapshot = this.verifyRecord(row);
      return {recordId,snapshotSha256:row.snapshotSha256,snapshot,artifactKeys:historyJson(row.artifactKeys),...policy};
    });
  }
  async reconciliation(queryInput:unknown,actorInput:unknown) {
    const actor=historyActor(actorInput,'history.view'),query=historyListQuery(queryInput);
    assertHistory(query.afterRecordId===null,'RECONCILIATION_CURSOR_NOT_ALLOWED');
    return this.transaction(async tx=>{
      const rows=await tx.historyRecord.findMany({where:{...historyScopeWhere(actor),
        ...(query.issuerRuc?{issuerRuc:query.issuerRuc}:{}),...(query.branchId?{branchId:query.branchId}:{}),
        ...(query.documentTypeCode?{documentTypeCode:query.documentTypeCode}:{}),...(query.series?{series:query.series}:{})},
        orderBy:{recordId:'asc'},take:HISTORY_FULL_LIMITS.rows+1});
      assertHistory(rows.length<=HISTORY_FULL_LIMITS.rows,'RECONCILIATION_LIMIT');
      return summarizeHistoricalSelection(rows.map(row=>this.verifyRecord(row)));
    });
  }
}
