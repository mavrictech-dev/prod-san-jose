// Ejecución en el contenedor QA por stdin. Sin Prisma, Redis, HTTP, datos
// guardados o certificados del usuario. Genera sólo un P12 ficticio en memoria.
'use strict';
const { createRequire } = require('node:module');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const localRequire = createRequire('/workspace/services/sunat-service/package.json');
const forge = localRequire('node-forge');
const { calculateDocumentTotals } = require('/workspace/packages/sunat-core/dist/tax');
const { buildNoteQaSnapshot } = require('/workspace/packages/sunat-core/dist/notes-qa');
const { prepareNotesQaXml } = require('/workspace/services/sunat-service/dist/application/notes-qa-pipeline');
const { verifyNotesTransportPackage } = require('/workspace/services/sunat-service/dist/application/notes-transport-qa-package');
const { XsdValidationService } = require('/workspace/services/sunat-service/dist/infrastructure/sunat/xsd-validation.service');
async function main() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const key = forge.pki.privateKeyFromPem(pair.privateKey), cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(pair.publicKey); cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 3600000); cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'FICTICIO QA SIN VALOR FISCAL' }]); cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }]); cert.sign(key, forge.md.sha256.create());
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(key, cert, 'FICTICIO', { algorithm: 'aes256' })).getBytes(), 'binary');
  const xsd = new XsdValidationService(), results = [];
  try {
    for (const originalType of ['01', '03']) for (const type of ['07', '08']) {
      const original = { documentId: randomUUID(), environment: 'BETA', documentTypeCode: originalType,
        series: originalType === '01' ? 'FQ01' : 'BQ01', number: '1', fullNumber: `${originalType === '01' ? 'FQ01' : 'BQ01'}-1`,
        issueDate: '2026-10-01T16:00:00Z', currencyCode: 'PEN', operationTypeCode: '0101',
        issuer: { identityType: '6', identityNumber: '00000000001', legalName: 'FICTICIO QA', ubigeo: '150101', establishmentCode: '0001' },
        customer: originalType === '01' ? { identityType: '6', identityNumber: '00000000000', legalName: 'CLIENTE FICTICIO' }
          : { identityType: '0', identityNumber: '0', legalName: 'CLIENTE FICTICIO' },
        ...calculateDocumentTotals([{ description: 'ITEM FICTICIO', unitCode: 'NIU', quantity: '2', unitPriceWithTax: '11.80', taxAffectationCode: '10', igvRate: '18' }]) };
      const note = buildNoteQaSnapshot(original, { idempotencyKey: randomUUID(), documentTypeCode: type,
        reasonCode: type === '07' ? '01' : '02', reasonDescription: 'SUSTENTO FICTICIO',
        ...(type === '08' ? { lines: [{ originalLineNumber: 1, quantity: '1', unitPriceWithTax: '1.18' }] } : {}) },
        { documentId: randomUUID(), number: '1', issueDate: '2026-10-02T10:00:00Z' });
      const summary = originalType === '03' ? 'RC-20261002-1' : undefined;
      const prepared = prepareNotesQaXml(note, original, p12, 'FICTICIO', summary);
      verifyNotesTransportPackage({ snapshot: note, digestValue: prepared.digestValue, certificateFingerprint: prepared.certificateFingerprintSha256 },
        original, Buffer.from(prepared.xml), prepared.zip, `${prepared.fileName}.zip`, summary);
      const proof = await xsd.validate(prepared.xml, summary ? 'SummaryDocuments' : type === '07' ? 'CreditNote' : 'DebitNote');
      results.push({ originalType, type, root: summary ? 'SummaryDocuments' : type === '07' ? 'CreditNote' : 'DebitNote', signatureVerified: true, xsd: proof.profile });
    }
  } finally { p12.fill(0); }
  console.log(JSON.stringify({ localOnly: true, readsUserData: false, results }));
}
main().catch(error => { console.error('AUDITORIA QA FALLIDA:', error.message); process.exitCode = 1; });
