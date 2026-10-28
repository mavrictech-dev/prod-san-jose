import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { addMoney, parseDecimal } from './tax';
import {
  assertFiscalCreditCapacity, fiscalAmountXml, fiscalArray, fiscalBillingReferenceXml,
  fiscalDate, fiscalDecimal, fiscalEqual, fiscalFail, fiscalLimaDate, fiscalObject,
  fiscalSignatureXml, fiscalSnapshotSha256, fiscalTaxXml, fiscalText, fiscalTimestamp,
  fiscalUuid, fiscalXml, FISCAL_XML_EXTENSION, FISCAL_XML_NAMESPACES,
  validateFiscalAcceptance, validateFiscalNoteSnapshot, validateFiscalOriginal,
  type FiscalAcceptanceEvidence, type FiscalNoteContext, type FiscalNoteSnapshot,
} from './fiscal-note';

/**
 * Lotes REALES BETA offline: RC UBL2.0/customization1.1, RA UBL2.0/1.0.
 * Fuentes SUNAT consultadas 2026-10-02, incluidas abajo. No hay firma/transporte
 * ni validación de CDR/SEE; las evidencias proceden de verificadores del caller.
 * Perfil <=100 documentos, un emisor/empresa/sede y una fecha de emisión Lima.
 * RC: boletas 03 y notas 07/08 sobre 03; estados 1 alta, 2 modificación y 3 baja
 * pueden convivir. Alta exige caller conocer que aún no fue informado. 2/3 exigen
 * versión previa y CDR RC aceptado ligado a sus bytes canónicos. 2 conserva
 * identidad/fecha/cliente; baja conserva TODOS los datos y exige no otorgamiento.
 * No cubre bajas de boletas no informadas, cambios de cliente ni notas corregidas
 * con otro tratamiento fiscal. RC se limita a 7 días desde la fecha de referencia.
 * RA: sólo 01 y notas F sobre 01 aceptadas y NO ENTREGADAS, evidencia por documento,
 * <=7 días desde aceptación (fecha Lima); 03 y notas B se comunican por RC.
 * PEN/IGV18 en originales; excepción explícita de mora 08-01 inafecta 30/9998.
 * Crédito/cuotas se bloquean en el validador del original. Totales nunca se editan
 * ni se ponen en cero para bajas; RA no serializa importes. No netea créditos con
 * débitos: capacidad acumulada incluye notas/historial de todas las entradas RC.
 * El caller garantiza exclusión de reservas simultáneas e integridad del historial;
 * preparar XML no reserva, comunica baja ni acredita aceptación de SUNAT.
 */
export const FISCAL_BATCH_PROFILE = 'FACTUEZ-BETA-BATCH-PEN-IGV18-MORA30-v1';
export const FISCAL_BATCH_SOURCES = Object.freeze({
  summary: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/GUIA_Resumen_de_Boletas_11-01-2018%20(2)_2_0%20(1)_0.pdf',
  voided: 'https://www.sunat.gob.pe/legislacion/superin/2014/anexo-199-2014.pdf',
  operation: 'https://orientacion.sunat.gob.pe/3529-operatividad',
  schemas: 'https://cpe.sunat.gob.pe/guias-y-manuales',
});
/** noteContext es obligatorio para 07/08; se valida también en entradas previas. */
export type FiscalBatchDocument = { snapshot: FiscalDocumentSnapshot | FiscalNoteSnapshot; noteContext?: FiscalNoteContext };
export type FiscalNotDeliveredEvidence = {
  status: 'NOT_DELIVERED'; documentId: string; documentTypeCode: '01' | '03' | '07' | '08';
  fullNumber: string; issuerRuc: string; snapshotSha256: string; evidenceId: string; assertedAt: string;
};
export type FiscalBatchPrevious = { document: FiscalBatchDocument; acceptance: FiscalAcceptanceEvidence };
export type FiscalRcEntry = { document: FiscalBatchDocument } & (
  | { conditionCode: '1'; previous?: never; notDelivered?: never }
  | { conditionCode: '2'; previous: FiscalBatchPrevious; notDelivered?: never }
  | { conditionCode: '3'; previous: FiscalBatchPrevious; notDelivered: FiscalNotDeliveredEvidence }
);
export type FiscalRaEntry = {
  document: FiscalBatchDocument; acceptance: FiscalAcceptanceEvidence;
  notDelivered: FiscalNotDeliveredEvidence; reasonDescription: string;
};
export type FiscalBatchEntry = FiscalRcEntry | FiscalRaEntry;
export type FiscalBatchInput = { kind: 'RC'; entries: FiscalRcEntry[] } | { kind: 'RA'; entries: FiscalRaEntry[] };
export type FiscalBatchIdentity = { documentId: string; identifier: string; issueDate: string; referenceDate: string };
export type FiscalBatchSnapshot = FiscalBatchIdentity & {
  environment: 'BETA'; profile: typeof FISCAL_BATCH_PROFILE; kind: 'RC' | 'RA';
  companyId?: number; branchId?: string; issuer: FiscalDocumentSnapshot['issuer'];
  input: FiscalBatchInput;
  totals: FiscalDocumentSnapshot['totals'] & { unaffectedAmount: string };
};

function validateDocument(document: FiscalBatchDocument, asOf: string): void {
  fiscalObject(document, ['snapshot', 'noteContext'], 'document');
  if (!document.snapshot || typeof document.snapshot !== 'object') fiscalFail('Snapshot fiscal requerido');
  if (document.snapshot.documentTypeCode === '07' || document.snapshot.documentTypeCode === '08') {
    if (!document.noteContext) fiscalFail('Nota requiere original aceptado, evidencia e historial explícitos');
    validateFiscalNoteSnapshot(document.snapshot as FiscalNoteSnapshot, { ...document.noteContext, asOf });
  } else {
    if (Object.hasOwn(document, 'noteContext')) fiscalFail('noteContext sólo aplica a 07/08');
    validateFiscalOriginal(document.snapshot, asOf);
  }
}
function isReceipt(document: FiscalBatchDocument): boolean {
  const snapshot = document.snapshot;
  return snapshot.documentTypeCode === '03' || (['07', '08'].includes(snapshot.documentTypeCode) && (snapshot as FiscalNoteSnapshot).reference.documentTypeCode === '03');
}
function sameIdentity(current: FiscalBatchDocument, previous: FiscalBatchDocument): void {
  const a = current.snapshot, b = previous.snapshot;
  for (const field of ['documentId', 'documentTypeCode', 'series', 'number', 'fullNumber', 'issueDate', 'environment', 'currencyCode', 'operationTypeCode', 'companyId', 'branchId', 'issuer', 'customer'] as const)
    fiscalEqual(a[field], b[field], `previous.${field}`);
  if (a.documentTypeCode === '07' || a.documentTypeCode === '08') fiscalEqual((a as FiscalNoteSnapshot).reference, (b as FiscalNoteSnapshot).reference, 'previous.reference');
}
function validateNotDelivered(snapshot: FiscalBatchDocument['snapshot'], evidence: FiscalNotDeliveredEvidence, asOf: string, issueDate: string): void {
  fiscalObject(evidence, ['status', 'documentId', 'documentTypeCode', 'fullNumber', 'issuerRuc', 'snapshotSha256', 'evidenceId', 'assertedAt'], 'notDelivered');
  fiscalUuid(evidence.evidenceId, 'notDelivered.evidenceId'); fiscalTimestamp(evidence.assertedAt, 'notDelivered.assertedAt');
  if (evidence.status !== 'NOT_DELIVERED' || evidence.documentId !== snapshot.documentId || evidence.documentTypeCode !== snapshot.documentTypeCode ||
    evidence.fullNumber !== snapshot.fullNumber || evidence.issuerRuc !== snapshot.issuer.identityNumber || evidence.snapshotSha256 !== fiscalSnapshotSha256(snapshot) ||
    Date.parse(evidence.assertedAt) < Date.parse(snapshot.issueDate) || Date.parse(evidence.assertedAt) > Date.parse(asOf) || fiscalLimaDate(evidence.assertedAt) > issueDate)
    fiscalFail('Baja requiere evidencia explícita por documento NO ENTREGADO');
}
function dayDifference(later: string, earlier: string): number {
  return (Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / 86400000;
}
/** Verifica también créditos creados por separado que juntos excederían el original. */
function validateCombinedCredits(entries: FiscalRcEntry[]): void {
  const groups = new Map<string, { original: FiscalDocumentSnapshot; notes: Map<string, FiscalNoteSnapshot> }>();
  for (const entry of entries) {
    if (entry.conditionCode === '3' || entry.document.snapshot.documentTypeCode !== '07') continue;
    const context = entry.document.noteContext!, original = context.original;
    const key = `${original.issuer.identityNumber}/${original.documentId}`;
    let group = groups.get(key);
    if (!group) { group = { original, notes: new Map() }; groups.set(key, group); }
    fiscalEqual(original, group.original, 'batch.original');
    for (const note of [...context.creditHistory.entries.map(e => e.note), entry.document.snapshot as FiscalNoteSnapshot]) {
      const known = group.notes.get(note.documentId);
      if (known) fiscalEqual(note, known, 'batch.credit'); else group.notes.set(note.documentId, note);
    }
  }
  for (const { original, notes } of groups.values()) assertFiscalCreditCapacity(original, [...notes.values()]);
}

export function buildFiscalBatchSnapshot(input: FiscalBatchInput, identity: FiscalBatchIdentity, asOf: string): FiscalBatchSnapshot {
  fiscalObject(input, ['kind', 'entries'], 'batch.input'); fiscalObject(identity, ['documentId', 'identifier', 'issueDate', 'referenceDate'], 'batch.identity');
  fiscalArray(input.entries, 100, 'batch.entries');
  if (!['RC', 'RA'].includes(input.kind) || !input.entries.length) fiscalFail('Lote RC/RA requiere 1..100 entradas');
  fiscalUuid(identity.documentId, 'batch.documentId'); fiscalDate(identity.issueDate, 'batch.issueDate'); fiscalDate(identity.referenceDate, 'batch.referenceDate'); fiscalTimestamp(asOf, 'asOf');
  if (!new RegExp(`^${input.kind}-\\d{8}-[1-9]\\d{0,4}$`).test(identity.identifier) ||
    identity.identifier.slice(3, 11) !== identity.issueDate.replaceAll('-', '') || identity.issueDate < identity.referenceDate || identity.issueDate > fiscalLimaDate(asOf))
    fiscalFail('Identificador/fecha de lote inválido');
  const seenIds = new Set<string>(), seenNumbers = new Set<string>();
  let first: FiscalBatchDocument['snapshot'] | undefined;
  for (const raw of input.entries) {
    fiscalObject(raw, input.kind === 'RC' ? ['document', 'conditionCode', 'previous', 'notDelivered'] : ['document', 'acceptance', 'notDelivered', 'reasonDescription'], 'batch.entry');
    validateDocument(raw.document, asOf);
    const snapshot = raw.document.snapshot;
    if (!first) first = snapshot;
    fiscalEqual(snapshot.issuer, first.issuer, 'batch.issuer'); fiscalEqual(snapshot.companyId, first.companyId, 'batch.companyId'); fiscalEqual(snapshot.branchId, first.branchId, 'batch.branchId');
    if (fiscalLimaDate(snapshot.issueDate) !== identity.referenceDate || snapshot.documentId === identity.documentId ||
      seenIds.has(snapshot.documentId) || seenNumbers.has(`${snapshot.documentTypeCode}/${snapshot.fullNumber}`)) fiscalFail('Lote mezcla fechas o documentos duplicados');
    seenIds.add(snapshot.documentId); seenNumbers.add(`${snapshot.documentTypeCode}/${snapshot.fullNumber}`);
    if (input.kind === 'RC') {
      const entry = raw as FiscalRcEntry;
      if (!isReceipt(entry.document) || !['1', '2', '3'].includes(entry.conditionCode)) fiscalFail('RC sólo boletas/notas sobre 03 y estados 1/2/3');
      if (dayDifference(identity.issueDate, identity.referenceDate) > 7) fiscalFail('RC fuera del límite de 7 días del perfil');
      if (entry.conditionCode === '1') {
        fiscalObject(entry, ['document', 'conditionCode'], 'RC.alta');
      } else {
        fiscalObject(entry, entry.conditionCode === '2' ? ['document', 'conditionCode', 'previous'] : ['document', 'conditionCode', 'previous', 'notDelivered'], 'RC.previous');
        fiscalObject(entry.previous, ['document', 'acceptance'], 'previous'); validateDocument(entry.previous.document, asOf);
        sameIdentity(entry.document, entry.previous.document); validateFiscalAcceptance(entry.previous.document.snapshot, entry.previous.acceptance, asOf);
        if (fiscalLimaDate(entry.previous.acceptance.acceptedAt) > identity.issueDate) fiscalFail('RC previo aún no aceptado en fecha de generación');
        if (entry.conditionCode === '3') {
          fiscalEqual(snapshot, entry.previous.document.snapshot, 'RC.baja.snapshot');
          validateNotDelivered(snapshot, entry.notDelivered, asOf, identity.issueDate);
        }
      }
    } else {
      const entry = raw as FiscalRaEntry;
      if (isReceipt(entry.document) || !['01', '07', '08'].includes(snapshot.documentTypeCode)) fiscalFail('RA sólo factura 01 y notas F ligadas a 01');
      validateFiscalAcceptance(snapshot, entry.acceptance, asOf); validateNotDelivered(snapshot, entry.notDelivered, asOf, identity.issueDate); fiscalText(entry.reasonDescription, 100, 'RA.reasonDescription');
      const days = dayDifference(identity.issueDate, fiscalLimaDate(entry.acceptance.acceptedAt));
      if (days < 0 || days > 7) fiscalFail('RA fuera de los 7 días desde CDR aceptado');
    }
  }
  if (input.kind === 'RC') validateCombinedCredits(input.entries);
  const snapshots = input.entries.map(e => e.document.snapshot);
  const totals = {
    taxableAmount: addMoney(snapshots.map(s => s.totals.taxableAmount)), igvAmount: addMoney(snapshots.map(s => s.totals.igvAmount)),
    payableAmount: addMoney(snapshots.map(s => s.totals.payableAmount)),
    unaffectedAmount: addMoney(snapshots.map(s => 'unaffectedAmount' in s.totals ? String(s.totals.unaffectedAmount) : '0.00')),
  };
  for (const value of Object.values(totals)) fiscalDecimal(value, 2, false, 'batch.totals');
  if (parseDecimal(totals.taxableAmount, 2) + parseDecimal(totals.unaffectedAmount, 2) + parseDecimal(totals.igvAmount, 2) !== parseDecimal(totals.payableAmount, 2)) fiscalFail('Suma de lote inválida');
  return { ...structuredClone(identity), kind: input.kind, environment: 'BETA', profile: FISCAL_BATCH_PROFILE,
    ...(first!.companyId !== undefined ? { companyId: first!.companyId } : {}), ...(first!.branchId !== undefined ? { branchId: first!.branchId } : {}),
    issuer: structuredClone(first!.issuer), input: structuredClone(input), totals };
}
export function validateFiscalBatchSnapshot(batch: FiscalBatchSnapshot, asOf: string): void {
  fiscalObject(batch, ['documentId', 'identifier', 'issueDate', 'referenceDate', 'kind', 'environment', 'profile', 'companyId', 'branchId', 'issuer', 'input', 'totals'], 'batch');
  fiscalObject(batch.totals, ['taxableAmount', 'igvAmount', 'payableAmount', 'unaffectedAmount'], 'batch.totals');
  const expected = buildFiscalBatchSnapshot(batch.input, { documentId: batch.documentId, identifier: batch.identifier, issueDate: batch.issueDate, referenceDate: batch.referenceDate }, asOf);
  fiscalEqual(batch, expected, 'batch');
}
/** cac:Signature enlaza #signatureFactuEz; ExtensionContent queda vacío para crypto. */
export function buildFiscalBatchUbl(batch: FiscalBatchSnapshot, asOf: string): string {
  validateFiscalBatchSnapshot(batch, asOf);
  const root = batch.kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments', issuer = batch.issuer;
  const supplier = `<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${issuer.identityNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6" schemeAgencyName="PE:SUNAT">${issuer.identityNumber}</cbc:ID></cac:PartyIdentification><cac:PartyLegalEntity><cbc:RegistrationName>${fiscalXml(issuer.legalName)}</cbc:RegistrationName><cac:RegistrationAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${issuer.ubigeo}</cbc:ID><cbc:AddressTypeCode>${issuer.establishmentCode}</cbc:AddressTypeCode>${issuer.address ? `<cac:AddressLine><cbc:Line>${fiscalXml(issuer.address)}</cbc:Line></cac:AddressLine>` : ''}<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>`;
  const lines = batch.input.entries.map((raw, index) => {
    const s = raw.document.snapshot;
    if (batch.kind === 'RA') return `<sac:VoidedDocumentsLine><cbc:LineID>${index + 1}</cbc:LineID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${s.documentTypeCode}</cbc:DocumentTypeCode><sac:DocumentSerialID>${s.series}</sac:DocumentSerialID><sac:DocumentNumberID>${s.number}</sac:DocumentNumberID><sac:VoidReasonDescription>${fiscalXml((raw as FiscalRaEntry).reasonDescription)}</sac:VoidReasonDescription></sac:VoidedDocumentsLine>`;
    const unaffected = s.documentTypeCode === '08' && (s as FiscalNoteSnapshot).reasonCode === '01';
    const base = unaffected ? (s as FiscalNoteSnapshot).totals.unaffectedAmount : s.totals.taxableAmount;
    const payment = (amount: string, code: string) => `<sac:BillingPayment>${fiscalAmountXml('PaidAmount', amount)}<cbc:InstructionID>${code}</cbc:InstructionID></sac:BillingPayment>`;
    return `<sac:SummaryDocumentsLine><cbc:LineID>${index + 1}</cbc:LineID><cbc:DocumentTypeCode listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">${s.documentTypeCode}</cbc:DocumentTypeCode><cbc:ID>${s.fullNumber}</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${s.customer.identityNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>${s.customer.identityType}</cbc:AdditionalAccountID></cac:AccountingCustomerParty>${['07', '08'].includes(s.documentTypeCode) ? fiscalBillingReferenceXml((s as FiscalNoteSnapshot).reference) : ''}<cac:Status><cbc:ConditionCode>${(raw as FiscalRcEntry).conditionCode}</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="PEN">${s.totals.payableAmount}</sac:TotalAmount>${payment(s.totals.taxableAmount, '01')}${payment('0.00', '02')}${payment(unaffected ? base : '0.00', '03')}${fiscalTaxXml(base, s.totals.igvAmount, unaffected)}</sac:SummaryDocumentsLine>`;
  }).join('');
  // RC/RA XSD no admite TaxTotal global: los subtotales de RC pertenecen a cada línea.
  return `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:${root}-1" ${FISCAL_XML_NAMESPACES} xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1">${FISCAL_XML_EXTENSION}<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>${batch.kind === 'RC' ? '1.1' : '1.0'}</cbc:CustomizationID><cbc:ID>${batch.identifier}</cbc:ID><cbc:ReferenceDate>${batch.referenceDate}</cbc:ReferenceDate><cbc:IssueDate>${batch.issueDate}</cbc:IssueDate>${fiscalSignatureXml(issuer)}${supplier}${lines}</${root}>`;
}
