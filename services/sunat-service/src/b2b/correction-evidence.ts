import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceRequest,correctionEvidenceResponse,verifyCorrectionEvidenceResponse,type CorrectionEvidenceRequest} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {validateFiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {validateFiscalOriginal,fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
import type {createBetaCorrectionOwnerAssembly} from '../application/beta-correction-owner-assembly';
import {isBetaOwnerDocumentAcceptance} from '../application/beta-document-acceptance';
import {isBetaOwnerSummaryAcceptance} from '../application/beta-owner-summary-acceptance';
import {isBetaCorrectionEvidence} from '../application/beta-correction-evidence';
import {isBetaVerifiedSupplementOutcome} from '../application/beta-verified-supplement-outcome';
export interface CorrectionEvidenceAuthorityPort {authorize(token:string,request:CorrectionEvidenceRequest):Promise<string>}
function fresh(asOf:string,now:string){const age=Date.parse(now)-Date.parse(asOf);if(!Number.isFinite(age)||age< -2000||age>30000)throw new B2bSecurityError(409,'EVIDENCE_REQUEST_EXPIRED');}

/** SUNAT calls back to Billing, which reauthorizes via Identity and own rows.
 * No direct access to Billing's database or caller-supplied trust assertions. */
export class HttpCorrectionEvidenceAuthority implements CorrectionEvidenceAuthorityPort {
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'>,private readonly now=()=>new Date().toISOString()){}
  async authorize(token:string,request:CorrectionEvidenceRequest){
    const response=verifyCorrectionEvidenceResponse(await this.http.post('/internal/b2b/correction-evidence-authorize',request,token),request,this.now());
    const result=response.result;
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).join(',')!=='authorized'||(result as {authorized?:unknown}).authorized!==true)throw new B2bSecurityError(503,'INVALID_CORRECTION_AUTHORITY_RESPONSE');
    return response.authoritySha256;
  }
}

/** Private read-only evidence boundary. Does not stage, prepare, sign or send.
 * Owner-local proof capabilities are checked HERE, not serialized as authority. */
export class SunatCorrectionEvidence {
  constructor(private readonly owner:ReturnType<typeof createBetaCorrectionOwnerAssembly>,private readonly authority:CorrectionEvidenceAuthorityPort,
    private readonly now=()=>new Date().toISOString()){}
  async execute(token:string,input:unknown){
    const request=correctionEvidenceRequest(input),binding=request.binding,r=binding.reference;fresh(request.asOf,this.now());
    let snapshot:FiscalDocumentSnapshot|undefined;
    let command:ReturnType<typeof validateFiscalSupplementCommand>|undefined;
    try{
      if(request.action==='ORIGINAL'){snapshot=request.payload as FiscalDocumentSnapshot;validateFiscalOriginal(snapshot,request.asOf);}
      else{command=validateFiscalSupplementCommand(request.payload);
        if(command.payload.envelope.kind!=='NOTE')throw new B2bSecurityError(409,'BATCH_AUTHORITY_NOT_AVAILABLE');
        snapshot=command.payload.envelope.context.original;
        if(command.payload.envelope.note.documentTypeCode!==binding.noteType)throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
      }
    }catch(error){if(error instanceof B2bSecurityError)throw error;throw new B2bSecurityError(400,'INVALID_CORRECTION_EVIDENCE_REQUEST');}
    if(!snapshot||snapshot.environment!=='BETA'||snapshot.companyId!==r.issuerId||snapshot.branchId!==r.branchId||snapshot.issuer.identityNumber!==r.issuerRuc||snapshot.documentTypeCode!==r.documentType)throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
    const authorization=await this.authority.authorize(token,request);if(!/^[a-f0-9]{64}$/.test(authorization))throw new B2bSecurityError(503,'INVALID_CORRECTION_AUTHORITY_RESPONSE');let result:unknown;
    if(request.action==='ORIGINAL'){
      const proof=await this.owner.acceptance.verify(snapshot,request.asOf);
      if(!isBetaOwnerDocumentAcceptance(proof)&&!isBetaOwnerSummaryAcceptance(proof))throw new B2bSecurityError(503,'OWNER_EVIDENCE_PROVENANCE_REQUIRED');
      if(proof.evidence.documentId!==snapshot.documentId||proof.evidence.snapshotSha256!==fiscalSnapshotSha256(snapshot))throw new B2bSecurityError(503,'OWNER_EVIDENCE_BINDING_REQUIRED');
      result={evidence:proof.evidence,fence:proof.fence};
    }else if(request.action==='PREREQUISITES'){
      const proof=await this.owner.prerequisites.verify(command,request.asOf);
      if(!isBetaCorrectionEvidence(proof))throw new B2bSecurityError(503,'OWNER_EVIDENCE_PROVENANCE_REQUIRED');
      if(proof.commandSha256!==fiscalSnapshotSha256(command))throw new B2bSecurityError(503,'OWNER_EVIDENCE_BINDING_REQUIRED');
      result={commandSha256:proof.commandSha256,evidenceSha256:proof.evidenceSha256};
    }else{
      const proof=await this.owner.outcomes.verify(command,request.asOf);
      if(!isBetaVerifiedSupplementOutcome(proof))throw new B2bSecurityError(503,'OWNER_EVIDENCE_PROVENANCE_REQUIRED');
      if(proof.commandSha256!==fiscalSnapshotSha256(command)||proof.operationId!==command!.payload.operationId)throw new B2bSecurityError(503,'OWNER_EVIDENCE_BINDING_REQUIRED');
      result={commandSha256:proof.commandSha256,operationId:proof.operationId,evidence:proof.evidence,fence:proof.fence};
    }
    if(authorization!==await this.authority.authorize(token,request))throw new B2bSecurityError(409,'CORRECTION_AUTHORITY_CHANGED');
    const now=this.now();fresh(request.asOf,now);return correctionEvidenceResponse(request,authorization,result,now);
  }
}
