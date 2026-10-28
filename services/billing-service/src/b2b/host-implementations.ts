import type { BillingB2bRuntimeDependencies } from './runtime-dependencies';
import { B2bIdentityHttp, B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { adminDigest } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { createBillingHostAdministration } from './host-administration';
import { BillingHostPermissions } from './host-permissions';
import { BillingAuthorityHttps } from './host-permissions-http';
import { BillingBatchCurrentIdentity } from './host-permissions-batch';
import { BillingBatchPolicyAdministration } from './batch-policy-administration';
import { HttpBatchMemberEvidence } from './batch-member-evidence-http';
import { HttpCarrierReferenceSignatureCdrValidator } from './carrier-reference-validation-http';
import { PrismaB2bContextRepository } from './context';
import { validateBillingHostConfig, validateBillingHostCredentials, type BillingHostConfig, type BillingHostCredentials } from './host-config';
import type { PrismaService } from '../infrastructure/prisma.service';

/** Internal software dependency contract, not a plugin API for the customer. */
export interface BillingHostImplementations {
  establishmentAdmin: BillingB2bRuntimeDependencies['establishmentAdmin'];
  businessPermissions: BillingB2bRuntimeDependencies['business']['permissions'];
  carrierReferenceValidator: BillingB2bRuntimeDependencies['carrierReferenceValidator'];
  batchEvidence: BillingB2bRuntimeDependencies['batches']['evidence'];
  batchMemberIdentity: BillingB2bRuntimeDependencies['batches']['memberIdentity'];
  batchPolicyAdmin: BillingB2bRuntimeDependencies['batches']['policyAdmin'];
  privilegedAdmin: BillingB2bRuntimeDependencies['privilegedAdmin'];
  reportRenderers?: BillingB2bRuntimeDependencies['reports']['renderers'];
  batchPolicyAdministration?: BillingBatchPolicyAdministration;
  requestAuthorities?:BillingB2bRuntimeDependencies['requestAuthorities'];
  assertInfrastructure(): Promise<void>;
  close(): Promise<void>;
}
const billingHostRequiredPorts = Object.freeze([
  'establishmentAdmin.verify', 'businessPermissions.authorizeCurrent', 'carrierReferenceValidator.verify',
  'batchEvidence.verifySignedVersion', 'batchMemberIdentity.current', 'batchPolicyAdmin.authorizeStepUp',
  'privilegedAdmin.authority.authorize', 'privilegedAdmin.liveIdentity.current',
]);
export const billingHostRequiredImplementations = Object.freeze([...billingHostRequiredPorts, 'assertInfrastructure', 'close']);
export class BillingHostMissingImplementations extends Error {
  constructor(readonly missing: readonly string[]) { super('BILLING_HOST_SOFTWARE_INCOMPLETE:' + missing.join(',')); }
}
export function validateBillingHostImplementations(input: unknown): asserts input is BillingHostImplementations {
  const missing = billingHostRequiredImplementations.filter(path => {
    let value: unknown = input;
    for (const key of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    return typeof value !== 'function';
  });
  if (missing.length) throw new BillingHostMissingImplementations(missing);
}
/** In-repository concrete composition. No I/O, plugins, default-allow authority or
 * inferred historical source. Missing mounted configuration is an actual dependency,
 * not an unconditional software gate. Empty/missing exact evidence still fails at use. */
export function requireBuiltinBillingHostImplementations(input?: BillingHostConfig, mounted?: BillingHostCredentials, prisma?: PrismaService): BillingHostImplementations {
  if (!input || !mounted || !prisma) throw new BillingHostMissingImplementations(['builtin.config','builtin.credentials','builtin.billingOwner']);
  const config = validateBillingHostConfig(input), credentials = validateBillingHostCredentials(mounted), builtin = config.builtin;
  if (!builtin || !credentials.authorityTls) throw new BillingHostMissingImplementations(['builtin.boundariesAndServerPins','builtin.authorityTls']);
  const identity = new B2bIdentityHttp(new B2bPrivateHttp(config.identityOrigin, credentials.identityTls));
  const administration = createBillingHostAdministration(new B2bPrivateHttp(config.identityOrigin, credentials.authorityTls));
  const permissions = new BillingHostPermissions(new BillingAuthorityHttps(config.identityOrigin, {
    ...credentials.authorityTls, serverFingerprintSha256: builtin.identityServerSha256,
  }), { enabled: true, establishment: { ...administration.privilegedAdmin, identity } });
  const batches = new BillingBatchCurrentIdentity(identity, { enabled: true });
  const context = new PrismaB2bContextRepository(prisma);
  const batchPolicies = new BillingBatchPolicyAdministration({ enabled: true, identity, ...administration.privilegedAdmin,
    bindingOwner: { revalidate: async binding => {
      const current = await context.resolve(binding);
      if (!current) throw Error('BILLING_BATCH_POLICY_BINDING_UNAVAILABLE');
      return { binding: structuredClone(binding), revision: adminDigest(current) };
    } },
  }, builtin.batchPolicyBindings);
  const fiscalOptions = { enabled: true, origin: config.fiscalOrigin, tls: credentials.fiscalTls, sunatPeerSha256: builtin.fiscalServerSha256 };
  const evidence = new HttpBatchMemberEvidence(fiscalOptions);
  let closed = false;
  return {
    establishmentAdmin: permissions.establishmentAdmin, businessPermissions: permissions.businessPermissions,
    carrierReferenceValidator: new HttpCarrierReferenceSignatureCdrValidator(fiscalOptions), batchEvidence: evidence,
    batchMemberIdentity: batches.memberIdentity, batchPolicyAdmin: batchPolicies.policyAdmin, batchPolicyAdministration: batchPolicies,
    privilegedAdmin: administration.privilegedAdmin,
    requestAuthorities: { permissions, masterBindings: builtin.masterBindings, batches },
    assertInfrastructure: async () => {
      if (closed) throw Error('BILLING_HOST_AUTHORITIES_CLOSED');
      await administration.assertAdministrationInfrastructure(); await permissions.readiness(); await evidence.readiness();
      if (closed) throw Error('BILLING_HOST_AUTHORITIES_CLOSED');
    },
    close: async () => { closed = true; permissions.close(); batches.close(); batchPolicies.close(); },
  };
}
