import { PRODUCTION_NOTES_PROFILE, type FiscalDocumentSnapshot, type ProductionNotesSnapshot, type ProductionNotesAdjustment, type ProductionNotesAcceptance } from '@factuez/contracts';
import { assertFiscalSnapshot } from './fiscal-rules';
import { addMoney, calculateTaxLine, parseDecimal } from './tax';
import { fiscalArray, fiscalDecimal, fiscalEqual, fiscalIdentity, fiscalObject, fiscalSignatureXml, fiscalSnapshotSha256, fiscalTaxXml, fiscalText, fiscalTimestamp, fiscalUuid, fiscalXml, fiscalAmountXml, fiscalLimaDate, FISCAL_XML_EXTENSION, FISCAL_XML_NAMESPACES, FISCAL_NOTE_SOURCES } from './fiscal-note';
export const PRODUCTION_NOTES_RULES = Object.freeze({ profile: PRODUCTION_NOTES_PROFILE, catalog09: ['01'], catalog10: ['02'], sources: FISCAL_NOTE_SOURCES, sourceReview: '2026-10-02', currency: 'PEN', original: '01', igvRate: '18', payment: 'CONTADO' });
export function productionNotesAdjustment(value: unknown): ProductionNotesAdjustment {
    fiscalObject(value, ['documentTypeCode', 'reasonCode', 'reasonDescription', 'lines'], 'adjustment');
    fiscalText(value.reasonDescription, 250, 'reasonDescription');
    const full = value.documentTypeCode === '07' && ['01'].includes(String(value.reasonCode));
    if (!full && !(value.documentTypeCode === '08' && value.reasonCode === '02'))
        throw Error('Motivo productivo no soportado; sólo NC 01 y ND 02 sobre factura 01');
    if (full) {
        if (Object.hasOwn(value, 'lines'))
            throw Error('Motivo total no admite líneas elegidas');
    }
    else {
        fiscalArray(value.lines, 100, 'lines');
        if (!value.lines.length)
            throw Error('Líneas requeridas');
        const seen = new Set<number>();
        for (const line of value.lines) {
            const field = 'unitPriceAdjustmentWithTax';
            fiscalObject(line, ['originalLineNumber', field], 'line');
            if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 || seen.has(Number(line.originalLineNumber)))
                throw Error('Línea inválida o duplicada');
            seen.add(Number(line.originalLineNumber));
            fiscalDecimal(line[field], 6, true, field);
        }
    }
    return JSON.parse(JSON.stringify(value));
}
export function assertProductionNotesOriginal(original: FiscalDocumentSnapshot) {
    if (original.environment !== 'PRODUCTION' || original.documentTypeCode !== '01' || original.currencyCode !== 'PEN' || original.operationTypeCode !== '0101' || original.paymentTerms?.type !== 'CONTADO')
        throw Error('Notas limitadas a factura 01 propia PEN/0101 IGV18 al contado');
    if (!original.lines.length || original.lines.length > 100)
        throw Error('Original limitado a 1..100 líneas');
    assertFiscalSnapshot(original, { mode: 'REAL_PREPARATION' });
}
export function assertProductionNotesAcceptance(original: FiscalDocumentSnapshot, proof: ProductionNotesAcceptance) {
    fiscalObject(proof, ['profile', 'documentId', 'snapshotSha256', 'signedXmlSha256', 'cdrXmlSha256', 'cdrZipSha256', 'acceptedAt', 'checkedAt'], 'acceptance');
    if (proof.profile !== 'PRODUCTION-01-ARCHIVE-v1' || proof.documentId !== original.documentId || proof.snapshotSha256 !== fiscalSnapshotSha256(original) ||
        ![proof.signedXmlSha256, proof.cdrXmlSha256, proof.cdrZipSha256].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)))
        throw Error('Aceptación original no vinculada');
    fiscalTimestamp(proof.acceptedAt, 'acceptedAt');
    fiscalTimestamp(proof.checkedAt, 'checkedAt');
    if (Date.parse(proof.acceptedAt) < Date.parse(original.issueDate) || Date.parse(proof.acceptedAt) > Date.now() || Date.parse(proof.checkedAt) > Date.now() + 300000)
        throw Error('Fecha aceptación inválida');
}
export function assertProductionNotesCapacity(original: FiscalDocumentSnapshot, credits: ProductionNotesSnapshot[]) {
    const ids = new Set<string>();
    for (const n of credits) {
        if (n.documentTypeCode !== '07' || n.reference.documentId !== original.documentId || n.reference.snapshotSha256 !== fiscalSnapshotSha256(original) || ids.has(n.documentId))
            throw Error('Historial crédito ajeno o duplicado');
        ids.add(n.documentId);
    }
    for (const line of original.lines) {
        const entries = credits.flatMap(n => n.lines.filter(l => l.originalLineNumber === line.lineNumber));
        if (entries.reduce((s, l) => s + parseDecimal(l.quantity), 0n) > parseDecimal(line.quantity))
            throw Error('Sobreacreditación cantidad');
        for (const key of ['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const)
            if (entries.reduce((s, l) => s + parseDecimal(l[key], 2), 0n) > parseDecimal(line[key], 2))
                throw Error('Sobreacreditación importe/IGV');
    }
    for (const key of ['taxableAmount', 'igvAmount', 'payableAmount'] as const)
        if (credits.reduce((s, n) => s + parseDecimal(n.totals[key], 2), 0n) > parseDecimal(original.totals[key], 2))
            throw Error('Sobreacreditación total');
}
export function buildProductionNotesSnapshot(original: FiscalDocumentSnapshot, acceptance: ProductionNotesAcceptance, adjustment: unknown, identity: {
    documentId: string;
    series: string;
    number: string;
    issueDate: string;
}, creditHistory: ProductionNotesSnapshot[] = []): ProductionNotesSnapshot {
    assertProductionNotesOriginal(original);
    assertProductionNotesAcceptance(original, acceptance);
    const input = productionNotesAdjustment(adjustment);
    fiscalIdentity(identity, 'F', new Date().toISOString());
    fiscalUuid(identity.documentId, 'documentId');
    if (identity.documentId === original.documentId || Date.parse(identity.issueDate) < Date.parse(acceptance.acceptedAt))
        throw Error('Fecha/identidad anterior al original aceptado');
    if (creditHistory.length > 100)
        throw Error('Historial excede límite');
    const full = input.documentTypeCode === '07' && ['01'].includes(input.reasonCode);
    const selected = full ? original.lines.map(l => ({ originalLineNumber: l.lineNumber })) : ('lines' in input ? input.lines : []);
    const lines = selected.map((item, index) => {
        const source = original.lines.find(l => l.lineNumber === item.originalLineNumber);
        if (!source)
            throw Error('Línea ajena');
        const quantity = source.quantity;
        const price = 'unitPriceAdjustmentWithTax' in item ? (item as {
            unitPriceAdjustmentWithTax: string;
        }).unitPriceAdjustmentWithTax : source.unitPriceWithTax;
        const calculated = full ? { unitValue: source.unitValue, lineExtensionAmount: source.lineExtensionAmount, igvAmount: source.igvAmount, totalAmount: source.totalAmount } : calculateTaxLine({ quantity, unitPriceWithTax: price, igvRate: '18' });
        fiscalDecimal(calculated.totalAmount, 2, true, 'total');
        return { ...(source.productCode === undefined ? {} : { productCode: source.productCode }), lineNumber: index + 1, originalLineNumber: source.lineNumber, description: source.description, unitCode: source.unitCode, quantity, unitPriceWithTax: price, igvRate: '18', taxAffectationCode: '10', ...calculated };
    });
    const note: ProductionNotesSnapshot = { documentId: identity.documentId, companyId: original.companyId, branchId: original.branchId, environment: 'PRODUCTION', documentTypeCode: input.documentTypeCode, profile: PRODUCTION_NOTES_PROFILE,
        series: identity.series, number: identity.number, fullNumber: identity.series + '-' + identity.number, issueDate: identity.issueDate, currencyCode: 'PEN', operationTypeCode: '0101', issuer: structuredClone(original.issuer), customer: structuredClone(original.customer),
        adjustment: input, reasonCode: input.reasonCode, reasonDescription: input.reasonDescription, reference: { documentId: original.documentId, documentTypeCode: '01', fullNumber: original.fullNumber, issueDate: original.issueDate, snapshotSha256: fiscalSnapshotSha256(original) },
        originalAcceptance: structuredClone(acceptance), creditHistoryIds: creditHistory.map(n => n.documentId), lines, totals: { taxableAmount: addMoney(lines.map(l => l.lineExtensionAmount)), igvAmount: addMoney(lines.map(l => l.igvAmount)), payableAmount: addMoney(lines.map(l => l.totalAmount)) } };
    if (input.documentTypeCode === '07')
        assertProductionNotesCapacity(original, [...creditHistory, note]);
    return JSON.parse(JSON.stringify(note));
}
export function assertProductionNotesSnapshot(note: ProductionNotesSnapshot, original: FiscalDocumentSnapshot, history: ProductionNotesSnapshot[]) {
    fiscalEqual(note, buildProductionNotesSnapshot(original, note.originalAcceptance, note.adjustment, { documentId: note.documentId, series: note.series, number: note.number, issueDate: note.issueDate }, history), 'productionNote');
}
/** Production-specific UBL; never rewrites Beta environments or trust evidence. */
export function buildProductionNotesUbl(note: ProductionNotesSnapshot): string {
    const root = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote', quantity = note.documentTypeCode === '07' ? 'CreditedQuantity' : 'DebitedQuantity', money = note.documentTypeCode === '07' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal';
    const party = (kind: string, p: typeof note.customer, supplier = false) => '<cac:' + kind + '><cac:Party><cac:PartyIdentification><cbc:ID schemeID="' + p.identityType + '">' + p.identityNumber + '</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>' + fiscalXml(p.legalName) + '</cbc:RegistrationName>' + (supplier ? '<cac:RegistrationAddress><cbc:ID>' + note.issuer.ubigeo + '</cbc:ID><cbc:AddressTypeCode>' + note.issuer.establishmentCode + '</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>' + fiscalXml(note.issuer.address ?? '') + '</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>' : '') + '</cac:PartyLegalEntity></cac:Party></cac:' + kind + '>';
    const lines = note.lines.map(l => '<cac:' + root + 'Line><cbc:ID>' + l.lineNumber + '</cbc:ID><cbc:' + quantity + ' unitCode="' + l.unitCode + '">' + l.quantity + '</cbc:' + quantity + '>' + fiscalAmountXml('LineExtensionAmount', l.lineExtensionAmount) + '<cac:PricingReference><cac:AlternativeConditionPrice>' + fiscalAmountXml('PriceAmount', l.unitPriceWithTax) + '<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>' + fiscalTaxXml(l.lineExtensionAmount, l.igvAmount, false, true) + '<cac:Item><cbc:Description>' + fiscalXml(l.description) + '</cbc:Description>' + (l.productCode ? '<cac:SellersItemIdentification><cbc:ID>' + fiscalXml(l.productCode) + '</cbc:ID></cac:SellersItemIdentification>' : '') + '</cac:Item><cac:Price>' + fiscalAmountXml('PriceAmount', l.unitValue) + '</cac:Price></cac:' + root + 'Line>').join('');
    return '<?xml version="1.0" encoding="UTF-8"?><' + root + ' xmlns="urn:oasis:names:specification:ubl:schema:xsd:' + root + '-2" ' + FISCAL_XML_NAMESPACES + '>' + FISCAL_XML_EXTENSION + '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>' + note.fullNumber + '</cbc:ID><cbc:IssueDate>' + fiscalLimaDate(note.issueDate) + '</cbc:IssueDate><cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode><cac:DiscrepancyResponse><cbc:ReferenceID>' + note.reference.fullNumber + '</cbc:ReferenceID><cbc:ResponseCode>' + note.reasonCode + '</cbc:ResponseCode><cbc:Description>' + fiscalXml(note.reasonDescription) + '</cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>' + note.reference.fullNumber + '</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>' + fiscalSignatureXml(note.issuer) + party('AccountingSupplierParty', note.issuer, true) + party('AccountingCustomerParty', note.customer) + fiscalTaxXml(note.totals.taxableAmount, note.totals.igvAmount, false) + '<cac:' + money + '>' + fiscalAmountXml('LineExtensionAmount', note.totals.taxableAmount) + fiscalAmountXml('TaxExclusiveAmount', note.totals.taxableAmount) + fiscalAmountXml('TaxInclusiveAmount', note.totals.payableAmount) + fiscalAmountXml('PayableAmount', note.totals.payableAmount) + '</cac:' + money + '>' + lines + '</' + root + '>';
}

// v2 is independent of Beta validators and never rewrites the original environment.
import { PRODUCTION_NOTES_EXTENDED_PROFILE, type ProductionNotesExtendedAdjustment, type ProductionNotesExtendedAcceptance, type ProductionNotesExtendedSnapshot, type ProductionNotesAnySnapshot } from '@factuez/contracts';
import { formatScaled } from './tax';
import { fiscalDate } from './fiscal-note';
export const PRODUCTION_NOTES_EXTENDED_RULES = Object.freeze({
    profile: PRODUCTION_NOTES_EXTENDED_PROFILE,
    catalog09: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'], catalog10: ['01', '02', '03'],
    unsupportedCatalog09: { '11': 'Exportación sin original soportado', '12': 'IVAP sin original soportado', '13': 'Crédito/cuotas sin original soportado' },
    sources: { ...FISCAL_NOTE_SOURCES, creditCatalog: 'https://www.sunat.gob.pe/legislacion/superin/2020/anexo3-193-2020.pdf' },
    currency: 'PEN', originals: ['01', '03'], payment: 'CONTADO', igvRate: '18', lateInterestAffectation: '30',
});
type ExtendedIdentity = { documentId: string; series: string; number: string; issueDate: string };
const isFullCredit = (a: { documentTypeCode: string; reasonCode: string }) => a.documentTypeCode === '07' && ['01', '02', '06'].includes(a.reasonCode);
export function productionNotesExtendedAdjustment(value: unknown): ProductionNotesExtendedAdjustment {
    fiscalObject(value, ['documentTypeCode', 'reasonCode', 'reasonDescription', 'lines', 'amountWithTax', 'interestNature', 'interestBasis'], 'adjustment');
    const credit = value.documentTypeCode === '07', debit = value.documentTypeCode === '08', reason = String(value.reasonCode);
    if (credit && ['11', '12', '13'].includes(reason)) throw Error('Motivo catálogo 09 ' + reason + ' fuera de alcance: exportación/IVAP/crédito requieren perfiles de originales reales');
    if (!(credit && PRODUCTION_NOTES_EXTENDED_RULES.catalog09.includes(reason)) && !(debit && PRODUCTION_NOTES_EXTENDED_RULES.catalog10.includes(reason))) throw Error('Motivo fuera del perfil extendido');
    if (typeof value.reasonCode !== 'string') throw Error('reasonCode literal requerido');
    fiscalText(value.reasonDescription, 250, 'reasonDescription');
    const full = isFullCredit({ documentTypeCode: String(value.documentTypeCode), reasonCode: reason }), mora = debit && reason === '01', global = credit && reason === '04';
    fiscalObject(value, ['documentTypeCode', 'reasonCode', 'reasonDescription', ...(!full ? ['lines'] : []), ...(global ? ['amountWithTax'] : []), ...(mora ? ['interestNature', 'interestBasis'] : [])], 'adjustment');
    if (full) return structuredClone(value) as ProductionNotesExtendedAdjustment;
    if (mora) {
        if (value.interestNature !== 'MORATORIO') throw Error('Sólo mora inafecta declarada, no interés compensatorio');
        fiscalText(value.interestBasis, 500, 'interestBasis');
    }
    if (global) fiscalDecimal(value.amountWithTax, 2, true, 'amountWithTax');
    fiscalArray(value.lines, 100, 'lines');
    if (!value.lines.length) throw Error('Líneas requeridas');
    const fields = credit && reason === '03' ? ['correctedDescription'] : global ? ['amountWithTax'] : credit && reason === '07' ? ['quantity'] : credit && reason === '08' ? ['bonusAmountWithTax', 'description'] : (credit && reason === '10') || (debit && reason === '03') ? ['quantity', 'unitPriceAdjustmentWithTax', 'description'] : mora ? ['interestAmount'] : ['unitPriceAdjustmentWithTax'];
    const seen = new Set<number>();
    for (const line of value.lines) {
        fiscalObject(line, ['originalLineNumber', ...fields], 'line');
        if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 || seen.has(Number(line.originalLineNumber))) throw Error('Línea inválida o duplicada');
        seen.add(Number(line.originalLineNumber));
        for (const field of fields) {
            if (field === 'description' || field === 'correctedDescription') fiscalText(line[field], 500, field);
            else fiscalDecimal(line[field], ['interestAmount', 'amountWithTax', 'bonusAmountWithTax'].includes(field) ? 2 : 6, true, field);
        }
    }
    if (global && addMoney(value.lines.map(l => (l as { amountWithTax: string }).amountWithTax)) !== formatScaled(parseDecimal(value.amountWithTax as string, 2), 2)) throw Error('Descuento global y reparto no coinciden');
    return structuredClone(value) as ProductionNotesExtendedAdjustment;
}
export function assertProductionNotesExtendedOriginal(original: FiscalDocumentSnapshot) {
    if (original.environment !== 'PRODUCTION' || !['01', '03'].includes(original.documentTypeCode) || original.currencyCode !== 'PEN' || original.operationTypeCode !== '0101' || original.paymentTerms?.type !== 'CONTADO') throw Error('Original fuera de PRODUCTION/01-03/PEN/0101/CONTADO/IGV18');
    fiscalObject(original.paymentTerms, ['type'], 'paymentTerms');
    fiscalArray(original.lines, 100, 'original.lines');
    if (!original.lines.length) throw Error('Original requiere líneas');
    assertFiscalSnapshot(original, { mode: 'REAL_PREPARATION' });
}
/** Evidence is supplied by the archive verifier; hashes alone are not signature verification. */
export function assertProductionNotesExtendedAcceptance(original: FiscalDocumentSnapshot, proof: ProductionNotesExtendedAcceptance) {
    if (original.documentTypeCode === '01') {
        assertProductionNotesAcceptance(original, proof as ProductionNotesAcceptance);
        return;
    }
    fiscalObject(proof, ['profile', 'documentId', 'snapshotSha256', 'signedXmlSha256', 'cdrXmlSha256', 'cdrZipSha256', 'acceptedAt', 'checkedAt', 'receiptSummary'], 'acceptance');
    const summary = proof.receiptSummary;
    fiscalObject(summary, ['identifier', 'summaryXmlSha256', 'summaryZipSha256', 'individualXmlSha256', 'individualZipSha256', 'cdrXmlSha256', 'cdrZipSha256'], 'receiptSummary');
    const hashes = ['summaryXmlSha256', 'summaryZipSha256', 'individualXmlSha256', 'individualZipSha256', 'cdrXmlSha256', 'cdrZipSha256'] as const;
    if (proof.profile !== 'PRODUCTION-03-RC-ARCHIVE-v1' || proof.documentId !== original.documentId || proof.snapshotSha256 !== fiscalSnapshotSha256(original) ||
        !hashes.every(k => typeof summary[k] === 'string' && /^[a-f0-9]{64}$/.test(summary[k] as string)) || proof.signedXmlSha256 !== summary.individualXmlSha256 || proof.cdrXmlSha256 !== summary.cdrXmlSha256 || proof.cdrZipSha256 !== summary.cdrZipSha256 || typeof summary.identifier !== 'string' || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(summary.identifier)) throw Error('Aceptación 03 requiere archivo individual y CDR del RC vinculados');
    fiscalTimestamp(proof.acceptedAt, 'acceptedAt'); fiscalTimestamp(proof.checkedAt, 'checkedAt');
    const compact = summary.identifier.slice(3, 11), day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
    fiscalDate(day, 'receiptSummary.identifier');
    if (day < fiscalLimaDate(original.issueDate) || day > fiscalLimaDate(proof.acceptedAt) || Date.parse(proof.acceptedAt) < Date.parse(original.issueDate) || Date.parse(proof.acceptedAt) > Date.now() || Date.parse(proof.checkedAt) < Date.parse(proof.acceptedAt) || Date.parse(proof.checkedAt) > Date.now() + 300000) throw Error('Fecha aceptación/RC inválida');
}
function extendedSnapshot(original: FiscalDocumentSnapshot, acceptance: ProductionNotesExtendedAcceptance, adjustment: unknown, identity: ExtendedIdentity, history: ProductionNotesAnySnapshot[]): ProductionNotesExtendedSnapshot {
    assertProductionNotesExtendedOriginal(original); assertProductionNotesExtendedAcceptance(original, acceptance);
    const input = productionNotesExtendedAdjustment(adjustment), full = isFullCredit(input), correction = input.documentTypeCode === '07' && input.reasonCode === '03', mora = input.documentTypeCode === '08' && input.reasonCode === '01';
    fiscalIdentity(identity, original.documentTypeCode === '03' ? 'B' : 'F', new Date().toISOString());
    if (identity.documentId === original.documentId || history.some(n => n.documentId === identity.documentId) || Date.parse(identity.issueDate) < Date.parse(acceptance.acceptedAt) || history.some(n => Date.parse(n.issueDate) > Date.parse(identity.issueDate))) throw Error('Identidad/fecha de nota inválida');
    const selected = full ? original.lines.map(l => ({ originalLineNumber: l.lineNumber })) : ('lines' in input ? input.lines : []);
    if (input.documentTypeCode === '07' && input.reasonCode === '04' && input.lines.length !== original.lines.length) throw Error('Descuento global requiere reparto completo');
    const lines = selected.map((entry, i) => {
        const source = original.lines.find(l => l.lineNumber === entry.originalLineNumber);
        if (!source) throw Error('Línea ajena');
        let quantity = source.quantity, price = source.unitPriceWithTax, description = source.description;
        if ('correctedDescription' in entry) description = entry.correctedDescription as string;
        if ('description' in entry) description = entry.description as string;
        if ('quantity' in entry) quantity = entry.quantity as string;
        if ('unitPriceAdjustmentWithTax' in entry) price = entry.unitPriceAdjustmentWithTax as string;
        if ('amountWithTax' in entry) { quantity = '1'; price = entry.amountWithTax as string; }
        if ('bonusAmountWithTax' in entry) { quantity = '1'; price = entry.bonusAmountWithTax as string; }
        if ('interestAmount' in entry) { quantity = '1'; price = entry.interestAmount as string; description = input.reasonDescription; }
        if (correction) price = '0.00';
        const calculated = full ? { unitValue: source.unitValue, lineExtensionAmount: source.lineExtensionAmount, igvAmount: source.igvAmount, totalAmount: source.totalAmount } : calculateTaxLine({ quantity, unitPriceWithTax: price, igvRate: mora ? '0' : '18' });
        fiscalDecimal(calculated.totalAmount, 2, !correction, 'total');
        return { ...(source.productCode === undefined ? {} : { productCode: source.productCode }), lineNumber: i + 1, originalLineNumber: source.lineNumber, description, unitCode: source.unitCode, quantity, unitPriceWithTax: price, igvRate: mora ? '0' : '18', taxAffectationCode: mora ? '30' : '10', ...calculated };
    });
    const note: ProductionNotesExtendedSnapshot = { documentId: identity.documentId, companyId: original.companyId, branchId: original.branchId, environment: 'PRODUCTION', documentTypeCode: input.documentTypeCode, profile: PRODUCTION_NOTES_EXTENDED_PROFILE,
        series: identity.series, number: identity.number, fullNumber: identity.series + '-' + identity.number, issueDate: identity.issueDate, currencyCode: 'PEN', operationTypeCode: '0101', issuer: structuredClone(original.issuer), customer: structuredClone(original.customer),
        adjustment: input, reasonCode: input.reasonCode, reasonDescription: input.reasonDescription, reference: { documentId: original.documentId, documentTypeCode: original.documentTypeCode as '01' | '03', fullNumber: original.fullNumber, issueDate: original.issueDate, snapshotSha256: fiscalSnapshotSha256(original) },
        originalAcceptance: structuredClone(acceptance), creditHistoryIds: history.map(n => n.documentId), lines, totals: { taxableAmount: mora ? '0.00' : addMoney(lines.map(l => l.lineExtensionAmount)), unaffectedAmount: mora ? addMoney(lines.map(l => l.lineExtensionAmount)) : '0.00', igvAmount: addMoney(lines.map(l => l.igvAmount)), payableAmount: addMoney(lines.map(l => l.totalAmount)) } };
    if (input.documentTypeCode === '07') extendedCapacity(original, [...history, note]);
    return JSON.parse(JSON.stringify(note));
}
/** Quantity capacity is consumed only by physical returns/full annulments. Every monetary credit consumes cents, including bonuses. */
function extendedCapacity(original: FiscalDocumentSnapshot, credits: ProductionNotesAnySnapshot[]) {
    for (const source of original.lines) {
        const entries = credits.flatMap(n => n.lines.filter(l => l.originalLineNumber === source.lineNumber).map(l => ({ n, l })));
        const quantity = entries.filter(({ n }) => isFullCredit(n) || n.reasonCode === '07').reduce((sum, { l }) => sum + parseDecimal(l.quantity), 0n);
        if (quantity > parseDecimal(source.quantity)) throw Error('Sobreacreditación cantidad');
        for (const key of ['lineExtensionAmount', 'igvAmount', 'totalAmount'] as const)
            if (entries.reduce((sum, { l }) => sum + parseDecimal(l[key], 2), 0n) > parseDecimal(source[key], 2)) throw Error('Sobreacreditación importe/IGV');
    }
    for (const key of ['taxableAmount', 'igvAmount', 'payableAmount'] as const)
        if (credits.reduce((sum, n) => sum + parseDecimal(n.totals[key], 2), 0n) > parseDecimal(original.totals[key], 2)) throw Error('Sobreacreditación total');
}
/** Caller must supply ALL accepted and reserved credits in reservation order, including unknown outcomes. Never net with debits. */
export function assertProductionNotesExtendedCapacity(original: FiscalDocumentSnapshot, history: ProductionNotesAnySnapshot[]) {
    assertProductionNotesExtendedOriginal(original);
    fiscalArray(history, 100, 'creditHistory');
    const prefix: ProductionNotesAnySnapshot[] = [], ids = new Set<string>();
    for (const n of history) {
        if (n.documentTypeCode !== '07' || ids.has(n.documentId) || n.reference.documentId !== original.documentId || n.reference.documentTypeCode !== original.documentTypeCode || n.reference.snapshotSha256 !== fiscalSnapshotSha256(original)) throw Error('Historial crédito ajeno, débito o duplicado');
        const identity = { documentId: n.documentId, series: n.series, number: n.number, issueDate: n.issueDate };
        if (n.profile === PRODUCTION_NOTES_EXTENDED_PROFILE) fiscalEqual(n, extendedSnapshot(original, n.originalAcceptance, n.adjustment, identity, prefix), 'history');
        else if (n.profile === PRODUCTION_NOTES_PROFILE) {
            const expected = buildProductionNotesSnapshot(original, n.originalAcceptance, n.adjustment, identity, []);
            expected.creditHistoryIds = prefix.map(p => p.documentId);
            fiscalEqual(n, expected, 'legacyHistory');
        } else throw Error('Historial sin perfil soportado');
        ids.add(n.documentId); prefix.push(n); extendedCapacity(original, prefix);
    }
}
export function buildProductionNotesExtendedSnapshot(original: FiscalDocumentSnapshot, acceptance: ProductionNotesExtendedAcceptance, adjustment: unknown, identity: ExtendedIdentity, creditHistory: ProductionNotesAnySnapshot[] = []): ProductionNotesExtendedSnapshot {
    assertProductionNotesExtendedCapacity(original, creditHistory);
    if (creditHistory.length >= 100) throw Error('Historial excede límite de 100 créditos incluyendo la nueva nota');
    return extendedSnapshot(original, acceptance, adjustment, identity, creditHistory);
}
export function assertProductionNotesExtendedSnapshot(note: ProductionNotesExtendedSnapshot, original: FiscalDocumentSnapshot, history: ProductionNotesAnySnapshot[]) {
    fiscalEqual(note, buildProductionNotesExtendedSnapshot(original, note.originalAcceptance, note.adjustment, { documentId: note.documentId, series: note.series, number: note.number, issueDate: note.issueDate }, history), 'productionExtendedNote');
}

/** Validates the complete immutable snapshot before producing unsigned UBL 2.1. */
export function buildProductionNotesExtendedUbl(note: ProductionNotesExtendedSnapshot, original: FiscalDocumentSnapshot, history: ProductionNotesAnySnapshot[] = []): string {
    assertProductionNotesExtendedSnapshot(note, original, history);
    return renderProductionNotesExtendedUbl(note);
}
function renderProductionNotesExtendedUbl(note: ProductionNotesExtendedSnapshot): string {
    const mora = note.documentTypeCode === '08' && note.reasonCode === '01';
    const base = addMoney([note.totals.taxableAmount, note.totals.unaffectedAmount]);
    const root = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote', quantity = note.documentTypeCode === '07' ? 'CreditedQuantity' : 'DebitedQuantity', money = note.documentTypeCode === '07' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal';
    const party = (kind: string, p: typeof note.customer, supplier = false) => '<cac:' + kind + '><cac:Party><cac:PartyIdentification><cbc:ID schemeID="' + p.identityType + '">' + p.identityNumber + '</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>' + fiscalXml(p.legalName) + '</cbc:RegistrationName>' + (supplier ? '<cac:RegistrationAddress><cbc:ID>' + note.issuer.ubigeo + '</cbc:ID><cbc:AddressTypeCode>' + note.issuer.establishmentCode + '</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>' + fiscalXml(note.issuer.address ?? '') + '</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>' : '') + '</cac:PartyLegalEntity></cac:Party></cac:' + kind + '>';
    const lines = note.lines.map(l => '<cac:' + root + 'Line><cbc:ID>' + l.lineNumber + '</cbc:ID><cbc:' + quantity + ' unitCode="' + l.unitCode + '">' + l.quantity + '</cbc:' + quantity + '>' + fiscalAmountXml('LineExtensionAmount', l.lineExtensionAmount) + '<cac:PricingReference><cac:AlternativeConditionPrice>' + fiscalAmountXml('PriceAmount', l.unitPriceWithTax) + '<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>' + fiscalTaxXml(l.lineExtensionAmount, l.igvAmount, l.taxAffectationCode === '30', true) + '<cac:Item><cbc:Description>' + fiscalXml(l.description) + '</cbc:Description>' + (l.productCode ? '<cac:SellersItemIdentification><cbc:ID>' + fiscalXml(l.productCode) + '</cbc:ID></cac:SellersItemIdentification>' : '') + '</cac:Item><cac:Price>' + fiscalAmountXml('PriceAmount', l.unitValue) + '</cac:Price></cac:' + root + 'Line>').join('');
    return '<?xml version="1.0" encoding="UTF-8"?><' + root + ' xmlns="urn:oasis:names:specification:ubl:schema:xsd:' + root + '-2" ' + FISCAL_XML_NAMESPACES + '>' + FISCAL_XML_EXTENSION + '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID><cbc:ID>' + note.fullNumber + '</cbc:ID><cbc:IssueDate>' + fiscalLimaDate(note.issueDate) + '</cbc:IssueDate><cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode><cac:DiscrepancyResponse><cbc:ReferenceID>' + note.reference.fullNumber + '</cbc:ReferenceID><cbc:ResponseCode listAgencyName="PE:SUNAT" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo' + (note.documentTypeCode === '07' ? '09' : '10') + '">' + note.reasonCode + '</cbc:ResponseCode><cbc:Description>' + fiscalXml(note.reasonDescription) + '</cbc:Description></cac:DiscrepancyResponse><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>' + note.reference.fullNumber + '</cbc:ID><cbc:DocumentTypeCode>' + note.reference.documentTypeCode + '</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>' + fiscalSignatureXml(note.issuer) + party('AccountingSupplierParty', note.issuer, true) + party('AccountingCustomerParty', note.customer) + fiscalTaxXml(base, note.totals.igvAmount, mora) + '<cac:' + money + '>' + fiscalAmountXml('LineExtensionAmount', base) + fiscalAmountXml('TaxExclusiveAmount', base) + fiscalAmountXml('TaxInclusiveAmount', note.totals.payableAmount) + fiscalAmountXml('PayableAmount', note.totals.payableAmount) + '</cac:' + money + '>' + lines + '</' + root + '>';
}

/** Explicit profile dispatch; v1 cannot silently reinterpret a v2 credit history. */
export function assertProductionNotesAnySnapshot(note: ProductionNotesAnySnapshot, original: FiscalDocumentSnapshot, history: ProductionNotesAnySnapshot[]): void {
    if (note.profile === PRODUCTION_NOTES_EXTENDED_PROFILE) return assertProductionNotesExtendedSnapshot(note, original, history);
    if (note.profile !== PRODUCTION_NOTES_PROFILE) throw Error('Perfil de nota no soportado');
    if (history.some(n => n.profile !== PRODUCTION_NOTES_PROFILE)) throw Error('Historial extendido requiere perfil v2 explícito');
    assertProductionNotesSnapshot(note, original, history as ProductionNotesSnapshot[]);
}
/** Serialization for an admitted immutable snapshot. Caller first invokes assertProductionNotesAnySnapshot with the original and complete history. */
export function buildProductionNotesAnyUbl(note: ProductionNotesAnySnapshot): string {
    if (note.profile === PRODUCTION_NOTES_PROFILE) return buildProductionNotesUbl(note);
    if (note.profile === PRODUCTION_NOTES_EXTENDED_PROFILE) return renderProductionNotesExtendedUbl(note);
    throw Error('Perfil de nota no soportado');
}
export function assertProductionNotesAnyOriginal(original: FiscalDocumentSnapshot): void {
    if (original.documentTypeCode === '01') return assertProductionNotesOriginal(original);
    assertProductionNotesExtendedOriginal(original);
}