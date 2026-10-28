-- Phase 6 technical BETA journal INSTALLATION BLUEPRINT, NOT a migration.
-- Never apply at startup or to a real/live database. PostgreSQL 13+ UUID support.
-- Install once in a separately authorized isolated database. Exclusive owner
-- table locks close the installation gap: seed CURRENT BETA RUC state, install
-- guards/triggers, then commit activation. Journals start EMPTY (head=floor=0).
-- This is NOT backfilled baseline/history. Capture a fresh baseline AFTER
-- activation, with its Billing barrier in the SAME RepeatableRead snapshot.
-- A SUNAT barrier taken before capture needs replay overlap; the vector is NOT
-- a distributed atomic cut. Pre-activation owner rows receive no invented events.
-- RESTORE/CLONE: before serving any capture/feed, quiesce writers/readers, lock
-- these owner + journal tables exclusively, delete events, set EACH state's
-- epoch=gen_random_uuid(), head=0, floor=0 atomically, retain all bindings, and
-- recapture baselines after activation. A copied epoch MUST NOT be served.
-- Epoch rotation is an explicit operator procedure, never inferred at startup.
-- Any trigger disable/bypass/gap requires the SAME epoch rotation and fresh
-- baseline before reactivation; re-enabling triggers cannot repair history.
-- Producer logins must not own these tables/functions or bypass triggers via
-- replication settings. Read readiness verifies all named enabled emitters and
-- guards on the expected public source tables/routines in its own snapshot.
BEGIN;
LOCK TABLE public."CompanySettings", public."Branch", public."EmissionPoint", public."SeriesCounter",
  public."Document" IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public."IntegrationChangeState" (
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment" = 'BETA'),
  "epoch" uuid NOT NULL DEFAULT gen_random_uuid(),
  "head" bigint NOT NULL DEFAULT 0 CHECK ("head" >= 0),
  "floor" bigint NOT NULL DEFAULT 0 CHECK ("floor" >= 0 AND "floor" <= "head"),
  PRIMARY KEY ("issuerRuc", "environment"),
  UNIQUE ("issuerRuc", "environment", "epoch")
);
CREATE TABLE public."IntegrationChangeEvent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- stable source event UUID
  "issuerRuc" varchar(11) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment" = 'BETA'),
  "epoch" uuid NOT NULL,
  "sequence" bigint NOT NULL CHECK ("sequence" > 0),
  "ownerKind" text NOT NULL CHECK ("ownerKind" = 'DOCUMENT'),
  "ownerId" uuid NOT NULL,
  "eventKind" text NOT NULL CHECK ("eventKind" IN
    ('DOCUMENT_CREATED', 'DOCUMENT_STATE_CHANGED', 'ARTIFACT_ADDED', 'DOCUMENT_RECONCILED')),
  "occurredAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "artifactId" uuid CHECK ("artifactId" IS NULL),
  CHECK ("eventKind" <> 'ARTIFACT_ADDED'),
  UNIQUE ("issuerRuc", "environment", "epoch", "sequence"),
  FOREIGN KEY ("issuerRuc", "environment", "epoch")
    REFERENCES public."IntegrationChangeState" ("issuerRuc", "environment", "epoch") ON DELETE RESTRICT ON UPDATE RESTRICT
);
-- Durable technical bindings outlive event retention. No snapshot/customer/XML,
-- content, storage paths, response descriptions or credentials in journal rows.
CREATE UNIQUE INDEX "IntegrationChangeCompanyRuc" ON public."CompanySettings" ("id", "ruc");
CREATE UNIQUE INDEX "IntegrationChangePointOwner" ON public."EmissionPoint" ("id", "companyId", "branchId");
CREATE UNIQUE INDEX "IntegrationChangeBranchOwner" ON public."Branch" ("id", "companyId");
CREATE UNIQUE INDEX "IntegrationChangeCounterOwner" ON public."SeriesCounter" ("id", "companyId", "emissionPointId", "documentType", "series");
CREATE TABLE public."IntegrationChangeBinding" (
  "ownerId" uuid PRIMARY KEY REFERENCES public."Document" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "companyId" integer NOT NULL,
  "issuerRuc" varchar(11) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment" = 'BETA'),
  "pointId" uuid NOT NULL,
  "branchId" uuid NOT NULL,
  "counterId" uuid NOT NULL,
  "type" public."DocumentType" NOT NULL,
  "series" varchar(4) NOT NULL,
  FOREIGN KEY ("companyId", "issuerRuc") REFERENCES public."CompanySettings" ("id", "ruc") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("pointId", "companyId", "branchId") REFERENCES public."EmissionPoint" ("id", "companyId", "branchId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("branchId", "companyId") REFERENCES public."Branch" ("id", "companyId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY ("counterId", "companyId", "pointId", "type", "series")
    REFERENCES public."SeriesCounter" ("id", "companyId", "emissionPointId", "documentType", "series") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION public.integration_change_billing_ruc(p public."Document") RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE s jsonb := p."immutableSnapshot"; code text; issuer text;
  point public."EmissionPoint"; counter public."SeriesCounter"; branch public."Branch";
BEGIN
  code := CASE p."type"::text WHEN 'INVOICE' THEN '01' WHEN 'SALES_RECEIPT' THEN '03'
    WHEN 'CREDIT_NOTE' THEN '07' WHEN 'DEBIT_NOTE' THEN '08' ELSE NULL END;
  -- Document has no environment column. Only an emitted snapshot's BETA counts;
  -- a later change of CompanySettings.environment cannot reclassify history.
  IF code IS NULL OR p."status"::text = 'DRAFT' OR s->>'environment' IS DISTINCT FROM 'BETA' OR
     s->>'documentId' IS DISTINCT FROM p."id"::text OR s->>'companyId' IS DISTINCT FROM p."companyId"::text OR
     s->>'documentTypeCode' IS DISTINCT FROM code OR s->>'series' IS DISTINCT FROM p."series" OR
     s->>'fullNumber' IS DISTINCT FROM p."fullNumber" OR p."series" !~ '^[FB][A-Z0-9]{3}$' OR
     s->>'number' IS NULL OR s->>'number' !~ '^[0-9]{1,20}$' OR p."number" <= 0 OR
     s ?| ARRAY['qa', 'qaScenario', 'simulation'] OR
     coalesce(s->>'qaOnly', 'false') <> 'false' OR coalesce(s->>'candidateOnly', 'false') <> 'false' OR
     coalesce(s->>'profile', '') ~* '(^|[-_])qa([-_]|$)' THEN RETURN NULL; END IF;
  IF (s->>'number')::numeric <> p."number" THEN RETURN NULL; END IF;
  SELECT c."ruc"::text INTO issuer FROM public."CompanySettings" c WHERE c."id"=p."companyId" FOR SHARE;
  IF issuer IS NULL OR issuer !~ '^[1-9][0-9]{10}$' OR s#>>'{issuer,identityNumber}' IS DISTINCT FROM issuer
    THEN RETURN NULL; END IF;
  SELECT * INTO point FROM public."EmissionPoint" WHERE "id"=p."emissionPointId" FOR SHARE;
  IF NOT FOUND OR point."companyId"<>p."companyId" OR point."branchId" IS NULL OR
    s->>'branchId' IS DISTINCT FROM point."branchId"::text THEN RETURN NULL; END IF;
  SELECT * INTO counter FROM public."SeriesCounter" WHERE "id"=p."seriesCounterId" FOR SHARE;
  IF NOT FOUND OR ROW(counter."companyId",counter."emissionPointId",counter."documentType",counter."series") IS DISTINCT FROM
    ROW(p."companyId",p."emissionPointId",p."type",p."series") THEN RETURN NULL; END IF;
  SELECT * INTO branch FROM public."Branch" WHERE "id"=point."branchId" FOR SHARE;
  IF NOT FOUND OR branch."companyId"<>p."companyId" THEN RETURN NULL; END IF;
  RETURN issuer;
END $$;

CREATE FUNCTION public.integration_change_billing_append(issuer text, owner_id uuid, event_kind text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE allocated bigint; current_epoch uuid;
BEGIN
  INSERT INTO public."IntegrationChangeState" ("issuerRuc") VALUES (issuer)
    ON CONFLICT ("issuerRuc", "environment") DO NOTHING;
  -- UPDATE locks the per-RUC state row UNTIL OWNER TRANSACTION COMMIT/ROLLBACK.
  -- A competing transaction for this RUC cannot allocate/commit ahead of it.
  -- Rollback undoes both counter and event. Other RUCs have independent locks.
  UPDATE public."IntegrationChangeState" SET "head"="head"+1
    WHERE "issuerRuc"=issuer AND "environment"='BETA' RETURNING "head", "epoch" INTO allocated, current_epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'CHANGE_FEED_NOT_READY'; END IF;
  INSERT INTO public."IntegrationChangeEvent" ("issuerRuc", "epoch", "sequence", "ownerKind", "ownerId", "eventKind")
    VALUES (issuer, current_epoch, allocated, 'DOCUMENT', owner_id, event_kind);
END $$;

-- Protect eligible pre-activation rows too, without inventing baseline events.
CREATE FUNCTION public.integration_change_billing_document_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE issuer text;
BEGIN
  issuer := public.integration_change_billing_ruc(OLD);
  IF issuer IS NOT NULL OR EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" WHERE "ownerId"=OLD."id") THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END IF;
    -- Frozen content and cut-filter fields cannot move out of a durable feed.
    IF ROW(NEW."id", NEW."companyId", NEW."type", NEW."series", NEW."number", NEW."fullNumber",
           NEW."emissionPointId", NEW."seriesCounterId", NEW."immutableSnapshot", NEW."issueDate", NEW."payableAmount") IS DISTINCT FROM
       ROW(OLD."id", OLD."companyId", OLD."type", OLD."series", OLD."number", OLD."fullNumber",
           OLD."emissionPointId", OLD."seriesCounterId", OLD."immutableSnapshot", OLD."issueDate", OLD."payableAmount") OR
       issuer IS NULL OR public.integration_change_billing_ruc(NEW) IS DISTINCT FROM issuer OR
       (NEW."immutableSnapshot"->>'branchId') IS DISTINCT FROM (OLD."immutableSnapshot"->>'branchId')
       THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.integration_change_billing_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE issuer text; event_kind text;
BEGIN
  issuer := public.integration_change_billing_ruc(NEW);
  IF issuer IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN event_kind := 'DOCUMENT_CREATED';
  ELSIF public.integration_change_billing_ruc(OLD) IS NULL THEN event_kind := 'DOCUMENT_CREATED';
  ELSIF ROW(NEW."status", NEW."sunatStatus") IS DISTINCT FROM ROW(OLD."status", OLD."sunatStatus")
    THEN event_kind := 'DOCUMENT_STATE_CHANGED';
  ELSIF ROW(NEW."sunatResponseCode", NEW."sunatResponseDescription", NEW."originSystem", NEW."originId")
    IS DISTINCT FROM ROW(OLD."sunatResponseCode", OLD."sunatResponseDescription", OLD."originSystem", OLD."originId")
    THEN event_kind := 'DOCUMENT_RECONCILED';
  ELSE RETURN NEW; END IF;
  INSERT INTO public."IntegrationChangeBinding" ("ownerId", "companyId", "issuerRuc", "pointId", "branchId", "counterId", "type", "series")
    VALUES (NEW."id", NEW."companyId", issuer, NEW."emissionPointId", (NEW."immutableSnapshot"->>'branchId')::uuid,
      NEW."seriesCounterId", NEW."type", NEW."series") ON CONFLICT ("ownerId") DO NOTHING;
  PERFORM public.integration_change_billing_append(issuer, NEW."id", event_kind);
  RETURN NEW;
END $$;

CREATE FUNCTION public.integration_change_billing_company_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW."id", NEW."ruc") IS DISTINCT FROM ROW(OLD."id", OLD."ruc") THEN
    IF EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" WHERE "companyId"=OLD."id") OR
       EXISTS (SELECT 1 FROM public."Document" d WHERE d."companyId"=OLD."id" AND
         public.integration_change_billing_ruc(d) IS NOT NULL) THEN
      RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_billing_company() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."environment"::text='BETA' AND NEW."ruc" ~ '^[1-9][0-9]{10}$' THEN
    INSERT INTO public."IntegrationChangeState" ("issuerRuc") VALUES (NEW."ruc")
      ON CONFLICT ("issuerRuc", "environment") DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.integration_change_billing_no_removal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REMOVAL'; END $$;

CREATE FUNCTION public.integration_change_billing_master_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE changed boolean; used boolean;
BEGIN
  IF TG_TABLE_NAME='EmissionPoint' THEN
    changed := TG_OP='DELETE' OR ROW(NEW."id", NEW."companyId", NEW."branchId") IS DISTINCT FROM ROW(OLD."id", OLD."companyId", OLD."branchId");
    SELECT EXISTS (SELECT 1 FROM public."Document" d WHERE d."emissionPointId"=OLD."id" AND
      (EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" b WHERE b."ownerId"=d."id") OR
       public.integration_change_billing_ruc(d) IS NOT NULL)) INTO used;
  ELSIF TG_TABLE_NAME='SeriesCounter' THEN
    changed := TG_OP='DELETE' OR ROW(NEW."id", NEW."companyId", NEW."emissionPointId", NEW."documentType", NEW."series") IS DISTINCT FROM
      ROW(OLD."id", OLD."companyId", OLD."emissionPointId", OLD."documentType", OLD."series");
    SELECT EXISTS (SELECT 1 FROM public."Document" d WHERE d."seriesCounterId"=OLD."id" AND
      (EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" b WHERE b."ownerId"=d."id") OR
       public.integration_change_billing_ruc(d) IS NOT NULL)) INTO used;
  ELSE
    changed := TG_OP='DELETE' OR ROW(NEW."id", NEW."companyId") IS DISTINCT FROM ROW(OLD."id", OLD."companyId");
    SELECT EXISTS (SELECT 1 FROM public."Document" d JOIN public."EmissionPoint" p ON p."id"=d."emissionPointId"
      WHERE p."branchId"=OLD."id" AND (EXISTS (SELECT 1 FROM public."IntegrationChangeBinding" b WHERE b."ownerId"=d."id") OR
       public.integration_change_billing_ruc(d) IS NOT NULL)) INTO used;
  END IF;
  IF changed AND used THEN RAISE EXCEPTION 'INTEGRATION_JOURNALED_OWNER_REBINDING'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "IntegrationChangeDocumentGuard" BEFORE UPDATE OR DELETE ON public."Document"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_document_guard();
CREATE TRIGGER "IntegrationChangeDocument" AFTER INSERT OR UPDATE ON public."Document"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_document();
CREATE TRIGGER "IntegrationChangeCompanyGuard" BEFORE UPDATE OR DELETE ON public."CompanySettings"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_company_guard();
CREATE TRIGGER "IntegrationChangeCompany" AFTER INSERT OR UPDATE ON public."CompanySettings"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_company();
CREATE TRIGGER "IntegrationChangeDocumentTruncate" BEFORE TRUNCATE ON public."Document"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();
CREATE TRIGGER "IntegrationChangeCompanyTruncate" BEFORE TRUNCATE ON public."CompanySettings"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();
CREATE TRIGGER "IntegrationChangePointGuard" BEFORE UPDATE OR DELETE ON public."EmissionPoint"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_master_guard();
CREATE TRIGGER "IntegrationChangeCounterGuard" BEFORE UPDATE OR DELETE ON public."SeriesCounter"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_master_guard();
CREATE TRIGGER "IntegrationChangeBranchGuard" BEFORE UPDATE OR DELETE ON public."Branch"
  FOR EACH ROW EXECUTE FUNCTION public.integration_change_billing_master_guard();
CREATE TRIGGER "IntegrationChangePointTruncate" BEFORE TRUNCATE ON public."EmissionPoint"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();
CREATE TRIGGER "IntegrationChangeCounterTruncate" BEFORE TRUNCATE ON public."SeriesCounter"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();
CREATE TRIGGER "IntegrationChangeBranchTruncate" BEFORE TRUNCATE ON public."Branch"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();

INSERT INTO public."IntegrationChangeState" ("issuerRuc")
  SELECT "ruc" FROM public."CompanySettings" WHERE "environment"::text='BETA' AND "ruc" ~ '^[1-9][0-9]{10}$'
  UNION SELECT public.integration_change_billing_ruc(d) FROM public."Document" d
    WHERE public.integration_change_billing_ruc(d) IS NOT NULL;
-- Freeze current eligible canonical bindings for the deletion/rebinding gate
-- only. This emits NO events and claims NO backfilled baseline or history.
-- Composite FKs also reject indirect master rebinding under concurrent/RR writes.
INSERT INTO public."IntegrationChangeBinding" ("ownerId","companyId","issuerRuc","pointId","branchId","counterId","type","series")
  SELECT d."id",d."companyId",public.integration_change_billing_ruc(d),d."emissionPointId",
    (d."immutableSnapshot"->>'branchId')::uuid,d."seriesCounterId",d."type",d."series" FROM public."Document" d
    WHERE public.integration_change_billing_ruc(d) IS NOT NULL;
CREATE TRIGGER "IntegrationChangeBindingGuard" BEFORE UPDATE OR DELETE OR TRUNCATE ON public."IntegrationChangeBinding"
  FOR EACH STATEMENT EXECUTE FUNCTION public.integration_change_billing_no_removal();

REVOKE ALL ON public."IntegrationChangeState", public."IntegrationChangeEvent", public."IntegrationChangeBinding" FROM PUBLIC;
REVOKE ALL ON FUNCTION public.integration_change_billing_ruc(public."Document"),
  public.integration_change_billing_append(text, uuid, text), public.integration_change_billing_document_guard(),
  public.integration_change_billing_document(), public.integration_change_billing_company_guard(),
  public.integration_change_billing_company(), public.integration_change_billing_no_removal(),
  public.integration_change_billing_master_guard() FROM PUBLIC;
-- Optional provisioning, deliberately NOT executed: no assumption a role exists.
-- CREATE ROLE factuez_integration_journal_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
-- GRANT USAGE ON SCHEMA public TO factuez_integration_journal_reader;
-- GRANT SELECT ON public."IntegrationChangeState", public."IntegrationChangeEvent" TO factuez_integration_journal_reader;
-- Attach only to a dedicated read login with no inherited owner/table rights.
-- It must have NO write/trigger/function-execute/owner-table or binding grants.
-- trim uses a SEPARATE technical credential: SELECT/UPDATE state, SELECT/DELETE
-- events only; never delete bindings or grant this maintenance role to readers.
COMMIT;
