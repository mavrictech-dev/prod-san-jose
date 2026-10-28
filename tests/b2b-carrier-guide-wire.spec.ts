import { describe, expect, it, vi } from 'vitest';
import { boundedCarrierGuideWire, carrierGuideWireBinding, carrierGuideReadyRequest, carrierGuideIssueRequest, carrierGuideWireScope,
  carrierGuideReadyResponse, carrierGuideIssuanceResponse, carrierGuideArtifactOwnerResponse } from '../packages/service-access/src/b2b-carrier-guide-wire';
import { validateCarrierGuideInput } from '../packages/sunat-core/src/carrier-guide-profile';
import { fiscalSnapshotSha256 as hash } from '../packages/sunat-core/src/fiscal-note';
import { carrierGuideHttpFixture } from './helpers/carrier-guide-http.fixture';

describe('portable strict complete GT31 HTTP wire', () => {
  it('accepts full profile matching the independent fiscal engine without importing it at the edge', () => {
    const f = carrierGuideHttpFixture(); expect(carrierGuideReadyRequest(f.ready)).toEqual(f.ready);
    const s = carrierGuideIssuanceResponse(f.issuance, f.scope).snapshot;
    expect(validateCarrierGuideInput({ schemaVersion: 'factuez.carrier-guide-input.v1', companyId: 1, branchId: f.binding.draft.anchor.branchId,
      documentId: s.documentId, operationId: s.operationId, issuer: s.issuer, documentType: '31', series: s.series, number: s.number,
      body: s.body, snapshotSha256: hash(s) }).body).toEqual(f.body);
    expect(carrierGuideIssueRequest(f.request)).toEqual(f.request); expect(carrierGuideWireScope(f.scope)).toEqual(f.scope);
    expect(carrierGuideReadyResponse(f.readyResponse, f.ready)).toEqual(f.readyResponse);
    expect(carrierGuideArtifactOwnerResponse(f.owned, f.scope)).toEqual(f.owned);
    expect(Object.isFrozen(s.body.items)).toBe(true);
  });
  it.each(['09', 'PRODUCTION', 'two-series', 'other-ruc', 'extra'])('rejects binding %s', scenario => {
    const f: any = carrierGuideHttpFixture(), b = f.binding;
    if (scenario === '09') b.draft.guideType = '09';
    if (scenario === 'PRODUCTION') b.draft.anchor.environment = 'PRODUCTION';
    if (scenario === 'two-series') b.fiscalSeriesId = b.draft.guideSeriesId;
    if (scenario === 'other-ruc') b.draft.anchor.issuerRuc = '00000000000';
    if (scenario === 'extra') b.approved = true;
    expect(() => carrierGuideWireBinding(b)).toThrow('INVALID_CARRIER_GUIDE_REQUEST');
  });
  it.each(['xml', 'empty-items', 'duplicate-items', 'zero-quantity', 'decimal-precision', 'missing-tuc', 'driver', 'private-transport',
    'carrier-ruc', 'sender-reference', 'negative-weight', 'same-address', 'invalid-date', 'retroactive-transfer', 'fractional-time',
    'subcontract', 'regulated', 'missing-body', 'unknown-item', 'pem-field', 'control-text'])(
    'rejects incomplete or out-of-profile body %s', scenario => {
      const f: any = carrierGuideHttpFixture(), b = f.ready.body;
      if (scenario === 'xml') f.ready.xml = '<fake/>';
      if (scenario === 'empty-items') b.items = [];
      if (scenario === 'duplicate-items') b.items.push(structuredClone(b.items[0]));
      if (scenario === 'zero-quantity') b.items[0].quantity = '0.000';
      if (scenario === 'decimal-precision') b.items[0].quantity = '1.00000000001';
      if (scenario === 'missing-tuc') delete b.transport.vehicle.tuc;
      if (scenario === 'driver') b.transport.driver.identityNumber = 'WRONG';
      if (scenario === 'private-transport') b.transport.mode = '02';
      if (scenario === 'carrier-ruc') b.transport.carrier.ruc = b.sender.ruc;
      if (scenario === 'sender-reference') b.reference09.issuerRuc = b.recipient.ruc;
      if (scenario === 'negative-weight') b.grossWeight = '-1';
      if (scenario === 'same-address') b.destination = b.origin;
      if (scenario === 'invalid-date') b.issueDate = '2026-02-30T15:00:00.000Z';
      if (scenario === 'retroactive-transfer') b.transferDate = '2026-10-22';
      if (scenario === 'fractional-time') b.issueDate = '2026-10-23T15:00:00Z';
      if (scenario === 'subcontract') b.subcontracted = true;
      if (scenario === 'regulated') b.regulatedGoods = true;
      if (scenario === 'missing-body') delete f.ready.body;
      if (scenario === 'unknown-item') b.items[0].accepted = true;
      if (scenario === 'pem-field') b.certificatePem = 'PRIVATE';
      if (scenario === 'control-text') b.transport.driver.firstName = 'PRIVATE\u0000';
      expect(() => carrierGuideReadyRequest(f.ready)).toThrow('INVALID_CARRIER_GUIDE_REQUEST');
    });
  it.each(['revision', 'weak-revision', 'key', 'id', 'schema', 'extra'])('rejects invalid issue %s', scenario => {
    const r: any = carrierGuideHttpFixture().request;
    if (scenario === 'revision') r.expectedRevision = '*'; if (scenario === 'weak-revision') r.expectedRevision = 'W/"v1"';
    if (scenario === 'key') r.idempotencyKey = 'short'; if (scenario === 'id') r.draftId = '../other';
    if (scenario === 'schema') r.schemaVersion = 'old'; if (scenario === 'extra') r.xml = '<fake/>';
    expect(() => carrierGuideIssueRequest(r)).toThrow('INVALID_CARRIER_GUIDE_REQUEST');
  });
  it('never executes getters, toJSON, proxies or cycles and bounds actual UTF8 bytes', () => {
    const f = carrierGuideHttpFixture(), getter = vi.fn(), obj = Object.defineProperty({}, 'binding', { enumerable: true, get: getter });
    const cycle: any = {}; cycle.self = cycle;
    for (const v of [obj, new Proxy(f.ready, {}), { toJSON: getter }, cycle]) expect(() => boundedCarrierGuideWire(v)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => boundedCarrierGuideWire({ text: 'é'.repeat(65536) })).toThrow('INVALID_CARRIER_GUIDE_REQUEST');
  });
  it.each(['hash', 'context', 'body-hash', 'number', 'issuer', 'binding', 'extra', 'revision', 'caps', 'private-data', 'replayed'])(
    'withholds inconsistent owner issuance %s even with a freshly recomputed hash', scenario => {
      const f: any = carrierGuideHttpFixture(), r = f.issuance, s = r.snapshot;
      if (scenario === 'hash') r.snapshotSha256 = 'f'.repeat(64);
      if (scenario === 'context') s.contextSha256 = 'wrong'; if (scenario === 'body-hash') s.bodySha256 = 'b'.repeat(64);
      if (scenario === 'number') { s.number = '0'; s.fullNumber = 'VQ31-0'; }
      if (scenario === 'issuer') s.issuer.legalName = 'DIFFERENT'; if (scenario === 'binding') s.binding = { ...s.binding, fiscalSeriesId: s.binding.draft.guideSeriesId };
      if (scenario === 'extra') r.keySha256 = 'INTERNAL'; if (scenario === 'revision') s.draftRevision = 0;
      if (scenario === 'caps') s.transmissionAuthorized = true; if (scenario === 'private-data') s.certificatePem = 'PRIVATE';
      if (scenario === 'replayed') r.replayed = null;
      if (scenario !== 'hash') r.snapshotSha256 = hash(s);
      expect(() => carrierGuideIssuanceResponse(r, f.scope)).toThrow('INCONSISTENT_CARRIER_GUIDE_RESPONSE');
    });
  it.each(['auth-hash', 'extra', 'reference', 'cdr', 'status', 'date', 'owner', 'items'])(
    'withholds substituted private reference %s', scenario => {
      const f: any = carrierGuideHttpFixture(), o = f.owned;
      if (scenario === 'auth-hash') o.authorizationSha256 = 'bad'; if (scenario === 'extra') o.privateKey = 'PRIVATE';
      if (scenario === 'reference') o.reference.snapshot.number = '10'; if (scenario === 'cdr') o.reference.acceptance.cdrSha256 = 'bad';
      if (scenario === 'status') o.reference.acceptance.responseCode = '99'; if (scenario === 'date') o.reference.acceptance.acceptedAt = '2026-10-23T18:00:00.000Z';
      if (scenario === 'owner') o.reference.snapshot.issuer.ruc = '20000000036'; if (scenario === 'items') o.reference.snapshot.items[0].quantity = '9';
      expect(() => carrierGuideArtifactOwnerResponse(o, f.scope)).toThrow('INCONSISTENT_CARRIER_GUIDE_RESPONSE');
    });
  it.each(['2026-10-23T13:00:00Z', '2026-10-23T08:00:00-05:00'])(
    'preserves an original explicit CDR timestamp %s without rewriting it', acceptedAt => {
      const f = carrierGuideHttpFixture(); f.owned.reference.acceptance.acceptedAt = acceptedAt;
      expect(carrierGuideArtifactOwnerResponse(f.owned, f.scope).reference.acceptance.acceptedAt).toBe(acceptedAt);
    });
  it('bounds requests at 128 KiB but allows the full duplicated private reference in a bounded 512 KiB response', () => {
    const f = carrierGuideHttpFixture();
    const many = Array.from({ length: 70 }, (_, n) => ({ code: 'ITEM-' + n, description: '測'.repeat(500), quantity: '1', unitCode: 'NIU' }));
    f.body.items = many; f.owned.reference.snapshot.items = structuredClone(many);
    f.body.reference09.snapshotSha256 = hash(f.owned.reference.snapshot);
    f.owned.reference.acceptance.snapshotSha256 = f.body.reference09.snapshotSha256;
    f.issuance.snapshot.bodySha256 = hash(f.body); f.issuance.snapshotSha256 = hash(f.issuance.snapshot);
    expect(Buffer.byteLength(JSON.stringify(f.ready))).toBeLessThan(128 * 1024);
    expect(Buffer.byteLength(JSON.stringify(f.owned))).toBeGreaterThan(128 * 1024);
    expect(carrierGuideReadyRequest(f.ready).body.items).toHaveLength(70);
    expect(carrierGuideArtifactOwnerResponse(f.owned, f.scope).reference.snapshot.items).toHaveLength(70);
  });
});
