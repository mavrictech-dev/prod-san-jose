import { vi, type Mock } from 'vitest';
import { B2bSecurityError } from '../../packages/contracts/src/b2b-security';
import { b2bGuideBindingKey, type B2bGuideBinding } from '../../packages/contracts/src/b2b-guide-security';
import { B2bGuides } from '../../services/billing-service/src/b2b/guide-drafts';
import type { GuideAuthorization } from '../../services/billing-service/src/b2b/guide-authorization';
import type { GuideCatalogue } from '../../services/billing-service/src/b2b/guide-catalogue';
import type { GuideBody, GuideDraft, GuideOperation, GuideStore, GuideTransaction } from '../../services/billing-service/src/b2b/guide-model';

export const guideUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const GUIDE_RUC = '20000000001';
export const guideKey = 'synthetic_guide_request_0001';
export function guideBinding(type: '09' | '31' = '09'): B2bGuideBinding {
  return { anchor: { issuerId: 1, issuerRuc: GUIDE_RUC, environment: 'BETA', branchId: guideUuid(1),
    pointId: guideUuid(2), seriesId: guideUuid(3), documentType: '01' }, guideSeriesId: guideUuid(4), guideType: type };
}
/** Synthetic parties and permits, no credentials, files, certificates or official evidence. */
export function guideBody(): GuideBody {
  return { issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
    destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
    sender: { ruc: GUIDE_RUC, legalName: 'REMITENTE FICTICIO' },
    recipient: { ruc: '20000000010', legalName: 'DESTINATARIO FICTICIO' }, grossWeight: '1.250', weightUnit: 'KGM',
    transport: { mode: '01', carrier: { ruc: GUIDE_RUC, legalName: 'TRANSPORTISTA FICTICIO', mtcRegistration: 'MTC-FICTICIO' } },
    items: [{ code: 'ITEM-1', description: 'ARTICULO FICTICIO', quantity: '2.000001', unitCode: 'NIU' }],
    references: [{ type: '09', issuerRuc: GUIDE_RUC, series: 'T001', number: '00000001' }], regulatedGoods: false };
}
type State = { rows: Map<string, GuideDraft>; ops: Map<string, GuideOperation> };
type Write = 'create' | 'save' | 'append';
type Read = 'get' | 'prior' | 'operation' | 'list';
/** Serializable in-memory owner double. Each callback uses a structured clone; failures discard
 * both aggregate and receipt. Restart tests reuse this store, not any service-local cache. */
export class MemoryGuideStore implements GuideStore {
  state: State = { rows: new Map(), ops: new Map() };
  private queue: Promise<void> = Promise.resolve();
  transactions = 0;
  writeCalls: Write[] = [];
  listCalls: { clientId: string; actorKey: string; bindings: B2bGuideBinding[]; limit: number; after: string | null }[] = [];
  onWrite?: (action: Write, staged: State) => void | Promise<void>;
  onRead?: (action: Read) => void | Promise<void>;
  listOverride?: (normal: GuideDraft[]) => GuideDraft[];
  get rows() { return this.state.rows; }
  get ops() { return this.state.ops; }
  async transaction<T>(work: (tx: GuideTransaction) => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.transactions++;
    const staged = structuredClone(this.state);
    const read = async <T>(name: Read, value: T): Promise<T> => {
      await this.onRead?.(name); return structuredClone(value);
    };
    const write = async (name: Write) => { this.writeCalls.push(name); await this.onWrite?.(name, staged); };
    const tx: GuideTransaction = {
      get: async id => read('get', staged.rows.get(id) ?? null),
      prior: async (clientId, actorKey, keySha256) => read('prior', [...staged.ops.values()].find(op =>
        op.clientId === clientId && op.actorKey === actorKey && op.keySha256 === keySha256) ?? null),
      operation: async (id, clientId, actorKey) => {
        const op = staged.ops.get(id);
        return read('operation', op?.clientId === clientId && op.actorKey === actorKey ? op : null);
      },
      list: async (clientId, actorKey, bindings, limit, after) => {
        this.listCalls.push(structuredClone({ clientId, actorKey, bindings, limit, after }));
        const allowed = new Set(bindings.map(b2bGuideBindingKey));
        const rows = [...staged.rows.values()].filter(row => row.clientId === clientId && row.actorKey === actorKey &&
          allowed.has(b2bGuideBindingKey(row.binding)) && (after === null || row.id > after))
          .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, limit);
        return read('list', this.listOverride ? this.listOverride(rows) : rows);
      },
      create: async draft => {
        if (staged.rows.has(draft.id)) throw new Error('SYNTHETIC_DUPLICATE_DRAFT');
        staged.rows.set(draft.id, structuredClone(draft)); await write('create');
      },
      save: async (draft, expectedRevision) => {
        if (staged.rows.get(draft.id)?.revision !== expectedRevision) throw new Error('SYNTHETIC_REVISION_CONFLICT');
        staged.rows.set(draft.id, structuredClone(draft)); await write('save');
      },
      append: async op => {
        if (staged.ops.has(op.id) || [...staged.ops.values()].some(prior => prior.clientId === op.clientId &&
          prior.actorKey === op.actorKey && prior.keySha256 === op.keySha256)) throw new Error('SYNTHETIC_DUPLICATE_OPERATION');
        staged.ops.set(op.id, structuredClone(op)); await write('append');
      },
    };
    try {
      const result = await work(tx);
      this.state = structuredClone(staged);
      return result;
    } finally { release(); }
  }
}
export type GuideFixture = {
  binding: B2bGuideBinding; store: MemoryGuideStore; kind: 'SERVICE' | 'USER'; token: string;
  access: Awaited<ReturnType<GuideAuthorization['current']>>;
  control: { revoked: boolean; at: string };
  catalogueValue: { binding: B2bGuideBinding; seriesLabel: string; metadataSha256: string };
  authorization: { current: Mock<GuideAuthorization['current']> };
  catalogue: { resolve: Mock<GuideCatalogue['resolve']> };
  now: Mock<() => string>; core: B2bGuides;
  command: (action?: GuideOperation['action'], id?: string | null, key?: string, etag?: string,
    input?: unknown) => ReturnType<B2bGuides['command']>;
  restart: () => B2bGuides;
  read: (id: string) => ReturnType<B2bGuides['read']>;
  operation: (id: string) => ReturnType<B2bGuides['operation']>;
  list: (limit?: number, after?: string | null) => ReturnType<B2bGuides['list']>;
};
export function guideFixture(kind: 'SERVICE' | 'USER' = 'SERVICE', type: '09' | '31' = '09'): GuideFixture {
  const binding = guideBinding(type), store = new MemoryGuideStore(), token = 'synthetic-guide-token';
  const subjectId = kind === 'USER' ? guideUuid(20) : null;
  const access: Awaited<ReturnType<GuideAuthorization['current']>> = {
    actor: { userId: subjectId, scope: { kind: 'ASSIGNED', branchIds: [binding.anchor.branchId],
      emissionPointIds: [binding.anchor.pointId], series: [binding.anchor.seriesId, binding.guideSeriesId] },
      b2b: { kind, clientId: guideUuid(21), revision: 1, subjectId, userAuthRevision: kind === 'USER' ? 1 : null } },
    grantRevision: 1, clientRevision: 1,
  };
  const control = { revoked: false, at: '2026-10-21T16:00:00.000Z' };
  const catalogueValue = { binding: structuredClone(binding), seriesLabel: type === '09' ? 'T001' : 'V001', metadataSha256: 'a'.repeat(64) };
  const authorization = { current: vi.fn<GuideAuthorization['current']>(async () => {
    if (control.revoked) throw new B2bSecurityError(401, 'SYNTHETIC_REVOKED');
    return structuredClone(access);
  }) };
  const catalogue = { resolve: vi.fn<GuideCatalogue['resolve']>(async () => structuredClone(catalogueValue)) };
  const now = vi.fn(() => control.at);
  const core = new B2bGuides(store, authorization, catalogue, now);
  const command = (action: GuideOperation['action'] = 'CREATE', id: string | null = null, key = guideKey,
    etag: string | undefined = undefined, input: unknown = action === 'CREATE' ? guideBody() : {}) =>
    core.command(token, kind, binding, action, id, key, etag, input);
  return { binding, store, kind, token, access, control, catalogueValue, authorization, catalogue, now, core, command,
    restart: () => new B2bGuides(store, authorization, catalogue, now),
    read: (id: string) => core.read(token, kind, binding, id),
    operation: (id: string) => core.operation(token, kind, binding, id),
    list: (limit = 10, after: string | null = null) => core.list(token, kind, binding, limit, after) };
}
