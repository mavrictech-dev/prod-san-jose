import { describe, expect, it, vi } from 'vitest';
import { ReceptionService } from '../services/received-documents-service/src/reception.service';
import type { ReceptionAccess } from '../services/received-documents-service/src/access';
import type { ReceptionPrisma } from '../services/received-documents-service/src/prisma.service';
const access = { user: { scope: { kind: 'GLOBAL' } }, catalog: { companies: [{ id: 1, ruc: '00000000101', environment: 'BETA' }], branches: [] } } as ReceptionAccess;
function service() {
  const findMany = vi.fn(async () => []), count = vi.fn(async () => 0);
  const db = { receivedDocument: { findMany, count }, $transaction: (operations: Promise<unknown>[]) => Promise.all(operations) };
  return { service: new ReceptionService(db as unknown as ReceptionPrisma), findMany, count };
}
describe('Reception query repository fail closed', () => {
  it.each([access, { ...access, catalog: { companies: [], branches: [] } }])('uses impossible ID set for empty business/authorized company selection', async context => {
    const test = service(); await test.service.list(context, {});
    expect(test.findMany.mock.calls[0][0].where.AND[0]).toEqual({ id: { in: [] } });
  });
  it('uses company and recipient together, with explicit synthetic selection', async () => {
    const test = service(); await test.service.list(access, { dataSource: 'SYNTHETIC', companyId: '1' });
    expect(test.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ companyId: 1, recipientRuc: '00000000101' }] });
  });
  it('requires a company before a branch filter', async () => {
    const test = service(); await expect(test.service.list(access, { branchId: 'bad' })).rejects.toThrow(); expect(test.findMany).not.toHaveBeenCalled();
  });
});
