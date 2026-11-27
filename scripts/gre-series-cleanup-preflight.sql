-- Read-only snapshot for manual review. This file does not delete or authorize deletion.
BEGIN READ ONLY;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='5s';
WITH creation_candidates AS (
 SELECT jsonb_build_object('id',a.id,'actorId',a."actorId",'action',a.action,'entityId',a."entityId",'metadata',a.metadata,'createdAt',a."createdAt") AS value FROM public."ConfigurationAudit" a JOIN public."SeriesCounter" s ON a."entityId"=s.id::text JOIN public."CompanySettings" c ON c.id=s."companyId"
 WHERE a.action='series.created' AND a."entityId"=s.id::text
 AND s.series='T099' AND s.environment='BETA' AND s."documentType"='DESPATCH_ADVICE' AND c.ruc='20600979630'
 AND jsonb_typeof(a.metadata)='object'
 AND (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(a.metadata)='object' THEN a.metadata ELSE '{}'::jsonb END) key)=ARRAY['changedFields','companyId','environment','issuerRuc','softDelete']::text[]
 AND a.metadata->'companyId'=to_jsonb(s."companyId") AND a.metadata->>'issuerRuc'=c.ruc
 AND a.metadata->>'environment'=s.environment::text AND a.metadata->'softDelete'='false'::jsonb
 AND jsonb_typeof(a.metadata->'changedFields')='array' AND jsonb_array_length(CASE WHEN jsonb_typeof(a.metadata->'changedFields')='array' THEN a.metadata->'changedFields' ELSE '[]'::jsonb END)=2
 AND a.metadata->'changedFields' @> '["documentType","series"]'::jsonb ORDER BY a.id LIMIT 2
)
SELECT jsonb_build_object(
 'version','factuez.gre-series-cleanup-preview.v2',
 'issuerRuc','20600979630','documentType','DESPATCH_ADVICE',
 'preflightOnly',true,'backupStillRequiredForDeletion',true,
 'creationAudit',COALESCE((SELECT jsonb_agg(value ORDER BY value->>'id') FROM creation_candidates),'[]'::jsonb),
 'auditSummary',jsonb_build_object('validCreationCandidates',(SELECT count(*) FROM creation_candidates),'targetAuditCount',(SELECT count(*) FROM public."ConfigurationAudit" a JOIN public."SeriesCounter" s ON a."entityId"=s.id::text JOIN public."CompanySettings" c ON c.id=s."companyId" WHERE c.ruc='20600979630' AND s."documentType"='DESPATCH_ADVICE' AND s.series IN ('T099','T100'))),
 'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'id',s.id,'companyId',s."companyId",'emissionPointId',s."emissionPointId",
  'documentType',s."documentType",'series',s.series,'environment',s.environment,
  'nextNumber',s."nextNumber"::text,'active',s.active,'masterRevision',s."masterRevision",
  'createdAt',s."createdAt",'updatedAt',s."updatedAt") ORDER BY s.series)
  FROM public."SeriesCounter" s JOIN public."CompanySettings" c ON c.id=s."companyId"
  WHERE c.ruc='20600979630' AND s."documentType"='DESPATCH_ADVICE' AND s.series IN ('T099','T100')),'[]'::jsonb),
 'locations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'id',s.id,'pointCode',p.code,'pointName',left(p.name,120),
  'branchId',b.id,'branchCode',b.code,'branchName',left(b.name,120)) ORDER BY s.series)
  FROM public."SeriesCounter" s JOIN public."CompanySettings" c ON c.id=s."companyId"
  LEFT JOIN public."EmissionPoint" p ON p.id=s."emissionPointId" AND p."companyId"=s."companyId"
  LEFT JOIN public."Branch" b ON b.id=p."branchId" AND b."companyId"=s."companyId"
  WHERE c.ruc='20600979630' AND s."documentType"='DESPATCH_ADVICE' AND s.series IN ('T099','T100')),'[]'::jsonb)
) AS preview;
COMMIT;
