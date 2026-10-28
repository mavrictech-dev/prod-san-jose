import type { GuideEstablishmentDatabase } from './guide-establishment-store';
import type { GuideIssueAuthority } from './guide-issue-model';
import { BillingGuideIssueProducer } from './guide-issue-producer';
import { PostgresGuideIssueContext } from './guide-issue-context';
import { PostgresGuideIssueStore } from './guide-issue-store';
import { BillingB2bGuideIssueAuthorization } from './guide-issue-authorization';
import type { ContextIdentity } from './context';
import type { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';

/** Explicit owner composition; not registered in a Nest module or Kong.
 * Construction never queries/applies a schema or starts a worker. No fallback
 * from draft permissions, default issuer or synthetic test authority exists. */
export function createCandidateGuideIssueProducer(dependencies: {
  database: GuideEstablishmentDatabase; authority: GuideIssueAuthority;
  allowedRucs: readonly string[]; now?: () => string;
}) {
  return new BillingGuideIssueProducer(new PostgresGuideIssueStore(dependencies.database),
    dependencies.authority, new PostgresGuideIssueContext(),
    { allowedRucs: dependencies.allowedRucs, now: dependencies.now });
}

/** Integration composition using a private Identity authority, not a fake grant.
 * The host still owns TLS material, registration and the explicit issuer list. */
export function createAuthorizedCandidateGuideIssueProducer(dependencies: {
  database: GuideEstablishmentDatabase; identity: ContextIdentity;
  identityHttp: Pick<B2bPrivateHttp, 'post'>; allowedRucs: readonly string[]; now?: () => string;
}) {
  return createCandidateGuideIssueProducer({ database: dependencies.database,
    authority: new BillingB2bGuideIssueAuthorization(dependencies.identity, dependencies.identityHttp),
    allowedRucs: dependencies.allowedRucs, now: dependencies.now });
}
