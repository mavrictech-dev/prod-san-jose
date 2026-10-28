-- Manual review artifact only. NOT a startup migration. NOT applied by Codex.
-- Target: the EXISTING Identity owner database, with its native User/RBAC tables.
-- Use only if ALL THREE B2B tables below are absent. No IF NOT EXISTS:
-- an existing installation must be reviewed for compatibility, never hidden.
-- This matches PostgresB2bStore/PgTransaction and the existing B2B schema.
-- OnPrem SERVICE/readonly/BETA/01-03 restrictions are enforced by the native
-- module; the shared table remains compatible with the full Identity owner.
BEGIN;
CREATE TABLE "B2bClient" (
  "id" uuid PRIMARY KEY,
  "label" varchar(120) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "kind" text NOT NULL CHECK ("kind" IN ('SERVICE','USER')),
  "enabled" boolean NOT NULL,
  "revision" integer NOT NULL CHECK ("revision">0),
  "secretHash" text,
  "oidcClientId" varchar(120),
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes")='array'),
  "bindings" jsonb NOT NULL CHECK (jsonb_typeof("bindings")='array'),
  CHECK (
    ("kind"='SERVICE' AND "secretHash" IS NOT NULL AND "secretHash" ~ '^[a-f0-9]{64}$' AND "oidcClientId" IS NULL)
    OR
    ("kind"='USER' AND "secretHash" IS NULL AND "oidcClientId" IS NOT NULL)
  )
);
CREATE TABLE "B2bAudit" (
  "id" uuid PRIMARY KEY,
  "requestId" uuid NOT NULL,
  "clientId" uuid,
  "actorId" uuid,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "revision" integer,
  "peerHash" char(64) NOT NULL,
  "at" timestamptz NOT NULL
);
CREATE INDEX ON "B2bAudit" ("clientId","at");
CREATE TABLE "B2bRateBucket" (
  "keyHash" char(64) PRIMARY KEY,
  "window" bigint NOT NULL,
  "count" integer NOT NULL CHECK ("count">0)
);
COMMIT;
