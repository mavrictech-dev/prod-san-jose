import {randomUUID} from 'node:crypto';
import {B2bSecurityError,validB2bCorrectionBinding,type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceRequest,correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {BillingB2bCorrectionAuthorization} from './correction-authorization';
import {PrismaCorrectionEvidenceScope} from './correction-evidence-authority';
import {HttpBetaCorrectionEvidence} from './correction-evidence-client';

/** Billing-owned operation lookup; authorizes before reading and before return.
 * Full commands remain private, never supplied by the external API consumer. */
export class BillingCorrectionEvidenceCommandReader {
  private readonly binding:B2bCorrectionBinding;
  constructor(private readonly db:PrismaService,private readonly authority:Pick<BillingB2bCorrectionAuthorization,'current'>,
    private readonly token:()=>Promise<string>,private readonly kind:'SERVICE'|'USER',binding:B2bCorrectionBinding,private readonly now=()=>new Date().toISOString()){
    if(!validB2bCorrectionBinding(binding))throw new Error('Explicit correction binding required');this.binding=correctionEvidenceFreeze(binding);
  }
  async load(operationId:string):Promise<FiscalSupplementCommand>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId))throw new B2bSecurityError(400,'INVALID_OPERATION_ID');
    const token=await this.token(),first=await this.authority.current(token,this.kind,this.binding);
    const read=async()=>{
      const rows=await this.db.outboxEvent.findMany({where:{aggregateId:operationId,eventType:'billing.beta.supplement.requested.v1',
        AND:[{payload:{path:['payload','companyId'],equals:this.binding.reference.issuerId}},{payload:{path:['payload','issuerRuc'],equals:this.binding.reference.issuerRuc}}]},take:2,select:{id:true,payload:true}});
      if(rows.length!==1)throw new B2bSecurityError(404,'CORRECTION_OPERATION_NOT_FOUND');
      const command=validateFiscalSupplementCommand(rows[0].payload);
      if(command.eventId!==rows[0].id||command.payload.operationId!==operationId)throw new B2bSecurityError(409,'CORRECTION_OPERATION_INCONSISTENT');return command;
    };
    const command=await read(),scope=new PrismaCorrectionEvidenceScope(this.db),request=correctionEvidenceRequest({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:randomUUID(),kind:this.kind,
      action:'OUTCOME',binding:this.binding,asOf:this.now(),payload:command});
    const initial=await scope.inspect(request,first.actor),fresh=await this.authority.current(token,this.kind,this.binding);
    if(fiscalSnapshotSha256(first)!==fiscalSnapshotSha256(fresh)||initial!==await scope.inspect(request,fresh.actor)||fiscalSnapshotSha256(command)!==fiscalSnapshotSha256(await read()))throw new B2bSecurityError(409,'CORRECTION_AUTHORITY_CHANGED');
    return correctionEvidenceFreeze(command);
  }
}

/** Owner-local assembly: Billing Prisma stays in Billing. SUNAT is ONLY an
 * authenticated HTTPS peer. Does not register a producer, allocate or transmit. */
export function createBillingCorrectionEvidencePorts(db:PrismaService,authorization:Pick<BillingB2bCorrectionAuthorization,'current'>,
  sunat:Pick<B2bPrivateHttp,'post'>,token:()=>Promise<string>,kind:'SERVICE'|'USER',binding:B2bCorrectionBinding,now=()=>new Date().toISOString()){
  if(!validB2bCorrectionBinding(binding))throw new Error('Explicit correction binding required');binding=correctionEvidenceFreeze(binding);
  const commands=new BillingCorrectionEvidenceCommandReader(db,authorization,token,kind,binding,now),scope=new PrismaCorrectionEvidenceScope(db);
  const client=new HttpBetaCorrectionEvidence(sunat,token,kind,binding,commands,now);
  return Object.freeze({reservationEvidence:client.correctionEvidence(),financialEvidence:client.financialEvidence(),
    commandAuthority:{current:async(input:FiscalSupplementCommand)=>{
      const command=validateFiscalSupplementCommand(input),credential=await token(),current=await authorization.current(credential,kind,binding);
      const request=correctionEvidenceRequest({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:randomUUID(),kind,action:'PREREQUISITES',binding,asOf:now(),payload:command});
      await scope.inspect(request,current.actor);return current.actor;
    }},
    financialAuthority:{current:async()=> (await authorization.current(await token(),kind,binding)).actor},
    candidateOnly:true as const,fiscalExecutionEnabled:false as const,transmissionAuthorized:false as const});
}
