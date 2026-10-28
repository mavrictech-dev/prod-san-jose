-- Candidate DRAFT storage only. No fiscal series/counter, Document, Outbox or SUNAT artifacts.
-- Apply only in an explicitly isolated rehearsal, never from startup.
CREATE TABLE "B2bGuideDraftSeries" (
 "id" uuid PRIMARY KEY,"companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
 "pointId" uuid NOT NULL,"guideType" text NOT NULL CHECK ("guideType" IN ('09','31')),
 "label" text NOT NULL CHECK ("label" ~ '^[A-Z0-9]{4}$'),
 "revision" integer NOT NULL DEFAULT 1 CHECK ("revision">0),"active" boolean NOT NULL DEFAULT true,
 "purpose" text NOT NULL DEFAULT 'DRAFT_ONLY' CHECK ("purpose"='DRAFT_ONLY'),
 FOREIGN KEY ("pointId","companyId") REFERENCES "EmissionPoint"("id","companyId") ON DELETE RESTRICT,
 UNIQUE ("companyId","guideType","label")
);
CREATE TABLE "B2bGuideDraft" (
 "id" uuid PRIMARY KEY,"clientId" uuid NOT NULL,"actorKey" text NOT NULL,
 "guideSeriesId" uuid NOT NULL REFERENCES "B2bGuideDraftSeries"("id") ON DELETE RESTRICT,
 "binding" jsonb NOT NULL,"body" jsonb NOT NULL,"bodySha256" text NOT NULL CHECK ("bodySha256" ~ '^[a-f0-9]{64}$'),
 "revision" integer NOT NULL CHECK ("revision" BETWEEN 1 AND 999999999),
 "state" text NOT NULL CHECK ("state" IN ('DRAFT','READY','CANCELLED')),
 "createdAt" timestamptz NOT NULL,"updatedAt" timestamptz NOT NULL,
 CHECK ("binding"->'anchor'->>'environment'='BETA'),CHECK ("updatedAt">="createdAt")
);
CREATE INDEX "B2bGuideDraftScopedPage" ON "B2bGuideDraft" ("clientId","actorKey","guideSeriesId","id");
CREATE TABLE "B2bGuideDraftOperation" (
 "id" uuid PRIMARY KEY,"clientId" uuid NOT NULL,"actorKey" text NOT NULL,
 "draftId" uuid NOT NULL REFERENCES "B2bGuideDraft"("id") ON DELETE RESTRICT,
 "keySha256" text NOT NULL CHECK ("keySha256" ~ '^[a-f0-9]{64}$'),
 "payload" jsonb NOT NULL,UNIQUE ("clientId","actorKey","keySha256")
);
CREATE FUNCTION b2b_guide_draft_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GUIDE_OPERATION_IMMUTABLE'; END $$;
CREATE TRIGGER guide_operation_immutable BEFORE UPDATE OR DELETE ON "B2bGuideDraftOperation"
FOR EACH ROW EXECUTE FUNCTION b2b_guide_draft_receipt_immutable();
CREATE FUNCTION b2b_guide_draft_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_DRAFT_NO_DELETE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['body','bodySha256','revision','state','updatedAt']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['body','bodySha256','revision','state','updatedAt'])
    OR NEW."revision"<>OLD."revision"+1 OR NEW."updatedAt"<OLD."updatedAt" OR OLD."state"='CANCELLED'
    OR (OLD."state"='READY' AND (NEW."state"<>'CANCELLED' OR NEW."body"<>OLD."body" OR NEW."bodySha256"<>OLD."bodySha256"))
 THEN RAISE EXCEPTION 'GUIDE_DRAFT_VERSION_OR_IMMUTABILITY'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_draft_versioned BEFORE UPDATE OR DELETE ON "B2bGuideDraft"
FOR EACH ROW EXECUTE FUNCTION b2b_guide_draft_versioned();
CREATE FUNCTION b2b_guide_draft_series_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_DRAFT_SERIES_NO_DELETE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','active']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','active']) OR NEW."revision"<>OLD."revision"+1
 THEN RAISE EXCEPTION 'GUIDE_DRAFT_SERIES_IDENTITY_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guide_draft_series_versioned BEFORE UPDATE OR DELETE ON "B2bGuideDraftSeries"
FOR EACH ROW EXECUTE FUNCTION b2b_guide_draft_series_versioned();
