import {validateFiscalSupplementCommand,type FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import type {Prisma,PrismaClient} from '../generated/prisma/client';
import {supplementActor,type SupplementActor} from './supplement-actor';
export interface CorrectionOwnerEvidence {
  verify(command:FiscalSupplementCommand,asOf:string):Promise<{commandSha256:string;evidenceSha256:string}>;
  owns(value:unknown):boolean;
}
export interface CorrectionCommandAuthority {current(command:FiscalSupplementCommand):Promise<SupplementActor>}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
/** Common transaction boundary for candidate owner composition. Never imported by active fiscal services. */
export class VerifiedCorrectionTransaction {
  constructor(private readonly db:Pick<PrismaClient,'$transaction'>,private readonly authority:CorrectionCommandAuthority,
    private readonly evidence:CorrectionOwnerEvidence,private readonly allowedRucs:readonly string[],private readonly now=()=>new Date().toISOString()){
    if(!allowedRucs.length||allowedRucs.some(r=>!/^\d{11}$/.test(r)))throw new Error('EXPLICIT_BETA_PROFILE_REQUIRED');
    this.allowedRucs=Object.freeze([...allowedRucs]);
  }
  async execute<T>(input:unknown,work:(tx:Prisma.TransactionClient,c:FiscalSupplementCommand,a:SupplementActor)=>Promise<T>){
    const command=freeze(validateFiscalSupplementCommand(input));
    if(command.payload.environment!=='BETA'||!this.allowedRucs.includes(command.payload.issuerRuc))throw new Error('BETA_PROFILE_NOT_ENABLED');
    const asOf=this.now(),commandHash=fiscalSnapshotSha256(command),actor=freeze(supplementActor(await this.authority.current(command))),actorHash=fiscalSnapshotSha256(actor);
    const proof=await this.evidence.verify(command,asOf);
    if(!this.evidence.owns(proof)||proof.commandSha256!==commandHash||!/^[a-f0-9]{64}$/.test(proof.evidenceSha256))throw new Error('OWNER_EVIDENCE_REQUIRED');
    const evidenceHash=proof.evidenceSha256;
    const fresh=async()=>{
      if(fiscalSnapshotSha256(supplementActor(await this.authority.current(command)))!==actorHash)throw new Error('AUTHORITY_CHANGED');
      const current=await this.evidence.verify(command,asOf);
      if(!this.evidence.owns(current)||current.commandSha256!==commandHash||current.evidenceSha256!==evidenceHash)throw new Error('EVIDENCE_CHANGED');
    };
    for(let attempt=0;;attempt++){
      try{return await this.db.$transaction(async tx=>{
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factuez:beta-supplement:company:${command.payload.companyId}:ruc:${command.payload.issuerRuc}`},0))`;
        await fresh();const result=await work(tx,command,actor);await fresh();return result;
      },{isolationLevel:'Serializable',maxWait:3000,timeout:15000});}
      catch(e){if(e&&typeof e==='object'&&'code'in e&&e.code==='P2034'&&attempt<2)continue;throw e;}
    }
  }
}
