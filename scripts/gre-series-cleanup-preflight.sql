-- Read-only snapshot for manual review. This file does not delete or authorize deletion.
BEGIN READ ONLY;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='5s';
SELECT jsonb_build_object(
 'version','factuez.gre-series-cleanup-preview.v1',
 'issuerRuc','20600979630','documentType','DESPATCH_ADVICE',
 'preflightOnly',true,'backupStillRequiredForDeletion',true,
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
