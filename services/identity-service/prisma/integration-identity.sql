-- Phase 3 blueprint. NOT installed by the normal Prisma migrate pipeline.
-- Apply only to an explicitly authorized new/copy Identity database after backup.
-- No Billing tables, counters, secrets in plaintext or fiscal Outbox.
CREATE TABLE "IntegrationClient" (
  "id" uuid PRIMARY KEY,
  "label" varchar(120) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment" = 'BETA'),
  "enabled" boolean NOT NULL DEFAULT true,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "secretHash" char(64) NOT NULL CHECK ("secretHash" ~ '^[a-f0-9]{64}$'),
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes") = 'array'),
  "grants" jsonb NOT NULL CHECK (jsonb_typeof("grants") = 'array'),
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "secretRotatedAt" timestamptz NOT NULL
);
CREATE TABLE "IntegrationAudit" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid REFERENCES "IntegrationClient"("id"),
  "actorId" uuid,
  "requestId" uuid NOT NULL,
  "peerHash" char(64) NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('CREATE','UPDATE','ROTATE','TOKEN','AUTHENTICATE')),
  "outcome" varchar(80) NOT NULL,
  "revision" integer,
  "at" timestamptz NOT NULL
);
CREATE INDEX "IntegrationAudit_client_at" ON "IntegrationAudit" ("clientId", "at");
CREATE TABLE "IntegrationRateBucket" (
  "keyHash" char(64) PRIMARY KEY,
  "window" bigint NOT NULL,
  "count" integer NOT NULL CHECK ("count" > 0)
);
