import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { boundedGuideIssueRequest, validateGuideIssueRequest, validateGuideIssuanceResponse } from '../packages/service-access/src/b2b-guide-issue-wire';
import { guidePreparationBody } from './helpers/guide-preparation.fixture';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = () => ({ draft: { anchor: { issuerId: 1, issuerRuc: '20000000001', environment: 'BETA' as const,
  branchId: id(1), pointId: id(2), seriesId: id(3), documentType: '01' as const }, guideSeriesId: id(4), guideType: '09' as const }, fiscalSeriesId: id(5) });
function canonical(v: any): string {
  return Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v !== null && typeof v === 'object'
    ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
}
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function response(): any {
  const body = guidePreparationBody();
  body.items.push({ ...body.items[0], code: 'SECOND', quantity: '0.000001' });
  const snapshot = { schemaVersion: 'factuez.guide-issued-local.v1', documentId: id(8), operationId: id(9), binding: binding(),
    draftId: id(10), draftRevision: 2, issuer: { ...body.sender }, series: 'T001', number: '1', fullNumber: 'T001-1',
    body, bodySha256: hash(body), contextSha256: hash({ synthetic: true }), at: '2026-10-22T15:00:00.000Z',
    candidateOnly: true, numberReserved: true, fiscalExecutionEnabled: false, transmissionAuthorized: false,
    authorizedForTransfer: false, officialRulesValidated: false, officialCdrVerified: false };
  return { schemaVersion: 'factuez.b2b.guide-issuance.v1', operationId: id(9), draftId: id(10), binding: binding(),
    snapshot, snapshotSha256: hash(snapshot), replayed: false };
}
const request = () => ({ schemaVersion: 'factuez.b2b.guide-issue.v1', binding: binding(), draftId: id(10), expectedRevision: '"v2"', idempotencyKey: 'synthetic_issue_0001' });
const validate = (v: unknown) => validateGuideIssuanceResponse(v, binding(), id(10), null, '"v2"');
const rehash = (r: any) => { r.snapshot.bodySha256 = hash(r.snapshot.body); r.snapshotSha256 = hash(r.snapshot); return r; };
const get = (v: any, path: string) => path ? path.split('.').reduce((v, k) => v[k], v) : v;
function set(v: any, path: string, replacement: unknown) { const parts = path.split('.'); get(v, parts.slice(0, -1).join('.'))[parts.at(-1)!] = replacement; }
function safe(run: () => unknown) {
  let error: any; try { run(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(B2bSecurityError);
  expect(error).toMatchObject({ status: 503, code: 'INCONSISTENT_GUIDE_ISSUANCE', message: 'INCONSISTENT_GUIDE_ISSUANCE' });
  expect(Object.keys(error).sort()).toEqual(['code', 'status']);
  expect(String(error) + JSON.stringify(error)).not.toContain('SYNTHETIC_PRIVATE');
}
const objects = ['', 'binding', 'binding.draft', 'binding.draft.anchor', 'snapshot', 'snapshot.binding', 'snapshot.binding.draft',
  'snapshot.binding.draft.anchor', 'snapshot.issuer', 'snapshot.body', 'snapshot.body.origin', 'snapshot.body.destination',
  'snapshot.body.sender', 'snapshot.body.recipient', 'snapshot.body.transport', 'snapshot.body.transport.vehicle', 'snapshot.body.transport.driver', 'snapshot.body.items.0'];

describe('strict local guide issuance wire', () => {
  it('accepts canonical hashes, preserves ordered items and detaches/freeze all output', () => {
    const input = response(), out = validate(input);
    expect(out).toEqual(input); expect(out).not.toBe(input);
    const frozen = (v: any) => { if (v && typeof v === 'object') { expect(Object.isFrozen(v)).toBe(true); Object.values(v).forEach(frozen); } };
    frozen(out); input.snapshot.body.items.reverse(); expect(out.snapshot.body.items[0].code).toBe('ITEM-FICTICIO-1');
    const reverse = (v: any): any => Array.isArray(v) ? v.map(reverse) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
    expect(validate(reverse(response()))).toEqual(response());
  });
  it('requires boolean issue replay and null read replay; binds operation and revision', () => {
    const r = response(); r.replayed = true; expect(validate(r).replayed).toBe(true);
    r.replayed = null; safe(() => validate(r));
    expect(validateGuideIssuanceResponse(r, binding(), id(10), id(9)).replayed).toBeNull();
    safe(() => validateGuideIssuanceResponse(response(), binding(), id(10), id(9)));
    safe(() => validateGuideIssuanceResponse(r, binding(), id(10), id(11)));
    safe(() => validateGuideIssuanceResponse(response(), binding(), id(10), null, '"v3"'));
    safe(() => validateGuideIssuanceResponse(response(), binding(), id(10), null));
  });
  it.each(objects)('rejects unknown fields on %s even with refreshed hashes', path => {
    const r = response(); get(r, path).SYNTHETIC_PRIVATE = 'SYNTHETIC_PRIVATE'; safe(() => validate(rehash(r)));
  });
  it.each(objects.flatMap(path => Object.keys(get(response(), path)).map(key => [path, key])))('requires %s.%s', (path, key) => {
    const r = response(); delete get(r, path)[key]; safe(() => validate(r));
  });
  it.each([
    ['snapshot.draftRevision', 0], ['snapshot.draftRevision', 1.5], ['snapshot.draftRevision', 1000000000],
    ['snapshot.number', '01'], ['snapshot.number', '0'], ['snapshot.number', '100000000'], ['snapshot.number', 1],
    ['snapshot.series', 'F001'], ['snapshot.fullNumber', 'T001-01'], ['snapshot.operationId', id(11)], ['snapshot.draftId', id(11)],
    ['snapshot.documentId', 'invalid'], ['snapshot.at', '2026-02-30T00:00:00.000Z'], ['snapshot.at', '2026-10-22T15:00:00Z'],
    ['snapshot.at', '2026-10-22T15:00:00.000+00:00'], ['snapshot.contextSha256', 'A'.repeat(64)],
    ['snapshot.issuer.legalName', ' X '], ['snapshot.issuer.ruc', '20000000002'],
    ['snapshot.body.reasonCode', '01'], ['snapshot.body.regulatedGoods', true], ['snapshot.body.references', [{}]],
    ['snapshot.body.transport.mode', '01'], ['snapshot.body.grossWeight', '0'], ['snapshot.body.grossWeight', '1e3'],
    ['snapshot.body.grossWeight', '1.0001'], ['snapshot.body.weightUnit', 'kg'], ['snapshot.body.items.0.quantity', '0.0000001'],
    ['snapshot.body.items.0.quantity', '-1'], ['snapshot.body.items.0.unitCode', 'niU'], ['snapshot.body.items.0.code', ' X '],
    ['snapshot.body.items', []], ['snapshot.body.items', Array.from({ length: 101 }, () => guidePreparationBody().items[0])],
    ['snapshot.body.transport.driver.identityNumber', '1'], ['snapshot.body.transport.driver.license', 'invalid license'],
    ['snapshot.body.transport.vehicle.registration', 'INVALID REG'], ['snapshot.body.transport.vehicle.plate', 'abc123'],
    ['snapshot.body.origin.establishmentCode', '001'], ['snapshot.body.origin.ubigeo', '15010'],
    ['snapshot.body.issueDate', '2026-02-30T15:00:00.000Z'], ['snapshot.body.transferDate', '2026-10-20'],
    ['snapshot.body.sender.legalName', 'OTHER'], ['snapshot.body.recipient.ruc', '20000000002'],
    ...['candidateOnly', 'numberReserved', 'fiscalExecutionEnabled', 'transmissionAuthorized', 'authorizedForTransfer', 'officialRulesValidated', 'officialCdrVerified']
      .map(k => ['snapshot.' + k, !response().snapshot[k]]),
  ] as [string, unknown][])('rejects rehashed invalid %s=%j', (path, v) => { const r = response(); set(r, path, v); safe(() => validate(rehash(r))); });
  it('rejects stale body/snapshot hashes and item reordering', () => {
    const r = response(); r.snapshot.body.items.reverse(); safe(() => validate(r));
    r.snapshotSha256 = hash(r.snapshot); safe(() => validate(r));
    expect(validate(rehash(r)).snapshot.body.items[0].code).toBe('SECOND');
  });
  it.each(['issuerId', 'issuerRuc', 'environment', 'branchId', 'pointId', 'seriesId', 'documentType', 'guideSeriesId', 'guideType', 'fiscalSeriesId'])('binds response tuple field %s', field => {
    const r = response(), b = r.snapshot.binding;
    if (field === 'fiscalSeriesId') b[field] = id(50);
    else if (field === 'guideSeriesId') b.draft[field] = id(50);
    else if (field === 'guideType') b.draft[field] = '31';
    else b.draft.anchor[field] = field === 'issuerId' ? 50 : field === 'documentType' ? '03' : field === 'issuerRuc' ? '20000000002' : field === 'environment' ? 'PRODUCTION' : id(50);
    r.binding = structuredClone(b); safe(() => validate(rehash(r)));
  });
  it('rejects invalid RUC checksum even if request and all parties agree', () => {
    const r = response(), b = binding(); b.draft.anchor.issuerRuc = '20000000002';
    r.binding = b; r.snapshot.binding = b;
    for (const p of [r.snapshot.issuer, r.snapshot.body.sender, r.snapshot.body.recipient]) p.ruc = b.draft.anchor.issuerRuc;
    safe(() => validateGuideIssuanceResponse(rehash(r), b, id(10), null, '"v2"'));
  });
  it('rejects duplicate items, matching locations and invalid private-driver alternatives', () => {
    const r = response(); r.snapshot.body.items[1].code = r.snapshot.body.items[0].code; safe(() => validate(rehash(r)));
    const other = response(); other.snapshot.body.destination = structuredClone(other.snapshot.body.origin); safe(() => validate(rehash(other)));
    const alt = response(); alt.snapshot.body.transport.driver.identityType = '4'; alt.snapshot.body.transport.driver.identityNumber = 'ABC123';
    expect(validate(rehash(alt))).toBeDefined(); alt.snapshot.body.transport.driver.identityNumber = 'a'; safe(() => validate(rehash(alt)));
  });
  it('rejects hooks, accessors, proxies, symbols, prototypes and cycles without invoking them', () => {
    const hook = vi.fn(() => { throw new Error('SYNTHETIC_PRIVATE'); });
    const r = response(); Object.defineProperty(r, 'snapshot', { get: hook, enumerable: true }); safe(() => validate(r));
    safe(() => validate(new Proxy({}, { ownKeys: hook })));
    const json = response(); json.toJSON = hook; safe(() => validate(json));
    const symbol = response(); symbol[Symbol('hidden')] = 1; safe(() => validate(symbol));
    const proto = Object.assign(Object.create({ hidden: true }), response()); safe(() => validate(proto));
    const cycle = response(); cycle.snapshot.body.cycle = cycle; safe(() => validate(cycle));
    expect(hook).not.toHaveBeenCalled();
  });
  it('bounds response UTF8 bytes and request bytes, returning finite errors', () => {
    const r = response(); r.snapshot.body.items[0].description = 'á'.repeat(270000); safe(() => validate(r));
    expect(() => boundedGuideIssueRequest({ text: 'x'.repeat(128 * 1024) })).toThrow(expect.objectContaining({ status: 413 }));
    expect(validateGuideIssueRequest(request())).toEqual(request());
    for (const k of Object.keys(request())) { const r: any = request(); delete r[k]; expect(() => validateGuideIssueRequest(r)).toThrow(expect.objectContaining({ status: 400 })); }
    expect(() => validateGuideIssueRequest({ ...request(), token: 'SYNTHETIC_PRIVATE' })).toThrow(expect.objectContaining({ status: 400 }));
  });
});
