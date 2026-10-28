-- Ejecutar sólo después del backup SUNAT. Aditiva e idempotente, sin cambio de estados.
CREATE TABLE IF NOT EXISTS "LocalXmlValidation" (
  "id" UUID PRIMARY KEY, "documentId" UUID NOT NULL REFERENCES "FiscalDocument"("documentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "profile" VARCHAR(80) NOT NULL, "credentialRevision" INTEGER NOT NULL,
  "certificateFingerprint" CHAR(64) NOT NULL, "snapshotSha256" CHAR(64) NOT NULL, "digestValue" VARCHAR(128) NOT NULL,
  "xmlStorageKey" VARCHAR(500) NOT NULL, "xmlSha256" CHAR(64) NOT NULL, "xmlSizeBytes" BIGINT NOT NULL,
  "zipStorageKey" VARCHAR(500) NOT NULL, "zipSha256" CHAR(64) NOT NULL, "zipSizeBytes" BIGINT NOT NULL,
  "actorId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "LocalXmlValidation_documentId_profile_credentialRevision_key" ON "LocalXmlValidation"("documentId", "profile", "credentialRevision");
CREATE INDEX IF NOT EXISTS "LocalXmlValidation_documentId_createdAt_idx" ON "LocalXmlValidation"("documentId", "createdAt");
DO $$ DECLARE service_owner NAME;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname = current_database();
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON "LocalXmlValidation" TO %I', service_owner);
END $$;
