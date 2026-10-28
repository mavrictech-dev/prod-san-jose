import type {ArtifactStore} from '../infrastructure/artifact-store';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {verifyBetaDocumentAcceptance,type BetaAcceptanceDocument} from './beta-document-acceptance';
import type {PrismaBetaDocumentAcceptanceRepository} from './beta-document-acceptance.repository';
/** Explicit candidate assembly only. No Injectable/bootstrap, endpoints, credentials or network. */
export class BetaOwnerDocumentAcceptance {
  constructor(private readonly repository:Pick<PrismaBetaDocumentAcceptanceRepository,'load'>,
    private readonly artifacts:Pick<ArtifactStore,'read'>,private readonly signatures:Pick<BetaOwnerXmlTrust,'verifyIssuer'>,
    private readonly cdr:Pick<CdrSignatureTrustService,'verify'>){}
  verify(snapshot:BetaAcceptanceDocument,asOf:string){
    return verifyBetaDocumentAcceptance(snapshot,asOf,{
      load:(ruc,environment,id)=>this.repository.load(ruc,environment,id),read:(id,a)=>this.artifacts.read(id,a),
      verifyIssuer:(record,xml,unsigned,now)=>this.signatures.verifyIssuer(record,xml,unsigned,now),verifyCdr:xml=>this.cdr.verify(xml),
    });
  }
}
