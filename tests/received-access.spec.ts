import { describe, expect, it } from 'vitest';
import { receptionCompany, receptionVisible, type ReceptionAccess } from '../services/received-documents-service/src/access';
import { receptionFilters, decodeUpload, safeArtifactName } from '../services/received-documents-service/src/validation';
const branch = '10000000-0000-4000-8000-000000000001';
const access = { user: { scope: { kind: 'GLOBAL' } }, catalog: { companies: [{ id: 1, ruc: '00000000101', environment: 'BETA' }, { id: 2, ruc: '00000000202', environment: 'PRODUCTION' }], branches: [{ id: branch, companyId: 1 }] } } as ReceptionAccess;
describe('Received authorization and input bounds', () => {
  it('requires an authorized Beta company, not an arbitrary RUC', () => {
    expect(receptionCompany(access, 1, branch).ruc).toBe('00000000101');
    for (const id of [2, '00000000101', 0, -1, 999, '1e0']) expect(() => receptionCompany(access, id)).toThrow();
  });
  it('blocks invisible recipient and unassigned/null branches', () => {
    const doc = { companyId: 1, recipientRuc: '00000000101', branchId: branch };
    expect(receptionVisible(access, doc)).toBe(true);
    expect(receptionVisible(access, { ...doc, recipientRuc: '00000000202' })).toBe(false);
    const assigned = { ...access, user: { ...access.user, scope: { kind: 'ASSIGNED', branchIds: [branch], emissionPointIds: [], series: [] } } } as ReceptionAccess;
    expect(receptionVisible(assigned, doc)).toBe(true);
    expect(receptionVisible(assigned, { ...doc, branchId: null })).toBe(false);
    expect(() => receptionCompany(assigned, 1, '20000000-0000-4000-8000-000000000001')).toThrow();
  });
  it.each([{ q: ['x'] }, { from: '2026-02-30' }, { from: '2026-02-01', to: '2026-01-01' }, { type: '01,03' }, { page: '1e2' }, { dataSource: 'secret' }])('rejects invalid filters %#', q => expect(() => receptionFilters(q)).toThrow());
  it('keeps business and synthetic catalogs explicit', () => {
    expect(receptionFilters({}).dataSource).toBe('BUSINESS'); expect(receptionFilters({ dataSource: 'SYNTHETIC' }).dataSource).toBe('SYNTHETIC');
  });
  it.each(['..\\file.xml', 'a/b.xml', 'a\r\n.xml', 'bad%name.xml', '  file.xml', 'x'.repeat(151)])('rejects dangerous artifact name %s', name => expect(() => safeArtifactName(name)).toThrow());
  it.each(['', '!!!!', 'Zg=', 'Zh==', 'Zm9v\n'])('rejects noncanonical base64 %j', v => expect(() => decodeUpload(v)).toThrow());
  it('keeps uploaded bytes unchanged', () => expect(decodeUpload('Zm9v').toString()).toBe('foo'));
  it('accepts maximum-size base64 without regular expression stack overflow', () => {
    const source = Buffer.alloc(4 * 1024 * 1024, 42); expect(decodeUpload(source.toString('base64')).equals(source)).toBe(true);
    expect(() => decodeUpload(Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64'))).toThrow();
  });
});
