import { vi } from 'vitest';
import { B2bSecurityError } from '../../packages/contracts/src/b2b-security';
import {
  GuideEstablishments,
  type EstablishmentAdminAuthority, type EstablishmentAudit, type EstablishmentBranch,
  type EstablishmentCompany, type EstablishmentEntry, type EstablishmentSnapshot,
  type EstablishmentStore, type EstablishmentTransaction,
} from '../../services/billing-service/src/b2b/guide-establishments';
import { guideBinding, guideUuid, GUIDE_RUC } from './b2b-guide.fixture';
import { guidePreparationBody } from './guide-preparation.fixture';

export type TypeAdmin = {
  id: string; authRevision: number; stepUpVerified: true; scope: 'GLOBAL';
  permissions: ['setup.manage', 'series.manage'];
};
export type EstablishmentState = {
  companies: Map<number, EstablishmentCompany>;
  branches: Map<string, EstablishmentBranch>;
  heads: Map<number, EstablishmentSnapshot>;
  audits: EstablishmentAudit[];
};
type Read = 'company' | 'branches' | 'head';
type Write = 'save' | 'audit';

/** Only persistence is doubled. Transactions serialize, clone at boundaries and
 * commit together; throwing discards the head AND its audit. Failed requests
 * still count against rate limits, which live outside the transaction. */
export class SerialMemoryEstablishmentStore implements EstablishmentStore {
  state: EstablishmentState = { companies: new Map(), branches: new Map(), heads: new Map(), audits: [] };
  readonly rates = new Map<string, number>();
  readonly rateCalls: { keySha256: string; window: number; limit: number }[] = [];
  readonly transactions: number[] = [];
  readonly writeCalls: Write[] = [];
  onRead?: (action: Read, staged: EstablishmentState) => void | Promise<void>;
  onWrite?: (action: Write, staged: EstablishmentState) => void | Promise<void>;
  branchesOverride?: (rows: EstablishmentBranch[]) => EstablishmentBranch[];
  private queue: Promise<void> = Promise.resolve();

  async rate(keySha256: string, window: number, limit: number): Promise<boolean> {
    this.rateCalls.push({ keySha256, window, limit });
    const key = `${keySha256}:${window}`, count = (this.rates.get(key) ?? 0) + 1;
    this.rates.set(key, count);
    return count <= limit;
  }

  async transaction<T>(companyId: number, work: (tx: EstablishmentTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      this.transactions.push(companyId);
      const staged = structuredClone(this.state);
      const read = async <V>(action: Read, get: () => V): Promise<V> => {
        await this.onRead?.(action, staged);
        return structuredClone(get());
      };
      const write = async (action: Write) => { this.writeCalls.push(action); await this.onWrite?.(action, staged); };
      const tx: EstablishmentTransaction = {
        company: async id => read('company', () => staged.companies.get(id) ?? null),
        branches: async (id, ids) => read('branches', () => {
          const rows = [...staged.branches.values()].filter(b => b.companyId === id && ids.includes(b.id));
          return this.branchesOverride ? this.branchesOverride(rows) : rows;
        }),
        head: async id => read('head', () => staged.heads.get(id) ?? null),
        save: async (snapshot, expectedRevision) => {
          if (snapshot.companyId !== companyId || (staged.heads.get(companyId)?.revision ?? 0) !== expectedRevision)
            throw new Error('SYNTHETIC_ESTABLISHMENT_CAS');
          staged.heads.set(companyId, structuredClone(snapshot));
          await write('save');
        },
        audit: async audit => { staged.audits.push(structuredClone(audit)); await write('audit'); },
      };
      const result = await work(tx);
      this.state = structuredClone(staged);
      return result;
    } finally { release(); }
  }
}

/** All issuers, addresses, parties, identities and tokens are fictitious. */
export function establishmentFixture() {
  const binding = guideBinding(), body = guidePreparationBody();
  const company: EstablishmentCompany = {
    id: binding.anchor.issuerId, ruc: GUIDE_RUC, environment: 'BETA', configVersion: 3, active: true,
  };
  const entries: EstablishmentEntry[] = [
    { branchId: binding.anchor.branchId, branchRevision: 5, ...body.origin },
    { branchId: guideUuid(10), branchRevision: 7, ...body.destination },
  ];
  const store = new SerialMemoryEstablishmentStore();
  store.state.companies.set(company.id, structuredClone(company));
  store.state.companies.set(2, { ...company, id: 2, ruc: '20000000010' });
  for (const e of entries) store.state.branches.set(e.branchId, {
    id: e.branchId, companyId: company.id, masterRevision: e.branchRevision, active: true,
  });
  store.state.branches.set(guideUuid(90), { id: guideUuid(90), companyId: 2, masterRevision: 1, active: true });
  const actor: TypeAdmin = {
    id: guideUuid(80), authRevision: 4, stepUpVerified: true, scope: 'GLOBAL',
    permissions: ['setup.manage', 'series.manage'],
  };
  const token = 'fictitious-owner-admin-step-up';
  const admin = { verify: vi.fn<EstablishmentAdminAuthority['verify']>(async value => {
    if (value !== token) throw new B2bSecurityError(401, 'SYNTHETIC_ADMIN_TOKEN_REQUIRED');
    return structuredClone(actor);
  }) };
  const control = { at: '2026-10-22T15:00:00.000Z' };
  const now = vi.fn(() => control.at);
  const core = new GuideEstablishments(store, admin, now);
  const context = { requestId: guideUuid(81), peer: 'fictitious-local-peer' };
  const input = (expectedRevision = 0, selected = entries, expectedIssuerRevision = company.configVersion) =>
    ({ expectedRevision, expectedIssuerRevision, entries: structuredClone(selected) });
  return {
    core, store, binding, body, company, entries, actor, token, admin, control, now, context, input,
    read: () => core.read(token, company.id, context),
    replace: (value: unknown = input()) => core.replace(token, company.id, value, context),
    match: () => core.assertLocalMapping(binding, body),
    restart: () => new GuideEstablishments(store, admin, now),
  };
}
