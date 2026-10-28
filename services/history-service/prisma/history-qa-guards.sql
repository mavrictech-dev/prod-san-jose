-- Rehearsal ONLY, empty isolated cluster/database provisioned by the QA runner.
-- No role creation, grants or migrations against the active FactuEz databases.
DO $$ BEGIN
  IF current_database() !~ '^factuez_history_qa_[a-f0-9]{10}(_restore)?$' THEN
    RAISE EXCEPTION 'HISTORY_SANDBOX_REQUIRED';
  END IF;
END $$;

ALTER TABLE "HistorySandbox" ADD CONSTRAINT "history_synthetic_marker"
  CHECK ("id"=1 AND "environment"='BETA' AND "datasetClass"='SYNTHETIC' AND "schemaVersion"='factuez.history-storage.v1');
ALTER TABLE "HistoryIssuer" ADD CONSTRAINT "history_synthetic_ruc" CHECK ("issuerRuc" ~ '^00000000[0-9]{3}$' AND "companyId">0);
ALTER TABLE "HistoryOwnerMapping" ADD CONSTRAINT "history_mapping_shape" CHECK
  ("documentTypeCode" IN ('01','03','07','08') AND "series" ~ '^[FB][A-Z0-9]{3}$' AND "mappingSha256" ~ '^[a-f0-9]{64}$' AND
   ("documentTypeCode"<>'01' OR left("series",1)='F') AND ("documentTypeCode"<>'03' OR left("series",1)='B'));
ALTER TABLE "HistoryImportJob" ADD CONSTRAINT "history_job_bounds" CHECK
  ("expectedRows" BETWEEN 1 AND 2000 AND "batchSize"=50 AND "completedBatches" BETWEEN 0 AND (("expectedRows"+49)/50) AND
   "inputSha256" ~ '^[a-f0-9]{64}$' AND "planSha256" ~ '^[a-f0-9]{64}$' AND "mappingSha256" ~ '^[a-f0-9]{64}$');
ALTER TABLE "HistoryBatchReceipt" ADD CONSTRAINT "history_receipt_bounds" CHECK
  ("batchIndex" BETWEEN 0 AND 39 AND "rowCount" BETWEEN 1 AND 50 AND "insertedCount" BETWEEN 0 AND "rowCount" AND "recordsSha256" ~ '^[a-f0-9]{64}$');
ALTER TABLE "HistoryRecord" ADD CONSTRAINT "history_record_quarantine" CHECK
  (("candidateOnly"=true AND "disposition"='QUARANTINED' AND "originSystem"='RESTOAPP' AND "number" BETWEEN 1 AND 99999999 AND
   "currencyCode" IN ('PEN','USD') AND "taxableAmount">=0 AND "igvAmount">=0 AND "payableAmount">=0 AND
   "recordId" ~ '^[a-f0-9]{64}$' AND "snapshotSha256" ~ '^[a-f0-9]{64}$' AND
   jsonb_typeof("snapshot")='object' AND jsonb_typeof("artifactKeys")='array' AND
   "snapshot"->>'schemaVersion'='factuez.history-document.v1' AND "snapshot"->>'environment'='BETA' AND
   "snapshot"->'sourceEvidence'->>'authenticity'='NOT_VERIFIED' AND
   "snapshot"->'ownership'->>'issuerRuc'="issuerRuc" AND "snapshot"->'ownership'->>'companyId'="companyId"::text AND
   "snapshot"->'ownership'->>'branchId'="branchId"::text AND "snapshot"->'ownership'->>'emissionPointId'="emissionPointId"::text AND
   "snapshot"->'ownership'->>'seriesCounterId'="seriesCounterId"::text AND "snapshot"->'ownership'->>'mappingId'="mappingId"::text AND
   "snapshot"->'ownership'->>'documentTypeCode'="documentTypeCode" AND "snapshot"->'ownership'->>'series'="series" AND
   "snapshot"->>'number'="number"::text AND "snapshot"->>'originId'="originId") IS TRUE);
ALTER TABLE "HistoryRecordImportLink" ADD CONSTRAINT "history_link_bounds" CHECK
  ("rowOrdinal" BETWEEN 0 AND 1999 AND "snapshotSha256" ~ '^[a-f0-9]{64}$');

CREATE FUNCTION history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'HISTORY_IMMUTABLE';
END $$;
CREATE TRIGGER history_record_immutable BEFORE UPDATE OR DELETE ON "HistoryRecord" FOR EACH ROW EXECUTE FUNCTION history_immutable();
CREATE TRIGGER history_receipt_immutable BEFORE UPDATE OR DELETE ON "HistoryBatchReceipt" FOR EACH ROW EXECUTE FUNCTION history_immutable();
CREATE TRIGGER history_link_immutable BEFORE UPDATE OR DELETE ON "HistoryRecordImportLink" FOR EACH ROW EXECUTE FUNCTION history_immutable();
CREATE TRIGGER history_mapping_immutable BEFORE UPDATE OR DELETE ON "HistoryOwnerMapping" FOR EACH ROW EXECUTE FUNCTION history_immutable();
CREATE TRIGGER history_issuer_immutable BEFORE UPDATE OR DELETE ON "HistoryIssuer" FOR EACH ROW EXECUTE FUNCTION history_immutable();
CREATE TRIGGER history_marker_immutable BEFORE UPDATE OR DELETE ON "HistorySandbox" FOR EACH ROW EXECUTE FUNCTION history_immutable();

CREATE FUNCTION history_job_initial_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW."completedBatches"<>0 THEN RAISE EXCEPTION 'HISTORY_INITIAL_CHECKPOINT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_job_initial BEFORE INSERT ON "HistoryImportJob" FOR EACH ROW EXECUTE FUNCTION history_job_initial_guard();

CREATE FUNCTION history_checkpoint_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected integer; actual integer;
BEGIN
  IF TG_OP<>'UPDATE' OR NEW."completedBatches"<>OLD."completedBatches"+1 OR
    (to_jsonb(NEW)-'completedBatches') IS DISTINCT FROM (to_jsonb(OLD)-'completedBatches') THEN
    RAISE EXCEPTION 'HISTORY_CHECKPOINT_TRANSITION';
  END IF;
  expected := LEAST(50, OLD."expectedRows" - OLD."completedBatches"*50);
  SELECT count(*) INTO actual FROM "HistoryBatchReceipt" WHERE "jobId"=OLD."jobId" AND "batchIndex"=OLD."completedBatches" AND "rowCount"=expected;
  IF actual<>1 THEN RAISE EXCEPTION 'HISTORY_CHECKPOINT_RECEIPT'; END IF;
  SELECT count(*) INTO actual FROM "HistoryRecordImportLink" WHERE "jobId"=OLD."jobId" AND "batchIndex"=OLD."completedBatches"
    AND "rowOrdinal">=OLD."completedBatches"*50 AND "rowOrdinal"<OLD."completedBatches"*50+expected;
  IF actual<>expected THEN RAISE EXCEPTION 'HISTORY_CHECKPOINT_PREFIX'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_checkpoint_transition BEFORE UPDATE OR DELETE ON "HistoryImportJob" FOR EACH ROW EXECUTE FUNCTION history_checkpoint_guard();

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO history_import_qa, history_reader_qa;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, history_import_qa, history_reader_qa;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO history_import_qa, history_reader_qa;
GRANT INSERT ON "HistoryImportJob", "HistoryRecord", "HistoryBatchReceipt", "HistoryRecordImportLink" TO history_import_qa;
GRANT UPDATE ("completedBatches") ON "HistoryImportJob" TO history_import_qa;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
