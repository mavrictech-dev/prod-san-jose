-- Candidate only. Apply solely to a NEW disposable database for rehearsal.
-- No changes to Customer/Shift/FuelProduct schemas, counters, issuance or Outbox. FuelProduct is the shared catalogue source.
BEGIN;
CREATE TABLE "B2bP8Customer" (
  id uuid PRIMARY KEY, issuer_id integer NOT NULL CHECK (issuer_id>0), issuer_ruc char(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
  environment text NOT NULL DEFAULT 'BETA' CHECK (environment='BETA'),
  identity_type text NOT NULL CHECK (identity_type IN ('1','4','6','7','A')), identity_number varchar(15) NOT NULL,
  revision integer NOT NULL CHECK (revision>0), search_text text NOT NULL, payload jsonb NOT NULL,
  UNIQUE (issuer_id,issuer_ruc,environment,identity_type,identity_number),
  CHECK (payload->>'id'=id::text AND (payload->>'revision')::integer=revision AND (payload->>'issuerId')::integer=issuer_id
    AND payload->>'issuerRuc'=issuer_ruc AND payload->>'environment'=environment
    AND payload->>'identityType'=identity_type AND payload->>'identityNumber'=identity_number)
);
CREATE INDEX "B2bP8Customer_scope" ON "B2bP8Customer" (issuer_id,issuer_ruc,environment,id);
-- Existing FuelProduct schema is unchanged; this is CAS metadata, never a parallel catalogue.
CREATE TABLE "B2bP8ProductRevision" (
  product_id uuid PRIMARY KEY REFERENCES "FuelProduct"(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision>0), source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE "B2bP8Shift" (
  id uuid PRIMARY KEY, issuer_id integer NOT NULL CHECK (issuer_id>0), issuer_ruc char(11) NOT NULL CHECK (issuer_ruc ~ '^[0-9]{11}$'),
  environment text NOT NULL DEFAULT 'BETA' CHECK (environment='BETA'), branch_id uuid NOT NULL, point_id uuid NOT NULL,
  binding jsonb NOT NULL, actor_key varchar(160) NOT NULL, state text NOT NULL CHECK (state IN ('OPEN','CLOSED')),
  revision integer NOT NULL CHECK (revision>0), currency char(3) NOT NULL CHECK (currency IN ('PEN','USD')),
  balance numeric(14,2) NOT NULL CHECK (balance>=0), payload jsonb NOT NULL,
  CHECK ((binding->>'issuerId')::integer=issuer_id AND binding->>'issuerRuc'=issuer_ruc AND binding->>'environment'=environment
    AND binding->>'branchId'=branch_id::text AND binding->>'pointId'=point_id::text
    AND binding->>'documentType' IN ('01','03') AND binding->>'seriesId' ~ '^[a-f0-9-]{36}$'),
  CHECK (payload->>'id'=id::text AND payload->'binding'=binding AND payload->>'actorKey'=actor_key
    AND payload->>'state'=state AND (payload->>'revision')::integer=revision AND payload->>'currency'=currency
    AND (payload->>'balance')::numeric=balance),
  CHECK ((state='OPEN' AND payload->>'closedAt' IS NULL AND payload->>'countedAmount' IS NULL AND payload->>'difference' IS NULL)
    OR (state='CLOSED' AND payload->>'closedAt' IS NOT NULL AND payload->>'countedAmount' IS NOT NULL AND payload->>'difference' IS NOT NULL))
);
-- Physical point uniqueness deliberately ignores actor, series and currency.
CREATE UNIQUE INDEX "B2bP8Shift_one_open_point" ON "B2bP8Shift" (issuer_id,issuer_ruc,environment,branch_id,point_id) WHERE state='OPEN';
CREATE INDEX "B2bP8Shift_actor_scope" ON "B2bP8Shift" (actor_key,issuer_id,issuer_ruc,point_id,id);
CREATE TABLE "B2bP8Movement" (
  id uuid PRIMARY KEY, shift_id uuid NOT NULL REFERENCES "B2bP8Shift"(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision>0), kind text NOT NULL CHECK (kind IN ('OPEN','IN','OUT','CLOSE')),
  amount numeric(14,2) NOT NULL CHECK (amount>=0 AND (kind NOT IN ('IN','OUT') OR amount>0)),
  balance_after numeric(14,2) NOT NULL CHECK (balance_after>=0), payload jsonb NOT NULL,
  UNIQUE (shift_id,revision),
  CHECK (payload->>'id'=id::text AND payload->>'shiftId'=shift_id::text AND (payload->>'revision')::integer=revision
    AND payload->>'kind'=kind AND (payload->>'amount')::numeric=amount AND (payload->>'balanceAfter')::numeric=balance_after)
);
CREATE UNIQUE INDEX "B2bP8Movement_one_open" ON "B2bP8Movement" (shift_id) WHERE kind='OPEN';
CREATE UNIQUE INDEX "B2bP8Movement_one_close" ON "B2bP8Movement" (shift_id) WHERE kind='CLOSE';
CREATE TABLE "B2bP8Operation" (
  id uuid PRIMARY KEY, actor_key varchar(160) NOT NULL, key_hash char(64) NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  environment text NOT NULL DEFAULT 'BETA' CHECK (environment='BETA'), payload jsonb NOT NULL,
  UNIQUE (actor_key,key_hash),
  CHECK (payload->>'id'=id::text AND payload->>'actorKey'=actor_key AND payload->>'keyHash'=key_hash AND payload->>'requestHash'=request_hash
    AND payload->'binding'->>'environment'='BETA' AND payload->>'permissionRevision' IS NOT NULL)
);
-- Closed shift histories are immutable even if another caller has raw candidate-store access.
CREATE FUNCTION "b2b_p8_guard_shift"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP='DELETE' OR OLD.state='CLOSED' THEN RAISE EXCEPTION 'P8_CLOSED_SHIFT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.id<>OLD.id OR NEW.binding<>OLD.binding OR NEW.actor_key<>OLD.actor_key OR NEW.currency<>OLD.currency
    OR NEW.issuer_id<>OLD.issuer_id OR NEW.issuer_ruc<>OLD.issuer_ruc OR NEW.branch_id<>OLD.branch_id OR NEW.point_id<>OLD.point_id
    OR NEW.environment<>OLD.environment OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'P8_SHIFT_IDENTITY_OR_REVISION' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER "B2bP8Shift_guard" BEFORE UPDATE OR DELETE ON "B2bP8Shift" FOR EACH ROW EXECUTE FUNCTION "b2b_p8_guard_shift"();
CREATE FUNCTION "b2b_p8_append_only"() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN RAISE EXCEPTION 'P8_APPEND_ONLY' USING ERRCODE='23514'; END $body$;
CREATE TRIGGER "B2bP8Movement_immutable" BEFORE UPDATE OR DELETE ON "B2bP8Movement" FOR EACH ROW EXECUTE FUNCTION "b2b_p8_append_only"();
CREATE TRIGGER "B2bP8Operation_immutable" BEFORE UPDATE OR DELETE ON "B2bP8Operation" FOR EACH ROW EXECUTE FUNCTION "b2b_p8_append_only"();
CREATE FUNCTION "b2b_p8_guard_movement"() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE s "B2bP8Shift"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "B2bP8Shift" WHERE id=NEW.shift_id FOR UPDATE;
  IF NOT FOUND OR NEW.revision<>s.revision OR NEW.balance_after<>s.balance OR
    (NEW.kind='CLOSE')<>(s.state='CLOSED') OR (NEW.kind='OPEN' AND NEW.revision<>1) THEN
    RAISE EXCEPTION 'P8_MOVEMENT_STATE_OR_REVISION' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $body$;
CREATE TRIGGER "B2bP8Movement_guard" BEFORE INSERT ON "B2bP8Movement" FOR EACH ROW EXECUTE FUNCTION "b2b_p8_guard_movement"();
COMMIT;

