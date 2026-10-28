-- LOCAL BETA candidate only. Install exclusively into a NEW synthetic disposable database.
-- No migration, runtime activation, legacy table, transport or official outcome is supplied.
CREATE TABLE b2b_batch_member_mutex (id integer PRIMARY KEY CHECK (id = 1));
INSERT INTO b2b_batch_member_mutex VALUES (1);

CREATE TABLE b2b_batch_member_document (
  document_id uuid PRIMARY KEY,
  binding jsonb NOT NULL CHECK (binding->>'environment' = 'BETA'),
  identity_sha256 text NOT NULL CHECK (identity_sha256 ~ '^[a-f0-9]{64}$'),
  fiscal_identity text NOT NULL UNIQUE,
  current_version integer NOT NULL CHECK (current_version > 0),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE b2b_batch_member_version (
  document_id uuid NOT NULL REFERENCES b2b_batch_member_document(document_id),
  version integer NOT NULL CHECK (version > 0),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  admission_sha256 text NOT NULL UNIQUE CHECK (admission_sha256 ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 2097152),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  provenance jsonb NOT NULL,
  PRIMARY KEY (document_id, version)
);
CREATE INDEX b2b_batch_member_artifact ON b2b_batch_member_version ((provenance->>'verifierId'), (provenance->>'artifactId'));
CREATE TABLE b2b_batch_member_history (
  original_id uuid PRIMARY KEY REFERENCES b2b_batch_member_document(document_id),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE b2b_batch_member_grant (
  grant_key text PRIMARY KEY CHECK (grant_key ~ '^[a-f0-9]{64}$'),
  policy jsonb NOT NULL CHECK (policy->'binding'->>'environment' = 'BETA'),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE TABLE b2b_batch_member_counter (
  counter_key text PRIMARY KEY,
  last_number integer NOT NULL CHECK (last_number BETWEEN 1 AND 99999)
);
CREATE TABLE b2b_batch_member_reservation (
  journal_key text PRIMARY KEY,
  operation_sha256 text NOT NULL UNIQUE CHECK (operation_sha256 ~ '^[a-f0-9]{64}$'),
  batch_id uuid NOT NULL UNIQUE,
  event_id uuid NOT NULL UNIQUE,
  correlation_id uuid NOT NULL UNIQUE,
  identifier text NOT NULL,
  counter_key text NOT NULL REFERENCES b2b_batch_member_counter(counter_key),
  UNIQUE (counter_key, identifier)
);
CREATE TABLE b2b_batch_member_claim (
  document_id uuid PRIMARY KEY REFERENCES b2b_batch_member_document(document_id),
  journal_key text NOT NULL REFERENCES b2b_batch_member_reservation(journal_key)
);
CREATE TABLE b2b_batch_member_command (
  batch_id uuid PRIMARY KEY REFERENCES b2b_batch_member_reservation(batch_id),
  command_sha256 text NOT NULL CHECK (command_sha256 ~ '^[a-f0-9]{64}$'),
  command jsonb NOT NULL CHECK (octet_length(command::text) <= 2097152),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object' AND request->'scope'->>'environment' = 'BETA'
    AND octet_length(request::text) <= 2097152),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  ubl text NOT NULL CHECK (octet_length(ubl) BETWEEN 1 AND 4194304),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object' AND subject ?& ARRAY['kind','clientId','subjectId'] AND
    ((subject->>'kind' = 'SERVICE' AND subject->'subjectId' = 'null'::jsonb) OR
    (subject->>'kind' = 'USER' AND subject->>'subjectId' ~ '^[a-f0-9-]{36}$')))
);
CREATE TABLE b2b_batch_member_local_outbox (
  event_id uuid PRIMARY KEY REFERENCES b2b_batch_member_reservation(event_id),
  batch_id uuid NOT NULL UNIQUE REFERENCES b2b_batch_member_command(batch_id),
  topic text NOT NULL CHECK (topic = 'factuez.b2b.batch.local.prepared.v1'),
  payload jsonb NOT NULL CHECK (payload->>'localOnly' = 'true' AND payload->>'fiscalExecutionEnabled' = 'false'
    AND payload->>'officialAcceptance' = 'false')
);
CREATE TABLE b2b_batch_member_journal (
  journal_key text PRIMARY KEY REFERENCES b2b_batch_member_reservation(journal_key),
  batch_id uuid NOT NULL UNIQUE REFERENCES b2b_batch_member_command(batch_id),
  record jsonb NOT NULL CHECK (octet_length(record::text) <= 2097152),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION b2b_batch_member_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'BATCH_APPEND_ONLY'; END $$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['b2b_batch_member_version','b2b_batch_member_reservation',
    'b2b_batch_member_claim','b2b_batch_member_command','b2b_batch_member_local_outbox','b2b_batch_member_journal'] LOOP
    EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION b2b_batch_member_immutable()', name);
  END LOOP;
END $$;
CREATE FUNCTION b2b_batch_member_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.revision <> OLD.revision + 1 THEN RAISE EXCEPTION 'BATCH_REVISION_REQUIRED'; END IF;
  IF TG_TABLE_NAME = 'b2b_batch_member_document' THEN
    IF (NEW.document_id <> OLD.document_id OR NEW.binding <> OLD.binding OR NEW.identity_sha256 <> OLD.identity_sha256 OR
      NEW.fiscal_identity <> OLD.fiscal_identity OR NEW.current_version <> OLD.current_version + 1)
    THEN RAISE EXCEPTION 'BATCH_IDENTITY_IMMUTABLE'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'b2b_batch_member_grant' THEN
    IF (NEW.grant_key <> OLD.grant_key OR NEW.policy->'subject' <> OLD.policy->'subject' OR
      NEW.policy->'binding' <> OLD.policy->'binding' OR NEW.policy->>'kind' <> OLD.policy->>'kind' OR
      NEW.policy->>'permission' <> OLD.policy->>'permission') THEN RAISE EXCEPTION 'BATCH_GRANT_IDENTITY_IMMUTABLE'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'b2b_batch_member_history' THEN
    IF NEW.original_id <> OLD.original_id THEN RAISE EXCEPTION 'BATCH_HISTORY_IDENTITY_IMMUTABLE'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision BEFORE UPDATE OR DELETE ON b2b_batch_member_document FOR EACH ROW EXECUTE FUNCTION b2b_batch_member_revision();
CREATE TRIGGER revision BEFORE UPDATE OR DELETE ON b2b_batch_member_grant FOR EACH ROW EXECUTE FUNCTION b2b_batch_member_revision();
CREATE TRIGGER revision BEFORE UPDATE OR DELETE ON b2b_batch_member_history FOR EACH ROW EXECUTE FUNCTION b2b_batch_member_revision();
