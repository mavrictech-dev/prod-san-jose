-- Phase 6 standalone blueprint. Apply ONLY via an explicitly configured isolated
-- runner to a NEW, disposable technical test database with synthetic data.
-- Never auto-run or apply to fiscal, SUNAT, live QA or production databases.
-- No migration registration, connection settings, credentials or fiscal objects.
BEGIN;
CREATE TABLE "IntegrationChangeDelivery" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid NOT NULL,
  "contextSha256" text NOT NULL CHECK ("contextSha256" ~ '^[a-f0-9]{64}$'),
  "issuerRuc" text NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "checkpointKey" text NOT NULL CHECK ("checkpointKey" ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "payload" bytea,
  "wipedAt" timestamptz,
  CONSTRAINT "IntegrationChangeDeliveryClientCheckpoint" UNIQUE ("clientId","checkpointKey"),
  CHECK (isfinite("createdAt") AND isfinite("expiresAt")),
  CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '168 hours'),
  CHECK (("payload" IS NOT NULL AND "wipedAt" IS NULL) OR ("payload" IS NULL AND "wipedAt" IS NOT NULL)),
  CHECK ("payload" IS NULL OR CASE WHEN octet_length("payload") BETWEEN 29 AND 4194304
    THEN get_byte("payload",0)=1 ELSE false END)
);
CREATE INDEX "IntegrationChangeDeliveryExpiry" ON "IntegrationChangeDelivery" ("expiresAt","id");
CREATE TABLE "IntegrationChangeDeliveryAudit" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision">0),
  "recordId" uuid NOT NULL,
  "operation" text NOT NULL CHECK ("operation" ~ '^[A-Z][A-Z_]{0,31}$'),
  "sha256" text CHECK ("sha256" IS NULL),
  "byteLength" bigint CHECK ("byteLength" IS NULL),
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "IntegrationChangeDeliveryAuditRecord" ON "IntegrationChangeDeliveryAudit" ("clientId","recordId","at");
COMMIT;
-- The store serializes writes/sweeps with pg_advisory_xact_lock(1985126506).
-- Under that lock it enforces 256 active rows and 33554432 retained ciphertext bytes,
-- including expired ciphertext pending sweep. Each envelope is at most 4194304 bytes.
-- It validates liveness against clock_timestamp(), a TTL of at most 168 hours,
-- expiresAt <= DB clock + 168 hours and a createdAt forward tolerance of 60 seconds,
-- and accepts only ExportVault v1 envelopes. The caller authenticates encryption.
-- Sweeps wipe <=100 expired payloads and delete <=100 tombstones per transaction.
-- Tombstones remain for at least seven days after expiry. Empty polls only audit;
-- they never reserve a delivery or consume the payload/active-row budget.
-- Audit recordId deliberately has NO foreign key (empty polls have no delivery).
-- The consumer keeps the bounded proof source disabled; RATE_LIMITED asks it to
-- take a new cut/retry when capacity is reclaimed. This blueprint does not enable it.
-- Audit is append-only at the API, metadata-only and survives tombstone deletion.
-- TI must provision a dedicated least-privilege role; no foreign/fiscal access.
