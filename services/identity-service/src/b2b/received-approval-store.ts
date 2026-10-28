import type {TransactionalSql} from '../integration/postgres-store';
import {PgTransaction} from './postgres-store';
import type {Audit,Client} from './model';
import {copy,unavailable,type ApprovalRow} from './received-approval-model';
export interface ReceivedApprovalTx {client(id:string):Promise<Client|null>;get(nonceHash:string):Promise<ApprovalRow|null>;insert(row:ApprovalRow):Promise<void>;audit(row:Audit):Promise<void>}
export interface ReceivedApprovalStore {transaction<T>(work:(tx:ReceivedApprovalTx)=>Promise<T>):Promise<T>}
/** Existing Identity transaction/client/audit primitives; no connection, DDL or migrations at construction. */
export class PostgresReceivedApprovalStore implements ReceivedApprovalStore {
 #db:TransactionalSql;
 constructor(db:TransactionalSql){this.#db=db;}
 async ready(){try{
  for(const sql of ['SELECT "nonceHash","approval","expiresAt" FROM "B2bReceivedApproval" WHERE false',
   'SELECT "id","requestId","clientId","actorId","action","outcome","revision","peerHash","at" FROM "B2bAudit" WHERE false']){const rows=await this.#db.$queryRawUnsafe<unknown[]>(sql);if(!Array.isArray(rows)||rows.length)throw unavailable();}
 }catch{throw unavailable();}}
 async transaction<T>(work:(tx:ReceivedApprovalTx)=>Promise<T>):Promise<T>{
  try{return await this.#db.$transaction(async sql=>{
   const base=new PgTransaction(sql);
   return work({client:id=>base.get(id),audit:row=>base.audit(row),get:async nonceHash=>{
    const rows=await sql.$queryRawUnsafe<{approval:ApprovalRow;expiresAt:bigint|number}[]>('SELECT "approval","expiresAt" FROM "B2bReceivedApproval" WHERE "nonceHash"=$1 FOR UPDATE',nonceHash);
    if(rows.length>1||rows[0]&&Number(rows[0].expiresAt)!==rows[0].approval.expiresAt)throw unavailable();return rows[0]?copy(rows[0].approval):null;
   },insert:async row=>{
    if(await sql.$executeRawUnsafe('INSERT INTO "B2bReceivedApproval" ("nonceHash","approval","expiresAt") VALUES($1,$2::jsonb,$3)',row.nonceHash,JSON.stringify(row),row.expiresAt)!==1)throw unavailable();
   }});
  },{timeout:30000,maxWait:3000});}catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='RECEIVED_STEP_UP_DENIED')throw e;throw unavailable();}
 }
}
