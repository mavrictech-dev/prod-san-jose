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
BEGIN
 IF plan IS NULL OR COALESCE(plan->>'backupSha256','') !~ '^[a-f0-9]{64}$' OR
    plan->'snapshot'->>'version' IS DISTINCT FROM 'factuez.gre-series-cleanup-preview.v1' OR
    plan->'snapshot'->>'issuerRuc' IS DISTINCT FROM '20600979630' OR
    plan->'snapshot'->>'documentType' IS DISTINCT FROM 'DESPATCH_ADVICE' OR
    jsonb_typeof(plan->'snapshot'->'rows') IS DISTINCT FROM 'array' OR
    jsonb_array_length(plan->'snapshot'->'rows')<>2 THEN
  RAISE EXCEPTION 'GRE_CLEANUP_REVIEW_REQUIRED';
 END IF;
 snapshot := plan->'snapshot';
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
  EXECUTE format($scan$SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE
   strpos(to_jsonb(r)::text,$1)>0 OR strpos(to_jsonb(r)::text,$2)>0 OR
   (jsonb_path_exists(to_jsonb(r),'$.**.series ? (@ == "T099" || @ == "T100")') AND
    (jsonb_path_exists(to_jsonb(r),'$.**.issuerRuc ? (@ == "20600979630")') OR
     jsonb_path_exists(to_jsonb(r),'$.**.companyId ? (@ == $company)',jsonb_build_object('company',$3)))))$scan$,relation.nspname,relation.relname)
   INTO has_reference USING targets[1]::text,targets[2]::text,company;
  IF has_reference THEN RAISE EXCEPTION 'GRE_CLEANUP_HISTORY_EXISTS'; END IF;
 END LOOP;
 WITH deleted AS (DELETE FROM public."SeriesCounter" WHERE id=ANY(targets) AND "companyId"=company AND "documentType"='DESPATCH_ADVICE' AND "nextNumber"=1
  RETURNING id,"companyId","emissionPointId","documentType",series,environment,"nextNumber",active,"masterRevision","createdAt","updatedAt")
 SELECT jsonb_agg(to_jsonb(deleted) ORDER BY series) INTO removed FROM deleted;
 IF jsonb_array_length(removed) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'GRE_CLEANUP_DELETE_COUNT_MISMATCH'; END IF;
 PERFORM set_config('factuez.gre.cleanup.deleted',jsonb_build_object('status','deleted','issuerRuc','20600979630','rows',removed)::text,true);
END $guard$;
SELECT current_setting('factuez.gre.cleanup.deleted')::jsonb AS deleted;
COMMIT;
