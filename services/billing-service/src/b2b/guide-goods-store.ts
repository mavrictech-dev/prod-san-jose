import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {EstablishmentCompany} from './guide-establishments';
import type {GuideEstablishmentDatabase,GuideEstablishmentSql} from './guide-establishment-store';
import type {GuideGoodsAudit,GuideGoodsProduct,GuideGoodsSnapshot,GuideGoodsStore,GuideGoodsTransaction} from './guide-goods-types';

const options={isolationLevel:'Serializable' as const,timeout:15000,maxWait:3000};
const unavailable=()=>new B2bSecurityError(503,'GUIDE_GOODS_STORE_UNAVAILABLE');
const conflict=()=>new B2bSecurityError(409,'GUIDE_GOODS_REVISION_CONFLICT');
const inconsistent=()=>new B2bSecurityError(409,'GUIDE_GOODS_POLICY_INCONSISTENT');
const integer=(value:unknown,min=1):value is number=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=2147483647;

function retryable(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const e=error as {code?:unknown;meta?:{code?:unknown;driverAdapterError?:{cause?:{originalCode?:unknown;code?:unknown}}}};
  return e.code==='P2034'||e.code==='40001'||e.code==='P2010'&&
    (e.meta?.code==='40001'||e.meta?.driverAdapterError?.cause?.originalCode==='40001'||
      e.meta?.driverAdapterError?.cause?.code==='40001');
}

type HeadRow={headCompanyId:number;headRevision:number;versionCompanyId:number|null;
  versionRevision:number|null;payload:GuideGoodsSnapshot|null};
type ProductRow=Omit<GuideGoodsProduct,'updatedAt'>&{updatedAt:Date|string};

class PgGuideGoodsTransaction implements GuideGoodsTransaction {
  private failed=false;
  private failure:unknown;
  constructor(private readonly db:GuideEstablishmentSql,private readonly companyId:number){}

  assertHealthy():void {if(this.failed)throw this.failure;}
  private async run<T>(work:()=>Promise<T>):Promise<T> {
    this.assertHealthy();
    try{return await work();}catch(error){this.failed=true;this.failure=error;throw error;}
  }
  private scope(companyId:number):void {if(companyId!==this.companyId)throw inconsistent();}

  company(id:number):Promise<EstablishmentCompany|null> {
    return this.run(async()=>{
      this.scope(id);
      const rows=await this.db.$queryRawUnsafe<EstablishmentCompany[]>(`
        SELECT "id","ruc","environment","configVersion","active"
        FROM "CompanySettings"
        WHERE "id"=$1 AND "active"=true AND "environment"='BETA' FOR UPDATE`,id);
      return rows[0]??null;
    });
  }

  products(ids:string[]):Promise<GuideGoodsProduct[]> {
    return this.run(async()=>{
      // Shared master, including inactive rows: eligibility and fingerprints belong
      // to the core. Never read price, tax configuration or an invented companyId.
      const rows=await this.db.$queryRawUnsafe<ProductRow[]>(`
        SELECT "id","sku","description","category","unitCode","sunatProductCode","active","updatedAt"
        FROM "FuelProduct" WHERE "id"=ANY($1::uuid[]) ORDER BY "id" FOR SHARE`,ids);
      return rows.map(row=>{
        const at=row.updatedAt;
        if(!(at instanceof Date)&&typeof at!=='string')throw inconsistent();
        const date=at instanceof Date?at:new Date(at);
        if(!Number.isFinite(date.getTime()))throw inconsistent();
        // pg/Prisma return Dates; the core fingerprints the canonical string.
        return {id:row.id,sku:row.sku,description:row.description,category:row.category,
          unitCode:row.unitCode,sunatProductCode:row.sunatProductCode,active:row.active,updatedAt:date.toISOString()};
      });
    });
  }

  head(companyId:number):Promise<GuideGoodsSnapshot|null> {
    return this.run(async()=>{
      this.scope(companyId);
      const rows=await this.db.$queryRawUnsafe<HeadRow[]>(`
        SELECT h."companyId" AS "headCompanyId",h."revision" AS "headRevision",
          v."companyId" AS "versionCompanyId",v."revision" AS "versionRevision",v."payload"
        FROM "B2bGuideGoodsHead" h
        LEFT JOIN "B2bGuideGoodsVersion" v
          ON v."companyId"=h."companyId" AND v."revision"=h."revision"
        WHERE h."companyId"=$1 FOR UPDATE OF h`,companyId);
      if(rows.length===0)return null;
      const row=rows[0],p=row.payload;
      if(rows.length!==1||row.headCompanyId!==companyId||row.versionCompanyId!==companyId||
        !integer(row.headRevision)||row.versionRevision!==row.headRevision||
        !p||typeof p!=='object'||Array.isArray(p)||p.companyId!==companyId||p.revision!==row.headRevision)
        throw inconsistent();
      // The core validates the canonical payload and hash.
      return p;
    });
  }

  save(snapshot:GuideGoodsSnapshot,expectedRevision:number):Promise<void> {
    return this.run(async()=>{
      this.scope(snapshot.companyId);
      if(!integer(expectedRevision,0)||expectedRevision===2147483647||snapshot.revision!==expectedRevision+1)
        throw conflict();
      const current=await this.head(snapshot.companyId);
      if((current?.revision??0)!==expectedRevision)throw conflict();
      // Deferred head->version membership permits CAS BEFORE immutable append.
      const changed=expectedRevision===0
        ?await this.db.$executeRawUnsafe(`
          INSERT INTO "B2bGuideGoodsHead" ("companyId","revision") VALUES ($1,$2)
          ON CONFLICT ("companyId") DO NOTHING`,snapshot.companyId,snapshot.revision)
        :await this.db.$executeRawUnsafe(`
          UPDATE "B2bGuideGoodsHead" SET "revision"=$2
          WHERE "companyId"=$1 AND "revision"=$3`,snapshot.companyId,snapshot.revision,expectedRevision);
      if(changed!==1)throw conflict();
      const appended=await this.db.$executeRawUnsafe(`
        INSERT INTO "B2bGuideGoodsVersion" ("companyId","revision","payload")
        VALUES ($1,$2,$3::jsonb)`,snapshot.companyId,snapshot.revision,JSON.stringify(snapshot));
      if(appended!==1)throw unavailable();
    });
  }

  audit(value:GuideGoodsAudit):Promise<void> {
    return this.run(async()=>{
      this.scope(value.companyId);
      const appended=await this.db.$executeRawUnsafe(`
        INSERT INTO "B2bGuideGoodsAudit"
          ("id","requestId","peerSha256","companyId","revision","actorId","action","at")
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8::timestamptz)`,
      value.id,value.requestId,value.peerSha256,value.companyId,value.revision,value.actorId,value.action,value.at);
      if(appended!==1)throw unavailable();
    });
  }
}

/** Candidate persistence only: construction never queries or applies schema.
 * The core must reauthorize on every invocation of a retried callback. */
export class PostgresGuideGoodsStore implements GuideGoodsStore {
  constructor(private readonly db:GuideEstablishmentDatabase){}

  private async execute<T>(work:(tx:GuideEstablishmentSql)=>Promise<T>):Promise<T> {
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.db.$transaction(work,options);}
      catch(error){
        if(error instanceof B2bSecurityError)throw error;
        if(attempt<2&&retryable(error))continue;
        throw unavailable();
      }
    }
    throw unavailable();
  }

  transaction<T>(companyId:number,work:(tx:GuideGoodsTransaction)=>Promise<T>):Promise<T> {
    if(!integer(companyId))return Promise.reject(unavailable());
    return this.execute(async db=>{
      await db.$queryRawUnsafe(`
        SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))`,
      'factuez:guide-goods:'+companyId);
      const tx=new PgGuideGoodsTransaction(db,companyId);
      try{
        const result=await work(tx);
        tx.assertHealthy();return result;
      }catch(error){
        // Even a swallowed SQL failure must abort all earlier writes.
        tx.assertHealthy();throw error;
      }
    });
  }

  rate(keySha256:string,window:number,limit:number):Promise<boolean> {
    if(typeof keySha256!=='string'||/^[a-f0-9]{64}$/.exec(keySha256)?.[0]!==keySha256||
      !Number.isSafeInteger(window)||window<0||!integer(limit)||limit===2147483647)
      return Promise.reject(unavailable());
    return this.execute(async db=>{
      const rows=await db.$queryRawUnsafe<{allowed:boolean}[]>(`
        INSERT INTO "B2bGuideGoodsRate" AS r ("keyHash","window","counter")
        VALUES ($1,$2::bigint,1)
        ON CONFLICT ("keyHash") DO UPDATE SET
          "window"=EXCLUDED."window",
          "counter"=CASE WHEN EXCLUDED."window">r."window" THEN 1
            ELSE LEAST(r."counter"::bigint+1,2147483647)::integer END
        WHERE EXCLUDED."window">=r."window"
        RETURNING ("window"=$2::bigint AND "counter"<=$3::integer) AS "allowed"`,keySha256,window,limit);
      if(rows.length===0)return false;
      if(rows.length!==1||typeof rows[0].allowed!=='boolean')throw unavailable();
      return rows[0].allowed;
    });
  }
}

/** Read/lock the existing policy on a caller-owned transaction. Deliberately
 * cannot perform administrative writes, rate writes, retries or nested SQL tx. */
export function transactionBoundGuideGoodsStore(
  sql:GuideEstablishmentSql,companyId:number,
  observeHead?:(head:GuideGoodsSnapshot|null)=>void,
):GuideGoodsStore {
  const denied=async():Promise<never>=>{throw new B2bSecurityError(403,'GUIDE_ISSUE_VALIDATION_ONLY');};
  return {
    async transaction<T>(id:number,work:(tx:GuideGoodsTransaction)=>Promise<T>):Promise<T>{
      if(!integer(companyId)||id!==companyId)throw inconsistent();
      const tx=new PgGuideGoodsTransaction(sql,companyId);
      try{
        const result=await work({
          company:value=>tx.company(value),products:ids=>tx.products(ids),
          head:async value=>{const head=await tx.head(value);observeHead?.(head);return head;},
          save:denied,audit:denied,
        });
        tx.assertHealthy();return result;
      }catch(error){
        try{tx.assertHealthy();}catch(failure){error=failure;}
        if(error instanceof B2bSecurityError)throw error;
        throw unavailable();
      }
    },
    rate:denied,
  };
}
