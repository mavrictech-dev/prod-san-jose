import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalEmissionWorkflowService } from '../services/sunat-service/src/application/local-emission-workflow.service';
import { LocalXmlValidationService, LocalDocumentPendingError } from '../services/sunat-service/src/application/local-xml-validation.service';
import { LocalPreparationUnavailableError } from '../services/sunat-service/src/application/local-preparation-policy';
import { FiscalCircuitQaController } from '../services/sunat-service/src/fiscal-circuit-qa.controller';
import { canRunLocalEmissionWorkflow, runLocalEmissionWorkflow } from '../apps/web-pwa/features/workspace/local-emission-workflow';
import type { Catalog, User } from '../apps/web-pwa/features/workspace/types';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { ConflictException, ForbiddenException, BadRequestException, ServiceUnavailableException } = require('@nestjs/common');
const id = randomUUID(); const actor = randomUUID();
const circuit = (state = 'QUEUED') => ({ ready: true, state, cdrAvailable: state === 'ACCEPTED', officialCdr: false, fiscalTransmission: false });
const started = (state = 'QUEUED') => ({ documentId: id, localOnly: true, official: false, fiscalTransmission: false, transport: 'LOCAL_SIMULATION', phase: 'CIRCUIT_STARTED', circuit: circuit(state) });
beforeEach(() => { vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true'); vi.stubEnv('LOCAL_XML_VALIDATION_ENABLED', 'true'); vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false'); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NO RED REAL'); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Orquestación local sobre una venta ya registrada', () => {
  it('revalida el contexto y arranca solamente el circuito simulado existente', async () => {
    const local = { context: vi.fn(async () => ({})) }; const qa = { start: vi.fn(async () => circuit()) };
    const service = new LocalEmissionWorkflowService(local as never, qa as never);
    expect(await service.run(id, actor, 'Bearer MOCK')).toMatchObject(started());
    expect(local.context).toHaveBeenCalledWith(id, 'Bearer MOCK'); expect(qa.start).toHaveBeenCalledWith(id, actor, 'ACCEPTED', 'Bearer MOCK');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('espera sólo cuando falta la copia propia del evento, sin iniciar firma', async () => {
    const qa = { start: vi.fn() }; const local = { context: vi.fn(async () => { throw new LocalDocumentPendingError(); }) };
    const result = await new LocalEmissionWorkflowService(local as never, qa as never).run(id, actor, 'Bearer MOCK');
    expect(result).toMatchObject({ phase: 'WAITING_LOCAL_COPY', retryAfterMs: 2000, official: false }); expect(qa.start).not.toHaveBeenCalled();
  });
  it('ocupación XSD explícita permite esperar, pero ningún otro error relaja los gates', async () => {
    const local = { context: vi.fn(async () => ({})) }; const qa = { start: vi.fn().mockRejectedValueOnce(new LocalPreparationUnavailableError('XSD_BUSY')) };
    const service = new LocalEmissionWorkflowService(local as never, qa as never);
    expect(await service.run(id, actor, 'Bearer MOCK')).toMatchObject({ phase: 'WAITING_LOCAL_VALIDATOR' });
    for (const error of [new ConflictException('Certificado cambió'), new BadRequestException('XML inválido'), new ForbiddenException('No autorizado'), new ServiceUnavailableException('Bóveda no disponible')]) {
      qa.start.mockRejectedValueOnce(error); await expect(service.run(id, actor, 'Bearer MOCK')).rejects.toBe(error);
    }
  });
  it('nunca inspecciona credenciales reales del RUC de software en este laboratorio', async () => {
    const prisma = { fiscalDocument: { findUnique: vi.fn() }, sunatCredentials: { findUnique: vi.fn() } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id, fiscalTransmission: false,
      immutableSnapshot: { documentId: id, environment: 'BETA', issuer: { identityNumber: '20615878481' } } }), { status: 200 })));
    const local = new LocalXmlValidationService(prisma as never, {} as never, {} as never, {} as never);
    const qa = { start: vi.fn() }; const service = new LocalEmissionWorkflowService(local, qa as never);
    await expect(service.run(id, actor, 'Bearer MOCK')).rejects.toThrow('no se firman comprobantes del RUC real');
    expect(prisma.fiscalDocument.findUnique).not.toHaveBeenCalled(); expect(prisma.sunatCredentials.findUnique).not.toHaveBeenCalled(); expect(qa.start).not.toHaveBeenCalled();
  });
  it('transmisión externa activa detiene antes de leer el contexto', async () => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true'); const local = { context: vi.fn() }; const qa = { start: vi.fn() };
    await expect(new LocalEmissionWorkflowService(local as never, qa as never).run(id, actor, 'Bearer MOCK')).rejects.toThrow('transmisión externa deshabilitada');
    expect(local.context).not.toHaveBeenCalled(); expect(qa.start).not.toHaveBeenCalled();
  });
  it('el endpoint no admite seleccionar ambiente/credenciales ni escenario desde el cliente', async () => {
    const workflow = { run: vi.fn() }; const controller = new FiscalCircuitQaController({} as never, workflow as never);
    const req = { headers: { authorization: 'Bearer MOCK' }, user: { sub: actor } };
    for (const body of [undefined, null, [], { environment: 'PRODUCTION' }, { ruc: '20615878481' }, { scenario: 'ACCEPTED' }]) {
      expect(() => controller.workflowStart(id, body, req as never)).toThrow('no admite');
    }
    expect(workflow.run).not.toHaveBeenCalled(); controller.workflowStart(id, {}, req as never);
    expect(workflow.run).toHaveBeenCalledWith(id, actor, 'Bearer MOCK');
  });
});

describe('PWA: un comprobante y un circuito local, no segunda emisión', () => {
  const admin: User = { sub: actor, username: 'MOCK', roles: ['ADMIN'], permissions: ['sunat.configure'], exp: 0, scope: { kind: 'GLOBAL' } };
  const catalog: Catalog = { companies: [{ id: 1, ruc: '00000000001', legalName: 'QA FICTICIO', environment: 'BETA' }], capabilities: { demoData: true, fiscalTransmission: false }, branches: [], emissionPoints: [], products: [] };
  it('sólo muestra la acción para admin global, emisor ficticio, BETA y demo aislada', () => {
    expect(canRunLocalEmissionWorkflow(admin, catalog, 1)).toBe(true);
    expect(canRunLocalEmissionWorkflow({ ...admin, roles: ['CASHIER'] }, catalog, 1)).toBe(false);
    expect(canRunLocalEmissionWorkflow(admin, { ...catalog, companies: [{ ...catalog.companies[0], ruc: '20615878481' }] }, 1)).toBe(false);
    expect(canRunLocalEmissionWorkflow(admin, { ...catalog, capabilities: { demoData: true, fiscalTransmission: true } }, 1)).toBe(false);
    expect(canRunLocalEmissionWorkflow(admin, { ...catalog, companies: [{ ...catalog.companies[0], environment: 'PRODUCTION' }] }, 1)).toBe(false);
  });
  it('espera copia local, arranca circuito, consulta el mismo ticket y recibe CDR simulado', async () => {
    vi.useFakeTimers(); const api = vi.fn().mockResolvedValueOnce({ ...started(), phase: 'WAITING_LOCAL_COPY', circuit: undefined, retryAfterMs: 2000 })
      .mockResolvedValueOnce(started()).mockResolvedValueOnce(circuit('WAITING_TICKET')).mockResolvedValueOnce(circuit('ACCEPTED'));
    const progress = vi.fn(); const running = runLocalEmissionWorkflow(api, id, new AbortController().signal, progress);
    await vi.runAllTimersAsync(); expect((await running).cdrAvailable).toBe(true);
    expect(api.mock.calls.map(([path]) => path)).toEqual([`/api/v1/fiscal-circuit-qa/${id}/workflow`, `/api/v1/fiscal-circuit-qa/${id}/workflow`, `/api/v1/fiscal-circuit-qa/${id}`, `/api/v1/fiscal-circuit-qa/${id}`]);
    expect(progress.mock.calls.flat().join(' ')).toContain('mismo ticket');
  });
  it('resultado desconocido termina el flujo sin repetir el POST', async () => {
    const api = vi.fn(async () => started('UNKNOWN'));
    expect((await runLocalEmissionWorkflow(api, id, new AbortController().signal, vi.fn())).state).toBe('UNKNOWN'); expect(api).toHaveBeenCalledOnce();
  });
  it('cancela al salir de la pantalla y no crea una venta al fallar el laboratorio', async () => {
    const controller = new AbortController(); controller.abort(); const api = vi.fn();
    await expect(runLocalEmissionWorkflow(api, id, controller.signal, vi.fn())).rejects.toBeDefined(); expect(api).not.toHaveBeenCalled();
    api.mockRejectedValue(new Error('Sin conexión')); await expect(runLocalEmissionWorkflow(api, id, new AbortController().signal, vi.fn())).rejects.toThrow('Sin conexión');
    expect(api.mock.calls.every(([path]) => !path.startsWith('/api/v1/documents'))).toBe(true);
  });
  it('rechaza una respuesta que intente aparentar transmisión o CDR oficiales', async () => {
    const api = vi.fn(async () => ({ ...started(), official: true }));
    await expect(runLocalEmissionWorkflow(api, id, new AbortController().signal, vi.fn())).rejects.toThrow('fuera del laboratorio');
  });
});
