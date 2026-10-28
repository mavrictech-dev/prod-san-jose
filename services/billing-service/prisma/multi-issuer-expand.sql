-- Ejecutar con servicios detenidos, respaldo verificado y phase1-expand.sql aplicado.
-- No cambia XML, snapshots, números ni claves de idempotencia.
BEGIN;
LOCK TABLE "CompanySettings", "Branch", "EmissionPoint", "SeriesCounter", "Document", "DailySummary" IN ACCESS EXCLUSIVE MODE;
CREATE SEQUENCE IF NOT EXISTS "CompanySettings_id_seq";
ALTER SEQUENCE "CompanySettings_id_seq" OWNED BY "CompanySettings"."id";
SELECT setval('"CompanySettings_id_seq"', GREATEST(COALESCE((SELECT MAX("id") FROM "CompanySettings"), 0), 1), EXISTS(SELECT 1 FROM "CompanySettings"));
ALTER TABLE "CompanySettings" ALTER COLUMN "id" SET DEFAULT nextval('"CompanySettings_id_seq"');
ALTER TABLE "Branch" ALTER COLUMN "companyId" DROP DEFAULT;
ALTER TABLE "SeriesCounter" ADD COLUMN IF NOT EXISTS "companyId" INTEGER;
UPDATE "SeriesCounter" c SET "companyId" = p."companyId" FROM "EmissionPoint" p WHERE c."emissionPointId" = p."id" AND c."companyId" IS NULL;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "companyId" INTEGER;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "seriesCounterId" UUID;
-- Recuperar el emisor original del snapshot, no de un parámetro o sede actual.
UPDATE "Document" d SET "companyId" = c."id" FROM "CompanySettings" c WHERE d."companyId" IS NULL AND c."ruc" = d."immutableSnapshot"->'issuer'->>'identityNumber';
UPDATE "Document" d SET "seriesCounterId" = c."id" FROM "SeriesCounter" c WHERE d."seriesCounterId" IS NULL AND d."companyId" = c."companyId" AND d."type" = c."documentType" AND d."series" = c."series";
ALTER TABLE "DailySummary" ADD COLUMN IF NOT EXISTS "companyId" INTEGER;
UPDATE "DailySummary" s SET "companyId" = p."companyId" FROM "EmissionPoint" p WHERE s."companyId" IS NULL AND s."emissionPointId" = p."id";
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM "Document" d LEFT JOIN "CompanySettings" c ON c."id" = d."companyId"
    WHERE d."companyId" IS NULL OR d."seriesCounterId" IS NULL OR c."ruc" IS DISTINCT FROM d."immutableSnapshot"->'issuer'->>'identityNumber') THEN
    RAISE EXCEPTION 'Emisor histórico o serie sin resolver. Revisar manualmente; toda la actualización se revierte.';
  END IF;
END $$;
ALTER TABLE "SeriesCounter" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Document" ALTER COLUMN "seriesCounterId" SET NOT NULL;
ALTER TABLE "DailySummary" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "ConfigurationAudit" ALTER COLUMN "entityId" TYPE VARCHAR(120) USING "entityId"::text;

DROP INDEX IF EXISTS "SeriesCounter_documentType_series_key";
DROP INDEX IF EXISTS "Document_type_series_number_key";
DROP INDEX IF EXISTS "Document_originSystem_originId_key";
DROP INDEX IF EXISTS "DailySummary_identifier_key";
DROP INDEX IF EXISTS "DailySummary_referenceDate_sequence_key";
CREATE UNIQUE INDEX IF NOT EXISTS "Branch_id_companyId_key" ON "Branch"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "EmissionPoint_id_companyId_key" ON "EmissionPoint"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "SeriesCounter_id_companyId_key" ON "SeriesCounter"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "SeriesCounter_companyId_documentType_series_key" ON "SeriesCounter"("companyId", "documentType", "series");
CREATE UNIQUE INDEX IF NOT EXISTS "Document_companyId_type_series_number_key" ON "Document"("companyId", "type", "series", "number");
CREATE UNIQUE INDEX IF NOT EXISTS "Document_companyId_originSystem_originId_key" ON "Document"("companyId", "originSystem", "originId");
CREATE UNIQUE INDEX IF NOT EXISTS "DailySummary_companyId_identifier_key" ON "DailySummary"("companyId", "identifier");
CREATE UNIQUE INDEX IF NOT EXISTS "DailySummary_companyId_referenceDate_sequence_key" ON "DailySummary"("companyId", "referenceDate", "sequence");
-- Claves compuestas impiden vincular sede/punto/serie/documento de RUC diferentes.
ALTER TABLE "EmissionPoint" DROP CONSTRAINT IF EXISTS "EmissionPoint_branchId_fkey";
ALTER TABLE "EmissionPoint" DROP CONSTRAINT IF EXISTS "EmissionPoint_branchId_companyId_fkey";
ALTER TABLE "EmissionPoint" ADD CONSTRAINT "EmissionPoint_branchId_companyId_fkey" FOREIGN KEY ("branchId", "companyId") REFERENCES "Branch"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SeriesCounter" DROP CONSTRAINT IF EXISTS "SeriesCounter_emissionPointId_fkey";
ALTER TABLE "SeriesCounter" DROP CONSTRAINT IF EXISTS "SeriesCounter_emissionPointId_companyId_fkey";
ALTER TABLE "SeriesCounter" ADD CONSTRAINT "SeriesCounter_emissionPointId_companyId_fkey" FOREIGN KEY ("emissionPointId", "companyId") REFERENCES "EmissionPoint"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_emissionPointId_fkey";
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_emissionPointId_companyId_fkey";
ALTER TABLE "Document" ADD CONSTRAINT "Document_emissionPointId_companyId_fkey" FOREIGN KEY ("emissionPointId", "companyId") REFERENCES "EmissionPoint"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Document" DROP CONSTRAINT IF EXISTS "Document_seriesCounterId_companyId_fkey";
ALTER TABLE "Document" ADD CONSTRAINT "Document_seriesCounterId_companyId_fkey" FOREIGN KEY ("seriesCounterId", "companyId") REFERENCES "SeriesCounter"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "DailySummary" DROP CONSTRAINT IF EXISTS "DailySummary_emissionPointId_fkey";
ALTER TABLE "DailySummary" DROP CONSTRAINT IF EXISTS "DailySummary_emissionPointId_companyId_fkey";
ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_emissionPointId_companyId_fkey" FOREIGN KEY ("emissionPointId", "companyId") REFERENCES "EmissionPoint"("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'SeriesCounter_companyId_fkey') THEN
 ALTER TABLE "SeriesCounter" ADD CONSTRAINT "SeriesCounter_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanySettings"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'Document_companyId_fkey') THEN
 ALTER TABLE "Document" ADD CONSTRAINT "Document_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanySettings"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname = 'DailySummary_companyId_fkey') THEN
 ALTER TABLE "DailySummary" ADD CONSTRAINT "DailySummary_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "CompanySettings"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF;
END $$;
COMMIT;
