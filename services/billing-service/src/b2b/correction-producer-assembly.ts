import {validB2bCorrectionBinding,type B2bCorrectionBinding} from '@factuez/contracts/b2b-security';
import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import type {PrismaService} from '../infrastructure/prisma.service';
import {BetaSupplementCommandRepository} from '../application/beta-supplement-command.repository';
import {CorrectionJournalRepository} from '../application/correction-journal.repository';
import {VerifiedCorrectionJournal} from '../application/verified-correction-journal';
import {B2bCorrectionProducer} from './correction-producer';
import {PrismaCorrectionProducerDrafts} from './correction-producer-drafts';
import {createBillingCorrectionEvidencePorts} from './correction-evidence-assembly';
import type {BillingB2bCorrectionAuthorization} from './correction-authorization';

/** Complete owner-local candidate assembly, per request, with fixed mTLS SUNAT
 * ports. Does not import SUNAT persistence, register AppModule/Kong, apply DDL,
 * publish Outbox, request OAuth or authorize official transmission. */
export function createBillingCorrectionProducer(db:PrismaService,authorization:Pick<BillingB2bCorrectionAuthorization,'current'>,
  sunat:Pick<B2bPrivateHttp,'post'>,token:string,kind:'SERVICE'|'USER',binding:B2bCorrectionBinding,allowedRucs:readonly string[],now=()=>new Date().toISOString()){
  if(!validB2bCorrectionBinding(binding)||binding.reference.environment!=='BETA'||!allowedRucs.includes(binding.reference.issuerRuc))throw new Error('EXPLICIT_ENTERPRISE_BETA_PROFILE_REQUIRED');
  binding=correctionEvidenceFreeze(binding);
  const ports=createBillingCorrectionEvidencePorts(db,authorization,sunat,async()=>token,kind,binding,now);
  const journal=new VerifiedCorrectionJournal(db,new CorrectionJournalRepository(new BetaSupplementCommandRepository(db)),ports.commandAuthority,ports.reservationEvidence,ports.financialEvidence,allowedRucs,now);
  const drafts=new PrismaCorrectionProducerDrafts(db,ports.financialEvidence,now);
  return new B2bCorrectionProducer(authorization,drafts,{reserve:command=>journal.reserve(command,drafts.receiptFor(command)),settle:id=>journal.settle(id),status:id=>journal.status(id)});
}
