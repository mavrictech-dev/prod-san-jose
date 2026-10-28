import { B2bSecurityError, b2bBindingsContain, validB2bPrincipal, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import type { ReportsAccess, ReportsOwnerSourceStore, ReportsSourceRecord } from './source-types';
import type { ReportsFilters, ReportsPgPool, ReportsPgConnection } from './types';
import { accessAnchor, accessKey, accessSeries, accessType, fail, limits, matches, validAccess } from './validation';
import { reportsFilters } from './filters';
import { reportsSourceScopes } from './owner-sources';
const actorKey=(p:B2bPrincipal)=>p.kind+':'+(p.subjectId??'-');
const documentJson=(alias:string)=>`jsonb_build_object(
 'id',${alias}."id",'companyId',${alias}."companyId",'type',${alias}."type",'series',${alias}."series",'number',${alias}."number"::text,
 'fullNumber',${alias}."fullNumber",'issueDate',${alias}."issueDate",'updatedAt',${alias}."updatedAt",'status',${alias}."status",
 'sunatStatus',${alias}."sunatStatus",'sunatResponseCode',${alias}."sunatResponseCode",'payableAmount',${alias}."payableAmount"::text,
 'originSystem',${alias}."originSystem",'originId',${alias}."originId",'immutableSnapshot',${alias}."immutableSnapshot",
 'company',jsonb_build_object('ruc',c."ruc"),
 'emissionPoint',jsonb_build_object('id',p."id",'companyId',p."companyId",'branchId',p."branchId",'branch',jsonb_build_object('companyId',p."companyId")),
 'seriesCounter',jsonb_build_object('id',${alias}."seriesCounterId",'companyId',${alias}."companyId",'emissionPointId',p."id",'documentType',${alias}."type",'series',${alias}."series"))`;
/** Billing-owned tables only. Exact tuples and dates are applied BEFORE LIMIT.
 * No journal/event union: Document is the current immutable snapshot of each NC/ND. */
export class PostgresBillingReportSources implements ReportsOwnerSourceStore {
  constructor(private readonly billingPool:ReportsPgPool){}
  async capture(p:B2bPrincipal,f:ReportsFilters,access:ReportsAccess[]){
    p=structuredClone(p);f=structuredClone(f);access=structuredClone(access);
    if(!validB2bPrincipal(p)||!Array.isArray(access)||access.length>500)fail(400,'INVALID_REPORT_SOURCE_CONFIGURATION');
    reportsFilters({...f,issuerId:String(f.issuerId),types:f.types.join(',')},true);
    if(reportsSourceScopes(f).some(s=>!p.scopes.includes(s)))fail(403,'SCOPE_REQUIRED');
    if(access.some(a=>!validAccess(a)||!b2bBindingsContain(p.bindings,accessAnchor(a))||!matches(accessAnchor(a),f)||
      !f.types.includes(accessType(a))||!!f.seriesId&&accessSeries(a)!==f.seriesId))fail(404,'RESOURCE_NOT_FOUND');
    if(new Set(access.map(accessKey)).size!==access.length)fail(400,'INVALID_REPORT_SOURCE_CONFIGURATION');
    let db:ReportsPgConnection|undefined,releaseError:Error|undefined;
    try{
      db=await this.billingPool.connect();
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await db.query("SET LOCAL statement_timeout = '10s'");
      const capturedAt=String((await db.query<{at:string}>("SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0].at);
      const records:ReportsSourceRecord[]=[];
      for(const a of access){
        const limit=limits.rows-records.length+1;let rows:any[];
        if(a.kind==='CORRECTION'){
          const b=a.binding.reference;
          rows=(await db.query(`SELECT ${documentJson('d')} AS document,${documentJson('o')} AS original
            FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId"
            JOIN "EmissionPoint" p ON p."id"=d."emissionPointId" AND p."companyId"=c."id"
            JOIN "Branch" branch ON branch."id"=p."branchId" AND branch."companyId"=c."id"
            JOIN "SeriesCounter" ns ON ns."id"=d."seriesCounterId" AND ns."companyId"=c."id" AND ns."emissionPointId"=p."id" AND ns."documentType"=d."type" AND ns."series"=d."series"
            JOIN "Document" o ON o."id"::text=d."immutableSnapshot"->'reference'->>'documentId'
              AND o."companyId"=c."id" AND o."emissionPointId"=p."id"
            JOIN "SeriesCounter" os ON os."id"=o."seriesCounterId" AND os."companyId"=c."id" AND os."emissionPointId"=p."id" AND os."documentType"=o."type" AND os."series"=o."series"
            WHERE c."id"=$1 AND c."ruc"=$2 AND c."environment"='BETA' AND p."branchId"=$3::uuid AND p."id"=$4::uuid
              AND o."seriesCounterId"=$5::uuid AND o."type"::text=$6 AND d."seriesCounterId"=$7::uuid AND d."type"::text=$8
              AND d."immutableSnapshot"->>'environment'='BETA' AND o."immutableSnapshot"->>'environment'='BETA'
              AND d."status"::text IN ('ISSUED','CANCELLED') AND o."status"::text IN ('ISSUED','CANCELLED')
              AND d."issueDate">=($9::date::timestamp AT TIME ZONE 'America/Lima') AND d."issueDate"<(($10::date+1)::timestamp AT TIME ZONE 'America/Lima')
            ORDER BY d."issueDate",d."id" LIMIT $11`,
            [b.issuerId,b.issuerRuc,b.branchId,b.pointId,b.seriesId,b.documentType==='01'?'INVOICE':'SALES_RECEIPT',
             a.binding.noteSeriesId,a.binding.noteType==='07'?'CREDIT_NOTE':'DEBIT_NOTE',f.from,f.to,limit])).rows;
        }else if(a.kind==='SALES_NOTE'){
          rows=(await db.query(`SELECT to_jsonb(r) AS resource FROM "B2bCommercialResource" r
            WHERE r."environment"='BETA' AND r."kind"='SALES_NOTE' AND r."clientId"=$1::uuid AND r."actorKey"=$2
              AND r."binding"=$3::jsonb AND r."completedSha256" IS NOT NULL AND r."state" IN ('COMPLETED','CONVERTED','CANCELLED')
              AND r."body"->>'issueDate'>=$4 AND r."body"->>'issueDate'<=$5 ORDER BY r."id" LIMIT $6`,
            [p.clientId,actorKey(p),JSON.stringify(a.binding),f.from,f.to,limit])).rows;
        }else{
          const carrier=a.binding.draft.guideType==='31',table=carrier?'CarrierGuide':'B2bGuideIssue',id=carrier?'documentId':'id';
          const b=a.binding.draft.anchor;
          rows=(await db.query(`SELECT to_jsonb(h) AS header,r."payload" AS receipt,
            (SELECT jsonb_agg(i."payload" ORDER BY i."position") FROM "${table}Item" i WHERE i."documentId"=h."${id}") AS items,
            (SELECT jsonb_agg(jsonb_build_object('operationId',o."operationId",'eventType',o."eventType",'payload',o."payload")) FROM "${table}LocalOutbox" o WHERE o."documentId"=h."${id}") AS events
            FROM "${table}Document" h JOIN "${table}Receipt" r ON r."documentId"=h."${id}"
            WHERE h."companyId"=$1 AND h."issuerRuc"=$2 AND h."binding"=$3::jsonb
              AND h."binding"->'draft'->'anchor'->>'environment'='BETA' AND r."clientId"=$4::uuid AND r."actorKey"=$5
              AND ((h."snapshot"->'body'->>'issueDate')::timestamptz AT TIME ZONE 'America/Lima')::date BETWEEN $6::date AND $7::date
            ORDER BY h."${id}" LIMIT $8`,
            [b.issuerId,b.issuerRuc,JSON.stringify(a.binding),p.clientId,actorKey(p),f.from,f.to,limit])).rows;
        }
        for(const value of rows)records.push({access:structuredClone(a),value});
        if(records.length>limits.rows||Buffer.byteLength(JSON.stringify(records))>limits.captureBytes)fail(413,'NARROW_QUERY');
      }
      await db.query('COMMIT');return {capturedAt,records};
    }catch(e){
      if(db)try{await db.query('ROLLBACK');}catch{releaseError=new Error('REPORT_SOURCE_ROLLBACK_FAILED');}
      if(e instanceof B2bSecurityError)throw e;
      releaseError=new Error('REPORT_SOURCE_UNAVAILABLE');return fail(503,'REPORT_SOURCE_UNAVAILABLE');
    }finally{db?.release(releaseError);}
  }
}



