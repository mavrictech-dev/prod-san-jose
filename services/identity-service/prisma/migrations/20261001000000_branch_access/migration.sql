BEGIN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "authVersion" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS "UserBranch" (
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "branchId" UUID NOT NULL,
  PRIMARY KEY ("userId", "branchId")
);
CREATE TABLE IF NOT EXISTS "UserSeries" (
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "series" VARCHAR(4) NOT NULL,
  PRIMARY KEY ("userId", "series")
);
-- Cuentas existentes no ADMIN requieren asignación explícita de sede y series.
COMMIT;
