-- Opt-in candidate. NEW rehearsal DB only in this delivery. No automatic DDL.
-- Only rendered report bytes; preserves jobs, captures, keys and fiscal tables.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid='"B2bP8ReportJob"'::regclass AND conname='B2bP8ReportJob_check') IS DISTINCT FROM
 $expected$CHECK ((((state = 'QUEUED'::text) AND (revision = 1) AND (content_bytes IS NULL)) OR ((state = 'READY'::text) AND (revision = 2) AND ((octet_length(content_bytes) >= 1) AND (octet_length(content_bytes) <= 25165824)) AND (content_bytes IS NOT NULL))))$expected$
 THEN RAISE EXCEPTION 'REPORT_RETENTION_SCHEMA_REVIEW_REQUIRED' USING ERRCODE='55000'; END IF;
END; $$;
ALTER TABLE "B2bP8ReportJob" ADD COLUMN content_purged_at timestamptz;
ALTER TABLE "B2bP8ReportJob" DROP CONSTRAINT "B2bP8ReportJob_check";
ALTER TABLE "B2bP8ReportJob" ADD CONSTRAINT report_content_availability CHECK ((
 (state='QUEUED' AND revision=1 AND content_bytes IS NULL AND content_purged_at IS NULL AND NOT payload ? 'contentPurgedAt') OR
 (state='READY' AND revision=2 AND (
   (content_purged_at IS NULL AND NOT payload ? 'contentPurgedAt' AND content_bytes IS NOT NULL AND octet_length(content_bytes) BETWEEN 1 AND 25165824) OR
   (content_purged_at IS NOT NULL AND content_bytes IS NULL AND jsonb_typeof(payload->'contentPurgedAt')='string'
    AND payload->>'contentPurgedAt'=to_char(content_purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
 ))
) IS TRUE);
CREATE TABLE "B2bReportRetentionRun" (
 plan_id uuid PRIMARY KEY,policy_id uuid NOT NULL,policy_revision integer NOT NULL CHECK(policy_revision>0),
 policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),plan_sha256 text NOT NULL CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 issuer_ids integer[] NOT NULL CHECK(cardinality(issuer_ids) BETWEEN 1 AND 100 AND 0<ALL(issuer_ids) AND array_position(issuer_ids,NULL) IS NULL),
 environment text NOT NULL CHECK(environment='BETA'),profile text NOT NULL CHECK(profile='REPORT_RENDERED_CONTENT_ONLY'),
 cutoff timestamptz NOT NULL,completed_at timestamptz NOT NULL,min_age_hours integer NOT NULL CHECK(min_age_hours BETWEEN 24 AND 87600),
 insert_txid bigint NOT NULL DEFAULT txid_current(),
 purged_rows integer NOT NULL CHECK(purged_rows BETWEEN 0 AND 100),purged_bytes bigint NOT NULL CHECK(purged_bytes BETWEEN 0 AND 268435456),
 CHECK((purged_rows=0)=(purged_bytes=0)),CHECK(cutoff<=completed_at-min_age_hours*interval '1 hour')
);
CREATE TABLE "B2bReportContentPurgeAudit" (
 job_id uuid PRIMARY KEY REFERENCES "B2bP8ReportJob"(id),plan_id uuid NOT NULL REFERENCES "B2bReportRetentionRun"(plan_id),
 purged_at timestamptz NOT NULL,job_revision integer NOT NULL CHECK(job_revision=2),job_created_at timestamptz NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 25165824),
 content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),capture_sha256 text NOT NULL CHECK(capture_sha256 ~ '^[a-f0-9]{64}$')
);
REVOKE ALL ON "B2bReportRetentionRun","B2bReportContentPurgeAudit" FROM PUBLIC;
CREATE FUNCTION b2b_report_retention_audit_current() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "B2bReportRetentionRun" WHERE plan_id=NEW.plan_id AND insert_txid=txid_current())
 THEN RAISE EXCEPTION 'REPORT_RETENTION_RUN_SEALED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER report_retention_audit_current BEFORE INSERT ON "B2bReportContentPurgeAudit"
 FOR EACH ROW EXECUTE FUNCTION b2b_report_retention_audit_current();
CREATE FUNCTION b2b_report_retention_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'REPORT_RETENTION_IMMUTABLE' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER report_retention_run_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReportRetentionRun"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_report_retention_immutable();
CREATE TRIGGER report_retention_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReportContentPurgeAudit"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_report_retention_immutable();
CREATE TRIGGER report_retention_job_preserved BEFORE DELETE OR TRUNCATE ON "B2bP8ReportJob"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_report_retention_immutable();
CREATE FUNCTION b2b_report_retention_job_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.content_purged_at IS NOT NULL OR NEW.payload ? 'contentPurgedAt' THEN RAISE EXCEPTION 'REPORT_PURGE_NOT_AN_INSERT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.content_purged_at IS NOT NULL THEN RAISE EXCEPTION 'REPORT_TOMBSTONE_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NEW.content_purged_at IS NULL THEN
  IF OLD.state<>'QUEUED' OR NEW.state<>'READY' OR NEW.id<>OLD.id OR NEW.owner_key<>OLD.owner_key OR NEW.key_hash<>OLD.key_hash OR NEW.request_hash<>OLD.request_hash
   OR (NEW.payload-ARRAY['state','revision','content']) IS DISTINCT FROM (OLD.payload-ARRAY['state','revision','content'])
  THEN RAISE EXCEPTION 'REPORT_READY_FACTS_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.state<>'READY' OR OLD.revision<>2 OR NEW.id<>OLD.id OR NEW.owner_key<>OLD.owner_key OR NEW.key_hash<>OLD.key_hash OR NEW.request_hash<>OLD.request_hash
  OR NEW.state<>OLD.state OR NEW.revision<>OLD.revision OR (NEW.payload-'contentPurgedAt') IS DISTINCT FROM OLD.payload OR NEW.content_bytes IS NOT NULL
  OR NOT EXISTS (
   SELECT 1 FROM "B2bReportContentPurgeAudit" a JOIN "B2bReportRetentionRun" r ON r.plan_id=a.plan_id
   WHERE a.job_id=OLD.id AND a.purged_at=NEW.content_purged_at AND a.job_revision=OLD.revision
    AND a.job_created_at=(OLD.payload->>'createdAt')::timestamptz AND a.job_created_at<=r.cutoff AND a.purged_at=r.completed_at
    AND (OLD.payload#>>'{capture,filters,issuerId}')::integer=ANY(r.issuer_ids)
    AND a.byte_length=octet_length(OLD.content_bytes) AND a.content_sha256=encode(sha256(OLD.content_bytes),'hex')
    AND a.content_sha256=OLD.payload#>>'{content,sha256}' AND a.capture_sha256=OLD.payload#>>'{capture,sha256}'
  )
 THEN RAISE EXCEPTION 'REPORT_PURGE_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER report_retention_job_transition BEFORE INSERT OR UPDATE ON "B2bP8ReportJob"
 FOR EACH ROW EXECUTE FUNCTION b2b_report_retention_job_transition();
CREATE FUNCTION b2b_report_retention_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='B2bReportContentPurgeAudit' THEN
  IF NOT EXISTS(SELECT 1 FROM "B2bP8ReportJob" j WHERE j.id=NEW.job_id AND j.content_purged_at=NEW.purged_at AND j.content_bytes IS NULL)
   THEN RAISE EXCEPTION 'REPORT_PURGE_NOT_COMPLETED' USING ERRCODE='23514'; END IF;
 ELSE
  IF (SELECT count(*) FROM "B2bReportContentPurgeAudit" WHERE plan_id=NEW.plan_id)<>NEW.purged_rows
   OR (SELECT coalesce(sum(byte_length),0) FROM "B2bReportContentPurgeAudit" WHERE plan_id=NEW.plan_id)<>NEW.purged_bytes
   THEN RAISE EXCEPTION 'REPORT_RETENTION_RUN_NOT_COMPLETED' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER report_retention_audit_complete AFTER INSERT ON "B2bReportContentPurgeAudit"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_report_retention_complete();
CREATE CONSTRAINT TRIGGER report_retention_run_complete AFTER INSERT ON "B2bReportRetentionRun"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_report_retention_complete();
COMMIT;
