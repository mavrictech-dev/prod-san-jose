CREATE TABLE "ReceptionConnection" (
 "companyId" INTEGER PRIMARY KEY, "recipientRuc" VARCHAR(11) NOT NULL UNIQUE,
 "revision" INTEGER NOT NULL DEFAULT 1, "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
 "mode" VARCHAR(20) NOT NULL, "settings" JSONB NOT NULL, "encryptedCredentials" TEXT,
 "configuredBy" UUID NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ReceptionConnectionAudit" (
 "id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL, "actorId" UUID NOT NULL,
 "action" VARCHAR(40) NOT NULL, "revision" INTEGER NOT NULL, "detail" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReceptionConnectionAudit_companyId_createdAt_idx" ON "ReceptionConnectionAudit"("companyId", "createdAt");
CREATE TABLE "ReceptionSyncRun" (
 "id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL, "recipientRuc" VARCHAR(11) NOT NULL,
 "revision" INTEGER NOT NULL, "source" VARCHAR(10) NOT NULL, "status" VARCHAR(20) NOT NULL,
 "activeKey" TEXT UNIQUE, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
 "counters" JSONB NOT NULL, "errorCode" VARCHAR(50), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReceptionSyncRun_companyId_createdAt_idx" ON "ReceptionSyncRun"("companyId", "createdAt");
CREATE TABLE "ReceptionMailboxCheckpoint" (
 "companyId" INTEGER PRIMARY KEY, "fingerprint" VARCHAR(64) NOT NULL, "uidValidity" VARCHAR(20) NOT NULL,
 "lastUid" BIGINT NOT NULL DEFAULT 0, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ReceptionMessageReceipt" (
 "id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL, "fingerprint" VARCHAR(64) NOT NULL,
 "uidValidity" VARCHAR(20) NOT NULL, "uid" BIGINT NOT NULL, "status" VARCHAR(20) NOT NULL,
 "counts" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("companyId", "fingerprint", "uidValidity", "uid")
);
CREATE TABLE "ReceptionSirePurchase" (
 "id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL, "recipientRuc" VARCHAR(11) NOT NULL,
 "period" VARCHAR(6) NOT NULL, "supplierRuc" VARCHAR(11) NOT NULL, "supplierName" TEXT,
 "documentType" VARCHAR(2) NOT NULL, "series" VARCHAR(20) NOT NULL, "number" VARCHAR(20) NOT NULL,
 "fullNumber" VARCHAR(41) NOT NULL, "issueDate" DATE NOT NULL, "currencyCode" VARCHAR(3),
 "amount" TEXT, "rawRecord" JSONB NOT NULL, "xmlStatus" VARCHAR(20) NOT NULL, "documentId" UUID,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "observedRunId" UUID NOT NULL,
 UNIQUE("recipientRuc", "supplierRuc", "documentType", "series", "number", "period")
);
CREATE INDEX "ReceptionSirePurchase_companyId_xmlStatus_period_idx" ON "ReceptionSirePurchase"("companyId", "xmlStatus", "period");
CREATE TABLE "ReceptionSireIncident" (
 "id" UUID PRIMARY KEY, "companyId" INTEGER NOT NULL, "recipientRuc" VARCHAR(11) NOT NULL,
 "period" VARCHAR(6) NOT NULL, "ordinal" INTEGER NOT NULL, "code" VARCHAR(50) NOT NULL,
 "recordHash" VARCHAR(64) NOT NULL, "rawRecord" JSONB NOT NULL, "active" BOOLEAN NOT NULL DEFAULT TRUE,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "observedRunId" UUID NOT NULL,
 UNIQUE("companyId", "period", "recordHash")
);
CREATE INDEX "ReceptionSireIncident_companyId_active_observedAt_idx" ON "ReceptionSireIncident"("companyId", "active", "observedAt");
