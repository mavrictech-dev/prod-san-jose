// Runner externo de UNA factura. No conecta con DB/Redis ni abre PFX/clave SOL.
// NO ejecutar nuevamente tras un resultado incierto. El marcador bloquea reenvíos.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, X509Certificate } = require('node:crypto');
const service = path.resolve(__dirname, '../services/sunat-service');
const { unzipSync } = require(path.join(service, 'node_modules/fflate'));
const { BoundedSoapAdapter, SUNAT_BETA_ENDPOINT, SoapSubmissionError } = require(path.join(service, 'dist/infrastructure/sunat/bounded-soap.adapter'));
const { parseCdrZip } = require(path.join(service, 'dist/infrastructure/sunat/cdr-parser'));
const { parseSafeInvoice } = require(path.join(service, 'dist/infrastructure/crypto/xml-signer.service'));
const ruc = '20615878481', reference = 'FQ01-1', baseName = `${ruc}-01-${reference}`;
const root = path.resolve(__dirname, '../tmp/beta-pilot/20615878481-20261002');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (!process.argv.includes('--one-invoice-authorized') || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Piloto Beta requiere autorización específica y TLS verificado');
let requests = 0, httpStatus = null, transportCode = null, locked = false;
const fetchOriginal = global.fetch;
(async () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'preparation.json'), 'utf8'));
  if (metadata.ruc !== ruc || metadata.environment !== 'BETA' || metadata.reference !== reference || metadata.documentTypeCode !== '01' ||
      metadata.signatureVerified !== true || metadata.exactRucMatch !== true || metadata.fiscalWrites !== 0 || metadata.officialRequests !== 0 ||
      metadata.total !== '1.18' || metadata.currency !== 'PEN' || !Number.isFinite(Date.parse(metadata.preparedAt)) ||
      Date.now() - Date.parse(metadata.preparedAt) > 86400000 || Date.parse(metadata.preparedAt) > Date.now() + 5000) throw new Error('PILOT_CONTEXT');
  const xml = fs.readFileSync(path.join(root, baseName + '.xml')), zip = fs.readFileSync(path.join(root, baseName + '.zip'));
  if (sha(xml) !== metadata.xmlSha256 || sha(zip) !== metadata.zipSha256 || zip.length > 4 * 1024 * 1024) throw new Error('PILOT_HASH');
  const files = unzipSync(zip);
  if (Object.keys(files).length !== 1 || !Buffer.from(files[baseName + '.xml']).equals(xml)) throw new Error('PILOT_PACKAGE');
  const document = parseSafeInvoice(xml.toString('utf8')).document;
  const certificates = document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
  if (certificates.length !== 1 || new X509Certificate(Buffer.from(certificates[0].textContent.replace(/\s/g, ''), 'base64')).fingerprint256.replace(/:/g, '').toLowerCase() !== metadata.certificateFingerprint) throw new Error('PILOT_CERTIFICATE');
  // Sólo este proceso; el QA conserva SUNAT_BETA_TRANSMISSION_ENABLED=false.
  process.env.SUNAT_BETA_TRANSMISSION_ENABLED = 'true';
  const adapter = new BoundedSoapAdapter({ environment: 'BETA', ruc, solUser: 'MODDATOS', solPassword: 'MODDATOS' });
  global.fetch = async (url, options) => {
    if (url !== SUNAT_BETA_ENDPOINT || options?.method !== 'POST' || options.redirect !== 'error' ||
        options.headers.SOAPAction !== 'sendBill' || requests !== 0) throw new Error('REQUEST_NOT_AUTHORIZED');
    requests++;
    // Antes del POST, queda evidencia persistente para no reenviar al perder respuesta.
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ environment: 'BETA', endpoint: SUNAT_BETA_ENDPOINT, method: 'sendBill',
      ruc, reference, zipSha256: metadata.zipSha256, attemptedAt: new Date().toISOString(), maximumRequests: 1, notice: 'SIN VALIDEZ TRIBUTARIA' }, null, 2), { flag: 'wx', mode: 0o600 });
    try { const response = await fetchOriginal(url, options); httpStatus = response.status; return response; }
    catch (error) { const code = error?.cause?.code; transportCode = /^[A-Z0-9_]{3,80}$/.test(code ?? '') ? code : 'BOUNDED_REQUEST_FAILED'; throw error; }
  };
  fs.writeFileSync(path.join(root, 'submission.lock'), 'ONE_BETA_ATTEMPT_NO_AUTOMATIC_RETRY\n', { flag: 'wx', mode: 0o600 }); locked = true;
  const receipt = await adapter.submit({ fileName: baseName + '.zip', zip, sha256: metadata.zipSha256 });
  if (receipt.kind !== 'CDR') throw new Error('PILOT_RECEIPT');
  fs.writeFileSync(path.join(root, 'cdr-beta.zip'), receipt.cdrZip, { flag: 'wx', mode: 0o600 });
  let cdr;
  try { cdr = parseCdrZip(receipt.cdrZip, { fileName: 'R-' + baseName + '.xml', issuerRuc: ruc, reference }); }
  catch { throw new Error('BETA_CDR_REQUIRES_REVIEW'); }
  fs.writeFileSync(path.join(root, 'cdr-beta.xml'), cdr.xml, { flag: 'wx', mode: 0o600 });
  const result = { state: cdr.status, responseCode: cdr.code, observationCount: cdr.notes.length,
    ruc, environment: 'BETA', reference, requests, httpStatus, fiscalWrites: 0, productionRequests: 0,
    cdrStructureAndBindingVerified: true, cdrSignatureTrustVerified: false, completedAt: new Date().toISOString(), notice: 'RESULTADO BETA SIN VALIDEZ TRIBUTARIA' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ...result, description: cdr.description, notes: cdr.notes }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result));
})().catch(error => {
  const result = { state: requests ? 'STOPPED_REQUIRES_REVIEW_NO_RESEND' : 'BLOCKED_BEFORE_SEND', environment: 'BETA', ruc, reference,
    requests, httpStatus, transportCode, responseCode: error instanceof SoapSubmissionError ? error.code : null,
    fiscalWrites: 0, productionRequests: 0, completedAt: new Date().toISOString() };
  if (locked) { try { fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 }); } catch {} }
  console.error(JSON.stringify(result)); process.exitCode = 1;
}).finally(() => { global.fetch = fetchOriginal; process.env.SUNAT_BETA_TRANSMISSION_ENABLED = 'false'; });
