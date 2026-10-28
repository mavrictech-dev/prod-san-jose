import type { Catalog, Company, Branch, User } from './types';
import { issuerCatalogSource } from './catalog-model';

export type GreAddress = { branchId: string; ubigeo: string; address: string; establishmentCode: string };
export type GreCatalogContext =
  | { ready: false; message: string }
  | { ready: true; company: Company; branches: Branch[]; originBranchId: string };

export function greCatalogContext(catalog: Catalog | undefined, companyId: string, branchId: string, user: User | undefined): GreCatalogContext {
  if (!user || user.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN') || !user.permissions.includes('sunat.configure') || !user.permissions.includes('document.view')) {
    return { ready: false, message: 'Guías locales requieren administrador general con permisos de configuración y lectura.' };
  }
  if (!catalog) return { ready: false, message: 'Carga el catálogo antes de escoger un emisor de laboratorio.' };
  if (!companyId) return { ready: false, message: 'Selecciona explícitamente un emisor de laboratorio en la cabecera. Usa Fuente del catálogo: Laboratorios QA para ver los RUC ficticios 00….' };
  const company = catalog.companies.find(company => String(company.id) === companyId);
  if (!company) return { ready: false, message: 'El emisor seleccionado ya no está disponible. Recarga el catálogo y selecciona un emisor de laboratorio en la cabecera.' };
  if (issuerCatalogSource(company) !== 'SYNTHETIC' || company.environment !== 'BETA' || !company.legalName.trim()) {
    return { ready: false, message: `El RUC activo ${company.ruc} no es un emisor de laboratorio habilitado. Selecciona Fuente del catálogo: Laboratorios QA y un RUC ficticio 00… en BETA.` };
  }
  const branches = catalog.branches.filter(branch => branch.companyId === company.id);
  if (branchId && !branches.some(branch => branch.id === branchId)) return { ready: false, message: 'La sede activa no pertenece al emisor de laboratorio seleccionado. Selecciona una sede de ese RUC en la cabecera.' };
  return { ready: true, company, branches, originBranchId: branchId };
}

export function greBranchSelectionError(branches: Branch[], companyId: number, origin: GreAddress, destination: GreAddress): string | undefined {
  if (![origin, destination].every(address => branches.some(branch => branch.id === address.branchId && branch.companyId === companyId))) {
    return 'Origen y destino deben ser sedes vigentes del emisor de laboratorio seleccionado. Revisa la selección o recarga el catálogo.';
  }
  if (origin.branchId === destination.branchId) return 'Selecciona dos sedes distintas del mismo emisor de laboratorio.';
}
