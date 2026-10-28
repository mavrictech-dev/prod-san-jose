-- Offline additive migration; never executed by bootstrap or tests against QA.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:production-notes-rc:v1',0));
ALTER TABLE "ProductionNotesDispatch" ADD COLUMN IF NOT EXISTS "rcIdentifier" text NULL;
ALTER TABLE "ProductionNotesDispatch" DROP CONSTRAINT IF EXISTS "ProductionNotesDispatch_phase_check";
ALTER TABLE "ProductionNotesDispatch" ADD CONSTRAINT "ProductionNotesDispatch_phase_check" CHECK ("phase" IN ('AWAITING_AUTHORIZATION','PREPARING','PREPARED','SENDING','POLLING','DONE','UNKNOWN','BLOCKED'));
ALTER TABLE "ProductionNotesDispatch" ADD CONSTRAINT "ProductionNotesDispatch_rcIdentifier_check" CHECK ("rcIdentifier" IS NULL OR "rcIdentifier" ~ '^RC-[0-9]{8}-[1-9][0-9]{0,4}$');
CREATE TABLE "ProductionNotesRcTicket" (
 "documentId" uuid PRIMARY KEY REFERENCES "ProductionNotesDispatch"("documentId"),
 "ticket" text NOT NULL CHECK ("ticket" ~ '^[A-Za-z0-9_-]{1,120}$'),
 "requestSha256" char(64) NOT NULL CHECK ("requestSha256" ~ '^[a-f0-9]{64}$'),
 "pollAttempts" integer NOT NULL DEFAULT 0 CHECK ("pollAttempts">=0),
 "nextPollAt" timestamptz NOT NULL DEFAULT now(), "lastCode" text NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX "ProductionNotesRcTicket_due_idx" ON "ProductionNotesRcTicket"("nextPollAt");
CREATE FUNCTION production_notes_rc_ticket_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'RC ticket is immutable'; END IF;
 IF NEW."documentId" IS DISTINCT FROM OLD."documentId" OR NEW."ticket" IS DISTINCT FROM OLD."ticket" OR NEW."requestSha256" IS DISTINCT FROM OLD."requestSha256" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN RAISE EXCEPTION 'RC ticket binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ProductionNotesRcTicket_immutable" BEFORE UPDATE OR DELETE ON "ProductionNotesRcTicket" FOR EACH ROW EXECUTE FUNCTION production_notes_rc_ticket_immutable();
CREATE FUNCTION production_notes_rc_dispatch_binding() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."manifest" IS NOT NULL AND NEW."manifest" IS DISTINCT FROM OLD."manifest" THEN RAISE EXCEPTION 'Prepared notes manifest is immutable'; END IF;
 IF OLD."rcIdentifier" IS NOT NULL AND NEW."rcIdentifier" IS DISTINCT FROM OLD."rcIdentifier" THEN RAISE EXCEPTION 'Reserved RC identifier is immutable'; END IF;
 IF NEW."payload" IS DISTINCT FROM OLD."payload" OR NEW."snapshotSha256" IS DISTINCT FROM OLD."snapshotSha256" OR NEW."eventId" IS DISTINCT FROM OLD."eventId" THEN RAISE EXCEPTION 'Notes owner binding is immutable'; END IF;
 IF OLD."phase" IN ('SENDING','POLLING','UNKNOWN','DONE') AND NEW."phase" IN ('AWAITING_AUTHORIZATION','PREPARING','PREPARED','SENDING') AND NEW."phase" IS DISTINCT FROM OLD."phase" THEN RAISE EXCEPTION 'A started RC submission cannot be reposted'; END IF;
 IF NEW."phase"='POLLING' AND (NEW."rcIdentifier" IS NULL OR NEW."manifest"->'rc'->>'identifier' IS DISTINCT FROM NEW."rcIdentifier" OR NOT EXISTS(SELECT 1 FROM "ProductionNotesRcTicket" t WHERE t."documentId"=NEW."documentId" AND t."requestSha256"=NEW."manifest"->'zip'->>'sha256')) THEN RAISE EXCEPTION 'Polling requires the exact durable RC ticket'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ProductionNotesDispatch_rc_binding" BEFORE UPDATE ON "ProductionNotesDispatch" FOR EACH ROW EXECUTE FUNCTION production_notes_rc_dispatch_binding();
COMMIT;
