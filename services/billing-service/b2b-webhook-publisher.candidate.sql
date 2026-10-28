-- NEW synthetic Billing DB only, after b2b-issuance-schema.candidate.sql.
-- A separate cursor/lease; no changes to legacy OutboxEvent.publishedAt.
ALTER TABLE "B2bCommitEvent" ADD COLUMN "fanoutLease" uuid;
ALTER TABLE "B2bCommitEvent" ADD COLUMN "fanoutLeaseUntil" timestamptz;
ALTER TABLE "B2bCommitEvent" ADD COLUMN "fanoutAttempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "B2bCommitEvent" ADD COLUMN "fanoutLastCode" text;
