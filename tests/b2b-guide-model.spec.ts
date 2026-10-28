import { describe, expect, it, vi } from 'vitest';
import type { B2bGuideBinding } from '../packages/contracts/src/b2b-guide-security';
import {
  parseGuideBody, parseGuidePatch, type GuideBody, type GuideDraft, type GuideOperation,
  type GuideStore, type GuideTransaction,
} from '../services/billing-service/src/b2b/guide-model';

// Checksum-valid synthetic identifiers. All parties, addresses and permits are fictional.
const RUC = '20000000001', OTHER = '20000000010';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function binding(type: '09' | '31' = '09'): B2bGuideBinding {
  return { anchor: { issuerId: 1, issuerRuc: RUC, environment: 'BETA', branchId: uuid(1),
    pointId: uuid(2), seriesId: uuid(3), documentType: '01' }, guideSeriesId: uuid(4), guideType: type };
}
function body(): GuideBody {
  return { issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
    destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
    sender: { ruc: RUC, legalName: 'REMITENTE FICTICIO' }, recipient: { ruc: OTHER, legalName: 'DESTINATARIO FICTICIO' },
    grossWeight: '1.250', weightUnit: 'KGM', transport: { mode: '01', carrier: {
      ruc: RUC, legalName: 'TRANSPORTISTA FICTICIO', mtcRegistration: 'MTC-FICTICIO' } },
    items: [{ code: 'ITEM-1', description: 'ARTICULO FICTICIO', quantity: '2.000001', unitCode: 'NIU' }],
    references: [{ type: '09', issuerRuc: RUC, series: 'T001', number: '00000001' }], regulatedGoods: false };
}
function privateTransport(): GuideBody['transport'] {
  return { mode: '02', vehicle: { plate: 'ABC123', registration: 'REGISTRO FICTICIO' }, driver: {
    identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR', lastName: 'FICTICIO', license: 'LICENCIA FICTICIA' } };
}
function set(row: any, path: string, value: unknown) {
  const parts = path.split('.');
  for (const key of parts.slice(0, -1)) row = row[key];
  row[parts.at(-1)!] = value;
}
function remove(row: any, path: string) {
  const parts = path.split('.');
  for (const key of parts.slice(0, -1)) row = row[key];
  delete row[parts.at(-1)!];
}
const required = ['issueDate', 'transferDate', 'reasonCode', 'origin', 'destination', 'sender', 'recipient',
  'grossWeight', 'weightUnit', 'transport', 'items', 'references', 'regulatedGoods'];

describe('guide business draft model: pure, detached, no fiscal generation', () => {
  it.each(['09', '31'] as const)('parses guide %s with explicit values only', type => {
    const original = body(), result = parseGuideBody(original, binding(type));
    expect(result).toEqual(original); expect(result).not.toBe(original);
    expect(result.transport).not.toBe(original.transport);
    expect(result.items[0]).not.toBe(original.items[0]);
    expect(result.references[0]).not.toBe(original.references[0]);
    expect(Object.keys(result).sort()).toEqual(required.sort());
  });
  it('normalizes timezone to UTC and trims text without inventing values', () => {
    const input = body(); input.issueDate = '2026-10-21T10:30:00-05:00';
    input.origin.address = '  DIRECCION FICTICIA  '; input.items[0].code = ' ITEM-1 ';
    const result = parseGuideBody(input, binding());
    expect(result.issueDate).toBe('2026-10-21T15:30:00.000Z');
    expect(result.origin.address).toBe('DIRECCION FICTICIA'); expect(result.items[0].code).toBe('ITEM-1');
    expect(input.origin.address).toBe('  DIRECCION FICTICIA  ');
    expect(result.grossWeight).toBe('1.250'); expect(result.references[0].number).toBe('00000001');
  });
  it('detaches in both directions', () => {
    const input = body(), result = parseGuideBody(input, binding());
    input.sender.legalName = 'MUTACION'; expect(result.sender.legalName).toBe('REMITENTE FICTICIO');
    result.items[0].description = 'OTRA'; expect(input.items[0].description).toBe('ARTICULO FICTICIO');
  });
  it.each(['1', '4'] as const)('allows private transport and declared driver identity %s for 09', type => {
    const input = body(); input.transport = privateTransport();
    if (input.transport.mode === '02') input.transport.driver.identityType = type;
    expect(parseGuideBody(input, binding()).transport).toEqual(input.transport);
  });
  it('allows an unrelated sender for 31 when the carrier owns the anchor', () => {
    const input = body(); input.sender.ruc = OTHER;
    expect(parseGuideBody(input, binding('31')).sender.ruc).toBe(OTHER);
  });
  it('does not assert a complete catalogue, reference ownership or goods approval', () => {
    const input = body(); input.reasonCode = '99'; input.origin.ubigeo = '999999'; input.regulatedGoods = true;
    input.references[0].issuerRuc = OTHER;
    expect(parseGuideBody(input, binding('31'))).toEqual(input);
  });
  it('permits empty references for 09, but not 31', () => {
    const input = body(); input.references = [];
    expect(parseGuideBody(input, binding()).references).toEqual([]);
    expect(() => parseGuideBody(input, binding('31'))).toThrow(/remitterRequired/);
  });
  it.each(required)('requires explicit %s (no defaults)', key => {
    const input: any = body(); delete input[key];
    expect(() => parseGuideBody(input, binding())).toThrow();
  });
  it.each(required)('forbids null in %s', key => {
    const input: any = body(); input[key] = null;
    expect(() => parseGuideBody(input, binding())).toThrow();
    expect(() => parseGuidePatch({ [key]: null })).toThrow();
  });
  it.each(['accepted', 'certificate', 'signedXml', 'cdr', 'number', 'series', 'environment', 'transmissionAuthorized', 'foo'])
    ('rejects unknown top-level field %s in body and patch', key => {
      expect(() => parseGuideBody({ ...body(), [key]: true }, binding())).toThrow();
      expect(() => parseGuidePatch({ [key]: true })).toThrow();
    });
  it.each(['origin', 'destination', 'sender', 'recipient', 'transport', 'transport.carrier', 'items.0', 'references.0'])
    ('rejects unknown nested field in %s', path => {
      const input = body(); set(input, `${path}.accepted`, true);
      expect(() => parseGuideBody(input, binding())).toThrow();
    });
  it.each(['origin.ubigeo', 'origin.address', 'origin.establishmentCode', 'destination.ubigeo',
    'sender.ruc', 'sender.legalName', 'recipient.ruc', 'recipient.legalName', 'transport.carrier.ruc',
    'transport.carrier.legalName', 'transport.carrier.mtcRegistration', 'items.0.code', 'items.0.description',
    'items.0.quantity', 'items.0.unitCode', 'references.0.type', 'references.0.issuerRuc', 'references.0.series', 'references.0.number'])
    ('rejects missing nested %s', path => {
      const input = body(); remove(input, path); expect(() => parseGuideBody(input, binding())).toThrow();
    });

  const badValues: [string, unknown][] = [
    ['reasonCode', '1'], ['reasonCode', '001'], ['reasonCode', 4], ['reasonCode', 'AA'],
    ['origin.ubigeo', '15010'], ['origin.ubigeo', '1501011'], ['origin.ubigeo', 'ABCDEF'],
    ['origin.establishmentCode', '001'], ['origin.establishmentCode', '00001'],
    ['origin.address', ''], ['origin.address', ' '], ['origin.address', 'a'.repeat(501)],
    ['sender.ruc', '20000000002'], ['recipient.ruc', '00000000000'], ['sender.ruc', 20000000001],
    ['sender.legalName', 'a'.repeat(201)], ['recipient.legalName', ''],
    ['grossWeight', '0'], ['grossWeight', '0.000'], ['grossWeight', '-1'], ['grossWeight', '+1'],
    ['grossWeight', '01'], ['grossWeight', '1.0001'], ['grossWeight', '1e3'], ['grossWeight', 1],
    ['grossWeight', '1000000000000'], ['grossWeight', '.1'], ['grossWeight', '1.'],
    ['weightUnit', 'kg'], ['weightUnit', 'LTR'], ['regulatedGoods', 'false'], ['regulatedGoods', 0],
    ['transport.mode', '03'], ['transport.mode', 1], ['transport.carrier.ruc', OTHER.slice(1)],
    ['transport.carrier.mtcRegistration', 'a'.repeat(21)], ['transport.carrier.mtcRegistration', ''],
    ['items.0.code', 'a'.repeat(41)], ['items.0.description', 'a'.repeat(251)],
    ['items.0.quantity', '0'], ['items.0.quantity', '0.000000'], ['items.0.quantity', '1.0000001'],
    ['items.0.quantity', '-1'], ['items.0.quantity', 2], ['items.0.unitCode', 'niu'],
    ['items.0.unitCode', 'N'], ['items.0.unitCode', 'NIUU'], ['items.0.unitCode', 'N U'],
    ['references.0.type', '07'], ['references.0.type', 9], ['references.0.issuerRuc', '20000000002'],
    ['references.0.series', 't001'], ['references.0.series', 'T01'], ['references.0.series', 'T0001'],
    ['references.0.number', '0'], ['references.0.number', '00000000'], ['references.0.number', '-1'],
    ['references.0.number', '1.0'], ['references.0.number', '100000000'], ['references.0.number', 1],
  ];
  it.each(badValues)('rejects invalid %s = %j', (path, value) => {
    const input = body(); set(input, path, value);
    expect(() => parseGuideBody(input, binding())).toThrow();
    const key = path.split('.')[0] as keyof GuideBody;
    expect(() => parseGuidePatch({ [key]: input[key] })).toThrow();
  });
  it.each(['issueDate', 'transferDate', 'sender.legalName', 'items.0.description', 'origin.address'])
    ('rejects control characters in %s', path => {
      const input = body(); set(input, path, 'bad\u0000value'); expect(() => parseGuideBody(input, binding())).toThrow();
    });
  it.each(['2026-02-29T12:00:00Z', '2026-10-21', '2026-10-21T25:00:00Z', '2026-10-21T12:00:60Z',
    '2026-10-21T12:00:00', '2026-10-21T12:00:00+14:01', '2026-10-21T12:00:00+05:60', '2026-13-01T12:00:00Z'])
    ('rejects invalid calendar/timestamp %s', date => {
      expect(() => parseGuideBody({ ...body(), issueDate: date }, binding())).toThrow();
      expect(() => parseGuidePatch({ issueDate: date })).toThrow();
    });
  it.each(['2026-02-29', '2026-04-31', '2026-00-01', '2026-10-21T00:00:00Z', '2026-1-1'])
    ('rejects invalid transfer date %s', date => {
      expect(() => parseGuidePatch({ transferDate: date })).toThrow();
    });
  it('compares transfer with Lima calendar, not UTC date', () => {
    const input = body(); input.issueDate = '2026-10-22T04:59:59Z';
    expect(parseGuideBody(input, binding()).transferDate).toBe('2026-10-21');
    input.issueDate = '2026-10-22T05:00:00Z';
    expect(() => parseGuideBody(input, binding())).toThrow(/beforeIssueDateLima/);
  });
  it('accepts a leap day and a future transfer without inventing a time limit', () => {
    const input = body(); input.issueDate = '2028-02-29T12:00:00Z'; input.transferDate = '2028-03-01';
    expect(parseGuideBody(input, binding()).transferDate).toBe('2028-03-01');
  });
  it.each(['KGM', 'TNE'] as const)('accepts explicit weight unit %s and smallest positive amounts', unit => {
    const input = body(); input.weightUnit = unit; input.grossWeight = '0.001'; input.items[0].quantity = '0.000001';
    expect(parseGuideBody(input, binding()).weightUnit).toBe(unit);
  });
  it.each(['01', '03', '09', '31'] as const)('allows declared reference type %s without claiming verification', type => {
    const input = body(); input.references[0].type = type;
    expect(parseGuideBody(input, binding()).references[0].type).toBe(type);
  });
  it('enforces 100 items and 20 references inclusive', () => {
    const input = body(); input.items = Array.from({ length: 100 }, (_, i) => ({ ...input.items[0], code: `I-${i}` }));
    input.references = Array.from({ length: 20 }, (_, i) => ({ ...input.references[0], number: String(i + 1) }));
    expect(parseGuideBody(input, binding()).items).toHaveLength(100);
    input.items.push({ ...input.items[0], code: 'I-101' }); expect(() => parseGuideBody(input, binding())).toThrow();
    input.items.pop(); input.references.push({ ...input.references[0], number: '21' });
    expect(() => parseGuideBody(input, binding())).toThrow();
    input.items = []; expect(() => parseGuideBody(input, binding())).toThrow();
  });
  it('rejects normalized duplicate item codes and padded duplicate references', () => {
    const input = body(); input.items.push({ ...input.items[0], code: ' ITEM-1 ' });
    expect(() => parseGuideBody(input, binding())).toThrow(/duplicateCode/);
    input.items.pop(); input.references.push({ ...input.references[0], number: '1' });
    expect(() => parseGuideBody(input, binding())).toThrow(/duplicateReference/);
  });
  it('keeps distinct reference types and issuers separate', () => {
    const input = body(); input.references.push({ ...input.references[0], type: '31' }, { ...input.references[0], issuerRuc: OTHER });
    expect(parseGuideBody(input, binding()).references).toHaveLength(3);
  });
  it.each(['transport', 'sender', 'references'] as const)('enforces full-body 31 constraints after merging %s patch', key => {
    const input = body(); const patch = key === 'transport' ? { transport: privateTransport() }
      : key === 'sender' ? { transport: { mode: '01', carrier: { ruc: OTHER, legalName: 'FICTICIO', mtcRegistration: 'FICTICIO' } } }
        : { references: [{ type: '01', issuerRuc: RUC, series: 'F001', number: '1' }] };
    const parsed = parseGuidePatch(patch); expect(() => parseGuideBody({ ...input, ...parsed }, binding('31'))).toThrow();
  });
  it('enforces 09 sender binding, but does not confuse recipient or carrier with sender', () => {
    const input = body(); input.sender.ruc = OTHER;
    expect(() => parseGuideBody(input, binding())).toThrow(/sender.anchorMismatch/);
    input.sender.ruc = RUC;
    if (input.transport.mode === '01') input.transport.carrier.ruc = OTHER;
    expect(parseGuideBody(input, binding()).recipient.ruc).toBe(OTHER);
  });
  it.each(['ABC123', 'ABC1234', 'ABC12345'])('accepts private plate length %s', plate => {
    const input = body(); input.transport = privateTransport();
    if (input.transport.mode === '02') input.transport.vehicle.plate = plate;
    expect(parseGuideBody(input, binding()).transport).toEqual(input.transport);
  });
  it.each([
    ['vehicle.plate', 'ABC12'], ['vehicle.plate', 'ABC123456'], ['vehicle.plate', 'abc123'], ['vehicle.plate', 'ABC-123'],
    ['vehicle.registration', ''], ['vehicle.registration', 'a'.repeat(41)], ['driver.identityType', '6'],
    ['driver.identityNumber', 'a'.repeat(16)], ['driver.firstName', 'a'.repeat(101)],
    ['driver.lastName', ''], ['driver.license', 'a'.repeat(21)], ['driver.accepted', true],
  ])('rejects private transport invalid %s', (path, value) => {
    const input = body(); input.transport = privateTransport(); set(input.transport, path as string, value);
    expect(() => parseGuideBody(input, binding())).toThrow();
  });
  it('rejects mixed transport shapes', () => {
    const input: any = body(); input.transport.driver = (privateTransport() as any).driver;
    expect(() => parseGuideBody(input, binding())).toThrow();
    input.transport = privateTransport(); input.transport.carrier = body().transport;
    expect(() => parseGuideBody(input, binding())).toThrow();
  });

  it.each(['anchor', 'guideSeriesId', 'guideType'])('rejects incomplete guide binding %s', key => {
    const b: any = binding(); delete b[key]; expect(() => parseGuideBody(body(), b)).toThrow();
  });
  it.each([
    ['guideType', '01'], ['guideType', 9], ['guideSeriesId', 'not-uuid'], ['guideSeriesId', uuid(3)],
    ['anchor.environment', 'PRODUCTION'], ['anchor.issuerRuc', '20000000002'], ['anchor.documentType', '09'],
    ['anchor.pointId', 'x'], ['anchor.issuerId', 0], ['anchor.issuerId', 1.5], ['foo', true],
  ])('rejects invalid guide binding %s', (path, value) => {
    const b = binding(); set(b, path as string, value); expect(() => parseGuideBody(body(), b)).toThrow();
  });
  it('supports a 03 anchor without broadening the base binding vocabulary', () => {
    const b = binding(); b.anchor.documentType = '03'; expect(parseGuideBody(body(), b)).toEqual(body());
  });
});

describe('guide patches are detached, bounded top-level replacements', () => {
  it('validates every supplied field and leaves omitted fields absent', () => {
    const input = body(); const patch = parseGuidePatch({ origin: input.origin, regulatedGoods: true });
    expect(patch).toEqual({ origin: input.origin, regulatedGoods: true });
    expect(patch.origin).not.toBe(input.origin); expect(patch).not.toHaveProperty('issueDate');
    expect(parseGuidePatch({})).toEqual({});
  });
  it('normalizes full-body patches consistently', () => {
    expect(parseGuidePatch(body())).toEqual(parseGuideBody(body(), binding()));
  });
  it('does not accept incomplete nested merge patches', () => {
    expect(() => parseGuidePatch({ sender: { legalName: 'FICTICIO' } })).toThrow();
    expect(() => parseGuidePatch({ transport: { mode: '02' } })).toThrow();
  });
  it('defers cross-field checks to the mandatory final merged-body parser', () => {
    const patch = parseGuidePatch({ transferDate: '2026-10-20' });
    expect(patch.transferDate).toBe('2026-10-20');
    expect(() => parseGuideBody({ ...body(), ...patch }, binding())).toThrow();
  });
});

describe('bounded guide JSON boundary rejects executable and exotic input before traversal', () => {
  it.each([undefined, null, true, 1, 'body', [], new Date(), new Map(), new Set(), () => body()])
    ('rejects non-record input %j', value => {
      expect(() => parseGuideBody(value, binding())).toThrow(); expect(() => parseGuidePatch(value)).toThrow();
    });
  it('never invokes getters in body, patch, nested values or binding', () => {
    const getter = vi.fn(() => 'value');
    const top = Object.defineProperty(body(), 'issueDate', { enumerable: true, get: getter });
    const nested = body(); Object.defineProperty(nested.sender, 'legalName', { enumerable: true, get: getter });
    const b = binding(); Object.defineProperty(b.anchor, 'issuerRuc', { enumerable: true, get: getter });
    for (const value of [top, nested]) {
      expect(() => parseGuideBody(value, binding())).toThrow(); expect(() => parseGuidePatch(value)).toThrow();
    }
    expect(() => parseGuideBody(body(), b)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('rejects proxies without invoking traps', () => {
    const trap = vi.fn(() => { throw new Error('must not execute'); });
    const proxy = new Proxy(body(), { get: trap, ownKeys: trap });
    expect(() => parseGuideBody(proxy, binding())).toThrow(); expect(() => parseGuidePatch(proxy)).toThrow();
    expect(() => parseGuideBody(body(), new Proxy(binding(), { get: trap, ownKeys: trap }))).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
  it('rejects cycles, symbols, hidden fields, pollution keys and custom prototypes', () => {
    const cycle: any = body(); cycle.origin = cycle;
    const hidden = Object.defineProperty(body(), 'hidden', { value: true });
    const symbol = { ...body(), [Symbol('hidden')]: true };
    const pollution = JSON.parse(JSON.stringify(body()).replace('"regulatedGoods":false', '"regulatedGoods":false,"__proto__":{}'));
    const custom = Object.assign(Object.create({ inherited: true }), body());
    for (const value of [cycle, hidden, symbol, pollution, custom]) {
      expect(() => parseGuideBody(value, binding())).toThrow(); expect(() => parseGuidePatch(value)).toThrow();
    }
  });
  it('rejects sparse arrays, array properties, nested functions and unbounded strings', () => {
    const sparse = body(); sparse.items.length = 2;
    const extra = body(); (extra.items as any).extra = true;
    const fn = body(); (fn.items[0] as any).description = () => 'value';
    const huge = body(); huge.sender.legalName = 'x'.repeat(20000);
    for (const value of [sparse, extra, fn, huge]) expect(() => parseGuideBody(value, binding())).toThrow();
  });
  it('accepts inert null-prototype objects then returns ordinary detached JSON', () => {
    const input = Object.assign(Object.create(null), body());
    expect(Object.getPrototypeOf(parseGuideBody(input, binding()))).toBe(Object.prototype);
  });
});

it('exposes the agreed draft, operation and owner transaction contracts without a runtime store', async () => {
  const draft: GuideDraft = { id: uuid(10), clientId: uuid(11), actorKey: 'SERVICE:FICTIONAL', binding: binding(),
    body: body(), revision: 1, state: 'DRAFT', bodySha256: 'a'.repeat(64),
    createdAt: body().issueDate, updatedAt: body().issueDate };
  const op: GuideOperation = { id: uuid(12), requestId: uuid(13), clientId: draft.clientId, actorKey: draft.actorKey,
    keySha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), draftId: draft.id, action: 'CREATE',
    actor: { kind: 'SERVICE', clientId: draft.clientId, revision: 3, subjectId: null, userAuthRevision: null },
    grantRevision: 2, at: draft.createdAt, response: draft };
  const tx: GuideTransaction = {
    get: async () => draft, prior: async () => op, operation: async () => op,
    list: async () => [draft], create: async () => {}, save: async () => {}, append: async () => {},
  };
  const store: GuideStore = { transaction: async work => work(tx) };
  expect(await store.transaction(t => t.get(draft.id))).toBe(draft);
  expect(await tx.list(draft.clientId, draft.actorKey, [draft.binding], 20, null)).toEqual([draft]);
  expect((await tx.operation(op.id, draft.clientId, draft.actorKey))?.actor).toEqual(op.actor);
  expect((await tx.prior(draft.clientId, draft.actorKey, op.keySha256))?.grantRevision).toBe(2);
});
