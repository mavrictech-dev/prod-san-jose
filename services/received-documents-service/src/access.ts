import { AccessError, identity, privateJson, UUID } from '@factuez/service-access';
import type { AccessTokenClaims } from '@factuez/contracts';
export interface ReceptionCatalog { companies: { id: number; ruc: string; legalName: string; environment: string }[]; branches: { id: string; companyId: number }[] }
export interface ReceptionAccess { user: AccessTokenClaims; catalog: ReceptionCatalog }
export async function receptionAccess(authorization: string | undefined, permission = 'report.view'): Promise<ReceptionAccess> {
  const user = await identity(authorization ?? '', permission);
  const catalog = await privateJson<ReceptionCatalog>(process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002', '/api/v1/documents/catalog/issuance', authorization!);
  if (!Array.isArray(catalog.companies) || !Array.isArray(catalog.branches)) throw new AccessError(503, 'Catálogo de empresas no disponible');
  return { user, catalog };
}
export function receptionCompany(access: ReceptionAccess, id: unknown, branchId?: unknown) {
  if (!/^[1-9]\d{0,9}$/.test(String(id))) throw new AccessError(400, 'Seleccione una empresa destinataria');
  const company = access.catalog.companies.find(c => c.id === Number(id) && c.environment === 'BETA');
  if (!company || !/^\d{11}$/.test(company.ruc)) throw new AccessError(403, 'Empresa destinataria no autorizada');
  if (branchId !== undefined && branchId !== null && branchId !== '') {
    if (typeof branchId !== 'string' || !UUID.test(branchId) || !access.catalog.branches.some(b => b.id === branchId && b.companyId === company.id) ||
      access.user.scope.kind === 'ASSIGNED' && !access.user.scope.branchIds.includes(branchId)) throw new AccessError(403, 'Sede no autorizada');
  }
  return company;
}
export function receptionVisible(access: ReceptionAccess, doc: { companyId: number; recipientRuc: string; branchId: string | null }) {
  const company = access.catalog.companies.find(c => c.id === doc.companyId && c.ruc === doc.recipientRuc && c.environment === 'BETA');
  return !!company && (access.user.scope.kind === 'GLOBAL' || !!doc.branchId && access.user.scope.branchIds.includes(doc.branchId) &&
    access.catalog.branches.some(b => b.id === doc.branchId && b.companyId === doc.companyId));
}
