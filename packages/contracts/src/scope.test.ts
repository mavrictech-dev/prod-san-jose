import { describe, expect, it } from "vitest";
import {
  allowsResource,
  canDelegate,
  DefaultRolePermissions,
  RoleCodes,
  validScope,
  type AccessScope,
  type AccessTokenClaims,
} from "./authorization";
const assigned: AccessScope = {
  kind: "ASSIGNED",
  branchIds: ["branch-a"],
  emissionPointIds: ["point-a"],
  series: ["F001", "B001"],
};
const manager: AccessTokenClaims = {
  sub: "manager",
  username: "manager",
  roles: [RoleCodes.STATION_MANAGER],
  permissions: [...DefaultRolePermissions.STATION_MANAGER],
  scope: assigned,
  authVersion: 1,
  iss: "test",
  aud: "test",
  iat: 0,
  exp: 1,
};
describe("Alcances y delegación multi-sede", () => {
  it("solo acepta UUIDs de series en tokens asignados, no etiquetas ambiguas entre RUC", () => {
    expect(validScope(assigned, ["CASHIER"])).toBe(false);
    expect(
      validScope(
        { ...assigned, series: ["40000000-0000-4000-8000-000000000001"] },
        ["CASHIER"],
      ),
    ).toBe(true);
    expect(validScope({ ...assigned, series: [] }, ["CASHIER"])).toBe(true);
  });
  it("rechaza tokens sin scope, scope incompleto y alcance global sin ADMIN", () => {
    expect(validScope(undefined, ["ADMIN"])).toBe(false);
    expect(
      validScope({ kind: "ASSIGNED", branchIds: ["a"] }, ["CASHIER"]),
    ).toBe(false);
    expect(validScope({ kind: "GLOBAL" }, ["STATION_MANAGER"])).toBe(false);
    expect(validScope({ kind: "GLOBAL" }, ["ADMIN"])).toBe(true);
  });
  it("un alcance vacío nunca equivale a acceso global", () => {
    expect(
      allowsResource(
        { kind: "ASSIGNED", branchIds: [], emissionPointIds: [], series: [] },
        "branch-a",
        "point-a",
        "F001",
      ),
    ).toBe(false);
    expect(allowsResource(undefined, "branch-a")).toBe(false);
  });
  it("exige la intersección sede, punto y serie", () => {
    expect(allowsResource(assigned, "branch-a", "point-a", "F001")).toBe(true);
    expect(allowsResource(assigned, "branch-b", "point-a", "F001")).toBe(false);
    expect(allowsResource(assigned, "branch-a", "point-b", "F001")).toBe(false);
    expect(allowsResource(assigned, "branch-a", "point-a", "F002")).toBe(false);
  });
  it("permite delegar cajeros dentro del alcance del administrador local", () => {
    expect(canDelegate(manager, ["CASHIER"], assigned)).toBe(true);
  });
  it("impide otorgar ADMIN, otro administrador local o un alcance mayor", () => {
    expect(canDelegate(manager, ["ADMIN"], { kind: "GLOBAL" })).toBe(false);
    expect(canDelegate(manager, ["STATION_MANAGER"], assigned)).toBe(false);
    expect(
      canDelegate(manager, ["CASHIER"], {
        ...assigned,
        branchIds: ["branch-b"],
      }),
    ).toBe(false);
    expect(
      canDelegate(manager, ["CASHIER"], {
        ...assigned,
        emissionPointIds: ["point-b"],
      }),
    ).toBe(false);
    expect(
      canDelegate(manager, ["CASHIER"], { ...assigned, series: ["B999"] }),
    ).toBe(false);
  });
  it("no delega permisos que el actor no posee", () => {
    expect(
      canDelegate({ ...manager, permissions: [] }, ["CASHIER"], assigned),
    ).toBe(false);
    expect(canDelegate(manager, ["AUDITOR"], assigned)).toBe(false);
  });
  it("solo el administrador global administra todos los recursos", () => {
    expect(
      canDelegate(
        { ...manager, roles: ["ADMIN"], scope: { kind: "GLOBAL" } },
        ["STATION_MANAGER"],
        assigned,
      ),
    ).toBe(true);
    expect(allowsResource({ kind: "GLOBAL" }, "any", "any", "F999")).toBe(true);
  });
});
