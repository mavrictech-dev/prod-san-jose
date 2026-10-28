-- Actualización de la base propia de SUNAT. Respaldo y servicios detenidos.
BEGIN;
LOCK TABLE "IssuerProjection", "SunatCredentials", "FiscalDocument", "FiscalBatch" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "IssuerProjection" ALTER COLUMN "id" DROP DEFAULT;
CREATE SEQUENCE IF NOT EXISTS "SunatCredentials_id_seq";
ALTER SEQUENCE "SunatCredentials_id_seq" OWNED BY "SunatCredentials"."id";
SELECT setval('"SunatCredentials_id_seq"', GREATEST(COALESCE((SELECT MAX("id") FROM "SunatCredentials"),0),1), EXISTS(SELECT 1 FROM "SunatCredentials"));
ALTER TABLE "SunatCredentials" ALTER COLUMN "id" SET DEFAULT nextval('"SunatCredentials_id_seq"');
ALTER TABLE "SunatCredentials" ADD COLUMN IF NOT EXISTS "issuerRuc" CHAR(11);
ALTER TABLE "SunatCredentials" ADD COLUMN IF NOT EXISTS "environment" "SunatEnvironment";
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "SunatCredentials" WHERE "issuerRuc" IS NULL OR "environment" IS NULL) AND (SELECT COUNT(*) FROM "IssuerProjection") <> 1 THEN
  RAISE EXCEPTION 'Credenciales antiguas sin propietario inequívoco. Resolver RUC y entorno manualmente; no se copiarán entre empresas.';
 END IF;
END $$;
UPDATE "SunatCredentials" s SET "issuerRuc" = c."ruc", "environment" = c."environment" FROM "IssuerProjection" c WHERE s."issuerRuc" IS NULL AND (SELECT COUNT(*) FROM "IssuerProjection") = 1;
ALTER TABLE "SunatCredentials" ALTER COLUMN "issuerRuc" SET NOT NULL;
ALTER TABLE "SunatCredentials" ALTER COLUMN "environment" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "SunatCredentials_issuerRuc_environment_key" ON "SunatCredentials"("issuerRuc", "environment");
ALTER TABLE "FiscalDocument" ADD COLUMN IF NOT EXISTS "issuerRuc" CHAR(11);
ALTER TABLE "FiscalBatch" ADD COLUMN IF NOT EXISTS "issuerRuc" CHAR(11);
UPDATE "FiscalDocument" SET "issuerRuc" = "immutablePayload"->'issuer'->>'identityNumber' WHERE "issuerRuc" IS NULL;
UPDATE "FiscalBatch" SET "issuerRuc" = "immutablePayload"->'issuer'->>'identityNumber' WHERE "issuerRuc" IS NULL;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "FiscalDocument" WHERE "issuerRuc" IS NULL OR "issuerRuc" !~ '^[0-9]{11}$' OR "issuerRuc" IS DISTINCT FROM "immutablePayload"->'issuer'->>'identityNumber') OR
    EXISTS(SELECT 1 FROM "FiscalBatch" WHERE "issuerRuc" IS NULL OR "issuerRuc" !~ '^[0-9]{11}$') THEN
  RAISE EXCEPTION 'Snapshot fiscal sin RUC original: resolver manualmente antes de continuar.';
 END IF;
 IF EXISTS(SELECT 1 FROM "FiscalDocument" WHERE "immutablePayload"->>'environment' IS NOT NULL AND "environment"::text <> "immutablePayload"->>'environment') THEN
  RAISE EXCEPTION 'Entorno persistido diferente del snapshot fiscal: revisar manualmente.';
 END IF;
END $$;
ALTER TABLE "FiscalDocument" ALTER COLUMN "issuerRuc" SET NOT NULL;
ALTER TABLE "FiscalBatch" ALTER COLUMN "issuerRuc" SET NOT NULL;
DROP INDEX IF EXISTS "FiscalDocument_environment_documentType_series_number_key";
DROP INDEX IF EXISTS "FiscalBatch_identifier_key";
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalDocument_issuer_fiscal_number_key" ON "FiscalDocument"("issuerRuc", "environment", "documentType", "series", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "FiscalBatch_issuerRuc_environment_identifier_key" ON "FiscalBatch"("issuerRuc", "environment", "identifier");
COMMIT;
