-- Candidate only. Apply to a NEW isolated reception database for testing.
-- No application bootstrap, cross-owner FK, numbering, fiscal state or Outbox.
CREATE FUNCTION factuez_received_read_scope(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p)='object' AND (SELECT count(*)=4 FROM jsonb_object_keys(p))
    AND p ?& ARRAY['environment','companyId','recipientRuc','branchId']
    AND jsonb_typeof(p->'environment')='string' AND p->>'environment'='BETA'
    AND jsonb_typeof(p->'companyId')='number' AND p->>'companyId' ~ '^[1-9][0-9]{0,9}$'
    AND (p->>'companyId')::numeric BETWEEN 1 AND 2147483647
    AND jsonb_typeof(p->'recipientRuc')='string' AND p->>'recipientRuc' ~ '^[0-9]{11}$'
    AND jsonb_typeof(p->'branchId')='string'
    AND p->>'branchId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
$$;
CREATE FUNCTION factuez_received_read_policy(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p)='object' AND (SELECT count(*)=7 FROM jsonb_object_keys(p))
    AND p ?& ARRAY['scope','subject','permission','clientRevision','userAuthRevision','active','revision']
    AND factuez_received_read_scope(p->'scope') IS TRUE
    AND jsonb_typeof(p->'subject')='object' AND (SELECT count(*)=3 FROM jsonb_object_keys(p->'subject'))
    AND p->'subject' ?& ARRAY['kind','clientId','subjectId']
    AND jsonb_typeof(p->'subject'->'kind')='string' AND jsonb_typeof(p->'subject'->'clientId')='string'
    AND p->'subject'->>'clientId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND ((p->'subject'->>'kind'='SERVICE' AND p->'subject'->'subjectId'='null'::jsonb AND p->'userAuthRevision'='null'::jsonb)
      OR (p->'subject'->>'kind'='USER' AND jsonb_typeof(p->'subject'->'subjectId')='string'
        AND p->'subject'->>'subjectId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        AND jsonb_typeof(p->'userAuthRevision')='number' AND p->>'userAuthRevision' ~ '^(0|[1-9][0-9]{0,9})$'
        AND (p->>'userAuthRevision')::numeric<=2147483647))
    AND jsonb_typeof(p->'permission')='string' AND p->>'permission' IN ('READ','ARTIFACT') AND jsonb_typeof(p->'active')='boolean'
    AND jsonb_typeof(p->'clientRevision')='number' AND p->>'clientRevision' ~ '^[1-9][0-9]{0,9}$'
    AND (p->>'clientRevision')::numeric<=2147483647
    AND jsonb_typeof(p->'revision')='number' AND p->>'revision' ~ '^[1-9][0-9]{0,9}$'
    AND (p->>'revision')::numeric<=2147483647;
$$;
CREATE TABLE "B2bReceivedReadGrant" (
  "grantKey" text PRIMARY KEY CHECK ("grantKey" ~ '^[a-f0-9]{64}$'),
  "policy" jsonb NOT NULL CHECK (factuez_received_read_policy("policy") IS TRUE),
  "revision" integer NOT NULL CHECK ("revision">0 AND "policy"->>'revision'="revision"::text)
);
CREATE TABLE "B2bReceivedPolicyAudit" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "grantKey" text NOT NULL REFERENCES "B2bReceivedReadGrant"("grantKey"),
  "revision" integer NOT NULL CHECK ("revision">0),"adminId" uuid NOT NULL,
  "policySha256" text NOT NULL CHECK ("policySha256" ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("grantKey","revision")
);
CREATE TABLE "B2bReceivedReadAudit" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"clientId" uuid NOT NULL,"subjectId" uuid,
  "actorKind" text NOT NULL CHECK ("actorKind" IN ('SERVICE','USER')),
  "scope" jsonb NOT NULL CHECK (factuez_received_read_scope("scope") IS TRUE),
  "action" text NOT NULL CHECK ("action" IN ('LIST','DETAIL','ARTIFACTS','CONTENT')),
  "documentId" uuid,"artifactId" uuid,"clientRevision" integer NOT NULL CHECK ("clientRevision">0),"userAuthRevision" integer,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL)
    OR ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "userAuthRevision" IS NOT NULL AND "userAuthRevision">=0)),
  CHECK (("action"='LIST' AND "documentId" IS NULL AND "artifactId" IS NULL)
    OR ("action" IN ('DETAIL','ARTIFACTS') AND "documentId" IS NOT NULL AND "artifactId" IS NULL)
    OR ("action"='CONTENT' AND "documentId" IS NOT NULL AND "artifactId" IS NOT NULL))
);
CREATE FUNCTION factuez_received_audit_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."documentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ReceivedDocument" d WHERE d."id"=NEW."documentId"
      AND d."companyId"=(NEW."scope"->>'companyId')::integer
      AND d."recipientRuc"=NEW."scope"->>'recipientRuc' AND d."branchId"=(NEW."scope"->>'branchId')::uuid
  ) THEN RAISE EXCEPTION 'RECEIVED_AUDIT_MEMBERSHIP_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW."artifactId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ReceivedArtifact" a WHERE a."id"=NEW."artifactId" AND a."documentId"=NEW."documentId"
  ) THEN RAISE EXCEPTION 'RECEIVED_AUDIT_MEMBERSHIP_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER received_audit_membership BEFORE INSERT ON "B2bReceivedReadAudit"
  FOR EACH ROW EXECUTE FUNCTION factuez_received_audit_membership();
CREATE FUNCTION factuez_received_read_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'RECEIVED_READ_AUDIT_IMMUTABLE' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER received_read_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedReadAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_policy_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedPolicyAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_policy_cas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR NEW."grantKey"<>OLD."grantKey" OR NEW."revision"<>OLD."revision"+1
    OR NEW."policy"->'scope'<>OLD."policy"->'scope' OR NEW."policy"->'subject'<>OLD."policy"->'subject'
    OR NEW."policy"->>'permission'<>OLD."policy"->>'permission' THEN
    RAISE EXCEPTION 'RECEIVED_POLICY_IDENTITY_AND_CAS_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER received_policy_cas BEFORE UPDATE OR DELETE ON "B2bReceivedReadGrant"
  FOR EACH ROW EXECUTE FUNCTION factuez_received_policy_cas();
CREATE TRIGGER received_policy_no_truncate BEFORE TRUNCATE ON "B2bReceivedReadGrant"
  FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_policy_audited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM "B2bReceivedPolicyAudit" a WHERE a."grantKey"=NEW."grantKey" AND a."revision"=NEW."revision") THEN
    RAISE EXCEPTION 'RECEIVED_POLICY_AUDIT_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER received_policy_audited AFTER INSERT OR UPDATE ON "B2bReceivedReadGrant"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_received_policy_audited();

-- Candidate NEW database only. pg_restore uses a restricted session search_path;
-- validators/triggers must resolve their own functions and owner tables safely.
-- Explicit pg_temp LAST also prevents temporary relations shadowing public facts.
ALTER FUNCTION factuez_received_read_scope(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_read_policy(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_audit_membership() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_read_immutable() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_policy_cas() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION factuez_received_policy_audited() SET search_path = pg_catalog, public, pg_temp;
