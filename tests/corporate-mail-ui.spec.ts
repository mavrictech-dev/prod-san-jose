import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ runtime: {} as any, workspace: {} as any }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({ useWorkspace: () => state.workspace,
  useResource: () => ({ data: state.runtime, reload: vi.fn() }) }));
import { CorporateMail, CorporateMailHistory } from '../apps/web-pwa/features/workspace/corporate-mail';
const req = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = req('react'), { renderToStaticMarkup } = req('react-dom/server');
const render = (component: any, props: any) => renderToStaticMarkup(React.createElement(component, props));
const props = { companyId: 1, ruc: '00000000001', revision: 1, dirty: false, parentBusy: false, secureTransport: true, onChange: vi.fn() };
beforeEach(() => { vi.stubGlobal('React', React);
  state.runtime = { companyId: 1, ruc: props.ruc, configurationRevision: 1, activationRevision: 1, serverEnabled: true,
    storageReady: true, workerReady: true, enabledForRuc: true, grantCurrent: true, readyToSendTest: true, jobs: [], events: [] };
  state.workspace = { user: { roles: ['ADMIN'], scope: { kind: 'GLOBAL' } }, can: () => true, api: vi.fn() };
});
afterEach(() => vi.unstubAllGlobals());
describe('UI consentimiento y límite real del correo corporativo', () => {
  it('load no envía ni activa; distingue pruebas de comprobantes/API', () => {
    const html = render(CorporateMail, props);
    expect(html).toContain('Autorizar esta revisión para pruebas'); expect(html).toContain('Enviar correo de prueba');
    expect(html).toContain('no concede permisos B2B ni envía comprobantes de clientes API');
    expect(html).toContain('Destinatario de la prueba'); expect(state.workspace.api).not.toHaveBeenCalled();
  });
  it('flag solo no implica grant vigente', () => {
    state.runtime.readyToSendTest = false; state.runtime.grantCurrent = false;
    expect(render(CorporateMail, props)).toContain('obsoleta; requiere nueva autorización');
    expect(render(CorporateMail, props)).not.toContain('Correo de prueba habilitado');
  });
  it('cambios locales bloquean acción y muestran motivo', () => {
    expect(render(CorporateMail, { ...props, dirty: true })).toContain('Guarde o descarte los cambios');
  });
  it('historial no afirma entrega ni muestra destinatario', () => {
    const html = render(CorporateMailHistory, { jobs: [{ id: 'synthetic-id', state: 'HANDED_OFF', configurationRevision: 1, activationRevision: 1 }], events: [] });
    expect(html).toContain('entrega al destinatario no confirmada'); expect(html).not.toMatch(/recipient@|deliveredToClient.*true/);
  });
  it('acción separada exige confirmación y clave estable para reintentos', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/corporate-mail.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Confirmar destinatario y enviar'); expect(source).toContain('confirmed: true');
    expect(source).toContain("'Idempotency-Key': attempt.current.key"); expect(source).toContain('attempt.current?.body !== body');
    expect(source).not.toMatch(/localStorage|sessionStorage|setInterval|send-test.*useEffect/);
  });
});
