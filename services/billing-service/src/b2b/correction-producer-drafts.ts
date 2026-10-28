import {B2bSecurityError,b2bCorrectionBindingKey,type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import {allowsResource,type FiscalDocumentSnapshot} from '@factuez/contracts';
import {buildFiscalNoteSnapshot,fiscalSnapshotSha256,validateFiscalOriginal,type FiscalAcceptanceEvidence,type FiscalNoteContext,type FiscalNoteSnapshot} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson,buildFiscalSupplementCommand,validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {PrismaService} from '../infrastructure/prisma.service';
import {supplementActorIdentity,type SupplementActor} from '../application/supplement-actor';
import type {CorrectionRequestReceipt} from '../application/correction-journal.repository';
import type {FinancialOutcomePort} from '../application/verified-financial-commit';
import type {B2bCorrectionCreateRequest,B2bCorrectionProducerDrafts} from './correction-producer';

type Plan={receipt:CorrectionRequestReceipt;binding:B2bCorrectionBinding;command:FiscalSupplementCommand};
const same=(a:unknown,b:unknown)=>fiscalSnapshotSha256(a)===fiscalSnapshotSha256(b);
function fail(status:number,code:string):never{throw new B2bSecurityError(status,code);}
function uuid(hash:string){return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;}

/** Frozen creation dependencies, not issueDate/UUID sorting, define the fiscal
 * validator's prefix. Equal dates may have reverse lexical UUID order. No
 * snapshots/creditHistoryIds are rewritten to make an inconsistent chain fit. */
export function orderCorrectionCreditHistory(entries:FiscalNoteContext['creditHistory']['entries']){
  const remaining=[...entries],ordered:FiscalNoteContext['creditHistory']['entries']=[],ids:string[]=[];
  if(remaining.length>100||new Set(remaining.map(e=>e.note.documentId)).size!==remaining.length)fail(409,'CORRECTION_HISTORY_DEPENDENCY_CONFLICT');
  while(remaining.length){
    const candidates=remaining.filter(e=>Array.isArray(e.note.creditHistoryIds)&&e.note.creditHistoryIds.length===ids.length&&e.note.creditHistoryIds.every((id,i)=>id===ids[i]));
    if(candidates.length!==1)fail(409,'CORRECTION_HISTORY_DEPENDENCY_CONFLICT');
    const next=candidates[0];ordered.push(next);ids.push(next.note.documentId);remaining.splice(remaining.indexOf(next),1);
  }
  return ordered;
}

/** Per-request owner adapter. Preparation is read-only. The receipt is written
 * by the journal in the SAME transaction as numbering/Document/Outbox, not here.
 * No complete fiscal snapshot, number or evidence is accepted from the caller. */
export class PrismaCorrectionProducerDrafts implements B2bCorrectionProducerDrafts {
  private readonly plans=new Map<string,Plan>();
  constructor(private readonly db:PrismaService,private readonly evidence:Pick<FinancialOutcomePort,'original'|'ownsOriginal'>,private readonly now=()=>new Date().toISOString()){}
  private receipt(request:B2bCorrectionCreateRequest,actor:SupplementActor):CorrectionRequestReceipt{
    if(!actor.b2b)fail(403,'B2B_ACTOR_REQUIRED');const identity=supplementActorIdentity(actor);
    return {keySha256:fiscalSnapshotSha256({identity,binding:request.binding,key:request.idempotencyKey}),requestSha256:fiscalSnapshotSha256(request),
      externalSha256:fiscalSnapshotSha256({clientId:actor.b2b.clientId,issuerId:request.binding.reference.issuerId,externalReference:request.externalReference}),
      binding:request.binding,actorIdentitySha256:fiscalSnapshotSha256(identity)};
  }
  receiptFor(command:FiscalSupplementCommand){
    const plan=this.plans.get(command.payload.operationId);if(!plan||!same(plan.command,command))fail(409,'OWN_PREPARED_COMMAND_REQUIRED');return plan.receipt;
  }
  private async persisted(operationId:string,binding:B2bCorrectionBinding,actor:SupplementActor){
    const rows=await this.db.$queryRawUnsafe<any[]>('SELECT "keySha256","requestSha256","externalSha256","operationId","binding","actorIdentitySha256" FROM "B2bCorrectionRequestReceipt" WHERE "operationId"=$1::uuid AND "binding"=$2::jsonb AND "actorIdentitySha256"=$3',operationId,JSON.stringify(binding),fiscalSnapshotSha256(supplementActorIdentity(actor)));
    if(rows.length!==1)fail(404,'CORRECTION_OPERATION_NOT_FOUND');return rows[0];
  }
  async operation(binding:B2bCorrectionBinding,operationId:string,actor:SupplementActor){
    const plan=this.plans.get(operationId);
    if(plan&&b2bCorrectionBindingKey(plan.binding)===b2bCorrectionBindingKey(binding)&&plan.receipt.actorIdentitySha256===fiscalSnapshotSha256(supplementActorIdentity(actor)))return;
    await this.persisted(operationId,binding,actor);
  }
  async replay(request:B2bCorrectionCreateRequest,actor:SupplementActor){
    const receipt=this.receipt(request,actor),rows=await this.db.$queryRawUnsafe<any[]>('SELECT "operationId","keySha256","requestSha256","externalSha256","binding","actorIdentitySha256" FROM "B2bCorrectionRequestReceipt" WHERE "keySha256"=$1 OR "externalSha256"=$2',receipt.keySha256,receipt.externalSha256);
    if(!rows.length)return null;
    if(rows.length!==1)fail(409,'CORRECTION_REQUEST_CONFLICT');const row=rows[0],{operationId,...stored}=row;
    if(!same(stored,receipt))fail(409,'CORRECTION_REQUEST_CONFLICT');
    await this.persisted(operationId,request.binding,actor);
    const events=await this.db.outboxEvent.findMany({where:{aggregateId:operationId,eventType:'billing.beta.supplement.requested.v1'},select:{payload:true},take:2});
    if(events.length!==1)fail(409,'CORRECTION_COMMAND_MISSING');const command=validateFiscalSupplementCommand(events[0].payload);
    if(command.payload.operationId!==operationId)fail(409,'CORRECTION_COMMAND_INCONSISTENT');
    this.plans.set(operationId,{receipt,binding:request.binding,command});return command;
  }
  async prepare(request:B2bCorrectionCreateRequest,actor:SupplementActor){
    request=boundedSupplementJson(request) as B2bCorrectionCreateRequest;
    const prior=await this.replay(request,actor);if(prior)return prior;
    const b=request.binding,r=b.reference,asOf=this.now();
    if(r.environment!=='BETA'||r.documentType!=='01'||request.note.documentTypeCode!==b.noteType)fail(409,'CORRECTION_PROFILE_NOT_ENABLED');
    if(!allowsResource(actor.scope,r.branchId,r.pointId,r.seriesId)||!allowsResource(actor.scope,r.branchId,r.pointId,b.noteSeriesId))fail(403,'CORRECTION_SCOPE_DENIED');
    const series=await this.db.seriesCounter.findMany({where:{id:{in:[r.seriesId,b.noteSeriesId]},companyId:r.issuerId,emissionPointId:r.pointId,active:true,
      company:{active:true,ruc:r.issuerRuc,environment:'BETA'},emissionPoint:{active:true,branchId:r.branchId,branch:{companyId:r.issuerId,active:true}}},select:{id:true,series:true,nextNumber:true,documentType:true}});
    const reference=series.find(v=>v.id===r.seriesId),noteSeries=series.find(v=>v.id===b.noteSeriesId);
    if(series.length!==2||!reference||!noteSeries||reference.documentType!=='INVOICE'||noteSeries.documentType!==(b.noteType==='07'?'CREDIT_NOTE':'DEBIT_NOTE')||!/^F[A-Z0-9]{3}$/.test(noteSeries.series))fail(404,'CORRECTION_SERIES_NOT_FOUND');
    const row=await this.db.document.findFirst({where:{id:request.originalDocumentId,companyId:r.issuerId,seriesCounterId:r.seriesId,emissionPointId:r.pointId,status:'ISSUED',type:'INVOICE'},select:{immutableSnapshot:true}});
    if(!row)fail(404,'CORRECTION_ORIGINAL_NOT_FOUND');const original=boundedSupplementJson(row.immutableSnapshot) as FiscalDocumentSnapshot;
    validateFiscalOriginal(original,asOf);
    if(original.series!==reference.series||original.branchId!==r.branchId||original.companyId!==r.issuerId||original.issuer.identityNumber!==r.issuerRuc||original.documentId!==request.originalDocumentId)fail(409,'CORRECTION_ORIGINAL_INCONSISTENT');
    const proof=await this.evidence.original(original,asOf);
    if(!this.evidence.ownsOriginal(proof)||proof.evidence.snapshotSha256!==fiscalSnapshotSha256(original)||proof.evidence.documentId!==original.documentId)fail(409,'VERIFIED_ORIGINAL_REQUIRED');
    const credits=await this.db.document.findMany({where:{companyId:r.issuerId,type:'CREDIT_NOTE',OR:[{referencesFrom:{some:{targetDocumentId:original.documentId}}},
      {immutableSnapshot:{path:['reference','documentId'],equals:original.documentId}}]},select:{id:true,seriesCounterId:true,emissionPointId:true,immutableSnapshot:true,sunatStatus:true},orderBy:[{issueDate:'asc'},{id:'asc'}],take:101});
    if(credits.length>100)fail(409,'CORRECTION_HISTORY_LIMIT');
    const history:FiscalNoteContext['creditHistory']['entries']=credits.map(v=>{
      // A pair never grants arbitrary historical series. Additional grants must
      // be explicitly composed; fail before numbering instead of crossing scope.
      if(v.emissionPointId!==r.pointId||v.seriesCounterId!==b.noteSeriesId||b.noteType!=='07')fail(409,'CROSS_SERIES_HISTORY_PROFILE_NOT_ENABLED');
      if(v.sunatStatus==='REJECTED')fail(409,'REJECTED_CREDIT_REQUIRES_RECONCILIATION');
      return {note:boundedSupplementJson(v.immutableSnapshot) as FiscalNoteSnapshot,state:['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(v.sunatStatus)?'ACCEPTED':'RESERVED'};
    });
    const context:FiscalNoteContext={original,acceptance:proof.evidence as FiscalAcceptanceEvidence,asOf,creditHistory:{complete:true,entries:orderCorrectionCreditHistory(history)}};
    const receipt=this.receipt(request,actor),operationId=uuid(receipt.keySha256);
    const note=buildFiscalNoteSnapshot(context,request.note,{documentId:operationId,series:noteSeries.series,number:String(noteSeries.nextNumber),issueDate:request.issueDate});
    const command=buildFiscalSupplementCommand({kind:'NOTE',note,context},{eventId:uuid(fiscalSnapshotSha256({key:receipt.keySha256,kind:'event'})),correlationId:uuid(fiscalSnapshotSha256({key:receipt.keySha256,kind:'correlation'})),occurredAt:asOf});
    this.plans.set(operationId,{receipt,binding:b,command});return command;
  }
}
