-- REVIEW CANDIDATE: NEW isolated synthetic database only. SUNAT-owned, opt-in.
-- No legacy/FiscalBatch writes, emission, queue consumption, migration or activation.
BEGIN;
CREATE FUNCTION batch_local_artifact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BATCH_LOCAL_ARTIFACT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TABLE "BatchLocalArtifact" (
  "batchId" uuid PRIMARY KEY,
  "eventId" uuid NOT NULL UNIQUE,
  "commandSha256" text NOT NULL UNIQUE CHECK ("commandSha256" ~ '^[a-f0-9]{64}$'),
  "issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^(10|15|16|17|20)[0-9]{9}$'),
  "identifier" text NOT NULL CHECK ("identifier" ~ '^(RC|RA)-[0-9]{8}-[1-9][0-9]{0,4}$'),
  "metadata" jsonb NOT NULL CHECK (jsonb_typeof("metadata")='object' AND octet_length("metadata"::text) BETWEEN 1 AND 16384),
  "metadataSha256" text NOT NULL CHECK ("metadataSha256" ~ '^[a-f0-9]{64}$'),
  "unsignedXml" bytea NOT NULL CHECK (octet_length("unsignedXml") BETWEEN 1 AND 2097152),
  "signedXml" bytea NOT NULL CHECK (octet_length("signedXml") BETWEEN 1 AND 2097152),
  "zip" bytea NOT NULL CHECK (octet_length("zip") BETWEEN 22 AND 4194304),
  "certificatePem" text NOT NULL CHECK (octet_length("certificatePem") BETWEEN 1 AND 65536 AND "certificatePem" NOT LIKE '%PRIVATE KEY%'),
  UNIQUE ("issuerRuc","identifier"), UNIQUE ("batchId","metadataSha256"),
  CHECK ("metadata" @> '{"schemaVersion":"factuez.batch-artifacts-local.v1","candidateOnly":true,"localOnly":true,"fiscalExecutionEnabled":false,"transmissionAuthorized":false,"officialCdrVerified":false,"certificateTrusted":false,"signatureVerifiedLocally":true}'),
  CHECK ("metadata"->>'operationId' IS NOT NULL AND "metadata"->>'operationId'="batchId"::text),
  CHECK ("metadata"->>'identifier' IS NOT NULL AND "metadata"->>'identifier'="identifier"),
  CHECK ("metadata"->>'kind' IS NOT NULL AND "metadata"->>'kind'=left("identifier",2)),
  CHECK ("metadata"#>>'{scope,environment}' IS NOT NULL AND "metadata"#>>'{scope,environment}'='BETA'),
  CHECK ("metadata"#>>'{scope,batchId}' IS NOT NULL AND "metadata"#>>'{scope,batchId}'="batchId"::text),
  CHECK ("metadata"#>>'{scope,issuerRuc}' IS NOT NULL AND "metadata"#>>'{scope,issuerRuc}'="issuerRuc"),
  CHECK ("metadata"#>>'{scope,companyId}' IS NOT NULL AND "metadata"#>>'{scope,companyId}' ~ '^[1-9][0-9]*$'),
  CHECK ("metadata"#>>'{scope,branchId}' IS NOT NULL AND "metadata"#>>'{scope,branchId}' ~ '^[a-f0-9-]{36}$'),
  CHECK ("metadata"->>'eventId' IS NOT NULL AND "metadata"->>'eventId'="eventId"::text),
  CHECK ("metadata"->>'commandSha256' IS NOT NULL AND "metadata"->>'commandSha256'="commandSha256"),
  CHECK ("metadata"->>'envelopeSha256' IS NOT NULL AND "metadata"->>'envelopeSha256' ~ '^[a-f0-9]{64}$'),
  CHECK ("metadata"->>'batchSnapshotSha256' IS NOT NULL AND "metadata"->>'batchSnapshotSha256' ~ '^[a-f0-9]{64}$'),
  CHECK ("metadata"->>'unsignedXmlSha256' IS NOT NULL AND "metadata"->>'unsignedXmlSha256'=encode(sha256("unsignedXml"),'hex')),
  CHECK ("metadata"->>'xmlSha256' IS NOT NULL AND "metadata"->>'xmlSha256'=encode(sha256("signedXml"),'hex')),
  CHECK ("metadata"->>'zipSha256' IS NOT NULL AND "metadata"->>'zipSha256'=encode(sha256("zip"),'hex'))
);
CREATE TRIGGER batch_local_artifact_no_change BEFORE UPDATE OR DELETE ON "BatchLocalArtifact"
  FOR EACH ROW EXECUTE FUNCTION batch_local_artifact_immutable();
CREATE TRIGGER batch_local_artifact_no_truncate BEFORE TRUNCATE ON "BatchLocalArtifact"
  FOR EACH STATEMENT EXECUTE FUNCTION batch_local_artifact_immutable();
CREATE TABLE "BatchLocalCdr" (
  "batchId" uuid PRIMARY KEY,
  "packageSha256" text NOT NULL CHECK ("packageSha256" ~ '^[a-f0-9]{64}$'),
  "evidence" jsonb NOT NULL CHECK (jsonb_typeof("evidence")='object' AND octet_length("evidence"::text) BETWEEN 1 AND 131072),
  "zip" bytea NOT NULL CHECK (octet_length("zip") BETWEEN 22 AND 4194304),
  FOREIGN KEY ("batchId","packageSha256") REFERENCES "BatchLocalArtifact" ("batchId","metadataSha256"),
  CHECK ("evidence" @> '{"schemaVersion":"factuez.batch-cdr-local.v1","source":"LOCAL_EMULATOR","requestHashesBoundByCdr":false,"signatureVerifiedLocally":true,"officialCdrVerified":false,"transmissionAuthorized":false,"memberAcceptanceGranted":false}'),
  CHECK ("evidence"->>'batchId' IS NOT NULL AND "evidence"->>'batchId'="batchId"::text),
  CHECK ("evidence"->>'cdrZipSha256' IS NOT NULL AND "evidence"->>'cdrZipSha256'=encode(sha256("zip"),'hex')),
  CHECK ("evidence"->>'cdrXmlSha256' IS NOT NULL AND "evidence"->>'cdrXmlSha256' ~ '^[a-f0-9]{64}$'),
  CHECK ("evidence"->>'responseCode' IS NOT NULL AND "evidence"->>'responseCode' ~ '^[0-9]{1,8}$'),
  CHECK ("evidence"->>'status' IS NOT NULL AND (("evidence"->>'responseCode'='0' AND "evidence"->>'status' IN ('ACCEPTED','ACCEPTED_WITH_OBSERVATIONS')) OR ("evidence"->>'responseCode'<>'0' AND "evidence"->>'status'='REJECTED')))
);
CREATE TRIGGER batch_local_cdr_no_change BEFORE UPDATE OR DELETE ON "BatchLocalCdr"
  FOR EACH ROW EXECUTE FUNCTION batch_local_artifact_immutable();
CREATE TRIGGER batch_local_cdr_no_truncate BEFORE TRUNCATE ON "BatchLocalCdr"
  FOR EACH STATEMENT EXECUTE FUNCTION batch_local_artifact_immutable();
COMMENT ON TABLE "BatchLocalArtifact" IS 'Original locally signed synthetic BETA RC/RA packages; not official PKI, dispatch or acceptance.';
COMMENT ON TABLE "BatchLocalCdr" IS 'Original local CDR ZIP, not request ZIP; cannot grant member acceptance or be silently overwritten.';
COMMIT;
