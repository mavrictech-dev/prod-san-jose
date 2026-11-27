-- Operator-only, fixed two-series scope. Wrapper must verify backup and reviewed
-- preview SHA before substituting the input marker. Missing input always aborts.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
-- REVIEWED_INPUT_REQUIRED
DO $guard$
DECLARE
 plan jsonb := current_setting('factuez.gre.cleanup.reviewed',true)::jsonb;
 snapshot jsonb; targets uuid[]; company integer; expected jsonb;
 relation record; fk record; has_reference boolean; joins text; removed jsonb;
 known_audit jsonb; actual_audit jsonb; audit_id uuid; audit_hash text; audit_count integer; extra_predicate text;
BEGIN
 IF plan IS NULL OR COALESCE(plan->>'backupSha256','') !~ '^[a-f0-9]{64}$' OR
    plan->'snapshot'->>'version' IS DISTINCT FROM 'factuez.gre-series-cleanup-preview.v2' OR
    plan->'snapshot'->>'issuerRuc' IS DISTINCT FROM '20600979630' OR
    plan->'snapshot'->>'documentType' IS DISTINCT FROM 'DESPATCH_ADVICE' OR
    jsonb_typeof(plan->'snapshot'->'rows') IS DISTINCT FROM 'array' OR
    jsonb_array_length(plan->'snapshot'->'rows')<>2 THEN
  RAISE EXCEPTION 'GRE_CLEANUP_REVIEW_REQUIRED';
 END IF;
 snapshot := plan->'snapshot';
 IF jsonb_typeof(snapshot->'creationAudit') IS DISTINCT FROM 'array' OR jsonb_array_length(snapshot->'creationAudit')>1 THEN RAISE EXCEPTION 'GRE_CLEANUP_AUDIT_REVIEW_REQUIRED'; END IF;
 SELECT array_agg((e->>'id')::uuid ORDER BY e->>'id') INTO targets FROM jsonb_array_elements(snapshot->'rows') e;
 IF targets[1]=targets[2] THEN RAISE EXCEPTION 'GRE_CLEANUP_EXACT_TWO_REQUIRED'; END IF;
 -- Fixed order blocks counter writers and new foreign keys during inspection.
 LOCK TABLE public."SeriesCounter" IN SHARE ROW EXCLUSIVE MODE;
 PERFORM 1 FROM public."SeriesCounter" WHERE id=ANY(targets) ORDER BY id FOR UPDATE;
 -- Existing history/outbox writers must also wait; timeout/deadlock aborts all.
 FOR relation IN SELECT n.nspname,c.relname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname
 LOOP EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE',relation.nspname,relation.relname); END LOOP;
 SELECT id INTO company FROM public."CompanySettings" WHERE ruc='20600979630';
 IF company IS NULL OR (SELECT count(*) FROM public."SeriesCounter" WHERE "companyId"=company AND "documentType"='DESPATCH_ADVICE' AND series IN ('T099','T100'))<>2 THEN
  RAISE EXCEPTION 'GRE_CLEANUP_EXACT_TWO_REQUIRED';
 END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements(snapshot->'rows') LOOP
  IF NOT (expected ?& ARRAY['id','companyId','emissionPointId','documentType','series','environment','nextNumber','active','masterRevision','createdAt','updatedAt']) OR
     expected->>'series' NOT IN ('T099','T100') OR expected->>'nextNumber' IS DISTINCT FROM '1' OR
     expected->>'documentType' IS DISTINCT FROM 'DESPATCH_ADVICE' OR
     expected->>'environment' IS DISTINCT FROM (CASE expected->>'series' WHEN 'T099' THEN 'BETA' WHEN 'T100' THEN 'PRODUCTION' END) OR
     NOT EXISTS (SELECT 1 FROM public."SeriesCounter" s WHERE s.id=(expected->>'id')::uuid AND s."companyId"=company
      AND s."nextNumber"=1 AND (to_jsonb(s)-'nextNumber') @> (expected-'nextNumber')
      AND s."masterRevision"=(expected->>'masterRevision')::integer) THEN
   RAISE EXCEPTION 'GRE_CLEANUP_SNAPSHOT_CHANGED_OR_USED';
  END IF;
 END LOOP;
 -- The only exception is one exact, reviewed T099/BETA creation row, never a table-wide exemption.
 SELECT count(*) INTO audit_count FROM public."ConfigurationAudit" a JOIN public."SeriesCounter" s ON a."entityId"=s.id::text JOIN public."CompanySettings" c ON c.id=s."companyId" WHERE a.action='series.created' AND a."entityId"=s.id::text
 AND s.series='T099' AND s.environment='BETA' AND s."documentType"='DESPATCH_ADVICE' AND c.ruc='20600979630'
 AND jsonb_typeof(a.metadata)='object'
 AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(a.metadata)='object' THEN a.metadata ELSE '{}'::jsonb END) key)=ARRAY['changedFields','companyId','environment','issuerRuc','softDelete']::text[]
 AND a.metadata->'companyId'=to_jsonb(s."companyId") AND a.metadata->>'issuerRuc'=c.ruc
 AND a.metadata->>'environment'=s.environment::text AND a.metadata->'softDelete'='false'::jsonb
 AND jsonb_typeof(a.metadata->'changedFields')='array' AND jsonb_array_length(CASE WHEN jsonb_typeof(a.metadata->'changedFields')='array' THEN a.metadata->'changedFields' ELSE '[]'::jsonb END)=2
 AND a.metadata->'changedFields' @> '["documentType","series"]'::jsonb;
 IF audit_count<>jsonb_array_length(snapshot->'creationAudit') THEN RAISE EXCEPTION 'GRE_CLEANUP_AUDIT_SNAPSHOT_CHANGED'; END IF;
 IF audit_count=1 THEN
  known_audit:=snapshot->'creationAudit'->0;
  SELECT jsonb_build_object('id',a.id,'actorId',a."actorId",'action',a.action,'entityId',a."entityId",'metadata',a.metadata,'createdAt',a."createdAt") INTO actual_audit FROM public."ConfigurationAudit" a JOIN public."SeriesCounter" s ON a."entityId"=s.id::text JOIN public."CompanySettings" c ON c.id=s."companyId" WHERE a.action='series.created' AND a."entityId"=s.id::text
 AND s.series='T099' AND s.environment='BETA' AND s."documentType"='DESPATCH_ADVICE' AND c.ruc='20600979630'
 AND jsonb_typeof(a.metadata)='object'
 AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(a.metadata)='object' THEN a.metadata ELSE '{}'::jsonb END) key)=ARRAY['changedFields','companyId','environment','issuerRuc','softDelete']::text[]
 AND a.metadata->'companyId'=to_jsonb(s."companyId") AND a.metadata->>'issuerRuc'=c.ruc
 AND a.metadata->>'environment'=s.environment::text AND a.metadata->'softDelete'='false'::jsonb
 AND jsonb_typeof(a.metadata->'changedFields')='array' AND jsonb_array_length(CASE WHEN jsonb_typeof(a.metadata->'changedFields')='array' THEN a.metadata->'changedFields' ELSE '[]'::jsonb END)=2
 AND a.metadata->'changedFields' @> '["documentType","series"]'::jsonb;
  IF actual_audit IS DISTINCT FROM known_audit THEN RAISE EXCEPTION 'GRE_CLEANUP_AUDIT_SNAPSHOT_CHANGED'; END IF;
  audit_id:=(known_audit->>'id')::uuid;
  PERFORM 1 FROM public."ConfigurationAudit" WHERE id=audit_id FOR SHARE;
  IF (SELECT to_jsonb(a) FROM public."ConfigurationAudit" a WHERE id=audit_id) IS DISTINCT FROM known_audit THEN RAISE EXCEPTION 'GRE_CLEANUP_AUDIT_CONTRACT_CHANGED'; END IF;
  audit_hash:=encode(sha256(convert_to(known_audit::text,'UTF8')),'hex');
 END IF;
 -- Inspect every current FK, including future tables and ON DELETE CASCADE.
 FOR fk IN SELECT k.oid,k.conrelid,n.nspname,c.relname,k.conkey,k.confkey
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE k.contype='f' AND k.confrelid='public."SeriesCounter"'::regclass ORDER BY k.oid
 LOOP
  EXECUTE format('LOCK TABLE %I.%I IN SHARE MODE',fk.nspname,fk.relname);
  SELECT string_agg(format('r.%I=s.%I',a.attname,b.attname),' AND ' ORDER BY pair.ordinality) INTO joins
   FROM unnest(fk.conkey,fk.confkey) WITH ORDINALITY pair(localkey,remotekey,ordinality)
   JOIN pg_catalog.pg_attribute a ON a.attrelid=fk.conrelid AND a.attnum=pair.localkey
   JOIN pg_catalog.pg_attribute b ON b.attrelid='public."SeriesCounter"'::regclass AND b.attnum=pair.remotekey;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I r JOIN public."SeriesCounter" s ON %s WHERE s.id=ANY($1))',fk.nspname,fk.relname,joins) INTO has_reference USING targets;
  IF has_reference THEN RAISE EXCEPTION 'GRE_CLEANUP_REFERENCES_EXIST'; END IF;
 END LOOP;
 -- Conservative history scan catches UUID bindings even without a declared FK,
 -- plus scoped series references in snapshots/audit/outboxes. No row is returned.
 FOR relation IN SELECT n.nspname,c.relname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.oid<>'public."SeriesCounter"'::regclass ORDER BY c.oid
 LOOP
  extra_predicate:='';
  IF audit_id IS NOT NULL AND relation.nspname='public' AND relation.relname='ConfigurationAudit' THEN extra_predicate:=' AND r.id<>$4::uuid'; END IF;
  EXECUTE format($scan$SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE (
   strpos(to_jsonb(r)::text,$1)>0 OR strpos(to_jsonb(r)::text,$2)>0 OR
   (jsonb_path_exists(to_jsonb(r),'$.**.series ? (@ == "T099" || @ == "T100")') AND
    (jsonb_path_exists(to_jsonb(r),'$.**.issuerRuc ? (@ == "20600979630")') OR
     jsonb_path_exists(to_jsonb(r),'$.**.companyId ? (@ == $company)',jsonb_build_object('company',$3))))) %s)$scan$,relation.nspname,relation.relname,extra_predicate)
   INTO has_reference USING targets[1]::text,targets[2]::text,company,audit_id;
  IF has_reference THEN RAISE EXCEPTION 'GRE_CLEANUP_HISTORY_EXISTS'; END IF;
 END LOOP;
 WITH deleted AS (DELETE FROM public."SeriesCounter" WHERE id=ANY(targets) AND "companyId"=company AND "documentType"='DESPATCH_ADVICE' AND "nextNumber"=1
  RETURNING id,"companyId","emissionPointId","documentType",series,environment,"nextNumber",active,"masterRevision","createdAt","updatedAt")
 SELECT jsonb_agg(to_jsonb(deleted) ORDER BY series) INTO removed FROM deleted;
 IF jsonb_array_length(removed) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'GRE_CLEANUP_DELETE_COUNT_MISMATCH'; END IF;
 IF audit_id IS NOT NULL AND (SELECT to_jsonb(a) FROM public."ConfigurationAudit" a WHERE id=audit_id) IS DISTINCT FROM known_audit THEN RAISE EXCEPTION 'GRE_CLEANUP_AUDIT_NOT_PRESERVED'; END IF;
 PERFORM set_config('factuez.gre.cleanup.deleted',jsonb_build_object('status','deleted','version','factuez.gre-series-cleanup-receipt.v2','issuerRuc','20600979630','rows',removed,'preservedCreationAudit',CASE WHEN audit_id IS NULL THEN NULL ELSE jsonb_build_object('id',audit_id,'action','series.created','entityId',known_audit->>'entityId','sha256',audit_hash) END)::text,true);
END $guard$;
SELECT current_setting('factuez.gre.cleanup.deleted')::jsonb AS deleted;
COMMIT;
