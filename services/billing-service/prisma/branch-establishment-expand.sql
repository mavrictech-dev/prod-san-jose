-- Expand only; Main applies this transaction during the controlled deployment.
-- Repeated execution verifies the installed definition without rewriting any rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
LOCK TABLE public."Branch" IN ACCESS EXCLUSIVE MODE;

DO $branch_establishment$
DECLARE
  branch_oid oid := 'public."Branch"'::regclass;
  column_info record;
  check_info record;
  check_expression text;
BEGIN
  SELECT a.* INTO column_info
    FROM pg_catalog.pg_attribute AS a
    WHERE a.attrelid = branch_oid AND a.attname = 'establishmentCode'
      AND a.attnum > 0 AND NOT a.attisdropped;

  IF FOUND THEN
    IF column_info.atttypid <> 'pg_catalog.varchar'::regtype
      OR column_info.atttypmod <> 8 -- varchar length + PostgreSQL header (4 + 4)
      OR column_info.attnotnull OR column_info.atthasdef
      OR column_info.attidentity <> '' OR column_info.attgenerated <> '' THEN
      RAISE EXCEPTION 'Billing baseline mismatch: Branch.establishmentCode must be nullable varchar(4) without a default, identity or generated value';
    END IF;
  ELSE
    ALTER TABLE public."Branch" ADD COLUMN "establishmentCode" VARCHAR(4);
    SELECT a.* INTO STRICT column_info FROM pg_catalog.pg_attribute AS a
      WHERE a.attrelid = branch_oid AND a.attname = 'establishmentCode'
        AND a.attnum > 0 AND NOT a.attisdropped;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
      WHERE c.conrelid = branch_oid AND c.conname = 'Branch_establishmentCode_check'
  ) THEN
    ALTER TABLE public."Branch" ADD CONSTRAINT "Branch_establishmentCode_check"
      CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{4}$');
  END IF;

  SELECT c.* INTO STRICT check_info FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid = branch_oid AND c.conname = 'Branch_establishmentCode_check';
  -- Compare PostgreSQL's canonical expression without changing string literals.
  check_expression := pg_catalog.pg_get_expr(check_info.conbin, check_info.conrelid);
  IF check_info.contype <> 'c' OR NOT check_info.convalidated
    OR check_info.connoinherit OR check_info.condeferrable OR check_info.condeferred
    OR check_info.conkey IS DISTINCT FROM ARRAY[column_info.attnum]::smallint[]
    OR check_expression IS DISTINCT FROM '(("establishmentCode" IS NULL) OR (("establishmentCode")::text ~ ''^[0-9]{4}$''::text))' THEN
    RAISE EXCEPTION 'Billing baseline mismatch: Branch_establishmentCode_check must be the validated nullable four-digit CHECK';
  END IF;
END
$branch_establishment$;
COMMIT;
