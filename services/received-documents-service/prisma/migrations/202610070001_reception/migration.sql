CREATE TABLE "ReceivedDocument" (
 "id" UUID NOT NULL PRIMARY KEY, "companyId" INTEGER NOT NULL,
 "recipientRuc" VARCHAR(11) NOT NULL, "branchId" UUID, "supplierRuc" VARCHAR(11) NOT NULL,
 "supplierName" TEXT, "documentType" VARCHAR(2) NOT NULL, "fullNumber" VARCHAR(32) NOT NULL,
 "series" VARCHAR(4) NOT NULL, "number" VARCHAR(8) NOT NULL, "issueDate" DATE NOT NULL,
 "currencyCode" VARCHAR(3), "payableAmount" TEXT, "projection" JSONB NOT NULL,
 "xmlSha256" VARCHAR(64) NOT NULL, "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "registeredAt" TIMESTAMP(3), "erpReference" TEXT
);
CREATE TABLE "ReceivedItemRecord" (
 "id" UUID NOT NULL PRIMARY KEY, "documentId" UUID NOT NULL, "ordinal" INTEGER NOT NULL,
 "supplierCode" TEXT, "sunatCode" TEXT, "description" TEXT NOT NULL, "quantity" TEXT,
 "unitCode" TEXT, "unitValue" TEXT, "unitPrice" TEXT, "amount" TEXT, "detail" JSONB NOT NULL
);
CREATE TABLE "ReceivedArtifact" (
 "id" UUID NOT NULL PRIMARY KEY, "documentId" UUID NOT NULL, "kind" VARCHAR(20) NOT NULL,
 "fileName" VARCHAR(150) NOT NULL, "sha256" VARCHAR(64) NOT NULL, "byteLength" INTEGER NOT NULL,
 "bytes" BYTEA NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ReceivedAudit" (
 "id" UUID NOT NULL PRIMARY KEY, "documentId" UUID NOT NULL, "actorId" UUID NOT NULL,
 "action" VARCHAR(40) NOT NULL, "detail" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReceivedDocument_companyId_branchId_issueDate_idx" ON "ReceivedDocument"("companyId", "branchId", "issueDate");
CREATE UNIQUE INDEX "ReceivedDocument_recipientRuc_supplierRuc_documentType_seri_key" ON "ReceivedDocument"("recipientRuc", "supplierRuc", "documentType", "series", "number");
CREATE UNIQUE INDEX "ReceivedItemRecord_documentId_ordinal_key" ON "ReceivedItemRecord"("documentId", "ordinal");
CREATE UNIQUE INDEX "ReceivedArtifact_documentId_kind_sha256_key" ON "ReceivedArtifact"("documentId", "kind", "sha256");
CREATE INDEX "ReceivedAudit_documentId_createdAt_idx" ON "ReceivedAudit"("documentId", "createdAt");
ALTER TABLE "ReceivedItemRecord" ADD CONSTRAINT "ReceivedItemRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceivedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivedArtifact" ADD CONSTRAINT "ReceivedArtifact_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceivedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivedAudit" ADD CONSTRAINT "ReceivedAudit_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ReceivedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
