import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GUIDE09_PREPARATION_PROFILE, GuidePreparationError,
  prepareGuide09, renderGuide09PreparationXml, validateGuide09Plan,
} from '../packages/sunat-core/src/fiscal-guide-preparation';
import { guidePreparationBody, guidePreparationInput } from './helpers/guide-preparation.fixture';

// Pure preparation only: no services, QA emitters, PKI, numbering, persistence or network.
const flags = {
  candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
  authorizedForTransfer: false, numberReserved: false, signatureVerified: false,
  officialRulesValidated: false, referenceVerification: 'NOT_VERIFIED',
} as const;
const proposal = () => ({ series: 'T001', number: '1' });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
// Independent reference for hash assertions; never invoked on hostile JS values.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hash = (value: unknown) => sha(canonical(value));
function set(value: any, path: string, replacement: unknown) {
  const keys = path.split('.');
  for (const key of keys.slice(0, -1)) value = value[key];
  value[keys.at(-1)!] = replacement;
}
function get(value: any, path: string): any {
  return path ? path.split('.').reduce((v, key) => v[key], value) : value;
}
function rebound(path: string, value: unknown) {
  const input = guidePreparationInput();
  set(input, path, value);
  if (path !== 'draftBodySha256') input.draftBodySha256 = hash(input.body);
  return input;
}
function rehashPlan(plan: any) {
  const { planSha256: ignored, ...unsigned } = plan;
  plan.planSha256 = hash(unsigned);
  return plan;
}
function rejects(call: () => unknown, code = 'INVALID_GUIDE_PREPARATION') {
  let failure: unknown;
  try { call(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(GuidePreparationError);
  expect(failure).toMatchObject({ code, message: code });
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function reverseKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .reverse().map(([key, v]) => [key, reverseKeys(v)]));
  return value;
}
const objects = [
  '', 'issuer', 'body', 'body.origin', 'body.destination', 'body.sender', 'body.recipient',
  'body.transport', 'body.transport.vehicle', 'body.transport.driver', 'body.items.0',
];
const required = objects.flatMap(path => Object.keys(get(guidePreparationInput(), path))
  .map(key => ({ path, key, label: path ? `${path}.${key}` : key })));
const bodyLeaves: [string, unknown][] = [
  ['issueDate', '2026-10-21T15:31:00.000Z'], ['transferDate', '2026-10-22'], ['reasonCode', '01'],
  ['origin.ubigeo', '150103'], ['origin.address', 'OTRO ORIGEN FICTICIO'], ['origin.establishmentCode', '0003'],
  ['destination.ubigeo', '150104'], ['destination.address', 'OTRO DESTINO FICTICIO'], ['destination.establishmentCode', '0004'],
  ['sender.ruc', '20000000010'], ['sender.legalName', 'OTRA EMPRESA FICTICIA'],
  ['recipient.ruc', '20000000010'], ['recipient.legalName', 'OTRA EMPRESA FICTICIA'],
  ['grossWeight', '1.251'], ['weightUnit', 'TNE'], ['transport.mode', '01'],
  ['transport.vehicle.plate', 'XYZ987'], ['transport.vehicle.registration', 'REG00002'],
  ['transport.driver.identityType', '4'], ['transport.driver.identityNumber', '00000002'],
  ['transport.driver.firstName', 'OTRO'], ['transport.driver.lastName', 'INVENTADO'], ['transport.driver.license', 'A000000002'],
  ['items.0.code', 'OTRO-ITEM'], ['items.0.description', 'OTRO BIEN FICTICIO'],
  ['items.0.quantity', '2.000002'], ['items.0.unitCode', 'KGM'], ['references', [{}]], ['regulatedGoods', true],
];

describe('GRE09 PRIVATE04 preparation: fixture, purity and no fiscal activation', () => {
  it('exports independent, wholly fictional input/body fixtures with checksum-valid RUC', () => {
    const input = guidePreparationInput(), body = guidePreparationBody();
    expect(input.body).toEqual(body);
    expect(input.body).not.toBe(body);
    expect(input.issuer).toEqual(input.body.sender);
    expect(input.issuer).toEqual(input.body.recipient);
    expect(input.issuer).not.toBe(input.body.sender);
    expect(input.body.sender).not.toBe(input.body.recipient);
    expect(input.issuer.ruc).toBe('20000000001');
    const ruc = input.issuer.ruc, weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const check = 11 - weights.reduce((sum, w, i) => sum + w * Number(ruc[i]), 0) % 11;
    expect(Number(ruc[10])).toBe(check === 10 ? 0 : check === 11 ? 1 : check);
    expect(body.transport.driver.license).toBe('A000000001');
    expect(body.transport.vehicle.registration).toBe('REG00001');
    expect(body.origin).not.toEqual(body.destination);
    expect(body.references).toEqual([]);
    expect(input.draftBodySha256).toBe(hash(body));
    body.items[0].description = 'CAMBIO FICTICIO';
    expect(guidePreparationBody()).toEqual(input.body);
    input.body.sender.legalName = 'MUTACION';
    expect(guidePreparationInput().issuer.legalName).toBe('EMPRESA FICTICIA DE PREPARACION');
  });

  it('creates a deterministic, exactly bounded plan and preview, with every non-emission flag', () => {
    const input = frozen(guidePreparationInput()), plan = prepareGuide09(input);
    expect(GUIDE09_PREPARATION_PROFILE).toBe('FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1');
    expect(plan).toEqual({ ...input, profile: GUIDE09_PREPARATION_PROFILE, ...flags, planSha256: plan.planSha256 });
    const { planSha256, ...unsigned } = plan;
    expect(planSha256).toBe(hash(unsigned));
    expect(prepareGuide09(input)).toEqual(plan);
    expect(prepareGuide09(reverseKeys(input))).toEqual(plan);
    expect(validateGuide09Plan(frozen(plan))).toEqual(plan);
    const result = renderGuide09PreparationXml(plan, frozen(proposal()));
    expect(result).toEqual({ xml: result.xml, xmlSha256: sha(result.xml), proposedFullNumber: 'T001-1', planSha256, ...flags });
    expect(renderGuide09PreparationXml(plan, proposal())).toEqual(result);
    expect(result.xml).toContain('PRUEBA LOCAL - PREPARACION SIN FIRMA - SIN VALIDEZ TRIBUTARIA - NO AUTORIZA TRASLADO');
    expect(result.xml).not.toMatch(/<(?:ds:)?Signature\b|X509Certificate|DigestValue|SignatureValue|QR|CDR/i);
    expect(plan).not.toHaveProperty('series');
    expect(plan).not.toHaveProperty('number');
  });

  it('detaches input, reconstructed plan and preview in both directions', () => {
    const input = guidePreparationInput(), plan = prepareGuide09(input), rebuilt = validateGuide09Plan(plan);
    expect(plan.body).not.toBe(input.body);
    expect(plan.body.items[0]).not.toBe(input.body.items[0]);
    expect(plan.body.transport.driver).not.toBe(input.body.transport.driver);
    expect(rebuilt.body).not.toBe(plan.body);
    const preview = renderGuide09PreparationXml(rebuilt, proposal());
    input.body.items[0].description = 'INPUT MUTADO';
    expect(plan.body.items[0].description).toBe('BIEN FICTICIO');
    plan.body.items[0].description = 'PLAN MUTADO';
    expect(rebuilt.body.items[0].description).toBe('BIEN FICTICIO');
    rebuilt.body.items[0].description = 'RECONSTRUIDO MUTADO';
    expect(preview.xml).toContain('BIEN FICTICIO');
    expect(guidePreparationInput().body.items[0].description).toBe('BIEN FICTICIO');
  });
});

describe('GRE09 preparation: hash binding and tamper resistance', () => {
  it.each(bodyLeaves)('binds body.%s before semantic validation', (path, value) => {
    const input = guidePreparationInput();
    set(input.body, path, value);
    rejects(() => prepareGuide09(input), 'GUIDE_PREPARATION_BODY_MISMATCH');
  });
  it('binds line ordering and exact decimal spelling, while ignoring object-key order', () => {
    const input = guidePreparationInput();
    input.body.items.push({ ...input.body.items[0], code: 'ITEM-FICTICIO-2' });
    input.draftBodySha256 = hash(input.body);
    const plan = prepareGuide09(input);
    input.body.items.reverse();
    rejects(() => prepareGuide09(input), 'GUIDE_PREPARATION_BODY_MISMATCH');
    input.draftBodySha256 = hash(input.body);
    expect(prepareGuide09(input).planSha256).not.toBe(plan.planSha256);
    const spelled = rebound('body.grossWeight', '1.2500');
    rejects(() => prepareGuide09(spelled));
    const sameValue = rebound('body.grossWeight', '1.25');
    expect(prepareGuide09(sameValue).body.grossWeight).toBe('1.25');
    expect(sameValue.draftBodySha256).not.toBe(guidePreparationInput().draftBodySha256);
  });
  it.each([
    ['draftId', '00000000-0000-4000-8000-000000000002'], ['draftRevision', '"v2"'],
    ['draftBodySha256', 'a'.repeat(64)], ['issuer.legalName', 'OTRO EMISOR FICTICIO'],
    ['body.items.0.quantity', '3'], ['profile', 'FACTUEZ-BETA-GRE31-PREPARATION-v1'], ['planSha256', '0'.repeat(64)],
  ])('rejects changed plan %s in validator and renderer', (path, value) => {
    const plan = prepareGuide09(guidePreparationInput());
    set(plan, path, value);
    rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    rejects(() => renderGuide09PreparationXml(plan, proposal()), 'GUIDE_PREPARATION_PLAN_MISMATCH');
  });
  it.each(Object.entries(flags))('rejects forged %s even with a recomputed plan hash', (key, value) => {
    for (const replacement of [typeof value === 'boolean' ? !value : 'VERIFIED',
      typeof value === 'boolean' ? String(value) : value.toLowerCase(), null, 1]) {
      const plan = prepareGuide09(guidePreparationInput());
      set(plan, key, replacement);
      rehashPlan(plan);
      rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
      rejects(() => renderGuide09PreparationXml(plan, proposal()), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    }
  });
  it.each(['profile', 'planSha256', ...Object.keys(flags)])('requires exact plan field %s', key => {
    const plan: any = prepareGuide09(guidePreparationInput());
    delete plan[key];
    rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
  });
  it('does not let recomputed outer hash hide a stale body hash or disabled profile', () => {
    const plan = prepareGuide09(guidePreparationInput());
    plan.body.items[0].quantity = '3';
    rehashPlan(plan);
    rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    plan.draftBodySha256 = hash(plan.body);
    rehashPlan(plan);
    expect(validateGuide09Plan(plan)).toEqual(plan);
    const forged: any = clone(plan);
    forged.body.reasonCode = '01';
    forged.draftBodySha256 = hash(forged.body);
    rehashPlan(forged);
    rejects(() => validateGuide09Plan(forged), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    forged.body.reasonCode = '04';
    forged.draftBodySha256 = hash(forged.body);
    forged.profile = 'FACTUEZ-BETA-GRE31-PREPARATION-v1';
    rehashPlan(forged);
    rejects(() => validateGuide09Plan(forged), 'GUIDE_PREPARATION_PLAN_MISMATCH');
  });
});

describe('GRE09 preparation: strict schema and restricted private04 profile', () => {
  it.each(required)('requires explicit $label (no defaults)', ({ path, key }) => {
    const input = guidePreparationInput();
    delete get(input, path)[key];
    // Rebind only when the body still exists, to exercise nested required fields.
    if (input.body && !(path === '' && key === 'draftBodySha256')) input.draftBodySha256 = hash(input.body);
    rejects(() => prepareGuide09(input));
  });
  it.each(required)('rejects null at $label', ({ label }) => {
    const disabled = ['body.reasonCode', 'body.regulatedGoods', 'body.references', 'body.transport.mode'];
    rejects(() => prepareGuide09(rebound(label, null)), disabled.includes(label)
      ? 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED' : 'INVALID_GUIDE_PREPARATION');
  });
  it.each(objects)('rejects unknown fields at object "%s", including rehashed plans', path => {
    const input = guidePreparationInput();
    get(input, path).unexpected = 'FICTICIO';
    input.draftBodySha256 = hash(input.body);
    rejects(() => prepareGuide09(input));
    const plan = prepareGuide09(guidePreparationInput());
    get(plan, path).unexpected = 'FICTICIO';
    plan.draftBodySha256 = hash(plan.body);
    rehashPlan(plan);
    rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
  });
  it.each(['documentTypeCode', 'guideType', 'series', 'number', 'environment', 'accepted', 'signedXml',
    'cdr', 'certificate', 'activation', ...Object.keys(flags)])('rejects injected fiscal/activation field %s', key => {
    const input = { ...guidePreparationInput(), [key]: key === 'guideType' || key === 'documentTypeCode' ? '31' : true };
    rejects(() => prepareGuide09(input));
  });
  it.each([
    ['schemaVersion', 'factuez.guide31-preparation-input.v1', 'INVALID_GUIDE_PREPARATION'],
    ['body.reasonCode', '01', 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.reasonCode', '31', 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.regulatedGoods', true, 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.regulatedGoods', 'false', 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.references', [{}], 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.references', {}, 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.transport.mode', '01', 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
    ['body.transport.mode', '31', 'GUIDE_PREPARATION_PROFILE_NOT_ENABLED'],
  ])('fails closed outside the profile at %s = %j', (path, value, code) => {
    rejects(() => prepareGuide09(rebound(path, value)), code);
  });
  it.each(['issuer', 'body', 'body.origin', 'body.destination', 'body.sender', 'body.recipient',
    'body.transport', 'body.transport.vehicle', 'body.transport.driver', 'body.items.0'])
    ('rejects non-object structures at %s', path => {
      for (const value of [[], '', 1, false]) rejects(() => prepareGuide09(rebound(path, value)));
    });
  it.each(['', 'not-a-uuid', '00000000-0000-0000-8000-000000000001',
    '00000000-0000-6000-8000-000000000001', '00000000-0000-4000-7000-000000000001',
    'ABCDEF00-0000-4000-8000-000000000001'])('rejects draftId %j', value => {
    rejects(() => prepareGuide09(rebound('draftId', value)));
  });
  it.each(['v1', '"v0"', '"v01"', '"v1000000000"', '"v-1"', '"v1" ', 1])('rejects revision %j', value => {
    rejects(() => prepareGuide09(rebound('draftRevision', value)));
  });
  it.each(['"v1"', '"v999999999"'])('accepts bounded revision %s', value => {
    expect(prepareGuide09(rebound('draftRevision', value)).draftRevision).toBe(value);
  });
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123])
    ('rejects malformed body hash %j', value => {
      const input: any = guidePreparationInput(); input.draftBodySha256 = value;
      rejects(() => prepareGuide09(input));
    });
});

describe('GRE09 preparation: issuer and establishment consistency', () => {
  it.each(['issuer', 'body.sender', 'body.recipient'])('rejects malformed RUC in %s', path => {
    for (const ruc of ['20000000000', '00000000000', '30000000001', '2000000000', '200000000010', 20000000001]) {
      rejects(() => prepareGuide09(rebound(`${path}.ruc`, ruc)));
    }
  });
  it.each(['issuer.ruc', 'body.sender.ruc', 'body.recipient.ruc', 'issuer.legalName',
    'body.sender.legalName', 'body.recipient.legalName'])('requires exact issuer consistency at %s', path => {
    rejects(() => prepareGuide09(rebound(path, path.endsWith('ruc') ? '20000000010' : 'OTRA EMPRESA FICTICIA')),
      'GUIDE_PREPARATION_ISSUER_MISMATCH');
  });
  it('rejects different addresses sharing an establishment code', () => {
    rejects(() => prepareGuide09(rebound('body.destination.establishmentCode', '0001')),
      'GUIDE_PREPARATION_SAME_ESTABLISHMENT');
  });
  it('rejects identical ubigeo/address even with distinct establishment codes', () => {
    const input = guidePreparationInput();
    input.body.destination = { ...input.body.origin, establishmentCode: '0002' };
    input.draftBodySha256 = hash(input.body);
    rejects(() => prepareGuide09(input), 'GUIDE_PREPARATION_SAME_ESTABLISHMENT');
  });
  it('accepts distinct addresses in the same district and exact distinct establishment codes', () => {
    const input = rebound('body.destination.ubigeo', '150101');
    expect(prepareGuide09(input).body.destination.address).toBe('DESTINO FICTICIO');
  });
  it.each(['body.origin', 'body.destination'])('validates location formats at %s', path => {
    for (const ubigeo of ['15010', '1501011', '15A101', 150101]) rejects(() => prepareGuide09(rebound(`${path}.ubigeo`, ubigeo)));
    for (const code of ['001', '00001', 'A001', 1]) rejects(() => prepareGuide09(rebound(`${path}.establishmentCode`, code)));
  });
});

describe('GRE09 preparation: canonical UTC timestamp, calendar and Lima date', () => {
  it.each([
    ['2026-10-21T04:59:59.999Z', '2026-10-20', '2026-10-20', '23:59:59'],
    ['2026-10-21T05:00:00.000Z', '2026-10-21', '2026-10-21', '00:00:00'],
    ['2026-01-01T00:00:00.000Z', '2025-12-31', '2025-12-31', '19:00:00'],
    ['2024-03-01T04:00:00.001Z', '2024-02-29', '2024-02-29', '23:00:00'],
    ['2000-01-01T05:00:00.000Z', '2000-01-01', '2000-01-01', '00:00:00'],
  ])('uses Lima calendar for %s', (timestamp, transferDate, localDate, localTime) => {
    const input = rebound('body.issueDate', timestamp);
    input.body.transferDate = transferDate; input.draftBodySha256 = hash(input.body);
    const plan = prepareGuide09(input), { xml } = renderGuide09PreparationXml(plan, proposal());
    expect(xml).toContain(`<cbc:IssueDate>${localDate}</cbc:IssueDate>`);
    expect(xml).toContain(`<cbc:IssueTime>${localTime}</cbc:IssueTime>`);
    expect(xml).toContain(`<cbc:StartDate>${transferDate}</cbc:StartDate>`);
  });
  it.each(['2026-10-20', '2026-10-21', '2026-10-22'])('allows transfer on/after Lima day, %s', date => {
    const input = rebound('body.issueDate', '2026-10-21T04:59:59.999Z');
    input.body.transferDate = date; input.draftBodySha256 = hash(input.body);
    expect(prepareGuide09(input).body.transferDate).toBe(date);
  });
  it('rejects transfer before the Lima issue date', () => {
    rejects(() => prepareGuide09(rebound('body.transferDate', '2026-10-20')));
  });
  it.each(['2026-10-21', '2026-10-21T15:30:00', '2026-10-21T15:30:00Z',
    '2026-10-21T15:30:00.00Z', '2026-10-21T10:30:00.000-05:00', '2026-10-21T15:30:00.000+00:00',
    '2026-02-29T15:30:00.000Z', '2026-04-31T15:30:00.000Z', '2026-10-21T24:00:00.000Z',
    '2026-10-21T23:59:60.000Z', '1999-12-31T15:30:00.000Z', '2000-01-01T04:59:59.999Z',
    '2026-10-21T15:30:00.0000Z', 1792596600000])('rejects noncanonical/invalid timestamp %j', value => {
    rejects(() => prepareGuide09(rebound('body.issueDate', value)));
  });
  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00',
    '2026-1-21', '2026-10-21T00:00:00Z', '1999-12-31', '2026-10-21 ', 20261021])('rejects invalid transfer date %j', value => {
    rejects(() => prepareGuide09(rebound('body.transferDate', value)));
  });
});

const textFields: [string, number][] = [
  ['issuer.legalName', 200], ['body.sender.legalName', 200], ['body.recipient.legalName', 200],
  ['body.origin.address', 300], ['body.destination.address', 300],
  ['body.transport.driver.firstName', 100], ['body.transport.driver.lastName', 100],
  ['body.items.0.code', 40], ['body.items.0.description', 250],
];
describe('GRE09 preparation: field bounds and safe text', () => {
  it.each(textFields)('accepts exact maximum length for %s', (path, max) => {
    const input = guidePreparationInput();
    if (path.endsWith('legalName')) {
      input.issuer.legalName = input.body.sender.legalName = input.body.recipient.legalName = 'X'.repeat(max);
    } else set(input, path, 'X'.repeat(max));
    input.draftBodySha256 = hash(input.body);
    expect(get(prepareGuide09(input), path)).toBe('X'.repeat(max));
  });
  it.each(textFields)('rejects overlong, empty, untrimmed or unsafe text at %s', (path, max) => {
    for (const value of ['', ' ', ' X', 'X ', 'X'.repeat(max + 1), 'A\u0000B', 'A\u001fB', 'A\u007fB',
      'A\u0085B', 'A\u009fB', 'A\ud800B', 'A\udfffB', 'A\ufffeB', 'A\uffffB', 12, false]) {
      rejects(() => prepareGuide09(rebound(path, value)));
    }
  });
  it('accepts accented, astral and XML-special text without normalizing content', () => {
    const text = 'FICTICIO áé ñ 🐟 & < > " \'', input = rebound('body.items.0.description', text);
    expect(prepareGuide09(input).body.items[0].description).toBe(text);
  });
  it.each([
    ['body.transport.vehicle.plate', ['ABC123', 'ABCD1234'], ['', 'ABC12', 'ABCDE1234', 'abc123', 'ABC-12', 'ABC123\n']],
    ['body.transport.vehicle.registration', ['R', 'R'.repeat(15)], ['', 'R'.repeat(16), 'REG-01', 'reg01']],
    ['body.transport.driver.license', ['A', 'A000000001'], ['', 'A'.repeat(11), 'a000000001', 'A-0001']],
    ['body.items.0.unitCode', ['AB', 'NIU'], ['', 'A', 'ABCD', 'niu', 'A&']],
  ] as [string, string[], string[]][])('checks exact alphanumeric bounds at %s', (path, valid, invalid) => {
    for (const value of valid) expect(get(prepareGuide09(rebound(path, value)), path)).toBe(value);
    for (const value of [...invalid, 123]) rejects(() => prepareGuide09(rebound(path, value)));
  });
  it.each(['0', '6', '01', 1])('rejects driver identity type %j', value => {
    rejects(() => prepareGuide09(rebound('body.transport.driver.identityType', value)));
  });
  it.each(['1234567', '123456789', 'ABC12345', 12345678])('requires an eight-digit DNI, %j', value => {
    rejects(() => prepareGuide09(rebound('body.transport.driver.identityNumber', value)));
  });
  it('accepts identity type 4 with bounded uppercase alphanumeric identity', () => {
    for (const number of ['A', 'ABC123456789']) {
      const input = rebound('body.transport.driver.identityType', '4');
      input.body.transport.driver.identityNumber = number; input.draftBodySha256 = hash(input.body);
      const plan = prepareGuide09(input);
      expect(renderGuide09PreparationXml(plan, proposal()).xml).toContain(`<cbc:ID schemeID="4"`);
    }
    for (const value of ['', 'A'.repeat(13), 'abc123', 'AB-123', 123]) {
      const input: any = rebound('body.transport.driver.identityType', '4');
      input.body.transport.driver.identityNumber = value; input.draftBodySha256 = hash(input.body);
      rejects(() => prepareGuide09(input));
    }
  });
  it.each([0, 101])('rejects %i items', count => {
    const input = guidePreparationInput();
    input.body.items = Array.from({ length: count }, (_, i) => ({ ...input.body.items[0], code: `ITEM-${i}` }));
    input.draftBodySha256 = hash(input.body);
    rejects(() => prepareGuide09(input));
  });
  it('accepts 100 distinct lines and renders consecutive line/reference identifiers', () => {
    const input = guidePreparationInput(), item = input.body.items[0];
    input.body.items = Array.from({ length: 100 }, (_, i) => ({ ...item, code: `ITEM-${i + 1}` }));
    input.draftBodySha256 = hash(input.body);
    const { xml } = renderGuide09PreparationXml(prepareGuide09(input), proposal());
    expect(xml.match(/<cac:DespatchLine>/g)).toHaveLength(100);
    expect(xml).toContain('<cac:DespatchLine><cbc:ID>100</cbc:ID>');
    expect(xml).toContain('<cac:OrderLineReference><cbc:LineID>100</cbc:LineID>');
  });
  it('rejects duplicate item codes', () => {
    const input = guidePreparationInput(); input.body.items.push({ ...input.body.items[0] });
    input.draftBodySha256 = hash(input.body);
    rejects(() => prepareGuide09(input));
  });
  it.each([{}, 'items', [null]])('rejects malformed item collections %j', value => {
    rejects(() => prepareGuide09(rebound('body.items', value)));
  });
});

describe('GRE09 preparation: exact positive decimal strings', () => {
  it.each([
    ['body.grossWeight', ['0.001', '1', '1.250', '999999999999.999']],
    ['body.items.0.quantity', ['0.000001', '1', '2.000001', '999999999999.999999']],
  ] as [string, string[]][])('preserves exact decimal strings at %s', (path, values) => {
    for (const value of values) {
      const plan = prepareGuide09(rebound(path, value)), { xml } = renderGuide09PreparationXml(plan, proposal());
      expect(get(plan, path)).toBe(value);
      expect(xml).toContain(`>${value}</cbc:${path === 'body.grossWeight' ? 'GrossWeightMeasure' : 'DeliveredQuantity'}>`);
    }
  });
  it.each(['body.grossWeight', 'body.items.0.quantity'])('rejects unsafe or inexact decimal representation at %s', path => {
    for (const value of ['0', '0.0', '0.000', '01', '01.2', '-1', '+1', '1e3', '1E3', '.5', '1.', '1,5',
      ' 1', '1 ', '1000000000000', 'NaN', 'Infinity', '0x10', '', 1.25, 9007199254740992, NaN, Infinity, -Infinity]) {
      rejects(() => prepareGuide09(rebound(path, value)));
    }
  });
  it.each([
    ['body.grossWeight', '0.0001'], ['body.grossWeight', '1.0000'],
    ['body.items.0.quantity', '0.0000001'], ['body.items.0.quantity', '1.0000000'],
  ])('rejects excessive decimal scale at %s = %s', (path, value) => {
    rejects(() => prepareGuide09(rebound(path, value)));
  });
  it.each(['KGM', 'TNE'])('supports declared weight unit %s without conversion', unit => {
    const plan = prepareGuide09(rebound('body.weightUnit', unit));
    expect(renderGuide09PreparationXml(plan, proposal()).xml).toContain(`<cbc:GrossWeightMeasure unitCode="${unit}">1.250</cbc:GrossWeightMeasure>`);
  });
  it.each(['KG', 'kgm', '', 1])('rejects unsupported weight unit %j', value => {
    rejects(() => prepareGuide09(rebound('body.weightUnit', value)));
  });
});

describe('GRE09 preparation: XML preview and proposed identity only', () => {
  it('renders explicit GRE09/private04 structure, addresses, vehicle and driver', () => {
    const { xml } = renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), proposal());
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?><DespatchAdvice /);
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"');
    expect(xml).toContain('<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>');
    expect(xml).toMatch(/<cbc:DespatchAdviceTypeCode\b[^>]*>09<\/cbc:DespatchAdviceTypeCode>/);
    expect(xml).toMatch(/<cbc:HandlingCode\b[^>]*>04<\/cbc:HandlingCode>/);
    expect(xml).toMatch(/<cbc:TransportModeCode\b[^>]*>02<\/cbc:TransportModeCode>/);
    expect(xml).toContain('<cbc:ID>ABC123</cbc:ID>');
    expect(xml).toContain('<cbc:RegistrationNationalityID>REG00001</cbc:RegistrationNationalityID>');
    expect(xml).toContain('<cac:IdentityDocumentReference><cbc:ID>A000000001</cbc:ID>');
    expect(xml).toContain('<cbc:FirstName>CONDUCTOR</cbc:FirstName><cbc:FamilyName>FICTICIO</cbc:FamilyName>');
    expect(xml).toMatch(/<cac:DeliveryAddress>.*150102.*0002.*DESTINO FICTICIO<\/cbc:Line>.*<\/cac:DeliveryAddress>/);
    expect(xml).toMatch(/<cac:DespatchAddress>.*150101.*0001.*ORIGEN FICTICIO<\/cbc:Line>.*<\/cac:DespatchAddress>/);
    expect(xml.match(/listID="20000000001"/g)).toHaveLength(2);
    expect(xml.match(/schemeID="6"/g)).toHaveLength(2);
    expect(xml).toContain('unitCodeListID="UN/ECE rec 20"');
    expect(xml).not.toContain('>31</cbc:DespatchAdviceTypeCode>');
    expect(xml).not.toMatch(/AdditionalDocumentReference|CarrierParty/);
    expect(xml.endsWith('</DespatchAdvice>')).toBe(true);
  });
  it('escapes all five XML metacharacters in every free-text output, without double escaping', () => {
    const raw = 'FICTICIO & < > " \' á 🐟', escaped = 'FICTICIO &amp; &lt; &gt; &quot; &apos; á 🐟';
    const input = guidePreparationInput();
    input.issuer.legalName = input.body.sender.legalName = input.body.recipient.legalName = raw;
    input.body.origin.address = raw; input.body.destination.address = `DESTINO ${raw}`;
    input.body.transport.driver.firstName = raw; input.body.transport.driver.lastName = raw;
    input.body.items[0].code = raw; input.body.items[0].description = raw;
    input.draftBodySha256 = hash(input.body);
    const { xml, xmlSha256 } = renderGuide09PreparationXml(prepareGuide09(input), proposal());
    for (const tag of ['RegistrationName', 'Line', 'FirstName', 'FamilyName', 'Description', 'ID']) {
      expect(xml).toContain(`<cbc:${tag}>${escaped}</cbc:${tag}>`);
    }
    expect(xml).toContain(`<cbc:Line>DESTINO ${escaped}</cbc:Line>`);
    expect(xml).not.toContain(raw);
    expect(xml).not.toContain('&amp;amp;');
    expect(xmlSha256).toBe(sha(xml));
  });
  it('encodes pre-existing entity spellings and XML injection as literal data', () => {
    const input = rebound('body.items.0.description', '&lt; &amp; </cbc:Description><evil injected="yes"/>');
    const { xml } = renderGuide09PreparationXml(prepareGuide09(input), proposal());
    expect(xml).toContain('&amp;lt; &amp;amp; &lt;/cbc:Description&gt;&lt;evil injected=&quot;yes&quot;/&gt;');
    expect(xml).not.toContain('<evil');
  });
  it.each([{ series: 'T000', number: '1' }, { series: 'TZ99', number: '99999999' }])
    ('accepts bounded proposed identity %j', identity => {
      const plan = frozen(prepareGuide09(guidePreparationInput()));
      const preview = renderGuide09PreparationXml(plan, identity);
      expect(preview.proposedFullNumber).toBe(`${identity.series}-${identity.number}`);
      expect(preview.numberReserved).toBe(false);
    });
  it('changes only preview/hash when the proposed number changes, without modifying the plan', () => {
    const plan = frozen(prepareGuide09(guidePreparationInput()));
    const first = renderGuide09PreparationXml(plan, proposal());
    const second = renderGuide09PreparationXml(plan, { series: 'T002', number: '2' });
    expect(first.xmlSha256).not.toBe(second.xmlSha256);
    expect(second.planSha256).toBe(first.planSha256);
    expect(first.xml.replaceAll('T001-1', 'T002-2')).toBe(second.xml);
    expect(validateGuide09Plan(plan)).toEqual(plan);
  });
  it.each(['F001', 'B001', 't001', 'T01', 'T0001', 'T-01', 'T001\n', 'T<01', 1])('rejects proposed series %j', series => {
    rejects(() => renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), { series, number: '1' }));
  });
  it.each(['0', '01', '00000001', '100000000', '-1', '+1', '1.0', '1e2', '1 ', '1\n', '', 1])('rejects proposed number %j', number => {
    rejects(() => renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), { series: 'T001', number }));
  });
  it.each([null, [], {}, { series: 'T001' }, { number: '1' }, { ...proposal(), reserved: true },
    { ...proposal(), guideType: '31' }, { ...proposal(), transmissionAuthorized: true }])('requires exact proposed-identity fields %j', identity => {
    rejects(() => renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), identity));
  });
});

describe('GRE09 preparation: unsafe JavaScript is rejected before execution', () => {
  it.each([undefined, null, false, 42, '', [], NaN, Infinity, -Infinity, 1n, Symbol('fiction'), () => 1])
    ('rejects unsafe root value #%# in all entry points', value => {
      rejects(() => prepareGuide09(value));
      rejects(() => validateGuide09Plan(value), 'GUIDE_PREPARATION_PLAN_MISMATCH');
      rejects(() => renderGuide09PreparationXml(value, proposal()), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    });
  it.each(['issuer', 'body', 'body.items', 'body.items.0', 'body.transport.driver'])
    ('rejects accessors at %s without invoking them', path => {
      const getter = vi.fn(() => { throw new Error('GETTER MUST NOT EXECUTE'); });
      for (const field of ['description', 'toJSON']) {
        const input = guidePreparationInput(), plan = prepareGuide09(guidePreparationInput());
        for (const value of [input, plan]) Object.defineProperty(get(value, path), field, { enumerable: true, get: getter });
        rejects(() => prepareGuide09(input));
        rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
        rejects(() => renderGuide09PreparationXml(plan, proposal()), 'GUIDE_PREPARATION_PLAN_MISMATCH');
      }
      expect(getter).not.toHaveBeenCalled();
    });
  it('rejects getters on required fields and array indices, including proposal getters', () => {
    const getter = vi.fn(() => { throw new Error('DO NOT EXECUTE'); });
    for (const [path, key] of [['', 'body'], ['body', 'issueDate'], ['body.items', '0']]) {
      const input = guidePreparationInput();
      Object.defineProperty(get(input, path), key, { enumerable: true, get: getter });
      rejects(() => prepareGuide09(input));
    }
    const identity = proposal();
    Object.defineProperty(identity, 'series', { enumerable: true, get: getter });
    expect(() => renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), identity)).toThrow();
    // Invalid plan is checked first, so even a hostile proposal remains untouched.
    rejects(() => renderGuide09PreparationXml({}, identity), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects proxies, including revoked proxies, without calling their traps', () => {
    const trap = vi.fn(() => { throw new Error('PROXY MUST NOT EXECUTE'); });
    const input = guidePreparationInput(), plan = prepareGuide09(input);
    const handler = { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap };
    rejects(() => prepareGuide09(new Proxy(input, handler)));
    rejects(() => validateGuide09Plan(new Proxy(plan, handler)), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    const nested = guidePreparationInput(); nested.body = new Proxy(nested.body, handler);
    rejects(() => prepareGuide09(nested));
    expect(() => renderGuide09PreparationXml(plan, new Proxy(proposal(), handler))).toThrow();
    const revoked = Proxy.revocable({}, handler); revoked.revoke();
    rejects(() => prepareGuide09(revoked.proxy));
    expect(trap).not.toHaveBeenCalled();
  });
  it('never invokes toJSON, valueOf, toString or Symbol.toPrimitive hooks', () => {
    const hook = vi.fn(() => { throw new Error('HOOK MUST NOT EXECUTE'); });
    for (const field of ['toJSON', 'valueOf', 'toString', Symbol.toPrimitive]) {
      const input: any = guidePreparationInput(); input.body[field] = hook;
      rejects(() => prepareGuide09(input));
    }
    expect(hook).not.toHaveBeenCalled();
  });
  it.each([undefined, 1n, Symbol('fixture'), () => 1, new Date('2026-10-21T00:00:00Z'),
    new String('FICTICIO'), new Map(), new Set(), /fixture/, Buffer.from('fiction')])
    ('rejects non-JSON nested values #%#', value => {
      const input = guidePreparationInput(); set(input, 'body.items.0.description', value);
      rejects(() => prepareGuide09(input));
      const plan = prepareGuide09(guidePreparationInput()); set(plan, 'body.items.0.description', value);
      rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    });
  it('rejects inherited/custom prototypes and accepts plain null-prototype JSON records', () => {
    const input = guidePreparationInput();
    const inherited = Object.create(input);
    rejects(() => prepareGuide09(inherited));
    class Custom { constructor(readonly value = 'FICTICIO') {} }
    const custom: any = guidePreparationInput(); custom.body.origin = new Custom();
    rejects(() => prepareGuide09(custom));
    const plain = Object.assign(Object.create(null), input);
    plain.body = Object.assign(Object.create(null), input.body);
    expect(prepareGuide09(plain)).toEqual(prepareGuide09(input));
  });
  it.each(['__proto__', 'prototype', 'constructor'])('rejects dangerous own key %s without pollution', key => {
    const input = guidePreparationInput();
    Object.defineProperty(input.body, key, { value: { guidePreparationPolluted: true }, enumerable: true });
    rejects(() => prepareGuide09(input));
    expect(Object.prototype).not.toHaveProperty('guidePreparationPolluted');
  });
  it('rejects hidden or symbolic keys and sparse/decorated arrays', () => {
    for (const decorate of [
      (v: any) => Object.defineProperty(v.body, 'hidden', { value: true, enumerable: false }),
      (v: any) => Object.defineProperty(v.body, Symbol('hidden'), { value: true, enumerable: true }),
      (v: any) => Object.defineProperty(v.body.items[0], 'code', { value: 'FICTICIO', enumerable: false }),
      (v: any) => { v.body.items = new Array(1); },
      (v: any) => { v.body.items.extra = 'FICTICIO'; },
      (v: any) => { v.body.references.extra = 'FICTICIO'; },
      (v: any) => Object.defineProperty(v.body.items, '0', { value: v.body.items[0], enumerable: false }),
    ]) {
      const input = guidePreparationInput(); decorate(input);
      rejects(() => prepareGuide09(input));
      const plan = prepareGuide09(guidePreparationInput()); decorate(plan);
      rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    }
  });
  it('rejects cycles at root, nested object and array without stack overflow or mutation', () => {
    for (const path of ['', 'body', 'body.items']) {
      const input: any = guidePreparationInput(), target = get(input, path);
      if (Array.isArray(target)) target.push(target); else target.cycle = target;
      rejects(() => prepareGuide09(input));
      expect(Array.isArray(target) ? target.at(-1) : target.cycle).toBe(target);
      const plan: any = prepareGuide09(guidePreparationInput()); plan.body.cycle = plan;
      rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    }
  });
  it.each([
    ['depth', () => { let v: any = null; for (let i = 0; i < 66; i++) v = { nested: v }; return v; }],
    ['string length', () => 'X'.repeat(16385)],
    ['aggregate UTF8 bytes', () => Array.from({ length: 100 }, () => 'á'.repeat(3000))],
    ['encoded JSON bytes', () => Array.from({ length: 100 }, () => '\u0000'.repeat(1000))],
    ['node count', () => Array.from({ length: 100 }, () => Array.from({ length: 510 }, () => null))],
    ['array length', () => Array.from({ length: 1001 }, () => null)],
    ['object key count', () => Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, null]))],
    ['key length', () => ({ ['k'.repeat(121)]: null })],
  ] as [string, () => unknown][])('rejects bounded-JSON attack: %s', (_label, make) => {
    const input = guidePreparationInput(); set(input, 'body.items.0.description', make());
    rejects(() => prepareGuide09(input));
    const plan = prepareGuide09(guidePreparationInput()); set(plan, 'body.items.0.description', make());
    rejects(() => validateGuide09Plan(plan), 'GUIDE_PREPARATION_PLAN_MISMATCH');
    expect(() => renderGuide09PreparationXml(prepareGuide09(guidePreparationInput()), { ...proposal(), payload: make() })).toThrow();
  });
});
