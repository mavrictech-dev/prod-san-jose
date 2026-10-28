import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedSubject,type ReceivedScope,type ReceivedSubject,type ReceivedSelection} from '@factuez/service-access/dist/b2b-received-wire';
export type ReceptionGrant={scope:ReceivedScope;subject:ReceivedSubject;permission:'READ'|'ARTIFACT';clientRevision:number;userAuthRevision:number|null;active:boolean;revision:number};
export interface ReceivedSql{ $queryRawUnsafe<T=any[]>(sql:string,...values:any[]):Promise<T>; $executeRawUnsafe(sql:string,...values:any[]):Promise<number> }
export interface ReceivedDatabase{ $transaction<T>(work:(db:ReceivedSql)=>Promise<T>,options?:{isolationLevel:'Serializable';timeout:number;maxWait:number}):Promise<T> }
export interface ReceivedReadTransaction{
  grant(principal:B2bPrincipal,scope:ReceivedScope,permission:'READ'|'ARTIFACT'):Promise<ReceptionGrant>;
  list(query:ReceivedSelection):Promise<any[]>;document(scope:ReceivedScope,id:string):Promise<any|null>;
  artifacts(scope:ReceivedScope,id:string):Promise<any[]>;artifact(scope:ReceivedScope,id:string,artifactId:string):Promise<any|null>;
  audit(principal:B2bPrincipal,scope:ReceivedScope,action:string,id:string|null,artifactId:string|null):Promise<void>;
  policy(key:string):Promise<ReceptionGrant|null>;savePolicy(key:string,value:ReceptionGrant,expected:number,adminId:string):Promise<void>;
}
export interface ReceivedReadStore{transaction<T>(work:(tx:ReceivedReadTransaction)=>Promise<T>):Promise<T>}
export const receptionGrantKey=(scope:ReceivedScope,subject:ReceivedSubject,permission:'READ'|'ARTIFACT')=>hash({scope,subject,permission});
const unavailable=()=>new B2bSecurityError(503,'RECEIVED_OWNER_UNAVAILABLE');
const fields='d."id",d."companyId",d."recipientRuc",d."branchId",d."supplierRuc",d."supplierName",d."documentType",d."fullNumber",d."issueDate",d."currencyCode",d."payableAmount",d."receivedAt",d."registeredAt",d."erpReference",d."projection",d."xmlSha256"';
class PgTransaction implements ReceivedReadTransaction{
  private open=true;private failure:unknown;private pending=new Set<Promise<unknown>>();
  constructor(private readonly db:ReceivedSql){}
  private run<T>(work:()=>Promise<T>):Promise<T>{
    const p=(async()=>{if(!this.open||this.failure)throw unavailable();try{return await work();}catch(e){this.failure??=e;throw e;}})();
    this.pending.add(p);void p.then(()=>this.pending.delete(p),()=>this.pending.delete(p));return p;
  }
  async finish(){
    // Close admission before draining: escaped callbacks must never enqueue a
    // second SQL operation while a transaction is waiting to commit.
    this.open=false;
    while(this.pending.size)await Promise.allSettled([...this.pending]);
    if(this.failure)throw this.failure;
  }
  grant(p:B2bPrincipal,s:ReceivedScope,permission:'READ'|'ARTIFACT'){
    return this.run(async()=>{
      const rows=await this.db.$queryRawUnsafe<any[]>('SELECT "policy" FROM "B2bReceivedReadGrant" WHERE "grantKey"=$1 FOR SHARE',receptionGrantKey(s,receivedSubject(p),permission));
      const g=rows[0]?.policy as ReceptionGrant;
      if(rows.length!==1||!g||g.active!==true||g.permission!==permission||g.clientRevision!==p.revision||g.userAuthRevision!==p.userAuthRevision||
        hash(g.scope)!==hash(s)||hash(g.subject)!==hash(receivedSubject(p))||!Number.isSafeInteger(g.revision)||g.revision<1)
        throw new B2bSecurityError(403,'RECEIVED_GRANT_REQUIRED');return correctionEvidenceFreeze(g);
    });
  }
  list(q:ReceivedSelection){return this.run(()=>this.db.$queryRawUnsafe<any[]>(`SELECT ${fields} FROM "ReceivedDocument" d
    WHERE d."companyId"=$1 AND d."recipientRuc"=$2 AND d."branchId"=$3::uuid AND d."issueDate">=$4::date AND d."issueDate"<=$5::date
      AND ($6::text IS NULL OR d."documentType"=$6) AND ($7::uuid IS NULL OR d."id">$7::uuid)
    ORDER BY d."id" ASC LIMIT $8`,q.scope.companyId,q.scope.recipientRuc,q.scope.branchId,q.from,q.to,q.type??null,q.after??null,q.limit+1));}
  document(s:ReceivedScope,id:string){return this.run(async()=>{
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT ${fields} FROM "ReceivedDocument" d WHERE d."id"=$1::uuid
      AND d."companyId"=$2 AND d."recipientRuc"=$3 AND d."branchId"=$4::uuid FOR SHARE`,id,s.companyId,s.recipientRuc,s.branchId);return rows[0]??null;
  });}
  artifacts(s:ReceivedScope,id:string){return this.run(()=>this.db.$queryRawUnsafe<any[]>(`SELECT a."id",a."kind",a."fileName",a."sha256",a."byteLength" FROM "ReceivedArtifact" a
    JOIN "ReceivedDocument" d ON d."id"=a."documentId" WHERE d."id"=$1::uuid AND d."companyId"=$2 AND d."recipientRuc"=$3 AND d."branchId"=$4::uuid
    ORDER BY a."id" ASC LIMIT 21`,id,s.companyId,s.recipientRuc,s.branchId));}
  artifact(s:ReceivedScope,id:string,artifactId:string){return this.run(async()=>{
    const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT a."id",a."kind",a."fileName",a."sha256",a."byteLength",a."bytes" FROM "ReceivedArtifact" a
      JOIN "ReceivedDocument" d ON d."id"=a."documentId" WHERE a."id"=$1::uuid AND d."id"=$2::uuid AND d."companyId"=$3 AND d."recipientRuc"=$4 AND d."branchId"=$5::uuid FOR SHARE`,artifactId,id,s.companyId,s.recipientRuc,s.branchId);return rows[0]??null;
  });}
  audit(p:B2bPrincipal,s:ReceivedScope,action:string,id:string|null,artifactId:string|null){return this.run(async()=>{
    const n=await this.db.$executeRawUnsafe(`INSERT INTO "B2bReceivedReadAudit" ("clientId","subjectId","actorKind","scope","action","documentId","artifactId","clientRevision","userAuthRevision")
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5,$6::uuid,$7::uuid,$8,$9)`,p.clientId,p.subjectId,p.kind,JSON.stringify(s),action,id,artifactId,p.revision,p.userAuthRevision);
    if(n!==1)throw unavailable();
  });}
  policy(key:string){return this.run(async()=>{const rows=await this.db.$queryRawUnsafe<any[]>('SELECT "policy" FROM "B2bReceivedReadGrant" WHERE "grantKey"=$1 FOR UPDATE',key);return rows[0]?.policy??null;});}
  savePolicy(key:string,g:ReceptionGrant,expected:number,adminId:string){return this.run(async()=>{
    const n=expected===0?await this.db.$executeRawUnsafe('INSERT INTO "B2bReceivedReadGrant" ("grantKey","policy","revision") VALUES($1,$2::jsonb,$3)',key,JSON.stringify(g),g.revision):
      await this.db.$executeRawUnsafe('UPDATE "B2bReceivedReadGrant" SET "policy"=$2::jsonb,"revision"=$3 WHERE "grantKey"=$1 AND "revision"=$4',key,JSON.stringify(g),g.revision,expected);
    if(n!==1)throw new B2bSecurityError(409,'RECEIVED_POLICY_CONFLICT');
    if(await this.db.$executeRawUnsafe('INSERT INTO "B2bReceivedPolicyAudit" ("grantKey","revision","adminId","policySha256") VALUES($1,$2,$3::uuid,$4)',key,g.revision,adminId,hash(g))!==1)throw unavailable();
  });}
}
/** Only this service's data. No Identity/Billing DB access, schema install or emission outbox. */
export class PostgresReceivedReadStore implements ReceivedReadStore{
  constructor(private readonly db:ReceivedDatabase){}
  async transaction<T>(work:(tx:ReceivedReadTransaction)=>Promise<T>):Promise<T>{
    try{return await this.db.$transaction(async db=>{
      const tx=new PgTransaction(db);try{const result=await work(tx);await tx.finish();return result;}catch(e){try{await tx.finish();}catch{}throw e;}
    },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});}
    catch(e){if(e instanceof B2bSecurityError)throw e;throw unavailable();}
  }
}
