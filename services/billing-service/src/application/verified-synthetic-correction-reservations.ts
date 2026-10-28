import type {PrismaClient} from '../generated/prisma/client';
import type {BetaSupplementCommandRepository} from './beta-supplement-command.repository';
import {SyntheticCorrectionReservations} from './synthetic-correction-reservations';
import {VerifiedCorrectionTransaction,type CorrectionCommandAuthority,type CorrectionOwnerEvidence} from './verified-correction-transaction';

/** Integrated rehearsal: authentic owner proof + fresh authority + atomic note,
 * counter, Outbox and monotonic hold. Not registered in any running module.
 * Deliberately retains the NEW synthetic database/RUC-only restrictions. */
export class VerifiedSyntheticCorrectionReservations {
  private readonly transaction:VerifiedCorrectionTransaction;
  private readonly reservations:SyntheticCorrectionReservations;
  constructor(db:Pick<PrismaClient,'$transaction'>,owner:Pick<BetaSupplementCommandRepository,'reserveWithinTransaction'>,
    authority:CorrectionCommandAuthority,evidence:CorrectionOwnerEvidence,now=()=>new Date().toISOString()){
    this.transaction=new VerifiedCorrectionTransaction(db,authority,evidence,['20000000001'],now);
    this.reservations=new SyntheticCorrectionReservations(db,owner,authority);
  }
  reserve(value:unknown){
    return this.transaction.execute(value,(tx,command,actor)=>this.reservations.reserveWithinTransaction(tx,command,actor));
  }
}
