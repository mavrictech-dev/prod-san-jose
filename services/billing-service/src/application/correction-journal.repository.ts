import type {FiscalDocumentSnapshot} from '@factuez/contracts';
import {projectCorrectionJournal,type CorrectionJournalEvent} from '@factuez/sunat-core/dist/fiscal-correction-journal';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {parseDecimal} from '@factuez/sunat-core/dist/tax';
import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {Prisma} from '../generated/prisma/client';
import {supplementActor,supplementActorIdentity,type SupplementActor} from './supplement-actor';
import type {BetaSupplementCommandRepository} from './beta-supplement-command.repository';

type Tx=Prisma.TransactionClient;
type Head={originalDocumentId:string;originalSha256:string;revision:number;headSha256:string;candidateOnly:boolean};
type Row={revision:number;operationId:string;kind:'RESERVE'|'SETTLE';event:CorrectionJournalEvent;versionSha256:string};
export type CorrectionRequestReceipt={keySha256:string;requestSha256:string;externalSha256:string;binding:unknown;actorIdentitySha256:string};
const check=(v:unknown,code:string):void=>{if(!v)throw new Error(code);};
const same=(a:unknown,b:unknown)=>fiscalSnapshotSha256(a)===fiscalSnapshotSha256(b);
const SHA=/^[a-f0-9]{64}$/;
type PhysicalIdentity={issueDate:Date;operationTypeCode:string|null;customerIdentityType:string;customerIdentityNumber:string;customerLegalName:string;customerAddress:string|null};
function physicalIdentity(row:PhysicalIdentity,snapshot:FiscalDocumentSnapshot){
  return row.issueDate.getTime()===Date.parse(snapshot.issueDate)&&row.operationTypeCode===snapshot.operationTypeCode&&row.customerIdentityType===snapshot.customer.identityType&&
    row.customerIdentityNumber===snapshot.customer.identityNumber&&row.customerLegalName===snapshot.customer.legalName&&(row.customerAddress??null)===(snapshot.customer.address??null);
}

/** Owner-only V2 persistence. Atomic with Document/items/counter/Outbox, never
 * updates an original or the fiscal status. Caller must supply verified owner
 * evidence and fresh authorization inside its Serializable transaction. */
export class CorrectionJournalRepository {
  constructor(private readonly notes:Pick<BetaSupplementCommandRepository,'reserveWithinTransaction'>){}
  async load(tx:Tx,original:FiscalDocumentSnapshot){
    const id=original.documentId;
    const source=await tx.document.findUnique({where:{id},select:{companyId:true,emissionPointId:true,type:true,status:true,sunatStatus:true,series:true,number:true,fullNumber:true,currencyCode:true,immutableSnapshot:true,taxableAmount:true,igvAmount:true,payableAmount:true,unaffectedAmount:true,issueDate:true,operationTypeCode:true,customerIdentityType:true,customerIdentityNumber:true,customerLegalName:true,customerAddress:true}});
    check(source&&source.companyId===original.companyId&&source.type===(original.documentTypeCode==='01'?'INVOICE':'SALES_RECEIPT')&&source.status==='ISSUED'&&['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(source.sunatStatus)&&source.series===original.series&&String(source.number)===original.number&&source.fullNumber===original.fullNumber&&source.currencyCode===original.currencyCode&&same(source.immutableSnapshot,original)&&
      physicalIdentity(source,original)&&parseDecimal(String(source.unaffectedAmount),2)===parseDecimal('0.00',2)&&(['taxableAmount','igvAmount','payableAmount'] as const).every(k=>parseDecimal(String(source[k]),2)===parseDecimal(original.totals[k],2)),'OWN_ORIGINAL_INCONSISTENT');
    const heads=await tx.$queryRawUnsafe<Head[]>('SELECT "originalDocumentId","originalSha256","revision","headSha256","candidateOnly" FROM "B2bCorrectionJournalHead" WHERE "originalDocumentId"=$1::uuid FOR UPDATE',id);
    const rows=await tx.$queryRawUnsafe<Row[]>('SELECT "revision","operationId","kind","event","versionSha256" FROM "B2bCorrectionJournalEvent" WHERE "originalDocumentId"=$1::uuid ORDER BY "revision" LIMIT 201',id);
    check(rows.length<=200,'JOURNAL_HISTORY_LIMIT');
    const events=rows.map(r=>r.event),projection=projectCorrectionJournal(original,events),head=heads[0];
    check(heads.length<=1&&Boolean(head)===Boolean(rows.length),'JOURNAL_HEAD_MISSING');
    if(head)check(head.candidateOnly&&head.originalSha256===projection.originalSha256&&head.revision===projection.revision&&head.headSha256===projection.headSha256,'JOURNAL_HEAD_INCONSISTENT');
    for(const [i,row]of rows.entries()){
      const event=row.event,operation=event.kind==='RESERVE'?event.command.payload.operationId:event.operationId;
      check(row.revision===i+1&&row.operationId===operation&&row.kind===event.kind&&row.versionSha256===projection.versions[i+1]?.sha256,'JOURNAL_EVENT_INCONSISTENT');
    }
    // Never silently adopt another ledger, a batch replacement, legacy notes,
    // or the synthetic hold profile as an available enterprise balance.
    check(!await tx.financialLedgerStream.findUnique({where:{documentId:id},select:{documentId:true}}),'V1_LEDGER_REQUIRES_RECONCILIATION');
    const legacy=await tx.$queryRawUnsafe<{name:string|null}[]>('SELECT to_regclass(\'"B2bCorrectionHoldHead"\')::text AS name');
    if(legacy[0]?.name)check(!(await tx.$queryRawUnsafe<{id:string}[]>('SELECT "originalDocumentId" AS id FROM "B2bCorrectionHoldHead" WHERE "originalDocumentId"=$1::uuid',id)).length,'SYNTHETIC_HOLDS_REQUIRE_RECONCILIATION');
    check(!await tx.dailySummaryItem.findFirst({where:{documentId:id},select:{id:true}}),'BATCH_HISTORY_REQUIRES_RECONCILIATION');
    const reserves=events.filter((e):e is Extract<CorrectionJournalEvent,{kind:'RESERVE'}>=>e.kind==='RESERVE');
    const notes=await tx.document.findMany({where:{companyId:original.companyId,type:{in:['CREDIT_NOTE','DEBIT_NOTE']},OR:[
      {referencesFrom:{some:{targetDocumentId:id}}},{immutableSnapshot:{path:['reference','documentId'],equals:id}},
      {referencesFrom:{some:{targetDocumentId:null,targetTypeCode:original.documentTypeCode,targetSeries:original.series,targetNumber:BigInt(original.number)}}}]},
      select:{id:true,companyId:true,emissionPointId:true,type:true,status:true,series:true,number:true,fullNumber:true,currencyCode:true,payableAmount:true,taxableAmount:true,igvAmount:true,unaffectedAmount:true,immutableSnapshot:true,createdByActor:true,createdByUserId:true,issueDate:true,operationTypeCode:true,customerIdentityType:true,customerIdentityNumber:true,customerLegalName:true,customerAddress:true},take:101});
    check(notes.length===reserves.length,'UNRECONCILED_NOTE_HISTORY');
    for(const e of reserves){
      const c=validateFiscalSupplementCommand(e.command),n=notes.find(n=>n.id===c.payload.operationId);
      check(c.payload.envelope.kind==='NOTE'&&n&&same(n.immutableSnapshot,c.payload.envelope.kind==='NOTE'?c.payload.envelope.note:null),'JOURNAL_NOTE_INCONSISTENT');
      if(c.payload.envelope.kind!=='NOTE'||!n)throw new Error('JOURNAL_NOTE_INCONSISTENT');const note=c.payload.envelope.note;
      check(n.companyId===original.companyId&&n.emissionPointId===source!.emissionPointId&&n.status==='ISSUED'&&n.type===(note.documentTypeCode==='07'?'CREDIT_NOTE':'DEBIT_NOTE')&&n.series===note.series&&String(n.number)===note.number&&n.fullNumber===note.fullNumber&&n.currencyCode===note.currencyCode&&
        physicalIdentity(n,note)&&(['taxableAmount','unaffectedAmount','igvAmount','payableAmount'] as const).every(k=>parseDecimal(String(n[k]),2)===parseDecimal(note.totals[k],2)),'JOURNAL_NOTE_PHYSICAL_MISMATCH');
      const events=await tx.outboxEvent.findMany({where:{id:c.eventId,aggregateId:c.payload.operationId,eventType:c.eventName},select:{payload:true},take:2});
      check(events.length===1&&same(events[0].payload,c),'JOURNAL_COMMAND_INCONSISTENT');
      const provenance=n?.createdByActor as SupplementActor['b2b'];
      try{
        check(provenance,'JOURNAL_ACTOR_INCONSISTENT');
        const creator=supplementActor({userId:n.createdByUserId,b2b:provenance,scope:{kind:'ASSIGNED',branchIds:[],emissionPointIds:[],series:[]}});
        check(fiscalSnapshotSha256(supplementActorIdentity(creator))===e.actorSha256,'JOURNAL_ACTOR_INCONSISTENT');
      }catch{throw new Error('JOURNAL_ACTOR_INCONSISTENT');}
    }
    return {events,projection};
  }
  private async append(tx:Tx,original:FiscalDocumentSnapshot,event:CorrectionJournalEvent,actor:SupplementActor,loaded:Awaited<ReturnType<CorrectionJournalRepository['load']>>){
    const projection=projectCorrectionJournal(original,[...loaded.events,event]),previous=loaded.projection;
    check(projection.revision===previous.revision+1&&projection.versions[previous.revision]?.sha256===previous.headSha256,'JOURNAL_PREFIX_CHANGED');
    if(previous.revision===0)await tx.$executeRawUnsafe('INSERT INTO "B2bCorrectionJournalHead" ("originalDocumentId","originalSha256","revision","headSha256") VALUES ($1::uuid,$2,$3,$4)',original.documentId,projection.originalSha256,projection.revision,projection.headSha256);
    else check(await tx.$executeRawUnsafe('UPDATE "B2bCorrectionJournalHead" SET "revision"=$2,"headSha256"=$3 WHERE "originalDocumentId"=$1::uuid AND "revision"=$4 AND "headSha256"=$5',original.documentId,projection.revision,projection.headSha256,previous.revision,previous.headSha256)===1,'JOURNAL_HEAD_CAS_FAILED');
    const operationId=event.kind==='RESERVE'?event.command.payload.operationId:event.operationId;
    await tx.$executeRawUnsafe('INSERT INTO "B2bCorrectionJournalEvent" ("originalDocumentId","revision","operationId","kind","event","versionSha256","actor") VALUES ($1::uuid,$2,$3::uuid,$4,$5::jsonb,$6,$7::jsonb)',original.documentId,projection.revision,operationId,event.kind,JSON.stringify(event),projection.headSha256,JSON.stringify(actor));
    const reserved=event.kind==='RESERVE'?event.command:loaded.events.find((v):v is Extract<CorrectionJournalEvent,{kind:'RESERVE'}>=>v.kind==='RESERVE'&&v.command.payload.operationId===operationId)?.command;
    if(!reserved)throw new Error('OWN_RESERVED_COMMAND_REQUIRED');return this.view(projection,operationId,false,reserved);
  }
  view(projection:ReturnType<typeof projectCorrectionJournal>,operationId:string,deduplicated:boolean,command:FiscalSupplementCommand){
    const operation=projection.operations.find(o=>o.operationId===operationId);check(operation,'CORRECTION_OPERATION_NOT_FOUND');
    const e=command.payload.envelope;if(e.kind!=='NOTE'||command.payload.operationId!==operationId||operation?.commandSha256!==fiscalSnapshotSha256(command))throw new Error('OWN_RESERVED_COMMAND_REQUIRED');
    const n=e.note;
    return {...operation,originalDocumentId:n.reference.documentId,document:{id:n.documentId,typeCode:n.documentTypeCode,series:n.series,number:n.number,fullNumber:n.fullNumber,issueDate:n.issueDate,currency:n.currencyCode,
      issuer:n.issuer,customer:n.customer,reference:n.reference,reason:{code:n.reasonCode,description:n.reasonDescription},items:n.lines,totals:n.totals},revision:projection.revision,headSha256:projection.headSha256,
      creditHeld:projection.creditHeld,debitHeld:projection.debitHeld,netAmount:projection.netAmount,deduplicated,candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const};
  }
  async reserve(tx:Tx,command:FiscalSupplementCommand,actor:SupplementActor,receipt?:CorrectionRequestReceipt){
    const e=command.payload.envelope;check(e.kind==='NOTE','NOTE_PROFILE_REQUIRED');if(e.kind!=='NOTE')throw new Error('NOTE_PROFILE_REQUIRED');
    const loaded=await this.load(tx,e.context.original),actorSha256=fiscalSnapshotSha256(supplementActorIdentity(actor));
    if(receipt)check([receipt.keySha256,receipt.requestSha256,receipt.externalSha256,receipt.actorIdentitySha256].every(v=>SHA.test(v))&&receipt.actorIdentitySha256===actorSha256,'INVALID_REQUEST_RECEIPT');
    const prior=loaded.projection.operations.find(o=>o.operationId===command.payload.operationId);
    if(prior){
      check(prior.actorSha256===actorSha256,'CORRECTION_REPLAY_CONFLICT');
      if(receipt){const stored=await tx.$queryRawUnsafe<any[]>('SELECT "keySha256","requestSha256","externalSha256","binding","actorIdentitySha256","operationId" FROM "B2bCorrectionRequestReceipt" WHERE "keySha256"=$1',receipt.keySha256);
        const row=stored[0];check(stored.length===1&&row.operationId===command.payload.operationId&&same({keySha256:row.keySha256,requestSha256:row.requestSha256,externalSha256:row.externalSha256,binding:row.binding,actorIdentitySha256:row.actorIdentitySha256},receipt),'REQUEST_REPLAY_CONFLICT');}
      else check(prior.commandSha256===fiscalSnapshotSha256(command),'CORRECTION_REPLAY_CONFLICT');
      const saved=loaded.events.find((v):v is Extract<CorrectionJournalEvent,{kind:'RESERVE'}>=>v.kind==='RESERVE'&&v.command.payload.operationId===command.payload.operationId);
      check(saved,'JOURNAL_REPLAY_INCONSISTENT');
      const replay=await this.notes.reserveWithinTransaction(tx,saved!.command,actor);check(replay.deduplicated,'JOURNAL_REPLAY_INCONSISTENT');return this.view(loaded.projection,command.payload.operationId,true,saved!.command);
    }
    // Pure validation BEFORE any numbering, then again in append.
    const event:CorrectionJournalEvent={kind:'RESERVE',command,actorSha256};projectCorrectionJournal(e.context.original,[...loaded.events,event]);
    const result=await this.notes.reserveWithinTransaction(tx,command,actor);check(!result.deduplicated,'ORPHAN_NOTE_RESERVATION');
    const view=await this.append(tx,e.context.original,event,actor,loaded);
    if(receipt)await tx.$executeRawUnsafe('INSERT INTO "B2bCorrectionRequestReceipt" ("keySha256","requestSha256","externalSha256","operationId","binding","actorIdentitySha256") VALUES ($1,$2,$3,$4::uuid,$5::jsonb,$6)',receipt.keySha256,receipt.requestSha256,receipt.externalSha256,command.payload.operationId,JSON.stringify(receipt.binding),receipt.actorIdentitySha256);
    return view;
  }
  async settle(tx:Tx,command:FiscalSupplementCommand,evidence:Extract<CorrectionJournalEvent,{kind:'SETTLE'}>['evidence'],actor:SupplementActor){
    const e=command.payload.envelope;if(e.kind!=='NOTE')throw new Error('NOTE_PROFILE_REQUIRED');const loaded=await this.load(tx,e.context.original);
    const own=loaded.events.find(v=>v.kind==='RESERVE'&&v.command.payload.operationId===command.payload.operationId);
    check(own?.kind==='RESERVE'&&same(own.command,command),'OWN_RESERVED_COMMAND_REQUIRED');
    const prior=loaded.events.find(v=>v.kind==='SETTLE'&&v.operationId===command.payload.operationId);
    if(prior){check(prior.kind==='SETTLE'&&same(prior.evidence,evidence),'SETTLEMENT_REPLAY_CONFLICT');return this.view(loaded.projection,command.payload.operationId,true,command);}
    return this.append(tx,e.context.original,{kind:'SETTLE',operationId:command.payload.operationId,evidence},actor,loaded);
  }
}
