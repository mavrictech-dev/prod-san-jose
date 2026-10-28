import 'reflect-metadata';
import { randomUUID, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src/events';
import { PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE, PRODUCTION_NOTES_PROFILES, isProductionNotesProfile, type ProductionNotesAnySnapshot, type ProductionNotesExtendedAdjustment, type ProductionNotesExtendedAcceptance } from '../packages/contracts/src/production-notes';
import { buildProductionNotesExtendedSnapshot as build, assertProductionNotesExtendedSnapshot as assertNote, buildProductionNotesExtendedUbl as ubl, productionNotesExtendedAdjustment as parse, assertProductionNotesAnySnapshot, buildProductionNotesAnyUbl, assertProductionNotesAnyOriginal, buildProductionNotesSnapshot, buildProductionNotesUbl, PRODUCTION_NOTES_RULES } from '../packages/sunat-core/src/production-notes-profile';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { fiscalSnapshotSha256, fiscalCanonical } from '../packages/sunat-core/src/fiscal-note';
import { createGuideSidecarPki } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { XmlSignerService, verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
const NOW = '2026-10-28T18:00:00.000Z';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); vi.stubGlobal('fetch', vi.fn(() => { throw Error('NETWORK_FORBIDDEN'); })); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function original(receipt = false): FiscalDocumentSnapshot {
    return { documentId: '20000000-0000-4000-8000-000000000001', companyId: 1, branchId: '10000000-0000-4000-8000-000000000001', environment: 'PRODUCTION', documentTypeCode: receipt ? '03' : '01', series: receipt ? 'B001' : 'F001', number: '1', fullNumber: receipt ? 'B001-1' : 'F001-1', issueDate: '2026-10-28T12:00:00.000Z', currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' }, issuer: { identityType: '6', identityNumber: '20100070970', legalName: 'SYNTHETIC ISSUER', address: 'SYNTHETIC ADDRESS', ubigeo: '150101', establishmentCode: '0000' }, customer: { identityType: '6', identityNumber: '20131312955', legalName: 'SYNTHETIC CUSTOMER' }, ...calculateDocumentTotals([ { description: 'SYNTHETIC A', quantity: '2', unitPriceWithTax: '11.80', unitCode: 'NIU', taxAffectationCode: '10', igvRate: '18' }, { description: 'SYNTHETIC B', quantity: '3', unitPriceWithTax: '23.60', unitCode: 'NIU', taxAffectationCode: '10', igvRate: '18' } ]) };
}
function acceptance(o: FiscalDocumentSnapshot): ProductionNotesExtendedAcceptance {
    return { profile: o.documentTypeCode === '03' ? 'PRODUCTION-03-RC-ARCHIVE-v1' : 'PRODUCTION-01-ARCHIVE-v1', documentId: o.documentId, snapshotSha256: fiscalSnapshotSha256(o), signedXmlSha256: 'a'.repeat(64), cdrXmlSha256: 'b'.repeat(64), cdrZipSha256: 'c'.repeat(64), acceptedAt: '2026-10-28T13:00:00.000Z', checkedAt: NOW,
        ...(o.documentTypeCode === '03' ? { receiptSummary: { identifier: 'RC-20261028-1', summaryXmlSha256: 'd'.repeat(64), summaryZipSha256: 'e'.repeat(64), individualXmlSha256: 'a'.repeat(64), individualZipSha256: 'f'.repeat(64), cdrXmlSha256: 'b'.repeat(64), cdrZipSha256: 'c'.repeat(64) } } : {}) };
}
const identity = (receipt = false) => ({ documentId: randomUUID(), series: receipt ? 'BC01' : 'FC01', number: '1', issueDate: '2026-10-28T14:00:00.000Z' });
const cases: ProductionNotesExtendedAdjustment[] = [
    ...(['01', '02', '06'] as const).map(reasonCode => ({ documentTypeCode: '07' as const, reasonCode, reasonDescription: 'SYNTHETIC FULL' })),
    { documentTypeCode: '07', reasonCode: '03', reasonDescription: 'DESCRIPTION', lines: [{ originalLineNumber: 1, correctedDescription: 'CORRECTED & <SAFE>' }] },
    { documentTypeCode: '07', reasonCode: '04', reasonDescription: 'GLOBAL', amountWithTax: '3.54', lines: [{ originalLineNumber: 1, amountWithTax: '1.18' }, { originalLineNumber: 2, amountWithTax: '2.36' }] },
    ...(['05', '09'] as const).map(reasonCode => ({ documentTypeCode: '07' as const, reasonCode, reasonDescription: 'UNIT DELTA', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }] })),
    { documentTypeCode: '07', reasonCode: '07', reasonDescription: 'RETURN', lines: [{ originalLineNumber: 1, quantity: '1' }] },
    { documentTypeCode: '07', reasonCode: '08', reasonDescription: 'BONUS', lines: [{ originalLineNumber: 1, bonusAmountWithTax: '1.18', description: 'MONETARY BONUS' }] },
    { documentTypeCode: '07', reasonCode: '10', reasonDescription: 'OTHER', lines: [{ originalLineNumber: 1, quantity: '1', unitPriceAdjustmentWithTax: '1.18', description: 'EXPLICIT CONCEPT' }] },
    { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'MORA', interestNature: 'MORATORIO', interestBasis: 'SYNTHETIC DOCUMENTED LATE INTEREST', lines: [{ originalLineNumber: 1, interestAmount: '5.00' }] },
    { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'PRICE INCREASE', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }] },
    { documentTypeCode: '08', reasonCode: '03', reasonDescription: 'OTHER CHARGE', lines: [{ originalLineNumber: 1, quantity: '2', unitPriceAdjustmentWithTax: '1.18', description: 'EXPLICIT CHARGE' }] },
];
const get = (type: string, reason: string) => cases.find(a => a.documentTypeCode === type && a.reasonCode === reason)!;
function note(a = cases[0], history: ProductionNotesAnySnapshot[] = [], o = original()) { return build(o, acceptance(o), a, identity(o.documentTypeCode === '03'), history); }
describe('explicit production notes extended v2', () => {
    it.each(cases.map(a => [a.documentTypeCode, a.reasonCode, a] as const))('builds and reconstructs %s reason %s for both 01 and 03', (_, __, a) => {
        for (const receipt of [false, true]) {
            const o = original(receipt), n = note(a, [], o), xml = ubl(n, o);
            expect(n.profile).toBe(PRODUCTION_NOTES_EXTENDED_PROFILE); expect(n.environment).toBe('PRODUCTION');
            expect(n.series.startsWith(receipt ? 'B' : 'F')).toBe(true);
            expect(() => assertNote(n, o, [])).not.toThrow();
            expect(xml).toContain('<cbc:DocumentTypeCode>' + o.documentTypeCode + '</cbc:DocumentTypeCode>');
            expect(xml).toContain('catalogo' + (a.documentTypeCode === '07' ? '09' : '10'));
        }
    });
    it('NC03 emits corrected text and all zero amounts, preserving monetary capacity even after full credit', () => {
        const full = note(), corrected = note(get('07', '03'), [full]), o = original();
        expect(corrected.totals).toEqual({ taxableAmount: '0.00', unaffectedAmount: '0.00', igvAmount: '0.00', payableAmount: '0.00' });
        expect(ubl(corrected, o, [full])).toContain('CORRECTED &amp; &lt;SAFE&gt;');
        expect(ubl(corrected, o, [full])).toContain('<cbc:PayableAmount currencyID="PEN">0.00</cbc:PayableAmount>');
        expect(() => note(cases[0], [full, corrected])).toThrow('Sobreacreditación');
        const correctionFirst = note(get('07', '03')); expect(note(cases[0], [correctionFirst]).totals.payableAmount).toBe(o.totals.payableAmount);
    });
    it('mora has no IGV, uses scheme 9998 and affectation 30 on amount rather than original quantity', () => {
        const n = note(get('08', '01')), xml = ubl(n, original());
        expect(n.totals).toEqual({ taxableAmount: '0.00', unaffectedAmount: '5.00', igvAmount: '0.00', payableAmount: '5.00' });
        expect(n.lines[0].quantity).toBe('1'); expect(n.lines[0].taxAffectationCode).toBe('30'); expect(xml).toContain('>9998</cbc:ID>'); expect(xml).toContain('>30</cbc:TaxExemptionReasonCode>');
    });
    it('unit discounts and returns share money capacity without counting quantity twice, in either order', () => {
        const discount = note(get('07', '05')), returned = note(get('07', '07'), [discount]);
        expect(discount.totals.payableAmount).toBe('2.36'); expect(returned.totals.payableAmount).toBe('11.80');
        const discount2 = note(get('07', '09'), [discount, returned]); expect(discount2.totals.payableAmount).toBe('2.36');
        expect(() => note(get('07', '07'), [discount, returned, discount2])).toThrow('Sobreacreditación');
        const firstReturn = note(get('07', '07')); expect(() => note(get('07', '05'), [firstReturn])).not.toThrow();
    });
    it('rejects forged histories, wrong reference, duplicate IDs, unknown profiles and debit netting', () => {
        const discount = note(get('07', '05'));
        for (const mutate of [(n: any) => n.lines[0].totalAmount = '0.00', (n: any) => n.reasonCode = '03', (n: any) => n.reference.snapshotSha256 = '0'.repeat(64), (n: any) => n.profile = 'BETA', (n: any) => n.creditHistoryIds.push(randomUUID())]) {
            const bad = structuredClone(discount); mutate(bad); expect(() => note(cases[0], [bad])).toThrow();
        }
        expect(() => note(cases[0], [discount, discount])).toThrow();
        expect(() => note(cases[0], [note(get('08', '02'))])).toThrow();
        const next = note(get('07', '09'), [discount]); expect(() => note(cases[0], [next])).toThrow();
    });
    it('rejects concentration beyond a line even when invoice has sufficient total capacity', () => {
        expect(() => note({ ...get('07', '10'), lines: [{ originalLineNumber: 1, quantity: '1', unitPriceAdjustmentWithTax: '30', description: 'EXCESS' }] } as any)).toThrow('Sobreacreditación');
    });
    it.each(['11', '12', '13'])('explicitly rejects unsupported catalogue reason %s', reasonCode => { expect(() => parse({ documentTypeCode: '07', reasonCode, reasonDescription: 'UNSUPPORTED' })).toThrow('fuera de alcance'); });
    it.each(['01', '02', '06'])('full NC %s rejects even empty selected lines', reasonCode => { expect(() => parse({ documentTypeCode: '07', reasonCode, reasonDescription: 'FULL', lines: [] })).toThrow(); });
    it.each(['0', '-1', '1.1234567', 1, NaN, '1e2'])('rejects invalid unit delta %s', delta => { expect(() => parse({ ...get('08', '02'), lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: delta }] })).toThrow(); });
    it('requires exact cent allocation for a global discount and every original line', () => {
        expect(() => note({ ...get('07', '04'), amountWithTax: '3.53' } as any)).toThrow('reparto');
        expect(() => note({ ...get('07', '04'), amountWithTax: '1.18', lines: [{ originalLineNumber: 1, amountWithTax: '1.18' }] } as any)).toThrow('completo');
        expect(() => parse({ ...get('07', '04'), amountWithTax: '3.540' })).toThrow();
    });
    it('rejects unknown fields, empty/duplicate/foreign lines, missing semantic data and compensatory interest', () => {
        for (const input of [ { ...get('08', '02'), overrideEnvironment: 'BETA' }, { ...get('08', '01'), interestNature: 'COMPENSATORIO' }, { ...get('08', '01'), interestBasis: '' }, { ...get('07', '08'), lines: [{ originalLineNumber: 1, bonusAmountWithTax: '1.18' }] }, { ...get('07', '03'), lines: [{ originalLineNumber: 1, correctedDescription: 'OK', amountWithTax: '1' }] }, { ...get('07', '05'), lines: [] }, { ...get('07', '05'), lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1' }, { originalLineNumber: 1, unitPriceAdjustmentWithTax: '1' }] }, { ...get('07', '07'), lines: [{ originalLineNumber: 9, quantity: '1' }] } ]) expect(() => note(input as any)).toThrow();
    });
    it.each(['BETA', 'USD', 'CREDITO', 'NO_PAYMENT', 'EXPORT', 'IVAP', 'BAD_TOTAL', 'BAD_IGV'])('rejects original context %s', kind => {
        const o: any = original();
        if (kind === 'BETA') o.environment = 'BETA'; if (kind === 'USD') o.currencyCode = 'USD'; if (kind === 'CREDITO') o.paymentTerms = { type: 'CREDITO' }; if (kind === 'NO_PAYMENT') delete o.paymentTerms; if (kind === 'EXPORT') o.operationTypeCode = '0200'; if (kind === 'IVAP') o.lines[0].taxAffectationCode = '17'; if (kind === 'BAD_TOTAL') o.totals.payableAmount = '1.00'; if (kind === 'BAD_IGV') o.lines[0].igvAmount = '0.00';
        expect(() => note(cases[0], [], o)).toThrow();
    });
    it('03 requires RC proof and B series; rejects individual CDR substitution and malformed RC hashes/date', () => {
        const o = original(true), p = acceptance(o);
        for (const mutate of [(a: any) => delete a.receiptSummary, (a: any) => a.profile = 'PRODUCTION-01-ARCHIVE-v1', (a: any) => a.receiptSummary.cdrXmlSha256 = 'f'.repeat(64), (a: any) => a.receiptSummary.individualXmlSha256 = 'f'.repeat(64), (a: any) => a.receiptSummary.summaryZipSha256 = 'bad', (a: any) => a.receiptSummary.identifier = 'RC-20261027-1', (a: any) => a.receiptSummary.individualCdrSha256 = 'a'.repeat(64)]) { const bad = structuredClone(p); mutate(bad); expect(() => build(o, bad, cases[0], identity(true))).toThrow(); }
        expect(() => build(o, p, cases[0], identity())).toThrow();
        expect(() => build(original(), acceptance(original()), cases[0], identity(true))).toThrow();
    });
    it('revalidates snapshot before XML and refuses edits to monetary totals', () => { const n = note(get('08', '03')); n.totals.payableAmount = '1.00'; expect(() => ubl(n, original())).toThrow(); });
    it('accepts a legacy full credit in conservative v2 history and leaves v1 output stable', () => {
        const o = original(), p = acceptance(o) as any, id = { ...identity(), documentId: '30000000-0000-4000-8000-000000000001' }, a = { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'SYNTHETIC FULL' };
        const legacy = buildProductionNotesSnapshot(o, p, a, id);
        expect(legacy.profile).toBe(PRODUCTION_NOTES_PROFILE); expect(PRODUCTION_NOTES_RULES.catalog09).toEqual(['01']);
        expect(legacy.originalAcceptance).not.toHaveProperty('receiptSummary'); expect(legacy.totals).not.toHaveProperty('unaffectedAmount');
        expect(() => note(cases[0], [legacy])).toThrow('Sobreacreditación'); expect(() => note(get('07', '03'), [legacy])).not.toThrow();
        expect(fiscalSnapshotSha256(legacy)).toBe('a6d9e9def9e7d87dcaad36fd65c0f85bdac5981399e50375ba94fa0a7f8a532b');
        expect(fiscalSnapshotSha256(buildProductionNotesUbl(legacy))).toBe('7799f0cd0a06cd4bd583501a4ecea5734b4b6ff39295bc491f18912396c17655');
        expect(createHmac('sha256', 'SYNTHETIC-ONLY-KEY').update(fiscalCanonical(legacy)).digest('hex')).toBe('8bfc8872b16d632bedae0c3be55e327c127064b9535b0393d65b13867dc11737');
    });
    it('dispatches Any helpers by literal profile and preserves legacy XML', () => {
        const o = original(), legacy = buildProductionNotesSnapshot(o, acceptance(o) as any, cases[0], identity());
        expect(buildProductionNotesAnyUbl(legacy)).toBe(buildProductionNotesUbl(legacy));
        expect(() => assertProductionNotesAnySnapshot(legacy, o, [])).not.toThrow();
        for (const receipt of [false, true]) {
            const source = original(receipt), n = note(get('07', '03'), [], source);
            expect(() => assertProductionNotesAnyOriginal(source)).not.toThrow();
            expect(() => assertProductionNotesAnySnapshot(n, source, [])).not.toThrow();
            expect(buildProductionNotesAnyUbl(n)).toBe(ubl(n, source));
        }
        expect(() => buildProductionNotesAnyUbl({ ...legacy, profile: 'UNKNOWN' } as any)).toThrow();
        expect(() => assertProductionNotesAnySnapshot({ ...legacy, profile: 'UNKNOWN' } as any, o, [])).toThrow();
        expect(() => assertProductionNotesAnySnapshot(legacy, o, [note(get('07', '03'))])).toThrow('v2');
    });
    it('requires explicit v2 and keeps profile identification exact', () => {
        expect(PRODUCTION_NOTES_EXTENDED_PROFILE).toBe('07-08-ON-01-03-PEN-0101-IGV18-v2');
        expect(PRODUCTION_NOTES_PROFILES).toEqual([PRODUCTION_NOTES_PROFILE, PRODUCTION_NOTES_EXTENDED_PROFILE]);
        for (const profile of PRODUCTION_NOTES_PROFILES) expect(isProductionNotesProfile(profile)).toBe(true);
        for (const profile of [null, {}, 'BETA', 'v2', '07-08-ON-01-03-PEN-0101-IGV18-MORA30-v2']) expect(isProductionNotesProfile(profile)).toBe(false);
        expect(() => buildProductionNotesSnapshot(original(), acceptance(original()) as any, get('07', '03'), identity())).toThrow();
    });
    it('rejects returned quantity overflow separately from money and never treats debit as credit capacity', () => {
        expect(() => note({ documentTypeCode: '07', reasonCode: '07', reasonDescription: 'EXCESS RETURN', lines: [{ originalLineNumber: 1, quantity: '2.000001' }] })).toThrow('cantidad');
        const price = note(get('08', '02'));
        expect(price.lines[0].quantity).toBe('2'); expect(price.totals.payableAmount).toBe('2.36');
        expect(() => note(get('07', '03'), [price])).toThrow('débito');
    });
    it('rejects already consumed monetary capacity by a bonus or global discount as well as a return', () => {
        const first = note({ documentTypeCode: '07', reasonCode: '08', reasonDescription: 'BONUS', lines: [{ originalLineNumber: 1, bonusAmountWithTax: '23.60', description: 'WHOLE LINE' }] });
        expect(() => note(get('07', '05'), [first])).toThrow('Sobreacreditación');
        expect(() => note(get('07', '04'), [first])).toThrow('Sobreacreditación');
        expect(() => note(get('07', '07'), [first])).toThrow('Sobreacreditación');
    });
    it('rejects future issuance and issuance before archive acceptance', () => {
        const o = original(), p = acceptance(o);
        for (const issueDate of ['2026-10-28T12:30:00.000Z', '2026-10-29T12:00:00.000Z']) expect(() => build(o, p, cases[0], { ...identity(), issueDate })).toThrow();
    });
    it('pins legacy ND02 quantities, XML and canonical HMAC without adopting v2 fields', () => {
        const o = original(), p = acceptance(o) as any, a = get('08', '02'), id = { ...identity(), documentId: '30000000-0000-4000-8000-000000000002' };
        const legacy = buildProductionNotesSnapshot(o, p, a, id);
        expect(legacy.profile).toBe(PRODUCTION_NOTES_PROFILE); expect(legacy.lines[0].quantity).toBe('2');
        expect(legacy.totals).toEqual({ taxableAmount: '2.00', igvAmount: '0.36', payableAmount: '2.36' });
        expect(fiscalSnapshotSha256(legacy)).toBe('c772b69685c12b9fcbabffc465f5b36cdbc3c9f0c99b0c251dcde046b73bf0b7');
        expect(fiscalSnapshotSha256(buildProductionNotesUbl(legacy))).toBe('d3a86712cc666852dd532fc646ee17f1a7b0bcf5190eb3fb5e8b5e73597da0ac');
        expect(createHmac('sha256', 'SYNTHETIC-ONLY-KEY').update(fiscalCanonical(legacy)).digest('hex')).toBe('e86fab1386cfe0481027fd65a66883d0baf5d5961149388db7851d272ddfa885');
    });
    it('all new motive XML validates against the official local UBL 2.1 schemas', () => {
        const code = ["from pathlib import Path", "from runpy import run_path", "import sys,json", "from lxml import etree", "h=run_path('tests/validate-official-xsd.py')", "root=Path('tmp/sunat-schema/ubl21-browser/Archivos XSD').resolve(strict=True)", "schemas={k:etree.XMLSchema(etree.parse(str(root/('2.1/maindoc/UBL-'+k+'-2.1.xsd')),h['parser'](root))) for k in ['CreditNote','DebitNote']}", "for k,xml in json.load(sys.stdin): schemas[k].assertValid(h['xml_root'](xml.encode()))"].join('\n');
        const pki = createGuideSidecarPki();
        const documents = [false, true].flatMap(receipt => cases.map(a => { const o = original(receipt); const kind = a.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote'; const unsigned = ubl(note(a, [], o), o); const signed = new XmlSignerService().sign(unsigned, pki.issuer.pkcs12, pki.password, kind); expect(verifyLocalSignedInvoice(signed.xml, pki.issuer.certificatePem, unsigned, kind)).toBe(signed.digestValue); return [kind, signed.xml]; }));
        const result = spawnSync('python', ['-c', code], { cwd: resolve('.'), input: JSON.stringify(documents), encoding: 'utf8', timeout: 20000 });
        for (const signer of [pki.issuer, pki.otherIssuer, pki.sunat]) signer.pkcs12.fill(0);
        expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    }, 30000);
});
