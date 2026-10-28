BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:production-batches:billing:v1',0));
CREATE TABLE "ProductionBatchesCounter" ("issuerRuc" varchar(11) NOT NULL,"kind" text NOT NULL CHECK("kind" IN ('RC','RA')),"issueDate" date NOT NULL,"nextNumber" integer NOT NULL DEFAULT 1 CHECK("nextNumber" BETWEEN 1 AND 100000),PRIMARY KEY("issuerRuc","kind","issueDate"));
CREATE TABLE "ProductionBatchesRoute" ("documentId" uuid PRIMARY KEY REFERENCES "Document"("id"),"issuerRuc" varchar(11) NOT NULL,"mode" text NOT NULL CHECK("mode" IN ('INDIVIDUAL','BATCH_PENDING')),"token" uuid NOT NULL UNIQUE,"transmissionStarted" boolean NOT NULL DEFAULT false,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesDeclaration" ("id" uuid PRIMARY KEY,"documentId" uuid NOT NULL REFERENCES "Document"("id"),"issuerRuc" varchar(11) NOT NULL,"snapshotSha256" char(64) NOT NULL,"actorId" uuid NOT NULL,"assertedAt" timestamptz NOT NULL,"reason" varchar(100) NOT NULL,"status" text NOT NULL CHECK("status"='NOT_DELIVERED'),"payload" jsonb NOT NULL);
CREATE TABLE "ProductionBatchesReservation" ("batchId" uuid PRIMARY KEY,"operationId" uuid UNIQUE NOT NULL,"actorId" uuid NOT NULL,"issuerRuc" varchar(11) NOT NULL,"requestSha256" char(64) NOT NULL,"snapshotSha256" char(64) NOT NULL,"payload" jsonb NOT NULL,"state" text NOT NULL DEFAULT 'QUEUED',"outcome" jsonb,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesMember" ("batchId" uuid NOT NULL REFERENCES "ProductionBatchesReservation"("batchId"),"documentId" uuid NOT NULL REFERENCES "Document"("id"),"snapshotSha256" char(64) NOT NULL,"active" boolean NOT NULL DEFAULT true,PRIMARY KEY("batchId","documentId"));
CREATE UNIQUE INDEX "ProductionBatchesMember_active" ON "ProductionBatchesMember"("documentId") WHERE "active";
CREATE TABLE "ProductionBatchesOutbox" ("id" uuid PRIMARY KEY,"payload" jsonb NOT NULL,"publishedAt" timestamptz,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesInbox" ("id" uuid PRIMARY KEY,"payloadSha256" char(64) NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
-- No DELETE/release path: UNKNOWN, rejection and cancellation retain reservations until an audited reconciliation.
COMMIT;
