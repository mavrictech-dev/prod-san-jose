import {isBetaOwnerDocumentAcceptance,type BetaAcceptanceDocument} from './beta-document-acceptance';
import type {BetaOwnerDocumentAcceptance} from './beta-owner-document-acceptance';
import {isBetaOwnerSummaryAcceptance,type BetaOwnerSummaryAcceptance} from './beta-owner-summary-acceptance';
export class BetaOwnerAcceptanceResolver {
  constructor(private readonly individual:Pick<BetaOwnerDocumentAcceptance,'verify'>,private readonly summary:Pick<BetaOwnerSummaryAcceptance,'verify'>){}
  async verify(snapshot:BetaAcceptanceDocument,asOf:string){
    const proof=snapshot.series.startsWith('B')?await this.summary.verify(snapshot,asOf):await this.individual.verify(snapshot,asOf);
    if(!isBetaOwnerDocumentAcceptance(proof)&&!isBetaOwnerSummaryAcceptance(proof))throw new Error('OWNER_PROOF_PROVENANCE_REQUIRED');return proof;
  }
}
