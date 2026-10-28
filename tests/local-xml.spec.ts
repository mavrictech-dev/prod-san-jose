import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { buildInvoiceUbl } from '../packages/sunat-core/src/ubl';
import { validateLocalInvoice, limaIssueDate, LOCAL_XML_PROFILE } from '../packages/sunat-core/src/local-validation';
import { XmlSignerService, verifyLocalSignedInvoice, parseSafeInvoice, MAX_XML_BYTES } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { prepareLocalXml } from '../services/sunat-service/src/infrastructure/crypto/local-xml-pipeline';
import { LocalXmlValidationService } from '../services/sunat-service/src/application/local-xml-validation.service';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const forge = require('node-forge'); const { unzipSync } = require('fflate');
const snapshot: FiscalDocumentSnapshot = {
  documentId: '50000000-0000-4000-8000-000000000021', environment: 'BETA',
  documentTypeCode: '03', series: 'B001', number: '1', fullNumber: 'B001-1',
  issueDate: '2026-10-02T03:30:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
  issuer: { identityType: '6', identityNumber: '00000000000', legalName: 'EMISOR FICTICIO QA', ubigeo: '200101', establishmentCode: 'QA' },
  customer: { identityType: '0', identityNumber: '0', legalName: 'CLIENTE QA' },
  ...calculateDocumentTotals([{ description: 'Diésel & <QA> "combustible"', unitCode: 'GLL', quantity: '2.5', unitPriceWithTax: '18.50', taxAffectationCode: '10', igvRate: '18' }]),
};
let p12: Buffer; let certificatePem: string; let unsigned: string; let signed: ReturnType<XmlSignerService['sign']>;
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const key = forge.pki.privateKeyFromPem(pair.privateKey);
  const cert = forge.pki.createCertificate(); cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey); cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 3600000); cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'FICTICIO QA' }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }]); cert.sign(key, forge.md.sha256.create());
  // Primera bolsa de certificado NO corresponde a la clave; no asumir posición.
  const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const other = forge.pki.createCertificate(); other.publicKey = forge.pki.publicKeyFromPem(otherPair.publicKey); other.serialNumber = '02';
  other.setSubject([{ name: 'commonName', value: 'NO ES EL FIRMANTE' }]); other.setIssuer(other.subject.attributes); other.sign(key, forge.md.sha256.create());
  p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, [other, cert], 'QA-only', { algorithm: 'aes256' })).getBytes(), 'binary');
  certificatePem = forge.pki.certificateToPem(cert); unsigned = buildInvoiceUbl(snapshot);
  signed = new XmlSignerService().sign(unsigned, p12, 'QA-only');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('Perfil local UBL: sin afirmar homologación', () => {
  it('valida decimales exactos, preserva snapshot y usa fecha Lima', () => {
    const before = structuredClone(snapshot); validateLocalInvoice(snapshot); expect(snapshot).toEqual(before);
    expect(limaIssueDate(snapshot.issueDate)).toBe('2026-10-01'); expect(unsigned).toContain('<cbc:IssueDate>2026-10-01</cbc:IssueDate>');
    expect(unsigned).toContain('Diésel &amp; &lt;QA&gt; &quot;combustible&quot;');
  });
  it.each(['igvAmount', 'payableAmount', 'taxableAmount'] as const)('rechaza total %s adulterado', field => {
    const doc = structuredClone(snapshot); doc.totals[field] = '999.99'; expect(() => validateLocalInvoice(doc)).toThrow('perfil local');
  });
  it.each(['unitValue', 'lineExtensionAmount', 'igvAmount', 'totalAmount'] as const)('rechaza línea %s adulterada', field => {
    const doc = structuredClone(snapshot); doc.lines[0][field] = '999.99'; expect(() => validateLocalInvoice(doc)).toThrow();
  });
  it('no firma exoneraciones, moneda inyectada, producción, texto ilegal o factura sin RUC', () => {
    for (const change of [
      (doc: FiscalDocumentSnapshot) => doc.lines[0].taxAffectationCode = '20',
      (doc: FiscalDocumentSnapshot) => doc.lines[0].description = 'texto\u0000ilegal',
      (doc: FiscalDocumentSnapshot) => doc.lines[0].quantity = '1<script>',
      (doc: FiscalDocumentSnapshot) => doc.environment = 'PRODUCTION',
      (doc: FiscalDocumentSnapshot) => doc.currencyCode = 'PEN"/>' as never,
      (doc: FiscalDocumentSnapshot) => { doc.documentTypeCode = '01'; doc.series = 'F001'; doc.fullNumber = 'F001-1'; },
    ]) { const doc = structuredClone(snapshot); change(doc); expect(() => validateLocalInvoice(doc)).toThrow(); }
  });
});
describe('Firma y verificación independiente local', () => {
  it('elige la pareja correcta aunque no sea la primera bolsa; firma toda Invoice', () => {
    expect(signed.certificateFingerprintSha256).toBe(new X509Certificate(certificatePem).fingerprint256.replace(/:/g, '').toLowerCase());
    expect(signed.xml).toContain('Reference URI=""');
    expect(verifyLocalSignedInvoice(signed.xml, certificatePem, unsigned)).toBe(signed.digestValue);
    expect(signed.xml).not.toContain('PRIVATE KEY'); expect(signed.xml).not.toContain('QA-only');
  });
  it('rechaza cambiar importes, cliente o RUC después de firmar', () => {
    for (const [before, after] of [['46.25', '46.26'], ['CLIENTE QA', 'OTRO CLIENTE'], ['00000000000', '20450819230']])
      expect(() => verifyLocalSignedInvoice(signed.xml.replaceAll(before, after), certificatePem, unsigned)).toThrow();
  });
  it('rechaza certificado externo diferente, contraseña incorrecta y doble firma', () => {
    expect(() => verifyLocalSignedInvoice(signed.xml, 'INVALID PEM', unsigned)).toThrow();
    expect(() => new XmlSignerService().sign(unsigned, p12, 'incorrecta')).toThrow('PKCS#12');
    expect(() => new XmlSignerService().sign(signed.xml, p12, 'QA-only')).toThrow('ya firmado');
  });
  it('rechaza referencias parciales/remotas, SHA1 y transformaciones extra', () => {
    for (const xml of [signed.xml.replace('URI=""', 'URI="#cliente"'), signed.xml.replace('URI=""', 'URI="http://example.test/key"'),
      signed.xml.replace('rsa-sha256', 'rsa-sha1'), signed.xml.replace('<Transforms>', '<Transforms><Transform Algorithm="http://evil.test"/>')])
      expect(() => verifyLocalSignedInvoice(xml, certificatePem, unsigned)).toThrow();
  });
  it('rechaza wrapping, IDs duplicados y una firma válida de otro snapshot', () => {
    expect(() => verifyLocalSignedInvoice(`<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">${signed.xml.replace(/<\?xml[^>]+>/, '')}</Invoice>`, certificatePem, unsigned)).toThrow();
    expect(() => verifyLocalSignedInvoice(signed.xml.replace('<cbc:ID>B001-1', '<cbc:ID Id="signatureFactuEz">B001-1'), certificatePem, unsigned)).toThrow('duplicados');
    expect(() => verifyLocalSignedInvoice(signed.xml, certificatePem, unsigned.replace('CLIENTE QA', 'OTRO'))).toThrow('snapshot');
  });
  it('bloquea DTD, entidades, comentarios, XML roto, profundidad y tamaño', () => {
    for (const xml of ['<!DOCTYPE Invoice [<!ENTITY a SYSTEM "file:///etc/passwd">]>' + unsigned,
      unsigned.replace('<cbc:ID>', '<!-- comentario --><cbc:ID>'), unsigned.replace('</Invoice>', ''),
      unsigned.replace('<cbc:ID>B001-1</cbc:ID>', '<x>'.repeat(45) + 'a' + '</x>'.repeat(45)), 'a'.repeat(MAX_XML_BYTES + 1)])
      expect(() => parseSafeInvoice(xml)).toThrow();
  });
  it('genera ZIP determinista con un único XML firmado y sin secretos', () => {
    const result = prepareLocalXml(snapshot, p12, 'QA-only'); const files = unzipSync(result.zip);
    expect(result.profile).toBe(LOCAL_XML_PROFILE); expect(Object.keys(files)).toEqual(['00000000000-03-B001-1.xml']);
    expect(Buffer.from(files['00000000000-03-B001-1.xml']).toString()).toBe(result.xml);
    expect(prepareLocalXml(snapshot, p12, 'QA-only').zip).toEqual(result.zip);
  });
});
function fixture() {
  vi.stubEnv('LOCAL_XML_VALIDATION_ENABLED', 'true');
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: snapshot.documentId, immutableSnapshot: snapshot, fiscalTransmission: false })));
  vi.stubGlobal('fetch', fetchMock);
  const fiscal = { issuerRuc: snapshot.issuer.identityNumber, environment: 'BETA', status: 'BUILDING', immutablePayload: JSON.parse(JSON.stringify(snapshot)) };
  const credentials = { revision: 1, certificateCipher: 'ENCRYPTED', certificatePasswordCipher: 'ENCRYPTED', certificateFingerprint: signed.certificateFingerprintSha256,
    certificateSelfSigned: true, certificateExpiresAt: new Date(Date.now() + 86400000) };
  const findUnique = vi.fn(async () => null as any); const prepare = vi.fn(); const open = vi.fn(); const put = vi.fn();
  const prisma = { fiscalDocument: { findUnique: vi.fn(async () => fiscal) }, sunatCredentials: { findUnique: vi.fn(async () => credentials) }, localXmlValidation: { findUnique } };
  const service = new LocalXmlValidationService(prisma as never, { put } as never, { open } as never, { prepare } as never);
  return { service, fetchMock, fiscal, credentials, findUnique, prepare, open, put, prisma };
}
describe('Aislamiento de la prueba local', () => {
  it('deshabilitado por defecto y sin token no consulta BD ni certificados', async () => {
    const f = fixture(); vi.stubEnv('LOCAL_XML_VALIDATION_ENABLED', 'false');
    await expect(f.service.prepare(snapshot.documentId, 'actor', 'Bearer qa')).rejects.toThrow('deshabilitadas');
    vi.stubEnv('LOCAL_XML_VALIDATION_ENABLED', 'true'); await expect(f.service.prepare(snapshot.documentId, 'actor')).rejects.toThrow('sesión');
    expect(f.open).not.toHaveBeenCalled(); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])('Billing HTTP %i falla cerrado', async status => {
    const f = fixture(); f.fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(f.service.status(snapshot.documentId, 'Bearer qa')).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it('no firma RUC real, producción, snapshot ajeno, fiscal aceptado o certificado sin vigencia', async () => {
    const f = fixture(); f.fiscal.status = 'ACCEPTED'; await expect(f.service.status(snapshot.documentId, 'Bearer qa')).rejects.toThrow('fiscal');
    f.fiscal.status = 'BUILDING'; f.credentials.certificateExpiresAt = new Date(0);
    await expect(f.service.status(snapshot.documentId, 'Bearer qa')).rejects.toThrow('certificado');
    const real = structuredClone(snapshot); real.issuer.identityNumber = '20450819230';
    f.fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: real.documentId, immutableSnapshot: real, fiscalTransmission: false })));
    await expect(f.service.status(real.documentId, 'Bearer qa')).rejects.toThrow('ficticios'); expect(f.prepare).not.toHaveBeenCalled();
  });
  it('resultado redacted sin confundir firma con CDR o XSD', async () => {
    const f = fixture(); const status = await f.service.status(snapshot.documentId, 'Bearer qa');
    expect(status).toMatchObject({ ready: false, fiscalTransmission: false, xsdValidated: false, sunatRulesValidated: false, trustAndRucVerified: false, cdrReceived: false });
    expect(JSON.stringify(status)).not.toMatch(/Cipher|StorageKey|password/); expect(f.put).not.toHaveBeenCalled();
  });
  it('una prueba archivada se reutiliza sin abrir el certificado ni generar archivos', async () => {
    const f = fixture(); const { createHash } = await import('node:crypto');
    f.findUnique.mockResolvedValue({ id: 'qa-proof', profile: LOCAL_XML_PROFILE, certificateFingerprint: f.credentials.certificateFingerprint,
      snapshotSha256: createHash('sha256').update(JSON.stringify(JSON.parse(JSON.stringify(snapshot)))).digest('hex'), credentialRevision: 1, zipSha256: 'hash', createdAt: new Date() });
    const first = await f.service.prepare(snapshot.documentId, 'actor', 'Bearer qa');
    const repeated = await f.service.prepare(snapshot.documentId, 'actor', 'Bearer qa');
    expect(first.id).toBe('qa-proof'); expect(repeated.id).toBe(first.id);
    expect(f.open).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
  });
  it('persiste con lock ejecutado sin deserializar void, limpia secretos y no cambia estado fiscal', async () => {
    const f = fixture();
    const certificateBytes = Buffer.from(p12); const passwordBytes = Buffer.from('QA-only');
    f.open.mockImplementation((_cipher, context) => context.field === 'certificate' ? certificateBytes : passwordBytes);
    f.prepare.mockResolvedValue(prepareLocalXml(snapshot, p12, 'QA-only'));
    f.put.mockResolvedValue({ storageKey: 'private-QA', sha256: '0'.repeat(64), sizeBytes: 10 });
    const execute = vi.fn(async () => 1); const query = vi.fn(async () => []);
    const upsert = vi.fn(async ({ create }) => ({ ...create, id: 'qa-proof', createdAt: new Date() }));
    (f.prisma as any).$transaction = async (callback: any) => callback({
      $executeRawUnsafe: execute, $queryRawUnsafe: query, sunatCredentials: f.prisma.sunatCredentials,
      fiscalDocument: f.prisma.fiscalDocument, localXmlValidation: { upsert },
    });
    const result = await f.service.prepare(snapshot.documentId, 'actor', 'Bearer qa');
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), '00000000000:BETA');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), snapshot.documentId);
    expect(result).toMatchObject({ ready: true, signatureVerified: true, fiscalTransmission: false, cdrReceived: false });
    expect(certificateBytes.every(byte => byte === 0)).toBe(true); expect(passwordBytes.every(byte => byte === 0)).toBe(true);
    expect(f.fiscal.status).toBe('BUILDING'); expect(upsert).toHaveBeenCalledOnce();
  });
});
