import { Injectable } from '@nestjs/common';
import { BetaIssuanceService } from './beta-issuance.service';
import { ProductionIssuanceRepository } from './production-issuance.repository';
import { ProductionDispatchPolicy, productionWorkflowEnabled } from './production-dispatch-policy';
import type { BetaDispatchRow } from './beta-dispatch-pipeline';
import { PrismaService } from '../infrastructure/prisma.service';
import { ArtifactStore } from '../infrastructure/artifact-store';
import { SecretVault } from '../infrastructure/crypto/secret-vault';
import { CertificateInspectionService } from '../infrastructure/crypto/certificate-inspection.service';
import { CertificateTrustService } from '../infrastructure/crypto/certificate-trust.service';
import { BetaXmlWorkerService } from '../infrastructure/crypto/beta-xml-worker.service';
import { XsdValidationService } from '../infrastructure/sunat/xsd-validation.service';
import { CdrSignatureTrustService } from '../infrastructure/crypto/cdr-signature-trust.service';
import { BoundedSoapAdapter } from '../infrastructure/sunat/bounded-soap.adapter';
import { createProductionSoapAuthorization } from '../infrastructure/sunat/production-soap-authorization';

/** Production 01/03 vertical. The server opt-in alone confers no issuer authority. */
@Injectable()
export class ProductionIssuanceService extends BetaIssuanceService {
  protected readonly environment = 'PRODUCTION' as const;
  constructor(prisma: PrismaService, repository: ProductionIssuanceRepository, store: ArtifactStore, vault: SecretVault,
    inspection: CertificateInspectionService, trust: CertificateTrustService, signer: BetaXmlWorkerService,
    xsd: XsdValidationService, cdrTrust: CdrSignatureTrustService, private readonly policy: ProductionDispatchPolicy) {
    super(prisma, repository, store, vault, inspection, trust, signer, xsd, cdrTrust);
  }
  protected workflowEnabled() { return productionWorkflowEnabled(); }
  protected async authorize(row: BetaDispatchRow) {
    await this.policy.assertCurrent(row.snapshot);
    const credentials = await this.context(row);
    const aad = { ruc: row.snapshot.issuer.identityNumber, environment: 'PRODUCTION' };
    const bytes = this.vault.open(credentials.certificateCipher!, { ...aad, field: 'certificate' }); let password: Buffer | undefined;
    try {
      password = this.vault.open(credentials.certificatePasswordCipher!, { ...aad, field: 'certificatePassword' });
      const certificate = await this.inspection.inspect(bytes, password.toString('utf8'));
      const proof = await this.trust.evaluate(certificate, aad.ruc);
      if (certificate.fingerprint !== credentials.certificateFingerprint || !proof.chainValid || !proof.identityMatched || proof.revocation !== 'VERIFIED_OFFLINE_CRL') throw new Error('Confianza del certificado pendiente');
      await this.policy.assertCurrent(row.snapshot, credentials.revision);
    } finally { bytes.fill(0); password?.fill(0); }
  }
  protected async adapter(row: BetaDispatchRow) {
    await this.authorize(row);
    const manifest = await this.repository.manifest(row);
    const credentials = await this.context(row, manifest.revision);
    if (!credentials.solUsernameCipher || !credentials.solPasswordCipher) throw new Error('Credenciales SOL de producción pendientes');
    const aad = { ruc: row.snapshot.issuer.identityNumber, environment: 'PRODUCTION' };
    const user = this.vault.open(credentials.solUsernameCipher, { ...aad, field: 'solUsername' }); let password: Buffer | undefined;
    try {
      password = this.vault.open(credentials.solPasswordCipher, { ...aad, field: 'solPassword' });
      const authority = createProductionSoapAuthorization({ ruc: aad.ruc, operations: row.snapshot.documentTypeCode === '03' ? ['sendSummary', 'getStatus'] : ['sendBill'] }, async () => {
        // Re-read revocation and the exact revision immediately before the outbound POST.
        await this.policy.assertCurrent(row.snapshot, credentials.revision);
        await this.authorize(row);
      });
      return new BoundedSoapAdapter({ environment: 'PRODUCTION', ruc: aad.ruc, solUser: user.toString('utf8'), solPassword: password.toString('utf8') }, authority);
    } finally { user.fill(0); password?.fill(0); }
  }
}
