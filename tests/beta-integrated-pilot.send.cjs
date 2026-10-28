// FQ02-1 only. PREPARE is owned by the main agent and is never invoked here.
// --verify-only: offline, no writes. --guard-smoke: guard checks, no artifacts/network.
// --one-invoice-authorized: ONE Beta POST from the host, using copied public outputs.
// Runtime flags must start false; only this process's transport flag is briefly enabled.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID, X509Certificate } = require('node:crypto');
const { createRequire } = require('node:module');

const RUC = '20615878481', ENVIRONMENT = 'BETA', REFERENCE = 'FQ02-1';
const BASE = `${RUC}-01-${REFERENCE}`, FILE_NAME = `${BASE}.zip`;
const ROOT = path.resolve(__dirname, '../tmp/beta-integrated-pilot/20615878481-20261002-FQ02-1');
const PUBLIC_ROOT = path.resolve(__dirname, '../tmp/beta-public-pki/20615878481-20261002');
const JOURNAL = path.join(ROOT, 'shadow-journal');
const ENDPOINT = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';
const ROOT_HASH = '5eba03b0cbb42c9882834d2b23206f8857c522f967be3b403a57579ad34f0c0f';
const CRL_HASH = 'b5a7abf29ecc940de27f5cd66255fe734a0a47561508f4aed83e3e9d2e1b3949';
const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const originalFetch = global.fetch;
const originalTransmissionFlag = process.env.SUNAT_BETA_TRANSMISSION_ENABLED;
const mode = process.argv.length === 3 ? process.argv[2] : '';
let activated = false;
let locked = false, sequence = 0, phase = null, latestHash = null;
let requests = 0, budgetConsumed = false, httpStatus = null, transportCode = null;
let sendWindow = false, metadata, snapshot, prepared, row, cdrEvidence = null;

function directory(target) {
  const info = fs.lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(target) !== path.resolve(target)) fail('PILOT_FILESYSTEM');
}
function exists(target) {
  try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function read(target, maximum) {
  directory(path.dirname(target));
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(target) !== path.resolve(target) ||
      info.size < 1 || info.size > maximum) fail('PILOT_FILESYSTEM');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev || stat.size !== info.size) fail('PILOT_FILESYSTEM');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fs.fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('PILOT_FILESYSTEM');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function json(target, maximum = 65536) { return JSON.parse(read(target, maximum).toString('utf8')); }
function syncDirectory(target) {
  directory(target); let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    fs.fsyncSync(fd);
  } catch (error) {
    // Only unsupported Windows directory flushing is skipped; file fsync errors always fail closed.
    // Native Node on this host reports EPERM when opening a directory fd.
    if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Exclusive open is 'wx' plus O_NOFOLLOW where supported; each FILE is always fsynced.
function write(target, bytes) {
  directory(path.dirname(target));
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  if (target === `${ROOT}/submission.lock`) locked = true;
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(target));
}
function writeJson(target, value) { write(target, JSON.stringify(value, null, 2)); }
function context() {
  if (!['linux', 'win32'].includes(process.platform) || process.env.SUNAT_ENVIRONMENT !== ENVIRONMENT ||
      process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'false' ||
      process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== (activated ? 'true' : 'false') ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
      typeof originalFetch !== 'function') fail('PILOT_CONTEXT');
}
function fresh(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 5000 && Date.now() - timestamp <= 86400000;
}
function scope(value) {
  if (value.ruc !== RUC || value.environment !== ENVIRONMENT || value.reference !== REFERENCE) fail('PILOT_CONTEXT');
}
function unused() {
  for (const name of ['submission.lock', 'request.json', 'result.json', 'shadow-journal', 'cdr-beta.zip', 'cdr-beta.xml', 'cdr-trust.json'])
    if (exists(`${ROOT}/${name}`)) fail('PILOT_ALREADY_RESERVED_NO_RESEND');
}
function authorization(value) {
  context();
  if (!activated || value.documentId !== snapshot.documentId || value.snapshot !== snapshot || value.ticket !== null ||
      value.snapshot.environment !== ENVIRONMENT || value.snapshot.documentTypeCode !== '01' ||
      value.snapshot.fullNumber !== REFERENCE || value.snapshot.issuer.identityNumber !== RUC ||
      !fresh(metadata.preparedAt) || Date.parse(metadata.revocationEvidenceExpiresAt) <= Date.now()) fail('PILOT_CONTEXT');
}
function binding() {
  return { ruc: RUC, environment: ENVIRONMENT, reference: REFERENCE, documentTypeCode: '01',
    documentId: snapshot.documentId, fileName: FILE_NAME, xmlSha256: metadata.xmlSha256,
    zipSha256: metadata.zipSha256, snapshotSha256: sha(JSON.stringify(snapshot)), maximumRequests: 1 };
}
function event(to, action, details = {}) {
  if (sequence >= 12) fail('JOURNAL_LIMIT');
  const value = { schemaVersion: 1, ...binding(), sequence: sequence + 1, previousSha256: latestHash,
    phase: to, action, attempt: row.attempt, owner: row.owner.toISOString(), submissionId: row.id, ticket: null,
    recordedAt: new Date().toISOString(), ...details };
  const bytes = JSON.stringify(value, null, 2);
  write(`${JOURNAL}/${String(sequence + 1).padStart(2, '0')}.json`, bytes);
  sequence++; latestHash = sha(bytes); phase = to;
}
function owns(value, expected) {
  if (!locked || !sequence || phase !== expected || value.id !== row.id || value.documentId !== row.documentId ||
      value.attempt !== row.attempt || value.owner.getTime() !== row.owner.getTime()) return false;
  const bytes = read(`${JOURNAL}/${String(sequence).padStart(2, '0')}.json`, 8192);
  const last = JSON.parse(bytes.toString('utf8'));
  const reservation = json(`${ROOT}/submission.lock`, 8192);
  return sha(bytes) === latestHash && last.phase === expected && last.submissionId === value.id &&
    last.documentId === value.documentId && last.owner === value.owner.toISOString() && last.attempt === value.attempt &&
    reservation.submissionId === value.id && reservation.zipSha256 === metadata.zipSha256 &&
    reservation.snapshotSha256 === binding().snapshotSha256;
}
function publicCdrPinsConfigured() {
  // Only PUBLIC pins in this pilot's public PKI directory may be read by trust.
  // Absent/unscoped pins mean false, never an alternate signer or relaxed profile.
  const pinnedPath = (name, expected) => typeof process.env[name] === 'string' && path.isAbsolute(process.env[name]) &&
    path.resolve(process.env[name]) === path.join(PUBLIC_ROOT, expected);
  if (!pinnedPath('SUNAT_CDR_SIGNER_CERT_FILE', 'sunat-cdr-signer.pem') ||
      !HASH.test(process.env.SUNAT_CDR_SIGNER_CERT_SHA256 ?? '') ||
      !pinnedPath('SUNAT_TRUST_STORE_FILE', 'ecernep-root3.pem') ||
      process.env.SUNAT_TRUST_STORE_SHA256 !== ROOT_HASH ||
      !pinnedPath('SUNAT_CRL_BUNDLE_FILE', 'crls-mirror.pem') ||
      process.env.SUNAT_CRL_BUNDLE_SHA256 !== CRL_HASH) return false;
  try { directory(PUBLIC_ROOT); return true; } catch { return false; }
}
function requestAllowed(url, options, guard) {
  try {
    return guard.sendWindow === true && guard.owned === true && guard.budgetConsumed === false && guard.requests === 0 &&
      url === ENDPOINT && options?.method === 'POST' && options.redirect === 'error' && options.body === guard.envelope &&
      options.headers?.SOAPAction === 'sendBill' && options.headers['Content-Type'] === 'text/xml; charset=utf-8' &&
      options.headers.Accept === 'text/xml' && Object.keys(options.headers).length === 3 &&
      Object.keys(options).sort().join(',') === 'body,headers,method,redirect,signal' &&
      options.signal instanceof AbortSignal && !options.signal.aborted && sha(guard.zip) === guard.zipSha256;
  } catch { return false; }
}
function guardSmoke() {
  // Pure policy checks. Dummy bytes are never passed to an adapter or fetch.
  const zip = Buffer.from('GUARD_SMOKE_NOT_A_FISCAL_PACKAGE');
  const guard = { sendWindow: true, owned: true, budgetConsumed: false, requests: 0,
    envelope: `sendBill:${FILE_NAME}:${zip.toString('base64')}`, zip, zipSha256: sha(zip) };
  const options = { method: 'POST', redirect: 'error', body: guard.envelope, signal: new AbortController().signal,
    headers: { SOAPAction: 'sendBill', 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' } };
  const aborted = new AbortController(); aborted.abort();
  const denials = [
    ['https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService', options, guard],
    ['http://sunat-emulator:3006/billService', options, guard],
    [ENDPOINT, { ...options, method: 'GET' }, guard],
    [ENDPOINT, { ...options, redirect: 'follow' }, guard],
    [ENDPOINT, { ...options, headers: { ...options.headers, SOAPAction: 'getStatus' } }, guard],
    [ENDPOINT, { ...options, headers: { ...options.headers, SOAPAction: 'sendSummary' } }, guard],
    [ENDPOINT, { ...options, headers: { ...options.headers, 'X-Extra': 'FORBIDDEN' } }, guard],
    [ENDPOINT, { ...options, body: guard.envelope.replace('FQ02-1', 'FQ01-1') }, guard],
    [ENDPOINT, { ...options, body: `${guard.envelope}TAMPERED` }, guard],
    [ENDPOINT, { ...options, signal: aborted.signal }, guard],
    [ENDPOINT, { ...options, dispatcher: {} }, guard],
    [ENDPOINT, options, { ...guard, owned: false }],
    [ENDPOINT, options, { ...guard, sendWindow: false }],
    [ENDPOINT, options, { ...guard, requests: 1 }],
    [ENDPOINT, options, { ...guard, budgetConsumed: true }],
    [ENDPOINT, options, { ...guard, zipSha256: '0'.repeat(64) }],
  ];
  if (!requestAllowed(ENDPOINT, options, guard) || denials.some(args => requestAllowed(...args))) fail('GUARD_SMOKE_FAILED');
  return { ...summary('GUARD_SMOKE_VERIFIED'), checks: denials.length + 1, guardLayerOnly: true };
}
function summary(state, reason = null) {
  return { state, reason, pipelinePhase: phase, ruc: RUC, environment: ENVIRONMENT, reference: REFERENCE,
    documentTypeCode: '01', total: '1.18', currency: 'PEN', requests, maximumRequests: 1, budgetConsumed,
    httpStatus, transportCode, submissionLocked: locked, retryAllowed: false,
    responseCode: cdrEvidence?.responseCode ?? null, observationCount: cdrEvidence?.observationCount ?? null,
    cdrStructureAndBindingVerified: cdrEvidence?.structureAndBindingVerified === true,
    cdrSignatureTrustVerified: cdrEvidence?.signatureTrustVerified === true,
    verifiedTechnicalOutcome: cdrEvidence?.signatureTrustVerified === true ? cdrEvidence.status : null,
    fiscalAcceptance: false, fiscalWrites: 0, productionRequests: 0,
    artifactDirectory: ROOT, notice: 'PILOTO TECNICO BETA SIN VALIDEZ TRIBUTARIA' };
}

async function main() {
  if (!['--verify-only', '--preflight-only', '--guard-smoke', '--one-invoice-authorized'].includes(mode)) fail('PILOT_ARGUMENTS');
  context();
  if (mode === '--guard-smoke') return guardSmoke();
  directory(ROOT); unused();
  // Block all network until the pipeline enters its single scoped submit port.
  global.fetch = async () => fail('REQUEST_NOT_AUTHORIZED');
  const service = path.resolve(__dirname, '../services/sunat-service');
  const localRequire = createRequire(`${service}/package.json`);
  localRequire('reflect-metadata');
  const { BetaDispatchPipeline } = localRequire('./dist/application/beta-dispatch-pipeline');
  const { BoundedSoapAdapter, SUNAT_BETA_ENDPOINT } = localRequire('./dist/infrastructure/sunat/bounded-soap.adapter');
  const { parseCdrZip } = localRequire('./dist/infrastructure/sunat/cdr-parser');
  const { validateBetaPackage } = localRequire('./dist/infrastructure/sunat/beta-package-validator');
  const { singleNotesTransportXml } = localRequire('./dist/infrastructure/sunat/notes-transport-qa-validator');
  const { parseSafeInvoice, verifyLocalSignedInvoice } = localRequire('./dist/infrastructure/crypto/xml-signer.service');
  const { CertificateTrustService } = localRequire('./dist/infrastructure/crypto/certificate-trust.service');
  const { CdrSignatureTrustService } = localRequire('./dist/infrastructure/crypto/cdr-signature-trust.service');
  const { XSD_PROFILE, XSD_ARCHIVE_SHA256 } = localRequire('./dist/infrastructure/sunat/xsd-validation.service');
  const core = localRequire('@factuez/sunat-core');
  if (SUNAT_BETA_ENDPOINT !== ENDPOINT || typeof BetaDispatchPipeline !== 'function') fail('PILOT_RUNTIME');
  metadata = json(`${ROOT}/preparation.json`); snapshot = json(`${ROOT}/snapshot.json`, 131072);
  const baseline = json(`${ROOT}/state-before.json`);
  if (read(`${ROOT}/preparation.lock`, 256).toString('utf8') !== 'ONE_NEW_AUTHORIZED_TECHNICAL_BETA_INVOICE\n') fail('PILOT_CONTEXT');
  scope(metadata);
  if (metadata.documentTypeCode !== '01' || metadata.total !== '1.18' || metadata.currency !== 'PEN' ||
      metadata.signatureVerified !== true || metadata.exactRucMatch !== true || metadata.trustChainVerified !== true ||
      metadata.revocationVerified !== true || metadata.officialRequests !== 0 || metadata.fiscalWrites !== 0 ||
      metadata.maximumRequests !== 1 || metadata.productionRequests !== 0 || metadata.generator !== 'prepareBetaXml' ||
      metadata.dispatcher !== 'BetaDispatchPipeline' || !Number.isSafeInteger(metadata.revision) || metadata.revision < 1 ||
      !HASH.test(metadata.xmlSha256) || !HASH.test(metadata.zipSha256) || !HASH.test(metadata.certificateFingerprint) ||
      !fresh(metadata.preparedAt) || !fresh(metadata.trust?.checkedAt) ||
      !Number.isFinite(Date.parse(metadata.revocationEvidenceExpiresAt)) || Date.parse(metadata.revocationEvidenceExpiresAt) <= Date.now() ||
      metadata.trust?.profile !== 'OFFLINE-PINNED-ROOTS-CRL-v1' || metadata.trust.chainValid !== true ||
      metadata.trust.identityMatched !== true || metadata.trust.revocation !== 'VERIFIED_OFFLINE_CRL' ||
      metadata.trust.certificateFingerprint !== metadata.certificateFingerprint || metadata.trust.trustStoreSha256 !== ROOT_HASH ||
      !Array.isArray(metadata.trust.blockers) || metadata.trust.blockers.length !== 0 ||
      metadata.xsd?.profile !== XSD_PROFILE || metadata.xsd.archiveSha256 !== XSD_ARCHIVE_SHA256 ||
      metadata.xsd.xmlSha256 !== metadata.xmlSha256 || !fresh(metadata.xsd.verifiedAt) ||
      baseline.configuration?.revision !== metadata.revision || !HASH.test(baseline.countersSha256) ||
      !/^\d{1,20}$/.test(baseline.billingDocuments ?? '') || !/^\d{1,20}$/.test(baseline.sunatDocuments ?? '')) fail('PILOT_PREPARATION');
  if (snapshot.documentId !== metadata.documentId || !/^[a-f0-9-]{36}$/i.test(snapshot.documentId ?? '') ||
      snapshot.environment !== ENVIRONMENT || snapshot.documentTypeCode !== '01' || snapshot.series !== 'FQ02' ||
      snapshot.number !== '1' || snapshot.fullNumber !== REFERENCE || snapshot.currencyCode !== 'PEN' ||
      snapshot.issuer?.identityNumber !== RUC || snapshot.issuer.identityType !== '6' ||
      snapshot.customer?.identityNumber !== RUC || snapshot.customer.identityType !== '6' ||
      snapshot.paymentTerms?.type !== 'CONTADO' || snapshot.operationTypeCode !== '0101' ||
      snapshot.totals?.taxableAmount !== '1.00' || snapshot.totals.igvAmount !== '0.18' || snapshot.totals.payableAmount !== '1.18' ||
      snapshot.lines?.length !== 1 || snapshot.lines[0].description !== 'PRUEBA TECNICA BETA SIN OPERACION COMERCIAL FACTUEZ' ||
      snapshot.lines[0].quantity !== '1' || snapshot.lines[0].unitPriceWithTax !== '1.18') fail('PILOT_SNAPSHOT');
  core.assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' });
  const xml = read(`${ROOT}/${BASE}.xml`, 2 * 1024 * 1024), zip = read(`${ROOT}/${FILE_NAME}`, 4 * 1024 * 1024);
  if (sha(xml) !== metadata.xmlSha256 || sha(zip) !== metadata.zipSha256 ||
      !singleNotesTransportXml(zip, FILE_NAME).equals(xml) || !Buffer.from(xml.toString('utf8')).equals(xml)) fail('PILOT_HASH');
  const proof = validateBetaPackage({ fileName: FILE_NAME, zip, sha256: metadata.zipSha256 }, RUC, 'sendBill');
  if (proof.reference !== REFERENCE || proof.rootName !== 'Invoice' || proof.digest !== metadata.digestValue ||
      proof.certificateFingerprint !== metadata.certificateFingerprint) fail('PILOT_PACKAGE');
  const parsed = parseSafeInvoice(xml.toString('utf8'));
  const certs = parsed.document.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'X509Certificate');
  if (certs.length !== 1) fail('PILOT_PACKAGE');
  // Verification with the embedded PUBLIC certificate; no PFX/vault/private key reads or signing.
  const publicCertificate = new X509Certificate(Buffer.from(certs[0].textContent.replace(/\s/g, ''), 'base64')).toString();
  verifyLocalSignedInvoice(xml.toString('utf8'), publicCertificate, core.buildInvoiceUbl(snapshot, { mode: 'REAL_PREPARATION' }));
  prepared = { fileName: FILE_NAME, zip, sha256: metadata.zipSha256, reference: REFERENCE, revision: metadata.revision };
  if (['--verify-only', '--preflight-only'].includes(mode)) return { ...summary('PREPARED_OFFLINE_VERIFIED'), signatureVerified: true,
    xsdEvidenceBoundToXml: true, cdrPublicPinsConfigured: publicCdrPinsConfigured() };

  const cdrTrust = new CdrSignatureTrustService(new CertificateTrustService());
  row = { id: randomUUID(), documentId: snapshot.documentId, phase: 'PREPARED', attempt: 0,
    owner: new Date(), snapshot, ticket: null };
  writeJson(`${ROOT}/submission.lock`, { ...binding(), submissionId: row.id, owner: row.owner.toISOString(),
    reservedAt: new Date().toISOString(), policy: 'ONE_BETA_ATTEMPT_NO_RESEND_EVEN_AFTER_CRASH' });
  fs.mkdirSync(JOURNAL, { mode: 0o700 }); syncDirectory(ROOT);
  event('PREPARED', 'ARCHIVE_RESERVED');
  // The installed QA/runtime flags remain false. Only this already-reserved process changes.
  process.env.SUNAT_BETA_TRANSMISSION_ENABLED = 'true'; activated = true;
  const adapter = new BoundedSoapAdapter({ environment: ENVIRONMENT, ruc: RUC, solUser: 'MODDATOS', solPassword: 'MODDATOS' });
  const expectedEnvelope = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.sunat.gob.pe" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soap:Header><wsse:Security soap:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${RUC}MODDATOS</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">MODDATOS</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ser:sendBill><fileName>${FILE_NAME}</fileName><contentFile>${zip.toString('base64')}</contentFile></ser:sendBill></soap:Body></soap:Envelope>`;
  global.fetch = async (url, options) => {
    authorization(row);
    if (!requestAllowed(url, options, { sendWindow, owned: owns(row, 'SENDING'), budgetConsumed, requests,
      envelope: expectedEnvelope, zip, zipSha256: metadata.zipSha256 })) fail('REQUEST_NOT_AUTHORIZED');
    // All evidence is durable BEFORE invoking fetch. A partial lock/journal also forbids retry.
    budgetConsumed = true;
    writeJson(`${ROOT}/request.json`, { ...binding(), submissionId: row.id, endpoint: ENDPOINT, httpMethod: 'POST',
      operation: 'sendBill', bodySha256: sha(options.body), attemptedAt: new Date().toISOString(), budgetConsumed: true });
    event('SENDING', 'POST_BUDGET_CONSUMED');
    requests = 1;
    try {
      const response = await originalFetch(url, options);
      httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      return response;
    } catch (error) {
      const code = error?.cause?.code;
      transportCode = /^(?:UND_ERR_[A-Z_]{1,50}|E[A-Z]{2,30}|CERT_[A-Z_]{1,50}|UNABLE_TO_[A-Z_]{1,50})$/.test(code ?? '') ? code : 'BOUNDED_REQUEST_FAILED';
      throw error;
    }
  };
  const ports = {
    authorize: async value => authorization(value),
    claim: async (value, to) => {
      if (to !== 'PREPARING' || !owns(value, 'PREPARED') || value.attempt !== 0) return null;
      row = { ...value, phase: to, attempt: 1 }; event(to, 'CLAIMED'); return row;
    },
    prepare: async () => fail('PREPARATION_NOT_AUTHORIZED'),
    archived: async value => {
      if (!owns(value, 'PREPARING') || !read(`${ROOT}/${FILE_NAME}`, 4 * 1024 * 1024).equals(zip) ||
          sha(read(`${ROOT}/${BASE}.xml`, 2 * 1024 * 1024)) !== metadata.xmlSha256) fail('PILOT_HASH');
      return prepared;
    },
    savePrepared: async (value, pkg) => {
      if (!owns(value, 'PREPARING') || pkg !== prepared) return false;
      writeJson(`${JOURNAL}/prepared.json`, { ...binding(), revision: pkg.revision, xsd: metadata.xsd });
      event('PREPARED', 'ARCHIVE_BOUND'); return true;
    },
    owns: async (value, expected) => owns(value, expected),
    transition: async (value, from, to, details = {}) => {
      if (!owns(value, from)) return false;
      const allowed = from === 'PREPARED' ? ['SENDING', 'BLOCKED'] : from === 'PREPARING' ? ['BLOCKED']
        : from === 'SENDING' ? ['DONE', 'CDR_UNVERIFIED', 'UNKNOWN', 'BLOCKED'] : [];
      if (!allowed.includes(to) || details.ticket !== undefined || details.delayMs !== undefined ||
          (to === 'DONE' && (details.cdr?.trusted !== true || cdrEvidence?.signatureTrustVerified !== true)) ||
          (to === 'CDR_UNVERIFIED' && (details.cdr?.trusted !== false || cdrEvidence?.signatureTrustVerified !== false))) fail('JOURNAL_TRANSITION');
      const code = typeof details.code === 'string' && /^(?:\d{1,8}|[A-Z_]{1,64})$/.test(details.code) ? details.code : null;
      event(to, 'TRANSITION', { code, cdr: cdrEvidence }); return true;
    },
    submit: async (value, pkg) => {
      authorization(value);
      if (!owns(value, 'SENDING') || pkg !== prepared || pkg.fileName !== FILE_NAME || pkg.reference !== REFERENCE ||
          pkg.sha256 !== metadata.zipSha256 || budgetConsumed) fail('REQUEST_NOT_AUTHORIZED');
      sendWindow = true;
      try { return await adapter.submit(pkg); } finally { sendWindow = false; }
    },
    getStatus: async () => fail('REQUEST_NOT_AUTHORIZED'),
    cdr: async (value, pkg, bytes) => {
      if (!owns(value, 'SENDING') || pkg !== prepared || requests !== 1 || !Buffer.isBuffer(bytes) ||
          bytes.length < 1 || bytes.length > 4 * 1024 * 1024) fail('PILOT_CDR');
      write(`${ROOT}/cdr-beta.zip`, bytes);
      const cdr = parseCdrZip(bytes, { fileName: `R-${BASE}.xml`, issuerRuc: RUC, reference: REFERENCE });
      write(`${ROOT}/cdr-beta.xml`, cdr.xml);
      const pinsConfigured = publicCdrPinsConfigured();
      const trusted = pinsConfigured && await cdrTrust.verify(cdr.xml) === true;
      cdrEvidence = { structureAndBindingVerified: true, signatureTrustVerified: trusted, pinsConfigured,
        responseCode: cdr.code, observationCount: cdr.notes.length, cdrZipSha256: sha(bytes), cdrXmlSha256: sha(cdr.xml),
        status: trusted ? cdr.status : null, checkedAt: new Date().toISOString() };
      writeJson(`${ROOT}/cdr-trust.json`, { ...binding(), ...cdrEvidence, policy: 'STRICT_PINNED_XMLDSIG_CHAIN_IDENTITY_CRL' });
      // A structurally accepted dummy/unsigned Beta CDR remains CDR_UNVERIFIED.
      return { trusted, status: cdr.status, code: cdr.code, description: trusted ? cdr.description : 'CDR_SIGNATURE_UNVERIFIED', notes: cdr.notes };
    },
  };
  await new BetaDispatchPipeline(ports).run(row);
  if (!['DONE', 'CDR_UNVERIFIED', 'UNKNOWN', 'BLOCKED'].includes(phase)) fail('PIPELINE_INCOMPLETE');
  return summary(phase);
}

async function runCli() {
  let result;
  try { result = await main(); }
  catch (error) {
    const codes = ['PILOT_ARGUMENTS', 'PILOT_CONTEXT', 'PILOT_RUNTIME', 'PILOT_FILESYSTEM', 'PILOT_PREPARATION',
      'PILOT_ALREADY_RESERVED_NO_RESEND', 'PILOT_SNAPSHOT', 'PILOT_HASH', 'PILOT_PACKAGE', 'PILOT_CDR',
      'REQUEST_NOT_AUTHORIZED', 'PREPARATION_NOT_AUTHORIZED', 'JOURNAL_LIMIT', 'JOURNAL_TRANSITION', 'PIPELINE_INCOMPLETE', 'GUARD_SMOKE_FAILED'];
    result = summary(requests ? 'UNKNOWN' : 'BLOCKED_BEFORE_SEND', codes.includes(error?.message) ? error.message : 'LOCAL_VALIDATION_FAILED');
  } finally {
    global.fetch = originalFetch;
    if (activated) process.env.SUNAT_BETA_TRANSMISSION_ENABLED = originalTransmissionFlag;
    activated = false;
  }
  result = { ...result, transmissionFlagRestored: process.env.SUNAT_BETA_TRANSMISSION_ENABLED === originalTransmissionFlag };
  if (locked) {
    try { writeJson(`${ROOT}/result.json`, { ...result, completedAt: new Date().toISOString() }); }
    catch { result = { ...result, state: 'STOPPED_REQUIRES_REVIEW_NO_RESEND', reason: 'RESULT_PERSISTENCE_FAILED' }; }
  }
  if (!['GUARD_SMOKE_VERIFIED', 'PREPARED_OFFLINE_VERIFIED', 'DONE'].includes(result.state) ||
      result.verifiedTechnicalOutcome === 'REJECTED') process.exitCode = 1;
  console.log(JSON.stringify(result));
}
module.exports = Object.freeze({ guardSmoke });
if (require.main === module) void runCli();
