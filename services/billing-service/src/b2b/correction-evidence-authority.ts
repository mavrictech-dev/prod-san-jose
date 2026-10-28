import {B2bSecurityError, type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
import {allowsResource} from '@factuez/contracts';
import {correctionEvidenceRequest,correctionEvidenceHash,correctionEvidenceResponse,type CorrectionEvidenceRequest} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {validateFiscalOriginal,fiscalSnapshotSha256,type FiscalNoteSnapshot} from '@factuez/sunat-core/dist/fiscal-note';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {BillingB2bCorrectionAuthorization} from './correction-authorization';
import type {SupplementActor} from '../application/supplement-actor';

function deny():never{throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');}
export function correctionEvidenceFresh(asOf:string,now:string){
  const age=Date.parse(now)-Date.parse(asOf);
  if(!Number.isFinite(age)||age< -2000||age>30000)throw new B2bSecurityError(409,'EVIDENCE_REQUEST_EXPIRED');
}
export interface CorrectionEvidenceScope {inspect(request:CorrectionEvidenceRequest,actor:SupplementActor):Promise<string>}

/** Read-only Billing owner callback. Identity verifies the paired grant afresh;
 * own rows verify the concrete snapshots, labels and operation, not just IDs. */
export class BillingCorrectionEvidenceAuthority {
  constructor(private readonly authority:Pick<BillingB2bCorrectionAuthorization,'current'>,private readonly scope:CorrectionEvidenceScope,
    private readonly now=()=>new Date().toISOString()){}
  async authorize(token:string,value:unknown){
    const request=correctionEvidenceRequest(value);correctionEvidenceFresh(request.asOf,this.now());
    const first=await this.authority.current(token,request.kind,request.binding);
    const stamp=correctionEvidenceHash(first),scope=await this.scope.inspect(request,first.actor);
    const fresh=await this.authority.current(token,request.kind,request.binding);
    if(stamp!==correctionEvidenceHash(fresh)||scope!==await this.scope.inspect(request,fresh.actor))throw new B2bSecurityError(409,'CORRECTION_AUTHORITY_CHANGED');
    const now=this.now();correctionEvidenceFresh(request.asOf,now);
    return correctionEvidenceResponse(request,correctionEvidenceHash({authority:stamp,scope}),{authorized:true},now);
  }
}

/** No credentials, writes, counter allocation, Outbox publication or shared DB. */
export class PrismaCorrectionEvidenceScope implements CorrectionEvidenceScope {
  constructor(private readonly db:PrismaService){}
  async inspect(request:CorrectionEvidenceRequest,actor:SupplementActor){
    const binding=request.binding,r=binding.reference;
    const series=await this.db.seriesCounter.findMany({where:{id:{in:[r.seriesId,binding.noteSeriesId]},companyId:r.issuerId,emissionPointId:r.pointId,active:true,
      company:{ruc:r.issuerRuc,environment:'BETA',active:true},emissionPoint:{branchId:r.branchId,active:true,branch:{companyId:r.issuerId,active:true}}},
      select:{id:true,series:true,documentType:true,emissionPoint:{select:{code:true}}}});
    const originalSeries=series.find(s=>s.id===r.seriesId),noteSeries=series.find(s=>s.id===binding.noteSeriesId);
    if(series.length!==2||!originalSeries||!noteSeries||originalSeries.documentType!==(r.documentType==='01'?'INVOICE':'SALES_RECEIPT')||noteSeries.documentType!==(binding.noteType==='07'?'CREDIT_NOTE':'DEBIT_NOTE'))deny();
    if(!originalSeries||!noteSeries)deny();
    const family=r.documentType==='01'?'F':'B';if(!originalSeries.series.startsWith(family)||!noteSeries.series.startsWith(family))deny();
    const marks:unknown[]=[];
    const own=async(snapshot:FiscalDocumentSnapshot|FiscalNoteSnapshot,seriesId:string)=>{
      if(snapshot.environment!=='BETA'||snapshot.companyId!==r.issuerId||snapshot.branchId!==r.branchId||snapshot.issuer.identityNumber!==r.issuerRuc||snapshot.issuer.establishmentCode!==originalSeries.emissionPoint.code||!allowsResource(actor.scope,r.branchId,r.pointId,seriesId))deny();
      const row=await this.db.document.findFirst({where:{id:snapshot.documentId,companyId:r.issuerId,emissionPointId:r.pointId,seriesCounterId:seriesId,status:'ISSUED'},
        select:{id:true,type:true,series:true,number:true,fullNumber:true,immutableSnapshot:true,updatedAt:true}});
      const types={'01':'INVOICE','03':'SALES_RECEIPT','07':'CREDIT_NOTE','08':'DEBIT_NOTE'} as const;
      if(!row||row.type!==types[snapshot.documentTypeCode as keyof typeof types]||row.series!==snapshot.series||String(row.number)!==snapshot.number||row.fullNumber!==snapshot.fullNumber||fiscalSnapshotSha256(row.immutableSnapshot)!==fiscalSnapshotSha256(snapshot))deny();
      marks.push({id:row!.id,seriesId,snapshotSha256:fiscalSnapshotSha256(snapshot),updatedAt:row!.updatedAt.toISOString()});
    };
    let command:FiscalSupplementCommand|undefined;
    let original:FiscalDocumentSnapshot;
    if(request.action==='ORIGINAL'){
      original=request.payload as FiscalDocumentSnapshot;
      try{validateFiscalOriginal(original,request.asOf);}catch{throw new B2bSecurityError(400,'INVALID_CORRECTION_SNAPSHOT');}
    }else{
      try{command=validateFiscalSupplementCommand(request.payload);}catch{throw new B2bSecurityError(400,'INVALID_CORRECTION_COMMAND');}
      if(command.payload.envelope.kind!=='NOTE')throw new B2bSecurityError(409,'BATCH_AUTHORITY_NOT_AVAILABLE');
      const envelope=command.payload.envelope;original=envelope.context.original;
      if(command.payload.companyId!==r.issuerId||command.payload.branchId!==r.branchId||command.payload.issuerRuc!==r.issuerRuc||envelope.note.documentTypeCode!==binding.noteType||envelope.note.series!==noteSeries.series)deny();
      // This narrow pair does not grant a Cartesian product of history series.
      // Cross-series history requires explicit additional grant composition.
      for(const entry of envelope.context.creditHistory.entries){
        if(binding.noteType!=='07'||entry.note.series!==noteSeries.series)deny();
        await own(entry.note,binding.noteSeriesId);
      }
      if(request.action==='OUTCOME'){
        await own(envelope.note,binding.noteSeriesId);
        const events=await this.db.outboxEvent.findMany({where:{aggregateId:command.payload.operationId,eventType:command.eventName},take:2,select:{id:true,payload:true}});
        if(events.length!==1||events[0].id!==command.eventId||fiscalSnapshotSha256(events[0].payload)!==fiscalSnapshotSha256(command))deny();
        marks.push({commandSha256:fiscalSnapshotSha256(command)});
      }
    }
    if(original.documentTypeCode!==r.documentType||original.series!==originalSeries.series)deny();
    await own(original,r.seriesId);
    return correctionEvidenceHash({binding,marks});
  }
}
