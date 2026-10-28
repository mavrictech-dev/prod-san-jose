-- Offline installation only. No alteration to counters or existing grants.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:production-notes-schema:v1',0));
CREATE TABLE "ProductionNotesReservation" (
 "documentId" uuid PRIMARY KEY REFERENCES "Document"("id"),"originalId" uuid NOT NULL REFERENCES "Document"("id"),
 "operationId" uuid UNIQUE NOT NULL,"actorId" uuid NOT NULL,"requestSha256" char(64) NOT NULL,
 "snapshotSha256" char(64) NOT NULL,"eventId" uuid UNIQUE NOT NULL,"payload" jsonb NOT NULL,
 "state" text NOT NULL DEFAULT 'QUEUED' CHECK("state" IN ('QUEUED','SUBMITTED','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','UNKNOWN','BLOCKED')),
 "outcome" jsonb,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "ProductionNotesReservation_original_idx" ON "ProductionNotesReservation"("originalId","createdAt");
CREATE TABLE "ProductionNotesOutbox" ("id" uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "Document"("id"),"payload" jsonb NOT NULL,"publishedAt" timestamptz,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionNotesInbox" ("id" uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "Document"("id"),"payloadSha256" char(64) NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
COMMIT;
