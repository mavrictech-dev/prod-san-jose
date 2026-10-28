import {B2bSecurityError,type B2bBinding} from '@factuez/contracts/b2b-security';
import {snapshotHash} from '@factuez/service-access/dist/integration';
import {PgDraftTransaction,type DraftDatabase,type DraftSql,type DraftIssuer} from './draft-store';
import type {Draft,DraftBody} from './draft-model';
import type {CommercialResource,CommercialOperation,CommercialTransaction,CommercialStore,CommercialKind,OriginalReference,CreditObservation} from './commercial-model';
const columns='"id","kind","clientId","actorKey","binding","body","revision","state","commercialNumber","completedSha256","original","convertedDocumentId","convertedDraftId","createdAt","updatedAt"';
const decode=(r:any):CommercialResource=>({...r,createdAt:new Date(r.createdAt).toISOString(),updatedAt:new Date(r.updatedAt).toISOString()});
class PgCommercialTransaction implements CommercialTransaction {
  readonly convert?:CommercialTransaction['convert'];
  constructor(private readonly db:DraftSql,issuer?:DraftIssuer){
    if(issuer)this.convert=async(resource,operation)=>{
      const drafts=new PgDraftTransaction(db,issuer),d:Draft={id:operation.draftId,clientId:resource.clientId,actorKey:resource.actorKey,
        binding:resource.binding,body:{...resource.body as DraftBody,externalReference:{namespace:'b2b_sales_note',value:resource.id}},revision:2,state:'DRAFT',validatedRevision:2,createdAt:operation.at,updatedAt:operation.at};
      // This is one owner-local transaction, including the ordinary issuance journal/FKs.
      await drafts.create(d);const result=await drafts.issue!(d,operation);
      await drafts.save({...d,state:'ISSUED',revision:3,updatedAt:operation.at},2);
      await drafts.append({...operation,documentId:result.documentId,response:{context:d.binding,...result,state:'COMMITTED',fiscalAcceptance:'NOT_ASSERTED'}});
      return result;
    };
  }
  async get(id:string){const r=await this.db.$queryRawUnsafe<any[]>(`SELECT ${columns} FROM "B2bCommercialResource" WHERE "id"=$1::uuid AND "environment"='BETA' FOR UPDATE`,id);return r[0]?decode(r[0]):null;}
  async list(clientId:string,actorKey:string,kind:CommercialKind,bindings:B2bBinding[],limit:number,after:string|null){
    // Whole tuples are filtered in SQL BEFORE LIMIT, so another point cannot starve a page.
    const r=await this.db.$queryRawUnsafe<any[]>(`SELECT ${columns} FROM "B2bCommercialResource" r WHERE "clientId"=$1::uuid AND "actorKey"=$2 AND "kind"=$3 AND "environment"='BETA'
      AND "id">COALESCE($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements($5::jsonb) b WHERE b=r."binding") ORDER BY "id" LIMIT $6`,clientId,actorKey,kind,after,JSON.stringify(bindings),limit);
    return r.map(decode);
  }
  async create(r:CommercialResource){
    const ref=r.body.externalReference;
    await this.db.$executeRawUnsafe(`INSERT INTO "B2bCommercialResource" ("id","kind","clientId","actorKey","binding","body","revision","state","commercialNumber","completedSha256","original","convertedDocumentId","convertedDraftId","createdAt","updatedAt","issuerId","pointId","referenceNamespace","referenceValue")
      VALUES ($1::uuid,$2,$3::uuid,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::uuid,$13::uuid,$14::timestamptz,$15::timestamptz,$16,$17::uuid,$18,$19)`,
      r.id,r.kind,r.clientId,r.actorKey,JSON.stringify(r.binding),JSON.stringify(r.body),r.revision,r.state,r.commercialNumber,r.completedSha256,r.original?JSON.stringify(r.original):null,r.convertedDocumentId,r.convertedDraftId,r.createdAt,r.updatedAt,r.binding.issuerId,r.binding.pointId,ref.namespace,ref.value);
  }
  async save(r:CommercialResource,expected:number){
    const n=await this.db.$executeRawUnsafe(`UPDATE "B2bCommercialResource" SET "body"=$2::jsonb,"revision"=$3,"state"=$4,"completedSha256"=$5,"convertedDocumentId"=$6::uuid,"convertedDraftId"=$7::uuid,"updatedAt"=$8::timestamptz WHERE "id"=$1::uuid AND "revision"=$9 AND "environment"='BETA' AND "state" NOT IN ('CONVERTED','CANCELLED')`,r.id,JSON.stringify(r.body),r.revision,r.state,r.completedSha256,r.convertedDocumentId,r.convertedDraftId,r.updatedAt,expected);
    if(n!==1)throw new B2bSecurityError(412,'REVISION_CONFLICT');
  }
  async nextNumber(b:B2bBinding){
    const rows=await this.db.$queryRawUnsafe<{number:string}[]>(`INSERT INTO "B2bSalesNoteCounter" ("issuerId","pointId","nextNumber") VALUES ($1,$2::uuid,2)
      ON CONFLICT ("issuerId","pointId") DO UPDATE SET "nextNumber"="B2bSalesNoteCounter"."nextNumber"+1 WHERE "B2bSalesNoteCounter"."nextNumber"<=99999999 RETURNING ("nextNumber"-1)::text AS number`,b.issuerId,b.pointId);
    if(!rows[0])throw new B2bSecurityError(409,'COMMERCIAL_SERIES_EXHAUSTED');return 'NV-'+rows[0].number.padStart(8,'0');
  }
  async prior(c:string,a:string,k:string){const r=await this.db.$queryRawUnsafe<any[]>('SELECT "payload" FROM "B2bCommercialOperation" WHERE "clientId"=$1::uuid AND "actorKey"=$2 AND "keyHash"=$3',c,a,k);return r[0]?.payload??null;}
  async operation(id:string,c:string,a:string){const r=await this.db.$queryRawUnsafe<any[]>('SELECT "payload" FROM "B2bCommercialOperation" WHERE "id"=$1::uuid AND "clientId"=$2::uuid AND "actorKey"=$3',id,c,a);return r[0]?.payload??null;}
  async append(op:CommercialOperation){await this.db.$executeRawUnsafe('INSERT INTO "B2bCommercialOperation" ("id","clientId","actorKey","keyHash","resourceId","payload") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)',op.id,op.clientId,op.actorKey,op.keyHash,op.resourceId,JSON.stringify(op));}
  async original(id:string):Promise<OriginalReference|null>{
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT d."id",d."companyId",d."seriesCounterId",d."emissionPointId",d."currencyCode",d."type",d."payableAmount"::text AS amount,d."immutableSnapshot",d."fullNumber",c."ruc",p."branchId"
      FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId" JOIN "EmissionPoint" p ON p."id"=d."emissionPointId" AND p."companyId"=d."companyId"
      WHERE d."id"=$1::uuid AND c."environment"='BETA' AND c."active"=true AND d."status"='ISSUED' AND d."type" IN ('INVOICE','SALES_RECEIPT') FOR SHARE OF d`,id);
    const r=rows[0];if(!r)return null;
    return {id:r.id,binding:{issuerId:r.companyId,issuerRuc:r.ruc,environment:'BETA',branchId:r.branchId,pointId:r.emissionPointId,seriesId:r.seriesCounterId,documentType:r.type==='INVOICE'?'01':'03'},
      currency:r.currencyCode,payableAmount:r.amount,snapshotSha256:snapshotHash(r.immutableSnapshot),fullNumber:r.fullNumber};
  }
  async observedCredits(id:string,issuerId:number):Promise<CreditObservation[]>{
    // One statement snapshot, bounded branches and UNION deduplication across links.
    // No status projection is trusted to release balance, and no note IDs leave this port.
    return this.db.$queryRawUnsafe<CreditObservation[]>(`WITH original AS (
      SELECT "id","companyId","series","number","type" FROM "Document" WHERE "id"=$1::uuid AND "companyId"=$2
    ), candidates AS (
      (SELECT n."id" FROM "Document" n JOIN original d ON n."companyId"=d."companyId"
        WHERE n."type"='CREDIT_NOTE' AND n."immutableSnapshot"->'reference'->>'documentId'=d."id"::text ORDER BY n."id" LIMIT 101)
      UNION
      (SELECT DISTINCT n."id" FROM "DocumentReference" r JOIN original d ON r."targetDocumentId"=d."id"
        JOIN "Document" n ON n."id"=r."sourceDocumentId" AND n."companyId"=d."companyId" AND n."type"='CREDIT_NOTE' ORDER BY n."id" LIMIT 101)
      UNION
      (SELECT DISTINCT n."id" FROM "DocumentReference" r JOIN original d ON r."targetDocumentId" IS NULL AND r."targetSeries"=d."series" AND r."targetNumber"=d."number"
          AND r."targetTypeCode"=CASE WHEN d."type"='INVOICE' THEN '01' ELSE '03' END
        JOIN "Document" n ON n."id"=r."sourceDocumentId" AND n."companyId"=d."companyId" AND n."type"='CREDIT_NOTE' ORDER BY n."id" LIMIT 101)
    ) SELECT n."payableAmount"::text AS "declaredAmount",n."currencyCode" AS currency,
      n."immutableSnapshot"->'totals'->>'payableAmount' AS "snapshotAmount",
      n."immutableSnapshot"->'reference'->>'documentId' AS "referenceDocumentId",
      n."immutableSnapshot"->'reference'->>'snapshotSha256' AS "referenceSha256"
      FROM "Document" n JOIN candidates c ON c."id"=n."id"
      ORDER BY n."id" LIMIT 101`,id,issuerId);
  }
}
export class PostgresB2bCommercialStore implements CommercialStore {
  constructor(private readonly db:DraftDatabase,private readonly issuer?:DraftIssuer){}
  async transaction<T>(scope:string,work:(tx:CommercialTransaction)=>Promise<T>){
    try{return await this.db.$transaction(async tx=>{
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))','b2b:commercial:'+scope);
      return work(new PgCommercialTransaction(tx,this.issuer));
    },{timeout:15000,maxWait:3000});}catch(e){
      if(e instanceof B2bSecurityError)throw e;
      if(e&&typeof e==='object'&&'code'in e&&(e.code==='23505'||e.code==='P2002'||('meta'in e&&((e.meta as any)?.code==='23505'||e.code==='P2010'&&(e.meta as any)?.driverAdapterError?.cause?.kind==='UniqueConstraintViolation'))))throw new B2bSecurityError(409,'COMMERCIAL_REFERENCE_CONFLICT');
      throw new B2bSecurityError(503,'COMMERCIAL_STORE_UNAVAILABLE');
    }
  }
}
