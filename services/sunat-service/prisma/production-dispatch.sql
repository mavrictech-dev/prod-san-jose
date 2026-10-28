-- Additive schema only. Review against the installed schema before applying.
-- No application data, counters, certificates or credentials are read or modified.
BEGIN;
CREATE TABLE "FiscalDispatchAuthorization" (
  "issuerRuc" CHAR(11) NOT NULL,
  "environment" "SunatEnvironment" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "profile" VARCHAR(64) NOT NULL,
  "credentialRevision" INTEGER NOT NULL CHECK ("credentialRevision" >= 0),
  "certificateFingerprint" CHAR(64) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "actorId" UUID NOT NULL,
  "registrationAttestedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("issuerRuc", "environment"),
  CHECK ("environment" = 'PRODUCTION'),
  CHECK ("profile" = '01-PEN-0101-IGV18-v1'),
  CHECK ("enabled" = false OR "registrationAttestedAt" IS NOT NULL)
);
CREATE TABLE "FiscalDispatchAudit" (
  "id" UUID PRIMARY KEY,
  "issuerRuc" CHAR(11) NOT NULL,
  "environment" "SunatEnvironment" NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL,
  "credentialRevision" INTEGER NOT NULL,
  "actorId" UUID NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "FiscalDispatchAudit_issuerRuc_environment_occurredAt_idx"
ON "FiscalDispatchAudit" ("issuerRuc", "environment", "occurredAt");
COMMIT;
