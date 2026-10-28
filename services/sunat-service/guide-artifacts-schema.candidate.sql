-- REVIEW CANDIDATE. Apply only to a NEW isolated synthetic DB in this phase.
-- No activation, fiscal Outbox, production, key/password or customer migration.
BEGIN;
CREATE FUNCTION guide_artifact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'GUIDE_ARTIFACT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TABLE "GuideLocalArtifact" (
  "operationId" uuid PRIMARY KEY,
  "documentId" uuid NOT NULL UNIQUE,
  "issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^(10|15|16|17|20)[0-9]{9}$'),
  "fullNumber" text NOT NULL CHECK ("fullNumber" ~ '^[TV][A-Z0-9]{3}-[1-9][0-9]{0,7}$'),
  "metadata" jsonb NOT NULL CHECK (jsonb_typeof("metadata")='object' AND octet_length("metadata"::text) BETWEEN 1 AND 16384),
  "metadataSha256" text NOT NULL CHECK ("metadataSha256" ~ '^[a-f0-9]{64}$'),
  "unsignedXml" bytea NOT NULL CHECK (octet_length("unsignedXml") BETWEEN 1 AND 2097152),
  "signedXml" bytea NOT NULL CHECK (octet_length("signedXml") BETWEEN 1 AND 2097152),
  "zip" bytea NOT NULL CHECK (octet_length("zip") BETWEEN 22 AND 4194304),
  "certificatePem" text NOT NULL CHECK (octet_length("certificatePem") BETWEEN 1 AND 65536 AND "certificatePem" NOT LIKE '%PRIVATE KEY%'),
  UNIQUE ("issuerRuc","fullNumber"),
  UNIQUE ("operationId","metadataSha256"),
  CHECK ("metadata" @> '{"schemaVersion":"factuez.guide-artifacts-local.v1","environment":"BETA","candidateOnly":true,"fiscalExecutionEnabled":false,"transmissionAuthorized":false,"authorizedForTransfer":false,"officialRulesValidated":false,"officialCdrVerified":false,"certificateTrusted":false,"signatureVerifiedLocally":true}'),
  CHECK ("metadata"->>'guideType' IS NOT NULL AND (("metadata"->>'guideType'='09' AND left("fullNumber",1)='T') OR ("metadata"->>'guideType'='31' AND left("fullNumber",1)='V'))),
  CHECK ("metadata"->>'documentId' IS NOT NULL AND "metadata"->>'documentId'="documentId"::text),
  CHECK ("metadata"->>'issuerRuc' IS NOT NULL AND "metadata"->>'issuerRuc'="issuerRuc"),
  CHECK ("metadata"->>'fullNumber' IS NOT NULL AND "metadata"->>'fullNumber'="fullNumber"),
  CHECK ("metadata"#>>'{scope,operationId}' IS NOT NULL AND "metadata"#>>'{scope,operationId}'="operationId"::text),
  CHECK ("metadata"#>>'{scope,binding,draft,anchor,environment}' IS NOT NULL AND "metadata"#>>'{scope,binding,draft,anchor,environment}'='BETA'),
  CHECK ("metadata"#>>'{scope,binding,draft,anchor,issuerRuc}' IS NOT NULL AND "metadata"#>>'{scope,binding,draft,anchor,issuerRuc}'="issuerRuc"),
  CHECK ("metadata"->>'xmlSha256' IS NOT NULL AND "metadata"->>'xmlSha256'=encode(sha256("signedXml"),'hex')),
  CHECK ("metadata"->>'unsignedXmlSha256' IS NOT NULL AND "metadata"->>'unsignedXmlSha256'=encode(sha256("unsignedXml"),'hex')),
  CHECK ("metadata"->>'zipSha256' IS NOT NULL AND "metadata"->>'zipSha256'=encode(sha256("zip"),'hex'))
);
CREATE TRIGGER guide_artifact_no_change BEFORE UPDATE OR DELETE ON "GuideLocalArtifact"
  FOR EACH ROW EXECUTE FUNCTION guide_artifact_immutable();
CREATE TRIGGER guide_artifact_no_truncate BEFORE TRUNCATE ON "GuideLocalArtifact"
  FOR EACH STATEMENT EXECUTE FUNCTION guide_artifact_immutable();
COMMENT ON TABLE "GuideLocalArtifact" IS 'Immutable local BETA guide originals. Local signature is not PKI trust, official CDR or transfer authorization.';
CREATE TABLE "GuideLocalCdr" (
  "operationId" uuid PRIMARY KEY,
  "packageSha256" text NOT NULL CHECK ("packageSha256" ~ '^[a-f0-9]{64}$'),
  "evidence" jsonb NOT NULL CHECK (jsonb_typeof("evidence")='object' AND octet_length("evidence"::text) BETWEEN 1 AND 131072),
  "zip" bytea NOT NULL CHECK (octet_length("zip") BETWEEN 22 AND 4194304),
  FOREIGN KEY ("operationId","packageSha256") REFERENCES "GuideLocalArtifact" ("operationId","metadataSha256"),
  CHECK ("evidence" @> '{"profile":"LOCAL_GUIDE_CDR_REVIEW_V1","source":"LOCAL_EMULATOR","requestHashesBoundByCdr":false,"signatureTrusted":true,"cryptographicReceiptVerified":true,"bindingComplete":true,"officialCdrVerified":false,"transmissionAuthorized":false,"authorizedForTransfer":false}'),
  CHECK ("evidence"->>'cdrZipSha256' IS NOT NULL AND "evidence"->>'cdrZipSha256'=encode(sha256("zip"),'hex'))
);
CREATE TRIGGER guide_cdr_no_change BEFORE UPDATE OR DELETE ON "GuideLocalCdr"
  FOR EACH ROW EXECUTE FUNCTION guide_artifact_immutable();
CREATE TRIGGER guide_cdr_no_truncate BEFORE TRUNCATE ON "GuideLocalCdr"
  FOR EACH STATEMENT EXECUTE FUNCTION guide_artifact_immutable();
COMMIT;
