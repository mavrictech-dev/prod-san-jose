import { vi } from 'vitest';
import { B2bSecurityError } from '../../packages/contracts/src/b2b-security';
import { fiscalSnapshotSha256 } from '../../packages/sunat-core/src/fiscal-note';
import type { GuideReferenceCatalogue } from '../../packages/sunat-core/src/fiscal-guide-catalogues';
import { GuideGoods, guideGoodsProductSha256 } from '../../services/billing-service/src/b2b/guide-goods';
import type {
  GuideGoodsAudit, GuideGoodsAuthority, GuideGoodsEntry, GuideGoodsProduct,
  GuideGoodsSnapshot, GuideGoodsStore, GuideGoodsTransaction,
} from '../../services/billing-service/src/b2b/guide-goods-types';
import type { EstablishmentAdministrator, EstablishmentCompany } from '../../services/billing-service/src/b2b/guide-establishments';
import { guideBinding, guideUuid, GUIDE_RUC } from './b2b-guide.fixture';
import { guidePreparationBody } from './guide-preparation.fixture';

export type GuideGoodsState = {
  companies: Map<number, EstablishmentCompany>;
  products: Map<string, GuideGoodsProduct>;
  heads: Map<number, GuideGoodsSnapshot>;
  audits: GuideGoodsAudit[];
};
type Read = 'company' | 'products' | 'head';
type Write = 'save' | 'audit';

/** Persistence alone is doubled: serial transactions clone all reads/writes,
 * enforce CAS and commit the policy and its audits atomically. Rate counters
 * deliberately live outside rollback. Products have no invented companyId. */
export class SerialMemoryGuideGoodsStore implements GuideGoodsStore {
  state: GuideGoodsState = { companies: new Map(), products: new Map(), heads: new Map(), audits: [] };
  readonly rates = new Map<string, number>();
  readonly rateCalls: { keySha256: string; window: number; limit: number }[] = [];
  readonly transactions: number[] = [];
  readonly productCalls: string[][] = [];
  readonly writeCalls: Write[] = [];
  onRead?: (action: Read, staged: GuideGoodsState) => void | Promise<void>;
  onWrite?: (action: Write, staged: GuideGoodsState) => void | Promise<void>;
  productsOverride?: (rows: GuideGoodsProduct[]) => GuideGoodsProduct[];
  private queue: Promise<void> = Promise.resolve();

  async rate(keySha256: string, window: number, limit: number): Promise<boolean> {
    this.rateCalls.push({ keySha256, window, limit });
    const key = `${keySha256}:${window}`, count = (this.rates.get(key) ?? 0) + 1;
    this.rates.set(key, count);
    return count <= limit;
  }

  async transaction<T>(companyId: number, work: (tx: GuideGoodsTransaction) => Promise<T>): Promise<T> {
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
      const write = async (action: Write) => {
        this.writeCalls.push(action);
        await this.onWrite?.(action, staged);
      };
      const tx: GuideGoodsTransaction = {
        company: async id => read('company', () => staged.companies.get(id) ?? null),
        products: async ids => {
          this.productCalls.push([...ids]);
          return read('products', () => {
            const rows = [...staged.products.values()].filter(p => ids.includes(p.id));
            return this.productsOverride ? this.productsOverride(rows) : rows;
          });
        },
        head: async id => read('head', () => staged.heads.get(id) ?? null),
        save: async (snapshot, expectedRevision) => {
          if (snapshot.companyId !== companyId ||
              (staged.heads.get(companyId)?.revision ?? 0) !== expectedRevision)
            throw new Error('SYNTHETIC_GUIDE_GOODS_CAS');
          staged.heads.set(companyId, structuredClone(snapshot));
          await write('save');
        },
        audit: async audit => {
          if (audit.companyId !== companyId) throw new Error('SYNTHETIC_GUIDE_GOODS_AUDIT_SCOPE');
          staged.audits.push(structuredClone(audit));
          await write('audit');
        },
      };
      const result = await work(tx);
      this.state = structuredClone(staged);
      return result;
    } finally { release(); }
  }
}

export function guideGoodsReferenceCatalogue(): GuideReferenceCatalogue {
  const unsigned: Omit<GuideReferenceCatalogue, 'sha256'> = {
    schemaVersion: 'factuez.guide-reference-catalogue.v1', version: 'fictional-reference-v1',
    sourceUrl: 'https://cpe.sunat.gob.pe/node/116', sourceSha256: 'a'.repeat(64),
    units: ['NIU'], weightUnits: ['KGM', 'TNE'], ubigeos: ['150101', '150102'],
    referenceStatus: 'LOCAL_REFERENCE_NOT_OFFICIAL',
  };
  return { ...unsigned, sha256: fiscalSnapshotSha256(unsigned) };
}

/** All identities, parties and tokens are fictional. No remote authority,
 * database, credentials, certificate or official classification is involved. */
export function guideGoodsFixture() {
  const binding = guideBinding(), body = guidePreparationBody();
  const company: EstablishmentCompany = {
    id: binding.anchor.issuerId, ruc: GUIDE_RUC, environment: 'BETA', configVersion: 3, active: true,
  };
  const product: GuideGoodsProduct = {
    id: guideUuid(50), sku: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', category: 'BIEN',
    unitCode: 'NIU', sunatProductCode: null, active: true, updatedAt: '2026-10-22T14:00:00.000Z',
  };
  const entries: GuideGoodsEntry[] = [{ productId: product.id,
    productSha256: guideGoodsProductSha256(product), classification: 'NON_REGULATED',
    rationale: 'DECLARACION LOCAL FICTICIA PARA PRUEBAS' }];
  const catalogue = guideGoodsReferenceCatalogue(), store = new SerialMemoryGuideGoodsStore();
  store.state.companies.set(company.id, structuredClone(company));
  store.state.companies.set(2, { ...company, id: 2, ruc: '20000000010' });
  store.state.products.set(product.id, structuredClone(product));
  const actor: EstablishmentAdministrator = {
    id: guideUuid(80), authRevision: 4, stepUpVerified: true, scope: 'GLOBAL',
    permissions: ['setup.manage', 'series.manage'],
  };
  const token = 'fictitious-goods-admin-step-up';
  const admin = { verify: vi.fn<GuideGoodsAuthority['verify']>(async value => {
    if (value !== token) throw new B2bSecurityError(401, 'SYNTHETIC_ADMIN_TOKEN_REQUIRED');
    return structuredClone(actor);
  }) };
  const control = { at: '2026-10-22T15:00:00.000Z' }, now = vi.fn(() => control.at);
  const context = { requestId: guideUuid(81), peer: 'fictitious-goods-local-peer' };
  const core = new GuideGoods(store, admin, now);
  const input = (expectedRevision = 0, selected = entries, expectedIssuerRevision = company.configVersion,
    referenceCatalogue = catalogue) => ({ expectedRevision, expectedIssuerRevision,
    catalogue: structuredClone(referenceCatalogue), entries: structuredClone(selected) });
  return { core, store, binding, body, company, product, entries, catalogue, token, actor, context,
    admin, control, now, input,
    replace: (value: unknown = input()) => core.replace(token, company.id, value, context),
    read: () => core.read(token, company.id, context),
    match: () => core.assertLocalGoods(binding, body),
    restart: () => new GuideGoods(store, admin, now) };
}
