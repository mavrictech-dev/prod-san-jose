/** Synthetic transaction store for LOCAL/BETA admin tests; never a runtime fallback. */
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { B2bIdentity } from '../services/identity-service/src/b2b/service';
import { B2bTokenCodec } from '../services/identity-service/src/b2b/token';
import { clientView, fail, type Audit, type Client, type Store, type Transaction, type DelegationVerifier, type B2bIdentityScope } from '../services/identity-service/src/b2b/model';
import { B2bIntegrationAdmin, type B2bIntegrationAdminOwner, type B2bIntegrationAdminRequest } from '../services/b2b-api-service/src/integration-admin';
import { pem, others, id, input, ctx, binding, basic } from './b2b-identity.fixture';
export { id, input, ctx, binding, basic };
export class AdminTestStore implements Store {
  clients = new Map<string, Client>(); audits: Audit[] = []; failAudit = false; down = false;
  onGet: (() => void) | null = null; onWrite: (() => void) | null = null; onAudit: (() => void) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private buckets = new Map<string, { window: number; count: number }>();
  async rate(key: string, window: number, limit: number) {
    if (this.down) throw new Error('Synthetic unavailable store');
    const prior = this.buckets.get(key), row = prior?.window === window ? prior : { window, count: 0 };
    this.buckets.set(key, row); return ++row.count <= limit;
  }
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      if (this.down) throw new Error('Synthetic unavailable store');
      const clients = structuredClone(this.clients), audits = structuredClone(this.audits);
      const tx: Transaction = {
        list: async q => [...clients.values()].filter(row => !q.after || row.id > q.after).sort((a,b) => a.id < b.id ? -1 : 1).slice(0,q.limit + 1).map(clientView),
        get: async id => { this.onGet?.(); return structuredClone(clients.get(id) ?? null); },
        create: async row => { if (clients.has(row.id)) throw new Error('Duplicate'); clients.set(row.id,structuredClone(row)); this.onWrite?.(); },
        save: async (row, revision) => { if (clients.get(row.id)?.revision !== revision) return fail(409,'REVISION_CONFLICT'); clients.set(row.id,structuredClone(row)); this.onWrite?.(); },
        audit: async event => { if (this.failAudit) throw new Error('Synthetic audit failure'); audits.push(structuredClone(event)); this.onAudit?.(); },
      };
      const value = await work(tx); this.clients = clients; this.audits = audits; return value;
    });
    this.tail = task.catch(() => {}); return task;
  }
}
export function adminFixture(delegation: DelegationVerifier | null = null, enabledScopes?: readonly B2bIdentityScope[]) {
  let time = 1800000000000;
  const store = new AdminTestStore(), state = { active: true, stepUp: true, actorId: id(9), down: false };
  const admin = { verify: vi.fn(async (token: string) => {
    if (state.down) throw new Error('Synthetic live authority unavailable');
    if (token !== 'human-step-up' || !state.active || !state.stepUp) return fail(403,'STEP_UP_REQUIRED');
    return { id: state.actorId, stepUpVerified: true as const };
  }) };
  const catalogue = { validate: vi.fn(async () => {}) };
  const codec = new B2bTokenCodec(pem,'https://admin.identity.invalid',() => Math.floor(time/1000),others);
  const core = new B2bIdentity(store,codec,randomBytes(32),admin,catalogue,delegation,() => time,enabledScopes);
  const owner: B2bIntegrationAdminOwner = { execute: vi.fn((bearer: string, request: B2bIntegrationAdminRequest) => {
    const a = request.args;
    switch (request.action) {
      case 'LIST': return core.list(bearer,a,ctx());
      case 'READ': return core.read(bearer,request.args.id,ctx());
      case 'CREATE': return core.create(bearer,request.args.body,ctx());
      case 'UPDATE': return core.change(bearer,request.args.id,request.args.body,ctx());
      case 'ROTATE': return core.change(bearer,request.args.id,request.args.body,ctx(),true);
    }
  }) };
  return { core, store, state, admin, catalogue, codec, owner, facade: new B2bIntegrationAdmin(owner), advance: (ms: number) => { time += ms; } };
}
