-- REVIEW CANDIDATE ONLY: never applied by startup, construction or migrations.
-- Local attributable policy, not an official classification or fiscal authority.
-- Apply only in an explicitly authorized isolated synthetic rehearsal.
BEGIN;

CREATE TABLE "B2bGuideGoodsHead" (
  "companyId" integer PRIMARY KEY REFERENCES "CompanySettings"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0)
);

-- Shape checks use only the supplied JSON. No product/issuer classification,
-- master-data lookup, external data or fiscal numbering is performed here.
CREATE FUNCTION b2b_guide_goods_payload_valid(p jsonb, company_id integer, rev integer)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  e jsonb;
  c jsonb;
  field_name text;
  code jsonb;
  previous_code text;
  product_id uuid;
  previous_id uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>262144 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p))<>12 OR NOT p ?& ARRAY[
    'schemaVersion','companyId','issuerRuc','issuerRevision','revision','catalogue','entries',
    'actorId','authRevision','at','source','sha256'] THEN RETURN false; END IF;
  IF jsonb_typeof(p->'companyId') IS DISTINCT FROM 'number' OR p->>'companyId' IS DISTINCT FROM company_id::text OR
    jsonb_typeof(p->'revision') IS DISTINCT FROM 'number' OR p->>'revision' IS DISTINCT FROM rev::text OR
    p->>'schemaVersion' IS DISTINCT FROM 'factuez.guide-goods-policy.v1' OR
    p->>'source' IS DISTINCT FROM 'ADMIN_LOCAL_CONFIGURATION' OR
    jsonb_typeof(p->'issuerRuc') IS DISTINCT FROM 'string' OR (p->>'issuerRuc' ~ '^[0-9]{11}$') IS DISTINCT FROM true OR
    jsonb_typeof(p->'sha256') IS DISTINCT FROM 'string' OR (p->>'sha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true OR
    jsonb_typeof(p->'issuerRevision') IS DISTINCT FROM 'number' OR (p->>'issuerRevision' ~ '^[1-9][0-9]{0,9}$') IS DISTINCT FROM true OR
    (p->>'issuerRevision')::bigint>2147483647 OR
    jsonb_typeof(p->'authRevision') IS DISTINCT FROM 'number' OR (p->>'authRevision' ~ '^(0|[1-9][0-9]{0,9})$') IS DISTINCT FROM true OR
    (p->>'authRevision')::bigint>2147483647 OR
    jsonb_typeof(p->'actorId') IS DISTINCT FROM 'string' OR
    (p->>'actorId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') IS DISTINCT FROM true OR
    jsonb_typeof(p->'at') IS DISTINCT FROM 'string' OR
    (p->>'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') IS DISTINCT FROM true OR
    NOT isfinite((p->>'at')::timestamptz) THEN RETURN false; END IF;
  c:=p->'catalogue';
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR octet_length(c::text)>131072 THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(c))<>9 OR NOT c ?& ARRAY[
    'schemaVersion','version','sourceUrl','sourceSha256','units','weightUnits','ubigeos','referenceStatus','sha256'] OR
    c->>'schemaVersion' IS DISTINCT FROM 'factuez.guide-reference-catalogue.v1' OR
    c->>'referenceStatus' IS DISTINCT FROM 'LOCAL_REFERENCE_NOT_OFFICIAL' OR
    jsonb_typeof(c->'version') IS DISTINCT FROM 'string' OR
    (c->>'version' ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') IS DISTINCT FROM true OR
    jsonb_typeof(c->'sourceUrl') IS DISTINCT FROM 'string' OR length(c->>'sourceUrl') NOT BETWEEN 1 AND 500 OR
    (c->>'sourceUrl') ~ '[[:cntrl:]]' OR
    jsonb_typeof(c->'sourceSha256') IS DISTINCT FROM 'string' OR
    (c->>'sourceSha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true OR
    jsonb_typeof(c->'sha256') IS DISTINCT FROM 'string' OR
    (c->>'sha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true THEN RETURN false; END IF;
  FOREACH field_name IN ARRAY ARRAY['units','weightUnits','ubigeos'] LOOP
    IF jsonb_typeof(c->field_name) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(c->field_name) NOT BETWEEN 1 AND
      (CASE field_name WHEN 'units' THEN 200 WHEN 'weightUnits' THEN 2 ELSE 500 END) THEN RETURN false; END IF;
    previous_code:=NULL;
    FOR code IN SELECT value FROM jsonb_array_elements(c->field_name) LOOP
      IF jsonb_typeof(code) IS DISTINCT FROM 'string' OR
        ((code #>> '{}') ~ CASE field_name WHEN 'ubigeos' THEN '^[0-9]{6}$'
          WHEN 'weightUnits' THEN '^(KGM|TNE)$' ELSE '^[A-Z0-9]{2,3}$' END) IS DISTINCT FROM true OR
        (previous_code IS NOT NULL AND (code #>> '{}') COLLATE "C"<=previous_code COLLATE "C") THEN RETURN false; END IF;
      previous_code:=code #>> '{}';
    END LOOP;
  END LOOP;
  IF jsonb_typeof(p->'entries') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p->'entries')>200 THEN RETURN false; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p->'entries') LOOP
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(e))<>4 OR
      NOT e ?& ARRAY['productId','productSha256','classification','rationale'] OR
      jsonb_typeof(e->'productId') IS DISTINCT FROM 'string' OR
      (e->>'productId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') IS DISTINCT FROM true OR
      jsonb_typeof(e->'productSha256') IS DISTINCT FROM 'string' OR
      (e->>'productSha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true OR
      jsonb_typeof(e->'classification') IS DISTINCT FROM 'string' OR
      (e->>'classification' IN ('NON_REGULATED','REGULATED','UNKNOWN')) IS DISTINCT FROM true OR
      jsonb_typeof(e->'rationale') IS DISTINCT FROM 'string' OR
      length(e->>'rationale') NOT BETWEEN 1 AND 500 OR
      btrim(e->>'rationale')<>e->>'rationale' OR (e->>'rationale') ~ '[[:cntrl:]]' THEN RETURN false; END IF;
    product_id:=(e->>'productId')::uuid;
    IF previous_id IS NOT NULL AND product_id<=previous_id THEN RETURN false; END IF;
    previous_id:=product_id;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR
  invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END $$;

CREATE TABLE "B2bGuideGoodsVersion" (
  "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  "revision" integer NOT NULL CHECK ("revision">0),
  "payload" jsonb NOT NULL,
  PRIMARY KEY ("companyId","revision"),
  FOREIGN KEY ("companyId") REFERENCES "B2bGuideGoodsHead"("companyId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (b2b_guide_goods_payload_valid("payload","companyId","revision") IS TRUE)
);
-- NO ACTION allows head CAS before version append, checked at commit.
ALTER TABLE "B2bGuideGoodsHead" ADD CONSTRAINT "B2bGuideGoodsHead_version_fkey"
  FOREIGN KEY ("companyId","revision") REFERENCES "B2bGuideGoodsVersion"("companyId","revision")
  ON UPDATE NO ACTION ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "B2bGuideGoodsAudit" (
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
CREATE INDEX "B2bGuideGoodsAudit_company_revision" ON "B2bGuideGoodsAudit" ("companyId","revision");

CREATE TABLE "B2bGuideGoodsRate" (
  "keyHash" text PRIMARY KEY CHECK ("keyHash" ~ '^[a-f0-9]{64}$'),
  "window" bigint NOT NULL CHECK ("window" BETWEEN 0 AND 9007199254740991),
  "counter" integer NOT NULL CHECK ("counter">0)
);

CREATE FUNCTION b2b_guide_goods_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GUIDE_GOODS_APPEND_ONLY';
END $$;
CREATE TRIGGER guide_goods_version_immutable BEFORE UPDATE OR DELETE ON "B2bGuideGoodsVersion"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_immutable();
CREATE TRIGGER guide_goods_audit_immutable BEFORE UPDATE OR DELETE ON "B2bGuideGoodsAudit"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_immutable();

CREATE FUNCTION b2b_guide_goods_head_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_GOODS_HEAD_NO_DELETE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-goods:'||NEW."companyId"::text,0));
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>1 THEN RAISE EXCEPTION 'GUIDE_GOODS_HEAD_FIRST_REVISION'; END IF;
  ELSIF NEW."companyId" IS DISTINCT FROM OLD."companyId" OR NEW."revision"::bigint<>OLD."revision"::bigint+1 THEN
    RAISE EXCEPTION 'GUIDE_GOODS_HEAD_IDENTITY_OR_REVISION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_goods_head_versioned BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideGoodsHead"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_head_versioned();

CREATE FUNCTION b2b_guide_goods_version_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-goods:'||NEW."companyId"::text,0));
  SELECT "revision" INTO head_revision FROM "B2bGuideGoodsHead" WHERE "companyId"=NEW."companyId" FOR UPDATE;
  IF head_revision IS DISTINCT FROM NEW."revision" THEN RAISE EXCEPTION 'GUIDE_GOODS_VERSION_HEAD_MISMATCH'; END IF;
  IF NEW."revision">1 AND NOT EXISTS (
    SELECT 1 FROM "B2bGuideGoodsVersion" WHERE "companyId"=NEW."companyId" AND "revision"=NEW."revision"-1
  ) THEN RAISE EXCEPTION 'GUIDE_GOODS_VERSION_PREDECESSOR_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_goods_version_member BEFORE INSERT ON "B2bGuideGoodsVersion"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_version_member();

CREATE FUNCTION b2b_guide_goods_audit_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE head_revision integer; version_payload jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('factuez:guide-goods:'||NEW."companyId"::text,0));
  SELECT "revision" INTO head_revision FROM "B2bGuideGoodsHead" WHERE "companyId"=NEW."companyId" FOR SHARE;
  IF NEW."revision"<>COALESCE(head_revision,0) THEN RAISE EXCEPTION 'GUIDE_GOODS_AUDIT_HEAD_MISMATCH'; END IF;
  IF NEW."revision">0 THEN
    SELECT "payload" INTO version_payload FROM "B2bGuideGoodsVersion"
      WHERE "companyId"=NEW."companyId" AND "revision"=NEW."revision";
    IF version_payload IS NULL THEN RAISE EXCEPTION 'GUIDE_GOODS_AUDIT_VERSION_REQUIRED'; END IF;
    IF NEW."action"='REPLACE' AND ((version_payload->>'actorId') IS DISTINCT FROM NEW."actorId"::text OR
      (version_payload->>'at')::timestamptz IS DISTINCT FROM NEW."at") THEN
      RAISE EXCEPTION 'GUIDE_GOODS_AUDIT_ACTOR_OR_TIME_MISMATCH';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_goods_audit_member BEFORE INSERT ON "B2bGuideGoodsAudit"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_audit_member();

CREATE FUNCTION b2b_guide_goods_rate_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'GUIDE_GOODS_RATE_NO_DELETE'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."counter"<>1 THEN RAISE EXCEPTION 'GUIDE_GOODS_RATE_INITIAL_COUNTER'; END IF;
  ELSIF NEW."keyHash" IS DISTINCT FROM OLD."keyHash" OR NEW."window"<OLD."window" OR
    (NEW."window">OLD."window" AND NEW."counter"<>1) OR
    (NEW."window"=OLD."window" AND NEW."counter"::bigint<>LEAST(OLD."counter"::bigint+1,2147483647)) THEN
    RAISE EXCEPTION 'GUIDE_GOODS_RATE_IDENTITY_OR_WINDOW';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_goods_rate_monotonic BEFORE INSERT OR UPDATE OR DELETE ON "B2bGuideGoodsRate"
  FOR EACH ROW EXECUTE FUNCTION b2b_guide_goods_rate_monotonic();

CREATE TRIGGER guide_goods_head_no_truncate BEFORE TRUNCATE ON "B2bGuideGoodsHead"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_goods_immutable();
CREATE TRIGGER guide_goods_version_no_truncate BEFORE TRUNCATE ON "B2bGuideGoodsVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_goods_immutable();
CREATE TRIGGER guide_goods_audit_no_truncate BEFORE TRUNCATE ON "B2bGuideGoodsAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_goods_immutable();
CREATE TRIGGER guide_goods_rate_no_truncate BEFORE TRUNCATE ON "B2bGuideGoodsRate"
  FOR EACH STATEMENT EXECUTE FUNCTION b2b_guide_goods_immutable();

COMMIT;
