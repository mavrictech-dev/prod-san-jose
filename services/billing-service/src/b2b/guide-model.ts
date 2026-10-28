import type { B2bGuideBinding } from '@factuez/contracts/b2b-guide-security';
import { validB2bBinding } from '@factuez/contracts/b2b-security';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { fiscalDate, fiscalDecimal, fiscalLimaDate, fiscalRuc, fiscalTimestamp } from '@factuez/sunat-core/dist/fiscal-note';

export type GuideParty = { ruc: string; legalName: string };
export type GuideLocation = { ubigeo: string; address: string; establishmentCode: string };
export type GuideTransport =
  | { mode: '01'; carrier: GuideParty & { mtcRegistration: string } }
  | { mode: '02'; vehicle: { plate: string; registration: string }; driver: {
      identityType: '1' | '4'; identityNumber: string; firstName: string; lastName: string; license: string;
    } };
export type GuideBody = {
  issueDate: string;
  transferDate: string;
  reasonCode: string;
  origin: GuideLocation;
  destination: GuideLocation;
  sender: GuideParty;
  recipient: GuideParty;
  grossWeight: string;
  weightUnit: 'KGM' | 'TNE';
  transport: GuideTransport;
  items: { code: string; description: string; quantity: string; unitCode: string }[];
  references: { type: '01' | '03' | '09' | '31'; issuerRuc: string; series: string; number: string }[];
  regulatedGoods: boolean;
};
export type GuideDraft = {
  id: string; clientId: string; actorKey: string; binding: B2bGuideBinding; body: GuideBody;
  /** READY freezes the business payload only; it allocates no fiscal number and proves no acceptance. */
  revision: number; state: 'DRAFT' | 'READY' | 'CANCELLED'; bodySha256: string;
  createdAt: string; updatedAt: string;
};
export type GuideOperation = {
  id: string; requestId: string; clientId: string; actorKey: string; keySha256: string;
  requestSha256: string; draftId: string; action: 'CREATE' | 'PATCH' | 'READY' | 'CANCEL';
  /** Verified owner provenance, not fields accepted from a public draft body. */
  actor: { kind: 'SERVICE' | 'USER'; clientId: string; revision: number; subjectId: string | null; userAuthRevision: number | null };
  grantRevision: number;
  at: string; response: unknown;
};
export interface GuideTransaction {
  get(id: string): Promise<GuideDraft | null>;
  prior(clientId: string, actorKey: string, keySha256: string): Promise<GuideOperation | null>;
  operation(id: string, clientId: string, actorKey: string): Promise<GuideOperation | null>;
  list(clientId: string, actorKey: string, bindings: B2bGuideBinding[], limit: number, after: string | null): Promise<GuideDraft[]>;
  create(draft: GuideDraft): Promise<void>;
  save(draft: GuideDraft, expectedRevision: number): Promise<void>;
  append(op: GuideOperation): Promise<void>;
}
export interface GuideStore {
  transaction<T>(work: (tx: GuideTransaction) => Promise<T>): Promise<T>;
}

const FIELDS = ['issueDate', 'transferDate', 'reasonCode', 'origin', 'destination', 'sender', 'recipient',
  'grossWeight', 'weightUnit', 'transport', 'items', 'references', 'regulatedGoods'] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid(path: string): never { throw new Error(`INVALID_GUIDE_DRAFT:${path}`); }
function object(value: unknown, fields: readonly string[], path: string, partial = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path);
  const row = value as Record<string, unknown>, keys = Object.keys(row);
  if (keys.some(key => !fields.includes(key)) || !partial && fields.some(key => !Object.hasOwn(row, key))) invalid(path);
  return row;
}
function text(value: unknown, max: number, path: string): string {
  if (typeof value !== 'string' || value.length > max || !value.trim() ||
    /[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value)) invalid(path);
  return value.trim();
}
function pattern(value: unknown, expression: RegExp, path: string): string {
  if (typeof value !== 'string' || !expression.test(value)) invalid(path);
  return value;
}
function checked<T>(path: string, work: () => T): T {
  try { return work(); } catch { return invalid(path); }
}
function ruc(value: unknown, path: string): string {
  return checked(path, () => { fiscalRuc(value, path); return value; });
}
function location(value: unknown, path: string): GuideLocation {
  const row = object(value, ['ubigeo', 'address', 'establishmentCode'], path);
  return { ubigeo: pattern(row.ubigeo, /^\d{6}$/, `${path}.ubigeo`),
    address: text(row.address, 500, `${path}.address`),
    establishmentCode: pattern(row.establishmentCode, /^\d{4}$/, `${path}.establishmentCode`) };
}
function party(value: unknown, path: string): GuideParty {
  const row = object(value, ['ruc', 'legalName'], path);
  return { ruc: ruc(row.ruc, `${path}.ruc`), legalName: text(row.legalName, 200, `${path}.legalName`) };
}
function transport(value: unknown): GuideTransport {
  const row = object(value, ['mode', 'carrier', 'vehicle', 'driver'], 'transport', true);
  if (row.mode === '01') {
    object(row, ['mode', 'carrier'], 'transport');
    const carrier = object(row.carrier, ['ruc', 'legalName', 'mtcRegistration'], 'transport.carrier');
    return { mode: '01', carrier: { ruc: ruc(carrier.ruc, 'transport.carrier.ruc'),
      legalName: text(carrier.legalName, 200, 'transport.carrier.legalName'),
      mtcRegistration: text(carrier.mtcRegistration, 20, 'transport.carrier.mtcRegistration') } };
  }
  if (row.mode === '02') {
    object(row, ['mode', 'vehicle', 'driver'], 'transport');
    const vehicle = object(row.vehicle, ['plate', 'registration'], 'transport.vehicle');
    const driver = object(row.driver, ['identityType', 'identityNumber', 'firstName', 'lastName', 'license'], 'transport.driver');
    if (driver.identityType !== '1' && driver.identityType !== '4') invalid('transport.driver.identityType');
    return { mode: '02', vehicle: { plate: pattern(vehicle.plate, /^[A-Z0-9]{6,8}$/, 'transport.vehicle.plate'),
      registration: text(vehicle.registration, 40, 'transport.vehicle.registration') }, driver: {
      identityType: driver.identityType, identityNumber: text(driver.identityNumber, 15, 'transport.driver.identityNumber'),
      firstName: text(driver.firstName, 100, 'transport.driver.firstName'),
      lastName: text(driver.lastName, 100, 'transport.driver.lastName'), license: text(driver.license, 20, 'transport.driver.license') } };
  }
  return invalid('transport.mode');
}
function items(value: unknown): GuideBody['items'] {
  if (!Array.isArray(value) || !value.length || value.length > 100) invalid('items');
  const codes = new Set<string>();
  return value.map((input, index) => {
    const path = `items.${index}`, row = object(input, ['code', 'description', 'quantity', 'unitCode'], path);
    const code = text(row.code, 40, `${path}.code`);
    if (codes.has(code)) invalid(`${path}.duplicateCode`);
    codes.add(code);
    checked(`${path}.quantity`, () => fiscalDecimal(row.quantity, 6, true, `${path}.quantity`));
    return { code, description: text(row.description, 250, `${path}.description`), quantity: row.quantity as string,
      unitCode: pattern(row.unitCode, /^[A-Z0-9]{2,3}$/, `${path}.unitCode`) };
  });
}
function references(value: unknown): GuideBody['references'] {
  if (!Array.isArray(value) || value.length > 20) invalid('references');
  const seen = new Set<string>();
  return value.map((input, index) => {
    const path = `references.${index}`, row = object(input, ['type', 'issuerRuc', 'series', 'number'], path);
    if (!['01', '03', '09', '31'].includes(String(row.type))) invalid(`${path}.type`);
    const issuerRuc = ruc(row.issuerRuc, `${path}.issuerRuc`);
    const series = pattern(row.series, /^[A-Z0-9]{4}$/, `${path}.series`);
    const number = pattern(row.number, /^\d{1,8}$/, `${path}.number`);
    if (BigInt(number) === 0n) invalid(`${path}.number`);
    // Padding is presentation, not a distinct reference identity.
    const key = JSON.stringify([row.type, issuerRuc, series, BigInt(number).toString()]);
    if (seen.has(key)) invalid(`${path}.duplicateReference`);
    seen.add(key);
    return { type: row.type as GuideBody['references'][number]['type'], issuerRuc, series, number };
  });
}
function field(key: typeof FIELDS[number], value: unknown): unknown {
  switch (key) {
    case 'issueDate': return checked(key, () => { fiscalTimestamp(value, key); return new Date(value).toISOString(); });
    case 'transferDate': return checked(key, () => { fiscalDate(value, key); return value; });
    case 'reasonCode': return pattern(value, /^\d{2}$/, key);
    case 'origin': case 'destination': return location(value, key);
    case 'sender': case 'recipient': return party(value, key);
    case 'grossWeight': checked(key, () => fiscalDecimal(value, 3, true, key)); return value;
    case 'weightUnit': if (value !== 'KGM' && value !== 'TNE') invalid(key); return value;
    case 'transport': return transport(value);
    case 'items': return items(value);
    case 'references': return references(value);
    case 'regulatedGoods': if (typeof value !== 'boolean') invalid(key); return value;
  }
}

/** Business drafts only. Codes, parties, references and regulated-goods declarations are NOT
 * verified catalogues, ownership evidence, PKI, regulatory approval or permission to transmit. */
export function parseGuideBody(input: unknown, binding: B2bGuideBinding): GuideBody {
  const safeBinding = checked('binding', () => boundedSupplementJson(binding));
  const pair = object(safeBinding, ['anchor', 'guideSeriesId', 'guideType'], 'binding');
  if (!validB2bBinding(pair.anchor) || typeof pair.guideSeriesId !== 'string' || !UUID.test(pair.guideSeriesId) ||
    pair.guideSeriesId === pair.anchor.seriesId || !['09', '31'].includes(String(pair.guideType))) invalid('binding');
  ruc(pair.anchor.issuerRuc, 'binding.anchor.issuerRuc');
  const row = object(checked('body', () => boundedSupplementJson(input)), FIELDS, 'body');
  const body = Object.fromEntries(FIELDS.map(key => [key, field(key, row[key])])) as GuideBody;
  if (body.transferDate < fiscalLimaDate(body.issueDate)) invalid('transferDate.beforeIssueDateLima');
  if (pair.guideType === '09' && body.sender.ruc !== pair.anchor.issuerRuc) invalid('sender.anchorMismatch');
  if (pair.guideType === '31') {
    if (body.transport.mode !== '01') invalid('transport.publicCarrierRequired');
    if (body.transport.carrier.ruc !== pair.anchor.issuerRuc) invalid('transport.carrier.anchorMismatch');
    if (!body.references.some(reference => reference.type === '09')) invalid('references.remitterRequired');
  }
  return body;
}

/** Top-level replacement patch, not a nested merge. No null removals, default values or inferred
 * dates. The owner MUST parseGuideBody({...prior.body, ...patch}, binding) before saving. */
export function parseGuidePatch(input: unknown): Partial<GuideBody> {
  const row = object(checked('patch', () => boundedSupplementJson(input)), FIELDS, 'patch', true);
  return Object.fromEntries(Object.keys(row).map(key => [key, field(key as typeof FIELDS[number], row[key])])) as Partial<GuideBody>;
}
