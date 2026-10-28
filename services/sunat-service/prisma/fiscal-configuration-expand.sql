-- Expansión aditiva. Respaldar y ensayar en copia antes del corte con datos.
BEGIN;
ALTER TABLE "SunatCredentials" ADD COLUMN IF NOT EXISTS "certificateCipher" TEXT;
ALTER TABLE "SunatCredentials" ADD COLUMN IF NOT EXISTS "certificateSelfSigned" BOOLEAN;
ALTER TABLE "SunatCredentials" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS "FiscalConfigurationAudit" (
  "id" UUID NOT NULL PRIMARY KEY,
  "issuerRuc" CHAR(11) NOT NULL,
  "environment" "SunatEnvironment" NOT NULL,
  "actorId" UUID NOT NULL,
  "fields" TEXT[] NOT NULL,
  "revision" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "FiscalConfigurationAudit_issuerRuc_environment_occurredAt_idx"
  ON "FiscalConfigurationAudit"("issuerRuc", "environment", "occurredAt");
-- Si el DBA aplica la expansión, el runtime conserva sólo el acceso requerido
-- a su propia auditoría. No se otorgan permisos entre bases o a PUBLIC.
DO $$
DECLARE service_owner NAME;
BEGIN
  SELECT pg_get_userbyid(datdba) INTO service_owner
    FROM pg_database WHERE datname = current_database();
  EXECUTE format('GRANT SELECT, INSERT ON "FiscalConfigurationAudit" TO %I', service_owner);
END $$;
COMMIT;
