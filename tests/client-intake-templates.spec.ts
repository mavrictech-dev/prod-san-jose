import { describe, expect, it } from "vitest";
import { intakeMapCsv, intakeScopeTemplate } from "../apps/web-pwa/features/workspace/client-intake-templates";

const row = { issuerRuc: "20175642341", legalName: "SEGÚN FICHA", branchCode: "SJ1", branchName: "San José I", taxAddress: "DIRECCIÓN DECLARADA" };
describe("plantillas de coordinación, no órdenes fiscales o de migración", () => {
  it("preserva los datos entregados y deja campos desconocidos vacíos", () => {
    const csv = intakeMapCsv([row]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain('"20175642341","SEGÚN FICHA","SJ1","San José I","DIRECCIÓN DECLARADA","","","","","","","",""');
    expect(csv).not.toMatch(/F001|B001|F179|B032|20450819230|correlativo/i);
    expect(csv).toContain("Confirmado por Contabilidad");
  });
  it.each(["=1+1", "+SUM(A1)", "-cmd", "@calc", " \t=1", "\ufeff+1"])("neutraliza fórmula %s", (payload) => {
    expect(intakeMapCsv([{ ...row, branchName: payload }])).toContain(`"'${payload}"`);
  });
  it("escapa comillas, comas y saltos de línea en celdas", () => {
    const csv = intakeMapCsv([{ ...row, branchName: 'Sede "A", sur\r\nB' }]);
    expect(csv).toContain('"Sede ""A"", sur\r\nB"');
  });
  it("no muta ni inventa autorizaciones, rutas, periodos o series", () => {
    const rucs = Object.freeze([row.issuerRuc, row.issuerRuc, "20614605864"]);
    const draft = intakeScopeTemplate(rucs);
    expect(draft.issuers).toHaveLength(2);
    expect(draft.environment).toBe("BETA");
    expect(draft.status).toBe("PENDING_APPROVAL");
    for (const value of [draft.productionAllowed, draft.officialTransmissionAuthorized, draft.realCertificateSigningAuthorized, draft.historyImportAuthorized, draft.counterChangeAuthorized, draft.cutoverApproved]) expect(value).toBe(false);
    for (const issuer of draft.issuers) {
      expect(issuer.pilot.documentTypes).toEqual([]);
      expect(issuer.pilot.testSeries).toBeNull();
      expect(issuer.history.sourceSystem).toBeNull();
      expect(issuer.history.authorizedByTi).toBeNull();
      expect(issuer.history.periodFrom).toBeNull();
      expect(issuer.history.isolatedDestination).toBeNull();
    }
    expect(rucs).toHaveLength(3);
  });
});
