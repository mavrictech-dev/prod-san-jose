-- Additive, reviewed installation step; never executed by application startup.
-- Run against the explicitly reviewed Billing database, as its owner.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS "GuideOperationalSettings" (
  "companyId" INTEGER PRIMARY KEY REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
  "settings" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Also add these constraints when the table was created from the Prisma schema.
DO $guide_settings$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='"GuideOperationalSettings"'::regclass AND conname='GuideOperationalSettings_revision_check') THEN
    ALTER TABLE "GuideOperationalSettings" ADD CONSTRAINT "GuideOperationalSettings_revision_check" CHECK ("revision">0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='"GuideOperationalSettings"'::regclass AND conname='GuideOperationalSettings_payload_check') THEN
    ALTER TABLE "GuideOperationalSettings" ADD CONSTRAINT "GuideOperationalSettings_payload_check" CHECK (
      jsonb_typeof("settings") = 'object' AND octet_length("settings"::text) <= 262144
      AND "settings" ?& ARRAY['role','products','routes']
      AND ("settings" - ARRAY['role','products','routes']) = '{}'::jsonb
      AND COALESCE("settings"->>'role' IN ('REMITENTE','TRANSPORTISTA','AMBOS'), false)
      AND jsonb_typeof("settings"->'products') = 'array' AND jsonb_array_length("settings"->'products') BETWEEN 1 AND 30
      AND jsonb_typeof("settings"->'routes') = 'array' AND jsonb_array_length("settings"->'routes') BETWEEN 1 AND 30
    );
  END IF;
END $guide_settings$;
COMMIT;
