-- CANDIDATE ONLY: NEW isolated test database; no runtime install or existing migration.
CREATE FUNCTION factuez_received_automation_policy(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p)='object' AND (SELECT count(*)=7 FROM jsonb_object_keys(p))
 AND p ?& ARRAY['scope','subject','action','clientRevision','userAuthRevision','active','revision']
 AND jsonb_typeof(p->'action')='string'
 AND p->>'action' IN ('CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ','LIVE_READ_ONLY','SYNC_EXECUTE')
 AND factuez_received_read_policy((p-'action')||'{"permission":"READ"}'::jsonb) IS TRUE;
$$;
CREATE TABLE "B2bReceivedAutomationGrant" (
 "grantKey" text PRIMARY KEY CHECK("grantKey" ~ '^[a-f0-9]{64}$'),
 "policyId" uuid NOT NULL UNIQUE,
 "policy" jsonb NOT NULL CHECK(factuez_received_automation_policy("policy") IS TRUE),
 "revision" integer NOT NULL CHECK("revision">0 AND "policy"->>'revision'="revision"::text),
 CHECK("grantKey"=factuez_received_write_hash(jsonb_build_object('scope',"policy"->'scope','subject',"policy"->'subject','action',"policy"->'action')))
);
CREATE TABLE "B2bReceivedAutomationPolicyAudit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "policyId" uuid NOT NULL REFERENCES "B2bReceivedAutomationGrant"("policyId"),
 "revision" integer NOT NULL CHECK("revision">0),"adminId" uuid NOT NULL,
 "authRevision" integer NOT NULL CHECK("authRevision">=0),
 "policySha256" text NOT NULL CHECK("policySha256" ~ '^[a-f0-9]{64}$'),
 "requestSha256" text NOT NULL CHECK("requestSha256" ~ '^[a-f0-9]{64}$'),
 "createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("policyId","revision")
);
CREATE TRIGGER received_automation_policy_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedAutomationPolicyAudit"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_automation_policy_cas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW."grantKey"<>OLD."grantKey" OR NEW."policyId"<>OLD."policyId" OR NEW."revision"<>OLD."revision"+1
 OR NEW."policy"->'scope'<>OLD."policy"->'scope' OR NEW."policy"->'subject'<>OLD."policy"->'subject' OR NEW."policy"->'action'<>OLD."policy"->'action' THEN
 RAISE EXCEPTION 'RECEIVED_WRITE_POLICY_CAS_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_automation_policy_cas BEFORE UPDATE OR DELETE ON "B2bReceivedAutomationGrant"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_policy_cas();
CREATE TRIGGER received_automation_policy_no_truncate BEFORE TRUNCATE ON "B2bReceivedAutomationGrant"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_automation_policy_audited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "B2bReceivedAutomationPolicyAudit" a WHERE a."policyId"=NEW."policyId" AND a."revision"=NEW."revision"
 AND a."policySha256"=factuez_received_write_hash(NEW."policy")
 AND a."requestSha256"=factuez_received_write_hash(jsonb_build_object('policy',NEW."policy"-'revision','expectedRevision',NEW."revision"-1))) THEN
 RAISE EXCEPTION 'RECEIVED_WRITE_POLICY_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER received_automation_policy_audited AFTER INSERT OR UPDATE ON "B2bReceivedAutomationGrant"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_policy_audited();
CREATE TABLE "B2bReceivedAutomationAudit" (
 "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "clientId" uuid NOT NULL,"subjectId" uuid,"actorKind" text NOT NULL,
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "action" text NOT NULL CHECK("action" IN ('CONFIG_READ','CONFIG_SAVE','SYNC_CREATE','SYNC_READ')),
 "clientRevision" integer NOT NULL CHECK("clientRevision">0),"userAuthRevision" integer,
 "authority" jsonb NOT NULL CHECK(jsonb_typeof("authority")='array' AND jsonb_array_length("authority") BETWEEN 1 AND 2),
 "adminStamp" text,"resourceId" text,"createdAt" timestamptz NOT NULL DEFAULT now(),
 CHECK(("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL AND "adminStamp" IS NULL AND "action" IN ('SYNC_CREATE','SYNC_READ'))
 OR ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "userAuthRevision" IS NOT NULL AND "userAuthRevision">=0 AND "adminStamp" IS NOT NULL AND "adminStamp" ~ '^[a-f0-9]{64}$'))
);
CREATE TABLE "B2bReceivedAutomationCommand" (
 "key" text PRIMARY KEY CHECK("key" ~ '^[a-f0-9]{64}$'),
 "requestHash" text NOT NULL CHECK("requestHash" ~ '^[a-f0-9]{64}$'),
 "clientId" uuid NOT NULL,"subjectId" uuid,"actorKind" text NOT NULL,
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "action" text NOT NULL CHECK("action" IN ('CONFIG_SAVE','SYNC_CREATE')),
 "result" jsonb NOT NULL CHECK((jsonb_typeof("result")='object' AND "result"->>'fiscalAcceptance'='NOT_VERIFIED'
  AND "result"->'runtimeEnabled'='false'::jsonb AND "result"->'scope'="scope") IS TRUE),
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 CHECK(("actorKind"='SERVICE' AND "subjectId" IS NULL AND "action"='SYNC_CREATE') OR ("actorKind"='USER' AND "subjectId" IS NOT NULL))
);
CREATE TABLE "B2bReceivedAutomationRun" (
 "runId" uuid PRIMARY KEY REFERENCES "ReceptionSyncRun"("id"),
 "clientId" uuid NOT NULL,"subjectId" uuid,"actorKind" text NOT NULL,
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "revision" integer NOT NULL CHECK("revision">0),
 "networkProfile" text NOT NULL CHECK("networkProfile" IN ('LOCAL_ONLY','LIVE_READ_ONLY')),
 "clientRevision" integer NOT NULL CHECK("clientRevision">0),
 "userAuthRevision" integer,
 "createAuthority" jsonb NOT NULL CHECK(jsonb_typeof("createAuthority")='object'),
 "liveAuthority" jsonb CHECK(jsonb_typeof("liveAuthority")='object'),
 "dispatchVersion" integer NOT NULL DEFAULT 1 CHECK("dispatchVersion"=1),
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 CHECK(("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL) OR ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "userAuthRevision">=0 AND "userAuthRevision" IS NOT NULL))
);
CREATE TRIGGER received_automation_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedAutomationAudit"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_automation_command_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedAutomationCommand"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_automation_run_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedAutomationRun"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_automation_connection_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "ReceptionConnectionAudit"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_automation_audit_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a jsonb;g jsonb; n integer;
BEGIN
 FOR n IN 0..jsonb_array_length(NEW."authority")-1 LOOP
  a=NEW."authority"->n;
  IF (jsonb_typeof(a)='object' AND a ?& ARRAY['action','policyId','revision'] AND (SELECT count(*)=3 FROM jsonb_object_keys(a))
   AND jsonb_typeof(a->'revision')='number' AND (CASE WHEN n=0 THEN a->>'action'=NEW."action" ELSE a->>'action'='LIVE_READ_ONLY' END)) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIVED_AUTOMATION_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT "policy" INTO g FROM "B2bReceivedAutomationGrant" WHERE "policyId"=(a->>'policyId')::uuid AND "revision"=(a->>'revision')::integer;
  IF g IS NULL OR g->'active'<>'true'::jsonb OR g->'scope'<>NEW."scope" OR g->>'action'<>a->>'action'
   OR g->'subject' IS DISTINCT FROM jsonb_build_object('kind',NEW."actorKind",'clientId',NEW."clientId",'subjectId',NEW."subjectId")
   OR (g->>'clientRevision')::integer<>NEW."clientRevision" OR g->'userAuthRevision' IS DISTINCT FROM coalesce(to_jsonb(NEW."userAuthRevision"),'null'::jsonb) THEN
   RAISE EXCEPTION 'RECEIVED_AUTOMATION_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_automation_audit_authority BEFORE INSERT ON "B2bReceivedAutomationAudit"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_audit_authority();
ALTER TABLE "ReceptionConnection" ADD CONSTRAINT received_b2b_configuration_staged CHECK("enabled"=false AND "revision">0
 AND "mode" IN ('LOCAL_FIXTURE','LIVE_READ_ONLY') AND jsonb_typeof("settings")='object'
 AND ("mode"<>'LOCAL_FIXTURE' OR "recipientRuc" ~ '^00[0-9]{9}$')
 AND ("encryptedCredentials" IS NULL OR (length("encryptedCredentials")<=11500 AND "encryptedCredentials" ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')));
CREATE FUNCTION factuez_received_automation_connection_cas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW."companyId"<>OLD."companyId" OR NEW."recipientRuc"<>OLD."recipientRuc" OR NEW."revision"<>OLD."revision"+1 THEN
 RAISE EXCEPTION 'RECEIVED_AUTOMATION_CONNECTION_CAS_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_automation_connection_cas BEFORE UPDATE OR DELETE ON "ReceptionConnection"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_connection_cas();
CREATE TRIGGER received_automation_connection_no_truncate BEFORE TRUNCATE ON "ReceptionConnection"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_automation_connection_audited() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "ReceptionConnectionAudit" a WHERE a."companyId"=NEW."companyId" AND a."revision"=NEW."revision" AND a."actorId"=NEW."configuredBy" AND a."action"='CONFIGURATION_SAVED')
 OR NOT EXISTS(SELECT 1 FROM "B2bReceivedAutomationAudit" a WHERE a."action"='CONFIG_SAVE' AND a."actorKind"='USER' AND a."subjectId"=NEW."configuredBy"
 AND a."scope"->>'companyId'=NEW."companyId"::text AND a."scope"->>'recipientRuc'=NEW."recipientRuc" AND a."resourceId"=NEW."revision"::text) THEN
 RAISE EXCEPTION 'RECEIVED_AUTOMATION_CONNECTION_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER received_automation_connection_audited AFTER INSERT OR UPDATE ON "ReceptionConnection"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_connection_audited();
CREATE FUNCTION factuez_received_automation_run_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."liveAuthority" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "B2bReceivedAutomationGrant" g
  WHERE g."policyId"=(NEW."liveAuthority"->>'policyId')::uuid AND g."revision"=(NEW."liveAuthority"->>'revision')::integer
  AND g."policy"->>'action'='LIVE_READ_ONLY' AND g."policy"->'active'='true'::jsonb AND g."policy"->'scope'=NEW."scope"
  AND g."policy"->'subject'=jsonb_build_object('kind',NEW."actorKind",'clientId',NEW."clientId",'subjectId',NEW."subjectId")
  AND g."policy"->>'clientRevision'=NEW."clientRevision"::text AND g."policy"->'userAuthRevision'=coalesce(to_jsonb(NEW."userAuthRevision"),'null'::jsonb)) THEN
  RAISE EXCEPTION 'RECEIVED_AUTOMATION_LIVE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM "ReceptionConnection" c WHERE c."companyId"=(NEW."scope"->>'companyId')::integer AND c."mode"='LIVE_READ_ONLY') AND NEW."liveAuthority" IS NULL THEN
  RAISE EXCEPTION 'RECEIVED_AUTOMATION_LIVE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 IF (jsonb_typeof(NEW."createAuthority")='object' AND NEW."createAuthority" ?& ARRAY['policyId','revision']
  AND NEW."createAuthority"-ARRAY['policyId','revision']='{}'::jsonb) IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM "B2bReceivedAutomationGrant" g
  WHERE g."policyId"=(NEW."createAuthority"->>'policyId')::uuid AND g."revision"=(NEW."createAuthority"->>'revision')::integer
  AND g."policy"->>'action'='SYNC_CREATE' AND g."policy"->'active'='true'::jsonb AND g."policy"->'scope'=NEW."scope"
  AND g."policy"->'subject'=jsonb_build_object('kind',NEW."actorKind",'clientId',NEW."clientId",'subjectId',NEW."subjectId")
  AND g."policy"->>'clientRevision'=NEW."clientRevision"::text
  AND g."policy"->'userAuthRevision'=coalesce(to_jsonb(NEW."userAuthRevision"),'null'::jsonb)) THEN
  RAISE EXCEPTION 'RECEIVED_AUTOMATION_CREATE_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM "ReceptionSyncRun" r JOIN "ReceptionConnection" c ON c."companyId"=r."companyId"
  WHERE r."id"=NEW."runId" AND r."companyId"=(NEW."scope"->>'companyId')::integer AND r."recipientRuc"=NEW."scope"->>'recipientRuc'
  AND r."revision"=NEW."revision" AND c."revision"=r."revision" AND c."recipientRuc"=r."recipientRuc" AND c."enabled"=false
  AND (c."mode"='LIVE_READ_ONLY' AND NEW."networkProfile"='LIVE_READ_ONLY' OR c."mode"='LOCAL_FIXTURE' AND c."recipientRuc" ~ '^00[0-9]{9}$')) THEN
 RAISE EXCEPTION 'RECEIVED_AUTOMATION_RUN_MEMBERSHIP_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_automation_run_membership BEFORE INSERT ON "B2bReceivedAutomationRun"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_automation_run_membership();
-- Replay envelopes contain only explicitly public metadata, never secret/cipher fields.
ALTER TABLE "B2bReceivedAutomationCommand" ADD CONSTRAINT received_automation_result_fields CHECK((
 CASE WHEN "action"='CONFIG_SAVE' THEN
  "result" ?& ARRAY['scope','revision','updatedAt','settings','credentialPresence','state','runtimeEnabled','networkProfile','fiscalAcceptance']
  AND "result"-ARRAY['scope','revision','updatedAt','settings','credentialPresence','state','runtimeEnabled','networkProfile','fiscalAcceptance']='{}'::jsonb
  AND "result"->>'state' IN ('DISABLED','STAGED_LOCAL','STAGED_READ_ONLY','WAITING_TI')
 ELSE
  "result" ?& ARRAY['scope','items','mode','networkProfile','runtimeEnabled','fiscalAcceptance']
  AND "result"-ARRAY['scope','items','mode','networkProfile','runtimeEnabled','fiscalAcceptance']='{}'::jsonb
  AND jsonb_typeof("result"->'items')='array' AND jsonb_array_length("result"->'items') BETWEEN 1 AND 2
 END AND "result"->>'networkProfile' IN ('LOCAL_ONLY','LIVE_READ_ONLY')
) IS TRUE);
