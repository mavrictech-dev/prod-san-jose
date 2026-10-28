-- Candidate ONLY. Apply only to a NEW isolated synthetic DB for rehearsal.
-- No Document/SeriesCounter/Outbox change, data import, counter reset or activation.
CREATE TABLE "B2bDocumentDraft" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid NOT NULL,
  "actorKey" text NOT NULL CHECK (length("actorKey") BETWEEN 9 AND 41),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "issuerId" integer NOT NULL CHECK ("issuerId">0),
  "referenceNamespace" varchar(40) NOT NULL,
  "referenceValue" varchar(120) NOT NULL,
  "binding" jsonb NOT NULL CHECK ("binding"->>'environment'='BETA' AND "binding"->>'documentType' IN ('01','03')),
  "body" jsonb NOT NULL CHECK ("body"->>'environment'='BETA' AND "body"->>'documentType' IN ('01','03')),
  "revision" integer NOT NULL CHECK ("revision">0),
  "state" text NOT NULL CHECK ("state" IN ('DRAFT','CANCELLED','ISSUED')),
  "validatedRevision" integer CHECK ("validatedRevision">0 AND "validatedRevision"<="revision"),
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  CONSTRAINT "B2bDraftReferenceUnique" UNIQUE ("clientId","actorKey","issuerId","referenceNamespace","referenceValue")
);
CREATE TABLE "B2bDraftOperation" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid NOT NULL,
  "actorKey" text NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "keyHash" char(64) NOT NULL CHECK ("keyHash" ~ '^[a-f0-9]{64}$'),
  "draftId" uuid NOT NULL REFERENCES "B2bDocumentDraft"("id"),
  "payload" jsonb NOT NULL,
  CONSTRAINT "B2bDraftCommandUnique" UNIQUE ("clientId","actorKey","keyHash")
);
-- No retention purge is configured: idempotency records must not disappear during retries.
