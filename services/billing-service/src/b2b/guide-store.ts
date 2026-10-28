import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import {validB2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import type {GuideDraft,GuideOperation,GuideStore,GuideTransaction} from './guide-model';
import type {DraftSql} from './draft-store';
export interface GuideDatabase{$transaction<T>(work:(tx:DraftSql)=>Promise<T>,options:{isolationLevel:'Serializable';timeout:number;maxWait:number}):Promise<T>}
const columns='"id","clientId","actorKey","guideSeriesId","binding","body","bodySha256","revision","state","createdAt","updatedAt"';
const decode=(r:any):GuideDraft=>{
  const {guideSeriesId,...value}=r;if(!validB2bGuideBinding(value.binding)||value.binding.guideSeriesId!==guideSeriesId)throw new B2bSecurityError(409,'GUIDE_DRAFT_INCONSISTENT');
  return{...value,createdAt:new Date(r.createdAt).toISOString(),updatedAt:new Date(r.updatedAt).toISOString()};
};
export class PgGuideTransaction implements GuideTransaction{
  constructor(private readonly db:DraftSql){}
  async get(id:string){const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT ${columns} FROM "B2bGuideDraft" WHERE "id"=$1::uuid FOR UPDATE`,id);return rows[0]?decode(rows[0]):null;}
  async prior(clientId:string,actorKey:string,keySha256:string){
    // Establish identity namespace serialization before a CREATE receipt exists.
    await this.db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))','factuez:guide-draft:'+clientId+':'+actorKey);
    const rows=await this.db.$queryRawUnsafe<{payload:GuideOperation}[]>('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "clientId"=$1::uuid AND "actorKey"=$2 AND "keySha256"=$3',clientId,actorKey,keySha256);return rows[0]?.payload??null;
  }
  async operation(id:string,clientId:string,actorKey:string){const rows=await this.db.$queryRawUnsafe<{payload:GuideOperation}[]>('SELECT "payload" FROM "B2bGuideDraftOperation" WHERE "id"=$1::uuid AND "clientId"=$2::uuid AND "actorKey"=$3',id,clientId,actorKey);return rows[0]?.payload??null;}
  async list(clientId:string,actorKey:string,bindings:B2bGuideBinding[],limit:number,after:string|null){
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT ${columns} FROM "B2bGuideDraft" d WHERE "clientId"=$1::uuid AND "actorKey"=$2 AND "id">COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) b WHERE b=d."binding") ORDER BY "id" LIMIT $5`,clientId,actorKey,after,JSON.stringify(bindings),limit);return rows.map(decode);
  }
  async create(d:GuideDraft){await this.db.$executeRawUnsafe(`INSERT INTO "B2bGuideDraft" ("id","clientId","actorKey","guideSeriesId","binding","body","bodySha256","revision","state","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::jsonb,$6::jsonb,$7,$8,$9,$10::timestamptz,$11::timestamptz)`,d.id,d.clientId,d.actorKey,d.binding.guideSeriesId,JSON.stringify(d.binding),JSON.stringify(d.body),d.bodySha256,d.revision,d.state,d.createdAt,d.updatedAt);}
  async save(d:GuideDraft,expected:number){
    const n=await this.db.$executeRawUnsafe('UPDATE "B2bGuideDraft" SET "body"=$2::jsonb,"bodySha256"=$3,"revision"=$4,"state"=$5,"updatedAt"=$6::timestamptz WHERE "id"=$1::uuid AND "revision"=$7 AND "state" IN (\'DRAFT\',\'READY\')',d.id,JSON.stringify(d.body),d.bodySha256,d.revision,d.state,d.updatedAt,expected);
    if(n!==1)throw new B2bSecurityError(412,'REVISION_CONFLICT');
  }
  async append(op:GuideOperation){await this.db.$executeRawUnsafe('INSERT INTO "B2bGuideDraftOperation" ("id","clientId","actorKey","draftId","keySha256","payload") VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::jsonb)',op.id,op.clientId,op.actorKey,op.draftId,op.keySha256,JSON.stringify(op));}
}
function retryable(e:unknown){
  if(!e||typeof e!=='object'||!('code'in e))return false;if(e.code==='P2034')return true;
  const meta='meta'in e?e.meta as any:null,cause=meta?.driverAdapterError?.cause,code=cause?.originalCode??meta?.code,message=cause?.originalMessage??meta?.message;
  return e.code==='P2010'&&(code==='40001'||code==='23505'&&typeof message==='string'&&/B2bGuideDraftOperation_clientId_actorKey_keySha256_key/.test(message));
}
/** Additive candidate store. No schema application, fiscal rows or external I/O.
 * Entire closure retries are bounded; callbacks must reauthorize each attempt. */
export class PostgresB2bGuideStore implements GuideStore{
  constructor(private readonly db:GuideDatabase){}
  async transaction<T>(work:(tx:GuideTransaction)=>Promise<T>):Promise<T>{
    for(let attempt=0;;attempt++)try{return await this.db.$transaction(tx=>work(new PgGuideTransaction(tx)),{isolationLevel:'Serializable',timeout:15000,maxWait:3000});}
    catch(e){if(attempt<2&&retryable(e))continue;if(e instanceof B2bSecurityError)throw e;throw new B2bSecurityError(503,'GUIDE_STORE_UNAVAILABLE');}
  }
}
