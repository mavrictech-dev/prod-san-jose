-- CANDIDATE ONLY: install through the owned NEW network-none/tmpfs test helper.
-- Never applied by application bootstrap, existing migrations or QA.
CREATE FUNCTION factuez_received_write_canonical(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
 IF jsonb_typeof(p)='object' THEN
  SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||factuez_received_write_canonical(value),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(p);
 ELSIF jsonb_typeof(p)='array' THEN
  SELECT '['||coalesce(string_agg(factuez_received_write_canonical(value),',' ORDER BY ordinal),'')||']' INTO result FROM jsonb_array_elements(p) WITH ORDINALITY AS a(value,ordinal);
 ELSE result=p::text; END IF;
 RETURN result;
END;
$$;
CREATE FUNCTION factuez_received_write_hash(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(factuez_received_write_canonical(p),'UTF8')),'hex');
$$;
CREATE FUNCTION factuez_received_write_policy(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p)='object' AND (SELECT count(*)=7 FROM jsonb_object_keys(p))
 AND p ?& ARRAY['scope','subject','action','clientRevision','userAuthRevision','active','revision']
 AND jsonb_typeof(p->'action')='string'
 AND p->>'action' IN ('IMPORT','ATTACH','ASSIGN','REGISTER')
 AND factuez_received_read_policy((p-'action')||'{"permission":"READ"}'::jsonb) IS TRUE;
$$;
CREATE TABLE "B2bReceivedWriteGrant" (
 "grantKey" text PRIMARY KEY CHECK("grantKey" ~ '^[a-f0-9]{64}$'),
 "policyId" uuid NOT NULL UNIQUE,
 "policy" jsonb NOT NULL CHECK(factuez_received_write_policy("policy") IS TRUE),
 "revision" integer NOT NULL CHECK("revision">0 AND "policy"->>'revision'="revision"::text),
 CHECK("grantKey"=factuez_received_write_hash(jsonb_build_object('scope',"policy"->'scope','subject',"policy"->'subject','action',"policy"->'action')))
);
CREATE TABLE "B2bReceivedWritePolicyAudit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "policyId" uuid NOT NULL REFERENCES "B2bReceivedWriteGrant"("policyId"),
 "revision" integer NOT NULL CHECK("revision">0),"adminId" uuid NOT NULL,
 "authRevision" integer NOT NULL CHECK("authRevision">=0),
 "policySha256" text NOT NULL CHECK("policySha256" ~ '^[a-f0-9]{64}$'),
 "requestSha256" text NOT NULL CHECK("requestSha256" ~ '^[a-f0-9]{64}$'),
 "createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("policyId","revision")
);
CREATE TRIGGER received_write_policy_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedWritePolicyAudit"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_write_policy_cas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW."grantKey"<>OLD."grantKey" OR NEW."policyId"<>OLD."policyId" OR NEW."revision"<>OLD."revision"+1
 OR NEW."policy"->'scope'<>OLD."policy"->'scope' OR NEW."policy"->'subject'<>OLD."policy"->'subject' OR NEW."policy"->'action'<>OLD."policy"->'action' THEN
 RAISE EXCEPTION 'RECEIVED_WRITE_POLICY_CAS_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_write_policy_cas BEFORE UPDATE OR DELETE ON "B2bReceivedWriteGrant"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_write_policy_cas();
CREATE TRIGGER received_write_policy_no_truncate BEFORE TRUNCATE ON "B2bReceivedWriteGrant"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_write_policy_audited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "B2bReceivedWritePolicyAudit" a WHERE a."policyId"=NEW."policyId" AND a."revision"=NEW."revision"
 AND a."policySha256"=factuez_received_write_hash(NEW."policy")
 AND a."requestSha256"=factuez_received_write_hash(jsonb_build_object('policy',NEW."policy"-'revision','expectedRevision',NEW."revision"-1))) THEN
 RAISE EXCEPTION 'RECEIVED_WRITE_POLICY_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER received_write_policy_audited AFTER INSERT OR UPDATE ON "B2bReceivedWriteGrant"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_received_write_policy_audited();
CREATE TABLE "B2bReceivedCommand" (
 "key" text PRIMARY KEY CHECK("key" ~ '^[a-f0-9]{64}$'),
 "requestHash" text NOT NULL CHECK("requestHash" ~ '^[a-f0-9]{64}$'),
 "clientId" uuid NOT NULL,"subjectId" uuid,"actorKind" text NOT NULL,
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "action" text NOT NULL CHECK("action" IN ('IMPORT','ATTACH','ASSIGN','REGISTER')),
 "clientRevision" integer NOT NULL CHECK("clientRevision">0),"userAuthRevision" integer,
 "authority" jsonb NOT NULL CHECK(jsonb_typeof("authority")='array' AND jsonb_array_length("authority") BETWEEN 1 AND 2),
 "result" jsonb NOT NULL CHECK(jsonb_typeof("result")='object' AND "result"->>'fiscalAcceptance'='NOT_VERIFIED'
  AND "result" ?& ARRAY['documentId','outcome','fiscalAcceptance']
  AND "result"->>'documentId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  AND (("action"='IMPORT' AND "result"->>'outcome' IN ('IMPORTED','DUPLICATE')) OR ("action"='ATTACH' AND "result"->>'outcome'='ATTACHED')
    OR ("action"='ASSIGN' AND "result"->>'outcome'='ASSIGNED') OR ("action"='REGISTER' AND "result"->>'outcome'='REGISTERED'))),
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 CHECK(("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL) OR
  ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "userAuthRevision" IS NOT NULL AND "userAuthRevision">=0))
);
CREATE TRIGGER received_command_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedCommand"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_command_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jsonb; expected_scope jsonb; g jsonb; r integer;
BEGIN
 IF jsonb_array_length(NEW."authority")<>(CASE WHEN NEW."action"='ASSIGN' THEN 2 ELSE 1 END) THEN
 RAISE EXCEPTION 'RECEIVED_WRITE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 FOR r IN 0..jsonb_array_length(NEW."authority")-1 LOOP
  a=NEW."authority"->r;
  expected_scope=CASE WHEN r=0 THEN NEW."scope" ELSE jsonb_set(NEW."scope",'{branchId}',NEW."result"->'branchId') END;
  IF jsonb_typeof(a)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(a))<>3
   OR jsonb_typeof(a->'policyId') IS DISTINCT FROM 'string' OR jsonb_typeof(a->'revision') IS DISTINCT FROM 'number'
   OR (a->>'revision' ~ '^[1-9][0-9]{0,9}$') IS NOT TRUE OR factuez_received_read_scope(a->'scope') IS NOT TRUE
   OR a->'scope' IS DISTINCT FROM expected_scope
   OR expected_scope IS NULL OR r=1 AND a->'scope'->'branchId'=NEW."scope"->'branchId' THEN
   RAISE EXCEPTION 'RECEIVED_WRITE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT "policy" INTO g FROM "B2bReceivedWriteGrant" WHERE "policyId"=(a->>'policyId')::uuid AND "revision"=(a->>'revision')::integer;
  IF g IS NULL OR g->'active'<>'true'::jsonb OR g->'scope' IS DISTINCT FROM expected_scope OR g->>'action'<>NEW."action"
   OR g->'subject' IS DISTINCT FROM jsonb_build_object('kind',NEW."actorKind",'clientId',NEW."clientId",'subjectId',NEW."subjectId")
   OR (g->>'clientRevision')::integer<>NEW."clientRevision" OR g->'userAuthRevision' IS DISTINCT FROM coalesce(to_jsonb(NEW."userAuthRevision"),'null'::jsonb) THEN
   RAISE EXCEPTION 'RECEIVED_WRITE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 END LOOP;
 expected_scope=NEW."authority"->(jsonb_array_length(NEW."authority")-1)->'scope';
 IF NOT EXISTS(SELECT 1 FROM "ReceivedDocument" d WHERE d."id"=(NEW."result"->>'documentId')::uuid
  AND d."companyId"=(expected_scope->>'companyId')::integer AND d."recipientRuc"=expected_scope->>'recipientRuc' AND d."branchId"=(expected_scope->>'branchId')::uuid) THEN
  RAISE EXCEPTION 'RECEIVED_COMMAND_MEMBERSHIP_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_command_authority BEFORE INSERT ON "B2bReceivedCommand"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_command_authority();
-- Immutable provider facts: assignment and ERP registration may only change
-- their own columns; they cannot reset a fiscal fact or replace an original.
CREATE FUNCTION factuez_received_document_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['branchId','registeredAt','erpReference']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['branchId','registeredAt','erpReference']) THEN
 RAISE EXCEPTION 'RECEIVED_FISCAL_FACTS_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_document_facts BEFORE UPDATE OR DELETE ON "ReceivedDocument"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_document_facts();
CREATE TRIGGER received_document_no_truncate BEFORE TRUNCATE ON "ReceivedDocument"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
ALTER TABLE "ReceivedArtifact" ADD CONSTRAINT received_artifact_bounded CHECK("kind" IN ('XML','CDR','PROVIDER_PDF') AND "byteLength" BETWEEN 1 AND 65536
 AND octet_length("bytes")="byteLength" AND "sha256"=encode(sha256("bytes"),'hex'));
CREATE UNIQUE INDEX received_one_original ON "ReceivedArtifact"("documentId") WHERE "kind"='XML';
CREATE TRIGGER received_original_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ReceivedArtifact"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_item_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ReceivedItemRecord"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_original_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(*) FROM "ReceivedArtifact" WHERE "documentId"=NEW."id" AND "kind"='XML' AND "sha256"=NEW."xmlSha256")<>1
 OR (SELECT count(*) FROM "ReceivedItemRecord" WHERE "documentId"=NEW."id")<>jsonb_array_length(NEW."projection"->'items') THEN
 RAISE EXCEPTION 'RECEIVED_ORIGINAL_AND_ITEMS_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER received_original_complete AFTER INSERT ON "ReceivedDocument"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_received_original_complete();
CREATE FUNCTION factuez_received_item_matches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
 SELECT "projection"->'items'->NEW."ordinal" INTO item FROM "ReceivedDocument" WHERE "id"=NEW."documentId";
 IF NEW."ordinal"<0 OR item IS NULL OR item IS DISTINCT FROM NEW."detail"
 OR (item->>'supplierCode') IS DISTINCT FROM NEW."supplierCode" OR (item->>'sunatCode') IS DISTINCT FROM NEW."sunatCode"
 OR (item->>'description') IS DISTINCT FROM NEW."description" OR (item->>'quantity') IS DISTINCT FROM NEW."quantity"
 OR (item->>'unitCode') IS DISTINCT FROM NEW."unitCode" OR (item->>'unitValue') IS DISTINCT FROM NEW."unitValue"
 OR (item->>'unitPrice') IS DISTINCT FROM NEW."unitPrice" OR (item->>'lineExtensionAmount') IS DISTINCT FROM NEW."amount" THEN
 RAISE EXCEPTION 'RECEIVED_ITEM_PROJECTION_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_item_matches BEFORE INSERT ON "ReceivedItemRecord"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_item_matches();

-- SQL CHECK accepts UNKNOWN by default: require true for every response fact
-- so JSON null and extra keys cannot masquerade as a finite owner result.
ALTER TABLE "B2bReceivedCommand" ADD CONSTRAINT received_command_result_exact CHECK((
 jsonb_typeof("result"->'documentId')='string' AND jsonb_typeof("result"->'outcome')='string'
 AND jsonb_typeof("result"->'fiscalAcceptance')='string' AND "result"->>'fiscalAcceptance'='NOT_VERIFIED'
 AND ("result" - ARRAY['documentId','outcome','fiscalAcceptance'] - CASE WHEN "action"='ASSIGN' THEN ARRAY['branchId'] ELSE ARRAY[]::text[] END)='{}'::jsonb
 AND ("action"<>'ASSIGN' OR (jsonb_typeof("result"->'branchId')='string'
  AND "result"->>'branchId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
) IS TRUE);

-- Independent of the caller/pg_restore session. No constraint, trigger, audit
-- requirement or grant is disabled. Existing installations need reviewed DDL.
ALTER FUNCTION factuez_received_write_canonical(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_write_hash(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_write_policy(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_write_policy_cas() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_write_policy_audited() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_command_authority() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_document_facts() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_original_complete() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_item_matches() SET search_path = pg_catalog, public, pg_temp;
