-- Migración aditiva para instalaciones existentes sin historial Prisma Billing.
-- Ejecutar después de respaldo; no modifica documentos ni correlativos.
BEGIN;
CREATE TABLE IF NOT EXISTS "Branch" (
  "id" UUID PRIMARY KEY,
  "companyId" INTEGER NOT NULL DEFAULT 1 REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
  "code" VARCHAR(20) NOT NULL UNIQUE,
  "name" VARCHAR(120) NOT NULL,
  "address" VARCHAR(300),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "EmissionPoint" ADD COLUMN IF NOT EXISTS "branchId" UUID REFERENCES "Branch"("id") ON DELETE RESTRICT;
INSERT INTO "Branch" ("id", "companyId", "code", "name")
SELECT '10000000-0000-4000-8000-000000000001', 1, 'CENTRAL', 'Sede principal'
WHERE EXISTS (SELECT 1 FROM "CompanySettings" WHERE "id" = 1)
ON CONFLICT ("code") DO NOTHING;
UPDATE "EmissionPoint" SET "branchId" = (SELECT "id" FROM "Branch" WHERE "code" = 'CENTRAL')
WHERE "branchId" IS NULL AND "companyId" = 1;
CREATE TABLE IF NOT EXISTS "ConfigurationAudit" (
  "id" UUID PRIMARY KEY,
  "actorId" UUID NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "entityId" UUID NOT NULL,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMIT;
