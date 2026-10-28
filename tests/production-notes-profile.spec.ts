import 'reflect-metadata';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { FiscalDocumentSnapshot, ProductionNotesAcceptance, ProductionNotesSnapshot } from '../packages/contracts/src';
import { calculateDocumentTotals, buildProductionNotesSnapshot, assertProductionNotesSnapshot, buildProductionNotesUbl, productionNotesAdjustment, PRODUCTION_NOTES_RULES, fiscalSnapshotSha256, signProductionNotesOwner, assertProductionNotesOwner } from '../packages/sunat-core/src';
import { prepareProductionNotesXml } from '../services/sunat-service/src/application/production-notes-crypto';
import { verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { validateProductionPackage } from '../services/sunat-service/src/infrastructure/sunat/production-package-validator';
import { ProductionNotesOwnerService } from '../services/billing-service/src/application/production-notes-owner.service';
import { createGuideSidecarPki, guideSidecarHash as hash } from './helpers/guide-sidecar-ephemeral-pki.fixture';
const NOW = new Date(), RUC = '20100070970', branchId = '10000000-0000-4000-8000-000000000001', pointId = '10000000-0000-4000-8000-000000000002';
const actorId = '10000000-0000-4000-8000-000000000003', seriesId = '10000000-0000-4000-8000-000000000004', debitSeriesId = '10000000-0000-4000-8000-000000000005';
let pki: ReturnType<typeof createGuideSidecarPki>, directory: string, ownerKey: Buffer;
beforeAll(() => { pki = createGuideSidecarPki(); }, 30000);
afterAll(() => { for (const s of [pki.issuer, pki.otherIssuer, pki.sunat])
    s.pkcs12.fill(0); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'factuez-production-notes-')); ownerKey = randomBytes(32); await writeFile(join(directory, 'owner.key'), ownerKey.toString('hex'),{mode:0o600}); vi.stubEnv('PRODUCTION_NOTES_OWNER_KEY_FILE', join(directory, 'owner.key')); vi.stubEnv('BILLING_PRODUCTION_NOTES_ENABLED', 'true'); vi.stubGlobal('fetch', vi.fn(async () => { throw Error('NETWORK_FORBIDDEN'); })); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); ownerKey.fill(0); if (!resolve(directory).startsWith(join(resolve(tmpdir()), 'factuez-production-notes-')))
    throw Error('UNSAFE_CLEANUP'); await rm(directory, { recursive: true, force: true }); });
function original(): FiscalDocumentSnapshot { return { documentId: '20000000-0000-4000-8000-000000000001', companyId: 1, branchId, documentTypeCode: '01', environment: 'PRODUCTION', series: 'F001', number: '2', fullNumber: 'F001-2', issueDate: new Date(NOW.getTime() - 7200000).toISOString(), currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' }, issuer: { identityType: '6', identityNumber: RUC, legalName: 'FICTITIOUS ISSUER & TEST', address: 'FICTITIOUS ADDRESS', ubigeo: '150101', establishmentCode: '0000' }, customer: { identityType: '6', identityNumber: '20131312955', legalName: 'FICTITIOUS CUSTOMER' }, ...calculateDocumentTotals([{ description: 'FICTITIOUS ITEM & <TEST>', quantity: '2', unitPriceWithTax: '11.80', unitCode: 'NIU', igvRate: '18', taxAffectationCode: '10' }]) }; }
function acceptance(o = original()): ProductionNotesAcceptance { return { profile: 'PRODUCTION-01-ARCHIVE-v1', documentId: o.documentId, snapshotSha256: fiscalSnapshotSha256(o), signedXmlSha256: 'a'.repeat(64), cdrXmlSha256: 'b'.repeat(64), cdrZipSha256: 'c'.repeat(64), acceptedAt: new Date(NOW.getTime() - 3600000).toISOString(), checkedAt: NOW.toISOString() }; }
const cancel = { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'FICTITIOUS ANNULMENT' } as const;
const increase = { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'FICTITIOUS INCREASE', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }] } as const;
function note(adjustment: unknown = cancel, history: ProductionNotesSnapshot[] = []) { const o = original(); return buildProductionNotesSnapshot(o, acceptance(o), adjustment, { documentId: randomUUID(), series: adjustment === increase ? 'FD01' : 'FC01', number: '1', issueDate: new Date(NOW.getTime() - 1000).toISOString() }, history); }
describe('versioned production notes, independent of Beta identity and catalogue', () => {
    it('pins only 07-01 and 08-02 against own 01 PEN/IGV18 and existing source references', () => { expect(PRODUCTION_NOTES_RULES.catalog09).toEqual(['01']); expect(PRODUCTION_NOTES_RULES.catalog10).toEqual(['02']); expect(PRODUCTION_NOTES_RULES.sources.credit).toContain('sunat.gob.pe'); });
    it('07-01 copies the complete original base, IGV, quantities and total without a negative or synthesized document', () => { const n = note(), o = original(); expect(n.environment).toBe('PRODUCTION'); expect(n.reference.snapshotSha256).toBe(fiscalSnapshotSha256(o)); expect(n.totals).toEqual(o.totals); expect(n.lines[0].quantity).toBe(o.lines[0].quantity); expect(n.lines[0].unitPriceWithTax).toBe(o.lines[0].unitPriceWithTax); });
    it('08-02 is a positive unit delta at original quantity, never the replacement total price', () => { const n = note(increase); expect(n.lines[0].quantity).toBe('2'); expect(n.totals).toEqual({ taxableAmount: '2.00', igvAmount: '0.36', payableAmount: '2.36' }); });
    it.each(['06', '07', '05', '09', '13', '03'])('rejects unsupported credit reason %s rather than approximating', reasonCode => { expect(() => productionNotesAdjustment({ ...cancel, reasonCode })).toThrow(); });
    it.each(['01', '03', '04'])('rejects unsupported debit reason %s including interest', reasonCode => { expect(() => productionNotesAdjustment({ ...increase, reasonCode })).toThrow(); });
    it.each(['03', 'BETA', 'USD', 'CREDITO', 'operation', 'tax', 'acceptance'])('rejects unsupported original context %s', change => { const o = original(), p = acceptance(o); if (change === '03')
        o.documentTypeCode = '03';
    else if (change === 'BETA')
        o.environment = 'BETA';
    else if (change === 'USD')
        o.currencyCode = 'USD';
    else if (change === 'CREDITO')
        o.paymentTerms = { type: 'CREDITO', currencyCode: 'PEN', pendingAmount: '1.00', installments: [] };
    else if (change === 'operation')
        o.operationTypeCode = '0200';
    else if (change === 'tax')
        o.lines[0].igvRate = '10';
    else
        p.cdrXmlSha256 = ''; expect(() => buildProductionNotesSnapshot(o, p, cancel, { documentId: randomUUID(), series: 'FC01', number: '1', issueDate: NOW.toISOString() })).toThrow(); });
    it.each(['0', '-1', '1.1234567', 1, NaN])('rejects invalid delta %j without number coercion', delta => { expect(() => productionNotesAdjustment({ ...increase, lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: delta }] })).toThrow(); });
    it('reconstructs every field exactly and refuses a second full credit reservation', () => { const n = note(); expect(() => assertProductionNotesSnapshot(n, original(), [])).not.toThrow(); const changed = structuredClone(n); changed.totals.igvAmount = '0.01'; expect(() => assertProductionNotesSnapshot(changed, original(), [])).toThrow(); expect(() => note(cancel, [n])).toThrow('Sobreacreditación'); });
    it.each([cancel, increase])('signs %j using real ephemeral RSA, validates production transport and both official local XSDs', adjustment => {
        const n = note(adjustment), prepared = prepareProductionNotesXml(n, pki.issuer.pkcs12, pki.password), kind = n.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
        expect(verifyLocalSignedInvoice(prepared.xml, pki.issuer.certificatePem, buildProductionNotesUbl(n), kind)).toBe(prepared.digestValue);
        expect(() => validateProductionPackage({ documentId: n.documentId, fileName: prepared.fileName + '.zip', zip: prepared.zip, sha256: hash(prepared.zip) }, RUC, 'sendBill')).not.toThrow();
        const code = ["from pathlib import Path", "from runpy import run_path", "import sys", "from lxml import etree", "h=run_path('tests/validate-official-xsd.py')", "root=Path('tmp/sunat-schema/ubl21-browser/Archivos XSD').resolve(strict=True)", "kind=sys.argv[1]", "schema=etree.XMLSchema(etree.parse(str(root/('2.1/maindoc/UBL-'+kind+'-2.1.xsd')),h['parser'](root)))", "schema.assertValid(h['xml_root'](sys.stdin.buffer.read()))"].join('\n');
        const result = spawnSync('python', ['-c', code, kind], { input: prepared.xml, encoding: 'utf8', timeout: 15000, cwd: resolve('.') });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
    });
    it('requires unforgeable owner purpose/body proof, expires only admission, never accepts edited history', () => {
        const body = { snapshot: note(), creditHistory: [], ownerRevisionSha256: 'a'.repeat(64) }, proof = signProductionNotesOwner(body, 'admission', ownerKey);
        expect(() => assertProductionNotesOwner(body, 'admission', proof, ownerKey)).not.toThrow();
        expect(() => assertProductionNotesOwner(body, 'issued', proof, ownerKey)).toThrow();
        expect(() => assertProductionNotesOwner({ ...body, ownerRevisionSha256: 'b'.repeat(64) }, 'admission', proof, ownerKey)).toThrow();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(Date.now() + 31000));
        expect(() => assertProductionNotesOwner(body, 'admission', proof, ownerKey)).toThrow('expirada');
    });
});
function ownerFixture() {
    const o = original(), point = { id: pointId, active: true, companyId: 1, branchId, branch: { id: branchId, active: true, companyId: 1 }, company: { id: 1, ruc: RUC, active: true, environment: 'PRODUCTION' } };
    const doc: any = { id: o.documentId, companyId: 1, seriesCounterId: randomUUID(), emissionPointId: pointId, type: 'INVOICE', status: 'ISSUED', sunatStatus: 'ACCEPTED', series: o.series, number: 2n, fullNumber: o.fullNumber, customerIdentityNumber: o.customer.identityNumber, immutableSnapshot: JSON.parse(JSON.stringify(o)), emissionPoint: point };
    const state = { counter: 1n, reservations: [] as any[], outbox: [] as any[], notes: [] as any[], refs: [] as any[] };
    const actor = { userId: actorId, scope: { kind: 'GLOBAL' as const }, authorization: 'Bearer FICTITIOUS.OWNER' };
    const tx: any = { document: { findUnique: vi.fn(async ({ where }: any) => where.id === o.documentId ? doc : state.notes.find(n => n.id === where.id)), create: vi.fn(async ({ data }: any) => { state.notes.push(data); state.refs.push({ sourceDocumentId: data.id }); return data; }), updateMany: vi.fn() }, seriesCounter: { findUnique: vi.fn(async ({ where }: any) => ({ id: where.id, companyId: 1, emissionPointId: pointId, documentType: where.id === debitSeriesId ? 'DEBIT_NOTE' : 'CREDIT_NOTE', series: where.id === debitSeriesId ? 'FD01' : 'FC01', active: true, nextNumber: state.counter })), findMany: vi.fn(async () => []), updateMany: vi.fn(async ({ where, data }: any) => { if (where.nextNumber !== state.counter)
                return { count: 0 }; state.counter += data.nextNumber.increment; return { count: 1 }; }) }, documentReference: { findMany: vi.fn(async () => structuredClone(state.refs)) } };
    tx.$queryRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => { if (sql.startsWith('SELECT * FROM "ProductionNotesReservation"'))
        return sql.includes('"operationId"') ? state.reservations.filter(r => r.operationId === args[0]) : structuredClone(state.reservations); return []; });
    tx.$executeRawUnsafe = vi.fn(async (sql: string, ...args: any[]) => { if (sql.startsWith('INSERT INTO "ProductionNotesReservation"')) {
        state.reservations.push({ documentId: args[0], originalId: args[1], operationId: args[2], actorId: args[3], requestSha256: args[4], snapshotSha256: args[5], eventId: args[6], payload: JSON.parse(args[7]), state: 'QUEUED' });
    } if (sql.startsWith('INSERT INTO "ProductionNotesOutbox"'))
        state.outbox.push({ id: args[0], documentId: args[1], payload: JSON.parse(args[2]) }); return 1; });
    // Serializable transaction double: independent concurrent calls wait; all owner writes roll back together.
    let tail = Promise.resolve();
    const prisma: any = { $transaction: async (run: any, options: any) => { expect(options?.isolationLevel ?? 'Serializable').toBe('Serializable'); let release!: () => void; const before = tail; tail = new Promise<void>(r => release = r); await before; const copy = structuredClone(state); try {
            return await run(tx);
        }
        catch (e) {
            Object.assign(state, copy);
            throw e;
        }
        finally {
            release();
        } } };
    const service = new ProductionNotesOwnerService(prisma);
    const remote = vi.fn(async (companyId: number, kind: string, body: any) => { if (kind === 'original-evidence')
        return acceptance(o); if (kind === 'admission')
        return { authorized: true, profile: '07-08-ON-01-PEN-0101-IGV18-v1', snapshotSha256: fiscalSnapshotSha256(body.snapshot), grantVersion: 1, credentialRevision: 4, certificateFingerprint: 'e'.repeat(64) }; throw Error('UNEXPECTED_REMOTE'); });
    (service as any).remote = remote;
    const issue = (adjustment: unknown = cancel, operationId = randomUUID()) => service.issue(o.documentId, { seriesCounterId: adjustment === increase ? debitSeriesId : seriesId, adjustment }, operationId, actor);
    return { state, service, tx, doc, o, actor, issue, remote };
}
describe('Billing owner production notes: persistence, scope, exact histories and two-credit race', () => {
    it('atomically owns note, items, reference, reservation, separate Outbox and one counter increment', async () => { const f = ownerFixture(); await f.issue(); expect(f.state.counter).toBe(2n); expect(f.state.notes).toHaveLength(1); expect(f.state.reservations).toHaveLength(1); expect(f.state.outbox).toHaveLength(1); const event = f.state.outbox[0].payload; const { ownerProof, ...unsigned } = event; expect(() => assertProductionNotesOwner(unsigned, 'issued', ownerProof)).not.toThrow(); expect(event.payload.snapshot.customer).toEqual(f.o.customer); expect(f.tx.$executeRawUnsafe.mock.calls.some((c: any) => c[1] === 'production-notes:ruc:' + RUC)).toBe(true); expect(f.tx.$queryRawUnsafe.mock.calls.some((c: any) => c[0].includes('"SeriesCounter"') && c[0].includes('FOR UPDATE'))).toBe(true); });
    it('two concurrent full-credit requests reserve exactly one note and never consume a second number', async () => { const f = ownerFixture(), results = await Promise.allSettled([f.issue(), f.issue()]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1); expect(f.state.counter).toBe(2n); expect(f.state.notes).toHaveLength(1); expect(f.state.outbox).toHaveLength(1); });
    it('same operation replay returns the same document and no extra number or Outbox', async () => { const f = ownerFixture(), id = randomUUID(), first = await f.issue(cancel, id), second = await f.issue(cancel, id); expect(second.documentId).toBe(first.documentId); expect(second.deduplicated).toBe(true); expect(f.state.counter).toBe(2n); expect(f.state.outbox).toHaveLength(1); });
    it('failed fiscal admission rolls back all owner writes and leaves the counter intact', async () => { const f = ownerFixture(); f.remote.mockImplementation(async () => { throw Error('NO_GRANT'); }); await expect(f.issue()).rejects.toThrow('NO_GRANT'); expect(f.state).toMatchObject({ counter: 1n, notes: [], reservations: [], outbox: [], refs: [] }); });
    it('does not ignore unrelated prior corrections or mix debit/credit history', async () => { const f = ownerFixture(); f.state.refs.push({ sourceDocumentId: randomUUID() }); await expect(f.issue()).rejects.toThrow('Historial'); expect(f.state.counter).toBe(1n); f.state.refs = []; await f.issue(increase); await expect(f.issue()).rejects.toThrow('Mezcla'); });
    it('rejects own nonaccepted/Beta originals and unauthorized human scope before number allocation', async () => { const f = ownerFixture(); f.doc.sunatStatus = 'PROCESSING'; await expect(f.issue()).rejects.toThrow(); f.doc.sunatStatus = 'ACCEPTED'; f.doc.immutableSnapshot.environment = 'BETA'; await expect(f.issue()).rejects.toThrow(); expect(f.state.counter).toBe(1n); });
    it('ready exposes only the Billing flag and own immutable data, without invented external readiness', async () => { const f = ownerFixture(); expect(await f.service.ready(f.o.documentId, f.actor)).toMatchObject({ serverEnabled: true, profile: '07-08-ON-01-PEN-0101-IGV18-v1', supportedReasons: { '07': ['01'], '08': ['02'] } }); vi.stubEnv('BILLING_PRODUCTION_NOTES_ENABLED', 'false'); expect(await f.service.ready(f.o.documentId, f.actor)).toMatchObject({ serverEnabled: false }); await expect(f.issue()).rejects.toThrow('deshabilitadas'); });
    it('rejects client snapshots or supplied credit histories in the UI DTO', async () => { const f = ownerFixture(); await expect(f.service.issue(f.o.documentId, { seriesCounterId: seriesId, adjustment: cancel, creditHistory: [] }, randomUUID(), f.actor)).rejects.toThrow(); expect(f.remote).not.toHaveBeenCalled(); });
});
describe('Billing-to-SUNAT admission HTTP has exact owner attestation, not a user authority DTO', () => {
    it('signs the exact body with short-lived admission purpose and forwards the human bearer only to the scoped internal service', async () => {
        const service: any = new ProductionNotesOwnerService({} as never), body = { snapshot: note(), original: original(), creditHistory: [], ownerRevisionSha256: 'f'.repeat(64) };
        const transport = vi.fn(async (url: string, options: any) => {
            expect(url).toContain('/1/PRODUCTION/notes/admission');
            expect(options.headers.Authorization).toBe('Bearer FICTITIOUS.HUMAN');
            const proof = JSON.parse(Buffer.from(options.headers['X-Factuez-Notes-Owner'], 'base64url').toString());
            expect(() => assertProductionNotesOwner(JSON.parse(options.body), 'admission', proof)).not.toThrow();
            expect(JSON.parse(options.body)).toEqual(JSON.parse(JSON.stringify(body)));
            return Response.json({ authorized: true });
        });
        vi.stubGlobal('fetch', transport);
        await expect(service.remote(1, 'admission', body, 'Bearer FICTITIOUS.HUMAN')).resolves.toEqual({ authorized: true });
        expect(transport).toHaveBeenCalledOnce();
    });
});
