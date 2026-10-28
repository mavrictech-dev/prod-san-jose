-- Expansión ADITIVA revisada por el integrador; este agente NO la ejecuta.
-- Sólo BD propia de sunat-service, previa copia verificada. Nunca db push/reset.
-- Para aplicar conscientemente: SET factuez.allow_notes_qa_expand = 'on';
BEGIN;
DO $$ BEGIN
  IF current_setting('factuez.allow_notes_qa_expand', true) IS DISTINCT FROM 'on'
  THEN RAISE EXCEPTION 'Se requiere habilitación explícita de la expansión de notas QA'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS "NotesQaCounter" (
  "id" VARCHAR(40) PRIMARY KEY,
  "lastNumber" INTEGER NOT NULL DEFAULT 0 CHECK ("lastNumber" BETWEEN 0 AND 99999999)
);
CREATE TABLE IF NOT EXISTS "NotesQa" (
  "id" UUID PRIMARY KEY,
  "originalDocumentId" UUID NOT NULL REFERENCES "FiscalDocument"("documentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "originalCircuitId" UUID NOT NULL REFERENCES "FiscalCircuitQa"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "actorId" UUID NOT NULL, "idempotencyKey" UUID NOT NULL,
  "requestSha256" CHAR(64) NOT NULL, "originalSha256" CHAR(64) NOT NULL,
  "credentialRevision" INTEGER NOT NULL CHECK ("credentialRevision">0), "certificateFingerprint" CHAR(64) NOT NULL,
  "issuerRuc" CHAR(11) NOT NULL CHECK ("issuerRuc" ~ '^00[0-9]{9}$'),
  "documentTypeCode" CHAR(2) NOT NULL CHECK ("documentTypeCode" IN ('07','08')),
  "series" CHAR(4) NOT NULL CHECK ("series" ~ '^[FB][CD]Q1$'),
  "number" INTEGER NOT NULL CHECK ("number" BETWEEN 1 AND 99999999),
  "snapshot" JSONB NOT NULL,
  "state" VARCHAR(30) NOT NULL DEFAULT 'QUEUED' CHECK ("state" IN ('QUEUED','SIGNING','SIGNED_LOCAL','BLOCKED')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 3),
  "claimedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "digestValue" VARCHAR(128), "xmlArtifact" JSONB, "zipArtifact" JSONB, "xsdEvidence" JSONB,
  "description" VARCHAR(2048),
  CONSTRAINT "NotesQa_request_key" UNIQUE("originalDocumentId","actorId","idempotencyKey"),
  CONSTRAINT "NotesQa_number_key" UNIQUE("issuerRuc","documentTypeCode","series","number")
);
-- Se reservan también los créditos BLOCKED: no se reciclan números ni se libera saldo implícitamente.
CREATE UNIQUE INDEX IF NOT EXISTS "NotesQa_one_credit_per_original" ON "NotesQa"("originalDocumentId") WHERE "documentTypeCode"='07';
CREATE INDEX IF NOT EXISTS "NotesQa_state_createdAt_idx" ON "NotesQa"("state","createdAt");
CREATE INDEX IF NOT EXISTS "NotesQa_originalDocumentId_createdAt_idx" ON "NotesQa"("originalDocumentId","createdAt");
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname=current_database();
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON "NotesQa","NotesQaCounter" TO %I',service_owner);
END $$;
COMMIT;
