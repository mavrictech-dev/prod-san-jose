-- Sólo expansión QA; no borra ni altera comprobantes, credenciales o estados fiscales.
BEGIN;
DO $$ BEGIN IF current_database() <> 'factuez_sunat' THEN RAISE EXCEPTION 'BD inesperada'; END IF; END $$;
CREATE TABLE IF NOT EXISTS "FiscalBatchQa" (
  "id" UUID PRIMARY KEY, "issuerRuc" CHAR(11) NOT NULL CHECK ("issuerRuc" ~ '^00[0-9]{9}$'),
  "idempotencyKey" UUID NOT NULL, "inputSha256" CHAR(64) NOT NULL,
  "kind" VARCHAR(12) NOT NULL CHECK ("kind" IN ('RC_ALTA','RC_BAJA','RA')), "identifier" VARCHAR(32) NOT NULL,
  "actorId" UUID NOT NULL, "credentialRevision" INTEGER NOT NULL, "scenario" VARCHAR(30) NOT NULL,
  "state" VARCHAR(40) NOT NULL DEFAULT 'BUILDING' CHECK ("state" IN ('BUILDING','QUEUED','SENDING','WAITING_TICKET','POLLING','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','UNKNOWN','POLL_LIMIT','BLOCKED')),
  "immutablePayload" JSONB NOT NULL, "requestFileName" VARCHAR(120) NOT NULL UNIQUE,
  "digestValue" VARCHAR(128), "requestArtifact" JSONB, "signedXmlArtifact" JSONB, "xsdEvidence" JSONB,
  "cdrZipArtifact" JSONB, "cdrXmlArtifact" JSONB, "responseCode" VARCHAR(40), "description" VARCHAR(2048), "notes" TEXT[] NOT NULL,
  "ticket" VARCHAR(120), "pollAttempts" INTEGER NOT NULL DEFAULT 0, "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalBatchQa_issuerRuc_idempotencyKey_key" UNIQUE("issuerRuc","idempotencyKey"),
  CONSTRAINT "FiscalBatchQa_issuerRuc_identifier_key" UNIQUE("issuerRuc","identifier")
);
CREATE INDEX IF NOT EXISTS "FiscalBatchQa_state_nextPollAt_idx" ON "FiscalBatchQa"("state","nextPollAt");
CREATE TABLE IF NOT EXISTS "FiscalBatchQaMember" (
  "id" UUID PRIMARY KEY, "batchId" UUID NOT NULL REFERENCES "FiscalBatchQa"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "documentId" UUID NOT NULL REFERENCES "FiscalDocument"("documentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "action" VARCHAR(8) NOT NULL CHECK ("action" IN ('ALTA','BAJA')),
  CONSTRAINT "FiscalBatchQaMember_documentId_action_key" UNIQUE("documentId","action")
);
CREATE INDEX IF NOT EXISTS "FiscalBatchQaMember_batchId_idx" ON "FiscalBatchQaMember"("batchId");
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname=current_database();
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON "FiscalBatchQa", "FiscalBatchQaMember" TO %I',service_owner);
END $$;
COMMIT;
