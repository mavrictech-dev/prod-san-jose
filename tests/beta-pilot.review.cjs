// Revisa OFFLINE la respuesta ya recibida. No invoca el runner ni hace fetch.
const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const { parseCdrZip } = require('../services/sunat-service/dist/infrastructure/sunat/cdr-parser');
const root = path.resolve(__dirname, '../tmp/beta-pilot/20615878481-20261002');
if (!process.argv.includes('--offline-only')) throw new Error('Sólo revisión local');
global.fetch = () => { throw new Error('RED_DESHABILITADA'); };
(async () => {
  const before = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  if (before.ruc !== '20615878481' || before.environment !== 'BETA' || before.requests !== 1 || before.httpStatus !== 200 ||
      before.productionRequests !== 0 || !fs.existsSync(path.join(root, 'submission.lock'))) throw new Error('Resultado no corresponde al piloto');
  const zip = fs.readFileSync(path.join(root, 'cdr-beta.zip'));
  const cdr = parseCdrZip(zip, { issuerRuc: '20615878481', reference: 'FQ01-1', fileName: 'R-20615878481-01-FQ01-1.xml' });
  const result = { ruc: '20615878481', environment: 'BETA', reference: 'FQ01-1', state: cdr.status, responseCode: cdr.code,
    observationCount: cdr.notes.length, originalRequests: 1, newRequests: 0, productionRequests: 0, fiscalWrites: 0,
    cdrStructureAndBindingVerified: true, cdrSignatureTrustVerified: false,
    cdrZipSha256: createHash('sha256').update(zip).digest('hex'), reviewedAt: new Date().toISOString(), notice: 'BETA SIN VALIDEZ TRIBUTARIA' };
  fs.writeFileSync(path.join(root, 'cdr-beta.xml'), cdr.xml, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify({ ...result, description: cdr.description, notes: cdr.notes }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...result, description: cdr.description, notes: cdr.notes }));
})().catch(() => { console.error('No se pudo validar offline la respuesta Beta; no se reenvió la factura'); process.exitCode = 1; });
