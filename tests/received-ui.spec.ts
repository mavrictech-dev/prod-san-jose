import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { parseReceivedXml } from '../packages/received-core/src';
import { receivedXml } from './received-fixture.mjs';
import { ReceivedProjection, ReceivedDocumentTable, ReceivedUploadForm } from '../apps/web-pwa/features/workspace/received-documents';
const require = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const projection = parseReceivedXml(Buffer.from(receivedXml()));
const detail = { id: '10000000-0000-4000-8000-000000000001', companyId: 101, recipientRuc: '00000000101', branchId: null, supplierRuc: '00000000303', supplierName: 'PROVEEDOR FICTICIO', documentType: '01', fullNumber: 'FQA1-00000001', issueDate: '2026-01-01', currencyCode: 'PEN', payableAmount: '118.00', receivedAt: '2026-01-01T12:00:00Z', itemCount: 1, sunatStatus: 'NOT_CHECKED' as const, lastVerifiedAt: null, registeredAt: null, erpReference: null, warnings: projection.warnings, projection, artifacts: [] };
describe('Received UI: shadcn semantic tables, not aggregate-only SIRE', () => {
  it('renders fiscal number, provider, item details and non-official state', () => {
    const html = renderToStaticMarkup(React.createElement(ReceivedDocumentTable, { items: [detail] }));
    expect(html).toContain('Ver detalle'); expect(html).toContain('No consultado'); expect(html).toContain('/received/'); expect(html).toContain('<thead'); expect(html).toContain('<tbody');
  });
  it('shows unit values, taxes and due dates from XML without unsafe HTML', () => {
    const html = renderToStaticMarkup(React.createElement(ReceivedProjection, { detail: { ...detail, projection: { ...projection, notes: ['<script>unsafe()</script>'] } } }));
    for (const text of ['20.000000', '23.60', '15101506', 'Cuota001', '2026-02-01', 'Firma XML ausente']) expect(html).toContain(text);
    expect(html).not.toContain('<script>unsafe'); expect(html).toContain('&lt;script&gt;');
  });
  it('hides import controls without the mutation permission', () => expect(renderToStaticMarkup(React.createElement(ReceivedUploadForm, { enabled: false, files: [], onFiles() {}, onSubmit() {} }))).toBe(''));
  it('has an explicit file label and bounds', () => {
    const html = renderToStaticMarkup(React.createElement(ReceivedUploadForm, { enabled: true, files: [], onFiles() {}, onSubmit() {} }));
    expect(html).toContain('for="received-files"'); expect(html).toContain('aria-describedby'); expect(html).toContain('4 MiB');
  });
});
