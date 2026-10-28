import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const webRequire = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const state = vi.hoisted(() => ({ value: {} as any, calls: [] as [string, boolean][] }));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({ useResource: (path: string, poll: boolean) => { state.calls.push([path, poll]); return state.value; } }));
import { SupplementTracking } from '../apps/web-pwa/features/workspace/supplement-tracking';
const id = '60000000-0000-4000-8000-000000000001';
const render = () => renderToStaticMarkup(React.createElement(SupplementTracking, { documentId: id }));
beforeEach(() => { vi.stubGlobal('React', React); state.value = { reload: vi.fn(), data: undefined, error: undefined }; state.calls = []; });
afterEach(() => vi.unstubAllGlobals());
describe('Seguimiento PWA no presenta registro como aceptación fiscal', () => {
  it('carga ruta autorizada y conserva aviso explícito', () => {
    const html = render(); expect(state.calls).toEqual([[`/api/v1/fiscal-evidence/${id}`, true]]);
    expect(html).toContain('Producción permanece bloqueada'); expect(html).toContain('no confirma aceptación fiscal');
  });
  it('sin suplementos no inventa ni mezcla CDR del emulador', () => {
    state.value.data = { documentId: id, environment: 'BETA', readOnly: true, financialProjectionApplied: false, transmissionAuthorized: false, items: [] };
    expect(render()).toContain('No hay notas o lotes fiscales vinculados');
  });
  it.each([{ environment: 'PRODUCTION' }, { transmissionAuthorized: true }, { financialProjectionApplied: true }, { documentId: 'otro' }])('no renderiza claims fuera del contrato %#', change => {
    state.value.data = { documentId: id, environment: 'BETA', readOnly: true, financialProjectionApplied: false, transmissionAuthorized: false, items: [], ...change };
    expect(render()).toContain('Respuesta de seguimiento inconsistente');
  });
  it('CDR no verificado permanece explícito aunque la fila registre ACCEPTED', () => {
    state.value.data = { documentId: id, environment: 'BETA', readOnly: true, financialProjectionApplied: false, transmissionAuthorized: false,
      items: [{ id: '60000000-0000-4000-8000-000000000002', kind: 'RC', reference: 'RC-20261003-1', recordedStatus: 'ACCEPTED',
        phase: 'CDR_UNVERIFIED', requestedAction: 'ALTA', attempt: 1, completedAt: null, snapshotSha256: 'a'.repeat(64), fiscalEffectsAppliedByThisView: false }] };
    const html = render(); expect(html).toContain('CDR_UNVERIFIED'); expect(html).toContain('Estado registrado');
    expect(html).not.toContain('Aceptado por SUNAT'); expect(html).not.toContain('bg-emerald');
  });
});
