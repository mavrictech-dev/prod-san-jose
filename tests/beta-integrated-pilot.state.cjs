// Read-only SQL evidence for ONE RUC/BETA. Does not invoke PREPARE or SEND.
// --before (after PREPARE): scoped observation; --after: compare to PREPARE/before.
// --preflight-only: scoped SQL access before/after PREPARE, stdout only, no file writes.
// Existing Linux QA only. Explicitly authorized DB_PASSWORD_FILE is read solely
// for authentication in this process. Never print/store it or put it in host env.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const RUC = '20615878481', ENVIRONMENT = 'BETA', REFERENCE = 'FQ02-1';
const ROOT = '/tmp/factuez-beta-integrated-20615878481-20261002-FQ02-1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clients = [];
let passwordBuffer;
const fail = () => { throw new Error('SCOPED_STATE_CHECK_FAILED'); };
function directory() {
  const info = fs.lstatSync(ROOT);
  if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(ROOT) !== ROOT) fail();
}
function readBytes(target, maximum) {
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(target) !== path.resolve(target) ||
      info.size < 1 || info.size > maximum) fail();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev || stat.size !== info.size) fail();
    bytes = Buffer.alloc(stat.size + 1); let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length !== stat.size || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs) fail();
    return bytes.subarray(0, length);
  } catch (error) { bytes?.fill(0); throw error;
  } finally { fs.closeSync(fd); }
}
function readJson(name) { directory(); return JSON.parse(readBytes(`${ROOT}/${name}`, 65536).toString('utf8')); }
function present(name) {
  try { fs.lstatSync(`${ROOT}/${name}`); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function writeJson(name, value) {
  directory();
  const fd = fs.openSync(`${ROOT}/${name}`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(ROOT, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function validate(value, scoped) {
  if (scoped && (value.ruc !== RUC || value.environment !== ENVIRONMENT || value.reference !== REFERENCE)) fail();
  if (typeof value.billingDocuments !== 'string' || !/^\d{1,20}$/.test(value.billingDocuments) ||
      typeof value.sunatDocuments !== 'string' || !/^\d{1,20}$/.test(value.sunatDocuments) ||
      !/^[a-f0-9]{64}$/.test(value.countersSha256 ?? '') || !Number.isSafeInteger(value.configuration?.revision) ||
      value.configuration.revision < 1 || !Number.isFinite(Date.parse(value.configuration.updatedAt))) fail();
}
function compare(before, after) {
  return { unchangedDocuments: before.billingDocuments === after.billingDocuments && before.sunatDocuments === after.sunatDocuments,
    unchangedCounters: before.countersSha256 === after.countersSha256,
    unchangedConfiguration: before.configuration.revision === after.configuration.revision &&
      new Date(before.configuration.updatedAt).toISOString() === new Date(after.configuration.updatedAt).toISOString() };
}
async function main() {
  const mode = process.argv.length === 3 ? process.argv[2] : '';
  if (!['--before', '--after', '--preflight-only'].includes(mode) || process.platform !== 'linux' ||
      process.env.SUNAT_ENVIRONMENT !== ENVIRONMENT || process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'false' ||
      process.env.SUNAT_BETA_WORKFLOW_ENABLED !== 'false' || process.env.DB_NAME !== 'factuez_sunat' ||
      !process.env.DB_HOST || !process.env.DB_USER || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail();
  let baseline = null;
  const hasPreparation = present('preparation.json'), hasBaseline = present('state-before.json');
  if (hasPreparation !== hasBaseline || (mode !== '--preflight-only' && !hasPreparation)) fail();
  if (hasPreparation) {
    const preparation = readJson('preparation.json'); baseline = readJson('state-before.json');
    if (preparation.ruc !== RUC || preparation.environment !== ENVIRONMENT || preparation.reference !== REFERENCE ||
        preparation.documentTypeCode !== '01' || preparation.total !== '1.18' || preparation.currency !== 'PEN' ||
        preparation.fiscalWrites !== 0 || preparation.officialRequests !== 0 || preparation.maximumRequests !== 1 ||
        preparation.productionRequests !== 0 || baseline.configuration?.revision !== preparation.revision) fail();
    validate(baseline, false);
  }
  if (mode === '--before' && present('submission.lock')) fail();
  const outputName = mode === '--before' ? 'state-observed-before.json' : 'state-after.json';
  if (mode !== '--preflight-only' && present(outputName)) fail(); // Evidence is never overwritten.
  const observedBefore = present('state-observed-before.json') ? readJson('state-observed-before.json') : null;
  if (observedBefore) { validate(observedBefore, true); if (!baseline || !Object.values(compare(baseline, observedBefore)).every(Boolean)) fail(); }
  const localRequire = createRequire(path.resolve(__dirname, '../services/sunat-service/package.json'));
  const { Client } = localRequire('pg');
  if (!process.env.DB_PASSWORD_FILE || !path.isAbsolute(process.env.DB_PASSWORD_FILE)) fail();
  passwordBuffer = readBytes(process.env.DB_PASSWORD_FILE, 4096);
  if (!passwordBuffer.toString('utf8').trim() || passwordBuffer.includes(0)) fail();
  const connect = database => {
    const client = new Client({ host: process.env.DB_HOST, user: process.env.DB_USER, database,
      password: () => passwordBuffer.toString('utf8').trim(), // Callback prevents .pgpass fallback.
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
      application_name: 'factuez-beta-integrated-scoped-read-only', connectionTimeoutMillis: 5000, query_timeout: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000' });
    client.on('error', () => {}); clients.push(client); return client;
  };
  const billing = connect('factuez_billing'), sunat = connect('factuez_sunat');
  await Promise.all([billing.connect(), sunat.connect()]);
  await Promise.all([billing.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), sunat.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')]);
  const params = [RUC, ENVIRONMENT];
  // Explicit column allowlists and bound scope: no snapshots, ciphers, logs, other RUCs or configuration updates.
  const companies = await billing.query('SELECT count(*)::text AS companies FROM "CompanySettings" WHERE ruc=$1 AND environment::text=$2', params);
  if (companies.rows[0]?.companies !== '1') fail();
  const counts = await billing.query('SELECT count(d.id)::text AS documents FROM "CompanySettings" c LEFT JOIN "Document" d ON d."companyId"=c.id AND d."immutableSnapshot"->>\'environment\'=$2 WHERE c.ruc=$1 AND c.environment::text=$2', params);
  const counters = await billing.query('SELECT s.id,s.series,s."nextNumber"::text,s."updatedAt" FROM "SeriesCounter" s JOIN "CompanySettings" c ON c.id=s."companyId" WHERE c.ruc=$1 AND c.environment=$2 ORDER BY s.id', params);
  const documents = await sunat.query('SELECT count("documentId")::text AS documents FROM "FiscalDocument" WHERE "issuerRuc"=$1 AND environment=$2', params);
  const config = await sunat.query('SELECT revision,"updatedAt" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', params);
  if (config.rows.length !== 1 || counters.rows.length > 10000) fail();
  const state = { ruc: RUC, environment: ENVIRONMENT, reference: REFERENCE,
    billingDocuments: counts.rows[0]?.documents, sunatDocuments: documents.rows[0]?.documents,
    countersSha256: sha(JSON.stringify(counters.rows)), configuration: config.rows[0] };
  validate(state, true);
  await Promise.all([billing.query('COMMIT'), sunat.query('COMMIT')]);
  const comparison = baseline ? compare(observedBefore ?? baseline, state)
    : { unchangedDocuments: null, unchangedCounters: null, unchangedConfiguration: null };
  const unchanged = baseline ? Object.values(comparison).every(Boolean) : null;
  if (mode !== '--preflight-only') {
    writeJson(outputName, { ...state, ...comparison, unchanged, observedAt: new Date().toISOString(),
      comparedTo: observedBefore ? 'state-observed-before.json' : 'state-before.json',
      databaseWrites: 0, fiscalWrites: 0, requests: 0, productionRequests: 0 });
  }
  if (unchanged === false) process.exitCode = 1;
  return { state: unchanged === null ? 'SCOPED_READ_ONLY_PREFLIGHT_VERIFIED' : unchanged ? 'SCOPED_STATE_UNCHANGED' : 'SCOPED_STATE_CHANGED',
    ruc: RUC, environment: ENVIRONMENT, reference: REFERENCE, mode, baselineAvailable: baseline !== null,
    ...comparison, billingDocuments: state.billingDocuments, sunatDocuments: state.sunatDocuments,
    countersSha256: state.countersSha256, configuration: state.configuration,
    evidenceFile: mode === '--preflight-only' ? null : `${ROOT}/${outputName}`,
    databaseWrites: 0, fiscalWrites: 0, requests: 0, productionRequests: 0 };
}
(async () => {
  let result;
  try { result = await main(); }
  catch {
    process.exitCode = 1;
    result = { state: 'SCOPED_STATE_CHECK_BLOCKED', ruc: RUC, environment: ENVIRONMENT, reference: REFERENCE,
      databaseWrites: 0, fiscalWrites: 0, requests: 0, productionRequests: 0 };
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
    passwordBuffer?.fill(0);
    for (const client of clients) { client.password = null; if (client.connectionParameters) client.connectionParameters.password = null; }
  }
  console.log(JSON.stringify(result));
})();
