-- Explicit installation for a NEW Mailer-owned database. Does not activate SMTP.
-- Review with TI; connect as the database owner and set the exact target first:
-- SET factuez.smtp_install_database = '<reviewed database name>';
-- Never use this file to update or reset an existing installation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:mailer:corporate-install:v1',0));
DO $guard$
DECLARE expected text := current_setting('factuez.smtp_install_database',true); owner_name text;
BEGIN
 IF expected IS NULL OR expected !~ '^[a-z][a-z0-9_]{0,62}$' OR expected <> current_database() THEN
  RAISE EXCEPTION 'Set and review the exact Mailer database identity before installation';
 END IF;
 SELECT pg_get_userbyid(datdba) INTO owner_name FROM pg_database WHERE datname=current_database();
 IF current_user <> owner_name THEN RAISE EXCEPTION 'Install as the reviewed Mailer database owner'; END IF;
 IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name IN
 ('CorporateSmtpConfiguration','CorporateSmtpConfigurationAudit','CorporateSmtpActivation','CorporateMailTestJob','CorporateMailAudit')) THEN
  RAISE EXCEPTION 'Existing SMTP schema: use a separately reviewed upgrade, never reinstall';
 END IF;
END;
$guard$;
CREATE TABLE IF NOT EXISTS "CorporateSmtpConfiguration" (
  "issuerRuc" varchar(11) PRIMARY KEY CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "companyId" integer NOT NULL CHECK ("companyId" > 0),
  "configurationCipher" varchar(5700) NOT NULL CHECK ("configurationCipher" ~ '^v1\.[0-9]{1,5}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  "keyVersion" integer NOT NULL CHECK ("keyVersion" BETWEEN 1 AND 10000),
  revision integer NOT NULL CHECK (revision > 0),
  "updatedBy" uuid NOT NULL,
  "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "CorporateSmtpConfigurationAudit" (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "companyId" integer NOT NULL CHECK ("companyId" > 0),
  "actorId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  "credentialsReplaced" boolean NOT NULL,
  action varchar(40) NOT NULL DEFAULT 'smtp.configuration.saved' CHECK (action = 'smtp.configuration.saved'),
  "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("issuerRuc", revision)
);
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname=current_database();
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON "CorporateSmtpConfiguration", "CorporateSmtpConfigurationAudit" TO %I',service_owner);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE "CorporateSmtpConfigurationAudit_id_seq" TO %I',service_owner);
END $$;
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
