-- Base exclusiva de Identity. Se conservan las asignaciones antiguas para revisión.
BEGIN;
ALTER TABLE "UserSeries" ALTER COLUMN "series" TYPE VARCHAR(36);
-- Las etiquetas antiguas (F001) no se convierten automáticamente en permisos para varios RUC.
-- Un ADMIN debe reasignarlas usando los UUIDs del catálogo de Billing.
UPDATE "User" SET "authVersion" = "authVersion" + 1
WHERE EXISTS(SELECT 1 FROM "UserSeries" s WHERE s."userId" = "User"."id" AND LENGTH(s."series") = 4);
UPDATE "RefreshSession" SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "revokedAt" IS NULL AND EXISTS(SELECT 1 FROM "UserSeries" s WHERE s."userId" = "RefreshSession"."userId" AND LENGTH(s."series") = 4);
COMMIT;
