-- Aditivo: sólo tablas NUEVAS del servicio Mailer, sin ALTER/DELETE ni acceso a Billing/Identity/SUNAT.
-- Debe aplicarlo el integrador tras verificar la base de QA y el rol propietario. No ejecutado por este módulo.
DO $$ BEGIN
  IF current_database() <> 'factuez_mailer_qa' THEN
    RAISE EXCEPTION 'Preparación SMTP restringida a factuez_mailer_qa';
  END IF;
END $$;
BEGIN;
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
COMMIT;
