-- Migración ADITIVA de maestros. Aplicar sólo a factuez_billing del QA autorizado.
-- No db push: no toca tablas financieras candidatas, documentos, números o series.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE "CompanySettings" ADD COLUMN IF NOT EXISTS "active" boolean NOT NULL DEFAULT true;
ALTER TABLE "Branch" ADD COLUMN IF NOT EXISTS "masterRevision" integer NOT NULL DEFAULT 1;
ALTER TABLE "EmissionPoint" ADD COLUMN IF NOT EXISTS "masterRevision" integer NOT NULL DEFAULT 1;
ALTER TABLE "SeriesCounter" ADD COLUMN IF NOT EXISTS "masterRevision" integer NOT NULL DEFAULT 1;
COMMIT;
