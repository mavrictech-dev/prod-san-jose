-- Candidate only. Apply solely to a NEW isolated rehearsal DB until rollout approval.
-- Separate from V1 and synthetic holds: no adoption, backfill, counter reset or release.
CREATE TABLE "B2bCorrectionJournalHead" (
  "originalDocumentId" uuid PRIMARY KEY REFERENCES "Document"("id") ON DELETE RESTRICT,
  "originalSha256" text NOT NULL CHECK ("originalSha256" ~ '^[a-f0-9]{64}$'),
  "revision" integer NOT NULL CHECK ("revision" BETWEEN 1 AND 200),
  "headSha256" text NOT NULL CHECK ("headSha256" ~ '^[a-f0-9]{64}$'),
  "candidateOnly" boolean NOT NULL DEFAULT true CHECK ("candidateOnly")
);
CREATE TABLE "B2bCorrectionJournalEvent" (
  "originalDocumentId" uuid NOT NULL REFERENCES "B2bCorrectionJournalHead"("originalDocumentId") ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision" BETWEEN 1 AND 200),
  "operationId" uuid NOT NULL REFERENCES "Document"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('RESERVE','SETTLE')),
  "event" jsonb NOT NULL,
  "versionSha256" text NOT NULL CHECK ("versionSha256" ~ '^[a-f0-9]{64}$'),
  "actor" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("originalDocumentId","revision"), UNIQUE ("operationId","kind")
);
CREATE TABLE "B2bCorrectionRequestReceipt" (
  "keySha256" text PRIMARY KEY CHECK ("keySha256" ~ '^[a-f0-9]{64}$'),
  "requestSha256" text NOT NULL CHECK ("requestSha256" ~ '^[a-f0-9]{64}$'),
  "externalSha256" text NOT NULL UNIQUE CHECK ("externalSha256" ~ '^[a-f0-9]{64}$'),
  "operationId" uuid NOT NULL UNIQUE REFERENCES "Document"("id") ON DELETE RESTRICT,
  "binding" jsonb NOT NULL,
  "actorIdentitySha256" text NOT NULL CHECK ("actorIdentitySha256" ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION factuez_correction_journal_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CORRECTION_JOURNAL_APPEND_ONLY'; END $$;
CREATE TRIGGER correction_journal_events_immutable BEFORE UPDATE OR DELETE ON "B2bCorrectionJournalEvent"
FOR EACH ROW EXECUTE FUNCTION factuez_correction_journal_append_only();
CREATE TRIGGER correction_journal_receipts_immutable BEFORE UPDATE OR DELETE ON "B2bCorrectionRequestReceipt"
FOR EACH ROW EXECUTE FUNCTION factuez_correction_journal_append_only();
CREATE FUNCTION factuez_correction_journal_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW."originalDocumentId" IS DISTINCT FROM OLD."originalDocumentId"
     OR NEW."originalSha256" IS DISTINCT FROM OLD."originalSha256"
     OR NEW."revision" <> OLD."revision" + 1 OR NOT NEW."candidateOnly" THEN
    RAISE EXCEPTION 'CORRECTION_JOURNAL_HEAD_MONOTONIC';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER correction_journal_head_monotonic BEFORE UPDATE OR DELETE ON "B2bCorrectionJournalHead"
FOR EACH ROW EXECUTE FUNCTION factuez_correction_journal_monotonic();
