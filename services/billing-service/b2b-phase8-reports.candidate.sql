-- Candidate only. Explicit application to a NEW synthetic test database only in this block.
-- No owner tables, counters, archive guards, clients, grants or production migrations.
CREATE TABLE "B2bP8ReportJob" (
  id uuid PRIMARY KEY,
  owner_key text NOT NULL CHECK (owner_key ~ '^[0-9a-f]{64}$'),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('QUEUED','READY')),
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 20000000),
  content_bytes bytea,
  CONSTRAINT "B2bP8ReportJob_owner_idem" UNIQUE (owner_key,key_hash),
  CHECK ((state='QUEUED' AND revision=1 AND content_bytes IS NULL) OR
         (state='READY' AND revision=2 AND octet_length(content_bytes) BETWEEN 1 AND 25165824 AND content_bytes IS NOT NULL)),
  CHECK (payload->>'id' = id::text AND payload->>'ownerKey' = owner_key AND payload->>'keyHash' = key_hash AND
         payload->>'requestHash' = request_hash AND payload->>'state' = state AND (payload->>'revision')::integer = revision),
  CHECK (payload->'capture'->'filters'->>'environment' = 'BETA')
);
REVOKE ALL ON "B2bP8ReportJob" FROM PUBLIC;