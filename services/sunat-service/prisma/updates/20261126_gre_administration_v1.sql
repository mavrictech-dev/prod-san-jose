-- Additive administrative preparation; no fiscal originals/counters are modified.
CREATE TABLE "ProductionGuidesAdministrationDraft" (
 "issuerRuc" char(11) NOT NULL, "revision" integer NOT NULL CHECK("revision">0),
 "companyId" integer NOT NULL, "payload" jsonb NOT NULL CHECK(octet_length("payload"::text)<=524288),
 "payloadSha256" char(64) NOT NULL CHECK("payloadSha256"~'^[a-f0-9]{64}$'),
 "actorId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY("issuerRuc","revision")
);
CREATE INDEX production_guides_administration_company ON "ProductionGuidesAdministrationDraft" ("companyId","issuerRuc","revision" DESC);
CREATE FUNCTION production_guides_administration_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'GRE preparation history append-only'; END $$;
CREATE TRIGGER production_guides_administration_immutable BEFORE UPDATE OR DELETE ON "ProductionGuidesAdministrationDraft" FOR EACH ROW EXECUTE FUNCTION production_guides_administration_frozen();
