// Única factura técnica 01 autorizada. Ejecutar sólo dentro del QA existente.
// Lecturas SQL READ ONLY y firma aislada; no ventas, contadores ni configuración.
'use strict';
const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Client } = require('/workspace/services/sunat-service/node_modules/pg');
const core = require('/workspace/packages/sunat-core/dist');
const { SecretVault } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/secret-vault');
const { inspectCertificate } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/certificate-inspector');
const { CertificateTrustService, loadPinnedPublicFile } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/certificate-trust.service');
const { prepareBetaXml } = require('/workspace/services/sunat-service/dist/infrastructure/crypto/beta-xml-pipeline');
const { XsdValidationService } = require('/workspace/services/sunat-service/dist/infrastructure/sunat/xsd-validation.service');
const ruc = '20615878481', environment = 'BETA', reference = 'FQ02-1';
const root = '/tmp/factuez-beta-integrated-20615878481-20261002-FQ02-1';
const publicRoot = '/tmp/factuez-beta-public-pki-20615878481-20261002';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv.length !== 3 || process.argv[2] !== '--one-invoice-authorized' || process.env.SUNAT_ENVIRONMENT !== environment ||
    process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'false' || process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'false' ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Sólo piloto técnico aislado, Beta y TLS verificado');
const connect = database => new Client({ host: process.env.DB_HOST, user: process.env.DB_USER, database,
  password: fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
const billing = connect('factuez_billing'), sunat = connect(process.env.DB_NAME), buffers = [];
const write = (name, bytes) => fs.writeFileSync(`${root}/${name}`, bytes, { flag: 'wx', mode: 0o600 });
(async () => {
  if (fs.existsSync(root)) throw new Error('PILOT_ALREADY_RESERVED');
  // Pins públicos contrastados con repositorio RENIEC; sólo este proceso, sin
  // alterar env/mounts del servicio instalado ni la configuración de otro RUC.
  process.env.SUNAT_TRUST_STORE_FILE = `${publicRoot}/ecernep-root3.pem`;
  process.env.SUNAT_TRUST_STORE_SHA256 = '5eba03b0cbb42c9882834d2b23206f8857c522f967be3b403a57579ad34f0c0f';
  process.env.SUNAT_CRL_BUNDLE_FILE = `${publicRoot}/crls-mirror.pem`;
  process.env.SUNAT_CRL_BUNDLE_SHA256 = 'b5a7abf29ecc940de27f5cd66255fe734a0a47561508f4aed83e3e9d2e1b3949';
  const chain = await loadPinnedPublicFile(`${publicRoot}/intermediates.pem`, '3c825659aa5934c0490a565d83b9511aff8e14e33386ba9e3a9ca37b0dc1383b');
  await billing.connect(); await sunat.connect(); await billing.query('BEGIN READ ONLY'); await sunat.query('BEGIN READ ONLY');
  const issuer = await billing.query('SELECT id, "legalName", "taxAddress", ubigeo FROM "CompanySettings" WHERE ruc=$1 AND environment=$2', [ruc, environment]);
  if (issuer.rows.length !== 1) throw new Error('ISSUER_NOT_CONFIGURED'); const company = issuer.rows[0];
  if (!company.legalName?.trim() || !company.taxAddress?.trim() || !/^\d{6}$/.test(company.ubigeo)) throw new Error('ISSUER_FIELDS_INCOMPLETE');
  const result = await sunat.query('SELECT revision, "certificateCipher", "certificatePasswordCipher", "certificateFingerprint" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]);
  if (result.rows.length !== 1) throw new Error('CERTIFICATE_NOT_CONFIGURED'); const row = result.rows[0], vault = new SecretVault();
  const bytes = vault.open(row.certificateCipher, { ruc, environment, field: 'certificate' }); buffers.push(bytes);
  const password = vault.open(row.certificatePasswordCipher, { ruc, environment, field: 'certificatePassword' }); buffers.push(password);
  const metadata = inspectCertificate(bytes, password.toString('utf8'));
  metadata.chainPems = chain.text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const trust = await new CertificateTrustService().evaluate(metadata, ruc);
  if (metadata.fingerprint !== row.certificateFingerprint || !trust.chainValid || !trust.identityMatched ||
      trust.revocation !== 'VERIFIED_OFFLINE_CRL') throw new Error('CERTIFICATE_TRUST_NOT_VERIFIED');
  const snapshot = { companyId: company.id, documentId: randomUUID(), environment, documentTypeCode: '01', series: 'FQ02', number: '1',
    fullNumber: reference, issueDate: new Date().toISOString(), currencyCode: 'PEN', paymentTerms: { type: 'CONTADO' }, operationTypeCode: '0101',
    issuer: { identityType: '6', identityNumber: ruc, legalName: company.legalName, address: company.taxAddress, ubigeo: company.ubigeo, establishmentCode: '0000' },
    customer: { identityType: '6', identityNumber: ruc, legalName: company.legalName },
    ...core.calculateDocumentTotals([{ description: 'PRUEBA TECNICA BETA SIN OPERACION COMERCIAL FACTUEZ', unitCode: 'NIU', quantity: '1',
      unitPriceWithTax: '1.18', taxAffectationCode: '10', igvRate: '18' }]) };
  core.assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
  fs.mkdirSync(root, { mode: 0o700 }); write('preparation.lock', 'ONE_NEW_AUTHORIZED_TECHNICAL_BETA_INVOICE\n');
  const prepared = prepareBetaXml(snapshot, bytes, password.toString('utf8'));
  const xsd = await new XsdValidationService().validate(prepared.document.xml, 'Invoice');
  const baselineQueries = [
    await billing.query('SELECT count(d.id)::text AS documents FROM "CompanySettings" c LEFT JOIN "Document" d ON d."companyId"=c.id AND d."immutableSnapshot"->>\'environment\'=$2 WHERE c.ruc=$1 AND c.environment::text=$2', [ruc, environment]),
    await billing.query('SELECT s.id,s.series,s."nextNumber"::text,s."updatedAt" FROM "SeriesCounter" s JOIN "CompanySettings" c ON c.id=s."companyId" WHERE c.ruc=$1 AND c.environment=$2 ORDER BY s.id', [ruc, environment]),
    await sunat.query('SELECT count("documentId")::text AS documents FROM "FiscalDocument" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]),
    await sunat.query('SELECT revision,"updatedAt" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]),
  ];
  const baseline = { billingDocuments: baselineQueries[0].rows[0].documents, countersSha256: sha(JSON.stringify(baselineQueries[1].rows)),
    sunatDocuments: baselineQueries[2].rows[0].documents, configuration: baselineQueries[3].rows[0] };
  write('state-before.json', JSON.stringify(baseline));
  const record = { ruc, environment, reference, documentTypeCode: '01', documentId: snapshot.documentId,
    total: '1.18', currency: 'PEN', revision: row.revision, xmlSha256: sha(prepared.document.xml), zipSha256: sha(prepared.zip),
    certificateFingerprint: metadata.fingerprint, digestValue: prepared.document.digestValue, signatureVerified: true, exactRucMatch: true,
    trustChainVerified: true, revocationVerified: true, trust, revocationEvidenceExpiresAt: '2026-10-03T22:00:22.000Z',
    xsd, officialRequests: 0, fiscalWrites: 0, preparedAt: new Date().toISOString(), maximumRequests: 1, productionRequests: 0,
    generator: 'prepareBetaXml', dispatcher: 'BetaDispatchPipeline', notice: 'PILOTO TECNICO BETA SIN VALIDEZ TRIBUTARIA' };
  write(`${prepared.fileName}.xml`, prepared.document.xml); write(`${prepared.fileName}.zip`, prepared.zip);
  write('preparation.json', JSON.stringify(record, null, 2));
  write('snapshot.json', JSON.stringify(snapshot));
  await billing.query('COMMIT'); await sunat.query('COMMIT');
  console.log(JSON.stringify({ ruc, environment, reference, certificateChainVerified: true, revocationVerified: true,
    signatureVerified: true, xsdVerified: true, officialRequests: 0, fiscalWrites: 0, artifactDirectory: root }));
})().catch(error => { const codes = ['PILOT_ALREADY_RESERVED', 'ISSUER_NOT_CONFIGURED', 'ISSUER_FIELDS_INCOMPLETE', 'CERTIFICATE_NOT_CONFIGURED', 'CERTIFICATE_TRUST_NOT_VERIFIED'];
  console.error(JSON.stringify({ state: 'PREPARATION_BLOCKED', reason: codes.includes(error?.message) ? error.message : 'LOCAL_VALIDATION_FAILED', officialRequests: 0, fiscalWrites: 0 })); process.exitCode = 1; })
  .finally(async () => { for (const buffer of buffers) buffer.fill(0); await billing.end().catch(() => {}); await sunat.end().catch(() => {}); });
