-- Reviewed candidate, not auto-applied. Use only in an authorized owner upgrade
-- after backup and before enabling the restored reception service.
-- Capture existing pg_proc.proconfig for these exact signatures before applying;
-- rollback restores the recorded settings, never blindly RESET search_path.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE signature text; proc oid;
 signatures text[] := ARRAY[
  'public.factuez_received_read_scope(jsonb)',
  'public.factuez_received_read_policy(jsonb)',
  'public.factuez_received_audit_membership()',
  'public.factuez_received_read_immutable()',
  'public.factuez_received_policy_cas()',
  'public.factuez_received_policy_audited()',
  'public.factuez_received_write_canonical(jsonb)',
  'public.factuez_received_write_hash(jsonb)',
  'public.factuez_received_write_policy(jsonb)',
  'public.factuez_received_write_policy_cas()',
  'public.factuez_received_write_policy_audited()',
  'public.factuez_received_command_authority()',
  'public.factuez_received_document_facts()',
  'public.factuez_received_original_complete()',
  'public.factuez_received_item_matches()'
 ];
BEGIN
 -- Validate the whole owner set BEFORE modifying the first function. No grants,
 -- tables, rows, audit history, series, constraints or triggers are removed.
 FOREACH signature IN ARRAY signatures LOOP
  proc := to_regprocedure(signature);
  IF proc IS NULL OR NOT EXISTS (
   SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
   WHERE p.oid=proc AND p.prokind='f' AND r.rolname=current_user
  ) THEN
   RAISE EXCEPTION 'RECEIVED_RECOVERY_OWNER_FUNCTION_SET_REQUIRED' USING ERRCODE='55000';
  END IF;
 END LOOP;
 FOREACH signature IN ARRAY signatures LOOP
  EXECUTE 'ALTER FUNCTION '||signature||' SET search_path = pg_catalog, public, pg_temp';
 END LOOP;
END;
$$;
COMMIT;
