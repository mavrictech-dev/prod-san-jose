-- CANDIDATE ONLY: owned NEW network-none/tmpfs PostgreSQL test database.
-- No bootstrap DDL, existing QA changes, live SIRE or mailbox activation.
CREATE TABLE "B2bReceivedDispatchAttempt" (
 "id" uuid PRIMARY KEY,"runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),
 "attempt" integer NOT NULL CHECK("attempt" BETWEEN 1 AND 3),
 "status" text NOT NULL CHECK("status" IN ('COMPLETED','BLOCKED','FAILED','RETRY')),
 "errorCode" text CHECK("errorCode" IN ('CONFIGURATION_CHANGED','CONNECTION_NOT_READY','CONNECTION_OR_SCOPE_CHANGED','CONNECTOR_UNAVAILABLE')),
 "counters" jsonb NOT NULL,"authoritySha256" text CHECK("authoritySha256" ~ '^[a-f0-9]{64}$'),"executionAuthority" jsonb,
 "createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("runId","attempt"),
 CHECK(("status"='COMPLETED' AND "errorCode" IS NULL AND "authoritySha256" IS NOT NULL AND "executionAuthority" IS NOT NULL AND "authoritySha256"=factuez_received_write_hash("executionAuthority"))
  OR ("status"<>'COMPLETED' AND "errorCode" IS NOT NULL AND "authoritySha256" IS NULL AND "executionAuthority" IS NULL)),
 CHECK((jsonb_typeof("counters")='object' AND "counters" ?& ARRAY['detected','imported','duplicate','rejected','xmlPending','matches','mismatches']
  AND "counters"-ARRAY['detected','imported','duplicate','rejected','xmlPending','matches','mismatches']='{}'::jsonb) IS TRUE)
);
CREATE TABLE "B2bReceivedDispatchObservation" (
 "runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),"ordinal" integer NOT NULL CHECK("ordinal" BETWEEN 0 AND 99),
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "recordKey" text NOT NULL CHECK("recordKey" ~ '^[a-f0-9]{64}$'),
 "recordSha256" text NOT NULL CHECK("recordSha256"=factuez_received_write_hash("record")),
 "record" jsonb NOT NULL,"documentId" uuid REFERENCES "ReceivedDocument"("id"),
 "comparison" text NOT NULL CHECK("comparison" IN ('PENDING','MATCHED','CONFLICT')),
 PRIMARY KEY("runId","ordinal"),UNIQUE("runId","recordKey"),
 CHECK(("comparison"='PENDING' AND "documentId" IS NULL) OR ("comparison"<>'PENDING' AND "documentId" IS NOT NULL))
);
CREATE INDEX received_dispatch_observation_scope ON "B2bReceivedDispatchObservation" USING gin("scope");
CREATE TRIGGER received_dispatch_attempt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedDispatchAttempt"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_dispatch_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedDispatchObservation"
 FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_dispatch_observation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId"
  WHERE a."runId"=NEW."runId" AND a."scope"=NEW."scope" AND r."source"='SIRE' AND r."status"='RUNNING')
 OR NEW."record"->>'recipientRuc' IS DISTINCT FROM NEW."scope"->>'recipientRuc'
 OR (NEW."scope"->>'recipientRuc' ~ '^00[0-9]{9}$') IS NOT TRUE
 OR (NEW."record"->>'supplierRuc' ~ '^00[0-9]{9}$') IS NOT TRUE
 OR NEW."recordKey" IS DISTINCT FROM factuez_received_write_hash(jsonb_build_object('period',NEW."record"->'period','supplierRuc',NEW."record"->'supplierRuc','documentType',NEW."record"->'documentType','series',NEW."record"->'series','number',NEW."record"->'number'))
 OR (NEW."documentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "ReceivedDocument" d WHERE d."id"=NEW."documentId"
  AND d."companyId"=(NEW."scope"->>'companyId')::integer AND d."recipientRuc"=NEW."scope"->>'recipientRuc' AND d."branchId"=(NEW."scope"->>'branchId')::uuid)) THEN
  RAISE EXCEPTION 'RECEIVED_DISPATCH_OBSERVATION_SCOPE_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_dispatch_observation_scope BEFORE INSERT ON "B2bReceivedDispatchObservation"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_dispatch_observation_scope();
CREATE FUNCTION factuez_received_dispatch_attempt_valid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record;g jsonb;v jsonb;perm text;entry jsonb;
BEGIN
 FOR entry IN SELECT value FROM jsonb_each(NEW."counters") LOOP
  IF (jsonb_typeof(entry)='number' AND entry::text ~ '^(0|[1-9][0-9]{0,9})$' AND entry::numeric<=2147483647) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIVED_DISPATCH_COUNTER_REQUIRED' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT m.*,r."source" AS "runSource",r."status" AS "runStatus",r."counters" AS "runCounters",r."errorCode" AS "runError" INTO a
  FROM "B2bReceivedAutomationRun" m JOIN "ReceptionSyncRun" r ON r."id"=m."runId" WHERE m."runId"=NEW."runId";
 IF a IS NULL OR a."runStatus" IS DISTINCT FROM (CASE WHEN NEW."status"='RETRY' THEN 'QUEUED' ELSE NEW."status" END)
 OR a."runError" IS DISTINCT FROM NEW."errorCode" OR a."runCounters" IS DISTINCT FROM NEW."counters"
 OR NEW."attempt"<>(SELECT count(*)+1 FROM "B2bReceivedDispatchAttempt" WHERE "runId"=NEW."runId") THEN
  RAISE EXCEPTION 'RECEIVED_DISPATCH_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 IF NEW."status"='COMPLETED' THEN
  v=NEW."executionAuthority";
  IF (jsonb_typeof(v)='object' AND v ?& ARRAY['executionId','contextSha256','expiresAt','administrator','create','execute']
   AND v-ARRAY['executionId','contextSha256','expiresAt','administrator','create','execute']='{}'::jsonb
   AND v->>'contextSha256'=factuez_received_write_hash(jsonb_build_object('runId',a."runId",'scope',a."scope",'source',a."runSource",'revision',a."revision",
    'actor',jsonb_build_object('kind',a."actorKind",'clientId',a."clientId",'subjectId',a."subjectId",'clientRevision',a."clientRevision",'userAuthRevision',a."userAuthRevision")))
   AND (v->>'expiresAt')::timestamptz>clock_timestamp() AND (v->>'expiresAt')::timestamptz<=clock_timestamp()+interval '5 minutes'
   AND ((a."actorKind"='SERVICE' AND v->'administrator'='null'::jsonb) OR (a."actorKind"='USER'
    AND v->'administrator'=jsonb_build_object('adminId',a."subjectId",'authRevision',a."userAuthRevision",'authority','GLOBAL_ADMIN')))) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIVED_DISPATCH_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
  FOREACH perm IN ARRAY ARRAY['create','execute'] LOOP
   SELECT "policy" INTO g FROM "B2bReceivedAutomationGrant" WHERE "policyId"=(v->perm->>'policyId')::uuid AND "revision"=(v->perm->>'revision')::integer;
   IF g IS NULL OR g->'active' IS DISTINCT FROM 'true'::jsonb OR g->>'action' IS DISTINCT FROM (CASE WHEN perm='create' THEN 'SYNC_CREATE' ELSE 'SYNC_EXECUTE' END)
    OR g->'scope' IS DISTINCT FROM a."scope" OR g->'subject' IS DISTINCT FROM jsonb_build_object('kind',a."actorKind",'clientId',a."clientId",'subjectId',a."subjectId")
    OR g->>'clientRevision' IS DISTINCT FROM a."clientRevision"::text OR g->'userAuthRevision' IS DISTINCT FROM coalesce(to_jsonb(a."userAuthRevision"),'null'::jsonb) THEN
    RAISE EXCEPTION 'RECEIVED_DISPATCH_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_dispatch_attempt_valid BEFORE INSERT ON "B2bReceivedDispatchAttempt"
 FOR EACH ROW EXECUTE FUNCTION factuez_received_dispatch_attempt_valid();
