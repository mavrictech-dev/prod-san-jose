import { createHash, X509Certificate } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_XML_SIGNATURE_PROFILE as PROFILE, verifySyntheticCertificate, verifySyntheticCdr,
  verifySyntheticXmlSignature, type SyntheticCertificateInput, type SyntheticCdrInput,
  type SyntheticXmlRootKind, type SyntheticXmlSignatureInput } from '../packages/evidence-core/src/crypto';
import { buildBusinessEvidenceXml, createBusinessEvidenceSnapshot } from '../packages/evidence-core/src/fixtures';
import { CAC, CBC, DS, EXT, SYNTHETIC_SCOPE, buildCryptoEvidenceFixture, corruptSyntheticCertificate, createEvidenceCryptoFixture, generateSyntheticCdr,
  editSyntheticXml, unsignedSyntheticCdr, unsignedSyntheticXml } from './helpers/evidence-crypto.fixture';

let fixture: ReturnType<typeof createEvidenceCryptoFixture>;
let other: ReturnType<typeof createEvidenceCryptoFixture>;
let unsigned: string;
let signed: string;
beforeAll(() => {
  fixture = createEvidenceCryptoFixture();
  other = createEvidenceCryptoFixture();
  unsigned = unsignedSyntheticXml();
  signed = fixture.sign(unsigned);
}, 30000);

function xmlInput(overrides: Partial<SyntheticXmlSignatureInput> = {}): SyntheticXmlSignatureInput {
  return { ...SYNTHETIC_SCOPE, xml: signed, certificatePem: fixture.certificatePem, expectedUnsignedXml: unsigned, rootKind: 'Invoice', ...overrides };
}
function certInput(overrides: Partial<SyntheticCertificateInput> = {}): SyntheticCertificateInput {
  return { ...SYNTHETIC_SCOPE, certificatePem: fixture.certificatePem, rootCertificatePem: fixture.rootCertificatePem,
    pinnedRootSha256: fixture.pinnedRootSha256, issuerRuc: fixture.senderRuc, checkedAt: fixture.checkedAt, ...overrides };
}
function cdrInput(options: Parameters<typeof unsignedSyntheticCdr>[0] = {}, overrides: Partial<SyntheticCdrInput> = {}): SyntheticCdrInput {
  const expectedUnsignedXml = unsignedSyntheticCdr(options);
  return { ...certInput(), issuerRuc: fixture.issuerRuc, reference: 'FQA1-1', xml: fixture.sign(expectedUnsignedXml), expectedUnsignedXml, ...overrides };
}
function invalidXml(xml: string, overrides: Partial<SyntheticXmlSignatureInput> = {}) {
  expect(() => verifySyntheticXmlSignature(xmlInput({ xml, ...overrides }))).toThrow('SYNTHETIC_XML_SIGNATURE_INVALID');
}

describe('public input boundary rejects accessors and proxies before any callback', () => {
  const operations = [
    { name: 'XML', make: () => xmlInput(), verify: (input: object) => verifySyntheticXmlSignature(input as SyntheticXmlSignatureInput) },
    { name: 'certificate', make: () => certInput(), verify: (input: object) => verifySyntheticCertificate(input as SyntheticCertificateInput) },
    { name: 'CDR', make: () => cdrInput(), verify: (input: object) => verifySyntheticCdr(input as SyntheticCdrInput) },
  ];
  it.each(operations)('$name never calls getters, including irrelevant extra and nonenumerable properties', operation => {
    for (const property of ['environment', 'datasetClass', 'certificatePem', 'xml', 'checkedAt', 'expectedDocumentTypeCode', 'extra']) {
      for (const enumerable of [true, false]) {
        let callbacks = 0;
        const input = operation.make();
        Object.defineProperty(input, property, { enumerable, configurable: true,
          get() { callbacks++; throw new Error('FORBIDDEN_GETTER_CALLBACK'); },
          set() { callbacks++; throw new Error('FORBIDDEN_SETTER_CALLBACK'); },
        });
        expect(() => operation.verify(input)).toThrow();
        expect(callbacks).toBe(0);
      }
    }
  });
  it.each(operations)('$name rejects proxies without get/prototype/descriptor/ownKeys traps', operation => {
    let callbacks = 0;
    const forbidden = () => { callbacks++; throw new Error('FORBIDDEN_PROXY_CALLBACK'); };
    const input = new Proxy(operation.make(), { get: forbidden, getPrototypeOf: forbidden, getOwnPropertyDescriptor: forbidden, ownKeys: forbidden });
    expect(() => operation.verify(input)).toThrow();
    expect(callbacks).toBe(0);
    const revocable = Proxy.revocable(operation.make(), { get: forbidden });
    revocable.revoke();
    expect(() => operation.verify(revocable.proxy)).toThrow();
    expect(callbacks).toBe(0);
  });
  it.each(operations)('$name rejects custom prototypes and symbol accessors without callbacks', operation => {
    let callbacks = 0;
    const prototype = { get environment() { callbacks++; return 'BETA'; } };
    const input = Object.create(prototype, Object.getOwnPropertyDescriptors(operation.make()));
    expect(() => operation.verify(input)).toThrow();
    expect(callbacks).toBe(0);
    const symbolInput = operation.make();
    Object.defineProperty(symbolInput, Symbol('extra'), { get() { callbacks++; throw new Error('FORBIDDEN_SYMBOL_CALLBACK'); } });
    expect(() => operation.verify(symbolInput)).toThrow();
    expect(callbacks).toBe(0);
  });
  it.each(operations)('$name accepts plain null-prototype data and nonenumerable own data fields', operation => {
    const input = Object.create(null, Object.getOwnPropertyDescriptors(operation.make()));
    Object.defineProperty(input, 'certificatePem', { value: input.certificatePem, enumerable: false });
    expect(operation.verify(input).officialTrust).toBe(false);
  });
  it('does not coerce a malicious rootKind value or call its toPrimitive getter', () => {
    let callbacks = 0;
    const rootKind = { get [Symbol.toPrimitive]() { callbacks++; throw new Error('FORBIDDEN_COERCION_CALLBACK'); } };
    expect(() => verifySyntheticXmlSignature(xmlInput({ rootKind: rootKind as unknown as SyntheticXmlRootKind }))).toThrow();
    expect(callbacks).toBe(0);
  });
});

describe('SYNTHETIC XML signature: complete authenticated references and external certificate', () => {
  it.each(['Invoice', 'CreditNote', 'DebitNote', 'ApplicationResponse'] as const)('verifies hardened SHA256/RSA/exclusive-c14n for %s', rootKind => {
    const expectedUnsignedXml = unsignedSyntheticXml(rootKind);
    const result = verifySyntheticXmlSignature(xmlInput({ rootKind, expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }));
    expect(result.signatureVerified).toBe(true);
    expect(result.officialTrust).toBe(false);
    expect(result.authenticatedXml).toContain('QA-001');
    expect(result.authenticatedXml).not.toContain('SignatureValue');
    expect(result.digestValue).toBe(createHash('sha256').update(result.authenticatedXml).digest('base64'));
  });
  it('accepts absent KeyInfo with the externally supplied signer', () => {
    expect(verifySyntheticXmlSignature(xmlInput({ xml: fixture.sign(unsigned, { keyInfo: 'none' }) })).signatureVerified).toBe(true);
  });
  it('matches canonical content rather than the lexical self-closing representation', () => {
    const expectedUnsignedXml = unsigned.replace('<ext:ExtensionContent/>', '<ext:ExtensionContent></ext:ExtensionContent>');
    expect(verifySyntheticXmlSignature(xmlInput({ expectedUnsignedXml })).signatureVerified).toBe(true);
  });
  it('rejects tampered content', () => invalidXml(signed.replace('QA-001', 'QA-999')));
  it('rejects a correctly signed different snapshot', () => invalidXml(signed, { expectedUnsignedXml: unsigned.replace('QA-001', 'QA-999') }));
  it('rejects no signature', () => invalidXml(unsigned));
  it('rejects an incorrect external certificate even with legitimate embedded KeyInfo', () => invalidXml(signed, { certificatePem: other.certificatePem }));
  it('rejects embedded CA substitution rather than trusting it', () => invalidXml(fixture.sign(unsigned, { keyInfo: 'root' })));
  it('rejects duplicate signatures', () => invalidXml(editSyntheticXml(signed, doc => {
    const signature = doc.getElementsByTagNameNS(DS, 'Signature')[0];
    signature.parentNode!.appendChild(signature.cloneNode(true));
  })));
  it('rejects signed multiple references even when both verify cryptographically', () => invalidXml(fixture.sign(unsigned, { references: 2 })));
  it('requires an explicitly present empty URI', () => invalidXml(editSyntheticXml(signed, doc => {
    doc.getElementsByTagNameNS(DS, 'Reference')[0].removeAttribute('URI');
  })));
  it('rejects a valid signature restricted to a fragment', () => {
    const xml = unsigned.replace('<cbc:ID>', '<cbc:ID Id="targetQa">');
    invalidXml(fixture.sign(xml, { xpath: "//*[@Id='targetQa']", uri: '#targetQa' }), { expectedUnsignedXml: xml });
  });
  it.each(['https://synthetic.invalid/never-fetch', '#xpointer(/)', '#targetQa'])('rejects URI %s without dereferencing it', uri => {
    invalidXml(editSyntheticXml(signed, doc => doc.getElementsByTagNameNS(DS, 'Reference')[0].setAttribute('URI', uri)));
  });
  it('rejects an Invoice wrapper with an independently signed inner Invoice', () => invalidXml(unsignedSyntheticXml('Invoice', signed)));
  it('rejects signature relocation outside the UBL extension', () => invalidXml(editSyntheticXml(signed, doc => {
    doc.documentElement!.appendChild(doc.getElementsByTagNameNS(DS, 'Signature')[0]);
  })));
  it('rejects duplicate Id values anywhere in the document', () => invalidXml(editSyntheticXml(signed, doc => {
    doc.documentElement!.setAttribute('Id', 'signatureSyntheticQa');
  })));
  it('rejects a nested business root even when signed and expected', () => {
    const xml = unsignedSyntheticXml('Invoice', '<cbc:ID>QA-001</cbc:ID>' + unsignedSyntheticXml('CreditNote'));
    invalidXml(fixture.sign(xml), { expectedUnsignedXml: xml });
  });
  it.each([
    { signatureAlgorithm: `${DS}rsa-sha1` },
    { digestAlgorithm: `${DS}sha1` },
    { transforms: [`${DS}enveloped-signature`, 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'] },
    { transforms: [PROFILE.canonicalizationAlgorithm] },
    { transforms: [`${DS}enveloped-signature`, PROFILE.canonicalizationAlgorithm, PROFILE.canonicalizationAlgorithm] },
  ])('rejects a profile outside the exact allowed algorithms/transforms: %j', options => invalidXml(fixture.sign(unsigned, options)));
  it('rejects canonicalization parameters', () => invalidXml(editSyntheticXml(signed, doc => {
    doc.getElementsByTagNameNS(DS, 'CanonicalizationMethod')[0].appendChild(doc.createElementNS(PROFILE.canonicalizationAlgorithm, 'ec:InclusiveNamespaces'));
  })));
  it('rejects ds:Object and retrieval-based KeyInfo', () => {
    invalidXml(editSyntheticXml(signed, doc => doc.getElementsByTagNameNS(DS, 'Signature')[0].appendChild(doc.createElementNS(DS, 'Object'))));
    invalidXml(editSyntheticXml(signed, doc => {
      const keyInfo = doc.getElementsByTagNameNS(DS, 'KeyInfo')[0];
      while (keyInfo.firstChild) keyInfo.removeChild(keyInfo.firstChild);
      const retrieval = doc.createElementNS(DS, 'RetrievalMethod');
      retrieval.setAttribute('URI', 'https://synthetic.invalid/never-fetch');
      keyInfo.appendChild(retrieval);
    }));
  });
  it('rejects DTD/entities, comments and processing instructions', () => {
    for (const prefix of ['<!DOCTYPE Invoice [<!ENTITY qa "SYNTHETIC">]>', '<!--SYNTHETIC-->', '<?qa SYNTHETIC?>']) invalidXml(prefix + signed);
  });
  it('rejects malformed XML, multiple roots, bad namespaces and oversized input', () => {
    for (const xml of [signed.slice(0, -4), signed + unsigned, signed.replace('xsd:Invoice-2', 'xsd:CreditNote-2'), ' '.repeat(2 * 1024 * 1024) + signed]) invalidXml(xml);
    invalidXml(signed, { rootKind: 'Unknown' as SyntheticXmlRootKind });
  });
  it('rejects an extension in a look-alike namespace', () => invalidXml(signed.replace(EXT, 'urn:synthetic:wrong-extension')));
  it('rejects a signed expected snapshot or an unexpected nonempty extension', () => {
    invalidXml(signed, { expectedUnsignedXml: signed });
    const xml = unsigned.replace('<ext:ExtensionContent/>', '<ext:ExtensionContent><cbc:ID>QA-EXTRA</cbc:ID></ext:ExtensionContent>');
    invalidXml(fixture.sign(xml), { expectedUnsignedXml: xml });
  });
  it('rejects wrong scope at runtime', () => {
    invalidXml(signed, { environment: 'PRODUCTION' as 'BETA' });
    invalidXml(signed, { datasetClass: 'REAL' as 'SYNTHETIC' });
  });
  it('does not expose signature content in failure messages', () => {
    const broken = editSyntheticXml(signed, doc => { doc.getElementsByTagNameNS(DS, 'SignatureValue')[0].textContent = 'PRIVATE_FIXTURE_CONTENT'; });
    invalidXml(broken);
    try { verifySyntheticXmlSignature(xmlInput({ xml: broken })); } catch (error) {
      expect((error as Error).message).not.toContain('PRIVATE_FIXTURE_CONTENT');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('SYNTHETIC certificates: explicit fictitious identity, direct pinned chain and UTC validity', () => {
  it('returns verified local facts, stable DER fingerprints and NOT_CHECKED revocation', () => {
    const result = verifySyntheticCertificate(certInput());
    expect(result).toMatchObject({ issuerRuc: fixture.senderRuc, chainSignatureVerified: true, keyUsageVerified: true, caVerified: true,
      algorithm: 'RSA_SHA256', keySizeBits: 2048, rootKeySizeBits: 2048, revocationStatus: 'NOT_CHECKED', officialTrust: false,
      validity: { valid: true, checkedAt: fixture.checkedAt } });
    expect(result.rootFingerprintSha256).toBe(fixture.pinnedRootSha256);
    expect(result.certificateFingerprintSha256).toBe(createHash('sha256').update(new X509Certificate(fixture.certificatePem).raw).digest('hex'));
  });
  it.each(['2026-02-01T00:00:00.000Z', '2027-01-01T00:00:00Z'])('accepts the inclusive UTC boundary %s', checkedAt => {
    expect(verifySyntheticCertificate(certInput({ checkedAt })).validity.valid).toBe(true);
  });
  it.each(['2026-01-31T23:59:59.999Z', '2027-01-01T00:00:00.001Z', '2026-02-30T00:00:00Z',
    '2026-10-04', '2026-10-04T12:00:00-05:00', '2026-10-04T12:00:00.00Z', '2026-10-04T25:00:00Z'])('rejects expired, future or invalid UTC checkedAt %s', checkedAt => {
    expect(() => verifySyntheticCertificate(certInput({ checkedAt }))).toThrow('SYNTHETIC_CERTIFICATE_INVALID');
  });
  it('rejects wrong root pin and noncanonical pin syntax', () => {
    for (const pinnedRootSha256 of ['a'.repeat(64), fixture.pinnedRootSha256.toUpperCase(), `sha256:${fixture.pinnedRootSha256}`]) {
      expect(() => verifySyntheticCertificate(certInput({ pinnedRootSha256 }))).toThrow();
    }
  });
  it('rejects a different CA even with that CA pinned and the same synthetic subject', () => {
    expect(() => verifySyntheticCertificate(certInput({ rootCertificatePem: other.rootCertificatePem, pinnedRootSha256: other.pinnedRootSha256 }))).toThrow();
  });
  it('rejects a corrupted signer certificate signature', () => {
    expect(() => verifySyntheticCertificate(certInput({ certificatePem: corruptSyntheticCertificate(fixture.certificatePem) }))).toThrow();
  });
  it('rejects a correctly signed certificate with an impossible DER UTC calendar date', () => {
    const certificatePem = fixture.issueLeafDer(asn => {
      const tbs = (asn.value as { value: unknown }[])[0].value as { value: unknown }[];
      const validity = tbs[4].value as { value: unknown }[];
      validity[0].value = '260230000000Z';
    });
    expect(() => verifySyntheticCertificate(certInput({ certificatePem }))).toThrow();
  });
  it('rejects mismatched inner/outer certificate signature algorithms', () => {
    const certificatePem = fixture.issueLeafDer(asn => {
      const tbs = (asn.value as { value: unknown }[])[0].value as { value: unknown }[];
      const algorithm = tbs[2].value as { value: unknown }[];
      // DER OID 1.2.840.113549.1.1.5 (SHA1/RSA), outer remains SHA256/RSA.
      algorithm[0].value = '\x2a\x86\x48\x86\xf7\x0d\x01\x01\x05';
    });
    expect(() => verifySyntheticCertificate(certInput({ certificatePem }))).toThrow();
  });
  it('rejects a corrupted root self-signature even if its altered DER is pinned', () => {
    const rootCertificatePem = corruptSyntheticCertificate(fixture.rootCertificatePem);
    const pinnedRootSha256 = createHash('sha256').update(new X509Certificate(rootCertificatePem).raw).digest('hex');
    expect(() => verifySyntheticCertificate(certInput({ rootCertificatePem, pinnedRootSha256 }))).toThrow();
  });
  it('rejects an identity/RUC mismatch and real-looking RUC input', () => {
    for (const issuerRuc of ['00000000202', '20123456789', 'NTRPE-00000000099']) expect(() => verifySyntheticCertificate(certInput({ issuerRuc }))).toThrow();
  });
  it.each([
    { ruc: '20123456789' }, { commonName: 'QA' }, { organization: 'REAL ORGANIZATION' },
    { identityFields: [] },
    { identityFields: [{ type: '2.5.4.97', value: '00000000099' }, { type: '2.5.4.97', value: '00000000101' }] },
    { identityFields: [{ type: '2.5.4.97', value: 'NTRPE-00000000099' }] },
    { ruc: '00000000101', commonName: 'SYNTHETIC FICTICIO QA 00000000099' },
    { sha1: true }, { notAfter: '2026-10-03T00:00:00.000Z' },
    { notBefore: '2026-10-05T00:00:00.000Z' }, { notBefore: '2025-12-31T00:00:00.000Z' },
  ])('rejects certificate profile or identity inconsistency %j', config => {
    const certificatePem = fixture.issueLeaf(config);
    expect(() => verifySyntheticCertificate(certInput({ certificatePem }))).toThrow();
  });
  it.each([
    [{ name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 }, { name: 'keyUsage', critical: true, digitalSignature: true }],
    [{ name: 'basicConstraints', critical: true, cA: false }, { name: 'keyUsage', critical: true, keyCertSign: true }],
    [{ name: 'basicConstraints', critical: true, cA: false }, { name: 'keyUsage', critical: true, digitalSignature: true, keyCertSign: true }],
    [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', critical: true, digitalSignature: true }],
    [{ name: 'basicConstraints', critical: true, cA: false }],
    [{ name: 'basicConstraints', critical: true, cA: false }, { name: 'keyUsage', critical: true, digitalSignature: true }, { name: 'extKeyUsage', clientAuth: true }],
    [{ name: 'basicConstraints', critical: true, cA: false }, { name: 'keyUsage', critical: true, digitalSignature: true }, { name: 'keyUsage', critical: true, digitalSignature: true }],
  ])('rejects incorrect CA/keyUsage/extensions %j', (...extensions) => {
    expect(() => verifySyntheticCertificate(certInput({ certificatePem: fixture.issueLeaf({ extensions }) }))).toThrow();
  });
  it.each([
    { sha1: true }, { keyBits: 1024 }, { commonName: 'ROOT QA' },
    { extensions: [{ name: 'basicConstraints', critical: true, cA: false }, { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true }] },
    { extensions: [{ name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 }, { name: 'keyUsage', critical: true, digitalSignature: true }] },
    { notAfter: '2026-10-03T00:00:00.000Z' },
  ])('rejects an incorrect root profile %j', root => {
    const bad = createEvidenceCryptoFixture({ root });
    expect(() => verifySyntheticCertificate(certInput({ ...bad, issuerRuc: bad.senderRuc }))).toThrow();
  }, 30000);
  it('rejects weak signer RSA even with a valid SHA256 chain', () => {
    const bad = createEvidenceCryptoFixture({ leaf: { keyBits: 1024 } });
    expect(() => verifySyntheticCertificate(certInput({ ...bad, issuerRuc: bad.senderRuc }))).toThrow();
    expect(() => verifySyntheticXmlSignature(xmlInput({ xml: bad.sign(unsigned), certificatePem: bad.certificatePem }))).toThrow();
  });
  it('requires one public certificate PEM per input, never bundles or a leaf trust anchor', () => {
    expect(() => verifySyntheticCertificate(certInput({ certificatePem: fixture.certificatePem + fixture.rootCertificatePem }))).toThrow();
    expect(() => verifySyntheticCertificate(certInput({ rootCertificatePem: fixture.certificatePem }))).toThrow();
  });
  it('rejects a real-looking identity even in the standalone XML verifier', () => {
    invalidXml(signed, { certificatePem: fixture.issueLeaf({ ruc: '20123456789' }) });
  });
  it('rejects production/non-synthetic scope', () => {
    expect(() => verifySyntheticCertificate(certInput({ environment: 'PRODUCTION' as 'BETA' }))).toThrow();
    expect(() => verifySyntheticCertificate(certInput({ datasetClass: 'REAL' as 'SYNTHETIC' }))).toThrow();
  });
});

describe('runner-facing ephemeral fixture API and business builder integration', () => {
  it('buildCryptoEvidenceFixture keeps private keys in a closure and signs each business root', () => {
    const f = buildCryptoEvidenceFixture();
    expect(f.issuerRuc).toBe('00000000001');
    expect(Object.keys(f).some(key => /private|secret|password/i.test(key))).toBe(false);
    expect(verifySyntheticCertificate({ ...SYNTHETIC_SCOPE, ...f }).officialTrust).toBe(false);
    for (const type of ['01', '03', '07', '08'] as const) {
      const expectedUnsignedXml = buildBusinessEvidenceXml(createBusinessEvidenceSnapshot(type));
      const rootKind = type === '07' ? 'CreditNote' : type === '08' ? 'DebitNote' : 'Invoice';
      const result = verifySyntheticXmlSignature({ ...SYNTHETIC_SCOPE, certificatePem: f.certificatePem,
        expectedUnsignedXml, rootKind, xml: f.sign(expectedUnsignedXml, rootKind) });
      expect(result.signatureVerified).toBe(true);
      expect(result.officialTrust).toBe(false);
    }
    expect(() => f.sign(unsignedSyntheticXml('Invoice'), 'DebitNote')).toThrow('SYNTHETIC_FIXTURE_ROOT_MISMATCH');
  });
  it('generateSyntheticCdr exposes unsigned simulated outcomes for the runner', () => {
    const f = buildCryptoEvidenceFixture();
    for (const status of ['SIMULATED_ACCEPTED', 'SIMULATED_ACCEPTED_WITH_OBSERVATIONS', 'SIMULATED_REJECTED'] as const) {
      const expectedUnsignedXml = generateSyntheticCdr(f.issuerRuc, 'FQ01-1', status);
      const result = verifySyntheticCdr({ ...SYNTHETIC_SCOPE, ...f, reference: 'FQ01-1', expectedUnsignedXml,
        xml: f.sign(expectedUnsignedXml, 'ApplicationResponse') });
      expect(result.status).toBe(status);
      expect(result.officialTrust).toBe(false);
    }
    const custom = buildCryptoEvidenceFixture('00000000003');
    const expectedUnsignedXml = custom.generateSyntheticCdr('00000000001', 'FQ01-1', 'ACCEPTED');
    expect(verifySyntheticCdr({ ...SYNTHETIC_SCOPE, ...custom, issuerRuc: '00000000001', reference: 'FQ01-1', expectedUnsignedXml,
      xml: custom.sign(expectedUnsignedXml, 'ApplicationResponse') }).senderRuc).toBe('00000000003');
    expect(() => buildCryptoEvidenceFixture('20123456789')).toThrow();
    expect(() => generateSyntheticCdr('20123456789', 'FQ01-1', 'ACCEPTED')).toThrow();
  });
  it('CJS closure accepts type as its fourth argument, standalone generator as its fifth', () => {
    const f = buildCryptoEvidenceFixture();
    const expectedUnsignedXml = f.generateSyntheticCdr(f.issuerRuc, 'FQ01-1', 'SIMULATED_ACCEPTED', '08');
    expect(expectedUnsignedXml).toBe(generateSyntheticCdr(f.issuerRuc, 'FQ01-1', 'SIMULATED_ACCEPTED', f.senderRuc, '08'));
    expect(verifySyntheticCdr({ ...SYNTHETIC_SCOPE, ...f, reference: 'FQ01-1', expectedDocumentTypeCode: '08', expectedUnsignedXml,
      xml: f.sign(expectedUnsignedXml, 'ApplicationResponse') })).toMatchObject({ documentTypeCode: '08', documentTypeBindingVerified: true, officialTrust: false });
    expect(f.generateSyntheticCdr(f.issuerRuc, 'FQ01-1', 'SIMULATED_ACCEPTED')).not.toContain('DocumentTypeCode');
    expect(() => f.generateSyntheticCdr(f.issuerRuc, 'FQ01-1', 'SIMULATED_ACCEPTED', '99')).toThrow();
  });
});

describe('SYNTHETIC CDR: authenticated sender, recipient and document; simulated outcomes only', () => {
  it.each([
    { responseCode: '0', notes: [], status: 'SIMULATED_ACCEPTED' },
    { responseCode: '0', notes: ['Observación FICTICIA QA'], status: 'SIMULATED_ACCEPTED_WITH_OBSERVATIONS' },
    { responseCode: '2335', notes: ['Rechazo FICTICIO QA'], status: 'SIMULATED_REJECTED' },
  ])('returns $status with no official acceptance', ({ status, ...options }) => {
    const result = verifySyntheticCdr(cdrInput(options));
    expect(result).toMatchObject({ ...SYNTHETIC_SCOPE, status, responseCode: options.responseCode, notes: options.notes,
      senderRuc: fixture.senderRuc, issuerRuc: fixture.issuerRuc, reference: 'FQA1-1', signatureVerified: true, certificateVerified: true, officialTrust: false });
    expect(result).toMatchObject({ documentTypeCode: null, documentTypeBindingVerified: false });
    expect(result.certificate).toMatchObject({ issuerRuc: fixture.senderRuc, revocationStatus: 'NOT_CHECKED', officialTrust: false });
  });
  it('accepts a matching optional Response/ReferenceID', () => {
    expect(verifySyntheticCdr(cdrInput({ responseReference: 'FQA1-1' })).status).toBe('SIMULATED_ACCEPTED');
  });
  it.each(['01', '03', '07', '08'])('binds explicit document type %s to the authenticated CBC field', expectedDocumentTypeCode => {
    const result = verifySyntheticCdr(cdrInput({ documentTypeCode: expectedDocumentTypeCode }, { expectedDocumentTypeCode }));
    expect(result).toMatchObject({ documentTypeCode: expectedDocumentTypeCode, documentTypeBindingVerified: true, officialTrust: false });
  });
  it.each([
    ['01', '07'], ['01', '08'], ['07', '01'], ['07', '08'], ['08', '01'], ['08', '07'], ['03', '01'],
  ])('rejects type %s for expected %s even with the same issuer, series and number', (documentTypeCode, expectedDocumentTypeCode) => {
    expect(() => verifySyntheticCdr(cdrInput({ documentTypeCode }, { expectedDocumentTypeCode }))).toThrow('SYNTHETIC_CDR_INVALID');
  });
  it('rejects missing type when explicitly expected and never infers it from F/B series', () => {
    for (const reference of ['FQA1-1', 'BQA1-1']) {
      expect(() => verifySyntheticCdr(cdrInput({ reference }, { reference, expectedDocumentTypeCode: '01' }))).toThrow();
      expect(verifySyntheticCdr(cdrInput({ reference }, { reference }))).toMatchObject({ documentTypeCode: null, documentTypeBindingVerified: false });
    }
  });
  it('reports the signed type without claiming binding when caller supplied no expected type', () => {
    expect(verifySyntheticCdr(cdrInput({ documentTypeCode: '07' }))).toMatchObject({ documentTypeCode: '07', documentTypeBindingVerified: false });
  });
  it.each(['99', '1', '07 ', undefined])('rejects invalid explicit expected type %s', expectedDocumentTypeCode => {
    expect(() => verifySyntheticCdr(cdrInput({ documentTypeCode: '07' }, { expectedDocumentTypeCode }))).toThrow();
  });
  it('rejects unknown-namespace and duplicate authenticated DocumentTypeCode fields', () => {
    const typed = unsignedSyntheticCdr({ documentTypeCode: '01' });
    for (const expectedUnsignedXml of [
      typed.replace('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>', '<qa:DocumentTypeCode xmlns:qa="urn:synthetic:wrong">01</qa:DocumentTypeCode>'),
      typed.replace('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>', '<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><cbc:DocumentTypeCode>07</cbc:DocumentTypeCode>'),
    ]) {
      expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml), expectedDocumentTypeCode: '01' }))).toThrow();
      expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
    }
  });
  it.each([
    { issuerRuc: '00000000202' }, { reference: 'FQA1-999' },
    { senderRuc: '00000000202' }, { senderRuc: '20123456789' }, { responseReference: 'FQA1-999' },
    { responseCode: '00' }, { responseCode: '-1' }, { responseCode: '0 OR ACCEPTED' }, { notes: [''] },
    { notes: ['x'.repeat(2049)] }, { notes: Array.from({ length: 51 }, () => 'FICTICIO') },
  ])('rejects a cryptographically valid but inconsistent CDR %j', options => {
    expect(() => verifySyntheticCdr(cdrInput(options))).toThrow('SYNTHETIC_CDR_INVALID');
  });
  it('rejects a different expected reference or recipient supplied by the caller', () => {
    expect(() => verifySyntheticCdr(cdrInput({}, { reference: 'FQA1-999' }))).toThrow();
    expect(() => verifySyntheticCdr(cdrInput({}, { issuerRuc: '00000000202' }))).toThrow();
  });
  it('rejects a correct signature with wrong CA or expired chain', () => {
    expect(() => verifySyntheticCdr(cdrInput({}, { rootCertificatePem: other.rootCertificatePem, pinnedRootSha256: other.pinnedRootSha256 }))).toThrow();
    expect(() => verifySyntheticCdr(cdrInput({}, { checkedAt: '2028-01-01T00:00:00Z' }))).toThrow();
  });
  it('rejects status tampering after signing', () => {
    const input = cdrInput({ responseCode: '2335' });
    input.xml = input.xml.replace('<cbc:ResponseCode>2335</cbc:ResponseCode>', '<cbc:ResponseCode>0</cbc:ResponseCode>');
    expect(() => verifySyntheticCdr(input)).toThrow();
  });
  it.each(['ReceiverParty', 'DocumentResponse', 'SenderParty'] as const)('rejects duplicate authenticated %s', name => {
    const expectedUnsignedXml = editSyntheticXml(unsignedSyntheticCdr(), doc => {
      const node = doc.getElementsByTagNameNS(CAC, name)[0];
      node.parentNode!.appendChild(node.cloneNode(true));
    });
    expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
  });
  it('rejects duplicate response fields and nested notes even when authenticated', () => {
    for (const name of ['ResponseCode', 'Note']) {
      const expectedUnsignedXml = editSyntheticXml(unsignedSyntheticCdr({ notes: ['FICTICIO'] }), doc => {
        const node = doc.getElementsByTagNameNS(CBC, name)[0];
        if (name === 'Note') node.appendChild(doc.createElementNS(CBC, 'cbc:ID'));
        else node.parentNode!.appendChild(node.cloneNode(true));
      });
      expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
    }
  });
  it('rejects a signed look-alike CBC namespace', () => {
    const expectedUnsignedXml = unsignedSyntheticCdr().replace(CBC, 'urn:synthetic:wrong-cbc');
    expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
  });
  it('rejects a bad ApplicationResponse root namespace', () => {
    const expectedUnsignedXml = unsignedSyntheticCdr().replace('xsd:ApplicationResponse-2', 'xsd:Invoice-2');
    expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
  });
  it('rejects a namespaced look-alike response field alongside the real field', () => {
    const expectedUnsignedXml = unsignedSyntheticCdr().replace('</cac:Response>', '<qa:ResponseCode xmlns:qa="urn:synthetic:wrong">0</qa:ResponseCode></cac:Response>');
    expect(() => verifySyntheticCdr(cdrInput({}, { expectedUnsignedXml, xml: fixture.sign(expectedUnsignedXml) }))).toThrow();
  });
  it('requires a signature and SYNTHETIC BETA scope', () => {
    expect(() => verifySyntheticCdr(cdrInput({}, { xml: unsignedSyntheticCdr() }))).toThrow();
    expect(() => verifySyntheticCdr(cdrInput({}, { environment: 'PRODUCTION' as 'BETA' }))).toThrow();
    expect(() => verifySyntheticCdr(cdrInput({}, { datasetClass: 'REAL' as 'SYNTHETIC' }))).toThrow();
  });
});
