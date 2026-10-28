import type { ClientIntakeReportV1 } from "@factuez/contracts";
import type { IntakeMapRow } from "./client-intake-templates";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key));
const text = (value: unknown, max = 400): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** La vista nunca admite datos de emisión/importación o un gate abierto. */
export function isClientIntakeReport(value: unknown): value is ClientIntakeReportV1 {
  try {
    if (!record(value) || !keys(value, ["schemaVersion", "kind", "environment", "status", "data", "summary", "pending", "canEmit", "canImportHistory", "canChangeCounters", "phase2Closed", "phase3Closed"])) return false;
    if (value.schemaVersion !== "factuez.client-intake-report.v1" || value.kind !== "BUSINESS_CONFIGURATION" || value.environment !== "BETA" || value.status !== "PARTIAL_REVIEW_REQUIRED") return false;
    if ([value.canEmit, value.canImportHistory, value.canChangeCounters, value.phase2Closed, value.phase3Closed].some((flag) => flag !== false)) return false;
    const data = value.data, summary = value.summary;
    if (!record(data) || !keys(data, ["schemaVersion", "kind", "environment", "receivedOn", "sources", "companies", "branches", "nameDiscrepancies", "fiscalEvidence", "authorizations"])) return false;
    if (data.schemaVersion !== "factuez.client-intake.v1" || data.kind !== "BUSINESS_CONFIGURATION" || data.environment !== "BETA" || data.receivedOn !== "2026-10-05") return false;
    if (!record(data.sources) || !keys(data.sources, ["wordResponse", "rucSheets", "pdfSamples", "signedXml", "originalCdr", "offlineDatabaseCopy", "completeHistoryExport"]) || data.sources.wordResponse !== true || data.sources.rucSheets !== 3 || data.sources.pdfSamples !== 7 || data.sources.signedXml !== 0 || data.sources.originalCdr !== 0 || data.sources.offlineDatabaseCopy !== false || data.sources.completeHistoryExport !== false) return false;
    if (!record(data.fiscalEvidence) || !keys(data.fiscalEvidence, ["signatureVerified", "certificateTrusted", "originalCdrValidated"]) || Object.values(data.fiscalEvidence).some((flag) => flag !== false)) return false;
    if (!record(data.authorizations) || !keys(data.authorizations, ["betaDevelopmentDeclared", "officialPilotScope", "offlineHistoryScope", "reconciliationApproved", "cutoverApproved"]) || data.authorizations.betaDevelopmentDeclared !== true || data.authorizations.officialPilotScope !== null || data.authorizations.offlineHistoryScope !== null || data.authorizations.reconciliationApproved !== false || data.authorizations.cutoverApproved !== false) return false;
    if (!Array.isArray(data.companies) || data.companies.length !== 3 || !data.companies.every((company) => record(company) && keys(company, ["ruc", "legalName", "taxAddress", "ubigeo", "verifiedOnline"]) && typeof company.ruc === "string" && /^\d{11}$/.test(company.ruc) && text(company.legalName, 200) && text(company.taxAddress) && company.ubigeo === null && company.verifiedOnline === false)) return false;
    const rucs = data.companies.map((company) => company.ruc as string);
    if (new Set(rucs).size !== 3) return false;
    if (!Array.isArray(data.branches) || data.branches.length !== 21 || !data.branches.every((branch) => record(branch) && keys(branch, ["code", "name", "issuerRuc", "address", "establishmentCode", "emissionPointCode", "series"]) && text(branch.code, 20) && text(branch.name, 120) && typeof branch.issuerRuc === "string" && rucs.includes(branch.issuerRuc) && [branch.address, branch.establishmentCode, branch.emissionPointCode, branch.series].every((field) => field === null))) return false;
    if (new Set(data.branches.map((branch) => branch.code)).size !== 21) return false;
    if (!Array.isArray(data.nameDiscrepancies) || data.nameDiscrepancies.length !== 1 || !data.nameDiscrepancies.every((entry) => record(entry) && keys(entry, ["issuerRuc", "wordLegalName", "sheetLegalName", "status"]) && typeof entry.issuerRuc === "string" && rucs.includes(entry.issuerRuc) && text(entry.wordLegalName, 200) && text(entry.sheetLegalName, 200) && entry.status === "PENDING_ACCOUNTING")) return false;
    if (!record(summary) || !keys(summary, ["companyCount", "branchCount", "pdfSampleCount", "signedXmlCount", "originalCdrCount", "rucBranchCounts"]) || summary.companyCount !== 3 || summary.branchCount !== 21 || summary.pdfSampleCount !== 7 || summary.signedXmlCount !== 0 || summary.originalCdrCount !== 0) return false;
    if (!Array.isArray(summary.rucBranchCounts) || summary.rucBranchCounts.length !== 3 || new Set(summary.rucBranchCounts.map((entry) => record(entry) ? entry.ruc : undefined)).size !== 3 || !summary.rucBranchCounts.every((entry) => record(entry) && keys(entry, ["ruc", "count"]) && typeof entry.ruc === "string" && rucs.includes(entry.ruc) && entry.count === (data.branches as Record<string, unknown>[]).filter((branch) => branch.issuerRuc === entry.ruc).length)) return false;
    if (!Array.isArray(value.pending) || value.pending.length !== 14 || !value.pending.every((entry) => record(entry) && keys(entry, ["id", "phase", "owner", "description"]) && text(entry.id, 50) && [2, 3].includes(entry.phase as number) && ["TI", "ADMINISTRACION_CONTABILIDAD", "EMISOR", "MAVRIC"].includes(entry.owner as string) && text(entry.description, 500))) return false;
    if (new Set(value.pending.map((entry) => entry.id)).size !== value.pending.length) return false;
    return true;
  } catch { return false; }
}

const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-PE");
export function clientIntakeRows(report: ClientIntakeReportV1, ruc = "all", query = ""): IntakeMapRow[] {
  if (!isClientIntakeReport(report)) throw new Error("Entrega parcial inválida");
  const search = normalize(query.trim());
  return report.data.branches
    .filter((branch) => (ruc === "all" || branch.issuerRuc === ruc) && (!search || normalize(`${branch.code} ${branch.name} ${branch.issuerRuc}`).includes(search)))
    .map((branch) => {
      const company = report.data.companies.find((entry) => entry.ruc === branch.issuerRuc)!;
      return { issuerRuc: company.ruc, legalName: company.legalName, taxAddress: company.taxAddress, branchCode: branch.code, branchName: branch.name };
    });
}
