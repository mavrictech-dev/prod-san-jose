-- NEW Mailer-owned tables only. Manually reviewed/applied by integrator; never at startup.
-- Rehearsal: a NEW isolated database named factuez_mailer_qa. Never an existing environment.
DO $$ BEGIN
  IF current_database() <> 'factuez_mailer_qa' THEN RAISE EXCEPTION 'MAILER_DATABASE_REQUIRED'; END IF;
  IF to_regclass('public."CorporateSmtpConfiguration"') IS NULL THEN RAISE EXCEPTION 'SMTP_CONFIGURATION_REQUIRED'; END IF;
END $$;
BEGIN;
CREATE TABLE IF NOT EXISTS "CorporateSmtpActivation" (
  "issuerRuc" varchar(11) PRIMARY KEY CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "companyId" integer NOT NULL CHECK ("companyId" > 0),
  revision integer NOT NULL CHECK (revision > 0),
  "configurationRevision" integer NOT NULL CHECK ("configurationRevision" > 0),
  "configurationDigest" char(64) NOT NULL CHECK ("configurationDigest" ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT false,
  "updatedBy" uuid NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CorporateMailTestJob" (
  id uuid PRIMARY KEY,
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "companyId" integer NOT NULL CHECK ("companyId" > 0),
  "actorId" uuid NOT NULL,
  "configurationRevision" integer NOT NULL CHECK ("configurationRevision" > 0),
  "configurationDigest" char(64) NOT NULL CHECK ("configurationDigest" ~ '^[a-f0-9]{64}$'),
  "activationRevision" integer NOT NULL CHECK ("activationRevision" > 0),
  "idempotencyHash" char(64) NOT NULL CHECK ("idempotencyHash" ~ '^[a-f0-9]{64}$'),
  "requestHash" char(64) NOT NULL CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  "payloadCipher" varchar(17000),
  state varchar(20) NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','PREPARING','SENDING','HANDED_OFF','UNKNOWN','FAILED','CANCELLED')),
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" timestamptz NOT NULL CHECK ("expiresAt" <= "createdAt" + interval '2 minutes' AND "expiresAt" > "createdAt"),
  "claimedAt" timestamptz,
  "finishedAt" timestamptz,
  CHECK ((state IN ('QUEUED','PREPARING','SENDING') AND "payloadCipher" IS NOT NULL AND "finishedAt" IS NULL)
    OR (state IN ('HANDED_OFF','UNKNOWN','FAILED','CANCELLED') AND "payloadCipher" IS NULL AND "finishedAt" IS NOT NULL)),
  UNIQUE ("issuerRuc", "actorId", "idempotencyHash")
);
CREATE INDEX IF NOT EXISTS "CorporateMailTestJob_pending" ON "CorporateMailTestJob" (state, "expiresAt");
CREATE INDEX IF NOT EXISTS "CorporateMailTestJob_actor_rate" ON "CorporateMailTestJob" ("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "CorporateMailTestJob_ruc_rate" ON "CorporateMailTestJob" ("issuerRuc", "createdAt");
CREATE TABLE IF NOT EXISTS "CorporateMailAudit" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "companyId" integer NOT NULL CHECK ("companyId" > 0),
  "actorId" uuid NOT NULL,
  "configurationRevision" integer NOT NULL,
  "activationRevision" integer NOT NULL,
  "jobId" uuid,
  event varchar(32) NOT NULL CHECK (event IN ('ACTIVATED','DEACTIVATED','QUEUED','PREPARING','SENDING','HANDED_OFF','UNKNOWN','FAILED','CANCELLED')),
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Audit deliberately has no recipient, username, token, password, protocol response or exception text.
CREATE INDEX IF NOT EXISTS "CorporateMailAudit_ruc" ON "CorporateMailAudit" ("issuerRuc", id DESC);
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname=current_database();
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON "CorporateSmtpActivation", "CorporateMailTestJob" TO %I',service_owner);
  EXECUTE format('GRANT SELECT,INSERT ON "CorporateMailAudit" TO %I',service_owner);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE "CorporateMailAudit_id_seq" TO %I',service_owner);
END $$;
COMMIT;
