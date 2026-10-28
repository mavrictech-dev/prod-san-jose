-- CANDIDATE ONLY. Not applied, imported or probed by any runtime/main.
-- SUNAT-owned immutable versions; no public role grants or raw-payload importer.
CREATE TABLE b2b_sunat_batch_member_evidence_version (
 owner_handle uuid PRIMARY KEY,
 document_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 snapshot_sha256 char(64) NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 payload jsonb NOT NULL CHECK((jsonb_typeof(payload)='object' AND payload->>'source'='OWNED') IS TRUE),
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,version),
 CHECK(octet_length(payload::text)<=262144),
 CHECK((payload->'record'->'member'->>'documentId'=document_id::text) IS TRUE),
 CHECK(((payload->'record'->'member'->>'version')::integer=version) IS TRUE),
 CHECK((payload->'record'->'member'->>'snapshotSha256'=snapshot_sha256) IS TRUE)
);
CREATE FUNCTION b2b_sunat_batch_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BATCH_EVIDENCE_IMMUTABLE'; END $$;
CREATE TRIGGER b2b_sunat_batch_evidence_immutable BEFORE UPDATE OR DELETE
 ON b2b_sunat_batch_member_evidence_version FOR EACH ROW
 EXECUTE FUNCTION b2b_sunat_batch_evidence_immutable();
CREATE TRIGGER b2b_sunat_batch_evidence_no_truncate BEFORE TRUNCATE
 ON b2b_sunat_batch_member_evidence_version FOR EACH STATEMENT
 EXECUTE FUNCTION b2b_sunat_batch_evidence_immutable();
-- Provision separate owner capture/read roles in a later reviewed migration.
-- Hash checks detect corruption; they are not provenance or a substitute for producer ownership.

