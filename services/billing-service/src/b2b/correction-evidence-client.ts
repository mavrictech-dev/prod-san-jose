import {randomUUID} from 'node:crypto';
import {B2bSecurityError,validB2bCorrectionBinding,type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceRequest,correctionEvidenceHash,correctionEvidenceFreeze,verifyCorrectionEvidenceResponse,type CorrectionEvidenceAction} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256,validateFiscalAcceptance,type FiscalAcceptanceEvidence} from '@factuez/sunat-core/dist/fiscal-note';
import type {FinancialOutcomePort} from '../application/verified-financial-commit';
import type {CorrectionOwnerEvidence} from '../application/verified-correction-transaction';

const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail():never{throw new B2bSecurityError(503,'INVALID_OWNER_EVIDENCE_RESPONSE');}
function exact(value:unknown,keys:string[]):asserts value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))fail();
}
function fence(value:unknown,original:boolean){
  if(!value||typeof value!=='object'||Array.isArray(value))fail();
  const v=value as Record<string,unknown>,fields=original?['ownerRecordSha256','ownerVersion','signedXmlSha256','requestZipSha256','cdrZipSha256','cdrXmlSha256']:['version','recordSha256','xmlSha256','requestSha256','cdrSha256'];
  if(fields.some(k=>typeof v[k]!=='string'||!SHA.test(v[k] as string))||original&&(typeof v.submissionId!=='string'||!UUID.test(v.submissionId)))fail();
}

/** Billing-local provenance is minted only AFTER a matching, fresh response over
 * the fixed mTLS owner transport. No remote WeakSet, shared database or PKI flag
 * supplied by an external consumer. Not registered in the active application. */
export class HttpBetaCorrectionEvidence {
  private readonly binding:B2bCorrectionBinding;
  private readonly originals=new WeakSet<object>();private readonly prerequisitesSeals=new WeakSet<object>();private readonly outcomes=new WeakSet<object>();
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'>,private readonly token:()=>Promise<string>,private readonly kind:'SERVICE'|'USER',binding:B2bCorrectionBinding,
    private readonly commands:{load(id:string):Promise<FiscalSupplementCommand>}|null=null,private readonly now=()=>new Date().toISOString()){
    if(!validB2bCorrectionBinding(binding)||!['SERVICE','USER'].includes(kind))throw new Error('Explicit correction binding required');
    this.binding=correctionEvidenceFreeze(structuredClone(binding));
  }
  private async exchange(action:CorrectionEvidenceAction,payload:unknown,asOf:string){
    const request=correctionEvidenceRequest({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:randomUUID(),kind:this.kind,action,binding:this.binding,asOf,payload});
    const response=verifyCorrectionEvidenceResponse(await this.http.post('/internal/b2b/correction-evidence',request,await this.token()),request,this.now());
    return {result:response.result,authoritySha256:response.authoritySha256};
  }
  private commandShape(value:unknown){
    const c=validateFiscalSupplementCommand(value),r=this.binding.reference,e=c.payload.envelope;
    if(e.kind!=='NOTE')throw new B2bSecurityError(409,'BATCH_AUTHORITY_NOT_AVAILABLE');
    if(c.payload.companyId!==r.issuerId||c.payload.branchId!==r.branchId||c.payload.issuerRuc!==r.issuerRuc||e.context.original.documentTypeCode!==r.documentType||e.note.documentTypeCode!==this.binding.noteType)throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
    return c;
  }
  async original(snapshot:FiscalDocumentSnapshot,asOf:string){
    const {result,authoritySha256}=await this.exchange('ORIGINAL',snapshot,asOf);exact(result,['evidence','fence']);
    try{validateFiscalAcceptance(snapshot,result.evidence as FiscalAcceptanceEvidence,asOf);fence(result.fence,true);}catch{fail();}
    const proof=correctionEvidenceFreeze({evidence:result.evidence as FiscalAcceptanceEvidence,fence:{owner:result.fence,authoritySha256}});
    this.originals.add(proof);return proof;
  }
  ownsOriginal(value:unknown){return !!value&&typeof value==='object'&&this.originals.has(value);}
  async prerequisites(value:unknown,asOf:string){
    const command=this.commandShape(value),{result,authoritySha256}=await this.exchange('PREREQUISITES',command,asOf);exact(result,['commandSha256','evidenceSha256']);
    if(result.commandSha256!==fiscalSnapshotSha256(command)||typeof result.evidenceSha256!=='string'||!SHA.test(result.evidenceSha256))fail();
    const proof=correctionEvidenceFreeze({commandSha256:result.commandSha256 as string,evidenceSha256:correctionEvidenceHash({owner:result.evidenceSha256,authoritySha256})});
    this.prerequisitesSeals.add(proof);return proof;
  }
  ownsPrerequisites(value:unknown){return !!value&&typeof value==='object'&&this.prerequisitesSeals.has(value);}
  async verify(value:unknown,asOf:string){
    const command=this.commandShape(value),{result,authoritySha256}=await this.exchange('OUTCOME',command,asOf);exact(result,['commandSha256','operationId','evidence','fence']);
    if(result.commandSha256!==fiscalSnapshotSha256(command)||result.operationId!==command.payload.operationId)fail();
    exact(result.evidence,['status','cdrSignatureVerified','officialCdr','cdrSha256','requestSha256','responseCode','acceptedAt']);
    const e=result.evidence;
    if(!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED'].includes(String(e.status))||e.cdrSignatureVerified!==true||e.officialCdr!==true||
      typeof e.cdrSha256!=='string'||!SHA.test(e.cdrSha256)||typeof e.requestSha256!=='string'||!SHA.test(e.requestSha256)||typeof e.responseCode!=='string'||!/^\d{1,8}$/.test(e.responseCode)||
      (e.status==='REJECTED')!==(e.responseCode!=='0')||typeof e.acceptedAt!=='string'||!Number.isFinite(Date.parse(e.acceptedAt))||Date.parse(e.acceptedAt)<Date.parse(command.occurredAt)||Date.parse(e.acceptedAt)>Date.parse(asOf))fail();
    fence(result.fence,false);
    const proof=correctionEvidenceFreeze({commandSha256:result.commandSha256 as string,operationId:result.operationId as string,evidence:e,fence:{owner:result.fence,authoritySha256}});
    this.outcomes.add(proof);return proof;
  }
  owns(value:unknown){return !!value&&typeof value==='object'&&this.outcomes.has(value);}
  correctionEvidence():CorrectionOwnerEvidence{return{verify:(command,asOf)=>this.prerequisites(command,asOf),owns:value=>this.ownsPrerequisites(value)};}
  financialEvidence():FinancialOutcomePort{
    if(!this.commands)throw new Error('Billing-owned command reader required');const commands=this.commands;
    return{command:async id=>{const command=this.commandShape(await commands.load(id));if(command.payload.operationId!==id)fail();return command;},
      verify:this.verify.bind(this),owns:this.owns.bind(this),original:this.original.bind(this),ownsOriginal:this.ownsOriginal.bind(this),
      prerequisites:this.prerequisites.bind(this),ownsPrerequisites:this.ownsPrerequisites.bind(this)};
  }
}
