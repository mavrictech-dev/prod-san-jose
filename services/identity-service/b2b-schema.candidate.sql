-- CANDIDATE ONLY. Never executed on startup or included in automatic migrations.
-- Review/backup and authorize the target Identity DB before applying.
BEGIN;
CREATE TABLE "B2bClient" (
  "id" uuid PRIMARY KEY, "label" varchar(120) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "kind" text NOT NULL CHECK ("kind" IN ('SERVICE','USER')),
  "enabled" boolean NOT NULL, "revision" integer NOT NULL CHECK ("revision">0),
  "secretHash" text, "oidcClientId" varchar(120),
  "scopes" jsonb NOT NULL CHECK (jsonb_typeof("scopes")='array'),
  "bindings" jsonb NOT NULL CHECK (jsonb_typeof("bindings")='array'),
  CHECK (("kind"='SERVICE' AND "secretHash" IS NOT NULL AND "secretHash" ~ '^[a-f0-9]{64}$' AND "oidcClientId" IS NULL)
      OR ("kind"='USER' AND "secretHash" IS NULL AND "oidcClientId" IS NOT NULL))
);
CREATE TABLE "B2bAudit" (
  "id" uuid PRIMARY KEY, "requestId" uuid NOT NULL, "clientId" uuid,
  "actorId" uuid, "action" text NOT NULL, "outcome" text NOT NULL,
  "revision" integer, "peerHash" char(64) NOT NULL, "at" timestamptz NOT NULL
);
CREATE INDEX ON "B2bAudit" ("clientId","at");
CREATE TABLE "B2bRateBucket" ("keyHash" char(64) PRIMARY KEY,"window" bigint NOT NULL,"count" integer NOT NULL CHECK ("count">0));
CREATE TABLE "B2bUserLink" (
  "issuer" varchar(500) NOT NULL,"subject" varchar(255) NOT NULL,"oidcClientId" varchar(120) NOT NULL,
  "clientId" uuid NOT NULL REFERENCES "B2bClient"("id") ON DELETE RESTRICT,
  "clientRevision" integer NOT NULL CHECK ("clientRevision">0),
  "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
  "userAuthRevision" integer NOT NULL,"enabled" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("issuer","subject","oidcClientId")
);
COMMIT;
