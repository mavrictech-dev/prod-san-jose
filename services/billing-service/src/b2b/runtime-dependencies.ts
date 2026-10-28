import type { PrismaService } from '../infrastructure/prisma.service';
import type { IssueDocumentService } from '../application/issue-document.service';
import type { StationAdminService } from '../application/station-admin.service';
import type { PrintBrandingService } from '../application/print-branding.service';
import type { B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import type { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import type { B2bMaintenanceHooks } from '@factuez/service-access/dist/b2b-maintenance-node';
import type { PrivilegedHumanAuthority, Phase8LiveHumanIdentity } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type { EstablishmentAdminAuthority } from './guide-establishments';
import type { CarrierReferenceSignatureCdrValidator } from './carrier-guide-reference';
import type { BusinessPgPool } from './phase8-business/postgres-store';
import type { BusinessPermissionPort } from './phase8-business/types';
import type { ReportsPgPool, ReportsRenderers } from './phase8-reports/types';
import type { B2bCorrectionBinding } from '@factuez/contracts/b2b-security';
import type { B2bGuideIssueBinding } from '@factuez/contracts/b2b-guide-security';
import type { ReportsCorrectionReadAuthority } from './phase8-reports/source-types';
import type { createBillingBatchOperations } from './batch-member-http';

import type { BillingOwnerDrain } from './runtime-lifecycle';
import type { BillingBatchPolicyAdministration } from './batch-policy-administration';
import type {BillingHostPermissions} from './host-permissions';
import type {BillingBatchCurrentIdentity} from './host-permissions-batch';
import type {B2bBinding} from '@factuez/contracts/b2b-security';

export interface BillingRuntimeTls { ca: Buffer; cert: Buffer; key: Buffer }
/** All pools are Billing-owned, explicitly supplied, and closed by legacyLifecycle.STORAGE.
 * Genuine trust/vault implementations belong to the host; none are inferred from env or DTOs. */
export interface BillingB2bRuntimeDependencies {
  prisma: PrismaService;
  issueDocument: IssueDocumentService;
  stationAdmin: StationAdminService;
  printBranding: PrintBrandingService;
  identity: B2bIdentityPort;
  identityHttp: Pick<B2bPrivateHttp, 'post'>;
  fiscalHttp: Pick<B2bPrivateHttp, 'post'>;
  allowedRucs: readonly string[];
  deploymentId: string;
  instanceId: string;
  peers: { callers: readonly string[]; registrar: readonly string[]; administrators: readonly string[]; status: readonly string[]; evidence: readonly string[] };
  tls: BillingRuntimeTls;
  maintenance: { enabled: boolean; operatorPeers: readonly string[]; tls: BillingRuntimeTls };
  /** Must cover ALL legacy HTTP admission, producers, schedulers, consumers and pools.
   * ADMISSION must retain internal read/auth; PRODUCERS resolves only after producers drain.
   * STORAGE closes Prisma and every injected pool, AFTER all callers have drained. */
  legacyLifecycle: B2bMaintenanceHooks;
  ownerDrain: BillingOwnerDrain;
  /** Standalone host additionally checks real BETA owner/trust infrastructure. */
  infrastructureCheck?: () => Promise<void>;
  establishmentAdmin: EstablishmentAdminAuthority;
  carrierReferenceValidator: CarrierReferenceSignatureCdrValidator;
  business: { pool: BusinessPgPool; permissions: BusinessPermissionPort };
  batches: Omit<Parameters<typeof createBillingBatchOperations>[0], 'identity' | 'now'>;
  reports: {
    pool: ReportsPgPool;
    guideMetadata: { origin: string; tls: BillingRuntimeTls };
    corrections: { bindings: readonly B2bCorrectionBinding[]; authority: ReportsCorrectionReadAuthority };
    guides: { bindings: readonly B2bGuideIssueBinding[] };
    renderers?: ReportsRenderers;
  };
  privilegedAdmin: { authority: PrivilegedHumanAuthority; liveIdentity: Phase8LiveHumanIdentity };
  batchPolicyAdministration?: BillingBatchPolicyAdministration;
  requestAuthorities?:{permissions:BillingHostPermissions;masterBindings:readonly B2bBinding[];batches:BillingBatchCurrentIdentity};
}

export function requiredMethod(value: unknown, method: string, name: string): void {
  if (!value || typeof (value as Record<string, unknown>)[method] !== 'function')
    throw Error('BILLING_RUNTIME_DEPENDENCY_REQUIRED:' + name + '.' + method);
}
export function runtimePeers(value: readonly string[] | undefined, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || new Set(value).size !== value.length || value.some(v => !/^[a-f0-9]{64}$/.test(v)))
    throw Error('BILLING_RUNTIME_PEERS_REQUIRED:' + name);
  return [...value];
}
export function runtimeTls(value: BillingRuntimeTls | undefined): BillingRuntimeTls {
  if (!value || ![value.ca, value.cert, value.key].every(v => Buffer.isBuffer(v) && v.length)) throw Error('BILLING_RUNTIME_MTLS_REQUIRED');
  return { ca: Buffer.from(value.ca), cert: Buffer.from(value.cert), key: Buffer.from(value.key) };
}

