-- Offline installation only, never apply from application bootstrap.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:production-notes-schema:v1',0));
CREATE TABLE "ProductionNotesGrant" (
 "issuerRuc" char(11) PRIMARY KEY, "profile" text NOT NULL CHECK("profile" IN ('07-08-ON-01-PEN-0101-IGV18-v1','07-08-ON-01-03-PEN-0101-IGV18-v2')),
 "enabled" boolean NOT NULL, "version" integer NOT NULL CHECK("version">0), "credentialRevision" integer NOT NULL CHECK("credentialRevision">=0),
 "fingerprint" char(64) NOT NULL, "actorId" uuid NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionNotesGrantAudit" ("id" uuid PRIMARY KEY,"issuerRuc" char(11) NOT NULL,"version" integer NOT NULL,"enabled" boolean NOT NULL,"actorId" uuid NOT NULL,"occurredAt" timestamptz NOT NULL DEFAULT now(),"profile" text NOT NULL DEFAULT '07-08-ON-01-PEN-0101-IGV18-v1');
CREATE TABLE "ProductionNotesDispatch" (
 "documentId" uuid PRIMARY KEY REFERENCES "FiscalDocument"("documentId"),"eventId" uuid UNIQUE NOT NULL,
 "payload" jsonb NOT NULL,"snapshotSha256" char(64) NOT NULL,"phase" text NOT NULL DEFAULT 'AWAITING_AUTHORIZATION'
 CHECK("phase" IN ('AWAITING_AUTHORIZATION','PREPARING','PREPARED','SENDING','DONE','UNKNOWN','BLOCKED')),
 "lease" uuid,"leaseUntil" timestamptz,"manifest" jsonb,"lastCode" text,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "ProductionNotesDispatch_phase_idx" ON "ProductionNotesDispatch"("phase","createdAt");
CREATE TABLE "ProductionNotesStatusOutbox" ("id" uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "FiscalDocument"("documentId"),"payload" jsonb NOT NULL,"publishedAt" timestamptz,"createdAt" timestamptz NOT NULL DEFAULT now());
COMMIT;
