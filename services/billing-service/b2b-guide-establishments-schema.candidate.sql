-- REVIEW CANDIDATE ONLY. Never applied by application startup or this store.
-- Local BETA configuration; grants no fiscal or transmission authority.
-- Apply only to an explicitly authorized isolated test database.
BEGIN;

CREATE TABLE "B2bGuideEstablishmentHead" (
  "companyId" integer PRIMARY KEY REFERENCES "CompanySettings"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0)
);
CREATE TABLE "B2bGuideEstablishmentVersion" (
  "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("companyId","revision"),
  FOREIGN KEY ("companyId") REFERENCES "B2bGuideEstablishmentHead"("companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (jsonb_typeof("payload")='object'),
  CHECK ((jsonb_typeof("payload"->'companyId')='number' AND "payload"->>'companyId'="companyId"::text) IS TRUE),
  CHECK ((jsonb_typeof("payload"->'revision')='number' AND "payload"->>'revision'="revision"::text) IS TRUE),
  CHECK (("payload"->>'schemaVersion'='factuez.guide-establishments.v1') IS TRUE),
  CHECK (("payload"->>'source'='ADMIN_LOCAL_CONFIGURATION') IS TRUE),
  CHECK ((jsonb_typeof("payload"->'entries')='array' AND jsonb_array_length("payload"->'entries')<=200) IS TRUE),
  CHECK (("payload"->>'sha256' ~ '^[a-f0-9]{64}$') IS TRUE),
  CHECK (octet_length("payload"::text)<=262144)
);
-- CAS changes the head before appending its version, including revision one.
-- NO ACTION (not RESTRICT) makes the membership check deferrable until commit.
ALTER TABLE "B2bGuideEstablishmentHead" ADD CONSTRAINT "B2bGuideEstablishmentHead_version_fkey"
  FOREIGN KEY ("companyId","revision") REFERENCES "B2bGuideEstablishmentVersion"("companyId","revision")
  ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "B2bGuideEstablishmentAudit" (
  "id" uuid PRIMARY KEY,
  "requestId" uuid NOT NULL,
  "peerSha256" text NOT NULL CHECK ("peerSha256" ~ '^[a-f0-9]{64}$'),
  "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">=0),
  "actorId" uuid NOT NULL,
  "action" text NOT NULL CHECK ("action" IN ('READ','REPLACE')),
  "at" timestamptz NOT NULL CHECK (isfinite("at")),
  CHECK ("action"<>'REPLACE' OR "revision">0)
);
CREATE INDEX "B2bGuideEstablishmentAudit_company_revision" ON "B2bGuideEstablishmentAudit" ("companyId","revision");

-- Bounded counter and a single current window per hash, including denied calls.
-- Raw peers, tokens, secrets and authority responses are never retained here.
CREATE TABLE "B2bGuideEstablishmentRate" (
  "keyHash" text PRIMARY KEY CHECK ("keyHash" ~ '^[a-f0-9]{64}$'),
  "window" bigint NOT NULL CHECK ("window" BETWEEN 0 AND 9007199254740991),
  "counter" integer NOT NULL CHECK ("counter">0)
);

CREATE FUNCTION b2b_guide_establishment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ESTABLISHMENT_APPEND_ONLY';
END $$;
CREATE TRIGGER guide_establishment_version_immutable BEFORE UPDATE OR DELETE ON "B2bGuideEstablishmentVersion"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_immutable();
CREATE TRIGGER guide_establishment_audit_immutable BEFORE UPDATE OR DELETE ON "B2bGuideEstablishmentAudit"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_immutable();

CREATE FUNCTION b2b_guide_establishment_head_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ESTABLISHMENT_HEAD_NO_DELETE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-establishments:'||NEW."companyId"::text,0));
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>1 THEN RAISE EXCEPTION 'ESTABLISHMENT_HEAD_FIRST_REVISION'; END IF;
  ELSE
    IF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."revision"::bigint<>OLD."revision"::bigint+1 THEN
      RAISE EXCEPTION 'ESTABLISHMENT_HEAD_IDENTITY_OR_REVISION';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_establishment_head_versioned BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideEstablishmentHead"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_head_versioned();

CREATE FUNCTION b2b_guide_establishment_version_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_revision integer;
  issuer_ruc text;
  issuer_revision integer;
  entry jsonb;
  branch_id uuid;
  branch_revision integer;
  seen_branches uuid[]:=ARRAY[]::uuid[];
  seen_codes text[]:=ARRAY[]::text[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-establishments:'||NEW."companyId"::text,0));
  SELECT "revision" INTO head_revision FROM "B2bGuideEstablishmentHead"
    WHERE "companyId"=NEW."companyId" FOR UPDATE;
  IF head_revision IS DISTINCT FROM NEW."revision" THEN RAISE EXCEPTION 'ESTABLISHMENT_VERSION_HEAD_MISMATCH'; END IF;
  IF NEW."revision">1 AND NOT EXISTS (
    SELECT 1 FROM "B2bGuideEstablishmentVersion" WHERE "companyId"=NEW."companyId" AND "revision"=NEW."revision"-1
  ) THEN RAISE EXCEPTION 'ESTABLISHMENT_VERSION_PREDECESSOR_REQUIRED'; END IF;

  SELECT "ruc","configVersion" INTO issuer_ruc,issuer_revision FROM "CompanySettings"
    WHERE "id"=NEW."companyId" AND "active"=true AND "environment"='BETA' FOR UPDATE;
  IF issuer_ruc IS NULL OR (NEW."payload"->>'issuerRuc') IS DISTINCT FROM issuer_ruc OR
    (NEW."payload"->>'issuerRevision') IS DISTINCT FROM issuer_revision::text THEN
    RAISE EXCEPTION 'ESTABLISHMENT_VERSION_ISSUER_MISMATCH';
  END IF;
  IF jsonb_typeof(NEW."payload"->'entries') IS DISTINCT FROM 'array' OR
    jsonb_array_length(NEW."payload"->'entries')>200 THEN RAISE EXCEPTION 'ESTABLISHMENT_ENTRIES_INVALID'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW."payload"->'entries') LOOP
    branch_id:=(entry->>'branchId')::uuid;
    branch_revision:=(entry->>'branchRevision')::integer;
    IF branch_id IS NULL OR branch_revision IS NULL OR branch_revision<1 OR
      branch_id=ANY(seen_branches) OR (entry->>'establishmentCode')=ANY(seen_codes) OR
      (entry->>'establishmentCode' ~ '^[0-9]{4}$') IS DISTINCT FROM true OR
      (entry->>'ubigeo' ~ '^[0-9]{6}$') IS DISTINCT FROM true OR
      jsonb_typeof(entry->'address') IS DISTINCT FROM 'string' OR
      length(entry->>'address') NOT BETWEEN 1 AND 300 OR btrim(entry->>'address')<>entry->>'address' THEN
      RAISE EXCEPTION 'ESTABLISHMENT_ENTRY_INVALID';
    END IF;
    PERFORM 1 FROM "Branch" WHERE "id"=branch_id AND "companyId"=NEW."companyId"
      AND "active"=true AND "masterRevision"=branch_revision FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ESTABLISHMENT_BRANCH_MEMBERSHIP_OR_REVISION'; END IF;
    seen_branches:=array_append(seen_branches,branch_id);
    seen_codes:=array_append(seen_codes,entry->>'establishmentCode');
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_establishment_version_member BEFORE INSERT ON "B2bGuideEstablishmentVersion"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_version_member();

CREATE FUNCTION b2b_guide_establishment_audit_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  head_revision integer;
  version_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-establishments:'||NEW."companyId"::text,0));
  SELECT "revision" INTO head_revision FROM "B2bGuideEstablishmentHead"
    WHERE "companyId"=NEW."companyId" FOR SHARE;
  IF NEW."revision"<>COALESCE(head_revision,0) THEN RAISE EXCEPTION 'ESTABLISHMENT_AUDIT_HEAD_MISMATCH'; END IF;
  IF NEW."revision">0 THEN
    SELECT "payload" INTO version_payload FROM "B2bGuideEstablishmentVersion"
      WHERE "companyId"=NEW."companyId" AND "revision"=NEW."revision";
    IF version_payload IS NULL THEN RAISE EXCEPTION 'ESTABLISHMENT_AUDIT_VERSION_REQUIRED'; END IF;
    IF NEW."action"='REPLACE' AND ((version_payload->>'actorId') IS DISTINCT FROM NEW."actorId"::text OR
      (version_payload->>'at')::timestamptz IS DISTINCT FROM NEW."at") THEN
      RAISE EXCEPTION 'ESTABLISHMENT_AUDIT_ACTOR_OR_TIME_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_establishment_audit_member BEFORE INSERT ON "B2bGuideEstablishmentAudit"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_audit_member();

CREATE FUNCTION b2b_guide_establishment_rate_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ESTABLISHMENT_RATE_NO_DELETE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."counter"<>1 THEN RAISE EXCEPTION 'ESTABLISHMENT_RATE_INITIAL_COUNTER'; END IF;
  ELSE
    IF NEW."keyHash" IS DISTINCT FROM OLD."keyHash" OR NEW."window"<OLD."window" OR
      (NEW."window">OLD."window" AND NEW."counter"<>1) OR
      (NEW."window"=OLD."window" AND NEW."counter"::bigint<>LEAST(OLD."counter"::bigint+1,2147483647)) THEN
      RAISE EXCEPTION 'ESTABLISHMENT_RATE_IDENTITY_OR_WINDOW';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_establishment_rate_monotonic BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideEstablishmentRate"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_establishment_rate_monotonic();

-- Row triggers do not cover TRUNCATE. Preserve history even on that path.
CREATE TRIGGER guide_establishment_head_no_truncate BEFORE TRUNCATE ON "B2bGuideEstablishmentHead"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_establishment_immutable();
CREATE TRIGGER guide_establishment_version_no_truncate BEFORE TRUNCATE ON "B2bGuideEstablishmentVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_establishment_immutable();
CREATE TRIGGER guide_establishment_audit_no_truncate BEFORE TRUNCATE ON "B2bGuideEstablishmentAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_establishment_immutable();
CREATE TRIGGER guide_establishment_rate_no_truncate BEFORE TRUNCATE ON "B2bGuideEstablishmentRate"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_establishment_immutable();

COMMIT;
