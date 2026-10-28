-- NEW synthetic DB ONLY. Not an applied migration, not a publisher or fiscal gate.
CREATE TABLE "B2bCorrectionHoldHead" (
  "originalDocumentId" uuid PRIMARY KEY REFERENCES "Document"("id"),
  "companyId" integer NOT NULL REFERENCES "CompanySettings"("id"),
  "branchId" uuid NOT NULL,"pointId" uuid NOT NULL,"issuerRuc" char(11) NOT NULL,
  "environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'),
  "candidateOnly" boolean NOT NULL DEFAULT true CHECK ("candidateOnly"=true),
  "originalSha256" char(64) NOT NULL CHECK ("originalSha256" ~ '^[a-f0-9]{64}$'),
  "originalAmount" numeric(18,2) NOT NULL CHECK ("originalAmount">0),
  "creditHeld" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("creditHeld">=0 AND "creditHeld"<="originalAmount"),
  "debitHeld" numeric(18,2) NOT NULL DEFAULT 0 CHECK ("debitHeld">=0),
  "revision" integer NOT NULL CHECK ("revision">=0),
  FOREIGN KEY ("originalDocumentId","companyId") REFERENCES "Document"("id","companyId"),
  FOREIGN KEY ("branchId","companyId") REFERENCES "Branch"("id","companyId"),
  FOREIGN KEY ("pointId","companyId") REFERENCES "EmissionPoint"("id","companyId")
);
CREATE TABLE "B2bCorrectionHold" (
  "operationId" uuid PRIMARY KEY,
  "originalDocumentId" uuid NOT NULL REFERENCES "B2bCorrectionHoldHead"("originalDocumentId"),
  "documentId" uuid NOT NULL UNIQUE REFERENCES "Document"("id"),
  "eventId" uuid NOT NULL UNIQUE REFERENCES "OutboxEvent"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('CREDIT','DEBIT')),
  "amount" numeric(18,2) NOT NULL CHECK ("amount">0),
  "revision" integer NOT NULL CHECK ("revision">0),
  "commandSha256" char(64) NOT NULL CHECK ("commandSha256" ~ '^[a-f0-9]{64}$'),
  "noteSha256" char(64) NOT NULL CHECK ("noteSha256" ~ '^[a-f0-9]{64}$'),
  "actor" jsonb NOT NULL,"createdAt" timestamptz NOT NULL,
  "candidateOnly" boolean NOT NULL DEFAULT true CHECK ("candidateOnly"=true),
  CHECK ("operationId"="documentId"),
  UNIQUE ("originalDocumentId","revision")
);
CREATE INDEX "B2bCorrectionHoldOriginal" ON "B2bCorrectionHold" ("originalDocumentId","operationId");
CREATE FUNCTION "b2bCorrectionHoldImmutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CANDIDATE_HOLD_IMMUTABLE'; END $$;
CREATE TRIGGER "B2bCorrectionHoldNoRewrite" BEFORE UPDATE OR DELETE ON "B2bCorrectionHold" FOR EACH ROW EXECUTE FUNCTION "b2bCorrectionHoldImmutable"();
CREATE FUNCTION "b2bCorrectionHeadMonotonic"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CANDIDATE_HEAD_IMMUTABLE'; END IF;
  IF (to_jsonb(NEW)-ARRAY['creditHeld','debitHeld','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['creditHeld','debitHeld','revision']) OR
     NEW."creditHeld"<OLD."creditHeld" OR NEW."debitHeld"<OLD."debitHeld" OR NEW."revision"<>OLD."revision"+1
  THEN RAISE EXCEPTION 'CANDIDATE_HEAD_NON_MONOTONIC'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "B2bCorrectionHeadNoRewrite" BEFORE UPDATE OR DELETE ON "B2bCorrectionHoldHead" FOR EACH ROW EXECUTE FUNCTION "b2bCorrectionHeadMonotonic"();
