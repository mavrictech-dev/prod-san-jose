-- Candidate schema for disposable synthetic tests only. Not a migration.
CREATE TABLE public.b2b_historical_original_candidate (
  handle text PRIMARY KEY CHECK (handle ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'),
  document_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version > 0 AND version <= 9007199254740991),
  record_sha256 text NOT NULL CHECK (record_sha256 ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  UNIQUE (document_id, version),
  CHECK ((record->>'handle' = handle) IS TRUE),
  CHECK ((record->'member'->>'documentId' = document_id::text) IS TRUE),
  CHECK ((record->'member'->>'version' = version::text) IS TRUE),
  CHECK ((record->>'recordSha256' = record_sha256) IS TRUE)
);
CREATE FUNCTION public.b2b_historical_original_candidate_no_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'HISTORICAL_ORIGINAL_IMMUTABLE'; END $$;
CREATE TRIGGER b2b_historical_original_candidate_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON public.b2b_historical_original_candidate
FOR EACH STATEMENT EXECUTE FUNCTION public.b2b_historical_original_candidate_no_mutation();

