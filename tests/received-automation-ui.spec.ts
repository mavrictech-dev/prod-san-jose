import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceivedAutomationConfig, ReceivedSireDiscovery, ReceivedSyncRun } from '../packages/contracts/src/received-automation';
import type { ReceivedSelection } from '../apps/web-pwa/features/workspace/received-documents-model';
import type { Branch, User } from '../apps/web-pwa/features/workspace/types';
import {
  canManageReceivedAutomation, createReceivedAutomationDraft, createReceivedAutomationPoll,
  receivedAutomationConfigInScope, receivedAutomationDiscoveriesInScope, receivedAutomationDraftDirty,
  receivedAutomationIncidentsValid, receivedAutomationQuery, receivedAutomationRunsValid, receivedAutomationSave, receivedAutomationScopeKey,
  receivedAutomationSelectionAllowed, receivedAutomationSettingsError, receivedAutomationSyncBlock,
  receivedListDirty, reconcileReceivedAutomationDraft, RECEIVED_AUTOMATION_POLL_MS, type ReceivedSireIncidentMetadata,
} from '../apps/web-pwa/features/workspace/received-automation-model';

const access = vi.hoisted(() => ({
  user: undefined as User | undefined, manage: true, read: true,
  catalog: undefined as { branches: Branch[] } | undefined, catalogError: undefined as string | undefined,
  data: {} as Record<string, unknown>, paths: [] as string[], api: vi.fn(), setDirty: vi.fn(),
}));
vi.mock('../apps/web-pwa/features/workspace/provider', () => ({
  ApiError: class extends Error { constructor(message: string, readonly status: number) { super(message); } },
  useWorkspace: () => ({ user: access.user, can: (permission: string) => permission === 'setup.manage' ? access.manage : access.read,
    catalogSource: 'SYNTHETIC', catalog: access.catalog, catalogError: access.catalogError, api: access.api, setDirty: access.setDirty }),
  useResource: (path: string) => { access.paths.push(path); return { data: access.data[path], error: undefined, reload: vi.fn() }; },
}));
import {
  ReceivedAutomationPanel, ReceivedAutomationForm, ReceivedAutomationStatus,
  ReceivedAutomationSyncControls, ReceivedAutomationRuns, ReceivedAutomationDiscoveries, ReceivedAutomationIncidents,
} from '../apps/web-pwa/features/workspace/received-automation';
import { ApiError } from '../apps/web-pwa/features/workspace/provider';
import {
  canAssignReceivedDocument, receivedAssignmentBranches, receivedAssignmentCommand,
  ReceivedAssignmentForm, saveReceivedAssignment,
} from '../apps/web-pwa/features/workspace/received-documents';

const require = createRequire(new URL('../apps/web-pwa/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const render = (component: unknown, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const selection: ReceivedSelection = { company: { id: 101, ruc: '00000000101', legalName: 'RECEPTOR FICTICIO', environment: 'BETA' }, branchId: 'qa-branch', dataSource: 'SYNTHETIC' };
const user = (): User => ({ sub: 'qa-admin', username: 'FICTICIO', roles: ['ADMIN'], permissions: ['setup.manage', 'report.view'], scope: { kind: 'GLOBAL' }, exp: 9999999999 });
const config = (patch: Partial<ReceivedAutomationConfig> = {}): ReceivedAutomationConfig => ({
  companyId: 101, recipientRuc: selection.company.ruc, revision: 2, updatedAt: null,
  settings: { enabled: true, mode: 'LOCAL_FIXTURE', intervalMinutes: 15,
    mailbox: { enabled: true, host: 'imap.fixture.invalid', port: 993, folder: 'INBOX', username: 'qa' },
    sire: { enabled: true, startPeriod: '202601', clientId: 'fixture-client', solUsername: 'FIXTURESOL' } },
  credentials: { mailPassword: false, sireClientSecret: false, solPassword: false },
  liveReadAllowed: false, mailHostApproved: false, canManage: true, state: 'READY_LOCAL', notice: 'Preparación ficticia local.', ...patch,
});
const live = (patch: Partial<ReceivedAutomationConfig> = {}): ReceivedAutomationConfig => {
  const base = config();
  return { ...base, settings: { ...base.settings, mode: 'LIVE_READ_ONLY' }, state: 'WAITING_TI', ...patch };
};
const discovery = (patch: Partial<ReceivedSireDiscovery> = {}): ReceivedSireDiscovery => ({
  id: 'qa-discovery', companyId: 101, recipientRuc: selection.company.ruc, period: '202601', supplierRuc: '00000000303',
  supplierName: 'PROVEEDOR FICTICIO', documentType: '01', fullNumber: 'FQA1-1', issueDate: '2026-01-01',
  currencyCode: null, amount: null, xmlStatus: 'PENDING', documentId: null, observedAt: '2026-01-01T00:00:00Z', ...patch,
});
const run = (patch: Partial<ReceivedSyncRun> = {}): ReceivedSyncRun => ({
  id: 'qa-run', source: 'SIRE', status: 'COMPLETED', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
  counters: { detected: 17, imported: 13, duplicate: 2, rejected: 1, xmlPending: 3, matches: 11, mismatches: 4 }, errorCode: null, ...patch,
});
const incident = (patch: Partial<ReceivedSireIncidentMetadata> = {}): ReceivedSireIncidentMetadata => ({
  id: 'qa-incident', period: '202601', ordinal: 3, code: 'CONSOLIDATED_RANGE', observedAt: '2026-01-01T00:00:00Z', ...patch,
});
const branchA: Branch = { id: '10000000-0000-4000-8000-000000000101', companyId: 101, code: 'QA-A', name: 'SEDE FICTICIA A' };
const branchA2: Branch = { id: '10000000-0000-4000-8000-000000000102', companyId: 101, code: 'QA-A2', name: 'SEDE FICTICIA A2' };
const branchB: Branch = { id: '10000000-0000-4000-8000-000000000202', companyId: 202, code: 'QA-B', name: 'OTRO RUC NO REVELAR' };
const assignmentDetail = { id: '10000000-0000-4000-8000-000000000001', companyId: 101, recipientRuc: selection.company.ruc, branchId: null as string | null };
const assignmentProps = () => ({ detail: assignmentDetail, branchId: null, onChange: vi.fn(), onSubmit: vi.fn(), onReset: vi.fn() });
const formProps = (current = config()) => ({ config: current, draft: createReceivedAutomationDraft(current), onChange: vi.fn(), onSubmit: vi.fn(), onDiscard: vi.fn() });
const buttons = (html: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
const disabled = (html: string | undefined) => !!html && /\sdisabled(?:="[^"]*")?(?=[\s>])/.test(html);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  access.user = user(); access.manage = true; access.read = true; access.paths = []; access.api.mockClear();
  access.api.mockReset(); access.catalogError = undefined;
  access.catalog = { branches: [branchA, branchA2, branchB] };
  access.data = { [receivedAutomationQuery(selection, 'config')]: config(),
    [receivedAutomationQuery(selection, 'runs')]: { items: [] }, [receivedAutomationQuery(selection, 'discoveries')]: { items: [] },
    [receivedAutomationQuery(selection, 'incidents')]: { items: [] } };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in reception UI tests'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('recepción automática: alcance y permisos', () => {
  it('consulta config/runs por empresa y discoveries con sede, sin inventar parámetros', () => {
    const paths = ['config', 'runs', 'discoveries'] as const;
    expect(paths.map(path => receivedAutomationQuery(selection, path))).toEqual([
      '/api/v1/received-documents/automation/config?companyId=101', '/api/v1/received-documents/automation/runs?companyId=101',
      '/api/v1/received-documents/automation/discoveries?companyId=101&branchId=qa-branch',
    ]);
    expect(receivedAutomationQuery({ ...selection, branchId: undefined }, 'discoveries')).toBe('/api/v1/received-documents/automation/discoveries?companyId=101');
    expect(receivedAutomationQuery(selection, 'incidents')).toBe('/api/v1/received-documents/automation/incidents?companyId=101');
  });
  it('ADMIN GLOBAL con setup.manage puede configurar cualquier RUC seleccionado', () => {
    expect(canManageReceivedAutomation(user(), true)).toBe(true);
    expect(receivedAutomationSelectionAllowed({ ...selection, company: { ...selection.company, id: 202, ruc: '00000000202' } }, user())).toBe(true);
    const html = render(ReceivedAutomationPanel, { selection });
    expect(html).toContain('Guardar configuración'); expect(html).toContain('Ejecuciones de este RUC');
    expect(html).toContain('Incidentes SIRE de este RUC');
    expect(access.paths).toEqual((['config', 'runs', 'incidents', 'discoveries'] as const).map(path => receivedAutomationQuery(selection, path)));
    expect(access.api).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['assigned', 'role', 'permission'])('oculta config y runs ante falta de autorización %s', condition => {
    if (condition === 'assigned') access.user!.scope = { kind: 'ASSIGNED', branchIds: ['qa-branch'], emissionPointIds: [], series: [] };
    if (condition === 'role') access.user!.roles = ['AUDITOR'];
    if (condition === 'permission') access.manage = false;
    const html = render(ReceivedAutomationPanel, { selection });
    expect(html).not.toContain('Guardar configuración'); expect(html).not.toContain('Ejecuciones de este RUC');
    expect(html).not.toContain('Hostname IMAP guardado aprobado'); expect(html).not.toContain('Lista para fixtures locales');
    expect(html).not.toContain('Incidentes SIRE de este RUC');
    expect(access.paths).toEqual([receivedAutomationQuery(selection, 'discoveries')]); expect(access.api).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'otra-sede'])('ASSIGNED sin sede autorizada %j no abre ningún recurso', branchId => {
    access.user!.scope = { kind: 'ASSIGNED', branchIds: ['qa-branch'], emissionPointIds: [], series: [] };
    expect(render(ReceivedAutomationPanel, { selection: { ...selection, branchId } })).toContain('role="alert"');
    expect(access.paths).toEqual([]);
  });
  it('ASSIGNED sólo recibe relaciones MATCHED y no revela pendientes de todo el RUC', () => {
    access.user!.scope = { kind: 'ASSIGNED', branchIds: ['qa-branch'], emissionPointIds: [], series: [] };
    access.data[receivedAutomationQuery(selection, 'discoveries')] = { items: [discovery({ supplierName: 'NO_REVELAR' })] };
    expect(render(ReceivedAutomationPanel, { selection })).not.toContain('NO_REVELAR');
    expect(receivedAutomationDiscoveriesInScope({ items: [discovery()] }, selection, true)).toBe(false);
    expect(receivedAutomationDiscoveriesInScope({ items: [discovery({ xmlStatus: 'MATCHED', documentId: 'qa-doc' })] }, selection, true)).toBe(true);
    expect(receivedAutomationDiscoveriesInScope({ items: [discovery({ xmlStatus: 'MATCHED' })] }, selection, true)).toBe(false);
  });
  it('no consulta discovery sin report.view y no consulta nada sin sesión o permisos', () => {
    access.read = false;
    render(ReceivedAutomationPanel, { selection });
    expect(access.paths).toHaveLength(3);
    access.paths = []; access.manage = false;
    expect(render(ReceivedAutomationPanel, { selection })).toContain('role="alert"'); expect(access.paths).toEqual([]);
    access.user = undefined;
    expect(render(ReceivedAutomationPanel, { selection })).toContain('role="alert"');
  });
  it('cambia la identidad de montaje ante RUC, sede, fuente, sesión o permisos', () => {
    const base = receivedAutomationScopeKey(selection, user(), 'SYNTHETIC');
    const keys = [receivedAutomationScopeKey({ ...selection, branchId: 'qa-other' }, user(), 'SYNTHETIC'),
      receivedAutomationScopeKey({ ...selection, company: { ...selection.company, ruc: '00000000202' } }, user(), 'SYNTHETIC'),
      receivedAutomationScopeKey(selection, user(), 'BUSINESS'), receivedAutomationScopeKey(selection, { ...user(), sub: 'qa-other-user' }, 'SYNTHETIC'),
      receivedAutomationScopeKey(selection, { ...user(), permissions: [] }, 'SYNTHETIC'),
      receivedAutomationScopeKey(selection, { ...user(), scope: { kind: 'ASSIGNED', branchIds: ['qa-branch'], emissionPointIds: [], series: [] } }, 'SYNTHETIC')];
    for (const key of keys) expect(key).not.toBe(base);
  });
});

describe('estado sucio agregado de la bandeja', () => {
  it('terminar importación o refrescar recursos no limpia el borrador de automatización', () => {
    const draft = createReceivedAutomationDraft(config());
    draft.settings.mailbox.folder = 'BORRADOR_PENDIENTE';
    const automationDirty = receivedAutomationDraftDirty(draft);
    expect(receivedListDirty(true, automationDirty)).toBe(true);
    expect(receivedListDirty(false, automationDirty)).toBe(true);
    reconcileReceivedAutomationDraft(draft, config({ revision: 3 }));
    expect(receivedListDirty(false, receivedAutomationDraftDirty(draft))).toBe(true);
    expect(receivedListDirty(false, receivedAutomationDraftDirty(createReceivedAutomationDraft(config({ revision: 3 }))))).toBe(false);
  });
  it('guardar o desmontar automatización no limpia archivos u operaciones pendientes', () => {
    const states = [[false, false], [true, false], [true, true], [true, false], [false, true], [false, false]] as const;
    expect(states.map(([importDirty, automationDirty]) => receivedListDirty(importDirty, automationDirty))).toEqual([false, true, true, true, true, false]);
  });
  it('la bandeja es el único dueño; propaga callback estable y sólo limpia al desmontar', () => {
    const received = readFileSync(new URL('../apps/web-pwa/features/workspace/received-documents.tsx', import.meta.url), 'utf8');
    const list = received.split('function ReceivedList(')[1].split('function ReceivedPageResource(')[0];
    const panel = readFileSync(new URL('../apps/web-pwa/features/workspace/received-automation.tsx', import.meta.url), 'utf8');
    expect(list).toContain('useCallback((value: boolean) => setAutomationDirty(value), [])');
    expect(list).toContain('receivedListDirty(importDirty, automationDirty)');
    expect(list).toContain('useEffect(() => { setDirty(dirty); }, [dirty, setDirty])');
    expect(list).toContain('useEffect(() => () => setDirty(false), [setDirty])');
    expect(list).toContain('<ReceivedAutomationPanel selection={selection} onDirtyChange={onDirtyChange} />');
    expect(panel).not.toMatch(/\bsetDirty\b/);
    expect(panel.match(/onDirtyChange=\{onDirtyChange\}/g)).toHaveLength(2);
    expect(panel).toContain('onDirtyChange(dirty || !!busy)');
    expect(panel).toContain('useEffect(() => () => onDirtyChange(false), [onDirtyChange])');
  });
});

describe('asignación manual de sede en documento recibido', () => {
  it('ADMIN GLOBAL setup.manage ve un formulario shadcn inicialmente Sin asignar, sin deducir sede', () => {
    expect(canAssignReceivedDocument(user(), true)).toBe(true);
    const html = render(ReceivedAssignmentForm, assignmentProps());
    expect(html).toContain('Asignación manual de sede'); expect(html).toContain('Sin asignar');
    expect(html).toContain('no identifica la sede en recepción'); expect(html).toContain('Todas las sedes');
    expect(html).toContain('no cambia el RUC, el XML, su proyección ni el estado fiscal');
    expect(html).toContain('data-slot="card"'); expect(html).toContain('data-slot="select-trigger"'); expect(html).toContain('aria-describedby');
    for (const match of html.matchAll(/<label[^>]*for="([^"]+)"/g)) expect(html).toContain(`id="${match[1]}"`);
    expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(true);
    expect(html).not.toContain(branchB.name); expect(access.api).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['assigned', 'role', 'permission', 'session'])('oculta asignación y sedes sin autorización %s', condition => {
    if (condition === 'assigned') access.user!.scope = { kind: 'ASSIGNED', branchIds: [branchA.id], emissionPointIds: [], series: [] };
    if (condition === 'role') access.user!.roles = ['AUDITOR'];
    if (condition === 'permission') access.manage = false;
    if (condition === 'session') access.user = undefined;
    expect(render(ReceivedAssignmentForm, { ...assignmentProps(), branchId: branchA.id })).toBe('');
    expect(access.api).not.toHaveBeenCalled();
  });
  it('filtra el catálogo por companyId y no elige una sede por orden, RUC o nombre', () => {
    const original = structuredClone(access.catalog!.branches);
    expect(receivedAssignmentBranches(101, access.catalog!.branches)).toEqual([branchA, branchA2]);
    expect(receivedAssignmentBranches(202, access.catalog!.branches)).toEqual([branchB]);
    expect(receivedAssignmentBranches(999, access.catalog!.branches)).toEqual([]);
    expect(access.catalog!.branches).toEqual(original);
    const html = render(ReceivedAssignmentForm, { ...assignmentProps(), branchId: branchA2.id });
    expect(html).toContain(branchA2.name); expect(html).not.toContain(branchB.name);
    expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(false);
  });
  it('usa la sede nullable del detalle para CAS y sólo incluye los dos campos administrativos', () => {
    expect(receivedAssignmentCommand(assignmentDetail, branchA.id, access.catalog!.branches)).toEqual({ branchId: branchA.id, expectedBranchId: null });
    expect(receivedAssignmentCommand({ ...assignmentDetail, branchId: branchA.id }, null, access.catalog!.branches)).toEqual({ branchId: null, expectedBranchId: branchA.id });
    expect(receivedAssignmentCommand({ ...assignmentDetail, branchId: branchA.id }, branchA2.id, access.catalog!.branches)).toEqual({ branchId: branchA2.id, expectedBranchId: branchA.id });
    expect(assignmentDetail.branchId).toBeNull();
  });
  it('permite Sin asignar para una sede actual válida y deshabilita la selección sin cambios', () => {
    const detail = { ...assignmentDetail, branchId: branchA.id };
    const unchanged = render(ReceivedAssignmentForm, { ...assignmentProps(), detail, branchId: branchA.id });
    expect(unchanged).toContain(branchA.name); expect(disabled(buttons(unchanged).find(button => button.includes('Guardar sede')))).toBe(true);
    const unassign = render(ReceivedAssignmentForm, { ...assignmentProps(), detail, branchId: null });
    expect(unassign).toContain('Sin asignar'); expect(disabled(buttons(unassign).find(button => button.includes('Guardar sede')))).toBe(false);
  });
  it.each([branchB.id, 'not-a-uuid', '10000000-0000-4000-8000-000000000999'])('rechaza una sede ajena o ausente %s antes del PATCH', async branchId => {
    await expect(saveReceivedAssignment(access.api, assignmentDetail, branchId, access.catalog!.branches, new AbortController().signal)).rejects.toThrow('catálogo actual');
    expect(access.api).not.toHaveBeenCalled();
    const html = render(ReceivedAssignmentForm, { ...assignmentProps(), branchId });
    expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(true);
    expect(html).not.toContain(branchB.name);
  });
  it('catálogo no disponible, ocupado o borradores de otro formulario bloquean el guardado', () => {
    const props = { ...assignmentProps(), branchId: branchA.id };
    for (const patch of [{ busy: true }, { blocked: true }]) {
      const html = render(ReceivedAssignmentForm, { ...props, ...patch });
      expect(disabled(buttons(html).find(button => button.includes('Guardar sede') || button.includes('Procesando')))).toBe(true);
    }
    access.catalog = undefined;
    const html = render(ReceivedAssignmentForm, props);
    expect(html).toContain('catálogo de sedes no está disponible'); expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(true);
  });
  it('retiene selección y expectedBranchId originales ante una sede distinta leída del servidor', () => {
    const html = render(ReceivedAssignmentForm, { ...assignmentProps(), detail: { ...assignmentDetail, branchId: branchA2.id }, branchId: branchA.id, expectedBranchId: null });
    expect(html).toContain(branchA.name); expect(html).toContain('Tu selección se conserva');
    expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(true);
    expect(disabled(buttons(html).find(button => button.includes('Cargar sede actual')))).toBe(false);
  });
  it('PATCH con CAS usa api/signal y valida el retorno antes de confirmar', async () => {
    access.api.mockResolvedValueOnce({ branchId: branchA.id });
    const controller = new AbortController();
    expect(await saveReceivedAssignment(access.api, assignmentDetail, branchA.id, access.catalog!.branches, controller.signal)).toEqual({ branchId: branchA.id });
    const [path, options] = access.api.mock.calls[0];
    expect(path).toBe(`/api/v1/received-documents/${assignmentDetail.id}/assignment`); expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ branchId: branchA.id, expectedBranchId: null }); expect(options.signal).toBeInstanceOf(AbortSignal);
    controller.abort(); expect(options.signal.aborted).toBe(true);
  });
  it('admite respuesta branchId:null al quitar una asignación existente', async () => {
    access.api.mockResolvedValueOnce({ branchId: null });
    expect(await saveReceivedAssignment(access.api, { ...assignmentDetail, branchId: branchA.id }, null, access.catalog!.branches, new AbortController().signal)).toEqual({ branchId: null });
  });
  it('CAS409 presenta un error seguro, conserva la selección y no reintenta sobre otra sede', async () => {
    access.api.mockRejectedValueOnce(new ApiError('NO_REVELAR_RAW_ERROR', 409));
    await expect(saveReceivedAssignment(access.api, assignmentDetail, branchA.id, access.catalog!.branches, new AbortController().signal)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('La sede cambió en otra sesión') });
    expect(access.api).toHaveBeenCalledOnce();
    const html = render(ReceivedAssignmentForm, { ...assignmentProps(), branchId: branchA.id, conflict: true });
    expect(html).toContain(branchA.name); expect(html).toContain('Tu selección se conserva'); expect(html).not.toContain('NO_REVELAR_RAW_ERROR');
    expect(disabled(buttons(html).find(button => button.includes('Guardar sede')))).toBe(true);
  });
  it.each([null, {}, [], { branchId: branchB.id }, { branchId: branchA.id, companyId: 202 }, { branchId: branchA.id, xml: 'NO_REVELAR_XML' }])('rechaza respuesta ajena o ampliada %j', async value => {
    access.api.mockResolvedValueOnce(value);
    await expect(saveReceivedAssignment(access.api, assignmentDetail, branchA.id, access.catalog!.branches, new AbortController().signal)).rejects.toThrow('respuesta de asignación es inválida');
  });
  it('cancela antes de enviar y rechaza respuesta tardía tras cambiar de contexto', async () => {
    const cancelled = new AbortController(); cancelled.abort();
    await expect(saveReceivedAssignment(access.api, assignmentDetail, branchA.id, access.catalog!.branches, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(access.api).not.toHaveBeenCalled();
    const waiting = deferred<unknown>(); access.api.mockReturnValueOnce(waiting.promise);
    const controller = new AbortController();
    const request = saveReceivedAssignment(access.api, assignmentDetail, branchA.id, access.catalog!.branches, controller.signal);
    controller.abort(); waiting.resolve({ branchId: branchA.id });
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('escapa nombres del catálogo y protege todos los borradores con un único setDirty owner', () => {
    access.catalog!.branches = [{ ...branchA, name: '<script>unsafe()</script>' }];
    const html = render(ReceivedAssignmentForm, { ...assignmentProps(), branchId: branchA.id });
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>unsafe');
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/received-documents.tsx', import.meta.url), 'utf8');
    const detail = source.split('function ReceivedDetail(')[1];
    expect(detail).toContain('assignmentChanged || !!action.busy'); expect(detail).toContain('useEffect(() => () => setDirty(false), [setDirty])');
    expect(detail).toContain('saveReceivedAssignment(api, assignmentBase, assignmentBranchId, catalog.branches, signal)');
    expect(detail).toContain('setAssignmentConflict(false); reload()');
    expect(source.split('export function ReceivedAssignmentForm(')[1].split('function ReceivedDetail(')[0]).not.toContain('setDirty');
  });
});

describe('incidentes SIRE: sólo administración y metadatos seguros', () => {
  it('muestra registros no conciliables con los cinco metadatos y sin enlaces fiscales', () => {
    access.data[receivedAutomationQuery(selection, 'incidents')] = { items: [incident()] };
    const html = render(ReceivedAutomationPanel, { selection, onDirtyChange() {} });
    for (const text of ['Incidentes SIRE de este RUC', 'Registros no conciliables', 'no acreditan aceptación fiscal', 'Periodo', 'Ordinal', 'Código', 'Observado', 'Identificador', 'CONSOLIDATED_RANGE', 'qa-incident', '2026-01-01T00:00:00Z']) expect(html).toContain(text);
    expect(html).not.toContain('rawRecord'); expect(html).not.toContain('Aceptar propuesta');
    const table = render(ReceivedAutomationIncidents, { items: [incident()] });
    expect(table).toContain('<thead'); expect(table).toContain('<tbody'); expect(table).not.toContain('/received/'); expect(table).toContain('>3<');
  });
  it.each(['assigned', 'role', 'permission'])('no consulta ni revela incidentes ante falta de autorización %s', condition => {
    if (condition === 'assigned') access.user!.scope = { kind: 'ASSIGNED', branchIds: ['qa-branch'], emissionPointIds: [], series: [] };
    if (condition === 'role') access.user!.roles = ['AUDITOR'];
    if (condition === 'permission') access.manage = false;
    access.data[receivedAutomationQuery(selection, 'incidents')] = { items: [incident({ code: 'NO_REVELAR_INCIDENTE' })] };
    expect(render(ReceivedAutomationPanel, { selection })).not.toContain('NO_REVELAR_INCIDENTE');
    expect(access.paths).not.toContain(receivedAutomationQuery(selection, 'incidents'));
    expect(access.api).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('muestra vacío real y acepta metadatos válidos sin rawRecord', () => {
    expect(receivedAutomationIncidentsValid({ items: [] })).toBe(true);
    expect(receivedAutomationIncidentsValid({ items: [incident()] })).toBe(true);
    expect(receivedAutomationIncidentsValid({ items: [incident({ ordinal: 0 })] })).toBe(true);
    const html = render(ReceivedAutomationIncidents, { items: [] });
    expect(html).toContain('Sin incidentes SIRE'); expect(html).toContain('No hay registros no conciliables'); expect(html).not.toContain('<table');
  });
  it.each([
    { ordinal: -1 }, { ordinal: 1.5 }, { ordinal: '3' }, { period: '202613' },
    { period: '2026-01' }, { observedAt: 'no-es-fecha' }, { code: '' }, { id: '' },
  ])('rechaza tipos o valores inválidos sin renderizar la respuesta %j', patch => {
    const value = { items: [{ ...incident(), ...patch, id: patch.id ?? 'NO_REVELAR_METADATA' }] };
    expect(receivedAutomationIncidentsValid(value)).toBe(false);
    access.data[receivedAutomationQuery(selection, 'incidents')] = value;
    const html = render(ReceivedAutomationPanel, { selection });
    expect(html).toContain('No se pudieron actualizar metadatos seguros'); expect(html).not.toContain('NO_REVELAR_METADATA');
  });
  it.each(['rawRecord', 'credentials', 'companyId'])('rechaza campos extra %s sin revelar su contenido ni metadatos parciales', key => {
    const value = { items: [{ ...incident({ code: 'NO_REVELAR_PARCIAL' }), [key]: 'NO_REVELAR_CONTENIDO' }] };
    expect(receivedAutomationIncidentsValid(value)).toBe(false);
    access.data[receivedAutomationQuery(selection, 'incidents')] = value;
    const html = render(ReceivedAutomationPanel, { selection });
    expect(html).not.toMatch(/NO_REVELAR_CONTENIDO|NO_REVELAR_PARCIAL/);
  });
  it('rechaza rawRecord en el envelope, respuestas incompletas e IDs repetidos', () => {
    for (const value of [null, undefined, {}, [], { items: null }, { items: [{}] },
      { items: [incident()], rawRecord: 'NO_REVELAR' }, { items: [incident(), incident()] }]) expect(receivedAutomationIncidentsValid(value)).toBe(false);
  });
  it('escapa códigos e identificadores y no interpreta HTML activo', () => {
    const row = incident({ code: '<script>unsafe()</script>', id: '<img src=x onerror=unsafe()>' });
    expect(receivedAutomationIncidentsValid({ items: [row] })).toBe(true);
    const html = render(ReceivedAutomationIncidents, { items: [row] });
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
    expect(html).not.toContain('<script>unsafe'); expect(html).not.toContain('<img src=x');
  });
  it('conserva los últimos metadatos seguros y el borrador ante un poll inválido; cancela resultados de otro scope', async () => {
    const draft = createReceivedAutomationDraft(config()); draft.settings.mailbox.folder = 'BORRADOR_PENDIENTE';
    const previous = { items: [incident()] }; let snapshot = previous; let signal!: AbortSignal;
    const waiting = deferred<unknown>();
    const read = vi.fn().mockResolvedValueOnce({ items: [{ ...incident(), rawRecord: 'NO_REVELAR' }] })
      .mockImplementationOnce((current: AbortSignal) => { signal = current; return waiting.promise; });
    const poll = createReceivedAutomationPoll(read, value => {
      if (receivedAutomationIncidentsValid(value)) snapshot = value;
    }, vi.fn());
    await poll.run(); expect(snapshot).toBe(previous); expect(receivedAutomationDraftDirty(draft)).toBe(true);
    const inFlight = poll.run(); poll.cancel(); expect(signal.aborted).toBe(true);
    waiting.resolve({ items: [incident({ id: 'OTHER_SCOPE' })] }); await inFlight;
    expect(snapshot).toBe(previous); expect(draft.settings.mailbox.folder).toBe('BORRADOR_PENDIENTE');
  });
});

describe('borrador, credenciales y revisión', () => {
  it('omite secretos vacíos y no modifica las settings originales', () => {
    const current = config(), draft = createReceivedAutomationDraft(current);
    draft.settings.mailbox.host = '  IMAP.fixture.invalid  ';
    draft.credentials.solPassword = ' secret with spaces ';
    const payload = receivedAutomationSave(draft);
    expect(payload).toEqual({ expectedRevision: 2, settings: { ...draft.settings, mailbox: { ...draft.settings.mailbox, host: 'imap.fixture.invalid' } }, credentials: { solPassword: ' secret with spaces ' } });
    expect(current.settings.mailbox.host).toBe('imap.fixture.invalid');
    expect(receivedAutomationSave(createReceivedAutomationDraft(current))).not.toHaveProperty('credentials');
  });
  it('una respuesta guardada sólo tiene flags; un borrador nuevo siempre vacía las contraseñas', () => {
    const draft = createReceivedAutomationDraft(config({ credentials: { mailPassword: true, sireClientSecret: true, solPassword: true } }));
    expect(draft.credentials).toEqual({ mailPassword: '', sireClientSecret: '', solPassword: '' });
    expect(receivedAutomationDraftDirty(draft)).toBe(false);
    draft.credentials.mailPassword = 'QA_SECRET'; expect(receivedAutomationDraftDirty(draft)).toBe(true);
  });
  it('no sustituye campos ni expectedRevision ante sondeo, refresco o revisión concurrente', () => {
    const draft = createReceivedAutomationDraft(config()); draft.settings.mailbox.folder = 'MI_BORRADOR'; draft.credentials.mailPassword = 'QA_SECRET';
    const snapshot = JSON.stringify(draft);
    expect(reconcileReceivedAutomationDraft(draft, config({ revision: 3 }))).toBe(draft);
    expect(JSON.stringify(draft)).toBe(snapshot); expect(receivedAutomationSave(draft).expectedRevision).toBe(2);
    expect(reconcileReceivedAutomationDraft(undefined, config()).credentials.mailPassword).toBe('');
    const props = { ...formProps(config({ revision: 3 })), draft };
    const html = render(ReceivedAutomationForm, props);
    expect(html).toContain('MI_BORRADOR'); expect(html).toContain('Hay una revisión nueva');
    expect(disabled(buttons(html).find(button => button.includes('Guardar configuración')))).toBe(true);
  });
  it.each([4, 1441, 15.5, NaN])('rechaza intervalos fuera del contrato %s', intervalMinutes => {
    expect(receivedAutomationSettingsError({ ...config().settings, intervalMinutes }, selection.company.ruc, '202610')).toContain('5 y 1440');
  });
  it.each([5, 15, 1440])('acepta intervalo %s y periodo no futuro', intervalMinutes => {
    expect(receivedAutomationSettingsError({ ...config().settings, intervalMinutes }, selection.company.ruc, '202610')).toBeUndefined();
  });
  it.each(['202600', '202613', '2026-01', '202611'])('rechaza periodo inválido o futuro %s', startPeriod => {
    const settings = config().settings; settings.sire.startPeriod = startPeriod;
    expect(receivedAutomationSettingsError(settings, selection.company.ruc, '202610')).toMatch(/periodo/i);
  });
  it('LIVE se puede preparar con gate apagado; exige campos, no permiso de lectura para guardar', () => {
    expect(receivedAutomationSettingsError(live().settings, selection.company.ruc, '202610')).toBeUndefined();
    const props = formProps(live()); props.draft.settings.intervalMinutes = 20;
    expect(disabled(buttons(render(ReceivedAutomationForm, props)).find(button => button.includes('Guardar configuración')))).toBe(false);
  });
  it.each(['https://imap.fixture.invalid', '127.0.0.1', '[::1]', 'imap.fixture.invalid:993'])('rechaza host con URL, IP o puerto %s', host => {
    const settings = live().settings; settings.mailbox.host = host;
    expect(receivedAutomationSettingsError(settings, selection.company.ruc, '202610')).toContain('hostname');
  });
  it('rechaza fuentes vacías y fixtures activas en un RUC distinto de 00', () => {
    const settings = config().settings;
    expect(receivedAutomationSettingsError(settings, '20999999999', '202610')).toContain('prefijo 00');
    settings.mailbox.enabled = false; settings.sire.enabled = false;
    expect(receivedAutomationSettingsError(settings, selection.company.ruc, '202610')).toContain('Activa correo o SIRE');
  });
});

describe('gate del servidor y vistas shadcn sin datos inventados', () => {
  it('espera TI con liveReadAllowed=false y no habilita botones de lectura', () => {
    const current = live();
    expect(receivedAutomationSyncBlock(current, 'ALL')).toContain('Esperando TI');
    const html = render(ReceivedAutomationSyncControls, { config: current, onSync() {} });
    expect(buttons(html)).toHaveLength(3); for (const button of buttons(html)) expect(disabled(button)).toBe(true);
    const status = render(ReceivedAutomationStatus, { config: current });
    expect(status).toContain('No es SOAP beta'); expect(status).toContain('LIVE_READ_ONLY'); expect(status).toContain('No · esperando TI');
  });
  it('requiere host exacto aprobado y todas las credenciales de cada fuente LIVE', () => {
    const ready = live({ state: 'READY_READ_ONLY', liveReadAllowed: true, mailHostApproved: true,
      credentials: { mailPassword: true, sireClientSecret: true, solPassword: true } });
    expect(receivedAutomationSyncBlock(ready, 'ALL')).toBeUndefined();
    expect(receivedAutomationSyncBlock({ ...ready, mailHostApproved: false }, 'MAIL')).toContain('hostname');
    expect(receivedAutomationSyncBlock({ ...ready, credentials: { ...ready.credentials, solPassword: false } }, 'SIRE')).toContain('credenciales');
    expect(receivedAutomationSyncBlock({ ...ready, canManage: false }, 'ALL')).toContain('no autoriza');
    expect(receivedAutomationSyncBlock({ ...ready, state: 'WAITING_TI' }, 'ALL')).toContain('Esperando TI');
  });
  it('fixtures sólo habilita consultas preparadas en RUC ficticio y bloquea fuente apagada', () => {
    const current = config(); expect(receivedAutomationSyncBlock(current, 'ALL')).toBeUndefined();
    expect(receivedAutomationSyncBlock({ ...current, recipientRuc: '20999999999' }, 'ALL')).toContain('prefijo 00');
    current.settings.mailbox.enabled = false; expect(receivedAutomationSyncBlock(current, 'MAIL')).toContain('deshabilitada');
    expect(buttons(render(ReceivedAutomationSyncControls, { config: current, dirty: true, onSync() {} })).every(disabled)).toBe(true);
  });
  it('tiene etiquetas asociadas, habilitación accesible, selectors shadcn y tres password vacíos', () => {
    const html = render(ReceivedAutomationForm, formProps(config({ credentials: { mailPassword: true, sireClientSecret: true, solPassword: true } })));
    expect(html).toContain('data-slot="card"'); expect(html).toContain('data-slot="select-trigger"');
    expect(html).toContain('Habilitar recepción automática'); expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    const passwords = html.match(/<input\b[^>]*type="password"[^>]*>/g)!;
    expect(passwords).toHaveLength(3); for (const password of passwords) { expect(password).toContain('value=""'); expect(password).toMatch(/autocomplete="new-password"/i); expect(password).toContain('aria-describedby'); }
    for (const match of html.matchAll(/<label[^>]*for="([^"]+)"/g)) expect(html).toContain(`id="${match[1]}"`);
    expect(html).toContain('min="5"'); expect(html).toContain('max="1440"'); expect(html).toContain('guardada');
  });
  it('muestra vacíos reales y no inventa filas o enlaces', () => {
    const html = render(ReceivedAutomationDiscoveries, { items: [] });
    expect(html).toContain('Sin descubrimientos SIRE'); expect(html).toContain('No hay ítems'); expect(html).toContain('XML pendiente');
    expect(html).not.toContain('<table'); expect(html).not.toContain('/received/');
    expect(render(ReceivedAutomationRuns, { items: [] })).toContain('Sin ejecuciones');
  });
  it('sólo enlaza XML MATCHED; PENDING y CONFLICT conservan importes desconocidos', () => {
    const html = render(ReceivedAutomationDiscoveries, { items: [discovery({ id: 'qa-pending', documentId: 'NO_LINK_PENDING' }),
      discovery({ id: 'qa-conflict', xmlStatus: 'CONFLICT', documentId: 'NO_LINK_CONFLICT' }),
      discovery({ id: 'qa-matched', xmlStatus: 'MATCHED', documentId: 'qa-doc/1', amount: '118.00', currencyCode: 'PEN' })] });
    expect(html).toContain('<thead'); expect(html).toContain('<tbody'); expect(html).toContain('XML pendiente'); expect(html).toContain('Conflicto con XML');
    expect(html).toContain('/received/qa-doc%2F1'); expect(html).not.toMatch(/NO_LINK_PENDING|NO_LINK_CONFLICT/); expect(html).toContain('118.00 PEN');
    expect(html).not.toContain('0.00');
  });
  it('muestra los siete contadores retornados y los estados de ejecución', () => {
    const html = render(ReceivedAutomationRuns, { items: [run(), run({ id: 'qa-blocked', status: 'BLOCKED', errorCode: 'TI_GATE_DISABLED' })] });
    for (const text of ['Detectados', 'Importados', 'Duplicados', 'Rechazados', 'XML pendientes', 'Coincidencias', 'Conflictos', '17', '13', '11', 'Completada', 'Bloqueada', 'TI_GATE_DISABLED']) expect(html).toContain(text);
  });
  it('rechaza respuestas de otro RUC, secretos en lugar de flags y contadores inválidos', () => {
    expect(receivedAutomationConfigInScope(config({ companyId: 202 }), selection)).toBe(false);
    expect(receivedAutomationConfigInScope(config({ recipientRuc: '00000000202' }), selection)).toBe(false);
    expect(receivedAutomationConfigInScope({ ...config(), credentials: { mailPassword: 'NO_REVELAR', sireClientSecret: false, solPassword: false } }, selection)).toBe(false);
    expect(receivedAutomationDiscoveriesInScope({ items: [discovery({ companyId: 202 })] }, selection)).toBe(false);
    expect(receivedAutomationRunsValid({ items: [{ ...run(), counters: { ...run().counters, imported: -1 } }] })).toBe(false);
    access.data[receivedAutomationQuery(selection, 'config')] = config({ companyId: 202, notice: 'NO_REVELAR' });
    expect(render(ReceivedAutomationPanel, { selection })).not.toContain('NO_REVELAR');
  });
  it('escapa texto de proveedor, aviso y código de diagnóstico', () => {
    for (const html of [render(ReceivedAutomationDiscoveries, { items: [discovery({ supplierName: '<script>unsafe()</script>' })] }),
      render(ReceivedAutomationStatus, { config: config({ notice: '<script>unsafe()</script>' }) }),
      render(ReceivedAutomationRuns, { items: [run({ errorCode: '<script>unsafe()</script>' })] })]) {
      expect(html).not.toContain('<script>unsafe'); expect(html).toContain('&lt;script&gt;');
    }
  });
});

describe('sondeo quieto y cancelación de alcance', () => {
  it('consulta a los 20 segundos, no solapa peticiones y cancela completados tardíos', async () => {
    vi.useFakeTimers();
    const waiting = deferred<number>(); let signal!: AbortSignal;
    const read = vi.fn((current: AbortSignal) => { signal = current; return waiting.promise; });
    const accept = vi.fn(), failure = vi.fn(); const poll = createReceivedAutomationPoll(read, accept, failure);
    const timer = setInterval(() => { void poll.run(); }, RECEIVED_AUTOMATION_POLL_MS);
    await vi.advanceTimersByTimeAsync(19_999); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); expect(read).toHaveBeenCalledTimes(1);
    clearInterval(timer); poll.cancel(); expect(signal.aborted).toBe(true);
    waiting.resolve(1); await Promise.resolve(); expect(accept).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
    await poll.run(); expect(read).toHaveBeenCalledTimes(1);
  });
  it('permite reintentar después de fallo y conserva la última instantánea válida', async () => {
    let snapshot = 7;
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(9);
    const fail = vi.fn(); const poll = createReceivedAutomationPoll(read, value => { snapshot = value as number; }, fail);
    await poll.run(); expect(snapshot).toBe(7); expect(fail).toHaveBeenCalledOnce();
    await poll.run(); expect(snapshot).toBe(9); poll.cancel();
  });
  it('usa provider/api y cancelación; no instala refresco en foco ni persiste secretos', () => {
    const source = readFileSync(new URL('../apps/web-pwa/features/workspace/received-automation.tsx', import.meta.url), 'utf8');
    const model = readFileSync(new URL('../apps/web-pwa/features/workspace/received-automation-model.ts', import.meta.url), 'utf8');
    expect(source).toContain('useResource<unknown>(path)'); expect(source).toContain('RECEIVED_AUTOMATION_POLL_MS');
    expect(source).toContain('task.cancel()'); expect(source).toContain('operation.current.cancel()');
    expect(source).toContain('method: \'PATCH\''); expect(source).toContain('method: \'POST\'');
    expect(source + model).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|addEventListener\(['"](?:focus|visibilitychange)|https?:\/\//);
  });
});
