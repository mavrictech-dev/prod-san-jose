BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtextextended('factuez:production-batches:sunat:v1',0));
CREATE TABLE "ProductionBatchesGrant" ("issuerRuc" varchar(11) PRIMARY KEY,"profile" text NOT NULL,"enabled" boolean NOT NULL DEFAULT false,"version" integer NOT NULL DEFAULT 0,"credentialRevision" integer NOT NULL,"fingerprint" char(64) NOT NULL,"actorId" uuid NOT NULL,"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesGrantAudit" ("id" uuid PRIMARY KEY,"issuerRuc" varchar(11) NOT NULL,"version" integer NOT NULL,"payload" jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesRoute" ("documentId" uuid PRIMARY KEY,"issuerRuc" varchar(11) NOT NULL,"token" uuid NOT NULL,"mode" text NOT NULL CHECK("mode" IN ('BATCH_PENDING','INDIVIDUAL')),"transmissionStarted" boolean NOT NULL DEFAULT false);
CREATE TABLE "ProductionBatchesDispatch" ("batchId" uuid PRIMARY KEY,"eventId" uuid UNIQUE NOT NULL,"issuerRuc" varchar(11) NOT NULL,"snapshotSha256" char(64) NOT NULL,"payload" jsonb NOT NULL,"state" text NOT NULL DEFAULT 'QUEUED' CHECK("state" IN ('QUEUED','PREPARED','SENDING','SUBMITTED','ACCEPTED','REJECTED','UNKNOWN','BLOCKED')),"ticket" varchar(120),"manifest" jsonb,"cdrManifest" jsonb,"grant" jsonb,"responseCode" varchar(10),"createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE "ProductionBatchesNumber" ("ownerId" uuid PRIMARY KEY,"issuerRuc" varchar(11) NOT NULL,"kind" text NOT NULL CHECK("kind" IN ('RC','RA')),"issueDate" date NOT NULL,"identifier" varchar(40) NOT NULL, UNIQUE("issuerRuc","identifier"));
CREATE TABLE "ProductionBatchesMember" ("batchId" uuid NOT NULL REFERENCES "ProductionBatchesDispatch"("batchId"),"documentId" uuid NOT NULL,"snapshotSha256" char(64) NOT NULL,"active" boolean NOT NULL DEFAULT true,PRIMARY KEY("batchId","documentId"));
CREATE UNIQUE INDEX "ProductionBatchesMember_reserved" ON "ProductionBatchesMember"("documentId") WHERE "active";
CREATE TABLE "ProductionBatchesStatusOutbox" ("id" uuid PRIMARY KEY,"payload" jsonb NOT NULL,"publishedAt" timestamptz,"createdAt" timestamptz NOT NULL DEFAULT now());
-- Reserved members remain locked on UNKNOWN/rejection. Reconciliation must be an explicit future audited command.
COMMIT;
