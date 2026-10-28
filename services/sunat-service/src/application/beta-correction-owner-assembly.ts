import type {FiscalSupplementCommand} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {ArtifactStore} from '../infrastructure/artifact-store';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {PrismaBetaDocumentAcceptanceRepository} from './beta-document-acceptance.repository';
import {BetaOwnerDocumentAcceptance} from './beta-owner-document-acceptance';
import {PrismaBetaSummaryOwner} from './beta-owner-summary.repository';
import {BetaOwnerSummaryAcceptance,isBetaOwnerSummaryAcceptance} from './beta-owner-summary-acceptance';
import {isBetaOwnerDocumentAcceptance} from './beta-document-acceptance';
import {BetaOwnerAcceptanceResolver} from './beta-owner-acceptance-resolver';
import {BetaCorrectionEvidence,isBetaCorrectionEvidence} from './beta-correction-evidence';
import {PrismaBetaSupplementOutcomeOwner} from './beta-supplement-outcome.repository';
import {BetaVerifiedSupplementOutcome,isBetaVerifiedSupplementOutcome} from './beta-verified-supplement-outcome';

/** Explicit owner-side composition, never an HTTP trust shortcut. Does not read
 * credentials, sign, submit or change any row. Deployment must provide pinned
 * public certificates/CRL policy; absent trust fails closed. No active bootstrap
 * imports this factory. A command reader must be supplied by its own Billing
 * authority; an operation ID from an unauthenticated caller is not that reader. */
export function createBetaCorrectionOwnerAssembly(db:PrismaService,artifacts:Pick<ArtifactStore,'read'>,
  signatures:Pick<BetaOwnerXmlTrust,'verifyIssuer'|'verifyBatch'|'verifyEnvelope'>,cdr:Pick<CdrSignatureTrustService,'verify'>){
  const individual=new BetaOwnerDocumentAcceptance(new PrismaBetaDocumentAcceptanceRepository(db),artifacts,signatures,cdr);
  const summaries=new BetaOwnerSummaryAcceptance(new PrismaBetaSummaryOwner(db),artifacts,signatures,cdr);
  const acceptance=new BetaOwnerAcceptanceResolver(individual,summaries);
  const prerequisites=new BetaCorrectionEvidence(acceptance);
  const outcomes=new BetaVerifiedSupplementOutcome(new PrismaBetaSupplementOutcomeOwner(db,artifacts),signatures,cdr);
  const originalOwned=(v:unknown)=>isBetaOwnerDocumentAcceptance(v)||isBetaOwnerSummaryAcceptance(v);
  return Object.freeze({acceptance,prerequisites,outcomes,
    correctionEvidence:Object.freeze({verify:prerequisites.verify.bind(prerequisites),owns:isBetaCorrectionEvidence}),
    financialEvidence(commandOwner:{load(operationId:string):Promise<FiscalSupplementCommand>}){
      return Object.freeze({command:(id:string)=>commandOwner.load(id),
        verify:outcomes.verify.bind(outcomes),owns:isBetaVerifiedSupplementOutcome,
        prerequisites:prerequisites.verify.bind(prerequisites),ownsPrerequisites:isBetaCorrectionEvidence,
        original:acceptance.verify.bind(acceptance),ownsOriginal:originalOwned});
    },candidateOnly:true as const,transmissionAuthorized:false as const,fiscalExecutionEnabled:false as const});
}
