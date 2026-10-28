import type { Prisma, ReceptionConnection } from '../generated/prisma/client';
import type { ReceptionPrisma } from '../prisma.service';
import type { ReceptionAccess } from '../access';
import { AccessError } from '@factuez/service-access';
export function automationCompany(access: ReceptionAccess, id: unknown, branchId?: unknown) {
  const company = access.catalog.companies.find(c => String(c.id) === String(id) && ['BETA', 'PRODUCTION'].includes(c.environment));
  if (!company || !/^\d{11}$/.test(company.ruc)) throw new AccessError(403, 'Empresa destinataria no autorizada');
  if (branchId && (!access.catalog.branches.some(b => b.id === branchId && b.companyId === company.id) || access.user.scope.kind === 'ASSIGNED' && !access.user.scope.branchIds.includes(String(branchId)))) throw new AccessError(403, 'Sede no autorizada');
  return company;
}
export async function hasActivation(db: Pick<ReceptionPrisma, 'receptionConnectionAudit'> | Prisma.TransactionClient, c: ReceptionConnection) {
  if (c.mode !== 'LIVE_READ_ONLY') return true;
  const proof = await db.receptionConnectionAudit.findFirst({ where: { companyId: c.companyId, revision: c.revision, action: 'PRODUCTION_ACTIVATED', detail: { path: ['recipientRuc'], equals: c.recipientRuc } }, orderBy: { createdAt: 'desc' } });
  return !!proof;
}
