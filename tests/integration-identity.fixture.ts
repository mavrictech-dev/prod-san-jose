// Test-only transactional fake. Never imported by runtime; no production memory fallback.
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { IntegrationIdentity } from '../services/identity-service/src/integration/service';
import { IntegrationTokenCodec } from '../services/identity-service/src/integration/token';
import { fail, view, type Audit, type Client, type Store, type Transaction } from '../services/identity-service/src/integration/model';

export const branch = '10000000-0000-4000-8000-000000000001', point = '20000000-0000-4000-8000-000000000001',
  series = '30000000-0000-4000-8000-000000000001', actor = '40000000-0000-4000-8000-000000000001';
export const grant = { issuerRuc: '20555555555', environment: 'BETA' as const, documentTypes: ['01' as const],
  branches: { kind: 'IDS' as const, ids: [branch] }, points: { kind: 'IDS' as const, ids: [point] }, series: { kind: 'IDS' as const, ids: [series] } };
export const catalogue = { companies: [{ id: 1, ruc: grant.issuerRuc, environment: 'BETA', source: 'BUSINESS' }],
  branches: [{ id: branch, companyId: 1, source: 'BUSINESS' }],
  emissionPoints: [{ id: point, branchId: branch, companyId: 1, source: 'BUSINESS', series: [{ id: series, documentType: 'INVOICE' }] }] };
export const ctx = () => ({ requestId: randomUUID(), peer: 'fixture-loopback' });
export const input = () => ({ label: 'ERP ficticio', scopes: ['integration:documents:read'], grants: [structuredClone(grant)] });
export const basic = (id: string, secret: string) => 'Basic ' + Buffer.from(id + ':' + secret).toString('base64');
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' });

export class TestStore implements Store {
  clients = new Map<string, Client>(); audits: Audit[] = [];
  buckets = new Map<string, { window: number; count: number }>(); failAudit = false; down = false;
  private tail: Promise<unknown> = Promise.resolve();
  private rateOn(buckets: TestStore['buckets'], key: string, window: number, limit: number) {
    if (this.down) throw new Error('Test DB unavailable');
    const old = buckets.get(key);
    if (old && (old.window > window || (old.window === window && old.count >= limit))) return false;
    buckets.set(key, { window, count: old?.window === window ? old.count + 1 : 1 }); return true;
  }
  async rate(key: string, window: number, limit: number) { return this.rateOn(this.buckets, key, window, limit); }
  async list() { if (this.down) throw new Error(); return [...this.clients.values()].map(view); }
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      if (this.down) throw new Error('Test DB unavailable');
      const clients = structuredClone(this.clients), audits = structuredClone(this.audits);
      const rates: Array<[string, number, number]> = [];
      const tx: Transaction = {
        get: async id => structuredClone(clients.get(id) ?? null),
        create: async c => { if (clients.has(c.id)) throw new Error(); clients.set(c.id, structuredClone(c)); },
        save: async (c, expected) => { if (clients.get(c.id)?.revision !== expected) return fail(409, 'REVISION_CONFLICT'); clients.set(c.id, structuredClone(c)); },
        audit: async a => { if (this.failAudit) throw new Error('Test audit failure'); audits.push(a); },
        rate: async (k, w, l) => { const copy = structuredClone(this.buckets); for (const r of rates) this.rateOn(copy, ...r);
          const ok = this.rateOn(copy, k, w, l); if (ok) rates.push([k, w, l]); return ok; },
      };
      const result = await work(tx);
      this.clients = clients; this.audits = audits;
      for (const r of rates) this.rateOn(this.buckets, ...r);
      return result;
    });
    this.tail = operation.catch(() => {}); return operation;
  }
}
export function fixture() {
  let time = 1_800_000_000_000;
  const store = new TestStore();
  const authority = { verify: vi.fn(async (token: string) => { if (token !== 'human-fixture') return fail(403, 'FORBIDDEN'); return { id: actor }; }) };
  const cataloguePort = { validate: vi.fn(async () => {}) };
  const codec = new IntegrationTokenCodec(Buffer.from(key), 'https://identity.factuez.invalid', 300, () => Math.floor(time / 1000));
  const core = new IntegrationIdentity(store, codec, randomBytes(32), authority, cataloguePort, () => time);
  return { store, core, codec, key, authority, cataloguePort, advance: (ms: number) => { time += ms; } };
}
