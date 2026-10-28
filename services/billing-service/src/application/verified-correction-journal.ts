import {boundedSupplementJson,validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {FiscalLedgerEvidence} from '@factuez/sunat-core/dist/fiscal-financial-ledger';
import type {PrismaClient} from '../generated/prisma/client';
import {VerifiedCorrectionTransaction,type CorrectionCommandAuthority,type CorrectionOwnerEvidence} from './verified-correction-transaction';
import {CorrectionJournalRepository,type CorrectionRequestReceipt} from './correction-journal.repository';
import type {FinancialOutcomePort} from './verified-financial-commit';
import {supplementActor} from './supplement-actor';

const same=(a:unknown,b:unknown)=>fiscalSnapshotSha256(a)===fiscalSnapshotSha256(b);
function retryable(error:unknown){
  if(!error||typeof error!=='object'||!('code'in error))return false;
  if(error.code==='P2034')return true;
  // Raw PostgreSQL serializable/unique receipt conflicts are retried as a whole,
  // never re-run just a write. Exact owned replay is verified on the next try.
  const meta='meta'in error?error.meta as {code?:unknown;message?:unknown;driverAdapterError?:{cause?:{originalCode?:unknown;originalMessage?:unknown}}}:undefined;
  const cause=meta?.driverAdapterError?.cause,code=cause?.originalCode??meta?.code,message=cause?.originalMessage??meta?.message;
  return error.code==='P2010'&&(code==='40001'||code==='23505'&&typeof message==='string'&&
    /B2bCorrection(?:JournalHead_pkey|JournalEvent_(?:pkey|operationId_kind_key)|RequestReceipt_(?:pkey|operationId_key|externalSha256_key))/.test(message));
}
/** Explicit candidate business profile, NOT a laboratory promotion. New journal
 * supports reservations after settlement; V1/synthetic guards are untouched.
 * Composition must use the private owner evidence adapters, never client flags. */
export class VerifiedCorrectionJournal {
  private readonly transaction:VerifiedCorrectionTransaction;
  private readonly allowed:readonly string[];
  constructor(private readonly db:Pick<PrismaClient,'$transaction'>,private readonly repository:CorrectionJournalRepository,
    private readonly authority:CorrectionCommandAuthority,evidence:CorrectionOwnerEvidence,private readonly outcomes:FinancialOutcomePort,
    allowedRucs:readonly string[],private readonly now=()=>new Date().toISOString()){
    this.allowed=Object.freeze([...allowedRucs]);this.transaction=new VerifiedCorrectionTransaction(db,authority,evidence,this.allowed,now);
  }
  private profile(input:unknown){
    const command=validateFiscalSupplementCommand(input),e=command.payload.envelope;
    if(command.payload.environment!=='BETA'||!this.allowed.includes(command.payload.issuerRuc)||e.kind!=='NOTE'||e.context.original.documentTypeCode!=='01'||!e.note.series.startsWith('F'))throw new Error('ENTERPRISE_BETA_NOTE_PROFILE_NOT_ENABLED');
    return command;
  }
  async reserve(input:unknown,receiptInput?:CorrectionRequestReceipt){
    const command=this.profile(input),receipt=receiptInput===undefined?undefined:boundedSupplementJson(receiptInput) as CorrectionRequestReceipt;
    for(let attempt=0;;attempt++)try{return await this.transaction.execute(command,(tx,c,a)=>this.repository.reserve(tx,c,a,receipt));}
    catch(error){if(attempt<2&&retryable(error))continue;throw error;}
  }
  async settle(operationId:string){
    const command=this.profile(await this.outcomes.command(operationId));
    if(command.payload.operationId!==operationId||command.payload.envelope.kind!=='NOTE')throw new Error('OWN_OPERATION_REQUIRED');
    const original=command.payload.envelope.context.original,asOf=this.now();let stamp:string|null=null;let evidence:FiscalLedgerEvidence|null=null;
    const fresh=async()=>{
      const origin=await this.outcomes.original(original,asOf),proof=await this.outcomes.verify(command,asOf);
      if(!this.outcomes.ownsOriginal(origin)||origin.evidence.documentId!==original.documentId||origin.evidence.snapshotSha256!==fiscalSnapshotSha256(original)||origin.evidence.issuerRuc!==command.payload.issuerRuc||origin.evidence.environment!=='BETA')throw new Error('VERIFIED_ORIGINAL_REQUIRED');
      if(!this.outcomes.owns(proof)||proof.commandSha256!==fiscalSnapshotSha256(command)||proof.operationId!==operationId)throw new Error('VERIFIED_OWN_OUTCOME_REQUIRED');
      const current=fiscalSnapshotSha256({original:origin.fence,outcome:proof.fence,evidence:proof.evidence});
      if(stamp!==null&&stamp!==current)throw new Error('FINANCIAL_EVIDENCE_CHANGED');stamp=current;
      evidence=boundedSupplementJson(proof.evidence) as FiscalLedgerEvidence;
    };
    await fresh();
    for(let attempt=0;;attempt++)try{return await this.transaction.execute(command,async(tx,c,a)=>{
      await fresh();const result=await this.repository.settle(tx,c,evidence!,a);await fresh();return result;
    });}catch(error){if(attempt<2&&retryable(error))continue;throw error;}
  }
  async status(operationId:string){
    const command=this.profile(await this.outcomes.command(operationId));
    if(command.payload.operationId!==operationId||command.payload.envelope.kind!=='NOTE')throw new Error('OWN_OPERATION_REQUIRED');
    const original=command.payload.envelope.context.original,actor=supplementActor(await this.authority.current(command));
    return this.db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:company:${command.payload.companyId}:ruc:${command.payload.issuerRuc}`},0))`;
      if(!same(actor,supplementActor(await this.authority.current(command))))throw new Error('AUTHORITY_CHANGED');
      const loaded=await this.repository.load(tx,original),result=this.repository.view(loaded.projection,operationId,true,command);
      if(!same(actor,supplementActor(await this.authority.current(command))))throw new Error('AUTHORITY_CHANGED');return result;
    },{isolationLevel:'Serializable',maxWait:3000,timeout:15000});
  }
}
