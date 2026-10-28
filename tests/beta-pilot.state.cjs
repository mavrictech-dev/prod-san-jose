// Evidencia read-only de un único RUC/BETA, antes/después del piloto aislado.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { Client } = require('/workspace/services/sunat-service/node_modules/pg');
const ruc = '20615878481', environment = 'BETA';
const beforePath = '/tmp/factuez-beta-pilot-state-before.json';
const afterPath = '/tmp/factuez-beta-pilot-state-after.json';
if (!['--before', '--after'].includes(process.argv[2]) || process.env.SUNAT_ENVIRONMENT !== environment || process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'false') throw new Error('Sólo QA Beta');
const connect = database => new Client({ host: process.env.DB_HOST, user: process.env.DB_USER, database,
  password: fs.readFileSync(process.env.DB_PASSWORD_FILE, 'utf8').trim(), connectionTimeoutMillis: 5000, query_timeout: 5000 });
const billing = connect('factuez_billing'), sunat = connect(process.env.DB_NAME);
(async () => {
  await billing.connect(); await sunat.connect(); await billing.query('BEGIN READ ONLY'); await sunat.query('BEGIN READ ONLY');
  const counts = await billing.query('SELECT count(d.id)::text AS documents FROM "CompanySettings" c LEFT JOIN "Document" d ON d."companyId"=c.id AND d."immutableSnapshot"->>\'environment\'=$2 WHERE c.ruc=$1 AND c.environment::text=$2', [ruc, environment]);
  const counters = await billing.query('SELECT s.id, s.series, s."nextNumber"::text, s."updatedAt" FROM "SeriesCounter" s JOIN "CompanySettings" c ON c.id=s."companyId" WHERE c.ruc=$1 AND c.environment=$2 ORDER BY s.id', [ruc, environment]);
  const documents = await sunat.query('SELECT count("documentId")::text AS documents FROM "FiscalDocument" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]);
  const config = await sunat.query('SELECT revision, "updatedAt" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND environment=$2', [ruc, environment]);
  if (config.rows.length !== 1) throw new Error();
  const state = { ruc, environment, billingDocuments: counts.rows[0].documents, sunatDocuments: documents.rows[0].documents,
    countersSha256: createHash('sha256').update(JSON.stringify(counters.rows)).digest('hex'), configuration: config.rows[0] };
  await billing.query('COMMIT'); await sunat.query('COMMIT');
  if (process.argv[2] === '--before') {
    fs.writeFileSync(beforePath, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ruc, environment, baselineRecorded: true }));
  } else {
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    const result = { ruc, environment, unchangedDocuments: state.billingDocuments === before.billingDocuments && state.sunatDocuments === before.sunatDocuments,
      unchangedCounters: state.countersSha256 === before.countersSha256, unchangedConfiguration: JSON.stringify(state.configuration) === JSON.stringify(before.configuration) };
    fs.writeFileSync(afterPath, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(result)); if (Object.values(result).includes(false)) process.exitCode = 1;
  }
})().catch(() => { console.error('No se pudo comprobar estado fiscal acotado; sin detalles privados'); process.exitCode = 1; })
  .finally(async () => { await billing.end().catch(() => {}); await sunat.end().catch(() => {}); });
