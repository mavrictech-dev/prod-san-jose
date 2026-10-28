-- Sólo la base NUEVA del capturador local. No migra ningún servicio fiscal.
DO $$ BEGIN
  IF current_database() <> 'factuez_mailer_qa' THEN
    RAISE EXCEPTION 'Inicialización restringida a factuez_mailer_qa';
  END IF;
END $$;
BEGIN;
CREATE TABLE "LocalQaMail" (
  "id" uuid PRIMARY KEY,
  "documentId" uuid NOT NULL,
  "actorId" uuid NOT NULL,
  "recipient" varchar(254) NOT NULL CHECK ("recipient" ~ '^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9]([a-z0-9-]*[a-z0-9])?\.invalid$'),
  "format" varchar(8) NOT NULL CHECK ("format" IN ('ticket','a4')),
  "manifest" jsonb NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','SENDING','RETRYABLE_ERROR','FAILED','UNKNOWN','CAPTURED_LOCAL')),
  "attempt" integer NOT NULL DEFAULT 0,
  "description" varchar(240), "messageId" varchar(255), "claimedAt" timestamp(3),
  "nextAttemptAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedAt" timestamp(3)
);
CREATE UNIQUE INDEX "LocalQaMail_documentId_recipient_format_key" ON "LocalQaMail"("documentId","recipient","format");
CREATE INDEX "LocalQaMail_status_nextAttemptAt_idx" ON "LocalQaMail"("status","nextAttemptAt");
COMMIT;
