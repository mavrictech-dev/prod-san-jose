import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workspace: {} as Record<string, any>, status: {} as Record<string, any> }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({
  useWorkspace: () => state.workspace,
  useResource: (path: string) => path.includes('/audit') ? { data: { total: 0, items: [] }, reload: vi.fn() } : { data: state.status, reload: vi.fn() },
}));
import { SmtpSettings, SmtpConnectionDiagnostic } from '../apps/web-pwa/features/workspace/smtp-settings';
const webRequire = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = webRequire('react'), { renderToStaticMarkup } = webRequire('react-dom/server');
const render = (component: any, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const result = { companyId: 1, ruc: '00000000001', revision: 1, connectionVerified: true, tlsVerified: true,
  smtpAuthenticationVerified: true, readyToSend: false, deliveredToClient: false, checkedAt: '2026-10-28T12:00:00Z' };
beforeEach(() => {
  vi.stubGlobal('React', React);
  state.workspace = { user: { sub: 'synthetic-admin', roles: ['ADMIN'], scope: { kind: 'GLOBAL' } },
    companyId: '1', catalog: { companies: [{ id: 1, ruc: result.ruc, legalName: 'Synthetic' }] },
    can: () => true, api: vi.fn(), setDirty: vi.fn() };
  state.status = { ...result, configured: true, credentialsConfigured: true, storageReady: true, encryption: 'READY',
    integrity: 'VALID', approvedHostListConfigured: true, hostnameApproved: true, connectionDiagnosticsEnabled: true, settings: null };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('panel SMTP distingue preparación, conexión y entrega', () => {
  it('muestra acciones separadas y no ejecuta pruebas al renderizar', () => {
    const html = render(SmtpSettings);
    expect(html).toContain('Diagnóstico local'); expect(html).toContain('Verificar conexión SMTP');
    expect(html).toContain('no envía mensajes'); expect(html).toContain('Máximo 15 segundos');
    expect(html).not.toContain('Conexión SMTP verificada'); expect(state.workspace.api).not.toHaveBeenCalled();
  });
  it('explica gate deshabilitado sin presentar éxito', () => {
    state.status.connectionDiagnosticsEnabled = false; const html = render(SmtpSettings);
    expect(html).toContain('requiere habilitación explícita'); expect(html).not.toContain('Conexión SMTP verificada');
  });
  it.each(['permission', 'role', 'scope'])('mantiene guard de autorización %s', field => {
    if (field === 'permission') state.workspace.can = () => false;
    if (field === 'role') state.workspace.user.roles = ['AUDITOR'];
    if (field === 'scope') state.workspace.user.scope.kind = 'ASSIGNED';
    const html = render(SmtpSettings); expect(html).toContain('requiere un administrador general'); expect(html).not.toContain('Verificar conexión SMTP');
  });
  it('conexión verificada informa revisión, TLS/AUTH y que no garantiza entrega', () => {
    const html = render(SmtpConnectionDiagnostic, { result, revision: 1, changed: false });
    expect(html).toContain('Conexión SMTP verificada'); expect(html).toContain('TLS y autenticación');
    expect(html).toContain('no garantiza entrega'); expect(html).toContain('Esta comprobación no envía mensajes'); expect(html).toContain('no envía mensajes ni activa el envío');
  });
  it.each([{ revision: 2, changed: false }, { revision: 1, changed: true }])('invalida éxito tras cambiar revisión o campos: %j', props => {
    expect(render(SmtpConnectionDiagnostic, { result, ...props })).toBe('');
    expect(render(SmtpConnectionDiagnostic, { revision: 1, changed: false })).toBe('');
  });
  it('solicita únicamente la revisión guardada, exige transporte seguro y no persiste credenciales', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/smtp-settings.tsx', import.meta.url), 'utf8');
    const check = source.slice(source.indexOf('async function verifyConnection()'), source.indexOf('  const status = resource.data;'));
    expect(check).toContain('/verify-connection'); expect(check).toContain('JSON.stringify({ expectedRevision: revision })');
    expect(check).toContain('busy || changed || !secureTransport'); expect(check).not.toMatch(/password|username|credentials:|sendMail/);
    expect(check).toContain('result.revision !== revision'); expect(check).toContain('result.readyToSend !== false');
    expect(source).not.toMatch(/localStorage.(setItem|getItem)|sessionStorage.(setItem|getItem)/);
  });
});
