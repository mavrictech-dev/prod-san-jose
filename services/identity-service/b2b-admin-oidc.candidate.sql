-- Candidate ONLY: provision in a NEW/copied Identity database after rollout approval.
-- No statements grant roles, enable an application, or link a provider subject.
CREATE TABLE "B2bAdminOidcLink" (
 "id" uuid PRIMARY KEY,
 "userId" uuid NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT,
 "issuer" varchar(1024) NOT NULL CHECK ("issuer" LIKE 'https://%' AND octet_length("issuer")<=1024),
 "subject" varchar(255) NOT NULL CHECK (length("subject")>0),
 "oidcClientId" varchar(120) NOT NULL CHECK ("oidcClientId" ~ '^[A-Za-z0-9_-]{1,120}$'),
 "enabled" boolean NOT NULL DEFAULT false,
 "userAuthRevision" integer NOT NULL CHECK ("userAuthRevision">0),
 "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision">0),
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("issuer","subject","oidcClientId")
);
COMMENT ON TABLE "B2bAdminOidcLink" IS 'Explicit offline/admin enrollment only; no automatic email/username linking. Readers never write this table.';
