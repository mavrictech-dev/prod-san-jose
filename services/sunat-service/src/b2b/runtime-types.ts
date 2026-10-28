import type {NestExpressApplication} from '@nestjs/platform-express';
import type {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import type {PrivilegedHumanAuthority,Phase8LiveHumanIdentity,Phase8AdminBindingOwner} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {ArtifactStore} from '../infrastructure/artifact-store';
import type {CurrentPdfService} from '../application/current-pdf.service';
import type {SecretVault} from '../infrastructure/crypto/secret-vault';
import type {CertificateInspectionService} from '../infrastructure/crypto/certificate-inspection.service';
import type {BetaOwnerXmlTrust} from '../infrastructure/crypto/beta-owner-xml-trust';
import type {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import type {XsdValidationService} from '../infrastructure/sunat/xsd-validation.service';
import type {PersistentBatchMemberEvidence} from './batch-member-evidence-assembly';
import type {CarrierReferenceValidation} from './carrier-reference-validation';
import type {LocalGuideKeys} from '../application/guide-artifact-assembly';
import type {BatchLocalKeyProvider,BatchLocalCdrSource} from '../application/batch-local-artifacts';
export interface SunatRuntimeTls {ca:Buffer;cert:Buffer;key:Buffer}
export interface B2bSunatRuntimeConfig {
 enabled?:boolean;environment:'BETA';deploymentId:string;instanceId:string;
 api:{host:'127.0.0.1'|'0.0.0.0';port:number};control:{host:'127.0.0.1'|'0.0.0.0';port:number};
 peers:{resource:string[];billing:string[];operator:string[]};
}
/** Structural interface of the parent's B2bOwnerDrain. Parent supplies its actual
 * instance; this module neither substitutes a no-op gate nor loads source/dist fallbacks. */
export interface SunatOwnerDrain {
 install(app:Pick<NestExpressApplication,'use'|'useGlobalInterceptors'>):void;
 pauseCommands():void;closeAdmission():void;
 drain(which:'COMMANDS'|'MUTATIONS'|'ALL',timeoutMs?:number):Promise<{state:string;pending:number}>;
 snapshot():{state:string;active:number;commands:number;mutations:number;uncertainGuards:number};
}
export interface B2bSunatRuntimeDependencies {
 /** Existing SUNAT App DI. No new PrismaService, env lookup or file/credential loader. */
 prisma:PrismaService;artifacts:Pick<ArtifactStore,'read'>;pdf:Pick<CurrentPdfService,'b2bDocument'>;
 identity:Pick<B2bIdentityHttp,'authenticate'>;identityHttp:Pick<B2bPrivateHttp,'post'>;billingHttp:B2bPrivateHttp;
 credentials:{apiTls:SunatRuntimeTls;controlTls:SunatRuntimeTls};drain:SunatOwnerDrain;
 lifecycle:{stopProducers():Promise<void>;stopWorkers():Promise<void>;closeOtherOwnerListeners():Promise<void>;closeStorage?():Promise<void>};
 batchMemberEvidence?:PersistentBatchMemberEvidence;
 carrierReference?:CarrierReferenceValidation;
 /** No successful crypto/XSD assertions in config. These execute on the actual bytes. */
 guide?:{keys:LocalGuideKeys;allowedRucs:readonly string[];cdr:Pick<CdrSignatureTrustService,'verify'>;xsd:Pick<XsdValidationService,'validate'>};
 batch?:{keys:BatchLocalKeyProvider;allowedRucs:readonly string[];cdr:Pick<CdrSignatureTrustService,'verify'>;xsd:Pick<XsdValidationService,'validate'>;cdrSource?:BatchLocalCdrSource};
 corrections?:{signatures:BetaOwnerXmlTrust;cdr:Pick<CdrSignatureTrustService,'verify'>;xsd:Pick<XsdValidationService,'validate'>};
 /** Existing DI supplies vault/inspector; factory creates a separate actual owner with exact request-local capabilities.
  * Never pass the legacy bearer-resolving singleton or invent an approved human. */
 privileged?:{vault:SecretVault;certificates:CertificateInspectionService;
  authority:PrivilegedHumanAuthority;liveIdentity:Phase8LiveHumanIdentity;bindingOwner:Phase8AdminBindingOwner};
}


