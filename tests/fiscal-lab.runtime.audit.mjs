// Existing QA only: one demo login and stateless previews. No fiscal writes,
// issuer/configuration queries, certificate access, SUNAT or SMTP connections.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const origin = 'http://127.0.0.1:8091';
if (process.argv.length !== 3 || process.argv[2] !== '--existing-qa-only') throw new Error('QA_SCOPE_REQUIRED');
let token, password;
const checks = [];
async function call(route, body, authorization) {
  assert.ok(['/api/v1/auth/login', '/api/v1/fiscal-rules/preview', '/api/v1/fiscal-rules/financial-ledger-preview'].includes(route));
  return fetch(`${origin}${route}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
    body: JSON.stringify(body),
  });
}
try {
  const input = { environment: 'BETA', currencyCode: 'PEN', issueDate: '2026-10-03',
    lines: [{ id: '1', quantity: '1', unitPriceWithTax: '118', taxAffectationCode: '10', igvRate: '18' }],
    globalDiscounts: [{ reasonCode: '02', factor: '0.1' }] };
  let response = await call('/api/v1/fiscal-rules/preview', input);
  assert.equal(response.status, 401); checks.push('unauthenticated-preview-401');
  response = await call('/api/v1/fiscal-rules/financial-ledger-preview', { scenario: 'CREDIT_ACCEPTED' });
  assert.equal(response.status, 401); checks.push('unauthenticated-financial-preview-401');
  const secret = readFileSync(new URL('../.factuez-demo/secrets/initial_admin_password.txt', import.meta.url));
  try { password = secret.toString('utf8').trim(); } finally { secret.fill(0); }
  response = await call('/api/v1/auth/login', { username: 'demo.admin', password }); password = undefined;
  assert.ok(response.ok);
  const session = await response.json(); token = session.accessToken;
  assert.equal(typeof token, 'string'); assert.ok(token.length > 20);
  checks.push('existing-demo-auth');
  response = await call('/api/v1/fiscal-rules/preview', input, token);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const preview = await response.json();
  assert.equal(preview.localOnly, true); assert.equal(preview.transmissionAuthorized, false);
  assert.equal(preview.calculation.totals.taxableAmount, '90.00');
  assert.equal(preview.calculation.totals.igvAmount, '16.20');
  assert.equal(preview.calculation.totals.payableAmount, '106.20');
  checks.push('authenticated-preview-exact-decimals-no-store');
  response = await call('/api/v1/fiscal-rules/preview', { ...input, environment: 'PRODUCTION' }, token);
  assert.equal(response.status, 400); checks.push('production-preview-rejected');
  for (const [scenario, expectedNet, expectedOutcome] of [
    ['CREDIT_ACCEPTED', '118.00', ['APPLIED']], ['DEBIT_ACCEPTED', '259.60', ['APPLIED']],
    ['CDR_UNVERIFIED', '236.00', ['EVIDENCE_UNVERIFIED']], ['REJECTED', '236.00', ['REJECTED']],
    ['REPLAY', '118.00', ['APPLIED', 'DUPLICATE']], ['RC_REPLACE', '118.00', ['APPLIED']], ['VOID', '236.00', ['APPLIED']],
  ]) {
    response = await call('/api/v1/fiscal-rules/financial-ledger-preview', { scenario }, token);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const projection = await response.json();
    assert.equal(projection.source, 'FIXED_SYNTHETIC_FIXTURE'); assert.equal(projection.simulationOnly, true);
    assert.equal(projection.fiscalWrites, 0); assert.equal(projection.certificateAccess, false);
    assert.equal(projection.transmissionAuthorized, false); assert.equal(projection.evidenceAuthenticityVerified, false);
    assert.equal(projection.originalPreserved, true); assert.equal(projection.originalPayableAmount, '236.00');
    assert.equal(projection.result.ok, true); assert.equal(projection.result.currentVersion.net.payableAmount, expectedNet);
    assert.deepEqual(projection.result.outcomes, expectedOutcome);
    checks.push(`synthetic-financial-${scenario}`);
  }
  response = await call('/api/v1/fiscal-rules/financial-ledger-preview', { scenario: 'STALE_VERSION' }, token);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { ok: false, code: 'STALE_VERSION' });
  checks.push('stale-financial-version-blocked');
  for (const forbidden of [{ scenario: 'PRODUCTION' }, { scenario: 'VOID', environment: 'PRODUCTION' },
    { scenario: 'CREDIT_ACCEPTED', issuerRuc: '20615878481' }, { scenario: 'VOID', evidence: { officialCdr: true } }]) {
    response = await call('/api/v1/fiscal-rules/financial-ledger-preview', forbidden, token);
    assert.equal(response.status, 400);
  }
  checks.push('financial-private-input-and-production-rejected');
  // Un UUID ficticio sin sesión y un ID inválido con sesión: no consulta ventas
  // ni otro emisor y no crea reservas; sólo prueba enrutamiento/guard de lectura.
  for (const [id, authorization, expected] of [['60000000-0000-4000-8000-000000000001', undefined, 401], ['invalid-id', token, 400]]) {
    const tracking = await fetch(`${origin}/api/v1/fiscal-evidence/${id}`, {
      redirect: 'error', signal: AbortSignal.timeout(10000), headers: authorization ? { Authorization: `Bearer ${authorization}` } : {},
    });
    assert.equal(tracking.status, expected);
    checks.push(`tracking-guard-${expected}`);
  }
  console.log(JSON.stringify({ status: 'PASS', checks, origin, fiscalWrites: 0, certificateReads: 0,
    officialRequests: 0, smtpRequests: 0, notice: 'Login demo genera su sesión normal; no cambios fiscales.' }));
} catch {
  process.exitCode = 1;
  console.error(JSON.stringify({ status: 'BLOCKED', completedChecks: checks, fiscalWrites: 0, officialRequests: 0 }));
} finally { token = undefined; password = undefined; }
