import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { validB2bBinding, type B2bBinding } from '@factuez/contracts/b2b-security';
import { Phase8AdminOperation, adminDigest, adminSnapshot, type Phase8AdminDependencies } from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import { fiscalSnapshotSha256 } from '@factuez/sunat-core/dist/fiscal-note';
import { billingPermissionFailure } from './host-permissions-wire';
import type { BatchLocalGrantPolicy, BatchMemberPolicyAdminPort } from './batch-member-postgres.types';
import type { BatchMemberBinding } from './batch-member-authority';

export type BatchPolicyBoundary = { anchor: B2bBinding; member: BatchMemberBinding };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function batchPolicyBoundaries(input: readonly BatchPolicyBoundary[]): BatchPolicyBoundary[] {
  const entries = adminSnapshot(input);
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) return billingPermissionFailure(400);
  for (const e of entries) {
    const b = e?.member, a = e?.anchor;
    if (!e || Object.keys(e).sort().join(',') !== 'anchor,member' || !validB2bBinding(a) || !b ||
        Object.keys(b).sort().join(',') !== 'branchId,companyId,documentType,environment,issuerRuc,pointId,series,seriesId' ||
        b.environment !== 'BETA' || b.companyId !== a.issuerId || b.issuerRuc !== a.issuerRuc || b.branchId !== a.branchId || b.pointId !== a.pointId ||
        !uuid.test(b.seriesId) || !/^[BF][A-Z0-9]{3}$/.test(b.series) || !['01','03','07','08'].includes(b.documentType) ||
        (['01','03'].includes(b.documentType) && (b.seriesId !== a.seriesId || b.documentType !== a.documentType)) ||
        (a.documentType === '01' ? !b.series.startsWith('F') : !b.series.startsWith('B'))) return billingPermissionFailure(400);
  }
  if (new Set(entries.map(e => adminDigest(e.member))).size !== entries.length) return billingPermissionFailure(400);
  return entries;
}

type Session = { handle: string; digest: string; current(): ReturnType<BatchMemberPolicyAdminPort['authorizeStepUp']>; close(): void };
/** Billing's independent policy requires BOTH current global setup.manage and series.manage.
 * The existing Identity relay performs OIDC introspection, MFA age/ACR/AMR checks and durable audit.
 * These are authority-only proofs; no master/series owner mutation is called here.
 * A configured boundary selects the exact member series; it NEVER creates a member grant.
 * No bearer, administrator boolean or serialized receipt is an ownerAdminHandle. */
export class BillingBatchPolicyAdministration {
  #context = new AsyncLocalStorage<Session>();
  #closed = false;
  #boundaries: BatchPolicyBoundary[];
  constructor(private readonly deps: Phase8AdminDependencies, boundaries: readonly BatchPolicyBoundary[]) {
    this.#boundaries = batchPolicyBoundaries(boundaries);
  }
  #open() { if (this.#closed || this.deps.enabled !== true) return billingPermissionFailure(); }
  readonly policyAdmin: BatchMemberPolicyAdminPort = { authorizeStepUp: async (handle, digest, asOf) => {
    this.#open(); const session = this.#context.getStore();
    const age = Date.now() - Date.parse(asOf);
    if (!session || session.handle !== handle || session.digest !== digest || !Number.isFinite(age) || age < 0 || age > 30000)
      return billingPermissionFailure(403);
    return session.current();
  }};
  /** Private owner command boundary. All SQL is still performed by setLocalGrant,
   * whose own before/inside/final fences recheck this capability and use CAS. */
  async withPolicy<T>(token: string, input: BatchLocalGrantPolicy, work: (ownerAdminHandle: string, policy: BatchLocalGrantPolicy) => Promise<T>): Promise<T> {
    this.#open(); if (this.#context.getStore()) return billingPermissionFailure(403);
    const policy = adminSnapshot(input), boundary = this.#boundaries.find(e => adminDigest(e.member) === adminDigest(policy?.binding));
    if (!boundary || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token) || typeof work !== 'function') return billingPermissionFailure(403);
    const digest = fiscalSnapshotSha256(policy), payload = { schemaVersion: 'factuez.billing.batch-local-policy.v1', policySha256: digest, policy };
    const ops: Phase8AdminOperation[] = [];
    const deadline = Date.now() + 30000;
    let closed = false;
    const session: Session = { handle: randomUUID(), digest, close: () => { closed = true; ops.forEach(op => op.close()); }, current: async () => {
      this.#open(); if (closed || Date.now() >= deadline || ops.length !== 2) return billingPermissionFailure(401);
      const setup = await ops[0].revalidate(), series = await ops[1].revalidate();
      const mark = (v: typeof setup) => adminDigest({ sub: v.sub, authVersion: v.authVersion, roles: v.roles, permissions: v.permissions, scope: v.scope });
      if (mark(setup) !== mark(series) || !setup.permissions.includes('setup.manage') || !setup.permissions.includes('series.manage') ||
          !Number.isSafeInteger(setup.authVersion) || setup.authVersion < 1) return billingPermissionFailure(403);
      this.#open(); if (closed || Date.now() >= deadline) return billingPermissionFailure(401);
      return { adminId: setup.sub, authRevision: setup.authVersion, policySha256: digest, checkedAt: new Date().toISOString() };
    }};
    try {
      ops.push(await Phase8AdminOperation.open(this.deps, { token, kind: 'USER' }, 'MASTERS_READ', { binding: boundary.anchor, payload }));
      ops.push(await Phase8AdminOperation.open(this.deps, { token, kind: 'USER' }, 'SERIES_UPDATE', { binding: boundary.anchor, payload, id: boundary.anchor.seriesId }));
      return await this.#context.run(session, async () => {
        await session.current();
        return work(session.handle, policy);
      });
    } finally { session.close(); }
  }
  close() { this.#closed = true; }
  toJSON() { return { service: 'BillingBatchPolicyAdministration', contents: 'PRIVATE' }; }
  [inspect.custom]() { return this.toJSON(); }
}
