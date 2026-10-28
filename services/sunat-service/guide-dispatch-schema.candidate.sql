-- REVIEW CANDIDATE ONLY. Independent SUNAT-owned dispatch journal.
-- LOCAL_EMULATOR / BETA metadata only: no numbering, transmission or CDR trust.
-- Install only into a NEW isolated synthetic database after review.
BEGIN;

CREATE FUNCTION guide_dispatch_exact_keys(p jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (SELECT array_agg(k ORDER BY k COLLATE "C") FROM jsonb_object_keys(p) k)
    = (SELECT array_agg(k ORDER BY k COLLATE "C") FROM unnest(keys) k);
END $$;

-- Same canonical JSON as fiscalSnapshotSha256 for this bounded ASCII contract.
-- PostgreSQL's built-in sha256(bytea) requires no extension or external service.
CREATE FUNCTION guide_dispatch_canonical(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  CASE jsonb_typeof(p)
    WHEN 'object' THEN RETURN '{' || COALESCE((SELECT string_agg(to_jsonb(key)::text || ':' ||
      guide_dispatch_canonical(value), ',' ORDER BY key COLLATE "C") FROM jsonb_each(p)), '') || '}';
    WHEN 'array' THEN RETURN '[' || COALESCE((SELECT string_agg(guide_dispatch_canonical(value), ',' ORDER BY n)
      FROM jsonb_array_elements(p) WITH ORDINALITY a(value,n)), '') || ']';
    ELSE RETURN p::text;
  END CASE;
END $$;
CREATE FUNCTION guide_dispatch_sha(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(guide_dispatch_canonical(p),'UTF8')),'hex')
$$;
CREATE FUNCTION guide_dispatch_uuid(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false)
$$;
CREATE FUNCTION guide_dispatch_ruc(p text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE weights integer[] := ARRAY[5,4,3,2,7,6,5,4,3,2]; total integer := 0; digit integer;
BEGIN
  IF p IS NULL OR p !~ '^(10|15|16|17|20)[0-9]{9}$' THEN RETURN false; END IF;
  FOR i IN 1..10 LOOP total := total + substring(p,i,1)::integer * weights[i]; END LOOP;
  digit := 11 - total % 11;
  RETURN right(p,1)::integer = CASE digit WHEN 10 THEN 0 WHEN 11 THEN 1 ELSE digit END;
END $$;
CREATE FUNCTION guide_dispatch_manifest_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k jsonb; field text;
BEGIN
  IF NOT guide_dispatch_exact_keys(p,ARRAY['schemaVersion','environment','key','documentId','guideType',
    'fullNumber','ownerRevision','snapshotSha256','xmlSha256','zipSha256','source']) OR octet_length(p::text)>262144
    THEN RETURN false; END IF;
  FOR field IN SELECT unnest(ARRAY['schemaVersion','environment','documentId','guideType','fullNumber',
    'snapshotSha256','xmlSha256','zipSha256','source']) LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  k := p->'key';
  IF NOT guide_dispatch_exact_keys(k,ARRAY['companyId','issuerRuc','operationId']) OR
    jsonb_typeof(k->'companyId') IS DISTINCT FROM 'number' OR (k->>'companyId') !~ '^[1-9][0-9]{0,9}$' OR
    (k->>'companyId')::numeric>2147483647 OR jsonb_typeof(k->'issuerRuc') IS DISTINCT FROM 'string' OR
    jsonb_typeof(k->'operationId') IS DISTINCT FROM 'string' OR NOT guide_dispatch_ruc(k->>'issuerRuc') OR
    NOT guide_dispatch_uuid(k->>'operationId') THEN RETURN false; END IF;
  RETURN p->>'schemaVersion'='factuez.guide-dispatch-manifest.v1' AND p->>'environment'='BETA' AND
    p->>'source'='LOCAL_EMULATOR' AND guide_dispatch_uuid(p->>'documentId') AND
    ((p->>'guideType'='09' AND p->>'fullNumber' ~ '^T[A-Z0-9]{3}-[1-9][0-9]{0,7}$') OR
     (p->>'guideType'='31' AND p->>'fullNumber' ~ '^V[A-Z0-9]{3}-[1-9][0-9]{0,7}$')) AND
    jsonb_typeof(p->'ownerRevision')='number' AND p->>'ownerRevision' ~ '^[1-9][0-9]{0,9}$' AND
    (p->>'ownerRevision')::numeric<=2147483647 AND p->>'snapshotSha256' ~ '^[a-f0-9]{64}$' AND
    p->>'xmlSha256' ~ '^[a-f0-9]{64}$' AND p->>'zipSha256' ~ '^[a-f0-9]{64}$';
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE FUNCTION guide_dispatch_event_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE d jsonb; field text; stamp text;
BEGIN
  IF NOT guide_dispatch_exact_keys(p,ARRAY['kind','data','schemaVersion','operationId','version',
    'previousSha256','at','sha256']) OR octet_length(p::text)>262144 THEN RETURN false; END IF;
  FOR field IN SELECT unnest(ARRAY['kind','schemaVersion','operationId','at','sha256']) LOOP
    IF jsonb_typeof(p->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  IF p->>'schemaVersion'<>'factuez.guide-dispatch-event.v1' OR NOT guide_dispatch_uuid(p->>'operationId') OR
    jsonb_typeof(p->'version') IS DISTINCT FROM 'number' OR p->>'version' !~ '^[1-9][0-9]{0,2}$' OR
    (p->>'version')::integer>128 OR p->>'sha256' !~ '^[a-f0-9]{64}$' OR
    p->>'sha256'<>guide_dispatch_sha(p-'sha256') THEN RETURN false; END IF;
  IF p->>'version'='1' THEN
    IF p->'previousSha256'<>'null'::jsonb OR p->>'kind'<>'REGISTER' THEN RETURN false; END IF;
  ELSIF jsonb_typeof(p->'previousSha256') IS DISTINCT FROM 'string' OR
    p->>'previousSha256' !~ '^[a-f0-9]{64}$' OR p->>'kind'='REGISTER' THEN RETURN false;
  END IF;
  stamp := p->>'at';
  IF stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' OR
    to_char(stamp::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>stamp THEN RETURN false; END IF;
  d := p->'data';
  CASE p->>'kind'
    WHEN 'REGISTER' THEN RETURN guide_dispatch_exact_keys(d,ARRAY['manifestSha256']) AND
      jsonb_typeof(d->'manifestSha256')='string' AND d->>'manifestSha256' ~ '^[a-f0-9]{64}$';
    WHEN 'ATTEMPT','NO_RESPONSE' THEN RETURN guide_dispatch_exact_keys(d,ARRAY['attemptId']) AND
      jsonb_typeof(d->'attemptId')='string' AND guide_dispatch_uuid(d->>'attemptId');
    WHEN 'TICKET' THEN RETURN guide_dispatch_exact_keys(d,ARRAY['attemptId','ticket']) AND
      jsonb_typeof(d->'attemptId')='string' AND guide_dispatch_uuid(d->>'attemptId') AND
      jsonb_typeof(d->'ticket')='string' AND d->>'ticket' ~ '^[A-Za-z0-9_-]{1,100}$';
    WHEN 'POLL_PENDING' THEN RETURN guide_dispatch_exact_keys(d,ARRAY['ticket']) AND
      jsonb_typeof(d->'ticket')='string' AND d->>'ticket' ~ '^[A-Za-z0-9_-]{1,100}$';
    WHEN 'POLL_RESULT' THEN RETURN guide_dispatch_exact_keys(d,ARRAY['ticket','receiptSha256']) AND
      jsonb_typeof(d->'ticket')='string' AND d->>'ticket' ~ '^[A-Za-z0-9_-]{1,100}$' AND
      jsonb_typeof(d->'receiptSha256')='string' AND d->>'receiptSha256' ~ '^[a-f0-9]{64}$';
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

CREATE TABLE "GuideDispatchStream" (
  "operationId" uuid PRIMARY KEY,
  "companyId" integer NOT NULL CHECK ("companyId">0),
  "issuerRuc" text NOT NULL CHECK (guide_dispatch_ruc("issuerRuc")),
  "documentId" uuid NOT NULL UNIQUE,
  "guideType" text NOT NULL CHECK ("guideType" IN ('09','31')),
  "fullNumber" text NOT NULL,
  "manifest" jsonb NOT NULL CHECK (guide_dispatch_manifest_valid("manifest") IS TRUE),
  "revision" integer NOT NULL CHECK ("revision" BETWEEN 1 AND 128),
  "headSha256" text NOT NULL CHECK ("headSha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "GuideDispatchStream_fiscal_identity" UNIQUE ("issuerRuc","guideType","fullNumber"),
  CHECK ("manifest"->'key' = jsonb_build_object('companyId',"companyId",'issuerRuc',"issuerRuc",'operationId',"operationId"::text)),
  CHECK ("manifest"->>'documentId'="documentId"::text AND "manifest"->>'guideType'="guideType" AND
    "manifest"->>'fullNumber'="fullNumber")
);
CREATE TABLE "GuideDispatchEvent" (
  "operationId" uuid NOT NULL REFERENCES "GuideDispatchStream"("operationId"),
  "version" integer NOT NULL CHECK ("version" BETWEEN 1 AND 128),
  "payload" jsonb NOT NULL CHECK (guide_dispatch_event_valid("payload") IS TRUE),
  "hash" text NOT NULL CHECK ("hash" ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY ("operationId","version"),
  UNIQUE ("operationId","version","hash"),
  CHECK ("payload"->>'operationId'="operationId"::text AND "payload"->'version'=to_jsonb("version") AND
    "payload"->>'sha256'="hash")
);
ALTER TABLE "GuideDispatchStream" ADD CONSTRAINT "GuideDispatchStream_head_event"
  FOREIGN KEY ("operationId","revision","headSha256")
  REFERENCES "GuideDispatchEvent"("operationId","version","hash") DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION guide_dispatch_stream_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."revision"<>1 THEN RAISE EXCEPTION 'GUIDE_DISPATCH_ROOT_REGISTER_REQUIRED'; END IF;
  ELSIF (to_jsonb(NEW)-'revision'-'headSha256') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'headSha256') OR
    NEW."revision"<>OLD."revision"+1 OR NEW."headSha256"=OLD."headSha256" THEN
    RAISE EXCEPTION 'GUIDE_DISPATCH_STREAM_IDENTITY_OR_REVISION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_dispatch_stream_guard BEFORE INSERT OR UPDATE ON "GuideDispatchStream"
  FOR EACH ROW EXECUTE FUNCTION guide_dispatch_stream_guard();

CREATE FUNCTION guide_dispatch_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root "GuideDispatchStream"%ROWTYPE; prior "GuideDispatchEvent"%ROWTYPE;
BEGIN
  SELECT * INTO root FROM "GuideDispatchStream" WHERE "operationId"=NEW."operationId" FOR UPDATE;
  IF NOT FOUND OR root."revision"<>NEW."version" OR root."headSha256"<>NEW."hash" THEN
    RAISE EXCEPTION 'GUIDE_DISPATCH_HEAD_BEFORE_APPEND_REQUIRED';
  END IF;
  IF NEW."version"=1 THEN
    IF NEW."payload"->>'kind'<>'REGISTER' OR
      NEW."payload"->'data'->>'manifestSha256'<>guide_dispatch_sha(root."manifest") THEN
      RAISE EXCEPTION 'GUIDE_DISPATCH_REGISTER_MANIFEST_MISMATCH';
    END IF;
  ELSE
    SELECT * INTO prior FROM "GuideDispatchEvent" WHERE "operationId"=NEW."operationId" AND "version"=NEW."version"-1;
    IF NOT FOUND OR NEW."payload"->>'previousSha256'<>prior."hash" OR
      NEW."payload"->>'at'<prior."payload"->>'at' THEN
      RAISE EXCEPTION 'GUIDE_DISPATCH_EVENT_PREDECESSOR_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guide_dispatch_event_guard BEFORE INSERT ON "GuideDispatchEvent"
  FOR EACH ROW EXECUTE FUNCTION guide_dispatch_event_guard();

CREATE FUNCTION guide_dispatch_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GUIDE_DISPATCH_IMMUTABLE'; END $$;
CREATE TRIGGER guide_dispatch_event_immutable BEFORE UPDATE OR DELETE ON "GuideDispatchEvent"
  FOR EACH ROW EXECUTE FUNCTION guide_dispatch_forbid_mutation();
CREATE TRIGGER guide_dispatch_stream_no_delete BEFORE DELETE ON "GuideDispatchStream"
  FOR EACH ROW EXECUTE FUNCTION guide_dispatch_forbid_mutation();
CREATE TRIGGER guide_dispatch_event_no_truncate BEFORE TRUNCATE ON "GuideDispatchEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION guide_dispatch_forbid_mutation();
CREATE TRIGGER guide_dispatch_stream_no_truncate BEFORE TRUNCATE ON "GuideDispatchStream"
  FOR EACH STATEMENT EXECUTE FUNCTION guide_dispatch_forbid_mutation();
COMMIT;
