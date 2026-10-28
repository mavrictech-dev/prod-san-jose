import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import type { B2bGuideBinding } from '../packages/contracts/src/b2b-guide-security';
import {
  GUIDE_PREPARATION_GATES, validateGuidePreparationResponse, type GuidePreparationResponse,
} from '../packages/service-access/src/b2b-guide-preparation-wire';
import * as guideCore from '../packages/sunat-core/src/fiscal-guide-preparation';
import { guidePreparationInput } from './helpers/guide-preparation.fixture';

// Entirely synthetic, pure wire integrity tests. No HTTP, owner services, QA,
// certificates, customer records, SUNAT calls or fiscal activation.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const responseFlags = {
  candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false, authorizedForTransfer: false,
} as const;
const planFlags = {
  ...responseFlags, numberReserved: false, signatureVerified: false,
  officialRulesValidated: false, referenceVerification: 'NOT_VERIFIED',
} as const;
const gates = ['NUMBER_RESERVATION', 'ESTABLISHMENT_MAPPING', 'CATALOGUES_AND_REGULATED_GOODS',
  'OFFICIAL_XSL_RULES', 'XSD_ON_SIGNED_XML', 'SIGNATURE_AND_PKI', 'SUNAT_TRANSPORT_AND_CDR'];
function binding(): B2bGuideBinding {
  return { anchor: { issuerId: 1, issuerRuc: '20000000001', environment: 'BETA', branchId: uuid(2),
    pointId: uuid(3), seriesId: uuid(4), documentType: '01' }, guideSeriesId: uuid(5), guideType: '09' };
}
function response(): GuidePreparationResponse {
  return { schemaVersion: 'factuez.b2b.guide-preparation.v1', binding: binding(),
    plan: guideCore.prepareGuide09(guidePreparationInput()), gates: [...GUIDE_PREPARATION_GATES], ...responseFlags };
}
const validate = (value: unknown, expected = binding(), id = uuid(1), etag = '"v1"') =>
  validateGuidePreparationResponse(value, expected, id, etag);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
// Independent reference hash: malformed payloads never pass through a core validator
// or the wire's own hashing helper before being submitted to the wire boundary.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');
function get(value: any, path: string): any {
  return path ? path.split('.').reduce((row, key) => row[key], value) : value;
}
function set(value: any, path: string, replacement: unknown) {
  const parts = path.split('.');
  get(value, parts.slice(0, -1).join('.'))[parts.at(-1)!] = replacement;
}
function rehash(value: GuidePreparationResponse, body = true) {
  if (body) value.plan.draftBodySha256 = hash(value.plan.body);
  const { planSha256: ignored, ...unsigned } = value.plan;
  value.plan.planSha256 = hash(unsigned);
  return value;
}
function safeError(run: () => unknown) {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(B2bSecurityError);
  expect(error).toMatchObject({ status: 503, code: 'INCONSISTENT_GUIDE_PREPARATION', message: 'INCONSISTENT_GUIDE_PREPARATION' });
  expect(Object.keys(error as object).sort()).toEqual(['code', 'status']);
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('response');
  expect(error).not.toHaveProperty('plan');
  return error as B2bSecurityError;
}
function deepFrozen(value: unknown) {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(deepFrozen);
  }
}
function reverseKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, child]) => [key, reverseKeys(child)]));
  return value;
}
const objectPaths = ['', 'binding', 'binding.anchor', 'plan', 'plan.issuer', 'plan.body', 'plan.body.origin',
  'plan.body.destination', 'plan.body.sender', 'plan.body.recipient', 'plan.body.transport',
  'plan.body.transport.vehicle', 'plan.body.transport.driver', 'plan.body.items.0'];
const required = objectPaths.flatMap(path => Object.keys(get(response(), path))
  .map(key => ({ path, key, label: path ? `${path}.${key}` : key })));

describe('B2B GRE09 preparation wire: positive integrity and permanent closed flags', () => {
  it('accepts a real core-prepared fictional plan with exact envelope/plan flags and exported gates', () => {
    const input = response(), result = validate(input);
    expect(GUIDE_PREPARATION_GATES).toEqual(gates);
    expect(Object.isFrozen(GUIDE_PREPARATION_GATES)).toBe(true);
    expect(result).toEqual(input);
    expect(Object.keys(result).sort()).toEqual(['schemaVersion', 'binding', 'plan', 'gates', ...Object.keys(responseFlags)].sort());
    for (const [key, value] of Object.entries(responseFlags)) expect(get(result, key)).toBe(value);
    for (const [key, value] of Object.entries(planFlags)) expect(get(result.plan, key)).toBe(value);
    const { planSha256, ...unsigned } = result.plan;
    expect(planSha256).toBe(hash(unsigned));
    expect(result.plan.draftBodySha256).toBe(hash(result.plan.body));
    expect(result.plan.draftId).toBe(uuid(1));
    expect(result.plan.draftRevision).toBe('"v1"');
    expect(result.plan.issuer.ruc).toBe(result.binding.anchor.issuerRuc);
    expect(result).not.toHaveProperty('xml');
    expect(result).not.toHaveProperty('number');
  });
  it('validates without calling the SUNAT core, XML renderer or plan rebuilder', () => {
    const input = response();
    const spies = [vi.spyOn(guideCore, 'prepareGuide09'), vi.spyOn(guideCore, 'validateGuide09Plan'),
      vi.spyOn(guideCore, 'renderGuide09PreparationXml')];
    try {
      for (const spy of spies) spy.mockImplementation(() => { throw new Error('CORE MUST NOT RUN AT THE WIRE BOUNDARY'); });
      expect(validate(input)).toEqual(input);
      spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });
  it('detaches and recursively freezes the result without freezing the input or expected binding', () => {
    const input = response(), expected = binding(), result = validate(input, expected);
    deepFrozen(result);
    for (const path of objectPaths) expect(get(result, path)).not.toBe(get(input, path));
    expect(result.gates).not.toBe(input.gates);
    expect(result.plan.body.items).not.toBe(input.plan.body.items);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(expected.anchor)).toBe(false);
    input.plan.body.items[0].description = 'MUTACION FICTICIA';
    input.binding.anchor.issuerRuc = '20000000010'; expected.guideSeriesId = uuid(99);
    expect(result.plan.body.items[0].description).toBe('BIEN FICTICIO');
    expect(result.binding.anchor.issuerRuc).toBe('20000000001');
    expect(result.binding.guideSeriesId).toBe(uuid(5));
    expect(() => set(result, 'plan.body.items.0.description', 'FORGED')).toThrow(TypeError);
  });
  it('ignores JSON object insertion order while preserving gate/item array order', () => {
    const input = response();
    expect(validate(reverseKeys(input), reverseKeys(binding()))).toEqual(input);
    const plain = Object.assign(Object.create(null), input);
    plain.plan = Object.assign(Object.create(null), input.plan);
    expect(validate(plain)).toEqual(input);
  });
  it.each(['01', '03'] as const)('accepts anchor %s only with an explicit separate guide09 binding', documentType => {
    const input = response(), expected = binding();
    input.binding.anchor.documentType = expected.anchor.documentType = documentType;
    expect(validate(input, expected).binding.guideType).toBe('09');
  });
  it('accepts a core-produced plan on the previous Lima day with exact large decimals and CE identity', () => {
    const input = guidePreparationInput();
    input.body.issueDate = '2026-10-21T04:59:59.999Z'; input.body.transferDate = '2026-10-20';
    input.body.grossWeight = '999999999999.999'; input.body.items[0].quantity = '999999999999.999999';
    input.body.weightUnit = 'TNE'; input.body.transport.driver.identityType = '4';
    input.body.transport.driver.identityNumber = 'ABC123456789'; input.draftBodySha256 = hash(input.body);
    const value = response(); value.plan = guideCore.prepareGuide09(input);
    expect(validate(value).plan.body).toEqual(input.body);
  });
  it('accepts a changed valid body only after both independent hashes are rebound', () => {
    const input = response(); input.plan.body.items[0].description = 'OTRO BIEN FICTICIO';
    safeError(() => validate(input));
    input.plan.draftBodySha256 = hash(input.plan.body);
    safeError(() => validate(input));
    rehash(input);
    expect(validate(input).plan.body.items[0].description).toBe('OTRO BIEN FICTICIO');
  });
});

describe('B2B GRE09 preparation wire: tuple, issuer isolation, ID and ETag', () => {
  const changes: [string, unknown][] = [
    ['anchor.issuerId', 2], ['anchor.issuerRuc', '20000000010'], ['anchor.environment', 'PRODUCTION'],
    ['anchor.branchId', uuid(12)], ['anchor.pointId', uuid(13)], ['anchor.seriesId', uuid(14)],
    ['anchor.documentType', '03'], ['guideSeriesId', uuid(15)], ['guideType', '31'],
  ];
  it.each(changes)('rejects a response binding differing at %s', (path, value) => {
    const input = response(); set(input.binding, path, value);
    safeError(() => validate(input));
  });
  it.each(changes)('rejects a caller binding differing at %s', (path, value) => {
    const expected = binding(); set(expected, path, value);
    safeError(() => validate(response(), expected));
  });
  it('rejects guide31 even when response and caller bindings agree', () => {
    const input = response(), expected = binding(); input.binding.guideType = expected.guideType = '31';
    safeError(() => validate(input, expected));
  });
  it.each([
    ['anchor.issuerId', 0], ['anchor.issuerId', 2147483648], ['anchor.issuerId', 1.5], ['anchor.issuerId', '1'],
    ['anchor.issuerRuc', '123'], ['anchor.issuerRuc', 20000000001], ['anchor.branchId', 'bad'],
    ['anchor.pointId', 'bad'], ['anchor.seriesId', 'bad'], ['anchor.documentType', '09'],
    ['guideSeriesId', uuid(4)], ['guideSeriesId', 'not-uuid'], ['guideType', 9],
  ])('rejects malformed matching bindings at %s = %j', (path, value) => {
    const input = response(), expected = binding(); set(input.binding, path, value); set(expected, path, value);
    safeError(() => validate(input, expected));
  });
  it.each(['plan.issuer.ruc', 'plan.body.sender.ruc', 'plan.body.recipient.ruc'])
    ('rejects cross-issuer payload at %s despite recomputing both hashes', path => {
      const input = response(); set(input, path, '20000000010'); rehash(input);
      safeError(() => validate(input));
    });
  it('rejects a consistently foreign plan even when every party and both hashes agree', () => {
    const input = response();
    for (const party of [input.plan.issuer, input.plan.body.sender, input.plan.body.recipient]) party.ruc = '20000000010';
    rehash(input); safeError(() => validate(input));
  });
  it.each(['plan.issuer.legalName', 'plan.body.sender.legalName', 'plan.body.recipient.legalName'])
    ('rejects changed party name at %s despite valid hashes', path => {
      const input = response(); set(input, path, 'OTRA EMPRESA FICTICIA'); rehash(input);
      safeError(() => validate(input));
    });
  it('rejects a different requested draft or revision even when response hashes are intact', () => {
    const input = response();
    safeError(() => validate(input, binding(), uuid(99)));
    safeError(() => validate(input, binding(), uuid(1), '"v2"'));
    input.plan.draftId = uuid(99); rehash(input, false);
    safeError(() => validate(input));
    input.plan.draftId = uuid(1); input.plan.draftRevision = '"v2"'; rehash(input, false);
    safeError(() => validate(input));
    expect(validate(input, binding(), uuid(1), '"v2"')).toEqual(input);
  });
  it.each(['v1', 'W/"v1"', '"v0"', '"v01"', '"v1000000000"', '"v-1"', '"v1" ', '', 1])
    ('rejects malformed revision even when caller ETag agrees: %j', value => {
      const input = response(); set(input, 'plan.draftRevision', value); rehash(input, false);
      safeError(() => validate(input, binding(), uuid(1), value as string));
    });
  // Regression expectations remain red if wire accepts a self-consistent plan the
  // preparation core cannot produce. Hashes are integrity checks, not validation.
  it.each(['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000',
    '00000000-0000-6000-8000-000000000001', 'ABCDEF00-0000-4000-8000-000000000001'])
    ('rejects malformed draft ID even when requested ID and rehashed plan agree: %j', id => {
      const raw = guidePreparationInput(); raw.draftId = id;
      expect(() => guideCore.prepareGuide09(raw)).toThrow(guideCore.GuidePreparationError);
      const input = response(); input.plan.draftId = id; rehash(input, false);
      safeError(() => validate(input, binding(), id));
    });
});

describe('B2B GRE09 preparation wire: exact fields, profile, gates and flags', () => {
  it.each(required)('rejects missing $label even after hashes are recomputed', ({ path, key }) => {
    const input = response(); delete get(input, path)[key];
    if (input.plan && path !== 'plan') rehash(input);
    safeError(() => validate(input));
  });
  it.each(objectPaths)('rejects unknown nested fields at "%s" even after recomputing hashes', path => {
    const input = response(); get(input, path).unexpected = 'SYNTHETIC_SECRET_DO_NOT_LEAK';
    rehash(input); safeError(() => validate(input));
  });
  it.each(required)('rejects null at $label even after hashes are recomputed', ({ path, key }) => {
    const input = response(); get(input, path)[key] = null;
    if (input.plan && path !== 'plan') rehash(input);
    safeError(() => validate(input));
  });
  it.each([
    ['schemaVersion', 'factuez.b2b.guide-preparation.v2'],
    ['plan.schemaVersion', 'factuez.guide31-preparation-input.v1'],
    ['plan.profile', 'FACTUEZ-BETA-GRE31-PREPARATION-v1'], ['plan.profile', 'FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v2'],
  ])('rejects changed %s despite recomputed plan hash', (path, value) => {
    const input = response(); set(input, path, value); rehash(input); safeError(() => validate(input));
  });
  const flagCases = [
    ...Object.entries(responseFlags).map(([key, value]) => ({ path: key, value })),
    ...Object.entries(planFlags).map(([key, value]) => ({ path: `plan.${key}`, value })),
  ];
  it.each(flagCases)('rejects flipped/forged flag at $path despite recalculated hashes', ({ path, value }) => {
    for (const invalid of [typeof value === 'boolean' ? !value : 'VERIFIED', typeof value === 'boolean' ? String(value) : false, 1]) {
      const input = response(); set(input, path, invalid); rehash(input); safeError(() => validate(input));
    }
  });
  it.each(['xml', 'signedXml', 'cdr', 'number', 'series', 'signature', 'accepted', 'certificate', 'authorization'])
    ('rejects unrequested fiscal/result field %s at both response and plan levels', key => {
      for (const path of ['', 'plan']) {
        const input = response(); get(input, path)[key] = 'SYNTHETIC_SECRET_DO_NOT_LEAK';
        rehash(input); safeError(() => validate(input));
      }
    });
  it.each([
    [], gates.slice(1), [...gates].reverse(), [...gates, gates[0]], [...gates, 'ACTIVATION_APPROVED'],
    gates.map((gate, i) => i === 0 ? 'number_reservation' : gate), gates.join(','), {}, [null],
  ])('rejects non-exact gate list %#', value => {
    const input = response(); set(input, 'gates', value); safeError(() => validate(input));
  });
});

describe('B2B GRE09 preparation wire: hashes never make malformed bodies admissible', () => {
  it.each(['plan.planSha256', 'plan.draftBodySha256'])('rejects bad hashes at %s', path => {
    for (const value of ['0'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '', 1, null]) {
      const input = response(); set(input, path, value); safeError(() => validate(input));
    }
  });
  it('rejects stale body hash even with a fresh plan hash', () => {
    const input = response(); input.plan.body.items[0].quantity = '3'; rehash(input, false);
    safeError(() => validate(input));
  });
  const invalidBody: [string, unknown][] = [
    ['reasonCode', '01'], ['reasonCode', '31'], ['regulatedGoods', true], ['regulatedGoods', 'false'],
    ['references', [{}]], ['references', {}], ['grossWeight', '0'], ['grossWeight', '0.000'],
    ['grossWeight', '-1'], ['grossWeight', '1e3'], ['grossWeight', '01.25'], ['grossWeight', '1.0000'],
    ['grossWeight', '1000000000000'], ['grossWeight', 1.25], ['weightUnit', 'KG'],
    ['issueDate', 'not-a-date'], ['issueDate', '2026-02-30T15:30:00.000Z'],
    ['issueDate', '2026-10-21T15:30:00Z'], ['issueDate', '2026-10-21T10:30:00.000-05:00'],
    ['transferDate', '2026-02-30'], ['transferDate', '2026-13-01'], ['transferDate', '2026-10-20'],
    ['transferDate', '2026-10-21T00:00:00Z'], ['origin.ubigeo', '15010'], ['origin.ubigeo', 150101],
    ['destination.establishmentCode', '001'], ['destination.establishmentCode', 2],
    ['destination.establishmentCode', '0001'], ['origin.address', ' ORIGEN FICTICIO'],
    ['transport.mode', '01'], ['transport.mode', '31'], ['transport.vehicle.plate', 'ABC12'],
    ['transport.vehicle.plate', 'ABCDE1234'], ['transport.vehicle.plate', 'abc123'],
    ['transport.vehicle.registration', 'REG-01'], ['transport.vehicle.registration', 'R'.repeat(16)],
    ['transport.driver.identityType', '6'], ['transport.driver.identityNumber', '1234567'],
    ['transport.driver.identityNumber', '123456789'], ['transport.driver.license', 'A'.repeat(11)],
    ['transport.driver.license', 'a000000001'], ['transport.driver.firstName', ''],
    ['transport.driver.lastName', 'L'.repeat(101)], ['items', []], ['items', {}], ['items', [null]],
    ['items.0.code', 'C'.repeat(41)], ['items.0.description', 'D'.repeat(251)],
    ['items.0.quantity', '0'], ['items.0.quantity', '0.000000'], ['items.0.quantity', '0.0000001'],
    ['items.0.quantity', '1.0000000'], ['items.0.quantity', '1000000000000'],
    ['items.0.quantity', 2.000001], ['items.0.quantity', '1e6'], ['items.0.unitCode', 'N'], ['items.0.unitCode', 'niu'],
  ];
  it.each(invalidBody)('rejects rehashed malformed body.%s = %j', (path, value) => {
    const input = response(); set(input.plan.body, path, value); rehash(input);
    expect(input.plan.draftBodySha256).toBe(hash(input.plan.body));
    const { planSha256, ...unsigned } = input.plan; expect(planSha256).toBe(hash(unsigned));
    safeError(() => validate(input));
  });
  it('rejects duplicate items, 101 items, and identical endpoints even with correct hashes', () => {
    for (const mutate of [
      (r: GuidePreparationResponse) => r.plan.body.items.push({ ...r.plan.body.items[0] }),
      (r: GuidePreparationResponse) => { r.plan.body.items = Array.from({ length: 101 }, (_, i) => ({ ...r.plan.body.items[0], code: `ITEM-${i}` })); },
      (r: GuidePreparationResponse) => { r.plan.body.destination = { ...r.plan.body.origin, establishmentCode: '0002' }; },
    ]) { const input = response(); mutate(input); rehash(input); safeError(() => validate(input)); }
  });
  it.each(['1999-12-31T15:30:00.000Z', '2000-01-01T04:59:59.999Z'])
    ('rejects rehashed dates outside the core preparation calendar: %s', issueDate => {
      const raw = guidePreparationInput(); raw.body.issueDate = issueDate; raw.body.transferDate = '1999-12-31';
      raw.draftBodySha256 = hash(raw.body);
      expect(() => guideCore.prepareGuide09(raw)).toThrow(guideCore.GuidePreparationError);
      const input = response(); input.plan.body = raw.body; rehash(input);
      safeError(() => validate(input));
    });
  it.each(['plan.issuer.legalName', 'plan.body.origin.address', 'plan.body.destination.address',
    'plan.body.transport.driver.firstName', 'plan.body.transport.driver.lastName', 'plan.body.items.0.code', 'plan.body.items.0.description'])
    ('rejects unsafe text in %s without exposing submitted content', path => {
      for (const value of ['SYNTHETIC_SECRET_DO_NOT_LEAK\u0000', '\ud800', '\uffff', ' PADDED', 'PADDED ']) {
        const input = response(); set(input, path, value); rehash(input);
        const error = safeError(() => validate(input));
        expect(JSON.stringify(error)).not.toContain('SYNTHETIC_SECRET_DO_NOT_LEAK');
        expect(String(error)).not.toContain(value);
      }
    });
});

describe('B2B GRE09 preparation wire: unsafe JS, bounded input and no error leaks', () => {
  it.each([undefined, null, [], '', false, 1, NaN, Infinity, 1n, Symbol('SECRET'), () => 1,
    new Date('2026-10-21T00:00:00Z'), new Map(), Buffer.from('SYNTHETIC_SECRET_DO_NOT_LEAK')])
    ('returns only the safe 503 wire error for invalid root %#', value => safeError(() => validate(value)));
  it.each(['', 'plan', 'plan.body', 'plan.body.items.0', 'binding.anchor'])
    ('rejects getters/JSON hooks at "%s" without execution or leakage', path => {
      const hook = vi.fn(() => { throw new Error('SYNTHETIC_SECRET_DO_NOT_LEAK'); });
      for (const key of ['secret', 'toJSON']) {
        const input = response();
        Object.defineProperty(get(input, path), key, { enumerable: true, get: hook });
        safeError(() => validate(input));
      }
      const input = response(); get(input, path).toJSON = hook;
      safeError(() => validate(input)); expect(hook).not.toHaveBeenCalled();
    });
  it('rejects required-field and array-index accessors, without invoking getters', () => {
    const getter = vi.fn(() => { throw new Error('SYNTHETIC_SECRET_DO_NOT_LEAK'); });
    for (const [path, key] of [['', 'plan'], ['plan', 'body'], ['plan.body', 'issueDate'],
      ['plan.body.items', '0'], ['gates', '0']]) {
      const input = response(); Object.defineProperty(get(input, path), key, { enumerable: true, get: getter });
      safeError(() => validate(input));
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects hostile caller-binding getters and proxies without invoking their code', () => {
    const getter = vi.fn(() => { throw new Error('SYNTHETIC_SECRET_DO_NOT_LEAK'); });
    const expected = binding(); Object.defineProperty(expected, 'anchor', { enumerable: true, get: getter });
    safeError(() => validate(response(), expected));
    const nested = binding(); Object.defineProperty(nested.anchor, 'issuerRuc', { enumerable: true, get: getter });
    safeError(() => validate(response(), nested));
    safeError(() => validate(response(), new Proxy(binding(), { get: getter, ownKeys: getter, getPrototypeOf: getter })));
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(['', 'binding', 'plan', 'plan.body.items'])('rejects nested/root proxies at "%s" without traps', path => {
    const trap = vi.fn(() => { throw new Error('SYNTHETIC_SECRET_DO_NOT_LEAK'); });
    const input = response(), proxy = new Proxy(get(input, path),
      { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    if (path) { set(input, path, proxy); safeError(() => validate(input)); }
    else safeError(() => validate(proxy));
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    safeError(() => validate(revoked.proxy)); expect(trap).not.toHaveBeenCalled();
  });
  it.each(['', 'plan.body', 'plan.body.items', 'gates'])('rejects cycles at "%s" with a safe error', path => {
    const input = response(), target = get(input, path);
    if (Array.isArray(target)) target.push(target); else target.self = target;
    safeError(() => validate(input));
  });
  it('rejects sparse/decorated arrays, hidden/symbol keys, prototype control and nonplain objects', () => {
    const changes: ((value: any) => void)[] = [
      r => { r.gates = Array(gates.length); }, r => { r.plan.body.items = Array(1); },
      r => { r.gates.extra = 'SECRET'; }, r => { r.plan.body.references.extra = 'SECRET'; },
      r => { r.plan.body[Symbol('SECRET')] = true; },
      r => { Object.defineProperty(r.plan, 'secret', { value: 'SECRET' }); },
      r => { Object.defineProperty(r.plan.body.items[0], 'code', { value: 'ITEM', enumerable: false }); },
      r => { r.plan.body.origin = Object.create({ secret: 'SECRET' }); },
      r => { r.plan.body.origin = new Map(); }, r => { r.plan.body.items[0].quantity = 1n; },
      r => { r.plan.body.items[0].description = undefined; },
      ...['__proto__', 'constructor', 'prototype'].map(key => (r: any) => {
        Object.defineProperty(r.plan.body, key, { value: { wirePreparationPolluted: true }, enumerable: true });
      }),
    ];
    for (const change of changes) { const input = response(); change(input); safeError(() => validate(input)); }
    expect(Object.prototype).not.toHaveProperty('wirePreparationPolluted');
  });
  it.each([
    ['UTF8 byte limit', () => 'á'.repeat(300000)],
    ['serialized escaping byte limit', () => '\u0000'.repeat(90000)],
    ['depth limit', () => { let value: any = null; for (let i = 0; i < 33; i++) value = { nested: value }; return value; }],
    ['node budget', () => Array.from({ length: 100000 }, () => null)],
  ] as [string, () => unknown][])('rejects %s and conceals input details', (_label, make) => {
    const input = response(); input.plan.body.items[0].description = make();
    const error = safeError(() => validate(input));
    expect(JSON.stringify(error)).toBe('{"status":503,"code":"INCONSISTENT_GUIDE_PREPARATION"}');
  });
  it('never echoes submitted sensitive fields or nested validation causes', () => {
    const input: any = response(); input.password = 'SYNTHETIC_SECRET_DO_NOT_LEAK';
    input.plan.planSha256 = 'BAD_HASH_WITH_SYNTHETIC_SECRET';
    const error = safeError(() => validate(input));
    expect(`${String(error)} ${JSON.stringify(error)} ${error.stack}`).not.toMatch(/SYNTHETIC_SECRET|password|BAD_HASH/);
    expect(clone(input).password).toBe('SYNTHETIC_SECRET_DO_NOT_LEAK');
  });
});
