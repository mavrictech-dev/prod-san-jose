-- Explicit candidate installation in a NEW dedicated database only. No application migration.
BEGIN;
CREATE TABLE "B2bEmailDeliverySandbox" (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version text NOT NULL CHECK(version='factuez.b2b.email-deliveries.v1')
);
INSERT INTO "B2bEmailDeliverySandbox" VALUES(true,'factuez.b2b.email-deliveries.v1');
CREATE TABLE "B2bEmailDeliveryJob" (
  id uuid PRIMARY KEY, actor_key text NOT NULL CHECK(length(actor_key)<=200),
  key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('QUEUED','WAITING_ARTIFACTS','DISPATCHING','CAPTURED_LOCAL','UNKNOWN')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  UNIQUE(actor_key,key_hash),
  CHECK(payload->>'id'=id::text AND payload->>'actorKey'=actor_key AND payload->>'keyHash'=key_hash
    AND (payload->>'revision')::integer=revision AND payload->>'state'=state),
  CHECK(payload->'binding'->>'environment'='BETA' AND payload->>'profile' IN ('NONE','LOCAL_CAPTURE')),
  CHECK(NOT payload ?| ARRAY['token','bearer','authorization','credentials','password']),
  CHECK(payload->'actor'->>'kind' IN ('USER','SERVICE') AND
    (CASE WHEN payload->'actor'->>'kind'='SERVICE' THEN
      payload->'actor'->'subjectId'='null'::jsonb AND payload->'actor'->'userAuthRevision'='null'::jsonb
    ELSE jsonb_typeof(payload->'actor'->'subjectId')='string'
      AND jsonb_typeof(payload->'actor'->'userAuthRevision')='number' END))
);
CREATE TABLE "B2bEmailDeliveryEvent" (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES "B2bEmailDeliveryJob"(id),
  revision integer NOT NULL, event_type text NOT NULL CHECK(event_type IN ('CREATED','WAITING_ARTIFACTS','ATTEMPT_STARTED','CAPTURED_LOCAL','UNKNOWN')),
  attempt_id uuid, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=2048),
  UNIQUE(job_id,revision),
  CHECK(payload->>'id'=id::text AND payload->>'jobId'=job_id::text AND (payload->>'revision')::integer=revision
    AND payload->>'type'=event_type AND payload->>'attemptId' IS NOT DISTINCT FROM attempt_id::text),
  CHECK(NOT payload ?| ARRAY['token','bearer','authorization','recipient','credentials'])
);
CREATE UNIQUE INDEX "B2bEmailDelivery_one_attempt" ON "B2bEmailDeliveryEvent"(job_id) WHERE event_type='ATTEMPT_STARTED';
CREATE FUNCTION b2b_email_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='B2bEmailDeliveryEvent' THEN RAISE EXCEPTION 'EMAIL_IMMUTABLE'; END IF;
  IF (NEW.payload - ARRAY['state','revision','updatedAt','attemptId','errorCode','attachments']) IS DISTINCT FROM
     (OLD.payload - ARRAY['state','revision','updatedAt','attemptId','errorCode','attachments'])
     OR NEW.revision<>OLD.revision+1 OR NEW.id<>OLD.id OR NEW.actor_key<>OLD.actor_key OR NEW.key_hash<>OLD.key_hash
     OR OLD.state IN ('UNKNOWN','CAPTURED_LOCAL')
     OR NOT ((OLD.state IN ('QUEUED','WAITING_ARTIFACTS') AND NEW.state IN ('WAITING_ARTIFACTS','DISPATCHING'))
       OR (OLD.state='DISPATCHING' AND NEW.state IN ('UNKNOWN','CAPTURED_LOCAL')))
     OR (OLD.state='DISPATCHING' AND (NEW.payload->'attachments' IS DISTINCT FROM OLD.payload->'attachments'
       OR NEW.payload->'attemptId' IS DISTINCT FROM OLD.payload->'attemptId'))
     THEN RAISE EXCEPTION 'EMAIL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b2b_email_job_immutable BEFORE UPDATE OR DELETE ON "B2bEmailDeliveryJob" FOR EACH ROW EXECUTE FUNCTION b2b_email_immutable();
CREATE TRIGGER b2b_email_event_immutable BEFORE UPDATE OR DELETE ON "B2bEmailDeliveryEvent" FOR EACH ROW EXECUTE FUNCTION b2b_email_immutable();
-- Deferred consistency makes job state and append-only audit an atomic unit.
CREATE FUNCTION b2b_email_audit_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "B2bEmailDeliveryEvent" e WHERE e.job_id=NEW.id AND e.revision=NEW.revision
    AND e.payload->'actor'=NEW.payload->'actor' AND
    e.event_type=CASE WHEN NEW.revision=1 THEN 'CREATED' WHEN NEW.state='DISPATCHING' THEN 'ATTEMPT_STARTED' ELSE NEW.state END)
  THEN RAISE EXCEPTION 'EMAIL_AUDIT_REQUIRED'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b2b_email_job_audit AFTER INSERT OR UPDATE ON "B2bEmailDeliveryJob"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_email_audit_required();
REVOKE ALL ON "B2bEmailDeliverySandbox","B2bEmailDeliveryJob","B2bEmailDeliveryEvent" FROM PUBLIC;
COMMIT;

