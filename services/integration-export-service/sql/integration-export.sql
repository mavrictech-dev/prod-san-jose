-- Reviewed blueprint for a NEW dedicated integration_exports_beta database only.
-- Never run automatically, on Billing/SUNAT databases, or on the active QA database.
CREATE TABLE "IntegrationExportRecord" (
  "id" uuid PRIMARY KEY, "kind" text NOT NULL CHECK ("kind" IN ('CUT','EXPORT')),
  "clientId" uuid NOT NULL, "contextSha256" char(64) NOT NULL,
  "issuerRuc" char(11) NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "keyHash" char(64), "requestSha256" char(64), "createdAt" timestamptz NOT NULL, "expiresAt" timestamptz NOT NULL,
  "state" text NOT NULL CHECK ("state" IN ('CAPTURING','QUEUED','RUNNING','READY','FAILED','EXPIRED')),
  "payload" bytea, "content" bytea, "contentSha256" char(64), "manifestSha256" char(64), "failureCode" text,
  "lease" uuid, "leaseExpiresAt" timestamptz,
  CHECK (("kind"='EXPORT' AND "keyHash" IS NOT NULL AND "requestSha256" IS NOT NULL) OR
         ("kind"='CUT' AND "keyHash" IS NULL AND "requestSha256" IS NULL)),
  CHECK (octet_length("payload") <= 100663325), CHECK (octet_length("content") <= 67108893),
  UNIQUE ("clientId","keyHash")
);
CREATE INDEX "IntegrationExportQueue" ON "IntegrationExportRecord" ("state","createdAt");
CREATE TABLE "IntegrationExportAudit" (
  "id" uuid PRIMARY KEY, "requestId" uuid NOT NULL, "clientId" uuid NOT NULL, "revision" integer NOT NULL CHECK ("revision">0),
  "recordId" uuid NOT NULL, "operation" text NOT NULL CHECK ("operation" IN ('LIST','DETAIL','CREATE','STATUS','MANIFEST','DOWNLOAD')),
  "sha256" char(64), "byteLength" bigint, "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Least privilege roles are provisioned by TI. No foreign access, emission tables or filesystem paths.
