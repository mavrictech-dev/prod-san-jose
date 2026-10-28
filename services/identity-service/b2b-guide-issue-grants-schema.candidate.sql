-- CANDIDATE ONLY. Apply only in an explicitly authorized isolated rehearsal.
-- Independent Identity-owned grant history; no Billing allocation, defaults or runtime hook.
-- Closed 09/31 LOCAL/BETA profiles. Each complete pair is separately enrolled;
-- Billing validates the matching T/V mapping, never an implicit shared grant.
BEGIN;
CREATE FUNCTION "b2b_guide_issue_bindings_valid"(items jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE pair jsonb; draft jsonb; anchor jsonb; item_key text; seen jsonb := '[]'::jsonb;
  uuid_pattern text := '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(items)>500 OR octet_length(items::text)>1048576 THEN RETURN false; END IF;
  FOR pair IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF jsonb_typeof(pair) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(pair) key) IS DISTINCT FROM ARRAY['draft','fiscalSeriesId'] THEN RETURN false; END IF;
    draft := pair->'draft'; anchor := draft->'anchor';
    IF jsonb_typeof(draft) IS DISTINCT FROM 'object' OR jsonb_typeof(anchor) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(draft) key) IS DISTINCT FROM ARRAY['anchor','guideSeriesId','guideType'] OR
      (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(anchor) key) IS DISTINCT FROM ARRAY['branchId','documentType','environment','issuerId','issuerRuc','pointId','seriesId'] THEN RETURN false; END IF;
    IF (jsonb_typeof(anchor->'issuerId')='number' AND (anchor->>'issuerId') ~ '^[1-9][0-9]*$' AND
      (anchor->>'issuerId')::numeric<=2147483647 AND anchor->>'environment'='BETA' AND
      jsonb_typeof(anchor->'issuerRuc')='string' AND anchor->>'issuerRuc' ~ '^[0-9]{11}$' AND
      jsonb_typeof(anchor->'documentType')='string' AND anchor->>'documentType' IN ('01','03') AND
      jsonb_typeof(draft->'guideType')='string' AND draft->>'guideType' IN ('09','31')) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    FOREACH item_key IN ARRAY ARRAY['branchId','pointId','seriesId'] LOOP
      IF (jsonb_typeof(anchor->item_key)='string' AND anchor->>item_key ~ uuid_pattern) IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    END LOOP;
    IF (jsonb_typeof(draft->'guideSeriesId')='string' AND draft->>'guideSeriesId' ~ uuid_pattern AND
      jsonb_typeof(pair->'fiscalSeriesId')='string' AND pair->>'fiscalSeriesId' ~ uuid_pattern AND
      anchor->>'seriesId'<>draft->>'guideSeriesId' AND anchor->>'seriesId'<>pair->>'fiscalSeriesId' AND
      draft->>'guideSeriesId'<>pair->>'fiscalSeriesId') IS DISTINCT FROM TRUE THEN RETURN false; END IF;
    IF seen @> jsonb_build_array(pair) THEN RETURN false; END IF;
    seen := seen || jsonb_build_array(pair);
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
CREATE TABLE "B2bGuideIssueGrantRevision" (
  "clientId" uuid NOT NULL REFERENCES "B2bClient"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  "clientRevision" integer NOT NULL CHECK ("clientRevision">0),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "bindings" jsonb NOT NULL CHECK ("b2b_guide_issue_bindings_valid"("bindings")),
  "actorId" uuid NOT NULL, "at" timestamptz NOT NULL,
  PRIMARY KEY ("clientId","revision")
);
CREATE TABLE "B2bGuideIssueGrantHead" (
  "clientId" uuid PRIMARY KEY REFERENCES "B2bClient"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  FOREIGN KEY ("clientId","revision") REFERENCES "B2bGuideIssueGrantRevision"("clientId","revision") ON DELETE RESTRICT
);
CREATE FUNCTION "b2b_guide_issue_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GUIDE_ISSUE_HISTORY_IMMUTABLE'; END; $$;
CREATE TRIGGER "b2b_guide_issue_revision_immutable" BEFORE UPDATE OR DELETE ON "B2bGuideIssueGrantRevision"
  FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_immutable"();
CREATE TRIGGER "b2b_guide_issue_revision_no_truncate" BEFORE TRUNCATE ON "B2bGuideIssueGrantRevision"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_guide_issue_immutable"();
CREATE TRIGGER "b2b_guide_issue_head_no_truncate" BEFORE TRUNCATE ON "B2bGuideIssueGrantHead"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_guide_issue_immutable"();
CREATE FUNCTION "b2b_guide_issue_head_monotonic"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_ISSUE_HEAD_IMMUTABLE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>1 THEN RAISE EXCEPTION 'GUIDE_ISSUE_HEAD_CAS_REQUIRED'; END IF;
  ELSIF NEW."clientId"<>OLD."clientId" OR NEW."revision"<>OLD."revision"+1 THEN RAISE EXCEPTION 'GUIDE_ISSUE_HEAD_CAS_REQUIRED'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "b2b_guide_issue_head_monotonic" BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideIssueGrantHead"
  FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_head_monotonic"();
CREATE FUNCTION "b2b_guide_issue_revision_scoped"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE client "B2bClient"%ROWTYPE; pair jsonb; previous integer;
BEGIN
  SELECT * INTO client FROM "B2bClient" WHERE "id"=NEW."clientId" AND "environment"='BETA' FOR UPDATE;
  IF NOT FOUND OR NOT client."enabled" OR client."revision"<>NEW."clientRevision" THEN RAISE EXCEPTION 'GUIDE_ISSUE_CLIENT_REVISION_REQUIRED'; END IF;
  SELECT max("revision") INTO previous FROM "B2bGuideIssueGrantRevision" WHERE "clientId"=NEW."clientId";
  IF NEW."revision"::bigint<>coalesce(previous,0)::bigint+1 THEN RAISE EXCEPTION 'GUIDE_ISSUE_REVISION_CAS_REQUIRED'; END IF;
  IF jsonb_array_length(NEW."bindings")>0 THEN
    IF NOT (client."scopes" @> '["b2b:documents:read","b2b:guides:issue"]'::jsonb OR
      client."scopes" @> '["b2b:documents:read","b2b:guides:read","b2b:guide-operations:read"]'::jsonb)
    THEN RAISE EXCEPTION 'GUIDE_ISSUE_SCOPE_REQUIRED'; END IF;
    FOR pair IN SELECT value FROM jsonb_array_elements(NEW."bindings") LOOP
      IF NOT client."bindings" @> jsonb_build_array(pair->'draft'->'anchor') THEN RAISE EXCEPTION 'GUIDE_ISSUE_ANCHOR_REQUIRED'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "b2b_guide_issue_revision_scoped" BEFORE INSERT ON "B2bGuideIssueGrantRevision"
  FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_revision_scoped"();
CREATE FUNCTION "b2b_guide_issue_head_complete"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head integer; last_revision integer; total bigint;
BEGIN
  SELECT "revision" INTO head FROM "B2bGuideIssueGrantHead" WHERE "clientId"=NEW."clientId";
  SELECT max("revision"),count(*) INTO last_revision,total FROM "B2bGuideIssueGrantRevision" WHERE "clientId"=NEW."clientId";
  IF head IS NULL OR head<>last_revision OR head<>total THEN RAISE EXCEPTION 'GUIDE_ISSUE_HEAD_INCOMPLETE'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "b2b_guide_issue_revision_complete" AFTER INSERT ON "B2bGuideIssueGrantRevision"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_head_complete"();
CREATE CONSTRAINT TRIGGER "b2b_guide_issue_head_complete" AFTER INSERT OR UPDATE ON "B2bGuideIssueGrantHead"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_head_complete"();
CREATE FUNCTION "b2b_guide_issue_audit_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."action" IN ('REPLACE_GUIDE_ISSUE_GRANTS','READ_GUIDE_ISSUE_GRANTS','AUTHORIZE_GUIDE_ISSUE_ISSUE','AUTHORIZE_GUIDE_ISSUE_READ') OR
    (TG_OP='UPDATE' AND NEW."action" IN ('REPLACE_GUIDE_ISSUE_GRANTS','READ_GUIDE_ISSUE_GRANTS','AUTHORIZE_GUIDE_ISSUE_ISSUE','AUTHORIZE_GUIDE_ISSUE_READ')) THEN
    RAISE EXCEPTION 'GUIDE_ISSUE_AUDIT_IMMUTABLE';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "b2b_guide_issue_audit_immutable" BEFORE UPDATE OR DELETE ON "B2bAudit"
  FOR EACH ROW EXECUTE FUNCTION "b2b_guide_issue_audit_immutable"();
CREATE TRIGGER "b2b_guide_issue_audit_no_truncate" BEFORE TRUNCATE ON "B2bAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION "b2b_guide_issue_immutable"();
COMMIT;
