-- Optional fuel configuration extension. Apply after guide-operational-settings.sql.
-- Replaces only this module's payload CHECK; preserves rows, ownership and revisions.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "GuideOperationalSettings" DROP CONSTRAINT IF EXISTS "GuideOperationalSettings_payload_check";
ALTER TABLE "GuideOperationalSettings" ADD CONSTRAINT "GuideOperationalSettings_payload_check" CHECK (
  jsonb_typeof("settings") = 'object' AND octet_length("settings"::text) <= 262144
  AND "settings" ?& ARRAY['role','products','routes']
  AND ("settings" - ARRAY['role','products','routes','fuelProfile']) = '{}'::jsonb
  AND COALESCE("settings"->>'role' IN ('REMITENTE','TRANSPORTISTA','AMBOS'), false)
  AND jsonb_typeof("settings"->'products') = 'array' AND jsonb_array_length("settings"->'products') BETWEEN 1 AND 30
  AND jsonb_typeof("settings"->'routes') = 'array' AND jsonb_array_length("settings"->'routes') BETWEEN 1 AND 30
  AND (NOT ("settings" ? 'fuelProfile') OR COALESCE(
    jsonb_typeof("settings"->'fuelProfile') = 'object'
    AND "settings"->'fuelProfile'->>'version' = 'factuez.guide-fuel-settings.v1'
    AND jsonb_typeof("settings"->'fuelProfile'->'products') = 'array'
    AND jsonb_array_length("settings"->'fuelProfile'->'products') BETWEEN 1 AND 30
    AND jsonb_typeof("settings"->'fuelProfile'->'routes') = 'array'
    AND jsonb_array_length("settings"->'fuelProfile'->'routes') BETWEEN 1 AND 30, false))
);
COMMIT;
