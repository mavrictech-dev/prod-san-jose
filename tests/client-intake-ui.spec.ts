import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClientIntakeReport } from "../packages/contracts/src/client-intake";
import { clientIntakeRows, isClientIntakeReport } from "../apps/web-pwa/features/workspace/client-intake-model";
import { intakeMapCsv } from "../apps/web-pwa/features/workspace/client-intake-templates";

const access = vi.hoisted(() => ({ allowed: true, scope: "GLOBAL", roles: ["ADMIN"], api: vi.fn() }));
vi.mock("../apps/web-pwa/features/workspace/provider", () => ({ useWorkspace: () => ({
  user: { sub: "00000000-0000-4000-8000-000000000951", scope: { kind: access.scope }, roles: access.roles, permissions: access.allowed ? ['setup.manage', 'series.manage'] : [] },
  can: () => access.allowed, api: access.api, setDirty: vi.fn(), reloadCatalog: vi.fn(),
  branchId: "", companyId: "", catalog: { companies: [], branches: [], emissionPoints: [], products: [] },
}) }));
import { ClientIntakePanel, ClientIntakeWorkspace } from "../apps/web-pwa/features/workspace/client-intake";
import StationsPage from "../apps/web-pwa/app/(workspace)/stations/page";

const webRequire = createRequire(new URL("../apps/web-pwa/package.json", import.meta.url));
const React = webRequire("react"), { renderToStaticMarkup } = webRequire("react-dom/server");
const render = (component: unknown, props = {}) => renderToStaticMarkup(React.createElement(component, props));
const copy = () => structuredClone(buildClientIntakeReport());
beforeEach(() => { vi.stubGlobal("React", React); access.allowed = true; access.scope = "GLOBAL"; access.roles = ["ADMIN"]; access.api.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

describe("preparación cliente shadcn: vista, filtros y guard de acceso", () => {
  it("muestra el mapa y pendientes reales sin botones de ejecución", () => {
    const html = render(ClientIntakePanel, { report: buildClientIntakeReport() });
    for (const text of ["Preparación de fases 2 y 3", "BETA · Solo lectura", "Producción, importación y corte bloqueados", "20175642341", "20614605864", "20600979630", "21", "Pucallpa", "San José II", "Razón social por confirmar", "0 / 0", "Mavric Technologies", "Descargar mapa CSV", "Alcance por autorizar", "Informe de entrega", "sin verificación en línea"]) expect(html).toContain(text);
    expect(html).not.toMatch(/Enviar a SUNAT|Importar historial|Aplicar series|Emitir factura|Max Garcia|20450819230/);
    expect(html).toContain('data-slot="card"'); expect(html).toContain('data-slot="table"');
  });
  it.each(["permission", "scope", "role"])("no revela el expediente ni el tab sin %s", (which) => {
    if (which === "permission") access.allowed = false;
    if (which === "scope") access.scope = "ASSIGNED";
    if (which === "role") access.roles = ["AUDITOR"];
    const html = render(ClientIntakeWorkspace);
    expect(html).toContain("requiere un administrador general");
    expect(html).not.toContain("20175642341");
    expect(render(StationsPage)).not.toContain("Entrega del cliente");
    expect(access.api).not.toHaveBeenCalled();
  });
  it("la pestaña interna se retiró de la vista operativa también para el administrador", () => {
    expect(render(StationsPage)).not.toContain("Entrega del cliente");
    const html = render(ClientIntakeWorkspace);
    expect(html).toContain("Cargando información");
    expect(html).not.toContain("20175642341");
    expect(access.api).not.toHaveBeenCalled();
  });
  it("escapa cadenas; no renderiza HTML activo", () => {
    const report: any = copy(); report.data.companies[0].legalName = '<script>NO_EXEC</script>';
    expect(isClientIntakeReport(report)).toBe(true);
    const html = render(ClientIntakePanel, { report });
    expect(html).toContain("&lt;script&gt;NO_EXEC&lt;/script&gt;");
    expect(html).not.toContain("<script>NO_EXEC");
  });
  it.each(["environment", "kind", "schemaVersion", "canEmit", "canImportHistory", "canChangeCounters", "phase2Closed", "phase3Closed"])("oculta datos y descargas si se cambia %s", (field) => {
    const report: any = copy(); report[field] = field.startsWith("can") || field.endsWith("Closed") ? true : "PRODUCTION";
    report.data.companies[0].legalName = "NO_REVELAR";
    expect(isClientIntakeReport(report)).toBe(false);
    const html = render(ClientIntakePanel, { report });
    expect(html).toContain('role="alert"'); expect(html).not.toContain("NO_REVELAR"); expect(html).not.toContain("Descargar mapa");
  });
  it.each([
    (r: any) => { r.data.sources.signedXml = 1; },
    (r: any) => { r.data.authorizations.officialPilotScope = { approved: true }; },
    (r: any) => { r.data.fiscalEvidence.certificateTrusted = true; },
    (r: any) => { r.data.companies[0].ubigeo = "200101"; },
    (r: any) => { r.data.branches[0].series = ["F179"]; },
    (r: any) => { r.data.branches[0].issuerRuc = "99999999999"; },
    (r: any) => { r.data.branches[1].code = r.data.branches[0].code; },
    (r: any) => { r.summary.rucBranchCounts[0].count = 99; },
    (r: any) => { r.pending[1].id = r.pending[0].id; },
    (r: any) => { r.secret = "NO_LEER"; },
    (r: any) => { r.data.companies[0].customer = "NO_LEER"; },
  ])("rechaza respuesta parcial contradictoria %s", (mutate) => {
    const report = copy(); mutate(report); expect(isClientIntakeReport(report)).toBe(false);
    expect(() => clientIntakeRows(report)).toThrow("Entrega parcial inválida");
  });
  it.each([undefined, null, {}, [], { data: {} }])("rechaza payload incompleto %s", (report) => expect(isClientIntakeReport(report)).toBe(false));
  it("filtra por empresa y busca sin distinguir tildes; no altera el mapa", () => {
    const report = buildClientIntakeReport(), before = JSON.stringify(report);
    expect(clientIntakeRows(report, "20600979630").map((row) => row.branchCode)).toEqual(["CHC", "LV1", "SJ2"]);
    expect(clientIntakeRows(report, "all", "narihuala").map((row) => row.branchCode)).toEqual(["NRH"]);
    expect(clientIntakeRows(report, "all", "organos").map((row) => row.branchCode)).toEqual(["ORG"]);
    expect(clientIntakeRows(report, "all", "no existe")).toEqual([]);
    expect(clientIntakeRows(report, "no existe")).toEqual([]);
    expect(clientIntakeRows(report)).toHaveLength(21);
    expect(JSON.stringify(report)).toBe(before);
  });
  it("el CSV tiene 21 sedes y no inventa puntos, ubigeos o series", () => {
    const csv = intakeMapCsv(clientIntakeRows(buildClientIntakeReport()));
    expect(csv.trim().split("\r\n")).toHaveLength(22);
    expect(csv).toContain('"PCL","Pucallpa"');
    expect(csv).not.toMatch(/F179|B032|T204|RestoApp|RESTOAPP|F001|B001/);
  });
  it("no mete el expediente empresarial ni los PDF reales en el bundle cliente", () => {
    const source = readFileSync(new URL("../apps/web-pwa/features/workspace/client-intake.tsx", import.meta.url), "utf8");
    expect(source).toContain('import type { ClientIntakePending, ClientIntakeReportV1 }');
    expect(source).not.toMatch(/SAN_JOSE_CLIENT_INTAKE_V1|buildClientIntakeReport|20175642341|Downloads|localStorage|indexedDB|method:\s*["']POST/);
    expect(source).toContain('api<unknown>("/api/v1/stations/client-intake"');
    expect(source).toContain("controller.abort()");
    expect(source).toContain("state.actorId !== actorId");
    const index = readFileSync(new URL("../packages/contracts/dist/index.js", import.meta.url), "utf8");
    expect(index).not.toContain('require("./client-intake")');
  });
});
