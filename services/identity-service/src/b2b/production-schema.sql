-- Additive PRODUCTION-only journal. No BETA tables, native owners or identity rows changed.
CREATE TABLE IF NOT EXISTS b2b_production_record (
 namespace text NOT NULL CHECK (namespace IN ('client','token','rate','audit','command','nonce','hook','event','delivery','inbox')),
 id text NOT NULL,
 value jsonb NOT NULL CHECK (jsonb_typeof(value)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(namespace,id)
);
CREATE INDEX IF NOT EXISTS b2b_production_record_updated ON b2b_production_record(namespace,updated_at);
-- Installer: separate runtime role; SELECT/INSERT/UPDATE only; no DELETE of audit.
-- Identity/facade must share this journal or an authenticated persistence adapter.

-- Protect append-only audit even when the runtime role can update other journal records.
CREATE OR REPLACE FUNCTION b2b_production_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.namespace='audit' THEN RAISE EXCEPTION 'PRODUCTION_AUDIT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS b2b_production_audit_immutable ON b2b_production_record;
CREATE TRIGGER b2b_production_audit_immutable BEFORE UPDATE OR DELETE ON b2b_production_record
 FOR EACH ROW EXECUTE FUNCTION b2b_production_audit_immutable();
