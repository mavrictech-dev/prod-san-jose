import type {
  Guide09PreparationBody, Guide09PreparationInput,
} from '../../packages/sunat-core/src/fiscal-guide-preparation';
import { fiscalSnapshotSha256 } from '../../packages/sunat-core/src/fiscal-note';

// Entirely fictional, checksum-valid RUC; no customer, certificate or owner data.
// Only GRE 09 / reason 04 / private transport 02 preparation is represented here.
export function guidePreparationBody(): Guide09PreparationBody {
  return {
    issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
    destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
    sender: { ruc: '20000000001', legalName: 'EMPRESA FICTICIA DE PREPARACION' },
    recipient: { ruc: '20000000001', legalName: 'EMPRESA FICTICIA DE PREPARACION' },
    grossWeight: '1.250', weightUnit: 'KGM',
    transport: {
      mode: '02', vehicle: { plate: 'ABC123', registration: 'REG00001' },
      driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR',
        lastName: 'FICTICIO', license: 'A000000001' },
    },
    items: [{ code: 'ITEM-FICTICIO-1', description: 'BIEN FICTICIO', quantity: '2.000001', unitCode: 'NIU' }],
    references: [], regulatedGoods: false,
  };
}

export function guidePreparationInput(): Guide09PreparationInput {
  const body = guidePreparationBody();
  return {
    schemaVersion: 'factuez.guide09-preparation-input.v1',
    draftId: '00000000-0000-4000-8000-000000000001', draftRevision: '"v1"',
    draftBodySha256: fiscalSnapshotSha256(body), issuer: { ...body.sender }, body,
  };
}
