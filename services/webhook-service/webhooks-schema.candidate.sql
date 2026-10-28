-- NEW dedicated b2b_webhooks_beta DB ONLY. Not an automatic migration.
CREATE TABLE "WebhookSubscription" ("id" uuid PRIMARY KEY,"owner" text NOT NULL,"revision" integer NOT NULL,"payload" jsonb NOT NULL,"environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'));
CREATE INDEX ON "WebhookSubscription" ("owner","id");
CREATE TABLE "WebhookInbox" ("id" uuid PRIMARY KEY,"hash" char(64) NOT NULL,"payload" jsonb NOT NULL,"environment" text NOT NULL DEFAULT 'BETA' CHECK ("environment"='BETA'));
CREATE TABLE "WebhookDelivery" ("id" uuid PRIMARY KEY,"subscriptionId" uuid NOT NULL REFERENCES "WebhookSubscription"("id"),"eventId" uuid NOT NULL REFERENCES "WebhookInbox"("id"),
  "state" text NOT NULL CHECK ("state" IN ('PENDING','RUNNING','RETRY','DELIVERED','DEAD_LETTER','CANCELLED')),"dueAt" bigint NOT NULL,"leaseUntil" bigint,"payload" jsonb NOT NULL,UNIQUE ("subscriptionId","eventId"));
CREATE INDEX ON "WebhookDelivery" ("state","dueAt");
CREATE TABLE "WebhookAttempt" ("id" uuid PRIMARY KEY,"deliveryId" uuid NOT NULL REFERENCES "WebhookDelivery"("id"),"payload" jsonb NOT NULL);
CREATE TABLE "WebhookCommand" ("owner" text NOT NULL,"keyHash" char(64) NOT NULL,"payload" jsonb NOT NULL,PRIMARY KEY ("owner","keyHash"));
CREATE TABLE "WebhookAudit" ("id" uuid PRIMARY KEY,"payload" jsonb NOT NULL);
