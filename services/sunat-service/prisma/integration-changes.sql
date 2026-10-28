-- Phase 6 technical BETA journal INSTALLATION BLUEPRINT, NOT a migration.
-- Never auto-apply or use a real/live database. Install once, only in an
-- authorized isolated PostgreSQL 13+ database. All source tables are locked
-- exclusively until state seeding, guards and AFTER triggers commit together.
-- Seed CURRENT BETA RUCs, EMPTY journals (head=floor=0); NO backfilled baseline
-- or history. Obtain a fresh baseline AFTER activation. Billing's barrier may
-- share its capture snapshot; SUNAT's earlier barrier requires safe replay
-- overlap. A vector is NOT a distributed atomic cut or fiscal acceptance proof.
-- QA models/09/31 are never sources. Journal rows contain only technical IDs,
-- sequence, kind and time; comparisons of payload/digest/path stay inside SQL.
-- RESTORE/CLONE: quiesce writers/readers BEFORE serving this database; lock
-- owner/journal tables exclusively, delete events, regenerate EVERY state epoch
-- with gen_random_uuid(), reset head=floor=0 in ONE transaction, retain bindings,
-- then activate and recapture baselines. NEVER serve a copied/reused epoch.
-- Apply the same epoch rotation + fresh baseline after ANY trigger disable,
-- bypass or capture gap. Re-enabling triggers cannot repair missing history.
-- Producer logins must not own tables/functions or bypass triggers through
-- replication settings. Readers verify all required enabled source emitters
-- and guards on the expected public tables/routines in the read snapshot.
BEGIN;
LOCK TABLE public."IssuerProjection", public."FiscalDocument", public."FiscalBatch",
  public."DocumentArtifact", public."BatchArtifact", public."SunatSubmission", public."CdrLog"
  IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public."IntegrationChangeState" (
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "epoch" uuid NOT NULL DEFAULT gen_random_uuid(),
  "head" bigint NOT NULL DEFAULT 0 CHECK ("head">=0),
  "floor" bigint NOT NULL DEFAULT 0 CHECK ("floor">=0 AND "floor"<="head"),
  PRIMARY KEY ("issuerRuc", "environment"), UNIQUE ("issuerRuc", "environment", "epoch")
);
CREATE TABLE public."IntegrationChangeEvent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- stable source event UUID
  "issuerRuc" varchar(11) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "epoch" uuid NOT NULL,
  "sequence" bigint NOT NULL CHECK ("sequence">0),
  "ownerKind" text NOT NULL CHECK ("ownerKind" IN ('DOCUMENT', 'BATCH')),
  "ownerId" uuid NOT NULL,
  "eventKind" text NOT NULL CHECK ("eventKind" IN
    ('DOCUMENT_CREATED', 'DOCUMENT_STATE_CHANGED', 'ARTIFACT_ADDED', 'DOCUMENT_RECONCILED')),
  "occurredAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "artifactId" uuid,
  CHECK ("eventKind" <> 'ARTIFACT_ADDED' OR "artifactId" IS NOT NULL),
  UNIQUE ("issuerRuc", "environment", "epoch", "sequence"),
  FOREIGN KEY ("issuerRuc", "environment", "epoch")
    REFERENCES public."IntegrationChangeState" ("issuerRuc", "environment", "epoch") ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- These durable bindings are not a baseline or event history; retain on trim.
CREATE TABLE public."IntegrationChangeBinding" (
  "ownerKind" text NOT NULL CHECK ("ownerKind" IN ('DOCUMENT', 'BATCH')),
  "ownerId" uuid NOT NULL,
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  PRIMARY KEY ("ownerKind", "ownerId")
);
CREATE TABLE public."IntegrationChangeArtifactBinding" (
  "artifactId" uuid NOT NULL,
  "ownerKind" text NOT NULL,
  "ownerId" uuid NOT NULL,
  PRIMARY KEY ("ownerKind", "artifactId"),
  FOREIGN KEY ("ownerKind", "ownerId") REFERENCES public."IntegrationChangeBinding" ("ownerKind", "ownerId")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TABLE public."IntegrationChangeProofBinding" (
  "proofId" uuid PRIMARY KEY REFERENCES public."CdrLog" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "submissionId" uuid NOT NULL REFERENCES public."SunatSubmission" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.integration_change_snapshot_ok(s jsonb, issuer text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(s)='object' AND issuer ~ '^[1-9][0-9]{10}$' AND
    s->>'environment'='BETA' AND s#>>'{issuer,identityNumber}'=issuer AND
    s->>'documentTypeCode' IN ('01','03','07','08') AND
    s->>'documentId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' AND
    s->>'series' ~ '^[FB][A-Z0-9]{3}$' AND s->>'number' ~ '^[0-9]{1,20}$' AND
    NOT (s ?| ARRAY['qa', 'qaScenario', 'simulation']) AND
    coalesce(s->>'qaOnly', 'false')='false' AND coalesce(s->>'candidateOnly', 'false')='false' AND
    coalesce(s->>'profile', '') !~* '(^|[-_])qa([-_]|$)', false);
END $$;
CREATE FUNCTION public.integration_change_document_ok(p public."FiscalDocument") RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p."environment"::text IS DISTINCT FROM 'BETA' OR
     NOT public.integration_change_snapshot_ok(p."immutablePayload", p."issuerRuc") THEN RETURN false; END IF;
  RETURN coalesce(p."documentType"=p."immutablePayload"->>'documentTypeCode' AND
    p."documentId"::text=lower(p."immutablePayload"->>'documentId') AND
    p."series"=p."immutablePayload"->>'series' AND p."number">0 AND
    p."number"=(p."immutablePayload"->>'number')::numeric, false);
END $$;

-- Returns only internal membership/identity tuples, never copied to the journal.
-- Supports actual legacy RC singleton sale snapshots and RC/RA envelopes.
CREATE FUNCTION public.integration_change_batch_members(p public."FiscalBatch") RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s jsonb := p."immutablePayload"; entries jsonb; entry jsonb; snap jsonb;
  result jsonb := '[]'; ids text[] := ARRAY[]::text[]; base_type text; batch_kind text; condition text;
BEGIN
  IF p."environment"::text IS DISTINCT FROM 'BETA' OR p."issuerRuc" !~ '^[1-9][0-9]{10}$' OR
     p."identifier" !~ '^(RC|RA)-[0-9]{8}-[1-9][0-9]{0,9}$' OR s->>'environment' IS DISTINCT FROM 'BETA' OR
     s#>>'{issuer,identityNumber}' IS DISTINCT FROM p."issuerRuc" OR
     s ?| ARRAY['qa', 'qaScenario', 'simulation'] OR coalesce(s->>'qaOnly','false')<>'false' OR
     coalesce(s->>'candidateOnly','false')<>'false' OR coalesce(s->>'profile','') ~* '(^|[-_])qa([-_]|$)'
    THEN RETURN NULL; END IF;
  batch_kind := left(p."identifier", 2);
  IF NOT (s ? 'input') THEN
    IF batch_kind<>'RC' OR s->>'documentTypeCode' IS DISTINCT FROM '03' THEN RETURN NULL; END IF;
    entries := jsonb_build_array(jsonb_build_object('document', jsonb_build_object('snapshot', s), 'conditionCode', '1'));
  ELSE
    IF s->>'kind' IS DISTINCT FROM batch_kind OR s->>'identifier' IS DISTINCT FROM p."identifier" OR
       s#>>'{input,kind}' IS DISTINCT FROM batch_kind THEN RETURN NULL; END IF;
    entries := s#>'{input,entries}';
  END IF;
  IF jsonb_typeof(entries) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(entries) NOT BETWEEN 1 AND 10000 THEN RETURN NULL; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(entries) LOOP
    snap := entry#>'{document,snapshot}';
    IF NOT public.integration_change_snapshot_ok(snap, p."issuerRuc") THEN RETURN NULL; END IF;
    IF (snap->>'number')::numeric <= 0 OR lower(snap->>'documentId')=ANY(ids) THEN RETURN NULL; END IF;
    ids := array_append(ids, lower(snap->>'documentId'));
    base_type := CASE WHEN snap->>'documentTypeCode' IN ('07','08')
      THEN snap#>>'{reference,documentTypeCode}' ELSE snap->>'documentTypeCode' END;
    IF base_type IS DISTINCT FROM (CASE WHEN batch_kind='RC' THEN '03' ELSE '01' END) THEN RETURN NULL; END IF;
    condition := CASE WHEN batch_kind='RC' THEN entry->>'conditionCode' ELSE NULL END;
    IF batch_kind='RC' AND (condition IS NULL OR condition NOT IN ('1','2','3')) THEN RETURN NULL; END IF;
    result := result || jsonb_build_array(jsonb_build_array(lower(snap->>'documentId'), snap->>'documentTypeCode',
      snap->>'series', (snap->>'number')::numeric, base_type, condition));
  END LOOP;
  RETURN result;
END $$;

CREATE FUNCTION public.integration_change_sunat_append(issuer text, owner_kind text, owner_id uuid, event_kind text,
  artifact_id uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE allocated bigint; current_epoch uuid;
BEGIN
  INSERT INTO public."IntegrationChangeBinding" ("issuerRuc", "ownerKind", "ownerId") VALUES (issuer, owner_kind, owner_id)
    ON CONFLICT ("ownerKind", "ownerId") DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" WHERE "ownerKind"=owner_kind AND
    "ownerId"=owner_id AND "issuerRuc"=issuer AND "environment"='BETA') THEN
    RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  INSERT INTO public."IntegrationChangeState" ("issuerRuc") VALUES (issuer)
    ON CONFLICT ("issuerRuc", "environment") DO NOTHING;
  -- Per-RUC row lock is held until the OWNER transaction commits or rolls back.
  -- Allocation and event INSERT are in that transaction; no global allocator.
  UPDATE public."IntegrationChangeState" SET "head"="head"+1 WHERE "issuerRuc"=issuer AND "environment"='BETA'
    RETURNING "head", "epoch" INTO allocated, current_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHANGE_FEED_NOT_READY'; END IF;
  INSERT INTO public."IntegrationChangeEvent" ("issuerRuc", "epoch", "sequence", "ownerKind", "ownerId", "eventKind", "artifactId")
    VALUES (issuer, current_epoch, allocated, owner_kind, owner_id, event_kind, artifact_id);
END $$;

CREATE FUNCTION public.integration_change_sunat_owner_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE tracked boolean; old_members jsonb; new_members jsonb;
BEGIN
  IF TG_TABLE_NAME='FiscalDocument' THEN
    tracked := public.integration_change_document_ok(OLD) OR EXISTS (SELECT 1 FROM public."IntegrationChangeBinding"
      WHERE "ownerKind"='DOCUMENT' AND "ownerId"=OLD."documentId");
    IF tracked THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
      IF NOT public.integration_change_document_ok(NEW) OR
        ROW(NEW."documentId",NEW."issuerRuc",NEW."environment",NEW."documentType",NEW."series",NEW."number",NEW."billingEventId",NEW."immutablePayload") IS DISTINCT FROM
        ROW(OLD."documentId",OLD."issuerRuc",OLD."environment",OLD."documentType",OLD."series",OLD."number",OLD."billingEventId",OLD."immutablePayload") THEN
        RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
    END IF;
  ELSE
    old_members := public.integration_change_batch_members(OLD);
    tracked := old_members IS NOT NULL OR EXISTS (SELECT 1 FROM public."IntegrationChangeBinding"
      WHERE "ownerKind"='BATCH' AND "ownerId"=OLD."id");
    IF tracked THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
      new_members := public.integration_change_batch_members(NEW);
      IF new_members IS NULL OR new_members IS DISTINCT FROM old_members OR
        ROW(NEW."id",NEW."issuerRuc",NEW."environment",NEW."identifier",NEW."summaryId",NEW."billingEventId",NEW."immutablePayload") IS DISTINCT FROM
        ROW(OLD."id",OLD."issuerRuc",OLD."environment",OLD."identifier",OLD."summaryId",OLD."billingEventId",OLD."immutablePayload") THEN
        RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_kind text; owner_id uuid; event_kind text; eligible boolean; old_eligible boolean;
BEGIN
  IF TG_TABLE_NAME='FiscalDocument' THEN
    eligible := public.integration_change_document_ok(NEW); owner_kind := 'DOCUMENT'; owner_id := NEW."documentId";
    IF TG_OP='UPDATE' THEN old_eligible := public.integration_change_document_ok(OLD); END IF;
  ELSE
    eligible := public.integration_change_batch_members(NEW) IS NOT NULL; owner_kind := 'BATCH'; owner_id := NEW."id";
    IF TG_OP='UPDATE' THEN old_eligible := public.integration_change_batch_members(OLD) IS NOT NULL; END IF;
  END IF;
  IF NOT eligible THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' OR NOT coalesce(old_eligible,false) THEN event_kind := 'DOCUMENT_CREATED';
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN event_kind := 'DOCUMENT_STATE_CHANGED';
  ELSIF TG_TABLE_NAME='FiscalDocument' THEN
    IF ROW(NEW."digestValue",NEW."acceptedAt") IS NOT DISTINCT FROM ROW(OLD."digestValue",OLD."acceptedAt") THEN RETURN NEW; END IF;
    event_kind := 'DOCUMENT_RECONCILED';
  ELSE RETURN NEW; END IF;
  PERFORM public.integration_change_sunat_append(NEW."issuerRuc",owner_kind,owner_id,event_kind);
  RETURN NEW;
END $$;

CREATE FUNCTION public.integration_change_artifact_owner(owner_kind text, owner_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE d public."FiscalDocument"; b public."FiscalBatch";
BEGIN
  IF owner_kind='DOCUMENT' THEN
    SELECT * INTO d FROM public."FiscalDocument" WHERE "documentId"=owner_id FOR SHARE;
    IF FOUND AND public.integration_change_document_ok(d) THEN RETURN d."issuerRuc"; END IF;
  ELSE
    SELECT * INTO b FROM public."FiscalBatch" WHERE "id"=owner_id FOR SHARE;
    IF FOUND AND public.integration_change_batch_members(b) IS NOT NULL THEN RETURN b."issuerRuc"; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION public.integration_change_sunat_artifact_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_kind text; owner_id uuid; new_owner uuid;
BEGIN
  IF TG_TABLE_NAME='DocumentArtifact' THEN owner_kind:='DOCUMENT'; owner_id:=OLD."documentId";
    IF TG_OP='UPDATE' THEN new_owner:=NEW."documentId"; END IF;
  ELSE owner_kind:='BATCH'; owner_id:=OLD."batchId";
    IF TG_OP='UPDATE' THEN new_owner:=NEW."batchId"; END IF;
  END IF;
  IF public.integration_change_artifact_owner(owner_kind,owner_id) IS NOT NULL OR
    EXISTS (SELECT 1 FROM public."IntegrationChangeArtifactBinding" WHERE "ownerKind"=owner_kind AND "artifactId"=OLD."id") THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
    IF ROW(NEW."id",new_owner,NEW."kind") IS DISTINCT FROM ROW(OLD."id",owner_id,OLD."kind") THEN
      RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_artifact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner_kind text; owner_id uuid; issuer text; event_kind text;
BEGIN
  IF TG_TABLE_NAME='DocumentArtifact' THEN owner_kind:='DOCUMENT'; owner_id:=NEW."documentId";
  ELSE owner_kind:='BATCH'; owner_id:=NEW."batchId"; END IF;
  issuer:=public.integration_change_artifact_owner(owner_kind,owner_id);
  IF issuer IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN event_kind:='ARTIFACT_ADDED';
  ELSIF ROW(NEW."storageKey",NEW."mediaType",NEW."sizeBytes",NEW."sha256",NEW."createdAt") IS DISTINCT FROM
    ROW(OLD."storageKey",OLD."mediaType",OLD."sizeBytes",OLD."sha256",OLD."createdAt") THEN event_kind:='DOCUMENT_RECONCILED';
  ELSE RETURN NEW; END IF;
  PERFORM public.integration_change_sunat_append(issuer,owner_kind,owner_id,event_kind,NEW."id");
  INSERT INTO public."IntegrationChangeArtifactBinding" ("artifactId","ownerKind","ownerId")
    VALUES (NEW."id",owner_kind,owner_id) ON CONFLICT ("ownerKind","artifactId") DO NOTHING;
  RETURN NEW;
END $$;

-- CDR proof can become available AFTER bytes/artifacts already existed.
-- Identify both direct owners and submission owners; refuse cross-RUC proof.
CREATE FUNCTION public.integration_change_cdr_owners(p public."CdrLog")
RETURNS TABLE (owner_kind text, owner_id uuid, issuer text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE sub public."SunatSubmission"; doc_id uuid; batch_id uuid; r text; previous_ruc text;
BEGIN
  SELECT * INTO sub FROM public."SunatSubmission" WHERE "id"=p."submissionId" FOR SHARE;
  FOR doc_id IN SELECT DISTINCT x FROM unnest(ARRAY[p."documentId",sub."documentId"]) x WHERE x IS NOT NULL LOOP
    r:=public.integration_change_artifact_owner('DOCUMENT',doc_id);
    IF r IS NOT NULL THEN
      IF previous_ruc IS NOT NULL AND previous_ruc<>r THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
      previous_ruc:=r; owner_kind:='DOCUMENT'; owner_id:=doc_id; issuer:=r; RETURN NEXT;
    END IF;
  END LOOP;
  FOR batch_id IN SELECT DISTINCT x FROM unnest(ARRAY[p."batchId",sub."batchId"]) x WHERE x IS NOT NULL LOOP
    r:=public.integration_change_artifact_owner('BATCH',batch_id);
    IF r IS NOT NULL THEN
      IF previous_ruc IS NOT NULL AND previous_ruc<>r THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
      previous_ruc:=r; owner_kind:='BATCH'; owner_id:=batch_id; issuer:=r; RETURN NEXT;
    END IF;
  END LOOP;
END $$;
CREATE FUNCTION public.integration_change_cdr_emit(p public."CdrLog") RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE o record; identified boolean:=false;
BEGIN
  FOR o IN SELECT * FROM public.integration_change_cdr_owners(p) ORDER BY issuer,owner_kind,owner_id LOOP
    PERFORM public.integration_change_sunat_append(o.issuer,o.owner_kind,o.owner_id,'DOCUMENT_RECONCILED');
    identified:=true;
  END LOOP;
  IF identified THEN INSERT INTO public."IntegrationChangeProofBinding" ("proofId","submissionId")
    VALUES (p."id",p."submissionId") ON CONFLICT ("proofId") DO NOTHING; END IF;
END $$;
CREATE FUNCTION public.integration_change_sunat_cdr_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."IntegrationChangeProofBinding" WHERE "proofId"=OLD."id") OR
    EXISTS (SELECT 1 FROM public.integration_change_cdr_owners(OLD)) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
    IF ROW(NEW."id",NEW."documentId",NEW."batchId",NEW."submissionId") IS DISTINCT FROM
       ROW(OLD."id",OLD."documentId",OLD."batchId",OLD."submissionId") THEN
      RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_cdr() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='INSERT' THEN PERFORM public.integration_change_cdr_emit(NEW);
  ELSIF ROW(NEW."responseCode",NEW."description",NEW."notes",NEW."cdrStorageKey",NEW."cdrSha256",NEW."receivedAt",
    NEW."documentId",NEW."batchId",NEW."submissionId") IS DISTINCT FROM
    ROW(OLD."responseCode",OLD."description",OLD."notes",OLD."cdrStorageKey",OLD."cdrSha256",OLD."receivedAt",
    OLD."documentId",OLD."batchId",OLD."submissionId") THEN PERFORM public.integration_change_cdr_emit(NEW); END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_submission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."IntegrationChangeProofBinding" WHERE "submissionId"=OLD."id") OR
    EXISTS (SELECT 1 FROM public."CdrLog" l WHERE l."submissionId"=OLD."id" AND
      EXISTS (SELECT 1 FROM public.integration_change_cdr_owners(l))) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
    IF ROW(NEW."id",NEW."documentId",NEW."batchId") IS DISTINCT FROM ROW(OLD."id",OLD."documentId",OLD."batchId") THEN
      RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE proof public."CdrLog";
BEGIN
  IF ROW(NEW."documentId",NEW."batchId") IS DISTINCT FROM ROW(OLD."documentId",OLD."batchId") THEN
    FOR proof IN SELECT * FROM public."CdrLog" WHERE "submissionId"=NEW."id" LOOP
      PERFORM public.integration_change_cdr_emit(proof);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_sunat_no_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END $$;
CREATE FUNCTION public.integration_change_sunat_issuer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."environment"::text='BETA' AND NEW."ruc" ~ '^[1-9][0-9]{10}$' THEN
    INSERT INTO public."IntegrationChangeState" ("issuerRuc") VALUES (NEW."ruc")
      ON CONFLICT ("issuerRuc","environment") DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "IntegrationChangeIssuer" AFTER INSERT OR UPDATE ON public."IssuerProjection"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_issuer();
CREATE TRIGGER "IntegrationChangeDocumentGuard" BEFORE UPDATE OR DELETE ON public."FiscalDocument"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_owner_guard();
CREATE TRIGGER "IntegrationChangeDocument" AFTER INSERT OR UPDATE ON public."FiscalDocument"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_owner();
CREATE TRIGGER "IntegrationChangeBatchGuard" BEFORE UPDATE OR DELETE ON public."FiscalBatch"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_owner_guard();
CREATE TRIGGER "IntegrationChangeBatch" AFTER INSERT OR UPDATE ON public."FiscalBatch"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_owner();
CREATE TRIGGER "IntegrationChangeDocumentArtifactGuard" BEFORE UPDATE OR DELETE ON public."DocumentArtifact"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_artifact_guard();
CREATE TRIGGER "IntegrationChangeDocumentArtifact" AFTER INSERT OR UPDATE ON public."DocumentArtifact"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_artifact();
CREATE TRIGGER "IntegrationChangeBatchArtifactGuard" BEFORE UPDATE OR DELETE ON public."BatchArtifact"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_artifact_guard();
CREATE TRIGGER "IntegrationChangeBatchArtifact" AFTER INSERT OR UPDATE ON public."BatchArtifact"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_artifact();
CREATE TRIGGER "IntegrationChangeCdrGuard" BEFORE UPDATE OR DELETE ON public."CdrLog"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_cdr_guard();
CREATE TRIGGER "IntegrationChangeCdr" AFTER INSERT OR UPDATE ON public."CdrLog"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_cdr();
CREATE TRIGGER "IntegrationChangeSubmissionGuard" BEFORE UPDATE OR DELETE ON public."SunatSubmission"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_submission_guard();
CREATE TRIGGER "IntegrationChangeSubmission" AFTER UPDATE ON public."SunatSubmission"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_sunat_submission();
DO $$ DECLARE source text; BEGIN
  FOREACH source IN ARRAY ARRAY['FiscalDocument','FiscalBatch','DocumentArtifact','BatchArtifact','CdrLog','SunatSubmission'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_sunat_no_removal()',
      'IntegrationChangeTruncate'||source,source);
  END LOOP;
  FOREACH source IN ARRAY ARRAY['IntegrationChangeBinding','IntegrationChangeArtifactBinding','IntegrationChangeProofBinding'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_sunat_no_removal()',
      source||'Guard',source);
  END LOOP;
END $$;

INSERT INTO public."IntegrationChangeState" ("issuerRuc")
  SELECT "ruc" FROM public."IssuerProjection" WHERE "environment"::text='BETA' AND "ruc" ~ '^[1-9][0-9]{10}$'
  UNION SELECT "issuerRuc" FROM public."FiscalDocument" d WHERE public.integration_change_document_ok(d)
  UNION SELECT "issuerRuc" FROM public."FiscalBatch" b WHERE public.integration_change_batch_members(b) IS NOT NULL;
REVOKE ALL ON public."IntegrationChangeState", public."IntegrationChangeEvent", public."IntegrationChangeBinding",
  public."IntegrationChangeArtifactBinding", public."IntegrationChangeProofBinding" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_change_snapshot_ok(jsonb,text), public.integration_change_document_ok(public."FiscalDocument"),
  public.integration_change_batch_members(public."FiscalBatch"), public.integration_change_sunat_append(text,text,uuid,text,uuid),
  public.integration_change_sunat_owner_guard(), public.integration_change_sunat_owner(), public.integration_change_artifact_owner(text,uuid),
  public.integration_change_sunat_artifact_guard(), public.integration_change_sunat_artifact(),
  public.integration_change_cdr_owners(public."CdrLog"), public.integration_change_cdr_emit(public."CdrLog"),
  public.integration_change_sunat_cdr_guard(), public.integration_change_sunat_cdr(),
  public.integration_change_sunat_submission_guard(), public.integration_change_sunat_submission(), public.integration_change_sunat_no_removal(),
  public.integration_change_sunat_issuer() FROM PUBLIC;
-- OPTIONAL provisioning examples ONLY: explicitly create a dedicated role;
-- no GRANT assumes an existing role and no password/login is created here.
-- CREATE ROLE factuez_integration_journal_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
-- GRANT USAGE ON SCHEMA public TO factuez_integration_journal_reader;
-- GRANT SELECT ON public."IntegrationChangeState", public."IntegrationChangeEvent" TO factuez_integration_journal_reader;
-- Its dedicated login must have no inherited owner, binding, function-execute
-- or write grants. RUC authorization is additionally required at owner-private
-- mTLS/authenticated endpoints; raw journal IDs MUST NOT go to public clients.
-- Retention: separate technical pool, SELECT/UPDATE state + SELECT/DELETE
-- events only. Always lock state, validate contiguous prefix, delete + advance
-- inclusive floor atomically. Never delete durable bindings during retention.
COMMIT;
