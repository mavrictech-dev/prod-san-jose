-- Aditiva. Antes de aplicar: respaldo verificado. No habilita transmisión fiscal.
CREATE TABLE IF NOT EXISTS "FiscalCircuitQa" (
  "id" UUID PRIMARY KEY, "documentId" UUID NOT NULL UNIQUE REFERENCES "FiscalDocument"("documentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" UUID NOT NULL, "credentialRevision" INTEGER NOT NULL, "scenario" VARCHAR(30) NOT NULL,
  "state" VARCHAR(40) NOT NULL DEFAULT 'QUEUED' CHECK ("state" IN ('QUEUED','SENDING','WAITING_TICKET','POLLING','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','UNKNOWN','POLL_LIMIT','BLOCKED')),
  "requestFileName" VARCHAR(120) NOT NULL, "reference" VARCHAR(40) NOT NULL, "digestValue" VARCHAR(128) NOT NULL,
  "requestArtifact" JSONB NOT NULL, "signedXmlArtifact" JSONB NOT NULL, "documentXmlArtifact" JSONB NOT NULL, "documentDigestValue" VARCHAR(128) NOT NULL,
  "cdrZipArtifact" JSONB, "cdrXmlArtifact" JSONB, "responseCode" VARCHAR(40), "description" VARCHAR(2048), "notes" TEXT[] NOT NULL,
  "ticket" VARCHAR(120), "pollAttempts" INTEGER NOT NULL DEFAULT 0, "nextPollAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "FiscalCircuitQa_state_nextPollAt_idx" ON "FiscalCircuitQa"("state", "nextPollAt");
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalCircuitQa_requestFileName_key" ON "FiscalCircuitQa"("requestFileName");
CREATE TABLE IF NOT EXISTS "FiscalQaCounter" ("id" VARCHAR(30) PRIMARY KEY, "lastNumber" INTEGER NOT NULL DEFAULT 0);
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname = current_database();
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON "FiscalCircuitQa" TO %I', service_owner);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON "FiscalQaCounter" TO %I', service_owner);
END $$;
