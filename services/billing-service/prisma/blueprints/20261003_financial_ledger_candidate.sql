-- REVIEW-ONLY PostgreSQL blueprint: NOT an applied migration or startup script.
-- Do not execute this file during Etapa2. No DB/CLI migrate is required to review it.
-- Prerequisites: existing CompanySettings, Branch, Document, SunatEnvironment,
-- and Branch_id_companyId_key with exactly the shape in schema.prisma.
-- Plain CREATE deliberately fails on existing names: never conceal a different
-- shape with IF NOT EXISTS. A future rollout must separately review the catalog,
-- including an already-present Document_id_companyId_key, before choosing DDL.
-- The sole existing-table change proposed here is Document's scoped unique index.
-- No grants, extensions, seed/backfill, real-table triggers or fiscal activation.
-- UUIDs and updatedAt have no SQL defaults: Prisma/application supplies them.
-- Candidate hashes bind content; they do not authenticate official evidence.

CREATE UNIQUE INDEX "Document_id_companyId_key" ON "Document"("id", "companyId");

CREATE TABLE "FinancialLedgerCommit" (
    "planId" UUID NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "issuerRuc" CHAR(11) NOT NULL,
    "environment" "SunatEnvironment" NOT NULL DEFAULT 'BETA',
    "candidateOnly" BOOLEAN NOT NULL DEFAULT true,
    "profile" VARCHAR(80) NOT NULL,
    "planSha256" CHAR(64) NOT NULL,
    "inputSha256" CHAR(64) NOT NULL,
    "resultSha256" CHAR(64) NOT NULL,
    "planPayload" JSONB NOT NULL,
    "resultPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialLedgerCommit_pkey" PRIMARY KEY ("planId"),
    CONSTRAINT "FinancialLedgerCommit_companyId_fkey" FOREIGN KEY ("companyId")
        REFERENCES "CompanySettings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialLedgerCommit_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId")
        REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerCommit_beta_check" CHECK ("environment" = 'BETA'),
    CONSTRAINT "FinancialLedgerCommit_candidate_check" CHECK ("candidateOnly" = true),
    CONSTRAINT "FinancialLedgerCommit_profile_check" CHECK ("profile" = 'FACTUEZ-BETA-FINANCIAL-LEDGER-v1'),
    CONSTRAINT "FinancialLedgerCommit_hashes_check" CHECK (
        "planSha256" ~ '^[0-9a-f]{64}$' AND "inputSha256" ~ '^[0-9a-f]{64}$'
        AND "resultSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "FinancialLedgerCommit_planId_companyId_branchId_key"
    ON "FinancialLedgerCommit"("planId", "companyId", "branchId");
CREATE INDEX "FinancialLedgerCommit_companyId_branchId_createdAt_idx"
    ON "FinancialLedgerCommit"("companyId", "branchId", "createdAt");

CREATE TABLE "FinancialLedgerStream" (
    "documentId" UUID NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "issuerRuc" CHAR(11) NOT NULL,
    "environment" "SunatEnvironment" NOT NULL DEFAULT 'BETA',
    "candidateOnly" BOOLEAN NOT NULL DEFAULT true,
    "profile" VARCHAR(80) NOT NULL,
    "revision" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "versionSha256" CHAR(64) NOT NULL,
    "originalSha256" CHAR(64) NOT NULL,
    "historySha256" CHAR(64) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "originalSnapshot" JSONB NOT NULL,
    "financialSnapshot" JSONB NOT NULL,
    "historyPayload" JSONB NOT NULL,
    "currentVersion" JSONB NOT NULL,
    "lastCommitId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancialLedgerStream_pkey" PRIMARY KEY ("documentId"),
    CONSTRAINT "FinancialLedgerStream_documentId_companyId_fkey" FOREIGN KEY ("documentId", "companyId")
        REFERENCES "Document"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerStream_companyId_fkey" FOREIGN KEY ("companyId")
        REFERENCES "CompanySettings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FinancialLedgerStream_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId")
        REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerStream_lastCommitId_companyId_branchId_fkey"
        FOREIGN KEY ("lastCommitId", "companyId", "branchId")
        REFERENCES "FinancialLedgerCommit"("planId", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerStream_beta_check" CHECK ("environment" = 'BETA'),
    CONSTRAINT "FinancialLedgerStream_candidate_check" CHECK ("candidateOnly" = true),
    CONSTRAINT "FinancialLedgerStream_profile_check" CHECK ("profile" = 'FACTUEZ-BETA-FINANCIAL-LEDGER-v1'),
    CONSTRAINT "FinancialLedgerStream_counters_check" CHECK ("revision" >= 0 AND "sequence" >= 0),
    CONSTRAINT "FinancialLedgerStream_state_check" CHECK ("state" IN ('ACTIVE', 'VOIDED')),
    CONSTRAINT "FinancialLedgerStream_hashes_check" CHECK (
        "versionSha256" ~ '^[0-9a-f]{64}$' AND "originalSha256" ~ '^[0-9a-f]{64}$'
        AND "historySha256" ~ '^[0-9a-f]{64}$'),
    -- CHECK must fail on missing/null JSON keys as well as on wrong values.
    CONSTRAINT "FinancialLedgerStream_currentVersion_check" CHECK (COALESCE(
        jsonb_typeof("currentVersion") = 'object'
        AND "currentVersion"->'revision' = to_jsonb("revision")
        AND "currentVersion"->>'sha256' = "versionSha256"::text
        AND "currentVersion"->>'state' = "state"
        AND (("revision" = 0 AND "currentVersion"->>'kind' = 'BASE' AND "state" = 'ACTIVE'
              AND "currentVersion"->'previousSha256' = 'null'::jsonb)
          OR ("revision" > 0 AND "currentVersion"->>'kind' IN ('NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID')
              AND "currentVersion"->>'previousSha256' ~ '^[0-9a-f]{64}$'
              AND (("currentVersion"->>'kind' = 'VOID' AND "state" = 'VOIDED')
                OR ("currentVersion"->>'kind' <> 'VOID' AND "state" = 'ACTIVE')))), false))
);

-- Both uniques are intentional: the pair is Prisma's 1:1 Document relation;
-- the triple is the tenant/branch target for Version and Entry relations.
CREATE UNIQUE INDEX "FinancialLedgerStream_documentId_companyId_key"
    ON "FinancialLedgerStream"("documentId", "companyId");
CREATE UNIQUE INDEX "FinancialLedgerStream_documentId_companyId_branchId_key"
    ON "FinancialLedgerStream"("documentId", "companyId", "branchId");
CREATE INDEX "FinancialLedgerStream_companyId_branchId_state_idx"
    ON "FinancialLedgerStream"("companyId", "branchId", "state");

CREATE TABLE "FinancialLedgerVersion" (
    "documentId" UUID NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "versionSha256" CHAR(64) NOT NULL,
    "previousSha256" CHAR(64),
    "versionPayload" JSONB NOT NULL,
    "candidateOnly" BOOLEAN NOT NULL DEFAULT true,
    "commitId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialLedgerVersion_pkey" PRIMARY KEY ("documentId", "revision"),
    CONSTRAINT "FinancialLedgerVersion_documentId_companyId_branchId_fkey"
        FOREIGN KEY ("documentId", "companyId", "branchId")
        REFERENCES "FinancialLedgerStream"("documentId", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerVersion_commitId_companyId_branchId_fkey"
        FOREIGN KEY ("commitId", "companyId", "branchId")
        REFERENCES "FinancialLedgerCommit"("planId", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerVersion_candidate_check" CHECK ("candidateOnly" = true),
    CONSTRAINT "FinancialLedgerVersion_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "FinancialLedgerVersion_hashes_check" CHECK (
        "versionSha256" ~ '^[0-9a-f]{64}$'
        AND ("previousSha256" IS NULL OR "previousSha256" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "FinancialLedgerVersion_payload_check" CHECK (COALESCE(
        jsonb_typeof("versionPayload") = 'object'
        AND "versionPayload"->'revision' = to_jsonb("revision")
        AND "versionPayload"->>'sha256' = "versionSha256"::text
        AND (("revision" = 0 AND "previousSha256" IS NULL
              AND "versionPayload"->'previousSha256' = 'null'::jsonb
              AND "versionPayload"->>'kind' = 'BASE' AND "versionPayload"->>'state' = 'ACTIVE')
          OR ("revision" > 0 AND "previousSha256" IS NOT NULL
              AND "versionPayload"->>'previousSha256' = "previousSha256"::text
              AND "versionPayload"->>'kind' IN ('NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID')
              AND (("versionPayload"->>'kind' = 'VOID' AND "versionPayload"->>'state' = 'VOIDED')
                OR ("versionPayload"->>'kind' <> 'VOID' AND "versionPayload"->>'state' = 'ACTIVE')))), false))
);

CREATE UNIQUE INDEX "FinancialLedgerVersion_documentId_versionSha256_key"
    ON "FinancialLedgerVersion"("documentId", "versionSha256");

CREATE TABLE "FinancialLedgerEntry" (
    "documentId" UUID NOT NULL,
    "companyId" INTEGER NOT NULL,
    "branchId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "outcome" VARCHAR(24) NOT NULL,
    "entrySha256" CHAR(64) NOT NULL,
    "entryPayload" JSONB NOT NULL,
    "versionSha256" CHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL,
    "candidateOnly" BOOLEAN NOT NULL DEFAULT true,
    "commitId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("documentId", "eventId"),
    CONSTRAINT "FinancialLedgerEntry_documentId_companyId_branchId_fkey"
        FOREIGN KEY ("documentId", "companyId", "branchId")
        REFERENCES "FinancialLedgerStream"("documentId", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerEntry_commitId_companyId_branchId_fkey"
        FOREIGN KEY ("commitId", "companyId", "branchId")
        REFERENCES "FinancialLedgerCommit"("planId", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "FinancialLedgerEntry_candidate_check" CHECK ("candidateOnly" = true),
    CONSTRAINT "FinancialLedgerEntry_counters_check" CHECK ("sequence" > 0 AND "revision" >= 0),
    CONSTRAINT "FinancialLedgerEntry_kind_check" CHECK ("kind" IN ('NOTE_CREDIT', 'NOTE_DEBIT', 'RC_REPLACE', 'VOID')),
    -- Replay DUPLICATE is a response, never an additional stored entry.
    CONSTRAINT "FinancialLedgerEntry_outcome_check" CHECK ("outcome" IN ('APPLIED', 'REJECTED', 'EVIDENCE_UNVERIFIED')),
    CONSTRAINT "FinancialLedgerEntry_hashes_check" CHECK (
        "entrySha256" ~ '^[0-9a-f]{64}$' AND "versionSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "FinancialLedgerEntry_documentId_sequence_key"
    ON "FinancialLedgerEntry"("documentId", "sequence");
CREATE UNIQUE INDEX "FinancialLedgerEntry_documentId_operationId_key"
    ON "FinancialLedgerEntry"("documentId", "operationId");

-- Single-column CompanySettings relations above use Prisma's implicit
-- onUpdate: Cascade; every composite scope relation explicitly uses Restrict.
-- Version/Entry inherit BETA/profile through immutable scoped Stream/Commit FKs.

CREATE FUNCTION "FinancialLedgerCandidate_append_only_guard"()
RETURNS trigger LANGUAGE plpgsql AS $financial_ledger_append_only$
BEGIN
    RAISE EXCEPTION 'Candidate financial ledger % is append-only', TG_TABLE_NAME
        USING ERRCODE = '55000';
END;
$financial_ledger_append_only$;

CREATE TRIGGER "FinancialLedgerCommit_append_only"
    BEFORE UPDATE OR DELETE ON "FinancialLedgerCommit"
    FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerCandidate_append_only_guard"();
CREATE TRIGGER "FinancialLedgerVersion_append_only"
    BEFORE UPDATE OR DELETE ON "FinancialLedgerVersion"
    FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerCandidate_append_only_guard"();
CREATE TRIGGER "FinancialLedgerEntry_append_only"
    BEFORE UPDATE OR DELETE ON "FinancialLedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerCandidate_append_only_guard"();

CREATE FUNCTION "FinancialLedgerCandidate_stream_guard"()
RETURNS trigger LANGUAGE plpgsql AS $financial_ledger_stream$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Candidate financial ledger stream cannot be deleted'
            USING ERRCODE = '55000';
    END IF;
    IF ROW(NEW."documentId", NEW."companyId", NEW."branchId", NEW."issuerRuc",
           NEW."environment", NEW."candidateOnly", NEW."profile",
           NEW."originalSnapshot", NEW."originalSha256", NEW."createdAt")
       IS DISTINCT FROM
       ROW(OLD."documentId", OLD."companyId", OLD."branchId", OLD."issuerRuc",
           OLD."environment", OLD."candidateOnly", OLD."profile",
           OLD."originalSnapshot", OLD."originalSha256", OLD."createdAt") THEN
        RAISE EXCEPTION 'Candidate financial ledger stream immutable fields changed'
            USING ERRCODE = '55000';
    END IF;
    IF NEW."revision" < OLD."revision" OR NEW."sequence" < OLD."sequence" THEN
        RAISE EXCEPTION 'Candidate financial ledger stream counters cannot decrease'
            USING ERRCODE = '55000';
    END IF;
    -- CAS belongs to the repository's atomic UPDATE WHERE expected revision,
    -- sequence and versionSha256, checking affected rows inside its transaction.
    -- One commit may append several entries/versions; increments need not be 1.
    RETURN NEW;
END;
$financial_ledger_stream$;

CREATE TRIGGER "FinancialLedgerStream_immutable_scope"
    BEFORE UPDATE OR DELETE ON "FinancialLedgerStream"
    FOR EACH ROW EXECUTE FUNCTION "FinancialLedgerCandidate_stream_guard"();
