-- SÓLO preparar/revisar. La integración principal aplica tras respaldo; no ejecutado aquí.
-- Aditivo e independiente de FiscalDocument, ventas, correlativos y bases Billing/Identity.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'factuez_sunat' THEN RAISE EXCEPTION 'GRE QA requiere base propia factuez_sunat'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS "GreQaGuide" (
  "id" uuid PRIMARY KEY, "actorId" uuid NOT NULL, "idempotencyKey" uuid NOT NULL,
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^00[0-9]{9}$'), "companyId" integer NOT NULL CHECK ("companyId">0),
  "originBranchId" uuid NOT NULL, "destinationBranchId" uuid NOT NULL CHECK ("destinationBranchId"<>"originBranchId"),
  "localIdentifier" varchar(50) NOT NULL UNIQUE CHECK ("localIdentifier"='GRE-QA-' || "id"::text),
  "ublNumber" varchar(20) NOT NULL CHECK ("ublNumber" ~ '^TQ00-[1-9][0-9]{0,7}$'),
  "payload" jsonb NOT NULL, "inputSha256" char(64) NOT NULL,
  "xmlArtifact" jsonb NOT NULL, "zipArtifact" jsonb NOT NULL,
  "signatureVerified" boolean NOT NULL DEFAULT false, "digestValue" varchar(128), "certificateFingerprint" varchar(128), "credentialRevision" integer,
  "xsdEvidence" jsonb, "state" varchar(32) NOT NULL DEFAULT 'PREPARED_LOCAL' CHECK ("state" IN ('PREPARED_LOCAL','SIMULATED_READY','SIMULATED_REJECTED','LOCAL_UNKNOWN')),
  "simulation" jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GreQaGuide_actorId_idempotencyKey_key" UNIQUE ("actorId","idempotencyKey"),
  CONSTRAINT "GreQaGuide_issuerRuc_ublNumber_key" UNIQUE ("issuerRuc","ublNumber")
);
CREATE INDEX IF NOT EXISTS "GreQaGuide_companyId_createdAt_idx" ON "GreQaGuide"("companyId","createdAt" DESC);
DO $$ DECLARE service_owner NAME; BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner FROM pg_database WHERE datname=current_database();
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON "GreQaGuide" TO %I',service_owner);
END $$;
COMMIT;
