-- Opt-in private read audit blueprint. NOT a normal fiscal migration.
-- Apply only to a new authorized isolated test database; never auto-apply at startup.
CREATE TABLE "IntegrationReadAudit" (
  "id" uuid PRIMARY KEY,
  "clientId" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" > 0),
  "issuerRuc" varchar(11) NOT NULL CHECK ("issuerRuc" ~ '^[1-9][0-9]{10}$'),
  "artifactId" uuid NOT NULL,
  "sha256" varchar(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  "byteLength" integer NOT NULL CHECK ("byteLength" BETWEEN 1 AND 10485760),
  "outcome" varchar(30) NOT NULL CHECK ("outcome" = 'READ_VERIFIED'),
  "at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- READ_VERIFIED records authorized bytes ready for response, not proof the client received them.
