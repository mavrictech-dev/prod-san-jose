-- Candidate READ policy only. No production/QA install or scope activation.
CREATE FUNCTION factuez_report_read_canonical(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;BEGIN
 IF jsonb_typeof(p)='object' THEN SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||factuez_report_read_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p);
 ELSIF jsonb_typeof(p)='array' THEN SELECT '['||coalesce(string_agg(factuez_report_read_canonical(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS a(value,ordinal);
 ELSE result=p::text;END IF;RETURN result;END;$$;
CREATE FUNCTION factuez_report_read_hash(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT encode(sha256(convert_to(factuez_report_read_canonical(p),'UTF8')),'hex');$$;
CREATE TABLE "B2bReportsCorrectionReadGrant" (
 "id" uuid PRIMARY KEY,"grantKey" text NOT NULL UNIQUE CHECK("grantKey" ~ '^[a-f0-9]{64}$'),
 "revision" integer NOT NULL CHECK("revision">0),"payload" jsonb NOT NULL,
 CHECK((jsonb_typeof("payload")='object' AND "payload" ?& ARRAY['binding','subject','clientRevision','userAuthRevision','active','revision']
  AND "payload"-ARRAY['binding','subject','clientRevision','userAuthRevision','active','revision']='{}'::jsonb
  AND "payload"->>'revision'="revision"::text AND jsonb_typeof("payload"->'active')='boolean'
  AND "payload"->'binding'->'reference'->>'environment'='BETA' AND "payload"->'binding'->>'noteType' IN ('07','08')
  AND "payload"->'binding'->'reference'->>'issuerRuc' ~ '^[0-9]{11}$'
  AND "grantKey"=factuez_report_read_hash("payload"-ARRAY['active','revision'])) IS TRUE)
);
CREATE TABLE "B2bReportsCorrectionReadAudit" (
 "grantId" uuid NOT NULL REFERENCES "B2bReportsCorrectionReadGrant"("id"),"revision" integer NOT NULL CHECK("revision">0),
 "adminId" uuid NOT NULL,"authRevision" integer NOT NULL CHECK("authRevision">=0),"policySha256" text NOT NULL CHECK("policySha256" ~ '^[a-f0-9]{64}$'),
 "requestSha256" text NOT NULL CHECK("requestSha256" ~ '^[a-f0-9]{64}$'),"createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("grantId","revision")
);
CREATE FUNCTION factuez_report_read_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'REPORT_READ_AUDIT_IMMUTABLE' USING ERRCODE='23514';END;$$;
CREATE TRIGGER report_read_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReportsCorrectionReadAudit" FOR EACH STATEMENT EXECUTE FUNCTION factuez_report_read_immutable();
CREATE FUNCTION factuez_report_read_cas() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'UPDATE' OR NEW."id"<>OLD."id" OR NEW."grantKey"<>OLD."grantKey" OR NEW."revision"<>OLD."revision"+1
 OR NEW."payload"-ARRAY['active','revision'] IS DISTINCT FROM OLD."payload"-ARRAY['active','revision'] THEN
  RAISE EXCEPTION 'REPORT_READ_POLICY_CAS_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;END;$$;
CREATE TRIGGER report_read_policy_cas BEFORE UPDATE OR DELETE ON "B2bReportsCorrectionReadGrant" FOR EACH ROW EXECUTE FUNCTION factuez_report_read_cas();
CREATE TRIGGER report_read_policy_no_truncate BEFORE TRUNCATE ON "B2bReportsCorrectionReadGrant" FOR EACH STATEMENT EXECUTE FUNCTION factuez_report_read_immutable();
CREATE FUNCTION factuez_report_read_audited() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM "B2bReportsCorrectionReadAudit" a WHERE a."grantId"=NEW."id" AND a."revision"=NEW."revision"
  AND a."policySha256"=factuez_report_read_hash(NEW."payload")
  AND a."requestSha256"=factuez_report_read_hash(jsonb_build_object('policy',NEW."payload"-'revision','expectedRevision',NEW."revision"-1))) THEN
  RAISE EXCEPTION 'REPORT_READ_POLICY_AUDIT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NULL;END;$$;
CREATE CONSTRAINT TRIGGER report_read_policy_audited AFTER INSERT OR UPDATE ON "B2bReportsCorrectionReadGrant" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_report_read_audited();
