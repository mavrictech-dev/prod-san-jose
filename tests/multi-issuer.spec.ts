import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentService } from "../services/billing-service/src/application/issue-document.service";
import { IssuanceQueryService } from "../services/billing-service/src/application/issuance-query.service";
import { StationsController } from "../services/billing-service/src/stations.controller";
import { StationAdminService } from "../services/billing-service/src/application/station-admin.service";
import { DocumentIssuedConsumer } from "../services/sunat-service/src/application/document-issued.consumer";
import type { AccessScope } from "../packages/contracts/src/authorization";
const branchA = "10000000-0000-4000-8000-000000000001";
const branchB = "10000000-0000-4000-8000-000000000002";
const pointA = "20000000-0000-4000-8000-000000000001";
const pointB = "20000000-0000-4000-8000-000000000002";
const counterA = "40000000-0000-4000-8000-000000000001";
const counterB = "40000000-0000-4000-8000-000000000002";
const actorId = "30000000-0000-4000-8000-000000000001";
const globalRequest = {
  user: { sub: actorId, scope: { kind: "GLOBAL" }, roles: ['ADMIN'], permissions: ['setup.manage', 'series.manage'] },
} as never;
const input = {
  emissionPointId: pointA,
  documentType: "INVOICE" as const,
  series: "F001",
  paymentTerms: { type: 'CONTADO' as const },
  customer: {
    identityType: "6",
    identityNumber: "20450819230",
    legalName: "Cliente QA",
  },
  lines: [
    {
      description: "Diesel QA",
      unitCode: "GLL",
      quantity: "1",
      unitPriceWithTax: "18.50",
      taxAffectationCode: "10",
      igvRate: "18",
    },
  ],
};
function billingFixture() {
  // Segundo RUC exclusivamente sintético de tests; no se configura ninguna empresa real.
  const companies = [
    {
      id: 1,
      ruc: "20450819230",
      legalName: "Emisor QA A",
      environment: "BETA",
      active: true,
      taxAddress: "Dirección QA",
      ubigeo: "200101",
    },
    {
      id: 2,
      ruc: "00000000000",
      legalName: "Emisor QA B FICTICIO",
      environment: "BETA",
      active: true,
      taxAddress: "Dirección QA",
      ubigeo: "200101",
    },
  ];
  const points = [
    {
      id: pointA,
      companyId: 1,
      branchId: branchA,
      code: "QA_A",
      active: true,
      branch: { active: true, companyId: 1 },
    },
    {
      id: pointB,
      companyId: 2,
      branchId: branchB,
      code: "QA_B",
      active: true,
      branch: { active: true, companyId: 2 },
    },
  ];
  const counters = [
    {
      id: counterA,
      companyId: 1,
      emissionPointId: pointA,
      active: true,
      nextNumber: 1n,
    },
    {
      id: counterB,
      companyId: 2,
      emissionPointId: pointB,
      active: true,
      nextNumber: 1n,
    },
  ];
  const documents: any[] = [];
  const events: any[] = [];
  const tx = {
    emissionPoint: {
      findUnique: vi.fn(async ({ where }: any) =>
        points.find((p) => p.id === where.id),
      ),
    },
    companySettings: {
      findUniqueOrThrow: vi.fn(async ({ where }: any) =>
        companies.find((c) => c.id === where.id),
      ),
    },
    seriesCounter: {
      findUnique: vi.fn(async ({ where }: any) =>
        counters.find(
          (c) => c.companyId === where.companyId_documentType_series.companyId,
        ),
      ),
      update: vi.fn(async ({ where }: any) => {
        const c = counters.find((c) => c.id === where.id)!;
        c.nextNumber++;
        return { ...c };
      }),
    },
    idempotencyRecord: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    document: {
      create: vi.fn(async ({ data }: any) => {
        documents.push(data);
        return data;
      }),
    },
    outboxEvent: {
      create: vi.fn(async ({ data }: any) => {
        events.push(data.payload);
        return data;
      }),
    },
  };
  const service = new IssueDocumentService({
    $transaction: (work: any) => work(tx),
  } as never);
  const context = (scope: AccessScope = { kind: "GLOBAL" }) => ({
    userId: actorId,
    scope,
    idempotencyKey: "QA",
    correlationId: "QA",
  });
  return { service, tx, companies, points, counters, documents, events, context };
}
describe("Multi-emisor privado configurable", () => {
  afterEach(() => vi.unstubAllEnvs());
  it('pago a crédito se congela en el snapshot y evento sin usar float ni añadir email al XML', async () => {
    const f = billingFixture();
    const paymentTerms = { type: 'CREDITO' as const, currencyCode: 'PEN' as const, pendingAmount: '18.50',
      installments: [{ amount: '9.25', dueDate: '2030-12-01' }, { amount: '9.25', dueDate: '2030-12-02' }] };
    await f.service.execute({ ...input, customer: { ...input.customer, email: 'qa@pruebas.invalid' }, paymentTerms }, f.context());
    expect(f.documents[0].immutableSnapshot.paymentTerms).toEqual(paymentTerms);
    expect(f.events[0].payload.paymentTerms).toEqual(paymentTerms);
    expect(f.documents[0].customerEmail).toBe('qa@pruebas.invalid');
    expect(f.events[0].payload.customer).not.toHaveProperty('email');
  });
  it('pago incompleto o cuotas inconsistentes se rechazan antes de consumir un correlativo', async () => {
    const f = billingFixture();
    await expect(f.service.execute({ ...input, paymentTerms: undefined }, f.context())).rejects.toThrow();
    await expect(f.service.execute({ ...input, paymentTerms: { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '18.50',
      installments: [{ amount: '18.49', dueDate: '2030-12-01' }] } }, f.context())).rejects.toThrow();
    expect(f.counters[0].nextNumber).toBe(1n);
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
    expect(f.tx.document.create).not.toHaveBeenCalled();
  });
  it.each(['20', '30'])('afectación no implementada %s se bloquea antes de numerar', async taxAffectationCode => {
    const f = billingFixture();
    await expect(f.service.execute({ ...input, lines: [{ ...input.lines[0], taxAffectationCode, igvRate: '0' }] }, f.context())).rejects.toThrow('otras afectaciones');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
  });
  it.each(['discountAmount', 'iscAmount', 'advanceAmount'])('campo financiero %s no se descarta silenciosamente', async field => {
    const f = billingFixture();
    await expect(f.service.execute({ ...input, lines: [{ ...input.lines[0], [field]: '1.00' }] } as any, f.context())).rejects.toThrow('Campos de ítem no soportados');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
    expect(f.tx.document.create).not.toHaveBeenCalled();
  });
  it('producción se rechaza antes de consumir una serie aun con pago válido', async () => {
    const f = billingFixture();
    f.tx.companySettings.findUniqueOrThrow.mockResolvedValueOnce({ id: 1, ruc: '20450819230', legalName: 'NO REAL', environment: 'PRODUCTION' } as any);
    await expect(f.service.execute(input, f.context())).rejects.toThrow('producción bloqueada');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
  });
  it('emisor desactivado bloquea nuevas ventas sin consumir números ni crear Outbox', async () => {
    const f = billingFixture(); f.companies[0].active = false;
    await expect(f.service.execute(input, f.context())).rejects.toThrow();
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
    expect(f.tx.document.create).not.toHaveBeenCalled(); expect(f.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
  it('la emisión se coordina con edición de maestros mediante locks ordenados y parametrizados', async () => {
    vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true');
    const f = billingFixture(); const raw = vi.fn(async () => [{ companyId: 1, branchId: branchA }]);
    Object.assign(f.tx, { $queryRawUnsafe: raw });
    await f.service.execute(input, f.context());
    const statements = raw.mock.calls.map((call: any[]) => call[0]);
    expect(statements.slice(1).map(sql => sql.match(/FROM "(\w+)"/)[1])).toEqual(['CompanySettings', 'Branch', 'EmissionPoint', 'SeriesCounter']);
    expect(statements.slice(1, 4).every(sql => sql.endsWith('FOR SHARE'))).toBe(true);
    expect(statements[4]).toContain('FOR UPDATE');
    expect(statements.every(sql => sql.includes('$1'))).toBe(true);
    expect(statements.every(sql => !sql.includes(pointA) && !sql.includes('F001'))).toBe(true);
  });
  it("dos RUC usan F001-1 con counters, snapshots y eventos independientes; rechaza un emisor impuesto por el cliente", async () => {
    const f = billingFixture();
    await expect(f.service.execute({ ...input, companyId: 1 } as any, f.context())).rejects.toThrow('Campos no soportados');
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
    await f.service.execute(input, f.context());
    await f.service.execute(
      { ...input, emissionPointId: pointB },
      f.context(),
    );
    expect(
      f.documents.map((d) => [d.companyId, d.seriesCounterId, d.fullNumber]),
    ).toEqual([
      [1, counterA, "F001-1"],
      [2, counterB, "F001-1"],
    ]);
    expect(
      f.documents.map((d) => d.immutableSnapshot.issuer.identityNumber),
    ).toEqual(["20450819230", "00000000000"]);
    expect(
      f.events.map((e) => [e.payload.companyId, e.payload.environment]),
    ).toEqual([
      [1, "BETA"],
      [2, "BETA"],
    ]);
    expect(f.counters.map((c) => c.nextNumber)).toEqual([2n, 2n]);
    expect(f.tx.companySettings.findUniqueOrThrow.mock.calls[1][0]).toEqual({
      where: { id: 2 },
    });
  });
  it("autorizar F001 de un emisor no habilita F001 de otro aunque ambas sedes estén asignadas", async () => {
    const f = billingFixture();
    const scope: AccessScope = {
      kind: "ASSIGNED",
      branchIds: [branchA, branchB],
      emissionPointIds: [pointA, pointB],
      series: [counterA],
    };
    await expect(
      f.service.execute(
        { ...input, emissionPointId: pointB },
        f.context(scope),
      ),
    ).rejects.toThrow("no autorizados");
    expect(f.tx.seriesCounter.update).not.toHaveBeenCalled();
    expect(f.tx.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });
  it("rechaza un punto inconsistente con el emisor de su sede", async () => {
    const f = billingFixture();
    f.points[0].branch.companyId = 2;
    await expect(f.service.execute(input, f.context())).rejects.toThrow(
      "no autorizados",
    );
    expect(f.tx.seriesCounter.findUnique).not.toHaveBeenCalled();
  });
  it("filtra documentos por emisor en el servidor, además de puntos y UUID de serie", async () => {
    const count = vi.fn(async () => 0);
    const findMany = vi.fn(async () => []);
    const db = {
      branch: { findFirst: vi.fn(async () => ({ id: branchA })) },
      document: { count, findMany },
      $transaction: (qs: any[]) => Promise.all(qs),
    };
    const service = new IssuanceQueryService(db as never);
    await service.recentDocuments(
      {
        kind: "ASSIGNED",
        branchIds: [branchA],
        emissionPointIds: [pointA],
        series: [counterA],
      },
      branchA,
      1,
      "",
      "1",
    );
    expect(count.mock.calls[0][0]).toMatchObject({
      where: { companyId: 1, seriesCounterId: { in: [counterA] } },
    });
    await expect(
      service.recentDocuments({ kind: "GLOBAL" }, undefined, 1, "", "abc"),
    ).rejects.toThrow("Emisor inválido");
  });
  it("cada agregado del dashboard respeta el RUC y el alcance; no expande una Promise sin await", async () => {
    const aggregate = vi.fn(async (_args: any) => ({
      _count: { _all: 0 },
      _sum: { payableAmount: null, igvAmount: null },
    }));
    const groupBy = vi.fn(async (_args: any) => []);
    const service = new IssuanceQueryService({
      branch: { findFirst: async () => ({ id: branchA }) },
      document: { aggregate, groupBy },
      $transaction: (queries: any[]) => Promise.all(queries),
    } as never);
    await service.dashboard(
      {
        kind: "ASSIGNED",
        branchIds: [branchA],
        emissionPointIds: [pointA],
        series: [counterA],
      },
      branchA,
      "1",
    );
    for (const call of [...aggregate.mock.calls, ...groupBy.mock.calls]) {
      expect(call[0].where).toMatchObject({
        companyId: 1,
        currencyCode: "PEN",
        emissionPoint: { id: { in: [pointA] }, branchId: branchA },
        seriesCounterId: { in: [counterA] },
      });
    }
    expect(groupBy).toHaveBeenCalledTimes(3);
  });

  it("no acepta combinar un RUC con una sede ajena a ese emisor", async () => {
    const service = new IssuanceQueryService({
      branch: { findFirst: async () => null },
    } as never);
    await expect(
      service.recentDocuments({ kind: "GLOBAL" }, branchA, 1, "", "2"),
    ).rejects.toThrow("Emisor o sede no autorizados");
  });
  it("crear sede usa el emisor seleccionado y lo audita; no hay límite fijo de 21 sedes", async () => {
    vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true');
    const create = vi.fn(async ({ data }: any) => ({ id: branchB, ...data }));
    const audit = vi.fn(async () => ({}));
    const tx = {
      $queryRawUnsafe: vi.fn(async () => []),
      companySettings: { findUnique: async () => ({ id: 2, ruc: '00000000002', environment: 'BETA', active: true }) },
      branch: { create },
      configurationAudit: { create: audit },
    };
    const controller = new StationsController(new StationAdminService({
      $transaction: (work: any) => work(tx),
    } as never));
    await controller.create(
      { companyId: 2, code: "OTRA", name: "Otra sede" },
      globalRequest,
    );
    expect(create.mock.calls[0][0].data.companyId).toBe(2);
    expect(audit.mock.calls[0][0].data.metadata.companyId).toBe(2);
  });
  it.each([0, 1])(
    "reasignación segura: %i puntos existentes",
    async (count) => {
      vi.stubEnv('STATION_MASTER_CRUD_ENABLED', 'true');
      const update = vi.fn(async () => ({ id: branchA, companyId: 2 }));
      const lock = vi.fn(async () => []);
      const tx = {
        $queryRawUnsafe: lock,
        companySettings: { findUnique: async ({ where }: any) => ({ id: where.id, ruc: '00000000002', environment: 'BETA', active: true }) },
        branch: {
          findUnique: async () => ({ id: branchA, companyId: 1, active: true, masterRevision: 1 }),
          findUniqueOrThrow: async () => ({ id: branchA, companyId: 1, active: true, masterRevision: 1 }),
          update,
        },
        emissionPoint: { count: async () => count },
        configurationAudit: { create: async () => ({}) },
      };
      const controller = new StationsController(new StationAdminService({
        $transaction: (work: any) => work(tx),
      } as never));
      const action = controller.assignIssuer(
        branchA,
        { companyId: 2, expectedRevision: 1 },
        globalRequest,
      );
      if (count) {
        await expect(action).rejects.toThrow("No se permite cambiar su RUC");
        expect(update).not.toHaveBeenCalled();
      } else {
        await expect(action).resolves.toMatchObject({ companyId: 2 });
        expect(update).toHaveBeenCalledOnce();
      }
      expect(lock).toHaveBeenCalled();
    },
  );
  it("SUNAT conserva el RUC y entorno del evento, no usa SUNAT_ENVIRONMENT global", async () => {
    const f = billingFixture();
    await f.service.execute({ ...input, emissionPointId: pointB }, f.context());
    vi.stubEnv("SUNAT_ENVIRONMENT", "PRODUCTION");
    const fiscalUpsert = vi.fn(async () => ({}));
    const db = {
      inboxEvent: { findUnique: async () => null, create: async () => ({}) },
      fiscalDocument: { findUnique: async () => null, upsert: fiscalUpsert },
      documentArtifact: { upsert: async () => ({}) },
      outboxEvent: { create: async () => ({}) },
      $transaction: (qs: any[]) => Promise.all(qs),
    };
    const putUnsignedXml = vi.fn(async () => ({
      storageKey: "QA",
      sizeBytes: 1,
      sha256: "QA",
    }));
    const consumer = new DocumentIssuedConsumer(
      db as never,
      { putUnsignedXml, put: putUnsignedXml } as never,
    );
    await (consumer as any).process({ data: f.events[0], name: "QA" });
    expect(fiscalUpsert.mock.calls[0][0].create).toMatchObject({
      issuerRuc: "00000000000",
      environment: "BETA",
    });
    expect(putUnsignedXml.mock.calls[0][1]).toContain("00000000000-01-F001-1");
    // El worker conserva UBL pero ya no persiste PDF de consulta al emitir.
    expect(putUnsignedXml).toHaveBeenCalledOnce();
    const legacyEvent = structuredClone(f.events[0]);
    delete legacyEvent.payload.environment;
    await expect(
      (consumer as any).process({ data: legacyEvent, name: "QA" }),
    ).rejects.toThrow("Falta el contexto fiscal");
    expect(fiscalUpsert).toHaveBeenCalledOnce();
  });
});
