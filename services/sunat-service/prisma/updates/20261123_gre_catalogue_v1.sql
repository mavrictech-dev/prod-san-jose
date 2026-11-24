CREATE TABLE "ProductionGuidesCatalogue" (
 "issuerRuc" char(11) NOT NULL,"revision" integer NOT NULL CHECK("revision">0),"companyId" integer NOT NULL,
 "payload" jsonb NOT NULL,"payloadSha256" char(64) NOT NULL,"reviewedBy" uuid NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY("issuerRuc","revision")
);
CREATE FUNCTION production_guides_catalogue_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GRE reviewed catalogue append-only'; END $$;
CREATE TRIGGER production_guides_catalogue_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesCatalogue" FOR EACH ROW EXECUTE FUNCTION production_guides_catalogue_frozen();
