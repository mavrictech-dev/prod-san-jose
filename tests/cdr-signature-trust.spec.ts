// Focused run: node node_modules/vitest/vitest.mjs run tests/cdr-signature-trust.spec.ts
import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdrSignatureTrustService } from '../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service';
import { CertificateTrustService, type CertificateTrustResult } from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import { XmlSignerService, parseSafeInvoice, verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';

const serviceRequire = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge: typeof import('node-forge') = serviceRequire('node-forge');
const { SignedXml }: typeof import('../services/sunat-service/node_modules/xml-crypto') = serviceRequire('xml-crypto');
const SUNAT_RUC = '20131312955';
const OTHER_RUC = '00000000001';
const PASSWORD = 'FICTICIO-CDR-UNIT-TEST';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
type ParsedXml = ReturnType<typeof parseSafeInvoice>;
type Issuer = {
  certificate: ReturnType<typeof forge.pki.createCertificate>;
  privateKey: ReturnType<typeof forge.pki.privateKeyFromPem>;
};

// Todos los certificados/PKCS#12 son generados aquí. El RUC sólo ejercita la
// política del servicio; estos fixtures no acreditan PKI oficial ni un CDR SUNAT.
function certificateFixture(serial: string, ruc?: string, issuer?: Issuer) {
  const pair = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = serial;
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 30 * 86400000);
  certificate.setSubject([
    { name: 'commonName', value: `CERTIFICADO FICTICIO CDR QA ${serial}` },
    ...(ruc ? [{ type: '2.5.4.97', value: `NTRPE-${ruc}` }] : []),
  ]);
  certificate.setIssuer(issuer?.certificate.subject.attributes ?? certificate.subject.attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', critical: true, cA: !issuer },
    { name: 'keyUsage', critical: true, digitalSignature: !!issuer, keyCertSign: !issuer, cRLSign: !issuer },
  ]);
  certificate.sign(issuer?.privateKey ?? pair.privateKey, forge.md.sha256.create());
  const certificatePem = forge.pki.certificateToPem(certificate);
  return { certificate, privateKey: pair.privateKey, certificatePem };
}

function signingFixture(serial: string, ruc: string, issuer: Issuer) {
  const fixture = certificateFixture(serial, ruc, issuer);
  const pkcs12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(
    fixture.privateKey, [fixture.certificate, issuer.certificate], PASSWORD, { algorithm: 'aes256' },
  )).getBytes(), 'binary');
  const x509 = new X509Certificate(fixture.certificatePem);
  return {
    certificatePem: fixture.certificatePem, pkcs12,
    fingerprint: x509.fingerprint256.replaceAll(':', '').toLowerCase(),
    embeddedCertificate: x509.raw.toString('base64'),
  };
}

function applicationResponse(senderRuc = SUNAT_RUC) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2" xmlns:ext="${EXT}" xmlns:cbc="${CBC}" xmlns:cac="${CAC}">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:ID Id="cdrDocument">CDR-FICTICIO-QA-1</cbc:ID>
  <cbc:IssueDate>2026-10-02</cbc:IssueDate>
  <cac:SenderParty><cac:PartyIdentification><cbc:ID>${senderRuc}</cbc:ID></cac:PartyIdentification></cac:SenderParty>
  <cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${OTHER_RUC}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty>
  <cac:DocumentResponse>
    <cac:Response><cbc:ReferenceID>FQA1-1</cbc:ReferenceID><cbc:ResponseCode>0</cbc:ResponseCode><cbc:Description>CDR FICTICIO UNIT TEST</cbc:Description></cac:Response>
    <cac:DocumentReference><cbc:ID>FQA1-1</cbc:ID></cac:DocumentReference>
  </cac:DocumentResponse>
</ApplicationResponse>`;
}

function one(parsed: ParsedXml, namespace: string, name: string) {
  const nodes = parsed.document.getElementsByTagNameNS(namespace, name);
  expect(nodes.length).toBe(1);
  return nodes[0];
}

function mutate(xml: string, edit: (parsed: ParsedXml) => void) {
  const parsed = parseSafeInvoice(xml, 'ApplicationResponse');
  edit(parsed);
  return parsed.document.toString();
}

// Verificación criptográfica directa con pin externo, incluso si KeyInfo cambia.
function cryptographicSignatureValid(xml: string, certificatePem: string) {
  const parsed = parseSafeInvoice(xml, 'ApplicationResponse');
  const verifier = new SignedXml({ publicCert: certificatePem, getCertFromKeyInfo: () => null });
  verifier.loadSignature(one(parsed, DS, 'Signature').toString());
  return verifier.checkSignature(xml);
}

let directory: string;
let rootPem: string;
let signer: ReturnType<typeof signingFixture>;
let otherSigner: ReturnType<typeof signingFixture>;
let wrongIdentitySigner: ReturnType<typeof signingFixture>;
let pin: { file: string; hash: string };
let unsignedXml: string;
let signed: ReturnType<XmlSignerService['sign']>;
let otherSigned: ReturnType<XmlSignerService['sign']>;
let trust: CertificateTrustService;
let evaluate: MockInstance<CertificateTrustService['evaluate']>;
let service: CdrSignatureTrustService;

async function publicPin(name: string, text: string) {
  const file = join(directory, name);
  const bytes = Buffer.from(text, 'utf8');
  // Sólo material público llega al filesystem; las claves y P12 quedan en memoria.
  await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  return { file, hash: createHash('sha256').update(bytes).digest('hex') };
}

function configurePin(value: { file: string; hash: string }) {
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', value.file);
  vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', value.hash);
}

function unitTrustProof(overrides: Partial<CertificateTrustResult> = {}): CertificateTrustResult {
  return {
    profile: 'OFFLINE-PINNED-ROOTS-CRL-v1', chainValid: true, identityMatched: true,
    revocation: 'VERIFIED_OFFLINE_CRL', trustStoreSha256: null,
    certificateFingerprint: signer.fingerprint, checkedAt: new Date().toISOString(), blockers: [],
    ...overrides,
  };
}

beforeAll(async () => {
  const root = certificateFixture('01');
  rootPem = root.certificatePem;
  signer = signingFixture('02', SUNAT_RUC, root);
  otherSigner = signingFixture('03', SUNAT_RUC, root);
  wrongIdentitySigner = signingFixture('04', OTHER_RUC, root);
  unsignedXml = applicationResponse();
  signed = new XmlSignerService().sign(unsignedXml, signer.pkcs12, PASSWORD, 'ApplicationResponse');
  otherSigned = new XmlSignerService().sign(unsignedXml, otherSigner.pkcs12, PASSWORD, 'ApplicationResponse');
  directory = await mkdtemp(join(tmpdir(), 'factuez-cdr-signature-unit-'));
  pin = await publicPin('fictitious-signer-chain.pem', signer.certificatePem + rootPem);
}, 30000);

beforeEach(() => {
  configurePin(pin);
  // Aun los casos con evaluate real tienen un entorno sin pins/secretos externos.
  for (const name of ['SUNAT_TRUST_STORE_FILE', 'SUNAT_TRUST_STORE_SHA256',
    'SUNAT_CRL_BUNDLE_FILE', 'SUNAT_CRL_BUNDLE_SHA256', 'SUNAT_OPENSSL_PATH']) vi.stubEnv(name, '');
  trust = new CertificateTrustService();
  // Único stub positivo: la política PKI en esta instancia de prueba unitaria.
  // Ni el pin filesystem, ni el parser, ni XmlSigner/XMLDSig están simulados.
  evaluate = vi.spyOn(trust, 'evaluate').mockResolvedValue(unitTrustProof());
  service = new CdrSignatureTrustService(trust);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  for (const fixture of [signer, otherSigner, wrongIdentitySigner]) fixture?.pkcs12.fill(0);
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('CdrSignatureTrustService: XMLDSig real con confianza PKI simulada sólo en unit tests', () => {
  it('acepta ApplicationResponse íntegro y entrega al trust el certificado/identidad fijados por pin', async () => {
    const x509 = new X509Certificate(signer.certificatePem);
    expect(x509.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(forge.pki.certificateFromPem(signer.certificatePem).subject.getField({ type: '2.5.4.97' })?.value)
      .toBe(`NTRPE-${SUNAT_RUC}`);
    expect(signed.certificateFingerprintSha256).toBe(signer.fingerprint);
    expect(verifyLocalSignedInvoice(signed.xml, signer.certificatePem, unsignedXml, 'ApplicationResponse'))
      .toBe(signed.digestValue);
    expect(cryptographicSignatureValid(signed.xml, signer.certificatePem)).toBe(true);
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      fingerprint: signer.fingerprint, certificatePem: signer.certificatePem.trimEnd(),
      chainPems: [rootPem.trimEnd()], selfSigned: false, digitalSignature: true,
      subjectRucCandidates: [SUNAT_RUC], expiresAt: expect.any(Date),
    }), SUNAT_RUC);
  });

  it.each(['SUNAT_CDR_SIGNER_CERT_FILE', 'SUNAT_CDR_SIGNER_CERT_SHA256'])('falla cerrado sin %s', async name => {
    vi.stubEnv(name, undefined);
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(['0'.repeat(64), 'g'.repeat(64), 'abcd'])('rechaza hash incorrecto o mal formado (%s)', async hash => {
    vi.stubEnv('SUNAT_CDR_SIGNER_CERT_SHA256', hash);
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(['missing', 'relative', 'url', 'directory'])('rechaza pin %s sin consultar confianza', async kind => {
    const files = { missing: join(directory, 'does-not-exist.pem'), relative: 'fictitious.pem',
      url: 'https://example.invalid/fictitious.pem', directory };
    vi.stubEnv('SUNAT_CDR_SIGNER_CERT_FILE', files[kind as keyof typeof files]);
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each(['sin certificado', 'basura adicional'])('rechaza contenido del pin %s aun con hash correcto', async kind => {
    const text = kind === 'sin certificado' ? 'FICTICIO NO ES PEM' : signer.certificatePem + 'FICTICIO TRAILING DATA';
    configurePin(await publicPin(`invalid-${kind === 'sin certificado' ? 'pem' : 'trailer'}.pem`, text));
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('rechaza firma ausente aun si la política PKI simulada resulta positiva', async () => {
    await expect(service.verify(Buffer.from(unsignedXml))).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it.each(['Description', 'ResponseCode', 'ReferenceID'])('rechaza contenido firmado manipulado: %s', async name => {
    const tampered = mutate(signed.xml, parsed => { one(parsed, CBC, name).textContent = 'ALTERADO'; });
    expect(tampered).not.toBe(signed.xml);
    await expect(service.verify(Buffer.from(tampered))).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it.each(['SignatureValue', 'DigestValue'])('rechaza %s manipulado manteniendo Base64 válido', async name => {
    const tampered = mutate(signed.xml, parsed => {
      const node = one(parsed, DS, name);
      const bytes = Buffer.from(node.textContent!, 'base64');
      bytes[0] ^= 1;
      node.textContent = bytes.toString('base64');
    });
    expect(tampered).not.toBe(signed.xml);
    await expect(service.verify(Buffer.from(tampered))).resolves.toBe(false);
  });

  it('rechaza otro certificado en KeyInfo aun con igual RUC y firma criptográfica válida bajo el pin', async () => {
    const tampered = mutate(signed.xml, parsed => {
      one(parsed, DS, 'X509Certificate').textContent = otherSigner.embeddedCertificate;
    });
    expect(otherSigner.fingerprint).not.toBe(signer.fingerprint);
    expect(cryptographicSignatureValid(tampered, signer.certificatePem)).toBe(true);
    expect(() => verifyLocalSignedInvoice(tampered, signer.certificatePem, unsignedXml, 'ApplicationResponse'))
      .toThrow('Certificado XML no coincide');
    await expect(service.verify(Buffer.from(tampered))).resolves.toBe(false);
  });

  it('rechaza firma real de otro firmante: KeyInfo no reemplaza el pin externo', async () => {
    expect(cryptographicSignatureValid(otherSigned.xml, otherSigner.certificatePem)).toBe(true);
    await expect(service.verify(Buffer.from(otherSigned.xml))).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: signer.fingerprint }), SUNAT_RUC);
  });

  it('rechaza firma de otra clave aunque KeyInfo copie el certificado fijado', async () => {
    const forged = mutate(otherSigned.xml, parsed => {
      one(parsed, DS, 'X509Certificate').textContent = signer.embeddedCertificate;
    });
    expect(() => cryptographicSignatureValid(forged, signer.certificatePem)).toThrow('invalid signature');
    await expect(service.verify(Buffer.from(forged))).resolves.toBe(false);
  });

  it.each([
    ['cadena no confiable', { chainValid: false }],
    ['identidad no coincidente', { identityMatched: false }],
    ['CRL pendiente', { revocation: 'PENDING' }],
    ['CRL inválida/revocación', { revocation: 'INVALID' }],
  ] as const)('falla cerrado con %s aunque el XML firmado sea íntegro', async (_name, proof) => {
    evaluate.mockResolvedValue(unitTrustProof(proof));
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('convierte un error del evaluador de confianza en false', async () => {
    evaluate.mockRejectedValue(new Error('FICTICIO TRUST ERROR'));
    await expect(service.verify(Buffer.from(signed.xml))).resolves.toBe(false);
  });

  it('con evaluate real, el certificado ficticio no acredita cadena/CRL sin trust store', async () => {
    const realTrust = new CertificateTrustService();
    const realEvaluate = vi.spyOn(realTrust, 'evaluate');
    await expect(new CdrSignatureTrustService(realTrust).verify(Buffer.from(signed.xml))).resolves.toBe(false);
    expect(realEvaluate).toHaveBeenCalledOnce();
    await expect(realEvaluate.mock.results[0].value).resolves.toMatchObject({
      identityMatched: true, chainValid: false, revocation: 'PENDING',
      blockers: ['TRUST_STORE_OR_CHAIN_NOT_VERIFIED'],
    });
  });

  it('con evaluate real, rechaza organizationIdentifier de otro RUC pese a firma y pin válidos', async () => {
    configurePin(await publicPin('wrong-identity.pem', wrongIdentitySigner.certificatePem + rootPem));
    const wrongSigned = new XmlSignerService().sign(unsignedXml, wrongIdentitySigner.pkcs12, PASSWORD, 'ApplicationResponse');
    expect(verifyLocalSignedInvoice(wrongSigned.xml, wrongIdentitySigner.certificatePem, unsignedXml, 'ApplicationResponse'))
      .toBe(wrongSigned.digestValue);
    const realTrust = new CertificateTrustService();
    const realEvaluate = vi.spyOn(realTrust, 'evaluate');
    await expect(new CdrSignatureTrustService(realTrust).verify(Buffer.from(wrongSigned.xml))).resolves.toBe(false);
    expect(realEvaluate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subjectRucCandidates: [OTHER_RUC] }), SUNAT_RUC);
    await expect(realEvaluate.mock.results[0].value).resolves.toMatchObject({
      identityMatched: false, chainValid: false, revocation: 'PENDING', blockers: ['CERTIFICATE_RUC_NOT_MATCHED'],
    });
  });

  it('rechaza dos Signature con IDs distintos', async () => {
    const doubled = mutate(signed.xml, parsed => {
      const copy = one(parsed, DS, 'Signature').cloneNode(true) as ParsedXml['root'];
      copy.setAttribute('Id', 'secondSignature');
      parsed.extension.appendChild(copy);
    });
    expect(parseSafeInvoice(doubled, 'ApplicationResponse').document.getElementsByTagNameNS(DS, 'Signature').length).toBe(2);
    await expect(service.verify(Buffer.from(doubled))).resolves.toBe(false);
  });

  it('rechaza una única Signature fuera de ExtensionContent', async () => {
    const moved = mutate(signed.xml, parsed => { parsed.root.appendChild(one(parsed, DS, 'Signature')); });
    await expect(service.verify(Buffer.from(moved))).resolves.toBe(false);
  });

  it.each(['Id', 'ID', 'id', 'xml:id'])('rechaza IDs duplicados también en atributo %s', async attribute => {
    const duplicate = mutate(signed.xml, parsed => {
      const signatureId = one(parsed, DS, 'Signature').getAttribute('Id');
      expect(signatureId).toBe('signatureFactuEz');
      if (attribute === 'xml:id') parsed.root.setAttributeNS('http://www.w3.org/XML/1998/namespace', attribute, signatureId!);
      else parsed.root.setAttribute(attribute, signatureId!);
    });
    expect(() => parseSafeInvoice(duplicate, 'ApplicationResponse')).toThrow('IDs XML duplicados');
    await expect(service.verify(Buffer.from(duplicate))).resolves.toBe(false);
  });

  it('rechaza SenderParty de otro RUC aunque la firma completa sea válida', async () => {
    const otherSenderXml = applicationResponse(OTHER_RUC);
    const otherSenderSigned = new XmlSignerService().sign(otherSenderXml, signer.pkcs12, PASSWORD, 'ApplicationResponse');
    expect(verifyLocalSignedInvoice(otherSenderSigned.xml, signer.certificatePem, otherSenderXml, 'ApplicationResponse'))
      .toBe(otherSenderSigned.digestValue);
    await expect(service.verify(Buffer.from(otherSenderSigned.xml))).resolves.toBe(false);
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it.each(['ausente', 'duplicado'])('rechaza SenderParty %s incluso firmado correctamente', async kind => {
    const ambiguousXml = mutate(unsignedXml, parsed => {
      const sender = one(parsed, CAC, 'SenderParty');
      if (kind === 'ausente') parsed.root.removeChild(sender);
      else parsed.root.appendChild(sender.cloneNode(true));
    });
    const ambiguousSigned = new XmlSignerService().sign(ambiguousXml, signer.pkcs12, PASSWORD, 'ApplicationResponse');
    expect(cryptographicSignatureValid(ambiguousSigned.xml, signer.certificatePem)).toBe(true);
    await expect(service.verify(Buffer.from(ambiguousSigned.xml))).resolves.toBe(false);
  });

  it.each(['#cdrDocument', 'https://example.invalid/cdr'])('rechaza referencia parcial/remota %s', async uri => {
    const partial = mutate(signed.xml, parsed => { one(parsed, DS, 'Reference').setAttribute('URI', uri); });
    await expect(service.verify(Buffer.from(partial))).resolves.toBe(false);
  });

  it.each([
    ['SignatureMethod', 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'],
    ['DigestMethod', 'http://www.w3.org/2000/09/xmldsig#sha1'],
    ['CanonicalizationMethod', 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'],
  ])('rechaza algoritmo fuera de perfil en %s', async (name, algorithm) => {
    const downgraded = mutate(signed.xml, parsed => { one(parsed, DS, name).setAttribute('Algorithm', algorithm); });
    await expect(service.verify(Buffer.from(downgraded))).resolves.toBe(false);
  });

  it('rechaza transformación XMLDSig adicional', async () => {
    const extraTransform = mutate(signed.xml, parsed => {
      const transforms = one(parsed, DS, 'Transforms');
      transforms.appendChild(transforms.firstChild!.cloneNode(true));
    });
    await expect(service.verify(Buffer.from(extraTransform))).resolves.toBe(false);
  });

  it('rechaza bytes UTF-8 inválidos sin normalizarlos a un XML diferente', async () => {
    const invalid = Buffer.concat([Buffer.from(signed.xml), Buffer.from([0xff])]);
    expect(Buffer.from(invalid.toString('utf8')).equals(invalid)).toBe(false);
    await expect(service.verify(invalid)).resolves.toBe(false);
  });
});
