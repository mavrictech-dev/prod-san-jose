import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceQueryService } from "../services/billing-service/src/application/issuance-query.service";
import { IssueDocumentService } from "../services/billing-service/src/application/issue-document.service";
import { UserAdministrationService } from "../services/identity-service/src/application/user-administration.service";
import { AuthService } from "../services/identity-service/src/application/auth.service";
import {
  DefaultRolePermissions,
  type AccessScope,
  type AccessTokenClaims,
} from "../packages/contracts/src/authorization";
const branchA = "10000000-0000-4000-8000-000000000001";
const branchB = "10000000-0000-4000-8000-000000000002";
const pointA = "20000000-0000-4000-8000-000000000001";
const pointB = "20000000-0000-4000-8000-000000000002";
const invoiceCounter = "40000000-0000-4000-8000-000000000001";
const receiptCounter = "40000000-0000-4000-8000-000000000002";
const scope: AccessScope = {
  kind: "ASSIGNED",
  branchIds: [branchA],
  emissionPointIds: [pointA],
  series: [invoiceCounter, receiptCounter],
};
const actor: AccessTokenClaims = {
  sub: "30000000-0000-4000-8000-000000000001",
  username: "local.admin",
  roles: ["STATION_MANAGER"],
  permissions: [...DefaultRolePermissions.STATION_MANAGER],
  scope,
  authVersion: 1,
  iat: 1,
  exp: 9999999999,
  iss: "test",
  aud: "test",
};
const input = {
  emissionPointId: pointA,
  documentType: "INVOICE" as const,
  series: "F001",
  customer: {
    identityType: "6",
    identityNumber: "20450819230",
    legalName: "Cliente de prueba",
  },
  lines: [
    {
      description: "Diesel B5",
      unitCode: "GLL",
      quantity: "1",
      unitPriceWithTax: "18.50",
      taxAffectationCode: "10",
      igvRate: "18",
    },
  ],
};
describe("Billing: autorización en la aplicación, no solo en la interfaz", () => {
  it("aplica filtros de sede y punto y rechaza una sede ajena", () => {
    const service = new IssuanceQueryService({} as never);
    expect(service.pointWhere(scope)).toMatchObject({
      id: { in: [pointA] },
      branchId: { in: [branchA] },
      active: true,
    });
    expect(() => service.pointWhere(scope, branchB)).toThrow(
      "Sede no autorizada",
    );
    expect(service.pointWhere(scope, branchA, false)).not.toHaveProperty(
      "active",
    );
  });
  it("consulta documentos con sede, punto y serie, sin ocultar históricos inactivos", async () => {
    const count = vi.fn().mockResolvedValue(0);
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new IssuanceQueryService({
      document: { count, findMany },
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    } as never);
    const page = await service.recentDocuments(scope, branchA);
    expect(count.mock.calls[0][0].where).toEqual({
      emissionPoint: { id: { in: [pointA] }, branchId: branchA },
      seriesCounterId: { in: [invoiceCounter, receiptCounter] },
    });
    expect(page).toEqual({ page: 1, pageSize: 20, total: 0, items: [] });
    await expect(service.recentDocuments(scope, branchA, 0)).rejects.toThrow(
      "Paginación",
    );
  });
  it.each([
    { point: pointB, branch: branchB, series: "F001" },
    { point: pointB, branch: branchA, series: "F001" },
    { point: pointA, branch: branchA, series: "F999" },
  ])(
    "rechaza emisión fuera de alcance antes de reservar un correlativo: %j",
    async ({ point, branch, series }) => {
      const reserve = vi.fn();
      const lookup = vi.fn();
      const tx = {
        emissionPoint: {
          findUnique: vi.fn().mockResolvedValue({
            id: point,
            branchId: branch,
            active: true,
            companyId: 1,
            branch: { active: true, companyId: 1 },
          }),
        },
        idempotencyRecord: { findUnique: lookup },
        seriesCounter: {
          update: reserve,
          findUnique: async () => ({
            id: "40000000-0000-4000-8000-000000000099",
            active: true,
            emissionPointId: pointA,
          }),
        },
      };
      const service = new IssueDocumentService({
        $transaction: (work: (value: unknown) => unknown) => work(tx),
      } as never);
      await expect(
        service.execute(
          { ...input, emissionPointId: point, series },
          {
            userId: actor.sub,
            scope,
            idempotencyKey: "test",
            correlationId: "test",
          },
        ),
      ).rejects.toThrow("no autorizados");
      expect(reserve).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it("recupera una operación ya confirmada sin incrementar la serie", async () => {
    const { createHash } = await import("node:crypto");
    const reserve = vi.fn();
    const document = { id: "doc", fullNumber: "F001-7", sunatStatus: "QUEUED" };
    const tx = {
      emissionPoint: {
        findUnique: async () => ({
          id: pointA,
          branchId: branchA,
          active: true,
          companyId: 1,
          branch: { active: true, companyId: 1 },
        }),
      },
      idempotencyRecord: {
        findUnique: async () => ({
          documentId: "doc",
          requestHash: createHash("sha256")
            .update(JSON.stringify(input))
            .digest("hex"),
        }),
      },
      document: { findUniqueOrThrow: async () => document },
      seriesCounter: {
        update: reserve,
        findUnique: async () => ({
          id: invoiceCounter,
          active: true,
          emissionPointId: pointA,
        }),
      },
    };
    const service = new IssueDocumentService({
      $transaction: (work: (value: unknown) => unknown) => work(tx),
    } as never);
    expect(
      await service.execute(input, {
        userId: actor.sub,
        scope,
        idempotencyKey: "same",
        correlationId: "same",
      }),
    ).toEqual(document);
    expect(reserve).not.toHaveBeenCalled();
  });
  it("rechaza datos inválidos antes de acceder a la base", async () => {
    const transaction = vi.fn();
    const service = new IssueDocumentService({
      $transaction: transaction,
    } as never);
    await expect(
      service.execute(
        { ...input, lines: [{ ...input.lines[0], quantity: "-1" }] },
        {
          userId: actor.sub,
          scope,
          idempotencyKey: "test",
          correlationId: "test",
        },
      ),
    ).rejects.toThrow("Ítems inválidos");
    expect(transaction).not.toHaveBeenCalled();
  });
});
describe("Identity: delegación y revocación", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it("revoca una cuenta aunque Billing esté caído y aumenta la versión de acceso", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("Billing no disponible"));
    vi.stubGlobal("fetch", fetchMock);
    const target = {
      id: "30000000-0000-4000-8000-000000000002",
      username: "cashier",
      fullName: "Cajero",
      active: true,
      lastLoginAt: null,
      roles: [{ role: { code: "CASHIER", name: "Cajero" } }],
      branches: [{ branchId: branchA }],
      emissionPoints: [{ emissionPointId: pointA }],
      series: [{ series: receiptCounter }],
    };
    const update = vi.fn().mockResolvedValue({ ...target, active: false });
    const revoke = vi.fn().mockResolvedValue({ count: 1 });
    const clear = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      $queryRawUnsafe: vi.fn(),
      user: { findUnique: vi.fn().mockResolvedValue(target), update },
      userRoleAssignment: { deleteMany: clear },
      userBranch: { deleteMany: clear },
      userEmissionPoint: { deleteMany: clear },
      userSeries: { deleteMany: clear },
      refreshSession: { updateMany: revoke },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const service = new UserAdministrationService(
      {
        $transaction: (work: (value: unknown) => unknown) => work(tx),
        role: {
          findMany: vi
            .fn()
            .mockResolvedValue([{ id: "role", code: "CASHIER" }]),
        },
      } as never,
      {} as never,
    );
    await service.updateAccess(
      target.id,
      { active: false },
      actor,
      "Bearer test",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.authVersion).toEqual({ increment: 1 });
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("el administrador local no crea ADMIN ni delega una sede ajena", async () => {
    const hash = vi.fn();
    const audit = vi.fn().mockResolvedValue({});
    const service = new UserAdministrationService(
      { auditLog: { create: audit } } as never,
      { hash } as never,
    );
    const data = {
      username: "new.user",
      fullName: "Nuevo usuario",
      password: "password-test-123",
      roles: ["ADMIN"] as const,
      branchIds: [],
      emissionPointIds: [],
      series: [],
    };
    await expect(
      service.create({ ...data, roles: ["ADMIN"] }, actor, "Bearer test"),
    ).rejects.toThrow("No puede delegar");
    await expect(
      service.create(
        { ...data, roles: ["CASHIER"], branchIds: [branchB] },
        actor,
        "Bearer test",
      ),
    ).rejects.toThrow("No puede delegar");
    expect(hash).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(2);
  });
  it("ni el administrador global asigna un punto que pertenece a otra sede", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          branches: [{ id: branchA }, { id: branchB }],
          emissionPoints: [
            {
              id: pointB,
              branchId: branchB,
              series: [{ id: receiptCounter, series: "B002" }],
            },
          ],
        }),
      }),
    );
    const service = new UserAdministrationService({} as never, {} as never);
    await expect(
      service.create(
        {
          username: "new.user",
          fullName: "Nuevo usuario",
          password: "password-test-123",
          roles: ["CASHIER"],
          branchIds: [branchA],
          emissionPointIds: [pointB],
          series: [receiptCounter],
        },
        { ...actor, roles: ["ADMIN"], scope: { kind: "GLOBAL" } },
        "Bearer test",
      ),
    ).rejects.toThrow("El punto no pertenece");
  });
  it("rechaza auto-modificar accesos", async () => {
    const service = new UserAdministrationService({} as never, {} as never);
    await expect(
      service.updateAccess(
        actor.sub,
        { roles: ["ADMIN"] },
        actor,
        "Bearer test",
      ),
    ).rejects.toThrow("propio acceso");
  });
  it.each([
    { active: false, authVersion: 1 },
    { active: true, authVersion: 2 },
    null,
  ])("rechaza sesiones revocadas: %j", async (record) => {
    const service = new AuthService(
      { user: { findUnique: async () => record } } as never,
      {} as never,
    );
    await expect(service.assertActive(actor)).rejects.toThrow(
      "Su acceso cambió",
    );
  });
  it("mantiene válida una sesión activa con la misma versión", async () => {
    const service = new AuthService(
      {
        user: { findUnique: async () => ({ active: true, authVersion: 1 }) },
      } as never,
      {} as never,
    );
    await expect(service.assertActive(actor)).resolves.toBeUndefined();
  });
});
