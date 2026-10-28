import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {
  EstablishmentAudit, EstablishmentBranch, EstablishmentCompany, EstablishmentSnapshot,
  EstablishmentStore, EstablishmentTransaction,
} from './guide-establishments';

export interface GuideEstablishmentSql {
  $queryRawUnsafe<T=unknown>(sql:string,...values:unknown[]):Promise<T>;
  $executeRawUnsafe(sql:string,...values:unknown[]):Promise<number>;
}
export interface GuideEstablishmentDatabase {
  $transaction<T>(work:(tx:GuideEstablishmentSql)=>Promise<T>,options:{
    isolationLevel:'Serializable';timeout:number;maxWait:number;
  }):Promise<T>;
}

const options={isolationLevel:'Serializable' as const,timeout:15000,maxWait:3000};
const unavailable=()=>new B2bSecurityError(503,'ESTABLISHMENT_STORE_UNAVAILABLE');
const conflict=()=>new B2bSecurityError(409,'ESTABLISHMENT_REVISION_CONFLICT');
const inconsistent=()=>new B2bSecurityError(409,'ESTABLISHMENT_REGISTRY_INCONSISTENT');
const integer=(value:unknown,min=1):value is number=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=2147483647;

function retryable(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const e=error as {code?:unknown;meta?:{code?:unknown;driverAdapterError?:{cause?:{originalCode?:unknown;code?:unknown}}}};
  return e.code==='P2034'||e.code==='40001'||e.code==='P2010'&&
    (e.meta?.code==='40001'||e.meta?.driverAdapterError?.cause?.originalCode==='40001'||
      e.meta?.driverAdapterError?.cause?.code==='40001');
}

type HeadRow={
  headCompanyId:number;headRevision:number;versionCompanyId:number|null;versionRevision:number|null;
  payload:EstablishmentSnapshot|null;
};

class PgGuideEstablishmentTransaction implements EstablishmentTransaction {
  private failed=false;
  private failure:unknown;
  constructor(private readonly db:GuideEstablishmentSql,private readonly companyId:number){}

  // A callback cannot swallow a failed write and commit its preceding changes.
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

  branches(companyId:number,ids:string[]):Promise<EstablishmentBranch[]> {
    return this.run(async()=>{
      this.scope(companyId);
      // Include inactive metadata: the core must report stale/conflicting maps.
      return this.db.$queryRawUnsafe<EstablishmentBranch[]>(`
        SELECT "id","companyId","masterRevision","active" FROM "Branch"
        WHERE "companyId"=$1 AND "id"=ANY($2::uuid[]) ORDER BY "id" FOR SHARE`,companyId,ids);
    });
  }

  head(companyId:number):Promise<EstablishmentSnapshot|null> {
    return this.run(async()=>{
      this.scope(companyId);
      const rows=await this.db.$queryRawUnsafe<HeadRow[]>(`
        SELECT h."companyId" AS "headCompanyId",h."revision" AS "headRevision",
          v."companyId" AS "versionCompanyId",v."revision" AS "versionRevision",v."payload"
        FROM "B2bGuideEstablishmentHead" h
        LEFT JOIN "B2bGuideEstablishmentVersion" v
          ON v."companyId"=h."companyId" AND v."revision"=h."revision"
        WHERE h."companyId"=$1 FOR UPDATE OF h`,companyId);
      if(rows.length===0)return null;
      const row=rows[0],p=row.payload;
      if(rows.length!==1||row.headCompanyId!==companyId||row.versionCompanyId!==companyId||
        !integer(row.headRevision)||row.versionRevision!==row.headRevision||
        !p||typeof p!=='object'||Array.isArray(p)||p.companyId!==companyId||p.revision!==row.headRevision)
        throw inconsistent();
      // Canonical payload/hash validation belongs to the existing core.
      return p;
    });
  }

  save(snapshot:EstablishmentSnapshot,expectedRevision:number):Promise<void> {
    return this.run(async()=>{
      this.scope(snapshot.companyId);
      if(!integer(expectedRevision,0)||expectedRevision===2147483647||snapshot.revision!==expectedRevision+1)
        throw conflict();
      const current=await this.head(snapshot.companyId);
      if((current?.revision??0)!==expectedRevision)throw conflict();
      // The deferred head->version FK permits this CAS before the immutable append.
      const changed=expectedRevision===0
        ?await this.db.$executeRawUnsafe(`
          INSERT INTO "B2bGuideEstablishmentHead" ("companyId","revision") VALUES ($1,$2)
          ON CONFLICT ("companyId") DO NOTHING`,snapshot.companyId,snapshot.revision)
        :await this.db.$executeRawUnsafe(`
          UPDATE "B2bGuideEstablishmentHead" SET "revision"=$2
          WHERE "companyId"=$1 AND "revision"=$3`,snapshot.companyId,snapshot.revision,expectedRevision);
      if(changed!==1)throw conflict();
      const appended=await this.db.$executeRawUnsafe(`
        INSERT INTO "B2bGuideEstablishmentVersion" ("companyId","revision","payload")
        VALUES ($1,$2,$3::jsonb)`,snapshot.companyId,snapshot.revision,JSON.stringify(snapshot));
      if(appended!==1)throw unavailable();
    });
  }

  audit(value:EstablishmentAudit):Promise<void> {
    return this.run(async()=>{
      this.scope(value.companyId);
      // Explicit fields only; never serialize a context, authority or credential.
      const appended=await this.db.$executeRawUnsafe(`
        INSERT INTO "B2bGuideEstablishmentAudit"
          ("id","requestId","peerSha256","companyId","revision","actorId","action","at")
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7,$8::timestamptz)`,
      value.id,value.requestId,value.peerSha256,value.companyId,value.revision,value.actorId,value.action,value.at);
      if(appended!==1)throw unavailable();
    });
  }
}

/** Candidate persistence only. Construction performs no queries or schema work.
 * A retried callback must reauthorize on every invocation, as the core does. */
export class PostgresGuideEstablishmentStore implements EstablishmentStore {
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

  transaction<T>(companyId:number,work:(tx:EstablishmentTransaction)=>Promise<T>):Promise<T> {
    if(!integer(companyId))return Promise.reject(unavailable());
    return this.execute(async db=>{
      // Serialize even the first insert, before authorization or any other callback.
      await db.$queryRawUnsafe(`
        SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))`,
      'factuez:guide-establishments:'+companyId);
      const tx=new PgGuideEstablishmentTransaction(db,companyId);
      try{
        const result=await work(tx);
        tx.assertHealthy();
        return result;
      }catch(error){
        // Preserve an earlier SQL failure even if the callback masks its error.
        tx.assertHealthy();
        throw error;
      }
    });
  }

  rate(keySha256:string,window:number,limit:number):Promise<boolean> {
    if(typeof keySha256!=='string'||!/^[a-f0-9]{64}$/.test(keySha256)||
      !Number.isSafeInteger(window)||window<0||!integer(limit)||limit===2147483647)
      return Promise.reject(unavailable());
    return this.execute(async db=>{
      // One row per digest. Count denied attempts too, saturating before overflow.
      // A clock moving backwards must neither reset nor grant quota.
      const rows=await db.$queryRawUnsafe<{allowed:boolean}[]>(`
        INSERT INTO "B2bGuideEstablishmentRate" AS r ("keyHash","window","counter")
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

/** Validation adapter for a caller-owned SQL transaction. No nested transaction,
 * retries, administrative writes or quota writes are permitted here. The head
 * observer is internal metadata only; the core still validates its payload. */
export function transactionBoundGuideEstablishmentStore(
  sql:GuideEstablishmentSql,companyId:number,
  observeHead?:(head:EstablishmentSnapshot|null)=>void,
):EstablishmentStore {
  const denied=async():Promise<never>=>{throw new B2bSecurityError(403,'GUIDE_ISSUE_VALIDATION_ONLY');};
  return {
    async transaction<T>(id:number,work:(tx:EstablishmentTransaction)=>Promise<T>):Promise<T>{
      if(!integer(companyId)||id!==companyId)throw inconsistent();
      const tx=new PgGuideEstablishmentTransaction(sql,companyId);
      try{
        const result=await work({
          company:value=>tx.company(value),branches:(value,ids)=>tx.branches(value,ids),
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
