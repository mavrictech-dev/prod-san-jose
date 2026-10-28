// Corre dentro del SUNAT QA: lectura sólo de 20615878481/BETA y una firma aislada.
const fs = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { Client } = require('/workspace/services/sunat-service/node_modules/pg');
const { zipSync, unzipSync } = require('/workspace/services/sunat-service/node_modules/fflate');
const core = require('/workspace/services/sunat-service/node_modules/@factuez/sunat-core');
const { SecretVault } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/secret-vault');
const { inspectCertificate } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/certificate-inspector');
const { XmlSignerService } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/xml-signer.service');
const { XsdValidationService } = require('/workspace/services/sunat-service/dist/infrastructure/sunat/xsd-validation.service');
const { buildPilotXml } = require('./beta-pilot.fixture.cjs');
const ruc = '20615878481', environment = 'BETA', reference = 'FQ01-1';
const root = '/tmp/factuez-beta-pilot-20615878481-20261002';
const baseName = ruc + '-01-' + reference;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.argv.includes('--one-invoice-authorized') || process.env.SUNAT_ENVIRONMENT !== environment ||
    process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'false') throw new Error('Sólo preparación aislada QA Beta');
const connect = database => new Client({ host: process.env.DB_HOST, user: process.env.DB_USER, database,
  password: fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
const sunat = connect(process.env.DB_NAME), billing = connect('factuez_billing'); const buffers = [];
(async () => {
  await sunat.connect(); await billing.connect(); await sunat.query('BEGIN READ ONLY'); await billing.query('BEGIN READ ONLY');
  const issuer = await billing.query('SELECT id, "legalName", "taxAddress", ubigeo FROM "CompanySettings" WHERE ruc=$1 AND environment=$2', [ruc, environment]);
  if (issuer.rows.length !== 1) throw new Error('ISSUER_NOT_CONFIGURED');
  const company = issuer.rows[0];
  if (!company.legalName?.trim() || !company.taxAddress?.trim() || !/^\d{6}$/.test(company.ubigeo)) throw new Error('ISSUER_FIELDS_INCOMPLETE');
  const credentials = await sunat.query('SELECT revision, "certificateCipher", "certificatePasswordCipher", "certificateFingerprint" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]);
  if (credentials.rows.length !== 1) throw new Error('CERTIFICATE_NOT_CONFIGURED');
  const row = credentials.rows[0], vault = new SecretVault();
  const bytes = vault.open(row.certificateCipher, { ruc, environment, field: 'certificate' }); buffers.push(bytes);
  const password = vault.open(row.certificatePasswordCipher, { ruc, environment, field: 'certificatePassword' }); buffers.push(password);
  const certificate = inspectCertificate(bytes, password.toString('utf8'));
  if (certificate.fingerprint !== row.certificateFingerprint || certificate.subjectRucCandidates.length !== 1 ||
      certificate.subjectRucCandidates[0] !== ruc || !certificate.digitalSignature || certificate.selfSigned) throw new Error('CERTIFICATE_IDENTITY_NOT_MATCHED');
  const snapshot = { companyId: company.id, documentId: randomUUID(), documentTypeCode: '01', environment,
    series: 'FQ01', number: '1', fullNumber: reference, issueDate: new Date().toISOString(), currencyCode: 'PEN', operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: ruc, legalName: company.legalName, address: company.taxAddress, ubigeo: company.ubigeo, establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: ruc, legalName: company.legalName },
    lines: [{ lineNumber: 1, description: 'PRUEBA TECNICA BETA SIN OPERACION COMERCIAL - FACTUEZ', unitCode: 'NIU', quantity: '1',
      unitPriceWithTax: '1.18', unitValue: '1.000000', lineExtensionAmount: '1.00', igvAmount: '0.18', totalAmount: '1.18', taxAffectationCode: '10', igvRate: '18.00' }],
    totals: { taxableAmount: '1.00', igvAmount: '0.18', payableAmount: '1.18' } };
  core.validateLocalInvoice(snapshot);
  const fiscal = core.validateFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
  if (!fiscal.valid) throw new Error('LOCAL_FISCAL_PROFILE_INVALID');
  // wx/creación exclusiva: ejecutar otra vez no firma ni sobreescribe el mismo piloto.
  fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(root + '/preparation.lock', 'ONE_AUTHORIZED_BETA_INVOICE\n', { flag: 'wx', mode: 0o600 });
  const unsigned = buildPilotXml(snapshot, core.buildInvoiceUbl);
  const signed = new XmlSignerService().sign(unsigned, bytes, password.toString('utf8'));
  const xsd = await new XsdValidationService().validate(signed.xml, 'Invoice');
  const xml = Buffer.from(signed.xml); const zip = Buffer.from(zipSync({ [baseName + '.xml']: xml }, { level: 6 }));
  const extracted = unzipSync(zip);
  if (Object.keys(extracted).length !== 1 || !Buffer.from(extracted[baseName + '.xml']).equals(xml)) throw new Error('ZIP_ROUNDTRIP');
  const record = { ruc, environment, reference, documentTypeCode: '01', total: '1.18', currency: 'PEN',
    revision: row.revision, xmlSha256: sha(xml), zipSha256: sha(zip), certificateFingerprint: certificate.fingerprint,
    digestValue: signed.digestValue, signatureVerified: true, exactRucMatch: true,
    trustChainVerified: false, revocationVerified: false, xsd, officialRequests: 0, fiscalWrites: 0,
    preparedAt: new Date().toISOString(), notice: 'BETA - SIN VALIDEZ TRIBUTARIA - SIN OPERACION COMERCIAL' };
  for (const [name, content] of [[baseName + '.xml', xml], [baseName + '.zip', zip], ['preparation.json', JSON.stringify(record, null, 2)]])
    fs.writeFileSync(root + '/' + name, content, { flag: 'wx', mode: 0o600 });
  await sunat.query('COMMIT'); await billing.query('COMMIT');
  console.log(JSON.stringify({ ruc, environment, reference, total: '1.18', certificateRucMatched: true,
    signatureVerified: true, xsdVerified: true, credentialRevision: row.revision, officialRequests: 0, fiscalWrites: 0, artifactDirectory: root }));
})().catch(error => { const known = ['ISSUER_NOT_CONFIGURED', 'ISSUER_FIELDS_INCOMPLETE', 'CERTIFICATE_NOT_CONFIGURED', 'CERTIFICATE_IDENTITY_NOT_MATCHED', 'LOCAL_FISCAL_PROFILE_INVALID', 'ZIP_ROUNDTRIP'];
  console.error(JSON.stringify({ state: 'PREPARATION_BLOCKED', reason: known.includes(error?.message) ? error.message : 'LOCAL_VALIDATION_FAILED', officialRequests: 0, fiscalWrites: 0 })); process.exitCode = 1; })
  .finally(async () => { for (const bytes of buffers) bytes.fill(0); await sunat.end().catch(() => {}); await billing.end().catch(() => {}); });
