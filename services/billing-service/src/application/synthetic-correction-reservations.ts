import {allowsResource} from '@factuez/contracts';
import {boundedSupplementJson,validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {parseDecimal,formatScaled} from '@factuez/sunat-core/dist/tax';
import type {Prisma,PrismaClient} from '../generated/prisma/client';
import {BetaSupplementCommandRepository} from './beta-supplement-command.repository';
import {supplementActor,supplementActorIdentity,type SupplementActor} from './supplement-actor';
type Tx=Prisma.TransactionClient;
export interface SyntheticCorrectionAuthority {current(command:FiscalSupplementCommand):Promise<SupplementActor>}
export class CorrectionReservationBlocked extends Error {constructor(readonly code:string){super(code);}}
const check=(v:unknown,code:string):void=>{if(!v)throw new CorrectionReservationBlocked(code);};
const same=(a:unknown,b:unknown)=>fiscalSnapshotSha256(a)===fiscalSnapshotSha256(b);
const record=(a:SupplementActor)=>({userId:a.userId?.toLowerCase()??null,...(a.b2b?{b2b:a.b2b}:{})});
/** Only detached, already bounded JSON reaches this traversal. */
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
interface Head {originalDocumentId:string;companyId:number;branchId:string;pointId:string;issuerRuc:string;environment:string;candidateOnly:boolean;originalSha256:string;originalAmount:string;creditHeld:string;debitHeld:string;revision:number}
interface Hold {operationId:string;originalDocumentId:string;documentId:string;eventId:string;kind:'CREDIT'|'DEBIT';amount:string;revision:number;commandSha256:string;noteSha256:string;actor:ReturnType<typeof record>;candidateOnly:boolean}
/** Concrete atomic rehearsal, NOT a producer activation or proof resolver.
 * Deliberately restricted to a NEW synthetic database and invented checksum-valid
 * RUC. No controllers/bootstrap/publishers invoke this class. Do not remove the
 * restrictions to enable business usage; the fiscal service gates stay closed.
 */
export class SyntheticCorrectionReservations {
  constructor(private readonly db:Pick<PrismaClient,'$transaction'>,private readonly owner:Pick<BetaSupplementCommandRepository,'reserveWithinTransaction'>,private readonly authority:SyntheticCorrectionAuthority){}
  /** Only the verified candidate composition calls this. Database/RUC fences are
   * retained inside the caller's transaction; this is not a business activation. */
  async reserveWithinTransaction(tx:Tx,value:unknown,actorInput:SupplementActor){
    const command=freeze(validateFiscalSupplementCommand(value)),actor=freeze(supplementActor(actorInput));
    check(command.payload.envelope.kind==='NOTE'&&command.payload.environment==='BETA'&&command.payload.issuerRuc==='20000000001','SYNTHETIC_NOTE_ONLY');
    check([command.eventId,command.payload.operationId,command.payload.branchId].every(id=>id===id.toLowerCase()),'SYNTHETIC_CANONICAL_IDS_REQUIRED');
    const names=await tx.$queryRawUnsafe<{name:string}[]>('SELECT current_database() AS name');
    check(names.length===1&&names[0].name==='b2b_corrections_synthetic','SYNTHETIC_DATABASE_REQUIRED');
    check(fiscalSnapshotSha256(supplementActor(await this.authority.current(command)))===fiscalSnapshotSha256(actor),'AUTHORITY_CHANGED');
    const result=await this.reserveTx(tx,command,actor);
    check(fiscalSnapshotSha256(supplementActor(await this.authority.current(command)))===fiscalSnapshotSha256(actor),'AUTHORITY_CHANGED');
    return result;
  }
  async reserve(value:unknown){
    let command:FiscalSupplementCommand,actor:SupplementActor;
    try{command=freeze(validateFiscalSupplementCommand(value));actor=freeze(supplementActor(await this.authority.current(command)));}
    catch{throw new CorrectionReservationBlocked('INVALID_COMMAND_OR_AUTHORITY');}
    check(command.payload.envelope.kind==='NOTE'&&command.payload.environment==='BETA'&&command.payload.issuerRuc==='20000000001','SYNTHETIC_NOTE_ONLY');
    check([command.eventId,command.payload.operationId,command.payload.branchId].every(id=>id===id.toLowerCase()),'SYNTHETIC_CANONICAL_IDS_REQUIRED');
    const stamp=fiscalSnapshotSha256(actor);
    const fresh=async()=>{const current=supplementActor(await this.authority.current(command));check(fiscalSnapshotSha256(current)===stamp,'AUTHORITY_CHANGED');};
    for(let attempt=0;;attempt++){
      try{return await this.db.$transaction(async tx=>{
        const names=await tx.$queryRawUnsafe<{name:string}[]>('SELECT current_database() AS name');
        check(names.length===1&&names[0].name==='b2b_corrections_synthetic','SYNTHETIC_DATABASE_REQUIRED');
        await fresh();const result=await this.reserveTx(tx,command,actor);await fresh();return result;
      },{isolationLevel:'Serializable',maxWait:3000,timeout:15000});}
      catch(e){
        if(e&&typeof e==='object'&&'code'in e&&e.code==='P2034'&&attempt<2)continue;
        if(e instanceof CorrectionReservationBlocked)throw e;
        throw new CorrectionReservationBlocked('CANDIDATE_TRANSACTION_FAILED');
      }
    }
  }
  private result(h:Hold){return {operationId:h.operationId,documentId:h.documentId,eventId:h.eventId,originalDocumentId:h.originalDocumentId,
    reservationRevision:h.revision,kind:h.kind,heldAmount:h.amount,state:'HELD_LOCAL' as const,candidateOnly:true as const,
    fiscalAuthority:false as const,evidenceAuthenticityVerified:false as const,transmissionAuthorized:false as const};}
  private async reserveTx(tx:Tx,c:FiscalSupplementCommand,actor:SupplementActor){
    const p=c.payload,e=p.envelope;check(e.kind==='NOTE','SYNTHETIC_NOTE_ONLY');if(e.kind!=='NOTE')throw new CorrectionReservationBlocked('SYNTHETIC_NOTE_ONLY');
    const original=e.context.original,originalId=original.documentId.toLowerCase(),operationId=p.operationId.toLowerCase();
    check(allowsResource(actor.scope,p.branchId),'SCOPE_DENIED');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:company:${p.companyId}:ruc:${p.issuerRuc}`},0))`;
    // Same master lock order as CRUD/issuance: company → branch → point.
    await tx.$queryRawUnsafe('SELECT "id" FROM "CompanySettings" WHERE "id"=$1 FOR SHARE',p.companyId);
    await tx.$queryRawUnsafe('SELECT "id" FROM "Branch" WHERE "id"=$1::uuid FOR SHARE',p.branchId);
    const own=await tx.document.findUnique({where:{id:originalId},select:{id:true,companyId:true,emissionPointId:true,seriesCounterId:true,immutableSnapshot:true,payableAmount:true,currencyCode:true}});
    check(own&&own.companyId===p.companyId&&same(own.immutableSnapshot,original)&&own.currencyCode==='PEN'&&parseDecimal(String(own.payableAmount),2)===parseDecimal(original.totals.payableAmount,2),'OWN_ORIGINAL_MISMATCH');
    if(!own)throw new CorrectionReservationBlocked('OWN_ORIGINAL_MISMATCH');
    await tx.$queryRawUnsafe('SELECT "id" FROM "EmissionPoint" WHERE "id"=$1::uuid FOR SHARE',own.emissionPointId);
    check(allowsResource(actor.scope,p.branchId,own.emissionPointId,own.seriesCounterId),'SCOPE_DENIED');
    // A separate accepted/versioned ledger or any batch history is not silently
    // adopted as an available original balance by this deliberately narrow rehearsal.
    check(!await tx.financialLedgerStream.findUnique({where:{documentId:originalId},select:{documentId:true}}),'EXISTING_FINANCIAL_LEDGER_REQUIRES_RECONCILIATION');
    check(!await tx.dailySummaryItem.findFirst({where:{documentId:originalId},select:{id:true}}),'BATCH_HISTORY_REQUIRES_RECONCILIATION');
    const heads=await tx.$queryRawUnsafe<Head[]>(`SELECT "originalDocumentId","companyId","branchId","pointId","issuerRuc","environment","candidateOnly","originalSha256","originalAmount"::text,"creditHeld"::text,"debitHeld"::text,"revision" FROM "B2bCorrectionHoldHead" WHERE "originalDocumentId"=$1::uuid FOR UPDATE`,originalId),head=heads[0]??null;
    const holds=await tx.$queryRawUnsafe<Hold[]>(`SELECT "operationId","originalDocumentId","documentId","eventId","kind","amount"::text,"revision","commandSha256","noteSha256","actor","candidateOnly" FROM "B2bCorrectionHold" WHERE "originalDocumentId"=$1::uuid ORDER BY "revision" LIMIT 101`,originalId);
    const notes=await tx.document.findMany({where:{companyId:p.companyId,type:{in:['CREDIT_NOTE','DEBIT_NOTE']},OR:[{referencesFrom:{some:{targetDocumentId:originalId}}},{immutableSnapshot:{path:['reference','documentId'],equals:originalId}},
      {referencesFrom:{some:{targetDocumentId:null,targetTypeCode:original.documentTypeCode,targetSeries:original.series,targetNumber:BigInt(original.number)}}}]},
      select:{id:true,type:true,sunatStatus:true,emissionPointId:true,immutableSnapshot:true,payableAmount:true,createdByUserId:true,createdByActor:true},take:101});
    check(holds.length<=100&&notes.length<=100&&holds.length===notes.length,'UNRECONCILED_NOTE_HISTORY');
    const events=holds.length?await tx.outboxEvent.findMany({where:{id:{in:holds.map(h=>h.eventId)}},select:{id:true,eventType:true,aggregateId:true,payload:true},take:101}):[];
    check(events.length===holds.length,'HOLD_COMMAND_MISSING');let credit=0n,debit=0n;
    for(const [i,h]of holds.entries()){
      const n=notes.find(n=>n.id===h.documentId),event=events.find(v=>v.id===h.eventId);
      check(h.candidateOnly&&h.originalDocumentId===originalId&&h.operationId===h.documentId&&h.revision===i+1&&n&&event,'HOLD_HISTORY_INCONSISTENT');
      if(!n||!event)throw new CorrectionReservationBlocked('HOLD_HISTORY_INCONSISTENT');
      const old=validateFiscalSupplementCommand(event.payload);
      check(event.eventType===old.eventName&&event.aggregateId.toLowerCase()===h.operationId&&old.eventId===h.eventId&&old.payload.operationId.toLowerCase()===h.operationId&&old.payload.envelope.kind==='NOTE'&&
        old.payload.companyId===p.companyId&&old.payload.branchId===p.branchId&&old.payload.issuerRuc===p.issuerRuc&&same(old.payload.envelope.kind==='NOTE'?old.payload.envelope.note:null,n.immutableSnapshot)&&fiscalSnapshotSha256(old)===h.commandSha256,'HOLD_COMMAND_INCONSISTENT');
      check(fiscalSnapshotSha256(n.immutableSnapshot)===h.noteSha256&&n.emissionPointId===own.emissionPointId&&parseDecimal(String(n.payableAmount),2)===parseDecimal(h.amount,2)&&
        (h.kind==='CREDIT'?n.type==='CREDIT_NOTE':n.type==='DEBIT_NOTE')&&n.createdByUserId===h.actor.userId&&same(n.createdByActor,h.actor.b2b??null),'HOLD_DOCUMENT_INCONSISTENT');
      if(h.kind==='CREDIT')credit+=parseDecimal(h.amount,2);else debit+=parseDecimal(h.amount,2);
    }
    const total=parseDecimal(original.totals.payableAmount,2),originalSha=fiscalSnapshotSha256(original);
    if(head)check(head.candidateOnly&&head.environment==='BETA'&&head.companyId===p.companyId&&head.branchId===p.branchId&&head.pointId===own.emissionPointId&&head.issuerRuc===p.issuerRuc&&head.originalSha256===originalSha&&
      parseDecimal(head.originalAmount,2)===total&&parseDecimal(head.creditHeld,2)===credit&&parseDecimal(head.debitHeld,2)===debit&&head.revision===holds.length,'HOLD_HEAD_INCONSISTENT');
    else check(!holds.length,'HOLD_HEAD_MISSING');
    const prior=holds.find(h=>h.operationId===operationId);
    if(prior){
      check(prior.commandSha256===fiscalSnapshotSha256(c)&&same(supplementActorIdentity({...prior.actor,scope:actor.scope}),supplementActorIdentity(actor)),'RESERVATION_REPLAY_CONFLICT');
      const result=await this.owner.reserveWithinTransaction(tx,c,actor);check(result.deduplicated,'RESERVATION_REPLAY_INCONSISTENT');return {...this.result(prior),deduplicated:true};
    }
    check(holds.length<100,'HOLD_HISTORY_LIMIT_EXCEEDED');
    // No implicit release on a REJECTED projection. Conflicting line histories
    // require reconciliation, rather than expanding the credit capacity.
    check(notes.filter(n=>n.type==='CREDIT_NOTE').length===e.context.creditHistory.entries.length,'CREDIT_HOLDS_REQUIRE_RECONCILIATION');
    const amount=parseDecimal(e.note.totals.payableAmount,2),kind=e.note.documentTypeCode==='07'?'CREDIT':'DEBIT';
    check(amount>0n&&(kind!=='CREDIT'||credit+amount<=total),'CREDIT_HOLD_CAPACITY_EXCEEDED');
    const reserved=await this.owner.reserveWithinTransaction(tx,c,actor);check(!reserved.deduplicated,'ORPHAN_NOTE_RESERVATION');
    if(!head)await tx.$executeRawUnsafe(`INSERT INTO "B2bCorrectionHoldHead" ("originalDocumentId","companyId","branchId","pointId","issuerRuc","originalSha256","originalAmount","revision") VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7::numeric,0)`,originalId,p.companyId,p.branchId,own.emissionPointId,p.issuerRuc,originalSha,formatScaled(total,2));
    const h:Hold={operationId,originalDocumentId:originalId,documentId:operationId,eventId:c.eventId.toLowerCase(),kind,amount:formatScaled(amount,2),revision:holds.length+1,
      commandSha256:fiscalSnapshotSha256(c),noteSha256:fiscalSnapshotSha256(e.note),actor:record(actor),candidateOnly:true};
    await tx.$executeRawUnsafe(`INSERT INTO "B2bCorrectionHold" ("operationId","originalDocumentId","documentId","eventId","kind","amount","revision","commandSha256","noteSha256","actor","createdAt") VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6::numeric,$7,$8,$9,$10::jsonb,$11::timestamptz)`,h.operationId,h.originalDocumentId,h.documentId,h.eventId,h.kind,h.amount,h.revision,h.commandSha256,h.noteSha256,JSON.stringify(h.actor),c.occurredAt);
    const changed=await tx.$executeRawUnsafe(`UPDATE "B2bCorrectionHoldHead" SET "creditHeld"=$2::numeric,"debitHeld"=$3::numeric,"revision"=$4 WHERE "originalDocumentId"=$1::uuid AND "revision"=$5 AND "creditHeld"=$6::numeric AND "debitHeld"=$7::numeric`,originalId,formatScaled(credit+(kind==='CREDIT'?amount:0n),2),formatScaled(debit+(kind==='DEBIT'?amount:0n),2),h.revision,holds.length,formatScaled(credit,2),formatScaled(debit,2));
    check(changed===1,'HOLD_HEAD_CAS_FAILED');return {...this.result(h),deduplicated:false};
  }
}
