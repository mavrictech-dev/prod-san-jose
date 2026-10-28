-- LOCAL CANDIDATE ONLY. Not a migration; never applied at startup.
-- Requires the existing synthetic masters and b2b-guide-drafts candidate DDL.
-- No legacy Document/OutboxEvent, dispatch, XML or transport writes are added.
CREATE TABLE "B2bGuideIssueSeries" (
 "draftSeriesId" uuid PRIMARY KEY REFERENCES "B2bGuideDraftSeries"("id") ON DELETE RESTRICT,
 "fiscalSeriesId" uuid NOT NULL UNIQUE,
 "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
 "revision" integer NOT NULL DEFAULT 1 CHECK ("revision">0),
 "active" boolean NOT NULL DEFAULT true,
 "purpose" text NOT NULL DEFAULT 'LOCAL_CANDIDATE' CHECK ("purpose"='LOCAL_CANDIDATE'),
 FOREIGN KEY ("fiscalSeriesId","companyId") REFERENCES "SeriesCounter"("id","companyId") ON DELETE RESTRICT,
 UNIQUE ("draftSeriesId","fiscalSeriesId","companyId")
);
CREATE TABLE "B2bGuideIssueDocument" (
 "id" uuid PRIMARY KEY,"operationId" uuid NOT NULL UNIQUE,
 "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
 "issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
 "type" text NOT NULL CHECK ("type"='09'),
 "draftSeriesId" uuid NOT NULL,"fiscalSeriesId" uuid NOT NULL,
 "draftId" uuid NOT NULL UNIQUE REFERENCES "B2bGuideDraft"("id") ON DELETE RESTRICT,
 "draftRevision" integer NOT NULL CHECK ("draftRevision" BETWEEN 1 AND 999999999),
 "clientId" uuid NOT NULL,"actorKey" text NOT NULL,
 "binding" jsonb NOT NULL,"series" text NOT NULL CHECK ("series" ~ '^T[A-Z0-9]{3}$'),
 "number" bigint NOT NULL CHECK ("number" BETWEEN 1 AND 99999999),
 "fullNumber" text NOT NULL CHECK ("fullNumber"="series"||'-'||"number"::text),
 "itemCount" integer NOT NULL CHECK ("itemCount" BETWEEN 1 AND 100),
 "snapshot" jsonb NOT NULL,"snapshotSha256" text NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY ("draftSeriesId","fiscalSeriesId","companyId") REFERENCES "B2bGuideIssueSeries"("draftSeriesId","fiscalSeriesId","companyId") ON DELETE RESTRICT,
 UNIQUE ("issuerRuc","type","series","number"),
 UNIQUE ("id","operationId"),
 UNIQUE ("id","operationId","clientId","actorKey"),
 CHECK ((jsonb_typeof("binding")='object' AND jsonb_typeof("snapshot")='object'
   AND "binding"->'draft'->'anchor'->>'environment'='BETA'
   AND "binding"->'draft'->>'guideType'='09'
   AND "binding"->'draft'->>'guideSeriesId'="draftSeriesId"::text
   AND "binding"->>'fiscalSeriesId'="fiscalSeriesId"::text
   AND "binding"->'draft'->'anchor'->>'issuerId'="companyId"::text
   AND "binding"->'draft'->'anchor'->>'issuerRuc'="issuerRuc"
   AND "snapshot"->>'schemaVersion'='factuez.guide-issued-local.v1'
   AND "snapshot"->>'documentId'="id"::text AND "snapshot"->>'operationId'="operationId"::text
   AND "snapshot"->>'draftId'="draftId"::text AND "snapshot"->>'draftRevision'="draftRevision"::text
   AND "snapshot"->'binding'="binding" AND "snapshot"->'issuer'->>'ruc'="issuerRuc"
   AND jsonb_typeof("snapshot"->'series')='string' AND jsonb_typeof("snapshot"->'number')='string'
   AND "snapshot"->>'series'="series" AND "snapshot"->>'number'="number"::text
   AND "snapshot"->>'fullNumber'="fullNumber"
   AND jsonb_typeof("snapshot"->'body'->'items')='array'
   AND jsonb_array_length("snapshot"->'body'->'items')="itemCount"
   AND "snapshot"->'candidateOnly'='true'::jsonb AND "snapshot"->'numberReserved'='true'::jsonb
   AND "snapshot"->'fiscalExecutionEnabled'='false'::jsonb AND "snapshot"->'transmissionAuthorized'='false'::jsonb
   AND "snapshot"->'authorizedForTransfer'='false'::jsonb AND "snapshot"->'officialRulesValidated'='false'::jsonb
   AND "snapshot"->'officialCdrVerified'='false'::jsonb) IS TRUE)
);
CREATE INDEX "B2bGuideIssueOwner" ON "B2bGuideIssueDocument" ("companyId","issuerRuc","clientId","actorKey","draftId");
CREATE TABLE "B2bGuideIssueItem" (
 "documentId" uuid NOT NULL REFERENCES "B2bGuideIssueDocument"("id") ON DELETE RESTRICT,
 "position" integer NOT NULL CHECK ("position" BETWEEN 1 AND 100),
 "payload" jsonb NOT NULL CHECK (jsonb_typeof("payload")='object'),
 PRIMARY KEY ("documentId","position")
);
CREATE TABLE "B2bGuideIssueReceipt" (
 "id" uuid PRIMARY KEY,"documentId" uuid NOT NULL UNIQUE,
 "clientId" uuid NOT NULL,"actorKey" text NOT NULL,
 "keySha256" text NOT NULL CHECK ("keySha256" ~ '^[a-f0-9]{64}$'),
 "requestSha256" text NOT NULL CHECK ("requestSha256" ~ '^[a-f0-9]{64}$'),
 "payload" jsonb NOT NULL,
 UNIQUE ("clientId","actorKey","keySha256"),
 FOREIGN KEY ("documentId","id","clientId","actorKey") REFERENCES "B2bGuideIssueDocument"("id","operationId","clientId","actorKey") ON DELETE RESTRICT,
 CHECK ((jsonb_typeof("payload")='object' AND "payload"->>'id'="id"::text
   AND "payload"->>'clientId'="clientId"::text AND "payload"->>'actorKey'="actorKey"
   AND "payload"->>'keySha256'="keySha256" AND "payload"->>'requestSha256'="requestSha256"
   AND "payload"->'snapshot'->>'documentId'="documentId"::text) IS TRUE)
);
CREATE TABLE "B2bGuideIssueLocalOutbox" (
 "documentId" uuid PRIMARY KEY,"operationId" uuid NOT NULL UNIQUE,
 "eventType" text NOT NULL CHECK ("eventType"='guide.issue.prepared.local.v1'),
 "payload" jsonb NOT NULL,
 FOREIGN KEY ("documentId","operationId") REFERENCES "B2bGuideIssueDocument"("id","operationId") ON DELETE RESTRICT
);

CREATE FUNCTION b2b_guide_issue_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GUIDE_ISSUE_IMMUTABLE'; END $$;
CREATE TRIGGER guide_issue_document_immutable BEFORE UPDATE OR DELETE ON "B2bGuideIssueDocument"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_item_immutable BEFORE UPDATE OR DELETE ON "B2bGuideIssueItem"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_receipt_immutable BEFORE UPDATE OR DELETE ON "B2bGuideIssueReceipt"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_local_event_immutable BEFORE UPDATE OR DELETE ON "B2bGuideIssueLocalOutbox"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_document_no_truncate BEFORE TRUNCATE ON "B2bGuideIssueDocument"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_item_no_truncate BEFORE TRUNCATE ON "B2bGuideIssueItem"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_receipt_no_truncate BEFORE TRUNCATE ON "B2bGuideIssueReceipt"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_local_event_no_truncate BEFORE TRUNCATE ON "B2bGuideIssueLocalOutbox"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();
CREATE TRIGGER guide_issue_series_no_truncate BEFORE TRUNCATE ON "B2bGuideIssueSeries"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();

CREATE FUNCTION b2b_guide_issue_series_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_ISSUE_SERIES_NO_DELETE'; END IF;
 IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-ARRAY['revision','active']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['revision','active']) OR NEW."revision"<>OLD."revision"+1)
 THEN RAISE EXCEPTION 'GUIDE_ISSUE_SERIES_IDENTITY_IMMUTABLE'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "B2bGuideDraftSeries" d JOIN "SeriesCounter" f ON f."id"=NEW."fiscalSeriesId"
   WHERE d."id"=NEW."draftSeriesId" AND d."companyId"=NEW."companyId" AND f."companyId"=NEW."companyId"
    AND d."pointId"=f."emissionPointId" AND d."guideType"='09' AND d."purpose"='DRAFT_ONLY'
    AND f."documentType"='DESPATCH_ADVICE' AND f."series" ~ '^T[A-Z0-9]{3}$' AND d."label"=f."series")
 THEN RAISE EXCEPTION 'GUIDE_ISSUE_SERIES_MAPPING_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_issue_series_versioned BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideIssueSeries"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_series_versioned();

-- Every append must be a complete aggregate by COMMIT, regardless of write order.
-- IS DISTINCT FROM and IS TRUE intentionally reject NULL/missing JSON fields.
CREATE FUNCTION b2b_guide_issue_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc uuid; h "B2bGuideIssueDocument"%ROWTYPE; r "B2bGuideIssueReceipt"%ROWTYPE;
        d "B2bGuideDraft"%ROWTYPE; items jsonb; n integer;
BEGIN
 IF TG_TABLE_NAME='B2bGuideIssueDocument' THEN doc=NEW."id"; ELSE doc=NEW."documentId"; END IF;
 SELECT * INTO STRICT h FROM "B2bGuideIssueDocument" WHERE "id"=doc;
 SELECT * INTO STRICT d FROM "B2bGuideDraft" WHERE "id"=h."draftId" FOR UPDATE;
 SELECT * INTO STRICT r FROM "B2bGuideIssueReceipt" WHERE "documentId"=doc;
 SELECT count(*),jsonb_agg("payload" ORDER BY "position") INTO n,items FROM "B2bGuideIssueItem" WHERE "documentId"=doc;
 IF n<>h."itemCount" OR items IS DISTINCT FROM h."snapshot"->'body'->'items'
   OR EXISTS (SELECT 1 FROM "B2bGuideIssueItem" WHERE "documentId"=doc AND "position">h."itemCount")
   OR d."state"<>'READY' OR d."revision"<>h."draftRevision" OR d."clientId"<>h."clientId" OR d."actorKey"<>h."actorKey"
   OR d."guideSeriesId"<>h."draftSeriesId" OR d."binding" IS DISTINCT FROM h."binding"->'draft'
   OR d."body" IS DISTINCT FROM h."snapshot"->'body' OR d."bodySha256" IS DISTINCT FROM h."snapshot"->>'bodySha256'
   OR r."id"<>h."operationId" OR r."payload"->'snapshot' IS DISTINCT FROM h."snapshot"
   OR r."payload"->>'snapshotSha256' IS DISTINCT FROM h."snapshotSha256"
   OR NOT EXISTS (SELECT 1 FROM "CompanySettings" c JOIN "B2bGuideDraftSeries" g ON g."companyId"=c."id"
     JOIN "B2bGuideIssueSeries" m ON m."draftSeriesId"=g."id" AND m."companyId"=c."id"
     JOIN "SeriesCounter" f ON f."id"=m."fiscalSeriesId" AND f."companyId"=c."id"
     JOIN "EmissionPoint" p ON p."id"=g."pointId" AND p."companyId"=c."id"
     WHERE c."id"=h."companyId" AND c."ruc"=h."issuerRuc" AND c."active"=true AND c."environment"='BETA'
       AND g."id"=h."draftSeriesId" AND g."guideType"='09' AND g."active"=true AND g."purpose"='DRAFT_ONLY'
       AND g."label"=h."series" AND f."series"=h."series" AND f."emissionPointId"=g."pointId"
       AND f."id"=h."fiscalSeriesId" AND f."documentType"='DESPATCH_ADVICE' AND f."active"=true AND f."nextNumber">h."number"
       AND m."active"=true AND m."purpose"='LOCAL_CANDIDATE' AND p."active"=true
       AND p."id"::text=h."binding"->'draft'->'anchor'->>'pointId'
       AND p."branchId"::text=h."binding"->'draft'->'anchor'->>'branchId')
   OR NOT EXISTS (SELECT 1 FROM "B2bGuideIssueLocalOutbox" o WHERE o."documentId"=doc AND o."operationId"=h."operationId"
     AND o."eventType"='guide.issue.prepared.local.v1' AND o."payload"=h."snapshot")
 THEN RAISE EXCEPTION 'GUIDE_ISSUE_AGGREGATE_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER guide_issue_document_complete AFTER INSERT ON "B2bGuideIssueDocument"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_complete();
CREATE CONSTRAINT TRIGGER guide_issue_item_complete AFTER INSERT ON "B2bGuideIssueItem"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_complete();
CREATE CONSTRAINT TRIGGER guide_issue_receipt_complete AFTER INSERT ON "B2bGuideIssueReceipt"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_complete();
CREATE CONSTRAINT TRIGGER guide_issue_local_event_complete AFTER INSERT ON "B2bGuideIssueLocalOutbox"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_complete();

CREATE FUNCTION b2b_guide_issue_freeze_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "B2bGuideIssueDocument" WHERE "draftId"=OLD."id")
 THEN RAISE EXCEPTION 'GUIDE_ISSUED_DRAFT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_issue_freeze_draft BEFORE UPDATE OR DELETE ON "B2bGuideDraft"
 FOR EACH ROW EXECUTE FUNCTION b2b_guide_issue_freeze_draft();
CREATE TRIGGER guide_issue_draft_no_truncate BEFORE TRUNCATE ON "B2bGuideDraft"
 FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_issue_immutable();
