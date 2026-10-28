import type { IntegrationGrantV1 } from '@factuez/contracts/integration';
import { fail, plain, uuid } from './model';

/** Validate canonical ownership; never join independently selected IDs across companies. */
export function validateCatalogue(value: unknown, requested: IntegrationGrantV1[]): void {
  if (!plain(value) || !Array.isArray(value.companies) || !Array.isArray(value.branches) || !Array.isArray(value.emissionPoints))
    return fail(503, 'CATALOGUE_UNAVAILABLE');
  const companies = value.companies, branches = value.branches, points = value.emissionPoints;
  if (companies.length > 10000 || branches.length > 10000 || points.length > 10000 ||
      [...companies, ...branches, ...points].some(v => !plain(v))) return fail(503, 'CATALOGUE_UNAVAILABLE');
  if (companies.some(c => !Number.isSafeInteger(c.id)) || [...branches, ...points].some(row => !uuid(row.id)) ||
      [companies, branches, points].some(rows => new Set(rows.map(row => row.id)).size !== rows.length)) return fail(503, 'CATALOGUE_UNAVAILABLE');
  const counters = points.flatMap(p => Array.isArray(p.series) ? p.series : []);
  if (counters.some(s => !plain(s) || !uuid(s.id)) || new Set(counters.map(s => s.id)).size !== counters.length)
    return fail(503, 'CATALOGUE_UNAVAILABLE');
  for (const grant of requested) {
    const owners = companies.filter(c => c.ruc === grant.issuerRuc && c.environment === 'BETA' && c.source === 'BUSINESS');
    if (owners.length !== 1 || !Number.isSafeInteger(owners[0].id)) return fail(400, 'INVALID_GRANTS');
    const companyId = owners[0].id;
    const ownedBranches = branches.filter(b => b.companyId === companyId && b.source === 'BUSINESS' && uuid(b.id));
    const ownedPoints = points.filter(p => p.companyId === companyId && p.source === 'BUSINESS' && uuid(p.id) &&
      ownedBranches.some(b => b.id === p.branchId));
    const seriesType: Record<string, string> = { INVOICE: '01', SALES_RECEIPT: '03', CREDIT_NOTE: '07', DEBIT_NOTE: '08', DESPATCH_ADVICE: '09' };
    if (grant.branches.kind === 'IDS' && grant.branches.ids.some(id => !ownedBranches.some(b => b.id === id))) return fail(400, 'INVALID_GRANTS');
    if (grant.points.kind === 'IDS' && grant.points.ids.some(id => !ownedPoints.some(p => p.id === id &&
        (grant.branches.kind === 'ALL' || grant.branches.ids.includes(p.branchId))))) return fail(400, 'INVALID_GRANTS');
    if (grant.series.kind === 'IDS' && grant.series.ids.some(id => !ownedPoints.some(p =>
        (grant.branches.kind === 'ALL' || grant.branches.ids.includes(p.branchId)) &&
        (grant.points.kind === 'ALL' || grant.points.ids.includes(p.id)) && Array.isArray(p.series) &&
        p.series.some((s: unknown) => plain(s) && s.id === id && grant.documentTypes.includes(seriesType[String(s.documentType)] as never)))))
      return fail(400, 'INVALID_GRANTS');
  }
}
