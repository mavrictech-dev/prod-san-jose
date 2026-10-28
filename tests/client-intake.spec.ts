import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildClientIntakeReport, clientIntakeRucChecksum, SAN_JOSE_CLIENT_INTAKE_V1 } from "../packages/contracts/src/client-intake";

const copy = () => structuredClone(SAN_JOSE_CLIENT_INTAKE_V1);
describe("entrega cliente v1: parcial, versionada y no fiscal", () => {
  it("incluye 3 RUC, 21 sedes y distribución del anexo 17 + 1 + 3", () => {
    const report = buildClientIntakeReport();
    expect(report.summary).toMatchObject({ companyCount: 3, branchCount: 21, pdfSampleCount: 7, signedXmlCount: 0, originalCdrCount: 0 });
    expect(report.summary.rucBranchCounts).toEqual([{ ruc: "20175642341", count: 17 }, { ruc: "20614605864", count: 1 }, { ruc: "20600979630", count: 3 }]);
    expect(report.data.branches.find((branch) => branch.code === "PCL")?.issuerRuc).toBe("20614605864");
    expect(report.data.branches.filter((branch) => branch.issuerRuc === "20600979630").map((branch) => branch.code)).toEqual(["CHC", "LV1", "SJ2"]);
    expect(report.data.companies.some((company) => company.ruc === "20450819230")).toBe(false);
  });
  it("es explícitamente distinto de un dataset SYNTHETIC o un comprobante", () => {
    const report = buildClientIntakeReport();
    expect(report.kind).toBe("BUSINESS_CONFIGURATION");
    expect(report.environment).toBe("BETA");
    expect(report.status).toBe("PARTIAL_REVIEW_REQUIRED");
    for (const flag of [report.canEmit, report.canImportHistory, report.canChangeCounters, report.phase2Closed, report.phase3Closed]) expect(flag).toBe(false);
    expect(JSON.stringify(report.data)).not.toMatch(/SYNTHETIC|customer|documentItems|password|token|certificateBytes|xmlContent|base64|https?:\/\//i);
  });
  it("conserva los campos desconocidos y la discrepancia sin inventar una asignación", () => {
    const report = buildClientIntakeReport();
    for (const company of report.data.companies) { expect(company.ubigeo).toBeNull(); expect(company.verifiedOnline).toBe(false); }
    for (const branch of report.data.branches) {
      for (const field of [branch.address, branch.establishmentCode, branch.emissionPointCode, branch.series]) expect(field).toBeNull();
    }
    expect(report.data.nameDiscrepancies[0]).toEqual({ issuerRuc: "20175642341", wordLegalName: "ESTACIONES SAN JOSE S.A.C.", sheetLegalName: "ESTACION DE SERVICIOS SAN JOSE S.A.C.", status: "PENDING_ACCOUNTING" });
    expect(report.data.authorizations).toMatchObject({ betaDevelopmentDeclared: true, officialPilotScope: null, offlineHistoryScope: null, reconciliationApproved: false, cutoverApproved: false });
  });
  it("informa pendientes del cliente y técnicos por fase, sin atribuir cierre", () => {
    const report = buildClientIntakeReport();
    expect(report.pending).toHaveLength(14);
    expect(report.pending.filter((item) => item.phase === 2)).toHaveLength(7);
    expect(report.pending.filter((item) => item.phase === 3)).toHaveLength(7);
    expect(report.pending.find((item) => item.id === "official-circuit")?.owner).toBe("MAVRIC");
    expect(report.pending.find((item) => item.id === "offline-copy")?.owner).toBe("TI");
    expect(report.pending.find((item) => item.id === "cutover")?.owner).toBe("ADMINISTRACION_CONTABILIDAD");
  });
  it("valida dígito de control sin convertirlo en verificación SUNAT", () => {
    for (const company of SAN_JOSE_CLIENT_INTAKE_V1.companies) expect(clientIntakeRucChecksum(company.ruc)).toBe(true);
    for (const ruc of ["20175642340", "20614605865", "20600979631", "", "99999999999", "2017564234", " 20175642341"]) expect(clientIntakeRucChecksum(ruc)).toBe(false);
  });
  it.each(["schemaVersion", "kind", "environment", "receivedOn"])("rechaza cambio de %s", (field) => {
    const input: any = copy(); input[field] = "PRODUCTION";
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["ubigeo", "legalName", "ruc", "verifiedOnline", "taxAddress"])("no acepta dato empresarial no revisado %s", (field) => {
    const input: any = copy(); input.companies[0][field] = field === "verifiedOnline" ? true : "INVENTADO";
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["address", "establishmentCode", "emissionPointCode", "series", "issuerRuc", "code", "name"])("rechaza asignación desconocida %s", (field) => {
    const input: any = copy(); input.branches[0][field] = "F001";
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["signatureVerified", "certificateTrusted", "originalCdrValidated"])("no acredita evidencia fiscal %s", (field) => {
    const input: any = copy(); input.fiscalEvidence[field] = true;
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["officialPilotScope", "offlineHistoryScope", "reconciliationApproved", "cutoverApproved"])("no transforma la declaración en autorización %s", (field) => {
    const input: any = copy(); input.authorizations[field] = true;
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["signedXml", "originalCdr", "offlineDatabaseCopy", "completeHistoryExport"])("no inventa un archivo o copia recibidos %s", (field) => {
    const input: any = copy(); input.sources[field] = 1;
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it.each(["canEmit", "password", "certificate", "xml", "history"])("rechaza claves fuera del contrato %s", (field) => {
    const input: any = copy(); input[field] = "NO_LEER";
    expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
  });
  it("rechaza repetidos, faltantes y RUC contradictorio", () => {
    for (const mutate of [(input: any) => input.branches.push(input.branches[0]), (input: any) => input.companies.pop(), (input: any) => { input.branches[0].issuerRuc = "20614605864"; }]) {
      const input = copy(); mutate(input); expect(() => buildClientIntakeReport(input)).toThrow("Expediente parcial inválido");
    }
  });
  it("rechaza getters, ciclos, arrays dispersos, atributos extra y contaminación", () => {
    const getter = vi.fn(() => "NO_LEER");
    const withGetter: any = copy(); Object.defineProperty(withGetter, "environment", { get: getter, enumerable: true });
    expect(() => buildClientIntakeReport(withGetter)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const cycle: any = copy(); cycle.loop = cycle; expect(() => buildClientIntakeReport(cycle)).toThrow();
    const sparse: any = copy(); delete sparse.branches[0]; expect(() => buildClientIntakeReport(sparse)).toThrow();
    const extra: any = copy(); extra.branches.password = "NO_LEER"; expect(() => buildClientIntakeReport(extra)).toThrow();
    const prototype: any = copy(); Object.setPrototypeOf(prototype, { canEmit: true }); expect(() => buildClientIntakeReport(prototype)).toThrow();
    const protoJson = JSON.parse(JSON.stringify(copy()).replace('"environment":"BETA"', '"__proto__":{"canEmit":true},"environment":"BETA"')); expect(() => buildClientIntakeReport(protoJson)).toThrow();
  });
  it("no muta el input; devuelve un informe congelado, reproducible y serializable", () => {
    const input = copy(), before = JSON.stringify(input), first = buildClientIntakeReport(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(first.data).not.toBe(input);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.data.branches[0])).toBe(true);
    expect(Object.isFrozen(SAN_JOSE_CLIENT_INTAKE_V1.companies[0])).toBe(true);
    expect(first).toEqual(buildClientIntakeReport(JSON.parse(before)));
  });
  it("el paquete es puro: no infraestructura, fuentes privadas ni I/O", () => {
    const source = readFileSync(new URL("../packages/contracts/src/client-intake.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import |node:|process\.env|fetch\(|Prisma|Outbox|createWrite|readFile|p12|pfx|SELECT |INSERT /);
  });
});
