-- CANDIDATE ONLY. Install exclusively through the NEW isolated synthetic helper.
-- Does not change LOCAL_FIXTURE guards, enable connections or authorize a pilot.
CREATE TABLE "B2bReceivedReadOnlyAttempt" (
 "runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),"attempt" integer NOT NULL CHECK("attempt" BETWEEN 1 AND 3),
 "status" text NOT NULL CHECK("status" IN ('COMPLETED','BLOCKED','FAILED','RETRY')),
 "errorCode" text CHECK("errorCode" IN ('CONNECTION_OR_SCOPE_CHANGED','CONNECTOR_UNAVAILABLE')),
 "counters" jsonb NOT NULL,"authority" jsonb,"authoritySha256" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("runId","attempt"),
 CHECK(("status"='COMPLETED' AND "errorCode" IS NULL AND "authority" IS NOT NULL AND "authoritySha256"=factuez_received_write_hash("authority"))
  OR ("status"<>'COMPLETED' AND "errorCode" IS NOT NULL AND "authority" IS NULL AND "authoritySha256" IS NULL)),
 CHECK((jsonb_typeof("counters")='object' AND "counters" ?& ARRAY['detected','imported','duplicate','rejected','xmlPending','matches','mismatches']
  AND "counters"-ARRAY['detected','imported','duplicate','rejected','xmlPending','matches','mismatches']='{}'::jsonb) IS TRUE)
);
CREATE TABLE "B2bReceivedReadOnlyObservation" (
 "runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),"ordinal" integer NOT NULL CHECK("ordinal" BETWEEN 0 AND 99),
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),"recordKey" text NOT NULL CHECK("recordKey" ~ '^[a-f0-9]{64}$'),
 "record" jsonb NOT NULL,"recordSha256" text NOT NULL CHECK("recordSha256"=factuez_received_write_hash("record")),
 "documentId" uuid REFERENCES "ReceivedDocument"("id"),"comparison" text NOT NULL CHECK("comparison" IN ('PENDING','MATCHED','CONFLICT')),
 PRIMARY KEY("runId","ordinal"),UNIQUE("runId","recordKey"),
 CHECK(("comparison"='PENDING' AND "documentId" IS NULL) OR ("comparison"<>'PENDING' AND "documentId" IS NOT NULL))
);
CREATE INDEX received_read_only_observation_scope ON "B2bReceivedReadOnlyObservation" USING gin("scope");
CREATE TABLE "B2bReceivedReadOnlyIncident" (
 "runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),"ordinal" integer NOT NULL CHECK("ordinal" BETWEEN 0 AND 99),
 "scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "code" text NOT NULL CHECK("code" IN ('INVALID_MESSAGE','INVALID_DOCUMENT','DOCUMENT_TOO_LARGE','ARTIFACT_UNMATCHED','SIRE_RECORD_REJECTED')),
 "sourceSha256" text NOT NULL CHECK("sourceSha256" ~ '^[a-f0-9]{64}$'),PRIMARY KEY("runId","ordinal")
);
CREATE TABLE "B2bReceivedReadOnlyCursor" (
 "scopeHash" text PRIMARY KEY CHECK("scopeHash"=factuez_received_write_hash("scope")),"scope" jsonb NOT NULL CHECK(factuez_received_read_scope("scope") IS TRUE),
 "revision" integer NOT NULL CHECK("revision">0),"configurationSha256" text NOT NULL CHECK("configurationSha256" ~ '^[a-f0-9]{64}$'),
 "fingerprint" text NOT NULL CHECK("fingerprint" ~ '^[a-f0-9]{64}$'),"uidValidity" text NOT NULL CHECK("uidValidity" ~ '^[0-9]{1,20}$'),
 "lastUid" bigint NOT NULL CHECK("lastUid" BETWEEN 0 AND 4294967295),"runId" uuid NOT NULL REFERENCES "B2bReceivedAutomationRun"("runId"),
 "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER received_read_only_attempt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedReadOnlyAttempt" FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_read_only_observation_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedReadOnlyObservation" FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_read_only_incident_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON "B2bReceivedReadOnlyIncident" FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE TRIGGER received_read_only_cursor_no_delete BEFORE DELETE OR TRUNCATE ON "B2bReceivedReadOnlyCursor" FOR EACH STATEMENT EXECUTE FUNCTION factuez_received_read_immutable();
CREATE FUNCTION factuez_received_read_only_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
 SELECT a.*,r."status" AS "runStatus",r."source" INTO m FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId" WHERE a."runId"=NEW."runId";
 IF m IS NULL OR m."networkProfile"<>'LIVE_READ_ONLY' OR m."liveAuthority" IS NULL OR m."runStatus"<>'RUNNING' OR m."scope" IS DISTINCT FROM NEW."scope" THEN
  RAISE EXCEPTION 'RECEIVED_READ_ONLY_SCOPE_REQUIRED' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='B2bReceivedReadOnlyObservation' THEN
  IF m."source"<>'SIRE' OR NEW."record"->>'recipientRuc' IS DISTINCT FROM NEW."scope"->>'recipientRuc'
   OR NEW."recordKey" IS DISTINCT FROM factuez_received_write_hash(jsonb_build_object('period',NEW."record"->'period','supplierRuc',NEW."record"->'supplierRuc','documentType',NEW."record"->'documentType','series',NEW."record"->'series','number',NEW."record"->'number'))
   OR (NEW."documentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM "ReceivedDocument" d WHERE d."id"=NEW."documentId" AND d."companyId"=(NEW."scope"->>'companyId')::integer AND d."recipientRuc"=NEW."scope"->>'recipientRuc' AND d."branchId"=(NEW."scope"->>'branchId')::uuid)) THEN
    RAISE EXCEPTION 'RECEIVED_READ_ONLY_OBSERVATION_REQUIRED' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='B2bReceivedReadOnlyCursor' THEN
  IF m."source"<>'MAIL' OR NEW."revision"<>m."revision" OR NOT EXISTS(SELECT 1 FROM "ReceptionConnection" c WHERE c."companyId"=(NEW."scope"->>'companyId')::integer
   AND c."revision"=NEW."revision" AND c."mode"='LIVE_READ_ONLY' AND c."enabled"=false
   AND NEW."configurationSha256"=factuez_received_write_hash(jsonb_build_object('scope',NEW."scope",'revision',NEW."revision",'settings',c."settings"))) THEN
    RAISE EXCEPTION 'RECEIVED_READ_ONLY_CURSOR_REQUIRED' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NEW."scopeHash"<>OLD."scopeHash" OR NEW."scope"<>OLD."scope" OR NEW."revision"<OLD."revision"
   OR (NEW."revision"=OLD."revision" AND (NEW."configurationSha256"<>OLD."configurationSha256" OR (NEW."fingerprint"=OLD."fingerprint" AND NEW."uidValidity"=OLD."uidValidity" AND NEW."lastUid"<OLD."lastUid")))) THEN
    RAISE EXCEPTION 'RECEIVED_READ_ONLY_CURSOR_REGRESSION' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_read_only_observation_scope BEFORE INSERT ON "B2bReceivedReadOnlyObservation" FOR EACH ROW EXECUTE FUNCTION factuez_received_read_only_scope();
CREATE TRIGGER received_read_only_incident_scope BEFORE INSERT ON "B2bReceivedReadOnlyIncident" FOR EACH ROW EXECUTE FUNCTION factuez_received_read_only_scope();
CREATE TRIGGER received_read_only_cursor_scope BEFORE INSERT OR UPDATE ON "B2bReceivedReadOnlyCursor" FOR EACH ROW EXECUTE FUNCTION factuez_received_read_only_scope();
CREATE FUNCTION factuez_received_read_only_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;g jsonb;key text;expected_action text;v jsonb;entry jsonb;cfg text;
BEGIN
 SELECT a.*,r."status" AS "runStatus",r."source",r."counters" AS "runCounters",r."errorCode" AS "runError",c."settings" INTO m
  FROM "B2bReceivedAutomationRun" a JOIN "ReceptionSyncRun" r ON r."id"=a."runId" JOIN "ReceptionConnection" c ON c."companyId"=r."companyId" WHERE a."runId"=NEW."runId";
 IF m IS NULL OR m."networkProfile"<>'LIVE_READ_ONLY' OR m."liveAuthority" IS NULL
  OR m."runStatus" IS DISTINCT FROM (CASE WHEN NEW."status"='RETRY' THEN 'QUEUED' ELSE NEW."status" END)
  OR m."runCounters" IS DISTINCT FROM NEW."counters" OR m."runError" IS DISTINCT FROM NEW."errorCode"
  OR NEW."attempt"<>(SELECT count(*)+1 FROM "B2bReceivedReadOnlyAttempt" WHERE "runId"=NEW."runId") THEN
  RAISE EXCEPTION 'RECEIVED_READ_ONLY_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
 FOR entry IN SELECT value FROM jsonb_each(NEW."counters") LOOP
  IF (jsonb_typeof(entry)='number' AND entry::text ~ '^(0|[1-9][0-9]{0,9})$' AND entry::numeric<=2147483647) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIVED_READ_ONLY_COUNTER_REQUIRED' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF NEW."status"='COMPLETED' THEN
  v=NEW."authority";cfg=factuez_received_write_hash(jsonb_build_object('scope',m."scope",'revision',m."revision",'settings',m."settings"));
  IF (jsonb_typeof(v)='object' AND v ?& ARRAY['create','execute','live','admission','imports','administrator','executionId','expiresAt','contextSha256']
   AND v-ARRAY['create','execute','live','admission','imports','administrator','executionId','expiresAt','contextSha256']='{}'::jsonb
   AND (v->>'expiresAt')::timestamptz>clock_timestamp() AND (v->>'expiresAt')::timestamptz<=clock_timestamp()+interval '5 minutes'
   AND v->>'contextSha256'=factuez_received_write_hash(jsonb_build_object('runId',m."runId",'scope',m."scope",'source',m."source",'revision',m."revision",'actor',jsonb_build_object('kind',m."actorKind",'clientId',m."clientId",'subjectId',m."subjectId",'clientRevision',m."clientRevision",'userAuthRevision',m."userAuthRevision")))
   AND v->'admission'->>'contextSha256'=v->>'contextSha256' AND v->'admission'->>'configurationSha256'=cfg AND v->'admission'->>'profile'='READ_ONLY'
   AND v->'create'=m."createAuthority" AND v->'live'=m."liveAuthority"
   AND ((m."actorKind"='SERVICE' AND v->'administrator'='null'::jsonb) OR (m."actorKind"='USER' AND v->'administrator'=jsonb_build_object('adminId',m."subjectId",'authRevision',m."userAuthRevision",'authority','GLOBAL_ADMIN')))) IS NOT TRUE THEN
   RAISE EXCEPTION 'RECEIVED_READ_ONLY_AUTHORITY_REQUIRED' USING ERRCODE='23514'; END IF;
  FOREACH key IN ARRAY ARRAY['create','execute','live'] LOOP
   expected_action=CASE key WHEN 'create' THEN 'SYNC_CREATE' WHEN 'execute' THEN 'SYNC_EXECUTE' ELSE 'LIVE_READ_ONLY' END;
   SELECT "policy" INTO g FROM "B2bReceivedAutomationGrant" WHERE "policyId"=(v->key->>'policyId')::uuid AND "revision"=(v->key->>'revision')::integer;
   IF g IS NULL OR g->'active' IS DISTINCT FROM 'true'::jsonb OR g->>'action'<>expected_action OR g->'scope' IS DISTINCT FROM m."scope"
    OR g->'subject' IS DISTINCT FROM jsonb_build_object('kind',m."actorKind",'clientId',m."clientId",'subjectId',m."subjectId")
    OR g->>'clientRevision' IS DISTINCT FROM m."clientRevision"::text OR g->'userAuthRevision' IS DISTINCT FROM coalesce(to_jsonb(m."userAuthRevision"),'null'::jsonb) THEN
    RAISE EXCEPTION 'RECEIVED_READ_ONLY_POLICY_REQUIRED' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER received_read_only_receipt BEFORE INSERT ON "B2bReceivedReadOnlyAttempt" FOR EACH ROW EXECUTE FUNCTION factuez_received_read_only_receipt();
