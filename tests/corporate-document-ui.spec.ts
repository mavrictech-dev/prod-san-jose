import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workspace: {} as any, runtime: {} as any, detail: {} as any, resources: vi.fn() }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({ useWorkspace: () => state.workspace,
  useResource: (path: string) => { state.resources(path); return { data: path.startsWith('/api/v1/documents/') ? state.detail : state.runtime, reload: vi.fn() }; } }));
vi.mock('../apps/web-pwa/node_modules/next/navigation.js', () => ({ useParams: () => ({ id: '084a10ac-df2d-49f5-aa8a-9a784212e320' }) }));
vi.mock('../apps/web-pwa/features/workspace/production-notes', () => ({ ProductionNotesPanel: () => null }));
vi.mock('../apps/web-pwa/features/workspace/fiscal-originals', () => ({ FiscalOriginals: () => null }));
vi.mock('../apps/web-pwa/features/workspace/circuit-qa', () => ({ CircuitQa: () => null }));
vi.mock('../apps/web-pwa/features/workspace/pdf-print', () => ({ PdfPrintButton: () => null }));
vi.mock('../apps/web-pwa/features/workspace/supplement-tracking', () => ({ SupplementTracking: () => null }));
import DocumentDetailPage from '../apps/web-pwa/app/(workspace)/documents/[id]/page';
import { FiscalDocumentMail, FiscalDocumentMailHistory } from '../apps/web-pwa/features/workspace/corporate-document-mail';
const req = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url)), React = req('react'), { renderToStaticMarkup } = req('react-dom/server');
const render = (c: any, p: any) => renderToStaticMarkup(React.createElement(c, p));
const props = { companyId: 1, ruc: '00000000001', documentId: '084a10ac-df2d-49f5-aa8a-9a784212e320' };
beforeEach(() => { vi.stubGlobal('React', React); state.resources.mockClear();
  state.workspace = { user: { sub: 'synthetic', roles: ['ADMIN'], scope: { kind: 'GLOBAL' } }, can: () => true, api: vi.fn(), apiBlob: vi.fn() };
  state.runtime = { ...props, scope: 'DOCUMENT', environment: 'PRODUCTION', fullNumber: 'F001-1', documentType: '01',
    configurationRevision: 1, activationRevision: 0, serverEnabled: false, storageReady: false, workerReady: false,
    readyToSendDocument: false, grantCurrent: false, enabledForDocuments: false, jobs: [] };
  state.detail = { id: props.documentId, companyId: props.companyId, fullNumber: 'F001-1', sunatStatus: 'ACCEPTED',
    immutableSnapshot: { environment: 'PRODUCTION', documentTypeCode: '01', issuer: { identityNumber: props.ruc, legalName: 'Emisor sintético' },
      customer: { identityNumber: '00000000002', legalName: 'Cliente sintético' }, currencyCode: 'PEN', issueDate: '2026-10-28T12:00:00Z',
      lines: [], totals: { taxableAmount: '1.00', igvAmount: '0.18', payableAmount: '1.18' } } };
});
afterEach(() => vi.unstubAllGlobals());
describe('FiscalDocumentMail listo para importar en detalle PWA', () => {
  it('render no encola, descarga ni concede grant; muestra separación TEST/DOCUMENT', () => {
    const html = render(FiscalDocumentMail, props);
    expect(html).toContain('Enviar comprobante por correo corporativo'); expect(html).toContain('La autorización de pruebas no habilita comprobantes');
    expect(html).toContain('Autorizar DOCUMENT para este RUC'); expect(html).toContain('Destinatario del comprobante');
    expect(html).toContain('XML firmado, ZIP de envío, CDR XML y CDR ZIP originales'); expect(html).toContain('resumen RC vinculado');
    expect(state.resources).toHaveBeenCalledWith('/api/v1/mail-settings/1/documents/' + props.documentId);
    expect(state.workspace.api).not.toHaveBeenCalled();
  });
  it.each(['role', 'scope', 'permission', 'session'])('guard %s antes de consultar estado o revelar detalle', which => {
    if (which === 'role') state.workspace.user.roles = ['AUDITOR'];
    if (which === 'scope') state.workspace.user.scope.kind = 'ASSIGNED';
    if (which === 'permission') state.workspace.can = () => false;
    if (which === 'session') state.workspace.user = null;
    const html = render(FiscalDocumentMail, props); expect(html).toContain('requiere ADMIN GLOBAL'); expect(state.resources).not.toHaveBeenCalled();
  });
  it('rechaza contexto de respuesta de otro emisor/documento y no presenta éxito', () => {
    state.runtime.ruc = '00000000002'; expect(render(FiscalDocumentMail, props)).toContain('otro comprobante o emisor');
  });
  it('historial distingue handedoff e incertidumbre sin afirmar entrega', () => {
    const html = render(FiscalDocumentMailHistory, { jobs: [{ id: 'synthetic', state: 'HANDED_OFF', format: 'a4' }, { id: 'synthetic2', state: 'UNKNOWN', format: 'a4' }] });
    expect(html).toContain('entrega al destinatario no confirmada'); expect(html).toContain('no se reenviará automáticamente');
  });
  it('acciones separadas, destinatario confirmado y clave idempotente estable sólo en memoria', () => {
    const s = readFileSync(new URL('../apps/web-pwa/features/workspace/corporate-document-mail.tsx', import.meta.url), 'utf8');
    expect(s).toContain('/send-document'); expect(s).toContain('/document-activation'); expect(s).toContain('Confirmar destinatario y enviar comprobante');
    expect(s).toContain("'Idempotency-Key': attempt.current.key"); expect(s).toContain('attempt.current?.body !== body');
    expect(s).not.toMatch(/localStorage|sessionStorage|apiBlob|setInterval/);
  });
});


describe('Correo DOCUMENT en el detalle de comprobantes productivos existentes', () => {
  const accepted = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'];
  it.each(['01', '03', '07', '08'].flatMap(type => accepted.map(status => [type, status])))('monta %s con estado %s sin enviar, descargar ni activar', (type, status) => {
    state.detail.immutableSnapshot.documentTypeCode = type; state.detail.sunatStatus = status; state.runtime.documentType = type;
    const html = render(DocumentDetailPage, {});
    expect(html).toContain('Enviar comprobante por correo corporativo');
    expect(html).toContain('Factura 01, boleta 03, nota de crédito 07 o nota de débito 08');
    expect(html).toContain('Para factura 01 y notas 07/08, el ZIP y CDR corresponden al comprobante individual.');
    expect(html).toContain('Para boleta 03, el ZIP y CDR corresponden al resumen RC vinculado.');
    expect(state.resources).toHaveBeenCalledWith('/api/v1/mail-settings/1/documents/' + props.documentId);
    expect(state.workspace.api).not.toHaveBeenCalled(); expect(state.workspace.apiBlob).not.toHaveBeenCalled();
  });
  it.each(['07', '08'].flatMap(type => ['BETA', 'UNKNOWN'].map(environment => [type, environment])))('no monta nota %s en ambiente %s', (type, environment) => {
    state.detail.immutableSnapshot.documentTypeCode = type; state.detail.immutableSnapshot.environment = environment;
    expect(render(DocumentDetailPage, {})).not.toContain('Enviar comprobante por correo corporativo');
    expect(state.resources).not.toHaveBeenCalledWith(expect.stringContaining('/mail-settings/'));
  });
  it.each(['07', '08'].flatMap(type => ['PENDING', 'QUEUED', 'PROCESSING', 'REJECTED', 'VOIDED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR', 'UNKNOWN'].map(status => [type, status])))('no monta nota %s con estado %s', (type, status) => {
    state.detail.immutableSnapshot.documentTypeCode = type; state.detail.sunatStatus = status;
    expect(render(DocumentDetailPage, {})).not.toContain('Enviar comprobante por correo corporativo');
    expect(state.resources).not.toHaveBeenCalledWith(expect.stringContaining('/mail-settings/'));
  });
  it.each(['07', '08'].flatMap(type => ['role', 'scope', 'permission', 'session'].map(guard => [type, guard])))('nota %s mantiene guard %s antes de montar correo', (type, guard) => {
    state.detail.immutableSnapshot.documentTypeCode = type;
    if (guard === 'role') state.workspace.user.roles = ['AUDITOR'];
    if (guard === 'scope') state.workspace.user.scope.kind = 'ASSIGNED';
    if (guard === 'permission') state.workspace.can = (permission: string) => permission !== 'document.email';
    if (guard === 'session') state.workspace.user = null;
    expect(render(DocumentDetailPage, {})).not.toContain('Enviar comprobante por correo corporativo');
    expect(state.resources).not.toHaveBeenCalledWith(expect.stringContaining('/mail-settings/'));
    expect(state.workspace.api).not.toHaveBeenCalled(); expect(state.workspace.apiBlob).not.toHaveBeenCalled();
  });
  it.each(['09', 'RC', undefined])('no amplía el montaje al tipo %s', type => {
    state.detail.immutableSnapshot.documentTypeCode = type;
    expect(render(DocumentDetailPage, {})).not.toContain('Enviar comprobante por correo corporativo');
    expect(state.resources).not.toHaveBeenCalledWith(expect.stringContaining('/mail-settings/'));
  });
  it.each(['BETA', 'type', 'scope', 'document', 'company'])('rechaza respuesta runtime incompatible: %s', mismatch => {
    if (mismatch === 'BETA') state.runtime.environment = 'BETA';
    if (mismatch === 'type') state.runtime.documentType = '09';
    if (mismatch === 'scope') state.runtime.scope = 'TEST';
    if (mismatch === 'document') state.runtime.documentId = '084a10ac-df2d-49f5-aa8a-9a784212e321';
    if (mismatch === 'company') state.runtime.companyId = 2;
    const html = render(FiscalDocumentMail, props);
    expect(html).toContain('otro comprobante o emisor'); expect(html).not.toContain('Autorizar DOCUMENT para este RUC');
    expect(state.workspace.api).not.toHaveBeenCalled();
  });
});
