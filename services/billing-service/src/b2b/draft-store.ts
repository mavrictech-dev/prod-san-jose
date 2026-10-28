import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { Draft,DraftOperation,DraftStore,DraftTransaction,DraftIssueResult } from './draft-model';
export interface DraftSql {$queryRawUnsafe<T=unknown>(sql:string,...values:unknown[]):Promise<T>;$executeRawUnsafe(sql:string,...values:unknown[]):Promise<number>}
export interface DraftDatabase {$transaction<T>(work:(tx:DraftSql)=>Promise<T>,options:{timeout:number;maxWait:number}):Promise<T>}
export type DraftIssuer=(db:DraftSql,draft:Draft,operation:DraftOperation)=>Promise<DraftIssueResult>;
const decode=(row:any):Draft=>({...row,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()});
export class PgDraftTransaction implements DraftTransaction {
  readonly issue?:DraftTransaction['issue'];
  constructor(private readonly db:DraftSql,issuer?:DraftIssuer){if(issuer)this.issue=(draft,operation)=>issuer(db,draft,operation);}
  async get(id:string){const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT "id","clientId","actorKey","binding","body","revision","state","validatedRevision","createdAt","updatedAt" FROM "B2bDocumentDraft" WHERE "id"=$1::uuid AND "environment"='BETA' FOR UPDATE`,id);return rows[0]?decode(rows[0]):null;}
  async create(d:Draft){await this.db.$executeRawUnsafe(`INSERT INTO "B2bDocumentDraft" ("id","clientId","actorKey","binding","body","revision","state","validatedRevision","createdAt","updatedAt","issuerId","referenceNamespace","referenceValue") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12,$13)`,d.id,d.clientId,d.actorKey,JSON.stringify(d.binding),JSON.stringify(d.body),d.revision,d.state,d.validatedRevision,d.createdAt,d.updatedAt,d.binding.issuerId,d.body.externalReference.namespace,d.body.externalReference.value);}
  async save(d:Draft,expected:number){const n=await this.db.$executeRawUnsafe(`UPDATE "B2bDocumentDraft" SET "body"=$2::jsonb,"revision"=$3,"state"=$4,"validatedRevision"=$5,"updatedAt"=$6::timestamptz WHERE "id"=$1::uuid AND "revision"=$7 AND "environment"='BETA' AND "state"='DRAFT'`,d.id,JSON.stringify(d.body),d.revision,d.state,d.validatedRevision,d.updatedAt,expected);if(n!==1)throw new B2bSecurityError(412,'REVISION_CONFLICT');}
  private async find(sql:string,values:unknown[]){const rows=await this.db.$queryRawUnsafe<any[]>(sql,...values);if(!rows[0])return null;const {payload}=rows[0];return payload as DraftOperation;}
  prior(clientId:string,actorKey:string,keyHash:string){return this.find(`SELECT "payload" FROM "B2bDraftOperation" WHERE "clientId"=$1::uuid AND "actorKey"=$2 AND "keyHash"=$3 AND "environment"='BETA'`,[clientId,actorKey,keyHash]);}
  operation(id:string,clientId:string,actorKey:string){return this.find(`SELECT "payload" FROM "B2bDraftOperation" WHERE "id"=$1::uuid AND "clientId"=$2::uuid AND "actorKey"=$3 AND "environment"='BETA'`,[id,clientId,actorKey]);}
  async append(op:DraftOperation){
    // Do not retain the bearer, client secret or complete effective grant snapshot.
    const {kind,clientId,revision,subjectId,userAuthRevision}=op.actor;
    const payload={...op,actor:{kind,clientId,revision,subjectId,userAuthRevision}};
    await this.db.$executeRawUnsafe(`INSERT INTO "B2bDraftOperation" ("id","clientId","actorKey","keyHash","draftId","payload") VALUES ($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::jsonb)`,op.id,op.clientId,op.actorKey,op.keyHash,op.draftId,JSON.stringify(payload));
  }
}
export class PostgresB2bDraftStore implements DraftStore {
  constructor(private readonly db:DraftDatabase,private readonly issuer?:DraftIssuer){}
  async transaction<T>(scope:string,work:(tx:DraftTransaction)=>Promise<T>):Promise<T>{
    try{return await this.db.$transaction(async tx=>{
      // Namespace lock also serializes CREATE/replay before a draft row exists.
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',scope);
      return work(new PgDraftTransaction(tx,this.issuer));
    },{timeout:15000,maxWait:3000});}catch(e){
      if(e instanceof B2bSecurityError)throw e;
      if(e&&typeof e==='object'&&'code'in e&&(e.code==='23505'||e.code==='P2002'||('meta'in e&&(e.meta as any)?.code==='23505')))throw new B2bSecurityError(409,'DRAFT_REFERENCE_CONFLICT');
      throw new B2bSecurityError(503,'DRAFT_STORE_UNAVAILABLE');
    }
  }
}
