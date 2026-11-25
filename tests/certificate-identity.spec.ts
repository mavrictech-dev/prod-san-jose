import { describe, expect, it } from 'vitest';
import { certificateRucCandidates } from '../services/sunat-service/src/infrastructure/crypto/certificate-identity';
import { CertificateTrustService } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
const ruc = '20615878481';
describe('Identidad RUC estricta del certificado', () => {
  it('recognizes the exact observed OU interoperability profile without claiming trust', async () => {
    const subjectRucCandidates=certificateRucCandidates([{type:'2.5.4.11',value:'FACTURA ELECTRONICA RUC '+ruc}]);
    expect(subjectRucCandidates).toEqual([ruc]);
    const proof=await new CertificateTrustService().evaluate({subjectRucCandidates,selfSigned:false,digitalSignature:true,expiresAt:new Date('2099-01-01'),fingerprint:'a'.repeat(64)} as never,ruc);
    expect(proof.identityMatched).toBe(true);expect(proof.chainValid).toBe(false);expect(proof.revocation).toBe('PENDING');
  });
  it.each(['FACTURA ELECTRONICA RUC '+ruc+' EXTRA','PREFIJO FACTURA ELECTRONICA RUC '+ruc,' FACTURA ELECTRONICA RUC '+ruc,
    'FACTURA ELECTRONICA RUC '+ruc+' ','FACTURA ELECTRONICA RUC '+ruc+'\n','factura electronica ruc '+ruc,
    'FACTURA ELECTRONICA RUC '+ruc+'0','FACTURA ELECTRONICA RUC '+ruc.slice(1),'FACTURA ELECTRONICA RUC \u202e'+ruc,
    'FACTURA ELECTRONICA RUC '+ruc+'\u202c','FACTURA ELECTRONICA RUC\u00a0'+ruc])('rejects modified OU identity %j',value=>{
    expect(certificateRucCandidates([{type:'2.5.4.11',value}])).toEqual([]);
  });
  it('ignores the same text in CN and retains conflicting OU/serial/organization identities',async()=>{
    expect(certificateRucCandidates([{type:'2.5.4.3',value:'FACTURA ELECTRONICA RUC '+ruc}])).toEqual([]);
    for(const type of ['2.5.4.5','2.5.4.97','2.5.4.11']){
      const subjectRucCandidates=certificateRucCandidates([{type:'2.5.4.11',value:'FACTURA ELECTRONICA RUC '+ruc},
        {type,value:type==='2.5.4.11'?'FACTURA ELECTRONICA RUC 20000000028':'20000000028'}]);
      expect(subjectRucCandidates).toEqual([ruc,'20000000028']);
      const proof=await new CertificateTrustService().evaluate({subjectRucCandidates,selfSigned:false,digitalSignature:true,expiresAt:new Date('2099-01-01'),fingerprint:'a'.repeat(64)} as never,ruc);
      expect(proof.identityMatched).toBe(false);expect(proof.blockers).toContain('CERTIFICATE_RUC_NOT_MATCHED');
    }
  });
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
