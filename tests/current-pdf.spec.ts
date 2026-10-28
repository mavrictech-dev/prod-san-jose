import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrozenPrintPresentationV1, FiscalDocumentSnapshot } from '../packages/contracts/src';
import { documentSample } from './qa-print-formats.mjs';

import { CurrentPdfService } from '../services/sunat-service/src/application/current-pdf.service';
const draw = { sale: vi.fn(), gre: vi.fn() };

const branchId = '20000000-0000-4000-8000-000000000001';
const token = 'Bearer QA.FICTICIO';
let service: CurrentPdfService, fetcher: ReturnType<typeof vi.fn>, profile: FrozenPrintPresentationV1;
function document(type = '03') {
  const value = documentSample(type) as FiscalDocumentSnapshot;
  value.branchId = branchId;
  value.printPresentation!.branchId = branchId;
  value.printPresentation!.branchName = 'SEDE EN LA EMISIÓN';
  value.printPresentation!.branchAddress = 'DIRECCIÓN EN LA EMISIÓN';
  return value;
}
beforeEach(() => {
  vi.stubEnv('PRINT_SETTINGS_ENABLED', 'true');
  profile = structuredClone(document().printPresentation!);
  profile.profileRevision = 20; profile.settings.logoMode = 'NONE'; profile.logo = null;
  profile.branchName = 'NOMBRE ACTUAL NO HISTÓRICO'; profile.branchAddress = 'DIRECCIÓN ACTUAL NO HISTÓRICA';
  fetcher = vi.fn(async () => new Response(JSON.stringify(profile), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  draw.sale.mockImplementation(async (snapshot, format, proof) => Buffer.from('%PDF-' + JSON.stringify({ snapshot, format, proof })));
  draw.gre.mockImplementation(async (snapshot, format, digest) => Buffer.from('%PDF-' + JSON.stringify({ snapshot, format, digest })));
  service = new CurrentPdfService({ document: draw.sale, gre: draw.gre });
});
afterEach(() => { service.onModuleDestroy(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('PDF bajo demanda: diseño actual y hechos históricos', () => {
  it.each(['01', '03', '07', '08'])('%s conserva datos de emisión, importes, cliente y referencias', async type => {
    const snapshot = document(type), before = structuredClone(snapshot);
    await service.document(snapshot, 'a4', token);
    expect(snapshot).toEqual(before);
    const printable = draw.sale.mock.calls[0][0];
    expect(printable).toMatchObject({ issuer: snapshot.issuer, customer: snapshot.customer,
      issueDate: snapshot.issueDate, series: snapshot.series, number: snapshot.number,
      lines: snapshot.lines, totals: snapshot.totals, paymentTerms: snapshot.paymentTerms });
    if (type === '07' || type === '08') expect(printable.reference).toEqual((snapshot as any).reference);
    expect(printable.printPresentation).toMatchObject({ profileRevision: 20, settings: profile.settings,
      branchName: 'SEDE EN LA EMISIÓN', branchAddress: 'DIRECCIÓN EN LA EMISIÓN' });
    expect(JSON.stringify(printable)).not.toContain('ACTUAL NO HISTÓRICO');
  });
  it('autoriza/consulta perfil vigente antes de CADA hit y evita regeneración duplicada', async () => {
    const snapshot = document();
    const one = await service.document(snapshot, 'a4', token), two = await service.document(snapshot, 'a4', token);
    expect(one).toEqual(two); expect(draw.sale).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toMatchObject([expect.stringContaining(`/1/snapshot?branchId=${branchId}`),
      { headers: { Authorization: token, 'Cache-Control': 'no-store' }, redirect: 'error' }]);
  });
  it.each(['revision', 'settings', 'logo', 'inheritance'])('cambio de %s se refleja sin esperar TTL', async change => {
    const snapshot = document();
    await service.document(snapshot, 'a4', token);
    if (change === 'revision') profile.profileRevision++;
    if (change === 'settings') profile.settings.footerNote = 'NOTA COMERCIAL NUEVA';
    if (change === 'logo') { profile.settings.logoMode = 'DEFAULT'; }
    if (change === 'inheritance') { profile.profileRevision = 0; profile.settings.showBranchAddress = false; }
    await service.document(snapshot, 'a4', token);
    expect(draw.sale).toHaveBeenCalledTimes(2);
  });
  it('no usa hit previo si se pierde autorización o se revoca la sesión', async () => {
    const snapshot = document(); await service.document(snapshot, 'a4', token);
    fetcher.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(service.document(snapshot, 'a4', token)).rejects.toMatchObject({ status: 403 });
    expect(draw.sale).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 500])('fallo del perfil %i no entrega presentación obsoleta', async status => {
    fetcher.mockResolvedValue(new Response('{}', { status }));
    await expect(service.document(document(), 'a4', token)).rejects.toThrow();
    expect(draw.sale).not.toHaveBeenCalled();
  });
  it.each(['ruc', 'branch', 'malformed', 'extra', 'url'])('rechaza perfil %s sin guardar ni representar', async kind => {
    if (kind === 'ruc') profile.issuerRuc = '00000000002';
    if (kind === 'branch') profile.branchId = '20000000-0000-4000-8000-000000000002';
    if (kind === 'malformed') profile.settings.logoWidthMm = NaN;
    if (kind === 'extra') Object.assign(profile, { issuer: { legalName: 'DATOS MODIFICADOS' } });
    if (kind === 'url') Object.assign(profile, { logoUrl: 'https://invalido.local/imagen' });
    await expect(service.document(document(), 'a4', token)).rejects.toMatchObject({ status: 409 });
    expect(draw.sale).not.toHaveBeenCalled();
  });
  it('reconstruye vínculo visual antiguo sólo desde metadata autorizada, no desde otro RUC', async () => {
    const snapshot = document(); delete snapshot.companyId; delete snapshot.branchId; delete snapshot.printPresentation;
    await service.document(snapshot, 'a4', token, undefined, { companyId: 1, branchId });
    expect(draw.sale.mock.calls[0][0].branchId).toBe(branchId);
    expect(draw.sale.mock.calls[0][0].printPresentation.branchName).toBeUndefined();
    expect(snapshot.branchId).toBeUndefined();
  });
  it.each([{ companyId: 2, branchId }, { companyId: 1, branchId: '20000000-0000-4000-8000-000000000002' }])(
    'rechaza vínculo externo incompatible %j', async binding => {
      await expect(service.document(document(), 'a4', token, undefined, binding)).rejects.toMatchObject({ status: 409 });
      expect(fetcher).not.toHaveBeenCalled(); expect(draw.sale).not.toHaveBeenCalled();
    },
  );
  it('sin contexto histórico no supone una empresa ni inventa una sede', async () => {
    const snapshot = document(); delete snapshot.companyId;
    await expect(service.document(snapshot, 'a4', token)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('mantiene exactamente el hash y estado QA y separa la caché de PDF sin firma', async () => {
    const snapshot = document(), proof = { digestValue: 'a'.repeat(43) + '=', status: 'SIGNED_LOCAL' };
    await service.document(snapshot, 'a4', token);
    await service.document(snapshot, 'a4', token, proof);
    expect(draw.sale).toHaveBeenCalledTimes(2); expect(draw.sale.mock.calls[1][2]).toEqual(proof);
  });
  it('separa formatos, documentos e importes, sin recalcular datos', async () => {
    const a = document(), b = document(); b.documentId = '50000000-0000-4000-8000-000000000002';
    await service.document(a, 'a4', token); await service.document(a, 'ticket', token); await service.document(b, 'a4', token);
    b.totals.payableAmount = '90.00'; await service.document(b, 'a4', token);
    expect(draw.sale).toHaveBeenCalledTimes(4); expect(draw.sale.mock.calls[3][0].totals.payableAmount).toBe('90.00');
  });
  it('la caché de desarrollo no habilita producción', async () => {
    const snapshot = document(); snapshot.environment = 'PRODUCTION';
    await expect(service.document(snapshot, 'a4', token)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).not.toHaveBeenCalled(); expect(draw.sale).not.toHaveBeenCalled();
  });
  it('sin módulo de logos usa el renderer actual con los datos congelados', async () => {
    vi.stubEnv('PRINT_SETTINGS_ENABLED', 'false'); const snapshot = document();
    await service.document(snapshot, 'a4', token);
    expect(fetcher).not.toHaveBeenCalled(); expect(draw.sale.mock.calls[0][0]).toEqual(snapshot);
  });
  it('un error de render no queda cacheado ni reutiliza PDF antiguo', async () => {
    draw.sale.mockRejectedValueOnce(new Error('fallo de plantilla'));
    await expect(service.document(document(), 'a4', token)).rejects.toMatchObject({ status: 503 });
    await service.document(document(), 'a4', token); expect(draw.sale).toHaveBeenCalledTimes(2);
  });
});
