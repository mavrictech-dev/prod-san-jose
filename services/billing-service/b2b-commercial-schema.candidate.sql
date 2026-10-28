-- Candidate ONLY. NEW synthetic Billing DB after drafts/issuance candidate DDL.
-- No live installation, financial effects, fiscal counter changes or transmission.
CREATE TABLE "B2bSalesNoteCounter" (
  "issuerId" integer NOT NULL REFERENCES "CompanySettings"("id"),
  "pointId" uuid NOT NULL,
  "nextNumber" bigint NOT NULL CHECK ("nextNumber" BETWEEN 1 AND 100000000),
  PRIMARY KEY ("issuerId","pointId"),
  FOREIGN KEY ("pointId","issuerId") REFERENCES "EmissionPoint"("id","companyId")
);
CREATE TABLE "B2bCommercialResource" (
  "id" uuid PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('SALES_NOTE','CORRECTION_REQUEST')),
  "clientId" uuid NOT NULL,"actorKey" text NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "issuerId" integer NOT NULL REFERENCES "CompanySettings"("id"),"pointId" uuid NOT NULL,
  "binding" jsonb NOT NULL CHECK ("binding"->>'environment'='BETA'),
  "body" jsonb NOT NULL,"revision" integer NOT NULL CHECK ("revision">0),
  "state" text NOT NULL CHECK ("state" IN ('DRAFT','COMPLETED','CONVERTED','CANCELLED','BLOCKED_FISCAL_EXECUTION')),
  "commercialNumber" varchar(11),"completedSha256" char(64),"original" jsonb,
  "convertedDocumentId" uuid UNIQUE REFERENCES "Document"("id"),
  "convertedDraftId" uuid UNIQUE REFERENCES "B2bDocumentDraft"("id"),
  "referenceNamespace" varchar(40) NOT NULL,"referenceValue" varchar(120) NOT NULL,
  "createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL,
  UNIQUE ("clientId","issuerId","kind","referenceNamespace","referenceValue"),
  UNIQUE ("issuerId","pointId","commercialNumber"),
  FOREIGN KEY ("pointId","issuerId") REFERENCES "EmissionPoint"("id","companyId"),
  CHECK (("kind"='SALES_NOTE' AND "commercialNumber" IS NOT NULL AND "original" IS NULL AND "state"<>'BLOCKED_FISCAL_EXECUTION') OR
         ("kind"='CORRECTION_REQUEST' AND "commercialNumber" IS NULL AND "original" IS NOT NULL AND "state" IN ('BLOCKED_FISCAL_EXECUTION','CANCELLED'))),
  CHECK (("state"='CONVERTED')=("convertedDocumentId" IS NOT NULL AND "convertedDraftId" IS NOT NULL)),
  CHECK (("state" NOT IN ('COMPLETED','CONVERTED')) OR "completedSha256" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "B2bCommercialList" ON "B2bCommercialResource" ("clientId","actorKey","kind","id");
CREATE TABLE "B2bCommercialOperation" (
  "id" uuid PRIMARY KEY,"clientId" uuid NOT NULL,"actorKey" text NOT NULL,
  "keyHash" char(64) NOT NULL CHECK ("keyHash" ~ '^[a-f0-9]{64}$'),
  "resourceId" uuid NOT NULL REFERENCES "B2bCommercialResource"("id"),"payload" jsonb NOT NULL,
  UNIQUE ("clientId","actorKey","keyHash")
);
-- Immutable command history: no purge, hard deletion or reuse of commercial numbers.
-- Candidate read indexes only; applied in the NEW synthetic rehearsal DB, never QA.
CREATE INDEX "B2bCorrectionCreditReference" ON "Document" ("companyId", ("immutableSnapshot"->'reference'->>'documentId'), "id") WHERE "type"='CREDIT_NOTE';
CREATE INDEX "B2bCorrectionReferenceTarget" ON "DocumentReference" ("targetDocumentId","sourceDocumentId");
CREATE INDEX "B2bCorrectionReferenceExternal" ON "DocumentReference" ("targetSeries","targetNumber","targetTypeCode","sourceDocumentId") WHERE "targetDocumentId" IS NULL;
