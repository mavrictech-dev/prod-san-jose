-- CANDIDATE ONLY. Apply separately to the approved BETA Identity database.
-- No runtime imports/executes this file. No grants, enrollment or credential storage.
CREATE TABLE "B2bReceivedApproval" (
 "nonceHash" char(64) PRIMARY KEY CHECK ("nonceHash" ~ '^[a-f0-9]{64}$'),
 "approval" jsonb NOT NULL CHECK (jsonb_typeof("approval")='object'),
 "expiresAt" bigint NOT NULL,
 CHECK ("approval"->>'schemaVersion'='factuez.b2b.received-approval.v1'),
 CHECK ("approval"->>'nonceHash'="nonceHash"),
 CHECK (("approval"->>'expiresAt')::bigint="expiresAt"),
 CHECK (("approval"->>'createdAt')::bigint<"expiresAt" AND "expiresAt"-("approval"->>'createdAt')::bigint<=30000)
);
CREATE INDEX "B2bReceivedApproval_expiry" ON "B2bReceivedApproval" ("expiresAt");
-- Preparation/verification append to the EXISTING B2bAudit in the SAME transaction.
-- No tokenOIDC or handle column exists; metadata JSON is written only by the closed server model.
