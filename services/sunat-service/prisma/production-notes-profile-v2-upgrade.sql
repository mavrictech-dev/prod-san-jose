-- Reviewed additive upgrade. No existing grant is widened or enabled.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
ALTER TABLE "ProductionNotesGrant" DROP CONSTRAINT IF EXISTS "ProductionNotesGrant_profile_check";
ALTER TABLE "ProductionNotesGrant" ADD CONSTRAINT "ProductionNotesGrant_profile_check" CHECK("profile" IN ('07-08-ON-01-PEN-0101-IGV18-v1','07-08-ON-01-03-PEN-0101-IGV18-v2'));
ALTER TABLE "ProductionNotesGrantAudit" ADD COLUMN IF NOT EXISTS "profile" text NOT NULL DEFAULT '07-08-ON-01-PEN-0101-IGV18-v1';
COMMIT;
