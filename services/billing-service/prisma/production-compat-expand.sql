-- Additive compatibility upgrade for the Billing PWA runtime.
-- No row, snapshot, owner, counter, series or document number is rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez.billing.production-compat.v1',0));
DO $upgrade$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Document' AND column_name='createdByUserId' AND udt_name='uuid') THEN
    RAISE EXCEPTION 'Billing baseline mismatch: Document.createdByUserId must exist as uuid';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Document' AND column_name='createdByActor') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='Document' AND column_name='createdByActor' AND udt_name='jsonb' AND is_nullable='YES') THEN
      RAISE EXCEPTION 'Billing baseline mismatch: createdByActor';
    END IF;
  ELSE
    ALTER TABLE "Document" ADD COLUMN "createdByActor" JSONB;
  END IF;
  -- SERVICE actors are represented in verified actor provenance, never as fake users.
  ALTER TABLE "Document" ALTER COLUMN "createdByUserId" DROP NOT NULL;
END
$upgrade$;
COMMIT;
