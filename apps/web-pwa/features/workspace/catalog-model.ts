import type { Branch, Catalog, Company, Point, User } from './types';

export type CatalogSource = 'BUSINESS' | 'SYNTHETIC';
export type CatalogView = CatalogSource | 'ALL';
export type WorkspaceCatalog = Omit<Catalog, 'companies' | 'branches' | 'emissionPoints'> & {
  companies: (Company & { source: CatalogSource })[];
  branches: (Branch & { source: CatalogSource })[];
  emissionPoints: (Point & { source: CatalogSource })[];
};
export type CatalogSelection = { source: CatalogView; companyId: string; branchId: string };
export type CatalogSelectionChange =
  | { kind: 'source'; value: CatalogView }
  | { kind: 'company' | 'branch'; value: string };

export const INITIAL_CATALOG_SELECTION: CatalogSelection = { source: 'BUSINESS', companyId: '', branchId: '' };
export const CATALOG_VIEW_LABELS: Record<CatalogView, string> = {
  BUSINESS: 'Negocio', SYNTHETIC: 'Laboratorios QA', ALL: 'Todo el catálogo',
};

// BUSINESS indica que no cumple la identidad sintética RUC00, no una validación fiscal.
export function issuerCatalogSource(company: Pick<Company, 'ruc'>): CatalogSource {
  return /^00\d{9}$/.test(company.ruc) ? 'SYNTHETIC' : 'BUSINESS';
}

/** Vista de presentación. La autorización sigue estando en el servidor. */
export function catalogForView(catalog: Catalog, scope: User['scope'], view: CatalogView): WorkspaceCatalog {
  const sourcedCompanies = catalog.companies.map(company => ({ ...company, source: issuerCatalogSource(company) }));
  const companiesById = new Map(sourcedCompanies.map(company => [company.id, company]));
  const branches = catalog.branches.flatMap(branch => {
    const company = companiesById.get(branch.companyId);
    if (!company || view !== 'ALL' && company.source !== view || scope.kind === 'ASSIGNED' && !scope.branchIds.includes(branch.id)) return [];
    return [{ ...branch, source: company.source }];
  });
  const branchesById = new Map(branches.map(branch => [branch.id, branch]));
  const assignedCompanies = new Set(branches.map(branch => branch.companyId));
  const companies = sourcedCompanies.filter(company =>
    (view === 'ALL' || company.source === view) && (scope.kind === 'GLOBAL' || assignedCompanies.has(company.id)),
  );
  const emissionPoints = catalog.emissionPoints.flatMap(point => {
    const branch = branchesById.get(point.branchId);
    if (!branch || branch.companyId !== point.companyId || scope.kind === 'ASSIGNED' && !scope.emissionPointIds.includes(point.id)) return [];
    return [{ ...point, source: branch.source, series: point.series.filter(counter => scope.kind === 'GLOBAL' || scope.series.includes(counter.id)) }];
  });
  return { ...catalog, companies, branches, emissionPoints };
}

/** Emisor y sede se reconcilian juntos; nunca se elige el primer registro. */
export function reconcileCatalogSelection(catalog: Catalog, selection: CatalogSelection): CatalogSelection {
  const company = catalog.companies.find(company => String(company.id) === selection.companyId);
  if (selection.companyId && !company) return { ...selection, companyId: '', branchId: '' };
  const branch = catalog.branches.find(branch => branch.id === selection.branchId);
  if (!branch || company && branch.companyId !== company.id) return { ...selection, branchId: '' };
  return { ...selection, companyId: String(branch.companyId), branchId: branch.id };
}

/** Única asignación autorizada, no primer elemento de un catálogo global. */
export function assignedCatalogSelection(catalog: Catalog, scope: User['scope'], selection: CatalogSelection): CatalogSelection {
  const safe = reconcileCatalogSelection(catalog, selection);
  if (scope.kind !== 'ASSIGNED') return safe;
  const branches = catalog.branches.filter(branch => scope.branchIds.includes(branch.id));
  if (branches.length === 1) return { ...safe, companyId: String(branches[0].companyId), branchId: branches[0].id };
  return catalog.companies.length === 1 && !safe.companyId ? { ...safe, companyId: String(catalog.companies[0].id) } : safe;
}

export function changeCatalogSelection(catalog: Catalog, scope: User['scope'], current: CatalogSelection, change: CatalogSelectionChange): CatalogSelection {
  const selection = change.kind === 'source' ? { ...current, source: change.value } : current;
  const visible = catalogForView(catalog, scope, selection.source);
  const safe = reconcileCatalogSelection(visible, selection);
  if (change.kind === 'source') return safe;
  if (change.kind === 'company') {
    return reconcileCatalogSelection(visible, {
      ...safe, companyId: change.value, branchId: change.value === safe.companyId ? safe.branchId : '',
    });
  }
  const branch = visible.branches.find(branch => branch.id === change.value);
  if (!branch || safe.companyId && String(branch.companyId) !== safe.companyId) return { ...safe, branchId: '' };
  return { ...safe, companyId: String(branch.companyId), branchId: branch.id };
}
