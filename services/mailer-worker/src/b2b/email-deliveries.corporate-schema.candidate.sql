-- Separate candidate only: do not install on current DB or run from the application.
-- Leaves the existing NONE/LOCAL_CAPTURE sandbox constraints and tables untouched.
BEGIN;
CREATE TABLE "B2bCorporateEmailDeliverySandbox" (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  version text NOT NULL CHECK(version='factuez.b2b.email-deliveries.corporate.v1')
);
INSERT INTO "B2bCorporateEmailDeliverySandbox" VALUES(true,'factuez.b2b.email-deliveries.corporate.v1');
CREATE TABLE "B2bCorporateEmailDeliveryJob" (
  id uuid PRIMARY KEY, actor_key text NOT NULL CHECK(length(actor_key)<=200),
  key_hash text NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('QUEUED','WAITING_ARTIFACTS','DISPATCHING','SMTP_ACCEPTED','UNKNOWN')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  UNIQUE(actor_key,key_hash),
  CHECK(payload->>'id'=id::text AND payload->>'actorKey'=actor_key AND payload->>'keyHash'=key_hash
    AND (payload->>'revision')::integer=revision AND payload->>'state'=state),
  CHECK(payload->'binding'->>'environment'='BETA' AND payload->>'profile'='CORPORATE'),
  CHECK(payload ? 'corporate' AND jsonb_typeof(payload->'corporate')='object'),
  CHECK((payload->'corporate') ?& ARRAY['grantId','grantRevision','configurationRevision','configurationSnapshotId','messageId']
    AND NOT jsonb_path_exists(payload->'corporate', '$.* ? (@ == null)')),
  CHECK((payload->'corporate'->>'grantId')::uuid IS NOT NULL
    AND (payload->'corporate'->>'grantRevision')::integer>0
    AND (payload->'corporate'->>'configurationRevision')::integer>0
    AND payload->'corporate'->>'configurationSnapshotId' ~ '^[a-f0-9]{64}$'
    AND payload->'corporate'->>'messageId'='<factuez-b2b-'||id::text||'@delivery.factuez.invalid>'),
  CHECK(NOT payload ?| ARRAY['token','bearer','authorization','credentials','password']),
  CHECK(NOT (payload->'corporate') ?| ARRAY['token','bearer','authorization','credentials','password','configuration']),
  CHECK(payload->'actor'->>'kind' IN ('USER','SERVICE') AND
    (CASE WHEN payload->'actor'->>'kind'='SERVICE' THEN
      payload->'actor'->'subjectId'='null'::jsonb AND payload->'actor'->'userAuthRevision'='null'::jsonb
    ELSE jsonb_typeof(payload->'actor'->'subjectId')='string'
      AND jsonb_typeof(payload->'actor'->'userAuthRevision')='number' END))
);
CREATE TABLE "B2bCorporateEmailDeliveryEvent" (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES "B2bCorporateEmailDeliveryJob"(id),
  revision integer NOT NULL, event_type text NOT NULL CHECK(event_type IN ('CREATED','WAITING_ARTIFACTS','ATTEMPT_STARTED','SMTP_ACCEPTED','UNKNOWN')),
  attempt_id uuid, payload jsonb NOT NULL CHECK(octet_length(payload::text)<=2048),
  UNIQUE(job_id,revision),
  CHECK(payload->>'id'=id::text AND payload->>'jobId'=job_id::text AND (payload->>'revision')::integer=revision
    AND payload->>'type'=event_type AND payload->>'attemptId' IS NOT DISTINCT FROM attempt_id::text),
  CHECK(NOT payload ?| ARRAY['token','bearer','authorization','recipient','credentials'])
);
CREATE UNIQUE INDEX "B2bCorporateEmailDelivery_one_attempt" ON "B2bCorporateEmailDeliveryEvent"(job_id) WHERE event_type='ATTEMPT_STARTED';
CREATE FUNCTION b2b_corporate_email_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR TG_TABLE_NAME='B2bCorporateEmailDeliveryEvent' THEN RAISE EXCEPTION 'EMAIL_IMMUTABLE'; END IF;
  IF (NEW.payload - ARRAY['state','revision','updatedAt','attemptId','errorCode','attachments']) IS DISTINCT FROM
     (OLD.payload - ARRAY['state','revision','updatedAt','attemptId','errorCode','attachments'])
     OR NEW.revision<>OLD.revision+1 OR NEW.id<>OLD.id OR NEW.actor_key<>OLD.actor_key OR NEW.key_hash<>OLD.key_hash
     OR OLD.state IN ('UNKNOWN','SMTP_ACCEPTED')
     OR NOT ((OLD.state IN ('QUEUED','WAITING_ARTIFACTS') AND NEW.state IN ('WAITING_ARTIFACTS','DISPATCHING'))
       OR (OLD.state='DISPATCHING' AND NEW.state IN ('UNKNOWN','SMTP_ACCEPTED')))
     OR (OLD.state='DISPATCHING' AND (NEW.payload->'attachments' IS DISTINCT FROM OLD.payload->'attachments'
       OR NEW.payload->'attemptId' IS DISTINCT FROM OLD.payload->'attemptId'))
     THEN RAISE EXCEPTION 'EMAIL_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER b2b_corporate_email_job_immutable BEFORE UPDATE OR DELETE ON "B2bCorporateEmailDeliveryJob" FOR EACH ROW EXECUTE FUNCTION b2b_corporate_email_immutable();
CREATE TRIGGER b2b_corporate_email_event_immutable BEFORE UPDATE OR DELETE ON "B2bCorporateEmailDeliveryEvent" FOR EACH ROW EXECUTE FUNCTION b2b_corporate_email_immutable();
CREATE FUNCTION b2b_corporate_email_audit_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "B2bCorporateEmailDeliveryEvent" e WHERE e.job_id=NEW.id AND e.revision=NEW.revision
    AND e.payload->'actor'=NEW.payload->'actor' AND
    e.event_type=CASE WHEN NEW.revision=1 THEN 'CREATED' WHEN NEW.state='DISPATCHING' THEN 'ATTEMPT_STARTED' ELSE NEW.state END)
  THEN RAISE EXCEPTION 'EMAIL_AUDIT_REQUIRED'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b2b_corporate_email_job_audit AFTER INSERT OR UPDATE ON "B2bCorporateEmailDeliveryJob"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_corporate_email_audit_required();
REVOKE ALL ON "B2bCorporateEmailDeliverySandbox","B2bCorporateEmailDeliveryJob","B2bCorporateEmailDeliveryEvent" FROM PUBLIC;
COMMIT;
