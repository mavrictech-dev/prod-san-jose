import {b2bReadonlyScopes} from '@factuez/service-access/dist/b2b-readonly-owner';
import type {Sql,TransactionalSql} from '../integration/postgres-store';
import {PostgresB2bStore,PgTransaction} from './postgres-store';
import {bindings,scopes,fail,type Client,type ClientMetadata,type ClientPageQuery,type Transaction,type BindingCatalogue} from './model';

export function readonlyOnpremClient(c:ClientMetadata){
 if(c.kind!=='SERVICE'||c.oidcClientId!==null)return fail(404,'ONPREM_READONLY_SERVICE_REQUIRED');
 scopes(c.scopes,b2bReadonlyScopes);bindings(c.bindings);
 return c;
}
/** The existing PostgreSQL adapter owns every mutation/audit/rate bucket.
 * The native profile narrows metadata queries and checks grants again before
 * writes. It never calls Auth.login or provisions a human/machine user. */
export class OnpremReadonlyPgStore extends PostgresB2bStore {
 constructor(private readonly owner:TransactionalSql,private readonly catalogue:BindingCatalogue){super(owner);}
 override transaction<T>(work:(tx:Transaction)=>Promise<T>):Promise<T>{
  return this.owner.$transaction(async sql=>{
   const tx=new PgTransaction(sql),catalogue=this.catalogue;
   return work({
    async list(q:ClientPageQuery){
     const rows=await sql.$queryRawUnsafe<ClientMetadata[]>(`SELECT "id","label","kind","enabled","revision","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE "environment"='BETA' AND "kind"='SERVICE' AND "scopes"<@$3::jsonb AND ($1::uuid IS NULL OR "id">$1::uuid) ORDER BY "id" ASC LIMIT $2`,q.after??null,q.limit+1,JSON.stringify(b2bReadonlyScopes));
     return rows.map(readonlyOnpremClient);
    },
    async get(id:string){const c=await tx.get(id);return c?readonlyOnpremClient(c) as Client:null;},
    async create(c:Client){readonlyOnpremClient(c);await catalogue.validate(c.bindings);await tx.create(c);},
    async save(c:Client,revision:number){readonlyOnpremClient(c);if(c.enabled)await catalogue.validate(c.bindings);await tx.save(c,revision);},
    audit:tx.audit.bind(tx),
   });
  },{timeout:15000,maxWait:3000});
 }
}
