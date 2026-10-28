import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({ useWorkspace: () => ({ api: state.api, user: { sub: 'demo' } }) }));
import { FinancialDemo } from '../apps/web-pwa/features/workspace/financial-demo';
const webRequire = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url)), React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
beforeEach(() => { vi.stubGlobal('React', React); state.api.mockClear(); });
afterEach(() => vi.unstubAllGlobals());
describe('panel shadcn de conciliación ficticia', () => {
  it('entra sin hacer peticiones ni presentarlo como aceptación SUNAT', () => {
    const html = renderToStaticMarkup(React.createElement(FinancialDemo));
    expect(state.api).not.toHaveBeenCalled(); expect(html).toContain('Conciliación financiera');
    expect(html).toContain('CDR y evidencias inventados'); expect(html).toContain('Producción permanece bloqueada');
    expect(html).toContain('Ejecutar simulación local'); expect(html).not.toContain('Aceptado por SUNAT');
  });
});
