-- CANDIDATE ONLY: no startup migration, no grants inferred/seeded, no live DB target.
BEGIN;
CREATE TABLE "B2bCorrectionGrantRevision" (
  "clientId" uuid NOT NULL REFERENCES "B2bClient"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  "clientRevision" integer NOT NULL CHECK ("clientRevision">0),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "bindings" jsonb NOT NULL CHECK (jsonb_typeof("bindings")='array' AND jsonb_array_length("bindings")<=500),
  "actorId" uuid NOT NULL, "at" timestamptz NOT NULL,
  PRIMARY KEY ("clientId","revision")
);
CREATE TABLE "B2bCorrectionGrantHead" (
  "clientId" uuid PRIMARY KEY REFERENCES "B2bClient"("id") ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  FOREIGN KEY ("clientId","revision") REFERENCES "B2bCorrectionGrantRevision"("clientId","revision") ON DELETE RESTRICT
);
CREATE FUNCTION "b2b_correction_grant_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CORRECTION_GRANT_REVISION_IMMUTABLE'; END; $$;
CREATE TRIGGER "b2b_correction_grant_immutable" BEFORE UPDATE OR DELETE ON "B2bCorrectionGrantRevision"
  FOR EACH ROW EXECUTE FUNCTION "b2b_correction_grant_immutable"();
CREATE FUNCTION "b2b_correction_grant_head_monotonic"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CORRECTION_GRANT_HEAD_IMMUTABLE'; END IF;
  IF NEW."clientId"<>OLD."clientId" OR NEW."revision"<>OLD."revision"+1 THEN RAISE EXCEPTION 'CORRECTION_GRANT_HEAD_CAS_REQUIRED'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "b2b_correction_grant_head_monotonic" BEFORE UPDATE OR DELETE ON "B2bCorrectionGrantHead"
  FOR EACH ROW EXECUTE FUNCTION "b2b_correction_grant_head_monotonic"();
COMMIT;
