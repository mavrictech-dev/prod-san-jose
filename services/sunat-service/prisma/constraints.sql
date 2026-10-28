-- Incorporar estas restricciones a la migración inicial generada por Prisma.
ALTER TABLE "IssuerProjection"
  ADD CONSTRAINT "IssuerProjection_singleton" CHECK ("id" = 1),
  ADD CONSTRAINT "IssuerProjection_ruc_format" CHECK ("ruc" ~ '^[0-9]{11}$'),
  ADD CONSTRAINT "IssuerProjection_ubigeo_format" CHECK ("ubigeo" ~ '^[0-9]{6}$');

ALTER TABLE "SunatCredentials"
  ADD CONSTRAINT "SunatCredentials_singleton" CHECK ("id" = 1);

ALTER TABLE "SunatSubmission"
  ADD CONSTRAINT "SunatSubmission_exactly_one_owner" CHECK (
    ("documentId" IS NOT NULL AND "batchId" IS NULL) OR
    ("documentId" IS NULL AND "batchId" IS NOT NULL)
  ),
  ADD CONSTRAINT "SunatSubmission_attempt_positive" CHECK ("attempt" > 0);

ALTER TABLE "CdrLog"
  ADD CONSTRAINT "CdrLog_exactly_one_owner" CHECK (
    ("documentId" IS NOT NULL AND "batchId" IS NULL) OR
    ("documentId" IS NULL AND "batchId" IS NOT NULL)
  );
