-- Review offline; do not apply implicitly. Requires production-dispatch.sql.
-- Only the profile CHECK expands. Existing rows, credentials and counters are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:sunat:production-receipt-profile-expand:v2', 0));
DO $migration$
DECLARE
  target regclass := to_regclass('"FiscalDispatchAuthorization"');
  profile_attribute smallint;
  existing record;
  expression text;
BEGIN
  IF target IS NULL THEN
    RAISE EXCEPTION 'FiscalDispatchAuthorization missing: install the base schema first';
  END IF;
  LOCK TABLE "FiscalDispatchAuthorization" IN ACCESS EXCLUSIVE MODE;
  SELECT attnum INTO profile_attribute FROM pg_attribute
    WHERE attrelid = target AND attname = 'profile' AND NOT attisdropped;
  IF profile_attribute IS NULL THEN
    RAISE EXCEPTION 'Expected profile column missing';
  END IF;
  SELECT c.oid, c.contype, c.conkey, c.convalidated, c.conbin INTO existing
    FROM pg_constraint c WHERE c.conrelid = target AND c.conname = 'FiscalDispatchAuthorization_profile_check';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expected profile constraint missing: no schema changes performed';
  END IF;
  IF existing.contype <> 'c' OR existing.conkey IS DISTINCT FROM ARRAY[profile_attribute]::smallint[] OR NOT existing.convalidated THEN
    RAISE EXCEPTION 'Expected validated single-column profile CHECK: refusing to replace constraint';
  END IF;
  -- Accept exactly the known v1/v2 expressions. No other restriction may be silently weakened.
  expression := regexp_replace(pg_get_expr(existing.conbin, target), '::(text|character varying)(\[\])?', '', 'g');
  expression := regexp_replace(expression, '[[:space:]()]', '', 'g');
  IF expression = $expected$profile=ANYARRAY['01-PEN-0101-IGV18-v1','01-03-PEN-0101-IGV18-v2']$expected$ THEN
    RETURN; -- Already installed and validated: do not drop or rebuild it.
  END IF;
  IF expression <> $expected$profile='01-PEN-0101-IGV18-v1'$expected$ THEN
    RAISE EXCEPTION 'Unrecognized profile CHECK: review installed schema before expansion';
  END IF;
  ALTER TABLE "FiscalDispatchAuthorization" DROP CONSTRAINT "FiscalDispatchAuthorization_profile_check";
  ALTER TABLE "FiscalDispatchAuthorization" ADD CONSTRAINT "FiscalDispatchAuthorization_profile_check"
    CHECK ("profile" IN ('01-PEN-0101-IGV18-v1', '01-03-PEN-0101-IGV18-v2'));
END;
$migration$;
COMMIT;
