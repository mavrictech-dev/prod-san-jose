import type {PrismaClient} from '../generated/prisma/client';
import {validateFinancialLedgerPlan} from './financial-ledger-plan';
import type {FinancialLedgerCandidateRepository} from './financial-ledger-candidate.repository';
import type {SupplementActor} from './supplement-actor';
import {supplementActor} from './supplement-actor';
import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalDocumentSnapshot} from '@factuez/contracts';
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** A concurrent identical plan may hit its receipt PK under Serializable before
 * PostgreSQL reports P2034. Retry the whole transaction, never an INSERT alone.
 * Only this owner table's planId primary key is eligible; other unique errors
 * are not treated as replay. The next attempt rechecks the complete receipt. */
function concurrentReceipt(error:unknown):boolean{
  if(!error||typeof error!=='object'||!('code'in error)||error.code!=='P2002'||!('meta'in error))return false;
  const meta=error.meta as {modelName?:unknown;target?:unknown}|undefined;
  return meta?.modelName==='FinancialLedgerCommit'&&(meta.target===undefined||meta.target===null||Array.isArray(meta.target)&&meta.target.length===1&&meta.target[0]==='planId');
}
export interface FinancialOutcomePort {
  command(id:string):Promise<FiscalSupplementCommand>;
  verify(command:FiscalSupplementCommand,asOf:string):Promise<{commandSha256:string;operationId:string;evidence:unknown;fence:unknown}>;
  owns(proof:unknown):boolean;
  prerequisites(command:FiscalSupplementCommand,asOf:string):Promise<{commandSha256:string;evidenceSha256:string}>;
  ownsPrerequisites(proof:unknown):boolean;
  original(snapshot:FiscalDocumentSnapshot,asOf:string):Promise<{evidence:{documentId:string;snapshotSha256:string;issuerRuc:string;environment:string};fence:unknown}>;
  ownsOriginal(proof:unknown):boolean;
}
/** Commits only owner-reverified outcomes, with same-transaction candidate persistence and precommit fences. */
export class VerifiedFinancialCommit {
  constructor(private readonly db:Pick<PrismaClient,'$transaction'>,private readonly repository:Pick<FinancialLedgerCandidateRepository,'commitWithinTransaction'>,
    private readonly outcomes:FinancialOutcomePort,private readonly authority:{current(actor:SupplementActor):Promise<SupplementActor>},private readonly now=()=>new Date().toISOString()){}
  async commit(value:unknown,inputActor:SupplementActor){
    const validation=validateFinancialLedgerPlan(value),actor=freeze(supplementActor(inputActor)),actorHash=fiscalSnapshotSha256(actor),asOf=this.now(),stamps=new Map<string,string>();
    const fresh=async(initial=false)=>{
      if(fiscalSnapshotSha256(supplementActor(await this.authority.current(actor)))!==actorHash)throw new Error('FINANCIAL_AUTHORITY_CHANGED');
      for(const document of validation.plan.input.documents){
        const proof=await this.outcomes.original(document as FiscalDocumentSnapshot,asOf);
        if(this.outcomes.ownsOriginal(proof)!==true||proof.evidence.documentId!==document.documentId||proof.evidence.snapshotSha256!==fiscalSnapshotSha256(document)||proof.evidence.issuerRuc!==document.issuer.identityNumber||proof.evidence.environment!=='BETA')throw new Error('VERIFIED_ORIGINAL_REQUIRED');
        const key='original:'+document.documentId,stamp=fiscalSnapshotSha256(proof.fence);
        if(!initial&&stamps.get(key)!==stamp)throw new Error('FINANCIAL_EVIDENCE_CHANGED');stamps.set(key,stamp);
      }
      for(const entry of validation.plan.input.entries){
        const command=freeze(validateFiscalSupplementCommand(await this.outcomes.command(entry.operationId)));
        const prerequisites=await this.outcomes.prerequisites(command,asOf);
        if(!this.outcomes.ownsPrerequisites(prerequisites)||prerequisites.commandSha256!==fiscalSnapshotSha256(command)||!/^[a-f0-9]{64}$/.test(prerequisites.evidenceSha256))throw new Error('VERIFIED_PREREQUISITES_REQUIRED');
        const proof=await this.outcomes.verify(command,asOf);
        if(!this.outcomes.owns(proof)||proof.commandSha256!==fiscalSnapshotSha256(command)||proof.operationId!==entry.operationId||fiscalSnapshotSha256(proof.evidence)!==fiscalSnapshotSha256(entry.evidence))throw new Error('VERIFIED_OWN_OUTCOME_REQUIRED');
        const key=entry.documentId+':'+entry.operationId,stamp=fiscalSnapshotSha256({outcome:proof.fence,prerequisites:prerequisites.evidenceSha256});
        if(!initial&&stamps.get(key)!==stamp)throw new Error('FINANCIAL_EVIDENCE_CHANGED');stamps.set(key,stamp);
      }
    };
    await fresh(true);
    for(let attempt=0;;attempt++)try{return await this.db.$transaction(async tx=>{
      await fresh();const result=await this.repository.commitWithinTransaction(tx,validation.plan,actor);await fresh();return result;
    },{isolationLevel:'Serializable',maxWait:3000,timeout:15000});}catch(e){if(attempt<2&&(e&&typeof e==='object'&&'code'in e&&e.code==='P2034'||concurrentReceipt(e)))continue;throw e;}
  }
}
