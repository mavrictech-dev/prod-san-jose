import 'reflect-metadata';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { signLocalGuideXml, verifyGuideIssuerXmlTrust, GuideArtifactCryptoError } from '../services/sunat-service/src/infrastructure/crypto/guide-artifact-crypto';
import { verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { CertificateTrustService, type CertificateTrustResult } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { betaCdrZipMetadata, betaCdrCrc32 } from '../services/sunat-service/src/application/beta-summary-acceptance';
import { createGuideSidecarPki, guideSidecarSigningInput, guideSidecarHash, unzipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';

let pki: ReturnType<typeof createGuideSidecarPki>;
beforeAll(() => { pki = createGuideSidecarPki(); }, 30000);
describe('local guide artifact adapter with ephemeral PKI', () => {
  it.each(['09', '31'] as const)('signs, independently verifies and packages %s without official capabilities', type => {
    const input = guideSidecarSigningInput(type), result = signLocalGuideXml(input, pki.issuer.pkcs12, pki.password);
    expect(verifyLocalSignedInvoice(result.xml, result.certificatePem, input.unsignedXml, 'DespatchAdvice')).toBe(result.digestValue);
    const entries = unzipSync(result.zip), bytes = Buffer.from(result.xml), metadata = betaCdrZipMetadata(result.zip, result.fileName);
    expect(Object.keys(entries)).toEqual([`${input.issuerRuc}-${type}-${input.fullNumber}.xml`]);
    expect(Buffer.from(entries[result.fileName])).toEqual(bytes);
    expect(metadata.size).toBe(bytes.length); expect(metadata.crc).toBe(betaCdrCrc32(bytes));
    expect(result.xmlSha256).toBe(guideSidecarHash(bytes)); expect(result.zipSha256).toBe(guideSidecarHash(result.zip));
    expect(result.certificateFingerprintSha256).toBe(pki.issuer.fingerprint);
    expect(result.certificatePem).toBe(pki.issuer.certificatePem);
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(result)).not.toContain(pki.password);
    expect(result).toMatchObject({ signingIdentityChecked: true, certificateTrusted: false, officialCdrVerified: false, transmissionAuthorized: false, authorizedForTransfer: false });
  });
  it('produces identical XML/ZIP bytes and hashes across different wall clocks', () => {
    const input = guideSidecarSigningInput(), first = signLocalGuideXml(input, pki.issuer.pkcs12, pki.password);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 86400000));
      const second = signLocalGuideXml(input, pki.issuer.pkcs12, pki.password);
      expect(second.xml).toBe(first.xml); expect(second.zip).toEqual(first.zip); expect(second.zipSha256).toBe(first.zipSha256);
    } finally { vi.useRealTimers(); }
  });
  it('rejects a valid key/certificate for another RUC with a finite error', () => {
    expect(() => signLocalGuideXml(guideSidecarSigningInput(), pki.otherIssuer.pkcs12, pki.password)).toThrow('GUIDE_CERTIFICATE_RUC_MISMATCH');
  });
  it.each([
    (xml: string) => xml.replace('TQ71-1', 'TQ71-2'),
    (xml: string) => xml.replace('>09<', '>31<'),
    (xml: string) => xml.replace('20100070970', '20131312955'),
    (xml: string) => xml.replace('<cbc:ID>TQ71-1</cbc:ID>', '<cbc:ID>TQ71-1</cbc:ID><evil:ID xmlns:evil="urn:evil">TQ71-1</evil:ID>'),
  ])('rejects mismatched/ambiguous XML identity', mutate => {
    const input = guideSidecarSigningInput(); input.unsignedXml = mutate(input.unsignedXml);
    expect(() => signLocalGuideXml(input, pki.issuer.pkcs12, pki.password)).toThrow(GuideArtifactCryptoError);
  });
  it('fails closed for malformed XML, password and supplied acceptance flags', () => {
    const input = guideSidecarSigningInput();
    expect(() => signLocalGuideXml({ ...input, unsignedXml: '<!DOCTYPE x><x/>' }, pki.issuer.pkcs12, pki.password)).toThrow('GUIDE_XML_INVALID');
    expect(() => signLocalGuideXml(input, pki.issuer.pkcs12, 'SENSITIVE-WRONG-PASSWORD')).toThrow('GUIDE_CERTIFICATE_INVALID');
    expect(() => signLocalGuideXml({ ...input, officialCdrVerified: true } as typeof input, pki.issuer.pkcs12, pki.password)).toThrow('GUIDE_INPUT_INVALID');
  });
  it('independent signature and archive verification rejects changed bytes', () => {
    const input = guideSidecarSigningInput(), result = signLocalGuideXml(input, pki.issuer.pkcs12, pki.password);
    expect(() => verifyLocalSignedInvoice(result.xml.replace('TQ71-1', 'TQ71-2'), result.certificatePem, input.unsignedXml, 'DespatchAdvice')).toThrow();
    const damaged = Buffer.from(result.zip), central = damaged.readUInt32LE(damaged.length - 6);
    damaged.writeUInt32LE(0, central + 16);
    expect(() => betaCdrZipMetadata(damaged, result.fileName)).toThrow();
    const payload = Buffer.from(result.zip), start = 30 + payload.readUInt16LE(26) + payload.readUInt16LE(28);
    payload[payload.indexOf(Buffer.from('TQ71-1'), start)] ^= 1;
    const archived = Buffer.from(unzipSync(payload)[result.fileName]);
    expect(betaCdrCrc32(archived)).not.toBe(betaCdrZipMetadata(payload, result.fileName).crc);
  });
});

describe('explicit public issuer trust adapter', () => {
  function fixture() {
    const base = guideSidecarSigningInput(), artifact = signLocalGuideXml(base, pki.issuer.pkcs12, pki.password);
    const input = { ...base, xml: artifact.xml, certificateFingerprintSha256: artifact.certificateFingerprintSha256, asOf: new Date().toISOString() };
    const certificates = { load: vi.fn(async () => ({ certificatePem: pki.issuer.certificatePem, chainPems: [...pki.issuer.chainPems] })) };
    const proof: CertificateTrustResult = { profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: true,
      revocation: 'VERIFIED_OFFLINE_CRL', trustStoreSha256: 'a'.repeat(64), certificateFingerprint: pki.issuer.fingerprint, checkedAt: input.asOf, blockers: [] };
    // Only the offline policy port is stubbed; key/cert matching and XMLDSig remain real.
    const trust = new CertificateTrustService(), evaluate = vi.spyOn(trust, 'evaluate').mockResolvedValue(proof);
    return { input, certificates, trust, evaluate, proof };
  }
  it('uses the public resolver and complete offline policy proof', async () => {
    const f = fixture(), proof = await verifyGuideIssuerXmlTrust(f.input, f.certificates, f.trust);
    expect(f.certificates.load).toHaveBeenCalledWith(f.input.issuerRuc, pki.issuer.fingerprint);
    expect(f.evaluate).toHaveBeenCalledOnce(); expect(proof.transmissionAuthorized).toBe(false);
  });
  it.each([{ chainValid: false }, { identityMatched: false }, { revocation: 'PENDING' as const }, { trustStoreSha256: null },
    { blockers: ['REVOKED'] }, { certificateFingerprint: 'f'.repeat(64) }, { checkedAt: '2020-01-01T00:00:00.000Z' }])('rejects incomplete trust proof %j', async override => {
    const f = fixture(); f.evaluate.mockResolvedValue({ ...f.proof, ...override });
    await expect(verifyGuideIssuerXmlTrust(f.input, f.certificates, f.trust)).rejects.toThrow('GUIDE_ISSUER_UNTRUSTED');
  });
  it('detects changes across awaits and tampered signed XML', async () => {
    const f = fixture(); f.evaluate.mockImplementation(async () => { f.input.fullNumber = 'TQ71-2'; return f.proof; });
    await expect(verifyGuideIssuerXmlTrust(f.input, f.certificates, f.trust)).rejects.toThrow('GUIDE_INPUT_CHANGED');
    const g = fixture(); g.input.xml = g.input.xml.replace('TQ71-1', 'TQ71-2');
    await expect(verifyGuideIssuerXmlTrust(g.input, g.certificates, g.trust)).rejects.toThrow('GUIDE_ISSUER_UNTRUSTED');
  });
});
