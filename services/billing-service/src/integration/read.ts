import { createHash } from 'node:crypto';
import { IntegrationContractVersion, IntegrationFiscalStates, IntegrationPatterns, integrationGrantAllows,
  parseIntegrationFiscalKey, type IntegrationDocumentDetailV1, type IntegrationPartyV1,
  type IntegrationBranchV1, type IntegrationIssuerV1, type IntegrationPointV1 } from '@factuez/contracts/integration';
import { deny, plain, ruc, uuid, requireIssuer, requireScopes, snapshotHash,
  type ReadPrincipal, type ReadIdentity, type BillingReadEnvelope } from '@factuez/service-access/dist/integration';

const types = { INVOICE: '01', SALES_RECEIPT: '03', CREDIT_NOTE: '07', DEBIT_NOTE: '08' } as const;
type SalesType = typeof types[keyof typeof types];
export const supportedSalesTypes = Object.values(types);
export interface BillingReadRepository {
  document(issuerRuc: string, key: { id: string } | { type: SalesType; series: string; number: bigint }): Promise<any | null>;
  catalog(issuerRuc: string): Promise<BillingCatalog | null>;
  batch(issuerRuc: string, id: string): Promise<{identifier:string;items:{documentId:string;conditionCode:string}[]}|null>;
}
export interface BillingCatalog { issuer: IntegrationIssuerV1; branches: IntegrationBranchV1[]; points: IntegrationPointV1[]; observedAt: string }
const text = (v: unknown): string | null => v == null ? null : typeof v === 'string' && v.length <= 10000 ? v : deny(409,'EVIDENCE_INCONSISTENT');
const decimal = (v: unknown): string | null => v == null ? null : typeof v === 'string' && new RegExp(IntegrationPatterns.decimal).test(v) ? v : deny(409,'EVIDENCE_INCONSISTENT');
function party(v: unknown): IntegrationPartyV1 {
  if (!plain(v)) return deny(409,'INCOMPLETE_BINDING');
  return { identityType: text(v.identityType), identityNumber: text(v.identityNumber), legalName: text(v.legalName),
    address: text(v.address), ubigeo: text(v.ubigeo), establishmentCode: text(v.establishmentCode) };
}
const at = (v: Date | string) => { const d = new Date(v); if (!Number.isFinite(d.getTime())) return deny(409,'EVIDENCE_INCONSISTENT'); return d.toISOString(); };
export function mapBillingDocument(row: any, p: ReadPrincipal, issuerRuc: string, now = new Date()): BillingReadEnvelope {
  requireScopes(p,['integration:documents:read']); requireIssuer(p,issuerRuc);
  if (!row || row.company?.ruc !== issuerRuc || !ruc(issuerRuc)) return deny(404,'RESOURCE_NOT_FOUND');
  const type = types[row.type as keyof typeof types];
  if (!type) return deny(422,'SOURCE_NOT_SUPPORTED');
  if (typeof row.series!=='string' || !new RegExp(IntegrationPatterns.series).test(row.series)) return deny(409,'EVIDENCE_INCONSISTENT');
  const point = row.emissionPoint, counter = row.seriesCounter;
  if (!point || !counter || !uuid(row.id) || !uuid(point.id) || !uuid(counter.id) || !uuid(point.branchId) ||
    point.companyId !== row.companyId || point.branch?.companyId !== row.companyId ||
    counter.companyId !== row.companyId || counter.emissionPointId !== point.id || counter.documentType !== row.type || counter.series !== row.series)
    return deny(409,'INCOMPLETE_BINDING');
  const resource = { issuerRuc, environment: 'BETA' as const, dataset: 'ISSUED_BUSINESS' as const, type,
    branchId: point.branchId, pointId: point.id, seriesCounterId: counter.id };
  if (!integrationGrantAllows(p.grants,resource)) return deny(404,'RESOURCE_NOT_FOUND');
  const s = row.immutableSnapshot;
  if (!plain(s) || s.environment !== 'BETA' || s.documentId !== row.id || s.companyId !== row.companyId ||
    s.branchId !== point.branchId || s.documentTypeCode !== type || s.series !== row.series || !plain(s.issuer) ||
    s.issuer.identityNumber !== issuerRuc || typeof s.number !== 'string' || !new RegExp(IntegrationPatterns.number).test(s.number) ||
    BigInt(s.number) !== BigInt(row.number) || typeof s.fullNumber !== 'string' || s.fullNumber !== row.fullNumber ||
    !new RegExp('^'+row.series+'-[0-9]{1,20}$').test(s.fullNumber) || BigInt(s.fullNumber.slice(5)) !== BigInt(row.number))
    return deny(409,'EVIDENCE_INCONSISTENT');
  const issuer = party(s.issuer), customer = party(s.customer);
  if (!issuer.legalName || !customer.legalName || !Array.isArray(s.lines) || !s.lines.length || s.lines.length > 10000 || !plain(s.totals))
    return deny(409,'INCOMPLETE_BINDING');
  const lines = s.lines.map((line: unknown) => {
    if (!plain(line) || !Number.isSafeInteger(line.lineNumber) || line.lineNumber < 1 || !text(line.description)) return deny(409,'EVIDENCE_INCONSISTENT');
    return { lineId: String(line.lineNumber), productCode: text(line.productCode), description: line.description as string,
      unitCode: text(line.unitCode), quantity: decimal(line.quantity), unitValue: decimal(line.unitValue),
      unitPriceWithTax: decimal(line.unitPriceWithTax), lineExtensionAmount: decimal(line.lineExtensionAmount),
      taxes: [{ schemeId: null, name: 'IGV', taxableAmount: decimal(line.lineExtensionAmount), amount: decimal(line.igvAmount),
        percent: decimal(line.igvRate), affectationCode: text(line.taxAffectationCode) }], allowances: [] };
  });
  if (new Set(lines.map(l=>l.lineId)).size !== lines.length) return deny(409,'EVIDENCE_INCONSISTENT');
  const totals = { lineExtensionAmount: decimal(s.totals.lineExtensionAmount), taxableAmount: decimal(s.totals.taxableAmount),
    exemptAmount: decimal(s.totals.exemptAmount), unaffectedAmount: decimal(s.totals.unaffectedAmount), freeAmount: decimal(s.totals.freeAmount),
    igvAmount: decimal(s.totals.igvAmount), iscAmount: decimal(s.totals.iscAmount), otherTaxesAmount: decimal(s.totals.otherTaxesAmount),
    allowanceTotalAmount: decimal(s.totals.allowanceTotalAmount), chargeTotalAmount: decimal(s.totals.chargeTotalAmount),
    prepaidAmount: decimal(s.totals.prepaidAmount), payableAmount: decimal(s.totals.payableAmount) };
  // Frozen values are authoritative. Missing fields remain null, not invented zeros.
  if (!totals.payableAmount || row.payableAmount.toString() !== totals.payableAmount.replace(/\.0+$/,'')) {
    // Decimal scale is insignificant; compare fixed-point strings without floating point.
    const normalized = (x: string) => x.includes('.') ? x.replace(/0+$/,'').replace(/\.$/,'') : x;
    if (!totals.payableAmount || normalized(row.payableAmount.toString()) !== normalized(totals.payableAmount)) return deny(409,'EVIDENCE_INCONSISTENT');
  }
  const timestamp = at(s.issueDate);
  if (timestamp !== at(row.issueDate)) return deny(409,'EVIDENCE_INCONSISTENT');
  const lima = new Date(Date.parse(timestamp)-5*3600000).toISOString();
  const snapshotSha256 = snapshotHash(s), observedAt = now.toISOString();
  const payment = s.paymentTerms;
  if (payment != null && (!plain(payment) || !['CONTADO','CREDITO'].includes(payment.type))) return deny(409,'EVIDENCE_INCONSISTENT');
  const installments = payment?.installments ?? [];
  if (!Array.isArray(installments) || installments.length > 1000) return deny(409,'EVIDENCE_INCONSISTENT');
  const reference = s.reference;
  if (['07','08'].includes(type) && (!plain(reference) || !['01','03'].includes(reference.documentTypeCode) || !text(reference.fullNumber)))
    return deny(409,'INCOMPLETE_BINDING');
  const transport = IntegrationFiscalStates.includes(row.sunatStatus) ? row.sunatStatus : null;
  const document: IntegrationDocumentDetailV1 = { ...resource, schemaVersion: IntegrationContractVersion, id: row.id,
    series: s.series, number: s.number, fullNumber: s.fullNumber, snapshotSha256,
    resourceVersion: createHash('sha256').update(JSON.stringify([snapshotSha256,at(row.updatedAt),row.status,row.sunatStatus])).digest('hex'),
    observedAt, issuerName: issuer.legalName, issueDate: lima.slice(0,10), issueTime: lima.slice(11,19), issuedAt: timestamp,
    currency: ['PEN','USD'].includes(s.currencyCode) ? s.currencyCode : null, customer, payableAmount: totals.payableAmount,
    state: { local: ['DRAFT','ISSUED','CANCELLED'].includes(row.status) ? row.status : null, fiscal: 'NOT_CHECKED', transport,
      provenance: 'LOCAL', verifiedAt: null, responseCode: text(row.sunatResponseCode) },
    source: { system: 'BILLING', originSystem: text(row.originSystem), originId: text(row.originId) },
    warnings: ['FISCAL_STATE_IS_UNVERIFIED_PROJECTION','ORIGINAL_XML_SIGNATURE_AND_TRUST_NOT_VERIFIED','SNAPSHOT_PROFILE_FIELDS_ONLY'],
    detail: { kind: 'SALE', issuer, customer, operationTypeCode: text(s.operationTypeCode), items: lines, allowances: [],
      taxes: [{ schemeId: null, name: 'IGV', taxableAmount: totals.taxableAmount, amount: totals.igvAmount, percent: null, affectationCode: null }], totals,
      paymentTerms: { type: payment?.type ?? null, pendingAmount: decimal(payment?.pendingAmount), installments: installments.map((i: unknown) => {
        if (!plain(i) || !decimal(i.amount) || !/^\d{4}-\d{2}-\d{2}$/.test(i.dueDate)) return deny(409,'EVIDENCE_INCONSISTENT');
        return { amount: i.amount as string, dueDate: i.dueDate as string };
      }) },
      references: reference ? [{ documentId: null, type: reference.documentTypeCode, fullNumber: reference.fullNumber,
        kind: 'MODIFIED_DOCUMENT', reasonCode: text(s.reasonCode), reason: text(s.reasonDescription) }] : [],
      observations: text(s.observations), additionalInformation: [] } };
  return { document };
}
export class BillingRead {
  constructor(private readonly repository: BillingReadRepository, private readonly identity: ReadIdentity) {}
  async document(token: string, issuerRuc: string, id: string) {
    if (!uuid(id) || !ruc(issuerRuc)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const p = await this.identity.authenticate(token,['integration:documents:read']); requireIssuer(p,issuerRuc);
    return mapBillingDocument(await this.repository.document(issuerRuc,{id}),p,issuerRuc);
  }
  async lookup(token: string, query: Record<string,string>) {
    let key; try { key = parseIntegrationFiscalKey(query); } catch { return deny(400,'INVALID_QUERY'); }
    const p = await this.identity.authenticate(token,['integration:documents:read']); requireIssuer(p,key.issuerRuc);
    if (!supportedSalesTypes.includes(key.type as SalesType)) return deny(422,'SOURCE_NOT_SUPPORTED');
    return mapBillingDocument(await this.repository.document(key.issuerRuc,{type:key.type as SalesType,series:key.series,number:BigInt(key.number)}),p,key.issuerRuc);
  }
  async catalog(token: string, issuerRuc: string) {
    const p = await this.identity.authenticate(token,['integration:catalog:read']); requireIssuer(p,issuerRuc);
    const c = await this.repository.catalog(issuerRuc); if (!c) return deny(404,'RESOURCE_NOT_FOUND');
    const selected = (selection: {kind:'ALL'}|{kind:'IDS';ids:string[]}, id: string) => selection.kind === 'ALL' || selection.ids.includes(id);
    const points = c.points.map(point => ({...point,series:point.series.filter(series=>p.grants.some(g=>g.issuerRuc===issuerRuc &&
      g.documentTypes.includes(series.type) && selected(g.branches,point.branchId) && selected(g.points,point.id) && selected(g.series,series.id)))})).filter(point=>point.series.length);
    const ids = new Set(points.map(point=>point.branchId));
    return { ...c, branches:c.branches.filter(b=>ids.has(b.id)),points };
  }
  async batch(token: string, issuerRuc: string, id: string) {
    if (!uuid(id)) return deny(400,'INVALID_QUERY');
    id=id.toLowerCase();
    const p=await this.identity.authenticate(token,['integration:documents:read']); requireIssuer(p,issuerRuc);
    const batch=await this.repository.batch(issuerRuc,id);
    if (!batch) return deny(404,'RESOURCE_NOT_FOUND');
    if (!batch.items.length || batch.items.length>10000 || new Set(batch.items.map(i=>i.documentId)).size!==batch.items.length)
      return deny(409,'INCOMPLETE_BINDING');
    for (const item of batch.items) await this.document(token,issuerRuc,item.documentId);
    return batch;
  }
}
