-- REVIEW ONLY. BETA prepared configuration; never invoked by readiness or runtime.
-- Independent from CorporateSmtpConfiguration (QA) and corporate delivery activation.
BEGIN;
DO $$ BEGIN
 IF current_database()<>'factuez_mailer_beta' THEN RAISE EXCEPTION 'B2B_HOST_SMTP_BETA_DATABASE_REQUIRED'; END IF;
END $$;
CREATE TABLE public."B2bHostSmtpPreparedSchema" (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version text NOT NULL CHECK(version='factuez.b2b.host-smtp.prepared.v1')
);
INSERT INTO public."B2bHostSmtpPreparedSchema" VALUES(true,'factuez.b2b.host-smtp.prepared.v1');
CREATE TABLE public."B2bHostSmtpConfiguration" (
 "issuerRuc" varchar(11) PRIMARY KEY CHECK("issuerRuc" ~ '^[0-9]{11}$'),
 "companyId" integer NOT NULL CHECK("companyId">0),
 "configurationCipher" varchar(5700) NOT NULL CHECK("configurationCipher" ~ '^v1\.[0-9]{1,5}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
 "keyVersion" integer NOT NULL CHECK("keyVersion" BETWEEN 1 AND 10000),
 revision integer NOT NULL CHECK(revision>0), "updatedBy" uuid NOT NULL,
 "updatedAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(split_part("configurationCipher",'.',2)="keyVersion"::text)
);
CREATE TABLE public."B2bHostSmtpConfigurationAudit" (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 "issuerRuc" varchar(11) NOT NULL CHECK("issuerRuc" ~ '^[0-9]{11}$'),
 "companyId" integer NOT NULL CHECK("companyId">0), "actorId" uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), "credentialsReplaced" boolean NOT NULL,
 action varchar(40) NOT NULL DEFAULT 'smtp.configuration.saved' CHECK(action='smtp.configuration.saved'),
 "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("issuerRuc",revision)
);
CREATE FUNCTION public.b2b_host_smtp_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='B2bHostSmtpConfigurationAudit' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'B2B_HOST_SMTP_IMMUTABLE'; END IF;
  IF NEW."issuerRuc"<>OLD."issuerRuc" OR NEW."companyId"<>OLD."companyId" OR NEW.revision<>OLD.revision+1
   THEN RAISE EXCEPTION 'B2B_HOST_SMTP_REVISION_CONFLICT'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b2b_host_smtp_immutable BEFORE UPDATE OR DELETE ON public."B2bHostSmtpConfiguration"
 FOR EACH ROW EXECUTE FUNCTION public.b2b_host_smtp_guard();
CREATE TRIGGER b2b_host_smtp_audit_immutable BEFORE UPDATE OR DELETE ON public."B2bHostSmtpConfigurationAudit"
 FOR EACH ROW EXECUTE FUNCTION public.b2b_host_smtp_guard();
CREATE FUNCTION public.b2b_host_smtp_require_audit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.revision<>1 THEN RAISE EXCEPTION 'B2B_HOST_SMTP_INITIAL_REVISION'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public."B2bHostSmtpConfigurationAudit" a WHERE a."issuerRuc"=NEW."issuerRuc"
  AND a."companyId"=NEW."companyId" AND a.revision=NEW.revision AND a."actorId"=NEW."updatedBy")
  THEN RAISE EXCEPTION 'B2B_HOST_SMTP_AUDIT_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b2b_host_smtp_audit_required AFTER INSERT OR UPDATE ON public."B2bHostSmtpConfiguration"
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.b2b_host_smtp_require_audit();
REVOKE ALL ON public."B2bHostSmtpPreparedSchema",public."B2bHostSmtpConfiguration",public."B2bHostSmtpConfigurationAudit" FROM PUBLIC;
-- Integrator reviews installation/ownership/grants offline. No GRANT to QA or shared roles.
COMMIT;
