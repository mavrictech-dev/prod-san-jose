-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "HistorySandbox" (
    "id" INTEGER NOT NULL,
    "markerId" UUID NOT NULL,
    "schemaVersion" VARCHAR(40) NOT NULL,
    "environment" VARCHAR(4) NOT NULL,
    "datasetClass" VARCHAR(12) NOT NULL,

    CONSTRAINT "HistorySandbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoryIssuer" (
    "companyId" INTEGER NOT NULL,
    "issuerRuc" CHAR(11) NOT NULL,

    CONSTRAINT "HistoryIssuer_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "HistoryOwnerMapping" (
    "mappingId" UUID NOT NULL,
    "issuerRuc" CHAR(11) NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "emissionPointId" UUID NOT NULL,
    "seriesCounterId" UUID NOT NULL,
    "documentTypeCode" CHAR(2) NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "mappingSha256" CHAR(64) NOT NULL,

    CONSTRAINT "HistoryOwnerMapping_pkey" PRIMARY KEY ("mappingId")
);

-- CreateTable
CREATE TABLE "HistoryImportJob" (
    "jobId" UUID NOT NULL,
    "inputSha256" CHAR(64) NOT NULL,
    "planSha256" CHAR(64) NOT NULL,
    "mappingSha256" CHAR(64) NOT NULL,
    "expectedRows" INTEGER NOT NULL,
    "batchSize" INTEGER NOT NULL,
    "completedBatches" INTEGER NOT NULL DEFAULT 0,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoryImportJob_pkey" PRIMARY KEY ("jobId")
);

-- CreateTable
CREATE TABLE "HistoryBatchReceipt" (
    "jobId" UUID NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "recordsSha256" CHAR(64) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "insertedCount" INTEGER NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoryBatchReceipt_pkey" PRIMARY KEY ("jobId","batchIndex")
);

-- CreateTable
CREATE TABLE "HistoryRecord" (
    "recordId" CHAR(64) NOT NULL,
    "mappingId" UUID NOT NULL,
    "issuerRuc" CHAR(11) NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "emissionPointId" UUID NOT NULL,
    "seriesCounterId" UUID NOT NULL,
    "documentTypeCode" CHAR(2) NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "number" BIGINT NOT NULL,
    "originSystem" VARCHAR(20) NOT NULL,
    "originId" VARCHAR(120) NOT NULL,
    "issueDate" TIMESTAMPTZ(3) NOT NULL,
    "currencyCode" CHAR(3) NOT NULL,
    "taxableAmount" DECIMAL(18,2) NOT NULL,
    "igvAmount" DECIMAL(18,2) NOT NULL,
    "payableAmount" DECIMAL(18,2) NOT NULL,
    "snapshotSha256" CHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "artifactKeys" JSONB NOT NULL,
    "candidateOnly" BOOLEAN NOT NULL DEFAULT true,
    "disposition" VARCHAR(16) NOT NULL DEFAULT 'QUARANTINED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoryRecord_pkey" PRIMARY KEY ("recordId")
);

-- CreateTable
CREATE TABLE "HistoryRecordImportLink" (
    "jobId" UUID NOT NULL,
    "batchIndex" INTEGER NOT NULL,
    "rowOrdinal" INTEGER NOT NULL,
    "recordId" CHAR(64) NOT NULL,
    "snapshotSha256" CHAR(64) NOT NULL,

    CONSTRAINT "HistoryRecordImportLink_pkey" PRIMARY KEY ("jobId","rowOrdinal")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoryIssuer_issuerRuc_key" ON "HistoryIssuer"("issuerRuc");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryIssuer_companyId_issuerRuc_key" ON "HistoryIssuer"("companyId", "issuerRuc");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryOwnerMapping_companyId_documentTypeCode_series_key" ON "HistoryOwnerMapping"("companyId", "documentTypeCode", "series");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryOwnerMapping_mappingId_issuerRuc_companyId_branchId__key" ON "HistoryOwnerMapping"("mappingId", "issuerRuc", "companyId", "branchId", "emissionPointId", "seriesCounterId", "documentTypeCode", "series");

-- CreateIndex
CREATE INDEX "HistoryRecord_companyId_branchId_issueDate_idx" ON "HistoryRecord"("companyId", "branchId", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryRecord_issuerRuc_documentTypeCode_series_number_key" ON "HistoryRecord"("issuerRuc", "documentTypeCode", "series", "number");

-- CreateIndex
CREATE UNIQUE INDEX "HistoryRecord_companyId_originSystem_originId_key" ON "HistoryRecord"("companyId", "originSystem", "originId");

-- CreateIndex
CREATE INDEX "HistoryRecordImportLink_jobId_batchIndex_idx" ON "HistoryRecordImportLink"("jobId", "batchIndex");

-- AddForeignKey
ALTER TABLE "HistoryOwnerMapping" ADD CONSTRAINT "HistoryOwnerMapping_companyId_issuerRuc_fkey" FOREIGN KEY ("companyId", "issuerRuc") REFERENCES "HistoryIssuer"("companyId", "issuerRuc") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HistoryBatchReceipt" ADD CONSTRAINT "HistoryBatchReceipt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "HistoryImportJob"("jobId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HistoryRecord" ADD CONSTRAINT "HistoryRecord_mappingId_issuerRuc_companyId_branchId_emiss_fkey" FOREIGN KEY ("mappingId", "issuerRuc", "companyId", "branchId", "emissionPointId", "seriesCounterId", "documentTypeCode", "series") REFERENCES "HistoryOwnerMapping"("mappingId", "issuerRuc", "companyId", "branchId", "emissionPointId", "seriesCounterId", "documentTypeCode", "series") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HistoryRecordImportLink" ADD CONSTRAINT "HistoryRecordImportLink_jobId_batchIndex_fkey" FOREIGN KEY ("jobId", "batchIndex") REFERENCES "HistoryBatchReceipt"("jobId", "batchIndex") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HistoryRecordImportLink" ADD CONSTRAINT "HistoryRecordImportLink_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "HistoryRecord"("recordId") ON DELETE RESTRICT ON UPDATE RESTRICT;

