import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canManageIntegrations } from '../apps/web-pwa/features/b2b/integration-access';

const require = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const state = vi.hoisted(() => ({ workspace: {} as any, pathname: '/dashboard', links: [] as any[], push: vi.fn(), replace: vi.fn() }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({ useWorkspace: () => state.workspace }));
vi.mock('../apps/web-pwa/node_modules/next/navigation.js', () => ({
  usePathname: () => state.pathname, useRouter: () => ({ push: state.push, replace: state.replace }),
}));
vi.mock('../apps/web-pwa/node_modules/next/link.js', () => ({ default: ({ children, prefetch, ...props }: any) => {
  state.links.push(props); return React.createElement('a', props, children);
} }));
import { WorkspaceShell } from '../apps/web-pwa/features/workspace/shell';

const render = () => renderToStaticMarkup(React.createElement(WorkspaceShell, null, React.createElement('p', null, 'Contenido del módulo')));
beforeEach(() => {
  state.pathname = '/dashboard'; state.links = []; state.push.mockClear(); state.replace.mockClear();
  state.workspace = {
    user: { username: 'admin', roles: ['ADMIN'], scope: { kind: 'GLOBAL' } }, can: () => true,
    catalog: { companies: [], branches: [], emissionPoints: [], capabilities: { demoData: false, fiscalTransmission: false } },
    companyId: '', branchId: '', catalogSource: 'BUSINESS', dirty: false, setDirty: vi.fn(), logout: vi.fn(),
  };
});

describe('integration discovery shares the existing page authorization', () => {
  it('shows the dedicated menu and header shortcut outside the integrations page', () => {
    const html = render();
    expect(html).toContain('Conexiones e integraciones');
    expect(html).toContain('aria-label="Abrir conexiones e integraciones"');
    expect(html.split('href="/integrations"')).toHaveLength(3);
    expect(html.indexOf('Conexiones e integraciones')).toBeLessThan(html.indexOf('Documentos recibidos'));
    expect(html).toContain('Abrir o cerrar menú');
  });
  it.each(['setup.manage', 'user.manage', 'role.manage', 'scope', 'role'])('hides both entry points and blocks the route without %s', missing => {
    if (missing === 'scope') state.workspace.user.scope = { kind: 'ASSIGNED' };
    else if (missing === 'role') state.workspace.user.roles = ['AUDITOR'];
    else state.workspace.can = (permission: string) => permission !== missing;
    expect(canManageIntegrations(state.workspace.user, state.workspace.can)).toBe(false);
    let html = render();
    expect(html).not.toContain('href="/integrations"');
    state.pathname = '/integrations'; html = render();
    expect(html).toContain('Acceso no autorizado'); expect(html).not.toContain('Contenido del módulo');
    expect(html).not.toContain('href="/integrations"');
  });
  it('marks the header shortcut as the current page', () => {
    state.pathname = '/integrations'; render();
    expect(state.links.find(link => link['aria-label'] === 'Abrir conexiones e integraciones')['aria-current']).toBe('page');
  });
  it('keeps unsaved-change protection on the new header shortcut', () => {
    state.workspace.dirty = true; render();
    const links = state.links.filter(link => link.href === '/integrations');
    const event = { preventDefault: vi.fn() };
    links.find(link => link['aria-label'] === 'Abrir conexiones e integraciones').onClick(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(state.push).not.toHaveBeenCalled(); expect(state.workspace.setDirty).not.toHaveBeenCalled();
  });
  it('does not expose access before the workspace session is restored', () => {
    state.workspace.user = null; state.workspace.restoring = true;
    expect(render()).not.toContain('href="/integrations"');
    expect(canManageIntegrations(null, state.workspace.can)).toBe(false);
  });
});
