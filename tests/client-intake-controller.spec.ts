import "reflect-metadata";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientIntakeController } from "../services/billing-service/src/client-intake.controller";
import { JwtPermissionGuard, REQUIRED_PERMISSIONS_KEY } from "../services/billing-service/src/auth/jwt-permission.guard";
import type { AccessTokenClaims } from "../packages/contracts/src/authorization";

const claims = (): AccessTokenClaims => ({
  sub: "00000000-0000-4000-8000-000000000950",
  username: "intake.local.admin",
  roles: ["ADMIN"], permissions: ["setup.manage"], scope: { kind: "GLOBAL" },
  authVersion: 1, iss: "factuez-identity", aud: "factuez-services", iat: 1, exp: 2,
});
const read = (user?: AccessTokenClaims) => new ClientIntakeController().read({ headers: {}, user });
beforeEach(() => vi.stubEnv("CLIENT_INTAKE_QA_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("expediente parcial del cliente: GET protegido y sin efectos", () => {
  it("mantiene JWT con revocación y permiso de administración", () => {
    expect(Reflect.getMetadata("path", ClientIntakeController)).toBe("api/v1/stations/client-intake");
    expect(Reflect.getMetadata("__guards__", ClientIntakeController)).toEqual([JwtPermissionGuard]);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ClientIntakeController.prototype.read)).toEqual(["setup.manage"]);
    expect(Reflect.getMetadata("__headers__", ClientIntakeController.prototype.read)).toEqual(expect.arrayContaining([
      { name: "Cache-Control", value: "private, no-store" },
      { name: "Vary", value: "Authorization" },
    ]));
  });

  it.each([undefined, "false", "TRUE", "1", "production"])("está cerrado por defecto con flag %s", (value) => {
    vi.stubEnv("CLIENT_INTAKE_QA_ENABLED", value);
    expect(() => read(claims())).toThrow("Preparación del cliente no habilitada en QA");
  });

  it.each(["missing", "role", "scope", "permission"])("no revela información sin %s", (which) => {
    const user = claims();
    if (which === "role") user.roles = ["AUDITOR"];
    if (which === "scope") user.scope = { kind: "ASSIGNED", branchIds: [], emissionPointIds: [], series: [] };
    if (which === "permission") user.permissions = [];
    expect(() => read(which === "missing" ? undefined : user)).toThrow("requiere un administrador general");
  });

  it("sólo devuelve la preparación BETA, nunca autorización fiscal o de corte", () => {
    const result = read(claims());
    const serialized = JSON.stringify(result);
    expect(serialized).toContain('"BETA"');
    for (const flag of ["canEmit", "canImportHistory", "canChangeCounters", "phase2Closed", "phase3Closed"]) {
      expect(serialized).toContain(`"${flag}":false`);
    }
    expect(serialized).not.toContain("PRODUCTION");
  });

  it("no tiene conexiones, repositorios, escrituras o secretos", () => {
    const source = readFileSync(new URL("../services/billing-service/src/client-intake.controller.ts", import.meta.url), "utf8");
    expect(source).toContain("@Get()");
    for (const forbidden of [/Prisma/, /Outbox/, /BullMQ/, /fetch\(/, /readFile/, /@Post/, /@Patch/, /@Delete/, /PRIVATE_KEY/, /PASSWORD/, /\.create\(/, /\.update\(/]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("no cambia seeding, producción ni migradores al habilitar la vista QA", () => {
    const overlay = readFileSync(new URL("../tests/compose.stage2.qa.yml", import.meta.url), "utf8");
    expect(overlay).toContain('CLIENT_INTAKE_QA_ENABLED: "true"');
    expect(overlay).toContain('FACTUEZ_DEMO_SEED: "false"');
    expect(overlay).toContain('SUNAT_BETA_TRANSMISSION_ENABLED: "false"');
    expect(overlay).toContain('SUNAT_BETA_WORKFLOW_ENABLED: "false"');
    const base = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
    expect(base).not.toContain("CLIENT_INTAKE_QA_ENABLED");
  });
});
