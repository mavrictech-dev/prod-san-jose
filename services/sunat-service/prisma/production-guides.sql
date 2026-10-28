-- Private originals and dispatch journal. Apply only after reviewing the additive DDL.
CREATE TABLE "ProductionGuidesJob" (
 "documentId" uuid PRIMARY KEY, "eventId" uuid NOT NULL UNIQUE,
 "snapshotSha256" char(64) NOT NULL CHECK ("snapshotSha256"~'^[a-f0-9]{64}$'),
 "event" jsonb NOT NULL, "result" jsonb NOT NULL,
 "state" text NOT NULL CHECK ("state" IN ('RESERVED','PREPARED','UNKNOWN','TICKET','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','FAILED_NO_CDR')),
 "revision" integer NOT NULL DEFAULT 0 CHECK ("revision">=0), "attemptId" uuid,
 "ticket" uuid UNIQUE, "manifest" jsonb, "evidence" jsonb, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "ProductionGuidesArtifact" (
 "documentId" uuid NOT NULL REFERENCES "ProductionGuidesJob"("documentId"),
 "kind" text NOT NULL CHECK ("kind" IN ('signed-xml','submission-zip','cdr-xml','cdr-zip')),
 "name" text NOT NULL CHECK ("name"~'^[A-Za-z0-9_-]+\.(xml|zip)$'), "mediaType" text NOT NULL,
 "sha256" char(64) NOT NULL CHECK ("sha256"~'^[a-f0-9]{64}$'),
 "bytes" bytea NOT NULL CHECK (octet_length("bytes") BETWEEN 1 AND 4194304),
 PRIMARY KEY ("documentId","kind")
);
CREATE TABLE "ProductionGuidesStatusOutbox" (
 "eventId" uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "ProductionGuidesJob"("documentId"),
 "revision" integer NOT NULL CHECK ("revision">0),"event" jsonb NOT NULL,"publishedAt" timestamptz,
 UNIQUE ("documentId","revision")
);
CREATE INDEX production_guides_work ON "ProductionGuidesJob" ("state","updatedAt");
CREATE FUNCTION production_guides_original_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GRE original append-only'; END $$;
CREATE TRIGGER production_guides_original_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesArtifact" FOR EACH ROW EXECUTE FUNCTION production_guides_original_frozen();
CREATE FUNCTION production_guides_job_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW."documentId"<>OLD."documentId" OR NEW."eventId"<>OLD."eventId" OR NEW."snapshotSha256"<>OLD."snapshotSha256" OR NEW."event"<>OLD."event" OR OLD."manifest" IS NOT NULL AND NEW."manifest" IS DISTINCT FROM OLD."manifest" OR OLD."evidence" IS NOT NULL AND NEW."evidence" IS DISTINCT FROM OLD."evidence" THEN RAISE EXCEPTION 'GRE owner/manifest/evidence immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER production_guides_job_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesJob" FOR EACH ROW EXECUTE FUNCTION production_guides_job_frozen();
CREATE FUNCTION production_guides_outbox_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'publishedAt') IS DISTINCT FROM (to_jsonb(OLD)-'publishedAt') THEN RAISE EXCEPTION 'GRE status immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER production_guides_outbox_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesStatusOutbox" FOR EACH ROW EXECUTE FUNCTION production_guides_outbox_frozen();
