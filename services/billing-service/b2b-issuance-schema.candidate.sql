-- Candidate ONLY, review/apply exclusively in a NEW synthetic Billing DB.
-- Requires the candidate Prisma schema (nullable createdByUserId + createdByActor)
-- and b2b-drafts-schema.candidate.sql. No automatic migration/activation in QA.
ALTER TABLE "Document" ADD CONSTRAINT "DocumentB2bActorConsistency" CHECK ((
  ("createdByActor" IS NULL AND "createdByUserId" IS NOT NULL) OR
  ("createdByActor" IS NOT NULL AND "createdByActor"->>'clientId' IS NOT NULL AND
   (("createdByActor"->>'kind'='SERVICE' AND "createdByUserId" IS NULL AND "createdByActor"->'subjectId'='null'::jsonb) OR
    ("createdByActor"->>'kind'='USER' AND "createdByUserId" IS NOT NULL AND "createdByActor"->>'subjectId'="createdByUserId"::text)))
) IS TRUE);
CREATE TABLE "B2bCommitEvent" (
  "id" uuid PRIMARY KEY,
  "operationId" uuid NOT NULL UNIQUE REFERENCES "B2bDraftOperation"("id") DEFERRABLE INITIALLY DEFERRED,
  "documentId" uuid NOT NULL UNIQUE REFERENCES "Document"("id"),
  "clientId" uuid NOT NULL,
  "actorKey" text NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "binding" jsonb NOT NULL CHECK ("binding"->>'environment'='BETA'),
  "payload" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "fannedOutAt" timestamptz
);
CREATE INDEX "B2bCommitEventPending" ON "B2bCommitEvent" ("createdAt","id") WHERE "fannedOutAt" IS NULL;
-- Phase 5 owns fanout/delivery retries. This table does NOT send webhooks.
