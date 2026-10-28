import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const baseUrl = (process.env.FACTUEZ_DEMO_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const credentials = await readFile(join(root, '.factuez-demo', 'demo-admin.txt'), 'utf8');
const username = credentials.match(/^username=(.+)$/m)?.[1];
const password = credentials.match(/^password=(.+)$/m)?.[1];
if (!username || !password) throw new Error('No se encontraron credenciales de demo. Ejecute primero scripts/create-demo-secrets.mjs');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

const login = await request('/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
});
const authorization = { Authorization: `Bearer ${login.accessToken}` };
const catalog = await request('/api/v1/documents/catalog/issuance', { headers: authorization });
const point = catalog.emissionPoints[0];
const product = catalog.products[0];
const series = point?.series.find((item) => item.documentType === 'SALES_RECEIPT')?.series;
if (!point || !product || !series) throw new Error('El seed no creó punto, producto o serie de boleta.');

const issued = await request('/api/v1/documents', {
  method: 'POST',
  headers: { ...authorization, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({
    emissionPointId: point.id,
    documentType: 'SALES_RECEIPT',
    series,
    currencyCode: 'PEN',
    customer: { identityType: '0', identityNumber: '0', legalName: 'CONSUMIDOR FINAL' },
    lines: [{ productId: product.id, productCode: product.sku, description: product.description, unitCode: product.unitCode, quantity: '1.000', unitPriceWithTax: '16.500000', taxAffectationCode: product.taxAffectationCode, igvRate: '18.00' }],
  }),
});

let finalDocument;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const documents = await request('/api/v1/documents', { headers: authorization });
  finalDocument = documents.find((document) => document.id === issued.documentId);
  if (finalDocument?.sunatStatus === 'PROCESSING') break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
}
if (finalDocument?.sunatStatus !== 'PROCESSING') throw new Error(`No llegó el estado desde sunat-service: ${JSON.stringify(finalDocument)}`);

console.log(`OK: ${issued.fullNumber} emitido; UBL de prueba construido y estado ${finalDocument.sunatStatus}.`);

