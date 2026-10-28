import { describe, expect, it } from 'vitest';
import { certificateRucCandidates } from '../services/sunat-service/src/infrastructure/crypto/certificate-identity';
const ruc = '20615878481';
describe('Identidad RUC estricta del certificado', () => {
  it.each(['NTRPE-', 'VATPE-'])('reconoce %s sólo en organizationIdentifier', prefix => {
    expect(certificateRucCandidates([{ type: '2.5.4.97', value: prefix + ruc }])).toEqual([ruc]);
    expect(certificateRucCandidates([{ type: '2.5.4.5', value: prefix + ruc }])).toEqual([]);
  });
  it.each([ruc, 'RUC:' + ruc, 'RUCPE-' + ruc])('conserva el formato local %s', value => {
    expect(certificateRucCandidates([{ type: '2.5.4.5', value }])).toEqual([ruc]);
  });
  it.each(['NTRUS-' + ruc, 'NTRPE-X' + ruc, 'NTRPE-' + ruc + '0', 'EMPRESA ' + ruc,
    'NTRPE-' + ruc + ';OTRO', 'ntrpe-' + ruc])('rechaza formato ambiguo/extranjero %s', value => {
    expect(certificateRucCandidates([{ type: '2.5.4.97', value }])).toEqual([]);
  });
  it('ignora CN y conserva candidatos conflictivos para que confianza los rechace', () => {
    expect(certificateRucCandidates([{ type: '2.5.4.3', value: 'NTRPE-' + ruc }])).toEqual([]);
    expect(certificateRucCandidates([{ type: '2.5.4.97', value: 'NTRPE-' + ruc },
      { type: '2.5.4.5', value: ruc }, { type: '2.5.4.5', value: '20450819230' }])).toEqual([ruc, '20450819230']);
  });
});
