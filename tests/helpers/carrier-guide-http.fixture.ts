import { fiscalSnapshotSha256 as hash } from '../../packages/sunat-core/src/fiscal-note';
import { CARRIER_GUIDE_WIRE_FLAGS, type CarrierGuideWireBody, type CarrierGuideWireBinding,
  type CarrierGuideWireIssuance, type CarrierGuideWireReference } from '../../packages/service-access/src/b2b-carrier-guide-wire';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** Grammar/HTTP fixture only: private acceptance is an explicit owner-port
 * double, NOT a claim of cryptographic verification or an official SUNAT CDR. */
export function carrierGuideHttpFixture() {
  const carrier = { ruc: '20000000028', legalName: 'TRANSPORTISTA FICTICIO' }, sender = { ruc: '20000000001', legalName: 'REMITENTE FICTICIO' };
  const binding: CarrierGuideWireBinding = { draft: { anchor: { issuerId: 1, issuerRuc: carrier.ruc, environment: 'BETA',
    branchId: id(1), pointId: id(2), seriesId: id(3), documentType: '01' }, guideSeriesId: id(4), guideType: '31' }, fiscalSeriesId: id(5) };
  const projection: CarrierGuideWireReference['snapshot'] = { schemaVersion: 'factuez.carrier-reference09-owner.v1',
    documentId: id(8), documentType: '09', issuer: sender, series: 'TQ31', number: '9', issueDate: '2026-10-23T12:00:00.000Z',
    transferDate: '2026-10-24', sender, recipient: { ruc: '20000000036', legalName: 'CLIENTE FICTICIO' },
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO' }, destination: { ubigeo: '150102', address: 'DESTINO FICTICIO' },
    carrier, grossWeight: '1.250', weightUnit: 'KGM', items: [{ code: 'FICTICIO-1', description: 'BIEN & <UNO>', quantity: '2.0000000001', unitCode: 'NIU' }],
    transportMode: '01', regulatedGoods: false };
  const body: CarrierGuideWireBody = { issueDate: '2026-10-23T15:00:00.000Z', transferDate: projection.transferDate,
    sender, recipient: projection.recipient, origin: projection.origin, destination: projection.destination,
    grossWeight: projection.grossWeight, weightUnit: projection.weightUnit,
    transport: { mode: '01', carrier: { ...carrier, mtcRegistration: 'MTC00031' }, vehicle: { plate: 'ABC931', tuc: 'TUC00031' },
      driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR', lastName: 'FICTICIO', license: 'A000000031' } },
    reference09: { documentId: projection.documentId, issuerRuc: sender.ruc, series: projection.series, number: projection.number, snapshotSha256: hash(projection) },
    items: projection.items, totalTransfer: true, freightPayer: 'SENDER', subcontracted: false, regulatedGoods: false };
  const ready = { binding, draftId: id(6), body };
  const request = { schemaVersion: 'factuez.b2b.carrier-guide-issue.v1' as const, binding, draftId: ready.draftId,
    expectedRevision: '"v1"', idempotencyKey: 'synthetic_carrier_http_key_0001' };
  const snapshot: CarrierGuideWireIssuance['snapshot'] = { schemaVersion: 'factuez.carrier-issued-local.v1', documentId: id(7),
    operationId: id(9), binding, draftId: ready.draftId, draftRevision: 1, issuer: carrier, series: 'VQ31', number: '1', fullNumber: 'VQ31-1',
    body, bodySha256: hash(body), contextSha256: 'c'.repeat(64), at: '2026-10-23T16:00:00.000Z', ...CARRIER_GUIDE_WIRE_FLAGS };
  const issuance: CarrierGuideWireIssuance = { schemaVersion: 'factuez.b2b.carrier-guide-issuance.v1', operationId: snapshot.operationId,
    draftId: snapshot.draftId, binding, snapshot, snapshotSha256: hash(snapshot), replayed: false };
  const reference: CarrierGuideWireReference = { snapshot: projection, acceptance: { environment: 'BETA', documentId: projection.documentId,
    issuerRuc: sender.ruc, fullNumber: 'TQ31-9', snapshotSha256: hash(projection), cdrSha256: 'd'.repeat(64), responseCode: '0',
    status: 'ACCEPTED', acceptedAt: '2026-10-23T13:00:00.000Z' } };
  return { ready, request, issuance, binding, body, scope: { binding, draftId: ready.draftId, operationId: issuance.operationId },
    readyResponse: { draftId: ready.draftId, revision: '"v1"', bodySha256: hash(body) },
    owned: { issuance, authorizationSha256: 'a'.repeat(64), reference } };
}
