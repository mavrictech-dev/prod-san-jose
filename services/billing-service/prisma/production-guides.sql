-- Additive native GRE persistence. No grants or issuer enrollment are inserted.
CREATE TABLE "ProductionGuidesGrant" (
 "seriesCounterId" uuid NOT NULL REFERENCES "SeriesCounter"("id"), "actorId" uuid NOT NULL,
 "version" integer NOT NULL CHECK ("version">0), "payload" jsonb NOT NULL,
 "configuredBy" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("seriesCounterId","actorId","version")
);
CREATE TABLE "ProductionGuidesReservation" (
 "documentId" uuid PRIMARY KEY REFERENCES "Document"("id"), "operationId" uuid NOT NULL UNIQUE,
 "actorId" uuid NOT NULL, "requestSha256" char(64) NOT NULL CHECK ("requestSha256"~'^[a-f0-9]{64}$'),
 "snapshotSha256" char(64) NOT NULL CHECK ("snapshotSha256"~'^[a-f0-9]{64}$'),
 "eventId" uuid NOT NULL UNIQUE REFERENCES "OutboxEvent"("id") DEFERRABLE INITIALLY DEFERRED,
 "event" jsonb NOT NULL, "state" text NOT NULL DEFAULT 'RESERVED', "revision" integer NOT NULL DEFAULT 0,
 "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "ProductionGuidesOwnerStatus" (
 "eventId" uuid PRIMARY KEY, "documentId" uuid NOT NULL REFERENCES "ProductionGuidesReservation"("documentId"),
 "revision" integer NOT NULL CHECK ("revision">0), "event" jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("documentId","revision")
);
CREATE FUNCTION production_guides_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'production guides append-only record'; END $$;
CREATE TRIGGER production_guides_grant_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesGrant" FOR EACH ROW EXECUTE FUNCTION production_guides_append_only();
CREATE TRIGGER production_guides_status_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesOwnerStatus" FOR EACH ROW EXECUTE FUNCTION production_guides_append_only();
CREATE FUNCTION production_guides_reservation_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision') THEN RAISE EXCEPTION 'production guides reservation immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER production_guides_reservation_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesReservation" FOR EACH ROW EXECUTE FUNCTION production_guides_reservation_frozen();
