// Read-only synthetic visual fixture; does not import into a real service.
import { createRequire } from 'node:module';
import { receivedXml } from './received-fixture.mjs';
const require = createRequire(import.meta.url);
const { parseReceivedXml } = require('../packages/received-core/dist');
const projection = parseReceivedXml(Buffer.from(receivedXml('01', 'FQA1-00000001', '00000000001')));
const doc = { id: '90000000-0000-4000-8000-000000000001', companyId: 1, recipientRuc: '00000000001', branchId: '10000000-0000-4000-8000-000000000001', supplierRuc: '00000000303', supplierName: 'PROVEEDOR FICTICIO - QA VISUAL', documentType: '01', fullNumber: projection.fullNumber, issueDate: projection.issueDate, currencyCode: 'PEN', payableAmount: '118.00', receivedAt: '2026-01-01T12:00:00Z', itemCount: 1, sunatStatus: 'NOT_CHECKED', lastVerifiedAt: null, registeredAt: null, erpReference: null, warnings: projection.warnings, projection,
  artifacts: [{ id: '90000000-0000-4000-8000-000000000002', kind: 'XML', fileName: 'proveedor-ficticio.xml', sha256: projection.xmlSha256, byteLength: Buffer.byteLength(receivedXml('01', docNumber(), '00000000001')) }] };
function docNumber() { return 'FQA1-00000001'; }
export function receivedVisual(url, method, role) {
  if (!url.pathname.startsWith('/api/v1/received-documents')) return;
  if (role !== 'ADMIN') return { status: 403, body: { message: 'Sin permiso en fixture visual' } };
  if (method !== 'GET') return { status: 400, body: { message: 'Fixture sólo visual de consulta; pruebe importaciones en el E2E aislado' } };
  if (url.pathname === '/api/v1/received-documents') {
    const inScope = url.searchParams.get('companyId') === '1' && (!url.searchParams.get('branchId') || url.searchParams.get('branchId') === doc.branchId);
    return { body: { items: inScope ? [doc] : [], total: inScope ? 1 : 0, page: 1, pageSize: 25 } };
  }
  if (url.pathname === `/api/v1/received-documents/${doc.id}`) return { body: doc };
  return { status: 404, body: { message: 'Descarga sólo disponible en el servicio real de QA, no en el fixture' } };
}
