import {
  IntegrationDocumentTypes, IntegrationPatterns, parseIntegrationDocumentFilters,
  type IntegrationDocumentDetailV1, type IntegrationDocumentFiltersV1,
  type IntegrationIdSelection, type IntegrationPageV1,
} from '@factuez/contracts/integration';
import {
  deny, plain, requireIssuer, requireScopes, ruc, snapshotHash, uuid,
  type ReadIdentity, type ReadPrincipal,
} from '@factuez/service-access/dist/integration';
import { mapBillingDocument, supportedSalesTypes } from './read';

export const billingCaptureMaxDocuments = 10000;
export const billingCaptureMaxBytes = 16 * 1024 * 1024;
export type BillingCaptureSalesType = '01' | '03' | '07' | '08';
export interface BillingCaptureBinding {
  id: string; branchId: string; pointId: string; seriesCounterId: string;
  type: BillingCaptureSalesType; snapshotSha256: string;
}
export interface BillingReauthorizeBody { issuerRuc: string; bindings: BillingCaptureBinding[] }
export interface BillingCaptureDTO {
  documents: IntegrationDocumentDetailV1[];
  snapshotAt: string;
  coverage: IntegrationPageV1<any>['coverage'];
  changeBarrier?:{epoch:string;sequence:string};
}
/** Array metadata belongs to this capture, so concurrent transactions cannot share a clock. */
export type BillingCaptureRows = any[] & { snapshotAt?: string;changeBarrier?:{epoch:string;sequence:string} };
export interface BillingCaptureRepository {
  capture(filters: IntegrationDocumentFiltersV1, principal: ReadPrincipal): Promise<any[]>;
  reauthorize(issuerRuc: string, ids: string[]): Promise<any[]>;
}

const selected = (s: IntegrationIdSelection, id: string | null) =>
  s.kind === 'ALL' || (s.ids.length > 0 && (id === null || s.ids.includes(id)));

function coverage(filters: IntegrationDocumentFiltersV1, p: ReadPrincipal): BillingCaptureDTO['coverage'] {
  const types: BillingCaptureDTO['coverage']['types'] = IntegrationDocumentTypes.map(type => {
    if (!supportedSalesTypes.includes(type as BillingCaptureSalesType))
      return { type, state: 'UNSUPPORTED', reasonCode: 'SOURCE_NOT_SUPPORTED' };
    const allowed = p.grants.some(g => g.issuerRuc === filters.issuerRuc && g.environment === filters.environment &&
      g.documentTypes.includes(type) && selected(g.branches, filters.branchId) &&
      selected(g.points, filters.pointId) && selected(g.series, null));
    return allowed ? { type, state: 'READY', reasonCode: null } :
      { type, state: 'UNAVAILABLE', reasonCode: 'INSUFFICIENT_SCOPE' };
  });
  return { types, complete: filters.types.every(type => types.some(t => t.type === type && t.state === 'READY')) };
}

function parseBindings(body: unknown): BillingReauthorizeBody {
  const keys = ['id', 'branchId', 'pointId', 'seriesCounterId', 'type', 'snapshotSha256'];
  if (!plain(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'issuerRuc') || !Object.hasOwn(body, 'bindings') ||
      !ruc(body.issuerRuc) || !Array.isArray(body.bindings)) return deny(400, 'INVALID_REQUEST');
  if (body.bindings.length > billingCaptureMaxDocuments) return deny(422, 'EXPORT_TOO_LARGE');
  const bindings: BillingCaptureBinding[] = body.bindings.map((binding: unknown) => {
    if (!plain(binding) || Object.keys(binding).length !== keys.length || !keys.every(key => Object.hasOwn(binding, key)) ||
        !['id', 'branchId', 'pointId', 'seriesCounterId'].every(key => uuid(binding[key])) ||
        !supportedSalesTypes.includes(binding.type) || typeof binding.snapshotSha256 !== 'string' ||
        !new RegExp(IntegrationPatterns.sha256).test(binding.snapshotSha256)) return deny(400, 'INVALID_REQUEST');
    return { id: binding.id.toLowerCase(), branchId: binding.branchId.toLowerCase(), pointId: binding.pointId.toLowerCase(),
      seriesCounterId: binding.seriesCounterId.toLowerCase(), type: binding.type, snapshotSha256: binding.snapshotSha256 };
  });
  if (new Set(bindings.map(b => b.id)).size !== bindings.length) return deny(400, 'INVALID_REQUEST');
  return { issuerRuc: body.issuerRuc, bindings };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function requireRows(rows: unknown): asserts rows is any[] {
  if (!Array.isArray(rows) || !Number.isSafeInteger(rows.length)) return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
  if (rows.length > billingCaptureMaxDocuments) return deny(422, 'EXPORT_TOO_LARGE');
}

export class BillingCapture {
  constructor(private readonly repository: BillingCaptureRepository, private readonly identity: ReadIdentity,
    private readonly now: () => number = Date.now) {}

  private async principal(token: string, issuerRuc: string): Promise<ReadPrincipal> {
    const p = await this.identity.authenticate(token, ['integration:documents:read']);
    requireScopes(p, ['integration:documents:read']); requireIssuer(p, issuerRuc);
    return structuredClone(p);
  }

  private async fresh(token: string, context: string) {
    const p = await this.identity.authenticate(token, ['integration:documents:read']);
    requireScopes(p, ['integration:documents:read']);
    if (snapshotHash(p) !== context) return deny(401, 'UNAUTHENTICATED');
  }

  async capture(token: string, query: unknown): Promise<BillingCaptureDTO> {
    let filters: IntegrationDocumentFiltersV1;
    try { filters = parseIntegrationDocumentFilters(query); } catch { return deny(400, 'INVALID_QUERY'); }
    // This owner operation materializes the entire cut; public page limits do not truncate it.
    if (!ruc(filters.issuerRuc) || filters.cursor !== null) return deny(400, 'INVALID_QUERY');
    if (filters.branchId) filters.branchId = filters.branchId.toLowerCase();
    if (filters.pointId) filters.pointId = filters.pointId.toLowerCase();
    const p = await this.principal(token, filters.issuerRuc), context = snapshotHash(p);
    if (filters.fiscalStatus !== null && filters.fiscalStatus !== 'NOT_CHECKED')
      return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
    const rows: BillingCaptureRows = await this.repository.capture(filters, p);
    requireRows(rows);
    // The Prisma adapter provides its transaction clock. Plain synthetic repositories use the injected clock.
    const snapshotAt = rows.snapshotAt ?? new Date(this.now()).toISOString();
    if (typeof snapshotAt !== 'string' || !Number.isFinite(Date.parse(snapshotAt)) || new Date(snapshotAt).toISOString() !== snapshotAt)
      return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
    const result: BillingCaptureDTO = { documents: [], snapshotAt, coverage: coverage(filters, p) };
    if(rows.changeBarrier)result.changeBarrier=rows.changeBarrier;
    const ids = new Set<string>();
    // Include the envelope, array commas and UTF-8 bytes, not just document text length.
    let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    for (const row of rows) {
      if (!['ISSUED', 'CANCELLED'].includes(row?.status)) return deny(409, 'EVIDENCE_INCONSISTENT');
      const document = mapBillingDocument(row, p, filters.issuerRuc, new Date(snapshotAt)).document;
      if (ids.has(document.id.toLowerCase()) || !filters.types.includes(document.type) ||
          document.issueDate < filters.from || document.issueDate > filters.to ||
          (filters.branchId !== null && document.branchId !== filters.branchId) ||
          (filters.pointId !== null && document.pointId !== filters.pointId) ||
          (filters.series !== null && document.series !== filters.series) ||
          (filters.currency !== null && document.currency !== filters.currency)) return deny(409, 'EVIDENCE_INCONSISTENT');
      bytes += Buffer.byteLength(JSON.stringify(document), 'utf8') + (ids.size ? 1 : 0);
      if (bytes > billingCaptureMaxBytes) return deny(422, 'EXPORT_TOO_LARGE');
      ids.add(document.id.toLowerCase()); result.documents.push(document);
    }
    result.documents.sort((a, b) => compare(a.issueDate, b.issueDate) || compare(a.issuedAt ?? '', b.issuedAt ?? '') || compare(a.id, b.id));
    await this.fresh(token, context);
    return result;
  }

  async reauthorize(token: string, body: unknown): Promise<{ valid: true }> {
    const request = parseBindings(body), p = await this.principal(token, request.issuerRuc), context = snapshotHash(p);
    const rows = await this.repository.reauthorize(request.issuerRuc, request.bindings.map(b => b.id));
    requireRows(rows);
    const byId = new Map<string, any>();
    for (const row of rows) {
      if (!uuid(row?.id) || byId.has(row.id.toLowerCase())) return deny(409, 'EVIDENCE_INCONSISTENT');
      byId.set(row.id.toLowerCase(), row);
    }
    const ids = new Set(request.bindings.map(b => b.id));
    if ([...byId.keys()].some(id => !ids.has(id))) return deny(409, 'EVIDENCE_INCONSISTENT');
    for (const binding of request.bindings) {
      const row = byId.get(binding.id);
      if (!row) return deny(404, 'RESOURCE_NOT_FOUND');
      if (!['ISSUED', 'CANCELLED'].includes(row.status)) return deny(409, 'EVIDENCE_INCONSISTENT');
      const document = mapBillingDocument(row, p, request.issuerRuc, new Date(this.now())).document;
      if (document.type !== binding.type || document.branchId !== binding.branchId || document.pointId !== binding.pointId ||
          document.seriesCounterId !== binding.seriesCounterId || document.snapshotSha256 !== binding.snapshotSha256)
        return deny(409, 'EVIDENCE_INCONSISTENT');
    }
    await this.fresh(token, context);
    return { valid: true };
  }
}
