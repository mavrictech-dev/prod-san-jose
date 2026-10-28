import {validateFiscalSupplementCommand,boundedSupplementJson,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {BetaOwnerAcceptanceResolver} from './beta-owner-acceptance-resolver';
import {isBetaOwnerDocumentAcceptance} from './beta-document-acceptance';
import {isBetaOwnerSummaryAcceptance} from './beta-owner-summary-acceptance';
import type {BetaAcceptanceDocument} from './beta-document-acceptance';
import type {FiscalAcceptanceEvidence} from '@factuez/sunat-core/dist/fiscal-note';
const seals=new WeakSet<object>();
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
export const isBetaCorrectionEvidence=(v:unknown)=>!!v&&typeof v==='object'&&seals.has(v);
/** Server-side evidence bundle; no flags, external XML or caller-supplied acceptance shortcuts. */
export class BetaCorrectionEvidence {
  constructor(private readonly resolver:Pick<BetaOwnerAcceptanceResolver,'verify'>){}
  async verify(value:unknown,asOf:string){
    const command=freeze(validateFiscalSupplementCommand(value)),fingerprint=fiscalSnapshotSha256(command),contexts=command.payload.envelope.kind==='NOTE'?[command.payload.envelope.context]:
      command.payload.envelope.batch.input.entries.flatMap(e=>[...(e.document.noteContext?[e.document.noteContext]:[]),...('previous'in e&&e.previous?.document.noteContext?[e.previous.document.noteContext]:[])]);
    const requests=new Map<string,{snapshot:BetaAcceptanceDocument;acceptance?:FiscalAcceptanceEvidence}>();
    const add=(snapshot:BetaAcceptanceDocument,acceptance?:FiscalAcceptanceEvidence)=>{const key=snapshot.documentId,prior=requests.get(key);if(prior&&fiscalSnapshotSha256(prior.snapshot)!==fiscalSnapshotSha256(snapshot))throw new Error('CONFLICTING_EVIDENCE_VERSIONS');
      if(prior?.acceptance&&acceptance&&fiscalSnapshotSha256(prior.acceptance)!==fiscalSnapshotSha256(acceptance))throw new Error('CONFLICTING_ACCEPTANCE_VERSIONS');
      requests.set(key,{snapshot,...(acceptance?{acceptance}:{}),...(prior?.acceptance?{acceptance:prior.acceptance}:{})});};
    for(const c of contexts){add(c.original,c.acceptance);for(const h of c.creditHistory.entries)if(h.state==='ACCEPTED')add(h.note);}
    if(command.payload.envelope.kind==='BATCH')for(const e of command.payload.envelope.batch.input.entries){
      if('acceptance'in e)add(e.document.snapshot,e.acceptance);else if('previous'in e&&e.previous)add(e.previous.document.snapshot,e.previous.acceptance);
    }
    if(requests.size>101)throw new Error('EVIDENCE_HISTORY_LIMIT');const proofs=[];
    for(const request of requests.values()){
      const proof=await this.resolver.verify(request.snapshot,asOf);
      if(!isBetaOwnerDocumentAcceptance(proof)&&!isBetaOwnerSummaryAcceptance(proof))throw new Error('OWNER_EVIDENCE_REQUIRED');
      if(proof.evidence.documentId!==request.snapshot.documentId||proof.evidence.snapshotSha256!==fiscalSnapshotSha256(request.snapshot)||proof.evidence.issuerRuc!==request.snapshot.issuer.identityNumber||proof.evidence.environment!=='BETA')throw new Error('OWNER_EVIDENCE_BINDING_REQUIRED');
      if(request.acceptance&&fiscalSnapshotSha256(proof.evidence)!==fiscalSnapshotSha256(request.acceptance))throw new Error('ACCEPTANCE_CHANGED');
      proofs.push({documentId:request.snapshot.documentId,snapshotSha256:fiscalSnapshotSha256(request.snapshot),evidence:proof.evidence,fence:proof.fence});
    }
    const result=Object.freeze({schemaVersion:'factuez.beta.correction-evidence.v1',commandSha256:fingerprint,
      evidenceSha256:fiscalSnapshotSha256(proofs),proofs:freeze(boundedSupplementJson(proofs) as unknown[]),checkedAt:asOf,candidateOnly:true as const,transmissionAuthorized:false as const});
    seals.add(result);return result;
  }
}
