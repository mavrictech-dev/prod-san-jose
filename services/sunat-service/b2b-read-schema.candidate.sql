-- Candidate only: reviewed and applied exclusively to an authorized isolated target.
CREATE TABLE "B2bArtifactAudit" (
  "id" uuid PRIMARY KEY,"clientId" uuid NOT NULL,"clientRevision" integer NOT NULL CHECK ("clientRevision">0),
  "actorKind" text NOT NULL CHECK ("actorKind" IN ('SERVICE','USER')),
  "subjectId" uuid,"userAuthRevision" integer,"issuerRuc" char(11) NOT NULL CHECK ("issuerRuc" ~ '^[0-9]{11}$'),
  "ownerId" uuid NOT NULL,"artifactId" uuid,
  "representation" text NOT NULL CHECK ("representation" IN ('ORIGINAL','CURRENT_LOCAL')),
  "sha256" char(64) NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),"byteLength" integer NOT NULL CHECK ("byteLength" BETWEEN 1 AND 10485760),
  "at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL) OR ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "userAuthRevision" IS NOT NULL))
);
CREATE INDEX ON "B2bArtifactAudit" ("clientId","at");
