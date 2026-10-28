// Se ejecuta por stdin dentro del contenedor SUNAT QA, sin acceso a APIs ni BD.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { XsdValidationService, XSD_ARCHIVE_SHA256 } = require('/workspace/services/sunat-service/dist/infrastructure/sunat/xsd-validation.service.js');
(async () => {
  const manifest = JSON.parse(fs.readFileSync('/tmp/factuez-xsd-runtime/manifest.json', 'utf8'));
  assert.equal(manifest.fiscalTransmission, false); assert.match(manifest.ruc, /^00\d{9}$/);
  const validator = new XsdValidationService();
  for (const entry of manifest.entries) {
    assert.match(entry.file, /^[A-Z_]+-(?:xml|request)\.xml$/);
    const bytes = fs.readFileSync('/tmp/factuez-xsd-runtime/' + entry.file);
    const result = await validator.validate(bytes, entry.kind);
    assert.equal(result.xmlSha256, entry.sha256); assert.equal(result.archiveSha256, XSD_ARCHIVE_SHA256);
    console.log('OK runtime XSD ' + entry.file + ': libxml, bytes exactos, sin red');
  }
  const invoice = fs.readFileSync('/tmp/factuez-xsd-runtime/INVOICE-xml.xml', 'utf8');
  const withoutId = invoice.replace(/<cbc:ID>FQ01-\d+<\/cbc:ID>/, ''); assert.notEqual(withoutId, invoice);
  await assert.rejects(validator.validate(withoutId, 'Invoice'), /XML rechazado por XSD oficial/);
  await assert.rejects(validator.validate('<!DOCTYPE x>' + invoice, 'Invoice'), /referencias externas/);
  await assert.rejects(validator.validate(invoice.replace('<Invoice', '<Invoice xml:base="https://example.invalid/"'), 'Invoice'), /referencias externas/);
  await assert.rejects(validator.validate('<SummaryDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1"/>', 'SummaryDocuments'), /XML rechazado por XSD oficial/);
  console.log('OK runtime negativo: XML sin ID, DTD, base externa y RC incompleto bloqueados');
})().catch(() => { console.error('Falló prueba runtime XSD; no se transmitió nada'); process.exitCode = 1; });
