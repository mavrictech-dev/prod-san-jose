-- BETA LOCAL candidate; apply only to a NEW isolated synthetic database.
-- Not a migration or startup script. Requires masters + b2b-guide-drafts DDL.
CREATE TABLE "CarrierGuideSeries" (
 "draftSeriesId" uuid PRIMARY KEY REFERENCES "B2bGuideDraftSeries"("id") ON DELETE RESTRICT,
 "fiscalSeriesId" uuid NOT NULL UNIQUE,"companyId" integer NOT NULL,
 "revision" integer NOT NULL DEFAULT 1 CHECK ("revision">0),"active" boolean NOT NULL DEFAULT true,
 "purpose" text NOT NULL DEFAULT 'LOCAL_CANDIDATE' CHECK ("purpose"='LOCAL_CANDIDATE'),
 FOREIGN KEY ("fiscalSeriesId","companyId") REFERENCES "SeriesCounter"("id","companyId") ON DELETE RESTRICT,
 UNIQUE ("draftSeriesId","fiscalSeriesId","companyId")
);
CREATE TABLE "CarrierGuideRegistryVersion" (
 "companyId" integer NOT NULL REFERENCES "CompanySettings"("id") ON DELETE RESTRICT,
 "revision" integer NOT NULL CHECK ("revision">0),"payload" jsonb NOT NULL,
 PRIMARY KEY ("companyId","revision"),
 CHECK (("payload"->>'schemaVersion'='factuez.carrier-guide-registry.v1' AND "payload"->>'companyId'="companyId"::text
   AND "payload"->>'revision'="revision"::text AND octet_length("payload"::text)<=262144) IS TRUE)
);
CREATE TABLE "CarrierGuideRegistryHead" (
 "companyId" integer PRIMARY KEY,"revision" integer NOT NULL CHECK ("revision">0),"active" boolean NOT NULL,
 FOREIGN KEY ("companyId","revision") REFERENCES "CarrierGuideRegistryVersion"("companyId","revision") ON DELETE RESTRICT
);
CREATE TABLE "CarrierGuideDraft" (
 "id" uuid PRIMARY KEY,"clientId" uuid NOT NULL,"actorKey" text NOT NULL,"binding" jsonb NOT NULL,"payload" jsonb NOT NULL,
 CHECK (("binding"->'draft'->>'guideType'='31' AND "binding"->'draft'->'anchor'->>'environment'='BETA'
   AND "payload"->>'id'="id"::text AND "payload"->>'clientId'="clientId"::text AND "payload"->>'actorKey'="actorKey"
   AND "payload"->'binding'="binding" AND "payload"->>'revision'='1'
   AND "payload"->'body'->'transport'->>'mode'='01' AND octet_length("payload"::text)<=262144) IS TRUE)
);
CREATE TABLE "CarrierReference09Version" (
 "documentId" uuid NOT NULL,"revision" integer NOT NULL CHECK ("revision">0),
 "ownerSnapshot" jsonb NOT NULL,"ownerSnapshotSha256" text NOT NULL CHECK ("ownerSnapshotSha256" ~ '^[a-f0-9]{64}$'),
 "projection" jsonb NOT NULL,"projectionSha256" text NOT NULL CHECK ("projectionSha256" ~ '^[a-f0-9]{64}$'),
 "signedXml" bytea NOT NULL CHECK (octet_length("signedXml") BETWEEN 1 AND 393216),
 "signedXmlSha256" text NOT NULL CHECK ("signedXmlSha256"=encode(sha256("signedXml"),'hex')),
 "cdrXml" bytea NOT NULL CHECK (octet_length("cdrXml") BETWEEN 1 AND 393216),
 "cdrSha256" text NOT NULL CHECK ("cdrSha256"=encode(sha256("cdrXml"),'hex')),
 "acceptance" jsonb NOT NULL,PRIMARY KEY ("documentId","revision"),
 CHECK (("ownerSnapshot"->>'schemaVersion'='factuez.public-guide09-issued-owner.v1'
   AND "ownerSnapshot"->>'documentId'="documentId"::text
   AND "ownerSnapshot"->'body'->>'transportMode'='01' AND "ownerSnapshot"->'body'->>'reasonCode'='01'
   AND "ownerSnapshot"->'body'->'regulatedGoods'='false'::jsonb
   AND "projection"->>'schemaVersion'='factuez.carrier-reference09-owner.v1' AND "projection"->>'documentType'='09'
   AND "projection"->>'transportMode'='01' AND "projection"->>'documentId'="documentId"::text
   AND "projection"->'regulatedGoods'='false'::jsonb
   AND "acceptance"->>'documentId'="documentId"::text AND "acceptance"->>'snapshotSha256'="projectionSha256"
   AND "acceptance"->>'cdrSha256'="cdrSha256" AND "acceptance"->>'responseCode'='0'
   AND "acceptance"->>'environment'='BETA' AND "acceptance"->>'status' IN ('ACCEPTED','ACCEPTED_WITH_OBSERVATIONS')
   AND octet_length("ownerSnapshot"::text)<=262144 AND octet_length("projection"::text)<=262144) IS TRUE)
);
CREATE TABLE "CarrierReference09Head" (
 "documentId" uuid PRIMARY KEY,"revision" integer NOT NULL CHECK ("revision">0),"active" boolean NOT NULL,
 FOREIGN KEY ("documentId","revision") REFERENCES "CarrierReference09Version"("documentId","revision") ON DELETE RESTRICT
);
CREATE TABLE "CarrierReference09Access" (
 "referenceId" uuid NOT NULL REFERENCES "CarrierReference09Head"("documentId") ON DELETE RESTRICT,
 "companyId" integer NOT NULL,"branchId" uuid NOT NULL,"issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
 "revision" integer NOT NULL CHECK ("revision">0),"active" boolean NOT NULL,
 PRIMARY KEY ("referenceId","companyId","branchId"),
 FOREIGN KEY ("branchId","companyId") REFERENCES "Branch"("id","companyId") ON DELETE RESTRICT
);
CREATE TABLE "CarrierGuideDocument" (
 "documentId" uuid PRIMARY KEY,"operationId" uuid NOT NULL UNIQUE,"draftId" uuid NOT NULL UNIQUE REFERENCES "CarrierGuideDraft"("id") ON DELETE RESTRICT,
 "companyId" integer NOT NULL,"issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
 "draftSeriesId" uuid NOT NULL,"fiscalSeriesId" uuid NOT NULL,"binding" jsonb NOT NULL,
 "series" text NOT NULL CHECK ("series" ~ '^V[A-Z0-9]{3}$'),"number" bigint NOT NULL CHECK ("number" BETWEEN 1 AND 99999999),
 "snapshot" jsonb NOT NULL,"snapshotSha256" text NOT NULL CHECK ("snapshotSha256" ~ '^[a-f0-9]{64}$'),
 UNIQUE ("issuerRuc","series","number"),UNIQUE ("documentId","operationId"),
 FOREIGN KEY ("draftSeriesId","fiscalSeriesId","companyId") REFERENCES "CarrierGuideSeries"("draftSeriesId","fiscalSeriesId","companyId") ON DELETE RESTRICT,
 CHECK (("binding"->'draft'->>'guideType'='31' AND "binding"->'draft'->'anchor'->>'environment'='BETA'
   AND "binding"->'draft'->'anchor'->>'issuerId'="companyId"::text AND "binding"->'draft'->'anchor'->>'issuerRuc'="issuerRuc"
   AND "binding"->'draft'->>'guideSeriesId'="draftSeriesId"::text AND "binding"->>'fiscalSeriesId'="fiscalSeriesId"::text
   AND "snapshot"->>'schemaVersion'='factuez.carrier-issued-local.v1'
   AND "snapshot"->>'documentId'="documentId"::text AND "snapshot"->>'operationId'="operationId"::text
   AND "snapshot"->>'draftId'="draftId"::text AND "snapshot"->'binding'="binding"
   AND "snapshot"->'issuer'->>'ruc'="issuerRuc" AND "snapshot"->>'series'="series" AND "snapshot"->>'number'="number"::text
   AND jsonb_typeof("snapshot"->'number')='string' AND "snapshot"->>'fullNumber'="series"||'-'||"number"::text
   AND "snapshot"->'body'->'transport'->>'mode'='01' AND "snapshot"->'body'->'transport'->'carrier'->>'ruc'="issuerRuc"
   AND "snapshot"->'body'->'totalTransfer'='true'::jsonb AND "snapshot"->'body'->>'freightPayer'='SENDER'
   AND "snapshot"->'body'->'subcontracted'='false'::jsonb AND "snapshot"->'body'->'regulatedGoods'='false'::jsonb
   AND jsonb_typeof("snapshot"->'body'->'items')='array' AND jsonb_array_length("snapshot"->'body'->'items') BETWEEN 1 AND 100
   AND "snapshot"->'candidateOnly'='true'::jsonb AND "snapshot"->'numberReserved'='true'::jsonb
   AND "snapshot"->'fiscalExecutionEnabled'='false'::jsonb AND "snapshot"->'transmissionAuthorized'='false'::jsonb
   AND "snapshot"->'authorizedForTransfer'='false'::jsonb AND "snapshot"->'officialRulesValidated'='false'::jsonb
   AND "snapshot"->'officialCdrVerified'='false'::jsonb AND octet_length("snapshot"::text)<=262144) IS TRUE)
);
CREATE TABLE "CarrierGuideItem" (
 "documentId" uuid NOT NULL REFERENCES "CarrierGuideDocument"("documentId") ON DELETE RESTRICT,
 "position" integer NOT NULL CHECK ("position" BETWEEN 1 AND 100),"payload" jsonb NOT NULL,
 PRIMARY KEY ("documentId","position")
);
CREATE TABLE "CarrierGuideReferenceBinding" (
 "documentId" uuid PRIMARY KEY REFERENCES "CarrierGuideDocument"("documentId") ON DELETE RESTRICT,
 "referenceId" uuid NOT NULL,"referenceRevision" integer NOT NULL,"accessRevision" integer NOT NULL CHECK ("accessRevision">0),
 "ownerSnapshotSha256" text NOT NULL,"projectionSha256" text NOT NULL,"signedXmlSha256" text NOT NULL,"cdrSha256" text NOT NULL,
 FOREIGN KEY ("referenceId","referenceRevision") REFERENCES "CarrierReference09Version"("documentId","revision") ON DELETE RESTRICT
);
CREATE TABLE "CarrierGuideReceipt" (
 "documentId" uuid PRIMARY KEY REFERENCES "CarrierGuideDocument"("documentId") ON DELETE RESTRICT,
 "clientId" uuid NOT NULL,"actorKey" text NOT NULL,"keySha256" text NOT NULL CHECK ("keySha256" ~ '^[a-f0-9]{64}$'),
 "requestSha256" text NOT NULL CHECK ("requestSha256" ~ '^[a-f0-9]{64}$'),"payload" jsonb NOT NULL,"responseBytes" bytea NOT NULL,
 UNIQUE ("clientId","actorKey","keySha256"),
 CHECK (("payload"->>'clientId'="clientId"::text AND "payload"->>'actorKey'="actorKey"
   AND "payload"->>'keySha256'="keySha256" AND "payload"->>'requestSha256'="requestSha256"
   AND "payload"->'response'->>'schemaVersion'='factuez.b2b.carrier-guide-issuance.v1'
   AND "payload"->'response'->'snapshot'->>'documentId'="documentId"::text
   AND "payload"->'response'->'replayed'='false'::jsonb
   AND "payload"->'actor'->>'clientId'="clientId"::text AND "payload"->'actor'->>'revision'="payload"->>'clientRevision'
   AND (("payload"->'actor'->>'kind'='SERVICE' AND "actorKey"='SERVICE:-'
         AND "payload"->'actor'->'subjectId'='null'::jsonb AND "payload"->'actor'->'userAuthRevision'='null'::jsonb)
     OR ("payload"->'actor'->>'kind'='USER' AND "actorKey"='USER:'||("payload"->'actor'->>'subjectId')
         AND ("payload"->'actor'->>'subjectId') ~ '^[a-f0-9-]{36}$' AND ("payload"->'actor'->>'userAuthRevision')::integer>=0))
   AND octet_length("payload"::text)<=262144 AND octet_length("responseBytes") BETWEEN 1 AND 262144
   AND convert_from("responseBytes",'UTF8')::jsonb="payload"->'response') IS TRUE)
);
CREATE TABLE "CarrierGuideLocalOutbox" (
 "documentId" uuid PRIMARY KEY,"operationId" uuid NOT NULL UNIQUE,
 "eventType" text NOT NULL CHECK ("eventType"='carrier.guide.issue.prepared.local.v1'),"payload" jsonb NOT NULL,
 FOREIGN KEY ("documentId","operationId") REFERENCES "CarrierGuideDocument"("documentId","operationId") ON DELETE RESTRICT
);
CREATE FUNCTION carrier_guide_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CARRIER_GUIDE_IMMUTABLE'; END $$;
CREATE FUNCTION carrier_guide_versioned() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' OR NEW."revision"<>OLD."revision"+1 OR
   (to_jsonb(NEW)-ARRAY['revision','active']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','active'])
 THEN RAISE EXCEPTION 'CARRIER_GUIDE_REVISION_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION carrier_guide_numbered_masters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM "CarrierGuideSeries" m JOIN "B2bGuideDraftSeries" g ON g."id"=m."draftSeriesId" AND g."companyId"=m."companyId"
   JOIN "SeriesCounter" f ON f."id"=m."fiscalSeriesId" AND f."companyId"=m."companyId"
   JOIN "CompanySettings" c ON c."id"=m."companyId"
   JOIN "EmissionPoint" p ON p."id"=f."emissionPointId" AND p."companyId"=c."id"
   JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=c."id"
   JOIN "SeriesCounter" a ON a."id"=(NEW."binding"->'draft'->'anchor'->>'seriesId')::uuid
     AND a."companyId"=c."id" AND a."emissionPointId"=p."id"
   WHERE m."draftSeriesId"=NEW."draftSeriesId" AND m."fiscalSeriesId"=NEW."fiscalSeriesId" AND m."companyId"=NEW."companyId"
     AND m."active" AND m."purpose"='LOCAL_CANDIDATE' AND g."active" AND g."guideType"='31' AND g."purpose"='DRAFT_ONLY'
     AND g."label"=NEW."series" AND g."pointId"=p."id" AND f."series"=NEW."series" AND f."active"
     AND f."documentType"='DESPATCH_ADVICE' AND f."nextNumber"=NEW."number"+1
     AND c."ruc"=NEW."issuerRuc" AND c."active" AND c."environment"='BETA' AND b."active" AND p."active" AND a."active"
     AND b."id"=(NEW."binding"->'draft'->'anchor'->>'branchId')::uuid
     AND p."id"=(NEW."binding"->'draft'->'anchor'->>'pointId')::uuid
     AND a."documentType"::text=CASE NEW."binding"->'draft'->'anchor'->>'documentType' WHEN '01' THEN 'INVOICE' WHEN '03' THEN 'SALES_RECEIPT' ELSE '' END
 ) THEN RAISE EXCEPTION 'CARRIER_GUIDE_NUMBERED_MASTERS_INVALID'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER carrier_numbered_masters BEFORE INSERT ON "CarrierGuideDocument"
 FOR EACH ROW EXECUTE FUNCTION carrier_guide_numbered_masters();
-- Cross-table deferred guards reject incomplete or mismatched immutable bundles
-- even when a caller bypasses the application producer.
CREATE FUNCTION carrier_guide_bundle_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc uuid; h "CarrierGuideDocument"; r "CarrierGuideReceipt"; d "CarrierGuideDraft"; n integer;
BEGIN
 doc:=NEW."documentId"; SELECT * INTO STRICT h FROM "CarrierGuideDocument" WHERE "documentId"=doc;
 SELECT * INTO STRICT r FROM "CarrierGuideReceipt" WHERE "documentId"=doc;
 SELECT * INTO STRICT d FROM "CarrierGuideDraft" WHERE "id"=h."draftId";
 IF r."payload"->'response'->'snapshot' IS DISTINCT FROM h."snapshot"
   OR r."payload"->'response'->>'snapshotSha256' IS DISTINCT FROM h."snapshotSha256"
   OR r."payload"->'response'->'binding' IS DISTINCT FROM h."binding"
   OR r."payload"->'response'->>'draftId' IS DISTINCT FROM h."draftId"::text
   OR r."payload"->'response'->>'operationId' IS DISTINCT FROM h."operationId"::text
   OR r."clientId" IS DISTINCT FROM d."clientId" OR r."actorKey" IS DISTINCT FROM d."actorKey"
   OR d."binding" IS DISTINCT FROM h."binding" OR d."payload"->'body' IS DISTINCT FROM h."snapshot"->'body'
   OR d."payload"->>'revision' IS DISTINCT FROM h."snapshot"->>'draftRevision'
 THEN RAISE EXCEPTION 'CARRIER_GUIDE_BUNDLE_MISMATCH'; END IF;
 SELECT count(*) INTO n FROM "CarrierGuideItem" WHERE "documentId"=doc;
 IF n<>jsonb_array_length(h."snapshot"->'body'->'items') OR EXISTS (
   SELECT 1 FROM "CarrierGuideItem" i WHERE i."documentId"=doc AND i."payload" IS DISTINCT FROM h."snapshot"->'body'->'items'->(i."position"-1))
   OR NOT EXISTS (SELECT 1 FROM "CarrierGuideLocalOutbox" o WHERE o."documentId"=doc AND o."operationId"=h."operationId" AND o."payload"=h."snapshot")
   OR NOT EXISTS (SELECT 1 FROM "CarrierGuideReferenceBinding" p JOIN "CarrierReference09Version" v
     ON v."documentId"=p."referenceId" AND v."revision"=p."referenceRevision"
     WHERE p."documentId"=doc AND p."referenceId"::text=h."snapshot"->'body'->'reference09'->>'documentId'
       AND p."projectionSha256"=h."snapshot"->'body'->'reference09'->>'snapshotSha256'
       AND p."ownerSnapshotSha256"=v."ownerSnapshotSha256" AND p."projectionSha256"=v."projectionSha256"
       AND p."signedXmlSha256"=v."signedXmlSha256" AND p."cdrSha256"=v."cdrSha256")
 THEN RAISE EXCEPTION 'CARRIER_GUIDE_CHILDREN_INCOMPLETE'; END IF;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['CarrierGuideRegistryVersion','CarrierGuideDraft','CarrierReference09Version','CarrierGuideDocument','CarrierGuideReferenceBinding','CarrierGuideItem','CarrierGuideReceipt','CarrierGuideLocalOutbox'] LOOP
   EXECUTE format('CREATE TRIGGER carrier_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION carrier_guide_immutable()',t);
   EXECUTE format('CREATE TRIGGER carrier_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION carrier_guide_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['CarrierGuideSeries','CarrierGuideRegistryHead','CarrierReference09Head','CarrierReference09Access'] LOOP
   EXECUTE format('CREATE TRIGGER carrier_versioned BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION carrier_guide_versioned()',t);
   EXECUTE format('CREATE TRIGGER carrier_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION carrier_guide_immutable()',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['CarrierGuideDocument','CarrierGuideReferenceBinding','CarrierGuideItem','CarrierGuideReceipt','CarrierGuideLocalOutbox'] LOOP
   EXECUTE format('CREATE CONSTRAINT TRIGGER carrier_complete AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION carrier_guide_bundle_complete()',t);
 END LOOP;
END $$;
