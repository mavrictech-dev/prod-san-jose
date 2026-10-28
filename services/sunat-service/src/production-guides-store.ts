import { randomUUID } from 'node:crypto';
import type { ProductionGuidesIssued as Issued,ProductionGuidesResult as Result,ProductionGuidesSigner,ProductionGuidesStatusEvent,ProductionGuidesArtifactKind as Kind,ProductionGuidesArtifact as Artifact } from '@factuez/contracts/production-guides';
import { productionGuidesHash as hash,productionGuidesBytesHash as bytesHash,productionGuidesUuid } from '@factuez/sunat-core/dist/production-guides';
export interface ProductionGuidesSql { $queryRawUnsafe<T=unknown>(sql:string,...values:any[]):Promise<T>; $executeRawUnsafe(sql:string,...values:any[]):Promise<number> }
export interface ProductionGuidesDatabase extends ProductionGuidesSql { $transaction<T>(work:(tx:ProductionGuidesSql)=>Promise<T>,options?:any):Promise<T> }
export type ProductionGuidesJob={documentId:string;eventId:string;snapshotSha256:string;event:Issued;result:Result;state:Result['state'];revision:number;attemptId:string|null;ticket:string|null;manifest:{unsignedXml:string;fingerprint:string;digest:string;reference?:unknown}|null;evidence:any};
export type ProductionGuidesPrepared={manifest:NonNullable<ProductionGuidesJob['manifest']>;artifacts:{kind:Kind;artifact:Artifact}[];xmlSha256:string;zipSha256:string};
export class ProductionGuidesStore {
 constructor(private readonly db:ProductionGuidesDatabase,private readonly signer:ProductionGuidesSigner,readonly source:Result['source']){}
 async get(id:string,tx:ProductionGuidesSql=this.db,lock=false){productionGuidesUuid(id);return (await tx.$queryRawUnsafe<ProductionGuidesJob[]>('SELECT * FROM "ProductionGuidesJob" WHERE "documentId"=$1::uuid'+(lock?' FOR UPDATE':''),id))[0];}
 async ingest(e:Issued){return this.db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-job:'+e.snapshot.documentId);
  const prior=await this.get(e.snapshot.documentId,tx);if(prior){if(hash(prior.event)!==hash(e))throw Error('GRE_EVENT_CONFLICT');return prior;}
  const result:Result={documentId:e.snapshot.documentId,snapshotSha256:e.snapshotSha256,state:'RESERVED',revision:0,source:this.source,officialCdrVerified:false,authorizedForTransfer:false};
  await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesJob" ("documentId","eventId","snapshotSha256","event","result","state") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb,\'RESERVED\')',e.snapshot.documentId,e.eventId,e.snapshotSha256,JSON.stringify(e),JSON.stringify(result));return (await this.get(e.snapshot.documentId,tx))!;
 });}
 private async update(tx:ProductionGuidesSql,j:ProductionGuidesJob,patch:Partial<Result>,extra:{ticket?:string;attemptId?:string;manifest?:unknown;evidence?:unknown}={}){
  const result:Result={...j.result,...patch,revision:j.revision+1,authorizedForTransfer:false};
  const payload={eventId:randomUUID(),eventType:'sunat.production-guides.status.v1' as const,result};
  const event:ProductionGuidesStatusEvent={...payload,seal:this.signer.sign(payload,'STATUS')};
  await tx.$executeRawUnsafe('UPDATE "ProductionGuidesJob" SET "state"=$2,"result"=$3::jsonb,"revision"=$4,"ticket"=COALESCE($5::uuid,"ticket"),"attemptId"=COALESCE($6::uuid,"attemptId"),"manifest"=COALESCE($7::jsonb,"manifest"),"evidence"=COALESCE($8::jsonb,"evidence"),"updatedAt"=now() WHERE "documentId"=$1::uuid',j.documentId,result.state,JSON.stringify(result),result.revision,extra.ticket??null,extra.attemptId??null,extra.manifest?JSON.stringify(extra.manifest):null,extra.evidence?JSON.stringify(extra.evidence):null);
  await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesStatusOutbox" ("eventId","documentId","revision","event") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)',event.eventId,j.documentId,result.revision,JSON.stringify(event));return (await this.get(j.documentId,tx))!;
 }
 private async save(tx:ProductionGuidesSql,id:string,kind:Kind,a:Artifact){
  if(bytesHash(a.bytes)!==a.sha256||a.bytes.length>4194304||!a.bytes.length)throw Error('GRE_ARTIFACT_INVALID');
  await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesArtifact" ("documentId","kind","name","mediaType","sha256","bytes") VALUES ($1::uuid,$2,$3,$4,$5,$6)',id,kind,a.name,a.mediaType,a.sha256,a.bytes);
 }
 /** One locked preparation; signatures/originals and PREPARED event commit atomically. */
 async prepare(id:string,work:(j:ProductionGuidesJob)=>Promise<ProductionGuidesPrepared>){return this.db.$transaction(async tx=>{
  const j=await this.get(id,tx,true);if(!j)throw Error('GRE_NOT_FOUND');if(j.state!=='RESERVED')return j;
  const p=await work(j);for(const a of p.artifacts)await this.save(tx,id,a.kind,a.artifact);
  if(p.artifacts.length!==2||!p.artifacts.some(a=>a.kind==='signed-xml'&&a.artifact.sha256===p.xmlSha256)||!p.artifacts.some(a=>a.kind==='submission-zip'&&a.artifact.sha256===p.zipSha256))throw Error('GRE_PREPARATION_INCOMPLETE');
  return this.update(tx,j,{state:'PREPARED',xmlSha256:p.xmlSha256,zipSha256:p.zipSha256},{manifest:p.manifest});
 },{maxWait:5000,timeout:60000});}
 /** Commit UNKNOWN before ANY network call. Concurrent workers cannot obtain a second submission capability. */
 async beginPost(id:string){return this.db.$transaction(async tx=>{
  const j=await this.get(id,tx,true);if(!j||j.state!=='PREPARED')return null;
  return this.update(tx,j,{state:'UNKNOWN'},{attemptId:randomUUID()});
 });}
 async attachTicket(id:string,attemptId:string,ticket:string){productionGuidesUuid(ticket);return this.db.$transaction(async tx=>{
  const j=await this.get(id,tx,true);if(!j||j.state!=='UNKNOWN'||j.attemptId!==attemptId)throw Error('GRE_ATTEMPT_CHANGED');
  return this.update(tx,j,{state:'TICKET',ticket},{ticket});
 });}
 async finish(id:string,ticket:string,patch:Partial<Result>,files:{kind:Kind;artifact:Artifact}[],evidence?:unknown){return this.db.$transaction(async tx=>{
  const j=await this.get(id,tx,true);if(!j)throw Error('GRE_NOT_FOUND');if(j.state!=='TICKET'){if(j.ticket===ticket)return j;throw Error('GRE_TICKET_CHANGED');}
  if(j.ticket!==ticket||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','FAILED_NO_CDR'].includes(patch.state??''))throw Error('GRE_RESULT_INVALID');
  if(patch.state!=='FAILED_NO_CDR'&&(files.length!==2||!files.some(f=>f.kind==='cdr-zip')||!files.some(f=>f.kind==='cdr-xml')||!evidence))throw Error('GRE_CDR_REQUIRED');
  for(const f of files)await this.save(tx,id,f.kind,f.artifact);return this.update(tx,j,patch,{evidence});
 });}
 async artifact(id:string,kind:Kind):Promise<Artifact>{
  const a=(await this.db.$queryRawUnsafe<Artifact[]>('SELECT "name","mediaType","sha256","bytes" FROM "ProductionGuidesArtifact" WHERE "documentId"=$1::uuid AND "kind"=$2',id,kind))[0];
  if(!a||bytesHash(Buffer.from(a.bytes))!==a.sha256)throw Error('GRE_ORIGINAL_UNAVAILABLE_OR_CHANGED');return {...a,bytes:Buffer.from(a.bytes)};
 }
 async pending(limit=20){if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('GRE_LIMIT_INVALID');return this.db.$queryRawUnsafe<{documentId:string}[]>('SELECT "documentId" FROM "ProductionGuidesJob" WHERE "state" IN (\'RESERVED\',\'PREPARED\',\'TICKET\') ORDER BY "updatedAt" LIMIT $1',limit);}
 /** Outbox relay acknowledges only after a protected Billing sink accepted the signed sequential event. */
 async relay(sink:(e:ProductionGuidesStatusEvent)=>Promise<void>,limit=20){
  return this.db.$transaction(async tx=>{
   const rows=await tx.$queryRawUnsafe<{event:ProductionGuidesStatusEvent}[]>('SELECT "event" FROM "ProductionGuidesStatusOutbox" WHERE "publishedAt" IS NULL ORDER BY "documentId","revision" LIMIT $1 FOR UPDATE',Math.max(1,Math.min(100,limit)));
   for(const r of rows){await sink(r.event);await tx.$executeRawUnsafe('UPDATE "ProductionGuidesStatusOutbox" SET "publishedAt"=now() WHERE "eventId"=$1::uuid',r.event.eventId);}return rows.length;
  },{timeout:60000});
 }
}
